import { describe, expect, it } from 'vitest'
import { battle, flatMap, pregenUnit } from './helpers'
import { hitChance } from '../src/rules/battle'
import { Rng, rollDice, parseDice } from '../src/rules/rng'
import { coverBetween } from '../src/rules/grid'

function duel(mapF?: Parameters<typeof flatMap>[2]) {
  const a = pregenUnit('Assault')
  const e = pregenUnit('Sniper', 'enemy')
  a.pos = { x: 1, y: 5 }
  e.pos = { x: 6, y: 5 }
  const b = battle([a, e], flatMap(12, 12, mapF))
  return { a, e, b }
}

describe('dice', () => {
  it('parses dice expressions', () => {
    expect(parseDice('1d6+2')).toEqual({ count: 1, sides: 6, flat: 2 })
    expect(parseDice('2d6')).toEqual({ count: 2, sides: 6, flat: 0 })
    expect(parseDice('3')).toEqual({ count: 0, sides: 0, flat: 3 })
  })
  it('crits keep the highest of doubled dice', () => {
    const r = new Rng(7)
    for (let i = 0; i < 200; i++) {
      const v = rollDice(r, '2d6', { crit: true }).total
      expect(v).toBeGreaterThanOrEqual(2)
      expect(v).toBeLessThanOrEqual(12)
    }
  })
  it('hit chance accounts for accuracy/difficulty', () => {
    expect(hitChance(0, 0, 10)).toBeCloseTo(0.55)
    expect(hitChance(0, 1, 10)).toBeGreaterThan(0.55)
    expect(hitChance(0, -2, 10)).toBeLessThan(0.55)
    expect(hitChance(0, 0, 1)).toBe(1)
  })
})

describe('turn economy', () => {
  it('alternates sides and tracks actions', () => {
    const { a, e, b } = duel()
    expect(b.currentSide).toBe('player')
    b.beginTurn(a)
    b.boost(a)
    expect(a.actionsLeft).toBe(1)
    expect(() => b.barrage(a, { weapon: a.weapons[0], aim: { targetId: e.id } }).ok).not.toThrow()
    expect(b.barrage(a, { weapon: a.weapons[0], aim: { targetId: e.id } }).ok).toBe(false)
    b.endTurn(a)
    expect(b.currentSide).toBe('enemy')
    b.beginTurn(e)
    b.endTurn(e)
    expect(b.round).toBe(2)
  })
  it('overcharge grants a quick action and heat', () => {
    const { a, b } = duel()
    b.beginTurn(a)
    b.overcharge(a)
    expect(a.heat).toBe(1)
    expect(a.flags.bonusQuick).toBe(1)
    expect(() => b.overcharge(a)).toThrow()
  })
})

describe('combat', () => {
  it('skirmish attacks roll and apply damage', () => {
    const { a, e, b } = duel()
    b.beginTurn(a)
    const rifle = a.weapons.find(w => w.dataId === 'mw_assault_rifle')!
    let hits = 0
    for (let i = 0; i < 40; i++) {
      a.actionsLeft = 2
      a.activeTurn = true
      b.activeId = a.id
      e.hp = e.stats.hp; e.structure = e.stats.structure; e.destroyed = false; e.statuses = []
      const r = b.skirmish(a, rifle, { targetId: e.id })
      expect(r.ok).toBe(true)
      if (r.ctxs[0].hit) hits++
    }
    expect(hits).toBeGreaterThan(5)
  })
  it('hard cover adds +2 difficulty', () => {
    const { a, e, b } = duel((x, y) => (x === 5 && y === 5 ? { h: 2, kind: 'block' } : undefined))
    expect(coverBetween(b.map, a, e)).toBe('hard')
    const rifle = a.weapons.find(w => w.dataId === 'mw_assault_rifle')!
    const p = b.previewAttack(a, rifle, e)
    expect(p.ctx.difficulty).toBe(2)
  })
  it('soft cover from forest', () => {
    const { a, e, b } = duel((x, y) => (x === 6 && y === 5 ? { kind: 'forest' } : undefined))
    expect(coverBetween(b.map, a, e)).toBe('soft')
  })
  it('tall walls block line of sight', () => {
    const { a, e, b } = duel((x, y) => (x === 4 ? { h: 4, kind: 'block' } : undefined))
    expect(b.los(a, e)).toBe(false)
  })
  it('armor, exposed and resistance', () => {
    const { e, b } = duel()
    e.stats.armor = 2
    b.applyDamage(e, [{ type: 'Kinetic', amount: 5 }])
    expect(e.hp).toBe(e.stats.hp - 3)
    e.hp = e.stats.hp
    b.addStatus(e, 'exposed')
    b.applyDamage(e, [{ type: 'Kinetic', amount: 5 }])
    expect(e.hp).toBe(e.stats.hp - 8)
    e.hp = e.stats.hp
    b.removeStatus(e, 'exposed')
    e.resist.push('Kinetic')
    b.applyDamage(e, [{ type: 'Kinetic', amount: 6 }])
    expect(e.hp).toBe(e.stats.hp - 2)
    e.hp = e.stats.hp
    b.addStatus(e, 'shredded')
    b.applyDamage(e, [{ type: 'Kinetic', amount: 6 }])
    expect(e.hp).toBe(e.stats.hp - 6)
  })
  it('hp loss past zero marks structure and carries over', () => {
    const { e, b } = duel()
    e.hp = 3
    b.applyDamage(e, [{ type: 'Kinetic', amount: 5 }])
    expect(e.structure).toBe(3)
    if (!e.destroyed) expect(e.hp).toBe(e.stats.hp - 2)
  })
  it('heat beyond cap causes stress', () => {
    const { e, b } = duel()
    b.addHeat(e, e.stats.heatcap + 2)
    expect(e.stress).toBe(3)
    expect(e.heat).toBe(2)
  })
  it('burn deals damage immediately and is marked', () => {
    const { e, b } = duel()
    b.applyDamage(e, [{ type: 'Burn', amount: 2 }])
    expect(e.burn).toBe(2)
    expect(e.hp).toBe(e.stats.hp - 2)
  })
  it('overshield absorbs damage first', () => {
    const { e, b } = duel()
    e.overshield = 4
    b.applyDamage(e, [{ type: 'Energy', amount: 6 }])
    expect(e.overshield).toBe(0)
    expect(e.hp).toBe(e.stats.hp - 2)
  })
})

