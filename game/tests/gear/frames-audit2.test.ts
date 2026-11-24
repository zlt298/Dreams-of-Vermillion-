// Audit 2 fixes for frame traits and CORE systems: each test pins one clause of the item's lancer-data text.
import { describe, expect, it } from 'vitest'
import type { Battle } from '../../src/rules/battle'
import type { Unit } from '../../src/rules/types'
import { getScript } from '../../src/rules/effects/registry'
import { deployableUnit } from '../../src/rules/effects/generic'
import { fullRepair, newRun, recordBattle, squadUnits } from '../../src/run/run'
import { act, arena, battle, flatMap, mech, pilot, rigDice, type PilotOpts } from '../support'
import { custom, weapon } from './helpers'

/** a frame mech (player) and a plain Everest (enemy), placed and started; the frame mech is active with its CORE charged */
function frame(id: string, at = { x: 3, y: 3 }, eAt = { x: 3, y: 8 }, o: PilotOpts = {}, extra: [Unit, { x: number; y: number }][] = []) {
  const a = mech({ frame: id, ...o })
  const e = mech({ callsign: 'Foe' }, 'enemy')
  const b = arena([[a, at], [e, eAt], ...extra], { map: flatMap(20, 20) })
  act(b, a)
  a.coreAvailable = true
  return { a, e, b }
}
const ally = (name = 'Ally', o: PilotOpts = {}) => mech({ callsign: name, ...o })
const foe = (name = 'Foe2', o: PilotOpts = {}) => mech({ callsign: name, ...o }, 'enemy')
/** end `a`'s turn and run `others` turns in order (beginning each), leaving the last one active */
const pass = (b: Battle, a: Unit, ...others: Unit[]) => { b.endTurn(a); for (const o of others) { act(b, o); b.endTurn(o) } }

describe('IPS-N Lancaster', () => {
  it('Supercharger: an allied mech within range 8 (never yourself), +1 accuracy and immunities from others; ends when either is Stunned', () => {
    const al = ally()
    const { a, e, b } = frame('mf_lancaster', { x: 3, y: 3 }, { x: 15, y: 15 }, {}, [[al, { x: 3, y: 10 }]])
    b.activateCore(a)
    expect(a.flags.superchargeTarget).toBe(al.id)
    expect(al.bonuses.filter(x => (x as any).supercharge === a.id)).toHaveLength(3)
    expect(b.addStatus(al, 'slowed', 'next_turn_end_target', e)).toBe(false) // from another character
    expect(b.addStatus(al, 'impaired', 'next_turn_end_target', al)).toBe(true) // from itself
    expect(b.canSpend(a, 'quick', 'activate:latch')).not.toBe(true) // the Latch Drone is busy
    b.addStatus(al, 'stunned', 'next_turn_end_target', e)
    expect(a.flags.superchargeTarget).toBeUndefined()
    expect(al.bonuses.some(x => (x as any).supercharge)).toBe(false)
    const heat = a.heat
    pass(b, a, e)
    act(b, a)
    expect(a.heat).toBe(heat) // no more heat at the start of its turns
  })
  it('Supercharger: with no allied mech in range the Latch Drone has nothing to clamp onto (not the Lancaster itself)', () => {
    const { a, b } = frame('mf_lancaster')
    b.activateCore(a)
    expect(a.flags.superchargeTarget).toBeUndefined()
    expect(a.coreAvailable).toBe(true)
  })
  it('Redundant Systems: an adjacent ally can spend the Lancaster\'s Repairs as its own', () => {
    const al = ally()
    const { a, e, b } = frame('mf_lancaster', { x: 3, y: 3 }, { x: 15, y: 15 }, {}, [[al, { x: 4, y: 3 }]])
    pass(b, a)
    act(b, al)
    al.repairs = 0
    al.hp = 3
    const before = a.repairs
    b.useCustom(al, custom(b, al, /Draw a Repair/))
    b.stabilize(al, 'repair')
    expect(al.hp).toBe(al.stats.hp)
    expect(a.repairs).toBe(before - 1)
    void e
  })
})

describe('IPS-N Blackbeard', () => {
  it('Lock/Kill Subsystem: "While grappling, the Blackbeard can Boost and take reactions"', () => {
    const { a, e, b } = frame('mf_blackbeard', { x: 3, y: 3 }, { x: 4, y: 3 })
    b.startGrapple(a, e)
    expect(b.has(a, 'grappled')).toBe(true)
    expect(b.canSpend(a, 'reaction', 'overwatch')).toBe(true)
    expect(() => b.boost(a)).not.toThrow()
    // the one held is not covered
    expect(b.canSpend(e, 'reaction', 'overwatch')).toBe('Grappled')
  })
})

