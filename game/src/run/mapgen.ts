// Seeded procedural battlefield generator: rolling elevation, buildings, cover walls,
// forests (soft cover), rubble (difficult), the odd hazard, and two deployment zones.
import type { GridMap, MapTheme, Tile, TileKind } from '../rules/grid'
import { Rng } from '../rules/rng'
import type { Pos } from '../rules/types'

export const MAP_W = 18
export const MAP_H = 36

export type Biome = 'colony' | 'wastes' | 'forest' | 'industrial'

export interface MapOptions { w?: number; h?: number; biome?: Biome; density?: number; theme?: MapTheme }

/** Campaign look per act: intercepted outside, the industrial park, then the cleanroom. */
export function themeForAct(act: number): MapTheme {
  return act >= 3 ? 'cleanroom' : act === 2 ? 'industrial' : 'outskirts'
}

export function generateMap(seed: number, opts: MapOptions = {}): GridMap {
  const rng = new Rng(seed)
  // 18 wide × 36 long: the two deployment zones are ~30 spaces apart, leaving room to manoeuvre
  const w = opts.w ?? MAP_W, h = opts.h ?? MAP_H
  const theme = opts.theme ?? 'outskirts'
  const biome = opts.biome ?? rng.pick(['colony', 'wastes', 'forest', 'industrial'] as const)
  // feature counts were tuned for 18×18; scale them with area so density stays the same
  const density = (opts.density ?? 1) * ((w * h) / 324)
  const tiles: Tile[] = Array.from({ length: w * h }, () => ({ h: 0, kind: 'ground' as TileKind }))
  const at = (x: number, y: number) => tiles[y * w + x]
  const inb = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h

  const deployRowsP = [h - 1, h - 2, h - 3]
  const deployRowsE = [0, 1, 2]
  const reserved = (x: number, y: number) => deployRowsP.includes(y) || deployRowsE.includes(y)

  if (theme === 'industrial') industrialPark(rng, tiles, w, h, density, reserved)
  else if (theme === 'cleanroom') cleanroom(rng, tiles, w, h, density, reserved)
  else {
    // --- rolling elevation: a few smoothed hills / plateaus
    const hills = Math.round((2 + rng.int(0, 2)) * ((w * h) / 324))
    for (let i = 0; i < hills; i++) {
      const cx = rng.int(2, w - 3), cy = rng.int(4, h - 5), r = rng.int(2, 4), ht = rng.int(1, 2)
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const d = Math.max(Math.abs(x - cx), Math.abs(y - cy))
        if (d <= r) at(x, y).h = Math.max(at(x, y).h, d <= r - 1 ? ht : Math.min(ht, 1))
      }
    }


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
  return { w, h, tiles, deployPlayer, deployEnemy, theme, zones: [{ name: 'control', tiles: zone }, { name: 'extraction', tiles: extract }] }
}

/** A tile a deploying unit may stand on: on the map and not a building, water or hazard. */
function deployable(map: GridMap, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= map.w || y >= map.h) return false
  const k = map.tiles[y * map.w + x].kind
  return k !== 'block' && k !== 'water' && k !== 'hazard'
}

/**
 * Footprint-aware deployment: gives each unit a position whose whole footprint (size × size,
 * extending +x/+y from `pos`) is on the map, passable and clear of units already placed.
 * Unit i prefers `deploy[i % deploy.length]`; when that doesn't fit it takes the nearest spot
 * that does, preferring spots whose footprint lies entirely inside the deployment rows.
 * `occupied` (optional) holds tiles already taken, e.g. by the other side.
 */
