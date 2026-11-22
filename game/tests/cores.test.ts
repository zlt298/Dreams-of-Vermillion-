// CORE powers: Raleigh, Black Witch, Dusk Wing, Goblin, Pegasus, Barbarossa, Sherman.
import { describe, expect, it } from 'vitest'
import type { PilotBuild } from '../src/import/compcon'
import { buildMechUnit } from '../src/rules/stats'
import { Battle } from '../src/rules/battle'
import { autoBattle, aiErrors } from '../src/ai/ai'
import type { Unit } from '../src/rules/types'
import { flatMap, pregenUnit } from './helpers'

function mech(frame: string, side: 'player' | 'enemy' = 'player', name = 'Tester'): Unit {
  const p = {
    id: `t-${Math.random()}`, callsign: name, name, level: 6, mechSkills: [2, 2, 2, 2], talents: [], coreBonuses: [],
    mech: { name, frameId: frame, mounts: [{ type: 'Main', slots: [{ size: 'Main', weaponId: 'mw_assault_rifle' }], bonusEffects: [] }], systems: [] },
    unknown: [],
  } as unknown as PilotBuild
  return buildMechUnit(p, side)
}
function setup(frame: string) {
  const a = mech(frame)
  const e = pregenUnit('Assault', 'enemy')
  a.pos = { x: 3, y: 3 }
  e.pos = { x: 3, y: 8 }
  const b = new Battle({ map: flatMap(16, 16), units: [a, e], seed: 3 })
  b.start()
  b.beginTurn(a)
  a.coreAvailable = true
  return { a, e, b }
}
const act = (b: Battle, u: Unit, re: RegExp) => {
  const x = b.customActions(u).find(c => re.test(c.name) || re.test(c.key))
  if (!x) throw new Error(`no action ${re}: ${b.customActions(u).map(c => c.name).join(', ')}`)
  return x
}
const roundTrip = (b: Battle, a: Unit, e: Unit) => { b.endTurn(a); b.beginTurn(e); b.endTurn(e); b.beginTurn(a) }

