// The structure and overheating tables (src/rules/battle/damage.ts), with every die rigged.
// A level-9 Everest at HASE 2/2/2/2: 4 structure, 4 stress, heat cap 8, Hull/Agility/Engineering +2 (so a check
// passes on a d20 of 8 and fails on a 7).
import { describe, expect, it } from 'vitest'
import { buildTeam } from '../../src/enemies/build'
import type { Unit } from '../../src/rules/types'
import { arena, mech, rigDice, teamFile } from '../support'

function solo(u: Unit = mech()) {
  const e = mech({}, 'enemy')
  const b = arena([[u, { x: 1, y: 1 }], [e, { x: 10, y: 10 }]])
  return { u, e, b }
}
const said = (b: { log: { text: string }[] }, re: RegExp) => b.log.some(l => re.test(l.text))

describe('structure table', () => {
  it('Direct Hit at exactly 2 structure: a passed Hull check leaves the mech Stunned', () => {
    const { u, b } = solo()
    u.structure = 2
    rigDice(b, 6, 1, 4) // two dice for two marked structure: lowest 1 → Direct Hit
    rigDice(b, 20, 8) // Hull check 8 + 2 = 10: success
    b.structureCheck(u)
    expect(said(b, /DIRECT HIT/)).toBe(true)
    expect(u.destroyed).toBe(false)
    expect(b.has(u, 'stunned')).toBe(true)
  })

  it('Direct Hit at exactly 2 structure: a failed Hull check destroys the mech', () => {
    const { u, b } = solo()
    u.structure = 2
    rigDice(b, 6, 4, 1)
    rigDice(b, 20, 7) // 7 + 2 = 9: failure
    b.structureCheck(u)
    expect(u.destroyed).toBe(true)
    expect(said(b, /DESTROYED \(direct hit\)/)).toBe(true)
  })

  it('Direct Hit with 3+ structure stuns without a check; with 1 structure it destroys', () => {
    const { u, b } = solo()
    u.structure = 3
    rigDice(b, 6, 1)
    b.structureCheck(u)
    expect(b.has(u, 'stunned')).toBe(true)
    expect(said(b, /HULL check/)).toBe(false)
    const { u: v, b: b2 } = solo()
    v.structure = 1
    rigDice(b2, 6, 1, 3, 6)
    b2.structureCheck(v)
    expect(v.destroyed).toBe(true)
  })

  it('5-6 is a Glancing Blow (Impaired); two 1s are a Crushing Hit', () => {
    const { u, b } = solo()
    u.structure = 2
    rigDice(b, 6, 5, 6)
    b.structureCheck(u)
    expect(b.has(u, 'impaired')).toBe(true)
    expect(u.destroyed).toBe(false)
    const { u: v, b: b2 } = solo()
    v.structure = 2
    rigDice(b2, 6, 1, 1)
    b2.structureCheck(v)
    expect(v.destroyed).toBe(true)
    expect(said(b2, /CRUSHING HIT/)).toBe(true)
  })

  describe('System Trauma (2-4)', () => {
    const batteries = () => mech({ weapons: 'mw_thermal_rifle', systems: ['ms_external_batteries'] })

    it('4-6 destroys a system, and its passive bonus goes with it', () => {
      const { u, b } = solo(batteries())
      const rifle = u.weapons[0]
      expect(b.ranges(u, rifle)[0].val).toBe(10) // Range 5, +5 from External Batteries
      u.structure = 3
      rigDice(b, 6, 3, 5) // table 3 → System Trauma; trauma roll 5 → a system
      b.structureCheck(u)
      expect(u.systems.find(s => s.dataId === 'ms_external_batteries')!.destroyed).toBe(true)
      expect(u.bonuses.some(x => x.sourceSystem === 'ms_external_batteries')).toBe(false)
      expect(b.ranges(u, rifle)[0].val).toBe(5)
      expect(rifle.destroyed).toBe(false)
      expect(said(b, /System Trauma: External Batteries destroyed!/)).toBe(true)
    })

    it('1-3 destroys a weapon mount', () => {
      const { u, b } = solo(batteries())
      u.structure = 3
      rigDice(b, 6, 2, 3)
      b.structureCheck(u)
      expect(u.weapons[0].destroyed).toBe(true)
      expect(u.systems[0].destroyed).toBe(false)
      expect(b.ranges(u, u.weapons[0])[0].val).toBe(10)
    })

    it('a mount result with no weapons left takes a system; a system result with no systems takes a mount', () => {
      const { u, b } = solo(batteries())
      u.weapons[0].destroyed = true
      u.structure = 3
      rigDice(b, 6, 4, 1)
      b.structureCheck(u)
      expect(u.systems[0].destroyed).toBe(true)
      const { u: v, b: b2 } = solo(mech({ weapons: 'mw_thermal_rifle' }))
      v.structure = 3
      rigDice(b2, 6, 4, 6)
      b2.structureCheck(v)
      expect(v.weapons[0].destroyed).toBe(true)
    })

    it('with nothing left to destroy it becomes a Direct Hit', () => {
      const { u, b } = solo(mech({ weapons: 'mw_thermal_rifle' }))
      u.weapons[0].destroyed = true
      expect(u.systems).toEqual([])
      u.structure = 3
      rigDice(b, 6, 4, 6) // table 4 → System Trauma; the trauma die is still rolled
      b.structureCheck(u)
      expect(said(b, /DIRECT HIT/)).toBe(true)
      expect(b.has(u, 'stunned')).toBe(true)
      // at 2 structure the Direct Hit asks for its Hull check
      const { u: v, b: b2 } = solo(mech({ weapons: 'mw_thermal_rifle' }))
      v.weapons[0].destroyed = true
      v.structure = 2
      rigDice(b2, 6, 4, 4, 2)
      rigDice(b2, 20, 7)
      b2.structureCheck(v)
      expect(v.destroyed).toBe(true)
    })
  })
})

