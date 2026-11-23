// A squad's condition between battles: what recordBattle carries over, repairs, rewards, level-ups, refits and
// re-imports, the Bondmate and boons. These are pure functions over RunState, so they are checked exactly.
import { describe, expect, it } from 'vitest'
import { importPilots } from '../../src/import/compcon'
import {
  newRun, availableNodes, recordBattle, squadUnits, fullRepair, repairOptions, applyRepair, rollRewards, applyReward,
  levelUp, refitPilot, replacePilots, freshCondition, minHp, REWARDS, type RunState,
} from '../../src/run/run'
import { EVENTS } from '../../src/run/events'
import { buildMechUnit } from '../../src/rules/stats'
import v3 from '../fixtures/V3_FIXTURE.json'
import { pregenPilots as squad } from '../support'

const bossOf = (run: RunState, act: number) => run.nodes.find(n => n.act === act && n.kind === 'boss')!
const combatNode = (run: RunState) => availableNodes(run)[0]

describe('recording a battle', () => {
  it('damage, spent Repairs, destroyed gear and Limited uses carry over to the next battle', () => {
    const run = newRun(squad(), 3)
    const units = squadUnits(run)
    const u = units[0]
    u.hp -= 5; u.structure -= 1; u.stress -= 1; u.repairs -= 2; u.overchargeLevel = 2; u.coreAvailable = false
    u.weapons[0].destroyed = true
    const lim = [...u.weapons, ...u.systems].find(x => x.usesLeft != null)
    expect(lim).toBeDefined() // the Vanguard's Hex Charges: the Limited carry-over is actually checked
    lim!.usesLeft = 0
    u.heat = 5
    recordBattle(run, combatNode(run), units, true)
    const v = squadUnits(run).find(x => x.flags.pilotId === u.flags.pilotId)!
    expect(v.hp).toBe(u.stats.hp - 5)
    expect(v.structure).toBe(u.stats.structure - 1)
    expect(v.stress).toBe(u.stats.stress - 1)
    expect(v.repairs).toBe(u.stats.repcap - 2)
    expect(v.overchargeLevel).toBe(2)
    expect(v.coreAvailable).toBe(false)
    expect(v.weapons[0].destroyed).toBe(true)
    expect(v.heat).toBe(0) // heat clears at the end of the scene
    expect([...v.weapons, ...v.systems].find(x => x.dataId === lim!.dataId)!.usesLeft).toBe(0)
    expect(run.battlesWon).toBe(1)
  })

  it('a destroyed mech sits out until reprinted', () => {
    const run = newRun(squad(), 3)
    const units = squadUnits(run)
    units[0].destroyed = true
    recordBattle(run, combatNode(run), units, true)
    expect(run.condition[run.squad[0].id].destroyed).toBe(true)
    expect(squadUnits(run)).toHaveLength(3)
    applyReward(run, 'reprint', run.squad[0].id)
    expect(squadUnits(run)).toHaveLength(4)
  })

  it('a loss ends the run; losing every mech also ends it', () => {
    const run = newRun(squad(), 3)
    recordBattle(run, combatNode(run), squadUnits(run), false)
    expect(run.over).toBe('defeat')
    const run2 = newRun(squad(), 3)
    const units = squadUnits(run2)
    units.forEach(u => (u.destroyed = true))
    recordBattle(run2, combatNode(run2), units, true)
    expect(run2.over).toBe('defeat')
  })

  it('beating an act boss advances the act, fully repairs and asks for a level-up', () => {
    const run = newRun(squad(), 3)
    const units = squadUnits(run)
    units[0].hp = 1; units[1].destroyed = true
    recordBattle(run, bossOf(run, 1), units, true)
    expect(run.act).toBe(2)
    expect(run.pendingLevelUp).toBe(true)
    for (const p of run.squad) expect(run.condition[p.id]).toEqual(freshCondition(p))
    expect(run.over).toBeUndefined()
  })

  it('beating the act 3 boss wins the run', () => {
    const run = newRun(squad(), 3)
    recordBattle(run, bossOf(run, 3), squadUnits(run), true)
    expect(run.over).toBe('victory')
  })

  it('a mech lost in blinkspace comes back with its pre-vanish condition', () => {
    const run = newRun(squad(), 3)
    const units = squadUnits(run)
    units[0].destroyed = true
    units[0].flags.vanished = { hp: 7, structure: 2, stress: 3 }
    recordBattle(run, combatNode(run), units, true)
    expect(run.condition[run.squad[0].id]).toMatchObject({ destroyed: false, hp: 7, structure: 2, stress: 3 })
  })

  it('one-battle boons are consumed, permanent ones are kept', () => {
    const run = newRun(squad(), 3)
    run.boons.push({ reward: 'plating' }, { reward: 'perm_acc', pilotId: run.squad[0].id }, { reward: 'intel' })
    recordBattle(run, combatNode(run), squadUnits(run), true)
    expect(run.boons.map(b => b.reward)).toEqual(['perm_acc'])
  })

  it('a permanent +2 HP boon does not heal a damaged mech between battles', () => {
    const run = newRun(squad(), 3)
    const pid = run.squad[0].id
    run.boons.push({ reward: 'perm_hp2', pilotId: pid })
    const units = squadUnits(run)
    const u = units.find(x => x.flags.pilotId === pid)!
    expect(u.hp).toBe(u.stats.hp)
    u.hp -= 6
    const hpAfter = u.hp
    recordBattle(run, combatNode(run), units, true)
    const again = squadUnits(run).find(x => x.flags.pilotId === pid)!
    expect(again.hp).toBe(hpAfter)
    // and a full-HP mech with the boon stays at its (raised) maximum
    const fresh = newRun(squad(), 3)
    fresh.boons.push({ reward: 'perm_hp2', pilotId: pid })
    const fu = squadUnits(fresh).find(x => x.flags.pilotId === pid)!
    recordBattle(fresh, combatNode(fresh), [fu], true)
    expect(squadUnits(fresh).find(x => x.flags.pilotId === pid)!.hp).toBe(fu.stats.hp)
  })

  // regression: a "never below 1 HP" event healed a mech whose max HP a boon had raised
  it('a "never below 1 HP" event does not heal a boosted mech left on 1 HP', () => {
    const run = newRun(squad(), 3)
    const pid = run.squad[0].id
    run.boons.push({ reward: 'perm_hp2', pilotId: pid })
    const units = squadUnits(run)
    const u = units.find(x => x.flags.pilotId === pid)!
    u.hp = 1
    recordBattle(run, availableNodes(run)[0], units, true)
    expect(run.condition[pid].hp).toBe(minHp(run, pid))
    const shortcut = EVENTS.find(e => e.id === 'shortcut')!
    shortcut.apply(run)
    expect(squadUnits(run).find(x => x.flags.pilotId === pid)!.hp).toBe(1)
  })
})

