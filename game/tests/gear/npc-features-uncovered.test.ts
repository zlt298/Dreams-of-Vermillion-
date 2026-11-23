// NPC features with no behaviour test.
// The shipped teams in data/enemies/*.json use no official `npcf_` feature ids (those need a pack), only templates and
// Veteran traits; those are tested on the shipped units themselves. The official base-feature scripts are then tested
// on synthetic classes that only reuse the feature *ids* (like tests/official-scripts.test.ts; no pack content).
import { describe, expect, it } from 'vitest'
import type { OfficialClass, OfficialFeature } from '../../src/import/lcp'
import type { Feature, NpcStats } from '../../src/enemies/ruleset'
import { officialUnitDef } from '../../src/enemies/official'
import { buildNpc, buildTeam } from '../../src/enemies/build'
import { Rng } from '../../src/rules/rng'
import type { Battle } from '../../src/rules/battle'
import type { Unit } from '../../src/rules/types'
import { act, arena, flatMap, mech, rigDice, teamFile, type PilotOpts } from '../support'

const w = (u: Unit, id: string) => u.weapons.find(x => x.dataId === id || x.name === id)!
const custom = (b: Battle, u: Unit, re: RegExp) => {
  const x = b.customActions(u).find(c => re.test(c.name) || re.test(c.key))
  if (!x) throw new Error(`no action ${re}: ${b.customActions(u).map(c => c.name).join(', ')}`)
  return x
}
const addUnit = (b: Battle, u: Unit, x: number, y: number) => { u.pos = { x, y }; b.units.push(u); return u }

/** a built unit from a shipped team file */
function shipped(team: string, name: string): Unit {
  const u = buildTeam(teamFile(team)).find(u => u.name.startsWith(name))
  if (!u) throw new Error(`no ${name} in ${team}`)
  return u
}
/** a Veteran with this trait, from a minimal team definition */
function veteran(trait: string): Unit {
  const team = {
    id: 't', name: 't', tier: 1, designedFor: 1,
    units: [{ name: 'Vet', role: 'Striker', templates: ['Veteran'], veteranTrait: trait, features: [{ type: 'weapon', name: 'Gun', weaponType: 'Rifle', range: [{ type: 'Range', val: 8 }], damage: [{ type: 'Kinetic', val: 3 }] }] }],
  }
  return buildTeam(team as any)[0]
}
/** player mech vs this enemy unit, the mech active and with attack bonus 0 */
function versus(e: Unit, o: PilotOpts = {}, eAt = { x: 5, y: 7 }) {
  const a = mech(o)
  const b = arena([[a, { x: 5, y: 4 }], [e, eAt]], { map: flatMap(16, 16) })
  act(b, a)
  a.stats.attackBonus = 0
  return { a, e, b }
}

// ------------------------------------------------------------------------------------------- official features
const stats: NpcStats = { hp: 15, armor: 0, evasion: 8, edef: 8, heatcap: 8, speed: 4, sensors: 10, save: 11, size: 1, hull: 1, agi: 1, sys: 1, eng: 1, structure: 1, stress: 1, activations: 1, attackBonus: 1, techAttack: 1 }
const gun: Feature = { type: 'weapon', name: 'Test Cannon', weaponType: 'Cannon', range: [{ type: 'Range', val: 10 }] as any, damage: [{ type: 'Kinetic', val: 4 }] as any }
const axe: Feature = { type: 'weapon', name: 'Chain Axe', weaponType: 'Melee', range: [{ type: 'Threat', val: 1 }] as any, damage: [{ type: 'Kinetic', val: 5 }] as any }
const feat = (id: string, f: Feature): OfficialFeature => ({ id, name: id, base: true, byTier: [f, f, f], partial: false })
function official(ids: string[], name = 'Testbed'): Unit {
  const cls: OfficialClass = {
    id: 'npcc_test', name, role: 'Striker', stats: [stats, stats, stats],
    features: [feat('w1', gun), feat('w2', axe), ...ids.map(id => feat(id, { type: 'trait', name: id, text: '' }))],
  }
  return buildNpc(officialUnitDef(cls, 1, [], new Rng(1), 0), 1)
}

