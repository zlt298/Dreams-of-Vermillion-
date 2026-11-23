// Weapons and weapon mods, one describe per item (alphabetical). Scripts in rules/effects/scripts/weapons*.ts.
import { describe, expect, it } from 'vitest'
import { autoBattle, aiErrors } from '../../src/ai/ai'
import { weaponCoverage, modCoverage } from '../../src/rules/effects/coverage'
import { getScript } from '../../src/rules/effects/registry'
import type { Battle } from '../../src/rules/battle'
import type { MountBuild } from '../../src/import/compcon'
import type { Unit } from '../../src/rules/types'
import { battle, flatMap, mech, pregenUnit, rigDice } from '../support'
import { custom, slot, vs, weapon } from './helpers'

/** A level-6 Everest with these mounts. */
const armed = (mounts: MountBuild[], o: { coreBonuses?: string[] } = {}) => mech({ level: 6, weapons: mounts, ...o })
/** `a` vs an Assault with Evasion 1 (and E-Defense 1 for the former partials) at the usual spots, seed 13. */
const setup = (a: Unit, map = flatMap(16, 16)) => vs(a, { map, enemy: { evasion: 1 } })
const setup2a = (a: Unit, map = flatMap(16, 16)) => vs(a, { map, enemy: { evasion: 1, edef: 1 } })
const nextRound = (b: Battle, a: Unit, e: Unit) => { if (b.activeId) b.endTurn(b.active!); if (!e.destroyed && e.activationsLeft > 0) { b.beginTurn(e); b.endTurn(e) } }

describe('coverage', () => {
  it('every former manual weapon and mod is now scripted', () => {
    for (const id of ['mw_autopod', 'mw_vorpal_gun', 'mw_mimic_gun', 'mw_siege_cannon', 'mw_prototype_1', 'mw_prototype_2', 'mw_prototype_3', 'mw_barbarossa_integrated']) expect(weaponCoverage(id), id).toBe('scripted')
    for (const id of ['wm_uncle_class_comp_con', 'wm_throughbolt_rounds']) expect(modCoverage(id), id).toBe('scripted')
  })
  it('former partial frame, weapon, mod and core bonus scripts are complete', () => {
    for (const id of ['frame:mf_goblin', 'core:mf_goblin', 'frame:mf_napoleon', 'core:mf_drake', 'core:mf_mourning_cloak', 'mw_combat_drill', 'mw_pinaka_missiles', 'mw_ghast_nexus', 'mw_annihilation_nexus', 'mw_plasma_thrower', 'wm_shock_wreath', 'cb_overpower_caliber', 'cb_briareos_frame', 'cb_ghostweave', 'cb_the_lesson_of_the_open_door'])
      expect(getScript(id)?.partial, id).toBeFalsy()
  })
})

describe('Annihilation Nexus', () => {
  it('the burst can be centred on one of your drones', () => {
    const { a, e, b } = setup2a(armed([slot('Main', 'mw_annihilation_nexus'), slot('Main', 'mw_ghast_nexus')]))
    b.useCustom(a, custom(b, a, /Deploy Ghast/), { x: 5, y: 7 })
    b.chooser = () => undefined
    const hp = e.hp
    a.stats.attackBonus = 30
    b.transaction(() => { b.weaponAttack(a, weapon(a, 'mw_annihilation_nexus'), { tile: a.pos }, 'free') }, [1])
    expect(e.hp).toBeLessThan(hp)
  })
})

describe('Autopod', () => {
  it('hits automatically when an ally consumes Lock On on a target within 15', () => {
    const { a, e, b } = setup(armed([slot('Main', 'mw_autopod')]))
    const ally = armed([slot('Main', 'mw_assault_rifle')])
    ally.pos = { x: 8, y: 4 }
    b.units.push(ally)
    expect(b.weaponUsable(a, weapon(a, 'mw_autopod'))).not.toBe(true) // no normal attacks
    b.addStatus(e, 'lockon', 'until_cleared', ally)
    b.weaponAttack(ally, weapon(ally, 'mw_assault_rifle'), { targetId: e.id }, 'free')
    expect(b.log.filter(l => /Autonomous Assault/.test(l.text)).map(l => l.text)).toEqual(["Tester's Autopod fires on Assault (Autonomous Assault)."])
    expect(b.log.some(l => /automatic HIT/.test(l.text))).toBe(true)
    expect(a.reactionsLeft).toBe(0)
  })
})

