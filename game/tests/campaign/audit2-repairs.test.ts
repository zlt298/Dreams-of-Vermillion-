// Audit 2: field repairs between battles (core book p.82).
import { describe, expect, it } from 'vitest'
import { applyRepair, newRun } from '../../src/run/run'
import { buildMechUnit } from '../../src/rules/stats'
import { pregenPilots } from '../support'

describe('repairing Structure', () => {
  it('2 Repairs restore 1 Structure only; HP is a separate purchase', () => {
    const run = newRun(pregenPilots(), 3)
    const p = run.squad[0]
    const c = run.condition[p.id]
    const max = buildMechUnit(p).stats
    c.structure = max.structure - 1
    c.hp = 3
    c.repairs = 4
    applyRepair(run, p.id, 'structure')
    expect(c.structure).toBe(max.structure)
    expect(c.hp).toBe(3)
    applyRepair(run, p.id, 'hp')
    expect(c.hp).toBe(max.hp)
  })
})
