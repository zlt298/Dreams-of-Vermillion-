// Battle.choose, transactions (suspend a command for a decision, then replay it with the answer), checkpoints,
// determinism, and sandbox() rollback for previews.
import { describe, expect, it } from 'vitest'
import { Battle, type ChoiceQuestion } from '../../src/rules/battle'
import { autoBattle } from '../../src/ai/ai'
import { uidState } from '../../src/rules/stats'
import { arena, battle, duel, flatMap, pregenUnit } from '../support'

/** Assault (1,5) and Vanguard (1,7) against a Sniper (9,5) on a 14x14 map. */
const trio = () => {
  const a = pregenUnit('Assault'); const a2 = pregenUnit('Vanguard'); const e = pregenUnit('Sniper', 'enemy')
  const b = arena([[a, { x: 1, y: 5 }], [a2, { x: 1, y: 7 }], [e, { x: 9, y: 5 }]], { map: flatMap(14, 14) })
  return { a, a2, e, b }
}
/** Assault (2,5) vs Sniper (6,5), with the Assault's turn begun unless `begin` is false. */
function choiceDuel(seed = 5, begin = true) {
  const d = duel({ a: { x: 2, y: 5 }, seed })
  if (begin) d.b.beginTurn(d.a)
  return d
}
const q = (u: any, def = 1): ChoiceQuestion => ({ kind: 'test', unit: u, title: 'Pick', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }], defaultIndex: def })

/** everything a replay must reproduce */
const state = (b: Battle) => JSON.stringify({
  units: b.units.map(u => ({ id: u.id, hp: u.hp, heat: u.heat, pos: u.pos, statuses: u.statuses, flags: u.flags, structure: u.structure, w: u.weapons.map(w => [w.loaded, w.usesLeft, w.profileIndex]) })),
  rng: b.rng.state, log: b.log.length, ev: b.eventCount, areas: b.areas, tiles: b.map.tiles,
})

describe('Battle.choose', () => {
  it('enemies, battles without a UI and AI-driven sides take the default', () => {
    const { a, e, b } = choiceDuel()
    expect(b.choose(q(e, 2))).toBe(2)
    expect(b.choose(q(a, 1))).toBe(1) // no chooser
    b.chooser = () => 0
    b.aiSide = 'player'
    expect(b.choose(q(a, 1))).toBe(1)
  })

  it('outside a transaction the chooser cannot defer, so the default is used', () => {
    const { a, b } = choiceDuel()
    b.chooser = () => undefined
    expect(b.choose(q(a, 2))).toBe(2)
  })

  it('a deferred question rolls the command back; the replay consumes the queued answer', () => {
    const { a, b } = choiceDuel()
    b.chooser = () => undefined
    const before = state(b)
    let picked = -1
    const cmd = () => { b.addHeat(a, 2); b.move(a, { x: 3, y: 3 }); picked = b.choose(q(a)) }
    const r1 = b.transaction(cmd)
    expect('pending' in r1 && r1.pending.kind).toBe('test')
    expect(state(b)).toBe(before)
    const r2 = b.transaction(cmd, [2])
    expect('pending' in r2).toBe(false)
    expect(picked).toBe(2)
    expect(a.heat).toBe(2)
    expect(a.pos).toEqual({ x: 3, y: 3 })
  })

  it('render listeners only see the events of the successful run', () => {
    const { a, b } = choiceDuel()
    b.chooser = () => undefined
    const seen: string[] = []
    b.listeners.push(ev => seen.push(ev.type))
    const cmd = () => { b.move(a, { x: 3, y: 3 }); b.choose(q(a)) }
    b.transaction(cmd)
    expect(seen).toHaveLength(0)
    b.transaction(cmd, [0])
    expect(seen).toContain('move')
  })
})

describe('transactions', () => {
  it('a player command that throws part-way is rolled back by transaction(rollbackOnError)', () => {
    const { a, b } = duel()
    b.beginTurn(a)
    const hp = a.hp
    const r = b.transaction(() => { a.hp -= 3; throw new Error('refused') }, [], { rollbackOnError: true })
    expect('error' in r && r.error?.message).toBe('refused')
    expect(a.hp).toBe(hp)
    // without the option (the AI path), work done before the error is kept
    b.transaction(() => { a.hp -= 3; throw new Error('refused') })
    expect(a.hp).toBe(hp - 3)
  })

  // regression: a PendingChoice raised mid-move (First Gate steering) was swallowed
  it('a PendingChoice raised during a move steered by First Gate (OSIRIS) is not swallowed', () => {
    const a = pregenUnit('Assault'); const v = pregenUnit('Vanguard'); const e = pregenUnit('Sniper', 'enemy')
    a.systems.push({ uid: 'sosiris', dataId: 'ms_osiris_class_nhp', name: 'OSIRIS', destroyed: false, charged: true } as any)
    a.pos = { x: 1, y: 1 }; v.pos = { x: 6, y: 6 }; e.pos = { x: 7, y: 6 }
    v.policies.overwatch = 'ask'
    const b = battle([a, v, e], flatMap(14, 14))
    b.beginTurn(a); b.endTurn(a)
    e.flags.duatSteer = a.id
    const asked: string[] = []
    b.chooser = q => { asked.push(q.kind); return undefined }
    const r1: any = b.transaction(() => b.beginTurn(e))
    expect(r1.pending?.kind).toBe('duat_steer')
    // 'Toward me': the steered move starts inside the Vanguard's threat, so the player is asked about Overwatch
    const r2: any = b.transaction(() => b.beginTurn(e), [0])
    expect(asked).toContain('overwatch')
    // the question must suspend the command (and be replayed with its answer), not be silently dropped mid-move
    expect(r2.pending?.kind).toBe('overwatch')
  })

  // regression: a rolled-back command left the id counter advanced, so ids diverged from replays
  it('rolling a command back for a decision also rolls back the id counter, so ids match an uninterrupted run (and replays)', () => {
    const { a, b } = trio()
    b.beginTurn(a)
    const u0 = uidState()
    const cmd = () => {
      const m = b.placeMine(a, { x: 2, y: 5 }, { name: 'Test Mine', radius: 1, damage: [] }, { noCheck: true })
      b.choose({ kind: 'test', unit: a, title: 'Pick', options: [{ label: 'A' }, { label: 'B' }], defaultIndex: 0 })
      return m
    }
    b.chooser = () => undefined
    const r1 = b.transaction(() => { cmd() })
    expect('pending' in r1).toBe(true)
    b.transaction(() => { cmd() }, [1])
    // one mine was planted; an uninterrupted run (and replayBattle, which runs each command once) names it mine<u0+1>
    expect(b.mines.map(m => m.id)).toEqual([`mine${u0 + 1}`])
  })
})

