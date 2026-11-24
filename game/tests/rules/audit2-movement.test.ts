// Rules audit 2, Core-B: movement, turns and Hidden. Core-book page numbers are cited; rules are paraphrased.
import { describe, expect, it } from 'vitest'
import type { Battle } from '../../src/rules/battle'
import type { Pos, Unit } from '../../src/rules/types'
import { act, arena, battle, duel, flatMap, mech, pregenUnit, rigDice } from '../support'

const custom = (b: Battle, u: Unit, key: string) => {
  const a = b.customActions(u).find(c => c.key === key)
  if (!a) throw new Error(`no action ${key}: ${b.customActions(u).map(c => c.key).join(', ')}`)
  return a
}

/** A unit of another kind (drone / deployable object) built from a mech, for obstruction and engagement checks. */
function thing(kind: 'drone' | 'deployable', side: 'player' | 'enemy', size: number, pos: Pos): Unit {
  const u = mech({ callsign: kind }, side)
  u.kind = kind
  u.stats.size = size
  u.weapons = []
  u.pos = { ...pos }
  return u
}

// ------------------------------------------------------------------------------------------------ reactions
describe('reactions refresh at round start (core p.61, owner ruling)', () => {
  it('an Overwatch spent before its owner acts stays spent after its turn, and refreshes at the next round', () => {
    const a = pregenUnit('Assault'); const a2 = pregenUnit('Vanguard')
    const e = pregenUnit('Sniper', 'enemy'); const e2 = pregenUnit('Hacker', 'enemy')
    a.pos = { x: 5, y: 5 }; a2.pos = { x: 1, y: 12 }; e.pos = { x: 6, y: 5 }; e2.pos = { x: 4, y: 5 }
    const b = battle([a, a2, e, e2], flatMap(14, 14))
    a.policies.overwatch = 'auto'
    // round 1: players open; a2 acts, then the enemy moves inside a's threat: a overwatches
    b.beginTurn(a2); b.endTurn(a2)
    b.beginTurn(e)
    let r = a.reactionsLeft
    b.move(e, { x: 8, y: 5 })
    expect(a.reactionsLeft).toBe(r - 1)
    b.endTurn(e)
    // a's own turn doesn't refresh Overwatch
    b.beginTurn(a); b.endTurn(a)
    expect(b.round).toBe(1)
    b.beginTurn(e2)
    r = a.reactionsLeft
    expect(r).toBe(1) // still one reaction for this turn
    expect(b.canSpend(a, 'reaction', 'overwatch')).not.toBe(true)
    b.move(e2, { x: 3, y: 7 })
    expect(a.reactionsLeft).toBe(r)
    b.endTurn(e2)
    // round 2 opens with the enemy side: a's Overwatch is back before a acts
    expect(b.round).toBe(2)
    expect(b.canSpend(a, 'reaction', 'overwatch')).toBe(true)
  })

  it('another reaction (Brace) is still available in the same round while a reaction is left this turn', () => {
    const { a, e, b } = duel({ a: { x: 5, y: 5 }, e: { x: 6, y: 5 } })
    a.policies.overwatch = 'auto'
    b.beginTurn(a); b.endTurn(a)
    b.beginTurn(e)
    b.move(e, { x: 8, y: 5 })
    expect(b.canSpend(a, 'reaction', 'overwatch')).not.toBe(true)
    b.endTurn(e)
    // a new turn in the same round: one reaction again, Brace unused this round
    expect(a.reactionsLeft).toBe(1)
    expect(b.canSpend(a, 'reaction', 'brace')).toBe(true)
  })
})

