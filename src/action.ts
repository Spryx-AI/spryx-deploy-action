import * as core from '@actions/core'

/** The result of a Railway deployment poll. */
export interface DeploymentResult {
  serviceId: string
  environmentId: string
  deploymentId: string
  status: 'SUCCESS' | 'FAILED' | 'CRASHED' | 'REMOVED' | string
  url?: string
  createdAt?: string
}

/** Parsed and validated action inputs. */
export interface Inputs {
  serviceId: string
  image: string
  environmentId: string
  railwayToken: string
  environment: string
  deployWaitTimeoutMs: number
}

/** Reads and validates all action inputs. */
export function parseInputs(): Inputs {
  return {
    serviceId: core.getInput('service_id', { required: true }),
    image: core.getInput('image', { required: true }),
    environment: core.getInput('environment', { required: true }),
    environmentId: core.getInput('environment_id', { required: true }),
    railwayToken: core.getInput('railway_token', { required: true }),
    deployWaitTimeoutMs: parseInt(core.getInput('deploy_wait_timeout_minutes') || '10', 10) * 60_000,
  }
}

const RAILWAY_TIMEOUT_MS = 30_000
const RAILWAY_POLL_INTERVAL_MS = 10_000

const TERMINAL_OK = new Set(['SUCCESS'])
const TERMINAL_ERROR = new Set(['FAILED', 'CRASHED', 'REMOVED'])

/**
 * Executes a GraphQL mutation against the Railway API.
 * Throws on HTTP errors, GraphQL errors in the response body, or request timeout (30s).
 */
export async function railwayGraphQL<T = void>(
  token: string,
  query: string,
  variables: Record<string, unknown>
): Promise<T> {
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

    const body = (await response.json()) as { data?: T; errors?: { message: string }[] }

    if (!response.ok || body.errors?.length) {
      const message = body.errors?.map((e) => e.message).join(', ') ?? response.statusText
      throw new Error(`Railway API error: ${message}`)
    }

    return body.data as T
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
export async function triggerDeploy(token: string, environmentId: string, serviceId: string): Promise<void> {
  await railwayGraphQL(
    token,
    `mutation DeployService($environmentId: String!, $serviceId: String!) {
      serviceInstanceDeploy(environmentId: $environmentId, serviceId: $serviceId)
    }`,
    { environmentId, serviceId }
  )
}

/** Returns the ID of the most recent deployment for a service in a given environment. */
export async function getLatestDeploymentId(token: string, serviceId: string, environmentId: string): Promise<string> {
  const data = await railwayGraphQL<{
    deployments: { edges: { node: { id: string } }[] }
  }>(
    token,
    `query GetLatestDeployment($serviceId: String!, $environmentId: String!) {
      deployments(first: 1, input: { serviceId: $serviceId, environmentId: $environmentId }) {
        edges {
          node {
            id
          }
        }
      }
    }`,
    { serviceId, environmentId }
  )

  const id = data.deployments.edges[0]?.node.id
  if (!id) throw new Error(`No deployment found for service ${serviceId} in environment ${environmentId}`)
  return id
}

/** Returns the project ID that owns the given service. */
export async function getProjectId(token: string, serviceId: string): Promise<string> {
  const data = await railwayGraphQL<{ service: { projectId: string } }>(
    token,
    `query GetServiceProject($serviceId: String!) {
      service(id: $serviceId) {
        projectId
      }
    }`,
    { serviceId }
  )
  return data.service.projectId
}

/**
 * Polls the Railway API until the deployment reaches a terminal state or the timeout is exceeded.
 * Terminal OK: SUCCESS. Terminal error: FAILED, CRASHED, REMOVED.
 */
export async function pollDeploymentStatus(
  token: string,
  deploymentId: string,
  timeoutMs: number,
  pollIntervalMs = RAILWAY_POLL_INTERVAL_MS
): Promise<DeploymentResult> {
  const deadline = Date.now() + timeoutMs

  while (true) {
    const data = await railwayGraphQL<{
      deployment: { status: string; serviceId: string; environmentId: string; staticUrl?: string; createdAt?: string }
    }>(
      token,
      `query PollDeployment($id: String!) {
        deployment(id: $id) {
          status
          serviceId
          environmentId
          staticUrl
          createdAt
        }
      }`,
      { id: deploymentId }
    )

    const { status, serviceId, environmentId, staticUrl, createdAt } = data.deployment

    if (TERMINAL_OK.has(status) || TERMINAL_ERROR.has(status)) {
      return { serviceId, environmentId, deploymentId, status, url: staticUrl, createdAt }
    }

    if (Date.now() + pollIntervalMs > deadline) {
      throw new Error(
        `Deployment ${deploymentId} did not reach a terminal state within ${timeoutMs / 60_000} minutes (last status: ${status})`
      )
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }
}

/** Writes a deploy summary to the GitHub Actions step summary. */
async function writeSummary(inputs: Inputs, result: DeploymentResult | null, projectId: string, failed = false): Promise<void> {
  const statusEmoji = result?.status === 'SUCCESS' ? '✅' : '❌'

  let builder = core.summary
    .addHeading(failed ? '❌ Spryx Deploy Failed' : '🚀 Spryx Deploy')
    .addTable([
      [
        { data: 'Field', header: true },
        { data: 'Value', header: true },
      ],
      ['Environment', inputs.environment],
      ['Service', inputs.serviceId],
      ['Image', inputs.image],
    ])

  if (result) {
    const railwayUrl = `https://railway.com/project/${projectId}/service/${result.serviceId}?environmentId=${result.environmentId}&id=${result.deploymentId}#deploy`
    const railwayLink = `<a href="${railwayUrl}">${result.deploymentId}</a>`
    const normalizedUrl = result.url ? (result.url.startsWith('http') ? result.url : `https://${result.url}`) : null
    const appUrl = normalizedUrl ? `<a href="${normalizedUrl}">${normalizedUrl}</a>` : '—'

    builder = builder.addTable([
      [
        { data: 'Deployment', header: true },
        { data: 'Status', header: true },
        { data: 'URL', header: true },
      ],
      [railwayLink, `${statusEmoji} ${result.status}`, appUrl],
    ])
  }

  await builder.write()
}

/** Entry point: parses inputs, deploys the service, and writes a summary. */
export async function run(): Promise<void> {
  const inputs = parseInputs()

  let failed = false
  let caughtError: unknown
  let result: DeploymentResult | null = null
  let projectId = ''

  try {
    core.info(`Deploying service ${inputs.serviceId} with image ${inputs.image}`)

    projectId = await getProjectId(inputs.railwayToken, inputs.serviceId)
    await updateServiceImage(inputs.railwayToken, inputs.environmentId, inputs.serviceId, inputs.image)
    await triggerDeploy(inputs.railwayToken, inputs.environmentId, inputs.serviceId)

    const deploymentId = await getLatestDeploymentId(inputs.railwayToken, inputs.serviceId, inputs.environmentId)
    core.info(`Deployment started: ${deploymentId}`)

    result = await pollDeploymentStatus(inputs.railwayToken, deploymentId, inputs.deployWaitTimeoutMs)

    if (TERMINAL_ERROR.has(result.status)) {
      throw new Error(`Deployment ${deploymentId} failed with status: ${result.status}`)
    }

    core.info('Deploy completed successfully.')
  } catch (err) {
    failed = true
    caughtError = err
  } finally {
    await writeSummary(inputs, result, projectId, failed)
  }

  if (caughtError !== undefined) {
    throw caughtError
  }
}
