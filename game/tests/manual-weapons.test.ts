// Weapons and mods that replace the normal attack (rules/effects/scripts/weapons2.ts).
import { describe, expect, it } from 'vitest'
import type { PilotBuild } from '../src/import/compcon'
import { buildMechUnit } from '../src/rules/stats'
import { Battle } from '../src/rules/battle'
import { autoBattle, aiErrors } from '../src/ai/ai'
import { weaponCoverage, modCoverage } from '../src/rules/effects/coverage'
import type { Unit } from '../src/rules/types'
import { flatMap, pregenUnit } from './helpers'

function mech(slots: { size: string; weaponId: string; modId?: string }[], side: 'player' | 'enemy' = 'player', talents: { id: string; rank: number }[] = []): Unit {
  const p = {
    id: `t-${Math.random()}`, callsign: 'Tester', name: 'T', level: 6, mechSkills: [2, 2, 2, 2], talents, coreBonuses: [],
    mech: { name: 'T', frameId: 'mf_standard_pattern_i_everest', mounts: slots.map(s => ({ type: s.size, slots: [s], bonusEffects: [] })), systems: [] },
    unknown: [],
  } as unknown as PilotBuild
  return buildMechUnit(p, side)
}
function setup(a: Unit, map = flatMap(16, 16)) {
  const e = pregenUnit('Assault', 'enemy')
  a.pos = { x: 5, y: 4 }
  e.pos = { x: 5, y: 8 }
  e.stats.evasion = 1
  const b = new Battle({ map, units: [a, e], seed: 13 })
  b.start()
  b.beginTurn(a)
  return { a, e, b }
}
const act = (b: Battle, u: Unit, re: RegExp) => {
  const x = b.customActions(u).find(c => re.test(c.name) || re.test(c.key))
  if (!x) throw new Error(`no action ${re}: ${b.customActions(u).map(c => c.name).join(', ')}`)
  return x
}
const W = (u: Unit, id: string) => u.weapons.find(w => w.dataId === id)!

