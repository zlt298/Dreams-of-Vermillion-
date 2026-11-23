// Frame traits (`frame:<id>`) and CORE systems (`core:<id>`) that had no behaviour test: one test per trait set and one
// per CORE, each asserting the main mechanical clause of the lancer-data text (quoted in the test titles).
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
/** a frame mech (player) and a plain Everest (enemy), placed and started; the frame mech is active with its CORE charged */
function frame(id: string, at = { x: 3, y: 3 }, eAt = { x: 3, y: 8 }, o: Parameters<typeof mech>[0] = {}) {
  const a = mech({ frame: id, ...o })
  const e = mech({ callsign: 'Foe' }, 'enemy')
  const b = arena([[a, at], [e, eAt]], { map: flatMap(20, 20) })
  act(b, a)
  a.coreAvailable = true
  return { a, e, b }
}

describe('HORUS Balor', () => {
  it('Scouring Swarm: "deals 2 kinetic to characters … that start their turn … adjacent"; Regeneration: "regains 1/4 of its total HP" at turn end', () => {
    const { a, e, b } = frame('mf_balor', { x: 3, y: 3 }, { x: 5, y: 3 }) // Size 2: x 3–4, so x 5 is adjacent
    a.hp = 1
    b.endTurn(a)
    expect(a.hp).toBe(1 + Math.floor(a.stats.hp / 4))
    const hp = e.hp
    act(b, e)
    expect(e.hp).toBe(hp - 2)
  })
  it('Hive Frenzy: Shredded, Scouring Swarm deals 4, Regeneration restores 1/2', () => {
    const { a, e, b } = frame('mf_balor', { x: 3, y: 3 }, { x: 5, y: 3 })
    b.activateCore(a)
    expect(b.has(a, 'shredded')).toBe(true)
    expect(b.cover(e, a)).toBe('soft') // "You and adjacent allies gain soft cover"
    a.hp = 1
    b.endTurn(a)
    expect(a.hp).toBe(1 + Math.floor(a.stats.hp / 2))
    const hp = e.hp
    act(b, e)
    expect(e.hp).toBe(hp - 4)
  })
})

describe('HA Genghis', () => {
  it('Insulated: "Immunity to burn"; Emergency Vent: "When the Genghis takes structure damage, it clears all heat"', () => {
    const { a, e, b } = frame('mf_genghis')
    b.applyDamage(a, [{ type: 'Burn', amount: 3 }], { source: e })
    expect(a.burn).toBe(0)
    a.heat = 4
    a.hp = 1
    rigDice(b, 6, 6) // structure check: Glancing Blow
    b.applyDamage(a, [{ type: 'Kinetic', amount: 5 }], { source: e, ap: true })
    expect(a.structure).toBe(a.stats.structure - 1)
    expect(a.heat).toBe(0)
  })
  it('Expose Power Cells: "The next time you exceed your Heat Cap … clear all heat and vent a burst 3 cloud"; others in it take 2 burn and 2 heat', () => {
    const { a, e, b } = frame('mf_genghis', { x: 3, y: 3 }, { x: 3, y: 5 })
    b.activateCore(a)
    const stress = a.stress
    a.heat = a.stats.heatcap
    b.addHeat(a, 2)
    expect(a.heat).toBe(0)
    expect(a.stress).toBe(stress) // no overheat
    expect(e.burn).toBe(2)
    expect(e.heat).toBe(2)
  })
})

describe('HORUS Gorgon', () => {
  it('Metastatic Paralysis: "an attack roll … lands on 1–2, it automatically misses and the attacker becomes Stunned"', () => {
    const { a, e, b } = frame('mf_gorgon', { x: 3, y: 3 }, { x: 3, y: 7 })
    expect(a.reactionsPerRound).toBe(2) // Gaze: "two reactions per turn"
    b.endTurn(a)
    act(b, e)
    rigDice(b, 20, 2)
    e.stats.attackBonus = 50
    const r = b.weaponAttack(e, w(e, 'mw_assault_rifle'), { targetId: a.id }, 'free')
    expect(r.ctxs[0].hit).toBe(false)
    expect(b.has(e, 'stunned')).toBe(true)
  })
  it('Extrude Basilisk: hostiles "must succeed on a Systems save before attacking you … On a failure, they become Stunned"', () => {
    const { a, e, b } = frame('mf_gorgon', { x: 3, y: 3 }, { x: 3, y: 7 })
    b.activateCore(a)
    b.endTurn(a)
    act(b, e)
    rigDice(b, 20, 3) // the Systems save (3 + Systems fails; as an attack roll, 3 would not trigger Metastatic Paralysis)
    const r = b.weaponAttack(e, w(e, 'mw_assault_rifle'), { targetId: a.id }, 'free')
    expect(r.ctxs[0].hit).toBe(false)
    expect(b.has(e, 'stunned')).toBe(true)
  })
})

