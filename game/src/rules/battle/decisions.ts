// Battle engine: decisions. Methods of `Battle` live here as functions taking the battle (`bt`) first;
// the class in ./core.ts keeps a typed one-line stub for each.
import type { DamageData, RangeData, TagData, BonusData } from '../../data/lancer'
import { Lancer } from '../../data/lancer'
import {
  type AreaEffect, type GridMap, type Tile, type Cover, tileAt, footprint, elevationAt, unitElevation, distanceBetween,
  distanceToTile, hasLineOfSight, hasLineOfSightToTile, coverBetween, burstTiles, blastTiles, lineTiles, coneTiles,
  unitsOnTiles, key, chebyshev, center, footprintSize,
} from '../grid'
import { parseDice, Rng, rollDice, rollAccuracy, averageDice } from '../rng'
import { hasTag, tagVal, nextUid, isWeaponType, uidState, setUidState } from '../stats'
import type { Duration, Effect, LogEntry, Pos, Profile, Side, Stat, StatusId, StatusInstance, Unit, UnitPolicies, Weapon } from '../types'
import { type FieldOverlay, type AttackCtx, type CustomAction, type DamageCtx, scriptsFor } from '../effects/registry'
import { genericActionsFor } from '../effects/generic'
import { AttackAim, AttackSummary, Battle, BattleEvent, ChoiceQuestion, Mine, MoveOpts, NEGATIVE, NO_NORMAL_ATTACK, PendingChoice, ReactionQuestion, Sitrep, actionLabel, averageRoll, fmtAcc, hitChance, maxOf, other, stripHtml } from './core'

/** Let `u` take a forced action it has no action economy for (Law of Blades): costs are paid from a temporary pool. */
export function withForcedAction<T>(bt: Battle, u: Unit, fn: () => T): T {
  // copy the arrays: spend() pushes into turn:spent in place, which would leak the forced action into the turn's record
  // it may not be this unit's turn at all (Slave Systems): it acts as if it were, for the forced action only
  const keep = { activeTurn: u.activeTurn, actionsLeft: u.actionsLeft, acted: u.actedThisTurn, quick: u.flags['turn:quickUsed'], spent: u.flags['turn:spent'] ? [...u.flags['turn:spent']] : undefined, bonus: u.flags.bonusQuick }
  const recovering = u.statuses.filter(s => s.id === 'bracing_recovery')
  u.statuses = u.statuses.filter(s => s.id !== 'bracing_recovery')
  u.actionsLeft = 2
  u.activeTurn = true
  u.flags['turn:quickUsed'] = []
  try { return fn() } finally {
    u.activeTurn = keep.activeTurn
    u.actionsLeft = keep.actionsLeft; u.actedThisTurn = keep.acted
    u.flags['turn:quickUsed'] = keep.quick; u.flags['turn:spent'] = keep.spent; u.flags.bonusQuick = keep.bonus
    u.statuses.push(...recovering)
  }
}

/**
 * Run `fn` and then roll back every piece of mutable battle state it touched (units, statuses,
 * flags, equipment, areas, mines, rng, log/events). Object identity is preserved and render
 * listeners are muted, so previews and AI lookahead can safely call script hooks.
 */
