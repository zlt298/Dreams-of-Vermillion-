import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { validateTeam } from '../src/enemies/validate'
import { buildTeam } from '../src/enemies/build'
import { baselineStats, teamBudget } from '../src/enemies/ruleset'
import { autoBattle } from '../src/ai/ai'
import { Battle } from '../src/rules/battle'
import { flatMap, pregenUnit } from './helpers'

const dir = join(__dirname, '../../data/enemies')
const teams = readdirSync(dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')))

describe('enemy ruleset', () => {
  it('baseline stats scale with tier and templates', () => {
    const t1 = baselineStats('Striker', 1)
    const t3 = baselineStats('Striker', 3)
    expect(t3.hp).toBeGreaterThan(t1.hp)
    expect(t3.attackBonus).toBe(3)
    expect(baselineStats('Striker', 1, ['Grunt']).hp).toBe(1)
    expect(baselineStats('Defender', 2, ['Ultra']).activations).toBe(2)
  })

  it.each(teams.map(t => [t.id, t]))('%s is valid', (_id, t) => {
    const r = validateTeam(t)
    expect(r.errors).toEqual([])
  })

  it('rejects overpowered or malformed teams', () => {
    const bad = {
      id: 'bad', name: 'Bad', tier: 1, designedFor: 4,
      units: [{ name: 'Doom', role: 'Striker', count: 8, stats: { hp: 99 }, features: [
        { type: 'weapon', name: 'Gun', weaponType: 'Rifle', range: [{ type: 'Range', val: 10 }], damage: [{ type: 'Kinetic', val: '4d6+4' }] },
        { type: 'tech', name: 'x', kind: 'quick', onHit: [{ do: 'status', status: 'banana' }] },
      ] }],
    }
    const r = validateTeam(bad as any)
    expect(r.ok).toBe(false)
    expect(r.errors.join('\n')).toMatch(/hp 99/)
    expect(r.errors.join('\n')).toMatch(/average damage/)
    expect(r.errors.join('\n')).toMatch(/banana/)
    expect(r.errors.join('\n')).toMatch(/budget/)
  })

  it('builds units and scales to squad size', () => {
    const t = teams.find(t => t.id === 't1-scrapjaw-raiders')
    expect(buildTeam(t, 4).length).toBe(11)
    expect(buildTeam(t, 2).length).toBeLessThan(11)
    expect(teamBudget(t)).toBe(5)
  })
})

describe('auto battle', () => {
  it.each(teams.map(t => [t.id, t]))('pregen squad vs %s runs to completion', (_id, team) => {
    const squad = ['Vanguard', 'Assault', 'Sniper', 'Fire Support'].map(n => pregenUnit(n))
    const enemies = buildTeam(team, 4)
    squad.forEach((u, i) => (u.pos = { x: 1 + i * 2, y: 1 }))
    enemies.forEach((u, i) => (u.pos = { x: 1 + (i % 6) * 2, y: 13 + Math.floor(i / 6) * 2 }))
    const map = flatMap(14, 18, (x, y) => (y === 8 && x % 4 === 1 ? { h: 2, kind: 'block' } : y === 9 && x % 5 === 2 ? { kind: 'forest' } : undefined))
    const b = new Battle({ map, units: [...squad, ...enemies], seed: 42 })
    b.start()
    autoBattle(b, 15)
    expect(b.round).toBeGreaterThan(1)
    const attacks = b.events.filter(e => e.type === 'attack').length
    expect(attacks).toBeGreaterThan(4)
  })
})

describe('official templates', () => {
  const def = (templates: any[], extra: any = {}) => ({ name: 'X', role: 'Striker', templates, features: [], ...extra })
  it('Elite: +1 structure/stress and two turns; cannot crit', () => {
    const s = baselineStats('Striker', 1, ['Elite'])
    expect([s.structure, s.stress, s.activations]).toEqual([2, 2, 2])
    expect(buildTeam({ id: 't', name: 't', tier: 1, designedFor: 4, units: [def(['Elite'])] } as any)[0].canCrit).toBe(false)
  })
  it('Veteran: +1/+1, Veterancy and a chosen trait; can crit', () => {
    const [u] = buildTeam({ id: 't', name: 't', tier: 1, designedFor: 4, units: [def(['Veteran'], { veterancy: 'agi', veteranTrait: 'deadly' })] } as any)
    expect([u.stats.structure, u.stats.stress, u.stats.activations]).toEqual([2, 2, 1])
    expect(u.traits).toEqual(expect.arrayContaining(['veterancy:agi', 'deadly']))
    expect(u.canCrit).toBe(true)
  })
  it('Ultra: 4 structure/stress, two turns (three vs 5+ hostiles), Deadly and Legendary', () => {
    const s = baselineStats('Striker', 1, ['Ultra'])
    expect([s.structure, s.stress, s.activations]).toEqual([4, 4, 2])
    const team = { id: 't', name: 't', tier: 1, designedFor: 4, units: [def(['Ultra'])] } as any
    expect(buildTeam(team, 5)[0].stats.activations).toBe(3)
    expect(buildTeam(team)[0].traits).toEqual(expect.arrayContaining(['deadly', 'legendary', 'reflex']))
  })
  it('Veterancy adds accuracy to the chosen skill only', () => {
    const [u] = buildTeam({ id: 't', name: 't', tier: 1, designedFor: 4, units: [def(['Veteran'], { veterancy: 'sys' })] } as any)
    const p = pregenUnit('Assault'); p.pos = { x: 1, y: 1 }; u.pos = { x: 8, y: 8 }
    const b = new Battle({ map: flatMap(), units: [p, u], seed: 1 })
    expect(b.accuracyFromStatuses(u, 'save', 'sys')).toBe(1)
    expect(b.accuracyFromStatuses(u, 'save', 'hull')).toBe(0)
  })
  it('Feign Death: survives the first destruction on 1 HP', () => {
    const [u] = buildTeam({ id: 't', name: 't', tier: 1, designedFor: 4, units: [def(['Veteran'], { veteranTrait: 'feign_death' })] } as any)
    const p = pregenUnit('Assault'); p.pos = { x: 1, y: 1 }; u.pos = { x: 8, y: 8 }
    const b = new Battle({ map: flatMap(), units: [p, u], seed: 1 })
    b.destroy(u, 'test')
    expect(u.destroyed).toBe(false)
    expect(u.hp).toBe(1)
    b.destroy(u, 'test')
    expect(u.destroyed).toBe(true)
  })
  it('validator rejects unknown veteran traits and traits without the template', () => {
    const base = { id: 'x', name: 'x', tier: 1, designedFor: 4, units: [] as any[] }
    expect(validateTeam({ ...base, units: [def(['Veteran'], { veteranTrait: 'nope', features: [{ type: 'weapon', name: 'g', weaponType: 'Rifle', range: [{ type: 'Range', val: 8 }], damage: [{ type: 'Kinetic', val: 4 }] }] })] } as any).errors.join()).toMatch(/veteranTrait/)
    expect(validateTeam({ ...base, units: [def([], { veteranTrait: 'deadly' })] } as any).errors.join()).toMatch(/requires the Veteran/)
  })
})
