// The in-game pilot builder: legality budgets and what each picker offers.
import { describe, expect, it } from 'vitest'
import { Lancer } from '../src/data/lancer'
import { importPilots } from '../src/import/compcon'
import { validateBuild } from '../src/rules/legality'
import {
  newDraft, editable, setFrame, setWeapon, weaponOptions, systemOptions, frameOptions, setLicenseRank, toggleCoreBonus,
  setMountBonus, setTalentRank, coreBonusOptions, pruneCoreBonuses, modOptions,
} from '../src/ui/builder'
import { newRun, refitPilot } from '../src/run/run'
import pregens from '../src/data/pregens/pregens.json'
import v3 from './fixtures/V3_FIXTURE.json'
import './helpers'

const pregen = (name: string) => importPilots((pregens as any[]).find(p => p.name === name))[0]
const ids = <T extends { id: string }>(xs: T[]) => xs.map(x => x.id)

describe('build legality', () => {
  it('accepts every COMP/CON pregen as a complete LL0 build', () => {
    for (const pg of pregens as any[]) {
      const r = validateBuild(importPilots(pg)[0])
      expect(r.errors).toEqual([])
      expect(r.warnings).toEqual([])
    }
  })

  it('flags an extra talent rank and extra mech skill points', () => {
    const p = editable(pregen('Vanguard'))
    setTalentRank(p, 't_ace', 1)
    expect(validateBuild(p).errors.join()).toMatch(/talent ranks \(4\/3\)/)
    const q = editable(pregen('Vanguard'))
    q.mechSkills = [3, 0, 0, 0]
    expect(validateBuild(q).errors.join()).toMatch(/mech skill points/)
  })

  it('counts license ranks implied by equipment', () => {
    const p = newDraft(0)
    setLicenseRank(p, 'mf_drake', 2)
    setFrame(p, 'mf_drake')
    expect(validateBuild(p).errors.join()).toMatch(/license ranks \(2\/0\)/)
    p.level = 2
    expect(validateBuild(p).errors).toEqual([])
  })

  it('reads license ranks from COMP/CON exports', () => {
    const [p] = importPilots(v3)
    expect(p.licenses).toEqual([{ id: 'mf_blackbeard', rank: 3 }])
  })
})

