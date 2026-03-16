import { describe, it, expect, vi, beforeEach } from 'vitest'
import { railwayGraphQL, updateServiceImage, deployService, pollDeploymentStatus } from '../action'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function mockResponse(body: unknown, ok = true, statusText = 'OK') {
  mockFetch.mockResolvedValueOnce({
    ok,
    statusText,
    json: () => Promise.resolve(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('railwayGraphQL', () => {
  it('calls the Railway GraphQL endpoint with correct headers', async () => {
    mockResponse({})

    await railwayGraphQL('tok_123', 'query { test }', { foo: 'bar' })

    const [url, options] = mockFetch.mock.calls[0]
    expect(url).toBe('https://backboard.railway.com/graphql/v2')
    expect(options.method).toBe('POST')
    expect(options.headers['Content-Type']).toBe('application/json')
    expect(options.headers['Authorization']).toBe('Bearer tok_123')
    expect(options.body).toBe(JSON.stringify({ query: 'query { test }', variables: { foo: 'bar' } }))
    expect(options.signal).toBeInstanceOf(AbortSignal)
  })

  it('throws a timeout error when the request is aborted', async () => {
    mockFetch.mockImplementationOnce((_url: string, { signal }: { signal: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    })

    // Use fake timers so we don't wait 30s
    vi.useFakeTimers()
    const promise = railwayGraphQL('tok', 'query {}', {})
    vi.advanceTimersByTime(30_000)
    await expect(promise).rejects.toThrow('Railway API request timed out')
    vi.useRealTimers()
  })

  it('throws on HTTP error', async () => {
    mockResponse({}, false, 'Unauthorized')

    await expect(railwayGraphQL('tok', 'query {}', {})).rejects.toThrow('Railway API error: Unauthorized')
  })

  it('throws on GraphQL errors in response body', async () => {
    mockResponse({ errors: [{ message: 'service not found' }] })

    await expect(railwayGraphQL('tok', 'query {}', {})).rejects.toThrow('Railway API error: service not found')
  })

  it('joins multiple GraphQL errors', async () => {
    mockResponse({ errors: [{ message: 'err1' }, { message: 'err2' }] })

    await expect(railwayGraphQL('tok', 'query {}', {})).rejects.toThrow('Railway API error: err1, err2')
  })
})

describe('updateServiceImage', () => {
  it('sends correct mutation and variables', async () => {
    mockResponse({})

    await updateServiceImage('tok', 'env_1', 'srv_1', 'ghcr.io/org/app:1.0.0')

    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.variables).toEqual({
      environmentId: 'env_1',
      serviceId: 'srv_1',
      input: { source: { image: 'ghcr.io/org/app:1.0.0' } },
    })
    expect(body.query).toContain('serviceInstanceUpdate')
  })
})

describe('deployService', () => {
  it('sends correct mutation and variables and returns deploymentId', async () => {
    mockResponse({ data: { serviceInstanceDeploy: 'dep_abc123' } })

    const deploymentId = await deployService('tok', 'env_1', 'srv_1')

    expect(deploymentId).toBe('dep_abc123')
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.variables).toEqual({ environmentId: 'env_1', serviceId: 'srv_1' })
    expect(body.query).toContain('serviceInstanceDeploy')
  })
})

describe('pollDeploymentStatus', () => {
  it('returns immediately on SUCCESS', async () => {
    mockResponse({
      data: {
        deployment: { status: 'SUCCESS', staticUrl: 'https://app.railway.app', createdAt: '2026-01-01T00:00:00Z' },
      },
    })

    const result = await pollDeploymentStatus('tok', 'dep_1', 60_000)

    expect(result).toEqual({
      deploymentId: 'dep_1',
      status: 'SUCCESS',
      url: 'https://app.railway.app',
      createdAt: '2026-01-01T00:00:00Z',
    })
  })

  it('returns on FAILED terminal state', async () => {
    mockResponse({ data: { deployment: { status: 'FAILED', staticUrl: undefined, createdAt: undefined } } })

    const result = await pollDeploymentStatus('tok', 'dep_2', 60_000)

    expect(result.status).toBe('FAILED')
    expect(result.deploymentId).toBe('dep_2')
  })

  it('returns on CRASHED terminal state', async () => {
    mockResponse({ data: { deployment: { status: 'CRASHED' } } })

    const result = await pollDeploymentStatus('tok', 'dep_3', 60_000)

    expect(result.status).toBe('CRASHED')
  })

  it('polls until terminal state', async () => {
    vi.useFakeTimers()

    mockResponse({ data: { deployment: { status: 'BUILDING' } } })
    mockResponse({ data: { deployment: { status: 'DEPLOYING' } } })
    mockResponse({ data: { deployment: { status: 'SUCCESS', staticUrl: 'https://app.up.railway.app' } } })

    const promise = pollDeploymentStatus('tok', 'dep_4', 120_000, 10_000)

    await vi.advanceTimersByTimeAsync(10_000)
    await vi.advanceTimersByTimeAsync(10_000)
    const result = await promise

    expect(mockFetch).toHaveBeenCalledTimes(3)
    expect(result.status).toBe('SUCCESS')
    expect(result.url).toBe('https://app.up.railway.app')

    vi.useRealTimers()
  })

  it('throws when timeout is exceeded before terminal state', async () => {
    vi.useFakeTimers()

    mockFetch.mockResolvedValue({
      ok: true,
      statusText: 'OK',
      json: () => Promise.resolve({ data: { deployment: { status: 'BUILDING' } } }),
    })

    const promise = pollDeploymentStatus('tok', 'dep_5', 15_000, 10_000)
    const expectReject = expect(promise).rejects.toThrow('did not reach a terminal state within')

    await vi.advanceTimersByTimeAsync(10_000)
    await expectReject

    vi.useRealTimers()
  })

  it('sends correct query and variables', async () => {
    mockResponse({ data: { deployment: { status: 'SUCCESS' } } })

    await pollDeploymentStatus('tok', 'dep_xyz', 60_000)

    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.variables).toEqual({ id: 'dep_xyz' })
    expect(body.query).toContain('deployment(id: $id)')
    expect(body.query).toContain('status')
    expect(body.query).toContain('staticUrl')
  })
})
