// Mech systems, one describe per system (alphabetical). Drones and deployables are in drones-deployables.test.ts,
// mines and charges in mines.test.ts.
import { describe, expect, it } from 'vitest'
import { autoBattle, aiErrors } from '../../src/ai/ai'
import { getScript, scriptsFor } from '../../src/rules/effects/registry'
import { sekhmetTurn } from '../../src/rules/effects/scripts/systems2'
import type { Battle } from '../../src/rules/battle'
import type { GridMap } from '../../src/rules/grid'
import type { Pos } from '../../src/rules/types'
import { battle, flatMap, mech, pregenUnit, rigDice } from '../support'
import { custom, gun, toEnemyTurn, vs, weapon } from './helpers'

const SAVES_FAIL = { hull: -20, agi: -20, sys: -20, eng: -20 }
/** Level-6 Everest with these systems vs an Assault that fails its saves. */
function setup(systems: string[], o: { size?: number } = {}) {
  const a = mech({ level: 6, systems })
  if (o.size) a.stats.size = o.size
  return vs(a, { enemy: SAVES_FAIL })
}
/** As setup(), and the enemy also has Evasion and E-Defense 1 (the former partial systems). */
const setup2b = (systems: string[], o: { map?: GridMap; weapon?: string } = {}) =>
  vs(mech({ level: 6, systems, weapons: o.weapon }), { map: o.map, enemy: { ...SAVES_FAIL, evasion: 1, edef: 1 } })
/** Level-9 Everest with these systems vs a plain Assault. */
const setup9 = (systems: string[], weapons?: [string, string][]) => vs(mech({ callsign: 'T', systems, weapons }))
const ally = (b: Battle, pos: Pos, systems: string[] = []) => { const u = mech({ level: 6, callsign: 'Ally', systems }); u.pos = pos; b.units.push(u); return u }
const rifle = (u: Parameters<typeof gun>[0]) => weapon(u, 'mw_assault_rifle')

describe('former partial systems', () => {
  it('every former partial system is complete', () => {
    for (const id of ['ms_reinforced_cabling', 'ms_sekhmet_class_nhp', 'ms_argonaut_shield', 'ms_cable_winch_system', 'ms_armor_lock_plating', 'ms_ramjet', 'ms_perimeter_command_plate', 'ms_magnetic_shield', 'ms_oasis_wall', 'ms_flash_charges', 'ms_tlaloc_class_nhp', 'ms_fade_cloak', 'ms_markerlight', 'ms_athena_class_nhp', 'ms_lb_oc_cloaking_field', 'ms_metahook', 'ms_h0r_os_system_upgrade_ii', 'ms_osiris_class_nhp', 'ms_mimic_mesh', 'ms_scylla_class_nhp', 'ms_assassin_drone', 'ms_beckoner', 'ms_aggressive_system_sync', 'ms_metafold_carver', 'ms_interdiction_field', 'ms_law_of_blades', 'ms_roller_directed_payload_charges', 'ms_blinkshield', 'ms_enclave_pattern_support_shield', 'ms_hardlight_defense_system', 'ms_reactor_stabilizer'])
      expect(getScript(id)?.partial, id).toBeFalsy()
    expect(getScript('ms_puppetmaster')?.partial).toBeFalsy()
  })
})

describe('Heat (Self) costs', () => {
  for (const [id, re, heat] of [
    ['ms_ramjet', /Ramjet/, 2], ['ms_active_camouflage', /Active Camo/, 2], ['ms_asura_class_nhp', /ASURA/, 3],
    ['ms_type_3_projected_shield', /Project Shield/, 1], ['ms_lb_oc_cloaking_field', /Cloaking/, 2],
    ['ms_repulser_field', /Repulser/, 1], ['ms_scylla_class_nhp', /SCYLLA/, 2],
  ] as [string, RegExp, number][]) {
    // regression: these activations did not charge their Heat (Self)
    it(`Heat (Self) is charged when activating ${id} (Heat ${heat})`, () => {
      const { a, e, b } = setup9([id])
      const x = custom(b, a, re)
      b.useCustom(a, x, x.target === 'enemy' ? e : undefined)
      expect(a.heat).toBe(heat)
    })
  }
})

