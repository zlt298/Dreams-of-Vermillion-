// Mech systems that had no behaviour test. Each test quotes the lancer-data clause it checks and rigs every roll the
// outcome depends on.
import { describe, expect, it } from 'vitest'
import type { Battle } from '../../src/rules/battle'
import type { Unit } from '../../src/rules/types'
import { act, arena, flatMap, mech, rigDice } from '../support'

const w = (u: Unit, id: string) => u.weapons.find(x => x.dataId === id)!
const custom = (b: Battle, u: Unit, re: RegExp) => {
  const x = b.customActions(u).find(c => re.test(c.name) || re.test(c.key))
  if (!x) throw new Error(`no action ${re}: ${b.customActions(u).map(c => c.name).join(', ')}`)
  return x
}
const sysOf = (u: Unit, id: string) => u.systems.find(s => s.dataId === id)!
/** an Everest with these systems (player, active) and a plain Everest (enemy) */
function setup(systems: string[], eAt = { x: 5, y: 8 }, o: Parameters<typeof mech>[0] = {}) {
  const a = mech({ systems, ...o })
  const e = mech({ callsign: 'Foe' }, 'enemy')
  const b = arena([[a, { x: 5, y: 4 }], [e, eAt]], { map: flatMap(16, 16) })
  act(b, a)
  return { a, e, b }
}
const toEnemy = (b: Battle, a: Unit, e: Unit) => { b.endTurn(a); act(b, e) }

