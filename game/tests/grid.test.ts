// Grid geometry: bounds, footprints, 3D distance, line of sight, cover and area templates.
import { describe, expect, it } from 'vitest'
import {
  tileAt, footprint, distanceBetween, distanceFootprints, distanceToTile, chebyshev, hasLineOfSight,
  hasLineOfSightToTile, coverBetween, burstTiles, blastTiles, lineTiles, coneTiles, unitsOnTiles, key,
} from '../src/rules/grid'
import { flatMap, pregenUnit } from './helpers'

const at = (name: string, x: number, y: number, side: 'player' | 'enemy' = 'player') => {
  const u = pregenUnit(name, side)
  u.pos = { x, y }
  return u
}

describe('tiles and footprints', () => {
  it('tileAt returns undefined off the map', () => {
    const m = flatMap(4, 3)
    expect(tileAt(m, { x: 0, y: 0 })).toBeDefined()
    expect(tileAt(m, { x: 3, y: 2 })).toBeDefined()
    for (const p of [{ x: -1, y: 0 }, { x: 0, y: -1 }, { x: 4, y: 0 }, { x: 0, y: 3 }]) expect(tileAt(m, p)).toBeUndefined()
  })
  it('tileAt indexes rows by width', () => {
    const m = flatMap(5, 4, (x, y) => (x === 3 && y === 2 ? { h: 7 } : undefined))
    expect(tileAt(m, { x: 3, y: 2 })!.h).toBe(7)
    expect(tileAt(m, { x: 2, y: 3 })!.h).toBe(0)
  })
  it('size ½ and 1 occupy one tile; size 2 occupies four; size 3 nine', () => {
    const u = at('Assault', 2, 2)
    expect(footprint(u)).toHaveLength(1)
    u.stats.size = 0.5
    expect(footprint(u)).toHaveLength(1)
    u.stats.size = 2
    expect(footprint(u).map(key).sort()).toEqual(['2,2', '2,3', '3,2', '3,3'])
    u.stats.size = 3
    expect(footprint(u)).toHaveLength(9)
  })
})

describe('distance', () => {
  it('chebyshev: diagonals count 1', () => {
    expect(chebyshev({ x: 0, y: 0 }, { x: 3, y: 3 })).toBe(3)
    expect(chebyshev({ x: 0, y: 0 }, { x: 3, y: 1 })).toBe(3)
  })
  it('adjacent units are 1 apart, and distance is symmetric', () => {
    const m = flatMap()
    const a = at('Assault', 2, 2), b = at('Sniper', 3, 3, 'enemy')
    expect(distanceBetween(m, a, b)).toBe(1)
    b.pos = { x: 7, y: 4 }
    expect(distanceBetween(m, a, b)).toBe(5)
    expect(distanceBetween(m, b, a)).toBe(5)
  })
  it('measures from the nearest square of a large footprint', () => {
    const m = flatMap()
    const a = at('Assault', 2, 2), b = at('Sniper', 5, 2, 'enemy')
    a.stats.size = 2 // occupies x 2..3
    expect(distanceBetween(m, a, b)).toBe(2)
  })
  it('vertical separation counts when it exceeds the horizontal one', () => {
    const m = flatMap(12, 12, (x, y) => (x === 2 && y === 2 ? { h: 6, kind: 'block' } : undefined))
    const a = at('Assault', 2, 2), b = at('Sniper', 3, 2, 'enemy')
    // a stands 6 up; b's body is 1 tall on the ground → 5 spaces of vertical gap
    expect(distanceBetween(m, a, b)).toBe(5)
    expect(distanceBetween(m, b, a)).toBe(5)
  })
  it('distanceFootprints with no height difference is the plain 2D distance', () => {
    expect(distanceFootprints([{ x: 0, y: 0 }], [{ x: 4, y: 1 }])).toBe(4)
  })
  it('distanceToTile uses the footprint', () => {
    const a = at('Assault', 2, 2)
    a.stats.size = 2
    expect(distanceToTile(flatMap(), a, { x: 6, y: 3 })).toBe(3)
  })
})

describe('line of sight', () => {
  it('open ground: mutual line of sight', () => {
    const m = flatMap()
    const a = at('Assault', 1, 5), b = at('Sniper', 9, 8, 'enemy')
    expect(hasLineOfSight(m, a, b)).toBe(true)
    expect(hasLineOfSight(m, b, a)).toBe(true)
  })
  it('a tall wall between blocks both ways; a low wall does not', () => {
    const tall = flatMap(12, 12, x => (x === 5 ? { h: 3, kind: 'block' } : undefined))
    const low = flatMap(12, 12, x => (x === 5 ? { h: 0.5 as any, kind: 'block' } : undefined))
    const a = at('Assault', 1, 5), b = at('Sniper', 9, 5, 'enemy')
    expect(hasLineOfSight(tall, a, b)).toBe(false)
    expect(hasLineOfSight(tall, b, a)).toBe(false)
    expect(hasLineOfSight(low, a, b)).toBe(true)
  })
  it('a unit on top of a tall wall sees over it', () => {
    const m = flatMap(12, 12, x => (x >= 4 && x <= 5 ? { h: 3, kind: 'block' } : undefined))
    const a = at('Assault', 5, 5), b = at('Sniper', 9, 5, 'enemy')
    expect(hasLineOfSight(m, a, b)).toBe(true)
  })
  it('line of sight to a tile ignores the tile itself', () => {
    const m = flatMap(12, 12, (x, y) => (x === 6 && y === 5 ? { h: 3, kind: 'block' } : undefined))
    const a = at('Assault', 1, 5)
    expect(hasLineOfSightToTile(m, a, { x: 6, y: 5 })).toBe(true)
    expect(hasLineOfSightToTile(m, a, { x: 8, y: 5 })).toBe(false)
    expect(hasLineOfSightToTile(m, a, { x: 40, y: 5 })).toBe(false)
  })
})