describe('repairs (core book: HP 1, weapon/system 1, Structure 2, Stress 2)', () => {
  const damaged = () => {
    const run = newRun(squad(), 3)
    const p = run.squad.find(x => x.mech.systems.length)!
    const c = run.condition[p.id]
    const u = buildMechUnit(p)
    c.hp = 1; c.structure = u.stats.structure - 1; c.stress = u.stats.stress - 1
    c.destroyedWeapons = [u.weapons[0].dataId!]; c.destroyedSystems = [p.mech.systems[0]]
    c.repairs = 10
    // the Everest's Replaceable Parts trait makes Structure cost 1 Repair instead of 2
    const sc = u.bonuses.some(b => b.id === 'cheap_struct') ? 1 : 2
    return { run, p, c, u, sc }
  }

  it('lists every repair with its cost', () => {
    const { p, c, sc } = damaged()
    const opts = Object.fromEntries(repairOptions(p, c).map(o => [o.id.split(':')[0], o.cost]))
    expect(opts).toEqual({ hp: 1, structure: sc, stress: 2, w: 1, s: 1 })
  })

  it('Structure costs 2 Repairs on a frame without Replaceable Parts', () => {
    const [p] = importPilots(v3) // Blackbeard
    const c = freshCondition(p)
    c.structure -= 1
    expect(repairOptions(p, c).find(o => o.id === 'structure')!.cost).toBe(2)
  })

  it('a healthy or destroyed mech has nothing to repair', () => {
    const run = newRun(squad(), 3)
    const p = run.squad[0]
    expect(repairOptions(p, run.condition[p.id])).toEqual([])
    run.condition[p.id].destroyed = true
    run.condition[p.id].hp = 0
    expect(repairOptions(p, run.condition[p.id])).toEqual([])
  })

  it('applying repairs spends Repairs and fixes the right thing', () => {
    const { run, p, c, u, sc } = damaged()
    applyRepair(run, p.id, 'hp')
    expect(c.hp).toBe(u.stats.hp)
    expect(c.repairs).toBe(9)
    applyRepair(run, p.id, 'stress')
    expect(c.stress).toBe(u.stats.stress)
    expect(c.repairs).toBe(7)
    applyRepair(run, p.id, `w:${u.weapons[0].dataId}`)
    expect(c.destroyedWeapons).toEqual([])
    applyRepair(run, p.id, `s:${p.mech.systems[0]}`)
    expect(c.destroyedSystems).toEqual([])
    applyRepair(run, p.id, 'structure')
    expect(c.structure).toBe(u.stats.structure)
    expect(c.repairs).toBe(5 - sc)
  })

  it('refuses a repair it cannot pay for, or one that is not needed', () => {
    const { run, p, c } = damaged()
    c.repairs = 1
    expect(() => applyRepair(run, p.id, 'stress')).toThrow(/Not enough repairs/)
    expect(c.repairs).toBe(1)
    expect(c.stress).toBe(buildMechUnit(p).stats.stress - 1)
    c.hp = buildMechUnit(p).stats.hp
    expect(() => applyRepair(run, p.id, 'hp')).toThrow()
  })

  it('a full repair restores everyone, including destroyed mechs', () => {
    const { run, p } = damaged()
    run.condition[run.squad[0].id].destroyed = true
    fullRepair(run)
    for (const q of run.squad) expect(run.condition[q.id]).toEqual(freshCondition(q))
    expect(run.condition[p.id].repairs).toBe(buildMechUnit(p).stats.repcap)
  })

  it('fullRepair(run, false) leaves destroyed mechs destroyed', () => {
    const run = newRun(squad(), 3)
    run.condition[run.squad[0].id].destroyed = true
    fullRepair(run, false)
    expect(run.condition[run.squad[0].id].destroyed).toBe(true)
  })
})