describe('templates and Veteran traits used by the shipped teams', () => {
  it('Mercenary (Gallowglass Lance): Opportunist – "+1 accuracy when the target is engaged by an ally"', () => {
    const lance = shipped('t2-gallowglass-company', 'Gallowglass Lance')
    expect(lance.templates).toContain('Mercenary')
    const { a, b } = versus(lance)
    const rifle = w(lance, 'mw_assault_rifle')
    expect(b.buildWeaponCtx(lance, rifle, a, 'free', false).accuracy).toBe(0)
    const ally = addUnit(b, shipped('t2-gallowglass-company', 'Gallowglass Recruit'), 5, 3)
    expect(b.adjacent(ally, a)).toBe(true)
    expect(b.buildWeaponCtx(lance, rifle, a, 'free', false).accuracy).toBe(1)
  })
  it('shock_armor (Kiln Bulwark): "resistance to damage from Main weapons"', () => {
    const bulwark = shipped('t2-ash-choir', 'Kiln Bulwark')
    expect(bulwark.traits).toContain('shock_armor')
    const { a, b } = versus(bulwark, { weapons: [['Main', 'mw_assault_rifle'], ['Heavy', 'mw_heavy_machine_gun']] })
    expect(b.buildWeaponCtx(a, w(a, 'mw_assault_rifle'), bulwark, 'free', false).resistAll).toBe(true)
    expect(b.buildWeaponCtx(a, w(a, 'mw_heavy_machine_gun'), bulwark, 'free', false).resistAll).toBeFalsy()
  })
  it('hardened_target (Witch-Cantor): tech attacks against it get +1 difficulty; +1 accuracy on its Systems saves', () => {
    // the shipped Witch-Cantor as a Veteran with Hardened Target (the roster trim made her a standard unit)
    const def = teamFile('t3-burning-eye-cantors').units.find((u: any) => u.name === 'Witch-Cantor')
    const cantor = buildTeam({ ...teamFile('t3-burning-eye-cantors'), units: [{ ...def, templates: ['Veteran'], veteranTrait: 'hardened_target' }] })[0]
    expect(cantor.traits).toContain('hardened_target')
    const { a, b } = versus(cantor)
    expect(b.techAttackRoll(a, cantor, 'probe').difficulty).toBe(1)
    rigDice(b, 20, 10)
    rigDice(b, 6, 6) // the accuracy die on the save
    expect(b.save(cantor, 'sys', 10 + cantor.stats.sys + 6)).toBe(true)
  })
  it('insulated: "immune to Burn"', () => {
    const { e, b } = versus(veteran('insulated'))
    b.applyDamage(e, [{ type: 'Burn', amount: 3 }], {})
    expect(e.burn).toBe(0)
  })
  it('lightning_reflexes: Heavy/Superheavy attacks against it miss on a d6 roll of 5+', () => {
    const { a, e, b } = versus(veteran('lightning_reflexes'), { weapons: [['Heavy', 'mw_heavy_melee_weapon']] }, { x: 5, y: 5 })
    rigDice(b, 20, 15)
    rigDice(b, 6, 5)
    const r = b.weaponAttack(a, w(a, 'mw_heavy_melee_weapon'), { targetId: e.id }, 'free')
    expect(r.ctxs[0].hit).toBe(false)
    expect(e.hp).toBe(e.stats.hp)
  })
  it('steel_jaw: "Auxiliary weapons deal at most 1 damage to it"', () => {
    const { a, e, b } = versus(veteran('steel_jaw'), { weapons: [['Auxiliary', 'mw_pistol']] })
    rigDice(b, 20, 15)
    rigDice(b, 3, 3)
    b.weaponAttack(a, w(a, 'mw_pistol'), { targetId: e.id }, 'free')
    expect(e.hp).toBe(e.stats.hp - 1)
  })
})

