// Square grid with elevation. Distances are 3D Chebyshev ("spaces"), diagonals count 1.
import type { Pos, Unit } from './types'

export type TileKind = 'ground' | 'block' | 'forest' | 'rubble' | 'water' | 'hazard'
/** `skin` only changes how a tile looks (e.g. 'mars': regolith breaking through a cleanroom floor). */
export interface Tile { h: number; kind: TileKind; skin?: 'mars'; indestructible?: boolean; owner?: string; /** dangerous terrain's damage type (default Energy) */ hazardType?: 'Kinetic' | 'Energy' | 'Explosive' | 'Burn' }

export interface GridMap {
  w: number
  h: number
  tiles: Tile[]
  deployPlayer: Pos[]
  deployEnemy: Pos[]
  zones?: { name: string; tiles: Pos[] }[]
  /** visual theme (and layout style): act 1 outskirts, act 2 industrial park, act 3 cleanroom */
  theme?: MapTheme
}

export type MapTheme = 'outskirts' | 'industrial' | 'cleanroom'

/** Short-lived area effects (smoke clouds, fire...). */
export interface AreaEffect {
  id: string
  kind: 'soft_cover' | 'damage' | 'difficult' | 'zero_g'
  tiles: Pos[]
  expiresRound?: number
  expiresAfterTurnOf?: string
  /** with expiresAfterTurnOf: how many of that character's turn ends remain */
  turnsLeft?: number
  damage?: string
  ownerId?: string
  /** script marker (e.g. 'plasma') */
  tag?: string
}

export const key = (p: Pos) => `${p.x},${p.y}`

export function tileAt(map: GridMap, p: Pos): Tile | undefined {
  if (p.x < 0 || p.y < 0 || p.x >= map.w || p.y >= map.h) return undefined
  return map.tiles[p.y * map.w + p.x]
}

export function footprintSize(u: { stats: { size: number } }): number {
  return Math.max(1, Math.floor(u.stats.size))
}

export function footprint(u: { pos: Pos; stats: { size: number } }, at: Pos = u.pos): Pos[] {
  const s = footprintSize(u)
  const out: Pos[] = []
  for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) out.push({ x: at.x + dx, y: at.y + dy })
  return out
}

export function elevationAt(map: GridMap, u: { stats: { size: number } }, at: Pos): number {
  let e = 0
  const s = Math.max(1, Math.floor(u.stats.size))
  for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) {
    const t = tileAt(map, { x: at.x + dx, y: at.y + dy })
    if (t) e = Math.max(e, t.h)
  }
  return e
}

export function unitElevation(map: GridMap, u: Unit): number {
  return elevationAt(map, u, u.pos) + (u.flying ? 1 : 0)
}

export function unitHeight(u: { stats: { size: number } }): number {
  return Math.max(0.5, u.stats.size)
}

/** Distance in spaces between two footprints (2D Chebyshev, plus vertical difference). */
export function distanceBetween(map: GridMap, a: Unit, b: Unit): number {
  return distanceFootprints(footprint(a), footprint(b), unitElevation(map, a), unitElevation(map, b), unitHeight(a), unitHeight(b))
}

export function distanceFootprints(fa: Pos[], fb: Pos[], ea = 0, eb = 0, ha = 1, hb = 1): number {
  let best = Infinity
  for (const p of fa) for (const q of fb) best = Math.min(best, Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y)))
  // vertical gap between the two bodies
  const gap = ea > eb + hb ? ea - (eb + hb) : eb > ea + ha ? eb - (ea + ha) : 0
  return Math.max(best, Math.floor(gap))
}

export function distanceToTile(map: GridMap, a: Unit, p: Pos): number {
  let best = Infinity
  for (const q of footprint(a)) best = Math.min(best, Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y)))
  return best
}

export function chebyshev(a: Pos, b: Pos): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))
}

export function center(u: { pos: Pos; stats: { size: number } }, at: Pos = u.pos): { x: number; y: number } {
  const s = footprintSize(u)
  return { x: at.x + s / 2, y: at.y + s / 2 }
}

