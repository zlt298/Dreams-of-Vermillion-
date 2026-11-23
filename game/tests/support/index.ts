// Shared test toolkit: one way to build pilots, mechs, battles and rigged dice, used by every test file.
// (tests/helpers.ts re-exports this for older imports.)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GridMap, Tile } from '../../src/rules/grid'
import { Battle } from '../../src/rules/battle'
import { importPilots, type PilotBuild, type MountBuild } from '../../src/import/compcon'
import { buildMechUnit } from '../../src/rules/stats'
import { placeUnits } from '../../src/run/mapgen'
import pregens from '../../src/data/pregens/pregens.json'
import type { Pos, Unit } from '../../src/rules/types'
import '../../src/rules/effects/scripts'

export type Side = 'player' | 'enemy'

// ------------------------------------------------------------------------------------------------ maps

export function flatMap(w = 12, h = 12, f?: (x: number, y: number) => Partial<Tile> | undefined): GridMap {
  const tiles: Tile[] = []
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) tiles.push({ h: 0, kind: 'ground', ...(f?.(x, y) ?? {}) })
  return { w, h, tiles, deployPlayer: [], deployEnemy: [] }
}

// ------------------------------------------------------------------------------------------------ pilots and mechs

export const EVEREST = 'mf_standard_pattern_i_everest'

let pilotSeq = 0
/** Deterministic pilot ids (tests used to use Math.random()). Reset per test by tests/support/setup.ts. */
export function resetPilotIds() { pilotSeq = 0 }

export interface PilotOpts {
  /** frame id (default: Everest) */
  frame?: string
  /** License Level (default 9) */
  level?: number
  /** HASE (default [2, 2, 2, 2]) */
  mechSkills?: [number, number, number, number]
  systems?: string[]
  /** `[id, rank]` tuples or `{ id, rank }` objects */
  talents?: ([string, number] | { id: string; rank: number })[]
  coreBonuses?: string[]
  /**
   * Weapons: a single weapon id (one Main mount), a list of `[mountType, weaponId]` (one mount each), or full
   * MountBuild objects. Default: one Main mount with an Assault Rifle.
   */
  weapons?: string | [string, string][] | MountBuild[]
  /** extra mount appended after `weapons` (e.g. an Auxiliary in a Flex mount) */
  aux?: string
  callsign?: string
}

function mountsOf(o: PilotOpts): MountBuild[] {
  const w = o.weapons ?? 'mw_assault_rifle'
  const mounts: MountBuild[] = typeof w === 'string'
    ? [{ type: 'Main', slots: [{ size: 'Main', weaponId: w }], bonusEffects: [] }]
    : (w as any[]).map(x => (Array.isArray(x) ? { type: x[0], slots: [{ size: x[0], weaponId: x[1] }], bonusEffects: [] } : x))
  if (o.aux) mounts.push({ type: 'Flex', slots: [{ size: 'Auxiliary', weaponId: o.aux }], bonusEffects: [] })
  return mounts
}

/** A PilotBuild for tests: the defaults make a level-9 Everest with an Assault Rifle. */
export function pilot(o: PilotOpts = {}): PilotBuild {
  const n = ++pilotSeq
  return {
    id: `test-pilot-${n}`,
    callsign: o.callsign ?? 'Tester',
    name: 'T',
    level: o.level ?? 9,
    mechSkills: o.mechSkills ?? [2, 2, 2, 2],
    talents: (o.talents ?? []).map(t => (Array.isArray(t) ? { id: t[0], rank: t[1] } : t)),
    coreBonuses: o.coreBonuses ?? [],
    mech: { name: 'T', frameId: o.frame ?? EVEREST, mounts: mountsOf(o), systems: o.systems ?? [] },
    unknown: [],
  } as PilotBuild
}

/** A battle-ready mech unit from `pilot(opts)`. */
export function mech(o: PilotOpts = {}, side: Side = 'player'): Unit {
  return buildMechUnit(pilot(o), side)
}

/** One of the four COMP/CON pregens (LL0 Everests): 'Vanguard' | 'Assault' | 'Sniper' | 'Hacker' | 'Fire Support'. */
export function pregenUnit(name: string, side: Side = 'player'): Unit {
  const p = importPilots((pregens as any[]).find(p => p.name === name))[0]
  return buildMechUnit(p, side)
}

// ------------------------------------------------------------------------------------------------ battles

/** A started battle with these units (positions already set by the caller). */
export function battle(units: Unit[], map = flatMap(), seed = 1) {
  const b = new Battle({ map, units, seed })
  b.start()
  return b
}