export function sandbox<T>(bt: Battle, fn: () => T): T {
  const listeners = bt.listeners
  bt.listeners = []
  const rng = bt.rng.state, logLen = bt.log.length, evLen = bt.events.length, evCount = bt.eventCount, nUnits = bt.units.length
  // battle-level state too: a hook can make a real attack inside a preview, and a kill must not end the battle or the turn
  // tiles are saved only when a preview is about to change one (touchTile): copying the whole map per preview is too slow
  const restoreBattle = bt.snapshotBattleFields(false)
  const outerTiles = bt.sandboxTiles
  bt.sandboxTiles = new Map()
  bt.sandboxDepth++
  // areas and mines keep their identity but get their contents back: a preview may change one in place
  const plain = (v: any): any => Array.isArray(v) ? v.map(plain) : v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)])) : v
  const keepAll = <T extends object>(xs: T[]) => xs.map(o => ({ o, v: plain(o) }))
  const putBack = <T extends object>(xs: { o: T; v: any }[]) => xs.map(({ o, v }) => { for (const k of Object.keys(o)) if (!(k in v)) delete (o as any)[k]; return Object.assign(o, plain(v)) })
  const areas = keepAll(bt.areas), mines = keepAll(bt.mines), lastMove = bt.lastMove, uid = uidState()
  const snap = bt.units.map(u => ({
    u,
    v: {
      hp: u.hp, heat: u.heat, structure: u.structure, stress: u.stress, overshield: u.overshield, burn: u.burn, repairs: u.repairs,
      coreAvailable: u.coreAvailable, coreActive: u.coreActive, overchargeLevel: u.overchargeLevel, reactionsLeft: u.reactionsLeft,
      actionsLeft: u.actionsLeft, moveLeft: u.moveLeft, activationsLeft: u.activationsLeft, destroyed: u.destroyed, flying: u.flying,
      meltdownTurns: u.meltdownTurns, selfDestructTurns: u.selfDestructTurns, actedThisTurn: u.actedThisTurn, overchargedThisTurn: u.overchargedThisTurn,
    },
    pos: { ...u.pos },
    flags: { ...u.flags },
    statuses: u.statuses.map(s => ({ ...s })),
    bonuses: u.bonuses.slice(), resist: u.resist.slice(), immune: u.immune.slice(),
    // scripts reshape the attack profile (Ammo Case damage types, Thunder God AP): previews must not keep the change
    weapons: u.weapons.map(w => ({ w, loaded: w.loaded, usesLeft: w.usesLeft, charged: w.charged, destroyed: w.destroyed, profileIndex: w.profileIndex, profiles: w.profiles.map(p => ({ p, damage: p.damage.map(d => ({ ...d })), tags: p.tags.map(t => ({ ...t })) })) })),
    systems: u.systems.map(s => ({ s, destroyed: s.destroyed, usesLeft: s.usesLeft, charged: s.charged })),
    stats: { ...u.stats },
  }))
  try {
    return fn()
  } finally {
    for (const x of snap) {
      Object.assign(x.u, x.v)
      x.u.pos = x.pos
      x.u.flags = x.flags
      x.u.statuses = x.statuses
      x.u.bonuses = x.bonuses; x.u.resist = x.resist; x.u.immune = x.immune
      Object.assign(x.u.stats, x.stats)
      for (const w of x.weapons) {
        Object.assign(w.w, { loaded: w.loaded, usesLeft: w.usesLeft, charged: w.charged, destroyed: w.destroyed, profileIndex: w.profileIndex })
        for (const sp of w.profiles) { sp.p.damage = sp.damage; sp.p.tags = sp.tags }
      }
      for (const s of x.systems) Object.assign(s.s, { destroyed: s.destroyed, usesLeft: s.usesLeft, charged: s.charged })
    }
    bt.units.length = nUnits
    restoreBattle()
    if (bt.sandboxTiles?.size) {
      for (const [i, t] of bt.sandboxTiles) { const cur = bt.map.tiles[i] as any; for (const k of Object.keys(cur)) if (!(k in t)) delete cur[k]; Object.assign(cur, t) }
      bt.invalidateTerrain()
    }
    // nested preview: a tile the outer preview hadn't touched was, before the inner one, still as the outer preview found it
    if (outerTiles && bt.sandboxTiles) for (const [i, t] of bt.sandboxTiles) if (!outerTiles.has(i)) outerTiles.set(i, t)
    bt.sandboxTiles = outerTiles
    bt.areas = putBack(areas)
    bt.mines = putBack(mines)
    bt.lastMove = lastMove
    setUidState(uid)
    bt.rng.state = rng
    bt.log.length = logLen
    bt.events.length = evLen
    bt.eventCount = evCount
    bt.sandboxDepth--
    bt.listeners = listeners
  }
}

/** Call before changing a map tile: inside a preview, remember how it was so sandbox() can put it back. */
export function touchTile(bt: Battle, p: Pos) {
  if (!bt.sandboxTiles) return
  const i = p.y * bt.map.w + p.x
  if (!bt.sandboxTiles.has(i)) bt.sandboxTiles.set(i, { ...bt.map.tiles[i] })
}