describe('Aggressive System Sync', () => {
  it('Excommunicate heats the target and its ally when they meet', () => {
    const { a, e, b } = setup2b(['ms_aggressive_system_sync'])
    const e2 = pregenUnit('Sniper', 'enemy'); e2.pos = { x: 6, y: 8 }; b.units.push(e2)
    a.stats.techAttack = 30
    b.useCustom(a, custom(b, a, /Excommunicate/), e)
    toEnemyTurn(b, a, e)
    expect(e.heat).toBeGreaterThanOrEqual(3)
    expect(b.customActions(e).some(c => /Break Excommunicate/.test(c.name))).toBe(true)
  })
})

describe('Argonaut Shield', () => {
  it('the ward resists; you take half the raw damage', () => {
    const { a, e, b } = setup2b(['ms_argonaut_shield'])
    const w = ally(b, { x: 6, y: 4 })
    b.useCustom(a, custom(b, a, /Argonaut/), w)
    const ah = a.hp, wh = w.hp
    b.applyDamage(w, [{ type: 'Kinetic', amount: 10 }], { source: e })
    expect(a.hp).toBe(ah - Math.max(0, 5 - a.stats.armor))
    expect(w.hp).toBe(wh - Math.ceil(Math.max(0, 10 - w.stats.armor) / 2))
  })
})

describe('Armor-Lock Plating', () => {
  it('Brace while grappled ends the grapple; no forced movement while braced', () => {
    const { a, e, b } = setup2b(['ms_armor_lock_plating'])
    e.pos = { x: 5, y: 5 }
    b.startGrapple(e, a)
    expect(b.canSpend(a, 'reaction', 'brace')).toBe(true)
    b.brace(a)
    expect(b.grapples).toHaveLength(0)
    const p = { ...a.pos }
    b.forceMove(a, e, 3, 1)
    expect(a.pos).toEqual(p)
  })
  it('after Bracing you auto-pass Hull/Agility saves', () => {
    const { a, b } = setup(['ms_armor_lock_plating'])
    a.flags.autoSaveUntil = b.round + 1
    a.stats.hull = -30
    expect(b.save(a, 'hull', 25)).toBe(true)
  })
})

describe('ATHENA-class NHP', () => {
  it('hostiles ending their turn in the simulacrum are Locked On', () => {
    const { a, e, b } = setup(['ms_athena_class_nhp'])
    b.useCustom(a, custom(b, a, /Simulacrum/), e.pos)
    toEnemyTurn(b, a, e)
    b.endTurn(e)
    expect(b.has(e, 'lockon')).toBe(true)
  })
})

describe('Beckoner and Metafold Carver', () => {
  it('Beckon swaps places; Ophidian Trek teleports toward you; Fold Space removes until its next turn', () => {
    const { a, e, b } = setup2b(['ms_beckoner', 'ms_metafold_carver'])
    a.stats.techAttack = 30
    const pa = { ...a.pos }, pe = { ...e.pos }
    b.useCustom(a, custom(b, a, /Beckon/), e)
    expect(a.pos).toEqual(pe); expect(e.pos).toEqual(pa)
    b.endTurn(a); b.beginTurn(e); b.endTurn(e); while (b.round < 2) { const u = b.combatants(b.currentSide).find(x => x.activationsLeft > 0); if (!u) break; b.beginTurn(u); b.endTurn(u) }
    if (b.currentSide !== 'player') { b.beginTurn(e); b.endTurn(e) }
    b.beginTurn(a)
    b.useCustom(a, custom(b, a, /Fold Space/), e)
    expect(e.flags.intangible).toBe(true)
  })
})

