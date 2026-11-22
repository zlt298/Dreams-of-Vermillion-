// Official NPC feature scripts. Units are built from synthetic classes that only reuse the official
// feature *ids* (which select the scripts); no pack content is in the repo.
import { describe, expect, it } from 'vitest'
import type { OfficialClass, OfficialFeature } from '../src/import/lcp'
import type { Feature, NpcStats } from '../src/enemies/ruleset'
import { officialUnitDef } from '../src/enemies/official'
import { buildNpc } from '../src/enemies/build'
import { allScriptIds } from '../src/rules/effects/registry'
import { Battle } from '../src/rules/battle'
import { autoBattle, aiErrors } from '../src/ai/ai'
import { Rng } from '../src/rules/rng'
import { flatMap, pregenUnit } from './helpers'

const stats: NpcStats = { hp: 15, armor: 0, evasion: 8, edef: 8, heatcap: 8, speed: 4, sensors: 10, save: 11, size: 1, hull: 1, agi: 1, sys: 1, eng: 1, structure: 1, stress: 1, activations: 1, attackBonus: 1, techAttack: 1 }
const TECH = new Set(['npcf_crush_targeting_goliath', 'npcf_drone_barrage_hive', 'npcf_impale_systems_hornet', 'npcf_warp_sensors_mirage', 'npcf_tear_down_witch', 'npcf_blind_witch', 'npcf_predatory_logic_witch', 'npcf_abjure_priest'])
const gun: Feature = { type: 'weapon', name: 'Test Cannon', weaponType: 'Cannon', range: [{ type: 'Range', val: 10 }] as any, damage: [{ type: 'Kinetic', val: 4 }] as any }
const axe: Feature = { type: 'weapon', name: 'Chain Axe', weaponType: 'Melee', range: [{ type: 'Threat', val: 1 }] as any, damage: [{ type: 'Kinetic', val: 5 }] as any }

const feat = (id: string, f: Feature, base = true): OfficialFeature => ({ id, name: id, base, byTier: [f, f, f], partial: false })
function officialUnit(ids: string[], name = 'Testbed') {
  const cls: OfficialClass = {
    id: 'npcc_test', name, role: 'Striker', stats: [stats, stats, stats],
    features: [feat('w1', gun), feat('w2', axe), ...ids.map(id => feat(id, TECH.has(id) ? { type: 'tech', name: id, kind: 'quick', onHit: [] } : { type: 'trait', name: id, text: '' }))],
  }
  const u = buildNpc(officialUnitDef(cls, 1, [], new Rng(1), 0), 1)
  return u
}
function duel(ids: string[]) {
  const e = officialUnit(ids)
  const a = pregenUnit('Assault')
  a.pos = { x: 2, y: 5 }
  e.pos = { x: 6, y: 5 }
  const b = new Battle({ map: flatMap(14, 14), units: [a, e], seed: 4 })
  b.start()
  return { a, e, b }
}

const officialIds = allScriptIds().filter(id => id.startsWith('npc:npcf_')).map(id => id.slice(4))

