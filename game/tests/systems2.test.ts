// Systems scripted in rules/effects/scripts/systems2.ts.
import { describe, expect, it } from 'vitest'
import type { PilotBuild } from '../src/import/compcon'
import { buildMechUnit } from '../src/rules/stats'
import { Battle } from '../src/rules/battle'
import { autoBattle, aiErrors } from '../src/ai/ai'
import type { Unit } from '../src/rules/types'
import { flatMap, pregenUnit } from './helpers'

function mech(systems: string[], opts: { side?: 'player' | 'enemy'; name?: string; size?: number } = {}): Unit {
  const p = {
    id: `t-${Math.random()}`, callsign: opts.name ?? 'Tester', name: 'T', level: 6, mechSkills: [2, 2, 2, 2], talents: [], coreBonuses: [],
    mech: { name: 'T', frameId: 'mf_standard_pattern_i_everest', mounts: [{ type: 'Main', slots: [{ size: 'Main', weaponId: 'mw_assault_rifle' }], bonusEffects: [] }], systems },
    unknown: [],
  } as unknown as PilotBuild
  const u = buildMechUnit(p, opts.side ?? 'player')
  if (opts.size) u.stats.size = opts.size
  return u
}
function setup(systems: string[], opts: { size?: number } = {}) {
  const a = mech(systems, opts)
  const e = pregenUnit('Assault', 'enemy')
  a.pos = { x: 5, y: 4 }
  e.pos = { x: 5, y: 8 }
  e.stats.hull = -20; e.stats.agi = -20; e.stats.sys = -20; e.stats.eng = -20
  const b = new Battle({ map: flatMap(16, 16), units: [a, e], seed: 13 })
  b.start()
  b.beginTurn(a)
  return { a, e, b }
}
const act = (b: Battle, u: Unit, re: RegExp) => {
  const x = b.customActions(u).find(c => re.test(c.name) || re.test(c.key))
  if (!x) throw new Error(`no action ${re}: ${b.customActions(u).map(c => c.name).join(', ')}`)
  return x
}
const toEnemyTurn = (b: Battle, a: Unit, e: Unit) => { b.endTurn(a); b.beginTurn(e) }
const rifle = (u: Unit) => u.weapons.find(w => w.dataId === 'mw_assault_rifle')!

