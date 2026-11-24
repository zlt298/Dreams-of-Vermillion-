// The Lancer combat engine. Deterministic given a seed; UI-free.
import type { DamageData, RangeData, TagData, BonusData } from '../../data/lancer'
import { Lancer } from '../../data/lancer'
import {
  type AreaEffect, type GridMap, type Tile, type Cover, tileAt, footprint, elevationAt, unitElevation, distanceBetween,
  distanceToTile, hasLineOfSight, hasLineOfSightToTile, coverBetween, burstTiles, blastTiles, lineTiles, coneTiles,
  unitsOnTiles, key, chebyshev, center, footprintSize,
} from '../grid'
import { parseDice, Rng, rollDice, rollAccuracy, averageDice } from '../rng'
export const maxOf = (v: string | number) => { const d = parseDice(v); return d.count * d.sides + d.flat }
import { hasTag, tagVal, nextUid, isWeaponType, uidState } from '../stats'
import type { Duration, Effect, LogEntry, Pos, Profile, Side, Stat, StatusId, StatusInstance, Unit, UnitPolicies, Weapon } from '../types'
import { type FieldOverlay, type AttackCtx, type CustomAction, type DamageCtx, scriptsFor } from '../effects/registry'
import { genericActionsFor } from '../effects/generic'

export type BattleEvent =
  | { type: 'move'; unitId: string; path: Pos[] }
  | { type: 'attack'; attackerId: string; targetId: string; hit: boolean; crit: boolean; weapon: string; total: number }
  | { type: 'damage'; unitId: string; amount: number; kind: 'hp' | 'heat' | 'burn' | 'structure' | 'stress' }
  | { type: 'destroyed'; unitId: string }
  | { type: 'status'; unitId: string; status: string; added: boolean }
  | { type: 'turn'; unitId: string }
  | { type: 'round'; round: number }
  | { type: 'area'; tiles: Pos[]; kind: string }
  | { type: 'spawn'; unitId: string }
  | { type: 'terrain'; tiles: Pos[] }
  | { type: 'mine'; mineId: string; pos: Pos; added: boolean }
  | { type: 'end'; winner: Side }
  | { type: 'text'; unitId?: string; text: string }

/** A decision for a player-controlled unit (reaction, firing mode, ...). See Battle.choose. */
export interface ChoiceQuestion {
  /** short key, e.g. 'brace', 'vorpal', 'siege_mode' */
  kind: string
  unit: Unit
  title: string
  text?: string
  options: { label: string; hint?: string }[]
  /** what the AI, autoplay and tests pick */
  defaultIndex: number
  /** the reaction policy that governs this question (undefined: always ask) */
  policy?: keyof UnitPolicies
  other?: Unit
}
/** @deprecated use ChoiceQuestion */
export type ReactionQuestion = ChoiceQuestion

/**
 * Thrown by Battle.choose when the player has to answer and no answer is queued yet. The UI
 * restores the command's checkpoint, asks, and replays the command with the answer queued
 * (the seeded RNG makes the replay exact).
 */
export class PendingChoice extends Error {
  constructor(public q: ChoiceQuestion) { super('Waiting for a decision') }
}

export interface Sitrep {
  id: 'standard' | 'holdout' | 'control' | 'extraction' | 'assassination'
  name: string
  rounds?: number
  zone?: Pos[]
  targetId?: string
  description: string
}

export interface Mine {
  id: string
  ownerId: string
  side: Side
  pos: Pos
  radius: number
  damage: DamageData[]
  save?: Stat
  saveHalf?: boolean
  name: string
  /** extra effects applied to characters that fail the save */
  effects?: Effect[]
  /** mines arm at the end of the turn they were planted on */
  armed?: boolean
  /** sides that have found this mine (it is Hidden from everyone else on the other side) */
  detectedBy?: Side[]
  /** adjacent (default): a character enters an adjacent space; over: moves onto it; flying: a flyer enters an adjacent space;
   *  ally: one of the owner's allies enters an adjacent space (Smoke Mine); remote: only its Detonate action */
  trigger?: 'adjacent' | 'over' | 'flying' | 'ally' | 'remote'
  /** fires a Line of this length toward the triggering character instead of a burst (HAVOK) */
  line?: number
  /** the owner's script handles the explosion (onMineDetonate) */
  tag?: string
}

export interface MoveOpts { mode: 'standard' | 'boost' | 'free' | 'disengage' | 'involuntary'; ignoreEngagement?: boolean; flyingOk?: boolean }

export interface AttackAim { targetId?: string; tile?: Pos }

export interface AttackSummary { ctxs: AttackCtx[]; ok: boolean; reason?: string }

/** weapons that can only fire through their own special rules */
/** "By the Way, I Know Everything" (Pegasus): fixed average damage instead of rolling. */
export function averageRoll(val: string | number): { total: number; overkillHeat: number } {
  const p = parseDice(val)
  const TABLE: Record<string, number> = { '1d3': 2, '1d6': 4, '2d6': 7, '3d6': 11, '4d6': 14 }
  const dice = p.count ? TABLE[`${p.count}d${p.sides}`] ?? Math.floor(p.count * (p.sides + 1) / 2) : 0
  return { total: dice + p.flat, overkillHeat: 0 }
}

export const NO_NORMAL_ATTACK = new Set(['mw_autogun', 'mw_lancaster_integrated', 'mw_autopod', 'mw_vorpal_gun', 'mw_barbarossa_integrated'])

export const NEGATIVE: StatusId[] = ['impaired', 'slowed', 'immobilized', 'jammed', 'lockon', 'shredded', 'stunned', 'exposed', 'prone']

import * as decisions from './decisions'
import * as turns from './turns'
import * as damage from './damage'
import * as movement from './movement'
import * as attacks from './attacks'
import * as actions from './actions'
import * as terrain from './terrain'
import * as tech from './tech'
import * as fields from './fields'

/** One recorded top-level command: its arguments are encoded as ids (see replay). */
export interface CommandEntry { op: string; args: unknown[]; answers: number[] }
/** Everything needed to rebuild a battle from its start. */
export interface BattleRecord { version: 1; seed: number; uid: number; map: GridMap; units: Unit[]; sitrep: Sitrep }

/** Encode command arguments: units, weapons, custom actions and mines by id; plain data as is. */
export function encodeArg(v: unknown): unknown {
  if (v == null || typeof v !== 'object') return typeof v === 'function' ? undefined : v
  if (Array.isArray(v)) return v.map(encodeArg)
  const o = v as any
  if ('uid' in o && 'profiles' in o) return { $w: o.uid }
  if ('id' in o && 'stats' in o && 'flags' in o) return { $u: o.id }
  if ('key' in o && typeof o.run === 'function') return { $a: o.key }
  if ('ownerId' in o && 'radius' in o && 'pos' in o && 'id' in o) return { $m: o.id }
  const out: any = {}
  for (const k of Object.keys(o)) if (typeof o[k] !== 'function') out[k] = encodeArg(o[k])
  return out
}