describe('IPS-N Nelson', () => {
  it('Skirmisher: a step after every attack (not only the first), and after an Overwatch', () => {
    const { a, e, b } = frame('mf_nelson', { x: 3, y: 3 }, { x: 3, y: 8 })
    const rifle = weapon(a, 'mw_assault_rifle')
    b.weaponAttack(a, rifle, { targetId: e.id }, 'free')
    b.useCustom(a, custom(b, a, /Skirmisher/), { x: 4, y: 3 })
    expect(a.pos).toEqual({ x: 4, y: 3 })
    expect(b.customActions(a).some(c => /Skirmisher/.test(c.name))).toBe(false)
    b.weaponAttack(a, rifle, { targetId: e.id }, 'free')
    b.useCustom(a, custom(b, a, /Skirmisher/), { x: 5, y: 3 })
    expect(a.pos).toEqual({ x: 5, y: 3 })
    // "immediately": doing something else first forfeits the step
    b.weaponAttack(a, rifle, { targetId: e.id }, 'free')
    b.boost(a)
    expect(b.customActions(a).some(c => /Skirmisher/.test(c.name))).toBe(false)
    // an attack outside its own turn (Overwatch) offers the step at once
    pass(b, a)
    act(b, e)
    a.reactionsLeft = 1
    const from = { ...a.pos }
    b.answers.push(1)
    b.weaponAttack(a, rifle, { targetId: e.id }, 'overwatch')
    expect(a.pos).not.toEqual(from)
  })
})

describe('IPS-N Raleigh', () => {
  it('Full Metal Jacket: no reload at the end of a turn in which it forced a save', () => {
    const { a, e, b } = frame('mf_raleigh')
    const w = a.weapons.find(x => !x.destroyed)!
    w.loaded = false
    b.save(e, 'agi', 10, 0, a)
    b.endTurn(a)
    expect(w.loaded).toBe(false)
    act(b, e); b.endTurn(e); act(b, a)
    b.endTurn(a)
    expect(w.loaded).toBe(true)
  })
})

describe('IPS-N Tortuga', () => {
  it('Hyper-Reflex Mode: "1/round, you may take an additional Overwatch" — only an Overwatch', () => {
    const { a, b } = frame('mf_tortuga')
    b.activateCore(a)
    b.spend(a, 'reaction', 'overwatch')
    expect(b.canSpend(a, 'reaction', 'brace')).not.toBe(true)
    expect(b.canSpend(a, 'reaction', 'overwatch')).toBe(true)
    b.spend(a, 'reaction', 'overwatch')
    expect(b.canSpend(a, 'reaction', 'overwatch')).not.toBe(true)
  })
})

describe('IPS-N Raleigh Thunder God', () => {
  it('"4 kinetic damage per loaded round": firing with no chambered rounds deals no damage', () => {
    const { a, e, b } = frame('mf_raleigh', { x: 3, y: 3 }, { x: 3, y: 6 })
    b.activateCore(a)
    const hp = e.hp
    b.weaponAttack(a, weapon(a, 'mw_raleigh_integrated'), { targetId: e.id }, 'free', { autoHit: true })
    expect(e.hp).toBe(hp)
  })
})

describe('Core bonus: Fomorian Frame', () => {
  it('"can\'t be knocked Prone, pulled, or knocked back by smaller characters"', () => {
    const { a, e, b } = frame(EVEREST_ID, { x: 3, y: 3 }, { x: 3, y: 6 }, { coreBonuses: ['cb_fomorian_frame'] })
    expect(a.stats.size).toBe(2)
    const at = { ...a.pos }
    b.forceMove(a, e, 3, 1)
    expect(a.pos).toEqual(at)
    expect(b.addStatus(a, 'prone', 'until_cleared', e)).toBe(false)
    expect(getScript('cb_fomorian_frame')).toBeTruthy()
  })
})
const EVEREST_ID = 'mf_standard_pattern_i_everest'

