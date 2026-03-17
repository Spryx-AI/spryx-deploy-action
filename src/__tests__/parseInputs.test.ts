import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as core from '@actions/core'
import { parseInputs } from '../action'

vi.mock('@actions/core')

const mockGetInput = vi.mocked(core.getInput)

function setInputs(inputs: Record<string, string>) {
  mockGetInput.mockImplementation((name: string, options?: { required?: boolean }) => {
    const value = inputs[name] ?? ''
    if (options?.required && !value) {
      throw new Error(`Input required and not supplied: ${name}`)
    }
    return value
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('parseInputs', () => {
  it('parses valid inputs', () => {
    setInputs({
      service_id: 'srv_1',
      image: 'ghcr.io/org/app:1.0.0',
      environment: 'production',
      environment_id: 'env_123',
      railway_token: 'tok_abc',
    })

    const inputs = parseInputs()

    expect(inputs.serviceId).toBe('srv_1')
    expect(inputs.image).toBe('ghcr.io/org/app:1.0.0')
    expect(inputs.environment).toBe('production')
    expect(inputs.environmentId).toBe('env_123')
    expect(inputs.railwayToken).toBe('tok_abc')
  })

  it('throws when service_id is missing', () => {
    setInputs({
      image: 'ghcr.io/org/app:1.0.0',
      environment: 'production',
      environment_id: 'env_1',
      railway_token: 'tok',
    })

    expect(() => parseInputs()).toThrow('Input required and not supplied: service_id')
  })

  it('throws when image is missing', () => {
    setInputs({
      service_id: 'srv_1',
      environment: 'production',
      environment_id: 'env_1',
      railway_token: 'tok',
    })

    expect(() => parseInputs()).toThrow('Input required and not supplied: image')
  })

  it('parses deploy_wait_timeout_minutes into milliseconds', () => {
    setInputs({
      service_id: 'srv_1',
      image: 'img:1',
      environment: 'production',
      environment_id: 'env_1',
      railway_token: 'tok',
      deploy_wait_timeout_minutes: '5',
    })

    expect(parseInputs().deployWaitTimeoutMs).toBe(300_000)
  })

  it('defaults deploy_wait_timeout_minutes to 10 minutes when not provided', () => {
    setInputs({
      service_id: 'srv_1',
      image: 'img:1',
      environment: 'production',
      environment_id: 'env_1',
      railway_token: 'tok',
    })

    expect(parseInputs().deployWaitTimeoutMs).toBe(600_000)
  })
})