export class Battle {
  map: GridMap
  units: Unit[]
  round = 0
  rng: Rng
  log: LogEntry[] = []
  events: BattleEvent[] = []
  areas: AreaEffect[] = []
  mines: Mine[] = []
  currentSide: Side = 'player'
  activeId: string | null = null
  winner: Side | null = null
  sitrep: Sitrep
  listeners: ((e: BattleEvent) => void)[] = []
  /**
   * UI hook for player decisions. Return an option index, or undefined to defer: the engine then
   * throws PendingChoice and the UI replays the command with the answer in `answers`.
   */
  chooser?: (q: ChoiceQuestion) => number | undefined
  /** answers queued for a replay, consumed in question order */
  answers: number[] = []
  /** while the AI drives a unit of this side, its side's questions take the default */
  aiSide: Side | null = null
  txDepth = 0
  /** the battle's seed and starting state (taken in start) for replays */
  seed = 0
  record: BattleRecord | null = null
  /** top-level commands since start, with the player decisions they consumed */
  commands: CommandEntry[] = []
  cmdDepth = 0
  currentCommand: CommandEntry | null = null
  /** set while resolving a Blast attack: cover is measured from here */
  blastCentre: Pos | null = null
  /** the aim of the most recent weapon attack (scripts read it after the attack) */
  lastAim: AttackAim | null = null
  /** set while an attack is measured from somewhere other than the attacker (Throughbolt) */
  attackOrigin: Pos | null = null
  /** prevents infinite reaction chains */
  reactionDepth = 0

  constructor(cfg: { map: GridMap; units: Unit[]; seed: number; sitrep?: Sitrep }) {
    this.map = cfg.map
    this.units = cfg.units
    this.rng = new Rng(cfg.seed)
    this.seed = cfg.seed
    this.sitrep = cfg.sitrep ?? { id: 'standard', name: 'Basic Combat', description: 'Defeat all enemy forces.' }
  }

  /** Monotonic count of events ever emitted (the `events` array itself is trimmed). */
  eventCount = 0
  sandboxDepth = 0
  static readonly MAX_EVENTS = 600
  static readonly MAX_LOG = 400
  emit(e: BattleEvent) {
    this.events.push(e)
    this.eventCount++
    if (!this.sandboxDepth && this.events.length > Battle.MAX_EVENTS * 2) this.events.splice(0, this.events.length - Battle.MAX_EVENTS)
    for (const l of this.listeners) l(e)
  }
  /** Last round anyone made an attack roll or lost HP (the AI's stalemate pressure reads it). */
  lastAttackRound = 0
  say(text: string, kind: LogEntry['kind'] = 'info') {
    this.log.push({ round: this.round, text, kind })
    if (!this.sandboxDepth && this.log.length > Battle.MAX_LOG * 2) this.log.splice(0, this.log.length - Battle.MAX_LOG)
    this.emit({ type: 'text', text })
  }
  unit(id: string | undefined | null): Unit | undefined {
    return id ? this.units.find(u => u.id === id) : undefined
  }
  get active(): Unit | undefined {
    return this.unit(this.activeId)
  }
  alive(side?: Side): Unit[] {
    return this.units.filter(u => !u.destroyed && (!side || u.side === side))
  }
  /** Characters that take turns (mechs & npcs) */
  combatants(side?: Side): Unit[] {
    return this.alive(side).filter(u => u.kind === 'mech' || u.kind === 'npc')
  }
  hostile(a: Unit, b: Unit): boolean {
    return a.side !== b.side && a.side !== 'neutral' && b.side !== 'neutral'
  }
  distance(a: Unit, b: Unit): number {
    return distanceBetween(this.map, a, b)
  }
  elevation(u: Unit): number {
    return unitElevation(this.map, u)
  }
  /** Map with cover deployables (Jericho etc.) folded in as raised tiles. */
  /** bumped whenever terrain-like state changes (cover deployables, areas); invalidates caches */
  terrainVersion = 0
  mapCache: { v: number; map: GridMap } | null = null
  losCache = new Map<string, boolean>()
  coverCache = new Map<string, Cover>()
  cacheVersion = -1
  invalidateTerrain() {
    this.terrainVersion++
    // cover may have changed or been destroyed: Hidden characters re-check it (core p.69)
    movement.recheckHidden(this)
  }
  checkCaches() {
    if (this.cacheVersion !== this.terrainVersion || this.losCache.size > 50000) {
      this.losCache.clear()
      this.coverCache.clear()
      this.cacheVersion = this.terrainVersion
    }
  }
  posKey(u: Unit, at: Pos = u.pos) {
    return `${u.id}@${at.x},${at.y}${u.flying ? 'f' : ''}${u.stats.size}`
  }
  effectiveMap(): GridMap {
    if (this.mapCache && this.mapCache.v === this.terrainVersion) return this.mapCache.map
    const map = this.buildEffectiveMap()
    this.mapCache = { v: this.terrainVersion, map }
    return map
  }
  buildEffectiveMap(): GridMap {
    // cover deployables, plus wreckage of destroyed mechs (hard cover objects)
    const covers = this.units.filter(u => (!u.destroyed && u.kind === 'deployable' && u.flags.isCover) || (u.destroyed && u.flags.wreck))
    if (!covers.length) return this.map
    const tiles = this.map.tiles.map(t => ({ ...t }))
    for (const c of covers) for (const p of footprint(c)) {
      const i = p.y * this.map.w + p.x
      if (tiles[i]) tiles[i] = { h: tiles[i].h + Math.max(1, c.stats.size), kind: 'block' }
    }
    return { ...this.map, tiles }
  }
  los(a: Unit, b: Unit, from?: Pos): boolean {
    this.checkCaches()
    const k = `${this.posKey(a, from)}>${this.posKey(b)}`
    let v = this.losCache.get(k)
    if (v === undefined) { v = hasLineOfSight(this.effectiveMap(), a, b, from); this.losCache.set(k, v) }
    if (v && this.losZones.length && this.losBlockedByZone(a, b, from)) return false
    return v
  }
  /** zones characters can't draw line of sight out of (Flash Grenade) */
  losZones: { id?: string; tiles: string[]; exempt?: string; untilRound: number; mode?: 'out' | 'border'; partialSeesThrough?: boolean }[] = []
  losBlockedByZone(a: Unit, b: Unit, from?: Pos): boolean {
    this.losZones = this.losZones.filter(z => this.round <= z.untilRound)
    for (const z of this.losZones) {
      if (z.exempt === a.id) continue
      const fa = footprint(a, from ?? a.pos), fb = footprint(b)
      const inA = fa.some(p => z.tiles.includes(key(p))), inB = fb.some(p => z.tiles.includes(key(p)))
      if ((z.mode ?? 'out') === 'out') { if (inA && !inB) return true; continue }
      // border: blocks both ways; characters straddling it may see through (Hardlight)
      if (z.partialSeesThrough && ((inA && !fa.every(p => z.tiles.includes(key(p)))) || (inB && !fb.every(p => z.tiles.includes(key(p)))))) continue
      if (inA !== inB) return true
    }
    return false
  }
  /** Let `u` take a forced action it has no action economy for (Law of Blades): costs are paid from a temporary pool. */
  withForcedAction<T>(u: Unit, fn: () => T): T { return decisions.withForcedAction(this, u, fn) }
  cover(attacker: Unit, target: Unit, from?: Pos): Cover {
    const m = this.effectiveMap()
    this.checkCaches()
    const ck = `${this.posKey(attacker, from)}>${this.posKey(target)}`
    let c = this.coverCache.get(ck) ?? coverBetween(m, attacker, target, this.areas, from)
    this.coverCache.set(ck, c)
    if (c !== 'hard') {
      // Guardian / Colossus: adjacent allied frames provide hard cover if they are between
      const ac = center(attacker, from ?? attacker.pos), tc = center(target)
      const dx = ac.x - tc.x, dy = ac.y - tc.y, dl = Math.hypot(dx, dy) || 1
      for (const g of this.units) {
        if (g.destroyed || g === target || g === attacker || !g.flags.guardian || this.hostile(g, target) || !this.adjacent(g, target)) continue
        const gc = center(g)
        const vx = gc.x - tc.x, vy = gc.y - tc.y, vl = Math.hypot(vx, vy) || 1
        if ((vx * dx + vy * dy) / (vl * dl) >= 0.5) { c = 'hard'; break }
      }
    }
    for (const o of this.units) {
      if (o.destroyed) continue
      for (const sc of scriptsFor(o)) if (sc.adjustCover) c = sc.adjustCover(this, o, attacker, target, c)
    }
    return c
  }