describe('systems: control', () => {
  it('EMP Pulse: "You become Stunned … all characters within burst 1 … must succeed on a Systems save or also become Stunned"', () => {
    const { a, e, b } = setup(['ms_emp_pulse'], { x: 5, y: 5 })
    rigDice(b, 20, 1)
    b.useCustom(a, custom(b, a, /EMP Pulse/))
    expect(b.has(a, 'stunned')).toBe(true)
    expect(b.has(e, 'stunned')).toBe(true)
  })
  it('Stasis Generator: the target becomes "Stunned" and can\'t be "targeted": attacks on it miss', () => {
    const { a, e, b } = setup(['ms_stasis_generator'])
    const ally = mech({ callsign: 'Ally' })
    ally.pos = { x: 5, y: 6 }
    b.units.push(ally)
    b.useCustom(a, custom(b, a, /Stasis Generator/), ally)
    expect(b.has(ally, 'stunned')).toBe(true)
    toEnemy(b, a, e)
    e.stats.attackBonus = 50
    const r = b.weaponAttack(e, w(e, 'mw_assault_rifle'), { targetId: ally.id }, 'free')
    expect(r.ctxs[0].hit).toBe(false)
  })
  // BUG: "they become Stunned, gain Immunity to all damage and effects, and can't be … targeted" — the attack is only
  // cancelled (a miss), so the Assault Rifle's Reliable 2 still damages the target.
  it.fails('Stasis Generator: "Immunity to all damage" – a Reliable weapon deals nothing to the target', () => {
    const { a, e, b } = setup(['ms_stasis_generator'])
    const ally = mech({ callsign: 'Ally' })
    ally.pos = { x: 5, y: 6 }
    b.units.push(ally)
    b.useCustom(a, custom(b, a, /Stasis Generator/), ally)
    toEnemy(b, a, e)
    b.weaponAttack(e, w(e, 'mw_assault_rifle'), { targetId: ally.id }, 'free')
    expect(ally.hp).toBe(ally.stats.hp)
  })
  it('Stasis Generator: "Hostile characters can succeed on an Engineering save" to avoid it', () => {
    const { a, e, b } = setup(['ms_stasis_generator'], { x: 5, y: 7 })
    rigDice(b, 20, 20)
    b.useCustom(a, custom(b, a, /Stasis Generator/), e)
    expect(b.has(e, 'stunned')).toBe(false)
  })
  it('Stuncrown: hostiles in burst 3 "must succeed on an Agility save or become Jammed, and a Systems save or become Impaired"', () => {
    const { a, e, b } = setup(['ms_stuncrown'], { x: 5, y: 7 })
    rigDice(b, 20, 1, 1)
    const uses = sysOf(a, 'ms_stuncrown').usesLeft!
    b.useCustom(a, custom(b, a, /Stuncrown/))
    expect(b.has(e, 'jammed')).toBe(true)
    expect(b.has(e, 'impaired')).toBe(true)
    expect(sysOf(a, 'ms_stuncrown').usesLeft).toBe(uses - 1) // Limited
  })
  it('Flak Launcher: a flyer "must succeed on an Agility save or immediately land … and additionally become Slowed"', () => {
    const { a, e, b } = setup(['ms_flak_launcher'])
    e.flying = true
    rigDice(b, 20, 1)
    b.useCustom(a, custom(b, a, /Flak/), e)
    expect(e.flying).toBe(false)
    expect(b.has(e, 'slowed')).toBe(true)
  })
  it('Ferrous Lash: a hostile "must succeed on an Agility save or be pulled 5 spaces"', () => {
    const { a, e, b } = setup(['ms_ferrous_lash'], { x: 5, y: 11 })
    rigDice(b, 20, 1)
    b.useCustom(a, custom(b, a, /Ferrous Lash/), e)
    expect(e.pos).toEqual({ x: 5, y: 6 })
  })
  it('Charged Stake: "Hull save or be impaled …, taking 1d6 AP energy damage and becoming Immobilized"', () => {
    const { a, e, b } = setup(['ms_charged_stake'], { x: 5, y: 5 })
    e.stats.armor = 2
    rigDice(b, 20, 1)
    rigDice(b, 6, 4)
    b.useCustom(a, custom(b, a, /Charged Stake/), e)
    expect(e.hp).toBe(e.stats.hp - 4)
    expect(b.has(e, 'immobilized')).toBe(true)
  })
  it('Smite: "You take 1d6 AP energy damage and your target must succeed on a Systems save or become Stunned"', () => {
    const { a, e, b } = setup(['ms_smite'], { x: 5, y: 7 })
    rigDice(b, 20, 20, 1) // the invade roll hits; the Systems save fails
    rigDice(b, 6, 4)
    b.useCustom(a, custom(b, a, /Invade: Smite/), e)
    expect(a.hp).toBe(a.stats.hp - 4)
    expect(b.has(e, 'stunned')).toBe(true)
    expect(e.heat).toBe(2) // the invade's own 2 heat
  })
  it('Viral Logic Suite (Banish): "they take 2 heat for every space they voluntarily move, up to a maximum of 6"', () => {
    const { a, e, b } = setup(['ms_viral_logic_suite'], { x: 5, y: 10 })
    rigDice(b, 20, 20)
    b.useCustom(a, custom(b, a, /Invade: Banish/), e)
    expect(e.heat).toBe(2)
    toEnemy(b, a, e)
    b.move(e, { x: 5, y: 12 })
    expect(e.heat).toBe(2 + 4)
  })
  it('Tracking Bug: on a hit "They can\'t Hide and you ignore their Invisible status"', () => {
    const { a, e, b } = setup(['ms_tracking_bug'])
    rigDice(b, 20, 20)
    b.addStatus(e, 'hidden', 'until_cleared', e)
    b.useCustom(a, custom(b, a, /Tracking Bug/), e)
    expect(b.has(e, 'hidden')).toBe(false)
    b.addStatus(e, 'invisible', 'until_cleared', e)
    a.stats.attackBonus = 50
    rigDice(b, 20, 10) // no invisibility d6 is rolled before this attack roll
    const r = b.weaponAttack(a, w(a, 'mw_assault_rifle'), { targetId: e.id }, 'free')
    expect(r.ctxs[0].hit).toBe(true)
  })
})