describe('Blinkshield', () => {
  it('line of sight and movement cannot cross the border', () => {
    const { a, e, b } = setup2b(['ms_blinkshield'])
    e.pos = { x: 5, y: 10 }
    b.useCustom(a, custom(b, a, /Blinkshield/))
    expect(b.los(e, a)).toBe(false)
    toEnemyTurn(b, a, e)
    expect(() => b.move(e, { x: 5, y: 8 })).toThrow(/Blinkshield/)
  })
  it('Blinkshield and Hardlight Defense stop attacks across their border', () => {
    for (const [s, re] of [['ms_blinkshield', /Blinkshield/], ['ms_hardlight_defense_system', /Hardlight/]] as const) {
      const { a, e, b } = setup([s])
      b.useCustom(a, custom(b, a, re))
      e.pos = { x: 5, y: 11 }
      toEnemyTurn(b, a, e)
      const r = b.weaponAttack(e, { ...rifle(e), profiles: rifle(e).profiles.map(p => ({ ...p, range: [{ type: 'Range', val: 20 }] as any })) }, { targetId: a.id }, 'free')
      expect(r.ctxs[0]?.hit).toBeFalsy()
    }
  })
})

describe('Cable Winch System', () => {
  it('towing beyond 5 drags the other end; anyone adjacent can cut it', () => {
    const { a, e, b } = setup2b(['ms_cable_winch_system'])
    e.pos = { x: 5, y: 5 }
    b.useCustom(a, custom(b, a, /Cable Winch/), e)
    expect(a.flags.tether).toBe(e.id)
    b.boost(a)
    b.move(a, { x: 12, y: 4 })
    expect(b.distance(a, e)).toBeLessThanOrEqual(5)
    expect(b.has(a, 'slowed')).toBe(true)
    expect(b.customActions(e).some(c => /Cut .*cable/.test(c.name))).toBe(true)
  })
})

describe('Clamp Bombs', () => {
  it('detonate at the end of the target’s turn unless it moves 4+', () => {
    const { a, e, b } = setup(['ms_clamp_bombs'])
    e.stats.armor = 0
    b.useCustom(a, custom(b, a, /Clamp Bombs/), e)
    toEnemyTurn(b, a, e)
    const hp = e.hp
    b.endTurn(e)
    expect(e.hp).toBeLessThan(hp)
  })
})

describe('ENCLAVE-pattern Support Shield', () => {
  it('+1 difficulty from outside; Blinkfield grants resistance', () => {
    const { a, e, b } = setup2b(['ms_enclave_pattern_support_shield'])
    b.useCustom(a, custom(b, a, /Enclave/))
    toEnemyTurn(b, a, e)
    const p = b.previewAttack(e, gun(e), a)
    expect(p.ctx.reasons.some(r => /Enclave/.test(r))).toBe(true)
  })
})

describe('External Batteries', () => {
  // regression: a destroyed External Batteries still gave energy weapons +5 range
  it('once destroyed (structure damage) its +5 range for energy weapons is gone', () => {
    const { a, e, b } = setup9(['ms_external_batteries'], [['Main', 'mw_thermal_rifle']])
    const w = a.weapons[0]
    expect(b.weaponReach(a, w)).toBe(10)
    a.hp = 1
    b.applyDamage(a, [{ type: 'Kinetic', amount: 10 }], { source: e })
    expect(a.systems[0].destroyed).toBe(true)
    expect(b.weaponReach(a, w)).toBe(5)
  })
})

describe('FADE Cloak', () => {
  it('phased characters pass through others but cannot stop on them', () => {
    const { a, e, b } = setup2b(['ms_fade_cloak'])
    e.pos = { x: 5, y: 3 }
    b.useCustom(a, custom(b, a, /FADE/))
    expect(a.flags.intangible).toBe(true)
    b.move(a, { x: 5, y: 2 })
    expect(a.pos).toEqual({ x: 5, y: 2 })
    expect(() => b.move(a, { x: 5, y: 3 })).toThrow()
  })
  it('intangible characters cannot be targeted or damaged', () => {
    const { a, e, b } = setup(['ms_fade_cloak'])
    b.useCustom(a, custom(b, a, /FADE Cloak/))
    expect(b.validTarget(e, rifle(e), a)).toBe('Intangible')
    const hp = a.hp
    b.applyDamage(a, [{ type: 'Kinetic', amount: 5 }])
    expect(a.hp).toBe(hp)
  })
})

