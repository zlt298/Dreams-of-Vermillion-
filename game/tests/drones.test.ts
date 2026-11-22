// Drones and deployables: deploy/recall/redeploy plumbing and each system's field or effect.
import { describe, expect, it } from 'vitest'
import type { PilotBuild } from '../src/import/compcon'
import { buildMechUnit } from '../src/rules/stats'
import { Battle } from '../src/rules/battle'
import { autoBattle, aiErrors } from '../src/ai/ai'
import type { Unit } from '../src/rules/types'
import { flatMap, pregenUnit } from './helpers'

function mech(systems: string[], opts: { frame?: string; talents?: { id: string; rank: number }[]; side?: 'player' | 'enemy'; name?: string } = {}): Unit {
  const p: PilotBuild = {
    id: `t-${Math.random()}`, callsign: opts.name ?? 'Tester', name: 'Test', level: 6, mechSkills: [2, 2, 2, 2],
    talents: opts.talents ?? [], coreBonuses: [],
    mech: { name: 'Test', frameId: opts.frame ?? 'mf_standard_pattern_i_everest', mounts: [{ type: 'Main', slots: [{ size: 'Main', weaponId: 'mw_assault_rifle' }], bonusEffects: [] }], systems },
    unknown: [],
  } as any
  return buildMechUnit(p, opts.side ?? 'player')
}
function setup(systems: string[], opts: Parameters<typeof mech>[1] = {}) {
  const a = mech(systems, opts)
  const e = pregenUnit('Assault', 'enemy')
  a.pos = { x: 3, y: 3 }
  e.pos = { x: 3, y: 9 }
  const b = new Battle({ map: flatMap(14, 14), units: [a, e], seed: 5 })
  b.start()
  b.beginTurn(a)
  return { a, e, b }
}
const act = (b: Battle, u: Unit, key: RegExp) => {
  const x = b.customActions(u).find(c => key.test(c.key) || key.test(c.name))
  if (!x) throw new Error(`no action ${key}: ${b.customActions(u).map(c => c.name).join(', ')}`)
  return x
}
const drones = (b: Battle, u: Unit, name: string) => b.alive().filter(d => d.ownerId === u.id && d.flags.dataName === name)
const passTurn = (b: Battle, from: Unit, to: Unit) => { b.endTurn(from); b.beginTurn(to) }

