// AI planning: where it moves, when it uses its CORE, and the previews and turn bookkeeping its plans rely on
// (a preview must leave no trace; status clocks must keep running when their source is gone).
import { describe, expect, it } from 'vitest'
import { importPilots } from '../../src/import/compcon'
import { buildMechUnit } from '../../src/rules/stats'
import { buildTeam } from '../../src/enemies/build'
import { planFor } from '../../src/ai/ai'
import ll10 from '../../src/data/squads/ll10.json'
import { battle, flatMap, mech, pregenUnit, teamFile } from '../support'

const drake = () => {
  const u = buildMechUnit(importPilots((ll10 as any[]).find(p => p.mechs?.some((m: any) => /drake/i.test(m.frame))) ?? (ll10 as any[])[0])[0])
  expect(u.frameId).toBe('mf_drake')
  return u
}

describe('AI movement', () => {
  // regression: the AI ended its turn in dangerous terrain when a safe tile was as good
  it('does not choose to end its turn in dangerous terrain when a safe tile is as good', () => {
    const a = pregenUnit('Assault'); a.pos = { x: 6, y: 6 }
    const e = buildTeam(teamFile('t1-checkpoint-garrison'), 1)[0]; e.pos = { x: 6, y: 1 }
    const b = battle([a, e], flatMap(12, 12), 3)
    b.currentSide = 'enemy'; a.activationsLeft = 0
    b.beginTurn(e)
    const dest = planFor(b, e).dest
    const map = flatMap(12, 12, (x, y) => (x === dest.x && y === dest.y ? { kind: 'hazard' } : undefined))
    const a2 = pregenUnit('Assault'); a2.pos = { x: 6, y: 6 }
    const e2 = buildTeam(teamFile('t1-checkpoint-garrison'), 1)[0]; e2.pos = { x: 6, y: 1 }
    const b2 = battle([a2, e2], map, 3)
    b2.currentSide = 'enemy'; a2.activationsLeft = 0
    b2.beginTurn(e2)
    expect(dest).not.toEqual({ x: 6, y: 1 }) // the scenario only means something if the AI wants to move
    expect(planFor(b2, e2).dest).not.toEqual(dest)
  })
})

describe('AI: Drake Fortress Protocol', () => {
  it('only roots itself within reach of a hostile', () => {
    const d = drake(), e = pregenUnit('Sniper', 'enemy')
    d.pos = { x: 2, y: 2 }; e.pos = { x: 2, y: 11 } // within 10 tiles, but beyond a short-range Drake's guns
    const b = battle([d, e], flatMap(12, 14))
    b.round = 2
    b.beginTurn(d)
    const reach = Math.max(...d.weapons.filter(w => !w.tech).map(w => b.weaponReach(d, w)))
    expect(reach).toBeLessThan(9)
    const plan = planFor(b, d)
    // it closes in first, and only roots where it can actually shoot
    expect(plan.actions.some(a => a.kind === 'core')).toBe(true)
    expect(Math.max(Math.abs(plan.dest.x - e.pos.x), Math.abs(plan.dest.y - e.pos.y))).toBeLessThanOrEqual(reach)
  })

  it('folds Fortress up when nothing hostile is in reach', () => {
    const d = drake(), e = pregenUnit('Sniper', 'enemy')
    d.pos = { x: 2, y: 2 }; e.pos = { x: 3, y: 3 }
    const b = battle([d, e], flatMap(30, 30))
    b.beginTurn(d)
    b.activateCore(d)
    expect(d.flags.fortress).toBe(true)
    e.pos = { x: 28, y: 28 }
    b.endTurn(d)
    const off = b.customActions(d).find(a => a.key === 'fortress_off')!
    expect(off.aiScore!(b, d)).toBeGreaterThan(0)
    e.pos = { x: 3, y: 3 }
    expect(off.aiScore!(b, d)).toBeLessThan(0)
  })
})