  has(u: Unit, s: StatusId | 'engaged' | 'dangerzone'): boolean {
    if (s === 'engaged') return this.isEngaged(u)
    if (s === 'dangerzone') return u.stats.heatcap > 0 && u.heat >= Math.ceil(u.stats.heatcap / 2)
    if (s === 'stunned' && u.statuses.some(x => x.id === 'shutdown')) return true
    return u.statuses.some(x => x.id === s)
  }
  isEngaged(u: Unit, at: Pos = u.pos): boolean {
    // Hidden characters don't cause engagement, and aren't engaged themselves (core p.77); drones are characters (p.78)
    if (u.kind === 'deployable' || this.has(u, 'hidden')) return false
    return this.alive().some(o => o !== u && this.hostile(u, o) && (o.kind === 'mech' || o.kind === 'npc' || o.kind === 'drone') && !this.has(o, 'hidden') &&
      this.adjacent(u, o, at))
  }
  /** symmetric: both sides use ground elevation (flying doesn't lift a unit out of reach of its neighbours) */
  adjacent(a: Unit, b: Unit, aAt: Pos = a.pos): boolean {
    const fa = footprint(a, aAt), fb = footprint(b)
    return fa.some(p => fb.some(q => chebyshev(p, q) <= 1)) && Math.abs(elevationAt(this.map, a, aAt) - elevationAt(this.map, b, b.pos)) <= Math.max(a.stats.size, b.stats.size) + 1
  }

  addStatus(u: Unit, id: StatusId, duration: Duration = 'until_cleared', source?: Unit, data?: any): boolean {
    if (u.destroyed) return false
    if (u.immune.includes(id)) { this.say(`${u.name} is immune to ${id}.`, 'status'); return false }
    for (const sc of scriptsFor(u)) if (sc.blockStatus?.(this, u, id, source)) { this.say(`${u.name} ignores ${id}.`, 'status'); return false }
    for (const o of this.alive()) if (o !== u) for (const sc of scriptsFor(o)) if (sc.blockAnyStatus?.(this, o, u, id, source)) { this.say(`${u.name} is protected from ${id}.`, 'status'); return false }
    if (u.kind === 'deployable' && ['prone', 'slowed', 'immobilized', 'impaired', 'jammed'].includes(id) && u.stats.speed === 0) return false
    if (id === 'prone' && u.flying) { this.say(`${u.name} is flying and can't be knocked prone.`, 'status'); return false }
    // flyers that are Immobilized or Stunned fall (they land; they take off again when they next move)
    if ((id === 'immobilized' || id === 'stunned') && u.flying && !data?.grapple && !data?.lift) this.land(u, `${id}`)
    const inst: StatusInstance = { id, source: source?.id, data }
    if (source?.flags.techActing) inst.tech = true // from a tech action (ICEOUT)
    if (duration === 'end_of_turn') { inst.clockUnit = this.activeId ?? u.id; inst.turnsLeft = 1 }
    else if (duration === 'next_turn_end_target') { inst.clockUnit = u.id; inst.turnsLeft = u.activeTurn ? 2 : 1 }
    else if (duration === 'next_turn_end_source' && source) { inst.clockUnit = source.id; inst.turnsLeft = source.activeTurn ? 2 : 1 }
    else if (duration === 'start_of_next_turn_target') { inst.clockUnit = u.id; inst.turnsLeft = 1; inst.atStart = true }
    const existing = u.statuses.find(s => s.id === id)
    if (existing) {
      // keep the longer of the two
      if (!existing.clockUnit) return true
      if (!inst.clockUnit) { Object.assign(existing, inst); delete existing.clockUnit; delete existing.turnsLeft; delete existing.atStart; return true }
      const same = u.statuses.find(s => s.id === id && s.clockUnit === inst.clockUnit)
      if (same) {
        // on one clock, more turns is longer; with equal turns, ending at the end of the turn outlasts the start
        const n = same.turnsLeft ?? 0, m = inst.turnsLeft ?? 0
        if (m > n) { same.turnsLeft = m; same.atStart = inst.atStart }
        else if (m === n) same.atStart = !!same.atStart && !!inst.atStart
        if (!same.atStart) delete same.atStart
      } else {
        // timed on different units' turns: the two can't be compared, so keep both; the status lasts until the later one expires
        u.statuses.push(inst)
      }
      return true
    }
    u.statuses.push(inst)
    this.emit({ type: 'status', unitId: u.id, status: id, added: true })
    this.say(`${u.name} is ${id.toUpperCase()}.`, 'status')
    if (source && source !== u) for (const sc of scriptsFor(source)) sc.onStatusInflicted?.(this, source, u, id)
    if (id === 'stunned' || id === 'shutdown') { u.flags.wasStunned = true }
    for (const sc of scriptsFor(u)) sc.onStatusAdded?.(this, u, id, duration, source)
    for (const o of this.alive()) if (o !== u) for (const sc of scriptsFor(o)) sc.onAnyStatusAdded?.(this, o, u, id, duration, source)
    return true
  }
  removeStatus(u: Unit, id: StatusId) {
    const before = u.statuses.length
    u.statuses = u.statuses.filter(s => s.id !== id)
    if (u.statuses.length !== before) {
      this.emit({ type: 'status', unitId: u.id, status: id, added: false })
      this.say(`${u.name} is no longer ${id}.`, 'status')
      for (const s of scriptsFor(u)) s.onStatusRemoved?.(this, u, id)
      // Hidden while Invisible lasts past Invisible only in cover (core p.69)
      if (id === 'invisible') movement.recheckHidden(this)
    }
  }
  tickStatuses(clock: Unit, atStart: boolean) {
    for (const u of this.units) {
      for (const s of [...u.statuses]) {
        if (s.clockUnit !== clock.id || !!s.atStart !== atStart) continue
        s.turnsLeft = (s.turnsLeft ?? 1) - 1
        if (s.turnsLeft > 0) continue
        // drop just this instance; the status only ends when no other instance is left
        if (u.statuses.some(x => x !== s && x.id === s.id)) u.statuses = u.statuses.filter(x => x !== s)
        else this.removeStatus(u, s.id)
      }
    }
  }

