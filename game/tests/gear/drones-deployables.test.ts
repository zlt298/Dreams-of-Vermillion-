// Drones and deployables: deploy/recall/redeploy plumbing and each system's field or effect (alphabetical).
// The Hydra's OROCHI drones are with the Hydra in frames-cores.test.ts.
import { describe, expect, it } from 'vitest'
import { autoBattle, aiErrors } from '../../src/ai/ai'
import { getScript } from '../../src/rules/effects/registry'
import type { Battle } from '../../src/rules/battle'
import type { Unit } from '../../src/rules/types'
import { battle, flatMap, mech } from '../support'
import { custom, toEnemyTurn, vs } from './helpers'

/** Level-6 Everest with these systems at (3,3) vs a plain Assault at (3,9) on a 14×14 map, seed 5. */
const setup = (systems: string[]) => vs(mech({ level: 6, systems }), { a: { x: 3, y: 3 }, e: { x: 3, y: 9 }, map: flatMap(14, 14), seed: 5 })
const drones = (b: Battle, u: Unit, name: string) => b.alive().filter(d => d.ownerId === u.id && d.flags.dataName === name)
const passTurn = (b: Battle, from: Unit, to: Unit) => { b.endTurn(from); b.beginTurn(to) }

describe('Aegis Shield Generator', () => {
  it('rolls a die to reduce damage to allies in the area', () => {
    const { a, b } = setup(['ms_aegis_shield_generator'])
    b.useCustom(a, custom(b, a, /Deploy Aegis/), { x: 4, y: 3 })
    const gen = drones(b, a, 'Aegis Shield Generator')[0]
    const hp = a.hp
    b.applyDamage(a, [{ type: 'Kinetic', amount: 8 }])
    expect(hp - a.hp).toBeLessThan(8)
    expect(gen.flags.aegisDice).toBe(2)
  })
})

describe('Assassin Drone', () => {
  it('Area Denial fires every time (not once a round)', () => {
    const { a, e, b } = vs(mech({ level: 6, systems: ['ms_assassin_drone'] }), { enemy: { hull: -20, agi: -20, sys: -20, eng: -20, evasion: 1, edef: 1 } })
    b.useCustom(a, custom(b, a, /Deploy Assassin/), { x: 5, y: 9 })
    toEnemyTurn(b, a, e)
    a.reactionsLeft = 1
    b.move(e, { x: 6, y: 9 })
    expect(b.log.some(l => /Area Denial/.test(l.text))).toBe(true)
  })
})

describe('Hive Drone', () => {
  it('deploy, soft cover for allies, 1 AP kinetic to hostiles starting in it, recall', () => {
    const { a, e, b } = setup(['ms_hive_drone'])
    b.useCustom(a, custom(b, a, /Deploy Hive Drone/), { x: 3, y: 7 })
    const hive = drones(b, a, 'Hive Drone')[0]
    expect(hive).toBeDefined()
    const hp = e.hp
    passTurn(b, a, e)
    expect(e.hp).toBe(hp - 1)
    expect(b.cover(e, hive)).toBe('soft')
    b.endTurn(e); b.beginTurn(a)
    b.useCustom(a, custom(b, a, /Recall Hive/))
    expect(drones(b, a, 'Hive Drone')).toHaveLength(0)
  })
})

describe('ICEOUT Drone', () => {
  it('characters in its field are immune to tech', () => {
    const { a, e, b } = setup(['ms_iceout_drone'])
    b.useCustom(a, custom(b, a, /Deploy ICEOUT/), { x: 3, y: 4 })
    expect(b.techTargetValid(e, a)).toMatch(/ICEOUT/)
  })
})

describe('Interdiction Field', () => {
  it('toggles and slows its user', () => {
    const { a, b } = setup(['ms_interdiction_field'])
    b.useCustom(a, custom(b, a, /Interdiction Field/))
    expect(b.has(a, 'slowed')).toBe(true)
  })
})

describe('Lotus Projector', () => {
  it('hostiles in the field cannot Hide', () => {
    const { a, e, b } = setup(['ms_lotus_projector'])
    e.pos = { x: 6, y: 6 }
    b.useCustom(a, custom(b, a, /Deploy Lotus/), { x: 6, y: 7 })
    b.addStatus(e, 'invisible')
    expect(b.canHide(e)).toBe(false)
  })
})

describe('Perimeter Command Plate', () => {
  it('Attract: characters moving onto it save or are Immobilized; it is flat', () => {
    const { a, e, b } = setup(['ms_perimeter_command_plate'])
    b.useCustom(a, custom(b, a, /Attract/), { x: 3, y: 7 })
    e.stats.hull = -20
    passTurn(b, a, e)
    b.move(e, { x: 3, y: 7 })
    expect(b.has(e, 'immobilized')).toBe(true)
    expect(e.pos).toEqual({ x: 3, y: 7 })
  })
})

describe('Portable Bunker', () => {
  it('hard cover for allies inside, once unfolded', () => {
    const { a, e, b } = setup(['ms_portable_bunker'])
    b.useCustom(a, custom(b, a, /Deploy Portable Bunker/), { x: 4, y: 2 })
    const bk = drones(b, a, 'Portable Bunker')[0]
    expect(bk.stats.size).toBe(4)
    a.pos = { x: 5, y: 3 }
    b.round++
    expect(b.cover(e, a)).toBe('hard')
  })
})