describe('previews cannot change whose turn it is or who won', () => {
  // regression: Cover Me! fired during an attack preview, spending the reaction and ending the turn
  it('Cover Me! does not fire during an attack preview', () => {
    const guard = mech({ talents: [['t_bonded', 3]] }); guard.pos = { x: 3, y: 5 }
    const mate = pregenUnit('Hacker'); mate.pos = { x: 5, y: 5 }
    const foe = pregenUnit('Assault', 'enemy'); foe.pos = { x: 6, y: 5 }
    foe.hp = 1; foe.structure = 1
    guard.flags.bondmate = mate.id
    const b = battle([guard, mate, foe])
    guard.activationsLeft = 0; mate.activationsLeft = 0
    b.currentSide = 'enemy'
    b.beginTurn(foe)
    for (const w of foe.weapons) { b.previewAttack(foe, w, mate); b.previewDetail(foe, w, mate) }
    expect(b.winner).toBeFalsy()
    expect(b.activeId).toBe(foe.id)
    expect(foe.destroyed).toBe(false)
    expect(guard.reactionsLeft).toBe(guard.reactionsPerRound)
  })

  // regression: a preview that destroyed units or terrain left them destroyed
  it('a preview that destroys units or terrain leaves no trace (sandbox restores battle state and tiles)', () => {
    const a = pregenUnit('Assault'); a.pos = { x: 1, y: 5 }
    const e = pregenUnit('Sniper', 'enemy'); e.pos = { x: 6, y: 5 }
    const b = battle([a, e], flatMap(12, 12, (x, y) => (x === 3 && y === 3 ? { h: 1, kind: 'block' } : undefined)))
    b.beginTurn(a)
    const before = JSON.stringify(b.map.tiles)
    b.sandbox(() => {
      b.damageTerrain({ x: 3, y: 3 }, 50)
      b.raiseCover({ x: 4, y: 4 })
      b.destroy(e, 'test')
    })
    expect(JSON.stringify(b.map.tiles)).toBe(before)
    expect(b.winner).toBeFalsy()
    expect(b.activeId).toBe(a.id)
    expect(e.destroyed).toBe(false)
  })
})

describe('status clocks of destroyed units', () => {
  // regression: a status timed to a destroyed unit's turns never ended, stalling autoBattles
  it('a status timed to another unit\'s turns ends even if that unit is destroyed off-turn', () => {
    const p = pregenUnit('Assault'); p.pos = { x: 1, y: 1 }
    const e = pregenUnit('Sniper', 'enemy'); e.pos = { x: 8, y: 8 }
    const e2 = pregenUnit('Hacker', 'enemy'); e2.pos = { x: 10, y: 10 }
    const b = battle([p, e, e2])
    b.addStatus(p, 'impaired', 'next_turn_end_source', e)
    b.destroy(e, 'test')
    for (let i = 0; i < 4 && !b.winner; i++) {
      for (const u of [p, e2]) { if (b.currentSide === u.side && !b.activeId && u.activationsLeft > 0) { b.beginTurn(u); b.endTurn(u) } }
    }
    expect(b.has(p, 'impaired')).toBe(false)
  })
  // regression: as above, for a source destroyed during another unit's turn
  it('during another unit\'s turn, the orphaned status ends with that turn', () => {
    const p = pregenUnit('Assault'); p.pos = { x: 1, y: 1 }
    const e = pregenUnit('Sniper', 'enemy'); e.pos = { x: 8, y: 8 }
    const e2 = pregenUnit('Hacker', 'enemy'); e2.pos = { x: 10, y: 10 }
    const b = battle([p, e, e2])
    b.addStatus(p, 'slowed', 'next_turn_end_source', e)
    b.beginTurn(p)
    b.destroy(e, 'test')
    expect(b.has(p, 'slowed')).toBe(true)
    b.endTurn(p)
    expect(b.has(p, 'slowed')).toBe(false)
  })
})