export function isBlocking(t: Tile | undefined): boolean {
  return !t || t.kind === 'water' && false
}

// ---------------- Line of sight & cover ----------------

function samplesBetween(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
  const dist = Math.hypot(b.x - a.x, b.y - a.y)
  const steps = Math.max(2, Math.ceil(dist * 4))
  const out: { x: number; y: number; z: number; t: number }[] = []
  for (let i = 1; i < steps; i++) {
    const t = i / steps
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t, t })
  }
  return out
}

/** Keys of the spaces adjacent to (touching, not inside) a footprint. */
export function ringAround(fp: Pos[]): Set<string> {
  const inside = new Set(fp.map(key))
  const out = new Set<string>()
  for (const p of fp) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const k = key({ x: p.x + dx, y: p.y + dy })
    if (!inside.has(k)) out.add(k)
  }
  return out
}

/**
 * Line of sight from `from` to any of a few points on `to`'s body. Terrain blocks a sight line when it rises above the
 * line and above both characters' tops, with two exceptions (core p. 66):
 *  - terrain adjacent to the target and no taller than the target is cover, not concealment: the target can still be
 *    attacked (hard cover), even when it is Size 2+ and the attacker is smaller;
 *  - terrain adjacent to the attacker and no taller than the attacker is cover it shoots over.
 */
export function hasLineOfSight(map: GridMap, from: Unit, to: Unit, fromPos: Pos = from.pos): boolean {
  const fpA = footprint(from, fromPos), fpB = footprint(to)
  const fa = new Set(fpA.map(key))
  const fb = new Set(fpB.map(key))
  const nearA = ringAround(fpA), nearB = ringAround(fpB)
  const ca = center(from, fromPos)
  const ea = elevationAt(map, from, fromPos) + (from.flying ? 1 : 0)
  const eyes = { x: ca.x, y: ca.y, z: ea + unitHeight(from) * 0.9 }
  const cb = center(to)
  const eb = unitElevation(map, to)
  // a target is visible if any of a few points on its body can be seen
  const targets = [eb + unitHeight(to) * 0.95, eb + unitHeight(to) * 0.5]
  const topA = ea + unitHeight(from), topB = eb + unitHeight(to)
  const lowTop = Math.min(topA, topB)
  for (const tz of targets) {
    const pts = samplesBetween(eyes, { x: cb.x, y: cb.y, z: tz })
    let blocked = false
    for (const s of pts) {
      const tp = { x: Math.floor(s.x), y: Math.floor(s.y) }
      const k = key(tp)
      if (fa.has(k) || fb.has(k)) continue
      const t = tileAt(map, tp)
      if (!t) continue
      let top = lowTop
      if (nearB.has(k)) top = Math.max(top, topB)
      if (nearA.has(k)) top = Math.max(top, topA)
      if (t.h > s.z + 0.01 && t.h > top + 0.01) { blocked = true; break }
    }
    if (!blocked) return true
  }
  return false
}

/** A stand-in for a point in space (a Blast's centre): one space, half a level tall. */
export function pointUnit(p: Pos): Unit {
  return { id: `point@${p.x},${p.y}`, pos: { ...p }, stats: { size: 0.5 }, flying: false } as unknown as Unit
}

/** Line of sight from a point in a space (a Blast's centre) to a character, as from a small character standing there. */
export function hasLineOfSightFromTile(map: GridMap, p: Pos, to: Unit): boolean {
  if (footprint(to).some(q => q.x === p.x && q.y === p.y)) return true
  return hasLineOfSight(map, pointUnit(p), to)
}

export function hasLineOfSightToTile(map: GridMap, from: Unit, p: Pos, fromPos: Pos = from.pos): boolean {
  const fa = new Set(footprint(from, fromPos).map(key))
  const ca = center(from, fromPos)
  const ea = elevationAt(map, from, fromPos) + (from.flying ? 1 : 0)
  const t0 = tileAt(map, p)
  if (!t0) return false
  const pts = samplesBetween({ x: ca.x, y: ca.y, z: ea + unitHeight(from) * 0.9 }, { x: p.x + 0.5, y: p.y + 0.5, z: t0.h + 0.5 })
  for (const s of pts) {
    const tp = { x: Math.floor(s.x), y: Math.floor(s.y) }
    if (fa.has(key(tp)) || (tp.x === p.x && tp.y === p.y)) continue
    const t = tileAt(map, tp)
    if (t && t.h > s.z + 0.01) return false
  }
  return true
}