describe('determinism', () => {
  it('a checkpoint restores a whole AI battle exactly, keeping object identity', () => {
    const { a, b } = choiceDuel(11, false)
    const w0 = a.weapons[0]
    const before = state(b)
    const restore = b.checkpoint()
    autoBattle(b, 3)
    expect(state(b)).not.toBe(before)
    restore()
    expect(state(b)).toBe(before)
    expect(b.units[0]).toBe(a)
    expect(a.weapons[0]).toBe(w0)
  })

  it('replaying from a checkpoint reproduces the same outcome (seeded RNG)', () => {
    const { b } = choiceDuel(21, false)
    const restore = b.checkpoint()
    autoBattle(b, 3)
    const once = state(b)
    restore()
    autoBattle(b, 3)
    expect(state(b)).toBe(once)
  })
})

describe('sandbox rollback', () => {
  it('a simulated kill that ends the round or battle does not leak turn state', () => {
    const a = pregenUnit('Assault'), e = pregenUnit('Sniper', 'enemy'), e2 = pregenUnit('Vanguard', 'enemy')
    a.pos = { x: 1, y: 1 }; e.pos = { x: 8, y: 8 }; e2.pos = { x: 9, y: 9 }
    const b = battle([a, e, e2])
    b.beginTurn(a)
    const before = { round: b.round, side: b.currentSide, active: b.activeId, winner: b.winner }
    // killing the active unit with nothing left to activate ends the round; killing every enemy ends the battle
    b.sandbox(() => { for (const u of b.units) u.activationsLeft = 0; b.destroy(a, 'test') })
    b.sandbox(() => { b.destroy(e, 'test'); b.destroy(e2, 'test') })
    expect({ round: b.round, side: b.currentSide, active: b.activeId, winner: b.winner }).toEqual(before)
    expect(a.destroyed).toBe(false)
  })

  it('terrain destroyed inside a sandbox is restored', () => {
    const map = flatMap(12, 12, (x, y) => (x === 5 && y === 5 ? { h: 2, kind: 'block' } : undefined))
    const a = pregenUnit('Assault'), e = pregenUnit('Sniper', 'enemy')
    a.pos = { x: 1, y: 1 }; e.pos = { x: 8, y: 8 }
    const b = battle([a, e], map)
    const tile = map.tiles[5 * 12 + 5]
    b.sandbox(() => { b.damageTerrain({ x: 5, y: 5 }, 30); expect(tile.kind).toBe('rubble') })
    expect(tile).toMatchObject({ h: 2, kind: 'block' })
    // outside a sandbox the damage sticks
    b.damageTerrain({ x: 5, y: 5 }, 10)
    expect(tile.h).toBe(1)
  })

  // regression: terrain caches built inside a preview survived the rollback (stale wreck cover / smoke)
  it('sandbox(): terrain caches built inside a preview survive the rollback (stale wreck cover / smoke)', () => {
    const a = pregenUnit('Assault'); const e1 = pregenUnit('Sniper', 'enemy'); const e2 = pregenUnit('Hacker', 'enemy')
    a.pos = { x: 1, y: 5 }; e1.pos = { x: 4, y: 5 }; e2.pos = { x: 5, y: 5 }
    const b = battle([a, e1, e2], flatMap(12, 12))
    expect(b.cover(a, e2)).toBe('none')
    // a preview in which e1 dies (becomes wreckage = hard cover) and cover is evaluated
    b.sandbox(() => { b.destroy(e1, 'test'); expect(b.cover(a, e2)).toBe('hard') })
    expect(e1.destroyed).toBe(false) // rolled back
    expect(b.cover(a, e2)).toBe('none') // was: 'hard' — mapCache/coverCache keyed on a terrainVersion the rollback never bumps
    // same for areas: a preview's smoke cloud lingers in the cover cache
    const b2 = battle([pregenUnit('Assault'), pregenUnit('Hacker', 'enemy')].map((u, i) => { u.pos = { x: 1 + i * 4, y: 5 }; return u }), flatMap(12, 12))
    const [x, y] = b2.units
    b2.sandbox(() => { b2.addArea({ kind: 'soft_cover', tiles: [{ x: 5, y: 5 }] }); b2.cover(x, y) })
    expect(b2.areas.length).toBe(0)
    expect(b2.cover(x, y)).toBe('none') // was: 'soft'
  })
})
