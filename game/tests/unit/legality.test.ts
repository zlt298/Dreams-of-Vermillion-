// LANCER build legality and derived mech stats, checked rule by rule against the core book.
// Each test starts from a legal build and breaks exactly one rule, so an error that stops firing
// (or fires for the wrong reason) is caught.
import { describe, expect, it } from 'vitest'
import { Lancer } from '../../src/data/lancer'
import type { PilotBuild } from '../../src/import/compcon'
import { validateBuild, slotSizes, modFits, coreBonusAllowed, expectedMounts, manufacturerRanks, licensed } from '../../src/rules/legality'
import { deriveMechStats, collectBonuses, mechSP } from '../../src/rules/stats'
import { newDraft, setFrame } from '../../src/ui/builder'
import '../support'

const EVEREST = 'mf_standard_pattern_i_everest'
/** Everest mounts are [Main, Flex, Heavy]. */
function draft(level = 0): PilotBuild {
  const p = newDraft(level)
  p.mechSkills = [0, 0, 0, 0]
  return p
}
const put = (p: PilotBuild, mount: number, slot: number, weaponId: string | null, modId?: string) => {
  const m = p.mech.mounts[mount]
  while (m.slots.length <= slot) m.slots.push({ size: 'Auxiliary', weaponId: null })
  m.slots[slot].weaponId = weaponId
  if (modId !== undefined) m.slots[slot].modId = modId
}
const errs = (p: PilotBuild) => validateBuild(p).errors.join(' | ')