describe('Combat Drill', () => {
  it('Overkill chains add bonus damage against Prone targets', () => {
    const { a, e, b } = setup2a(armed([slot('Main', 'mw_combat_drill')]))
    e.pos = { x: 5, y: 5 }
    b.addStatus(e, 'prone')
    a.stats.attackBonus = 30
    e.hp = 999; e.stats.hp = 999
    rigDice(b, 6, 3, 1) // the Prone accuracy die, then a 1 on the first damage die: Overkill
    b.weaponAttack(a, weapon(a, 'mw_combat_drill'), { targetId: e.id }, 'free')
    expect(b.log.some(l => /Overkill drill/.test(l.text))).toBe(true)
  })
})

describe('Fold Knife', () => {
  // regression: any Fold Knife attack granted the teleport, not only a crit
  it('the 2-space teleport is an on-crit effect, not granted by any attack', () => {
    const { a, e, b } = vs(mech({ callsign: 'T', weapons: [['Auxiliary', 'mw_fold_knife']] }))
    e.pos = { x: 5, y: 5 }
    e.stats.evasion = 40 // guaranteed miss
    b.skirmish(a, a.weapons[0], { targetId: e.id })
    expect(b.customActions(a).some(c => /Fold Knife Teleport/.test(c.name))).toBe(false)
  })
})

describe('Ghast Nexus', () => {
  it('deploy as a drone; attacks trace range and line of sight from it; losing the drone loses the weapon', () => {
    const map = flatMap(16, 16, (x, y) => (y === 6 && x >= 3 && x <= 7 ? { h: 4, kind: 'block' } : undefined))
    const { a, e, b } = setup2a(armed([slot('Main', 'mw_ghast_nexus')]), map)
    const w = weapon(a, 'mw_ghast_nexus')
    expect(b.validTarget(a, w, e)).toMatch(/line of sight/i)
    b.useCustom(a, custom(b, a, /Deploy Ghast/), { x: 9, y: 6 })
    const d = b.alive().find(u => u.name === 'Ghast Drone')!
    expect(d?.ownerId).toBe(a.id)
    expect(d.pos).toEqual({ x: 9, y: 6 })
    const r = b.weaponAttack(a, w, { targetId: e.id }, 'free')
    expect(r.ok).toBe(true)
    b.applyDamage(d, [{ type: 'Kinetic', amount: 50 }], { source: e })
    expect(w.destroyed).toBe(true)
  })
})

describe('Mimic Gun', () => {
  it('3d20 ranges cycle each turn after the first; damage is 1 + half; Provoke rerolls', () => {
    const { a, e, b } = setup(armed([slot('Heavy', 'mw_mimic_gun')]))
    const w = weapon(a, 'mw_mimic_gun')
    const [x, y] = w.flags!.mimic
    expect(b.profile(w).range[0].val).toBe(x)
    expect(b.profile(w).damage[0].val).toBe(1 + Math.floor(x / 2))
    b.endTurn(a); b.beginTurn(e); b.endTurn(e); b.round++
    b.beginTurn(a)
    expect(b.profile(w).range[0].val).toBe(y)
    custom(b, a, /Provoke/).run(b, a)
    expect(w.flags!.mimic).toHaveLength(3)
    expect(b.profile(w).range[0].val).toBe(w.flags!.mimic[0])
  })
  it('counts as every ranged weapon type for talents', () => {
    const a = armed([slot('Heavy', 'mw_mimic_gun')])
    const w = weapon(a, 'mw_mimic_gun')
    expect(w.flags!.allRangedTypes).toBe(true)
    expect(w.bonuses).toHaveLength(0)
  })
})

describe('Pinaka Missiles', () => {
  it('a second, non-overlapping blast; Delayed Strike lands at the end of the next round for 3d6', () => {
    const { a, e, b } = setup2a(armed([slot('Main', 'mw_pinaka_missiles')]))
    const e2 = pregenUnit('Sniper', 'enemy'); e2.pos = { x: 10, y: 10 }; e2.stats.evasion = 1; b.units.push(e2)
    a.stats.attackBonus = 30
    const hp2 = e2.hp
    b.weaponAttack(a, weapon(a, 'mw_pinaka_missiles'), { tile: e.pos }, 'free')
    expect(e2.hp).toBeLessThan(hp2)
    // delayed
    nextRound(b, a, e)
    while (b.round < 2) { const u = b.combatants(b.currentSide).find(x => x.activationsLeft > 0); if (!u) break; b.beginTurn(u); b.endTurn(u) }
    if (b.currentSide !== 'player') { const u = b.combatants('enemy').find(x => x.activationsLeft > 0)!; b.beginTurn(u); b.endTurn(u) }
    b.beginTurn(a)
    b.useCustom(a, custom(b, a, /Delayed Strike/), e.pos)
    expect(b.has(a, 'slowed')).toBe(true)
    expect(a.flags.pinakaDelayed.lands).toBe(b.round + 2)
    expect(b.fieldOverlays().some(f => /Pinaka strike/.test(f.label))).toBe(true)
  })
})

