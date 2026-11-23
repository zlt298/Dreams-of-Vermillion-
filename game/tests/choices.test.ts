// Battle.choose, checkpoints and the suspend-and-replay transaction used by the HUD picker.
import { describe, expect, it } from 'vitest'
import { Battle, type ChoiceQuestion } from '../src/rules/battle'
import { autoBattle } from '../src/ai/ai'
import { flatMap, pregenUnit } from './helpers'

function setup(seed = 5, begin = true) {
  const a = pregenUnit('Assault')
  const e = pregenUnit('Sniper', 'enemy')
  a.pos = { x: 2, y: 5 }
  e.pos = { x: 6, y: 5 }
  const b = new Battle({ map: flatMap(12, 12), units: [a, e], seed })
  b.start()
  if (begin) b.beginTurn(a)
  return { a, e, b }
}
const q = (u: any, def = 1): ChoiceQuestion => ({ kind: 'test', unit: u, title: 'Pick', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }], defaultIndex: def })

/** everything a replay must reproduce */
const state = (b: Battle) => JSON.stringify({
  units: b.units.map(u => ({ id: u.id, hp: u.hp, heat: u.heat, pos: u.pos, statuses: u.statuses, flags: u.flags, structure: u.structure, w: u.weapons.map(w => [w.loaded, w.usesLeft, w.profileIndex]) })),
  rng: b.rng.state, log: b.log.length, ev: b.eventCount, areas: b.areas, tiles: b.map.tiles,
})

describe('Battle.choose', () => {
  it('enemies, battles without a UI and AI-driven sides take the default', () => {
    const { a, e, b } = setup()
    expect(b.choose(q(e, 2))).toBe(2)
    expect(b.choose(q(a, 1))).toBe(1) // no chooser
    b.chooser = () => 0
    b.aiSide = 'player'
    expect(b.choose(q(a, 1))).toBe(1)
  })
  it('outside a transaction the chooser cannot defer, so the default is used', () => {
    const { a, b } = setup()
    b.chooser = () => undefined
    expect(b.choose(q(a, 2))).toBe(2)
  })
  it('a deferred question rolls the command back; the replay consumes the queued answer', () => {
    const { a, b } = setup()
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
    const { a, b } = setup()
    b.chooser = () => undefined
    const seen: string[] = []
    b.listeners.push(ev => seen.push(ev.type))
    const cmd = () => { b.move(a, { x: 3, y: 3 }); b.choose(q(a)) }
    b.transaction(cmd)
    expect(seen).toHaveLength(0)
    b.transaction(cmd, [0])
    expect(seen).toContain('move')
  })
  it('a checkpoint restores a whole AI battle exactly, keeping object identity', () => {
    const { a, b } = setup(11, false)
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
    const { b } = setup(21, false)
    const restore = b.checkpoint()
    autoBattle(b, 3)
    const once = state(b)
    restore()
    autoBattle(b, 3)
    expect(state(b)).toBe(once)
  })
  it("an 'ask' brace pauses an enemy attack until the player answers", () => {
    const { a, e, b } = setup()
    b.chooser = () => undefined
    a.policies.brace = 'ask'
    a.hp = 2
    b.endTurn(a)
    b.currentSide = 'enemy'
    b.beginTurn(e)
    e.stats.attackBonus = 40
    const w = e.weapons.find(x => b.weaponUsable(e, x) === true)!
    const fire = () => { b.skirmish(e, w, { targetId: a.id }) }
    const r = b.transaction(fire)
    expect('pending' in r && r.pending.kind).toBe('brace')
    expect(b.has(a, 'braced')).toBe(false)
    b.transaction(fire, [0])
    expect(b.has(a, 'braced')).toBe(true)
  })
})
