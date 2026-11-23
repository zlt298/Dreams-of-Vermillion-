// Grapples (core book), flight landing, zero-g areas and destructible terrain (house rule).
import { describe, expect, it } from 'vitest'
import { Battle } from '../src/rules/battle'
import { flatMap, pregenUnit } from './helpers'

function setup(map = flatMap(12, 12)) {
  const a = pregenUnit('Assault')
  const e = pregenUnit('Sniper', 'enemy')
  a.pos = { x: 5, y: 5 }
  e.pos = { x: 5, y: 6 }
  const b = new Battle({ map, units: [a, e], seed: 3 })
  b.start()
  b.beginTurn(a)
  return { a, e, b }
}

describe('grapples', () => {
  it('the larger side drags the smaller; the smaller is Immobilized', () => {
    const { a, e, b } = setup()
    a.stats.size = 2
    e.pos = { x: 5, y: 7 } // next to the 2x2 footprint
    b.startGrapple(a, e)
    expect(b.has(e, 'immobilized')).toBe(true)
    expect(b.has(a, 'immobilized')).toBe(false)
    expect(b.canMove(e, 'standard')).not.toBe(true)
    b.move(a, { x: 5, y: 2 })
    expect(b.adjacent(a, e)).toBe(true)
    expect(e.pos.y).toBeLessThan(7)
  })
  it('same size: the attacker counts as larger until a contest is won', () => {
    const { a, e, b } = setup()
    b.startGrapple(a, e)
    expect(b.grappleInfo(a).dominant).toBe(true)
    expect(b.grappleInfo(e).dominant).toBe(false)
  })
  it('combined size: two size-1 attackers outweigh a size-2 defender only together', () => {
    const { a, e, b } = setup()
    e.stats.size = 2
    const ally = pregenUnit('Hacker'); ally.pos = { x: 4, y: 7 }; b.units.push(ally)
    b.startGrapple(a, e)
    expect(b.grappleInfo(e).dominant).toBe(true) // 1 vs 2: the defender is larger
    b.startGrapple(ally, e)
    expect(b.grappleInfo(e).dominant).toBe(false) // 1 + 1 vs 2: a tie goes to the attackers
  })
  it('breaking adjacency ends the grapple; the attacker can release; only the defender breaks free', () => {
    const { a, e, b } = setup()
    b.startGrapple(a, e)
    expect(() => b.breakGrapple(a)).toThrow(/release/)
    b.releaseGrapple(a)
    expect(b.has(e, 'grappled')).toBe(false)
    b.startGrapple(a, e)
    b.forceMove(e, a, 3, 1)
    expect(b.grapples).toHaveLength(0)
    expect(b.has(e, 'grappled')).toBe(false)
  })
  it('grappled characters cannot Boost or react', () => {
    const { a, e, b } = setup()
    b.startGrapple(a, e)
    expect(() => b.boost(a)).toThrow(/grappl/)
    expect(b.canSpend(e, 'reaction')).toBe('Grappled')
  })
})

describe('flight', () => {
  it('a flyer that becomes Immobilized lands, and takes off again when it moves', () => {
    const { a, b } = setup()
    a.flying = true
    b.addStatus(a, 'immobilized', 'end_of_turn')
    expect(a.flying).toBe(false)
    b.removeStatus(a, 'immobilized')
    b.move(a, { x: 6, y: 4 })
    expect(a.flying).toBe(true)
  })
})

describe('zero-g', () => {
  it('characters in a zero-g area fly and are Slowed; leaving restores them', () => {
    const { a, b } = setup()
    b.addArea({ kind: 'zero_g', tiles: [{ x: 5, y: 5 }, { x: 5, y: 4 }] })
    b.syncZeroG(a)
    expect(a.flying).toBe(true)
    expect(b.has(a, 'slowed')).toBe(true)
    a.pos = { x: 8, y: 8 }
    b.syncZeroG(a)
    expect(a.flying).toBe(false)
    expect(b.has(a, 'slowed')).toBe(false)
  })
})

describe('destructible terrain', () => {
  const wall = () => flatMap(12, 12, (x, y) => (x === 5 && y === 3 ? { h: 2, kind: 'block' } : undefined))
  it('10 damage knocks a level off; a block with no levels left becomes rubble', () => {
    const { b } = setup(wall())
    b.damageTerrain({ x: 5, y: 3 }, 6)
    expect(b.map.tiles[3 * 12 + 5].h).toBe(2)
    b.damageTerrain({ x: 5, y: 3 }, 6)
    expect(b.map.tiles[3 * 12 + 5].h).toBe(1)
    b.damageTerrain({ x: 5, y: 3 }, 30)
    expect(b.map.tiles[3 * 12 + 5].kind).toBe('rubble')
  })
  it('a skirmish can target terrain', () => {
    const { a, b } = setup(wall())
    const w = a.weapons.find(x => x.dataId === 'mw_assault_rifle')!
    const r = b.attackTerrain(a, w, { x: 5, y: 3 })
    expect(r.ok).toBe(true)
    expect(b.firedThisTurn(a, w)).toBe(true)
  })
  it('raised debris is hard cover', () => {
    const { a, e, b } = setup()
    e.pos = { x: 5, y: 9 }
    expect(b.raiseCover({ x: 5, y: 8 })).toBe(true)
    expect(b.cover(a, e)).toBe('hard')
  })
})
