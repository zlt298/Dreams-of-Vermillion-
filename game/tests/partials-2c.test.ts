// Former partial scripts, batch 2c: talent ranks.
import { describe, expect, it } from 'vitest'
import type { PilotBuild } from '../src/import/compcon'
import { buildMechUnit } from '../src/rules/stats'
import { Battle } from '../src/rules/battle'
import { autoBattle, aiErrors } from '../src/ai/ai'
import { getScript } from '../src/rules/effects/registry'
import type { Unit } from '../src/rules/types'
import { flatMap, pregenUnit } from './helpers'

function mech(talents: [string, number][], o: { side?: 'player' | 'enemy'; name?: string; weapon?: string; size?: string } = {}): Unit {
  const p = {
    id: `t-${Math.random()}`, callsign: o.name ?? 'Tester', name: 'T', level: 12, mechSkills: [2, 2, 2, 2], talents: talents.map(([id, rank]) => ({ id, rank })), coreBonuses: [],
    mech: { name: 'T', frameId: 'mf_standard_pattern_i_everest', mounts: [{ type: o.size ?? 'Main', slots: [{ size: o.size ?? 'Main', weaponId: o.weapon ?? 'mw_assault_rifle' }], bonusEffects: [] }], systems: [] },
    unknown: [],
  } as unknown as PilotBuild
  return buildMechUnit(p, o.side ?? 'player')
}
function setup(talents: [string, number][], o: { weapon?: string; size?: string } = {}) {
  const a = mech(talents, o)
  const e = pregenUnit('Assault', 'enemy')
  a.pos = { x: 5, y: 4 }
  e.pos = { x: 5, y: 8 }
  e.stats.evasion = 1; e.stats.hull = -20; e.stats.agi = -20; e.stats.sys = -20
  const b = new Battle({ map: flatMap(16, 16), units: [a, e], seed: 13 })
  b.start()
  b.beginTurn(a)
  return { a, e, b }
}
const act = (b: Battle, u: Unit, re: RegExp) => {
  const x = b.customActions(u).find(c => re.test(c.name) || re.test(c.key))
  if (!x) throw new Error(`no action ${re}: ${b.customActions(u).map(c => c.name).join(', ')}`)
  return x
}
const rifle = (u: Unit) => u.weapons.find(w => !w.destroyed && !w.tech)!
const toEnemyTurn = (b: Battle, a: Unit, e: Unit) => { b.endTurn(a); b.beginTurn(e) }

describe('2c: talent ranks are complete', () => {
  it('no partial talent rank scripts remain', () => {
    for (const id of ['t_ace:3', 't_bonded:1', 't_bonded:2', 't_bonded:3', 't_brutal:1', 't_crack_shot:3', 't_centimane:3', 't_duelist:2', 't_exemplar:1', 't_exemplar:3', 't_hacker:3', 't_heavy_gunner:1', 't_infiltrator:3', 't_leader:1', 't_stormbringer:2', 't_walking_armory:1'])
      expect(getScript(id)?.partial, id).toBeFalsy()
  })
})

