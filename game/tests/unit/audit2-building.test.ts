// Audit 2, building: mech build legality and unit construction fixes (core book pp.32, 90, 105-106; lancer-data
// for item text). Each test starts from a legal build and breaks exactly one rule.
import { describe, expect, it } from 'vitest'
import type { PilotBuild } from '../../src/import/compcon'
import { validateBuild } from '../../src/rules/legality'
import { buildMechUnit } from '../../src/rules/stats'
import { fitToLevel, modOptions, newDraft, systemOptions, setWeapon, toggleCoreBonus } from '../../src/ui/builder'
import { mech, pilot, battle, flatMap } from '../support'

const errs = (p: PilotBuild) => validateBuild(p).errors.join(' | ')

/** A legal LL3 Everest: [Main, Flex, Heavy], 3 HASE... spent so only the rule under test can fail. */
function draft(level = 3): PilotBuild {
  const p = newDraft(level)
  p.mechSkills = [0, 0, 0, 0]
  return p
}

describe('Fomorian Frame (lancer-data: one Size increment, up to Size 3)', () => {
  it('Size 1/2 becomes 1, Size 1 becomes 2, Size 3 stays 3', () => {
    expect(mech({ frame: 'mf_goblin', coreBonuses: ['cb_fomorian_frame'] }).stats.size).toBe(1)
    expect(mech({ coreBonuses: ['cb_fomorian_frame'] }).stats.size).toBe(2)
    expect(mech({ frame: 'mf_barbarossa', coreBonuses: ['cb_fomorian_frame'] }).stats.size).toBe(3)
    expect(mech({ frame: 'mf_goblin' }).stats.size).toBe(0.5)
  })
})

describe('talent ranks are taken one per License Level (core book p.90)', () => {
  it('rank II/III each need an LL', () => {
    expect(errs(pilot({ level: 0, mechSkills: [1, 1, 0, 0], talents: [['t_ace', 3]] }))).toMatch(/Talent ranks above I/)
    expect(errs(pilot({ level: 0, mechSkills: [1, 1, 0, 0], talents: [['t_ace', 2], ['t_brawler', 1]] }))).toMatch(/Talent ranks above I/)
    expect(errs(pilot({ level: 1, mechSkills: [1, 1, 1, 0], talents: [['t_ace', 3], ['t_brawler', 1]] }))).toMatch(/Talent ranks above I/)
    expect(errs(pilot({ level: 2, mechSkills: [1, 1, 1, 1], talents: [['t_ace', 3], ['t_brawler', 1]] }))).not.toMatch(/Talent ranks/)
    expect(errs(pilot({ level: 0, mechSkills: [1, 1, 0, 0], talents: [['t_ace', 1], ['t_brawler', 1], ['t_crack_shot', 1]] }))).not.toMatch(/Talent/)
  })
  it('fitToLevel takes ranks off the highest-rank talents first, so the trimmed build stays legal', () => {
    const src = pilot({ level: 5, mechSkills: [2, 2, 2, 1], talents: [['t_ace', 3], ['t_brawler', 3], ['t_crack_shot', 2]] })
    const p = fitToLevel(src, 0)
    expect(p.talents.every(t => t.rank === 1)).toBe(true)
    expect(p.talents.length).toBe(3)
    expect(errs(p)).not.toMatch(/Talent/)
    const p2 = fitToLevel(src, 2)
    expect(p2.talents.reduce((a, t) => a + t.rank - 1, 0)).toBeLessThanOrEqual(2)
    expect(errs(p2)).not.toMatch(/Talent/)
  })
})

describe('mount types are checked against the frame (core book p.32)', () => {
  it('a relabelled mount is an error; a Mount Retrofitting Main/Aux is allowed', () => {
    const p = draft()
    p.mech.mounts[1] = { type: 'Main/Aux', slots: [{ size: 'Main', weaponId: 'mw_assault_rifle' }, { size: 'Auxiliary', weaponId: 'mw_pistol' }], bonusEffects: [] }
    expect(errs(p)).toMatch(/Mount 2 should be Flex, is Main\/Aux/)
    p.level = 3
    p.mech.mounts[1].bonusEffects = ['cb_mount_retrofitting']
    p.coreBonuses = ['cb_mount_retrofitting']
    expect(errs(p)).not.toMatch(/should be/)
  })
})

describe('Unique mods: only one copy (lancer-data tg_unique)', () => {
  it('two Throughbolt Rounds is an error, and the picker hides the second', () => {
    const p = draft()
    setWeapon(p, 0, 0, 'mw_assault_rifle')
    setWeapon(p, 2, 0, 'mw_assault_rifle')
    p.mech.mounts[0].slots[0].modId = 'wm_throughbolt_rounds'
    expect(errs(p)).not.toMatch(/Unique/)
    expect(modOptions(p, 'mw_assault_rifle', 2, 0).map(m => m.id)).not.toContain('wm_throughbolt_rounds')
    expect(modOptions(p, 'mw_assault_rifle', 0, 0).map(m => m.id)).toContain('wm_throughbolt_rounds')
    p.mech.mounts[2].slots[0].modId = 'wm_throughbolt_rounds'
    expect(errs(p)).toMatch(/Throughbolt Rounds is Unique/)
  })
})