  accuracyFromStatuses(u: Unit, kind: 'attack' | 'check' | 'save', stat?: Stat): number {
    let n = 0
    if (this.has(u, 'impaired')) n -= 1
    for (const b of u.bonuses) {
      if (b.accuracy == null) continue
      if (b.condition && !this.evalCondition(u, b.condition)) continue
      if (b.id === kind) n += b.accuracy
      if (stat && kind !== 'attack' && b.id === ({ hull: 'hull', agi: 'agility', sys: 'systems', eng: 'engineering' } as const)[stat]) n += b.accuracy
    }
    if (kind !== 'attack') {
      for (const o of this.alive()) for (const s of scriptsFor(o)) if (s.checkAccuracy) n += s.checkAccuracy(this, o, u, kind, stat)
      const bol = u.statuses.find(s => s.id === 'bolstered')
      if (bol) { n += 2; this.removeStatus(u, 'bolstered') }
    }
    return n
  }
  evalCondition(u: Unit, cond: string): boolean {
    const c = cond.replace(/[{}]/g, '').toLowerCase()
    if (c === 'exposed') return this.has(u, 'exposed')
    if (c === 'dangerzone' || c === 'danger_zone') return this.has(u, 'dangerzone')
    if (c === 'first_round') return this.round === 1
    if (c === 'early_rounds') return this.round <= 2
    if (c === 'flying') return u.flying
    if (u.flags[c]) return true
    if (c === 'adjacent_ally') return this.alive().some(o => o !== u && !this.hostile(u, o) && (o.kind === 'mech' || o.kind === 'npc') && this.adjacent(u, o))
    return false
  }

  /** Skill check vs 10. */
  check(u: Unit, stat: Stat, extraAcc = 0): boolean {
    if ((stat === 'hull' || stat === 'agi') && this.has(u, 'stunned')) { this.say(`${u.name} automatically fails the ${stat.toUpperCase()} check (stunned).`); return false }
    const acc = this.accuracyFromStatuses(u, 'check', stat) + extraAcc
    const roll = () => {
      const d = this.rollD20(u, 'check'), a = rollAccuracy(this.rng, acc)
      const total = d + u.stats[stat] + a.bonus
      const ok = total >= 10
      this.say(`${u.name} ${stat.toUpperCase()} check: ${total} (${d}${fmtAcc(a.bonus)}+${u.stats[stat]}) ${ok ? 'success' : 'failure'}.`)
      return ok
    }
    const ok = roll()
    return ok || (this.offerReroll(u, 'check', stat) && roll())
  }
  /** A failed check or save: a script (e.g. a Commander's Voice of Authority) may let it be rerolled once. */
  offerReroll(u: Unit, kind: 'check' | 'save', stat: Stat): boolean {
    for (const o of this.alive()) for (const s of scriptsFor(o)) if (s.rerollFailed?.(this, o, u, kind, stat)) return true
    return false
  }
  /** Save vs a source's save target. */
  save(u: Unit, stat: Stat, target: number, extraAcc = 0, source?: Unit): boolean {
    if (source && source !== u && !source.destroyed) for (const sc of scriptsFor(source)) sc.onSaveForced?.(this, source, u, stat)
    if ((stat === 'hull' || stat === 'agi') && this.has(u, 'stunned')) { this.say(`${u.name} automatically fails the ${stat.toUpperCase()} save (stunned).`); return false }
    if ((stat === 'hull' || stat === 'agi') && u.flags.autoSaveUntil != null && this.round <= u.flags.autoSaveUntil) { this.say(`${u.name} automatically passes the ${stat.toUpperCase()} save.`); return true }
    const acc = this.accuracyFromStatuses(u, 'save', stat) + extraAcc
    const roll = () => {
      const d = this.rollD20(u, 'save'), a = rollAccuracy(this.rng, acc)
      const total = d + u.stats[stat] + a.bonus
      const ok = total >= target
      this.say(`${u.name} ${stat.toUpperCase()} save vs ${target}: ${total} — ${ok ? 'success' : 'failure'}.`)
      return ok
    }
    // a save forced during the source's own turn (Raleigh Full Metal Jacket)
    if (source && source !== u && source.activeTurn) source.flags['turn:forcedSave'] = true
    let ok = roll()
    if (!ok && this.offerReroll(u, 'save', stat)) ok = roll()
    for (const o of this.alive()) for (const sc of scriptsFor(o)) sc.onAnySave?.(this, o, u, stat, ok, source)
    if (!ok && source && source !== u && !source.destroyed) for (const sc of scriptsFor(source)) sc.onSaveFailed?.(this, source, u, stat)
    return ok
  }

  start() {
    this.record = { version: 1, seed: this.seed, uid: uidState(), map: JSON.parse(JSON.stringify(this.map)), units: JSON.parse(JSON.stringify(this.units)), sitrep: JSON.parse(JSON.stringify(this.sitrep)) }
    this.commands = []
    return turns.start(this)
  }
  /** Run a command, recording it when it is a top-level player or AI command (nested calls aren't recorded). */
  command<T>(op: string, args: unknown[], fn: () => T): T {
    if (this.cmdDepth > 0 || this.sandboxDepth > 0 || !this.record) return fn()
    const entry: CommandEntry = { op, args: args.map(encodeArg), answers: [] }
    this.commands.push(entry)
    const prev = this.currentCommand
    this.currentCommand = entry
    this.cmdDepth++
    try { return fn() } catch (e) {
      if (!(e instanceof PendingChoice)) this.commands = this.commands.filter(x => x !== entry)
      throw e
    } finally { this.cmdDepth--; this.currentCommand = prev }
  }
  /** a player decision taken during the current command (replays feed it back) */
  noteAnswer(i: number) { this.currentCommand?.answers.push(i) }
  /** UI settings that change outcomes, made through commands so replays see them */
  setProfile(u: Unit, w: Weapon, i: number) { return this.command('setProfile', [u, w, i], () => { w.profileIndex = i }) }
  setWeaponFlag(u: Unit, w: Weapon, flag: string, value: unknown) { return this.command('setWeaponFlag', [u, w, flag, value], () => { (w.flags ??= {})[flag] = value }) }
  setPolicy(u: Unit, kind: keyof UnitPolicies, value: 'auto' | 'ask' | 'off') { return this.command('setPolicy', [u, kind, value], () => { u.policies[kind] = value }) }
  startRound() { return turns.startRound(this) }
  hasActivations(side: Side): boolean { return turns.hasActivations(this, side) }
  canActivate(u: Unit): true | string { return turns.canActivate(this, u) }
  /** a unit that takes its turn right after the current one (Goblin INSTINCT Rig on its host's turn) */
  chainTurn: string | null = null
  /** The side that took the most recent turn: the other side opens the next round (sides keep alternating). */
  lastSide: Side | null = null
  /** a character acting inside another's turn (Goblin INSTINCT Rig), see interject */
  interjection: { unit: string; host: string } | null = null
  interject(u: Unit, host: Unit) { return this.command('interject', [u, host], () => turns.interject(this, u, host)) }