describe('systems', () => {
  it('Whitewash Sealant slows a hostile that fails its save', () => {
    const { a, e, b } = setup(['ms_whitewash_sealant_spray'])
    e.pos = { x: 5, y: 7 }
    b.useCustom(a, act(b, a, /Whitewash/), e.pos)
    expect(b.has(e, 'slowed')).toBe(true)
  })
  it('BB charges: thermal grenade and a remote breaching charge', () => {
    const { a, e, b } = setup(['ms_bb_breach_blast_charges'])
    const hp = e.hp
    b.useCustom(a, act(b, a, /Thermal Grenade/), { x: 5, y: 8 })
    expect(e.hp).toBeLessThan(hp)
    b.useCustom(a, act(b, a, /Plant Breaching/), { x: 5, y: 5 })
    expect(act(b, a, /Detonate Breaching/)).toBeDefined()
  })
  it('Magnetic Shield gives soft cover from attacks across it', () => {
    const { a, e, b } = setup(['ms_magnetic_shield'])
    b.useCustom(a, act(b, a, /Magnetic Shield/), { x: 5, y: 5 })
    expect(b.cover(e, a)).not.toBe('none')
  })
  it('Flicker Field: after moving, the next attack treats you as Invisible', () => {
    const { a, e, b } = setup(['ms_flicker_field_projector'])
    b.move(a, { x: 6, y: 4 })
    expect(a.flags.flicker).toBe(true)
    toEnemyTurn(b, a, e)
    b.weaponAttack(e, rifle(e), { targetId: a.id }, 'free')
    expect(a.flags.flicker).toBe(false)
  })
  it("Flash Grenade: characters inside can't attack out", () => {
    const { a, e, b } = setup(['ms_flash_charges'])
    b.useCustom(a, act(b, a, /Flash Grenade/), { x: 5, y: 8 })
    toEnemyTurn(b, a, e)
    const r = b.weaponAttack(e, rifle(e), { targetId: a.id }, 'free')
    expect(r.ctxs[0]?.hit).toBe(false)
  })
  it('Flash Mine blinds a character that approaches it', () => {
    const { a, e, b } = setup(['ms_flash_charges'])
    b.useCustom(a, act(b, a, /Flash Mine/), { x: 5, y: 6 })
    toEnemyTurn(b, a, e)
    b.move(e, { x: 5, y: 7 })
    expect(b.isBlinded(e)).toBe(true)
    expect(b.validTarget(e, rifle(e), a)).toMatch(/Blinded/)
  })
  it('Javelin Rockets hit the first character to enter a marked space', () => {
    const { a, e, b } = setup(['ms_javelin_rockets'])
    b.useCustom(a, act(b, a, /Javelin/), { x: 5, y: 7 })
    toEnemyTurn(b, a, e)
    e.stats.armor = 0
    const hp = e.hp
    b.move(e, { x: 5, y: 7 })
    expect(e.hp).toBe(hp - 3)
  })
  it("Retractable Profile: you can't attack", () => {
    const { a, b } = setup(['ms_retractable_profile'])
    b.useCustom(a, act(b, a, /Retractable Profile/))
    expect(b.weaponUsable(a, rifle(a))).toMatch(/Cannot attack/)
  })
  it('FADE Cloak: intangible characters cannot be targeted or damaged', () => {
    const { a, e, b } = setup(['ms_fade_cloak'])
    b.useCustom(a, act(b, a, /FADE Cloak/))
    expect(b.validTarget(e, rifle(e), a)).toBe('Intangible')
    const hp = a.hp
    b.applyDamage(a, [{ type: 'Kinetic', amount: 5 }])
    expect(a.hp).toBe(hp)
  })
  it('ATHENA: hostiles ending their turn in the simulacrum are Locked On', () => {
    const { a, e, b } = setup(['ms_athena_class_nhp'])
    b.useCustom(a, act(b, a, /Simulacrum/), e.pos)
    toEnemyTurn(b, a, e)
    b.endTurn(e)
    expect(b.has(e, 'lockon')).toBe(true)
  })
  it('Swarm Body: hostiles starting next to you save or take kinetic', () => {
    const { a, e, b } = setup(['ms_swarm_body'])
    e.pos = { x: 5, y: 5 }
    e.stats.armor = 0
    b.useCustom(a, act(b, a, /Swarm Body/))
    const hp = e.hp
    toEnemyTurn(b, a, e)
    expect(e.hp).toBe(hp - 3)
  })
  it('Monitor Module: when the guarded ally is attacked, you Skirmish the attacker', () => {
    const { a, e, b } = setup(['ms_monitor_module'])
    const ally = pregenUnit('Sniper'); ally.pos = { x: 6, y: 4 }; ally.activationsLeft = 0; b.units.push(ally)
    b.useCustom(a, act(b, a, /Monitor Module/), ally)
    toEnemyTurn(b, a, e)
    b.weaponAttack(e, rifle(e), { targetId: ally.id }, 'free')
    expect(a.reactionsLeft).toBe(0)
  })
  it('Mesmer Beacon: the target can only move toward you', () => {
    const { a, e, b } = setup(['ms_mesmer_charges'])
    e.pos = { x: 5, y: 8 }
    b.useCustom(a, act(b, a, /Mesmer Beacon/), e)
    toEnemyTurn(b, a, e)
    expect(() => b.move(e, { x: 5, y: 10 })).toThrow(/Mesmerized/)
    b.move(e, { x: 5, y: 6 })
  })
  it('SISYPHUS: an ally’s save uses the stored high roll', () => {
    const { a, b } = setup(['ms_sisyphus_class_nhp'])
    a.flags.bend = { vals: [20, 1], until: b.round + 1, uses: 2 }
    expect(b.save(a, 'hull', 30)).toBe(false)
    expect(a.flags.bend.vals).toEqual([1])
  })
  it('Roller Grenade detonates on the first character along its line', () => {
    const { a, e, b } = setup(['ms_roller_directed_payload_charges'])
    const hp = e.hp
    b.useCustom(a, act(b, a, /Roller Grenade/), { x: 5, y: 10 })
    expect(e.hp).toBeLessThan(hp)
  })
  it('Clamp Bombs detonate at the end of the target’s turn unless it moves 4+', () => {
    const { a, e, b } = setup(['ms_clamp_bombs'])
    e.stats.armor = 0
    b.useCustom(a, act(b, a, /Clamp Bombs/), e)
    toEnemyTurn(b, a, e)
    const hp = e.hp
    b.endTurn(e)
    expect(e.hp).toBeLessThan(hp)
  })
  it('Tesseract Pinpoint Focus lifts a hostile into the air', () => {
    const { a, e, b } = setup(['ms_tesseract'])
    b.useCustom(a, act(b, a, /Pinpoint/), e)
    expect(e.flying).toBe(true)
    expect(b.has(e, 'immobilized')).toBe(true)
  })
  it('Blinkshield and Hardlight Defense stop attacks across their border', () => {
    for (const [s, re] of [['ms_blinkshield', /Blinkshield/], ['ms_hardlight_defense_system', /Hardlight/]] as const) {
      const { a, e, b } = setup([s])
      b.useCustom(a, act(b, a, re))
      e.pos = { x: 5, y: 11 }
      toEnemyTurn(b, a, e)
      const r = b.weaponAttack(e, { ...rifle(e), profiles: rifle(e).profiles.map(p => ({ ...p, range: [{ type: 'Range', val: 20 }] as any })) }, { targetId: a.id }, 'free')
      expect(r.ctxs[0]?.hit).toBeFalsy()
    }
  })
  it('Flash Anchor stops an ally being knocked back', () => {
    const { a, e, b } = setup(['ms_flash_anchor'])
    const ally = pregenUnit('Sniper'); ally.pos = { x: 6, y: 6 }; b.units.push(ally)
    b.forceMove(ally, e, 3, 1)
    expect(ally.pos).toEqual({ x: 6, y: 6 })
    expect(a.heat).toBe(2)
  })
  it('NOAH: ranged attacks on you cost heat and sometimes miss; misses hurt the attacker', () => {
    const { a, e, b } = setup(['ms_noah_class_nhp'])
    b.useCustom(a, act(b, a, /Diluvian Ark/))
    toEnemyTurn(b, a, e)
    b.weaponAttack(e, rifle(e), { targetId: a.id }, 'free')
    expect(a.heat).toBeGreaterThanOrEqual(1)
  })
  it('Armor-Lock: after Bracing you auto-pass Hull/Agility saves', () => {
    const { a, b } = setup(['ms_armor_lock_plating'])
    a.flags.autoSaveUntil = b.round + 1
    a.stats.hull = -30
    expect(b.save(a, 'hull', 25)).toBe(true)
  })
  it('MULE Harness: an ally rides along when you move', () => {
    const { a, b } = setup(['ms_mule_harness'], { size: 2 })
    const rider = pregenUnit('Sniper'); rider.pos = { x: 7, y: 4 }; b.units.push(rider)
    rider.stats.size = 1
    b.move(a, { x: 5, y: 3 })
    b.endTurn(a)
    ;(b as any).currentSide = 'player'; a.activationsLeft = 1
    b.beginTurn(rider)
    b.useCustom(rider, act(b, rider, /Ride/))
    expect(rider.pos).toEqual(a.pos)
    b.endTurn(rider)
    ;(b as any).currentSide = 'player'
    b.beginTurn(a)
    b.move(a, { x: 5, y: 1 })
    expect(rider.pos).toEqual(a.pos)
  })
  it('Ammo Case: SABOT costs 2 charges', () => {
    const { a, e, b } = setup(['ms_walking_armory_1', 'ms_walking_armory_2'])
    const s = a.systems.find(x => x.dataId === 'ms_walking_armory_1')!
    s.usesLeft = 6
    b.useCustom(a, act(b, a, /SABOT/))
    e.pos = { x: 5, y: 7 }
    b.weaponAttack(a, rifle(a), { targetId: e.id }, 'free')
    expect(s.usesLeft).toBeLessThanOrEqual(4)
  })
  it('AI battles with every new system without errors', () => {
    aiErrors.length = 0
    const sets = [
      ['ms_whitewash_sealant_spray', 'ms_bb_breach_blast_charges', 'ms_magnetic_shield', 'ms_flicker_field_projector'],
      ['ms_flash_charges', 'ms_javelin_rockets', 'ms_tlaloc_class_nhp', 'ms_fade_cloak'],
      ['ms_athena_class_nhp', 'ms_swarm_body', 'ms_h0r_os_system_upgrade_ii', 'ms_h0r_os_system_upgrade_iii', 'ms_monitor_module'],
      ['ms_mesmer_charges', 'ms_law_of_blades', 'ms_sisyphus_class_nhp', 'ms_roller_directed_payload_charges', 'ms_grounding_charges'],
      ['ms_clamp_bombs', 'ms_tesseract', 'ms_blinkshield', 'ms_flash_anchor', 'ms_hardlight_defense_system', 'ms_noah_class_nhp'],
      ['ms_armor_lock_plating', 'ms_cable_winch_system', 'ms_mule_harness', 'ms_retractable_profile', 'ms_sekhmet_class_nhp', 'ms_walking_armory_1'],
    ]
    const ps = sets.map((s, i) => { const u = mech(s, { name: `P${i}` }); u.pos = { x: 1 + i * 2, y: 1 }; return u })
    const es = sets.map((s, i) => { const u = mech(s, { name: `E${i}`, side: 'enemy' }); u.pos = { x: 1 + i * 2, y: 18 }; return u })
    const b = new Battle({ map: flatMap(16, 20), units: [...ps, ...es], seed: 41 })
    b.start()
    autoBattle(b, 10)
    expect(aiErrors).toEqual([])
  })
})
