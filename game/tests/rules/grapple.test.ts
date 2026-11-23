// Grapples (core book): who is dominant, dragging, breaking free, and what being grappled forbids.
import { describe, expect, it } from 'vitest'
import type { GridMap } from '../../src/rules/grid'
import { battle, duel, flatMap, pregenUnit } from '../support'

/** Assault at (5,5) beside the Sniper at (5,6), seed 3, with the Assault's turn begun. */
function besideDuel(map?: GridMap) {
  const d = duel({ a: { x: 5, y: 5 }, e: { x: 5, y: 6 }, seed: 3, map })
  d.b.beginTurn(d.a)
  return d
}

describe('grapples', () => {
  it('the larger side drags the smaller; the smaller is Immobilized', () => {
    const { a, e, b } = besideDuel()
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
    const { a, e, b } = besideDuel()
    b.startGrapple(a, e)
    expect(b.grappleInfo(a).dominant).toBe(true)
    expect(b.grappleInfo(e).dominant).toBe(false)
  })

  it('combined size: two size-1 attackers outweigh a size-2 defender only together', () => {
    const { a, e, b } = besideDuel()
    e.stats.size = 2
    const ally = pregenUnit('Hacker'); ally.pos = { x: 4, y: 7 }; b.units.push(ally)
    b.startGrapple(a, e)
    expect(b.grappleInfo(e).dominant).toBe(true) // 1 vs 2: the defender is larger
    b.startGrapple(ally, e)
    expect(b.grappleInfo(e).dominant).toBe(false) // 1 + 1 vs 2: a tie goes to the attackers
  })

  it('breaking adjacency ends the grapple; the attacker can release; only the defender breaks free', () => {
    const { a, e, b } = besideDuel()
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
    const { a, e, b } = besideDuel()
    b.startGrapple(a, e)
    expect(() => b.boost(a)).toThrow(/grappl/)
    expect(b.canSpend(e, 'reaction')).toBe('Grappled')
  })

  it('grappled characters cannot Boost', () => {
    const { a, b } = duel()
    b.beginTurn(a)
    b.addStatus(a, 'grappled')
    expect(() => b.boost(a)).toThrow(/grappl/)
  })

  // regression: a grappled character dragged next to a mine did not set it off
  it('a grappled character dragged next to a hostile mine does not set it off', () => {
    const a = pregenUnit('Vanguard'); const e = pregenUnit('Sniper', 'enemy')
    a.pos = { x: 5, y: 5 }; e.pos = { x: 6, y: 5 }
    a.stats.size = 2 // larger side: drags its partner
    const b = battle([a, e], flatMap(16, 16))
    b.beginTurn(a)
    b.startGrapple(a, e)
    b.placeMine(a, { x: 8, y: 3 }, { name: 'M', radius: 1, damage: [{ type: 'Explosive', val: 5 }], armed: true }, { noCheck: true })
    const hp = e.hp
    b.move(a, { x: 7, y: 5 })
    expect(e.pos).toEqual({ x: 7, y: 4 }) // dragged from (6,5) [not adjacent to the mine] to (7,4) [adjacent]
    // terrain.ts dragGrappled sets p.pos directly (no followPath): no mines, hazards, onMove scripts
    expect(b.mines.length).toBe(0) // was: mine still there
    expect(e.hp).toBeLessThan(hp)
  })
})