/**
 * Snapshot of the battle's own fields (turn, side, round, winner, grapples, areas, terrain…) and the map tiles,
 * not the units: deep-copied, but references to units, weapons, systems and the map are kept as they are.
 */
export function snapshotBattleFields(bt: Battle, withTiles = true): () => void {
  const anchors = new Set<object>(bt.units)
  for (const u of bt.units) { for (const w of u.weapons) anchors.add(w); for (const x of u.systems) anchors.add(x) }
  anchors.add(bt.map)
  const dc = (v: any): any => {
    if (v === null || typeof v !== 'object' || anchors.has(v)) return v
    if (Array.isArray(v)) return v.map(dc)
    if (v instanceof Map) return new Map([...v].map(([k, x]) => [k, dc(x)]))
    if (v instanceof Set) return new Set([...v].map(dc))
    if (Object.getPrototypeOf(v) !== Object.prototype) return v
    const o: any = {}
    for (const k of Object.keys(v)) o[k] = dc(v[k])
    return o
  }
  const tiles = withTiles ? bt.map.tiles.map(t => ({ ...t })) : []
  const SKIP = new Set(['units', 'map', 'rng', 'log', 'events', 'listeners', 'chooser', 'answers', 'txDepth', 'record', 'commands', 'cmdDepth', 'currentCommand', 'sandboxDepth', 'sandboxTiles', 'mapCache', 'losCache', 'coverCache', 'cacheVersion', 'terrainVersion'])
  const self = bt as any
  const rest: Record<string, any> = {}
  for (const k of Object.keys(self)) if (!SKIP.has(k) && typeof self[k] !== 'function') rest[k] = dc(self[k])
  return () => {
    let terrain = false
    tiles.forEach((t, i) => {
      const cur = bt.map.tiles[i] as any
      if (cur.h !== t.h || cur.kind !== t.kind) terrain = true
      for (const k of Object.keys(cur)) if (!(k in t)) delete cur[k]
      Object.assign(cur, t)
    })
    for (const k of Object.keys(rest)) self[k] = dc(rest[k])
    if (terrain) bt.invalidateTerrain()
  }
}

export function checkpoint(bt: Battle): () => void {
  const anchors = new Set<object>(bt.units)
  for (const u of bt.units) { for (const w of u.weapons) anchors.add(w); for (const x of u.systems) anchors.add(x) }
  anchors.add(bt.map)
  const dc = (v: any): any => {
    if (v === null || typeof v !== 'object' || anchors.has(v)) return v
    if (Array.isArray(v)) return v.map(dc)
    if (v instanceof Map) return new Map([...v].map(([k, x]) => [k, dc(x)]))
    if (v instanceof Set) return new Set([...v].map(dc))
    if (Object.getPrototypeOf(v) !== Object.prototype) return v
    const o: any = {}
    for (const k of Object.keys(v)) o[k] = dc(v[k])
    return o
  }
  const fields = (o: any, skip: string[] = []) => { const r: any = {}; for (const k of Object.keys(o)) if (!skip.includes(k)) r[k] = dc(o[k]); return r }
  const units = bt.units.map(u => ({ u, f: fields(u, ['weapons', 'systems']), weapons: u.weapons.slice(), systems: u.systems.slice(), w: u.weapons.map(w => fields(w)), s: u.systems.map(x => fields(x)) }))
  const tiles = bt.map.tiles.map(t => ({ ...t }))
  const SKIP = new Set(['units', 'map', 'rng', 'log', 'events', 'listeners', 'chooser', 'answers', 'txDepth', 'record', 'mapCache', 'losCache', 'coverCache', 'cacheVersion', 'terrainVersion'])
  const self = bt as any
  const rest: Record<string, any> = {}
  for (const k of Object.keys(self)) if (!SKIP.has(k) && typeof self[k] !== 'function') rest[k] = dc(self[k])
  const rng = bt.rng.state, log = bt.log.slice(), events = bt.events.slice(), uid = uidState()
  const assign = (o: any, f: any) => { for (const k of Object.keys(o)) if (!(k in f)) delete o[k]; Object.assign(o, dc(f)) }
  return () => {
    for (const x of units) {
      assign(x.u, { ...x.f, weapons: x.u.weapons, systems: x.u.systems })
      x.u.weapons.splice(0, x.u.weapons.length, ...x.weapons)
      x.u.systems.splice(0, x.u.systems.length, ...x.systems)
      x.weapons.forEach((w, i) => assign(w, x.w[i]))
      x.systems.forEach((sy, i) => assign(sy, x.s[i]))
    }
    bt.units.splice(0, bt.units.length, ...units.map(x => x.u))
    tiles.forEach((t, i) => { const cur = bt.map.tiles[i] as any; for (const k of Object.keys(cur)) if (!(k in t)) delete cur[k]; Object.assign(cur, t) })
    for (const k of Object.keys(rest)) self[k] = dc(rest[k])
    bt.rng.state = rng
    setUidState(uid)
    bt.log.splice(0, bt.log.length, ...log)
    bt.events.splice(0, bt.events.length, ...events)
    bt.invalidateTerrain()
  }
}