describe('overheating table', () => {
  /** Overheat by 1 from `stress` remaining: the mech drops to stress - 1 and rolls (4 - (stress - 1)) dice. */
  function overheat(stress: number, u = mech()) {
    const s = solo(u)
    s.u.stress = stress
    s.u.heat = s.u.stats.heatcap
    return s
  }

  it('Meltdown at 2 stress: a passed Engineering check leaves it Exposed', () => {
    const { u, b } = overheat(3)
    rigDice(b, 6, 1, 4)
    rigDice(b, 20, 8)
    b.addHeat(u, 1)
    expect(u.stress).toBe(2)
    expect(u.heat).toBe(0)
    expect(b.has(u, 'exposed')).toBe(true)
    expect(u.meltdownTurns).toBeUndefined()
  })

  it('Meltdown at 2 stress: a failed Engineering check melts down in 1d6 turns', () => {
    const { u, b } = overheat(3)
    rigDice(b, 6, 4, 1, 3) // table [4, 1], then the 1d6 countdown
    rigDice(b, 20, 7)
    b.addHeat(u, 1)
    expect(u.meltdownTurns).toBe(3)
    expect(b.has(u, 'exposed')).toBe(false)
  })

  it('Meltdown with 3+ stress left: Exposed, no check', () => {
    const { u, b } = overheat(4)
    rigDice(b, 6, 1)
    b.addHeat(u, 1)
    expect(u.stress).toBe(3)
    expect(b.has(u, 'exposed')).toBe(true)
    expect(said(b, /ENG check/)).toBe(false)
    expect(u.meltdownTurns).toBeUndefined()
  })

  it('Meltdown with 1 stress left: melts down at the end of its next turn', () => {
    const { u, b } = overheat(2)
    rigDice(b, 6, 3, 1, 6)
    b.addHeat(u, 1)
    expect(u.stress).toBe(1)
    expect(u.meltdownTurns).toBe(1)
  })

  it('5-6 is an Emergency Shunt (Impaired); 2-4 Destabilized Power Plant (Exposed); two 1s Irreversible Meltdown', () => {
    const s1 = overheat(4)
    rigDice(s1.b, 6, 5)
    s1.b.addHeat(s1.u, 1)
    expect(s1.b.has(s1.u, 'impaired')).toBe(true)
    expect(s1.b.has(s1.u, 'exposed')).toBe(false)
    const s2 = overheat(4)
    rigDice(s2.b, 6, 2)
    s2.b.addHeat(s2.u, 1)
    expect(s2.b.has(s2.u, 'exposed')).toBe(true)
    const s3 = overheat(3)
    rigDice(s3.b, 6, 1, 1)
    s3.b.addHeat(s3.u, 1)
    expect(said(s3.b, /IRREVERSIBLE MELTDOWN/)).toBe(true)
    expect(s3.u.meltdownTurns).toBe(1)
  })

  it('an NPC with 1 stress does not roll: it vents its heat and becomes Exposed', () => {
    const npc = buildTeam(teamFile('t1-checkpoint-garrison')).find(x => x.name === 'Choir Rifleman A')!
    expect([npc.kind, npc.isGrunt, npc.stats.stress, npc.stats.heatcap]).toEqual(['npc', false, 1, 6])
    const { u, b } = solo(npc)
    u.heat = 6
    b.addHeat(u, 3) // no rigged dice: none may be rolled
    expect(u.stress).toBe(1)
    expect(u.heat).toBe(2) // owner ruling: heat clears like a mech's, only what went beyond cap + 1 carries over (core p.81)
    expect(b.has(u, 'exposed')).toBe(true)
    expect(said(b, /overheats and vents violently/)).toBe(true)
    expect(said(b, /Overheating check/)).toBe(false)
  })
})

