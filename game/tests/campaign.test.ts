// The roguelike campaign layer: map structure, persistent damage, repairs, rewards, level-ups,
// refits and save/load. These are pure functions over RunState, so they are checked exactly.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { importPilots } from '../src/import/compcon'
import pregens from '../src/data/pregens/pregens.json'
import {
  newRun, availableNodes, recordBattle, squadUnits, fullRepair, repairOptions, applyRepair, rollRewards, applyReward,
  levelUp, refitPilot, chooseTeam, saveRun, loadRun, nodeTier, sitrepFor, freshCondition, ACTS, REWARDS,
  type RunState, type RunNode,
} from '../src/run/run'
import { EVENTS } from '../src/run/events'
import { buildMechUnit } from '../src/rules/stats'
import v3 from './fixtures/V3_FIXTURE.json'
import './helpers'

const squad = (n = 4) => (pregens as any[]).slice(0, n).map(p => importPilots(p)[0])
const bossOf = (run: RunState, act: number) => run.nodes.find(n => n.act === act && n.kind === 'boss')!
const combatNode = (run: RunState) => availableNodes(run)[0]

describe('campaign map', () => {
  const seeds = [1, 7, 42, 1234, 99999, 314159]

  it.each(seeds)('seed %s: three acts of six layers, one boss each, first layer all combat', seed => {
    const run = newRun(squad(), seed)
    for (let act = 1; act <= ACTS; act++) {
      const nodes = run.nodes.filter(n => n.act === act)
      expect(new Set(nodes.map(n => n.layer))).toEqual(new Set([0, 1, 2, 3, 4, 5]))
      expect(nodes.filter(n => n.kind === 'boss')).toHaveLength(1)
      expect(nodes.find(n => n.kind === 'boss')!.layer).toBe(5)
      expect(nodes.filter(n => n.layer === 0).every(n => n.kind === 'combat')).toBe(true)
      // the layer before the boss always offers a rest
      expect(nodes.some(n => n.layer === 4 && n.kind === 'rest')).toBe(true)
    }
  })

  it.each(seeds)('seed %s: edges only go one layer forward, ids are unique, every node is reachable', seed => {
    const run = newRun(squad(), seed)
    const byId = new Map(run.nodes.map(n => [n.id, n]))
    expect(byId.size).toBe(run.nodes.length)
    const order = (n: RunNode) => (n.act - 1) * 6 + n.layer
    for (const n of run.nodes) {
      expect(new Set(n.next).size).toBe(n.next.length)
      for (const id of n.next) {
        const m = byId.get(id)
        expect(m).toBeDefined()
        expect(order(m!)).toBe(order(n) + 1)
      }
      const isFinal = n.act === ACTS && n.kind === 'boss'
      expect(n.next.length > 0).toBe(!isFinal)
    }
    // BFS from the starting choices reaches every node, so no node is stranded
    const seen = new Set(availableNodes(run).map(n => n.id))
    const queue = [...seen]
    while (queue.length) for (const id of byId.get(queue.shift()!)!.next) if (!seen.has(id)) { seen.add(id); queue.push(id) }
    expect(seen.size).toBe(run.nodes.length)
  })

  it('is deterministic per seed', () => {
    expect(JSON.stringify(newRun(squad(), 77).nodes)).toBe(JSON.stringify(newRun(squad(), 77).nodes))
    expect(JSON.stringify(newRun(squad(), 77).nodes)).not.toBe(JSON.stringify(newRun(squad(), 78).nodes))
  })

  it('bosses fight standard combat; tiers follow the act', () => {
    const run = newRun(squad(), 5)
    for (let a = 1; a <= 3; a++) {
      expect(bossOf(run, a).sitrep).toBe('standard')
      expect(nodeTier(bossOf(run, a))).toBe(a)
    }
  })

  it('sitrepFor wires zones and targets through', () => {
    const map = { zones: [{ name: 'control', tiles: [{ x: 1, y: 1 }] }] }
    const n = (sitrep: any): RunNode => ({ id: 'x', act: 1, layer: 1, kind: 'combat', next: [], seed: 1, sitrep })
    expect(sitrepFor(n('control'), map).zone).toEqual([{ x: 1, y: 1 }])
    expect(sitrepFor(n('assassination'), map, 'boss1').targetId).toBe('boss1')
    expect(sitrepFor(n(undefined), map).id).toBe('standard')
  })

  it('availableNodes follows the cleared node', () => {
    const run = newRun(squad(), 5)
    expect(availableNodes(run).every(n => n.act === 1 && n.layer === 0)).toBe(true)
    const first = availableNodes(run)[0]
    recordBattle(run, first, squadUnits(run), true)
    expect(availableNodes(run).map(n => n.id)).toEqual(first.next)
  })
})

