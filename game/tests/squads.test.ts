// The sample LL5/LL10 squads must be legal COMP/CON builds (they drive the balance sim).
import { describe, expect, it } from 'vitest'
import { Lancer } from '../src/data/lancer'
import { importPilots } from '../src/import/compcon'
import { buildMechUnit } from '../src/rules/stats'
import { validateBuild } from '../src/rules/legality'
import ll5 from '../src/data/squads/ll5.json'
import ll10 from '../src/data/squads/ll10.json'
import './helpers'

describe.each([['LL5', ll5], ['LL10', ll10]] as const)('%s sample squad', (_n, squad) => {
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
