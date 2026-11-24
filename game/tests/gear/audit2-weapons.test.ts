// Audit 2, weapons and weapon mods: each item judged by its lancer-data text (the errata).
import { describe, expect, it, vi } from 'vitest'
import type { Battle } from '../../src/rules/battle'
import type { MountBuild } from '../../src/import/compcon'
import type { AttackCtx } from '../../src/rules/effects/registry'
import { deployableUnit } from '../../src/rules/effects/generic'
import type { Unit } from '../../src/rules/types'
import { act, arena, flatMap, mech, pregenUnit, rigDice } from '../support'
import { custom, slot, vs, weapon } from './helpers'

/** A level-9 Everest with these mounts (and options). */
const armed = (mounts: MountBuild[], o: Parameters<typeof mech>[0] = {}) => mech({ weapons: mounts, ...o })
/** An extra enemy (pregen Sniper) at this spot. */
function foe(b: Battle, x: number, y: number, name = 'Foe'): Unit {
  const f = pregenUnit('Sniper', 'enemy')
  f.name = name
  f.pos = { x, y }
  b.units.push(f)
  return f
}
const attacksWith = (b: Battle, name: string) => b.log.filter(l => l.text.startsWith(`Tester attacks with ${name}`)).length
/** Sure hits that never crit (a crit would roll damage twice). */
const sureHit = (a: Unit) => { a.stats.attackBonus = 30; a.canCrit = false }

describe('Annihilator', () => {
  it('a miss makes no secondary attacks', () => {
    const { a, b } = vs(armed([slot('Main', 'mw_annihilator')]), { enemy: { evasion: 40 } })
    foe(b, 6, 8)
    rigDice(b, 20, 1)
    b.weaponAttack(a, weapon(a, 'mw_annihilator'), { targetId: b.units[1].id }, 'free')
    expect(attacksWith(b, 'Annihilator')).toBe(1)
  })
  it('a hit attacks every other character in burst 1 of the target, and the heat is paid once', () => {
    const { a, e, b } = vs(armed([slot('Main', 'mw_annihilator')]), { enemy: { evasion: 1 } })
    const f = foe(b, 6, 8)
    sureHit(a)
    const heat = a.heat
    b.weaponAttack(a, weapon(a, 'mw_annihilator'), { targetId: e.id }, 'free')
    expect(b.log.some(l => /vs Foe/.test(l.text))).toBe(true)
    expect(attacksWith(b, 'Annihilator')).toBe(2)
    expect(a.heat - heat).toBe(2)
    expect(f.hp).toBeLessThan(f.stats.hp)
  })
})

describe('Arc Projector', () => {
  it('secondary targets are measured from the first target; 1 heat each beyond the weapon’s own', () => {
    const { a, e, b } = vs(armed([slot('Heavy', 'mw_arc_projector')]), { enemy: { evasion: 1 } })
    const near = foe(b, 7, 8, 'Near') // 2 from the first target
    const far = foe(b, 9, 8, 'Far') // 2 from Near but 4 from the first target
    near.stats.evasion = 1; far.stats.evasion = 1
    sureHit(a)
    const heat = a.heat
    b.weaponAttack(a, weapon(a, 'mw_arc_projector'), { targetId: e.id }, 'free')
    expect(attacksWith(b, 'Arc Projector')).toBe(2)
    expect(b.log.some(l => /vs Near/.test(l.text))).toBe(true)
    expect(b.log.some(l => /vs Far/.test(l.text))).toBe(false)
    expect(a.heat - heat).toBe(2) // 1 (weapon) + 1 (secondary attack)
  })
  it('the player may stop the chain', () => {
    const { a, e, b } = vs(armed([slot('Heavy', 'mw_arc_projector')]), { enemy: { evasion: 1 } })
    foe(b, 7, 8, 'Near')
    sureHit(a)
    b.chooser = q => (q.kind === 'arc_chain' ? q.options.length - 1 : undefined)
    b.transaction(() => { b.weaponAttack(a, weapon(a, 'mw_arc_projector'), { targetId: e.id }, 'free') })
    expect(attacksWith(b, 'Arc Projector')).toBe(1)
  })
})