export type Cover = 'none' | 'soft' | 'hard'

/** Does the segment between two space centres pass through any of `tiles`? Grazing a corner doesn't count. */
function segmentCrosses(a: Pos, b: Pos, tiles: Set<string>): boolean {
  const ax = a.x + 0.5, ay = a.y + 0.5, bx = b.x + 0.5, by = b.y + 0.5
  const steps = Math.max(2, Math.ceil(Math.hypot(bx - ax, by - ay) * 8))
  for (let i = 1; i < steps; i++) {
    const t = i / steps
    const x = ax + (bx - ax) * t, y = ay + (by - ay) * t
    const fx = x - Math.floor(x), fy = y - Math.floor(y)
    const onX = fx < 1e-6 || fx > 1 - 1e-6, onY = fy < 1e-6 || fy > 1 - 1e-6
    if (onX && onY) continue
    if (tiles.has(key({ x: Math.floor(x + 1e-7), y: Math.floor(y + 1e-7) }))) return true
  }
  return false
}

/**
 * Cover from attacker's point of view (core p. 66).
 * Hard cover: terrain adjacent to the target, at least the target's Size tall above its base (negated if the attacker
 * is 2+ above the block top). The target is flanked, and loses it, if a line totally clear of that cover can be drawn
 * from any space of the attacker to any space of the target.
 * Soft cover: the target stands in, or the line passes through, obscuring terrain (forest, smoke), or a non-adjacent
 * obstruction partially blocks the line. Cover adjacent to the attacker and no taller than it doesn't count: the
 * attacker shoots over its own cover.
 */
export function coverBetween(map: GridMap, attacker: Unit, target: Unit, areas: AreaEffect[] = [], attackerPos: Pos = attacker.pos): Cover {
  const ca = center(attacker, attackerPos)
  const ct = center(target)
  const eT = unitElevation(map, target)
  const eA = elevationAt(map, attacker, attackerPos) + (attacker.flying ? 1 : 0)
  const tfp = footprint(target)
  const tSet = new Set(tfp.map(key))
  const afpList = footprint(attacker, attackerPos)
  const afp = new Set(afpList.map(key))
  const nearA = ringAround(afpList)
  // hard cover must be adjacent and at least as large as the target
  const need = Math.max(1, Math.ceil(target.stats.size))
  const hardTiles = new Set<string>()
  for (const k of ringAround(tfp)) {
    if (afp.has(k)) continue
    const [x, y] = k.split(',').map(Number)
    const t = tileAt(map, { x, y })
    if (t && t.h - eT >= need && !(eA >= t.h + 2)) hardTiles.add(k)
  }
  // flanked: some line from an attacker space to a target space is clear of the hard cover
  if (hardTiles.size && !afpList.some(a => tfp.some(b => !segmentCrosses(a, b, hardTiles)))) return 'hard'
  const obscured = (p: Pos) => tileAt(map, p)?.kind === 'forest' || areas.some(a => a.kind === 'soft_cover' && a.tiles.some(t => t.x === p.x && t.y === p.y))
  if (tfp.some(obscured)) return 'soft'
  const pts = samplesBetween({ x: ca.x, y: ca.y, z: 0 }, { x: ct.x, y: ct.y, z: 0 })
  for (const s of pts) {
    const tp = { x: Math.floor(s.x), y: Math.floor(s.y) }
    const k = key(tp)
    if (afp.has(k) || tSet.has(k)) continue
    if (obscured(tp)) return 'soft'
    const t = tileAt(map, tp)
    if (!t) continue
    // the attacker shoots over its own adjacent cover when that cover is no taller than it is
    if (nearA.has(k) && t.h - eA <= Math.max(1, attacker.stats.size)) continue
    // a hard obstruction partially blocking the line (or flanked hard cover the line still crosses): soft cover
    if (t.h - eT >= 1 && !(eA >= t.h + 2)) return 'soft'
  }
  return 'none'
}