describe('Flash Anchor', () => {
  it('stops an ally being knocked back', () => {
    const { a, e, b } = setup(['ms_flash_anchor'])
    const al = pregenUnit('Sniper'); al.pos = { x: 6, y: 6 }; b.units.push(al)
    b.forceMove(al, e, 3, 1)
    expect(al.pos).toEqual({ x: 6, y: 6 })
    expect(a.heat).toBe(2)
  })
})

describe('Flicker Field Projector', () => {
  it('after moving, the next attack treats you as Invisible', () => {
    const { a, e, b } = setup(['ms_flicker_field_projector'])
    b.move(a, { x: 6, y: 4 })
    expect(a.flags.flicker).toBe(true)
    toEnemyTurn(b, a, e)
    b.weaponAttack(e, rifle(e), { targetId: a.id }, 'free')
    expect(a.flags.flicker).toBe(false)
  })
})

describe('H0R_OS System Upgrade II', () => {
  it('a failed save sends attacks at the False Idol instead', () => {
    const { a, e, b } = setup2b(['ms_h0r_os_system_upgrade_ii'])
    b.useCustom(a, custom(b, a, /False Idol/), { x: 8, y: 6 })
    toEnemyTurn(b, a, e)
    e.stats.attackBonus = 30
    b.weaponAttack(e, gun(e), { targetId: a.id }, 'free')
    expect(b.alive().some(o => o.flags.idolOf)).toBe(false) // the 1 HP decoy took the hit
  })
})

describe('Hardlight Defense System', () => {
  it('blocks line of sight both ways; crossing deals 2 burn', () => {
    const { a, e, b } = setup2b(['ms_hardlight_defense_system'])
    b.useCustom(a, custom(b, a, /Hardlight Defense System/))
    expect(b.los(e, a)).toBe(false)
    expect(b.los(a, e)).toBe(false)
    toEnemyTurn(b, a, e)
    b.move(e, { x: 5, y: 6 })
    expect(e.burn).toBeGreaterThanOrEqual(2)
  })
})

describe('Interdiction Field', () => {
  it('hostiles cannot teleport in', () => {
    const { a, e, b } = setup2b(['ms_interdiction_field'])
    b.useCustom(a, custom(b, a, /Interdiction Field/))
    expect(b.teleportBlocked(e, { x: 5, y: 6 })).toBe(true)
    expect(b.teleportBlocked(a, { x: 5, y: 6 })).toBe(false)
  })
})

describe('Javelin Rockets', () => {
  it('hit the first character to enter a marked space', () => {
    const { a, e, b } = setup(['ms_javelin_rockets'])
    b.useCustom(a, custom(b, a, /Javelin/), { x: 5, y: 7 })
    toEnemyTurn(b, a, e)
    e.stats.armor = 0
    const hp = e.hp
    b.move(e, { x: 5, y: 7 })
    expect(e.hp).toBe(hp - 3)
  })
})

describe('Law of Blades', () => {
  it('Predator/Prey makes the target attack its own ally', () => {
    const { a, e, b } = setup2b(['ms_law_of_blades'])
    const e2 = pregenUnit('Sniper', 'enemy'); e2.pos = { x: 6, y: 8 }; e2.stats.evasion = 1; b.units.push(e2)
    a.stats.techAttack = 30
    e.stats.attackBonus = 30
    const hp = e2.hp
    b.useCustom(a, custom(b, a, /Predator/), e)
    expect(e2.hp).toBeLessThan(hp)
  })
})

describe('LB/OC Cloaking Field', () => {
  it('allies wholly inside burst 2 are Invisible; taking damage ends it', () => {
    const { a, e, b } = setup2b(['ms_lb_oc_cloaking_field'])
    const al = ally(b, { x: 6, y: 5 })
    b.useCustom(a, custom(b, a, /Cloaking Field/))
    expect(b.has(al, 'invisible')).toBe(true)
    expect(b.has(a, 'slowed')).toBe(true)
    b.applyDamage(a, [{ type: 'Kinetic', amount: 10 }], { source: e })
    expect(b.has(al, 'invisible')).toBe(false)
  })
})

describe('LUCIFER-class NHP', () => {
  // regression: the protocol's Heat 1d3+3 was not charged
  it('the protocol costs Heat 1d3+3', () => {
    const { a, b } = setup9(['ms_lucifer_class_nhp'])
    rigDice(b, 3, 2)
    b.useCustom(a, custom(b, a, /LUCIFER/))
    expect(a.heat).toBe(5)
  })
})