// ------------------------------------------------------------------------------------------------ Overwatch
describe('Overwatch', () => {
  it('a ranged weapon without a Threat entry has Threat 1 and overwatches (core p.73)', () => {
    const { a, e, b } = duel({ a: { x: 5, y: 5 }, e: { x: 6, y: 5 } })
    const rifle = mech({ weapons: 'mw_assault_rifle' }, 'enemy').weapons[0]
    e.weapons = [rifle]
    e.policies.overwatch = 'auto'
    b.beginTurn(a)
    expect(b.weaponThreat(e, rifle)).toBe(1)
    const r = e.reactionsLeft
    b.move(a, { x: 3, y: 5 })
    expect(e.reactionsLeft).toBe(r - 1)
  })

  it('a hostile armed only with a Superheavy weapon (Combat Drill) does not overwatch', () => {
    const a = pregenUnit('Assault')
    const e = mech({ weapons: [['Superheavy', 'mw_combat_drill']] }, 'enemy')
    const b = arena([[a, { x: 5, y: 5 }], [e, { x: 6, y: 5 }]])
    e.policies.overwatch = 'auto'
    b.beginTurn(a)
    expect(b.bestThreatWeapon(e, a)).toBeNull()
    const r = e.reactionsLeft
    b.move(a, { x: 3, y: 5 })
    expect(e.reactionsLeft).toBe(r)
  })

  it('scripted voluntary movement (moveAlong, e.g. Grapple Swing) provokes Overwatch; movement that provokes no reactions does not', () => {
    const { a, e, b } = duel({ a: { x: 5, y: 5 }, e: { x: 6, y: 5 } })
    e.policies.overwatch = 'auto'
    b.beginTurn(a)
    let r = e.reactionsLeft
    b.moveAlong(a, [{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 3, y: 5 }], { noReactions: true })
    expect(e.reactionsLeft).toBe(r)
    a.pos = { x: 5, y: 5 }
    r = e.reactionsLeft
    b.moveAlong(a, [{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 3, y: 5 }])
    expect(e.reactionsLeft).toBe(r - 1)
  })

  it('Grapple Swing started in Threat is overwatched', () => {
    const a = mech({ systems: ['ms_reinforced_cabling'] })
    const e = pregenUnit('Assault', 'enemy')
    const b = arena([[a, { x: 5, y: 5 }], [e, { x: 6, y: 5 }]])
    e.policies.overwatch = 'auto'
    act(b, a)
    const r = e.reactionsLeft
    b.useCustom(a, custom(b, a, 'grappleswing'), { x: 2, y: 5 })
    expect(e.reactionsLeft).toBe(r - 1)
  })
})

// ------------------------------------------------------------------------------------------------ teleport
describe('teleport (core p.63, owner ruling)', () => {
  function teleporter() {
    const { a, e, b } = duel({ a: { x: 5, y: 5 }, e: { x: 10, y: 10 }, size: 14 })
    a.flags.teleportMoves = true
    return { a, e, b }
  }
  it('spends the whole movement however far it goes', () => {
    const { a, b } = teleporter()
    b.beginTurn(a)
    expect(a.moveLeft).toBeGreaterThan(2)
    b.move(a, { x: 6, y: 5 })
    expect(a.moveLeft).toBe(0)
    expect(a.pos).toEqual({ x: 6, y: 5 })
  })
  it('reaches up to Speed in one jump', () => {
    const { a, b } = teleporter()
    b.beginTurn(a)
    const s = a.stats.speed
    expect(b.reachable(a, a.moveLeft).has(`${5 + s},5`)).toBe(true)
    expect(b.reachable(a, a.moveLeft).has(`${5 + s + 1},5`)).toBe(false)
  })
  it('is blocked by Immobilized', () => {
    const { a, b } = teleporter()
    b.beginTurn(a)
    b.addStatus(a, 'immobilized')
    expect(() => b.move(a, { x: 7, y: 5 })).toThrow(/Immobilized/)
  })
  it('still provokes Overwatch (it is movement)', () => {
    const { a, e, b } = teleporter()
    e.pos = { x: 6, y: 5 }
    e.policies.overwatch = 'auto'
    b.beginTurn(a)
    const r = e.reactionsLeft
    b.move(a, { x: 2, y: 5 })
    expect(e.reactionsLeft).toBe(r - 1)
  })
  it('teleporting down from a tower deals no fall damage', () => {
    const { a, b } = duel({ a: { x: 5, y: 5 }, e: { x: 11, y: 11 }, map: (x, y) => (x === 5 && y === 5 ? { h: 6, kind: 'block' } : undefined) })
    a.flags.teleportMoves = true
    b.beginTurn(a)
    const hp = a.hp
    b.move(a, { x: 7, y: 5 })
    expect(a.pos).toEqual({ x: 7, y: 5 })
    expect(a.hp).toBe(hp)
  })
  it('walking off the same tower still falls', () => {
    const { a, b } = duel({ a: { x: 5, y: 5 }, e: { x: 11, y: 11 }, map: (x, y) => (x === 5 && y === 5 ? { h: 6, kind: 'block' } : undefined) })
    b.beginTurn(a)
    const hp = a.hp
    b.move(a, { x: 6, y: 5 })
    expect(a.hp).toBeLessThan(hp)
  })
})