describe('one AI per mech (core book p.105; The Lesson of Shaping allows a second)', () => {
  it('two AI systems, or an AI system plus the UNCLE mod, is an error', () => {
    const two = pilot({ systems: ['ms_comp_con_class_assistant_unit', 'ms_sekhmet_class_nhp'] })
    expect(errs(two)).toMatch(/Only one AI/)
    const uncle = pilot({ systems: ['ms_comp_con_class_assistant_unit'], weapons: [{ type: 'Main', slots: [{ size: 'Main', weaponId: 'mw_assault_rifle', modId: 'wm_uncle_class_comp_con' }], bonusEffects: [] }] })
    expect(errs(uncle)).toMatch(/Only one AI/)
    expect(errs(pilot({ systems: ['ms_comp_con_class_assistant_unit'] }))).not.toMatch(/AI/)
  })
  it('The Lesson of Shaping raises the limit to two; the Enlightenment-Class NHP never counts', () => {
    const p = pilot({ systems: ['ms_comp_con_class_assistant_unit', 'ms_sekhmet_class_nhp'], coreBonuses: ['cb_the_lesson_of_shaping'] })
    p.licenses = [{ id: 'mf_pegasus', rank: 3 }]
    expect(errs(p)).not.toMatch(/AI/)
    p.mech.systems.push('ms_athena_class_nhp')
    expect(errs(p)).toMatch(/Only 2 AIs/)
    expect(errs(pilot({ systems: ['ms_comp_con_class_assistant_unit', 'ms_technophile_3'] }))).not.toMatch(/AI/)
  })
  it('the builder stops offering AIs once the limit is reached', () => {
    const p = draft()
    expect(systemOptions(p).map(s => s.id)).toContain('ms_comp_con_class_assistant_unit')
    p.mech.systems = ['ms_comp_con_class_assistant_unit']
    expect(systemOptions(p).some(s => s.tags?.some(t => t.id === 'tg_ai'))).toBe(false)
    setWeapon(p, 0, 0, 'mw_assault_rifle')
    expect(modOptions(p, 'mw_assault_rifle', 0, 0).map(m => m.id)).not.toContain('wm_uncle_class_comp_con')
  })
})

describe('integrated weapons (core book p.32; lancer-data cb_integrated_weapon no_mods)', () => {
  it("the Integrated Weapon core bonus mount can't be modified, and the builder offers no mods for it", () => {
    const p = draft()
    toggleCoreBonus(p, 'cb_integrated_weapon')
    const cb = p.mech.mounts.findIndex(m => m.type === 'CB-Integrated')
    setWeapon(p, cb, 0, 'mw_pistol')
    expect(errs(p)).toBe('')
    expect(modOptions(p, 'mw_pistol', cb, 0)).toEqual([])
    p.mech.mounts[cb].slots[0].modId = 'wm_nanocomposite_adaptation'
    expect(errs(p)).toMatch(/integrated: it can't be modified/)
  })
  it('an imported Integrated mount with a mod is an error', () => {
    const p = pilot({ frame: 'mf_raleigh', weapons: [['Aux/Aux', 'mw_pistol'], ['Flex', 'mw_assault_rifle'], ['Heavy', 'mw_howitzer']] })
    p.mech.mounts.push({ type: 'Integrated', slots: [{ size: 'Integrated', weaponId: 'mw_raleigh_integrated', modId: 'wm_nanocomposite_adaptation' }], bonusEffects: [] })
    expect(errs(p)).toMatch(/integrated: it can't be modified/)
  })
  it('weapons are flagged `integrated` (frame, talent, Integrated mount, core bonus mount); mounted ones are not', () => {
    const u = mech({ frame: 'mf_raleigh', talents: [['t_engineer', 1]], coreBonuses: ['cb_integrated_weapon'], weapons: [{ type: 'Flex', slots: [{ size: 'Main', weaponId: 'mw_assault_rifle' }], bonusEffects: [] }, { type: 'CB-Integrated', slots: [{ size: 'Auxiliary', weaponId: 'mw_pistol' }], bonusEffects: [] }] })
    const by = (id: string) => u.weapons.find(w => w.dataId === id)!
    expect(by('mw_raleigh_integrated').integrated).toBe(true)
    expect(by('mw_prototype_1').integrated).toBe(true)
    expect(by('mw_pistol').integrated).toBe(true)
    expect(by('mw_assault_rifle').integrated).toBeFalsy()
  })
  it("an imported Raleigh's Integrated mount doesn't make its integrated weapon destroyable", () => {
    const p = pilot({ frame: 'mf_raleigh', weapons: [['Flex', 'mw_assault_rifle']] })
    p.mech.mounts.push({ type: 'Integrated', slots: [{ size: 'Integrated', weaponId: 'mw_raleigh_integrated' }], bonusEffects: [] })
    const u = buildMechUnit(p)
    const mj = u.weapons.filter(w => w.dataId === 'mw_raleigh_integrated')
    expect(mj).toHaveLength(1)
    expect(mj[0].mountIndex).toBe(-1)
    u.pos = { x: 2, y: 2 }
    const b = battle([u], flatMap())
    for (let i = 0; i < 6; i++) b.systemTrauma(u)
    expect(mj[0].destroyed).toBe(false)
  })
})

describe('Engineer and Walking Armory give one item, upgraded by rank (lancer-data)', () => {
  it('Engineer III fits only the rank III prototype weapon', () => {
    const protos = mech({ talents: [['t_engineer', 3]] }).weapons.filter(w => w.dataId?.startsWith('mw_prototype'))
    expect(protos.map(w => w.dataId)).toEqual(['mw_prototype_3'])
  })
  it('Walking Armory III fits only the rank III Ammo Case', () => {
    const cases = mech({ talents: [['t_walking_armory', 3]] }).systems.filter(s => s.dataId.startsWith('ms_walking_armory'))
    expect(cases.map(s => s.dataId)).toEqual(['ms_walking_armory_3'])
  })
})
