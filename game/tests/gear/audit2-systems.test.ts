// Audit 2, mech systems: each test quotes the lancer-data clause (the errata) it pins and rigs every roll the outcome
// depends on. Rulings the owner made on ambiguous items are named as such.
import { describe, expect, it } from 'vitest'
import type { Battle } from '../../src/rules/battle'
import { getScript } from '../../src/rules/effects/registry'
import { chebyshev, footprint } from '../../src/rules/grid'
import type { Unit } from '../../src/rules/types'
import { newRun, recordBattle, squadUnits, fullRepair } from '../../src/run/run'
import { act, arena, flatMap, mech, pilot, rigDice } from '../support'

const w = (u: Unit, id: string) => u.weapons.find(x => x.dataId === id)!
const custom = (b: Battle, u: Unit, re: RegExp) => {
  const x = b.customActions(u).find(c => re.test(c.name) || re.test(c.key))
  if (!x) throw new Error(`no action ${re}: ${b.customActions(u).map(c => c.name).join(', ')}`)
  return x
}
const sysOf = (u: Unit, id: string) => u.systems.find(s => s.dataId === id)!
/** an Everest with these systems (player, active) and a plain Everest (enemy) */
function setup(systems: string[], eAt = { x: 5, y: 8 }, o: Parameters<typeof mech>[0] = {}, eo: Parameters<typeof mech>[0] = {}) {
  const a = mech({ systems, ...o })
  const e = mech({ callsign: 'Foe', ...eo }, 'enemy')
  const b = arena([[a, { x: 5, y: 4 }], [e, eAt]], { map: flatMap(16, 16) })
  act(b, a)
  return { a, e, b }
}
const toEnemy = (b: Battle, a: Unit, e: Unit) => { b.endTurn(a); act(b, e) }
const join = (b: Battle, u: Unit, at: { x: number; y: number }) => { u.pos = { ...at }; b.units.push(u); return u }
/** A tall wall along row 7, so the enemy (row 8) can stay Hidden from the attacker (row 4). */
const wallRow7 = (b: Battle) => { for (let x = 0; x < 16; x++) b.map.tiles[7 * 16 + x].h = 4; b.invalidateTerrain() }