describe('point budgets (core book: HASE 2+LL, talents 3+LL, licenses LL, core bonuses LL/3)', () => {
  it.each([0, 1, 3, 6, 12])('LL%s budgets', ll => {
    const b = validateBuild(draft(ll)).budgets
    expect(b.hase.max).toBe(2 + ll)
    expect(b.talents.max).toBe(3 + ll)
    expect(b.licenses.max).toBe(ll)
    expect(b.coreBonuses.max).toBe(Math.floor(ll / 3))
  })
  it('a blank draft is legal but warns about every unspent pool', () => {
    const r = validateBuild(draft(3))
    expect(r.errors).toEqual([])
    expect(r.warnings.join()).toMatch(/mech skill/)
    expect(r.warnings.join()).toMatch(/talent/)
    expect(r.warnings.join()).toMatch(/license/)
    expect(r.warnings.join()).toMatch(/core bonus/)
  })
  it.each([-1, 13, 2.5])('License Level %s is rejected', ll => {
    expect(errs(draft(ll))).toMatch(/License Level/)
  })
  it('mech skills: over budget and over 6 are separate errors', () => {
    const p = draft(12) // 14 points
    p.mechSkills = [7, 0, 0, 0]
    expect(errs(p)).toMatch(/Mech skills must be 0–6/)
    expect(errs(p)).not.toMatch(/Too many mech skill/)
    p.mechSkills = [6, 6, 3, 0]
    expect(errs(p)).toMatch(/Too many mech skill points \(15\/14\)/)
    p.mechSkills = [-1, 3, 0, 0]
    expect(errs(p)).toMatch(/Mech skills must be/)
  })
  it('talents: duplicates and out-of-range ranks are errors', () => {
    const p = draft(3)
    p.talents = [{ id: 't_ace', rank: 1 }, { id: 't_ace', rank: 1 }]
    expect(errs(p)).toMatch(/listed twice/)
    p.talents = [{ id: 't_ace', rank: 4 }]
    expect(errs(p)).toMatch(/rank must be 1–3/)
    p.talents = [{ id: 't_ace', rank: 0 }]
    expect(errs(p)).toMatch(/rank must be 1–3/)
  })
  it('licenses: no rank above 3, and implied ranks count toward the budget', () => {
    const p = draft(6)
    p.licenses = [{ id: 'mf_drake', rank: 4 }]
    expect(errs(p)).toMatch(/can't go above rank 3/)
    const q = draft(1)
    setFrame(q, 'mf_drake') // needs Drake 2
    expect(validateBuild(q).budgets.licenses.used).toBe(2)
    expect(errs(q)).toMatch(/Too many license ranks \(2\/1\)/)
  })
})

describe('core bonuses', () => {
  it('a GMS core bonus needs no license ranks', () => {
    const p = draft(3)
    p.coreBonuses = ['cb_universal_compatibility']
    expect(validateBuild(p).errors).toEqual([])
  })
  it('a manufacturer core bonus needs 3 of that manufacturer\'s license ranks per bonus', () => {
    const p = draft(6)
    p.coreBonuses = ['cb_reinforced_frame'] // IPS-N
    expect(errs(p)).toMatch(/need 3 IPS-N license ranks \(have 0\)/)
    p.licenses = [{ id: 'mf_drake', rank: 2 }, { id: 'mf_blackbeard', rank: 1 }]
    expect(validateBuild(p).errors).toEqual([])
    p.coreBonuses = ['cb_reinforced_frame', 'cb_sloped_plating']
    expect(errs(p)).toMatch(/2 IPS-N core bonus\(es\) need 6/)
    // other manufacturers' ranks don't count
    p.licenses.push({ id: 'mf_swallowtail', rank: 3 }) // SSC
    expect(errs(p)).toMatch(/need 6 IPS-N license ranks \(have 3\)/)
  })
  it('too many and duplicated core bonuses', () => {
    const p = draft(3)
    p.coreBonuses = ['cb_universal_compatibility', 'cb_universal_compatibility']
    expect(errs(p)).toMatch(/listed twice/)
    expect(errs(p)).toMatch(/Too many core bonuses \(2\/1\)/)
  })
  it('coreBonusAllowed and manufacturerRanks agree with validateBuild', () => {
    const lic = new Map([['mf_drake', 3]])
    expect(manufacturerRanks('IPS-N', lic)).toBe(3)
    expect(manufacturerRanks('SSC', lic)).toBe(0)
    expect(coreBonusAllowed('cb_reinforced_frame', [], lic)).toBe(true)
    expect(coreBonusAllowed('cb_sloped_plating', ['cb_reinforced_frame'], lic)).toBe(false)
    expect(coreBonusAllowed('cb_kai_bioplating', [], lic)).toBe(false)
    expect(coreBonusAllowed('cb_does_not_exist', [], lic)).toBe(false)
  })
  it('Improved Armament adds a Flex mount only to frames with fewer than 3 mounts', () => {
    expect(expectedMounts(EVEREST, ['cb_improved_armament'])).toEqual(['Main', 'Flex', 'Heavy'])
    const two = [...Lancer.frames.values()].find(f => f.mounts.length === 2)
    expect(two).toBeDefined()
    expect(expectedMounts(two!.id, ['cb_improved_armament'])).toEqual([...two!.mounts, 'Flex'])
  })
  it('Integrated Weapon requires its CB-Integrated mount and vice versa', () => {
    const p = draft(3)
    p.coreBonuses = ['cb_integrated_weapon']
    expect(errs(p)).toMatch(/Integrated Weapon core bonus mount is missing/)
    p.mech.mounts.push({ type: 'CB-Integrated', slots: [{ size: 'Auxiliary', weaponId: null }], bonusEffects: [] })
    expect(validateBuild(p).errors).toEqual([])
    p.coreBonuses = []
    expect(errs(p)).toMatch(/missing or extra/)
  })
})

describe('mounts and weapons', () => {
  it('the wrong number of frame mounts is an error', () => {
    const p = draft()
    p.mech.mounts.pop()
    expect(errs(p)).toMatch(/should have 3 mounts, has 2/)
  })
  it('a Heavy weapon does not fit a Main mount; a Main weapon fits a Heavy mount', () => {
    const p = draft()
    put(p, 0, 0, 'mw_heavy_machine_gun')
    expect(errs(p)).toMatch(/Heavy Machine Gun \(Heavy\) doesn't fit a Main mount/)
    const q = draft()
    put(q, 2, 0, 'mw_assault_rifle')
    expect(validateBuild(q).errors).toEqual([])
  })
  it('a Flex mount holds one Main or two Auxiliary, never Main + Auxiliary', () => {
    const p = draft()
    put(p, 1, 0, 'mw_pistol'); put(p, 1, 1, 'mw_tactical_knife')
    expect(validateBuild(p).errors).toEqual([])
    put(p, 1, 0, 'mw_assault_rifle')
    expect(errs(p)).toMatch(/doesn't fit a Flex mount/)
    expect(slotSizes(p.mech.mounts[1], 1)).toEqual([])
  })
  it('a Superheavy weapon needs a second, empty mount', () => {
    const p = draft()
    put(p, 2, 0, 'mw_cyclone_pulse_rifle')
    expect(validateBuild(p).errors).toEqual([])
    put(p, 0, 0, 'mw_assault_rifle'); put(p, 1, 0, 'mw_pistol')
    expect(errs(p)).toMatch(/Superheavy weapon needs one other mount left empty/)
  })
  it('a mod in an empty slot, and a mod on a weapon it cannot fit, are errors', () => {
    const p = draft()
    p.mech.mounts[0].slots[0].modId = 'wm_nanocomposite_adaptation'
    expect(errs(p)).toMatch(/mod is fitted to an empty slot/)
    const melee = [...Lancer.weapons.values()].find(w => w.type === 'Melee' && w.mount === 'Main' && w.source === 'GMS')!
    const rangedOnly = [...Lancer.mods.values()].find(m => m.allowed_types && !m.allowed_types.includes('Melee'))
    expect(rangedOnly).toBeDefined()
    expect(modFits(rangedOnly!, melee)).toBe(false)
    const q = draft()
    put(q, 0, 0, melee.id, rangedOnly!.id)
    expect(errs(q)).toMatch(/can't be fitted to/)
    expect(modFits(undefined, melee)).toBe(false)
  })
  it('Unique gear can only be taken once', () => {
    const p = draft()
    p.mech.systems = ['ms_comp_con_class_assistant_unit', 'ms_comp_con_class_assistant_unit']
    expect(errs(p)).toMatch(/is Unique: only one allowed/)
  })
  it('going over the SP budget is an error', () => {
    const p = draft()
    p.mech.systems = ['ms_type_i_flight_system', 'ms_type_i_flight_system', 'ms_custom_paint_job'] // 3+3+1 > 6
    expect(errs(p)).toMatch(/Over SP budget \(7\/6\)/)
  })
  it('an unknown frame is reported, not thrown', () => {
    const p = draft()
    p.mech.frameId = 'mf_homebrew'
    expect(errs(p)).toMatch(/Unknown frame/)
  })
})

describe('licensing', () => {
  it('GMS items are always licensed; others need the rank', () => {
    expect(licensed(Lancer.weapons.get('mw_assault_rifle'), new Map())).toBe(true)
    const lev = Lancer.weapons.get('mw_leviathan_heavy_assault_cannon') // Drake 3
    expect(licensed(lev, new Map([['mf_drake', 2]]))).toBe(false)
    expect(licensed(lev, new Map([['mf_drake', 3]]))).toBe(true)
  })
})

describe('derived mech stats (core book p. 33)', () => {
  // Everest: HP 10, Evasion 8, E-Def 8, Heat 6, Speed 4, Save 10, Sensors 10, Repair Cap 5, SP 6, Tech 0
  const stats = (level: number, hase: [number, number, number, number]) => {
    const p = draft(level)
    p.mechSkills = hase
    return { s: deriveMechStats(p, collectBonuses(p)), sp: mechSP(p) }
  }
  it('LL0, no skills: the bare frame', () => {
    const { s, sp } = stats(0, [0, 0, 0, 0])
    expect(s).toMatchObject({ hp: 10, evasion: 8, edef: 8, heatcap: 6, speed: 4, save: 10, sensors: 10, repcap: 5, techAttack: 0, grit: 0, structure: 4, stress: 4, limitedBonus: 0 })
    expect(sp.max).toBe(6)
  })
  it('Grit is ceil(LL/2) and adds to HP, save target and attack bonus', () => {
    for (const [ll, grit] of [[1, 1], [2, 1], [3, 2], [12, 6]]) {
      const { s } = stats(ll, [0, 0, 0, 0])
      expect(s.grit).toBe(grit)
      expect(s.hp).toBe(10 + grit)
      expect(s.save).toBe(10 + grit)
      expect(s.attackBonus).toBe(grit)
    }
  })
  it('HULL: +2 HP per point, +1 Repair Cap per 2 points', () => {
    const { s } = stats(3, [3, 0, 0, 0])
    expect(s.hp).toBe(10 + 2 + 6)
    expect(s.repcap).toBe(5 + 1)
  })
  it('AGILITY: +1 Evasion per point, +1 Speed per 2 points', () => {
    const { s } = stats(3, [0, 3, 0, 0])
    expect(s.evasion).toBe(11)
    expect(s.speed).toBe(5)
  })
  it('SYSTEMS: +1 E-Defense and Tech Attack per point, +1 SP per 2 points', () => {
    const { s, sp } = stats(3, [0, 0, 3, 0])
    expect(s.edef).toBe(11)
    expect(s.techAttack).toBe(3)
    expect(sp.max).toBe(6 + 2 + 1)
  })
  it('ENGINEERING: +1 Heat Cap per point, +1 Limited use per 2 points', () => {
    const { s } = stats(3, [0, 0, 0, 4])
    expect(s.heatcap).toBe(10)
    expect(s.limitedBonus).toBe(2)
  })
  it('armor is capped at 4', () => {
    const p = draft()
    const s = deriveMechStats(p, [{ id: 'armor', val: 9 } as any])
    expect(s.armor).toBe(4)
  })
  it('conditional and typed bonuses are not added to flat stats', () => {
    const p = draft()
    const s = deriveMechStats(p, [{ id: 'hp', val: 5, condition: 'x' } as any, { id: 'hp', val: '3' } as any])
    expect(s.hp).toBe(13)
  })
})
