// Importing squads and NPC packs from outside the game: COMP/CON pilot files (fallbacks, unknown content, malformed
// shapes) and LCP packs with malformed entries. A bad file is refused with a clear ImportError or read as far as it
// is sound, never a raw TypeError.
import { describe, expect, it } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { importPilots, ImportError } from '../../src/import/compcon'
import { readLcp } from '../../src/import/lcp'
import { mechSP } from '../../src/rules/stats'
import { validateBuild } from '../../src/rules/legality'
import v3fixture from '../fixtures/V3_FIXTURE.json'
import '../support'

describe('COMP/CON import: edge cases', () => {
  it('falls back to the first mech when the favourite mech is missing', () => {
    const v3 = JSON.parse(JSON.stringify(v3fixture))
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

describe('COMP/CON import: malformed files', () => {
  const cases: [string, unknown][] = [
    ['null mech', { mechs: [null] }],
    ['null mount', { mechs: [{ frame: 'mf_standard_pattern_i_everest', loadouts: [{ mounts: [null] }] }] }],
    ['null slot', { mechs: [{ frame: 'mf_standard_pattern_i_everest', loadouts: [{ mounts: [{ mount_type: 'Main', slots: [null] }] }] }] }],
    ['null talent', { talents: [null], mechs: [{ frame: 'mf_standard_pattern_i_everest' }] }],
    ['mounts object', { mechs: [{ frame: 'mf_standard_pattern_i_everest', loadouts: [{ mounts: {} }] }] }],
    ['systems number', { mechs: [{ frame: 'mf_standard_pattern_i_everest', loadouts: [{ systems: 5 }] }] }],
    ['talents object', { talents: {}, mechs: [{ frame: 'mf_standard_pattern_i_everest' }] }],
    ['core_bonuses string', { core_bonuses: 'abc', mechs: [{ frame: 'mf_standard_pattern_i_everest' }] }],
    ['pregen null mount', { name: 'X', build: { mech: { mounts: [null] } } }],
  ]
  // regression: these crashed the importer with a raw TypeError
  it.each(cases)('%s: throws ImportError, not a raw TypeError', (_n, json) => {
    expect(() => importPilots(json)).toThrow(ImportError)
  })

  // regression: a pregen-shaped file without mechSkills crashed mechSP (pilotCard calls it outside its try)
  it('a pregen-shaped file without mechSkills defaults them, so mechSP/validateBuild (the hangar card) work', () => {
    const [p] = importPilots({ name: 'X', build: { mech: {} } }) // accepted: no ImportError
    expect(() => mechSP(p)).not.toThrow() // was: TypeError reading '2' of undefined
    expect(() => validateBuild(p)).not.toThrow()
  })

  // regression: a string level was concatenated into the mech skill budget
  it('a string level is coerced to a number (not "2" + "5" = 25 mech skill points)', () => {
    const [p] = importPilots({ level: '5', mechs: [{ frame: 'mf_standard_pattern_i_everest' }] })
    expect(validateBuild(p).budgets.hase.max).toBe(7) // was: "25" (2 + "5")
  })
})

describe('LCP import: malformed packs', () => {
  const z = (files: Record<string, unknown>) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(JSON.stringify(v))])))
  const cls = { id: 'c', name: 'Cls', role: 'striker', stats: { hp: [10, 12, 14] } }
  // [case, pack files, class names read, feature ids of the first class]: malformed entries are skipped, the rest is read
  const cases: [string, Record<string, unknown>, string[], string[]][] = [
    ['v1 features object', { 'npc_classes.json': [cls], 'npc_features.json': {} }, ['Cls'], []],
    ['v1 null class', { 'npc_classes.json': [null, cls] }, ['Cls'], []],
    ['v2 null feature', { 'npcc_a.json': [cls, null] }, ['Cls'], []],
    ['numeric class name', { 'npcc_a.json': [{ ...cls, name: 5 }], 'npcc_b.json': [cls] }, ['5', 'Cls'], []],
    ['tags object', { 'npcc_a.json': [cls, { id: 'f', name: 'F', type: 'Weapon', tags: {} }] }, ['Cls'], ['f']],
    ['bonuses object', { 'npcc_a.json': [cls, { id: 'f', name: 'F', type: 'Trait', bonuses: {} }] }, ['Cls'], ['f']],
  ]
  // regression: these crashed readLcp with a raw TypeError
  it.each(cases)('%s: reads the sound parts of the pack', (_n, files, classes, features) => {
    const pack = readLcp(z(files))
    expect(pack.classes.map(c => c.name)).toEqual(classes)
    expect(pack.classes[0].features.map(f => f.id)).toEqual(features)
  })
})