describe('audit 2 systems: GMS and IPS-N', () => {
  it('Custom Paint Job: on a 6 "you return to 1 HP and ignore the damage" — no structure check follows', () => {
    const { a, b } = setup(['ms_custom_paint_job'])
    a.hp = 3
    rigDice(b, 6, 6)
    b.applyDamage(a, [{ type: 'Kinetic', amount: 10 }], { ap: true })
    expect(a.structure).toBe(a.stats.structure)
    expect(a.hp).toBe(1)
    expect(b.has(a, 'impaired')).toBe(false) // a structure check with no marked structure would be a Glancing Blow
  })

  it('HyperDense Armor: "you become Slowed and deal half damage, Heat and Burn to characters beyond Range 3"; deactivating clears Slowed', () => {
    const { a, e, b } = setup(['ms_hyperdense_armor'], { x: 5, y: 9 })
    b.useCustom(a, custom(b, a, /^HyperDense Armor/))
    expect(b.has(a, 'slowed')).toBe(true)
    e.stats.armor = 0; e.stats.heatcap = 30
    const hit = () => { const hp = e.hp; b.applyDamage(e, [{ type: 'Energy', amount: 10 }, { type: 'Heat', amount: 4 }], { source: a, attack: b.newAttackCtx(a, e, {}) }); return hp - e.hp }
    expect(hit()).toBe(5)
    expect(e.heat).toBe(2)
    e.pos = { x: 5, y: 7 } // within range 3: full damage
    expect(hit()).toBe(10)
    b.useCustom(a, custom(b, a, /Deactivate HyperDense/))
    expect(b.has(a, 'slowed')).toBe(false)
  })

  it('Charged Stake: no free save at the end of its turns; it "can successfully repeat this save as a full action"; "only one character at a time"', () => {
    const { a, e, b } = setup(['ms_charged_stake'], { x: 5, y: 5 })
    const e2 = join(b, mech({ callsign: 'Foe2' }, 'enemy'), { x: 6, y: 5 })
    rigDice(b, 20, 1); rigDice(b, 6, 3)
    b.useCustom(a, custom(b, a, /Charged Stake/), e)
    expect(b.has(e, 'immobilized')).toBe(true)
    toEnemy(b, a, e)
    rigDice(b, 6, 2) // 1d6 AP energy at the end of its turn, and no save is rolled
    const hp = e.hp
    b.endTurn(e)
    expect(e.hp).toBe(hp - 2)
    expect(b.has(e, 'immobilized')).toBe(true)
    // a second victim: the first one is freed
    act(b, a)
    rigDice(b, 20, 1); rigDice(b, 6, 1)
    b.useCustom(a, custom(b, a, /Charged Stake/), e2)
    expect(b.has(e2, 'immobilized')).toBe(true)
    expect(b.has(e, 'immobilized')).toBe(false)
    b.endTurn(a); act(b, e2)
    rigDice(b, 20, 20)
    b.useCustom(e2, custom(b, e2, /Pull Out the Stake/))
    expect(b.has(e2, 'immobilized')).toBe(false)
  })

  it('Leviathan: the Standard profile "can be used with Skirmish" although Superheavy; the spin-up switch costs a quick action and Slows', () => {
    const a = mech({ weapons: [['Heavy', 'mw_leviathan_heavy_assault_cannon']] })
    const e = mech({ callsign: 'Foe' }, 'enemy')
    const b = arena([[a, { x: 5, y: 4 }], [e, { x: 5, y: 8 }]], { map: flatMap(16, 16) })
    act(b, a)
    const lev = w(a, 'mw_leviathan_heavy_assault_cannon')
    expect(lev.size).toBe('Superheavy')
    expect(b.skirmish(a, lev, { targetId: e.id }).ok).toBe(true)
    b.endTurn(a); act(b, a)
    const spin = custom(b, a, /Spin-Up Mode/)
    expect(spin.activation).toBe('quick')
    b.useCustom(a, spin)
    expect(b.has(a, 'slowed')).toBe(true)
    expect(b.skirmish(a, lev, { targetId: e.id }).reason).toMatch(/Barrage/)
  })

  it('Caltrop Launcher: mechs take 1d3 AP explosive entering it the first time in a round and ending a turn in it; Whitewash leaves it', () => {
    const { a, e, b } = setup(['ms_caltrop_launcher', 'ms_whitewash_sealant_spray'], { x: 5, y: 11 })
    b.useCustom(a, custom(b, a, /Caltrop/), { x: 5, y: 8 })
    b.useCustom(a, custom(b, a, /Whitewash/), { x: 5, y: 8 })
    expect(b.areas.some(x => x.tag === 'caltrops')).toBe(true)
    toEnemy(b, a, e)
    e.stats.armor = 2
    e.moveLeft = 20
    rigDice(b, 3, 3)
    const hp = e.hp
    b.move(e, { x: 5, y: 9 })
    expect(e.hp).toBe(hp - 3) // AP: Armor doesn't apply
    b.move(e, { x: 5, y: 10 }); b.move(e, { x: 5, y: 9 }) // entering again the same round: nothing
    expect(e.hp).toBe(hp - 3)
    rigDice(b, 3, 1)
    b.endTurn(e)
    expect(e.hp).toBe(hp - 4)
  })

  it('Webjaw Snare: "it arms at the end of your turn"; then a hostile moving over it saves (Hull) or takes 1d6 AP kinetic and is Immobilized', () => {
    const { a, e, b } = setup(['ms_webjaw_snare'], { x: 5, y: 8 })
    b.useCustom(a, custom(b, a, /Webjaw/), { x: 5, y: 5 })
    b.forceMove(e, a, 3, -1) // dragged across it before it arms
    expect(b.has(e, 'immobilized')).toBe(false)
    b.forceMove(e, a, 3, 1)
    b.endTurn(a); act(b, e)
    rigDice(b, 20, 1); rigDice(b, 6, 4)
    const hp = e.hp
    b.move(e, { x: 5, y: 5 })
    expect(b.has(e, 'immobilized')).toBe(true)
    expect(e.hp).toBe(hp - 4)
  })

  it('Synthetic Muscle Netting: grappling, you count one Size larger than a same-Size target and as large as a larger one', () => {
    const { a, e, b } = setup(['ms_synthetic_muscle_netting'], { x: 5, y: 5 })
    const g = { a: a.id, d: e.id, winner: e.id }
    b.grapples.push(g)
    expect(b.grappleDominance(g)).toBe('attackers') // 2 against 1: the contest doesn't matter
    e.stats.size = 2
    expect(b.grappleDominance(g)).toBe('defender') // the same Size: the contest decides (the target won it)
    g.winner = a.id
    expect(b.grappleDominance(g)).toBe('attackers') // without the netting, Size 1 can't hold Size 2 at all
  })

  it('Jericho cover: two sections "adjacent to you and to each other" on any side of a Size 2 mech; "picked up again as a full action"', () => {
    const { a, b } = setup(['ms_pattern_a_jericho_deployable_cover'])
    a.stats.size = 2
    b.useCustom(a, custom(b, a, /Deploy Jericho/), { x: 7, y: 5 })
    const secs = b.alive().filter(d => d.flags.dataName === 'Jericho Deployable Cover')
    expect(secs.length).toBe(2)
    for (const s of secs) expect(footprint(a).some(q => chebyshev(q, s.pos) === 1)).toBe(true)
    expect(chebyshev(secs[0].pos, secs[1].pos)).toBe(1)
    b.endTurn(a); act(b, a)
    b.useCustom(a, custom(b, a, /Pick Up Jericho/))
    expect(b.alive().some(d => d.flags.dataName === 'Jericho Deployable Cover')).toBe(false)
    expect(a.actionsLeft).toBe(0)
  })

  it('Whitewash on a free space: "fires within blast 1 are extinguished and the area becomes difficult terrain for the rest of the scene"', () => {
    const { a, e, b } = setup(['ms_whitewash_sealant_spray'])
    b.addArea({ kind: 'damage', tiles: [{ x: 5, y: 7 }], damage: '2', ownerId: e.id })
    b.useCustom(a, custom(b, a, /Whitewash/), { x: 5, y: 7 })
    expect(b.areas.some(x => x.kind === 'damage')).toBe(false)
    expect(b.stepCost(e, { x: 5, y: 9 }, { x: 5, y: 8 })).toBe(2)
  })

  it('Turret Drones (owner ruling): each turret has its own 1/round Turret Attack; the owner spends no reaction', () => {
    const { a, e, b } = setup(['ms_turret_drones'])
    b.useCustom(a, custom(b, a, /Deploy Turret/), { x: 6, y: 6 })
    const r = a.reactionsLeft
    a.stats.attackBonus = 50
    const hp = e.hp
    const res = b.weaponAttack(a, w(a, 'mw_assault_rifle'), { targetId: e.id }, 'free')
    expect(hp - e.hp).toBe(res.ctxs[0].damageDealt! + 3)
    expect(a.reactionsLeft).toBe(r)
  })

  it('Type-3 Projected Shield: "all ranged or melee attacks" between you and the nominee get +2 Difficulty — tech attacks don\'t', () => {
    const { a, e, b } = setup(['ms_type_3_projected_shield'])
    b.useCustom(a, custom(b, a, /Project Shield/), e)
    expect(b.buildWeaponCtx(a, w(a, 'mw_assault_rifle'), e, 'free', false).difficulty).toBe(2)
    expect(b.techAttackRoll(a, e, 'probe').difficulty).toBe(0)
  })

  it('Portable Bunker: "All characters completely within" (hostiles too) get hard cover; area attacks by systems are resisted', () => {
    const { a, e, b } = setup(['ms_portable_bunker'], { x: 13, y: 13 })
    a.pos = { x: 5, y: 1 } // the bunker deploys adjacent (its action has range 1)
    b.useCustom(a, custom(b, a, /Deploy Portable Bunker/), { x: 6, y: 2 })
    const bk = b.alive().find(d => d.flags.dataName === 'Portable Bunker')!
    bk.flags.unfoldRound = 0
    e.pos = { x: 7, y: 3 }
    expect(b.cover(a, e)).toBe('hard')
    const ctx = b.newAttackCtx(a, e, { multiTarget: true })
    getScript('ms_portable_bunker')!.beforeAnyAttack!(b, a, ctx)
    expect(ctx.resistAll).toBe(true)
  })

  it('Armor-Lock Plating: Bracing costs its 2 Heat (Self); braced, you "can\'t fail Agility or Hull saves or contested checks"', () => {
    const { a, e, b } = setup(['ms_armor_lock_plating'], { x: 5, y: 8 }, {}, { systems: ['ms_reinforced_cabling'] })
    toEnemy(b, a, e)
    expect(b.brace(a)).toBe(true)
    expect(a.heat).toBe(2)
    expect(b.save(a, 'agi', 40)).toBe(true)
    rigDice(b, 20, 20, 1) // Drag Down: the attacker rolls 20, the braced mech 1 — and still wins
    b.useCustom(e, custom(b, e, /Drag Down/), a)
    expect(b.has(e, 'prone')).toBe(true)
  })
})

