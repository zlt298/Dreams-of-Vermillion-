// Themed pre-built squads, the sample LL2/LL5/LL8 squads and act levels: every preset and sample is a legal COMP/CON
// build, fully spent at its level (the samples drive the balance sim), each pilot stays recognizable from act to act,
// and pilots can be fitted down (or up) to an act's License Level.
import { describe, expect, it } from 'vitest'
import { Lancer } from '../../src/data/lancer'
import { importPilots } from '../../src/import/compcon'
import pregens from '../../src/data/pregens/pregens.json'
import ll2 from '../../src/data/squads/ll2.json'
import ll5 from '../../src/data/squads/ll5.json'
import ll8 from '../../src/data/squads/ll8.json'
import themed from '../../src/data/squads/themed.json'
import { fitToLevel, readyProblems } from '../../src/ui/builder'
import { validateBuild } from '../../src/rules/legality'
import { buildMechUnit } from '../../src/rules/stats'
import { newRun, levelUp, actLevel, ACT_LEVEL } from '../../src/run/run'
import type { PilotBuild } from '../../src/import/compcon'
import '../support'

const load = (x: any[]) => x.map(p => importPilots(p)[0])
const presets = themed as unknown as { id: string; theme: string; level: number; pilots: PilotBuild[] }[]
const LEVELS = [2, 5, 8]
const SAMPLES: [number, any[]][] = [[2, ll2], [5, ll5], [8, ll8]]
const gear = (p: PilotBuild) => [...p.mech.mounts.flatMap(m => m.slots.map(s => s.weaponId)).filter(Boolean), ...p.mech.systems] as string[]

/** The same pilot one act later: same frame, nothing goes down, and most of the gear is kept. */
function expectCarriedForward(was: PilotBuild, now: PilotBuild) {
  const who = `${now.callsign} LL${was.level}→LL${now.level}`
  expect(now.mech.frameId, who).toBe(was.mech.frameId)
  now.mechSkills.forEach((s, i) => expect(s, who).toBeGreaterThanOrEqual(was.mechSkills[i]))
  for (const t of was.talents) expect(now.talents.find(x => x.id === t.id)?.rank ?? 0, `${who} ${t.id}`).toBeGreaterThanOrEqual(t.rank)
  for (const l of was.licenses ?? []) expect(now.licenses?.find(x => x.id === l.id)?.rank ?? 0, `${who} ${l.id}`).toBeGreaterThanOrEqual(l.rank)
  for (const c of was.coreBonuses) expect(now.coreBonuses, who).toContain(c)
  const kept = gear(was).filter(g => gear(now).includes(g))
  expect(gear(was).length - kept.length, `${who}: gear swapped out`).toBeLessThanOrEqual(2)
}

describe('pre-built squads', () => {
  it('has 3 themes at LL2, LL5 and LL8, 4 pilots each', () => {
    expect(presets).toHaveLength(9)
    expect(new Set(presets.map(s => s.theme)).size).toBe(3)
    for (const level of LEVELS) expect(presets.filter(s => s.level === level)).toHaveLength(3)
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
    for (const level of LEVELS) expect(presets.filter(s => s.level === level).map(s => (s as any).difficulty).sort()).toEqual(['Easy', 'Hard', 'Medium'])
  })

  it('squads differ: no two pilots in a squad have the same loadout, and themes use different frames', () => {
    for (const s of presets) {
      const loadouts = s.pilots.map(p => JSON.stringify([p.mech.frameId, p.mech.mounts.map(m => m.slots.map(x => x.weaponId)), p.mech.systems]))
      expect(new Set(loadouts).size, s.id).toBe(4)
    }
    for (const level of LEVELS) {
      const frames = presets.filter(s => s.level === level).flatMap(s => s.pilots.map(p => p.mech.frameId))
      expect(new Set(frames).size, `LL${level}`).toBe(frames.length)
      expect(frames, `LL${level}: licensed frames from act 1 on`).not.toContain('mf_standard_pattern_i_everest')
    }
  })

  it('each themed pilot is recognizable from act to act: the next level is built on the previous one', () => {
    for (const theme of new Set(presets.map(s => s.theme))) {
      const byLevel = LEVELS.map(l => presets.find(s => s.theme === theme && s.level === l)!)
      for (let k = 1; k < byLevel.length; k++) byLevel[k].pilots.forEach((p, i) => expectCarriedForward(byLevel[k - 1].pilots[i], p))
    }
  })

  it('the COMP/CON pregens and the sample squads are ready at their levels', () => {
    for (const p of load(pregens as any[])) expect(readyProblems(p, 0), p.callsign).toEqual([])
    for (const [level, squad] of SAMPLES) for (const p of load(squad)) expect(readyProblems(p, level), p.callsign).toEqual([])
  })

  it('each sample pilot is recognizable from act to act', () => {
    for (let k = 1; k < SAMPLES.length; k++) {
      const was = load(SAMPLES[k - 1][1]), now = load(SAMPLES[k][1])
      now.forEach((p, i) => { expect(p.callsign).toBe(was[i].callsign); expectCarriedForward(was[i], p) })
    }
  })
})

