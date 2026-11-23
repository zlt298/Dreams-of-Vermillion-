// Mines (core book MINE tag, with the friendly-safe house rule) and the deployable objects built on them.
import { describe, expect, it } from 'vitest'
import type { PilotBuild } from '../src/import/compcon'
import { buildMechUnit } from '../src/rules/stats'
import { Battle } from '../src/rules/battle'
import { autoBattle, aiErrors } from '../src/ai/ai'
import type { Unit } from '../src/rules/types'
import { flatMap, pregenUnit } from './helpers'

function mech(systems: string[], o: { side?: 'player' | 'enemy'; name?: string } = {}): Unit {
  const p = {
    id: `t-${Math.random()}`, callsign: o.name ?? 'Tester', name: 'T', level: 6, mechSkills: [2, 2, 2, 2], talents: [], coreBonuses: [],
    mech: { name: 'T', frameId: 'mf_standard_pattern_i_everest', mounts: [{ type: 'Main', slots: [{ size: 'Main', weaponId: 'mw_assault_rifle' }], bonusEffects: [] }], systems },
    unknown: [],
  } as unknown as PilotBuild
  return buildMechUnit(p, o.side ?? 'player')
}
function setup(systems: string[], map = flatMap(16, 16)) {
  const a = mech(systems)
  const e = pregenUnit('Assault', 'enemy')
  a.pos = { x: 5, y: 4 }
  e.pos = { x: 5, y: 9 }
  e.stats.hull = -20; e.stats.agi = -20; e.stats.sys = -20
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
const toEnemyTurn = (b: Battle, a: Unit, e: Unit) => { b.endTurn(a); b.beginTurn(e) }
const plain = (b: Battle, owner: Unit, x: number, y: number, extra: object = {}) =>
  b.placeMine(owner, { x, y }, { name: 'Test Mine', radius: 1, damage: [{ type: 'Explosive', val: 5 }], ...extra })

describe('mine rules', () => {
  it('planted in an adjacent free space, not next to another mine', () => {
    const { a, b } = setup([])
    expect(() => plain(b, a, 5, 7)).toThrow(/adjacent/)
    plain(b, a, 5, 5)
    expect(() => plain(b, a, 6, 5)).toThrow(/another mine/)
  })
  it('arms at the end of the owner\'s turn', () => {
    const { a, e, b } = setup([])
    const m = plain(b, a, 5, 5)
    expect(m.armed).toBe(false)
    toEnemyTurn(b, a, e)
    expect(m.armed).toBe(true)
  })
  it('triggers when a hostile enters an adjacent space and bursts from the mine', () => {
    const { a, e, b } = setup([])
    plain(b, a, 5, 5)
    toEnemyTurn(b, a, e)
    const hp = e.hp
    b.move(e, { x: 5, y: 7 })
    expect(b.mines).toHaveLength(1) // two spaces away: nothing
    b.move(e, { x: 5, y: 6 })
    expect(b.mines).toHaveLength(0)
    expect(e.hp).toBeLessThan(hp)
  })
  it('leaving an adjacent space does not trigger it', () => {
    const { a, e, b } = setup([])
    e.pos = { x: 6, y: 6 }
    const m = plain(b, a, 5, 5, { armed: true })
    b.endTurn(a); b.beginTurn(e)
    b.move(e, { x: 8, y: 8 })
    expect(b.mines).toContain(m)
  })
  it('house rule: the owner\'s allies never trigger it', () => {
    const { a, b } = setup([])
    const ally = mech([], { name: 'Ally' }); ally.pos = { x: 8, y: 5 }; b.units.push(ally)
    plain(b, a, 5, 5, { armed: true })
    b.endTurn(a); b.currentSide = 'player'; b.beginTurn(ally)
    b.move(ally, { x: 6, y: 6 })
    expect(b.mines).toHaveLength(1)
  })
  it('hidden from the other side until found; Search and Disarm', () => {
    const { a, e, b } = setup([])
    const m = plain(b, a, 5, 5, { armed: true })
    expect(b.mineVisibleTo(m, 'player')).toBe(true)
    expect(b.mineVisibleTo(m, 'enemy')).toBe(false)
    expect(b.fieldOverlays().some(f => /Test Mine/.test(f.label))).toBe(true)
    toEnemyTurn(b, a, e)
    e.stats.sys = 30
    expect(b.searchMines(e)).toBe(1)
    expect(b.mineVisibleTo(m, 'enemy')).toBe(true)
    e.pos = { x: 5, y: 6 } // placed next to it (no movement trigger)
    b.disarmMine(e, m)
    expect(b.mines).toHaveLength(0)
  })
  it('a failed disarm sets the mine off', () => {
    const { a, e, b } = setup([])
    const m = plain(b, a, 5, 5, { armed: true })
    m.detectedBy = ['enemy']
    toEnemyTurn(b, a, e)
    e.pos = { x: 5, y: 6 }
    e.stats.sys = -30
    const hp = e.hp
    b.disarmMine(e, m)
    expect(b.mines).toHaveLength(0)
    expect(e.hp).toBeLessThan(hp)
  })
  it('enemy mines show up for the player only once detected', () => {
    const { a, e, b } = setup([])
    b.endTurn(a); b.beginTurn(e)
    e.pos = { x: 9, y: 9 }
    const m = b.placeMine(e, { x: 9, y: 10 }, { name: 'Enemy Mine', radius: 1, damage: [] })
    expect(b.fieldOverlays().some(f => /Enemy Mine/.test(f.label))).toBe(false)
    m.detectedBy = ['player']
    expect(b.fieldOverlays().some(f => /Enemy Mine/.test(f.label))).toBe(true)
  })
})

describe('charges and objects', () => {
  it('Smoke Mine: an ally coming next to it raises Burst 3 soft cover', () => {
    const { a, b } = setup(['ms_pattern_a_smoke_charges'])
    const ally = mech([], { name: 'Ally' }); ally.pos = { x: 8, y: 5 }; b.units.push(ally)
    b.useCustom(a, act(b, a, /Smoke Mine/), { x: 5, y: 5 })
    b.endTurn(a); b.currentSide = 'player'; b.beginTurn(ally)
    b.move(ally, { x: 6, y: 6 })
    expect(b.areas.some(x => x.kind === 'soft_cover' && x.expiresAfterTurnOf === ally.id)).toBe(true)
  })
  it('Bouncing Mine only reacts to flyers', () => {
    const { a, e, b } = setup(['ms_roller_directed_payload_charges'])
    b.useCustom(a, act(b, a, /Bouncing Mine/), { x: 5, y: 5 })
    toEnemyTurn(b, a, e)
    b.move(e, { x: 5, y: 6 })
    expect(b.mines).toHaveLength(1)
    e.pos = { x: 5, y: 9 }
    e.flying = true
    e.moveLeft = 10
    b.move(e, { x: 6, y: 6 })
    expect(b.mines).toHaveLength(0)
  })
  it('Breaching and Grounding mines go off only when detonated', () => {
    const { a, e, b } = setup(['ms_bb_breach_blast_charges', 'ms_grounding_charges'])
    b.useCustom(a, act(b, a, /Plant Breaching/), { x: 5, y: 5 })
    b.useCustom(a, act(b, a, /Plant Grounding/), { x: 4, y: 3 })
    toEnemyTurn(b, a, e)
    b.move(e, { x: 5, y: 6 })
    expect(b.mines).toHaveLength(2)
    b.endTurn(e); while (b.round < 2) { const u = b.combatants(b.currentSide).find(x => x.activationsLeft > 0); if (!u) break; b.beginTurn(u); b.endTurn(u) }
    if (b.currentSide !== 'player') { b.beginTurn(e); b.endTurn(e) }
    b.beginTurn(a)
    b.useCustom(a, act(b, a, /Detonate Grounding/), e)
    expect(b.has(e, 'prone')).toBe(true)
  })
  it('HAVOK fires a Line 5 toward whoever set it off', () => {
    const { a, e, b } = setup(['ms_havok_charges'])
    b.useCustom(a, act(b, a, /HAVOK/), { x: 5, y: 5 })
    expect(b.mines[0].line).toBe(5)
    toEnemyTurn(b, a, e)
    b.move(e, { x: 5, y: 6 })
    expect(e.burn).toBeGreaterThan(0)
  })
  it('Webjaw Snare: untargetable until sprung; the hold lasts until it is destroyed', () => {
    const { a, e, b } = setup(['ms_webjaw_snare'])
    b.useCustom(a, act(b, a, /Webjaw/), { x: 5, y: 5 })
    const snare = b.alive().find(u => u.flags.webjaw)!
    expect(snare.flags.intangible).toBe(true)
    toEnemyTurn(b, a, e)
    b.move(e, { x: 5, y: 5 })
    expect(snare.flags.intangible).toBe(false)
    expect(b.has(e, 'immobilized')).toBe(true)
    b.applyDamage(snare, [{ type: 'Kinetic', amount: 20 }], { source: e })
    expect(b.has(e, 'immobilized')).toBe(false)
  })
  it('Dimensional Emblems are objects: passing through deals 2 heat; Systems check destroys one', () => {
    const { a, e, b } = setup(['ms_h0r_os_system_upgrade_iii'])
    a.stats.techAttack = 30
    b.useCustom(a, act(b, a, /Dimensional Emblems/), e)
    const ems = b.alive().filter(u => u.flags.emblem)
    expect(ems.length).toBeGreaterThan(0)
    toEnemyTurn(b, a, e)
    const destroy = b.customActions(e).find(c => /Destroy Dimensional Emblem/.test(c.name))
    expect(destroy).toBeTruthy()
    const h = e.heat
    b.move(e, ems[0].pos)
    expect(e.heat).toBe(h + 2)
  })
  it('AI battles with mine users on both sides run cleanly', () => {
    const p1 = mech(['ms_pattern_b_hex_charges', 'ms_havok_charges'])
    const p2 = mech(['ms_flash_charges', 'ms_mesmer_charges'])
    const e1 = mech(['ms_pattern_b_hex_charges', 'ms_webjaw_snare'], { side: 'enemy' }), e2 = pregenUnit('Sniper', 'enemy')
    p1.pos = { x: 3, y: 2 }; p2.pos = { x: 7, y: 2 }; e1.pos = { x: 3, y: 12 }; e2.pos = { x: 7, y: 13 }
    const b = new Battle({ map: flatMap(14, 16), units: [p1, p2, e1, e2], seed: 9 })
    b.start()
    aiErrors.length = 0
    autoBattle(b, 8)
    expect(aiErrors).toHaveLength(0)
  })
})
