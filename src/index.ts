import * as core from '@actions/core'
import { exec } from '@actions/exec'

interface ServiceInput {
  serviceId: string
  image: string
}

interface Inputs {
  services: ServiceInput[]
  environmentId: string
  railwayToken: string
  releaseName: string
  environment: string
  sentryAuthToken: string
  sentryOrg: string
  sentryProjects: string[]
}

function parseInputs(): Inputs {
  const servicesRaw = core.getInput('services', { required: true })
  const environment = core.getInput('environment', { required: true })

  let services: ServiceInput[]
  try {
    services = JSON.parse(servicesRaw)
    if (!Array.isArray(services) || services.some((s) => typeof s.serviceId !== 'string' || typeof s.image !== 'string')) {
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
    sentryProjects: core.getInput('sentry_projects').split(',').filter(Boolean),
  }
}

async function railwayGraphQL(token: string, query: string, variables: Record<string, unknown>): Promise<void> {
  const response = await fetch('https://backboard.railway.com/graphql/v2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Project-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  })

  const body = await response.json() as { errors?: { message: string }[] }

  if (!response.ok || body.errors?.length) {
    const message = body.errors?.map((e) => e.message).join(', ') ?? response.statusText
    throw new Error(`Railway API error: ${message}`)
  }
}

async function updateServiceImage(token: string, environmentId: string, serviceId: string, image: string): Promise<void> {
  await railwayGraphQL(token,
    `mutation UpdateServiceInstance($environmentId: String!, $serviceId: String!, $input: ServiceInstanceUpdateInput!) {
      serviceInstanceUpdate(environmentId: $environmentId, serviceId: $serviceId, input: $input)
    }`,
    { environmentId, serviceId, input: { source: { image } } }
  )
}

async function deployService(token: string, environmentId: string, serviceId: string): Promise<void> {
  await railwayGraphQL(token,
    `mutation DeployService($environmentId: String!, $serviceId: String!) {
      serviceInstanceDeploy(environmentId: $environmentId, serviceId: $serviceId) { id }
    }`,
    { environmentId, serviceId }
  )
}

async function deployAllServices(services: ServiceInput[], environmentId: string, railwayToken: string): Promise<void> {
  core.info(`Deploying ${services.length} service(s): ${services.map((s) => s.serviceId).join(', ')}`)

  await Promise.all(
    services.map(async ({ serviceId, image }) => {
      core.startGroup(`Deploy: ${serviceId}`)
      await updateServiceImage(railwayToken, environmentId, serviceId, image)
      await deployService(railwayToken, environmentId, serviceId)
      core.endGroup()
    })
  )

  core.info('All Railway deploys completed.')
}

async function trackSentryRelease(
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
  await exec('npm', ['install', '-g', '@sentry/cli'])

  const sentryEnv = {
    ...process.env,
    SENTRY_AUTH_TOKEN: sentryAuthToken,
    SENTRY_ORG: sentryOrg,
  } as Record<string, string>

  const projectFlags = sentryProjects.flatMap((p) => ['-p', p])

  try {
    await exec('sentry-cli', ['releases', 'new', releaseName, ...projectFlags], { env: sentryEnv })
  } catch {
    core.warning(`sentry-cli releases new failed (may already exist) — continuing`)
  }

  await exec('sentry-cli', ['releases', 'set-commits', releaseName, '--auto'], { env: sentryEnv })
  await exec('sentry-cli', ['releases', 'deploys', releaseName, 'new', '-e', environment], { env: sentryEnv })

  core.endGroup()
  core.info(`Sentry release ${releaseName} deployed to ${environment}.`)
}

async function run(): Promise<void> {
  const inputs = parseInputs()

  await deployAllServices(inputs.services, inputs.environmentId, inputs.railwayToken)
  await trackSentryRelease(inputs.releaseName, inputs.sentryAuthToken, inputs.sentryOrg, inputs.sentryProjects, inputs.environment)
}

run().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err))
})