describe('act levels', () => {
  it('acts are fought at LL2, LL5 and LL8', () => {
    expect(ACT_LEVEL).toEqual({ 1: 2, 2: 5, 3: 8 })
    expect(actLevel(1)).toBe(2)
    expect(actLevel(3)).toBe(8)
  })

  it('levelUp sets the new act level exactly and leaves the points to spend', () => {
    const run = newRun(load(ll2 as any[]), 3)
    expect(run.squad.every(p => !readyProblems(p, actLevel(1)).length)).toBe(true)
    run.act = 2; run.pendingLevelUp = true
    levelUp(run)
    expect(run.squad.every(p => p.level === 5)).toBe(true)
    expect(run.squad.every(p => readyProblems(p, 5).some(x => /unspent|unchosen/.test(x)))).toBe(true)
    run.act = 3
    levelUp(run); levelUp(run)
    expect(run.squad.every(p => p.level === 8)).toBe(true)
  })

  it('readyProblems flags the wrong level, and a mech with no weapons', () => {
    const p = load(ll5 as any[])[0]
    expect(readyProblems(p, 8)[0]).toMatch(/License Level 8/)
    const bare = fitToLevel(p, 0)
    expect(readyProblems(bare, 0)).toContain('No weapons fitted')
  })
})

describe('fitToLevel', () => {
  const higher = () => [...load(ll5 as any[]), ...load(ll8 as any[]), ...presets.filter(s => s.level > 2).flatMap(s => s.pilots)]

  it('fits every LL5 and LL8 pilot down to the act 1 level (LL2): legal, frame kept, roster copy untouched', () => {
    for (const src of higher()) {
      const before = JSON.stringify(src)
      const p = fitToLevel(src, 2)
      expect(JSON.stringify(src)).toBe(before)
      expect(p.level).toBe(2)
      expect(validateBuild(p).errors, src.callsign).toEqual([])
      expect(p.mech.frameId, src.callsign).toBe(src.mech.frameId) // LL2's two license ranks still cover the frame
      expect(p.licenses!.reduce((a, l) => a + l.rank, 0)).toBeLessThanOrEqual(2)
      expect(p.id).toBe(src.id)
    }
  })

  it('fits down to LL0 too: legal, back on the Everest', () => {
    for (const src of higher()) {
      const p = fitToLevel(src, 0)
      expect(validateBuild(p).errors, src.callsign).toEqual([])
      expect(p.mech.frameId).toBe('mf_standard_pattern_i_everest')
    }
  })

  it('fitting LL8 down to LL5 keeps the frame when its license survives', () => {
    for (const s of presets.filter(x => x.level === 8)) for (const src of s.pilots) {
      const p = fitToLevel(src, 5)
      expect(validateBuild(p).errors, src.callsign).toEqual([])
      expect(p.mech.frameId, src.callsign).toBe(src.mech.frameId)
      expect(p.licenses!.reduce((a, l) => a + l.rank, 0)).toBeLessThanOrEqual(5)
    }
  })

  it('fitting up keeps the build and leaves the new points unspent', () => {
    const src = presets.find(s => s.level === 2)!.pilots[0]
    const p = fitToLevel(src, 5)
    expect(p.mech.systems).toEqual(src.mech.systems)
    expect(validateBuild(p).errors).toEqual([])
    expect(readyProblems(p, 5).length).toBeGreaterThan(0)
  })

  it('an LL0 COMP/CON pregen fitted up to the act 1 level keeps its Everest build, with points to spend', () => {
    for (const src of load(pregens as any[])) {
      const p = fitToLevel(src, actLevel(1))
      expect(p.level).toBe(2)
      expect(validateBuild(p).errors, src.callsign).toEqual([])
      expect(p.mech.systems).toEqual(src.mech.systems)
      expect(readyProblems(p, 2).some(x => /unspent/.test(x)), src.callsign).toBe(true)
    }
  })
})

describe.each(SAMPLES.map(([l, s]) => [`LL${l}`, s] as const))('%s sample squad', (_n, squad) => {
  it.each((squad as any[]).map(p => [p.callsign, p]))('%s is a legal build', (_c, raw) => {
    const [p] = importPilots(raw)
    expect(p.unknown).toEqual([])
    const r = validateBuild(p)
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([]) // every point is spent
    expect(Lancer.frames.get(p.mech.frameId)!.mounts.length).toBe(p.mech.mounts.length)
    expect(buildMechUnit(p).weapons.length).toBeGreaterThan(0)
  })
})
