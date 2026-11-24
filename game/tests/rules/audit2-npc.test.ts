// Audit 2, NPCs: core book NPC rules (pp.280-283) and templates (pp.326-332), with the owner's rulings.
import { describe, expect, it } from 'vitest'
import { buildNpc, buildTeam } from '../../src/enemies/build'
import { generateOfficialTeam, officialUnitDef } from '../../src/enemies/official'
import { featureSlots, teamBudget, type EnemyUnitDef, type Feature } from '../../src/enemies/ruleset'
import { validateTeam } from '../../src/enemies/validate'
import { Rng } from '../../src/rules/rng'
import type { Unit } from '../../src/rules/types'
import { act, arena, pregenUnit, rigDice, teamFile } from '../support'

const gun = (extra: Partial<Feature> = {}): Feature => ({ type: 'weapon', name: 'Gun', weaponType: 'Rifle', range: [{ type: 'Range', val: 8 }], damage: [{ type: 'Kinetic', val: 4 }], ...extra } as Feature)
const npc = (def: Partial<EnemyUnitDef>, tier: 1 | 2 | 3 = 1): Unit => buildNpc({ name: 'X', role: 'Striker', features: [gun()], ...def } as EnemyUnitDef, tier)
const team = (units: any[], extra: any = {}) => ({ id: 'x', name: 'x', tier: 1, designedFor: 4, units, ...extra }) as any

/** Count the d6s rolled from now on (on top of any rigging). */
function countD6(b: any) {
  const inner = b.rng.int.bind(b.rng)
  const c = { n: 0 }
  b.rng.int = (min: number, max: number) => { if (min === 1 && max === 6) c.n++; return inner(min, max) }
  return c
}

describe('Recharge (core book p.282)', () => {
  it('a weapon-only NPC rolls Recharge at its turn start', () => {
    const e = npc({ features: [gun({ recharge: 5 })] })
    const b = arena([[pregenUnit('Assault'), { x: 1, y: 1 }], [e, { x: 9, y: 9 }]])
    e.weapons[0].charged = false
    rigDice(b, 6, 5)
    act(b, e)
    expect(e.weapons[0].charged).toBe(true)
  })
  it('a tech-only NPC rolls Recharge too', () => {
    const e = npc({ role: 'Controller', features: [{ type: 'tech', name: 'Hex', kind: 'quick', onHit: [{ do: 'heat', val: 2 }], recharge: 4 } as Feature] })
    const b = arena([[pregenUnit('Assault'), { x: 1, y: 1 }], [e, { x: 9, y: 9 }]])
    e.weapons[0].charged = false
    rigDice(b, 6, 4)
    act(b, e)
    expect(e.weapons[0].charged).toBe(true)
  })
  it('one roll per NPC, checked against every spent Recharge item', () => {
    const e = npc({ features: [gun({ recharge: 4 }), gun({ name: 'Cannon', recharge: 6 }), { type: 'system', name: 'Mend', activation: 'quick', target: 'self', effects: [{ do: 'heal', val: 2 }], recharge: 5 } as Feature] })
    const b = arena([[pregenUnit('Assault'), { x: 1, y: 1 }], [e, { x: 9, y: 9 }]])
    e.weapons.forEach(w => (w.charged = false))
    e.systems[0].charged = false
    rigDice(b, 6, 5)
    const c = countD6(b)
    act(b, e)
    expect(c.n).toBe(1)
    expect(e.weapons.map(w => w.charged)).toEqual([true, false])
    expect(e.systems[0].charged).toBe(true)
  })
  it('no roll when nothing is spent', () => {
    const e = npc({ features: [gun({ recharge: 5 })] })
    const b = arena([[pregenUnit('Assault'), { x: 1, y: 1 }], [e, { x: 9, y: 9 }]])
    const c = countD6(b)
    act(b, e)
    expect(c.n).toBe(0)
  })
})

