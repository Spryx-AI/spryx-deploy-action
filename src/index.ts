import * as core from '@actions/core'
import { run } from './action'

run().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err))
})
