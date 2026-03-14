import * as core from '@actions/core'
import { exec } from '@actions/exec'

/** A Railway service to deploy, identified by its service ID and the Docker image to use. */
export interface ServiceInput {
  serviceId: string
  image: string
}

/** Parsed and validated action inputs. */
export interface Inputs {
  services: ServiceInput[]
  environmentId: string
  railwayToken: string
  releaseName: string
  environment: string
  sentryAuthToken: string
  sentryOrg: string
  sentryProjects: string[]
}

/** Reads and validates all action inputs, throwing on invalid values. */
export function parseInputs(): Inputs {
  const servicesRaw = core.getInput('services', { required: true })
  const environment = core.getInput('environment', { required: true })

  let services: ServiceInput[]
  try {
    services = JSON.parse(servicesRaw)
    if (
      !Array.isArray(services) ||
      services.some(
        (s) => typeof s !== 'object' || s === null || typeof s.serviceId !== 'string' || typeof s.image !== 'string'
      )
    ) {
      throw new Error('services must be a JSON array of { serviceId, image } objects')
    }
  } catch (err) {
    throw new Error(`Invalid services input: ${err}`)
  }

  return {
    services,
    environment,
    environmentId: core.getInput('environment_id', { required: true }),
    railwayToken: core.getInput('railway_token', { required: true }),
    releaseName: core.getInput('release_name', { required: true }),
    sentryAuthToken: core.getInput('sentry_auth_token'),
    sentryOrg: core.getInput('sentry_org'),
    sentryProjects: core
      .getInput('sentry_projects')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  }
}

const RAILWAY_TIMEOUT_MS = 30_000

/**
 * Executes a GraphQL mutation against the Railway API.
 * Throws on HTTP errors, GraphQL errors in the response body, or request timeout (30s).
 */
export async function railwayGraphQL(token: string, query: string, variables: Record<string, unknown>): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RAILWAY_TIMEOUT_MS)

  try {
    const response = await fetch('https://backboard.railway.com/graphql/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    })

    const body = (await response.json()) as { errors?: { message: string }[] }

    if (!response.ok || body.errors?.length) {
      const message = body.errors?.map((e) => e.message).join(', ') ?? response.statusText
      throw new Error(`Railway API error: ${message}`)
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Railway API request timed out')
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/** Updates the Docker image source of a Railway service instance. */
export async function updateServiceImage(
  token: string,
  environmentId: string,
  serviceId: string,
  image: string
): Promise<void> {
  await railwayGraphQL(
    token,
    `mutation UpdateServiceInstance($environmentId: String!, $serviceId: String!, $input: ServiceInstanceUpdateInput!) {
      serviceInstanceUpdate(environmentId: $environmentId, serviceId: $serviceId, input: $input)
    }`,
    { environmentId, serviceId, input: { source: { image } } }
  )
}

/** Triggers a deploy for a Railway service instance. */
export async function deployService(token: string, environmentId: string, serviceId: string): Promise<void> {
  await railwayGraphQL(
    token,
    `mutation DeployService($environmentId: String!, $serviceId: String!) {
      serviceInstanceDeploy(environmentId: $environmentId, serviceId: $serviceId)
    }`,
    { environmentId, serviceId }
  )
}

/** Updates the image and triggers a deploy for all services in parallel. */
export async function deployAllServices(
  services: ServiceInput[],
  environmentId: string,
  railwayToken: string
): Promise<void> {
  core.info(`Deploying ${services.length} service(s): ${services.map((s) => s.serviceId).join(', ')}`)

  await Promise.all(
    services.map(async ({ serviceId, image }) => {
      core.startGroup(`Deploy: ${serviceId}`)
      try {
        await updateServiceImage(railwayToken, environmentId, serviceId, image)
        await deployService(railwayToken, environmentId, serviceId)
      } finally {
        core.endGroup()
      }
    })
  )

  core.info('All Railway deploys completed.')
}

/**
 * Creates a Sentry release, associates commits, and registers the deploy.
 * Skips silently if `sentryAuthToken` is not provided.
 */
export async function trackSentryRelease(
  releaseName: string,
  sentryAuthToken: string,
  sentryOrg: string,
  sentryProjects: string[],
  environment: string
): Promise<void> {
  if (!sentryAuthToken) {
    core.info('No sentry_auth_token provided — skipping Sentry release tracking.')
    return
  }

  core.startGroup('Sentry release tracking')
  try {
    await exec('npm', ['install', '-g', '@sentry/cli@2.28.0'])

    const sentryEnv = {
      ...process.env,
      SENTRY_AUTH_TOKEN: sentryAuthToken,
      SENTRY_ORG: sentryOrg,
    } as Record<string, string>

    const projectFlags = sentryProjects.flatMap((p) => ['-p', p])

    try {
      await exec('sentry-cli', ['releases', 'new', releaseName, ...projectFlags], { env: sentryEnv })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.toLowerCase().includes('already exists')) {
        core.warning(`sentry-cli releases new: release already exists, continuing. (${message})`)
      } else {
        throw err
      }
    }

    await exec('sentry-cli', ['releases', 'set-commits', releaseName, '--auto'], { env: sentryEnv })
    await exec('sentry-cli', ['releases', 'deploys', releaseName, 'new', '-e', environment, '-n', releaseName], { env: sentryEnv })
  } finally {
    core.endGroup()
  }

  core.info(`Sentry release ${releaseName} deployed to ${environment}.`)
}

/** Writes a deploy summary to the GitHub Actions step summary. */
async function writeSummary(inputs: Inputs, sentryTracked: boolean, failed = false): Promise<void> {
  const serviceRows = inputs.services.map((s) => [s.serviceId, s.image])

  await core.summary
    .addHeading(failed ? '❌ Spryx Deploy Failed' : '🚀 Spryx Deploy')
    .addTable([
      [
        { data: 'Service ID', header: true },
        { data: 'Image', header: true },
      ],
      ...serviceRows,
    ])
    .addTable([
      [
        { data: 'Field', header: true },
        { data: 'Value', header: true },
      ],
      ['Environment', inputs.environment],
      ['Release', inputs.releaseName],
      ['Sentry tracking', sentryTracked ? '✅ tracked' : '⏭️ skipped'],
    ])
    .write()
}

/** Entry point: parses inputs, deploys all services, and optionally tracks the Sentry release. */
export async function run(): Promise<void> {
  const inputs = parseInputs()

  let failed = false
  let caughtError: unknown
  const sentryTracked = Boolean(inputs.sentryAuthToken)

  try {
    await deployAllServices(inputs.services, inputs.environmentId, inputs.railwayToken)

    await trackSentryRelease(
      inputs.releaseName,
      inputs.sentryAuthToken,
      inputs.sentryOrg,
      inputs.sentryProjects,
      inputs.environment
    )
  } catch (err) {
    failed = true
    caughtError = err
  } finally {
    await writeSummary(inputs, sentryTracked, failed)
  }

  if (caughtError !== undefined) {
    throw caughtError
  }
}