describe('rewards', () => {
  it('offers three distinct rewards, deterministically per seed', () => {
    const run = newRun(squad(), 3)
    const r = rollRewards(11, run)
    expect(r).toHaveLength(3)
    expect(new Set(r.map(x => x.id)).size).toBe(3)
    expect(rollRewards(11, run).map(x => x.id)).toEqual(r.map(x => x.id))
  })
  it('only offers Emergency Print when a mech is destroyed', () => {
    const run = newRun(squad(), 3)
    for (let s = 1; s < 200; s++) expect(rollRewards(s, run).some(x => x.id === 'reprint')).toBe(false)
    run.condition[run.squad[0].id].destroyed = true
    let offered = false
    for (let s = 1; s < 200 && !offered; s++) offered = rollRewards(s, run).some(x => x.id === 'reprint')
    expect(offered).toBe(true)
  })
  it('each reward does what it says', () => {
    const run = newRun(squad(), 3)
    const [a, b] = run.squad.map(p => p.id)
    const ca = run.condition[a]
    const rep = ca.repairs
    applyReward(run, 'repairs', a)
    expect(ca.repairs).toBe(rep + 2)
    ca.coreAvailable = false
    applyReward(run, 'core', a)
    expect(ca.coreAvailable).toBe(true)
    run.condition[a].overchargeLevel = 3; run.condition[b].overchargeLevel = 2
    applyReward(run, 'cool')
    expect(run.condition[a].overchargeLevel + run.condition[b].overchargeLevel).toBe(0)
    applyReward(run, 'plating')
    expect(squadUnits(run).every(u => u.overshield === 4)).toBe(true)
    expect(REWARDS.map(r => r.id).sort()).toEqual(['cool', 'core', 'intel', 'plating', 'repairs', 'reprint'])
  })
})