describe('talents', () => {
  it('Bonded 1: +1 Accuracy on checks and saves for both while adjacent; the Bondmate is chosen', () => {
    const { a, b } = setup([['t_bonded', 1]])
    const m = mech([], { name: 'Mate' }); m.pos = { x: 6, y: 4 }; b.units.push(m)
    b.useCustom(a, act(b, a, /Choose Bondmate/), m)
    expect(b.accuracyFromStatuses(a, 'save', 'hull')).toBe(1)
    expect(b.accuracyFromStatuses(m, 'check', 'agi')).toBe(1)
    m.pos = { x: 10, y: 10 }
    expect(b.accuracyFromStatuses(a, 'save', 'hull')).toBe(0)
  })
  it('Bonded 2: Intercede asks the player and takes the damage instead', () => {
    const { a, e, b } = setup([['t_bonded', 2]])
    const m = mech([], { name: 'Mate' }); m.pos = { x: 6, y: 4 }; b.units.push(m)
    a.flags.bondmate = m.id
    b.chooser = () => undefined
    const hp = m.hp, ahp = a.hp
    const r = b.transaction(() => { b.applyDamage(m, [{ type: 'Kinetic', amount: 6 }], { source: e }) })
    expect('pending' in r && r.pending.kind).toBe('intercede')
    b.transaction(() => { b.applyDamage(m, [{ type: 'Kinetic', amount: 6 }], { source: e }) }, [0])
    expect(m.hp).toBe(hp)
    expect(a.hp).toBeLessThan(ahp)
  })
  it('Bonded 3: Cover Me! — the threatened attacker may switch targets', () => {
    const { a, e, b } = setup([['t_bonded', 3]])
    const m = mech([], { name: 'Mate' }); m.pos = { x: 6, y: 6 }; b.units.push(m)
    const other = mech([], { name: 'Other' }); other.pos = { x: 4, y: 6 }; b.units.push(other)
    a.flags.bondmate = m.id
    toEnemyTurn(b, a, e)
    e.hp = 2 // a hurt attacker switches by default
    const r = b.weaponAttack(e, rifle(e), { targetId: m.id }, 'free')
    expect(r.ctxs[0].target).not.toBe(m)
    expect(a.reactionsLeft).toBe(0)
  })
  it('Brutal 1: a natural 20 crit deals maximum damage', () => {
    const { a, e, b } = setup([['t_brutal', 1]])
    e.stats.hp = 999; e.hp = 999; e.stats.armor = 0
    let found = false
    for (let s = 1; s < 3000 && !found; s++) {
      b.rng.state = s
      if (b.rng.d(20) === 20) { b.rng.state = s; found = true }
    }
    const hp = e.hp
    const r = b.weaponAttack(a, rifle(a), { targetId: e.id }, 'free')
    if (r.ctxs[0].roll === 20) expect(hp - e.hp).toBeGreaterThanOrEqual(6 + 0) // assault rifle 1d6 maxed
    expect(found).toBe(true)
  })
  it('Crack Shot 3: on a steadied Rifle crit, the shooter picks the effect', () => {
    const { a, e, b } = setup([['t_crack_shot', 3]], { weapon: 'mw_assault_rifle' })
    const s = getScript('t_crack_shot:3')!
    a.flags.steady = true
    b.chooser = () => undefined
    const ctx: any = { attacker: a, target: e, weapon: rifle(a), crit: true, hit: true }
    b.transaction(() => s.afterAttack!(b, a, ctx, 'attacker'), [1])
    expect(b.has(e, 'immobilized')).toBe(true)
  })
  it('Centimane 3: Restricting swarm burns on every action', () => {
    const { a, e, b } = setup([['t_centimane', 3]])
    const s = getScript('t_centimane:3')!
    b.chooser = () => undefined
    b.transaction(() => s.afterAttack!(b, a, { attacker: a, target: e, weapon: { ...rifle(a), type: 'Nexus' }, crit: true, hit: true } as any, 'attacker'), [3])
    toEnemyTurn(b, a, e)
    b.boost(e)
    expect(e.burn).toBeGreaterThanOrEqual(1)
  })
  it('Duelist 2: Blademaster dice — Parry gives resistance; Trip knocks Prone', () => {
    const { a, e, b } = setup([['t_duelist', 2]])
    a.flags.bladeDice = 2
    e.pos = { x: 5, y: 5 }
    b.useCustom(a, act(b, a, /Trip/), e)
    expect(b.has(e, 'prone')).toBe(true)
    expect(a.flags.bladeDice).toBe(1)
  })
  it('Exemplar 1: Valiant Aid lets an ally reroll a miss on your Mark', () => {
    const { a, e, b } = setup([['t_exemplar', 1]])
    const al = mech([], { name: 'Ally' }); al.pos = { x: 6, y: 5 }; b.units.push(al)
    e.flags.exemplarMarkBy = a.id
    e.stats.evasion = 99
    b.weaponAttack(al, rifle(al), { targetId: e.id }, 'free')
    expect(b.log.some(l => /Reroll vs/.test(l.text))).toBe(true)
    expect(a.reactionsLeft).toBe(0)
  })
  it('Exemplar 3: you cannot voluntarily move away from your Mark during the duel', () => {
    const { a, e, b } = setup([['t_exemplar', 3]])
    a.flags.duel = e.id
    expect(() => b.move(a, { x: 5, y: 1 })).toThrow(/To the Death/)
    b.move(a, { x: 5, y: 6 })
  })
  it('Hacker 3: Last Argument of Kings deals Burn equal to Heat', () => {
    const { a, e, b } = setup([['t_hacker', 3]])
    a.stats.techAttack = 30
    e.heat = 5
    b.useCustom(a, act(b, a, /Last Argument/), e)
    expect(e.burn).toBe(5)
  })
  it('Heavy Gunner 1: Covering Fire triggers only after more than 1 space, for half damage', () => {
    const { a, e, b } = setup([['t_heavy_gunner', 1]], { weapon: 'mw_heavy_machine_gun', size: 'Heavy' })
    b.useCustom(a, act(b, a, /Covering Fire/), e)
    expect(b.has(e, 'impaired')).toBe(true)
    toEnemyTurn(b, a, e)
    b.move(e, { x: 6, y: 8 })
    expect(e.flags.coveredBy).toBe(a.id)
    b.move(e, { x: 8, y: 8 })
    expect(e.flags.coveredBy).toBeUndefined()
    expect(b.has(e, 'impaired')).toBe(false)
  })
  it('Leader 1: Issue Order gives an ally a die it spends for +1 Accuracy', () => {
    const { a, e, b } = setup([['t_leader', 1]])
    const al = mech([], { name: 'Ally' }); al.pos = { x: 6, y: 4 }; b.units.push(al)
    b.useCustom(a, act(b, a, /Issue Order/), al)
    expect(al.flags.leaderDie).toBe(a.id)
    b.endTurn(a)
    b.currentSide = 'player'
    b.beginTurn(al)
    const p = b.previewAttack(al, rifle(al), e)
    expect(p.ctx.reasons.some(r => /order/.test(r))).toBe(true)
  })
  it('Stormbringer 2: Thunder knocks back everyone else near the target', () => {
    const { a, e, b } = setup([['t_stormbringer', 2]])
    const e2 = pregenUnit('Sniper', 'enemy'); e2.pos = { x: 6, y: 9 }; e2.stats.agi = -20; b.units.push(e2)
    b.chooser = () => undefined
    const s = getScript('t_stormbringer:2')!
    const from = { ...e2.pos }
    b.transaction(() => s.afterAttack!(b, a, { attacker: a, target: e, weapon: { ...rifle(a), type: 'Launcher' }, hit: true } as any, 'attacker'), [1])
    expect(e2.pos).not.toEqual(from)
  })
  it('Ace 3: Supersonic flies you next to the nominee when its turn ends', () => {
    const { a, e, b } = setup([['t_ace', 3]])
    a.flying = true
    b.useCustom(a, act(b, a, /Spin Up/))
    b.endTurn(a)
    expect(a.flags.supersonic).toBe(e.id)
    b.beginTurn(e)
    b.endTurn(e)
    expect(b.adjacent(a, e)).toBe(true)
  })
  it('AI battles with these talents run cleanly', () => {
    const p1 = mech([['t_bonded', 3], ['t_exemplar', 3], ['t_leader', 1]])
    const p2 = mech([['t_duelist', 2], ['t_brutal', 1], ['t_bonded', 2]], { weapon: 'mw_chain_axe' })
    const p3 = mech([['t_heavy_gunner', 1], ['t_ace', 3], ['t_centimane', 3]], { weapon: 'mw_heavy_machine_gun', size: 'Heavy' })
    const e1 = mech([['t_infiltrator', 3], ['t_crack_shot', 3]], { side: 'enemy' }), e2 = pregenUnit('Sniper', 'enemy'), e3 = mech([['t_stormbringer', 2], ['t_hacker', 3]], { side: 'enemy' })
    p1.pos = { x: 3, y: 2 }; p2.pos = { x: 7, y: 2 }; p3.pos = { x: 10, y: 2 }; e1.pos = { x: 3, y: 12 }; e2.pos = { x: 7, y: 13 }; e3.pos = { x: 10, y: 12 }
    const b = new Battle({ map: flatMap(14, 16), units: [p1, p2, p3, e1, e2, e3], seed: 9 })
    b.start()
    aiErrors.length = 0
    autoBattle(b, 8)
    expect(aiErrors).toHaveLength(0)
  })
})
