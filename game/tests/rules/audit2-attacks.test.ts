// Audit 2, Core-A: attacks and cover. Threat, hard cover and flanking, line of sight past cover, area patterns
// (Cone shape, line of sight and height, who they hit), bonus damage in one packet, Gravity Gun, Napalm Grenade,
// default object HP, Titanomachy Mesh knockback and NPC Brace. Page numbers are the core book's.
import { describe, expect, it } from 'vitest'
import type { Battle } from '../../src/rules/battle'
import { coneTiles, coverBetween, hasLineOfSight, type GridMap } from '../../src/rules/grid'
import { deployableUnit } from '../../src/rules/effects/generic'
import { buildNpc } from '../../src/enemies/build'
import type { Pos, Unit } from '../../src/rules/types'
import { act, arena, flatMap, mech, rigDice } from '../support'
import { custom } from '../gear/helpers'

const blocks = (list: [number, number, number][], w = 14) =>
  flatMap(w, w, (x, y) => { const k = list.find(b => b[0] === x && b[1] === y); return k ? { h: k[2], kind: 'block' } : undefined })

/** attacker and target on a map with these blocks */
const scene = (list: [number, number, number][], apos: Pos, tpos: Pos, asize = 1, tsize = 1) => {
  const a = mech(); const t = mech({}, 'enemy')
  a.stats.size = asize; t.stats.size = tsize
  const b = arena([[a, apos], [t, tpos]], { map: blocks(list) })
  return { a, t, b }
}

/** Fire `w` at `aim` and return the units it attacked. */
const fire = (b: Battle, u: Unit, w = u.weapons[0], aim: Pos) => b.weaponAttack(u, w, { tile: aim }, 'free').ctxs.map(c => c.target)

describe('Threat (p. 64, glossary p. 79)', () => {
  it('every weapon has Threat 1 by default, so a ranged weapon can Overwatch an adjacent mover', () => {
    const a = mech({ weapons: 'mw_assault_rifle' })
    const e = mech({ weapons: 'mw_assault_rifle' }, 'enemy')
    const b = arena([[a, { x: 2, y: 5 }], [e, { x: 3, y: 5 }]])
    expect(b.weaponThreat(a, a.weapons[0])).toBe(1)
    expect(b.bestThreatWeapon(a, e)?.dataId).toBe('mw_assault_rifle')
    act(b, e)
    b.move(e, { x: 7, y: 5 })
    expect(b.log.some(l => /OVERWATCH/.test(l.text))).toBe(true)
  })
})

describe('hard cover and flanking (p. 66)', () => {
  it('a block directly between attacker and target is hard cover', () => {
    const { a, t, b } = scene([[7, 5, 1]], { x: 2, y: 5 }, { x: 8, y: 5 })
    expect(coverBetween(b.map, a, t)).toBe('hard')
  })

  it('a block adjacent to the target but off every line from the attacker gives no cover (flanked)', () => {
    const { a, t, b } = scene([[7, 4, 1]], { x: 2, y: 5 }, { x: 8, y: 5 })
    expect(coverBetween(b.map, a, t)).toBe('none') // was 'hard' (within 60 degrees of the attacker)
  })

  it('a clear diagonal line past the block flanks the target', () => {
    const { a, t, b } = scene([[7, 5, 1]], { x: 5, y: 2 }, { x: 8, y: 5 })
    expect(coverBetween(b.map, a, t)).not.toBe('hard')
  })

  it('a Size 2 target needs cover of its Size across its whole side: one 2-high space is not enough', () => {
    const wall = scene([[6, 5, 2], [6, 6, 2]], { x: 1, y: 5 }, { x: 7, y: 5 }, 1, 2)
    expect(coverBetween(wall.b.map, wall.a, wall.t)).toBe('hard')
    const pillar = scene([[6, 5, 2]], { x: 1, y: 5 }, { x: 7, y: 5 }, 1, 2)
    expect(coverBetween(pillar.b.map, pillar.a, pillar.t)).not.toBe('hard')
  })
})