describe('audit 2 systems: Harrison Armory', () => {
  it('Siege Stabilizers: +5 range only once however often they are extended; no blasts "centered on" spaces within range 5', () => {
    const { a, b } = setup(['ms_siege_stabilizers'], { x: 12, y: 12 }, { weapons: [['Main', 'mw_mortar']] })
    const mortar = w(a, 'mw_mortar')
    const toggle = custom(b, a, /Extend Stabilizers/)
    toggle.run(b, a); toggle.run(b, a); toggle.run(b, a) // extend, retract, extend
    expect(a.flags.stabilizers).toBe(true)
    expect(b.weaponReach(a, mortar)).toBe(20)
    expect(b.aoeTiles(a, mortar, { x: 5, y: 8 })).toMatch(/Siege Stabilizers/)
    expect(Array.isArray(b.aoeTiles(a, mortar, { x: 5, y: 12 }))).toBe(true)
  })

  it('Flak Launcher: the flyer lands and "can\'t fly until the end of their next turn"', () => {
    const { a, e, b } = setup(['ms_flak_launcher'], { x: 5, y: 15 })
    e.flying = true
    rigDice(b, 20, 1)
    b.useCustom(a, custom(b, a, /Flak/), e)
    expect(e.flying).toBe(false)
    expect(e.flags.landed).toBeFalsy() // no taking off again yet
    expect(b.has(e, 'slowed')).toBe(true)
    toEnemy(b, a, e)
    b.endTurn(e)
    expect(e.flags.landed).toBe(true) // it may fly again
  })

  it('External Ammo Feed: "1/round, you can activate this system to reload a Loading weapon" (Heat 1d3+1)', () => {
    const { a, b } = setup(['ms_external_ammo_feed'], undefined, { weapons: [['Main', 'mw_rocket_propelled_grenade']] })
    const g = w(a, 'mw_rocket_propelled_grenade')
    g.loaded = false
    rigDice(b, 3, 2)
    b.useCustom(a, custom(b, a, /External Ammo Feed/))
    expect(g.loaded).toBe(true)
    expect(a.heat).toBe(3)
    g.loaded = false
    expect(custom(b, a, /External Ammo Feed/).usable(b, a)).toBe('Once per round')
  })

  it('Explosive Vents: "when you clear all heat or take stress" (Stabilize here), 1/round: 2 heat and 2 burn in burst 1', () => {
    const { a, e, b } = setup(['ms_explosive_vents'], { x: 5, y: 5 })
    e.stats.heatcap = 30
    a.heat = 3
    b.stabilize(a, 'cool')
    expect(e.heat).toBe(2)
    expect(e.burn).toBe(2)
    a.heat = a.stats.heatcap
    b.addHeat(a, 1) // takes stress the same round: the vents already blew
    expect(e.heat).toBe(2)
  })

  it('HAVOK Napalm Grenade: thrown within range 5, then "a line 5 path of your choice from its impact location"', () => {
    const { a, e, b } = setup(['ms_havok_charges'], { x: 9, y: 9 })
    const s = sysOf(a, 'ms_havok_charges'), n = s.usesLeft!
    b.answers.push(2) // spray East
    rigDice(b, 20, 1)
    b.useCustom(a, custom(b, a, /Napalm/), { x: 5, y: 9 })
    expect(e.burn).toBe(2)
    expect(s.usesLeft).toBe(n - 1)
  })

  it('Auto-Cooler (owner ruling): taking heat alone doesn\'t cancel it; HP damage does', () => {
    const { a, b } = setup(['ms_auto_cooler'])
    a.heat = 2
    b.useCustom(a, custom(b, a, /Auto-Cooler/))
    b.addHeat(a, 2)
    b.endTurn(a); act(b, a)
    expect(a.heat).toBe(0)
    a.heat = 3
    b.useCustom(a, custom(b, a, /Auto-Cooler/))
    b.applyDamage(a, [{ type: 'Kinetic', amount: 2 }], { ap: true })
    b.endTurn(a); act(b, a)
    expect(a.heat).toBe(3)
  })

  it('AGNI: "expend a charge"; characters that fail are "pushed outside the area" (just outside burst 2)', () => {
    const { a, e, b } = setup(['ms_agni_class_nhp'], { x: 5, y: 5 })
    const s = sysOf(a, 'ms_agni_class_nhp'), n = s.usesLeft!
    a.heat = 4
    b.useCustom(a, custom(b, a, /AGNI/))
    expect(s.usesLeft).toBe(n - 1)
    rigDice(b, 20, 1)
    b.endTurn(a)
    expect(a.heat).toBe(0)
    expect(b.distance(a, e)).toBe(3)
  })

  it('Repulser Field: "You count as having Immunity to any damage or effects immediately forced by mines detonated using this system"', () => {
    const { a, e, b } = setup(['ms_repulser_field'], { x: 13, y: 13 })
    b.placeMine(e, { x: 5, y: 5 }, { name: 'Test Mine', radius: 1, damage: [{ type: 'Explosive', val: '6' }] as any }, { noCheck: true })
    const hp = a.hp
    b.useCustom(a, custom(b, a, /Repulser/))
    expect(b.mines.length).toBe(0)
    expect(a.hp).toBe(hp)
  })

  it('Clamp Bombs: the target must be "within Sensors"', () => {
    const { a, e, b } = setup(['ms_clamp_bombs'], { x: 5, y: 15 })
    const s = sysOf(a, 'ms_clamp_bombs'), n = s.usesLeft!
    expect(() => b.useCustom(a, custom(b, a, /Clamp/), e)).toThrow(/Sensors|Out of range/)
    expect(s.usesLeft).toBe(n)
  })

  it('Tesseract Pinpoint Focus: a lifted ally "can choose to sink" — it may stay aloft past its next turn; Sensors range', () => {
    const { a, e, b } = setup(['ms_tesseract'], { x: 5, y: 15 })
    const ally = join(b, mech({ callsign: 'Ally' }), { x: 6, y: 6 })
    b.useCustom(a, custom(b, a, /Pinpoint/), ally)
    expect(ally.flying).toBe(true)
    b.endTurn(a); act(b, ally); b.endTurn(ally)
    expect(ally.flying).toBe(true)
    act(b, a)
    expect(() => b.useCustom(a, custom(b, a, /Pinpoint/), e)).toThrow(/Sensors|Out of range/)
  })

  it('Stasis Bolt: Interdiction Point answers a ranged attack on you (contested roll) but not a tech attack', () => {
    const { a, e, b } = setup(['ms_stasis_bolt'])
    b.useCustom(a, custom(b, a, /Charge Stasis Bolt/))
    toEnemy(b, a, e)
    e.stats.techAttack = 50
    b.techAttackRoll(e, a, 'probe')
    expect(a.flags.stasisBolt).toBe(true)
    e.stats.attackBonus = 0
    rigDice(b, 20, 15, 20) // the attack (15, a hit) then the bolt's contested roll
    const r = b.weaponAttack(e, w(e, 'mw_assault_rifle'), { targetId: a.id }, 'free')
    expect(r.ctxs[0].hit).toBe(false)
    expect(a.flags.stasisBolt).toBe(false)
  })

  it('Stasis Generator: "within line of sight and range 5"', () => {
    const { a, e, b } = setup(['ms_stasis_generator'], { x: 5, y: 10 })
    expect(() => b.useCustom(a, custom(b, a, /Stasis Generator/), e)).toThrow(/range/i)
    expect(b.has(e, 'stunned')).toBe(false)
  })

  it('Stasis Barrier (owner ruling): its soft cover and 4+ interception shelter hostile characters behind it too', () => {
    const { a, e, b } = setup(['ms_stasis_barrier'], { x: 5, y: 6 })
    b.useCustom(a, custom(b, a, /^Stasis Barrier/), { x: 5, y: 5 })
    expect(b.cover(a, e)).toBe('soft')
    rigDice(b, 6, 4)
    expect(b.buildWeaponCtx(a, w(a, 'mw_assault_rifle'), e, 'free', false).cancelled).toBe(true)
  })

  it('Flash Anchor: the Immunity lasts "until the start of their next turn"', () => {
    const { a, e, b } = setup(['ms_flash_anchor'], { x: 5, y: 6 })
    toEnemy(b, a, e)
    b.forceMove(a, e, 2, 1)
    expect(a.pos).toEqual({ x: 5, y: 4 })
    expect(a.heat).toBe(2)
    b.forceMove(a, e, 2, 1) // still immune: no reaction, no heat
    expect(a.heat).toBe(2)
    b.endTurn(e); act(b, a)
    expect(a.flags.anchored).toBeFalsy()
  })

  it('NOAH Diluvian Ark: "until the end of your next turn" (not the end of the next round)', () => {
    const { a, b } = setup(['ms_noah_class_nhp'])
    b.useCustom(a, custom(b, a, /Diluvian Ark/))
    b.endTurn(a)
    expect(a.flags.ark).toBe(1)
    act(b, a); b.endTurn(a)
    expect(a.flags.ark).toBeFalsy()
  })

  it('Redundant Systems Upgrade: "Stabilize as a quick action" — the Repair option and the reload too', () => {
    const { a, b } = setup(['ms_redundant_systems_upgrade'], undefined, { weapons: [['Main', 'mw_rocket_propelled_grenade']] })
    const g = w(a, 'mw_rocket_propelled_grenade')
    a.hp = 3; g.loaded = false
    const reps = a.repairs
    b.answers.push(1) // spend a Repair
    b.useCustom(a, custom(b, a, /Quick Stabilize/))
    expect(a.hp).toBe(a.stats.hp)
    expect(a.repairs).toBe(reps - 1)
    expect(g.loaded).toBe(true)
    expect(a.actionsLeft).toBe(1)
  })

  it('ASURA: "expend a charge to take two additional quick actions or one additional full action"', () => {
    const { a, b } = setup(['ms_asura_class_nhp'])
    const s = sysOf(a, 'ms_asura_class_nhp'), n = s.usesLeft!
    b.useCustom(a, custom(b, a, /ASURA/))
    expect(s.usesLeft).toBe(n - 1)
    b.stabilize(a, 'cool')
    expect(b.canSpend(a, 'full')).toBe(true)
  })

  it('Plasma Gauntlet (owner ruling): on a successful save you take half the damage actually inflicted as heat', () => {
    const { a, e, b } = setup(['ms_plasma_gauntlet'], { x: 5, y: 5 })
    a.stats.heatcap = 30; a.heat = 15
    rigDice(b, 6, 6, 6, 6, 6) // 24 damage
    rigDice(b, 20, 20) // the target saves: 12 inflicted
    b.useCustom(a, custom(b, a, /Plasma Gauntlet/), e)
    expect(a.heat).toBe(21)
  })
})