describe('official feature scripts', () => {
  it('registers scripts for the official base features', () => {
    expect(officialIds.length).toBeGreaterThanOrEqual(55)
  })
  it.each(officialIds.map(id => [id]))('%s battles without runtime errors', id => {
    aiErrors.length = 0
    const units = [officialUnit([id], 'A'), officialUnit([id], 'B')]
    const lancers = ['Assault', 'Sniper'].map(n => pregenUnit(n))
    lancers.forEach((u, i) => (u.pos = { x: 2 + i, y: 1 }))
    units.forEach((u, i) => (u.pos = { x: 3 + i, y: 10 }))
    const b = new Battle({ map: flatMap(14, 14), units: [...lancers, ...units], seed: 7 })
    b.start()
    autoBattle(b, 6)
    expect(aiErrors).toEqual([])
  })

  it('Hunker Down: resists the first hit each round as a reaction', () => {
    const { a, e, b } = duel(['npcf_hunker_down_assault'])
    b.beginTurn(a)
    const ctx = b.newAttackCtx(a, e, { mode: 'skirmish', attackBonus: 50 })
    b.rollToHit(ctx)
    expect(ctx.resistAll).toBe(true)
    expect(e.reactionsLeft).toBe(0)
  })
  it('Stampede Defense: resistance unless the Berserker is impaired', () => {
    const { a, e, b } = duel(['npcf_stampede_defense_berserker'])
    const rifle = a.weapons.find(w => w.dataId === 'mw_assault_rifle')!
    expect(b.previewAttack(a, rifle, e).ctx.resistAll).toBe(true)
    b.addStatus(e, 'impaired')
    expect(b.previewAttack(a, rifle, e).ctx.resistAll).toBeFalsy()
  })
  it('Siege Armor: resistance only beyond range 3', () => {
    const { a, e, b } = duel(['npcf_siege_armor_goliath'])
    const rifle = a.weapons.find(w => w.dataId === 'mw_assault_rifle')!
    expect(b.previewAttack(a, rifle, e).ctx.resistAll).toBe(true)
    e.pos = { x: 4, y: 5 }
    expect(b.previewAttack(a, rifle, e).ctx.resistAll).toBeFalsy()
  })
  it('Heavy Frame: smaller characters cannot knock it back', () => {
    const { a, e, b } = duel(['npcf_heavy_frame_goliath'])
    e.stats.size = 2
    const before = { ...e.pos }
    b.forceMove(e, a, 3, 1)
    expect(e.pos).toEqual(before)
  })
  it('Guardian: an adjacent ally behind it gets hard cover', () => {
    const { a, e, b } = duel(['npcf_guardian_bastion'])
    const ally = officialUnit([], 'Ally')
    ally.pos = { x: 7, y: 5 }
    b.units.push(ally)
    expect(b.cover(a, ally)).toBe('hard')
  })
  it('Weave: the first reaction attack each round misses', () => {
    const { a, e, b } = duel(['npcf_weave_hornet'])
    const ctx = b.newAttackCtx(a, e, { mode: 'overwatch', attackBonus: 50 })
    b.rollToHit(ctx)
    expect(ctx.hit).toBe(false)
    const ctx2 = b.newAttackCtx(a, e, { mode: 'overwatch', attackBonus: 50 })
    b.rollToHit(ctx2)
    expect(ctx2.hit).toBe(true)
  })
  it('Explosive Vent clears all heat and knocks adjacent characters down on a failed save', () => {
    const { a, e, b } = duel(['npcf_explosive_vent_pyro'])
    a.pos = { x: 5, y: 5 }
    e.heat = 6
    a.stats.agi = -10
    b.beginTurn(a); b.endTurn(a); b.beginTurn(e)
    const act = b.customActions(e).find(x => x.key === 'explosive_vent')!
    b.useCustom(e, act)
    expect(e.heat).toBe(0)
    expect(b.has(a, 'prone')).toBe(true)
  })
  it("Sniper's Mark: the anti-materiel rifle deals one structure to an exposed mark", () => {
    const { a, e, b } = duel(['npcf_snipers_mark_sniper'])
    e.weapons[0].name = 'Anti-Materiel Rifle'
    e.flags.sniperMark = a.id
    const s = a.structure
    b.beginTurn(a); b.endTurn(a); b.beginTurn(e)
    const ctx = b.newAttackCtx(e, a, { mode: 'skirmish', attackBonus: 50, weapon: e.weapons[0] } as any)
    b.rollToHit(ctx)
    if (ctx.hit) expect(a.structure).toBe(s - 1)
  })
  it('Leap lands next to the target', () => {
    const { a, e, b } = duel(['npcf_leap_assassin'])
    b.beginTurn(a); b.endTurn(a); b.beginTurn(e)
    b.useCustom(e, b.customActions(e).find(x => x.key === 'leap')!, a)
    expect(b.adjacent(e, a)).toBe(true)
  })
})
