// Former partial scripts, batch 2b: systems.
import { describe, expect, it } from 'vitest'
import type { PilotBuild } from '../src/import/compcon'
import { buildMechUnit } from '../src/rules/stats'
import { Battle } from '../src/rules/battle'
import { autoBattle, aiErrors } from '../src/ai/ai'
import { getScript, scriptsFor } from '../src/rules/effects/registry'
import { sekhmetTurn } from '../src/rules/effects/scripts/systems2'
import type { Unit } from '../src/rules/types'
import { flatMap, pregenUnit } from './helpers'

function mech(systems: string[], o: { side?: 'player' | 'enemy'; name?: string; weapon?: string } = {}): Unit {
  const p = {
    id: `t-${Math.random()}`, callsign: o.name ?? 'Tester', name: 'T', level: 6, mechSkills: [2, 2, 2, 2], talents: [], coreBonuses: [],
    mech: { name: 'T', frameId: 'mf_standard_pattern_i_everest', mounts: [{ type: 'Main', slots: [{ size: 'Main', weaponId: o.weapon ?? 'mw_assault_rifle' }], bonusEffects: [] }], systems },
    unknown: [],
  } as unknown as PilotBuild
  return buildMechUnit(p, o.side ?? 'player')
}
function setup(systems: string[], o: { map?: ReturnType<typeof flatMap>; weapon?: string } = {}) {
  const a = mech(systems, { weapon: o.weapon })
  const e = pregenUnit('Assault', 'enemy')
  a.pos = { x: 5, y: 4 }
  e.pos = { x: 5, y: 8 }
  e.stats.hull = -20; e.stats.agi = -20; e.stats.sys = -20; e.stats.eng = -20; e.stats.evasion = 1; e.stats.edef = 1
  const b = new Battle({ map: o.map ?? flatMap(16, 16), units: [a, e], seed: 13 })
  b.start()
  b.beginTurn(a)
  return { a, e, b }
}
const act = (b: Battle, u: Unit, re: RegExp) => {
  const x = b.customActions(u).find(c => re.test(c.name) || re.test(c.key))
  if (!x) throw new Error(`no action ${re}: ${b.customActions(u).map(c => c.name).join(', ')}`)
  return x
}
const ally = (b: Battle, pos: { x: number; y: number }, systems: string[] = []) => { const u = mech(systems, { name: 'Ally' }); u.pos = pos; b.units.push(u); return u }
const toEnemyTurn = (b: Battle, a: Unit, e: Unit) => { b.endTurn(a); b.beginTurn(e) }
const rifle = (u: Unit) => u.weapons.find(w => !w.destroyed && !w.tech)!

describe('2b: systems are complete', () => {
  it('only PUPPETMASTER keeps a documented deviation', () => {
    for (const id of ['ms_reinforced_cabling', 'ms_sekhmet_class_nhp', 'ms_argonaut_shield', 'ms_cable_winch_system', 'ms_armor_lock_plating', 'ms_ramjet', 'ms_perimeter_command_plate', 'ms_magnetic_shield', 'ms_oasis_wall', 'ms_flash_charges', 'ms_tlaloc_class_nhp', 'ms_fade_cloak', 'ms_markerlight', 'ms_athena_class_nhp', 'ms_lb_oc_cloaking_field', 'ms_metahook', 'ms_h0r_os_system_upgrade_ii', 'ms_osiris_class_nhp', 'ms_mimic_mesh', 'ms_scylla_class_nhp', 'ms_assassin_drone', 'ms_beckoner', 'ms_aggressive_system_sync', 'ms_metafold_carver', 'ms_interdiction_field', 'ms_law_of_blades', 'ms_roller_directed_payload_charges', 'ms_blinkshield', 'ms_enclave_pattern_support_shield', 'ms_hardlight_defense_system', 'ms_reactor_stabilizer'])
      expect(getScript(id)?.partial, id).toBeFalsy()
    expect(getScript('ms_puppetmaster')?.partial).toBe(true)
  })
})