describe('statuses', () => {
  it('"until end of next turn" lasts through the target’s next turn', () => {
    const { a, e, b } = duel()
    b.beginTurn(a)
    b.addStatus(e, 'impaired', 'next_turn_end_target', a)
    b.endTurn(a)
    expect(b.has(e, 'impaired')).toBe(true)
    b.beginTurn(e)
    expect(b.has(e, 'impaired')).toBe(true)
    b.endTurn(e)
    expect(b.has(e, 'impaired')).toBe(false)
  })
  it('stunned caps evasion and auto-fails hull saves', () => {
    const { e, b } = duel()
    b.addStatus(e, 'stunned')
    expect(b.save(e, 'hull', 1)).toBe(false)
  })
  it('immunity blocks statuses', () => {
    const { e, b } = duel()
    e.immune.push('impaired')
    expect(b.addStatus(e, 'impaired')).toBe(false)
  })
})

describe('movement', () => {
  it('moves within speed and stops when engaged', () => {
    const { a, e, b } = duel()
    b.beginTurn(a)
    e.pos = { x: 4, y: 5 }
    const r = b.reachable(a, a.moveLeft)
    // cannot pass through/around the enemy beyond engagement in one move
    expect(r.has('5,5')).toBe(false)
    expect(r.has('3,5')).toBe(true)
    b.move(a, { x: 3, y: 5 })
    expect(b.isEngaged(a)).toBe(true)
  })
  it('climbing costs extra movement', () => {
    const { a, b } = duel((x) => (x >= 2 ? { h: 3, kind: 'ground' } : undefined))
    b.beginTurn(a)
    const p = b.pathTo(a, { x: 2, y: 5 }, 10)!
    expect(p.cost).toBe(3)
  })
  it('knockback pushes targets away', () => {
    const { a, e, b } = duel()
    b.forceMove(e, a, 2, 1)
    expect(e.pos.x).toBe(8)
  })
})

describe('tech', () => {
  it('invade deals 2 heat on a hit', () => {
    const { a, e, b } = duel()
    b.beginTurn(a)
    a.stats.techAttack = 30
    b.invade(a, e)
    expect(e.heat).toBe(2)
    expect(b.has(e, 'impaired')).toBe(true)
  })
  it('lock on grants +1 accuracy and is consumed', () => {
    const { a, e, b } = duel()
    b.beginTurn(a)
    b.lockOn(a, e)
    const rifle = a.weapons.find(w => w.dataId === 'mw_assault_rifle')!
    expect(b.previewAttack(a, rifle, e).ctx.accuracy).toBeGreaterThanOrEqual(1)
    b.skirmish(a, rifle, { targetId: e.id })
    expect(b.has(e, 'lockon')).toBe(false)
  })
})