describe('level-ups', () => {
  it('levelUp sets the act level (LL5, then LL10) and fully repairs', () => {
    const run = newRun(squad(), 3)
    run.condition[run.squad[0].id].hp = 1
    run.pendingLevelUp = true
    run.act = 2
    levelUp(run)
    expect(run.squad.every(p => p.level === 5)).toBe(true)
    expect(run.pendingLevelUp).toBe(false)
    expect(run.condition[run.squad[0].id].hp).toBe(buildMechUnit(run.squad[0]).stats.hp)
    run.act = 3
    levelUp(run); levelUp(run)
    expect(run.squad.every(p => p.level === 10)).toBe(true)
  })

  // app.ts: boss win -> recordBattle (fullRepair) -> debrief() rewardPick -> repairs() -> maybeEvent() -> runMap()
  // -> levelUpScreen() -> levelUp(), which resets every condition (run.ts levelUp -> resetCondition).
  // regression: the level-up after an act boss threw away the debrief reward
  it('a Field Repair Kit taken as the act 1 boss reward survives the level-up', () => {
    const run = newRun(squad(), 3)
    const boss = bossOf(run, 1)
    recordBattle(run, boss, squadUnits(run), true)
    expect(rollRewards(boss.seed + 1, run).length).toBeGreaterThan(0)
    const pid = run.squad[0].id
    applyReward(run, 'repairs', pid) // "+2 Repairs for one mech (can exceed its Repair Cap)"
    const withKit = run.condition[pid].repairs
    levelUp(run) // what levelUpScreen does next
    expect(run.condition[pid].repairs).toBe(withKit) // was: back to the fresh Repair Cap (kit wasted)
  })

  // regression: the level-up after an act boss undid a pact's cost but kept its boon
  it("a boss-node pact's cost survives the level-up along with its permanent boon", () => {
    const run = newRun(squad(), 3)
    const boss = bossOf(run, 1)
    recordBattle(run, boss, squadUnits(run), true)
    const pid = run.squad[1].id // Assault has systems
    const ev = EVENTS.find(e => e.id === 'targeting_core')!
    expect(ev.eligible!(run, pid)).toBe(true)
    ev.apply(run, pid)
    expect(run.condition[pid].destroyedSystems.length).toBe(1)
    levelUp(run)
    expect(run.boons.some(b => b.reward === 'perm_acc' && b.pilotId === pid)).toBe(true)
    expect(run.condition[pid].destroyedSystems.length).toBe(1) // was: 0, the +1 accuracy was free
  })

  // regression: the level-up after an act boss refunded Repairs spent after the boss
  it('Repairs spent after the boss stay spent through the level-up', () => {
    const run = newRun(squad(), 3)
    recordBattle(run, bossOf(run, 1), squadUnits(run), true)
    const pid = run.squad[0].id
    run.condition[pid].repairs -= 1
    const left = run.condition[pid].repairs
    levelUp(run)
    expect(run.condition[pid].repairs).toBe(left)
    expect(run.condition[pid].hp).toBe(buildMechUnit(run.squad[0]).stats.hp)
  })
})