describe('Autogun', () => {
  it('doesn’t benefit from or trigger your talents', () => {
    const a = armed([slot('Main', 'mw_autogun')], { talents: [['t_brutal', 3]] })
    const { e, b } = vs(a, { enemy: { evasion: 1 } })
    a.flags.relentless = 2
    const seen: AttackCtx[] = []
    const spy = vi.spyOn(b, 'rollToHit').mockImplementation(function (this: Battle, ctx: AttackCtx) { seen.push(ctx); ctx.hit = false; ctx.crit = false })
    b.endTurn(a)
    spy.mockRestore()
    expect(seen.length).toBe(1)
    expect(seen[0].target).toBe(e)
    expect(seen[0].reasons.some(r => /Relentless/.test(r))).toBe(false)
    expect(a.flags.relentless).toBe(2) // Relentless's after-attack didn't run either
    expect(a.talents).toHaveLength(1)
  })
})

describe('Bristlecrown Flechette Launcher', () => {
  it('3 kinetic to a Grappled target, armor applied once', () => {
    const { a, e, b } = vs(armed([slot('Main', 'mw_assault_rifle')], { aux: 'mw_bristlecrown_flechette_launcher' }), { e: { x: 5, y: 5 }, enemy: { evasion: 1, armor: 1 } })
    b.addStatus(e, 'grappled', 'until_cleared', a)
    sureHit(a)
    const hp = e.hp
    b.weaponAttack(a, weapon(a, 'mw_bristlecrown_flechette_launcher'), { tile: a.pos }, 'free')
    expect(hp - e.hp).toBe(2)
  })
  it('the same against each of several targets (the extra damage is not halved)', () => {
    const { a, e, b } = vs(armed([slot('Main', 'mw_assault_rifle')], { aux: 'mw_bristlecrown_flechette_launcher' }), { e: { x: 5, y: 5 }, enemy: { evasion: 1, armor: 1 } })
    const f = foe(b, 6, 5)
    f.stats.evasion = 1; f.stats.armor = 1
    b.addStatus(e, 'grappled', 'until_cleared', a)
    b.addStatus(f, 'grappled', 'until_cleared', a)
    sureHit(a)
    const hp = e.hp, hf = f.hp
    b.weaponAttack(a, weapon(a, 'mw_bristlecrown_flechette_launcher'), { tile: a.pos }, 'free')
    expect(hp - e.hp).toBe(2)
    expect(hf - f.hp).toBe(2)
  })
})

describe('Cutter MkII Plasma Torch', () => {
  it('deals 10 to terrain (one section)', () => {
    const map = flatMap(16, 16, (x, y) => (x === 5 && y === 5 ? { h: 3, kind: 'block' } : undefined))
    const { a, b } = vs(armed([slot('Main', 'mw_assault_rifle')], { aux: 'mw_cutter_mkii_plasma_torch' }), { map })
    rigDice(b, 20, 15)
    b.attackTerrain(a, weapon(a, 'mw_cutter_mkii_plasma_torch'), { x: 5, y: 5 })
    expect(b.map.tiles[5 * 16 + 5].h).toBe(2)
  })
  it('deals 10 AP energy to an object', () => {
    const { a, b } = vs(armed([slot('Main', 'mw_assault_rifle')], { aux: 'mw_cutter_mkii_plasma_torch' }))
    const e = b.units[1]
    const wall = deployableUnit(e, { name: 'Wall', type: 'Deployable', hp: 20, armor: 3, evasion: 5 } as any, { x: 5, y: 5 })
    b.units.push(wall)
    sureHit(a)
    b.weaponAttack(a, weapon(a, 'mw_cutter_mkii_plasma_torch'), { targetId: wall.id }, 'free')
    expect(20 - wall.hp).toBe(10)
  })
})