describe('Plasma Thrower', () => {
  it('Cone or Line toggle; 3 burning spaces that hurt on entry once per round', () => {
    const { a, b } = setup2a(armed([slot('Heavy', 'mw_plasma_thrower')]))
    const w = weapon(a, 'mw_plasma_thrower')
    const cone = b.aoeTiles(a, w, { x: 5, y: 9 }) as any[]
    ;(w.flags ??= {}).shape = 'line'
    const line = b.aoeTiles(a, w, { x: 5, y: 9 }) as any[]
    expect(line.length).not.toBe(cone.length)
    a.stats.attackBonus = 30
    b.weaponAttack(a, w, { tile: { x: 5, y: 9 } }, 'free')
    const fire = b.areas.find(x => x.tag === 'plasma')!
    expect(fire.tiles).toHaveLength(3)
  })
})

describe('Prototype weapons', () => {
  it('uses rolled at battle start; configure type and damage before the first attack', () => {
    const { a, e, b } = setup(armed([slot('Main', 'mw_prototype_1')]))
    const w = weapon(a, 'mw_prototype_1')
    expect(w.usesLeft).toBeGreaterThanOrEqual(3)
    expect(w.usesLeft).toBeLessThanOrEqual(8 + a.stats.limitedBonus)
    b.chooser = () => undefined
    const cfg = custom(b, a, /Configure/)
    b.transaction(() => cfg.run(b, a), [0, 2]) // Melee, Explosive
    expect(w.type).toBe('Melee')
    expect(b.profile(w).damage[0].type).toBe('Explosive')
    expect(b.profile(w).range).toEqual([{ type: 'Threat', val: 1 }])
    e.pos = { x: 5, y: 5 }
    b.weaponAttack(a, w, { targetId: e.id }, 'free')
    expect(b.customActions(a).some(c => /Configure/.test(c.name))).toBe(false)
  })
})

describe('Shock Wreath', () => {
  it('spend a quick action on a hit for 1d6 burn; an already-burning target is blinded', () => {
    const { a, e, b } = setup2a(armed([slot('Main', 'mw_assault_rifle', 'wm_shock_wreath')]))
    a.stats.attackBonus = 30
    e.burn = 2
    b.skirmish(a, weapon(a, 'mw_assault_rifle'), { targetId: e.id })
    expect(a.actionsLeft).toBe(0)
    expect(e.flags.blindUntil).toBe(b.round + 1)
  })
})

describe('Siege Cannon', () => {
  it('the two firing modes are profiles chosen before firing', () => {
    const { a, b } = setup(armed([slot('Superheavy', 'mw_siege_cannon')]))
    const w = weapon(a, 'mw_siege_cannon')
    expect(w.profiles.map(p => p.name)).toEqual(['Siege Mode', 'Direct Fire Mode'])
    w.profileIndex = 1
    expect(b.isAoE(b.profile(w))).toBe(false)
  })
})

describe('Throughbolt Rounds', () => {
  it('a Line 3 path through terrain hits everything on it; the attack is measured from its end', () => {
    const map = flatMap(16, 16, (x, y) => (x === 5 && y === 6 ? { h: 3, kind: 'block' } : undefined))
    const { a, e, b } = setup(armed([slot('Main', 'mw_assault_rifle', 'wm_throughbolt_rounds')]), map)
    const bystander = pregenUnit('Sniper', 'enemy')
    bystander.pos = { x: 5, y: 5 }
    b.units.push(bystander)
    const w = weapon(a, 'mw_assault_rifle')
    expect(b.los(a, e)).toBe(false) // the wall blocks line of sight from the attacker
    ;(w.flags ??= {}).throughbolt = true
    const hp = bystander.hp
    const r = b.weaponAttack(a, w, { targetId: e.id }, 'free')
    expect(r.ok).toBe(true)
    expect(bystander.hp).toBe(hp - 2) // 2 AP kinetic
    expect(b.map.tiles[6 * 16 + 5].h).toBe(3) // 2 damage does not break a 10 HP level
  })
})