describe('refits and re-imports keep the condition', () => {
  it('refitPilot keeps damage taken, spent Repairs and CORE use, and refuses strangers', () => {
    const run = newRun(squad(), 3)
    const p = run.squad[0]
    const c = run.condition[p.id]
    const before = buildMechUnit(p).stats
    c.hp = before.hp - 4; c.repairs = before.repcap - 1; c.coreAvailable = false; c.structure = 2
    const better = structuredClone(p)
    better.level = 2; better.mechSkills = [2, 0, 0, 0]
    expect(refitPilot(run, better)).toBe(true)
    const now = buildMechUnit(better).stats
    expect(now.hp).toBeGreaterThan(before.hp)
    expect(run.condition[p.id]).toMatchObject({ hp: now.hp - 4, repairs: now.repcap - 1, coreAvailable: false, structure: 2 })
    expect(refitPilot(run, { ...better, id: 'stranger' })).toBe(false)
  })

  it('a refit that lowers max HP never leaves the mech at 0 or below', () => {
    const run = newRun(squad(), 3)
    const p = run.squad[0]
    p.mechSkills = [2, 0, 0, 0]
    run.condition[p.id] = freshCondition(p)
    run.condition[p.id].hp = 2
    const worse = structuredClone(p)
    worse.mechSkills = [0, 0, 0, 0]
    refitPilot(run, worse)
    expect(run.condition[p.id].hp).toBeGreaterThanOrEqual(1)
  })

  // regression: a no-op refit reset Repairs to the Repair Cap
  it('Repairs above the Repair Cap (Field Repair Kit / events) survive a no-op refit', () => {
    const run = newRun(squad(), 3)
    const pid = run.squad[0].id
    applyReward(run, 'repairs', pid)
    const before = run.condition[pid].repairs
    refitPilot(run, structuredClone(run.squad[0]))
    expect(run.condition[pid].repairs).toBe(before) // was: before - 2
  })

  // regression: a refit dropped the locked Prototype Weapon set-up
  it('a locked Prototype Weapon set-up (kept "until the next Full Repair") survives a refit', () => {
    const run = newRun(squad(), 3)
    const pid = run.squad[0].id
    run.condition[pid].proto = { some_weapon: { type: 'Rifle', damage: 'Energy' } }
    refitPilot(run, structuredClone(run.squad[0]))
    expect(run.condition[pid].proto).toEqual({ some_weapon: { type: 'Rifle', damage: 'Energy' } }) // was: undefined
  })

  // regression: re-importing pilots fully repaired them
  it('a re-import is not a free full repair (damage and a destroyed mech carry over)', () => {
    const run = newRun(squad(), 3)
    const [a, b] = run.squad
    run.condition[a.id].hp = 3
    run.condition[b.id].destroyed = true
    replacePilots(run, [structuredClone(a), structuredClone(b)])
    expect(run.condition[a.id].hp).toBe(3)
    expect(run.condition[b.id].destroyed).toBe(true)
  })

  // regression: a refit dropped destroyed marks for gear that left the build, and kept over-cap Limited uses
  it('a refit keeps destroyed marks for gear that left the build (no repair offered, no free repair on refitting it) and clamps Limited uses', () => {
    const run = newRun(squad(), 3)
    const p = run.squad[0]
    const c = run.condition[p.id]
    const u = squadUnits(run).find(x => x.flags.pilotId === p.id)!
    const lim = [...u.weapons, ...u.systems].find(x => x.usesLeft != null && x.dataId)!
    c.destroyedWeapons = ['not_in_build']
    c.destroyedSystems = ['also_not_in_build']
    c.limited[lim.dataId!] = 99
    refitPilot(run, structuredClone(p))
    expect(run.condition[p.id].destroyedWeapons).toEqual(['not_in_build'])
    expect(run.condition[p.id].destroyedSystems).toEqual(['also_not_in_build'])
    expect(repairOptions(run.squad[0], run.condition[p.id]).some(o => /not_in_build/.test(o.id))).toBe(false)
    expect(run.condition[p.id].limited[lim.dataId!]).toBe(lim.usesLeft)
  })

  // regression: unfitting a destroyed system and fitting it back repaired it
  it('taking a destroyed system off and fitting it back does not repair it (refit, battle, refit)', () => {
    const run = newRun(squad(), 3)
    const p = run.squad.find(x => x.mech.systems.length)!
    const sys = p.mech.systems[0]
    run.condition[p.id].destroyedSystems = [sys]
    const without = structuredClone(p); without.mech.systems = without.mech.systems.slice(1)
    refitPilot(run, without)
    recordBattle(run, availableNodes(run)[0], squadUnits(run), true)
    refitPilot(run, structuredClone(p))
    expect(squadUnits(run).find(x => x.flags.pilotId === p.id)!.systems.find(s => s.dataId === sys)!.destroyed).toBe(true)
  })

  it('re-import matches by id first, then by a unique callsign; reports ambiguity and strays', () => {
    const run = newRun(squad(2), 3)
    const [a, b] = run.squad
    const byId = { ...a, level: 3 }
    const byCallsign = { ...b, id: 'other-id', level: 3 }
    const stranger = { ...b, id: 'x', callsign: 'Nobody' }
    const r = replacePilots(run, [byId, byCallsign, stranger])
    expect(r.replaced).toEqual([a.callsign])
    expect(r.byCallsign).toEqual([b.callsign])
    expect(r.unmatched).toEqual(['Nobody'])
    expect(run.squad.every(p => p.level === 3)).toBe(true)
    expect(run.squad[1].id).toBe(b.id) // keeps the run's id so condition stays linked
  })
  it('re-import refuses to guess when several squad pilots share a callsign', () => {
    const run = newRun(squad(2), 3)
    run.squad[1].callsign = run.squad[0].callsign
    const r = replacePilots(run, [{ ...run.squad[0], id: 'new' }])
    expect(r.ambiguous.length).toBe(1)
  })
})