describe('HA Barbarossa', () => {
  function fire(die: 1 | 2 | 3) {
    const e2 = foe()
    const { a, e, b } = frame('mf_barbarossa', { x: 2, y: 2 }, { x: 18, y: 18 }, {}, [[e2, { x: 10, y: 16 }]])
    b.activateCore(a)
    a.flags.apocDie = die
    a.actionsLeft = 2
    b.useCustom(a, custom(b, a, /Apocalypse Rail/), { x: 10, y: 10 })
    return { a, e, e2, b }
  }
  it('Charge Rail 1: the crater burns characters (4 burn, not energy) that enter it or start their turn there, for the scene', () => {
    const { a, e, e2, b } = fire(1)
    expect(b.areas.some(x => x.kind === 'damage')).toBe(false)
    pass(b, a)
    act(b, e2)
    e2.moveLeft = 20
    b.move(e2, { x: 10, y: 12 })
    expect(e2.burn).toBe(4)
    b.move(e2, { x: 10, y: 11 }) // once per round for entering
    expect(e2.burn).toBe(4)
    b.endTurn(e2)
    e2.burn = 0
    act(b, e); b.endTurn(e)
    b.startRound()
    act(b, e2) // starts its turn in the crater
    expect(e2.burn).toBe(4)
  })
  it('Charge Rail 2: the burning storm lasts until the end of your next turn', () => {
    const { a, e, e2, b } = fire(2)
    expect(a.flags.burnZones).toHaveLength(1)
    pass(b, a, e2, e)
    b.startRound()
    act(b, a); b.endTurn(a)
    expect(a.flags.burnZones).toHaveLength(0)
    expect(b.areas.some(x => x.id.startsWith('apoc-') && x.kind === 'soft_cover')).toBe(false)
  })
  it('Apocalypse Die: becoming Jammed resets it to 4, and it then counts down as usual', () => {
    const { a, e, b } = frame('mf_barbarossa', { x: 2, y: 2 }, { x: 18, y: 18 })
    b.activateCore(a)
    a.flags.apocDie = 2
    pass(b, a)
    act(b, e)
    b.addStatus(a, 'jammed', 'next_turn_end_target', e)
    expect(a.flags.apocDie).toBe(4)
    b.endTurn(e)
    b.startRound()
    act(b, a)
    expect(a.flags.apocDie).toBe(3)
  })
  it('"If you reach the end of the scene without using it, you regain 1 CP"', () => {
    const run = newRun([pilot({ frame: 'mf_barbarossa' })], 1)
    const [u] = squadUnits(run)
    const e = mech({}, 'enemy')
    u.pos = { x: 2, y: 2 }; e.pos = { x: 15, y: 15 }
    const b = battle([u, e], flatMap(20, 20))
    act(b, u)
    b.activateCore(u)
    expect(u.coreAvailable).toBe(false)
    recordBattle(run, run.nodes[0], [u], true)
    expect(run.condition[u.flags.pilotId].coreAvailable).toBe(true)
  })
})

describe('HA Genghis', () => {
  it('Expose Power Cells: the cloud makes characters in it Invisible to others, and burns others when they start their turn in it; then soft cover the Genghis ignores', () => {
    const e2 = foe('Far', {})
    const { a, e, b } = frame('mf_genghis', { x: 3, y: 3 }, { x: 3, y: 5 }, {}, [[e2, { x: 3, y: 12 }]])
    b.activateCore(a)
    a.heat = a.stats.heatcap
    b.addHeat(a, 2)
    expect(a.heat).toBe(0)
    expect(e.burn).toBe(0) // nothing at the moment of venting
    const gun = e2.weapons.find(w => !w.destroyed && !w.tech)!
    expect(b.buildWeaponCtx(e2, gun, e, 'free', false).forceInvisible).toBe(true)
    expect(b.buildWeaponCtx(a, weapon(a, 'mw_assault_rifle'), e, 'free', false).forceInvisible).toBeFalsy()
    b.endTurn(a)
    act(b, e)
    expect(e.burn).toBe(2)
    expect(e.heat).toBe(2)
    b.endTurn(e)
    b.startRound()
    act(b, a) // the cloud thins to cover
    expect(a.burn).toBe(0)
    expect(b.cover(e2, e)).toBe('soft')
    expect(b.cover(a, e)).toBe('none')
    b.endTurn(a)
    b.startRound()
    act(b, a)
    expect(b.cover(e2, e)).toBe('none')
  })
})