describe('Grunt (core book p.327)', () => {
  it('keeps its Armor', () => {
    expect(npc({ role: 'Defender', templates: ['Grunt'] }, 3).stats.armor).toBe(3)
  })
  it('stays at 1 HP, 1 Structure and 1 Stress whatever else it takes', () => {
    const u = npc({ templates: ['Grunt', 'Commander'], features: [gun(), { type: 'trait', name: 'Plate', stats: { hp: 6 } } as Feature] })
    expect([u.hp, u.stats.structure, u.stats.stress]).toEqual([1, 1, 1])
  })
  it('the validator refuses Grunt + Veteran, and HP gains on a Grunt', () => {
    expect(validateTeam(team([{ name: 'G', role: 'Striker', templates: ['Grunt', 'Veteran'], veteranTraits: ['deadly'], features: [gun()] }])).errors.join()).toMatch(/Grunt cannot combine with Veteran/)
    expect(validateTeam(team([{ name: 'G', role: 'Striker', templates: ['Grunt'], features: [gun(), { type: 'trait', name: 'Plate', stats: { hp: 6 } }] }])).errors.join()).toMatch(/can't gain hp/)
    expect(validateTeam(team([{ name: 'G', role: 'Striker', templates: ['Grunt'], stats: { hp: 2 }, features: [gun()] }])).errors.join()).toMatch(/Grunt has 1 HP/)
  })
})

describe('Veteran: one Veteran trait per tier (core book p.332)', () => {
  it('a T3 Veteran carries all three traits', () => {
    const u = npc({ templates: ['Veteran'], veteranTraits: ['deadly', 'insulated', 'steel_jaw'] }, 3)
    expect(u.traits).toEqual(expect.arrayContaining(['deadly', 'insulated', 'steel_jaw']))
  })
  it('the validator wants exactly `tier` traits', () => {
    const vet = (tier: number, veteranTraits: string[]) => validateTeam(team([{ name: 'V', role: 'Striker', templates: ['Veteran'], veteranTraits, features: [gun()] }], { tier, designedFor: 1 })).errors.join()
    expect(vet(2, ['deadly'])).toMatch(/T2 Veteran takes 2 Veteran trait/)
    expect(vet(2, ['deadly', 'hacker'])).not.toMatch(/Veteran trait/)
  })
  it('the official generator picks `tier` distinct traits', () => {
    const def = officialUnitDef(fakeClass(), 3, ['Veteran'], new Rng(5))
    expect(def.veteranTraits).toHaveLength(3)
    expect(new Set(def.veteranTraits).size).toBe(3)
  })
})

/** An invented official class (no paid content): one base gun and many optional guns. */
function fakeClass(): any {
  const f = (id: string, base: boolean) => ({ id, name: id, base, partial: false, byTier: [1, 2, 3].map(() => gun({ name: id })) })
  const s = { hp: 10, armor: 0, evasion: 8, edef: 8, heatcap: 6, speed: 4, sensors: 8, save: 10, size: 1, hull: 1, agi: 1, sys: 0, eng: 0, structure: 1, stress: 1, activations: 1, attackBonus: 1, techAttack: 0 }
  return { id: 'npcc_fake', name: 'FAKE', role: 'Striker', stats: [s, s, s], features: [f('base', true), ...Array.from({ length: 12 }, (_, i) => f(`opt${i}`, false))] }
}

describe('Elite (core book p.326)', () => {
  it('Specialist Kit: one extra feature slot, and one extra optional system from the official generator', () => {
    expect(featureSlots(1, ['Elite'])).toBe(featureSlots(1) + 1)
    const plain = officialUnitDef(fakeClass(), 1, [], new Rng(3), 1)
    const elite = officialUnitDef(fakeClass(), 1, ['Elite'], new Rng(3), 1)
    expect(elite.features.length).toBe(plain.features.length + 1)
  })
  it('reactions refresh once per round for an Elite, at each turn for an Ultra (data-driven flag)', () => {
    expect(npc({ templates: ['Elite'] }).flags.reactionsEachTurn).toBeFalsy()
    const ultra = npc({ templates: ['Ultra'], features: [gun(), { type: 'reaction', name: 'Riposte', trigger: 'hit_by_melee', attackWith: 'Gun' } as Feature] })
    expect(ultra.flags.reactionsEachTurn).toBe(true)
    const b = arena([[pregenUnit('Assault'), { x: 1, y: 1 }], [ultra, { x: 9, y: 9 }]])
    const r = ultra.systems.find(s => s.feature?.type === 'reaction')!
    ultra.flags[`round:${r.uid}`] = true
    ultra.flags['react:overwatch'] = true
    act(b, ultra)
    expect(ultra.flags[`round:${r.uid}`]).toBeFalsy()
    expect(ultra.flags['react:overwatch']).toBeFalsy()
  })
})

describe('Commander: Voice of Authority covers checks and saves (core book p.326)', () => {
  it('an ally that fails a save rerolls it, spending the Commander\'s reaction', () => {
    const cmd = npc({ name: 'Cmd', templates: ['Commander'] })
    const ally = npc({ name: 'Ally' })
    const b = arena([[pregenUnit('Assault'), { x: 1, y: 1 }], [cmd, { x: 10, y: 10 }], [ally, { x: 5, y: 10 }]])
    rigDice(b, 20, 1, 20)
    expect(b.save(ally, 'hull', 10)).toBe(true)
    expect(cmd.reactionsLeft).toBe(0)
    rigDice(b, 20, 1)
    expect(b.check(ally, 'hull')).toBe(false) // reaction spent: no second reroll
  })
})

describe('Feign Death (core book p.332)', () => {
  it('also triggers on a crushing hit', () => {
    const u = npc({ templates: ['Veteran'], veteranTraits: ['feign_death'] })
    const b = arena([[pregenUnit('Assault'), { x: 1, y: 1 }], [u, { x: 9, y: 9 }]])
    b.destroy(u, 'crushing hit')
    expect(u.destroyed).toBe(false)
    expect(u.hp).toBe(1)
  })
})

describe('NPC basic actions (core book p.280)', () => {
  it('Improvised Attack: fixed 3/4/6 damage by tier', () => {
    const e = npc({}, 2)
    const p = pregenUnit('Assault')
    const b = arena([[p, { x: 5, y: 5 }], [e, { x: 6, y: 5 }]])
    act(b, e)
    const hp = p.hp
    rigDice(b, 20, 15)
    b.improvisedAttack(e, p)
    expect(hp - p.hp).toBe(4)
  })
  it('Invade: 2 heat and Impaired, not Slowed', () => {
    const e = npc({ role: 'Controller' })
    const p = pregenUnit('Assault')
    const b = arena([[p, { x: 5, y: 5 }], [e, { x: 7, y: 5 }]])
    act(b, e)
    rigDice(b, 20, 19)
    b.invade(e, p)
    expect(p.heat).toBe(2)
    expect(b.has(p, 'impaired')).toBe(true)
    expect(b.has(p, 'slowed')).toBe(false)
  })
})

describe('Encounter budget: at least one NPC per player in a standard fight (core book p.283)', () => {
  it('the validator refuses a standard team under 1 budget per player', () => {
    const units = [{ name: 'A', role: 'Striker', count: 3, features: [gun()] }]
    expect(validateTeam(team(units)).errors.join()).toMatch(/at least one NPC per player/)
    expect(validateTeam(team([{ ...units[0], count: 4 }])).errors.join()).not.toMatch(/at least one NPC/)
  })
  it('a rescaled standard team keeps the floor', () => {
    const t = teamFile('t1-theodora-sunspotters')
    for (const n of [3, 5, 6]) {
      const units = buildTeam(t, n)
      expect(units.reduce((a, u) => a + (u.flags.budget ?? 0), 0), `${n} PCs`).toBeGreaterThanOrEqual(n)
    }
  })
  it('the official generator gives a standard fight at least one NPC per player', () => {
    for (const tier of [1, 2, 3] as const) for (const seed of [1, 2, 3, 4]) {
      const t = generateOfficialTeam([fakeClass()], tier, 'standard', 4, seed)
      expect(teamBudget(t), `T${tier} seed ${seed}`).toBeGreaterThanOrEqual(4)
    }
  })
})
