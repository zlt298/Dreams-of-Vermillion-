import { describe, expect, it } from 'vitest'
import { importPilots } from '../src/import/compcon'
import { buildMechUnit, deriveMechStats, collectBonuses, mechSP } from '../src/rules/stats'
import v3 from './fixtures/V3_FIXTURE.json'
import v2 from './fixtures/v2_PILOT_FIXTURE.json'
import pregens from '../src/data/pregens/pregens.json'

describe('COMP/CON import', () => {
  it('reads a v3 "Save Pilot" export', () => {
    const [p] = importPilots(v3)
    expect(p.callsign).toBe('v3_fixture')
    expect(p.level).toBe(3)
    expect(p.mechSkills).toEqual([2, 0, 0, 3])
    // favourite mech is the Blackbeard
    expect(p.mech.frameId).toBe('mf_blackbeard')
    const weapons = p.mech.mounts.flatMap(m => m.slots.map(s => s.weaponId)).filter(Boolean)
    expect(weapons).toContain('mw_chain_axe')
    expect(weapons).toContain('mw_assault_cannon')
    expect(p.talents.length).toBeGreaterThan(0)
  })

  it('reads v2 pilot data', () => {
    const [p] = importPilots(v2)
    expect(p.level).toBe(3)
    expect(p.talents.map(t => t.id)).toContain('t_executioner')
    expect(p.mech.frameId).toBeTruthy()
  })

  it('reads every COMP/CON pregen', () => {
    for (const pg of pregens as any[]) {
      const [p] = importPilots(pg)
      expect(p.unknown).toEqual([])
      const u = buildMechUnit(p)
      expect(u.weapons.length).toBeGreaterThan(0)
    }
  })

  it('derives Everest stats like COMP/CON', () => {
    const [p] = importPilots((pregens as any[]).find(x => x.name === 'Vanguard'))
    const s = deriveMechStats(p, collectBonuses(p))
    // Everest: HP 10 + hull 2*2 + Personalizations 2
    expect(s.hp).toBe(16)
    expect(s.evasion).toBe(8)
    expect(s.edef).toBe(8)
    expect(s.heatcap).toBe(6)
    expect(s.speed).toBe(4)
    expect(s.repcap).toBe(6)
    expect(s.structure).toBe(4)
    expect(s.stress).toBe(4)
    expect(mechSP(p).used).toBeLessThanOrEqual(mechSP(p).max)
  })

  it('applies grit from level', () => {
    const [p] = importPilots(v3)
    const s = deriveMechStats(p, collectBonuses(p))
    expect(s.grit).toBe(2)
    expect(s.attackBonus).toBe(2)
  })

  it('rejects non-pilot JSON', () => {
    expect(() => importPilots({ foo: 1 })).toThrow()
  })
})
