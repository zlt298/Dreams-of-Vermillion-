// Themed pre-built squads and act levels: every preset is legal and fully spent at its level, and pilots
// can be fitted down (or up) to an act's License Level.
import { describe, expect, it } from 'vitest'
import { importPilots } from '../src/import/compcon'
import pregens from '../src/data/pregens/pregens.json'
import ll5 from '../src/data/squads/ll5.json'
import ll10 from '../src/data/squads/ll10.json'
import themed from '../src/data/squads/themed.json'
import { fitToLevel, readyProblems } from '../src/ui/builder'
import { validateBuild } from '../src/rules/legality'
import { buildMechUnit } from '../src/rules/stats'
import { newRun, levelUp, actLevel, ACT_LEVEL } from '../src/run/run'
import type { PilotBuild } from '../src/import/compcon'
import './helpers'

const load = (x: any[]) => x.map(p => importPilots(p)[0])
const presets = themed as unknown as { id: string; theme: string; level: number; pilots: PilotBuild[] }[]

describe('pre-built squads', () => {
  it('has 3 themes at LL0, LL5 and LL10, 4 pilots each', () => {
    expect(presets).toHaveLength(9)
    expect(new Set(presets.map(s => s.theme)).size).toBe(3)
    for (const level of [0, 5, 10]) expect(presets.filter(s => s.level === level)).toHaveLength(3)
    expect(presets.every(s => s.pilots.length === 4)).toBe(true)
    const ids = presets.flatMap(s => s.pilots.map(p => p.id))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it.each(presets.map(s => [s.id, s] as const))('%s: every pilot is legal, at its level, with nothing unspent', (_, s) => {
    for (const p of s.pilots) {
      expect(readyProblems(p, s.level), `${p.callsign}`).toEqual([])
      expect(() => buildMechUnit(p)).not.toThrow()
    }
  })

  it('each act offers one squad per difficulty (Easy, Medium, Hard)', () => {
    for (const level of [0, 5, 10]) expect(presets.filter(s => s.level === level).map(s => (s as any).difficulty).sort()).toEqual(['Easy', 'Hard', 'Medium'])
  })

  it('squads differ: no two pilots in a squad have the same loadout, and themes use different frames', () => {
    for (const s of presets) {
      const loadouts = s.pilots.map(p => JSON.stringify([p.mech.frameId, p.mech.mounts.map(m => m.slots.map(x => x.weaponId)), p.mech.systems]))
      expect(new Set(loadouts).size, s.id).toBe(4)
    }
    const frames = (level: number) => presets.filter(s => s.level === level).flatMap(s => s.pilots.map(p => p.mech.frameId))
    expect(new Set(frames(5)).size).toBe(frames(5).length)
  })

  it('the COMP/CON pregens and the sample squads are ready at their act levels', () => {
    for (const p of load(pregens as any[])) expect(readyProblems(p, 0), p.callsign).toEqual([])
    for (const p of load(ll5 as any[])) expect(readyProblems(p, 5), p.callsign).toEqual([])
    for (const p of load(ll10 as any[])) expect(readyProblems(p, 10), p.callsign).toEqual([])
  })
})

describe('act levels', () => {
  it('acts are fought at LL0, LL5 and LL10', () => {
    expect(ACT_LEVEL).toEqual({ 1: 0, 2: 5, 3: 10 })
    expect(actLevel(3)).toBe(10)
  })

  it('levelUp sets the new act level exactly and leaves the points to spend', () => {
    const run = newRun(load(pregens as any[]).slice(0, 4), 3)
    run.act = 2; run.pendingLevelUp = true
    levelUp(run)
    expect(run.squad.every(p => p.level === 5)).toBe(true)
    expect(run.squad.every(p => readyProblems(p, 5).some(x => /unspent|unchosen/.test(x)))).toBe(true)
    run.act = 3
    levelUp(run); levelUp(run)
    expect(run.squad.every(p => p.level === 10)).toBe(true)
  })

  it('readyProblems flags the wrong level, and a mech with no weapons', () => {
    const p = load(ll5 as any[])[0]
    expect(readyProblems(p, 10)[0]).toMatch(/License Level 10/)
    const bare = fitToLevel(p, 0)
    expect(readyProblems(bare, 0)).toContain('No weapons fitted')
  })
})

describe('fitToLevel', () => {
  it('fits every LL5 and LL10 pilot down to LL0: legal, within budget, roster copy untouched', () => {
    for (const src of [...load(ll5 as any[]), ...load(ll10 as any[]), ...presets.filter(s => s.level).flatMap(s => s.pilots)]) {
      const before = JSON.stringify(src)
      const p = fitToLevel(src, 0)
      expect(JSON.stringify(src)).toBe(before)
      expect(p.level).toBe(0)
      expect(validateBuild(p).errors, src.callsign).toEqual([])
      expect(p.mech.frameId).toBe('mf_standard_pattern_i_everest')
      expect(p.id).toBe(src.id)
    }
  })

  it('fitting LL10 down to LL5 keeps the frame when its license survives', () => {
    for (const s of presets.filter(x => x.level === 10)) for (const src of s.pilots) {
      const p = fitToLevel(src, 5)
      expect(validateBuild(p).errors, src.callsign).toEqual([])
      expect(p.mech.frameId, src.callsign).toBe(src.mech.frameId)
      expect(p.licenses!.reduce((a, l) => a + l.rank, 0)).toBeLessThanOrEqual(5)
    }
  })

  it('fitting up keeps the build and leaves the new points unspent', () => {
    const src = presets.find(s => s.level === 0)!.pilots[0]
    const p = fitToLevel(src, 5)
    expect(p.mech.systems).toEqual(src.mech.systems)
    expect(validateBuild(p).errors).toEqual([])
    expect(readyProblems(p, 5).length).toBeGreaterThan(0)
  })
})