describe('audit 2 systems: HORUS', () => {
  it('//SCORPION: a tech attack missing an adjacent ally triggers it without a reaction, and it can Jam instead', () => {
    const { a, e, b } = setup(['ms___scorpion_v70.1'])
    const ally = join(b, mech({ callsign: 'Ally' }), { x: 6, y: 4 })
    toEnemy(b, a, e)
    e.stats.techAttack = -50
    const r = a.reactionsLeft
    b.answers.push(1) // Jammed
    b.techAttackRoll(e, ally, 'probe')
    expect(b.has(e, 'jammed')).toBe(true)
    expect(a.reactionsLeft).toBe(r)
  })
  it('//SCORPION: "succeed on a save against a hostile tech action" also triggers it', () => {
    const { a, e, b } = setup(['ms___scorpion_v70.1'])
    toEnemy(b, a, e)
    e.stats.heatcap = 30
    e.flags.techActing = true
    rigDice(b, 20, 20)
    b.save(a, 'sys', 10, 0, e)
    expect(b.has(e, 'impaired')).toBe(true)
    expect(e.heat).toBe(2)
  })

  it('Hunter Lock: the +3 is bonus damage on the hit, so Armor applies once; only the first hit each round', () => {
    const { a, e, b } = setup(['ms_hunter_lock'])
    b.useCustom(a, custom(b, a, /Hunter Lock/), e)
    e.stats.armor = 2
    a.stats.attackBonus = 0
    rigDice(b, 20, 15); rigDice(b, 6, 4)
    const hp = e.hp
    b.weaponAttack(a, w(a, 'mw_assault_rifle'), { targetId: e.id }, 'free')
    expect(hp - e.hp).toBe(4 + 3 - 2)
    expect(b.buildWeaponCtx(a, w(a, 'mw_assault_rifle'), e, 'free', false).bonusDamage.length).toBe(0)
  })

  it('Viral Logic Banish: "for every space they voluntarily move, up to a maximum of 6 heat" in total', () => {
    const { a, e, b } = setup(['ms_viral_logic_suite'], { x: 5, y: 9 })
    e.stats.heatcap = 30
    rigDice(b, 20, 20)
    b.useCustom(a, custom(b, a, /Invade: Banish/), e)
    const h = e.heat
    b.forceMove(e, a, 2, 1) // pushed: involuntary
    expect(e.heat).toBe(h)
    toEnemy(b, a, e)
    b.move(e, { x: 5, y: 13 })
    expect(e.heat).toBe(h + 4)
    b.move(e, { x: 5, y: 15 })
    expect(e.heat).toBe(h + 6)
  })

  it('Logic Bomb: Slowed "until they end one of their turns not adjacent to any character"', () => {
    const { a, e, b } = setup(['ms_viral_logic_suite'], { x: 5, y: 5 })
    rigDice(b, 20, 20, 1) // the invade hits; the target fails its Systems save
    b.useCustom(a, custom(b, a, /Invade: Logic Bomb/), e)
    toEnemy(b, a, e)
    b.endTurn(e) // ends next to you: still Slowed
    expect(b.has(e, 'slowed')).toBe(true)
    e.pos = { x: 5, y: 10 }
    act(b, e); b.endTurn(e)
    expect(b.has(e, 'slowed')).toBe(false)
  })

  it('Puppet System: "in a direction of your choice"; the move "provokes reactions … as normal"', () => {
    const { a, e, b } = setup(['ms_h0r_os_system_upgrade_i'], { x: 8, y: 8 })
    const ally = join(b, mech({ callsign: 'Ally', weapons: 'mw_chain_axe' }), { x: 9, y: 8 })
    rigDice(b, 20, 20)
    b.answers.push(6) // West
    const r = ally.reactionsLeft
    b.useCustom(a, custom(b, a, /Invade: Puppet System/), e)
    expect(e.pos.x).toBeLessThan(8)
    expect(e.pos.y).toBe(8)
    expect(ally.reactionsLeft).toBe(r - 1) // Overwatch
  })

  it('Lightning Generator: the automatic Danger Zone discharge uses up the protocol', () => {
    const { a, b } = setup(['ms_lightning_generator'])
    b.endTurn(a)
    a.heat = Math.ceil(a.stats.heatcap / 2)
    act(b, a)
    expect(() => b.useCustom(a, custom(b, a, /Lightning Generator/))).toThrow(/already used/)
  })

  it('Sentinel Drone: 3 kinetic "before making any attack" — a second tech attack the same turn too', () => {
    const { a, e, b } = setup(['ms_sentinel_drone'])
    b.useCustom(a, custom(b, a, /Deploy Sentinel/), { x: 5, y: 7 })
    toEnemy(b, a, e)
    e.stats.armor = 0
    const hp = e.hp
    b.techAttackRoll(e, a, 'one')
    b.techAttackRoll(e, a, 'two')
    expect(hp - e.hp).toBe(6)
  })

  it('OSIRIS: Gate progress "persists between scenes but resets if you rest or perform a Full Repair"', () => {
    const p = pilot({ systems: ['ms_osiris_class_nhp'] })
    const run = newRun([p], 3)
    const [u] = squadUnits(run)
    u.flags.duatGate = 2
    recordBattle(run, run.nodes[0], [u], true)
    expect(squadUnits(run)[0].flags.duatGate).toBe(2)
    fullRepair(run)
    expect(squadUnits(run)[0].flags.duatGate).toBeUndefined()
  })

  it('H0R_OS II constructs are Quick Tech: Jammed characters can\'t make them', () => {
    const { a, b } = setup(['ms_h0r_os_system_upgrade_ii'])
    expect(custom(b, a, /Ideal Image/).activation).toBe('quick_tech')
    expect(custom(b, a, /False Idol/).activation).toBe('quick_tech')
    b.addStatus(a, 'jammed', 'until_cleared', a)
    expect(() => b.useCustom(a, custom(b, a, /Ideal Image/), { x: 6, y: 5 })).toThrow(/Jammed/)
  })

  it('Monitor Module: the Skirmish is offered (a reaction the player may decline)', () => {
    const { a, e, b } = setup(['ms_monitor_module'])
    const ally = join(b, mech({ callsign: 'Ally' }), { x: 6, y: 4 })
    b.useCustom(a, custom(b, a, /Monitor Module/), ally)
    a.policies.reactions = 'off'
    toEnemy(b, a, e)
    const r = a.reactionsLeft
    b.weaponAttack(e, w(e, 'mw_assault_rifle'), { targetId: ally.id }, 'free')
    expect(a.reactionsLeft).toBe(r)
  })

  it('Eye of HORUS: Hidden stops protecting against you for the whole window, even for a character that Hides again', () => {
    const { a, e, b } = setup(['ms_eye_of_horus'])
    b.useCustom(a, custom(b, a, /Eye of Horus/))
    toEnemy(b, a, e)
    // Hidden needs cover now (it ends when a hostile sees it in the open): smoke keeps line of sight but hides it
    b.areas.push({ id: 'smoke', kind: 'soft_cover', tiles: [{ ...e.pos }] }); b.invalidateTerrain()
    b.addStatus(e, 'hidden', 'until_cleared', e)
    expect(b.techTargetValid(a, e)).toBe(true)
    b.endTurn(e); act(b, a); b.endTurn(a)
    expect(b.techTargetValid(a, e)).toBe('Hidden')
  })
})