// ---------------- Areas ----------------
export function burstTiles(map: GridMap, u: Unit, r: number, at: Pos = u.pos): Pos[] {
  const fp = footprint(u, at)
  const out: Pos[] = []
  for (let y = 0; y < map.h; y++) for (let x = 0; x < map.w; x++) {
    let d = Infinity
    for (const p of fp) d = Math.min(d, chebyshev(p, { x, y }))
    if (d <= r) out.push({ x, y })
  }
  return out
}

export function blastTiles(map: GridMap, c: Pos, r: number): Pos[] {
  const out: Pos[] = []
  for (let y = c.y - r; y <= c.y + r; y++) for (let x = c.x - r; x <= c.x + r; x++) if (tileAt(map, { x, y })) out.push({ x, y })
  return out
}

export function lineTiles(map: GridMap, u: Unit, toward: Pos, len: number): Pos[] {
  const c = center(u)
  const dx = toward.x + 0.5 - c.x, dy = toward.y + 0.5 - c.y
  // one tile per step along the major axis (Bresenham): Line N covers exactly N spaces and reaches distance N on any bearing
  const m = Math.max(Math.abs(dx), Math.abs(dy))
  if (m === 0) return []
  const sx = dx / m, sy = dy / m
  const half = footprintSize(u) / 2
  const out: Pos[] = []
  for (let i = 1; i <= len; i++) {
    const t = half - 0.5 + i
    // a hair off exact tile edges so floor() doesn't flip on the minor axis
    const p = { x: Math.floor(c.x + sx * t + 1e-9 * Math.sign(sx)), y: Math.floor(c.y + sy * t + 1e-9 * Math.sign(sy)) }
    if (!tileAt(map, p)) break
    out.push(p)
  }
  return out
}

/**
 * Cone X (core p. 64): X spaces long, one space wide where it starts and X wide at its far end. Each ring of spaces
 * (by distance from the user) keeps the spaces within (ring - 1) / 2 of the aim line; the first ring keeps only the
 * space(s) closest to it.
 */
export function coneTiles(map: GridMap, u: Unit, toward: Pos, len: number): Pos[] {
  const c = center(u)
  let dx = toward.x + 0.5 - c.x, dy = toward.y + 0.5 - c.y
  const l = Math.hypot(dx, dy)
  if (!l) return []
  dx /= l; dy /= l
  const fp = footprint(u)
  const fps = new Set(fp.map(key))
  const s = footprintSize(u)
  const extra = s % 2 === 0 ? 0.5 : 0
  const cand: { p: Pos; d: number; perp: number }[] = []
  let first = Infinity
  const r = len + s
  for (let y = Math.max(0, Math.floor(c.y - r)); y <= Math.min(map.h - 1, Math.ceil(c.y + r)); y++) {
    for (let x = Math.max(0, Math.floor(c.x - r)); x <= Math.min(map.w - 1, Math.ceil(c.x + r)); x++) {
      const p = { x, y }
      if (fps.has(key(p))) continue
      let d = Infinity
      for (const q of fp) d = Math.min(d, chebyshev(p, q))
      if (d < 1 || d > len) continue
      const vx = x + 0.5 - c.x, vy = y + 0.5 - c.y
      if (vx * dx + vy * dy <= 0) continue
      const perp = Math.abs(vx * dy - vy * dx)
      if (d === 1) first = Math.min(first, perp)
      cand.push({ p, d, perp })
    }
  }
  return cand.filter(t => (t.d === 1 ? t.perp <= first + 0.01 : t.perp <= (t.d - 1) / 2 + extra + 0.01)).map(t => t.p)
}

export function unitsOnTiles(units: Unit[], tiles: Pos[]): Unit[] {
  const s = new Set(tiles.map(key))
  return units.filter(u => !u.destroyed && footprint(u).some(p => s.has(key(p))))
}