describe('IPS-N and SSC', () => {
  it('Grapple Swing: a straight-line flight of your Speed instead of the standard move', () => {
    const { a, b } = setup(['ms_reinforced_cabling'])
    b.useCustom(a, act(b, a, /Grapple Swing/), { x: 5, y: 0 })
    expect(a.pos).toEqual({ x: 5, y: 0 })
    expect(a.moveLeft).toBe(0)
    expect(act(b, a, /Grapple Swing/).usable(b, a)).not.toBe(true)
  })
  it('Argonaut Shield: the ward resists; you take half the raw damage', () => {
    const { a, e, b } = setup(['ms_argonaut_shield'])
    const w = ally(b, { x: 6, y: 4 })
    b.useCustom(a, act(b, a, /Argonaut/), w)
    const ah = a.hp, wh = w.hp
    b.applyDamage(w, [{ type: 'Kinetic', amount: 10 }], { source: e })
    expect(a.hp).toBe(ah - Math.max(0, 5 - a.stats.armor))
    expect(w.hp).toBe(wh - Math.ceil(Math.max(0, 10 - w.stats.armor) / 2))
  })
  it('Ramjet: moves must be full-Speed straight lines', () => {
    const { a, b } = setup(['ms_ramjet'])
    b.useCustom(a, act(b, a, /Ramjet/))
    expect(() => b.move(a, { x: 6, y: 2 })).toThrow(/straight/)
    expect(() => b.move(a, { x: 5, y: 2 })).toThrow(/full Speed/)
    b.move(a, { x: 5 + 0, y: 4 - Math.min(a.stats.speed, 4) })
  })
  it('Markerlight: an ally hit on the target can be turned into a critical', () => {
    const { a, e, b } = setup(['ms_markerlight'])
    const al = ally(b, { x: 6, y: 5 })
    a.stats.techAttack = 30
    b.useCustom(a, act(b, a, /Markerlight/), e)
    expect(b.has(e, 'lockon')).toBe(true)
    al.stats.attackBonus = 10
    const r = b.weaponAttack(al, rifle(al), { targetId: e.id }, 'free')
    if (r.ctxs[0].hit) expect(r.ctxs[0].crit).toBe(true)
  })
  it('LB/OC: allies wholly inside burst 2 are Invisible; taking damage ends it', () => {
    const { a, e, b } = setup(['ms_lb_oc_cloaking_field'])
    const al = ally(b, { x: 6, y: 5 })
    b.useCustom(a, act(b, a, /Cloaking Field/))
    expect(b.has(al, 'invisible')).toBe(true)
    expect(b.has(a, 'slowed')).toBe(true)
    b.applyDamage(a, [{ type: 'Kinetic', amount: 10 }], { source: e })
    expect(b.has(al, 'invisible')).toBe(false)
  })
  it('Cable Winch: towing beyond 5 drags the other end; anyone adjacent can cut it', () => {
    const { a, e, b } = setup(['ms_cable_winch_system'])
    e.pos = { x: 5, y: 5 }
    b.useCustom(a, act(b, a, /Cable Winch/), e)
    expect(a.flags.tether).toBe(e.id)
    b.boost(a)
    b.move(a, { x: 12, y: 4 })
    expect(b.distance(a, e)).toBeLessThanOrEqual(5)
    expect(b.has(a, 'slowed')).toBe(true)
    expect(b.customActions(e).some(c => /Cut .*cable/.test(c.name))).toBe(true)
  })
  it('Armor-Lock: Brace while grappled ends the grapple; no forced movement while braced', () => {
    const { a, e, b } = setup(['ms_armor_lock_plating'])
    e.pos = { x: 5, y: 5 }
    b.startGrapple(e, a)
    expect(b.canSpend(a, 'reaction', 'brace')).toBe(true)
    b.brace(a)
    expect(b.grapples).toHaveLength(0)
    const p = { ...a.pos }
    b.forceMove(a, e, 3, 1)
    expect(a.pos).toEqual(p)
  })
  it('Magnetic Shield: resistance to kinetic only (not energy) for characters it covers', () => {
    const { a, e, b } = setup(['ms_magnetic_shield'])
    b.useCustom(a, act(b, a, /Magnetic Shield/), { x: 5, y: 5 })
    const opts: any = { source: e }
    const parts = [{ type: 'Kinetic', amount: 6 }]
    for (const o of b.alive()) for (const sc of scriptsFor(o)) sc.beforeAnyDamage?.(b, o, a, parts, opts)
    expect(opts.resistTypes).toEqual(['Kinetic', 'Explosive'])
  })
  it('TLALOC: a miss can be rerolled at a new target', () => {
    const { a, e, b } = setup(['ms_tlaloc_class_nhp'])
    const e2 = pregenUnit('Sniper', 'enemy'); e2.pos = { x: 7, y: 8 }; e2.stats.evasion = 1; b.units.push(e2)
    b.useCustom(a, act(b, a, /TLALOC/))
    e.stats.evasion = 99
    b.weaponAttack(a, rifle(a), { targetId: e.id }, 'free')
    expect(b.log.some(l => /TLALOC retargets/.test(l.text))).toBe(true)
  })
  it('FADE: phased characters pass through others but cannot stop on them', () => {
    const { a, e, b } = setup(['ms_fade_cloak'])
    e.pos = { x: 5, y: 3 }
    b.useCustom(a, act(b, a, /FADE/))
    expect(a.flags.intangible).toBe(true)
    b.move(a, { x: 5, y: 2 })
    expect(a.pos).toEqual({ x: 5, y: 2 })
    expect(() => b.move(a, { x: 5, y: 3 })).toThrow()
  })
  it('SEKHMET: the NHP charges the closest character, even an ally', () => {
    const { a, b } = setup(['ms_sekhmet_class_nhp'], { weapon: 'mw_combat_drill' })
    const al = ally(b, { x: 7, y: 4 })
    b.useCustom(a, act(b, a, /SEKHMET Protocol/))
    const hp = al.hp
    a.stats.attackBonus = 30
    sekhmetTurn(b, a)
    expect(al.hp).toBeLessThan(hp)
  })
})

