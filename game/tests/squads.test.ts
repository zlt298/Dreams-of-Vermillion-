// The sample LL3/LL6 squads must be legal COMP/CON builds (they drive the balance sim).
import { describe, expect, it } from 'vitest'
import { Lancer } from '../src/data/lancer'
import { importPilots } from '../src/import/compcon'
import { mechSP, buildMechUnit } from '../src/rules/stats'
import ll3 from '../src/data/squads/ll3.json'
import ll6 from '../src/data/squads/ll6.json'
import './helpers'

const mountAllows: Record<string, string[]> = Lancer.rules.mount_fittings

describe.each([['LL3', ll3], ['LL6', ll6]] as const)('%s sample squad', (_n, squad) => {
  it.each((squad as any[]).map(p => [p.callsign, p]))('%s is a legal build', (_c, raw) => {
    const [p] = importPilots(raw)
    const LL = p.level
    expect(p.unknown).toEqual([])
    const sp = mechSP(p)
    expect(sp.used).toBeLessThanOrEqual(sp.max)
    expect(p.mechSkills.reduce((a, b) => a + b, 0)).toBe(2 + LL)
    expect(Math.max(...p.mechSkills)).toBeLessThanOrEqual(6)
    expect(p.talents.reduce((a, t) => a + t.rank, 0)).toBe(3 + LL)
    expect(p.coreBonuses.length).toBeLessThanOrEqual(Math.floor(LL / 3))
    // license ranks: each licensed item needs that rank in its license; total ranks used ≤ LL
    const need = new Map<string, number>()
    const add = (lic?: string, lvl?: number) => { if (lic && lic !== 'GMS' && lvl) need.set(lic, Math.max(need.get(lic) ?? 0, lvl)) }
    const f = Lancer.frames.get(p.mech.frameId)!
    add(f.name, f.license_level)
    for (const m of p.mech.mounts) for (const s of m.slots) if (s.weaponId) { const w = Lancer.weapons.get(s.weaponId)!; add(w.license, w.license_level) }
    for (const s of p.mech.systems) { const d = Lancer.systems.get(s)!; add(d.license, d.license_level) }
    expect([...need.values()].reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(LL)
    // weapons fit their mounts
    for (const m of p.mech.mounts) for (const s of m.slots) if (s.weaponId) {
      const size = Lancer.weapons.get(s.weaponId)!.mount
      const allowed = m.type === 'Main/Aux' ? ['Main', 'Auxiliary'] : m.type === 'Aux/Aux' ? ['Auxiliary'] : mountAllows[m.type] ?? []
      expect(allowed).toContain(size)
    }
    expect(f.mounts.length).toBe(p.mech.mounts.length)
    expect(buildMechUnit(p).weapons.length).toBeGreaterThan(0)
  })
})