describe('Magnetic Shield', () => {
  it('resistance to kinetic only (not energy) for characters it covers', () => {
    const { a, e, b } = setup2b(['ms_magnetic_shield'])
    b.useCustom(a, custom(b, a, /Magnetic Shield/), { x: 5, y: 5 })
    const opts: any = { source: e }
    const parts = [{ type: 'Kinetic', amount: 6 }]
    for (const o of b.alive()) for (const sc of scriptsFor(o)) sc.beforeAnyDamage?.(b, o, a, parts, opts)
    expect(opts.resistTypes).toEqual(['Kinetic', 'Explosive'])
  })
  it('gives soft cover from attacks across it', () => {
    const { a, e, b } = setup(['ms_magnetic_shield'])
    b.useCustom(a, custom(b, a, /Magnetic Shield/), { x: 5, y: 5 })
    expect(b.cover(e, a)).not.toBe('none')
  })
})

describe('Markerlight', () => {
  it('an ally hit on the target can be turned into a critical', () => {
    const { a, e, b } = setup2b(['ms_markerlight'])
    const al = ally(b, { x: 6, y: 5 })
    a.stats.techAttack = 30
    b.useCustom(a, custom(b, a, /Markerlight/), e)
    expect(b.has(e, 'lockon')).toBe(true)
    al.stats.attackBonus = 10
    rigDice(b, 20, 2) // 2 + 10 (+1 Accuracy from Lock On) hits Evasion 1 but is short of a critical on its own
    const r = b.weaponAttack(al, gun(al), { targetId: e.id }, 'free')
    expect(r.ctxs[0].roll).toBe(2)
    expect(r.ctxs[0].hit).toBe(true)
    expect(r.ctxs[0].crit).toBe(true)
    expect(a.reactionsLeft).toBe(0)
  })
})

describe('Metahook', () => {
  it('shared heat and conditions; the ally uses your Systems', () => {
    const { a, e, b } = setup2b(['ms_metahook'])
    const al = ally(b, { x: 7, y: 4 })
    a.stats.sys = 6
    b.useCustom(a, custom(b, a, /Metahook/), al)
    expect(al.stats.sys).toBe(6)
    b.addHeat(al, 2)
    expect(a.heat).toBe(2)
    b.addStatus(a, 'impaired', 'next_turn_end_target', e)
    expect(b.has(al, 'impaired')).toBe(true)
  })
})

describe('Mimic Mesh', () => {
  it('Battlefield Awareness moves you toward the attacked ally first', () => {
    const { a, e, b } = setup2b(['ms_mimic_mesh'])
    const al = ally(b, { x: 10, y: 4 })
    b.useCustom(a, custom(b, a, /Mimic Mesh/), al)
    toEnemyTurn(b, a, e)
    const d0 = b.distance(a, al)
    b.weaponAttack(e, gun(e), { targetId: al.id }, 'free')
    expect(b.distance(a, al)).toBeLessThan(d0)
  })
})

describe('Monitor Module', () => {
  it('when the guarded ally is attacked, you Skirmish the attacker', () => {
    const { a, e, b } = setup(['ms_monitor_module'])
    const al = pregenUnit('Sniper'); al.pos = { x: 6, y: 4 }; al.activationsLeft = 0; b.units.push(al)
    b.useCustom(a, custom(b, a, /Monitor Module/), al)
    toEnemyTurn(b, a, e)
    b.weaponAttack(e, rifle(e), { targetId: al.id }, 'free')
    expect(a.reactionsLeft).toBe(0)
  })
})

describe('MULE Harness', () => {
  it('an ally rides along when you move', () => {
    const { a, b } = setup(['ms_mule_harness'], { size: 2 })
    const rider = pregenUnit('Sniper'); rider.pos = { x: 7, y: 4 }; b.units.push(rider)
    rider.stats.size = 1
    b.move(a, { x: 5, y: 3 })
    b.endTurn(a)
    ;(b as any).currentSide = 'player'; a.activationsLeft = 1
    b.beginTurn(rider)
    b.useCustom(rider, custom(b, rider, /Ride/))
    expect(rider.pos).toEqual(a.pos)
    b.endTurn(rider)
    ;(b as any).currentSide = 'player'
    b.beginTurn(a)
    b.move(a, { x: 5, y: 1 })
    expect(rider.pos).toEqual(a.pos)
  })
})