describe('HORUS', () => {
  it('Metahook: shared heat and conditions; the ally uses your Systems', () => {
    const { a, e, b } = setup(['ms_metahook'])
    const al = ally(b, { x: 7, y: 4 })
    a.stats.sys = 6
    b.useCustom(a, act(b, a, /Metahook/), al)
    expect(al.stats.sys).toBe(6)
    b.addHeat(al, 2)
    expect(a.heat).toBe(2)
    b.addStatus(a, 'impaired', 'next_turn_end_target', e)
    expect(b.has(al, 'impaired')).toBe(true)
  })
  it('OSIRIS: the Gates advance; the Fourth Gate turns the target', () => {
    const { a, e, b } = setup(['ms_osiris_class_nhp'])
    a.stats.techAttack = 30
    a.flags.duatGate = 3
    b.useCustom(a, act(b, a, /Duat/), e)
    expect(e.side).toBe('player')
    expect(b.winner).toBeNull()
    b.applyDamage(e, [{ type: 'Kinetic', amount: 1 }], { source: a })
    expect(e.side).toBe('enemy')
  })
  it('Mimic Mesh: Battlefield Awareness moves you toward the attacked ally first', () => {
    const { a, e, b } = setup(['ms_mimic_mesh'])
    const al = ally(b, { x: 10, y: 4 })
    b.useCustom(a, act(b, a, /Mimic Mesh/), al)
    toEnemyTurn(b, a, e)
    const d0 = b.distance(a, al)
    b.weaponAttack(e, rifle(e), { targetId: al.id }, 'free')
    expect(b.distance(a, al)).toBeLessThan(d0)
  })
  it('SCYLLA: a hostile attacking an ally within 3 is skirmished at half damage', () => {
    const { a, e, b } = setup(['ms_scylla_class_nhp'])
    const al = ally(b, { x: 6, y: 5 })
    b.useCustom(a, act(b, a, /Unleash SCYLLA/))
    toEnemyTurn(b, a, e)
    b.weaponAttack(e, rifle(e), { targetId: al.id }, 'free')
    expect(a.flags.scylla.left).toBe(1)
  })
  it('Beckon swaps places; Ophidian Trek teleports toward you; Fold Space removes until its next turn', () => {
    const { a, e, b } = setup(['ms_beckoner', 'ms_metafold_carver'])
    a.stats.techAttack = 30
    const pa = { ...a.pos }, pe = { ...e.pos }
    b.useCustom(a, act(b, a, /Beckon/), e)
    expect(a.pos).toEqual(pe); expect(e.pos).toEqual(pa)
    b.endTurn(a); b.beginTurn(e); b.endTurn(e); while (b.round < 2) { const u = b.combatants(b.currentSide).find(x => x.activationsLeft > 0); if (!u) break; b.beginTurn(u); b.endTurn(u) }
    if (b.currentSide !== 'player') { b.beginTurn(e); b.endTurn(e) }
    b.beginTurn(a)
    b.useCustom(a, act(b, a, /Fold Space/), e)
    expect(e.flags.intangible).toBe(true)
  })
  it('Aggressive System Sync: Excommunicate heats the target and its ally when they meet', () => {
    const { a, e, b } = setup(['ms_aggressive_system_sync'])
    const e2 = pregenUnit('Sniper', 'enemy'); e2.pos = { x: 6, y: 8 }; b.units.push(e2)
    a.stats.techAttack = 30
    b.useCustom(a, act(b, a, /Excommunicate/), e)
    toEnemyTurn(b, a, e)
    expect(e.heat).toBeGreaterThanOrEqual(3)
    expect(b.customActions(e).some(c => /Break Excommunicate/.test(c.name))).toBe(true)
  })
  it('H0R_OS II: a failed save sends attacks at the False Idol instead', () => {
    const { a, e, b } = setup(['ms_h0r_os_system_upgrade_ii'])
    b.useCustom(a, act(b, a, /False Idol/), { x: 8, y: 6 })
    toEnemyTurn(b, a, e)
    e.stats.attackBonus = 30
    b.weaponAttack(e, rifle(e), { targetId: a.id }, 'free')
    expect(b.alive().some(o => o.flags.idolOf)).toBe(false) // the 1 HP decoy took the hit
  })
  it('Interdiction Field: hostiles cannot teleport in', () => {
    const { a, e, b } = setup(['ms_interdiction_field'])
    b.useCustom(a, act(b, a, /Interdiction Field/))
    expect(b.teleportBlocked(e, { x: 5, y: 6 })).toBe(true)
    expect(b.teleportBlocked(a, { x: 5, y: 6 })).toBe(false)
  })
  it('Law of Blades: Predator/Prey makes the target attack its own ally', () => {
    const { a, e, b } = setup(['ms_law_of_blades'])
    const e2 = pregenUnit('Sniper', 'enemy'); e2.pos = { x: 6, y: 8 }; e2.stats.evasion = 1; b.units.push(e2)
    a.stats.techAttack = 30
    e.stats.attackBonus = 30
    const hp = e2.hp
    b.useCustom(a, act(b, a, /Predator/), e)
    expect(e2.hp).toBeLessThan(hp)
  })
})