describe('HA Iskander', () => {
  it('Assault Launcher: "plant one Mine as though it has range 15"; Skeleton Key: "never triggers or sets off Mines"', () => {
    const { a, e, b } = frame('mf_iskander', { x: 3, y: 3 }, { x: 3, y: 14 }, { systems: ['ms_pattern_a_smoke_charges'] })
    b.useCustom(a, custom(b, a, /Smoke Mine/), { x: 3, y: 15 }) // 11 spaces away
    expect(b.mines).toHaveLength(1)
    // a hostile Iskander walks next to an armed mine without setting it off
    const isk = mech({ frame: 'mf_iskander', callsign: 'Isk' }, 'enemy')
    const owner = mech({ callsign: 'Owner' })
    const b2 = arena([[owner, { x: 2, y: 2 }], [isk, { x: 8, y: 5 }]], { map: flatMap(14, 14) })
    act(b2, owner)
    const m = b2.placeMine(owner, { x: 3, y: 3 }, { name: 'Test Mine', radius: 1, damage: [{ type: 'Explosive', val: 5 }] })
    b2.endTurn(owner)
    expect(m.armed).toBe(true)
    act(b2, isk)
    b2.move(isk, { x: 4, y: 5 })
    expect(b2.mines).toHaveLength(1)
    expect(isk.hp).toBe(isk.stats.hp)
    void e
  })
  it('Death Cloud: hostiles making "any movement other than their standard move (including involuntary)" take 3 AP explosive, 1/round', () => {
    const { a, e, b } = frame('mf_iskander', { x: 3, y: 3 }, { x: 3, y: 7 })
    b.activateCore(a)
    e.stats.armor = 2
    const hp = e.hp
    b.forceMove(e, a, 1, 1)
    expect(e.hp).toBe(hp - 3) // AP: armor ignored
    b.forceMove(e, a, 1, 1)
    expect(e.hp).toBe(hp - 3) // only 1/round
  })
})

describe('IPS-N Lancaster', () => {
  it('Combat Repair: "use 4 Repairs to repair a destroyed mech as a full action, returning it to 1 Structure, 1 Stress, and 1 HP"; Insulated', () => {
    const { a, e, b } = frame('mf_lancaster')
    const ally = mech({ callsign: 'Wreck' })
    ally.pos = { x: 5, y: 3 }
    b.units.push(ally)
    b.destroy(ally, 'test')
    expect(ally.destroyed).toBe(true)
    const repairs = a.repairs
    b.useCustom(a, custom(b, a, /Combat Repair/), ally)
    expect(ally.destroyed).toBe(false)
    expect([ally.hp, ally.structure, ally.stress]).toEqual([1, 1, 1])
    expect(a.repairs).toBe(repairs - 4)
    b.applyDamage(a, [{ type: 'Burn', amount: 2 }], { source: e })
    expect(a.burn).toBe(0)
  })
  it('Supercharger: "you take 1 heat at the start of each of your turns, but your target gains +1 accuracy … and Immunity to … Slowed"', () => {
    const { a, e, b } = frame('mf_lancaster')
    const ally = mech({ callsign: 'Ally' })
    ally.pos = { x: 5, y: 3 }
    b.units.push(ally)
    b.activateCore(a)
    expect(b.addStatus(ally, 'slowed', 'until_cleared', e)).toBe(false)
    expect(b.has(ally, 'slowed')).toBe(false)
    const ctx = b.buildWeaponCtx(ally, w(ally, 'mw_assault_rifle'), e, 'free', false)
    expect(ctx.accuracy).toBe(1)
    b.endTurn(a)
    a.activationsLeft = 1
    const heat = a.heat
    act(b, a)
    expect(a.heat).toBe(heat + 1)
  })
})