describe('line of sight past cover (pp. 65-66)', () => {
  it('a Size 2 target behind a wall as tall as itself can be attacked, with hard cover, by a Size 1 attacker', () => {
    const { a, t, b } = scene([[6, 5, 2], [6, 6, 2]], { x: 1, y: 5 }, { x: 7, y: 5 }, 1, 2)
    expect(hasLineOfSight(b.map, a, t)).toBe(true) // was false
    expect(b.validTarget(a, a.weapons[0], t)).toBe(true)
    expect(b.cover(a, t)).toBe('hard')
    const ctx = b.buildWeaponCtx(a, a.weapons[0], t, 'skirmish', false)
    expect(ctx.reasons).toContain('Hard cover -2')
  })

  it('a Size 3 target behind 3-high cover is also targetable', () => {
    const { a, t, b } = scene([[6, 5, 3], [6, 6, 3], [6, 7, 3]], { x: 1, y: 5 }, { x: 7, y: 5 }, 1, 3)
    expect(b.los(a, t)).toBe(true)
    expect(b.cover(a, t)).toBe('hard')
  })

  it('a wall taller than the target still hides it', () => {
    const { a, t, b } = scene([[7, 5, 2]], { x: 2, y: 5 }, { x: 8, y: 5 })
    expect(b.los(a, t)).toBe(false)
  })

  it('an attacker shoots over its own adjacent cover no taller than itself: no cover for the target', () => {
    const one = scene([[3, 5, 1]], { x: 2, y: 5 }, { x: 8, y: 5 })
    expect(coverBetween(one.b.map, one.a, one.t)).toBe('none') // was 'soft'
    const big = scene([[3, 5, 1], [3, 6, 1]], { x: 1, y: 5 }, { x: 9, y: 5 }, 2, 1)
    expect(coverBetween(big.b.map, big.a, big.t)).toBe('none')
  })

  it('a Size 2 attacker sees over its own 2-high wall; a Size 1 attacker behind it cannot', () => {
    const big = scene([[3, 5, 2], [3, 6, 2]], { x: 1, y: 5 }, { x: 9, y: 5 }, 2, 1)
    expect(big.b.los(big.a, big.t)).toBe(true)
    const small = scene([[3, 5, 2]], { x: 2, y: 5 }, { x: 9, y: 5 })
    expect(small.b.los(small.a, small.t)).toBe(false)
  })
})

describe('Cone (p. 64)', () => {
  const at = (map: GridMap, pos: Pos) => { const u = mech(); u.pos = pos; return coneTiles(map, u, { x: pos.x + 5, y: pos.y }, 3) }
  it('starts one space wide and is X wide at its far end', () => {
    const map = flatMap(14, 14)
    const t = at(map, { x: 1, y: 6 })
    const ring = (d: number) => t.filter(p => p.x === 1 + d)
    expect(ring(1)).toEqual([{ x: 2, y: 6 }])
    expect(ring(3).map(p => p.y).sort()).toEqual([5, 6, 7])
    expect(t.length).toBe(5) // was 9: a 3x3 block
  })

  it('a diagonal Cone 3 also starts one space wide and is 3 wide at the end', () => {
    const u = mech(); u.pos = { x: 1, y: 1 }
    const t = coneTiles(flatMap(14, 14), u, { x: 6, y: 6 }, 3)
    expect(t.filter(p => Math.max(p.x - 1, p.y - 1) === 1)).toEqual([{ x: 2, y: 2 }])
    expect(t.filter(p => Math.max(p.x - 1, p.y - 1) === 3).length).toBe(3)
  })

  it('Cone 7 is 7 wide at range 7', () => {
    const u = mech(); u.pos = { x: 0, y: 7 }
    const t = coneTiles(flatMap(16, 16), u, { x: 10, y: 7 }, 7)
    expect(t.filter(p => p.x === 7).length).toBe(7)
    expect(t.filter(p => p.x === 1).length).toBe(1)
  })
})