describe('systems: damage and attacks', () => {
  it('Siege Ram: "When you Ram, you deal 2 kinetic damage on hit"', () => {
    const { a, e, b } = setup(['ms_siege_ram'], { x: 5, y: 5 })
    a.stats.attackBonus = 50
    rigDice(b, 20, 10)
    b.ram(a, e)
    expect(b.has(e, 'prone')).toBe(true)
    expect(e.hp).toBe(e.stats.hp - 2)
  })
  it('Synthetic Muscle Netting: "You may Ram targets larger than you"', () => {
    const { a, e, b } = setup(['ms_synthetic_muscle_netting'], { x: 5, y: 5 })
    e.stats.size = 2
    rigDice(b, 20, 20)
    b.ram(a, e)
    const plain = setup([], { x: 5, y: 5 })
    plain.e.stats.size = 2
    expect(() => plain.b.ram(plain.a, plain.e)).toThrow(/too large/)
  })
  it('Core Siphon: "+1 accuracy on your first attack roll this turn, but … +1 difficulty on all other attack rolls"', () => {
    const { a, e, b } = setup(['ms_core_siphon'])
    b.useCustom(a, custom(b, a, /Core Siphon/))
    const rifle = w(a, 'mw_assault_rifle')
    expect(b.buildWeaponCtx(a, rifle, e, 'free', false).accuracy).toBe(1)
    const second = b.buildWeaponCtx(a, rifle, e, 'free', false)
    expect([second.accuracy, second.difficulty]).toEqual([0, 1])
  })
  it('Kinetic Compensator: "When you miss with a ranged attack roll, your next ranged attack roll gains +1 accuracy"', () => {
    const { a, e, b } = setup(['ms_kinetic_compensator'])
    const rifle = w(a, 'mw_assault_rifle')
    expect(b.buildWeaponCtx(a, rifle, e, 'free', false).accuracy).toBe(0)
    rigDice(b, 20, 1)
    const r = b.weaponAttack(a, rifle, { targetId: e.id }, 'free')
    expect(r.ctxs[0].hit).toBe(false)
    expect(b.buildWeaponCtx(a, rifle, e, 'free', false).accuracy).toBe(1)
    expect(b.buildWeaponCtx(a, rifle, e, 'free', false).accuracy).toBe(0) // used up
  })
  it('Hunter Lock: "your first successful … attack against them each round deals +3 bonus damage"', () => {
    const { a, e, b } = setup(['ms_hunter_lock'])
    e.stats.hp = 40; e.hp = 40
    b.useCustom(a, custom(b, a, /Hunter Lock/), e)
    a.stats.attackBonus = 0
    rigDice(b, 20, 15, 15)
    rigDice(b, 6, 3, 3)
    const rifle = w(a, 'mw_assault_rifle')
    b.weaponAttack(a, rifle, { targetId: e.id }, 'free')
    expect(e.hp).toBe(40 - 3 - 3)
    b.weaponAttack(a, rifle, { targetId: e.id }, 'free')
    expect(e.hp).toBe(40 - 6 - 3) // second hit this round: no bonus
  })
  it('Roland Chamber: after reloading, the next Loading attack "deals +1d6 explosive bonus damage, and targets must succeed on a Hull save or be knocked Prone"', () => {
    const { a, e, b } = setup(['ms_roland_chamber'], { x: 5, y: 5 }, { weapons: 'mw_catalytic_hammer' })
    const hammer = w(a, 'mw_catalytic_hammer')
    hammer.loaded = false
    b.reload(a, hammer)
    a.stats.attackBonus = 0
    rigDice(b, 20, 15, 1) // attack roll, then the Hull save
    const r = b.weaponAttack(a, hammer, { targetId: e.id }, 'free')
    expect(r.ctxs[0].bonusDamage).toContainEqual({ type: 'Explosive', val: '1d6' })
    expect(b.has(e, 'prone')).toBe(true)
  })
  it('Lightning Generator: "take 1 heat and deal 2 energy to all characters … adjacent to you"', () => {
    const { a, e, b } = setup(['ms_lightning_generator'], { x: 5, y: 5 })
    b.useCustom(a, custom(b, a, /Lightning Generator/))
    expect(a.heat).toBe(1)
    expect(e.hp).toBe(e.stats.hp - 2)
  })
  it('Plasma Gauntlet (Danger Zone): "Agility save or take 4d6 AP energy damage and be knocked Prone … You take half … as heat and become Stunned"', () => {
    const { a, e, b } = setup(['ms_plasma_gauntlet'], { x: 5, y: 5 })
    expect(custom(b, a, /Plasma Gauntlet/).usable(b, a)).toMatch(/Danger Zone/)
    a.stats.heatcap = 20
    a.heat = 10
    e.stats.hp = 40; e.hp = 40; e.stats.armor = 2
    rigDice(b, 6, 3, 3, 3, 3)
    rigDice(b, 20, 1)
    const heat = a.heat
    b.useCustom(a, custom(b, a, /Plasma Gauntlet/), e)
    expect(e.hp).toBe(40 - 12)
    expect(b.has(e, 'prone')).toBe(true)
    expect(a.heat).toBe(heat + 6)
    expect(b.has(a, 'stunned')).toBe(true)
  })
  it('Explosive Vents: on overheating, "Characters within the affected area take 2 heat and 2 burn"', () => {
    const { a, e, b } = setup(['ms_explosive_vents'], { x: 5, y: 5 })
    a.heat = a.stats.heatcap
    b.addHeat(a, 1)
    expect(e.heat).toBe(2)
    expect(e.burn).toBe(2)
  })
})