describe('Bonded: the Bondmate stays for the run', () => {
  const bonded = () => {
    const run = newRun(squad(), 3)
    const [a, b] = run.squad
    run.condition[a.id].bondmate = b.id
    return { run, a, b }
  }
  it('survives a battle', () => {
    const { run, a, b } = bonded()
    recordBattle(run, combatNode(run), squadUnits(run), true)
    expect(run.condition[a.id].bondmate).toBe(b.id)
  })
  it('survives a rest (full repair)', () => {
    const { run, a, b } = bonded()
    fullRepair(run)
    expect(run.condition[a.id].bondmate).toBe(b.id)
  })
  it('survives an act boss and the level-up after it', () => {
    const { run, a, b } = bonded()
    recordBattle(run, bossOf(run, 1), squadUnits(run), true)
    levelUp(run)
    expect(run.condition[a.id].bondmate).toBe(b.id)
  })
  it('survives a refit in the builder', () => {
    const { run, a, b } = bonded()
    refitPilot(run, structuredClone(a))
    expect(run.condition[a.id].bondmate).toBe(b.id)
  })
  // regression: Emergency Print reset the condition, Bondmate included
  it('survives Emergency Print', () => {
    const { run, a, b } = bonded()
    run.condition[a.id].destroyed = true
    applyReward(run, 'reprint', a.id)
    expect(run.condition[a.id].bondmate).toBe(b.id)
  })
  // regression: events that rebuild a condition entry dropped the Bondmate
  it('survives Ram the Gate and Through the Fire', () => {
    for (const id of ['ram_gate', 'through_fire']) {
      const ev = EVENTS.find(e => e.id === id)!
      const { run, a, b } = bonded()
      run.condition[a.id].destroyed = id === 'ram_gate'
      ev.apply(run, id === 'through_fire' ? b.id : a.id)
      expect(run.condition[a.id].bondmate).toBe(b.id)
    }
  })
})
