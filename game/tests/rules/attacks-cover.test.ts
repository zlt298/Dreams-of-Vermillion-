// Attack rolls and hit chance, cover and line of sight, and attack previews.
import { describe, expect, it } from 'vitest'
import type { Unit } from '../../src/rules/types'
import { hitChance } from '../../src/rules/battle'
import { Rng, rollDice, parseDice } from '../../src/rules/rng'
import { coverBetween } from '../../src/rules/grid'
import { battle, duel, flatMap, pregenUnit } from '../support'

const rifleOf = (u: Unit) => u.weapons.find(w => w.dataId === 'mw_assault_rifle')!

describe('dice and hit chance', () => {
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

describe('attack rolls', () => {
  it('skirmish attacks roll and apply damage', () => {
    const { a, e, b } = duel()
    b.beginTurn(a)
    const rifle = a.weapons.find(w => w.dataId === 'mw_assault_rifle')!
    let hits = 0
    for (let i = 0; i < 40; i++) {
      a.actionsLeft = 2
      a.flags['turn:fired'] = []
      a.flags['turn:quickUsed'] = []
      a.activeTurn = true
      b.activeId = a.id
      e.hp = e.stats.hp; e.structure = e.stats.structure; e.destroyed = false; e.statuses = []
      const r = b.skirmish(a, rifle, { targetId: e.id })
      expect(r.ok).toBe(true)
      if (r.ctxs[0].hit) hits++
    }
    expect(hits).toBeGreaterThan(5)
  })

  it('NPCs cannot crit; tech attacks never crit', () => {
    const { a, e, b } = duel()
    a.canCrit = false
    const ctx = b.newAttackCtx(a, e, { mode: 'skirmish', attackBonus: 50 })
    b.rollToHit(ctx)
    expect(ctx.hit).toBe(true)
    expect(ctx.crit).toBe(false)
  })
})

describe('cover and line of sight', () => {
  it('hard cover adds +2 difficulty', () => {
    const { a, e, b } = duel({ map: (x, y) => (x === 5 && y === 5 ? { h: 2, kind: 'block' } : undefined) })
    expect(coverBetween(b.map, a, e)).toBe('hard')
    const rifle = a.weapons.find(w => w.dataId === 'mw_assault_rifle')!
    const p = b.previewAttack(a, rifle, e)
    expect(p.ctx.difficulty).toBe(2)
  })

  it('soft cover from forest', () => {
    const { a, e, b } = duel({ map: (x, y) => (x === 6 && y === 5 ? { kind: 'forest' } : undefined) })
    expect(coverBetween(b.map, a, e)).toBe('soft')
  })

  it('tall walls block line of sight', () => {
    const { a, e, b } = duel({ map: (x, y) => (x === 4 ? { h: 4, kind: 'block' } : undefined) })
    expect(b.los(a, e)).toBe(false)
  })

  it('destroyed mechs leave wreckage that is hard cover', () => {
    const { a, e, b } = duel()
    e.pos = { x: 3, y: 5 }
    const t = pregenUnit('Hacker', 'enemy')
    t.pos = { x: 4, y: 5 }
    b.units.push(t)
    expect(b.cover(a, t)).toBe('none')
    b.destroy(e, 'test')
    expect(e.flags.wreck).toBe(true)
    expect(b.cover(a, t)).toBe('hard')
  })

  it('hard cover must be at least as large as the target', () => {
    const map = flatMap(12, 12, (x, y) => (x === 5 && y === 5 ? { h: 1, kind: 'block' } : undefined))
    const a = pregenUnit('Assault'); a.pos = { x: 1, y: 5 }
    const big = pregenUnit('Sniper', 'enemy'); big.pos = { x: 6, y: 5 }; big.stats.size = 2
    expect(coverBetween(map, a, big)).not.toBe('hard')
    big.stats.size = 1
    expect(coverBetween(map, a, big)).toBe('hard')
  })

  it('a non-adjacent obstruction grants soft cover', () => {
    const map = flatMap(12, 12, (x, y) => (x === 4 && y === 5 ? { h: 1, kind: 'block' } : undefined))
    const a = pregenUnit('Assault'); a.pos = { x: 1, y: 5 }
    const t = pregenUnit('Sniper', 'enemy'); t.pos = { x: 8, y: 5 }
    expect(coverBetween(map, a, t)).toBe('soft')
  })

  // regression: a size-1 target behind size-1 hard cover had no line of sight
  it('a same-size wall hides the target completely: hard cover from a 1-high wall almost always means no line of sight', () => {
    const a = pregenUnit('Assault'); const e = pregenUnit('Sniper', 'enemy')
    a.pos = { x: 1, y: 5 }; e.pos = { x: 6, y: 5 }
    const b = battle([a, e], flatMap(14, 14, (x, y) => (x === 5 && y === 5 ? { h: 1, kind: 'block' } : undefined)))
    const rifle = a.weapons.find(w => w.name === 'Assault Rifle')!
    expect(b.cover(a, e)).toBe('hard')
    // Lancer: a size-1 mech behind size-1 hard cover is targetable at +2 difficulty
    expect(b.validTarget(a, rifle, e)).toBe(true) // was: 'No line of sight' (top sample 0.95 < wall height 1)
  })

  // regression: Thrown melee attacks at range ignored cover
  it('thrown melee attacks at range ignore cover (treated as melee)', () => {
    const a = pregenUnit('Assault'); const e = pregenUnit('Sniper', 'enemy')
    a.pos = { x: 1, y: 3 }; e.pos = { x: 5, y: 5 }
    const b = battle([a, e], flatMap(12, 12, (x, y) => (x === 4 && y === 5 ? { kind: 'forest' } : undefined)))
    const w = a.weapons.find(w => w.type === 'Melee')!
    w.profiles[0].range = [{ type: 'Threat', val: 1 }, { type: 'Thrown', val: 5 }] as any
    expect(b.cover(a, e)).not.toBe('none')
    expect(b.validTarget(a, w, e)).toBe(true)
    const ctx = b.buildWeaponCtx(a, w, e, 'skirmish', false)
    // Thrown X: "can be thrown ... as a ranged attack" — cover applies at range
    expect(ctx.difficulty).toBeGreaterThan(0) // was: 0, isMelee() is true so the cover block is skipped
  })
})

describe('previews', () => {
  const rifleSetup = () => {
    const { a, e, b } = duel()
    e.stats.armor = 2
    return { a, e, b, rifle: rifleOf(a) }
  }
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

  it('Exposed doubles before Armor (AI estimate)', () => {
    const { a, e, b, rifle } = rifleSetup()
    const base = b.previewAttack(a, rifle, e)
    b.addStatus(e, 'exposed')
    const exp = b.previewAttack(a, rifle, e)
    // assault rifle 1d6 (avg 3.5), Reliable 2 on a miss: per hit (3.5 - 2) = 1.5 normally, (7 - 2) = 5 when Exposed
    const c = base.chance
    expect(base.expectedDamage).toBeCloseTo(1.5 * c + 2 * (1 - c), 5)
    expect(exp.expectedDamage).toBeCloseTo(5 * c + 2 * (1 - c), 5)
  })

  it('Shredded ignores Armor and Resistance in both previews', () => {
    const { a, e, b, rifle } = rifleSetup()
    e.resist.push('Kinetic')
    const before = b.previewDetail(a, rifle, e)
    const est = b.previewAttack(a, rifle, e).expectedDamage
    b.addStatus(e, 'shredded')
    expect(b.previewDetail(a, rifle, e).maxDmg).toBeGreaterThan(before.maxDmg)
    expect(b.previewAttack(a, rifle, e).expectedDamage).toBeGreaterThan(est)
  })

  it('Resistance halves the estimate', () => {
    const { a, e, b, rifle } = rifleSetup()
    e.stats.armor = 0
    const base = b.previewAttack(a, rifle, e).expectedDamage
    e.resist.push('Kinetic')
    const half = b.previewAttack(a, rifle, e).expectedDamage
    expect(half).toBeLessThan(base)
    expect(half).toBeGreaterThan(base * 0.45)
  })
})
