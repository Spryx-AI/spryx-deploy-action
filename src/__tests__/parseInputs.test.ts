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
  it('parses valid services and inputs', () => {
    setInputs({
      services: '[{"serviceId":"srv_1","image":"ghcr.io/org/app:1.0.0"}]',
      environment: 'production',
      environment_id: 'env_123',
      railway_token: 'tok_abc',
      release_name: 'my-app@1.0.0',
      sentry_auth_token: 'sntr_token',
      sentry_org: 'my-org',
      sentry_projects: 'api,worker',
    })

    const inputs = parseInputs()

    expect(inputs.services).toEqual([{ serviceId: 'srv_1', image: 'ghcr.io/org/app:1.0.0' }])
    expect(inputs.environment).toBe('production')
    expect(inputs.environmentId).toBe('env_123')
    expect(inputs.railwayToken).toBe('tok_abc')
    expect(inputs.releaseName).toBe('my-app@1.0.0')
    expect(inputs.sentryAuthToken).toBe('sntr_token')
    expect(inputs.sentryOrg).toBe('my-org')
    expect(inputs.sentryProjects).toEqual(['api', 'worker'])
  })

  it('parses multiple services', () => {
    setInputs({
      services: '[{"serviceId":"srv_1","image":"img:1"},{"serviceId":"srv_2","image":"img:2"}]',
      environment: 'staging',
      environment_id: 'env_1',
      railway_token: 'tok',
      release_name: 'app@1.0.0',
      sentry_projects: '',
    })

    const inputs = parseInputs()

    expect(inputs.services).toHaveLength(2)
    expect(inputs.sentryProjects).toEqual([])
  })

  it('filters empty values from sentry_projects', () => {
    setInputs({
      services: '[{"serviceId":"srv_1","image":"img:1"}]',
      environment: 'staging',
      environment_id: 'env_1',
      railway_token: 'tok',
      release_name: 'app@1.0.0',
      sentry_projects: 'api,,worker,',
    })

    expect(parseInputs().sentryProjects).toEqual(['api', 'worker'])
  })

  it('trims whitespace from sentry_projects entries', () => {
    setInputs({
      services: '[{"serviceId":"srv_1","image":"img:1"}]',
      environment: 'staging',
      environment_id: 'env_1',
      railway_token: 'tok',
      release_name: 'app@1.0.0',
      sentry_projects: 'api, worker, bo-api',
    })

    expect(parseInputs().sentryProjects).toEqual(['api', 'worker', 'bo-api'])
  })

  it('throws on invalid JSON in services', () => {
    setInputs({
      services: 'not-json',
      environment: 'production',
      environment_id: 'env_1',
      railway_token: 'tok',
      release_name: 'app@1.0.0',
    })

    expect(() => parseInputs()).toThrow('Invalid services input')
  })

  it('throws when services is not an array', () => {
    setInputs({
      services: '{"serviceId":"srv_1"}',
      environment: 'production',
      environment_id: 'env_1',
      railway_token: 'tok',
      release_name: 'app@1.0.0',
    })

    expect(() => parseInputs()).toThrow('Invalid services input')
  })

  it('throws when a service is missing serviceId', () => {
    setInputs({
      services: '[{"image":"ghcr.io/org/app:1.0.0"}]',
      environment: 'production',
      environment_id: 'env_1',
      railway_token: 'tok',
      release_name: 'app@1.0.0',
    })

    expect(() => parseInputs()).toThrow('Invalid services input')
  })

  it('throws when a service is missing image', () => {
    setInputs({
      services: '[{"serviceId":"srv_1"}]',
      environment: 'production',
      environment_id: 'env_1',
      railway_token: 'tok',
      release_name: 'app@1.0.0',
    })

    expect(() => parseInputs()).toThrow('Invalid services input')
  })

  it('throws when a service entry is null', () => {
    setInputs({
      services: '[null]',
      environment: 'production',
      environment_id: 'env_1',
      railway_token: 'tok',
      release_name: 'app@1.0.0',
    })

    expect(() => parseInputs()).toThrow('Invalid services input')
  })

  it('parses deploy_wait_timeout_minutes into milliseconds', () => {
    setInputs({
      services: '[{"serviceId":"srv_1","image":"img:1"}]',
      environment: 'production',
      environment_id: 'env_1',
      railway_token: 'tok',
      release_name: 'app@1.0.0',
      deploy_wait_timeout_minutes: '5',
    })

    expect(parseInputs().deployWaitTimeoutMs).toBe(300_000)
  })

  it('defaults deploy_wait_timeout_minutes to 10 minutes when not provided', () => {
    setInputs({
      services: '[{"serviceId":"srv_1","image":"img:1"}]',
      environment: 'production',
      environment_id: 'env_1',
      railway_token: 'tok',
      release_name: 'app@1.0.0',
    })

    expect(parseInputs().deployWaitTimeoutMs).toBe(600_000)
  })
})