describe('area attacks: line of sight, height and who they hit (pp. 64-65, rulings)', () => {
  it('a Line does not reach a target behind a wall taller than both', () => {
    const a = mech({ weapons: [['Auxiliary', 'mw_thermal_pistol']] })
    const e = mech({}, 'enemy')
    const b = arena([[a, { x: 1, y: 5 }], [e, { x: 5, y: 5 }]], { map: flatMap(12, 12, x => (x === 3 ? { h: 4, kind: 'block' } : undefined)) })
    act(b, a)
    expect(fire(b, a, a.weapons[0], { x: 5, y: 5 })).not.toContain(e) // was attacked through the wall
  })

  it("a Blast's line of sight comes from its centre: a full-height wall between the centre and a unit protects it", () => {
    const run = (wall: boolean) => {
      const a = mech({ weapons: 'mw_rocket_propelled_grenade' })
      const e = mech({}, 'enemy')
      const map = flatMap(12, 12, (x, y) => (wall && x === 5 && y === 4 ? { h: 4, kind: 'block' } : undefined))
      const b = arena([[a, { x: 1, y: 6 }], [e, { x: 5, y: 3 }]], { map })
      act(b, a)
      return fire(b, a, a.weapons[0], { x: 5, y: 5 }).includes(e)
    }
    expect(run(false)).toBe(true)
    expect(run(true)).toBe(false)
  })

  it('a Burst does not reach a target high above it', () => {
    const a = mech({ weapons: [['Auxiliary', 'mw_bristlecrown_flechette_launcher']] })
    const e = mech({}, 'enemy')
    const b = arena([[a, { x: 5, y: 5 }], [e, { x: 6, y: 5 }]], { map: blocks([[6, 5, 6]], 12) })
    act(b, a)
    expect(fire(b, a, a.weapons[0], a.pos)).not.toContain(e)
    e.pos = { x: 4, y: 5 }
    b.invalidateTerrain()
    a.weapons[0].loaded = true
    expect(fire(b, a, a.weapons[0], a.pos)).toContain(e)
  })

  it("areas hit the attacker's own deployables, and Hidden characters", () => {
    const a = mech({ weapons: [['Auxiliary', 'mw_missile_rack']] })
    const e = mech({}, 'enemy')
    const b = arena([[a, { x: 1, y: 5 }], [e, { x: 6, y: 5 }]])
    const cover = deployableUnit(a, { name: 'Box', type: 'Deployable', size: 1 } as any, { x: 6, y: 6 })
    b.units.push(cover)
    b.addStatus(e, 'hidden')
    act(b, a)
    const hit = fire(b, a, a.weapons[0], { x: 6, y: 5 })
    expect(hit).toContain(cover) // was spared
    expect(hit).toContain(e)
  })

  it('your own Blast can hit you; your Burst never does', () => {
    const a = mech({ weapons: [['Main', 'mw_rocket_propelled_grenade'], ['Auxiliary', 'mw_bristlecrown_flechette_launcher']] })
    const e = mech({}, 'enemy')
    const b = arena([[a, { x: 4, y: 5 }], [e, { x: 6, y: 5 }]])
    act(b, a)
    const rpg = a.weapons.find(w => w.dataId === 'mw_rocket_propelled_grenade')!
    const burst = a.weapons.find(w => w.dataId === 'mw_bristlecrown_flechette_launcher')!
    expect(b.aoeTargets(a, rpg, { x: 5, y: 5 })).toContain(a)
    expect(b.aoeTargets(a, burst, a.pos)).not.toContain(a)
  })
})