  beginTurn(u: Unit) { return this.command('beginTurn', [u], () => turns.beginTurn(this, u)) }

  /** Set while endTurn runs, so a unit destroyed by its own end-of-turn effects doesn't hand the turn over twice. */
  endingTurnOf: string | null = null
  endTurn(u: Unit = this.active!) { return this.command('endTurn', [u], () => turns.endTurn(this, u)) }
  endTurnInner(u: Unit) { return turns.endTurnInner(this, u) }
  handOverTurn(u: Unit) { return turns.handOverTurn(this, u) }
  endInterjection(u: Unit) { return turns.endInterjection(this, u) }
  removeStatusIfExpiredRecovery(_u: Unit) {}
  endRound() { return turns.endRound(this) }
  sitrepScore?: number

  checkVictory() { return turns.checkVictory(this) }
  finish(w: Side, why: string) { return turns.finish(this, w, why) }

  /**
   * Quick actions can't be repeated in a turn from the normal action pool, but a repeat can be
   * paid with a free-action quick (Overcharge, Everest Initiative, ASURA...).
   */
  quickUsed(u: Unit, action: string): boolean { return turns.quickUsed(this, u, action) }
  canSpend(u: Unit, cost: 'quick' | 'full' | 'protocol' | 'free' | 'reaction' | 'move', action?: string): true | string { return turns.canSpend(this, u, cost, action) }
  spend(u: Unit, cost: 'quick' | 'full' | 'protocol' | 'free' | 'reaction', action?: string) { return turns.spend(this, u, cost, action) }

  addHeat(u: Unit, amount: number, source?: Unit) { return damage.addHeat(this, u, amount, source) }

  overheatCheck(u: Unit) { return damage.overheatCheck(this, u) }

  /** Structure/overheat dice; Legendary rolls twice and keeps the better result. */
  tableDice(u: Unit, marked: number): number[] { return damage.tableDice(this, u, marked) }
  structureCheck(u: Unit) { return damage.structureCheck(this, u) }
  directHit(u: Unit) { return damage.directHit(this, u) }
  systemTrauma(u: Unit) { return damage.systemTrauma(this, u) }

  reactorExplosion(u: Unit, why: string) { return damage.reactorExplosion(this, u, why) }

  /** Half damage on a successful save (Napoleon's Heavy Shielding reduces it to 1). */
  halfOnSave(t: Unit, amount: number): number { return damage.halfOnSave(this, t, amount) }

  destroy(u: Unit, why: string) { return damage.destroy(this, u, why) }

  /**
   * Apply damage parts to a unit. Types: Kinetic, Explosive, Energy, Burn, Heat, plus internal 'Burn-tick'.
   */
  applyDamage(t: Unit, parts: { type: string; amount: number }[], opts: { source?: Unit; ap?: boolean; irreducible?: boolean; attack?: AttackCtx; resistAll?: boolean; resistTypes?: string[] } = {}): number { return damage.applyDamage(this, t, parts, opts) }

  loseHp(t: Unit, amount: number, _source?: Unit) { return damage.loseHp(this, t, amount, _source) }

  heal(u: Unit, amount: number) { return damage.heal(this, u, amount) }

  passable(u: Unit, at: Pos, mover: Set<string>): 'ok' | 'pass' | 'blocked' { return movement.passable(this, u, at, mover) }

  stepCost(u: Unit, from: Pos, to: Pos): number { return movement.stepCost(this, u, from, to) }

  /** Dijkstra over anchor positions. Returns reachable stop positions with cost and path. */
  reachable(u: Unit, budget: number, opts: movement.ReachOpts = {}): Map<string, { pos: Pos; cost: number; prev?: string }> { return movement.reachable(this, u, budget, opts) }

  pathTo(u: Unit, dest: Pos, budget: number, opts: movement.ReachOpts = {}): { path: Pos[]; cost: number } | null { return movement.pathTo(this, u, dest, budget, opts) }

  canMove(u: Unit, mode: MoveOpts['mode']): true | string { return movement.canMove(this, u, mode) }

  /** Move a unit along the cheapest path. Standard moves spend moveLeft. */
  move(u: Unit, dest: Pos, opts: MoveOpts = { mode: 'standard' }): boolean { return this.command('move', [u, dest, opts], () => movement.move(this, u, dest, opts)) }

  /** Last undoable standard move (cleared as soon as anything else happens). */
  lastMove: { unitId: string; pos: Pos; moveLeft: number; acted: boolean; moved: boolean; round: number; startEvents: number; endEvents: number } | null = null

  canUndoMove(u: Unit): boolean { return movement.canUndoMove(this, u) }

  undoMove(u: Unit) { return this.command('undoMove', [u], () => movement.undoMove(this, u)) }

  /** Move along an explicit path (straight swings, scripted dashes): same triggers as a normal move. */
  moveAlong(u: Unit, path: Pos[], opts: { noReactions?: boolean } = {}) { return movement.moveAlong(this, u, path, opts) }
  followPath(u: Unit, path: Pos[]) { return movement.followPath(this, u, path) }
  updateEngagementTerminal(_u: Unit) {}

  /** Push/pull (involuntary). dir: +1 away from source, -1 toward source. */
  forceMove(target: Unit, source: Unit | Pos, spaces: number, dir: 1 | -1) { return movement.forceMove(this, target, source, spaces, dir) }

  triggerOverwatch(mover: Unit) { return attacks.triggerOverwatch(this, mover) }
  bestThreatWeapon(o: Unit, target: Unit): Weapon | null { return attacks.bestThreatWeapon(this, o, target) }

  profile(w: Weapon): Profile { return attacks.profile(this, w) }
  weaponTags(u: Unit, w: Weapon): TagData[] { return attacks.weaponTags(this, u, w) }
  isMelee(w: Weapon): boolean { return attacks.isMelee(this, w) }
  isAoE(p: Profile): boolean { return attacks.isAoE(this, p) }
  bonusApplies(b: BonusData, w: Weapon, rangeType?: string, damageType?: string): boolean { return attacks.bonusApplies(this, b, w, rangeType, damageType) }
  ranges(u: Unit, w: Weapon): RangeData[] { return attacks.ranges(this, u, w) }
  weaponThreat(u: Unit, w: Weapon): number { return attacks.weaponThreat(this, u, w) }
  weaponReach(u: Unit, w: Weapon): number { return attacks.weaponReach(this, u, w) }
  weaponReady(u: Unit, w: Weapon): boolean { return attacks.weaponReady(this, u, w) }
  weaponUsable(u: Unit, w: Weapon, normalAttack = true): true | string { return attacks.weaponUsable(this, u, w, normalAttack) }

  /** Targets (or aim tile) validity for a weapon attack */
  validTarget(u: Unit, w: Weapon, t: Unit, from: Pos = u.pos): true | string { return attacks.validTarget(this, u, w, t, from) }

