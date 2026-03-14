import { describe, it, expect, vi, beforeEach } from 'vitest'
import { railwayGraphQL, updateServiceImage, deployService } from '../action'

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
  it('sends correct mutation and variables', async () => {
    mockResponse({})

    await deployService('tok', 'env_1', 'srv_1')

    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.variables).toEqual({ environmentId: 'env_1', serviceId: 'srv_1' })
    expect(body.query).toContain('serviceInstanceDeploy')
  })
})