describe('bonus damage (p. 64)', () => {
  it('area bonus damage is rolled once for the attack and halved for every target', () => {
    const a = mech({ weapons: [['Auxiliary', 'mw_thermal_pistol']] })
    const es = [0, 1, 2].map(() => mech({}, 'enemy'))
    const b = arena([[a, { x: 1, y: 5 }], [es[0], { x: 3, y: 5 }], [es[1], { x: 4, y: 5 }], [es[2], { x: 5, y: 5 }]])
    for (const e of es) { e.stats.armor = 0; e.stats.evasion = 1 }
    act(b, a)
    const orig = b.buildWeaponCtx.bind(b)
    b.buildWeaponCtx = ((...args: Parameters<Battle['buildWeaponCtx']>) => { const c = orig(...args); b.addBonusDamage(c, '1d6', 'Kinetic'); return c }) as any
    rigDice(b, 20, 10, 10, 10)
    rigDice(b, 6, 6) // one bonus roll for the whole attack
    const hp = es.map(e => e.hp)
    b.weaponAttack(a, a.weapons[0], { tile: { x: 5, y: 5 } }, 'skirmish')
    expect(es.map((e, i) => hp[i] - e.hp)).toEqual([5, 5, 5]) // 2 energy + ceil(6 / 2)
  })

  it('addBonusDamage joins the hit: Armor comes off once', () => {
    const a = mech({ weapons: 'mw_assault_rifle' })
    const e = mech({}, 'enemy')
    const b = arena([[a, { x: 1, y: 5 }], [e, { x: 5, y: 5 }]])
    e.stats.armor = 2
    act(b, a)
    const orig = b.buildWeaponCtx.bind(b)
    b.buildWeaponCtx = ((...args: Parameters<Battle['buildWeaponCtx']>) => { const c = orig(...args); b.addBonusDamage(c, 3, undefined, { source: 'Test lock' }); return c }) as any
    rigDice(b, 20, 15)
    rigDice(b, 6, 4)
    const hp = e.hp
    b.weaponAttack(a, a.weapons[0], { targetId: e.id }, 'skirmish')
    expect(hp - e.hp).toBe(4 + 3 - 2) // a separate hit would have lost Armor twice: (4 - 2) + (3 - 2)
  })

  it('critOnly and onlyIf bonus damage are checked when the attack hits', () => {
    const a = mech({ weapons: 'mw_assault_rifle' })
    const e = mech({}, 'enemy')
    const b = arena([[a, { x: 1, y: 5 }], [e, { x: 5, y: 5 }]])
    e.stats.armor = 0
    e.stats.evasion = 5
    act(b, a)
    let asked = 0
    const orig = b.buildWeaponCtx.bind(b)
    b.buildWeaponCtx = ((...args: Parameters<Battle['buildWeaponCtx']>) => {
      const c = orig(...args)
      b.addBonusDamage(c, 10, undefined, { critOnly: true })
      b.addBonusDamage(c, 1, undefined, { onlyIf: () => { asked++; return true } })
      return c
    }) as any
    rigDice(b, 20, 8) // a hit, not a crit
    rigDice(b, 6, 4)
    const hp = e.hp
    b.weaponAttack(a, a.weapons[0], { targetId: e.id }, 'skirmish')
    expect(hp - e.hp).toBe(4 + 1)
    expect(asked).toBe(1)
  })
})

describe('Gravity Gun on_attack', () => {
  it('the Hull save is made by the characters in the area, not the attacker', () => {
    const a = mech({ weapons: [['Heavy', 'mw_gravity_gun']] })
    const e = mech({}, 'enemy')
    const b = arena([[a, { x: 1, y: 5 }], [e, { x: 7, y: 5 }]])
    act(b, a)
    const savers: string[] = []
    const orig = b.save.bind(b)
    b.save = ((u: Unit, ...rest: any[]) => { savers.push(u.id); return (orig as any)(u, ...rest) }) as any
    b.weaponAttack(a, a.weapons[0], { tile: { x: 7, y: 5 } }, 'skirmish')
    expect(savers).toContain(e.id)
    expect(savers).not.toContain(a.id)
  })
})