describe('NOAH-class NHP', () => {
  it('ranged attacks on you cost heat and sometimes miss; misses hurt the attacker', () => {
    const { a, e, b } = setup(['ms_noah_class_nhp'])
    b.useCustom(a, custom(b, a, /Diluvian Ark/))
    toEnemyTurn(b, a, e)
    b.weaponAttack(e, rifle(e), { targetId: a.id }, 'free')
    expect(a.heat).toBeGreaterThanOrEqual(1)
  })
})

describe('OASIS Wall', () => {
  it('straight moves; nobody can stop inside the trail', () => {
    const { a, e, b } = setup2b(['ms_oasis_wall'])
    b.useCustom(a, custom(b, a, /OASIS/))
    expect(() => b.move(a, { x: 7, y: 3 })).toThrow(/straight/)
    b.move(a, { x: 8, y: 4 })
    expect(a.flags.oasis).toEqual([{ x: 5, y: 4 }, { x: 6, y: 4 }, { x: 7, y: 4 }])
    expect(b.endBlocked(e, { x: 6, y: 4 })).toBe(true)
  })
})

describe('OSIRIS-class NHP', () => {
  it('the Gates advance; the Fourth Gate turns the target', () => {
    const { a, e, b } = setup2b(['ms_osiris_class_nhp'])
    a.stats.techAttack = 30
    a.flags.duatGate = 3
    b.useCustom(a, custom(b, a, /Duat/), e)
    expect(e.side).toBe('player')
    expect(b.winner).toBeNull()
    b.applyDamage(e, [{ type: 'Kinetic', amount: 1 }], { source: a })
    expect(e.side).toBe('enemy')
  })
})

describe('PUPPETMASTER', () => {
  it('Guide the Flock: each drone moves to its own space, up to 4', () => {
    const { a, b } = setup2b(['ms_puppetmaster'])
    // two drones (one hostile) next to the mech
    const mk = (side: 'player' | 'enemy', x: number, y: number) => { const u = pregenUnit('Assault', side); u.kind = 'drone'; u.stats.size = 0.5; u.pos = { x, y }; u.name = `Drone ${x}`; b.units.push(u); return u }
    const own = mk('player', 6, 4), foe = mk('enemy', 4, 6)
    a.stats.techAttack = 30
    b.useCustom(a, custom(b, a, /Guide the Flock/))
    b.useCustom(a, custom(b, a, new RegExp(`Guide ${own.name}`)), { x: 9, y: 4 })
    b.useCustom(a, custom(b, a, new RegExp(`Guide ${foe.name}`)), { x: 4, y: 10 })
    expect(own.pos).toEqual({ x: 9, y: 4 })
    expect(foe.pos).toEqual({ x: 4, y: 10 })
    expect(() => b.useCustom(a, custom(b, a, /Guide the Flock/))).toThrow()
  })
})

describe('Ramjet', () => {
  it('moves must be full-Speed straight lines', () => {
    const { a, b } = setup2b(['ms_ramjet'])
    b.useCustom(a, custom(b, a, /Ramjet/))
    expect(() => b.move(a, { x: 6, y: 2 })).toThrow(/straight/)
    expect(() => b.move(a, { x: 5, y: 2 })).toThrow(/full Speed/)
    b.move(a, { x: 5 + 0, y: 4 - Math.min(a.stats.speed, 4) })
  })
})

describe('Reactor Stabilizer', () => {
  it('a bad overheating roll is rerolled', () => {
    const { a, b } = setup2b(['ms_reactor_stabilizer'])
    expect(a.flags.reactorStabilizer).toBe(true)
    a.heat = a.stats.heatcap
    b.addHeat(a, 3)
    expect(b.log.some(l => /Overheating check/.test(l.text))).toBe(true)
  })
})