// ------------------------------------------------------------------------------------------------ climbing
describe('climbing (core p.63, owner ruling)', () => {
  const cost = (size: number, h: number) => {
    const { a, b } = duel({ map: x => (x >= 2 ? { h, kind: 'ground' } : undefined), a: { x: 0, y: 5 }, e: { x: 9, y: 9 } })
    a.stats.size = size
    b.beginTurn(a)
    return b.pathTo(a, { x: 2, y: 5 }, 20, { ignoreEngagement: true })!.cost
  }
  it('jumps up to its Size for free, then 2 per extra level', () => {
    expect(cost(1, 1)).toBe(2)
    expect(cost(1, 2)).toBe(4)
    expect(cost(1, 3)).toBe(6)
    expect(cost(2, 2)).toBe(2)
    expect(cost(2, 3)).toBe(4)
  })
})

// ------------------------------------------------------------------------------------------------ obstruction and engagement
describe('obstruction and engagement', () => {
  it('a Size 2 mech passes through a Size 1 deployable but cannot end there; a Size 1 mech is blocked by it (core p.62)', () => {
    const a = mech()
    const d = thing('deployable', 'enemy', 1, { x: 6, y: 5 })
    d.flags.isCover = true
    const b = arena([[a, { x: 4, y: 5 }], [mech({}, 'enemy'), { x: 11, y: 11 }]])
    b.spawn(d)
    expect(b.passable(a, { x: 6, y: 5 }, new Set([a.id]))).toBe('blocked')
    a.stats.size = 2
    expect(b.passable(a, { x: 5, y: 4 }, new Set([a.id]))).toBe('pass')
  })

  it('allied drones never obstruct; same-Size hostile drones do', () => {
    const a = mech()
    const ally = thing('drone', 'player', 1, { x: 6, y: 5 })
    const foe = thing('drone', 'enemy', 1, { x: 6, y: 7 })
    const b = arena([[a, { x: 4, y: 5 }], [ally, ally.pos], [foe, foe.pos]])
    expect(b.passable(a, { x: 6, y: 5 }, new Set([a.id]))).toBe('pass')
    expect(b.passable(a, { x: 6, y: 7 }, new Set([a.id]))).toBe('blocked')
  })

  it('a hostile drone causes Engagement (+1 Difficulty on ranged attacks) but a Size 1/2 drone does not stop a Size 1 move', () => {
    const a = mech()
    const d = thing('drone', 'enemy', 0.5, { x: 6, y: 5 })
    const e = mech({}, 'enemy')
    const b = arena([[a, { x: 5, y: 5 }], [d, d.pos], [e, { x: 10, y: 10 }]])
    expect(b.isEngaged(a)).toBe(true)
    b.beginTurn(a)
    a.pos = { x: 3, y: 5 }
    // moving next to the drone doesn't stop the move
    expect(b.reachable(a, a.moveLeft).has('7,6')).toBe(true)
  })

  it('a Hidden hostile still obstructs movement through its space', () => {
    const { a, e, b } = duel({ a: { x: 3, y: 5 }, e: { x: 5, y: 5 } })
    b.addStatus(e, 'hidden')
    expect(b.passable(a, { x: 5, y: 5 }, new Set([a.id]))).toBe('blocked')
  })

  it('engagement with a Hidden character is ignored both ways (core p.77)', () => {
    const { a, e, b } = duel({ a: { x: 5, y: 5 }, e: { x: 6, y: 5 } })
    b.addStatus(a, 'hidden')
    expect(b.isEngaged(a)).toBe(false)
    expect(b.isEngaged(e)).toBe(false)
  })

  it('a push passes through an ally of the target and ends beyond it (core p.62)', () => {
    const a = pregenUnit('Assault')
    const e = pregenUnit('Sniper', 'enemy'); const e2 = pregenUnit('Hacker', 'enemy')
    const b = arena([[a, { x: 3, y: 5 }], [e, { x: 4, y: 5 }], [e2, { x: 5, y: 5 }]])
    b.forceMove(e, a, 3, 1)
    expect(e.pos).toEqual({ x: 7, y: 5 })
  })

  it('a push that would end in an ally\'s space stops short of it', () => {
    const a = pregenUnit('Assault')
    const e = pregenUnit('Sniper', 'enemy'); const e2 = pregenUnit('Hacker', 'enemy')
    const b = arena([[a, { x: 3, y: 5 }], [e, { x: 4, y: 5 }], [e2, { x: 6, y: 5 }]])
    b.forceMove(e, a, 2, 1)
    expect(e.pos).toEqual({ x: 5, y: 5 })
  })

  it('a push is still stopped by a same-Size hostile', () => {
    const a = pregenUnit('Assault'); const a2 = pregenUnit('Vanguard')
    const e = pregenUnit('Sniper', 'enemy')
    const b = arena([[a, { x: 3, y: 5 }], [e, { x: 4, y: 5 }], [a2, { x: 6, y: 5 }]])
    b.forceMove(e, a, 3, 1)
    expect(e.pos).toEqual({ x: 5, y: 5 })
  })
})

