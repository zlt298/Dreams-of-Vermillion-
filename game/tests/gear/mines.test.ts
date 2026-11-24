// Mines (core book MINE tag, with the friendly-safe house rule), then the charge systems and the deployable
// objects built on them (alphabetical).
import { describe, expect, it } from 'vitest'
import { autoBattle, aiErrors } from '../../src/ai/ai'
import type { Battle } from '../../src/rules/battle'
import type { Unit } from '../../src/rules/types'
import { battle, flatMap, mech, pregenUnit } from '../support'
import { custom, toEnemyTurn, vs, weapon } from './helpers'

/** Level-6 Everest with these systems vs an Assault at (5,9) that fails Hull/Agility/Systems saves. */
const setup = (systems: string[], map = flatMap(16, 16)) => vs(mech({ level: 6, systems }), { e: { x: 5, y: 9 }, map, enemy: { hull: -20, agi: -20, sys: -20 } })
/** As setup(), with the enemy at (5,8) and failing Engineering too. */
const setupCharges = (systems: string[]) => vs(mech({ level: 6, systems }), { enemy: { hull: -20, agi: -20, sys: -20, eng: -20 } })
const ally = (b: Battle) => { const u = mech({ level: 6, callsign: 'Ally' }); u.pos = { x: 8, y: 5 }; b.units.push(u); return u }
const plain = (b: Battle, owner: Unit, x: number, y: number, extra: object = {}) =>
  b.placeMine(owner, { x, y }, { name: 'Test Mine', radius: 1, damage: [{ type: 'Explosive', val: 5 }], ...extra })
const rifle = (u: Unit) => weapon(u, 'mw_assault_rifle')

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
    const al = ally(b)
    plain(b, a, 5, 5, { armed: true })
    b.endTurn(a); b.currentSide = 'player'; b.beginTurn(al)
    b.move(al, { x: 6, y: 6 })
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

describe('BB Breach/Blast Charges', () => {
  it('thermal grenade and a remote breaching charge', () => {
    const { a, e, b } = setupCharges(['ms_bb_breach_blast_charges'])
    const hp = e.hp
    b.useCustom(a, custom(b, a, /Thermal Grenade/), { x: 5, y: 8 })
    expect(e.hp).toBeLessThan(hp)
    b.useCustom(a, custom(b, a, /Plant Breaching/), { x: 5, y: 5 })
    expect(custom(b, a, /Detonate Breaching/)).toBeDefined()
  })
  it('Breaching and Grounding mines go off only when detonated', () => {
    const { a, e, b } = setup(['ms_bb_breach_blast_charges', 'ms_grounding_charges'])
    b.useCustom(a, custom(b, a, /Plant Breaching/), { x: 5, y: 5 })
    b.useCustom(a, custom(b, a, /Plant Grounding/), { x: 4, y: 3 })
    toEnemyTurn(b, a, e)
    b.move(e, { x: 5, y: 6 })
    expect(b.mines).toHaveLength(2)
    b.endTurn(e); while (b.round < 2) { const u = b.combatants(b.currentSide).find(x => x.activationsLeft > 0); if (!u) break; b.beginTurn(u); b.endTurn(u) }
    if (b.currentSide !== 'player') { b.beginTurn(e); b.endTurn(e) }
    b.beginTurn(a)
    b.useCustom(a, custom(b, a, /Detonate Grounding/), e)
    expect(b.has(e, 'prone')).toBe(true)
  })
})

describe('Flash Charges', () => {
  it("Flash Grenade: characters inside can't draw line of sight out (the thrower is exempt)", () => {
    const { a, e, b } = setupCharges(['ms_flash_charges'])
    b.useCustom(a, custom(b, a, /Flash Grenade/), { x: 5, y: 8 })
    toEnemyTurn(b, a, e)
    expect(b.los(e, a)).toBe(false)
    const r = b.weaponAttack(e, rifle(e), { targetId: a.id }, 'free')
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/line of sight/i)
    expect(b.los(a, e)).toBe(true)
  })
  it('Flash Mine blinds a character that approaches it', () => {
    const { a, e, b } = setupCharges(['ms_flash_charges'])
    b.useCustom(a, custom(b, a, /Flash Mine/), { x: 5, y: 5 })
    toEnemyTurn(b, a, e)
    b.move(e, { x: 5, y: 6 })
    expect(b.isBlinded(e)).toBe(true)
    expect(b.validTarget(e, rifle(e), a)).toMatch(/Blinded/)
  })
})

