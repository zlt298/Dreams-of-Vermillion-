// Movement (engagement, obstruction, climbing, knockback, Disengage), flight, Overwatch on movement, undoing a move,
// and terrain (dangerous terrain, zero-g, destructible terrain).
import { describe, expect, it } from 'vitest'
import type { GridMap } from '../../src/rules/grid'
import { battle, duel, flatMap, pregenUnit } from '../support'

/** Assault at (5,5) beside the Sniper at (5,6), seed 3, with the Assault's turn begun. */
function besideDuel(map?: GridMap) {
  const d = duel({ a: { x: 5, y: 5 }, e: { x: 5, y: 6 }, seed: 3, map })
  d.b.beginTurn(d.a)
  return d
}

describe('movement', () => {
  it('moves within speed and stops when engaged', () => {
    const { a, e, b } = duel()
    b.beginTurn(a)
    e.pos = { x: 4, y: 5 }
    const r = b.reachable(a, a.moveLeft)
    // cannot pass through/around the enemy beyond engagement in one move
    expect(r.has('5,5')).toBe(false)
    expect(r.has('3,5')).toBe(true)
    b.move(a, { x: 3, y: 5 })
    expect(b.isEngaged(a)).toBe(true)
  })

  it('climbing costs extra movement', () => {
    const { a, b } = duel({ map: (x) => (x >= 2 ? { h: 3, kind: 'ground' } : undefined) })
    b.beginTurn(a)
    const p = b.pathTo(a, { x: 2, y: 5 }, 10)!
    // Size 1: jump 1 level free, climb the other 2 at half speed (core p.63)
    expect(p.cost).toBe(5)
  })

  it('knockback pushes targets away', () => {
    const { a, e, b } = duel()
    b.forceMove(e, a, 2, 1)
    expect(e.pos.x).toBe(8)
  })

  it('allied units never obstruct; smaller hostiles do not either', () => {
    const { a, e, b } = duel()
    const ally = pregenUnit('Hacker')
    ally.pos = { x: 2, y: 5 }
    b.units.push(ally)
    const pass = (at: { x: number; y: number }) => (b as any).passable(a, at, new Set([a.id]))
    expect(pass(ally.pos)).not.toBe('blocked')
    expect(pass(e.pos)).toBe('blocked')
    e.stats.size = 0.5
    expect(pass(e.pos)).not.toBe('blocked')
  })

  // regression: Disengage did not let a mover pass through engagement
  it('after Disengage, engagement does not stop movement', () => {
    const { a, e, b } = duel()
    e.pos = { x: 3, y: 5 }
    b.beginTurn(a)
    expect(b.reachable(a, a.moveLeft).has('5,5')).toBe(false)
    b.disengage(a)
    b.move(a, { x: 5, y: 5 })
    expect(a.pos).toEqual({ x: 5, y: 5 })
  })

  // regression: a refused move left a landed flyer back in the air
  it('a move that throws leaves the mover unchanged (a landed flyer is not put back in the air)', () => {
    const { a, b } = duel()
    b.beginTurn(a)
    a.flags.landed = true
    a.flying = false
    expect(() => b.move(a, { x: 11, y: 11 })).toThrow()
    expect(a.flying).toBe(false)
  })
})

describe('flight', () => {
  it('a landed flyer that makes a legal move takes off', () => {
    const { a, b } = duel()
    b.beginTurn(a)
    a.flags.landed = true
    a.flying = false
    b.move(a, { x: 3, y: 5 })
    expect(a.flying).toBe(true)
    expect(a.flags.landed).toBe(false)
  })

  // regression: reachable() treated a landed flyer as walking while move() takes off first
  it('a landed flyer: reachable() (UI highlight, AI) disagrees with move(), which takes off first', () => {
    const a = pregenUnit('Assault'); const e = pregenUnit('Sniper', 'enemy')
    a.pos = { x: 2, y: 2 }; e.pos = { x: 10, y: 10 }
    // a 6-high wall right next to it: walking costs 1 + 5 climb, flying costs 1
    const b = battle([a, e], flatMap(12, 12, x => (x === 3 ? { h: 6, kind: 'block' } : undefined)))
    b.beginTurn(a)
    a.flying = false; a.flags.landed = true // e.g. after Immobilized / losing control
    const before = a.moveLeft
    expect(before).toBe(4)
    b.move(a, { x: 3, y: 2 }) // succeeds: move() takes off and flies up
    expect(before - a.moveLeft).toBe(1)
    // reset and ask reachable(), as the UI move highlight and the AI do
    a.pos = { x: 2, y: 2 }; a.moveLeft = before; a.flying = false; a.flags.landed = true
    const r = b.reachable(a, a.moveLeft)
    expect(r.get('3,2')?.cost).toBe(1) // was: undefined (unreachable on foot), though move() accepts it for 1
  })

  // regression: adjacency and engagement were asymmetric when one side flew
  it('adjacency (and so engagement) is asymmetric when one side flies', () => {
    const a = pregenUnit('Assault'); const e = pregenUnit('Sniper', 'enemy')
    a.pos = { x: 2, y: 2 }; e.pos = { x: 3, y: 2 }
    const b = battle([a, e], flatMap(12, 12, (x, y) => (x === 3 && y === 2 ? { h: 2, kind: 'block' } : undefined)))
    e.flying = true // flying over a 2-high block next to a ground mech
    expect(b.adjacent(e, a)).toBe(true)
    expect(b.isEngaged(e)).toBe(true)
    // core.ts adjacent(): own elevation ignores flying, the other's includes it
    expect(b.adjacent(a, e)).toBe(b.adjacent(e, a)) // was: false vs true
    expect(b.isEngaged(a)).toBe(b.isEngaged(e)) // was: a is not engaged by e, but e is engaged by a
  })

  it('a flyer that becomes Immobilized lands, and takes off again when it moves', () => {
    const { a, b } = besideDuel()
    a.flying = true
    b.addStatus(a, 'immobilized', 'end_of_turn')
    expect(a.flying).toBe(false)
    b.removeStatus(a, 'immobilized')
    b.move(a, { x: 6, y: 4 })
    expect(a.flying).toBe(true)
  })
})