describe('cover', () => {
  it('open ground gives no cover', () => {
    expect(coverBetween(flatMap(), at('Assault', 1, 5), at('Sniper', 8, 5, 'enemy'))).toBe('none')
  })
  it('an adjacent wall on the far side of the target gives no cover', () => {
    const m = flatMap(12, 12, (x, y) => (x === 9 && y === 5 ? { h: 2, kind: 'block' } : undefined))
    expect(coverBetween(m, at('Assault', 1, 5), at('Sniper', 8, 5, 'enemy'))).toBe('none')
  })
  it('an attacker 2+ above the wall top ignores the hard cover', () => {
    const m = flatMap(12, 12, (x, y) => (x === 7 && y === 5 ? { h: 1, kind: 'block' } : x <= 2 ? { h: 3, kind: 'ground' } : undefined))
    const target = at('Sniper', 8, 5, 'enemy')
    expect(coverBetween(m, at('Assault', 1, 5), target)).not.toBe('hard')
    const flat = flatMap(12, 12, (x, y) => (x === 7 && y === 5 ? { h: 1, kind: 'block' } : undefined))
    expect(coverBetween(flat, at('Assault', 1, 5), target)).toBe('hard')
  })
  it('a smoke area grants soft cover', () => {
    const tiles = [{ x: 8, y: 5 }]
    expect(coverBetween(flatMap(), at('Assault', 1, 5), at('Sniper', 8, 5, 'enemy'), [{ id: 's', kind: 'soft_cover', tiles }])).toBe('soft')
  })
})

describe('area templates', () => {
  it('Burst 1 around a size-1 unit is its 3×3 square (9 tiles including its own)', () => {
    const u = at('Assault', 5, 5)
    const t = burstTiles(flatMap(), u, 1)
    expect(t).toHaveLength(9)
    expect(t.map(key)).toContain('5,5')
  })
  it('Burst is clipped by the map edge', () => {
    expect(burstTiles(flatMap(), at('Assault', 0, 0), 2)).toHaveLength(9)
  })
  it('Burst around a size-2 unit grows from its whole footprint', () => {
    const u = at('Assault', 5, 5)
    u.stats.size = 2
    expect(burstTiles(flatMap(), u, 1)).toHaveLength(16)
  })
  it('Blast r is a (2r+1)² square, clipped by the map', () => {
    expect(blastTiles(flatMap(), { x: 5, y: 5 }, 2)).toHaveLength(25)
    expect(blastTiles(flatMap(), { x: 0, y: 0 }, 1)).toHaveLength(4)
  })
  it('Line N is exactly N tiles, excludes the user and starts adjacent', () => {
    const u = at('Assault', 2, 5)
    for (const toward of [{ x: 9, y: 5 }, { x: 9, y: 9 }, { x: 2, y: 0 }]) {
      const t = lineTiles(flatMap(), u, toward, 5)
      expect(t).toHaveLength(5)
      expect(t.map(key)).not.toContain('2,5')
      expect(chebyshev(t[0], u.pos)).toBe(1)
      for (let i = 1; i < t.length; i++) expect(chebyshev(t[i], t[i - 1])).toBe(1)
    }
  })
  it('Line stops at the map edge', () => {
    expect(lineTiles(flatMap(), at('Assault', 9, 5), { x: 11, y: 5 }, 8)).toHaveLength(2)
  })
  it('Cone points the right way and never includes the user', () => {
    const u = at('Assault', 5, 5)
    const t = coneTiles(flatMap(), u, { x: 9, y: 5 }, 3)
    expect(t.length).toBeGreaterThan(3)
    expect(t.every(p => p.x > 5)).toBe(true)
    expect(t.map(key)).toContain('6,5')
    expect(t.map(key)).toContain('8,5')
    expect(t.map(key)).not.toContain('9,5')
  })
  it('unitsOnTiles finds units by any footprint square and skips the destroyed', () => {
    const a = at('Assault', 2, 2), b = at('Sniper', 5, 5, 'enemy')
    b.stats.size = 2
    expect(unitsOnTiles([a, b], [{ x: 6, y: 6 }])).toEqual([b])
    b.destroyed = true
    expect(unitsOnTiles([a, b], [{ x: 6, y: 6 }])).toEqual([])
  })
})