describe('HA Iskander', () => {
  it('Mine Deployers: 1/round, planting a Mine lets it plant up to two more in adjacent spaces as a free action; Assault Launcher is 1/round', () => {
    const { a, b } = frame('mf_iskander', { x: 5, y: 5 }, { x: 18, y: 18 }, { systems: ['ms_pattern_a_smoke_charges'] })
    const plant = custom(b, a, /Smoke Mine/)
    expect(plant.range).toBe(15)
    b.useCustom(a, plant, { x: 5, y: 15 })
    expect(b.mines).toHaveLength(1)
    // the Assault Launcher is spent: mines are adjacent again
    expect(custom(b, a, /Smoke Mine/).range).toBe(1)
    const extra = custom(b, a, /Deploy Additional Mines/)
    b.useCustom(a, extra, { x: 4, y: 5 })
    b.useCustom(a, custom(b, a, /Deploy Additional Mines/), { x: 7, y: 6 }) // Size 2: (5,5)-(6,6)
    expect(b.mines).toHaveLength(3)
    expect(b.customActions(a).some(c => /Deploy Additional Mines/.test(c.name))).toBe(false)
    a.flags.bonusQuick = 1
    b.useCustom(a, custom(b, a, /Smoke Mine/), { x: 5, y: 7 })
    expect(b.customActions(a).some(c => /Deploy Additional Mines/.test(c.name))).toBe(false) // 1/round
  })
  it('Assault Launcher: one Grenade at range 15 per round', () => {
    const { a, b } = frame('mf_iskander', { x: 5, y: 5 }, { x: 18, y: 18 }, { systems: ['ms_pattern_a_smoke_charges'] })
    expect(custom(b, a, /Smoke Grenade/).range).toBe(15)
    b.useCustom(a, custom(b, a, /Smoke Grenade/), { x: 5, y: 16 })
    expect(custom(b, a, /Smoke Grenade/).range).toBe(5)
    b.startRound()
    expect(custom(b, a, /Smoke Grenade/).range).toBe(15)
  })
})

describe('HA Napoleon', () => {
  it('Activate Aegis: only standard moves, Boost, Grapple, Ram, Improvised Attack and Shield systems; no reactions or Overcharge', () => {
    const { a, e, b } = frame('mf_napoleon', { x: 3, y: 3 }, { x: 3, y: 4 })
    b.activateCore(a)
    a.actionsLeft = 2
    const r = b.skirmish(a, weapon(a, 'mw_assault_rifle'), { targetId: e.id })
    expect(r.ok).toBe(false)
    expect(() => b.overcharge(a)).toThrow()
    expect(() => b.stabilize(a, 'cool')).toThrow()
    expect(b.canSpend(a, 'reaction', 'overwatch')).not.toBe(true)
    expect(b.canSpend(a, 'quick', 'ram')).toBe(true)
    expect(b.canSpend(a, 'quick', 'grapple')).toBe(true)
    expect(b.canSpend(a, 'quick', 'boost')).toBe(true)
    expect(b.canSpend(a, 'full', 'improvised')).toBe(true)
    expect(() => b.improvisedAttack(a, e)).not.toThrow()
  })
  it('Activate Aegis: damage that ignores reduction is not reduced; burn is reduced to 1; beneficial tech is refused too', () => {
    const al = ally()
    const { a, e, b } = frame('mf_napoleon', { x: 3, y: 3 }, { x: 3, y: 8 }, {}, [[al, { x: 4, y: 3 }]])
    b.activateCore(a)
    let hp = a.hp
    b.applyDamage(a, [{ type: 'Kinetic', amount: 8 }], { source: e, irreducible: true })
    expect(a.hp).toBe(hp - 8)
    hp = a.hp
    b.applyDamage(a, [{ type: 'Burn', amount: 5 }], { source: e })
    expect(a.hp).toBe(hp - 1)
    expect(b.techTargetValid(al, a, 'bolster')).not.toBe(true)
  })
})

describe('HA Saladin', () => {
  it('Warp Shield: offered as a reaction; declining leaves the attack alone', () => {
    const al = ally()
    const { a, e, b } = frame('mf_saladin', { x: 3, y: 3 }, { x: 3, y: 9 }, {}, [[al, { x: 5, y: 5 }]])
    pass(b, a)
    act(b, e)
    const gun = e.weapons.find(w => !w.destroyed && !w.tech)!
    b.answers.push(1)
    expect(b.buildWeaponCtx(e, gun, al, 'free', false).reasons.some(r => /Warp Shield/.test(r))).toBe(false)
    expect(b.buildWeaponCtx(e, gun, al, 'free', false).reasons.some(r => /Warp Shield/.test(r))).toBe(true)
    expect(a.reactionsLeft).toBe(0)
  })
  it('Tachyon Shield: the target is chosen, can be retargeted as a quick action, and a pulsed miss can be redirected', () => {
    const al = ally('A1'), al2 = ally('A2')
    const e2 = foe()
    const { a, e, b } = frame('mf_saladin', { x: 3, y: 3 }, { x: 3, y: 9 }, {}, [[al, { x: 5, y: 5 }], [al2, { x: 7, y: 5 }], [e2, { x: 9, y: 9 }]])
    b.answers.push(1)
    b.activateCore(a)
    const first = a.flags.tachyonTarget
    expect([al.id, al2.id]).toContain(first)
    const other = first === al.id ? al2 : al
    b.useCustom(a, custom(b, a, /Retarget Tachyon/), other)
    expect(a.flags.tachyonTarget).toBe(other.id)
    pass(b, a)
    act(b, e)
    a.reactionsLeft = 1
    const hp2 = e2.hp
    const gun = e.weapons.find(w => !w.destroyed && !w.tech)!
    rigDice(b, 20, 1, 20) // the attack misses; the redirected reroll crits
    b.answers.push(1, 0, 1) // Warp Shield: no; pulse: yes; redirect: the first listed character (hostiles first)
    b.weaponAttack(e, gun, { targetId: other.id }, 'free')
    expect(e2.hp).toBeLessThan(hp2)
  })
})

