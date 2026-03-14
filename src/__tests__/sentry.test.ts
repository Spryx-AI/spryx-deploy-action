import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as core from '@actions/core'
import * as actionsExec from '@actions/exec'
import { trackSentryRelease } from '../action'

vi.mock('@actions/core')
vi.mock('@actions/exec')

const mockExec = vi.mocked(actionsExec.exec)
const mockInfo = vi.mocked(core.info)

beforeEach(() => {
  vi.clearAllMocks()
  mockExec.mockResolvedValue(0)
})

describe('trackSentryRelease', () => {
  it('skips when sentryAuthToken is empty', async () => {
    await trackSentryRelease('app@1.0.0', '', 'my-org', ['api'], 'production')

    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('skipping Sentry release tracking'))
    expect(mockExec).not.toHaveBeenCalled()
  })

  it('installs sentry-cli and runs all three commands', async () => {
    await trackSentryRelease('app@1.0.0', 'sntr_tok', 'my-org', ['api'], 'production')

    const calls = mockExec.mock.calls.map((c) => c.slice(0, 2))
    expect(calls).toContainEqual(['npm', ['install', '-g', '@sentry/cli@2.28.0']])
    expect(calls).toContainEqual(['sentry-cli', ['releases', 'new', 'app@1.0.0', '-p', 'api']])
    expect(calls).toContainEqual(['sentry-cli', ['releases', 'set-commits', 'app@1.0.0', '--auto']])
    expect(calls).toContainEqual(['sentry-cli', ['releases', 'deploys', 'app@1.0.0', 'new', '-e', 'production']])
  })

  it('passes correct project flags for multiple projects', async () => {
    await trackSentryRelease('app@1.0.0', 'sntr_tok', 'my-org', ['api', 'worker', 'bo-api'], 'staging')

    const newReleaseCall = mockExec.mock.calls.find((c) => c[1]?.includes('new') && c[0] === 'sentry-cli')
    expect(newReleaseCall?.[1]).toEqual(['releases', 'new', 'app@1.0.0', '-p', 'api', '-p', 'worker', '-p', 'bo-api'])
  })

  it('continues and warns if sentry-cli releases new fails with already exists', async () => {
    mockExec
      .mockResolvedValueOnce(0) // npm install
      .mockRejectedValueOnce(new Error('release already exists')) // releases new
      .mockResolvedValueOnce(0) // set-commits
      .mockResolvedValueOnce(0) // deploys new

    await expect(trackSentryRelease('app@1.0.0', 'sntr_tok', 'my-org', [], 'production')).resolves.not.toThrow()

    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('release already exists'))
    expect(mockExec).toHaveBeenCalledTimes(4)
  })

  it('rethrows if sentry-cli releases new fails with an unexpected error', async () => {
    mockExec
      .mockResolvedValueOnce(0) // npm install
      .mockRejectedValueOnce(new Error('authentication failed')) // releases new

    await expect(trackSentryRelease('app@1.0.0', 'sntr_tok', 'my-org', [], 'production')).rejects.toThrow(
      'authentication failed'
    )
  })

  it('passes SENTRY_AUTH_TOKEN and SENTRY_ORG in env', async () => {
    await trackSentryRelease('app@1.0.0', 'sntr_tok', 'my-org', [], 'production')

    const sentryCall = mockExec.mock.calls.find((c) => c[0] === 'sentry-cli')
    const env = sentryCall?.[2]?.env as Record<string, string>
    expect(env['SENTRY_AUTH_TOKEN']).toBe('sntr_tok')
    expect(env['SENTRY_ORG']).toBe('my-org')
  })
})
