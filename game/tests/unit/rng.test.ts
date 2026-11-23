// The seeded RNG and dice helpers underpin every roll in the game, so they get exact checks:
// determinism, inclusive bounds, distribution, and the LANCER dice rules (crits, accuracy, overkill).
import { describe, expect, it } from 'vitest'
import { Rng, parseDice, rollDice, averageDice, rollAccuracy } from '../../src/rules/rng'

describe('Rng', () => {
  it('is deterministic for a seed and serializable through its state', () => {
    const a = new Rng(1234), b = new Rng(1234)
    const xs = Array.from({ length: 50 }, () => a.next())
    expect(Array.from({ length: 50 }, () => b.next())).toEqual(xs)
    // resuming from a saved state continues the same sequence
    const c = new Rng(99)
    c.next(); c.next()
    const saved = c.state
    const tail = [c.next(), c.next(), c.next()]
    const d = new Rng(saved)
    expect([d.next(), d.next(), d.next()]).toEqual(tail)
  })

  it('different seeds give different sequences', () => {
    expect(new Rng(1).next()).not.toBe(new Rng(2).next())
  })

  it('next() stays in [0, 1)', () => {
    const r = new Rng(5)
    for (let i = 0; i < 10_000; i++) {
      const v = r.next()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('int() is inclusive at both ends and roughly uniform', () => {
    const r = new Rng(42)
    const counts = new Map<number, number>()
    const N = 60_000
    for (let i = 0; i < N; i++) {
      const v = r.int(1, 6)
      counts.set(v, (counts.get(v) ?? 0) + 1)
    }
    expect([...counts.keys()].sort()).toEqual([1, 2, 3, 4, 5, 6])
    for (const c of counts.values()) expect(Math.abs(c / N - 1 / 6)).toBeLessThan(0.01)
    expect(r.int(3, 3)).toBe(3)
  })

  it('d20 covers 1..20 and never leaves the range', () => {
    const r = new Rng(7)
    const seen = new Set<number>()
    for (let i = 0; i < 5000; i++) seen.add(r.d(20))
    expect([...seen].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
  })

  it('pick() can return every element; shuffle() is an in-place permutation', () => {
    const r = new Rng(3)
    const arr = ['a', 'b', 'c', 'd']
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) seen.add(r.pick(arr))
    expect(seen.size).toBe(4)
    const xs = Array.from({ length: 20 }, (_, i) => i)
    const out = r.shuffle(xs)
    expect(out).toBe(xs)
    expect([...out].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i))
    expect(out).not.toEqual(Array.from({ length: 20 }, (_, i) => i))
  })
})

describe('parseDice', () => {
  it.each([
    ['1d6+2', { count: 1, sides: 6, flat: 2 }],
    ['1d6-1', { count: 1, sides: 6, flat: -1 }],
    ['d6', { count: 1, sides: 6, flat: 0 }],
    ['2D6', { count: 2, sides: 6, flat: 0 }],
    [' 3d3 + 1 ', { count: 3, sides: 3, flat: 1 }],
    ['4', { count: 0, sides: 0, flat: 4 }],
    ['-1', { count: 0, sides: 0, flat: -1 }],
    [5, { count: 0, sides: 0, flat: 5 }],
  ] as const)('%j', (expr, want) => {
    expect(parseDice(expr as any)).toEqual(want)
  })

  it('non-numeric strings parse to zero rather than NaN', () => {
    expect(parseDice('hard')).toEqual({ count: 0, sides: 0, flat: 0 })
    expect(parseDice('')).toEqual({ count: 0, sides: 0, flat: 0 })
  })
})

describe('rollDice', () => {
  it('rolls within bounds and reports each die', () => {
    const r = new Rng(11)
    for (let i = 0; i < 500; i++) {
      const roll = rollDice(r, '2d6+3')
      expect(roll.dice).toHaveLength(2)
      expect(roll.flat).toBe(3)
      expect(roll.total).toBe(roll.dice[0] + roll.dice[1] + 3)
      expect(roll.total).toBeGreaterThanOrEqual(5)
      expect(roll.total).toBeLessThanOrEqual(15)
    }
  })

  it('flat damage is never rolled', () => {
    const r = new Rng(1)
    const before = r.state
    expect(rollDice(r, 4).total).toBe(4)
    expect(r.state).toBe(before)
  })

  it('a crit rolls double the dice and keeps the highest (mean of 2d6 goes from 7 to ~9.3)', () => {
    const r = new Rng(17)
    let normal = 0, crit = 0
    const N = 20_000
    for (let i = 0; i < N; i++) normal += rollDice(r, '2d6').total
    for (let i = 0; i < N; i++) {
      const c = rollDice(r, '2d6', { crit: true })
      expect(c.dice).toHaveLength(2) // kept dice only
      expect(c.dice[0]).toBeGreaterThanOrEqual(c.dice[1])
      crit += c.total
    }
    expect(normal / N).toBeCloseTo(7, 1)
    // E[top 2 of 4d6] = 9.34
    expect(crit / N).toBeGreaterThan(9.1)
    expect(crit / N).toBeLessThan(9.6)
  })

  it('a 1d6 crit is the max of 2d6 (mean ~4.47)', () => {
    const r = new Rng(23)
    let s = 0
    const N = 20_000
    for (let i = 0; i < N; i++) s += rollDice(r, '1d6', { crit: true }).total
    expect(s / N).toBeGreaterThan(4.35)
    expect(s / N).toBeLessThan(4.6)
  })

  it('Overkill rerolls 1s and counts 1 heat per reroll; no die ever shows a 1', () => {
    const r = new Rng(31)
    let heat = 0
    for (let i = 0; i < 2000; i++) {
      const roll = rollDice(r, '3d6', { overkill: true })
      expect(roll.dice.every(d => d >= 2)).toBe(true)
      heat += roll.overkillHeat
    }
    // each d6 shows a 1 with p=1/6, rerolls are geometric: E[1s per die] = 1/5
    expect(heat / (2000 * 3)).toBeCloseTo(0.2, 1)
  })

  it('without Overkill the heat count stays 0', () => {
    const r = new Rng(31)
    for (let i = 0; i < 200; i++) expect(rollDice(r, '3d6').overkillHeat).toBe(0)
  })
})

describe('averageDice', () => {
  it.each([['1d6', 3.5], ['2d6', 7], ['1d3+1', 3], ['1d6+2', 5.5], [3, 3], ['0', 0]] as const)('%s → %s', (e, v) => {
    expect(averageDice(e)).toBe(v)
  })
})

describe('rollAccuracy', () => {
  it('net 0 rolls nothing', () => {
    const r = new Rng(1)
    const s = r.state
    expect(rollAccuracy(r, 0)).toEqual({ bonus: 0, dice: [] })
    expect(r.state).toBe(s)
  })
  it('rolls |net| d6 and keeps the highest, signed', () => {
    const r = new Rng(9)
    for (let i = 0; i < 300; i++) {
      const acc = rollAccuracy(r, 3)
      expect(acc.dice).toHaveLength(3)
      expect(acc.bonus).toBe(Math.max(...acc.dice))
      const diff = rollAccuracy(r, -2)
      expect(diff.dice).toHaveLength(2)
      expect(diff.bonus).toBe(-Math.max(...diff.dice))
    }
  })
})