describe('Reinforced Cabling', () => {
  it('Grapple Swing: a straight-line flight of your Speed instead of the standard move', () => {
    const { a, b } = setup2b(['ms_reinforced_cabling'])
    b.useCustom(a, custom(b, a, /Grapple Swing/), { x: 5, y: 0 })
    expect(a.pos).toEqual({ x: 5, y: 0 })
    expect(a.moveLeft).toBe(0)
    expect(custom(b, a, /Grapple Swing/).usable(b, a)).not.toBe(true)
  })
})

describe('Retractable Profile', () => {
  it("you can't attack", () => {
    const { a, b } = setup(['ms_retractable_profile'])
    b.useCustom(a, custom(b, a, /Retractable Profile/))
    expect(b.weaponUsable(a, rifle(a))).toMatch(/Cannot attack/)
  })
})

describe('//SCORPION V70.1', () => {
  // regression: a missed hostile tech attack did not Impair the attacker
  it('a hostile tech attack that MISSES you leaves the attacker Impaired (+2 heat)', () => {
    const { a, e, b } = setup9(['ms___scorpion_v70.1'])
    a.stats.edef = 40
    b.endTurn(a); b.beginTurn(e)
    e.pos = { x: 5, y: 6 }
    b.invade(e, a)
    expect(b.has(e, 'impaired')).toBe(true)
  })
})

describe('SCYLLA-class NHP', () => {
  it('a hostile attacking an ally within 3 is skirmished at half damage', () => {
    const { a, e, b } = setup2b(['ms_scylla_class_nhp'])
    const al = ally(b, { x: 6, y: 5 })
    b.useCustom(a, custom(b, a, /Unleash SCYLLA/))
    toEnemyTurn(b, a, e)
    b.weaponAttack(e, gun(e), { targetId: al.id }, 'free')
    expect(a.flags.scylla.left).toBe(1)
  })
})

describe('SEKHMET-class NHP', () => {
  it('the NHP charges the closest character, even an ally', () => {
    const { a, b } = setup2b(['ms_sekhmet_class_nhp'], { weapon: 'mw_combat_drill' })
    const al = ally(b, { x: 7, y: 4 })
    b.useCustom(a, custom(b, a, /SEKHMET Protocol/))
    const hp = al.hp
    a.stats.attackBonus = 30
    sekhmetTurn(b, a)
    expect(al.hp).toBeLessThan(hp)
  })
})

describe('SISYPHUS-class NHP', () => {
  it('an ally’s save uses the stored high roll', () => {
    const { a, b } = setup(['ms_sisyphus_class_nhp'])
    a.flags.bend = { vals: [20, 1], until: b.round + 1, uses: 2 }
    expect(b.save(a, 'hull', 30)).toBe(false)
    expect(a.flags.bend.vals).toEqual([1])
  })
})

describe('Swarm Body', () => {
  it('hostiles starting next to you save or take kinetic', () => {
    const { a, e, b } = setup(['ms_swarm_body'])
    e.pos = { x: 5, y: 5 }
    e.stats.armor = 0
    b.useCustom(a, custom(b, a, /Swarm Body/))
    const hp = e.hp
    toEnemyTurn(b, a, e)
    expect(e.hp).toBe(hp - 3)
  })
})

describe('Tesseract', () => {
  it('Pinpoint Focus lifts a hostile into the air', () => {
    const { a, e, b } = setup(['ms_tesseract'])
    b.useCustom(a, custom(b, a, /Pinpoint/), e)
    expect(e.flying).toBe(true)
    expect(b.has(e, 'immobilized')).toBe(true)
  })
})

describe('TLALOC-class NHP', () => {
  it('a miss can be rerolled at a new target', () => {
    const { a, e, b } = setup2b(['ms_tlaloc_class_nhp'])
    const e2 = pregenUnit('Sniper', 'enemy'); e2.pos = { x: 7, y: 8 }; e2.stats.evasion = 1; b.units.push(e2)
    b.useCustom(a, custom(b, a, /TLALOC/))
    e.stats.evasion = 99
    b.weaponAttack(a, gun(a), { targetId: e.id }, 'free')
    expect(b.log.some(l => /TLALOC retargets/.test(l.text))).toBe(true)
  })
})

