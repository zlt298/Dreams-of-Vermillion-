// Regression tests: gear that did not match its lancer-data text (found in the final bug hunt).
import { describe, expect, it } from 'vitest'
import type { PilotBuild } from '../src/import/compcon'
import { buildMechUnit } from '../src/rules/stats'
import { Battle } from '../src/rules/battle'
import { getScript } from '../src/rules/effects/registry'
import type { Unit } from '../src/rules/types'
import { flatMap, pregenUnit } from './helpers'

function mech(o: { frame?: string; systems?: string[]; talents?: [string, number][]; weapons?: [string, string][]; cbs?: string[] } = {}): Unit {
  const p = {
    id: `t-${Math.random()}`, callsign: 'T', name: 'T', level: 9, mechSkills: [2, 2, 2, 2],
    talents: (o.talents ?? []).map(([id, rank]) => ({ id, rank })), coreBonuses: o.cbs ?? [],
    mech: { name: 'T', frameId: o.frame ?? 'mf_standard_pattern_i_everest', mounts: (o.weapons ?? [['Main', 'mw_assault_rifle']]).map(([size, weaponId]) => ({ type: size, slots: [{ size, weaponId }], bonusEffects: [] })), systems: o.systems ?? [] },
    unknown: [],
  } as unknown as PilotBuild
  return buildMechUnit(p, 'player')
}
function setup(o: Parameters<typeof mech>[0] = {}) {
  const a = mech(o)
  const e = pregenUnit('Assault', 'enemy')
  a.pos = { x: 5, y: 4 }
  e.pos = { x: 5, y: 8 }
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

describe('gear does what its text says', () => {
  it('Siege Specialist 3 (Collateral Damage): characters in the burst take 2 explosive and are knocked back 2', () => {
    const { a, e, b } = setup({ talents: [['t_siege_specialist', 3]], weapons: [['Heavy', 'mw_heavy_machine_gun']] })
    const e2 = pregenUnit('Hacker', 'enemy'); e2.pos = { x: 6, y: 8 }; b.units.push(e2)
    e2.stats.armor = 0
    const hp = e2.hp, pos = { ...e2.pos }
    const ctx = b.newAttackCtx(a, e, { weapon: a.weapons[0], hit: true, crit: true })
    getScript('t_siege_specialist:3')!.afterAttack!(b, a, ctx, 'attacker')
    expect(hp - e2.hp).toBe(2) // script deals 5
    expect(e2.pos).not.toEqual(pos) // and never knocks back
  })

  it('Gunslinger 3 (I Kill With My Heart): the empowered attack gains AP and ignores cover (not Irreducible)', () => {
    const { a, e, b } = setup({ talents: [['t_gunslinger', 3]], weapons: [['Auxiliary', 'mw_pistol']] })
    a.flags.gunslingerReady = true
    const ctx = b.previewAttack(a, a.weapons[0], e).ctx
    expect(ctx.ignoreCover).toBe(true)
    expect(ctx.irreducible).toBeFalsy()
  })

  it('Turret Drones: the Turret Attack deals 3 kinetic automatically (no attack roll)', () => {
    const { a, e, b } = setup({ systems: ['ms_turret_drones'] })
    b.useCustom(a, act(b, a, /Deploy Turret/), { x: 5, y: 5 })
    e.stats.evasion = 40; e.stats.armor = 0
    const hp = e.hp
    getScript('ms_turret_drones')!.afterAnyAttack!(b, a, b.newAttackCtx(a, e, { hit: true, mode: 'skirmish' }))
    expect(hp - e.hp).toBe(3)
  })

  it('//SCORPION V70.1: a hostile tech attack that MISSES you leaves the attacker Impaired (+2 heat)', () => {
    const { a, e, b } = setup({ systems: ['ms___scorpion_v70.1'] })
    a.stats.edef = 40
    b.endTurn(a); b.beginTurn(e)
    e.pos = { x: 5, y: 6 }
    b.invade(e, a)
    expect(b.has(e, 'impaired')).toBe(true)
  })

  it('Manticore CORE: the Charge Die discharges once, then the effect ends', () => {
    const { a, b } = setup({ frame: 'mf_manticore' })
    b.activateCore(a)
    for (let i = 0; i < 5; i++) b.addHeat(a, 1) // 1 -> 6: discharge
    expect(a.flags.chargeDie ?? 0).toBe(0) // script resets it to 1 and keeps charging
  })

  it('Manticore CORE: taking energy damage raises the Charge Die', () => {
    const { a, e, b } = setup({ frame: 'mf_manticore' })
    b.activateCore(a)
    b.applyDamage(a, [{ type: 'Energy', amount: 3 }], { source: e })
    expect(a.flags.chargeDie).toBe(2)
  })

  for (const [id, re, heat] of [
    ['ms_ramjet', /Ramjet/, 2], ['ms_active_camouflage', /Active Camo/, 2], ['ms_asura_class_nhp', /ASURA/, 3],
    ['ms_type_3_projected_shield', /Project Shield/, 1], ['ms_lb_oc_cloaking_field', /Cloaking/, 2],
    ['ms_repulser_field', /Repulser/, 1], ['ms_scylla_class_nhp', /SCYLLA/, 2],
  ] as [string, RegExp, number][]) {
    it(`Heat (Self) is charged when activating ${id} (Heat ${heat})`, () => {
      const { a, e, b } = setup({ systems: [id] })
      const x = act(b, a, re)
      b.useCustom(a, x, x.target === 'enemy' ? e : undefined)
      expect(a.heat).toBe(heat)
    })
  }
  it('LUCIFER-class NHP: the protocol costs Heat 1d3+3', () => {
    const { a, b } = setup({ systems: ['ms_lucifer_class_nhp'] })
    b.useCustom(a, act(b, a, /LUCIFER/))
    expect(a.heat).toBeGreaterThanOrEqual(4)
  })

  it('Fold Knife: the 2-space teleport is an on-crit effect, not granted by any attack', () => {
    const { a, e, b } = setup({ weapons: [['Auxiliary', 'mw_fold_knife']] })
    e.pos = { x: 5, y: 5 }
    e.stats.evasion = 40 // guaranteed miss
    b.skirmish(a, a.weapons[0], { targetId: e.id })
    expect(b.customActions(a).some(c => /Fold Knife Teleport/.test(c.name))).toBe(false)
  })

  it('External Batteries: once destroyed (structure damage) its +5 range for energy weapons is gone', () => {
    const { a, e, b } = setup({ systems: ['ms_external_batteries'], weapons: [['Main', 'mw_thermal_rifle']] })
    const w = a.weapons[0]
    expect(b.weaponReach(a, w)).toBe(10)
    a.hp = 1
    b.applyDamage(a, [{ type: 'Kinetic', amount: 10 }], { source: e })
    expect(a.systems[0].destroyed).toBe(true)
    expect(b.weaponReach(a, w)).toBe(5)
  })

  it('Mourning Cloak Hunter: a melee miss does not use up the 1/round +1d6 on hit', () => {
    const { a, e, b } = setup({ frame: 'mf_mourning_cloak', weapons: [['Main', 'mw_tactical_melee_weapon']] })
    e.pos = { x: 5, y: 5 }
    e.stats.evasion = 40
    b.skirmish(a, a.weapons[0], { targetId: e.id })
    expect(a.flags['round:hunter']).toBeFalsy()
  })

  it("Lesson of Thinking-Tomorrow's Thought: a scripted tech attack hit (Markerlight) primes the next melee attack", () => {
    const { a, e, b } = setup({ cbs: ['cb_the_lesson_of_thinking_tomorrows_thought'], systems: ['ms_markerlight'] })
    e.stats.edef = -10
    b.useCustom(a, act(b, a, /Markerlight/), e)
    expect(a.flags.tomorrow).toBe(e.id)
  })

  it('Hacker 1 (SNOW_CRASH): a scripted invade that consumes Lock On also deals the 2 heat (and leaves no pending flag)', () => {
    const { a, e, b } = setup({ talents: [['t_hacker', 1]], systems: ['ms_neurospike'] })
    e.stats.edef = -10
    b.addStatus(e, 'lockon', 'until_cleared', a)
    b.useCustom(a, act(b, a, /Shrike Code/), e)
    expect(e.heat).toBe(4)
    expect(a.flags.snow).toBeFalsy()
  })

  it("Death's Head Mark for Death: no crit bonus damage against a target within range 5", () => {
    const { a, e, b } = setup({ frame: 'mf_deaths_head' })
    a.flags.markTarget = e.id
    e.pos = { x: 5, y: 6 } // range 2
    e.stats.armor = 0
    const hp = e.hp
    const ctx = b.newAttackCtx(a, e, { weapon: a.weapons[0], hit: true, crit: true, ranged: true })
    getScript('core:mf_deaths_head')!.afterAttack!(b, a, ctx, 'attacker')
    expect(e.hp).toBe(hp)
  })
})