describe('Overwatch on movement', () => {
  it("'off' overwatch never triggers", () => {
    const { a, e, b } = duel()
    e.pos = { x: 3, y: 5 } // Sniper is hostile; Assault starts adjacent-ish
    a.pos = { x: 1, y: 5 }
    e.weapons.forEach(w => (w.profiles[w.profileIndex].range = [{ type: 'Threat', val: 3 }]))
    e.policies.overwatch = 'off'
    b.beginTurn(a)
    b.move(a, { x: 1, y: 3 })
    expect(b.events.filter(ev => ev.type === 'attack').length).toBe(0)
  })
})

describe('undo move', () => {
  it('restores position and movement after a clean move', () => {
    const { a, b } = duel()
    b.beginTurn(a)
    const start = { ...a.pos }
    b.move(a, { x: 3, y: 5 })
    expect(b.canUndoMove(a)).toBe(true)
    b.undoMove(a)
    expect(a.pos).toEqual(start)
    expect(a.moveLeft).toBe(a.stats.speed)
    expect(a.actedThisTurn).toBe(false)
  })

  it('is not allowed once something else happened', () => {
    const { a, e, b } = duel()
    b.beginTurn(a)
    b.move(a, { x: 3, y: 5 })
    b.lockOn(a, e)
    expect(b.canUndoMove(a)).toBe(false)
    expect(() => b.undoMove(a)).toThrow()
  })

  it('is not allowed if the move provoked overwatch', () => {
    const { a, e, b } = duel()
    e.pos = { x: 3, y: 5 }
    e.weapons.forEach(w => (w.profiles[w.profileIndex].range = [{ type: 'Threat', val: 3 }]))
    b.beginTurn(a)
    b.move(a, { x: 1, y: 3 })
    expect(b.canUndoMove(a)).toBe(false)
  })
})

describe('terrain', () => {
  const wall = () => flatMap(12, 12, (x, y) => (x === 5 && y === 3 ? { h: 2, kind: 'block' } : undefined))
  it('ending a turn in dangerous terrain can deal 5 energy damage', () => {
    let hurt = false
    for (let seed = 1; seed < 20 && !hurt; seed++) {
      const a = pregenUnit('Assault'); a.pos = { x: 1, y: 5 }
      const e = pregenUnit('Sniper', 'enemy'); e.pos = { x: 9, y: 5 }
      const b = battle([a, e], flatMap(12, 12, (x, y) => (x === 1 && y === 5 ? { h: 0, kind: 'hazard' } : undefined)), seed)
      b.beginTurn(a)
      const hp = a.hp
      b.endTurn(a)
      expect(a.flags['round:hazard']).toBe(true)
      if (a.hp < hp) hurt = true
    }
    expect(hurt).toBe(true)
  })

  it('characters in a zero-g area fly and are Slowed; leaving restores them', () => {
    const { a, b } = besideDuel()
    b.addArea({ kind: 'zero_g', tiles: [{ x: 5, y: 5 }, { x: 5, y: 4 }] })
    b.syncZeroG(a)
    expect(a.flying).toBe(true)
    expect(b.has(a, 'slowed')).toBe(true)
    a.pos = { x: 8, y: 8 }
    b.syncZeroG(a)
    expect(a.flying).toBe(false)
    expect(b.has(a, 'slowed')).toBe(false)
  })

  it('10 damage knocks a level off; a block with no levels left becomes rubble', () => {
    const { b } = besideDuel(wall())
    b.damageTerrain({ x: 5, y: 3 }, 6)
    expect(b.map.tiles[3 * 12 + 5].h).toBe(2)
    b.damageTerrain({ x: 5, y: 3 }, 6)
    expect(b.map.tiles[3 * 12 + 5].h).toBe(1)
    b.damageTerrain({ x: 5, y: 3 }, 30)
    expect(b.map.tiles[3 * 12 + 5].kind).toBe('rubble')
  })

  it('a skirmish can target terrain', () => {
    const { a, b } = besideDuel(wall())
    const w = a.weapons.find(x => x.dataId === 'mw_assault_rifle')!
    const r = b.attackTerrain(a, w, { x: 5, y: 3 })
    expect(r.ok).toBe(true)
    expect(b.firedThisTurn(a, w)).toBe(true)
  })

  it('raised debris is hard cover', () => {
    const { a, e, b } = besideDuel()
    e.pos = { x: 5, y: 9 }
    expect(b.raiseCover({ x: 5, y: 8 })).toBe(true)
    expect(b.cover(a, e)).toBe('hard')
  })
})