describe('pilot builder', () => {
  it('starts as a legal Everest with points to spend', () => {
    const p = newDraft(3)
    const r = validateBuild(p)
    expect(r.errors).toEqual([])
    expect(r.warnings.join()).toMatch(/unspent/)
    expect(p.mech.mounts.map(m => m.type)).toEqual(Lancer.frames.get('mf_standard_pattern_i_everest')!.mounts)
  })

  it('only offers licensed frames and gear', () => {
    const p = newDraft(2)
    expect(ids(frameOptions(p))).toEqual(['mf_standard_pattern_i_everest'])
    const heavy = p.mech.mounts.findIndex(m => m.type === 'Heavy')
    expect(ids(weaponOptions(p, heavy, 0))).not.toContain('mw_assault_cannon') // Drake I
    setLicenseRank(p, 'mf_drake', 1)
    expect(ids(weaponOptions(p, heavy, 0))).toContain('mw_assault_cannon')
    expect(ids(frameOptions(p))).not.toContain('mf_drake') // frames need rank II
    setLicenseRank(p, 'mf_drake', 2)
    expect(ids(frameOptions(p))).toContain('mf_drake')
    expect(systemOptions(p).every(s => !s.license_level || s.source === 'GMS' || s.license_id === 'mf_drake')).toBe(true)
  })

  it('fits weapons by mount size and keeps a Flex mount to one Main or two Aux', () => {
    const p = newDraft(0)
    const main = p.mech.mounts.findIndex(m => m.type === 'Main')
    const sizes = new Set(weaponOptions(p, main, 0).map(w => w.mount))
    expect([...sizes].sort()).toEqual(['Auxiliary', 'Main'])
    const flex = p.mech.mounts.findIndex(m => m.type === 'Flex')
    setWeapon(p, flex, 0, 'mw_assault_rifle')
    expect(weaponOptions(p, flex, 1)).toEqual([])
    setWeapon(p, flex, 0, 'mw_pistol')
    setWeapon(p, flex, 1, 'mw_pistol')
    expect(validateBuild(p).errors).toEqual([])
    expect(new Set(weaponOptions(p, flex, 0).map(w => w.mount))).toEqual(new Set(['Auxiliary']))
  })

  it('keeps weapons that still fit when the frame changes', () => {
    const p = newDraft(2)
    const heavy = p.mech.mounts.findIndex(m => m.type === 'Heavy')
    setWeapon(p, heavy, 0, 'mw_heavy_machine_gun')
    setLicenseRank(p, 'mf_drake', 2)
    setFrame(p, 'mf_drake')
    expect(p.mech.mounts.flatMap(m => m.slots.map(s => s.weaponId))).toContain('mw_heavy_machine_gun')
    expect(p.mech.name).toBe('Drake')
  })

  it('applies mount core bonuses', () => {
    const p = newDraft(6)
    setLicenseRank(p, 'mf_saladin', 2)
    setFrame(p, 'mf_saladin')
    const before = p.mech.mounts.length
    toggleCoreBonus(p, 'cb_improved_armament')
    expect(p.mech.mounts.length).toBe(before + 1)
    toggleCoreBonus(p, 'cb_integrated_weapon')
    expect(p.mech.mounts.at(-1)!.type).toBe('CB-Integrated')
    expect(validateBuild(p).errors).toEqual([])
    toggleCoreBonus(p, 'cb_integrated_weapon')
    toggleCoreBonus(p, 'cb_mount_retrofitting')
    setMountBonus(p, 'cb_mount_retrofitting', 0)
    expect(p.mech.mounts[0].type).toBe('Main/Aux')
    setMountBonus(p, 'cb_mount_retrofitting', 1)
    expect(p.mech.mounts.map(m => m.type)).toEqual(['Flex', 'Main/Aux'])
  })

  it('needs 3 manufacturer license ranks per non-GMS core bonus', () => {
    const p = newDraft(3)
    const ok = () => coreBonusOptions(p).find(c => c.cb.id === 'cb_reinforced_frame')!.allowed
    expect(ok()).toBe(false)
    setLicenseRank(p, 'mf_drake', 3)
    expect(ok()).toBe(true)
    toggleCoreBonus(p, 'cb_reinforced_frame')
    expect(validateBuild(p).errors).toEqual([])
    setLicenseRank(p, 'mf_drake', 2)
    pruneCoreBonuses(p)
    expect(p.coreBonuses).toEqual([])
  })

  it('offers only mods that fit the weapon', () => {
    const p = newDraft(3)
    setLicenseRank(p, 'mf_nelson', 2)
    expect(ids(modOptions(p, 'mw_charged_blade'))).toContain('wm_thermal_charge')
    expect(ids(modOptions(p, 'mw_assault_rifle'))).not.toContain('wm_thermal_charge')
  })
})

describe('refit during a run', () => {
  it('keeps damage and spent repairs', () => {
    const p = pregen('Vanguard')
    const run = newRun([p])
    const c = run.condition[p.id]
    c.hp -= 5
    c.repairs -= 2
    c.structure -= 1
    const b = editable(run.squad[0])
    b.mechSkills = [0, 0, 0, 2] // HASE respec
    expect(refitPilot(run, b)).toBe(true)
    const after = run.condition[p.id]
    expect(run.squad[0].mechSkills).toEqual([0, 0, 0, 2])
    expect(after.structure).toBe(c.structure)
    expect(after.repairs).toBeLessThan(c.repairs + 2)
    expect(after.hp).toBeLessThan(16)
  })
})