describe('HA Sherman', () => {
  it('Vent Heat: soft cover after Stabilizing, until the start of its next turn; Mathur Stop: take back half the Heat Cap', () => {
    const { a, e, b } = frame('mf_sherman', { x: 3, y: 3 }, { x: 3, y: 9 })
    a.heat = 3
    b.stabilize(a, 'cool')
    expect(b.cover(e, a)).toBe('soft')
    b.useCustom(a, custom(b, a, /Mathur Stop/))
    expect(a.heat).toBe(Math.floor(a.stats.heatcap / 2))
    expect(b.has(a, 'dangerzone')).toBe(true)
    pass(b, a, e)
    b.startRound()
    act(b, a)
    expect(b.cover(e, a)).toBe('none')
  })
  it('ZF4 SOLIDCORE charges carry over to the next scene and are lost on a Full Repair', () => {
    const run = newRun([pilot({ frame: 'mf_sherman' })], 1)
    const [u] = squadUnits(run)
    u.flags.zfSynced = true // as once a battle has started
    u.flags.zfCharges = 3
    getScript('core:mf_sherman')!.onRoundStart!(null as any, u)
    recordBattle(run, run.nodes[0], [u], true)
    const [v] = squadUnits(run)
    const e = mech({}, 'enemy')
    v.pos = { x: 2, y: 2 }; e.pos = { x: 15, y: 15 }
    battle([v, e], flatMap(20, 20))
    expect(v.flags.zfCharges).toBe(3)
    expect(weapon(v, 'mw_sherman_integrated').profileIndex).toBe(2)
    fullRepair(run)
    const [w] = squadUnits(run)
    battle([w, mech({}, 'enemy')], flatMap(20, 20))
    expect(w.flags.zfCharges).toBe(1)
  })
})

describe('HA Tokugawa', () => {
  it('Overclock: a protocol that makes the Tokugawa Exposed until the end of its next turn', () => {
    const { a, e, b } = frame('mf_tokugawa')
    b.useCustom(a, custom(b, a, /Overclock/))
    expect(b.has(a, 'exposed')).toBe(true)
    pass(b, a, e)
    b.startRound()
    act(b, a)
    expect(b.has(a, 'exposed')).toBe(true)
    b.endTurn(a)
    expect(b.has(a, 'exposed')).toBe(false)
  })
  it('Limit Break: while Exposed, kinetic weapons deal energy (+3 energy); with Radiance, +10 range', () => {
    const { a, e, b } = frame('mf_tokugawa', { x: 3, y: 3 }, { x: 3, y: 6 })
    const rifle = weapon(a, 'mw_assault_rifle')
    const base = b.weaponReach(a, rifle)
    b.activateCore(a)
    b.addStatus(a, 'exposed', 'until_cleared', a)
    expect(b.weaponReach(a, rifle)).toBe(base + 10)
    e.resist = ['Kinetic']
    e.stats.armor = 0
    const hp = e.hp
    rigDice(b, 6, 4)
    b.weaponAttack(a, rifle, { targetId: e.id }, 'free', { autoHit: true })
    // exposed target? no: the Tokugawa is Exposed. 4 + 3, all energy, not halved
    expect(hp - e.hp).toBe(7)
  })
  it('Plasma Sheath: in the Danger Zone with a weapon dealing energy, bonus damage becomes burn', () => {
    const { a, e, b } = frame('mf_tokugawa', { x: 3, y: 3 }, { x: 3, y: 6 })
    b.addStatus(a, 'exposed', 'until_cleared', a)
    a.heat = Math.ceil(a.stats.heatcap / 2)
    b.weaponAttack(a, weapon(a, 'mw_assault_rifle'), { targetId: e.id }, 'free', { autoHit: true })
    expect(e.burn).toBe(3)
  })
})

