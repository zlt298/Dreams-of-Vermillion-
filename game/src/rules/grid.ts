// Square grid with elevation. Distances are 3D Chebyshev ("spaces"), diagonals count 1.
import type { Pos, Unit } from './types'

export type TileKind = 'ground' | 'block' | 'forest' | 'rubble' | 'water' | 'hazard'
/** `skin` only changes how a tile looks (e.g. 'mars': regolith breaking through a cleanroom floor). */
export interface Tile { h: number; kind: TileKind; skin?: 'mars'; indestructible?: boolean; owner?: string }

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

export function hasLineOfSight(map: GridMap, from: Unit, to: Unit, fromPos: Pos = from.pos): boolean {
  const fa = new Set(footprint(from, fromPos).map(key))
  const fb = new Set(footprint(to).map(key))
  const ca = center(from, fromPos)
  const ea = elevationAt(map, from, fromPos) + (from.flying ? 1 : 0)
  const eyes = { x: ca.x, y: ca.y, z: ea + unitHeight(from) * 0.9 }
  const cb = center(to)
  const eb = unitElevation(map, to)
  // a target is visible if any of a few points on its body can be seen
  const targets = [eb + unitHeight(to) * 0.95, eb + unitHeight(to) * 0.5]
  // terrain no taller than both characters' tops is cover, not a full block: their tops show over it
  // (a size-1 mech behind size-1 hard cover can still be targeted). Symmetric in the two units.
  const lowTop = Math.min(ea + unitHeight(from), eb + unitHeight(to)) + 0.01
  for (const tz of targets) {
    const pts = samplesBetween(eyes, { x: cb.x, y: cb.y, z: tz })
    let blocked = false
    for (const s of pts) {
      const tp = { x: Math.floor(s.x), y: Math.floor(s.y) }
      const k = key(tp)
      if (fa.has(k) || fb.has(k)) continue
      const t = tileAt(map, tp)
      if (!t) continue
      if (t.h > s.z + 0.01 && t.h > lowTop) { blocked = true; break }
    }
    if (!blocked) return true
  }
  return false
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

/**
 * Cover from attacker's point of view.
 * Hard cover: a terrain block adjacent to the target, on the attacker's side, at least half the
 * target's height above the target's base (negated if the attacker is 2+ above the block top).
 * Soft cover: target stands in, or the line passes through, obscuring terrain (forest, smoke).
 */
export function coverBetween(map: GridMap, attacker: Unit, target: Unit, areas: AreaEffect[] = [], attackerPos: Pos = attacker.pos): Cover {
  const ca = center(attacker, attackerPos)
  const ct = center(target)
  const dir = { x: ca.x - ct.x, y: ca.y - ct.y }
  const len = Math.hypot(dir.x, dir.y) || 1
  dir.x /= len; dir.y /= len
  const eT = unitElevation(map, target)
  const eA = elevationAt(map, attacker, attackerPos) + (attacker.flying ? 1 : 0)
  const tfp = footprint(target)
  const tSet = new Set(tfp.map(key))
  const afp = new Set(footprint(attacker, attackerPos).map(key))
  // hard cover must be adjacent and at least as large as the target (core rules)
  const need = Math.max(1, Math.ceil(target.stats.size))
  let hard = false
  const seen = new Set<string>()
  for (const p of tfp) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const q = { x: p.x + dx, y: p.y + dy }
    const k = key(q)
    if (tSet.has(k) || afp.has(k) || seen.has(k)) continue
    seen.add(k)
    const t = tileAt(map, q)
    if (!t) continue
    const vx = q.x + 0.5 - ct.x, vy = q.y + 0.5 - ct.y
    const vl = Math.hypot(vx, vy) || 1
    const dot = (vx / vl) * dir.x + (vy / vl) * dir.y
    if (dot < 0.5) continue
    if (t.h - eT >= need && !(eA >= t.h + 2)) hard = true
  }
  if (hard) return 'hard'
  const obscured = (p: Pos) => tileAt(map, p)?.kind === 'forest' || areas.some(a => a.kind === 'soft_cover' && a.tiles.some(t => t.x === p.x && t.y === p.y))
  if (tfp.some(obscured)) return 'soft'
  const pts = samplesBetween({ x: ca.x, y: ca.y, z: 0 }, { x: ct.x, y: ct.y, z: 0 })
  for (const s of pts) {
    const tp = { x: Math.floor(s.x), y: Math.floor(s.y) }
    const k = key(tp)
    if (afp.has(k) || tSet.has(k)) continue
    if (obscured(tp)) return 'soft'
    // non-adjacent hard obstruction partially blocking the line: soft cover
    const t = tileAt(map, tp)
    if (t && t.h - eT >= 1 && !(eA >= t.h + 2)) return 'soft'
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

export function coneTiles(map: GridMap, u: Unit, toward: Pos, len: number): Pos[] {
  const c = center(u)
  const dx = toward.x + 0.5 - c.x, dy = toward.y + 0.5 - c.y
  const l = Math.hypot(dx, dy) || 1
  const fp = footprint(u)
  const fps = new Set(fp.map(key))
  const out: Pos[] = []
  const halfAngle = Math.atan(0.5) + 0.05
  for (let y = 0; y < map.h; y++) for (let x = 0; x < map.w; x++) {
    const p = { x, y }
    if (fps.has(key(p))) continue
    let d = Infinity
    for (const q of fp) d = Math.min(d, chebyshev(p, q))
    if (d > len) continue
    const vx = x + 0.5 - c.x, vy = y + 0.5 - c.y
    const vl = Math.hypot(vx, vy) || 1
    const ang = Math.acos(Math.max(-1, Math.min(1, (vx * dx + vy * dy) / (vl * l))))
    if (ang <= halfAngle || d <= 1 && ang <= Math.PI / 4 + 0.01) out.push(p)
  }
  return out
}

export function unitsOnTiles(units: Unit[], tiles: Pos[]): Unit[] {
  const s = new Set(tiles.map(key))
  return units.filter(u => !u.destroyed && footprint(u).some(p => s.has(key(p))))
}