describe('H0R_OS System Upgrade III', () => {
  it('Dimensional Emblems are objects: passing through deals 2 heat; Systems check destroys one', () => {
    const { a, e, b } = setup(['ms_h0r_os_system_upgrade_iii'])
    a.stats.techAttack = 30
    b.useCustom(a, custom(b, a, /Dimensional Emblems/), e)
    const ems = b.alive().filter(u => u.flags.emblem)
    expect(ems).toHaveLength(3) // three emblems next to the target
    toEnemyTurn(b, a, e)
    expect(b.customActions(e).filter(c => /Destroy Dimensional Emblem/.test(c.name))).toHaveLength(3) // one per adjacent emblem
    const h = e.heat
    b.move(e, ems[0].pos)
    expect(e.heat).toBe(h + 2)
  })
})

describe('HAVOK Charges', () => {
  it('fires a Line 5 toward whoever set it off', () => {
    const { a, e, b } = setup(['ms_havok_charges'])
    b.useCustom(a, custom(b, a, /HAVOK/), { x: 5, y: 5 })
    expect(b.mines[0].line).toBe(5)
    toEnemyTurn(b, a, e)
    b.move(e, { x: 5, y: 6 })
    expect(e.burn).toBe(4) // 4 burn, Agility save failed
  })
})

describe('Mesmer Charges', () => {
  it('Mesmer Beacon: the target can only move toward you', () => {
    const { a, e, b } = setupCharges(['ms_mesmer_charges'])
    e.pos = { x: 5, y: 8 }
    b.useCustom(a, custom(b, a, /Mesmer Beacon/), e)
    toEnemyTurn(b, a, e)
    expect(() => b.move(e, { x: 5, y: 10 })).toThrow(/Mesmerized/)
    b.move(e, { x: 5, y: 6 })
  })
})

describe('Pattern-A Smoke Charges', () => {
  it('Smoke Mine: an ally coming next to it raises Burst 3 soft cover', () => {
    const { a, b } = setup(['ms_pattern_a_smoke_charges'])
    const al = ally(b)
    b.useCustom(a, custom(b, a, /Smoke Mine/), { x: 5, y: 5 })
    b.endTurn(a); b.currentSide = 'player'; b.beginTurn(al)
    b.move(al, { x: 6, y: 6 })
    expect(b.areas.some(x => x.kind === 'soft_cover' && x.expiresAfterTurnOf === al.id)).toBe(true)
  })
})

describe('Roller Directed-Payload Charges', () => {
  it('Bouncing Mine only reacts to flyers', () => {
    const { a, e, b } = setup(['ms_roller_directed_payload_charges'])
    b.useCustom(a, custom(b, a, /Bouncing Mine/), { x: 5, y: 5 })
    toEnemyTurn(b, a, e)
    b.move(e, { x: 5, y: 6 })
    expect(b.mines).toHaveLength(1)
    e.pos = { x: 5, y: 9 }
    e.flying = true
    e.moveLeft = 10
    b.move(e, { x: 5, y: 6 }) // flight follows a straight line (core p.63)
    expect(b.mines).toHaveLength(0)
  })
  it('Roller Grenade detonates on the first character along its line', () => {
    const { a, e, b } = setupCharges(['ms_roller_directed_payload_charges'])
    const hp = e.hp
    b.useCustom(a, custom(b, a, /Roller Grenade/), { x: 5, y: 10 })
    expect(e.hp).toBeLessThan(hp)
  })
})

describe('Webjaw Snare', () => {
  it('untargetable until sprung; the hold lasts until it is destroyed', () => {
    const { a, e, b } = setup(['ms_webjaw_snare'])
    b.useCustom(a, custom(b, a, /Webjaw/), { x: 5, y: 5 })
    const snare = b.alive().find(u => u.flags.webjaw)!
    expect(snare.flags.intangible).toBe(true)
    toEnemyTurn(b, a, e)
    b.move(e, { x: 5, y: 5 })
    expect(snare.flags.intangible).toBe(false)
    expect(b.has(e, 'immobilized')).toBe(true)
    b.applyDamage(snare, [{ type: 'Kinetic', amount: 20 }], { source: e })
    expect(b.has(e, 'immobilized')).toBe(false)
  })
})

describe('AI with mines', () => {
  it('AI battles with mine users on both sides run cleanly', () => {
    const p1 = mech({ level: 6, systems: ['ms_pattern_b_hex_charges', 'ms_havok_charges'] })
    const p2 = mech({ level: 6, systems: ['ms_flash_charges', 'ms_mesmer_charges'] })
    const e1 = mech({ level: 6, systems: ['ms_pattern_b_hex_charges', 'ms_webjaw_snare'] }, 'enemy'), e2 = pregenUnit('Sniper', 'enemy')
    p1.pos = { x: 3, y: 2 }; p2.pos = { x: 7, y: 2 }; e1.pos = { x: 3, y: 12 }; e2.pos = { x: 7, y: 13 }
    const b = battle([p1, p2, e1, e2], flatMap(14, 16), 9)
    autoBattle(b, 8)
    expect(aiErrors).toHaveLength(0)
  })
})