describe('Napalm Grenade: a Line with a Range (p. 64)', () => {
  it('the Line 5 starts at the impact point, up to Range 5 away', () => {
    const setup = () => {
      const a = mech({ systems: ['ms_havok_charges'] })
      const e = mech({}, 'enemy')
      const b = arena([[a, { x: 1, y: 5 }], [e, { x: 9, y: 5 }]], { map: flatMap(16, 16) })
      act(b, a)
      return { a, e, b, nap: custom(b, a, /Napalm Grenade/) }
    }
    const far = setup()
    expect(() => far.b.useCustom(far.a, far.nap, { x: 7, y: 5 })).toThrow(/range/i)
    const { a, e, b, nap } = setup()
    rigDice(b, 20, 1) // e fails its Agility save
    b.useCustom(a, nap, { x: 6, y: 5 })
    expect(e.burn).toBe(2) // 3 spaces past the impact point: out of reach of a Line 5 drawn from the user
  })
})

describe('objects (p. 68)', () => {
  it('a deployable object with no HP listed has 10 HP per Size; drones 5', () => {
    const o = mech()
    expect(deployableUnit(o, { name: 'X', type: 'Deployable', size: 2 } as any, { x: 0, y: 0 }).hp).toBe(20)
    expect(deployableUnit(o, { name: 'Y', type: 'Deployable', size: 1 } as any, { x: 0, y: 0 }).hp).toBe(10)
    expect(deployableUnit(o, { name: 'Z', type: 'Drone' } as any, { x: 0, y: 0 }).hp).toBe(5)
  })
})

describe('Titanomachy Mesh', () => {
  const titan = (weapon: string) => {
    const a = mech({ weapons: weapon, coreBonuses: ['cb_titanomachy_mesh'] })
    const e = mech({}, 'enemy')
    const b = arena([[a, { x: 4, y: 5 }], [e, { x: 5, y: 5 }]], { map: flatMap(14, 14) })
    e.stats.evasion = 1
    act(b, a)
    return { a, e, b }
  }
  it('a melee hit without Knockback pushes nobody', () => {
    const { a, e, b } = titan('mw_tactical_melee_weapon')
    rigDice(b, 20, 15)
    b.weaponAttack(a, a.weapons[0], { targetId: e.id }, 'skirmish')
    expect(e.pos).toEqual({ x: 5, y: 5 }) // was pushed 1
  })
  it('a Knockback 1 melee weapon pushes 2', () => {
    const { a, e, b } = titan('mw_war_pike')
    rigDice(b, 20, 15)
    b.weaponAttack(a, a.weapons[0], { targetId: e.id }, 'skirmish')
    expect(e.pos).toEqual({ x: 7, y: 5 })
  })
  it('a successful Ram on a mech knocks back 2 and allows a free Ram or Grapple once per round', () => {
    const { a, e, b } = titan('mw_assault_rifle')
    rigDice(b, 20, 15)
    b.ram(a, e)
    expect(e.pos).toEqual({ x: 7, y: 5 })
    expect(b.canSpend(a, 'quick', 'grapple')).toBe(true)
    a.actionsLeft = 0
    a.pos = { x: 6, y: 5 }
    rigDice(b, 20, 15)
    b.grapple(a, e) // free
    expect(b.has(e, 'grappled')).toBe(true)
    expect(a.flags['turn:freeQuick']).toBeUndefined()
  })
})

describe('NPCs never Brace (p. 280)', () => {
  it('an Elite NPC facing lethal damage does not Brace', () => {
    const gunF = { type: 'weapon', name: 'Gun', weaponType: 'Rifle', range: [{ type: 'Range', val: 10 }], damage: [{ type: 'Kinetic', val: '4' }] }
    const e = buildNpc({ name: 'N', role: 'Striker', features: [gunF], templates: ['Elite'] } as any, 1)
    const p = mech()
    const b = arena([[p, { x: 1, y: 1 }], [e, { x: 4, y: 1 }]])
    e.hp = 2
    expect(b.shouldBrace(e, [{ type: 'Kinetic', amount: 10 }])).toBe(false)
    expect(b.brace(e)).toBe(false)
    expect(b.has(e, 'braced')).toBe(false)
  })
})
