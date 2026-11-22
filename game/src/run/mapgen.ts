// Seeded procedural battlefield generator: rolling elevation, buildings, cover walls,
// forests (soft cover), rubble (difficult), the odd hazard, and two deployment zones.
import type { GridMap, Tile, TileKind } from '../rules/grid'
import { Rng } from '../rules/rng'
import type { Pos } from '../rules/types'

export const MAP_W = 18
export const MAP_H = 36

export type Biome = 'colony' | 'wastes' | 'forest' | 'industrial'

export interface MapOptions { w?: number; h?: number; biome?: Biome; density?: number }

export function generateMap(seed: number, opts: MapOptions = {}): GridMap {
  const rng = new Rng(seed)
  // 18 wide × 36 long: the two deployment zones are ~30 spaces apart, leaving room to manoeuvre
  const w = opts.w ?? MAP_W, h = opts.h ?? MAP_H
  const biome = opts.biome ?? rng.pick(['colony', 'wastes', 'forest', 'industrial'] as const)
  // feature counts were tuned for 18×18; scale them with area so density stays the same
  const density = (opts.density ?? 1) * ((w * h) / 324)
  const tiles: Tile[] = Array.from({ length: w * h }, () => ({ h: 0, kind: 'ground' as TileKind }))
  const at = (x: number, y: number) => tiles[y * w + x]
  const inb = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h

  // --- rolling elevation: a few smoothed hills / plateaus
  const hills = Math.round((2 + rng.int(0, 2)) * ((w * h) / 324))
  for (let i = 0; i < hills; i++) {
    const cx = rng.int(2, w - 3), cy = rng.int(4, h - 5), r = rng.int(2, 4), ht = rng.int(1, 2)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const d = Math.max(Math.abs(x - cx), Math.abs(y - cy))
      if (d <= r) at(x, y).h = Math.max(at(x, y).h, d <= r - 1 ? ht : Math.min(ht, 1))
    }
  }

  const deployRowsP = [h - 1, h - 2, h - 3]
  const deployRowsE = [0, 1, 2]
  const reserved = (x: number, y: number) => deployRowsP.includes(y) || deployRowsE.includes(y)

  // --- buildings (tall blocks)
  const nBuild = Math.round((biome === 'colony' || biome === 'industrial' ? 5 : 2) * density)
  for (let i = 0; i < nBuild; i++) {
    const bw = rng.int(2, 3), bh = rng.int(2, 3)
    const x0 = rng.int(1, w - bw - 1), y0 = rng.int(4, h - bh - 4)
    const ht = rng.int(2, biome === 'industrial' ? 4 : 3)
    for (let y = y0; y < y0 + bh; y++) for (let x = x0; x < x0 + bw; x++) if (!reserved(x, y)) { at(x, y).h += ht; at(x, y).kind = 'block' }
  }
  // --- low walls / barricades (hard cover for size 1)
  const nWalls = Math.round(7 * density)
  for (let i = 0; i < nWalls; i++) {
    const horiz = rng.next() < 0.5
    const len = rng.int(2, 4)
    let x = rng.int(1, w - 2), y = rng.int(3, h - 4)
    for (let k = 0; k < len; k++) {
      if (inb(x, y) && !reserved(x, y) && at(x, y).kind === 'ground') { at(x, y).h += 1; at(x, y).kind = 'block' }
      if (horiz) x++; else y++
    }
  }
  // --- forests / smoke stacks (soft cover)
  const nForest = Math.round((biome === 'forest' ? 6 : 3) * density)
  for (let i = 0; i < nForest; i++) {
    const cx = rng.int(1, w - 2), cy = rng.int(3, h - 4), r = rng.int(1, 2)
    for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++)
      if (inb(x, y) && at(x, y).kind === 'ground' && !reserved(x, y) && rng.next() < 0.75) at(x, y).kind = 'forest'
  }
  // --- rubble (difficult terrain)
  const nRubble = Math.round((biome === 'wastes' || biome === 'industrial' ? 5 : 2) * density)
  for (let i = 0; i < nRubble; i++) {
    const cx = rng.int(1, w - 2), cy = rng.int(3, h - 4)
    for (let k = 0; k < 4; k++) {
      const x = cx + rng.int(-1, 1), y = cy + rng.int(-1, 1)
      if (inb(x, y) && at(x, y).kind === 'ground' && !reserved(x, y)) at(x, y).kind = 'rubble'
    }
  }
  // --- hazards
  if (biome === 'industrial' || biome === 'wastes') {
    const n = Math.round(rng.int(1, 2) * ((w * h) / 324))
    for (let i = 0; i < n; i++) {
      const x = rng.int(2, w - 3), y = rng.int(5, h - 6)
      if (at(x, y).kind === 'ground') at(x, y).kind = 'hazard'
    }
  }

  // --- deployment zones: flatten
  for (const y of [...deployRowsP, ...deployRowsE]) for (let x = 0; x < w; x++) { at(x, y).h = Math.min(at(x, y).h, 1); at(x, y).kind = 'ground' }
  ensureConnected(tiles, w, h)

  const deployPlayer: Pos[] = []
  const deployEnemy: Pos[] = []
  const mid = Math.floor(w / 2)
  const order = [...Array(w).keys()].sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid))
  for (const row of [h - 2, h - 1, h - 3]) for (const x of order) if (x % 2 === 0) deployPlayer.push({ x, y: row })
  for (const row of [1, 0, 2]) for (const x of order) if (x % 2 === 1 || row !== 1) deployEnemy.push({ x, y: row })
  const zc = { x: mid - 1, y: Math.floor(h / 2) - 1 }
  const zone: Pos[] = []
  for (let y = zc.y; y < zc.y + 3; y++) for (let x = zc.x; x < zc.x + 3; x++) { zone.push({ x, y }); if (at(x, y).kind === 'block') { at(x, y).kind = 'ground'; at(x, y).h = Math.min(at(x, y).h, 1) } }
  const extract: Pos[] = []
  for (let y = 0; y < 2; y++) for (let x = w - 3; x < w; x++) extract.push({ x, y })
  return { w, h, tiles, deployPlayer, deployEnemy, zones: [{ name: 'control', tiles: zone }, { name: 'extraction', tiles: extract }] }
}

/** Make sure size-1 units can walk from the player zone to the enemy zone (climb ≤ 2 per step). */
function ensureConnected(tiles: Tile[], w: number, h: number) {
  const at = (x: number, y: number) => tiles[y * w + x]
  for (let attempt = 0; attempt < 20; attempt++) {
    const seen = new Set<number>()
    const q: [number, number][] = []
    for (let x = 0; x < w; x++) { q.push([x, h - 1]); seen.add((h - 1) * w + x) }
    while (q.length) {
      const [x, y] = q.pop()!
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const i = ny * w + nx
        if (seen.has(i) || at(nx, ny).h - at(x, y).h > 2) continue
        seen.add(i)
        q.push([nx, ny])
      }
    }
    let ok = false
    for (let x = 0; x < w; x++) if (seen.has(x)) ok = true
    if (ok) return
    // carve a corridor through the middle column
    const cx = Math.floor(w / 2) + attempt % 3 - 1
    for (let y = 0; y < h; y++) { const t = at(cx, y); if (t.kind === 'block') { t.kind = 'rubble'; t.h = Math.min(t.h, 1) } }
  }
}
