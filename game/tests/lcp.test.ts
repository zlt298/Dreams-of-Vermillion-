// LCP importer tests. They use a small invented NPC class: no official (paid) content lives in the repo.
import { describe, expect, it } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { readLcp, tierVal, tierText, parseEffects, parseAreaSave } from '../src/import/lcp'
import { generateOfficialTeam } from '../src/enemies/official'
import { buildTeam } from '../src/enemies/build'
import { teamBudget } from '../src/enemies/ruleset'
import { autoBattle } from '../src/ai/ai'
import { Battle } from '../src/rules/battle'
import { flatMap, pregenUnit } from './helpers'

const stats = { armor: 1, hp: [12, 14, 16], evade: [8, 9, 10], edef: [8, 8, 8], heatcap: 6, speed: 4, sensor: 8, save: [10, 11, 12], hull: [1, 2, 3], agility: [0, 1, 1], systems: [0, 0, 1], engineering: [1, 1, 2], size: 1, activations: 1 }
const v2Features = [
  { id: 'npcf_test_gun', name: 'Test Gun', base: true, type: 'Weapon', weapon_type: 'Main Rifle', attack_bonus: [1, 2, 3], damage: [{ type: 'Kinetic', val: [4, 5, 6] }], range: [{ type: 'Range', val: 8 }], tags: [{ id: 'tg_reliable', val: '{1/2/3}' }], on_hit: 'The target becomes Slowed until the end of their next turn.' },
  { id: 'npcf_test_mortar', name: 'Test Mortar', base: false, type: 'System', effect: 'Choose a space within Range 10. Characters in a Blast 1 area there must pass an Agility save or take {3/4/5} explosive damage. On a success they take half damage.' },
  { id: 'npcf_test_plating', name: 'Test Plating', base: false, type: 'Trait', effect: 'The Testbed gains +2 HP.', bonuses: [{ id: 'hp', val: 2 }] },
  { id: 'npcf_test_hammer', name: 'Test Hammer', base: false, type: 'Weapon', weapon_type: 'Superheavy Melee', attack_bonus: [1, 2, 3], damage: [{ type: 'Explosive', val: [8, 10, 12] }], range: [{ type: 'Threat', val: 2 }], on_hit: { detail: 'Hull save or be Stunned.', add_status: [{ id: 'stunned', duration: 'next_turn_end_target', save: 'hull' }] } },
  { id: 'npcf_test_react', name: 'Test Reaction', base: false, type: 'Reaction', actions: [{ name: 'Test Reaction', activation: 'Reaction', frequency: '1/round', trigger: 'A melee attack hits the Testbed.', detail: 'Something narrative happens.' }] },
]

function v2Pack() {
  return zipSync({
    'lcp_manifest.json': strToU8(JSON.stringify({ name: 'Test Pack', version: '2.0.0' })),
    'npcc_testbed.json': strToU8(JSON.stringify([{ id: 'npcc_testbed', name: 'TESTBED', role: 'striker', stats }, ...v2Features.map(f => ({ ...f, origin: 'npcc_testbed' }))])),
  })
}
function v1Pack() {
  const feats = v2Features.map(f => ({ ...f, origin: { type: 'Class', name: 'TESTBED', base: f.base }, damage: (f as any).damage?.map((d: any) => ({ type: d.type.toLowerCase(), damage: d.val })), trigger: (f as any).actions?.[0]?.trigger, effect: (f as any).effect ?? (f as any).actions?.[0]?.detail ?? '' }))
  return zipSync({
    'lcp_manifest.json': strToU8(JSON.stringify({ name: 'Test Pack v1', version: '1.0.0' })),
    'npc_classes.json': strToU8(JSON.stringify([{ id: 'npcc_testbed', name: 'TESTBED', role: 'striker', stats: { ...stats, armor: [1, 1, 1] }, base_features: ['npcf_test_gun'], optional_features: ['npcf_test_mortar', 'npcf_test_plating', 'npcf_test_react'] }])),
    'npc_features.json': strToU8(JSON.stringify(feats)),
  })
}