describe('SSC Metalmark', () => {
  // regression (fixed): "When the Metalmark is in soft cover, ranged attackers receive +2 difficulty instead of +1 difficulty."
  // The script looks for the 'Soft cover -1' reason in beforeAttack, but cover is added after every beforeAttack hook.
  it('Carapace Adaptation: "in soft cover, ranged attackers receive +2 difficulty instead of +1"', () => {
    const { a, e, b } = frame('mf_metalmark', { x: 3, y: 3 }, { x: 3, y: 8 })
    b.addArea({ kind: 'soft_cover', tiles: [{ ...a.pos }], expiresRound: 99, ownerId: a.id })
    expect(b.cover(e, a)).toBe('soft')
    const ctx = b.buildWeaponCtx(e, w(e, 'mw_assault_rifle'), a, 'free', false)
    expect(ctx.difficulty).toBe(2)
  })
  it('Flash Cloak: Invisible against reactions made while it moves (Overwatch)', () => {
    const { a, e, b } = frame('mf_metalmark', { x: 3, y: 3 }, { x: 3, y: 8 })
    const ctx = b.buildWeaponCtx(e, w(e, 'mw_assault_rifle'), a, 'overwatch', false)
    expect(ctx.forceInvisible).toBe(true)
  })
  it('Tactical Cloak: "You are Invisible for the rest of the scene"', () => {
    const { a, e, b } = frame('mf_metalmark')
    b.activateCore(a)
    expect(b.has(a, 'invisible')).toBe(true)
    b.endTurn(a); act(b, e); b.endTurn(e)
    expect(b.has(a, 'invisible')).toBe(true)
  })
})

describe('HORUS Minotaur', () => {
  it('Localized Maze: hostiles "must always stop moving when Engaged with it, regardless of Size"', () => {
    const { a, e, b } = frame('mf_minotaur', { x: 5, y: 5 }, { x: 5, y: 7 })
    e.stats.size = 2 // bigger than the Minotaur: normally not stopped by engagement with it
    b.endTurn(a)
    act(b, e)
    // every 5-space route to (5,2) passes next to the Minotaur, where the move has to stop
    expect(b.pathTo(e, { x: 5, y: 2 }, 5)).toBeNull()
    delete a.flags.localizedMaze
    expect(b.pathTo(e, { x: 5, y: 2 }, 5)).not.toBeNull()
  })
  it('Maze: "Choose a character within Sensors: they become Stunned"; the Systems save at the end of their turn is at +3 difficulty', () => {
    const { a, e, b } = frame('mf_minotaur', { x: 5, y: 5 }, { x: 5, y: 9 })
    b.activateCore(a)
    expect(b.has(e, 'stunned')).toBe(true)
    b.endTurn(a)
    act(b, e)
    e.stats.sys = 0
    rigDice(b, 20, 20) // 20 + 0 still fails vs save … only because of the 3 difficulty dice
    rigDice(b, 6, 6, 6, 6)
    b.endTurn(e)
    expect(b.has(e, 'stunned')).toBe(true)
    expect(e.flags.mazeAcc).toBe(-2) // "+1 accuracy each time until successful"
  })
})