describe('official NPC features', () => {
  it('npcf_regenerative_shielding_aegis: immune to Impaired and Slowed; can\'t be critically hit', () => {
    const { a, e, b } = versus(official(['npcf_regenerative_shielding_aegis']))
    expect(b.addStatus(e, 'slowed', 'until_cleared', a)).toBe(false)
    rigDice(b, 20, 20)
    a.stats.attackBonus = 10
    const r = b.weaponAttack(a, w(a, 'mw_assault_rifle'), { targetId: e.id }, 'free')
    expect(r.ctxs[0].hit).toBe(true)
    expect(r.ctxs[0].crit).toBe(false)
  })
  it('npcf_superior_sentinel_archer: +1 accuracy on reaction attacks', () => {
    const { a, e, b } = versus(official(['npcf_superior_sentinel_archer']))
    const cannon = w(e, 'Test Cannon')
    expect(b.buildWeaponCtx(e, cannon, a, 'overwatch', false).accuracy).toBe(1)
  })
  it('npcf_shock_plating_barricade: resistance to kinetic; npcf_ablative_shielding_scourer: resistance to energy', () => {
    const { e, b } = versus(official(['npcf_shock_plating_barricade', 'npcf_ablative_shielding_scourer']))
    b.applyDamage(e, [{ type: 'Kinetic', amount: 6 }], {})
    expect(e.hp).toBe(15 - 3)
    b.applyDamage(e, [{ type: 'Energy', amount: 4 }], {})
    expect(e.hp).toBe(15 - 3 - 2)
  })
  it('npcf_shock_armor_demolisher: resistance to melee weapon damage', () => {
    const { a, e, b } = versus(official(['npcf_shock_armor_demolisher']), { weapons: [['Main', 'mw_tactical_melee_weapon'], ['Main', 'mw_assault_rifle']] }, { x: 5, y: 5 })
    rigDice(b, 20, 15)
    rigDice(b, 6, 4) // 1d6+2 = 6, halved
    b.weaponAttack(a, w(a, 'mw_tactical_melee_weapon'), { targetId: e.id }, 'free')
    expect(e.hp).toBe(15 - 3)
  })
  it('npcf_heavy_frame_demolisher: "can\'t be moved or knocked Prone by smaller characters"', () => {
    const { a, e, b } = versus(official(['npcf_heavy_frame_demolisher']), {}, { x: 5, y: 6 })
    e.stats.size = 2
    b.forceMove(e, a, 2, 1)
    expect(e.pos).toEqual({ x: 5, y: 6 })
    expect(b.addStatus(e, 'prone', 'until_cleared', a)).toBe(false)
  })
  it('npcf_guardian_goliath / npcf_guardian_sentinel: "adjacent allies use it as hard cover"', () => {
    for (const id of ['npcf_guardian_goliath', 'npcf_guardian_sentinel']) {
      const g = official([id], 'Guardian')
      const { a, b } = versus(g, {}, { x: 5, y: 8 })
      const ally = addUnit(b, official([], 'Ward'), 5, 9)
      expect(b.cover(a, ally)).toBe('hard')
    }
  })
  it('npcf_siege_armor_bombard: "resistance to attacks from beyond range 3"', () => {
    const { a, e, b } = versus(official(['npcf_siege_armor_bombard']), {}, { x: 5, y: 9 })
    const rifle = w(a, 'mw_assault_rifle')
    expect(b.buildWeaponCtx(a, rifle, e, 'free', false).resistAll).toBe(true)
    e.pos = { x: 5, y: 7 }
    expect(b.buildWeaponCtx(a, rifle, e, 'free', false).resistAll).toBeFalsy()
  })
  it('npcf_insulated_pyro: immune to Burn', () => {
    const { e, b } = versus(official(['npcf_insulated_pyro']))
    b.applyDamage(e, [{ type: 'Burn', amount: 2 }], {})
    expect(e.burn).toBe(0)
  })
  it('npcf_hardened_target_priest: tech attacks against it +1 difficulty', () => {
    const { a, e, b } = versus(official(['npcf_hardened_target_priest']))
    expect(b.techAttackRoll(a, e, 'probe').difficulty).toBe(1)
  })
  it('npcf_huntsman_rainmaker: ignores cover and armor against Locked On targets', () => {
    const { a, e, b } = versus(official(['npcf_huntsman_rainmaker']))
    const cannon = w(e, 'Test Cannon')
    expect(b.buildWeaponCtx(e, cannon, a, 'free', false).irreducible).toBeFalsy()
    b.addStatus(a, 'lockon', 'until_cleared', e)
    const ctx = b.buildWeaponCtx(e, cannon, a, 'free', false)
    expect([ctx.ignoreCover, ctx.irreducible]).toEqual([true, true])
  })
  it('npcf_blur_witch: Invisible during its own turn', () => {
    const { a, e, b } = versus(official(['npcf_blur_witch']))
    expect(b.has(e, 'invisible')).toBe(false)
    b.endTurn(a)
    act(b, e)
    expect(b.has(e, 'invisible')).toBe(true)
    b.endTurn(e)
    expect(b.has(e, 'invisible')).toBe(false)
  })
  it('npcf_dataveil_mirage / npcf_tactical_cloak_specter: permanently Invisible', () => {
    for (const id of ['npcf_dataveil_mirage', 'npcf_tactical_cloak_specter']) {
      const { e, b } = versus(official([id]))
      expect(b.has(e, 'invisible')).toBe(true)
    }
  })
  it('npcf_nano_repair_cloud_support: adjacent allies get +1 accuracy on saves and checks', () => {
    const { e, b } = versus(official(['npcf_nano_repair_cloud_support']))
    const ally = addUnit(b, official([], 'Ward'), 6, 7)
    rigDice(b, 20, 10)
    rigDice(b, 6, 6)
    expect(b.save(ally, 'hull', 10 + ally.stats.hull + 6)).toBe(true)
    void e
  })
  it('npcf_cooling_module_scourer: "clears all heat at turn start if it hasn\'t moved since its last turn"', () => {
    const { a, e, b } = versus(official(['npcf_cooling_module_scourer']))
    e.heat = 5
    b.endTurn(a)
    act(b, e)
    expect(e.heat).toBe(0)
  })
  it('npcf_hunt_specter: "+5 melee damage against targets with no other characters adjacent"', () => {
    const { a, e, b } = versus(official(['npcf_hunt_specter']), {}, { x: 5, y: 5 })
    const ctx = b.buildWeaponCtx(e, w(e, 'Chain Axe'), a, 'free', false)
    expect(ctx.bonusDamage).toContainEqual({ type: 'Kinetic', val: 5 })
    addUnit(b, official([], 'Pal'), 4, 3)
    expect(b.buildWeaponCtx(e, w(e, 'Chain Axe'), a, 'free', false).bonusDamage).toEqual([])
  })
  it('npcf_kai_bioplating_assassin / npcf_bulwark_mods_barricade: ignore difficult terrain', () => {
    for (const id of ['npcf_kai_bioplating_assassin', 'npcf_bulwark_mods_barricade']) {
      const { e, b } = versus(official([id]))
      b.addArea({ kind: 'difficult', tiles: [{ x: 5, y: 8 }], ownerId: e.id })
      expect(b.stepCost(e, { x: 5, y: 7 }, { x: 5, y: 8 })).toBe(1)
    }
    const { e, b } = versus(official([]))
    b.addArea({ kind: 'difficult', tiles: [{ x: 5, y: 8 }], ownerId: e.id })
    expect(b.stepCost(e, { x: 5, y: 7 }, { x: 5, y: 8 })).toBe(2)
  })
  it('npcf_aggression_berserker: "the first time it takes damage each round, it attacks a random adjacent character"', () => {
    const { a, e, b } = versus(official(['npcf_aggression_berserker']), {}, { x: 5, y: 5 })
    rigDice(b, 20, 20)
    b.applyDamage(e, [{ type: 'Kinetic', amount: 2 }], { source: a })
    expect(a.hp).toBeLessThan(a.stats.hp)
    const hp = a.hp
    b.applyDamage(e, [{ type: 'Kinetic', amount: 2 }], { source: a })
    expect(a.hp).toBe(hp) // once per round
  })
  it('npcf_point_defense_shield_cataphract: "Resistance to all damage from the single closest hostile"', () => {
    const { a, e, b } = versus(official(['npcf_point_defense_shield_cataphract']))
    const far = addUnit(b, mech({ callsign: 'Far' }), 5, 12)
    expect(b.buildWeaponCtx(a, w(a, 'mw_assault_rifle'), e, 'free', false).resistAll).toBe(true)
    expect(b.buildWeaponCtx(far, w(far, 'mw_assault_rifle'), e, 'free', false).resistAll).toBeFalsy()
  })
  it('npcf_dig_in_demolisher: a reaction on being hit gives resistance to the attack, then it is Slowed', () => {
    const { a, e, b } = versus(official(['npcf_dig_in_demolisher']))
    rigDice(b, 20, 15)
    rigDice(b, 6, 6)
    const r = b.weaponAttack(a, w(a, 'mw_assault_rifle'), { targetId: e.id }, 'free')
    expect(r.ctxs[0].resistAll).toBe(true)
    expect(e.hp).toBe(15 - 3)
    expect(b.has(e, 'slowed')).toBe(true)
  })
  it('npcf_ssc_flight_system_ace / npcf_ssc_total_suite_hornet: fly', () => {
    for (const id of ['npcf_ssc_flight_system_ace', 'npcf_ssc_total_suite_hornet']) expect(official([id]).flying).toBe(true)
    expect(official([]).flying).toBeFalsy()
  })
  it('npcf_trace_drive_operator / npcf_reality_flicker_mirage: teleport when moving (straight past engagement and obstacles)', () => {
    for (const id of ['npcf_trace_drive_operator', 'npcf_reality_flicker_mirage']) {
      const { a, e, b } = versus(official([id]), {}, { x: 5, y: 5 }) // engaged with the mech
      b.endTurn(a)
      act(b, e)
      b.move(e, { x: 5, y: 3 }) // the mech stands in the way
      expect(e.pos).toEqual({ x: 5, y: 3 })
    }
  })
  it('npcf_climber_sniper: "Climbs any surface without penalty"', () => {
    const map = flatMap(16, 16, (x, y) => (x === 5 && y === 8 ? { h: 3 } : undefined))
    const { e, b } = versus(official(['npcf_climber_sniper']))
    const plain = addUnit(b, official([], 'Plain'), 9, 7)
    b.map = map
    b.invalidateTerrain()
    expect(b.stepCost(e, { x: 5, y: 7 }, { x: 5, y: 8 })).toBeLessThan(b.stepCost(plain, { x: 5, y: 7 }, { x: 5, y: 8 }))
  })
  it('npcf_barrel_roll_ace: "when hit, the attack misses and the Ace flies away 6"', () => {
    const { a, e, b } = versus(official(['npcf_barrel_roll_ace']), {}, { x: 5, y: 6 })
    rigDice(b, 20, 15)
    const r = b.weaponAttack(a, w(a, 'mw_assault_rifle'), { targetId: e.id }, 'free')
    expect(r.ctxs[0].hit).toBe(false)
    expect(e.pos).toEqual({ x: 5, y: 12 })
  })
  it('npcf_cloaking_field_scout: "it and allies within Burst 3 are Invisible …; it is Immobilized"', () => {
    const { a, e, b } = versus(official(['npcf_cloaking_field_scout']), {}, { x: 5, y: 9 })
    const ally = addUnit(b, official([], 'Ward'), 7, 9)
    b.endTurn(a)
    act(b, e)
    b.useCustom(e, custom(b, e, /Cloaking Field/))
    expect([b.has(e, 'invisible'), b.has(ally, 'invisible'), b.has(e, 'immobilized'), b.has(a, 'invisible')]).toEqual([true, true, true, false])
  })
  it('npcf_self_erasure_operator: on destruction, adjacent characters take energy damage; no wreck remains', () => {
    const { a, e, b } = versus(official(['npcf_self_erasure_operator']), {}, { x: 5, y: 5 })
    rigDice(b, 20, 1) // the mech's Agility save
    b.destroy(e, 'test')
    expect(a.hp).toBe(a.stats.hp - 4) // tier 1: 4 energy
    expect(e.flags.wreck).toBe(false)
  })
  it('npcf_dispersal_shield_priest: "an ally resists the next 1d3 attacks that hit it"', () => {
    const { a, e, b } = versus(official(['npcf_dispersal_shield_priest']))
    const ward = addUnit(b, official([], 'Ward'), 7, 7)
    b.endTurn(a)
    act(b, e)
    rigDice(b, 3, 1)
    b.useCustom(e, custom(b, e, /Dispersal Shield/), ward)
    expect(ward.flags.dispersal).toBe(1)
    expect(b.buildWeaponCtx(a, w(a, 'mw_assault_rifle'), ward, 'free', false).resistAll).toBe(true)
  })
  it('npcf_investiture_priest: "a linked ally within 5 gains accuracy on attacks"', () => {
    const { a, e, b } = versus(official(['npcf_investiture_priest']))
    const ward = addUnit(b, official([], 'Ward'), 7, 7)
    b.endTurn(a)
    act(b, e)
    const cannon = w(ward, 'Test Cannon')
    expect(b.buildWeaponCtx(ward, cannon, a, 'free', false).accuracy).toBe(0)
    b.useCustom(e, custom(b, e, /Investiture/), ward)
    expect(b.buildWeaponCtx(ward, cannon, a, 'free', false).accuracy).toBe(1)
  })
  it('npcf_sealant_gun_support: hostiles "Agility save or Slowed"; the Burst 1 becomes difficult terrain', () => {
    const { a, e, b } = versus(official(['npcf_sealant_gun_support']))
    b.endTurn(a)
    act(b, e)
    rigDice(b, 20, 1)
    b.useCustom(e, custom(b, e, /Sealant Gun/), a)
    expect(b.has(a, 'slowed')).toBe(true)
    expect(b.stepCost(e, { x: 6, y: 6 }, { x: 6, y: 5 })).toBe(2)
  })
  it('npcf_eye_of_midnight_sentinel: "Slowed, but can Overwatch once every turn"', () => {
    const { a, e, b } = versus(official(['npcf_eye_of_midnight_sentinel']))
    b.endTurn(a)
    act(b, e)
    b.useCustom(e, custom(b, e, /Eye of Midnight/))
    expect(b.has(e, 'slowed')).toBe(true)
    expect(e.traits).toContain('reflex')
  })
  it('npcf_step_operator: "teleport to a free space in line of sight"', () => {
    const { a, e, b } = versus(official(['npcf_step_operator']))
    b.endTurn(a)
    act(b, e)
    b.useCustom(e, custom(b, e, /Step/), { x: 12, y: 12 })
    expect(e.pos).toEqual({ x: 12, y: 12 })
  })
})