describe('HORUS Balor', () => {
  it('Hive Frenzy: on a 6 it takes no structure damage (no check), returns to 1 HP and is immune to damage for the turn', () => {
    const { a, e, b } = frame('mf_balor', { x: 3, y: 3 }, { x: 3, y: 9 })
    b.activateCore(a)
    a.structure = 1
    a.hp = 1
    rigDice(b, 6, 6)
    b.applyDamage(a, [{ type: 'Kinetic', amount: 5 }], { source: e, ap: true })
    expect(a.destroyed).toBe(false)
    expect(a.structure).toBe(1)
    expect(a.hp).toBe(1)
    expect(b.log.some(l => /Structure check/.test(l.text))).toBe(false)
    b.applyDamage(a, [{ type: 'Kinetic', amount: 5 }], { source: e, ap: true })
    expect(a.hp).toBe(1)
    b.endTurn(a)
    expect(a.flags.hiveImmune).toBeUndefined()
  })
  it('Regeneration: structure damage taken before its turn stops only that turn\'s regeneration', () => {
    const { a, e, b } = frame('mf_balor', { x: 3, y: 3 }, { x: 3, y: 9 })
    b.endTurn(a)
    act(b, e)
    a.hp = 2
    rigDice(b, 6, 6)
    b.applyDamage(a, [{ type: 'Kinetic', amount: 5 }], { source: e, ap: true }) // structure damage
    b.endTurn(e)
    b.startRound()
    act(b, a)
    a.hp = 5
    b.endTurn(a)
    expect(a.hp).toBe(5)
    act(b, e); b.endTurn(e)
    b.startRound()
    act(b, a)
    b.endTurn(a)
    expect(a.hp).toBe(5 + Math.floor(a.stats.hp / 4))
  })
  it('Self-Perpetuating: at the rest after a fight it regains full HP without repairs', () => {
    const run = newRun([pilot({ frame: 'mf_balor' })], 1)
    const [u] = squadUnits(run)
    u.hp = 3
    const repairs = u.repairs
    recordBattle(run, run.nodes[0], [u], true)
    expect(run.condition[u.flags.pilotId].hp).toBe(u.stats.hp)
    expect(run.condition[u.flags.pilotId].repairs).toBe(repairs)
  })
})

describe('HORUS Minotaur', () => {
  it('Metafold Maze: after a tech hit, a quick action makes the target Slowed, then Immobilized, then Stunned (once per combat)', () => {
    const { a, e, b } = frame('mf_minotaur', { x: 3, y: 3 }, { x: 3, y: 6 })
    const step = () => {
      rigDice(b, 20, 20)
      b.techAttackRoll(a, e, 'test')
      a.flags.bonusQuick = 1
      b.useCustom(a, custom(b, a, /Metafold Maze/), e)
    }
    step()
    expect(b.has(e, 'slowed')).toBe(true)
    step()
    expect(b.has(e, 'immobilized')).toBe(true)
    step()
    expect(b.has(e, 'stunned')).toBe(true)
    b.removeStatus(e, 'stunned')
    step()
    expect(b.has(e, 'stunned')).toBe(false) // once per combat
    // until the end of the Minotaur's next turn
    pass(b, a, e)
    b.startRound()
    act(b, a)
    expect(b.has(e, 'immobilized')).toBe(true)
    b.endTurn(a)
    expect(b.has(e, 'immobilized')).toBe(false)
  })
  it('Maze: the player chooses the character', () => {
    const e2 = foe('Second')
    const { a, e, b } = frame('mf_minotaur', { x: 3, y: 3 }, { x: 3, y: 6 }, {}, [[e2, { x: 6, y: 6 }]])
    b.answers.push(1)
    b.activateCore(a)
    const stunned = [e, e2].filter(x => b.has(x, 'stunned'))
    expect(stunned).toHaveLength(1)
  })
})

describe('HORUS Manticore', () => {
  it('Unstable System: destroyed on the enemy turn, it explodes at the end of its side\'s next turn', () => {
    const al = ally()
    const { a, e, b } = frame('mf_manticore', { x: 3, y: 3 }, { x: 5, y: 3 }, {}, [[al, { x: 15, y: 15 }]])
    pass(b, a)
    act(b, e)
    b.destroy(a, 'test')
    const hp = e.hp
    b.endTurn(e)
    expect(e.hp).toBe(hp)
    act(b, al)
    rigDice(b, 20, 1)
    b.endTurn(al)
    expect(e.hp).toBeLessThan(hp)
    expect(b.alive().some(u => u.traits?.includes('manticore_reactor'))).toBe(false)
    expect(getScript('trait:manticore_reactor')).toBeTruthy()
  })
  it('Castigation State: it explodes at once when destroyed (8d6, Agility save)', () => {
    const { a, e, b } = frame('mf_manticore', { x: 3, y: 3 }, { x: 5, y: 3 })
    a.flags.castigation = true
    const hp = e.hp
    rigDice(b, 20, 1)
    b.destroy(a, 'test')
    expect(e.hp).toBeLessThan(hp)
  })
})