describe('systems: defence and support', () => {
  it('Singularity Motivator: when hit, "You may immediately teleport to a free space within 1d6 spaces"', () => {
    const { a, e, b } = setup(['ms_singularity_motivator'], { x: 5, y: 8 })
    toEnemy(b, a, e)
    e.stats.attackBonus = 0
    rigDice(b, 20, 15) // hits EVA 10 without a critical
    rigDice(b, 6, 3, 3) // the rifle's damage and the teleport distance
    const reactions = a.reactionsLeft
    b.weaponAttack(e, w(e, 'mw_assault_rifle'), { targetId: a.id }, 'free')
    expect(a.pos).toEqual({ x: 5, y: 1 }) // 3 spaces, away from the attacker
    expect(a.reactionsLeft).toBe(reactions - 1)
  })
  it('Black ICE Module: tech attacks against you get +1 difficulty, +1 more each time, "resetting to +1 difficulty" past +3', () => {
    const { a, e, b } = setup(['ms_black_ice_module'])
    toEnemy(b, a, e)
    const diffs = [1, 2, 3, 4].map(() => b.techAttackRoll(e, a, 'probe').difficulty)
    expect(diffs).toEqual([1, 2, 3, 1])
  })
  it('Stasis Bolt: Interdiction Point – "Make a contested ranged attack roll: if you win …, the attack automatically misses"', () => {
    const { a, e, b } = setup(['ms_stasis_bolt'])
    b.useCustom(a, custom(b, a, /Charge Stasis Bolt/))
    const ally = mech({ callsign: 'Ally' })
    ally.pos = { x: 6, y: 6 }
    b.units.push(ally)
    toEnemy(b, a, e)
    e.stats.attackBonus = 0
    rigDice(b, 20, 12, 20) // the attack (12 hits), then the bolt's contested roll
    const r = b.weaponAttack(e, w(e, 'mw_assault_rifle'), { targetId: ally.id }, 'free')
    expect(r.ctxs[0].hit).toBe(false)
    expect(a.flags.stasisBolt).toBe(false)
  })
  it('Reactive Weave: when Braced, "you become Invisible until the end of your next turn"', () => {
    const { a, e, b } = setup(['ms_reactive_weave'])
    b.addStatus(a, 'braced', 'until_cleared', a)
    toEnemy(b, a, e)
    b.buildWeaponCtx(e, w(e, 'mw_assault_rifle'), a, 'free', false)
    expect(b.has(a, 'invisible')).toBe(true)
  })
  it('Aceso Stabilizer: an ally within range 5 gains "Overshield equal to your GRIT + 4"', () => {
    const { a, b } = setup(['ms_aceso_stabilizer'])
    const ally = mech({ callsign: 'Ally' })
    ally.pos = { x: 5, y: 7 }
    b.units.push(ally)
    const uses = sysOf(a, 'ms_aceso_stabilizer').usesLeft!
    b.useCustom(a, custom(b, a, /Aceso/), ally)
    expect(ally.overshield).toBe(a.stats.grit + 4)
    expect(sysOf(a, 'ms_aceso_stabilizer').usesLeft).toBe(uses - 1)
  })
  // BUG: "While they have this Overshield they gain Immunity to Impaired and Jammed." (flags.aceso is set but never read)
  it.fails('Aceso Stabilizer: Immunity to Impaired and Jammed while the Overshield lasts', () => {
    const { a, e, b } = setup(['ms_aceso_stabilizer'])
    b.useCustom(a, custom(b, a, /Aceso/), a)
    expect(a.overshield).toBeGreaterThan(0)
    b.addStatus(a, 'jammed', 'until_cleared', e)
    expect(b.has(a, 'jammed')).toBe(false)
  })
  it('Jericho Deployable Cover: "two sections of Size 1 hard cover … Each section … with 5 Evasion and 10 HP"', () => {
    const { a, b } = setup(['ms_pattern_a_jericho_deployable_cover'])
    b.useCustom(a, custom(b, a, /Jericho/), { x: 5, y: 5 })
    const cover = b.alive().filter(u => u.ownerId === a.id && u.flags.isCover)
    expect(cover).toHaveLength(2)
    expect(cover.map(c => [c.stats.size, c.stats.evasion, c.hp])).toEqual([[1, 5, 10], [1, 5, 10]])
    for (const c of cover) expect(b.adjacent(a, c)).toBe(true)
  })
  it('Redundant Systems Upgrade: "Expend a charge to Stabilize as a quick action" (clears heat and Exposed)', () => {
    const { a, b } = setup(['ms_redundant_systems_upgrade'])
    a.heat = 5
    b.addStatus(a, 'exposed', 'until_cleared', a)
    const uses = sysOf(a, 'ms_redundant_systems_upgrade').usesLeft!
    b.useCustom(a, custom(b, a, /Quick Stabilize/))
    expect(a.heat).toBe(0)
    expect(b.has(a, 'exposed')).toBe(false)
    expect(sysOf(a, 'ms_redundant_systems_upgrade').usesLeft).toBe(uses - 1)
  })
  it('Auto-Cooler: "As long as you don\'t take damage, move, or exceed your Heat Cap, you clear all heat at the start of your next turn"', () => {
    const { a, e, b } = setup(['ms_auto_cooler'])
    a.heat = 4
    b.useCustom(a, custom(b, a, /Auto-Cooler/))
    toEnemy(b, a, e); b.endTurn(e); act(b, a)
    expect(a.heat).toBe(0)
    a.heat = 4
    b.useCustom(a, custom(b, a, /Auto-Cooler/))
    b.applyDamage(a, [{ type: 'Kinetic', amount: 1 }], { source: e })
    toEnemy(b, a, e); b.endTurn(e); act(b, a)
    expect(a.heat).toBe(4)
  })
  it('AGNI-class NHP: "clear all heat at the end of your turn …; characters within … must succeed on an Engineering save or take 2 burn"', () => {
    const { a, e, b } = setup(['ms_agni_class_nhp'], { x: 5, y: 6 })
    a.heat = 5
    b.useCustom(a, custom(b, a, /AGNI/))
    rigDice(b, 20, 1)
    b.endTurn(a)
    expect(a.heat).toBe(0)
    expect(e.burn).toBe(2)
    expect(b.distance(a, e)).toBeGreaterThan(2) // pushed outside the burst 2
  })
  it('Siege Stabilizers: "+5 range, but you become Immobilized … can\'t make ranged attacks against … within range 5"', () => {
    const { a, e, b } = setup(['ms_siege_stabilizers'], { x: 5, y: 7 })
    const rifle = w(a, 'mw_assault_rifle')
    b.useCustom(a, custom(b, a, /Extend Stabilizers/))
    expect(b.has(a, 'immobilized')).toBe(true)
    expect(b.weaponReach(a, rifle)).toBe(15)
    a.stats.attackBonus = 50
    const r = b.weaponAttack(a, rifle, { targetId: e.id }, 'free')
    expect(r.ctxs[0].hit).toBe(false)
  })
  // BUG: "can't make ranged attacks against or centered on characters … within range 5" — the attack is made and
  // cancelled as a miss, so Reliable damage still lands.
  it.fails('Siege Stabilizers: no attack at all within range 5 (Reliable damage does not land)', () => {
    const { a, e, b } = setup(['ms_siege_stabilizers'], { x: 5, y: 7 })
    b.useCustom(a, custom(b, a, /Extend Stabilizers/))
    b.weaponAttack(a, w(a, 'mw_assault_rifle'), { targetId: e.id }, 'free')
    expect(e.hp).toBe(e.stats.hp)
  })
  it('Stable Structure: "+1 Accuracy on saves to avoid Prone or Knockback" (Hull saves)', () => {
    const { a, b } = setup(['ms_stable_structure'])
    rigDice(b, 20, 10)
    rigDice(b, 6, 6) // the accuracy die
    expect(b.save(a, 'hull', 10 + a.stats.hull + 6)).toBe(true)
  })
  it('Rapid Burst Jump Jet System: "You can fly when you Boost", landing at the end of the turn', () => {
    const { a, e, b } = setup(['ms_rapid_burst_jump_jet_system'])
    b.boost(a)
    expect(a.flying).toBe(true)
    b.endTurn(a)
    expect(a.flying).toBe(false)
    void e
  })
  it('Caltrop Launcher: the Burst 1 area "becomes difficult terrain" and mechs in it take 1d3 AP explosive', () => {
    const { a, e, b } = setup(['ms_caltrop_launcher'], { x: 5, y: 8 })
    b.useCustom(a, custom(b, a, /Caltrop/), { x: 5, y: 8 })
    expect(b.stepCost(e, { x: 5, y: 9 }, { x: 5, y: 8 })).toBe(2)
    rigDice(b, 3, 2)
    toEnemy(b, a, e) // the enemy starts its turn inside the field
    expect(e.hp).toBe(e.stats.hp - 2)
  })
})