describe('Restock Drone', () => {
  it('primes at end of turn; an adjacent ally activates it to vent heat and reload', () => {
    const { a, e, b } = setup(['ms_restock_drone'])
    b.useCustom(a, custom(b, a, /Deploy Restock/), { x: 4, y: 3 })
    expect(() => custom(b, a, /Activate Restock/)).toThrow()
    passTurn(b, a, e); b.endTurn(e); b.beginTurn(a)
    a.heat = 6
    b.useCustom(a, custom(b, a, /Activate Restock/))
    expect(a.heat).toBeLessThan(6)
    expect(drones(b, a, 'Restock Drone')).toHaveLength(0)
  })
})

describe('Sentinel Drone', () => {
  it('hostiles in its field take 3 kinetic before attacking', () => {
    const { a, e, b } = setup(['ms_sentinel_drone'])
    b.useCustom(a, custom(b, a, /Deploy Sentinel/), { x: 3, y: 8 })
    passTurn(b, a, e)
    const hp = e.hp
    b.skirmish(e, e.weapons.find(w => w.dataId === 'mw_assault_rifle')!, { targetId: a.id })
    expect(e.hp).toBeLessThan(hp)
  })
})

describe('Stasis Barrier', () => {
  it('a line of obstructions that gives soft cover', () => {
    const { a, e, b } = setup(['ms_stasis_barrier'])
    b.useCustom(a, custom(b, a, /Stasis Barrier/), { x: 3, y: 4 })
    expect(drones(b, a, 'Stasis Barrier').length).toBeGreaterThanOrEqual(3)
    expect(b.cover(e, a)).not.toBe('none')
  })
})

describe('Tempest Drone', () => {
  it('characters starting adjacent save or take 4 energy and are knocked back', () => {
    const { a, e, b } = setup(['ms_tempest_drone'])
    e.stats.hull = -20
    b.useCustom(a, custom(b, a, /Deploy Tempest/), { x: 3, y: 8 })
    const hp = e.hp
    passTurn(b, a, e)
    expect(e.hp).toBeLessThan(hp)
    expect(e.pos.y).toBeGreaterThan(9)
  })
})

describe('Turret Drones', () => {
  // regression: the Turret Attack rolled to hit instead of dealing 3 kinetic automatically
  it('the Turret Attack deals 3 kinetic automatically (no attack roll)', () => {
    const { a, e, b } = vs(mech({ callsign: 'T', systems: ['ms_turret_drones'] }))
    b.useCustom(a, custom(b, a, /Deploy Turret/), { x: 5, y: 5 })
    e.stats.evasion = 40; e.stats.armor = 0
    const hp = e.hp
    getScript('ms_turret_drones')!.afterAnyAttack!(b, a, b.newAttackCtx(a, e, { hit: true, mode: 'skirmish' }))
    expect(hp - e.hp).toBe(3)
  })
})

describe('fields and AI', () => {
  it('fields are reported as overlays with labels', () => {
    const { a, b } = setup(['ms_hive_drone', 'ms_interdiction_field'])
    b.useCustom(a, custom(b, a, /Deploy Hive Drone/), { x: 3, y: 6 })
    b.useCustom(a, custom(b, a, /Interdiction Field/))
    b.areas.push({ id: 'smoke', kind: 'soft_cover', tiles: [{ x: 1, y: 1 }] })
    const f = b.fieldOverlays()
    expect(f.find(x => /hive swarm/.test(x.label))?.tiles.length).toBeGreaterThan(9)
    expect(f.find(x => /interdiction/.test(x.label))?.effect).toBe('control')
    expect(f.find(x => /Soft cover/.test(x.label))?.effect).toBe('protect')
  })
  it('AI battles with every drone/deployable system without errors', () => {
    const sets = [
      ['ms_hive_drone', 'ms_sentinel_drone', 'ms_restock_drone'],
      ['ms_tempest_drone', 'ms_assassin_drone', 'ms_autoloader_drone', 'ms_iceout_drone'],
      ['ms_lotus_projector', 'ms_perimeter_command_plate', 'ms_aegis_shield_generator', 'ms_portable_bunker'],
      ['ms_oasis_wall', 'ms_stasis_barrier', 'ms_interdiction_field'],
    ]
    const players = sets.map((s, i) => { const u = mech({ level: 6, systems: s, callsign: `P${i}`, frame: i === 3 ? 'mf_hydra' : undefined, talents: [['t_drone_commander', 3]] }); u.pos = { x: 2 + i * 3, y: 1 }; return u })
    const enemies = sets.map((s, i) => { const u = mech({ level: 6, systems: s, callsign: `E${i}` }, 'enemy'); u.pos = { x: 2 + i * 3, y: 18 }; return u })
    const b = battle([...players, ...enemies], flatMap(16, 20), 11)
    autoBattle(b, 10)
    expect(aiErrors).toEqual([])
    expect(b.units.filter(u => u.kind === 'drone' || u.kind === 'deployable').length).toBe(14) // seeded: exactly what this battle deploys (re-pinned after audit 2)
  })
})
