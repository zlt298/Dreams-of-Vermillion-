// Saving and loading: the run save (round trip, unreadable/unavailable storage, version migration and repair) and
// the battle-in-progress save.
import { describe, expect, it } from 'vitest'
import {
  newRun, availableNodes, recordBattle, squadUnits, saveRun, loadRun, migrateRun, validateRun, SAVE_VERSION,
} from '../../src/run/run'
import { loadBattle } from '../../src/run/battle-save'
import { MemStorage, pregenPilots as squad, useLocalStorage } from '../support'

describe('save and load', () => {
  it('round-trips a run in progress', () => {
    useLocalStorage()
    const run = newRun(squad(), 3)
    recordBattle(run, availableNodes(run)[0], squadUnits(run), true)
    run.boons.push({ reward: 'perm_acc', pilotId: run.squad[0].id })
    saveRun(run)
    const loaded = loadRun()!
    expect(loaded).toEqual(JSON.parse(JSON.stringify(run)))
    expect(availableNodes(loaded).map(n => n.id)).toEqual(availableNodes(run).map(n => n.id))
  })
  it('saveRun(null) clears the save', () => {
    useLocalStorage()
    saveRun(newRun(squad(), 3))
    saveRun(null)
    expect(loadRun()).toBeNull()
  })
  it('discards unreadable saves and reports why', async () => {
    const ls = useLocalStorage(new MemStorage()) as MemStorage
    ls.setItem('dov.run.v1', '{not json')
    expect(loadRun()).toBeNull()
    const mod = await import('../../src/run/run')
    expect(mod.lastLoadProblem).toMatch(/could not be read/)
    expect(ls.data.has('dov.run.v1')).toBe(false)
  })
  it('does not throw when storage is unavailable', () => {
    useLocalStorage({ getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') }, removeItem() { throw new Error('denied') } })
    expect(() => saveRun(newRun(squad(), 3))).not.toThrow()
    expect(loadRun()).toBeNull()
  })
  // regression: loadRun deleted a save from a newer version although the message said it was only "not loaded"
  it('loadRun keeps a save made by a newer version (the message says it was "not loaded")', () => {
    const ls = useLocalStorage(new MemStorage()) as MemStorage
    const run = newRun(squad(1), 123)
    ls.setItem('dov.run.v1', JSON.stringify({ ...run, version: SAVE_VERSION + 1 }))
    expect(loadRun()).toBeNull()
    expect(ls.getItem('dov.run.v1')).not.toBeNull()
  })
})

describe('save migration', () => {
  it('accepts a current-version save round-tripped through JSON', () => {
    const run = newRun(squad(2), 7)
    const loaded = migrateRun(JSON.parse(JSON.stringify({ ...run, version: SAVE_VERSION })))
    expect(loaded?.squad.length).toBe(2)
  })
  it('rejects saves from newer versions and damaged saves', () => {
    const run = newRun(squad(2), 7)
    expect(migrateRun({ ...run, version: SAVE_VERSION + 1 })).toBeNull()
    expect(migrateRun({ ...run, version: SAVE_VERSION, squad: [] })).toBeNull()
    expect(validateRun({ ...run, current: 'nope' })).toMatch(/current node/)
  })
  it('repairs a missing condition entry', () => {
    const run = newRun(squad(2), 7)
    delete (run.condition as any)[run.squad[0].id]
    expect(migrateRun({ ...run, version: SAVE_VERSION })!.condition[run.squad[0].id]).toBeTruthy()
  })
  // regression: a condition entry missing its arrays passed validation, and squadUnits then crashed
  it('migrateRun repairs a condition entry missing its arrays, so squadUnits works', () => {
    const [pilot] = squad(1)
    const run = JSON.parse(JSON.stringify(newRun([pilot], 7)))
    run.condition[pilot.id] = { hp: 5 } // partial/corrupt entry
    const r = migrateRun(run)
    expect(r).not.toBeNull()
    expect(r!.condition[pilot.id].hp).toBe(5)
    expect(() => squadUnits(r!)).not.toThrow()
  })
})

describe('battle save', () => {
  // regression: loadBattle accepted a malformed battle save that then crashed replayBattle (app.ts startBattle has no guard)
  it('loadBattle rejects a malformed battle save instead of handing it to replayBattle', () => {
    const ls = useLocalStorage(new MemStorage()) as MemStorage
    ls.setItem('dov.battle.v1', JSON.stringify({ runSeed: 1, nodeId: 'a1l0n0', title: 'x', data: { format: 'dov-battle', version: 1 } }))
    expect(loadBattle()).toBeNull()
  })
})