describe('recording a battle', () => {
  it('damage, spent Repairs, destroyed gear and Limited uses carry over to the next battle', () => {
    const run = newRun(squad(), 3)
    const units = squadUnits(run)
    const u = units[0]
    u.hp -= 5; u.structure -= 1; u.stress -= 1; u.repairs -= 2; u.overchargeLevel = 2; u.coreAvailable = false
    u.weapons[0].destroyed = true
    const lim = [...u.weapons, ...u.systems].find(x => x.usesLeft != null)
    if (lim) lim.usesLeft = 0
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
    if (lim) expect([...v.weapons, ...v.systems].find(x => x.dataId === lim.dataId)!.usesLeft).toBe(0)
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

describe('level-ups and refits', () => {
  it('levelUp adds 5 LL (capped at 12) and fully repairs', () => {
    const run = newRun(squad(), 3)
    run.condition[run.squad[0].id].hp = 1
    run.pendingLevelUp = true
    levelUp(run)
    expect(run.squad.every(p => p.level === 5)).toBe(true)
    expect(run.pendingLevelUp).toBe(false)
    expect(run.condition[run.squad[0].id].hp).toBe(buildMechUnit(run.squad[0]).stats.hp)
    levelUp(run); levelUp(run)
    expect(run.squad.every(p => p.level === 12)).toBe(true)
  })

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
})

describe('team selection', () => {
  const teams = ['t1', 't2', 't3'].map(id => ({ id }) as any)
  it('is deterministic per node and avoids teams already beaten', () => {
    const run = newRun(squad(), 3)
    const n = availableNodes(run)[0]
    expect(chooseTeam(run, n, teams).id).toBe(chooseTeam(run, n, teams).id)
    run.nodes[0].cleared = true; run.nodes[0].teamId = 't1'
    run.nodes[1].cleared = true; run.nodes[1].teamId = 't2'
    for (const node of run.nodes.slice(2, 12)) expect(chooseTeam(run, node, teams).id).toBe('t3')
  })
  it('falls back to any team once all have been seen', () => {
    const run = newRun(squad(), 3)
    run.nodes.slice(0, 3).forEach((n, i) => { n.cleared = true; n.teamId = teams[i].id })
    expect(teams.map(t => t.id)).toContain(chooseTeam(run, run.nodes[5], teams).id)
  })
})

describe('save and load', () => {
  let store: Map<string, string>
  beforeEach(() => {
    store = new Map()
    ;(globalThis as any).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    }
  })
  afterEach(() => { delete (globalThis as any).localStorage })

  it('round-trips a run in progress', () => {
    const run = newRun(squad(), 3)
    recordBattle(run, combatNode(run), squadUnits(run), true)
    run.boons.push({ reward: 'perm_acc', pilotId: run.squad[0].id })
    saveRun(run)
    const loaded = loadRun()!
    expect(loaded).toEqual(JSON.parse(JSON.stringify(run)))
    expect(availableNodes(loaded).map(n => n.id)).toEqual(availableNodes(run).map(n => n.id))
  })
  it('saveRun(null) clears the save', () => {
    saveRun(newRun(squad(), 3))
    saveRun(null)
    expect(loadRun()).toBeNull()
  })
  it('discards unreadable saves and reports why', async () => {
    store.set('dov.run.v1', '{not json')
    expect(loadRun()).toBeNull()
    const mod = await import('../src/run/run')
    expect(mod.lastLoadProblem).toMatch(/could not be read/)
    expect(store.has('dov.run.v1')).toBe(false)
  })
  it('does not throw when storage is unavailable', () => {
    ;(globalThis as any).localStorage = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') }, removeItem() { throw new Error('denied') } }
    expect(() => saveRun(newRun(squad(), 3))).not.toThrow()
    expect(loadRun()).toBeNull()
  })
})

describe('events never break a run', () => {
  it('every event applied to every eligible mech keeps the run loadable and battle-ready', () => {
    for (const e of EVENTS) for (let i = 0; i < 4; i++) {
      const run = newRun(squad(), 5)
      run.condition[run.squad[0].id].coreAvailable = false
      const id = run.squad[i].id
      if (e.needsMech && e.eligible && e.eligible(run, id) !== true) continue
      e.apply(run, e.needsMech ? id : undefined)
      for (const c of Object.values(run.condition)) {
        expect(c.hp).toBeGreaterThanOrEqual(1)
        expect(c.structure).toBeGreaterThanOrEqual(1)
        expect(c.stress).toBeGreaterThanOrEqual(1)
        expect(c.repairs).toBeGreaterThanOrEqual(0)
      }
      expect(squadUnits(run).length).toBe(4)
    }
  })
})
