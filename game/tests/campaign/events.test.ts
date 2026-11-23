// Between-battle events: odds, determinism, eligibility and effects.
import { describe, expect, it } from 'vitest'
import { EVENTS, rollEvent } from '../../src/run/events'
import { newRun, recordBattle, squadUnits, type RunNode } from '../../src/run/run'
import { battle, pregenPilots as squad, pregenUnit } from '../support'

const ev = (id: string) => EVENTS.find(e => e.id === id)!
const node = (seed: number): RunNode => ({ id: `n${seed}`, act: 1, layer: 1, kind: 'combat', next: [], seed })

describe('between-battle events', () => {
  it('has six events per tier', () => {
    for (const t of ['find', 'gamble', 'pact']) expect(EVENTS.filter(e => e.tier === t)).toHaveLength(6)
  })
  it('rolls about 25% nothing / 50% find / 15% gamble / 10% hard choice, deterministically per node', () => {
    const n = { none: 0, find: 0, gamble: 0, pact: 0 }
    for (let s = 1; s <= 4000; s++) { const e = rollEvent(node(s * 7919)); n[e ? e.tier : 'none']++ }
    expect(n.none / 4000).toBeCloseTo(0.25, 1)
    expect(n.find / 4000).toBeCloseTo(0.5, 1)
    expect(n.gamble / 4000).toBeCloseTo(0.15, 1)
    expect(n.pact / 4000).toBeCloseTo(0.1, 1)
    expect(rollEvent(node(42))?.id).toBe(rollEvent(node(42))?.id)
  })
  it('every event applies without errors', () => {
    for (const e of EVENTS) {
      const run = newRun(squad(), 5)
      run.condition[run.squad[0].id].coreAvailable = false // so Reactor Tap has a taker
      const id = run.squad.find(p => !e.eligible || e.eligible(run, p.id) === true)?.id
      expect(typeof e.apply(run, e.needsMech ? id : undefined)).toBe('string')
    }
  })
  it('every event applied to every eligible mech keeps the run loadable and battle-ready', () => {
    const applied = new Set<string>()
    for (const e of EVENTS) for (let i = 0; i < 4; i++) {
      const run = newRun(squad(), 5)
      run.condition[run.squad[0].id].coreAvailable = false
      const id = run.squad[i].id
      if (e.needsMech && e.eligible && e.eligible(run, id) !== true) continue
      e.apply(run, e.needsMech ? id : undefined)
      applied.add(e.id)
      for (const c of Object.values(run.condition)) {
        expect(c.hp).toBeGreaterThanOrEqual(1)
        expect(c.structure).toBeGreaterThanOrEqual(1)
        expect(c.stress).toBeGreaterThanOrEqual(1)
        expect(c.repairs).toBeGreaterThanOrEqual(0)
      }
      expect(squadUnits(run).length).toBe(4)
    }
    // the eligibility skip must not hide an event: each one was applied to at least one mech
    expect([...applied].sort()).toEqual(EVENTS.map(e => e.id).sort())
  })
  it('a minor find gives a Repair', () => {
    const run = newRun(squad(), 5)
    const p = run.squad[0].id
    const before = run.condition[p].repairs
    ev('field_kit').apply(run, p)
    expect(run.condition[p].repairs).toBe(before + 1)
  })
  it('permanent boons persist across battles; one-battle boons are consumed', () => {
    const run = newRun(squad(), 5)
    const p = run.squad[0].id
    ev('burning_warehouse').apply(run, p)
    ev('plating').apply(run, p)
    let u = squadUnits(run).find(x => x.flags.pilotId === p)!
    expect(u.overshield).toBe(4)
    const base = squadUnits(newRun(squad(), 5)).find(x => x.flags.pilotId === p)!.stats.hp
    expect(u.stats.hp).toBe(base + 2)
    recordBattle(run, node(1), squadUnits(run), true)
    u = squadUnits(run).find(x => x.flags.pilotId === p)!
    expect(u.overshield).toBe(0)
    expect(u.stats.hp).toBe(base + 2)
  })
  it('heavy costs check eligibility: Structure, Stress and systems', () => {
    const run = newRun(squad(), 5)
    const p = run.squad[0].id
    run.condition[p].structure = 1
    expect(ev('through_fire').eligible!(run, p)).toMatch(/Structure/)
    run.condition[p].stress = 1
    expect(ev('choir_armoury').eligible!(run, p)).toMatch(/Stress/)
    run.condition[p].destroyedSystems = [...run.squad[0].mech.systems]
    expect(ev('targeting_core').eligible!(run, p)).toMatch(/systems/)
  })
  // regression: Hot-Loaded Rounds was offered with nothing left to give up
  it('Hot-Loaded Rounds is not offered when every Limited item is empty and no Repairs are left', () => {
    const run = newRun(squad(), 3)
    const e = ev('hot_loaded')
    const p = run.squad[0]
    const c = run.condition[p.id]
    c.repairs = 0
    const u = squadUnits(run).find(x => x.flags.pilotId === p.id)!
    const lim = [...u.weapons, ...u.systems].filter(x => x.usesLeft != null && x.dataId)
    expect(lim.length).toBeGreaterThan(0)
    for (const x of lim) c.limited[x.dataId!] = 0
    expect(e.eligible!(run, p.id)).toBe('Nothing to give up') // was: true
  })
  it('a system lost to an event stays destroyed in the next battle', () => {
    const run = newRun(squad(), 5)
    const p = run.squad.find(x => x.mech.systems.length)!.id
    ev('prototype_actuators').apply(run, p)
    expect(run.condition[p].destroyedSystems).toHaveLength(1)
    const u = squadUnits(run).find(x => x.flags.pilotId === p)!
    expect(u.systems.some(s => s.destroyed)).toBe(true)
  })
  it('a mech Stunned by A Voice in the Static cannot act in round 1', () => {
    const run = newRun(squad(), 5)
    const p = run.squad[0].id
    ev('voice_static').apply(run, p)
    const units = squadUnits(run)
    const u = units.find(x => x.flags.pilotId === p)!
    units.forEach((x, i) => (x.pos = { x: 1 + i * 2, y: 1 }))
    const foe = pregenUnit('Assault', 'enemy'); foe.pos = { x: 6, y: 10 }
    const b = battle([...units, foe])
    b.beginTurn(u)
    expect(b.has(u, 'stunned')).toBe(true)
    expect(u.actionsLeft).toBe(0)
    expect(Object.values(run.condition).every(c => c.coreAvailable)).toBe(true)
  })
})
