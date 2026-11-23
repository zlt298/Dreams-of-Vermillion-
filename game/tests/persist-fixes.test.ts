// Regression tests: persistence, determinism and undo bugs found in the final bug hunt.
import { afterEach, describe, expect, it } from 'vitest'
import type { PilotBuild } from '../src/import/compcon'
import { importPilots } from '../src/import/compcon'
import { buildMechUnit } from '../src/rules/stats'
import { Battle } from '../src/rules/battle'
import { exportBattle, replayBattle, stateHash } from '../src/replay/replay'
import { loadRun, migrateRun, saveRun, newRun, squadUnits, SAVE_VERSION } from '../src/run/run'
import { loadBattle } from '../src/run/battle-save'
import type { Unit } from '../src/rules/types'
import pregens from '../src/data/pregens/pregens.json'
import { flatMap } from './helpers'

function mech(systems: string[], side: 'player' | 'enemy' = 'player'): Unit {
  const p = {
    id: `t-${side}`, callsign: 'T', name: `T-${side}`, level: 6, mechSkills: [2, 2, 2, 2], talents: [], coreBonuses: [],
    mech: { name: 'T', frameId: 'mf_standard_pattern_i_everest', mounts: [{ type: 'Main', slots: [{ size: 'Main', weaponId: 'mw_assault_rifle' }], bonusEffects: [] }], systems },
    unknown: [],
  } as unknown as PilotBuild
  return buildMechUnit(p, side)
}
const ask = (b: Battle, u: Unit) => b.choose({ kind: 'test', unit: u, title: 'React?', options: [{ label: 'Yes' }, { label: 'No' }], defaultIndex: 0 })

class MemStorage {
  m = new Map<string, string>()
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
}
afterEach(() => { delete (globalThis as any).localStorage })

describe('uid counter is not part of undo / rollback state', () => {
  it('in-session undo (checkpoint restore) does not rewind the id counter: the saved replay rebuilds a different battle', () => {
    const a = mech(['ms_pattern_b_hex_charges']), e = mech([], 'enemy')
    a.pos = { x: 5, y: 4 }; e.pos = { x: 5, y: 12 }
    const b = new Battle({ map: flatMap(14, 16), units: [a, e], seed: 5 })
    b.start()
    b.chooser = () => undefined
    b.transaction(() => b.beginTurn(a))
    const mineAct = () => b.customActions(a).find(x => /Explosive Mine/.test(x.name))!
    // what BattleScreen.cmd + undo() do: snapshot, act, restore the snapshot, act again
    const snap = b.checkpoint()
    b.transaction(() => b.useCustom(a, mineAct(), { x: 5, y: 5 }), [], { rollbackOnError: true })
    snap()
    b.transaction(() => b.useCustom(a, mineAct(), { x: 5, y: 5 }), [], { rollbackOnError: true })
    const x = exportBattle(b) // what saveBattle stores
    const resumed = replayBattle(JSON.parse(JSON.stringify(x)))
    expect(resumed.mines.map(m => m.id)).toEqual(b.mines.map(m => m.id))
    expect(stateHash(resumed)).toBe(x.hash)
  })

  it('a PendingChoice rollback does not rewind the id counter: after resume, a recorded attack on a spawned drone is silently lost', () => {
    const a = mech([]), e = mech(['ms_turret_drones'], 'enemy')
    a.pos = { x: 5, y: 3 }; e.pos = { x: 5, y: 10 }
    const b = new Battle({ map: flatMap(12, 14), units: [a, e], seed: 4 })
    b.start()
    b.chooser = () => undefined
    b.transaction(() => b.beginTurn(a)); b.transaction(() => b.endTurn(a))
    // enemy turn: deploys a drone, then the player is asked a question (e.g. a reaction) -> rollback + replay with the answer
    const enemyTurn = () => {
      b.beginTurn(e)
      b.useCustom(e, b.customActions(e).find(x => x.key === 'turret')!, { x: 5, y: 8 })
      ask(b, a)
      b.endTurn(e)
    }
    expect('pending' in b.transaction(enemyTurn)).toBe(true)
    b.transaction(enemyTurn, [1])
    const drone = b.units.find(u => u.kind === 'drone')!
    b.transaction(() => b.beginTurn(a))
    b.transaction(() => { b.skirmish(a, a.weapons[0], { targetId: drone.id }) })
    expect(drone.hp).toBeLessThan(drone.stats.hp) // the shot landed in the live battle
    const x = exportBattle(b)
    const resumed = replayBattle(JSON.parse(JSON.stringify(x)))
    expect(resumed.units.map(u => u.id)).toEqual(b.units.map(u => u.id))
    expect(resumed.units.find(u => u.kind === 'drone')!.hp).toBe(drone.hp)
  })
})

describe('checkpoint restore inside a command', () => {
  it('a refund (checkpoint restore) inside a command detaches currentCommand, so later player answers are not recorded', () => {
    const a = mech([]), e = mech([], 'enemy')
    a.pos = { x: 5, y: 3 }; e.pos = { x: 5, y: 10 }
    const b = new Battle({ map: flatMap(12, 14), units: [a, e], seed: 4 })
    b.start()
    b.chooser = () => undefined
    b.transaction(() => b.beginTurn(a)); b.transaction(() => b.endTurn(a))
    b.transaction(() => b.beginTurn(e))
    // inside one top-level command (as in an AI turn): an attack refused before rolling (skirmish refunds via
    // checkpoint) and then a player decision. AI turns do hit the refund path in normal autoBattles.
    const turn = () => b.command('aiTurn', [e], () => {
      b.skirmish(e, e.weapons[0], { targetId: 'nobody' })
      ask(b, a)
    })
    expect('pending' in b.transaction(turn)).toBe(true)
    b.transaction(turn, [1])
    const rec = b.commands[b.commands.length - 1]
    expect(rec.op).toBe('aiTurn')
    expect(rec.answers).toEqual([1]) // replays feed this back; without it they take the default (0)
  })
})

describe('run / battle save loading', () => {
  it('loadRun deletes a save made by a newer version (the message says it was only "not loaded")', () => {
    const ls = new MemStorage(); (globalThis as any).localStorage = ls
    const pilot = importPilots((pregens as any[])[0])[0]
    const run = newRun([pilot], 123)
    ls.setItem('dov.run.v1', JSON.stringify({ ...run, version: SAVE_VERSION + 1 }))
    expect(loadRun()).toBeNull()
    expect(ls.getItem('dov.run.v1')).not.toBeNull()
  })

  it('loadBattle accepts a malformed battle save that then crashes replayBattle (app.ts startBattle has no guard)', () => {
    const ls = new MemStorage(); (globalThis as any).localStorage = ls
    ls.setItem('dov.battle.v1', JSON.stringify({ runSeed: 1, nodeId: 'a1l0n0', title: 'x', data: { format: 'dov-battle', version: 1 } }))
    const saved = loadBattle()
    // either reject it at load time, or replaying it must not throw
    if (saved) expect(() => replayBattle(saved.data)).not.toThrow()
  })

  it('validateRun accepts a condition entry missing its arrays, and squadUnits then crashes', () => {
    const pilot = importPilots((pregens as any[])[0])[0]
    const run = JSON.parse(JSON.stringify(newRun([pilot], 7)))
    run.condition[pilot.id] = { hp: 5 } // partial/corrupt entry
    const r = migrateRun(run)
    if (r) expect(() => squadUnits(r)).not.toThrow()
  })
})