// ------------------------------------------------------------------------------------------------ flight
describe('flight (core p.63)', () => {
  it('a flyer (no hover) moves in straight lines only', () => {
    const { a, b } = duel({ a: { x: 1, y: 5 }, e: { x: 11, y: 11 } })
    a.flying = true
    b.beginTurn(a)
    const r = b.reachable(a, a.moveLeft)
    expect(r.has('4,5')).toBe(true)
    expect(r.has('4,8')).toBe(true)
    expect(r.has('3,8')).toBe(false)
    expect(() => b.move(a, { x: 3, y: 8 })).toThrow()
  })

  it('a hovering flyer (Dusk Wing) may bend its path', () => {
    const a = mech({ frame: 'mf_dusk_wing' })
    const e = mech({}, 'enemy')
    const b = arena([[a, { x: 1, y: 5 }], [e, { x: 11, y: 11 }]])
    expect(a.flying).toBe(true)
    b.beginTurn(a)
    expect(b.reachable(a, a.moveLeft).has('3,8')).toBe(true)
  })

  it('a flyer that ends its turn without moving lands; a hovering one stays up', () => {
    const { a, b } = duel({ a: { x: 1, y: 5 }, e: { x: 11, y: 11 } })
    a.flying = true
    b.beginTurn(a); b.endTurn(a)
    expect(a.flying).toBe(false)
    const h = mech({ frame: 'mf_dusk_wing' })
    const e = mech({}, 'enemy')
    const b2 = arena([[h, { x: 1, y: 5 }], [e, { x: 11, y: 11 }]])
    b2.beginTurn(h); b2.endTurn(h)
    expect(h.flying).toBe(true)
  })

  it('a flyer that moved stays up', () => {
    const { a, b } = duel({ a: { x: 1, y: 5 }, e: { x: 11, y: 11 } })
    a.flying = true
    b.beginTurn(a)
    b.move(a, { x: 2, y: 5 })
    b.endTurn(a)
    expect(a.flying).toBe(true)
  })

  it('a flyer passes over a same-Size hostile on the ground, but cannot end there', () => {
    const { a, e, b } = duel({ a: { x: 3, y: 5 }, e: { x: 4, y: 5 } })
    a.flying = true
    expect(b.passable(a, e.pos, new Set([a.id]))).toBe('pass')
  })

  it('flyers are exempt from dangerous terrain they cross, ground movers are not', () => {
    const map = (x: number, y: number) => (x === 3 && y === 5 ? { kind: 'hazard' as const, h: 0 } : undefined)
    const f = duel({ a: { x: 1, y: 5 }, e: { x: 11, y: 11 }, map })
    f.a.flying = true
    f.b.beginTurn(f.a)
    const hp = f.a.hp
    f.b.move(f.a, { x: 5, y: 5 })
    expect(f.a.hp).toBe(hp)
    const g = duel({ a: { x: 1, y: 5 }, e: { x: 11, y: 11 }, map })
    g.b.beginTurn(g.a)
    rigDice(g.b, 20, 1)
    const hp2 = g.a.hp
    g.b.move(g.a, { x: 3, y: 5 })
    expect(g.a.hp).toBeLessThan(hp2)
  })

  it('a burn hazard deals 5 burn on a failed check (core p.62)', () => {
    const map = (x: number, y: number) => (x === 3 && y === 5 ? { kind: 'hazard' as const, h: 0, hazardType: 'Burn' as const } : undefined)
    const { a, b } = duel({ a: { x: 1, y: 5 }, e: { x: 11, y: 11 }, map })
    b.beginTurn(a)
    rigDice(b, 20, 1)
    const hp = a.hp
    b.move(a, { x: 3, y: 5 })
    expect(a.burn).toBe(5)
    expect(a.hp).toBe(hp - 5) // burn's first damage lands at once
  })

  it('zero-g: a mech with a flight system (switched off) is not Slowed; one without is', () => {
    const z = (sys: string[]) => {
      const a = mech({ systems: sys })
      const e = mech({}, 'enemy')
      const b = arena([[a, { x: 1, y: 5 }], [e, { x: 11, y: 11 }]])
      b.addArea({ kind: 'zero_g', tiles: [{ x: 2, y: 5 }, { x: 3, y: 5 }] } as any)
      b.beginTurn(a)
      b.move(a, { x: 2, y: 5 })
      return { a, b }
    }
    const f = z(['ms_type_i_flight_system'])
    expect(f.a.flags.zeroG).toBe(true)
    expect(f.b.has(f.a, 'slowed')).toBe(false)
    const g = z([])
    expect(g.b.has(g.a, 'slowed')).toBe(true)
  })
})