describe('SSC Monarch', () => {
  it('Avenger Silos: "on a critical hit with any ranged weapon, … deal 3 explosive to a different character … within range 15"', () => {
    const { a, e, b } = frame('mf_monarch', { x: 3, y: 3 }, { x: 3, y: 8 })
    const e2 = mech({ callsign: 'Other' }, 'enemy')
    e2.pos = { x: 8, y: 3 }
    b.units.push(e2)
    a.stats.attackBonus = 0
    rigDice(b, 20, 20)
    const r = b.weaponAttack(a, w(a, 'mw_assault_rifle'), { targetId: e.id }, 'free')
    expect(r.ctxs[0].crit).toBe(true)
    expect(e2.hp).toBe(e2.stats.hp - 3)
  })
  it('Seeking Payload: a Launcher attack on a Locked On target consumes the Lock On, ignores cover and "cannot be reduced"', () => {
    const { a, e, b } = frame('mf_monarch', { x: 3, y: 3 }, { x: 3, y: 7 }, { weapons: 'mw_concussion_missiles' })
    b.addStatus(e, 'lockon', 'until_cleared', a)
    const ctx = b.buildWeaponCtx(a, w(a, 'mw_concussion_missiles'), e, 'free', false)
    expect(b.has(e, 'lockon')).toBe(false)
    expect(ctx.irreducible).toBe(true)
    expect(ctx.ignoreCover).toBe(true)
  })
  it('Divine Punishment: targets "must each succeed on an Agility save or take 1d6+4 explosive"', () => {
    const { a, e, b } = frame('mf_monarch', { x: 3, y: 3 }, { x: 15, y: 15 })
    rigDice(b, 6, 3)
    rigDice(b, 20, 1)
    b.activateCore(a)
    expect(e.hp).toBe(e.stats.hp - 7)
  })
})

describe('HA Tokugawa', () => {
  it('Limit Break: "When the Tokugawa is Exposed, its … attacks deal +3 energy bonus damage … ranged weapons gain +5 range"', () => {
    const { a, e, b } = frame('mf_tokugawa')
    const rifle = w(a, 'mw_assault_rifle')
    expect(b.weaponReach(a, rifle)).toBe(10)
    b.addStatus(a, 'exposed', 'until_cleared', a)
    expect(b.weaponReach(a, rifle)).toBe(15)
    const ctx = b.buildWeaponCtx(a, rifle, e, 'free', false)
    expect(ctx.bonusDamage).toContainEqual({ type: 'Energy', val: '3' })
  })
  it('Radiance: "weapons that deal any energy gain +5 range if they are ranged"', () => {
    const { a, b } = frame('mf_tokugawa', undefined, undefined, { weapons: [['Main', 'mw_thermal_rifle'], ['Main', 'mw_assault_rifle']] })
    const thermal = w(a, 'mw_thermal_rifle'), rifle = w(a, 'mw_assault_rifle')
    expect(b.weaponReach(a, thermal)).toBe(5)
    b.activateCore(a)
    expect(b.weaponReach(a, thermal)).toBe(10)
    expect(b.weaponReach(a, rifle)).toBe(10) // kinetic: unchanged
  })
})

describe('IPS-N Tortuga', () => {
  it('Sentinel: "+1 accuracy on all attacks made as reactions (e.g. Overwatch)"; Guardian: adjacent allies use it for hard cover', () => {
    const { a, e, b } = frame('mf_tortuga', { x: 3, y: 3 }, { x: 3, y: 8 })
    const ctx = b.buildWeaponCtx(a, w(a, 'mw_assault_rifle'), e, 'overwatch', false)
    expect(ctx.accuracy).toBe(1)
    expect(b.buildWeaponCtx(a, w(a, 'mw_assault_rifle'), e, 'skirmish', false).accuracy).toBe(0)
    const ally = mech({ callsign: 'Ally' })
    ally.pos = { x: 3, y: 2 } // above the Tortuga, which sits between it and the enemy
    b.units.push(ally)
    expect(b.cover(e, ally)).toBe('hard')
  })
  it('Hyper-Reflex Mode: threat 3 with ranged weapons, an extra Overwatch, and "Any character you hit with Overwatch becomes Immobilized"', () => {
    const { a, e, b } = frame('mf_tortuga', { x: 3, y: 3 }, { x: 3, y: 8 })
    const rifle = w(a, 'mw_assault_rifle')
    expect(b.weaponThreat(a, rifle)).toBeLessThan(3)
    const reactions = a.reactionsPerRound
    b.activateCore(a)
    expect(b.weaponThreat(a, rifle)).toBe(3)
    expect(a.reactionsPerRound).toBe(reactions + 1)
    a.stats.attackBonus = 50
    b.weaponAttack(a, rifle, { targetId: e.id }, 'overwatch')
    expect(b.has(e, 'immobilized')).toBe(true)
  })
})