export function placeUnits(map: GridMap, units: { pos: Pos; stats: { size: number } }[], deploy: Pos[], occupied: Set<string> = new Set()): void {
  if (!deploy.length) return
  const rows = new Set(deploy.map(p => p.y))
  const taken = occupied
  units.forEach((u, i) => {
    const s = Math.max(1, Math.floor(u.stats.size))
    const pref = deploy[i % deploy.length]
    const fits = (x: number, y: number) => {
      for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++)
        if (!deployable(map, x + dx, y + dy) || taken.has(`${x + dx},${y + dy}`)) return false
      return true
    }
    const inRows = (y: number) => { for (let dy = 0; dy < s; dy++) if (!rows.has(y + dy)) return false; return true }
    let best: Pos | undefined
    let bestScore = Infinity
    if (fits(pref.x, pref.y) && inRows(pref.y)) best = pref
    else {
      for (let y = 0; y < map.h; y++) for (let x = 0; x < map.w; x++) {
        if (!fits(x, y)) continue
        const score = (inRows(y) ? 0 : 10000) + Math.max(Math.abs(x - pref.x), Math.abs(y - pref.y)) * 10 + Math.abs(x - pref.x)
        if (score < bestScore) { bestScore = score; best = { x, y } }
      }
    }
    u.pos = best ?? pref
    for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) taken.add(`${u.pos.x + dx},${u.pos.y + dy}`)
  })
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

type Reserved = (x: number, y: number) => boolean

/** Act 2: inside an industrial park. Warehouse rows along aisles, container stacks, pipe runs,
 *  steam vents (soft cover), scrap (difficult) and chemical spills (dangerous). Mostly flat floor. */
function industrialPark(rng: Rng, tiles: Tile[], w: number, h: number, density: number, reserved: Reserved) {
  const at = (x: number, y: number) => tiles[y * w + x]
  const inb = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h
  const free = (x: number, y: number) => inb(x, y) && !reserved(x, y) && at(x, y).kind === 'ground'
  // a raised loading dock or two
  for (let i = 0; i < Math.round(1 * density); i++) {
    const y0 = rng.int(5, h - 9), x0 = rng.next() < 0.5 ? 0 : w - 4
    for (let y = y0; y < y0 + 4; y++) for (let x = x0; x < x0 + 4; x++) if (inb(x, y) && !reserved(x, y)) at(x, y).h = 1
  }
  // warehouse rows: buildings either side of a central aisle, in bands down the map
  const aisle = Math.floor(w / 2) + rng.int(-1, 1)
  for (let y0 = 5; y0 < h - 8; y0 += rng.int(6, 8)) {
    for (const side of [-1, 1]) {
      if (rng.next() < 0.25) continue
      const bw = rng.int(3, 5), bh = rng.int(3, 4)
      const x0 = side < 0 ? rng.int(1, Math.max(1, aisle - bw - 2)) : rng.int(aisle + 2, Math.max(aisle + 2, w - bw - 1))
      const ht = rng.int(2, 4)
      for (let y = y0; y < y0 + bh; y++) for (let x = x0; x < x0 + bw; x++) if (inb(x, y) && !reserved(x, y)) { at(x, y).h += ht; at(x, y).kind = 'block' }
    }
  }
  // container stacks (1x2 / 2x1, one or two high)
  for (let i = 0; i < Math.round(8 * density); i++) {
    const x = rng.int(1, w - 3), y = rng.int(4, h - 5), horiz = rng.next() < 0.5, ht = rng.int(1, 2)
    for (let k = 0; k < 2; k++) { const xx = horiz ? x + k : x, yy = horiz ? y : y + k; if (free(xx, yy)) { at(xx, yy).h += ht; at(xx, yy).kind = 'block' } }
  }
  // pipe runs: long, low, straight barricades
  for (let i = 0; i < Math.round(4 * density); i++) {
    const horiz = rng.next() < 0.6, len = rng.int(4, 6)
    let x = rng.int(1, w - 2), y = rng.int(4, h - 5)
    for (let k = 0; k < len; k++) { if (free(x, y)) { at(x, y).h += 1; at(x, y).kind = 'block' } if (horiz) x++; else y++ }
  }
  // steam vents (soft cover), scrap piles (difficult), chemical spills (dangerous)
  for (let i = 0; i < Math.round(3 * density); i++) {
    const cx = rng.int(1, w - 2), cy = rng.int(4, h - 5)
    for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) if (free(x, y) && rng.next() < 0.6) at(x, y).kind = 'forest'
  }
  for (let i = 0; i < Math.round(4 * density); i++) {
    const cx = rng.int(1, w - 2), cy = rng.int(4, h - 5)
    for (let k = 0; k < 3; k++) { const x = cx + rng.int(-1, 1), y = cy + rng.int(-1, 1); if (free(x, y)) at(x, y).kind = 'rubble' }
  }
  for (let i = 0; i < Math.round(rng.int(2, 3) * density / 2 + 1); i++) {
    const x = rng.int(2, w - 3), y = rng.int(6, h - 7)
    if (free(x, y)) at(x, y).kind = 'hazard'
    if (free(x + 1, y) && rng.next() < 0.5) at(x + 1, y).kind = 'hazard'
  }
}