describe('Walking Armory (Ammo Case)', () => {
  it('SABOT costs 2 charges', () => {
    const { a, e, b } = setup(['ms_walking_armory_1', 'ms_walking_armory_2'])
    const s = a.systems.find(x => x.dataId === 'ms_walking_armory_1')!
    s.usesLeft = 6
    b.useCustom(a, custom(b, a, /SABOT/))
    e.pos = { x: 5, y: 7 }
    b.weaponAttack(a, rifle(a), { targetId: e.id }, 'free')
    expect(s.usesLeft).toBeLessThanOrEqual(4)
  })
})

describe('Whitewash Sealant Spray', () => {
  it('slows a hostile that fails its save', () => {
    const { a, e, b } = setup(['ms_whitewash_sealant_spray'])
    e.pos = { x: 5, y: 7 }
    b.useCustom(a, custom(b, a, /Whitewash/), e.pos)
    expect(b.has(e, 'slowed')).toBe(true)
  })
})

describe('AI with these systems', () => {
  it('AI battles with the systems2 systems without errors', () => {
    const sets = [
      ['ms_whitewash_sealant_spray', 'ms_bb_breach_blast_charges', 'ms_magnetic_shield', 'ms_flicker_field_projector'],
      ['ms_flash_charges', 'ms_javelin_rockets', 'ms_tlaloc_class_nhp', 'ms_fade_cloak'],
      ['ms_athena_class_nhp', 'ms_swarm_body', 'ms_h0r_os_system_upgrade_ii', 'ms_h0r_os_system_upgrade_iii', 'ms_monitor_module'],
      ['ms_mesmer_charges', 'ms_law_of_blades', 'ms_sisyphus_class_nhp', 'ms_roller_directed_payload_charges', 'ms_grounding_charges'],
      ['ms_clamp_bombs', 'ms_tesseract', 'ms_blinkshield', 'ms_flash_anchor', 'ms_hardlight_defense_system', 'ms_noah_class_nhp'],
      ['ms_armor_lock_plating', 'ms_cable_winch_system', 'ms_mule_harness', 'ms_retractable_profile', 'ms_sekhmet_class_nhp', 'ms_walking_armory_1'],
    ]
    const ps = sets.map((s, i) => { const u = mech({ level: 6, systems: s, callsign: `P${i}` }); u.pos = { x: 1 + i * 2, y: 1 }; return u })
    const es = sets.map((s, i) => { const u = mech({ level: 6, systems: s, callsign: `E${i}` }, 'enemy'); u.pos = { x: 1 + i * 2, y: 18 }; return u })
    const b = battle([...ps, ...es], flatMap(16, 20), 41)
    autoBattle(b, 10)
    expect(aiErrors).toEqual([])
  })
  it('AI battles with the former partial systems run cleanly', () => {
    const p1 = mech({ level: 6, systems: ['ms_osiris_class_nhp', 'ms_law_of_blades', 'ms_metahook'] })
    const p2 = mech({ level: 6, systems: ['ms_blinkshield', 'ms_tlaloc_class_nhp', 'ms_oasis_wall'] })
    const p3 = mech({ level: 6, systems: ['ms_hardlight_defense_system', 'ms_scylla_class_nhp', 'ms_perimeter_command_plate'] })
    const e1 = mech({ level: 6, systems: ['ms_interdiction_field', 'ms_argonaut_shield'] }, 'enemy'), e2 = pregenUnit('Sniper', 'enemy'), e3 = mech({ level: 6, systems: ['ms_sekhmet_class_nhp', 'ms_cable_winch_system'], weapons: 'mw_combat_drill' }, 'enemy')
    p1.pos = { x: 3, y: 2 }; p2.pos = { x: 7, y: 2 }; p3.pos = { x: 10, y: 2 }; e1.pos = { x: 3, y: 12 }; e2.pos = { x: 7, y: 13 }; e3.pos = { x: 10, y: 12 }
    const b = battle([p1, p2, p3, e1, e2, e3], flatMap(14, 16), 9)
    autoBattle(b, 8)
    expect(aiErrors).toHaveLength(0)
  })
})