describe('systems: tech and movement', () => {
  it('Scanner Swarm: "+1 accuracy on tech attacks against adjacent characters"', () => {
    const { a, e, b } = setup(['ms_scanner_swarm'], { x: 5, y: 5 })
    expect(b.techAttackRoll(a, e, 'probe').accuracy).toBe(1)
    e.pos = { x: 5, y: 7 }
    expect(b.techAttackRoll(a, e, 'probe').accuracy).toBe(0)
  })
  it('Hunter Logic Suite (Terrify): "Until the end of their next turn, they become Impaired"', () => {
    const { a, e, b } = setup(['ms_hunter_logic_suite'])
    rigDice(b, 20, 20)
    b.useCustom(a, custom(b, a, /Invade: Terrify/), e)
    expect(b.has(e, 'impaired')).toBe(true)
  })
  it('Hunter Logic Suite (Stalk Prey): "They treat you as Invisible until you next take damage from them"', () => {
    const { a, e, b } = setup(['ms_hunter_logic_suite'])
    rigDice(b, 20, 20)
    b.useCustom(a, custom(b, a, /Invade: Stalk Prey/), e)
    toEnemy(b, a, e)
    expect(b.buildWeaponCtx(e, w(e, 'mw_assault_rifle'), a, 'free', false).forceInvisible).toBe(true)
    b.applyDamage(a, [{ type: 'Kinetic', amount: 1 }], { source: e })
    expect(b.buildWeaponCtx(e, w(e, 'mw_assault_rifle'), a, 'free', false).forceInvisible).toBeFalsy()
  })
  it('Eye of Horus: "characters within Sensors don\'t benefit from Hidden … against you"', () => {
    const { a, e, b } = setup(['ms_eye_of_horus'])
    b.addStatus(e, 'hidden', 'until_cleared', e)
    b.useCustom(a, custom(b, a, /Eye of Horus/))
    expect(b.has(e, 'hidden')).toBe(false)
  })
  it('Bulwark Mods: "ignore difficult terrain"; High-Stress Mag Clamps: climb "as flat ground"', () => {
    const map = flatMap(16, 16, (x, y) => (x === 5 && y === 6 ? { h: 3 } : undefined))
    const plain = mech({})
    const a = mech({ systems: ['ms_bulwark_mods', 'ms_high_stress_mag_clamps'] })
    const b = arena([[a, { x: 5, y: 4 }], [plain, { x: 8, y: 4 }]], { map })
    b.addArea({ kind: 'difficult', tiles: [{ x: 5, y: 5 }, { x: 8, y: 5 }], ownerId: a.id })
    expect(b.stepCost(plain, { x: 8, y: 4 }, { x: 8, y: 5 })).toBe(2)
    expect(b.stepCost(a, { x: 5, y: 4 }, { x: 5, y: 5 })).toBe(1)
    expect(b.stepCost(plain, { x: 5, y: 5 }, { x: 5, y: 6 })).toBeGreaterThan(b.stepCost(a, { x: 5, y: 5 }, { x: 5, y: 6 }))
  })
})