describe('UNCLE-class COMP/CON', () => {
  it('free attack at +2 difficulty, then the weapon is locked until next turn', () => {
    const { a, e, b } = setup(armed([slot('Main', 'mw_assault_rifle', 'wm_uncle_class_comp_con')]))
    const w = weapon(a, 'mw_assault_rifle')
    const u = custom(b, a, /UNCLE/)
    expect(u.activation).toBe('free')
    b.useCustom(a, u, e)
    expect(b.log.filter(l => l.text === 'Tester attacks with Assault Rifle.')).toHaveLength(1)
    expect(b.weaponUsable(a, w)).toMatch(/UNCLE/)
    expect(custom(b, a, /UNCLE/).usable(b, a)).not.toBe(true)
    b.endTurn(a); b.beginTurn(e); b.endTurn(e); b.round++; b.beginTurn(a)
    expect(b.weaponUsable(a, w)).toBe(true)
  })
})

describe('Vorpal Gun', () => {
  it('Snicker-Snack attacks a hostile that damages an ally in range', () => {
    const { a, e, b } = setup(armed([slot('Main', 'mw_vorpal_gun')]))
    const ally = armed([slot('Main', 'mw_assault_rifle')])
    ally.pos = { x: 6, y: 8 }
    b.units.push(ally)
    expect(b.weaponUsable(a, weapon(a, 'mw_vorpal_gun'))).not.toBe(true)
    b.applyDamage(ally, [{ type: 'Kinetic', amount: 3 }], { source: e })
    expect(b.log.some(l => /attacks with Vorpal Gun/.test(l.text))).toBe(true)
    expect(a.reactionsLeft).toBe(0)
    // 1/round
    b.applyDamage(ally, [{ type: 'Kinetic', amount: 3 }], { source: e })
    expect(b.log.filter(l => /attacks with Vorpal Gun/.test(l.text))).toHaveLength(1)
  })
})

describe('AI with these weapons', () => {
  it('AI battles with the former manual weapons run cleanly', () => {
    const a = armed([slot('Main', 'mw_prototype_1'), slot('Main', 'mw_assault_rifle', 'wm_uncle_class_comp_con'), slot('Heavy', 'mw_mimic_gun')])
    const c = armed([slot('Main', 'mw_vorpal_gun'), slot('Main', 'mw_autopod')])
    const e1 = pregenUnit('Assault', 'enemy'), e2 = pregenUnit('Sniper', 'enemy')
    a.pos = { x: 3, y: 2 }; c.pos = { x: 6, y: 2 }; e1.pos = { x: 3, y: 12 }; e2.pos = { x: 7, y: 12 }
    const b = battle([a, c, e1, e2], flatMap(14, 16), 4)
    autoBattle(b, 6)
    expect(aiErrors).toHaveLength(0)
  })
  it('AI battles with the former partial frames, weapons, mods and core bonuses run cleanly', () => {
    const a = mech({ level: 6, frame: 'mf_drake', weapons: [slot('Main', 'mw_pinaka_missiles'), slot('Heavy', 'mw_plasma_thrower')], coreBonuses: ['cb_briareos_frame', 'cb_overpower_caliber'] })
    const c = mech({ level: 6, frame: 'mf_goblin', weapons: [slot('Main', 'mw_ghast_nexus'), slot('Main', 'mw_annihilation_nexus', 'wm_shock_wreath')], coreBonuses: ['cb_ghostweave', 'cb_the_lesson_of_the_open_door'] })
    const m = mech({ level: 6, frame: 'mf_mourning_cloak', weapons: [slot('Main', 'mw_combat_drill')] })
    const e1 = pregenUnit('Assault', 'enemy'), e2 = pregenUnit('Sniper', 'enemy'), e3 = pregenUnit('Hacker', 'enemy')
    a.pos = { x: 3, y: 2 }; c.pos = { x: 7, y: 2 }; m.pos = { x: 10, y: 2 }; e1.pos = { x: 3, y: 12 }; e2.pos = { x: 7, y: 13 }; e3.pos = { x: 10, y: 12 }
    for (const u of [a, c, m]) u.coreAvailable = true
    const b = battle([a, c, m, e1, e2, e3], flatMap(14, 16), 9)
    autoBattle(b, 8)
    expect(aiErrors).toHaveLength(0)
  })
})