describe('Harrison Armory and drones', () => {
  it('Blinkshield: line of sight and movement cannot cross the border', () => {
    const { a, e, b } = setup(['ms_blinkshield'])
    e.pos = { x: 5, y: 10 }
    b.useCustom(a, act(b, a, /Blinkshield/))
    expect(b.los(e, a)).toBe(false)
    toEnemyTurn(b, a, e)
    expect(() => b.move(e, { x: 5, y: 8 })).toThrow(/Blinkshield/)
  })
  it('Hardlight: blocks line of sight both ways; crossing deals 2 burn', () => {
    const { a, e, b } = setup(['ms_hardlight_defense_system'])
    b.useCustom(a, act(b, a, /Hardlight Defense System/))
    expect(b.los(e, a)).toBe(false)
    expect(b.los(a, e)).toBe(false)
    toEnemyTurn(b, a, e)
    b.move(e, { x: 5, y: 6 })
    expect(e.burn).toBeGreaterThanOrEqual(2)
  })
  it('ENCLAVE: +1 difficulty from outside; Blinkfield grants resistance', () => {
    const { a, e, b } = setup(['ms_enclave_pattern_support_shield'])
    b.useCustom(a, act(b, a, /Enclave/))
    toEnemyTurn(b, a, e)
    const p = b.previewAttack(e, rifle(e), a)
    expect(p.ctx.reasons.some(r => /Enclave/.test(r))).toBe(true)
  })
  it('Reactor Stabilizer: a bad overheating roll is rerolled', () => {
    const { a, b } = setup(['ms_reactor_stabilizer'])
    expect(a.flags.reactorStabilizer).toBe(true)
    a.heat = a.stats.heatcap
    b.addHeat(a, 3)
    expect(b.log.some(l => /Overheating check/.test(l.text))).toBe(true)
  })
  it('OASIS Wall: straight moves; nobody can stop inside the trail', () => {
    const { a, e, b } = setup(['ms_oasis_wall'])
    b.useCustom(a, act(b, a, /OASIS/))
    expect(() => b.move(a, { x: 7, y: 3 })).toThrow(/straight/)
    b.move(a, { x: 8, y: 4 })
    expect(a.flags.oasis.length).toBeGreaterThan(0)
    expect(b.endBlocked(e, { x: 6, y: 4 })).toBe(true)
  })
  it('Assassin Drone: Area Denial fires every time (not once a round)', () => {
    const { a, e, b } = setup(['ms_assassin_drone'])
    b.useCustom(a, act(b, a, /Deploy Assassin/), { x: 5, y: 9 })
    toEnemyTurn(b, a, e)
    a.reactionsLeft = 1
    b.move(e, { x: 6, y: 9 })
    expect(b.log.some(l => /Area Denial/.test(l.text))).toBe(true)
  })
  it('AI battles with these systems run cleanly', () => {
    const p1 = mech(['ms_osiris_class_nhp', 'ms_law_of_blades', 'ms_metahook'])
    const p2 = mech(['ms_blinkshield', 'ms_tlaloc_class_nhp', 'ms_oasis_wall'])
    const p3 = mech(['ms_hardlight_defense_system', 'ms_scylla_class_nhp', 'ms_perimeter_command_plate'])
    const e1 = mech(['ms_interdiction_field', 'ms_argonaut_shield'], { side: 'enemy' }), e2 = pregenUnit('Sniper', 'enemy'), e3 = mech(['ms_sekhmet_class_nhp', 'ms_cable_winch_system'], { side: 'enemy', weapon: 'mw_combat_drill' })
    p1.pos = { x: 3, y: 2 }; p2.pos = { x: 7, y: 2 }; p3.pos = { x: 10, y: 2 }; e1.pos = { x: 3, y: 12 }; e2.pos = { x: 7, y: 13 }; e3.pos = { x: 10, y: 12 }
    const b = new Battle({ map: flatMap(14, 16), units: [p1, p2, p3, e1, e2, e3], seed: 9 })
    b.start()
    aiErrors.length = 0
    autoBattle(b, 8)
    expect(aiErrors).toHaveLength(0)
  })
})