describe('drones and deployables', () => {
  it('Hive Drone: deploy, soft cover for allies, 1 AP kinetic to hostiles starting in it, recall', () => {
    const { a, e, b } = setup(['ms_hive_drone'])
    b.useCustom(a, act(b, a, /Deploy Hive Drone/), { x: 3, y: 7 })
    const hive = drones(b, a, 'Hive Drone')[0]
    expect(hive).toBeDefined()
    const hp = e.hp
    passTurn(b, a, e)
    expect(e.hp).toBe(hp - 1)
    expect(b.cover(e, hive)).toBe('soft')
    b.endTurn(e); b.beginTurn(a)
    b.useCustom(a, act(b, a, /Recall Hive/))
    expect(drones(b, a, 'Hive Drone')).toHaveLength(0)
  })
  it('Sentinel Drone: hostiles in its field take 3 kinetic before attacking', () => {
    const { a, e, b } = setup(['ms_sentinel_drone'])
    b.useCustom(a, act(b, a, /Deploy Sentinel/), { x: 3, y: 8 })
    passTurn(b, a, e)
    const hp = e.hp
    b.skirmish(e, e.weapons.find(w => w.dataId === 'mw_assault_rifle')!, { targetId: a.id })
    expect(e.hp).toBeLessThan(hp)
  })
  it('Restock Drone: primes at end of turn; an adjacent ally activates it to vent heat and reload', () => {
    const { a, e, b } = setup(['ms_restock_drone'])
    b.useCustom(a, act(b, a, /Deploy Restock/), { x: 4, y: 3 })
    expect(() => act(b, a, /Activate Restock/)).toThrow()
    passTurn(b, a, e); b.endTurn(e); b.beginTurn(a)
    a.heat = 6
    b.useCustom(a, act(b, a, /Activate Restock/))
    expect(a.heat).toBeLessThan(6)
    expect(drones(b, a, 'Restock Drone')).toHaveLength(0)
  })
  it('ICEOUT Drone: characters in its field are immune to tech', () => {
    const { a, e, b } = setup(['ms_iceout_drone'])
    b.useCustom(a, act(b, a, /Deploy ICEOUT/), { x: 3, y: 4 })
    expect(b.techTargetValid(e, a)).toMatch(/ICEOUT/)
  })
  it('Lotus Projector: hostiles in the field cannot Hide', () => {
    const { a, e, b } = setup(['ms_lotus_projector'])
    e.pos = { x: 6, y: 6 }
    b.useCustom(a, act(b, a, /Deploy Lotus/), { x: 6, y: 7 })
    b.addStatus(e, 'invisible')
    expect(b.canHide(e)).toBe(false)
  })
  it('Aegis Shield Generator: rolls a die to reduce damage to allies in the area', () => {
    const { a, b } = setup(['ms_aegis_shield_generator'])
    b.useCustom(a, act(b, a, /Deploy Aegis/), { x: 4, y: 3 })
    const gen = drones(b, a, 'Aegis Shield Generator')[0]
    const hp = a.hp
    b.applyDamage(a, [{ type: 'Kinetic', amount: 8 }])
    expect(hp - a.hp).toBeLessThan(8)
    expect(gen.flags.aegisDice).toBe(2)
  })
  it('Portable Bunker: hard cover for allies inside, once unfolded', () => {
    const { a, e, b } = setup(['ms_portable_bunker'])
    b.useCustom(a, act(b, a, /Deploy Portable Bunker/), { x: 4, y: 2 })
    const bk = drones(b, a, 'Portable Bunker')[0]
    expect(bk.stats.size).toBe(4)
    a.pos = { x: 5, y: 3 }
    b.round++
    expect(b.cover(e, a)).toBe('hard')
  })
  it('Stasis Barrier: a line of obstructions that gives soft cover', () => {
    const { a, e, b } = setup(['ms_stasis_barrier'])
    b.useCustom(a, act(b, a, /Stasis Barrier/), { x: 3, y: 4 })
    expect(drones(b, a, 'Stasis Barrier').length).toBeGreaterThanOrEqual(3)
    expect(b.cover(e, a)).not.toBe('none')
  })
  it('Perimeter Command Plate (Attract): characters moving onto it save or are Immobilized; it is flat', () => {
    const { a, e, b } = setup(['ms_perimeter_command_plate'])
    b.useCustom(a, act(b, a, /Attract/), { x: 3, y: 7 })
    e.stats.hull = -20
    passTurn(b, a, e)
    b.move(e, { x: 3, y: 7 })
    expect(b.has(e, 'immobilized')).toBe(true)
    expect(e.pos).toEqual({ x: 3, y: 7 })
  })
  it('Tempest Drone: characters starting adjacent save or take 4 energy and are knocked back', () => {
    const { a, e, b } = setup(['ms_tempest_drone'])
    e.stats.hull = -20
    b.useCustom(a, act(b, a, /Deploy Tempest/), { x: 3, y: 8 })
    const hp = e.hp
    passTurn(b, a, e)
    expect(e.hp).toBeLessThan(hp)
    expect(e.pos.y).toBeGreaterThan(9)
  })
  it('Interdiction Field toggles and slows its user', () => {
    const { a, b } = setup(['ms_interdiction_field'])
    b.useCustom(a, act(b, a, /Interdiction Field/))
    expect(b.has(a, 'slowed')).toBe(true)
  })
  it('Hydra: Full Deployment puts out all four OROCHI drones; Guardian adds difficulty to ranged attacks on adjacent allies', () => {
    const { a, e, b } = setup([], { frame: 'mf_hydra' })
    a.coreAvailable = true
    b.activateCore(a)
    const orochi = b.alive().filter(d => d.ownerId === a.id && d.flags.orochi)
    expect(orochi).toHaveLength(4)
    const g = orochi.find(d => d.flags.orochi === 'Guardian')!
    const ally = pregenUnit('Sniper')
    ally.pos = { x: g.pos.x + 1, y: g.pos.y }
    if (b.alive().some(o => o !== ally && o.pos.x === ally.pos.x && o.pos.y === ally.pos.y)) ally.pos = { x: g.pos.x - 1, y: g.pos.y }
    b.units.push(ally)
    const rifle = e.weapons.find(w => w.dataId === 'mw_assault_rifle')!
    expect(b.previewAttack(e, rifle, ally).ctx.reasons).toContain('Guardian OROCHI -1')
  })
  it('Drone Commander: Invigorate gives a chain of allies 4 overshield', () => {
    const { a, b } = setup(['ms_hive_drone'], { talents: [{ id: 't_drone_commander', rank: 3 }] })
    const ally = pregenUnit('Sniper'); ally.pos = { x: 5, y: 3 }
    const ally2 = pregenUnit('Hacker'); ally2.pos = { x: 8, y: 3 }
    b.units.push(ally, ally2)
    b.useCustom(a, act(b, a, /Invigorate/), ally)
    expect(ally.overshield).toBe(4)
    expect(ally2.overshield).toBe(4)
  })
  it('AI battles with every drone/deployable system without errors', () => {
    aiErrors.length = 0
    const sets = [
      ['ms_hive_drone', 'ms_sentinel_drone', 'ms_restock_drone'],
      ['ms_tempest_drone', 'ms_assassin_drone', 'ms_autoloader_drone', 'ms_iceout_drone'],
      ['ms_lotus_projector', 'ms_perimeter_command_plate', 'ms_aegis_shield_generator', 'ms_portable_bunker'],
      ['ms_oasis_wall', 'ms_stasis_barrier', 'ms_interdiction_field'],
    ]
    const players = sets.map((s, i) => { const u = mech(s, { name: `P${i}`, frame: i === 3 ? 'mf_hydra' : undefined, talents: [{ id: 't_drone_commander', rank: 3 }] }); u.pos = { x: 2 + i * 3, y: 1 }; return u })
    const enemies = sets.map((s, i) => { const u = mech(s, { side: 'enemy', name: `E${i}` }); u.pos = { x: 2 + i * 3, y: 18 }; return u })
    const b = new Battle({ map: flatMap(16, 20), units: [...players, ...enemies], seed: 11 })
    b.start()
    autoBattle(b, 10)
    expect(aiErrors).toEqual([])
    expect(b.units.filter(u => u.kind === 'drone' || u.kind === 'deployable').length).toBeGreaterThan(0)
  })
})