describe('LCP import', () => {
  it('reads tier values', () => {
    expect(tierVal([4, 5, 6], 2)).toBe(5)
    expect(tierVal('{1/2/3}', 3)).toBe(3)
    expect(tierVal(7, 1)).toBe(7)
    expect(tierText('Deal {2/4/6} damage', 2)).toBe('Deal 4 damage')
  })
  it.each([['v2', v2Pack], ['v1', v1Pack]] as const)('parses a %s pack into classes with per-tier stats and features', (_v, make) => {
    const p = readLcp(make())
    expect(p.classes).toHaveLength(1)
    const c = p.classes[0]
    expect(c.name).toBe('Testbed')
    expect(c.role).toBe('Striker')
    expect(c.stats[1].hp).toBe(14)
    expect(c.stats[2].evasion).toBe(10)
    const gun = c.features.find(f => f.name === 'Test Gun')!
    expect(gun.base).toBe(true)
    const w = gun.byTier[2] as any
    expect(w.type).toBe('weapon')
    expect(w.damage[0]).toEqual({ type: 'Kinetic', val: 6 })
    expect(w.attackBonus).toBe(3)
    expect(w.tags).toContainEqual({ id: 'tg_reliable', val: 3 })
    expect(w.onHit).toContainEqual(expect.objectContaining({ do: 'status', status: 'slowed' }))
    const mortar = c.features.find(f => f.name === 'Test Mortar')!.byTier[0] as any
    expect(mortar).toMatchObject({ type: 'system', target: 'tile_blast', radius: 1, range: 10, save: 'agi' })
    expect((c.features.find(f => f.name === 'Test Plating')!.byTier[0] as any).stats).toEqual({ hp: 2 })
    expect(c.features.find(f => f.name === 'Test Reaction')!.partial).toBe(true)
    if (_v === 'v2') {
      const hammer = c.features.find(f => f.name === 'Test Hammer')!
      expect(hammer.partial).toBe(false)
      expect((hammer.byTier[0] as any).size).toBe('Superheavy')
      expect((hammer.byTier[0] as any).onHit).toContainEqual({ do: 'status', status: 'stunned', duration: 'next_turn_end_target', save: 'hull' })
    }
  })
  it('rejects files that are not packs', () => {
    expect(() => readLcp(strToU8('hello'))).toThrow(/zip/)
    expect(() => readLcp(zipSync({ 'readme.txt': strToU8('x') }))).toThrow(/No NPC classes/)
  })
  it('parses common riders from rules text', () => {
    expect(parseEffects('On hit, the target takes 2 heat and is knocked back 2.').effects).toEqual(expect.arrayContaining([{ do: 'heat', val: 2 }, { do: 'push', val: 2 }]))
    expect(parseAreaSave('Burst 2: characters must succeed on a Hull save or take 4 energy damage.')).toMatchObject({ target: 'self_burst', radius: 2, save: 'hull' })
    expect(parseAreaSave('Line 8: Hull save or take 4 kinetic damage')).toMatchObject({ target: 'line', radius: 8, save: 'hull' })
    expect(parseAreaSave('A Cone 3 of flame: no save mentioned.')).toBeNull()
  })
})

describe('official encounters', () => {
  const classes = readLcp(v2Pack()).classes
  it.each([[1, 'standard'], [2, 'elite'], [3, 'boss']] as const)('tier %s %s teams fit the budget and build into units', (tier, kind) => {
    const team = generateOfficialTeam(classes, tier, kind, 4, 123)
    expect(team.units.length).toBeGreaterThan(0)
    expect(teamBudget(team)).toBeLessThanOrEqual(4 * [1.4, 1.875, 1.4][tier - 1] * 2 + 1)
    if (kind === 'boss') expect(team.units.some(u => u.templates?.includes('Ultra'))).toBe(true)
    const units = buildTeam(team, 4)
    expect(units[0].stats.hp).toBeGreaterThan(0)
    expect(units.every(u => u.weapons.length > 0)).toBe(true)
  })
  it('a battle against official NPCs runs to completion', () => {
    const team = generateOfficialTeam(classes, 1, 'standard', 2, 9)
    const enemies = buildTeam(team, 2)
    const a = pregenUnit('Assault'), s = pregenUnit('Sniper')
    a.pos = { x: 1, y: 1 }; s.pos = { x: 2, y: 1 }
    enemies.forEach((u, i) => (u.pos = { x: 1 + (i % 10), y: 14 + Math.floor(i / 10) }))
    const b = new Battle({ map: flatMap(16, 16), units: [a, s, ...enemies], seed: 3 })
    b.start()
    autoBattle(b, 30)
    expect(b.round).toBeGreaterThan(0)
  })
})