describe('Gravity Gun', () => {
  it('characters in the blast save (Hull) or take 1d6 energy and are pulled toward the centre; the attacker is unharmed', () => {
    const { a, e, b } = vs(armed([slot('Heavy', 'mw_gravity_gun')]), { e: { x: 8, y: 8 }, enemy: { evasion: 1, armor: 0 } })
    const hp = a.hp, heat = a.heat
    rigDice(b, 20, 10, 1) // attack roll, then the Hull save fails
    rigDice(b, 6, 4)
    b.weaponAttack(a, weapon(a, 'mw_gravity_gun'), { tile: { x: 5, y: 8 } }, 'free')
    expect(e.stats.hp - e.hp).toBe(4)
    expect(Math.max(Math.abs(e.pos.x - 5), Math.abs(e.pos.y - 8))).toBeLessThanOrEqual(1)
    expect(a.hp).toBe(hp)
    expect(a.heat).toBe(heat)
  })
})

describe('Latch Drone (Lancaster, mw_lancaster_integrated)', () => {
  const lancaster = () => mech({ frame: 'mf_lancaster', weapons: [] })
  it('refuses an ally out of range', () => {
    const a = lancaster()
    const ally = mech({ callsign: 'Ally' })
    const { b } = vs(a)
    ally.pos = { x: 15, y: 4 } // 9 away
    b.units.push(ally)
    expect(() => b.useCustom(a, custom(b, a, /Latch Drone Repair/), ally)).toThrow(/range/i)
  })
  it('an attack roll vs Evasion 8: a miss heals nothing; on a hit the target may pay the Repair', () => {
    const setup = () => {
      const a = lancaster()
      const ally = mech({ callsign: 'Ally' })
      const { b } = vs(a)
      ally.pos = { x: 7, y: 4 }
      b.units.push(ally)
      ally.hp = 1
      a.repairs = 0
      return { a, ally, b }
    }
    const m = setup()
    rigDice(m.b, 20, 1)
    m.b.useCustom(m.a, custom(m.b, m.a, /Latch Drone Repair/), m.ally)
    expect(m.ally.hp).toBe(1)
    const { a, ally, b } = setup()
    const repairs = ally.repairs
    rigDice(b, 20, 15)
    b.useCustom(a, custom(b, a, /Latch Drone Repair/), ally)
    expect(ally.hp).toBe(1 + Math.ceil(ally.stats.hp / 2))
    expect(ally.repairs).toBe(repairs - 1)
  })
})

describe('Leviathan Heavy Assault Cannon', () => {
  const leviathan = () => armed([slot('Superheavy', 'mw_leviathan_heavy_assault_cannon')])
  it('the Standard profile can Skirmish and Overwatch; Spin-Up Mode cannot', () => {
    const { a, e, b } = vs(leviathan(), { enemy: { evasion: 1 } })
    const w = weapon(a, 'mw_leviathan_heavy_assault_cannon')
    expect(b.bestThreatWeapon(a, e)).toBe(null) // Range only, no Threat: but not refused for its size
    const r = b.skirmish(a, w, { targetId: e.id })
    expect(r.ok).toBe(true)
    w.profileIndex = 1
    const r2 = b.skirmish(a, w, { targetId: e.id })
    expect(r2.ok).toBe(false)
    expect(r2.reason).toMatch(/Barrage/)
  })
  it('other Superheavy weapons can’t Overwatch', () => {
    const { a, e, b } = vs(armed([slot('Superheavy', 'mw_combat_drill')]), { e: { x: 5, y: 5 } })
    expect(b.bestThreatWeapon(a, e)).toBe(null)
  })
  it('spinning up (the weapon card’s profile switch) costs a quick action and Slows', () => {
    const { a, b } = vs(leviathan())
    const w = weapon(a, 'mw_leviathan_heavy_assault_cannon')
    // the switch the UI's profile button uses (key `${uid}:p${i}`)
    const sw = b.customActions(a).find(x => x.key === `${w.uid}:p1`)!
    expect(sw.activation).toBe('quick')
    const before = a.actionsLeft
    b.useCustom(a, sw, a)
    expect(w.profileIndex).toBe(1)
    expect(b.has(a, 'slowed')).toBe(true)
    expect(a.actionsLeft).toBe(before - 1)
  })
})