describe('HORUS Hydra', () => {
  it('Shepherd Field: only drones and deployables adjacent to the Hydra have Resistance', () => {
    const { a, b } = frame('mf_hydra', { x: 3, y: 3 }, { x: 15, y: 15 })
    const near = deployableUnit(a, { name: 'Near', type: 'Drone', hp: 20 } as any, { x: 4, y: 3 })
    const far = deployableUnit(a, { name: 'Far', type: 'Drone', hp: 20 } as any, { x: 10, y: 3 })
    b.spawn(near); b.spawn(far)
    expect(b.applyDamage(near, [{ type: 'Kinetic', amount: 4 }], {})).toBe(2)
    expect(b.applyDamage(far, [{ type: 'Kinetic', amount: 4 }], {})).toBe(4)
  })
})

describe('SSC Monarch', () => {
  it('Seeking Payload in a real attack: a Launcher hits a Locked On target out of line of sight; the Lock On is consumed and damage is not reduced', () => {
    const a = mech({ frame: 'mf_monarch', weapons: 'mw_concussion_missiles' })
    const e = mech({ callsign: 'Foe' }, 'enemy')
    const map = flatMap(16, 16, (x, y) => (y === 5 && x >= 1 && x <= 6 ? { h: 4, kind: 'block' } : undefined))
    const b = arena([[a, { x: 3, y: 3 }], [e, { x: 3, y: 7 }]], { map })
    act(b, a)
    const w = weapon(a, 'mw_concussion_missiles')
    expect(b.validTarget(a, w, e)).not.toBe(true)
    b.addStatus(e, 'lockon', 'until_cleared', a)
    expect(b.validTarget(a, w, e)).toBe(true)
    e.stats.armor = 2
    e.resist = ['Explosive']
    const hp = e.hp
    rigDice(b, 3, 3) // 1d3 explosive: 3
    const r = b.weaponAttack(a, w, { targetId: e.id }, 'free', { autoHit: true })
    expect(r.ok).toBe(true)
    expect(r.ctxs[0].reasons).toContain('Seeking Payload')
    expect(r.ctxs[0].irreducible).toBe(true)
    expect(b.has(e, 'lockon')).toBe(false)
    expect(hp - e.hp).toBe(3) // neither Armor 2 nor Resistance reduce it
  })
  it('Avenger Silos: the player picks the character that takes 3 explosive', () => {
    const e2 = foe('Second'), e3 = foe('Third')
    const { a, e, b } = frame('mf_monarch', { x: 3, y: 3 }, { x: 3, y: 7 }, {}, [[e2, { x: 6, y: 3 }], [e3, { x: 8, y: 3 }]])
    e2.stats.armor = 0; e3.stats.armor = 0
    const h2 = e2.hp, h3 = e3.hp
    const ctx = b.newAttackCtx(a, e, { weapon: a.weapons[0], hit: true, crit: true, ranged: true })
    b.answers.push(2) // 0 hold fire, 1 and 2 the two candidates
    getScript('frame:mf_monarch')!.afterAttack!(b, a, ctx, 'attacker')
    expect((h2 - e2.hp) + (h3 - e3.hp)).toBe(3)
  })
})