  aoeTiles(u: Unit, w: Weapon, aim: Pos): Pos[] | string { return attacks.aoeTiles(this, u, w, aim) }
  /** The units a weapon's area attack aimed at `aim` would affect (line of sight, height, own Blast, deployables). */
  aoeTargets(u: Unit, w: Weapon, aim: Pos): Unit[] | string { return attacks.aoeTargets(this, u, w, aim) }
  /** Who an area pattern on `tiles` affects (for scripted and system areas): see attacks.areaVictims. */
  areaVictims(u: Unit, tiles: Pos[], shape: attacks.AreaShape, size: number, opts: { centre?: Pos; origin?: Unit; ignoreLos?: boolean } = {}): Unit[] { return attacks.areaVictims(this, u, tiles, shape, size, opts) }
  /** Add bonus damage to an attack's own damage packet (Armor once, rolled once, halved vs multiple targets): see attacks.addBonusDamage. */
  addBonusDamage(ctx: AttackCtx, val: string | number, type?: string, opts: attacks.BonusDamageOpts = {}) { return attacks.addBonusDamage(this, ctx, val, type, opts) }
  /** A knockback's length after bonuses (Titanomachy Mesh); 0 stays 0. Without a weapon it counts as a melee attack. */
  knockbackDistance(u: Unit, base: number, w?: Weapon): number { return attacks.knockbackDistance(this, u, base, w) }

  /** Damage bonus (flat) from bonuses, per damage type */
  flatDamageBonus(u: Unit, w: Weapon, type: string): number { return attacks.flatDamageBonus(this, u, w, type) }

  newAttackCtx(attacker: Unit, target: Unit, partial: Partial<AttackCtx>): AttackCtx { return attacks.newAttackCtx(this, attacker, target, partial) }

  /**
   * Run `fn` and then roll back every piece of mutable battle state it touched (units, statuses,
   * flags, equipment, areas, mines, rng, log/events). Object identity is preserved and render
   * listeners are muted, so previews and AI lookahead can safely call script hooks.
   */
  sandbox<T>(fn: () => T): T { return decisions.sandbox(this, fn) }

  /**
   * Deep snapshot of all mutable battle state; the returned function restores it in place (unit,
   * weapon and system objects keep their identity so the UI's references stay valid). Render
   * listeners are not involved: use `transaction` to hold events back until a command succeeds.
   */
  /** True while a preview runs in sandbox(): scripts must not take real actions (reactions, attacks) then. */
  get previewing(): boolean { return this.sandboxDepth > 0 }
  /** Tiles changed during the current preview, as they were before it (see touchTile). */
  sandboxTiles: Map<number, Tile> | null = null
  /** Call before changing a map tile: inside a preview, remember how it was so sandbox() can put it back. */
  touchTile(p: Pos) { return decisions.touchTile(this, p) }

  /**
   * Snapshot of the battle's own fields (turn, side, round, winner, grapples, areas, terrain…) and the map tiles,
   * not the units: deep-copied, but references to units, weapons, systems and the map are kept as they are.
   */
  snapshotBattleFields(withTiles = true): () => void { return decisions.snapshotBattleFields(this, withTiles) }

  checkpoint(): () => void { return decisions.checkpoint(this) }
  /**
   * Run a player or AI command so it can be suspended for a decision: render events are held back
   * until it finishes; on PendingChoice the battle is rolled back and the question returned.
   */
  transaction(fn: () => void, answers: number[] = [], opts: { rollbackOnError?: boolean } = {}): { pending: ChoiceQuestion } | { error?: Error } { return decisions.transaction(this, fn, answers, opts) }

  /** Compute accuracy/difficulty and the to-hit chance for previews and the AI (no state is changed). */
  previewAttack(attacker: Unit, w: Weapon, target: Unit, from: Pos = attacker.pos, mode: AttackCtx['mode'] = 'skirmish'): { ctx: AttackCtx; chance: number; cover: Cover; expectedDamage: number } { return attacks.previewAttack(this, attacker, w, target, from, mode) }

  /**
   * Detailed hover preview: Monte Carlo over the real attack math with a private RNG.
   * Damage figures are after Exposed, armor (per type) and resistance; heat is reported separately.
   */
  previewDetail(attacker: Unit, w: Weapon, target: Unit, samples = 1200): { chance: number; critChance: number; minDmg: number; maxDmg: number; avgDmg: number; heat: number; lethal: number; lethalLabel: 'destroy' | 'structure'; reliable: number } { return attacks.previewDetail(this, attacker, w, target, samples) }

  previewAttackRaw(attacker: Unit, w: Weapon, target: Unit, from: Pos, mode: AttackCtx['mode']): { ctx: AttackCtx; chance: number; cover: Cover; expectedDamage: number } { return attacks.previewAttackRaw(this, attacker, w, target, from, mode) }

  defenseOf(t: Unit, ctx: AttackCtx): number { return attacks.defenseOf(this, t, ctx) }

  buildWeaponCtx(attacker: Unit, w: Weapon, target: Unit, mode: AttackCtx['mode'], consume: boolean, multi = false): AttackCtx { return attacks.buildWeaponCtx(this, attacker, w, target, mode, consume, multi) }

  /** Main entry for weapon attacks (skirmish/barrage call this). Handles AoE, rolls and on-hit effects. */
  weaponAttack(u: Unit, w: Weapon, aim: AttackAim, mode: AttackCtx['mode'] = 'free', opts: { noBonusDamage?: boolean; autoHit?: boolean; from?: Pos } = {}): AttackSummary { return this.command('weaponAttack', [u, w, aim, mode, opts], () => attacks.weaponAttack(this, u, w, aim, mode, opts)) }

  /** Reroll a resolved attack roll (Valiant Aid): the second result stands. */
  rerollToHit(ctx: AttackCtx) { return attacks.rerollToHit(this, ctx) }
  rollToHit(ctx: AttackCtx) { return attacks.rollToHit(this, ctx) }

  /** Run DSL effects from `src` against `target`. */
  runEffects(src: Unit, target: Unit, effects: Effect[], ctx?: AttackCtx, saveTarget?: number) { return attacks.runEffects(this, src, target, effects, ctx, saveTarget) }

  /** Rough incoming HP damage before resistance (for brace decisions and prompts). */
  estimateIncoming(t: Unit, parts: { type: string; amount: number }[]): number { return attacks.estimateIncoming(this, t, parts) }
  shouldBrace(t: Unit, parts: { type: string; amount: number }[]): boolean { return attacks.shouldBrace(this, t, parts) }
  braceWanted(t: Unit, attacker: Unit, parts: { type: string; amount: number }[], ctx: AttackCtx): boolean { return attacks.braceWanted(this, t, attacker, parts, ctx) }
  /** Resolve a reaction decision under the unit's policy. */
  wantsReaction(u: Unit, kind: 'brace' | 'overwatch', heuristic: boolean, other: Unit, text: string): boolean { return decisions.wantsReaction(this, u, kind, heuristic, other, text) }
  /**
   * Ask a player-controlled unit a question. Enemies, AI-driven turns, sandboxes, policies other
   * than 'ask' and battles without a UI take `defaultIndex`.
   */
  choose(q: ChoiceQuestion): number { return decisions.choose(this, q) }
  /** Yes/no scripted reaction for a player unit (policy 'reactions'); the AI answers `heuristic`. */
  offerReaction(u: Unit, kind: string, title: string, text: string, heuristic = true): boolean { return decisions.offerReaction(this, u, kind, title, text, heuristic) }
  brace(t: Unit): boolean { return attacks.brace(this, t) }