describe('M35 Mjolnir and ROLAND Chamber', () => {
  it('a reload opens both: the free Mjolnir shot doesn’t cancel ROLAND', () => {
    const a = mech({ frame: 'mf_raleigh', weapons: [['Main', 'mw_rocket_propelled_grenade']], systems: ['ms_roland_chamber'] })
    const { e, b } = vs(a, { enemy: { evasion: 1 } })
    sureHit(a)
    a.flags.reloaded = true
    b.useCustom(a, custom(b, a, /Mjolnir \(free\)/), e)
    expect(attacksWith(b, 'M35 Mjolnir')).toBe(1)
    const saves = b.log.filter(l => /HULL save/i.test(l.text)).length
    b.weaponAttack(a, weapon(a, 'mw_rocket_propelled_grenade'), { tile: e.pos }, 'free')
    expect(b.log.filter(l => /HULL save/i.test(l.text)).length).toBe(saves + 1) // ROLAND's Prone save
  })
  it('the Mjolnir window closes at the end of the turn', () => {
    const a = mech({ frame: 'mf_raleigh', weapons: [['Main', 'mw_assault_rifle']] })
    const { b } = vs(a)
    a.flags.reloaded = true
    expect(b.customActions(a).some(x => /Mjolnir \(free\)/.test(x.name))).toBe(true)
    b.endTurn(a)
    expect(b.customActions(a).some(x => /Mjolnir \(free\)/.test(x.name))).toBe(false)
  })
})

describe('Phase-Ready Mod', () => {
  it('attacks through a wall without line of sight', () => {
    const map = flatMap(16, 16, (x, y) => (y === 6 ? { h: 4, kind: 'block' } : undefined))
    const a = armed([slot('Main', 'mw_assault_rifle', 'wm_phase_ready_mod'), slot('Main', 'mw_assault_rifle')])
    const { e, b } = vs(a, { map })
    const [phase, plain] = a.weapons.filter(w => w.dataId === 'mw_assault_rifle')
    expect(b.validTarget(a, plain, e)).toBe('No line of sight')
    expect(b.validTarget(a, phase, e)).toBe(true)
  })
})

describe('Pinaka Missiles', () => {
  it('an attack with two areas costs its heat once', () => {
    const { a, e, b } = vs(armed([slot('Superheavy', 'mw_pinaka_missiles')]), { enemy: { evasion: 1 } })
    const f = foe(b, 10, 10)
    sureHit(a)
    const heat = a.heat, hf = f.hp
    b.weaponAttack(a, weapon(a, 'mw_pinaka_missiles'), { tile: e.pos }, 'free')
    expect(f.hp).toBeLessThan(hf)
    expect(a.heat - heat).toBe(2)
  })
})

describe('Sharanga Missiles', () => {
  it('the player picks the second target', () => {
    const { a, e, b } = vs(armed([slot('Main', 'mw_sharanga_missiles')]), { enemy: { evasion: 1 } })
    foe(b, 9, 8, 'Foe2')
    foe(b, 2, 8, 'Foe3')
    sureHit(a)
    b.chooser = q => (q.kind === 'sharanga_second' ? q.options.findIndex(o => o.label === 'Foe3') : undefined)
    b.transaction(() => { b.weaponAttack(a, weapon(a, 'mw_sharanga_missiles'), { targetId: e.id }, 'free') })
    expect(b.log.some(l => /vs Foe3/.test(l.text))).toBe(true)
    expect(b.log.some(l => /vs Foe2/.test(l.text))).toBe(false)
  })
})

describe('Siege Stabilizers', () => {
  it('extending again doesn’t stack the +5 range', () => {
    const a = armed([slot('Main', 'mw_assault_rifle')], { systems: ['ms_siege_stabilizers'] })
    const { b } = vs(a)
    const w = weapon(a, 'mw_assault_rifle')
    const run = () => custom(b, a, /Stabilizers/).run(b, a)
    run(); expect(b.weaponReach(a, w)).toBe(15)
    run(); expect(b.weaponReach(a, w)).toBe(10)
    run(); expect(b.weaponReach(a, w)).toBe(15)
  })
})