/** Place each unit, then start a battle: `arena([[a, {x:1,y:5}], [e, {x:6,y:5}]])`. */
export function arena(placed: [Unit, Pos][], opts: { map?: GridMap; seed?: number } = {}) {
  for (const [u, p] of placed) u.pos = { ...p }
  return battle(placed.map(([u]) => u), opts.map ?? flatMap(), opts.seed ?? 1)
}

/** The classic two-mech scenario: pregen Assault (player) vs pregen Sniper (enemy), 5 spaces apart on a 12×12 map. */
export function duel(opts: { map?: GridMap | ((x: number, y: number) => Partial<Tile> | undefined); a?: Pos; e?: Pos; seed?: number; size?: number } = {}) {
  const a = pregenUnit('Assault')
  const e = pregenUnit('Sniper', 'enemy')
  const map = typeof opts.map === 'function' ? flatMap(opts.size ?? 12, opts.size ?? 12, opts.map) : opts.map ?? flatMap(opts.size ?? 12, opts.size ?? 12)
  const b = arena([[a, opts.a ?? { x: 1, y: 5 }], [e, opts.e ?? { x: 6, y: 5 }]], { map, seed: opts.seed })
  return { a, e, b }
}

/** Put a squad and an enemy team on a generated map's deployment zones (as the app does). */
export function deploy(map: GridMap, squad: Unit[], enemies: Unit[]) {
  placeUnits(map, squad, map.deployPlayer)
  const taken = new Set<string>()
  for (const u of squad) for (let dy = 0; dy < Math.max(1, Math.floor(u.stats.size)); dy++) for (let dx = 0; dx < Math.max(1, Math.floor(u.stats.size)); dx++) taken.add(`${u.pos.x + dx},${u.pos.y + dy}`)
  placeUnits(map, enemies, map.deployEnemy, taken)
}

/** An enemy team from data/enemies/<id>.json. */
export function teamFile(id: string) {
  return JSON.parse(readFileSync(join(__dirname, `../../../data/enemies/${id}.json`), 'utf8'))
}

/** Make a unit the active one on its side's turn (begins its turn if needed). */
export function act(b: Battle, u: Unit) {
  if (b.activeId === u.id) return
  b.currentSide = u.side
  if (u.activationsLeft <= 0) u.activationsLeft = 1
  b.beginTurn(u)
}

// ------------------------------------------------------------------------------------------------ dice

const rigged = new Set<{ b: Battle; queue: Record<number, number[]> }>()

/**
 * Make the next d(sides) rolls in this battle return `values` (then real rolls resume). Hooks Rng.int, which every
 * die goes through. tests/support/setup.ts fails the test if any rigged value was never rolled, so a rig can't
 * silently miss its target roll.
 */
export function rigDice(b: Battle, sides: number, ...values: number[]) {
  const rng = b.rng as any
  let entry = [...rigged].find(r => r.b === b)
  if (!entry) {
    entry = { b, queue: {} }
    rigged.add(entry)
    const real = rng.int.bind(rng)
    const q = entry.queue
    rng.int = (min: number, max: number) => (min === 1 && q[max]?.length ? q[max].shift()! : real(min, max))
  }
  ;(entry.queue[sides] ??= []).push(...values)
}

/** Called after each test: rigged dice that were never rolled mean the test didn't exercise what it meant to. */
export function checkRiggedDiceUsed() {
  const left: string[] = []
  for (const r of rigged) for (const [s, v] of Object.entries(r.queue)) if (v.length) left.push(`d${s}: [${v.join(', ')}]`)
  rigged.clear()
  if (left.length) throw new Error(`rigDice: values never rolled (the scenario didn't roll the expected dice): ${left.join('; ')}`)
}

// ------------------------------------------------------------------------------------------------ storage

/** A localStorage stand-in. Installed on globalThis by useLocalStorage(); removed after each test by setup.ts. */
export class MemStorage {
  data = new Map<string, string>()
  getItem(k: string) { return this.data.get(k) ?? null }
  setItem(k: string, v: string) { this.data.set(k, String(v)) }
  removeItem(k: string) { this.data.delete(k) }
  clear() { this.data.clear() }
  key(i: number) { return [...this.data.keys()][i] ?? null }
  get length() { return this.data.size }
}
export function useLocalStorage(ls: MemStorage | Record<string, unknown> = new MemStorage()) {
  ;(globalThis as any).localStorage = ls
  return ls
}