describe("SSC Death's Head", () => {
  it('Mark for Death: no reactions while focusing, across rounds; Cease Focus ends the Immobilized; the bonus is part of the attack', () => {
    const { a, e, b } = frame('mf_deaths_head', { x: 3, y: 3 }, { x: 3, y: 12 })
    b.activateCore(a)
    a.actionsLeft = 2
    b.useCustom(a, custom(b, a, /Mark for Death/), e)
    expect(b.has(a, 'immobilized')).toBe(true)
    pass(b, a, e)
    b.startRound()
    expect(b.canSpend(a, 'reaction', 'overwatch')).not.toBe(true)
    act(b, a)
    expect(b.has(a, 'immobilized')).toBe(true)
    const ctx = b.newAttackCtx(a, e, { weapon: weapon(a, 'mw_assault_rifle'), hit: true, crit: true, ranged: true })
    getScript('core:mf_deaths_head')!.afterAnyRoll!(b, a, ctx)
    expect(ctx.bonusDamage).toEqual([{ type: 'Kinetic', val: '2d6' }])
    expect(getScript('core:mf_deaths_head')!.afterAttack).toBeUndefined() // no separate damage packet
    b.useCustom(a, custom(b, a, /Cease Focus/))
    expect(b.has(a, 'immobilized')).toBe(false)
    expect(b.canSpend(a, 'reaction', 'overwatch')).toBe(true)
  })
  it('Mark for Death: the focus ends when the target is destroyed', () => {
    const { a, e, b } = frame('mf_deaths_head', { x: 3, y: 3 }, { x: 3, y: 12 })
    b.activateCore(a)
    a.actionsLeft = 2
    b.useCustom(a, custom(b, a, /Mark for Death/), e)
    b.destroy(e, 'test')
    expect(a.flags.markTarget).toBeUndefined()
    expect(b.has(a, 'immobilized')).toBe(false)
  })
})

describe('SSC Swallowtail', () => {
  it('Integrated Cloak: the Invisibility ends when it takes a reaction or moves', () => {
    const { a, e, b } = frame('mf_swallowtail')
    b.endTurn(a)
    expect(b.has(a, 'invisible')).toBe(true)
    act(b, e)
    b.spend(a, 'reaction', 'overwatch')
    expect(b.has(a, 'invisible')).toBe(false)
  })
  it('Tactical Simulation: needs line of sight to the ally; on 3 or less no Resistance but a teleport up to 6', () => {
    const al = ally()
    const map = flatMap(20, 20, (x, y) => (x === 6 && y <= 8 ? { h: 4, kind: 'block' } : undefined))
    const a = mech({ frame: 'mf_swallowtail' })
    const e = mech({ callsign: 'Foe' }, 'enemy')
    const b = arena([[a, { x: 3, y: 3 }], [e, { x: 3, y: 12 }], [al, { x: 9, y: 3 }]], { map })
    act(b, a)
    a.coreAvailable = true
    b.activateCore(a)
    b.endTurn(a)
    act(b, e)
    const gun = e.weapons.find(w => !w.destroyed && !w.tech)!
    // ally behind the wall: no reaction
    b.weaponAttack(e, gun, { targetId: al.id }, 'free', { autoHit: true })
    expect(a.reactionsLeft).toBe(1)
    al.pos = { x: 3, y: 9 }
    rigDice(b, 20, 15)
    rigDice(b, 6, 2)
    b.answers.push(0, 1) // react: yes; teleport: the first spot offered
    const r = b.weaponAttack(e, gun, { targetId: al.id }, 'free')
    expect(a.reactionsLeft).toBe(0)
    expect(r.ctxs[0].resistAll).toBeFalsy()
    expect(al.pos).not.toEqual({ x: 3, y: 9 })
  })
})

describe('SSC Dusk Wing', () => {
  it('Maneuverability Jets: it hovers while moving and is on the ground otherwise', () => {
    const { a, b } = frame('mf_dusk_wing')
    expect(a.flying).toBe(false)
    b.move(a, { x: 3, y: 6 })
    expect(a.pos).toEqual({ x: 3, y: 6 })
    b.endTurn(a)
    expect(a.flying).toBe(false)
  })
})

describe('SSC Mourning Cloak', () => {
  it('Blinkspace Jump: roll first, then choose the space within the result', () => {
    const { a, b } = frame('mf_mourning_cloak')
    a.actionsLeft = 2
    rigDice(b, 6, 1, 2, 3)
    b.useCustom(a, custom(b, a, /^Blinkspace Jump$/))
    const tp = custom(b, a, /Blinkspace: teleport/)
    expect(tp.range).toBe(6)
    expect(() => b.useCustom(a, tp, { x: 3, y: 12 })).toThrow()
    b.useCustom(a, custom(b, a, /Blinkspace: teleport/), { x: 3, y: 9 })
    expect(a.pos).toEqual({ x: 3, y: 9 })
  })
  it('Blinkspace Jump: triples make it vanish without being destroyed (no wreck, no destruction effects)', () => {
    const { a, b } = frame('mf_mourning_cloak')
    a.actionsLeft = 2
    rigDice(b, 6, 4, 4, 4)
    b.useCustom(a, custom(b, a, /^Blinkspace Jump$/))
    expect(a.flags.removed).toBe(true)
    expect(a.flags.wreck).toBeFalsy()
    expect(a.flags.vanished).toBeTruthy()
    expect(b.activeId).not.toBe(a.id)
  })
})