  skirmish(u: Unit, w: Weapon, aim: AttackAim, aux?: { weapon: Weapon; aim: AttackAim }): AttackSummary { return this.command('skirmish', [u, w, aim, aux], () => actions.skirmish(this, u, w, aim, aux)) }

  barrage(u: Unit, a: { weapon: Weapon; aim: AttackAim }, b?: { weapon: Weapon; aim: AttackAim }, auxes: { weapon: Weapon; aim: AttackAim }[] = []): AttackSummary { return this.command('barrage', [u, a, b, auxes], () => actions.barrage(this, u, a, b, auxes)) }
  /** Auxiliary weapons that may follow up a barrage/skirmish with these weapons. */
  auxFollowUps(u: Unit, fired: Weapon[]): Weapon[] { return actions.auxFollowUps(this, u, fired) }

  firedThisTurn(u: Unit, w: Weapon): boolean { return actions.firedThisTurn(this, u, w) }
  /** Damage carried by each terrain block's top section (house rule: 10 HP per level of height, Evasion 5). */
  terrainDamage = new Map<string, number>()
  static TERRAIN_SECTION_HP = 10

  /** Damage a terrain block. Every 10 damage knocks one level off; a block with no levels left becomes rubble. */
  damageTerrain(p: Pos, amount: number, opts: { source?: Unit; quiet?: boolean } = {}): boolean { return terrain.damageTerrain(this, p, amount, opts) }
  /** Objects in an area take automatic damage: deployables, and terrain blocks. */
  damageObjectsIn(tiles: Pos[], amount: number, opts: { source?: Unit; ap?: boolean } = {}) { return terrain.damageObjectsIn(this, tiles, amount, opts) }
  /** Raise a size-1 section of hard cover on a free ground space (debris, barricades). */
  raiseCover(p: Pos, opts: { indestructible?: boolean; owner?: string } = {}): boolean { return terrain.raiseCover(this, p, opts) }
  /** Skirmish against a terrain block: attack roll vs Evasion 5, weapon damage to the section. */
  attackTerrain(u: Unit, w: Weapon, p: Pos): AttackSummary { return this.command('attackTerrain', [u, w, p], () => terrain.attackTerrain(this, u, w, p)) }
  markFired(u: Unit, w: Weapon) { return this.command('markFired', [u, w], () => terrain.markFired(this, u, w)) }

  boost(u: Unit) { return this.command('boost', [u], () => terrain.boost(this, u)) }

  /** Standing up takes the standard move: only on your own turn, before moving, and not while Stunned or Immobilized. */
  canStandUp(u: Unit): true | string { return terrain.canStandUp(this, u) }
  standUp(u: Unit) { return this.command('standUp', [u], () => terrain.standUp(this, u)) }

  overcharge(u: Unit) { return this.command('overcharge', [u], () => terrain.overcharge(this, u)) }

  stabilize(u: Unit, mode: 'cool' | 'repair', clear?: { unit: Unit; status?: StatusId | 'burn' | 'reload' }, opts: { paid?: boolean } = {}) { return this.command('stabilize', [u, mode, clear, opts], () => terrain.stabilize(this, u, mode, clear, opts)) }

  disengage(u: Unit) { return this.command('disengage', [u], () => terrain.disengage(this, u)) }

  /** Hide: needs to be out of LoS of all hostiles or in cover from them. */
  canHide(u: Unit): boolean { return terrain.canHide(this, u) }
  hide(u: Unit) { return this.command('hide', [u], () => terrain.hide(this, u)) }
  search(u: Unit) { return this.command('search', [u], () => terrain.search(this, u)) }

  /** Ram and Grapple are attacks: hidden, intangible or destroyed targets can't be chosen. */
  meleeTargetValid(u: Unit, t: Unit): true | string { return terrain.meleeTargetValid(this, u, t) }
  /** The status modifiers every attack gets (as buildWeaponCtx applies them), for Ram and Grapple. Attacking reveals a Hidden attacker. */
  meleeAttackMods(u: Unit, t: Unit, ctx: AttackCtx) { return terrain.meleeAttackMods(this, u, t, ctx) }
  ram(u: Unit, t: Unit) { return this.command('ram', [u, t], () => terrain.ram(this, u, t)) }

  /** Active grapples: attacker `a` holds defender `d`; `winner` decides same-size contests. */
  grapples: { a: string; d: string; winner?: string }[] = []
  draggingId: string | null = null

  grapple(u: Unit, t: Unit) { return this.command('grapple', [u, t], () => terrain.grapple(this, u, t)) }
  /** Begin a grapple (also used by systems such as Impale). */
  startGrapple(a: Unit, d: Unit) { return terrain.startGrapple(this, a, d) }
  /** Combined Size of everyone grappling `d`, against `d`'s own Size. */
  grappleDominance(g: { a: string; d: string; winner?: string }): 'attackers' | 'defender' { return terrain.grappleDominance(this, g) }
  /** Units this one is holding or being held by, and whether it currently counts as the larger side. */
  grappleInfo(u: Unit): { partners: Unit[]; dominant: boolean; attacker: boolean; defender: boolean } { return terrain.grappleInfo(this, u) }
  /** Drop broken grapples (destroyed, no longer adjacent) and refresh Grappled/Immobilized. */
  syncGrapples() { return terrain.syncGrapples(this) }
  /** Same-size grapples: contested Hull check at the start of a turn decides who counts as larger. */
  grappleContest(u: Unit) { return terrain.grappleContest(this, u) }
  /** Defender: contested Hull check as a quick action to break free. */
  breakGrapple(u: Unit) { return this.command('breakGrapple', [u], () => terrain.breakGrapple(this, u)) }
  /** Attacker: end your grapples as a free action. */
  releaseGrapple(u: Unit) { return this.command('releaseGrapple', [u], () => terrain.releaseGrapple(this, u)) }
  /** The larger side drags the smaller along when it moves (mirroring its movement). */
  dragGrappled(u: Unit, from: Pos) { return terrain.dragGrappled(this, u, from) }
  dragSpot(p: Unit, want: Pos, holder: Unit): Pos | null { return terrain.dragSpot(this, p, want, holder) }

  improvisedAttack(u: Unit, t: Unit) { return this.command('improvisedAttack', [u, t], () => terrain.improvisedAttack(this, u, t)) }

  reload(u: Unit, w: Weapon) { return this.command('reload', [u, w], () => terrain.reload(this, u, w)) }

  shutDown(u: Unit) { return this.command('shutDown', [u], () => terrain.shutDown(this, u)) }
  bootUp(u: Unit) { return this.command('bootUp', [u], () => terrain.bootUp(this, u)) }
  selfDestruct(u: Unit) { return this.command('selfDestruct', [u], () => terrain.selfDestruct(this, u)) }

