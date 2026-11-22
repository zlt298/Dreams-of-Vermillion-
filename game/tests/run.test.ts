import { describe, expect, it } from 'vitest'
import { importPilots } from '../src/import/compcon'
import { newRun, migrateRun, validateRun, replacePilots, SAVE_VERSION } from '../src/run/run'
import pregens from '../src/data/pregens/pregens.json'
import './helpers'

const squad = () => (pregens as any[]).slice(0, 2).map(p => importPilots(p)[0])

describe('save migration', () => {
  it('accepts a current-version save round-tripped through JSON', () => {
    const run = newRun(squad(), 7)
    const loaded = migrateRun(JSON.parse(JSON.stringify({ ...run, version: SAVE_VERSION })))
    expect(loaded?.squad.length).toBe(2)
  })
  it('rejects saves from newer versions and damaged saves', () => {
    const run = newRun(squad(), 7)
    expect(migrateRun({ ...run, version: SAVE_VERSION + 1 })).toBeNull()
    expect(migrateRun({ ...run, version: SAVE_VERSION, squad: [] })).toBeNull()
    expect(validateRun({ ...run, current: 'nope' })).toMatch(/current node/)
  })
  it('repairs a missing condition entry', () => {
    const run = newRun(squad(), 7)
    delete (run.condition as any)[run.squad[0].id]
    expect(migrateRun({ ...run, version: SAVE_VERSION })!.condition[run.squad[0].id]).toBeTruthy()
  })
})

describe('re-import matching', () => {
  it('matches by id first, then by a unique callsign; reports ambiguity and strays', () => {
    const run = newRun(squad(), 3)
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
  it('refuses to guess when several squad pilots share a callsign', () => {
    const run = newRun(squad(), 3)
    run.squad[1].callsign = run.squad[0].callsign
    const r = replacePilots(run, [{ ...run.squad[0], id: 'new' }])
    expect(r.ambiguous.length).toBe(1)
  })
})

describe('importer edge cases', () => {
  it('falls back to the first mech when the favourite mech is missing', () => {
    const v3 = JSON.parse(JSON.stringify(require('./fixtures/V3_FIXTURE.json')))
    v3.data.favorite_mech = 'does-not-exist'
    const [p] = importPilots(v3)
    expect(p.mech.frameId).toBe(v3.data.mechs[0].frame)
  })
  it('tolerates a mech without loadouts', () => {
    const [p] = importPilots({ id: 'x', callsign: 'Bare', level: 1, mechs: [{ name: 'Empty', frame: 'mf_standard_pattern_i_everest' }] })
    expect(p.mech.mounts).toEqual([])
    expect(p.mech.systems).toEqual([])
  })
  it('flags frames and gear that are not in lancer-data', () => {
    const [p] = importPilots({ id: 'y', callsign: 'LCP', mechs: [{ frame: 'mf_homebrew_thing', loadouts: [{ systems: [{ id: 'ms_homebrew' }], mounts: [] }] }] })
    expect(p.unknown).toEqual(['mf_homebrew_thing', 'ms_homebrew'])
  })
  it('rejects pilots without mechs with a clear message', () => {
    expect(() => importPilots({ callsign: 'Walker', mechs: [] })).toThrow(/no mechs/)
  })
})
