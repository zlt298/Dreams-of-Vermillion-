import { describe, it, expect } from 'vitest'
import { battle, flatMap, pregenUnit } from './helpers'
import { planFor } from '../src/ai/ai'
import { importPilots } from '../src/import/compcon'
import { buildMechUnit } from '../src/rules/stats'
import ll10 from '../src/data/squads/ll10.json'

const drake = () => {
  const u = buildMechUnit(importPilots((ll10 as any[]).find(p => p.mechs?.some((m: any) => /drake/i.test(m.frame))) ?? (ll10 as any[])[0])[0])
  expect(u.frameId).toBe('mf_drake')
  return u
}

describe('AI: Drake Fortress Protocol', () => {
  it('only roots itself within reach of a hostile', () => {
    const d = drake(), e = pregenUnit('Sniper', 'enemy')
    d.pos = { x: 2, y: 2 }; e.pos = { x: 2, y: 11 } // within 10 tiles, but beyond a short-range Drake's guns
    const b = battle([d, e], flatMap(12, 14))
    b.round = 2
    b.beginTurn(d)
    const reach = Math.max(...d.weapons.filter(w => !w.tech).map(w => b.weaponReach(d, w)))
    const plan = planFor(b, d)
    // it may close in first, but only roots where it can actually shoot
    if (plan.actions.some(a => a.kind === 'core')) expect(Math.max(Math.abs(plan.dest.x - e.pos.x), Math.abs(plan.dest.y - e.pos.y))).toBeLessThanOrEqual(reach)
    expect(reach).toBeLessThan(9)
  })

  it('folds Fortress up when nothing hostile is in reach', () => {
    const d = drake(), e = pregenUnit('Sniper', 'enemy')
    d.pos = { x: 2, y: 2 }; e.pos = { x: 3, y: 3 }
    const b = battle([d, e], flatMap(30, 30))
    b.beginTurn(d)
    b.activateCore(d)
    expect(d.flags.fortress).toBe(true)
    e.pos = { x: 28, y: 28 }
    b.endTurn(d); b.startRound?.()
    const off = b.customActions(d).find(a => a.key === 'fortress_off')!
    expect(off.aiScore!(b, d)).toBeGreaterThan(0)
    e.pos = { x: 3, y: 3 }
    expect(off.aiScore!(b, d)).toBeLessThan(0)
  })
})
