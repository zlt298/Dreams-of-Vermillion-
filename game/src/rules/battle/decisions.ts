// Battle engine: decisions. Methods of `Battle` live here as functions taking the battle (`bt`) first;
// the class in ./core.ts keeps a typed one-line stub for each.
import type { DamageData, RangeData, TagData, BonusData } from '../../data/lancer'
import { Lancer } from '../../data/lancer'
import {
  type AreaEffect, type GridMap, type Cover, tileAt, footprint, elevationAt, unitElevation, distanceBetween,
  distanceToTile, hasLineOfSight, hasLineOfSightToTile, coverBetween, burstTiles, blastTiles, lineTiles, coneTiles,
  unitsOnTiles, key, chebyshev, center, footprintSize,
} from '../grid'
import { parseDice, Rng, rollDice, rollAccuracy, averageDice } from '../rng'
import { hasTag, tagVal, nextUid, isWeaponType } from '../stats'
import type { Duration, Effect, LogEntry, Pos, Profile, Side, Stat, StatusId, StatusInstance, Unit, UnitPolicies, Weapon } from '../types'
import { type FieldOverlay, type AttackCtx, type CustomAction, type DamageCtx, scriptsFor } from '../effects/registry'
import { genericActionsFor } from '../effects/generic'
import { AttackAim, AttackSummary, Battle, BattleEvent, ChoiceQuestion, Mine, MoveOpts, NEGATIVE, NO_NORMAL_ATTACK, PendingChoice, ReactionQuestion, Sitrep, actionLabel, averageRoll, fmtAcc, hitChance, maxOf, other, stripHtml } from './core'

/** Let `u` take a forced action it has no action economy for (Law of Blades): costs are paid from a temporary pool. */
export function withForcedAction<T>(bt: Battle, u: Unit, fn: () => T): T {
  const keep = { actionsLeft: u.actionsLeft, acted: u.actedThisTurn, quick: u.flags['turn:quickUsed'], spent: u.flags['turn:spent'], bonus: u.flags.bonusQuick }
  const recovering = u.statuses.filter(s => s.id === 'bracing_recovery')
  u.statuses = u.statuses.filter(s => s.id !== 'bracing_recovery')
  u.actionsLeft = 2
  u.flags['turn:quickUsed'] = []
  try { return fn() } finally {
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
  bt.sandboxDepth++
  const areas = bt.areas.slice(), mines = bt.mines.slice(), lastMove = bt.lastMove
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
    weapons: u.weapons.map(w => ({ w, loaded: w.loaded, usesLeft: w.usesLeft, charged: w.charged, destroyed: w.destroyed, profileIndex: w.profileIndex })),
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
      for (const w of x.weapons) Object.assign(w.w, { loaded: w.loaded, usesLeft: w.usesLeft, charged: w.charged, destroyed: w.destroyed, profileIndex: w.profileIndex })
      for (const s of x.systems) Object.assign(s.s, { destroyed: s.destroyed, usesLeft: s.usesLeft, charged: s.charged })
    }
    bt.units.length = nUnits
    bt.areas = areas
    bt.mines = mines
    bt.lastMove = lastMove
    bt.rng.state = rng
    bt.log.length = logLen
    bt.events.length = evLen
    bt.eventCount = evCount
    bt.sandboxDepth--
    bt.listeners = listeners
  }
}

/**
 * Deep snapshot of all mutable battle state; the returned function restores it in place (unit,
 * weapon and system objects keep their identity so the UI's references stay valid). Render
 * listeners are not involved: use `transaction` to hold events back until a command succeeds.
 */
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
  const SKIP = new Set(['units', 'map', 'rng', 'log', 'events', 'listeners', 'chooser', 'answers', 'txDepth', 'mapCache', 'losCache', 'coverCache', 'cacheVersion', 'terrainVersion'])
  const self = bt as any
  const rest: Record<string, any> = {}
  for (const k of Object.keys(self)) if (!SKIP.has(k) && typeof self[k] !== 'function') rest[k] = dc(self[k])
  const rng = bt.rng.state, log = bt.log.slice(), events = bt.events.slice()
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
    bt.log.splice(0, bt.log.length, ...log)
    bt.events.splice(0, bt.events.length, ...events)
    bt.invalidateTerrain()
  }
}

/**
 * Run a player or AI command so it can be suspended for a decision: render events are held back
 * until it finishes; on PendingChoice the battle is rolled back and the question returned.
 */
export function transaction(bt: Battle, fn: () => void, answers: number[] = []): { pending: ChoiceQuestion } | { error?: Error } {
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
  if ('pending' in out) { restore(); return out }
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
  if (bt.answers.length) return clamp(bt.answers.shift()!)
  if (!bt.chooser || !bt.txDepth) return def // outside a transaction there is no way to suspend
  const r = bt.chooser(q)
  if (r === undefined) throw new PendingChoice(q)
  return clamp(r)
}

/** Yes/no scripted reaction for a player unit (policy 'reactions'); the AI answers `heuristic`. */
export function offerReaction(bt: Battle, u: Unit, kind: string, title: string, text: string, heuristic = true): boolean {
  if ((u.policies.reactions ?? 'ask') === 'off' && u.side === 'player') return false
  return bt.choose({ kind, unit: u, policy: 'reactions', title, text, options: [{ label: 'Yes' }, { label: 'No' }], defaultIndex: heuristic ? 0 : 1 }) === 0
}