describe('Siege Ram', () => {
  it('10 AP kinetic when you Ram an object', () => {
    const a = armed([slot('Main', 'mw_assault_rifle')], { systems: ['ms_siege_ram'] })
    const { b } = vs(a)
    const wall = deployableUnit(b.units[1], { name: 'Wall', type: 'Deployable', hp: 20, armor: 3, evasion: 5 } as any, { x: 5, y: 5 })
    b.units.push(wall)
    sureHit(a)
    b.ram(a, wall)
    expect(20 - wall.hp).toBe(10)
  })
})

describe('Tachyon Lance', () => {
  it('the Danger Zone backblast happens once per round', () => {
    const { a, e, b } = vs(armed([slot('Superheavy', 'mw_tachyon_lance')]), { enemy: { evasion: 1 } })
    const behind = foe(b, 5, 2, 'Behind')
    a.stats.heatcap = 40; a.heat = 20
    a.stats.save = 40
    sureHit(a)
    const w = weapon(a, 'mw_tachyon_lance')
    b.weaponAttack(a, w, { targetId: e.id }, 'free')
    expect(behind.burn).toBe(4)
    b.weaponAttack(a, w, { targetId: e.id }, 'free')
    expect(behind.burn).toBe(4)
  })
})

describe('Thermal Charge', () => {
  it('+1d6 explosive bonus damage in the same packet (armor once); Limited 3 plus the Limited bonus', () => {
    const a = armed([slot('Main', 'mw_tactical_melee_weapon', 'wm_thermal_charge')], { mechSkills: [2, 2, 2, 6] })
    const { e, b } = vs(a, { e: { x: 5, y: 5 }, enemy: { evasion: 1, armor: 3 } })
    sureHit(a)
    const w = weapon(a, 'mw_tactical_melee_weapon')
    const base = Number(String(w.profiles[0].damage[0].val).replace(/^1d6\+?/, '') || 0)
    rigDice(b, 6, 6, 4) // weapon die, charge die
    const hp = e.hp
    b.weaponAttack(a, w, { targetId: e.id }, 'free')
    expect(hp - e.hp).toBe(6 + base + 4 - 3)
    expect(w.flags?.thermalCharges).toBe(3 + 3 - 1) // ENG 6: Limited bonus 3
  })
})

describe('Thunder God (Raleigh)', () => {
  it('the Mjolnir with no chambered rounds deals no damage', () => {
    const a = mech({ frame: 'mf_raleigh', weapons: [['Main', 'mw_assault_rifle']] })
    const { e, b } = vs(a, { enemy: { evasion: 1 } })
    sureHit(a)
    b.activateCore(a)
    const hp = e.hp
    b.weaponAttack(a, weapon(a, 'mw_raleigh_integrated'), { targetId: e.id }, 'free')
    expect(e.hp).toBe(hp)
  })
})

describe('UNCLE-class COMP/CON', () => {
  it('can’t use a weapon already used this turn', () => {
    const { a, e, b } = vs(armed([slot('Main', 'mw_assault_rifle', 'wm_uncle_class_comp_con')]))
    b.skirmish(a, weapon(a, 'mw_assault_rifle'), { targetId: e.id })
    expect(custom(b, a, /UNCLE/).usable(b, a)).toMatch(/already used this turn/)
  })
})

describe('Veil Rifle', () => {
  it('an ally in the line gets soft cover that moves with it, until the end of its next turn', () => {
    const { a, e, b } = vs(armed([slot('Main', 'mw_veil_rifle')]), { enemy: { evasion: 1 } })
    const ally = mech({ callsign: 'Ally' })
    ally.pos = { x: 5, y: 6 }
    b.units.push(ally)
    sureHit(a)
    b.weaponAttack(a, weapon(a, 'mw_veil_rifle'), { tile: e.pos }, 'free')
    ally.pos = { x: 10, y: 10 }
    expect(b.cover(e, ally)).toBe('soft')
    b.endTurn(a)
    act(b, ally)
    expect(b.cover(e, ally)).toBe('soft')
    b.endTurn(ally)
    expect(b.cover(e, ally)).toBe('none')
  })
})

void arena
