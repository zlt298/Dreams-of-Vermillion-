// Regression tests for spatial-rules fixes (grid / movement / terrain / attacks / sandbox caches).
import { describe, expect, it } from 'vitest'
import { flatMap, pregenUnit, battle } from './helpers'

describe('spatial fixes', () => {
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

  it('a same-size wall hides the target completely: hard cover from a 1-high wall almost always means no line of sight', () => {
    const a = pregenUnit('Assault'); const e = pregenUnit('Sniper', 'enemy')
    a.pos = { x: 1, y: 5 }; e.pos = { x: 6, y: 5 }
    const b = battle([a, e], flatMap(14, 14, (x, y) => (x === 5 && y === 5 ? { h: 1, kind: 'block' } : undefined)))
    const rifle = a.weapons.find(w => w.name === 'Assault Rifle')!
    expect(b.cover(a, e)).toBe('hard')
    // Lancer: a size-1 mech behind size-1 hard cover is targetable at +2 difficulty
    expect(b.validTarget(a, rifle, e)).toBe(true) // was: 'No line of sight' (top sample 0.95 < wall height 1)
  })

  it('thrown melee attacks at range ignore cover (treated as melee)', () => {
    const a = pregenUnit('Assault'); const e = pregenUnit('Sniper', 'enemy')
    a.pos = { x: 1, y: 3 }; e.pos = { x: 5, y: 5 }
    const b = battle([a, e], flatMap(12, 12, (x, y) => (x === 4 && y === 5 ? { kind: 'forest' } : undefined)))
    const w = a.weapons.find(w => w.type === 'Melee')!
    w.profiles[0].range = [{ type: 'Threat', val: 1 }, { type: 'Thrown', val: 5 }] as any
    expect(b.cover(a, e)).not.toBe('none')
    expect(b.validTarget(a, w, e)).toBe(true)
    const ctx = b.buildWeaponCtx(a, w, e, 'skirmish', false)
    // Thrown X: "can be thrown ... as a ranged attack" — cover applies at range
    expect(ctx.difficulty).toBeGreaterThan(0) // was: 0, isMelee() is true so the cover block is skipped
  })
})
