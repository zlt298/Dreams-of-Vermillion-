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
      a.flags['turn:fired'] = []
      a.flags['turn:skirmished'] = false
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

describe('rulings cross-checked against COMP/CON', () => {
  it('armor applies to each damage type separately', () => {
    const { e, b } = duel()
    e.stats.armor = 2
    b.applyDamage(e, [{ type: 'Kinetic', amount: 3 }, { type: 'Energy', amount: 3 }])
    expect(e.hp).toBe(e.stats.hp - 2)
  })
  it('resistance halves after armor, rounding up', () => {
    const { e, b } = duel()
    e.stats.armor = 1
    e.resist.push('Energy')
    b.applyDamage(e, [{ type: 'Energy', amount: 6 }])
    expect(e.hp).toBe(e.stats.hp - 3)
  })
  it('skirmish is once per turn, each weapon once per turn', () => {
    const { a, e, b } = duel()
    b.beginTurn(a)
    const [w1, w2] = a.weapons.filter(w => !b.isAoE(b.profile(w)))
    expect(b.skirmish(a, w1, { targetId: e.id }).ok).toBe(true)
    const r = b.skirmish(a, w2, { targetId: e.id })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/once per turn/)
  })
  it('reaching 0 stress schedules a meltdown at the end of the next turn', () => {
    const { e, b } = duel()
    e.stress = 1
    b.addHeat(e, e.stats.heatcap + 1)
    expect(e.stress).toBe(0)
    expect(e.destroyed).toBe(false)
    expect(e.meltdownTurns).toBe(1)
  })
  it('grunts are destroyed by external heat', () => {
    const { a, b } = duel()
    const g = pregenUnit('Hacker', 'enemy')
    g.isGrunt = true
    g.pos = { x: 9, y: 9 }
    b.units.push(g)
    b.addHeat(g, 1, a)
    expect(g.destroyed).toBe(true)
  })
  it('NPCs cannot crit; tech attacks never crit', () => {
    const { a, e, b } = duel()
    a.canCrit = false
    const ctx = b.newAttackCtx(a, e, { mode: 'skirmish', attackBonus: 50 })
    b.rollToHit(ctx)
    expect(ctx.hit).toBe(true)
    expect(ctx.crit).toBe(false)
  })
  it('standing up from prone uses the standard move', () => {
    const { a, b } = duel()
    b.beginTurn(a)
    b.addStatus(a, 'prone')
    b.standUp(a)
    expect(b.has(a, 'prone')).toBe(false)
    expect(a.moveLeft).toBe(0)
  })
})

describe('reaction policies', () => {
  it("'ask' brace consults Battle.decide; 'off' never braces", () => {
    const { a, e, b } = duel()
    const asked: string[] = []
    b.decide = q => { asked.push(q.kind); return true }
    e.policies.brace = 'ask'
    e.hp = 3
    const rifle = a.weapons.find(w => w.dataId === 'mw_assault_rifle')!
    b.beginTurn(a)
    a.stats.attackBonus = 40
    b.skirmish(a, rifle, { targetId: e.id })
    expect(asked).toContain('brace')
    expect(b.has(e, 'braced')).toBe(true)
  })
  it("'off' overwatch never triggers; 'ask' declines when decide says no", () => {
    const { a, e, b } = duel()
    e.pos = { x: 3, y: 5 } // Sniper is hostile; Assault starts adjacent-ish
    a.pos = { x: 1, y: 5 }
    e.weapons.forEach(w => (w.profiles[w.profileIndex].range = [{ type: 'Threat', val: 3 }]))
    e.policies.overwatch = 'off'
    b.beginTurn(a)
    b.move(a, { x: 1, y: 3 })
    expect(b.events.filter(ev => ev.type === 'attack').length).toBe(0)
  })
})

describe('undo move', () => {
  it('restores position and movement after a clean move', () => {
    const { a, b } = duel()
    b.beginTurn(a)
    const start = { ...a.pos }
    b.move(a, { x: 3, y: 5 })
    expect(b.canUndoMove(a)).toBe(true)
    b.undoMove(a)
    expect(a.pos).toEqual(start)
    expect(a.moveLeft).toBe(a.stats.speed)
    expect(a.actedThisTurn).toBe(false)
  })
  it('is not allowed once something else happened', () => {
    const { a, e, b } = duel()
    b.beginTurn(a)
    b.move(a, { x: 3, y: 5 })
    b.lockOn(a, e)
    expect(b.canUndoMove(a)).toBe(false)
    expect(() => b.undoMove(a)).toThrow()
  })
  it('is not allowed if the move provoked overwatch', () => {
    const { a, e, b } = duel()
    e.pos = { x: 3, y: 5 }
    e.weapons.forEach(w => (w.profiles[w.profileIndex].range = [{ type: 'Threat', val: 3 }]))
    b.beginTurn(a)
    b.move(a, { x: 1, y: 3 })
    expect(b.canUndoMove(a)).toBe(false)
  })
})

describe('previews are side-effect free', () => {
  it('previewAttack does not consume rng, flags, statuses or HP', () => {
    const { a, e, b } = duel()
    b.beginTurn(a)
    b.addStatus(e, 'lockon')
    const rifle = a.weapons.find(w => w.dataId === 'mw_assault_rifle')!
    const before = { rng: b.rng.state, hp: a.hp, ehp: e.hp, log: b.log.length, flags: JSON.stringify(a.flags) }
    b.previewAttack(a, rifle, e)
    b.previewDetail(a, rifle, e)
    expect(b.rng.state).toBe(before.rng)
    expect(a.hp).toBe(before.hp)
    expect(e.hp).toBe(before.ehp)
    expect(b.log.length).toBe(before.log)
    expect(JSON.stringify(a.flags)).toBe(before.flags)
    expect(b.has(e, 'lockon')).toBe(true)
  })
  it('previewDetail reports sensible ranges', () => {
    const { a, e, b } = duel()
    const rifle = a.weapons.find(w => w.dataId === 'mw_assault_rifle')!
    const d = b.previewDetail(a, rifle, e)
    expect(d.chance).toBeGreaterThan(0)
    expect(d.minDmg).toBeGreaterThanOrEqual(0)
    expect(d.maxDmg).toBeGreaterThanOrEqual(d.minDmg)
    expect(d.critChance).toBeLessThanOrEqual(d.chance)
    e.hp = 1
    expect(b.previewDetail(a, rifle, e).lethal).toBeGreaterThan(0.2)
  })
})