/**
 * Run a player or AI command so it can be suspended for a decision: render events are held back
 * until it finishes; on PendingChoice the battle is rolled back and the question returned.
 */
export function transaction(bt: Battle, fn: () => void, answers: number[] = [], opts: { rollbackOnError?: boolean } = {}): { pending: ChoiceQuestion } | { error?: Error } {
  const restore = bt.checkpoint()
  const listeners = bt.listeners
  const held: BattleEvent[] = []
  bt.listeners = [e => held.push(e)]
  bt.answers = answers.slice()
  let out: { pending: ChoiceQuestion } | { error?: Error } = {}
  bt.txDepth++
  try {
    fn()
  } catch (e) {
    if (e instanceof PendingChoice) out = { pending: e.q }
    else out = { error: e as Error }
  } finally {
    bt.txDepth--
    bt.listeners = listeners
    bt.answers = []
  }
  // a pending decision is replayed later; a player command refused part-way (rollbackOnError) leaves the battle as it was.
  // AI turns don't roll back on error: the turn has already been ended, and undoing it would hand the same unit back forever.
  if ('pending' in out || (out.error && opts.rollbackOnError)) { restore(); return out }
  for (const e of held) for (const l of bt.listeners) l(e)
  return out
}

/** Resolve a reaction decision under the unit's policy. */
export function wantsReaction(bt: Battle, u: Unit, kind: 'brace' | 'overwatch', heuristic: boolean, other: Unit, text: string): boolean {
  const p = u.policies[kind]
  if (p === 'off') return false
  return bt.choose({ kind, unit: u, other, policy: kind, title: kind === 'brace' ? 'Brace?' : 'Overwatch?', text, options: [{ label: 'Yes' }, { label: 'No' }], defaultIndex: heuristic ? 0 : 1 }) === 0
}

/**
 * Ask a player-controlled unit a question. Enemies, AI-driven turns, sandboxes, policies other
 * than 'ask' and battles without a UI take `defaultIndex`.
 */
export function choose(bt: Battle, q: ChoiceQuestion): number {
  const clamp = (i: number) => Math.max(0, Math.min(q.options.length - 1, Math.floor(i)))
  const def = clamp(q.defaultIndex)
  if (q.options.length <= 1 || bt.sandboxDepth || q.unit.side !== 'player' || bt.aiSide === q.unit.side) return def
  const pol = q.policy ? (q.unit.policies[q.policy] ?? 'ask') : 'ask'
  if (pol !== 'ask') return def
  if (bt.answers.length) { const i = clamp(bt.answers.shift()!); bt.noteAnswer(i); return i }
  if (!bt.chooser || !bt.txDepth) return def // outside a transaction there is no way to suspend
  const r = bt.chooser(q)
  if (r === undefined) throw new PendingChoice(q)
  bt.noteAnswer(clamp(r))
  return clamp(r)
}

/** Yes/no scripted reaction for a player unit (policy 'reactions'); the AI answers `heuristic`. */
export function offerReaction(bt: Battle, u: Unit, kind: string, title: string, text: string, heuristic = true): boolean {
  if ((u.policies.reactions ?? 'ask') === 'off' && u.side === 'player') return false
  return bt.choose({ kind, unit: u, policy: 'reactions', title, text, options: [{ label: 'Yes' }, { label: 'No' }], defaultIndex: heuristic ? 0 : 1 }) === 0
}