  techTargetValid(u: Unit, t: Unit, option?: string): true | string { return tech.techTargetValid(this, u, t, option) }
  /** Quick Tech can be taken more than once per turn, but a different option must be chosen each time
   * (Full Tech may pick the same option twice). Invasion options all count as the 'invade' option. */
  spendTech(u: Unit, option: string) { return tech.spendTech(this, u, option) }
  canQuickTech(u: Unit, option?: string): true | string { return tech.canQuickTech(this, u, option) }
  /** Metahook: a linked ally's Sensors and line of sight count for your tech actions. */
  viaMetahook(u: Unit, t: Unit): boolean { return tech.viaMetahook(this, u, t) }
  /** A straight (orthogonal or diagonal) path to `dest`, or an error if there isn't one. */
  straightPath(u: Unit, dest: Pos, budget: number): { path: Pos[]; cost: number } { return tech.straightPath(this, u, dest, budget) }
  /** Interdiction Field and similar: may `u` teleport (out of where it is) to `p`? */
  teleportBlocked(u: Unit, p: Pos): boolean { return tech.teleportBlocked(this, u, p) }
  /** spaces a character may pass through but not end a move in (OASIS trail) */
  endBlocked(u: Unit, p: Pos): boolean { return tech.endBlocked(this, u, p) }
  /** Take one Quick Tech option without spending an action (reactions like Reactive Code). */
  withFreeTech<T>(u: Unit, fn: () => T): T { return tech.withFreeTech(this, u, fn) }
  /** Full Tech: two quick tech actions. */
  fullTech(u: Unit) { return this.command('fullTech', [u], () => tech.fullTech(this, u)) }
  /**
   * The roll for an INVADE: a tech attack against hostiles; a willing ally is invaded automatically
   * (no roll, it isn't an attack, and the caller deals no heat).
   */
  invadeRoll(u: Unit, t: Unit, label: string): AttackCtx { return tech.invadeRoll(this, u, t, label) }
  techAttackRoll(u: Unit, t: Unit, label: string): AttackCtx { return tech.techAttackRoll(this, u, t, label) }
  invade(u: Unit, t: Unit, option: 'fragment' | { name: string; effects: Effect[]; heat?: number } = 'fragment') { return this.command('invade', [u, t, option], () => tech.invade(this, u, t, option)) }
  lockOn(u: Unit, t: Unit) { return this.command('lockOn', [u, t], () => tech.lockOn(this, u, t)) }
  bolster(u: Unit, t: Unit) { return this.command('bolster', [u, t], () => tech.bolster(this, u, t)) }
  scan(u: Unit, t: Unit): string { return this.command('scan', [u, t], () => tech.scan(this, u, t)) }

  activateCore(u: Unit) { return this.command('activateCore', [u], () => tech.activateCore(this, u)) }

  /** Every persistent zone on the map (terrain areas, drone and system fields), for overlays and tooltips. */
  fieldOverlays(): FieldOverlay[] { return fields.fieldOverlays(this) }
  /** Zero-g areas: characters inside can fly and can't fall, but are Slowed unless they already fly. */
  syncZeroG(u: Unit) { return fields.syncZeroG(this, u) }
  /** A flyer falls to the ground (the battlefield models one level of altitude, so no fall damage). */
  land(u: Unit, why: string) { return fields.land(this, u, why) }
  /** Blinded: line of sight only to adjacent spaces (flash bombs, Blind tech). */
  isBlinded(u: Unit): boolean { return fields.isBlinded(this, u) }
  /** d20 for an attack, check or save; scripts (e.g. SISYPHUS) may substitute a stored result. */
  rollD20(u: Unit, kind: 'attack' | 'check' | 'save', ctx?: AttackCtx): number { return fields.rollD20(this, u, kind, ctx) }
  /** Hostile reveal fields (e.g. Lotus Projector): no Hiding, no Invisibility benefit, Hidden lost at turn end. */
  inRevealField(u: Unit): boolean { return fields.inRevealField(this, u) }
  /** ICEOUT fields: characters inside are immune to tech actions and can't take them. */
  inIceout(u: Unit): boolean { return fields.inIceout(this, u) }
  /** Take a drone/deployable off the field without destroying it (recall, expiry, disintegration). */
  removeUnit(u: Unit, why: string) { return fields.removeUnit(this, u, why) }
  spawn(u: Unit) { return fields.spawn(this, u) }
  /**
   * Plant a mine (core book MINE tag): a free space within `range` (adjacent by default) that isn't next to another
   * mine; it arms at the end of the owner's turn and is Hidden from the other side until detected.
   */
  placeMine(owner: Unit, pos: Pos, m: Omit<Mine, 'id' | 'ownerId' | 'side' | 'pos'>, opts: { range?: number; onWalls?: boolean; noCheck?: boolean } = {}): Mine { return fields.placeMine(this, owner, pos, m, opts) }
  mineVisibleTo(m: Mine, side: Side): boolean { return fields.mineVisibleTo(this, m, side) }
  mineTriggeredBy(m: Mine, u: Unit, before: Pos[]): boolean { return fields.mineTriggeredBy(this, m, u, before) }
  /** Detonate a mine (triggered by `by`, or remotely). */
  detonateMine(m: Mine, by?: Unit) { return fields.detonateMine(this, m, by) }
  /** Search for Mines (quick): a Systems check finds every hostile mine within Sensors. */
  searchMines(u: Unit, paid = false): number { return this.command('searchMines', [u, paid], () => fields.searchMines(this, u, paid)) }
  /** Disarm Mine (quick): a detected mine in an adjacent space; a failed Systems check sets it off. */
  disarmMine(u: Unit, m: Mine, paid = false) { return this.command('disarmMine', [u, m, paid], () => fields.disarmMine(this, u, m, paid)) }
  addArea(a: Omit<AreaEffect, 'id'>) { return fields.addArea(this, a) }

  customActions(u: Unit): CustomAction[] { return fields.customActions(this, u) }
  useCustom(u: Unit, a: CustomAction, target?: Unit | Pos) { return this.command('useCustom', [u, a, target], () => fields.useCustom(this, u, a, target)) }
}

export function other(s: Side): Side {
  return s === 'player' ? 'enemy' : 'player'
}

export function fmtAcc(n: number) {
  return n ? (n > 0 ? `+${n}` : `${n}`) : ''
}

export function stripHtml(s: string): string {
  return s.replace(/<br\s*\/?>/g, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
}

/** Probability that d20 + bonus + (net acc dice) >= def. */
export function hitChance(bonus: number, net: number, def: number): number {
  // distribution of accuracy modifier
  const n = Math.abs(net)
  const accDist: number[] = new Array(7).fill(0) // index = highest d6 value
  if (n === 0) accDist[0] = 1
  else for (let k = 1; k <= 6; k++) accDist[k] = Math.pow(k / 6, n) - Math.pow((k - 1) / 6, n)
  let p = 0
  for (let k = 0; k <= 6; k++) {
    if (!accDist[k]) continue
    const mod = net >= 0 ? k : -k
    const need = def - bonus - mod
    const pr = need <= 1 ? 1 : need > 20 ? 0 : (21 - need) / 20
    p += accDist[k] * pr
  }
  return p
}

export function actionLabel(action: string): string {
  if (action.startsWith('custom:')) return 'That system action'
  if (action.startsWith('tech:')) return 'That tech action'
  return action.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())
}
