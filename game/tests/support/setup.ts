// Runs before every test file (vitest setupFiles): keeps tests independent of each other's global state.
import { afterEach, beforeEach } from 'vitest'
import { setUidState } from '../../src/rules/stats'
import { aiErrors } from '../../src/ai/ai'
import { checkRiggedDiceUsed, resetPilotIds } from './index'

beforeEach(() => {
  // unit, weapon and mine ids depend only on what the test itself builds, not on earlier tests in the file
  setUidState(0)
  resetPilotIds()
  aiErrors.length = 0
})

afterEach(() => {
  delete (globalThis as any).localStorage
  checkRiggedDiceUsed()
})