describe('manual weapons', () => {
  it('every former manual weapon and mod is now scripted', () => {
    for (const id of ['mw_autopod', 'mw_vorpal_gun', 'mw_mimic_gun', 'mw_siege_cannon', 'mw_prototype_1', 'mw_prototype_2', 'mw_prototype_3', 'mw_barbarossa_integrated']) expect(weaponCoverage(id), id).toBe('scripted')
    for (const id of ['wm_uncle_class_comp_con', 'wm_throughbolt_rounds']) expect(modCoverage(id), id).toBe('scripted')
  })

  it('Autopod: hits automatically when an ally consumes Lock On on a target within 15', () => {
    const a = mech([{ size: 'Main', weaponId: 'mw_autopod' }])
    const { e, b } = setup(a)
    const ally = mech([{ size: 'Main', weaponId: 'mw_assault_rifle' }])
    ally.pos = { x: 8, y: 4 }
    b.units.push(ally)
    expect(b.weaponUsable(a, W(a, 'mw_autopod'))).not.toBe(true) // no normal attacks
    b.addStatus(e, 'lockon', 'until_cleared', ally)
    b.weaponAttack(ally, W(ally, 'mw_assault_rifle'), { targetId: e.id }, 'free')
    const auto = b.log.find(l => /Autonomous Assault/.test(l.text))
    expect(auto).toBeTruthy()
    expect(b.log.some(l => /automatic HIT/.test(l.text))).toBe(true)
    expect(a.reactionsLeft).toBe(0)
  })

  it('Vorpal Gun: Snicker-Snack attacks a hostile that damages an ally in range', () => {
    const a = mech([{ size: 'Main', weaponId: 'mw_vorpal_gun' }])
    const { e, b } = setup(a)
    const ally = mech([{ size: 'Main', weaponId: 'mw_assault_rifle' }])
    ally.pos = { x: 6, y: 8 }
    b.units.push(ally)
    expect(b.weaponUsable(a, W(a, 'mw_vorpal_gun'))).not.toBe(true)
    b.applyDamage(ally, [{ type: 'Kinetic', amount: 3 }], { source: e })
    expect(b.log.some(l => /attacks with Vorpal Gun/.test(l.text))).toBe(true)
    expect(a.reactionsLeft).toBe(0)
    // 1/round
    b.applyDamage(ally, [{ type: 'Kinetic', amount: 3 }], { source: e })
    expect(b.log.filter(l => /attacks with Vorpal Gun/.test(l.text))).toHaveLength(1)
  })

  it('Mimic Gun: 3d20 ranges cycle each turn after the first; damage is 1 + half; Provoke rerolls', () => {
    const a = mech([{ size: 'Heavy', weaponId: 'mw_mimic_gun' }])
    const { e, b } = setup(a)
    const w = W(a, 'mw_mimic_gun')
    const [x, y] = w.flags!.mimic
    expect(b.profile(w).range[0].val).toBe(x)
    expect(b.profile(w).damage[0].val).toBe(1 + Math.floor(x / 2))
    b.endTurn(a); b.beginTurn(e); b.endTurn(e); b.round++
    b.beginTurn(a)
    expect(b.profile(w).range[0].val).toBe(y)
    act(b, a, /Provoke/).run(b, a)
    expect(w.flags!.mimic).toHaveLength(3)
    expect(b.profile(w).range[0].val).toBe(w.flags!.mimic[0])
  })

  it('Mimic Gun counts as every ranged weapon type for talents', () => {
    const a = mech([{ size: 'Heavy', weaponId: 'mw_mimic_gun' }])
    const w = W(a, 'mw_mimic_gun')
    expect(w.flags!.allRangedTypes).toBe(true)
    expect(w.bonuses).toHaveLength(0)
  })

  it('Siege Cannon: the two firing modes are profiles chosen before firing', () => {
    const a = mech([{ size: 'Superheavy', weaponId: 'mw_siege_cannon' }])
    const { b } = setup(a)
    const w = W(a, 'mw_siege_cannon')
    expect(w.profiles.map(p => p.name)).toEqual(['Siege Mode', 'Direct Fire Mode'])
    w.profileIndex = 1
    expect(b.isAoE(b.profile(w))).toBe(false)
  })

  it('Prototype weapons: uses rolled at battle start; configure type and damage before the first attack', () => {
    const a = mech([{ size: 'Main', weaponId: 'mw_prototype_1' }])
    const { e, b } = setup(a)
    const w = W(a, 'mw_prototype_1')
    expect(w.usesLeft).toBeGreaterThanOrEqual(3)
    expect(w.usesLeft).toBeLessThanOrEqual(8 + a.stats.limitedBonus)
    b.chooser = () => undefined
    const cfg = act(b, a, /Configure/)
    b.transaction(() => cfg.run(b, a), [0, 2]) // Melee, Explosive
    expect(w.type).toBe('Melee')
    expect(b.profile(w).damage[0].type).toBe('Explosive')
    expect(b.profile(w).range).toEqual([{ type: 'Threat', val: 1 }])
    e.pos = { x: 5, y: 5 }
    b.weaponAttack(a, w, { targetId: e.id }, 'free')
    expect(b.customActions(a).some(c => /Configure/.test(c.name))).toBe(false)
  })

  it('UNCLE: free attack at +2 difficulty, then the weapon is locked until next turn', () => {
    const a = mech([{ size: 'Main', weaponId: 'mw_assault_rifle', modId: 'wm_uncle_class_comp_con' }])
    const { e, b } = setup(a)
    const w = W(a, 'mw_assault_rifle')
    const u = act(b, a, /UNCLE/)
    expect(u.activation).toBe('free')
    b.useCustom(a, u, e)
    expect(b.log.some(l => /UNCLE/.test(l.text) || /attacks with Assault Rifle/.test(l.text))).toBe(true)
    expect(b.weaponUsable(a, w)).toMatch(/UNCLE/)
    expect(act(b, a, /UNCLE/).usable(b, a)).not.toBe(true)
    b.endTurn(a); b.beginTurn(e); b.endTurn(e); b.round++; b.beginTurn(a)
    expect(b.weaponUsable(a, w)).toBe(true)
  })

  it('Throughbolt: a Line 3 path through terrain hits everything on it; the attack is measured from its end', () => {
    const map = flatMap(16, 16, (x, y) => (x === 5 && y === 6 ? { h: 3, kind: 'block' } : undefined))
    const a = mech([{ size: 'Main', weaponId: 'mw_assault_rifle', modId: 'wm_throughbolt_rounds' }])
    const { e, b } = setup(a, map)
    const bystander = pregenUnit('Sniper', 'enemy')
    bystander.pos = { x: 5, y: 5 }
    b.units.push(bystander)
    const w = W(a, 'mw_assault_rifle')
    expect(b.los(a, e)).toBe(false) // the wall blocks line of sight from the attacker
    ;(w.flags ??= {}).throughbolt = true
    const hp = bystander.hp
    const r = b.weaponAttack(a, w, { targetId: e.id }, 'free')
    expect(r.ok).toBe(true)
    expect(bystander.hp).toBe(hp - 2) // 2 AP kinetic
    expect(b.map.tiles[6 * 16 + 5].h).toBe(3) // 2 damage does not break a 10 HP level
  })

  it('AI battles with these weapons run cleanly', () => {
    const a = mech([{ size: 'Main', weaponId: 'mw_prototype_1' }, { size: 'Main', weaponId: 'mw_assault_rifle', modId: 'wm_uncle_class_comp_con' }, { size: 'Heavy', weaponId: 'mw_mimic_gun' }])
    const c = mech([{ size: 'Main', weaponId: 'mw_vorpal_gun' }, { size: 'Main', weaponId: 'mw_autopod' }])
    const e1 = pregenUnit('Assault', 'enemy'), e2 = pregenUnit('Sniper', 'enemy')
    a.pos = { x: 3, y: 2 }; c.pos = { x: 6, y: 2 }; e1.pos = { x: 3, y: 12 }; e2.pos = { x: 7, y: 12 }
    const b = new Battle({ map: flatMap(14, 16), units: [a, c, e1, e2], seed: 4 })
    b.start()
    aiErrors.length = 0
    autoBattle(b, 6)
    expect(aiErrors).toHaveLength(0)
  })
})
