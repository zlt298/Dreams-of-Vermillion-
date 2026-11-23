import { describe, it, expect } from 'vitest'
import { battle, flatMap, pregenUnit } from './helpers'

describe('Battle.sandbox rollback', () => {
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
})