/** Act 3: a cleanroom of lab modules and frosted-glass partitions (soft cover), with Martian
 *  landscape breaking through: regolith patches with dunes, rock outcrops, dust and broken labs. */
function cleanroom(rng: Rng, tiles: Tile[], w: number, h: number, density: number, reserved: Reserved) {
  const at = (x: number, y: number) => tiles[y * w + x]
  const inb = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h
  const free = (x: number, y: number) => inb(x, y) && !reserved(x, y) && at(x, y).kind === 'ground'
  // lab modules on a regular grid with clean aisles
  for (let gy = 5; gy < h - 7; gy += 6) for (let gx = 1; gx < w - 3; gx += 6) {
    if (rng.next() < 0.3) continue
    const bw = rng.int(2, 3), bh = rng.int(2, 3), x0 = gx + rng.int(0, 1), y0 = gy + rng.int(0, 1)
    for (let y = y0; y < y0 + bh; y++) for (let x = x0; x < x0 + bw; x++) if (inb(x, y) && !reserved(x, y)) { at(x, y).h = 2; at(x, y).kind = 'block' }
  }
  // frosted-glass partitions (soft cover lines) and low equipment benches (hard cover)
  for (let i = 0; i < Math.round(5 * density); i++) {
    const horiz = rng.next() < 0.5, len = rng.int(3, 5)
    let x = rng.int(1, w - 2), y = rng.int(4, h - 5)
    for (let k = 0; k < len; k++) { if (free(x, y)) at(x, y).kind = 'forest'; if (horiz) x++; else y++ }
  }
  for (let i = 0; i < Math.round(4 * density); i++) {
    const x = rng.int(1, w - 3), y = rng.int(4, h - 5)
    for (let k = 0; k < 2; k++) if (free(x + k, y)) { at(x + k, y).h = 1; at(x + k, y).kind = 'block' }
  }
  // Martian incursions: regolith breaking through the floor
  const n = Math.max(2, Math.round(rng.int(3, 4) * density / 2))
  for (let i = 0; i < n; i++) {
    const cx = rng.int(1, w - 2), cy = rng.int(5, h - 6), r = rng.int(2, 4)
    for (let y = cy - r - 1; y <= cy + r + 1; y++) for (let x = cx - r - 1; x <= cx + r + 1; x++) {
      if (!inb(x, y) || reserved(x, y)) continue
      const d = Math.hypot(x - cx, y - cy) + rng.next() * 1.2 // ragged edge
      if (d > r + 0.6) continue
      const t = at(x, y)
      t.skin = 'mars'
      if (t.kind === 'block') { // a lab module torn open
        if (rng.next() < 0.6) { t.kind = 'rubble'; t.h = Math.min(t.h, 1) }
        continue
      }
      if (d < r - 1 && rng.next() < 0.5) t.h = Math.max(t.h, 1) // dunes
      const roll = rng.next()
      if (roll < 0.12 && d < r - 0.5) { t.kind = 'block'; t.h += rng.int(1, 2) } // rock outcrop
      else if (roll < 0.32) t.kind = 'rubble' // loose rock
      else if (roll < 0.46) t.kind = 'forest' // red dust haze
      else t.kind = 'ground'
    }
    // a breach at the heart of the larger incursions
    if (r >= 3 && free(cx, cy)) at(cx, cy).kind = 'hazard'
  }
}