describe('Legendary: table dice roll twice and keep the better result', () => {
  const boss = () => {
    const u = buildTeam(teamFile('t1-boss-red-warden')).find(x => x.traits?.includes('legendary'))!
    expect(u.stats.structure).toBe(4)
    return solo(u)
  }

  it('keeps the better roll, treating two 1s as the worst; ties keep the first', () => {
    const { u, b } = boss()
    rigDice(b, 6, 1, 1, 1, 2)
    expect(b.tableDice(u, 2)).toEqual([1, 2])
    rigDice(b, 6, 5, 5, 2, 6)
    expect(b.tableDice(u, 2)).toEqual([5, 5])
    rigDice(b, 6, 3, 4, 6, 3)
    expect(b.tableDice(u, 2)).toEqual([3, 4])
  })

  it('a Legendary structure check turns a Crushing Hit into the better result', () => {
    const { u, b } = boss()
    u.structure = 2
    rigDice(b, 6, 1, 1, 6, 5)
    b.structureCheck(u)
    expect(u.destroyed).toBe(false)
    expect(b.has(u, 'impaired')).toBe(true)
  })

  it('a non-Legendary mech rolls once', () => {
    const { u, b } = solo()
    rigDice(b, 6, 1, 1)
    expect(b.tableDice(u, 2)).toEqual([1, 1])
  })
})

describe('flyers lose control', () => {
  it('structure damage: a failed Agility save drops a flyer; a passed one keeps it airborne', () => {
    const { u, b } = solo()
    u.flying = true
    rigDice(b, 20, 7) // Agility 7 + 2 = 9 vs 10: fails
    rigDice(b, 6, 6) // one marked structure: Glancing Blow
    b.loseHp(u, u.hp)
    expect(u.structure).toBe(3)
    expect(u.flying).toBe(false)
    expect(said(b, /loses control and drops to the ground/)).toBe(true)
    const { u: v, b: b2 } = solo()
    v.flying = true
    rigDice(b2, 20, 8)
    rigDice(b2, 6, 6)
    b2.loseHp(v, v.hp)
    expect(v.structure).toBe(3)
    expect(v.flying).toBe(true)
  })

  it('stress damage: a failed Agility save drops a flyer', () => {
    const { u, b } = solo()
    u.flying = true
    u.heat = u.stats.heatcap
    rigDice(b, 20, 7)
    rigDice(b, 6, 6)
    b.addHeat(u, 1)
    expect(u.stress).toBe(3)
    expect(u.flying).toBe(false)
    expect(said(b, /loses control/)).toBe(true)
  })
})