describe('CORE powers', () => {
  it('Raleigh Thunder God: chambers 2 rounds per turn not fired; firing 4+ is AP and Shreds', () => {
    const { a, e, b } = setup('mf_raleigh')
    b.activateCore(a)
    roundTrip(b, a, e)
    roundTrip(b, a, e)
    expect(a.flags.chambers).toBe(4)
    const m35 = a.weapons.find(w => w.dataId === 'mw_raleigh_integrated')!
    e.pos = { x: 3, y: 5 }
    e.stats.evasion = -50
    e.stats.hp = 100; e.hp = 100
    b.weaponAttack(a, m35, { targetId: e.id }, 'free')
    expect(100 - e.hp).toBeGreaterThanOrEqual(10)
    expect(b.has(e, 'shredded')).toBe(true)
    expect(a.flags.chambers).toBe(0)
  })
  it('Black Witch Mag Field: stops kinetic shots crossing its edge, then they resume', () => {
    const { a, e, b } = setup('mf_black_witch')
    b.useCustom(a, act(b, a, /Mag Field/), { x: 3, y: 6 })
    expect(a.coreAvailable).toBe(false)
    const f = a.flags.magField
    expect(f.tiles.length).toBe(49)
    e.pos = { x: 3, y: 12 }
    const ally = pregenUnit('Sniper')
    ally.pos = { x: 4, y: 6 }
    ally.activationsLeft = 0
    b.units.push(ally)
    b.endTurn(a); b.beginTurn(e)
    const r = b.weaponAttack(e, e.weapons.find(w => w.dataId === 'mw_assault_rifle')!, { targetId: ally.id }, 'free')
    expect(r.ctxs[0].hit).toBe(false)
    expect(a.flags.magField.count).toBe(1)
    b.endTurn(e); b.beginTurn(a); b.endTurn(a)
    expect(a.flags.magField).toBeUndefined()
  })
  it('Dusk Wing Hall of Mirrors: moving leaves a hologram that detonates on hostiles', () => {
    const { a, e, b } = setup('mf_dusk_wing')
    b.activateCore(a)
    b.move(a, { x: 6, y: 3 })
    expect(a.flags.holos).toEqual([{ x: 3, y: 3 }])
    b.endTurn(a); b.beginTurn(e)
    e.stats.agi = -20
    const hp = e.hp
    b.move(e, { x: 3, y: 4 })
    expect(e.hp).toBeLessThan(hp)
    expect(a.flags.holos).toHaveLength(0)
  })
  it('Goblin Symbiosis: attaches to a larger ally, shares E-Defense, and detaches', () => {
    const { a, b } = setup('mf_goblin')
    const host = mech('mf_barbarossa', 'player', 'Host')
    host.pos = { x: 4, y: 3 }
    host.stats.edef = 6
    b.units.push(host)
    b.useCustom(a, act(b, a, /Symbiosis/), host)
    expect(a.pos).toEqual(host.pos)
    expect(host.stats.edef).toBe(Math.max(6, a.stats.edef))
    b.useCustom(a, act(b, a, /Detach/))
    expect(host.stats.edef).toBe(6)
    expect(a.pos).not.toEqual(host.pos)
  })
  it('Pegasus: the Ushabti Omnigun deals 1 unreducible damage 1/round (3/round after the CORE)', () => {
    const { a, e, b } = setup('mf_pegasus')
    e.stats.armor = 5
    const hp = e.hp
    b.useCustom(a, act(b, a, /Omnigun/), e)
    expect(e.hp).toBe(hp - 1)
    expect(act(b, a, /Omnigun/).usable(b, a)).not.toBe(true)
    roundTrip(b, a, e)
    b.activateCore(a)
    b.useCustom(a, act(b, a, /Omnigun/), e)
    expect(act(b, a, /Omnigun/).usable(b, a)).toBe(true)
  })
  it('Pegasus: average damage toggle', () => {
    const { a, b } = setup('mf_pegasus')
    b.useCustom(a, act(b, a, /average damage/))
    expect(a.flags.averageDamage).toBe(true)
  })
  it('Barbarossa Apocalypse Rail: the die counts down, the rail fires at 1-3 and resets', () => {
    const { a, e, b } = setup('mf_barbarossa')
    b.activateCore(a)
    expect(act(b, a, /Apocalypse Rail/).usable(b, a)).not.toBe(true)
    roundTrip(b, a, e)
    expect(a.flags.apocDie).toBe(3)
    e.pos = { x: 3, y: 12 }
    b.useCustom(a, act(b, a, /Apocalypse Rail/), e.pos)
    expect(a.flags.apocDie).toBe(4)
    expect(a.actionsLeft).toBe(0)
  })
  it('Sherman: Stabilize adds charges (the profile follows), COREBURN adds 3 and doubles Stabilize', () => {
    const { a, e, b } = setup('mf_sherman')
    const zf = a.weapons.find(w => w.dataId === 'mw_sherman_integrated')!
    expect(zf.profileIndex).toBe(0)
    b.stabilize(a, 'cool')
    expect(a.flags.zfCharges).toBe(2)
    expect(zf.profileIndex).toBe(1)
    roundTrip(b, a, e)
    a.coreAvailable = true
    b.activateCore(a)
    expect(a.flags.zfCharges).toBe(4)
  })
  it('AI battles with these frames without errors', () => {
    aiErrors.length = 0
    const frames = ['mf_raleigh', 'mf_black_witch', 'mf_dusk_wing', 'mf_goblin', 'mf_pegasus', 'mf_barbarossa', 'mf_sherman']
    const ps = frames.map((f, i) => { const u = mech(f, 'player', `P${i}`); u.pos = { x: 1 + i * 2, y: 1 }; u.coreAvailable = true; return u })
    const es = frames.map((f, i) => { const u = mech(f, 'enemy', `E${i}`); u.pos = { x: 1 + i * 2, y: 18 }; u.coreAvailable = true; return u })
    const b = new Battle({ map: flatMap(16, 20), units: [...ps, ...es], seed: 21 })
    b.start()
    autoBattle(b, 10)
    expect(aiErrors).toEqual([])
  })
})
