// Seeded, serializable RNG (mulberry32) + Lancer dice helpers.
export class Rng {
  constructor(public state: number) {}
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) | 0)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1))
  }
  d(sides: number): number {
    return this.int(1, sides)
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)]
  }
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1))
      ;[arr[i], arr[j]] = [arr[j], arr[i]]
    }
    return arr
  }
}

export interface DiceExpr { count: number; sides: number; flat: number }

/** Parse "1d6+2", "2d6", "3", "1d3+1", "-1" */
export function parseDice(expr: string | number): DiceExpr {
  if (typeof expr === 'number') return { count: 0, sides: 0, flat: expr }
  const s = expr.replace(/\s+/g, '').toLowerCase()
  const m = s.match(/^(\d*)d(\d+)([+-]\d+)?$/)
  if (m) return { count: m[1] === '' ? 1 : parseInt(m[1]), sides: parseInt(m[2]), flat: m[3] ? parseInt(m[3]) : 0 }
  const n = parseInt(s)
  return { count: 0, sides: 0, flat: isNaN(n) ? 0 : n }
}

export interface DiceRoll { total: number; dice: number[]; flat: number }

export function rollDice(rng: Rng, expr: string | number, opts: { crit?: boolean; overkill?: boolean } = {}): DiceRoll & { overkillHeat: number } {
  const d = parseDice(expr)
  const dice: number[] = []
  let overkillHeat = 0
  const rollOne = (): number => {
    let v = rng.d(d.sides)
    if (opts.overkill) {
      while (v === 1) {
        overkillHeat++
        v = rng.d(d.sides)
      }
    }
    return v
  }
  if (opts.crit) {
    // Crit: all damage dice are rolled twice (2d6 -> 4d6) and the highest results are kept.
    const pool: number[] = []
    for (let i = 0; i < d.count * 2; i++) pool.push(rollOne())
    pool.sort((x, y) => y - x)
    dice.push(...pool.slice(0, d.count))
  } else {
    for (let i = 0; i < d.count; i++) dice.push(rollOne())
  }
  return { total: dice.reduce((x, y) => x + y, 0) + d.flat, dice, flat: d.flat, overkillHeat }
}

export function averageDice(expr: string | number): number {
  const d = parseDice(expr)
  return d.count * (d.sides + 1) / 2 + d.flat
}

/** Net accuracy (+) / difficulty (-): roll |n| d6, keep highest, add or subtract. */
export function rollAccuracy(rng: Rng, net: number): { bonus: number; dice: number[] } {
  if (net === 0) return { bonus: 0, dice: [] }
  const dice = Array.from({ length: Math.abs(net) }, () => rng.d(6))
  const hi = Math.max(...dice)
  return { bonus: net > 0 ? hi : -hi, dice }
}