describe('audit 2 systems: SSC', () => {
  it('Ferrous Lash: pulled "in a direction of your choice"; a hostile that collides "with … another mech" is knocked Prone', () => {
    const { a, e, b } = setup(['ms_ferrous_lash'])
    // a mech that obstructs the pulled hostile (pushes pass through its own allies, core p.62)
    join(b, mech({ callsign: 'Blocker' }), { x: 7, y: 8 })
    rigDice(b, 20, 1)
    b.answers.push(2) // East
    b.useCustom(a, custom(b, a, /Ferrous Lash/), e)
    expect(e.pos).toEqual({ x: 6, y: 8 })
    expect(b.has(e, 'prone')).toBe(true)
  })

  it('Reactive Weave: "When you Brace, you become Invisible … and may immediately move spaces equal to your Speed"', () => {
    const { a, e, b } = setup(['ms_reactive_weave'])
    toEnemy(b, a, e)
    const d = b.distance(a, e)
    b.brace(a)
    expect(b.has(a, 'invisible')).toBe(true)
    expect(b.distance(a, e)).toBeGreaterThan(d)
    expect(b.distance(a, e)).toBeLessThanOrEqual(d + a.stats.speed)
  })

  it('Hunter Logic Suite: Terrify forbids "voluntary movements that bring it closer to you"; Stalk Prey is one target at a time', () => {
    const { a, e, b } = setup(['ms_hunter_logic_suite'])
    rigDice(b, 20, 20)
    b.useCustom(a, custom(b, a, /Invade: Terrify/), e)
    toEnemy(b, a, e)
    expect(() => b.move(e, { x: 5, y: 6 })).toThrow(/Terrified/)
    b.move(e, { x: 5, y: 10 })
    const e2 = join(b, mech({ callsign: 'Foe2' }, 'enemy'), { x: 8, y: 8 })
    b.endTurn(e); act(b, a)
    rigDice(b, 20, 20)
    b.useCustom(a, custom(b, a, /Invade: Stalk Prey/), e)
    b.endTurn(a); act(b, a)
    rigDice(b, 20, 20)
    b.useCustom(a, custom(b, a, /Invade: Stalk Prey/), e2)
    expect(e.flags[`stalked:${a.id}`]).toBeFalsy()
    expect(e2.flags[`stalked:${a.id}`]).toBe(true)
  })

  it('Neurospike: Shrike Code heat once per attack (an area attack too); Mirage can hide an ally', () => {
    const { a, e, b } = setup(['ms_neurospike'], { x: 5, y: 12 }, {}, { weapons: [['Main', 'mw_mortar']] })
    const ally = join(b, mech({ callsign: 'Ally' }), { x: 6, y: 4 })
    e.stats.heatcap = 30
    rigDice(b, 20, 20)
    b.useCustom(a, custom(b, a, /Invade: Shrike Code/), e)
    b.endTurn(a); act(b, a)
    rigDice(b, 20, 20)
    b.answers.push(1) // Mirage on the ally
    b.useCustom(a, custom(b, a, /Invade: Mirage/), e)
    toEnemy(b, a, e)
    expect(b.buildWeaponCtx(e, w(e, 'mw_mortar'), ally, 'free', false).forceInvisible).toBe(true)
    const h = e.heat
    b.weaponAttack(e, w(e, 'mw_mortar'), { tile: { x: 5, y: 4 } }, 'free') // a Blast 1 over both of them
    expect(e.heat - h).toBe(2)
  })

  it('Exposed Singularity: triggered by damage that isn\'t an attack too', () => {
    const { a, e, b } = setup(['ms_singularity_motivator'])
    toEnemy(b, a, e)
    rigDice(b, 6, 2)
    b.applyDamage(a, [{ type: 'Energy', amount: 3 }], { source: e })
    expect(Math.max(Math.abs(a.pos.x - 5), Math.abs(a.pos.y - 4))).toBe(2)
  })

  it('Tracking Bug: the tagged character can "remove the tracking drone" with an Engineering check as a quick action', () => {
    const { a, e, b } = setup(['ms_tracking_bug'])
    rigDice(b, 20, 20)
    b.useCustom(a, custom(b, a, /Tracking Bug/), e)
    toEnemy(b, a, e)
    rigDice(b, 20, 20)
    b.useCustom(e, custom(b, e, /Remove Tracking Bug/))
    expect(e.flags.trackedBy).toBeFalsy()
  })

  it('Javelin Rockets: "3 free spaces within range 15 and line of sight that aren\'t adjacent to each other"', () => {
    const { a, b } = setup(['ms_javelin_rockets'])
    b.useCustom(a, custom(b, a, /Javelin/), { x: 5, y: 10 })
    const js = a.flags.javelins as { x: number; y: number }[]
    expect(js.length).toBe(3)
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) expect(chebyshev(js[i], js[j])).toBeGreaterThan(1)
  })

  it('Retractable Profile: "rolls to locate you receive +1 difficulty while you are Hidden"', () => {
    const { a, e, b } = setup([], { x: 5, y: 8 }, {}, { systems: ['ms_retractable_profile'] })
    toEnemy(b, a, e)
    b.useCustom(e, custom(b, e, /^Retractable Profile/))
    wallRow7(b)
    b.addStatus(e, 'hidden', 'until_cleared', e)
    b.endTurn(e); act(b, a)
    a.stats.sys = 0; e.stats.agi = 0
    rigDice(b, 20, 10, 5) // the search (10) and the hider (5)
    rigDice(b, 6, 6) // the difficulty die: 10 - 6 < 5
    b.search(a)
    expect(b.has(e, 'hidden')).toBe(true)
  })

  it('ICEOUT Drone: "Existing conditions and effects caused by tech actions" don\'t affect characters inside the field', () => {
    const { a, e, b } = setup(['ms_iceout_drone'])
    const ally = join(b, mech({ callsign: 'Ally' }), { x: 6, y: 6 })
    e.flags.techActing = true
    b.addStatus(ally, 'impaired', 'until_cleared', e)
    e.flags.techActing = false
    b.useCustom(a, custom(b, a, /Deploy ICEOUT/), { x: 6, y: 7 })
    expect(b.has(ally, 'impaired')).toBe(false)
    b.forceMove(ally, { x: 6, y: 15 }, 3, 1) // out of the field: it comes back
    expect(b.has(ally, 'impaired')).toBe(true)
  })
})