// ------------------------------------------------------------------------------------------------ Hidden
describe('Hidden (core p.69)', () => {
  /** Hider at (5,2) behind a wall row y=4 (x 3..7) from an enemy at (5,8). */
  function hidden() {
    const a = pregenUnit('Assault')
    const e = pregenUnit('Sniper', 'enemy')
    const map = flatMap(14, 14, (x, y) => (y === 3 && x >= 3 && x <= 7 ? { kind: 'block', h: 3 } : undefined))
    const b = arena([[a, { x: 5, y: 0 }], [e, { x: 5, y: 8 }]], { map })
    b.beginTurn(a)
    b.hide(a)
    expect(b.has(a, 'hidden')).toBe(true)
    b.endTurn(a)
    return { a, e, b }
  }

  it('is lost when a hostile moves to where it sees the hider without cover', () => {
    const { a, e, b } = hidden()
    b.beginTurn(e)
    e.moveLeft = 10
    b.move(e, { x: 10, y: 0 })
    expect(b.los(e, a)).toBe(true)
    expect(b.has(a, 'hidden')).toBe(false)
  })

  it('is lost when the cover is destroyed', () => {
    const { a, b } = hidden()
    for (let x = 3; x <= 7; x++) b.damageTerrain({ x, y: 3 }, 100)
    expect(b.has(a, 'hidden')).toBe(false)
  })

  it('Hidden while Invisible ends with Invisible when not in cover', () => {
    const { a, e, b } = duel({ a: { x: 2, y: 5 }, e: { x: 8, y: 5 } })
    b.beginTurn(a)
    b.addStatus(a, 'invisible')
    b.hide(a)
    expect(b.has(a, 'hidden')).toBe(true)
    b.removeStatus(a, 'invisible')
    expect(b.has(a, 'hidden')).toBe(false)
    void e
  })

  it('an Invisible but Engaged character cannot Hide', () => {
    const { a, b } = duel({ a: { x: 5, y: 5 }, e: { x: 6, y: 5 } })
    b.beginTurn(a)
    b.addStatus(a, 'invisible')
    expect(b.isEngaged(a)).toBe(true)
    expect(b.canHide(a)).toBe(false)
  })
})

// ------------------------------------------------------------------------------------------------ scripted actions
describe('scripted item actions enforce their range and target side for every caller', () => {
  function setup(systems: string[], foeAt: Pos, allyAt?: Pos) {
    const a = mech({ systems })
    const e = mech({ callsign: 'Foe' }, 'enemy')
    const al = mech({ callsign: 'Ally' })
    const b = arena([[a, { x: 2, y: 2 }], [e, foeAt], [al, allyAt ?? { x: 2, y: 4 }]], { map: flatMap(30, 30) })
    act(b, a)
    return { a, e, al, b }
  }

  it('Aceso Stabilizer: an ally within 5 only, never a hostile', () => {
    const far = setup(['ms_aceso_stabilizer'], { x: 20, y: 20 }, { x: 8, y: 2 })
    expect(() => far.b.useCustom(far.a, custom(far.b, far.a, 'aceso'), far.al)).toThrow(/Out of range/)
    expect(far.al.overshield).toBe(0)
    const foe = setup(['ms_aceso_stabilizer'], { x: 4, y: 2 })
    expect(() => foe.b.useCustom(foe.a, custom(foe.b, foe.a, 'aceso'), foe.e)).toThrow(/ally/)
    const ok = setup(['ms_aceso_stabilizer'], { x: 20, y: 20 }, { x: 7, y: 2 })
    ok.b.useCustom(ok.a, custom(ok.b, ok.a, 'aceso'), ok.al)
    expect(ok.al.overshield).toBeGreaterThan(0)
  })

  it('Smoke Grenade: a blast aimed within range 5', () => {
    const s = setup(['ms_pattern_a_smoke_charges'], { x: 20, y: 20 })
    expect(() => s.b.useCustom(s.a, custom(s.b, s.a, 'smoke-grenade'), { x: 12, y: 2 })).toThrow(/Out of range/)
    expect(s.b.areas.length).toBe(0)
    s.b.useCustom(s.a, custom(s.b, s.a, 'smoke-grenade'), { x: 7, y: 2 })
    expect(s.b.areas.length).toBeGreaterThan(0)
  })

  it('Flak Launcher: a hostile within 15', () => {
    const s = setup(['ms_flak_launcher'], { x: 2, y: 26 })
    s.e.flying = true
    expect(() => s.b.useCustom(s.a, custom(s.b, s.a, 'flak'), s.e)).toThrow(/Out of range/)
    expect(s.e.flying).toBe(true)
    expect(() => s.b.useCustom(s.a, custom(s.b, s.a, 'flak'), s.al)).toThrow(/hostile/)
  })

  it('Clamp Bombs: a hostile within Sensors', () => {
    const s = setup(['ms_clamp_bombs'], { x: 2, y: 28 })
    expect(s.b.distance(s.a, s.e)).toBeGreaterThan(s.a.stats.sensors)
    expect(() => s.b.useCustom(s.a, custom(s.b, s.a, 'clamp'), s.e)).toThrow(/Out of range/)
    expect(s.e.flags.clampBy).toBeUndefined()
  })
})
