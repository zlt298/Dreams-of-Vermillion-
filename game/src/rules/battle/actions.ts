// Battle engine: actions. Methods of `Battle` live here as functions taking the battle (`bt`) first;
// the class in ./core.ts keeps a typed one-line stub for each.
import type { DamageData, RangeData, TagData, BonusData } from '../../data/lancer'
import { Lancer } from '../../data/lancer'
import {
  type AreaEffect, type GridMap, type Tile, type Cover, tileAt, footprint, elevationAt, unitElevation, distanceBetween,
  distanceToTile, hasLineOfSight, hasLineOfSightToTile, coverBetween, burstTiles, blastTiles, lineTiles, coneTiles,
  unitsOnTiles, key, chebyshev, center, footprintSize,
} from '../grid'
import { parseDice, Rng, rollDice, rollAccuracy, averageDice } from '../rng'
import { hasTag, tagVal, nextUid, isWeaponType } from '../stats'
import type { Duration, Effect, LogEntry, Pos, Profile, Side, Stat, StatusId, StatusInstance, Unit, UnitPolicies, Weapon } from '../types'
import { type FieldOverlay, type AttackCtx, type CustomAction, type DamageCtx, scriptsFor } from '../effects/registry'
import { genericActionsFor } from '../effects/generic'
import { withTechScope } from './tech'
import { AttackAim, AttackSummary, Battle, BattleEvent, ChoiceQuestion, Mine, MoveOpts, NEGATIVE, NO_NORMAL_ATTACK, PendingChoice, ReactionQuestion, Sitrep, actionLabel, averageRoll, fmtAcc, hitChance, maxOf, other, stripHtml } from './core'

/** Superheavy weapons need a Barrage, unless the current profile's data says it can Skirmish (Leviathan, Standard profile). */
export function needsBarrage(w: Weapon): boolean {
  if (w.size !== 'Superheavy') return false
  const p = w.dataId ? (Lancer.weapons.get(w.dataId)?.profiles?.[w.profileIndex] as { skirmish?: boolean } | undefined) : undefined
  return !p?.skirmish
}

/** Core-C's name for the same check. */
export const barrageOnly = needsBarrage

export function skirmish(bt: Battle, u: Unit, w: Weapon, aim: AttackAim, aux?: { weapon: Weapon; aim: AttackAim }): AttackSummary {
  if (needsBarrage(w)) return { ctxs: [], ok: false, reason: 'Superheavy weapons require Barrage' }
  const c = bt.canSpend(u, 'quick', w.tech ? `tech:${w.uid}` : 'skirmish')
  if (c !== true) return { ctxs: [], ok: false, reason: c }
  const pre = bt.weaponUsable(u, w)
  if (pre !== true) return { ctxs: [], ok: false, reason: pre }
  const refund = bt.checkpoint()
  if (!u.actedThisTurn) u.flags['turn:ordnanceWindow'] = true // nothing came before this attack (see Ordnance)
  try { return skirmishInner(bt, u, w, aim, aux, refund) } finally { delete u.flags['turn:ordnanceWindow'] }
}
function skirmishInner(bt: Battle, u: Unit, w: Weapon, aim: AttackAim, aux: { weapon: Weapon; aim: AttackAim } | undefined, refund: () => void): AttackSummary {
  bt.spend(u, 'quick', w.tech ? `tech:${w.uid}` : 'skirmish')
  bt.markFired(u, w)
  const r = w.tech ? withTechScope(bt, () => bt.weaponAttack(u, w, aim, 'skirmish')) : bt.weaponAttack(u, w, aim, 'skirmish')
  // an attack refused before anything was rolled (bad target, out of range...) costs nothing
  if (!r.ok && !r.ctxs.length) { refund(); return r }
  if (aux && aux.weapon.size === 'Auxiliary' && aux.weapon !== w && aux.weapon.mountIndex === w.mountIndex && w.mountIndex >= 0 && !u.destroyed) {
    bt.markFired(u, aux.weapon)
    const r2 = bt.weaponAttack(u, aux.weapon, aux.aim, 'skirmish', { noBonusDamage: true })
    r.ctxs.push(...r2.ctxs)
  }
  return r
}

export function barrage(bt: Battle, u: Unit, a: { weapon: Weapon; aim: AttackAim }, b?: { weapon: Weapon; aim: AttackAim }, auxes: { weapon: Weapon; aim: AttackAim }[] = []): AttackSummary {
  const c = bt.canSpend(u, 'full')
  if (c !== true) return { ctxs: [], ok: false, reason: c }
  if (b && a.weapon === b.weapon) return { ctxs: [], ok: false, reason: 'Barrage needs two different weapons' }
  // core p.71: two weapons, or one Superheavy weapon (which takes the whole Barrage); one ordinary weapon is allowed
  if (b && (a.weapon.size === 'Superheavy' || b.weapon.size === 'Superheavy')) return { ctxs: [], ok: false, reason: 'A Superheavy weapon takes the whole Barrage' }
  const ua = bt.weaponUsable(u, a.weapon)
  if (ua !== true) return { ctxs: [], ok: false, reason: ua }
  const refund = bt.checkpoint()
  if (!u.actedThisTurn) u.flags['turn:ordnanceWindow'] = true // nothing came before this attack (see Ordnance)
  try { return barrageInner(bt, u, a, b, auxes, refund) } finally { delete u.flags['turn:ordnanceWindow'] }
}
function barrageInner(bt: Battle, u: Unit, a: { weapon: Weapon; aim: AttackAim }, b: { weapon: Weapon; aim: AttackAim } | undefined, auxes: { weapon: Weapon; aim: AttackAim }[], refund: () => void): AttackSummary {
  bt.markFired(u, a.weapon)
  if (b) bt.markFired(u, b.weapon)
  bt.spend(u, 'full')
  const fire = (w: Weapon, aim: AttackAim) => w.tech ? withTechScope(bt, () => bt.weaponAttack(u, w, aim, 'barrage')) : bt.weaponAttack(u, w, aim, 'barrage')
  const r = fire(a.weapon, a.aim)
  if (b && !u.destroyed) {
    const r2 = fire(b.weapon, b.aim)
    r.ctxs.push(...r2.ctxs)
    if (r2.ok) r.ok = true
    else if (!r.ok && !r2.ok) r.reason = r.reason ?? r2.reason
  }
  // neither weapon could attack: the Barrage costs nothing
  if (!r.ok && !r.ctxs.length) { refund(); return r }
  // additional AUXILIARY weapon on each mount that was fired (no bonus damage)
  const mounts = new Set([a.weapon.mountIndex, b?.weapon.mountIndex].filter((m): m is number => m != null && m >= 0))
  const usedMounts = new Set<number>()
  for (const x of auxes) {
    if (u.destroyed) break
    const m = x.weapon.mountIndex
    if (x.weapon.size !== 'Auxiliary' || !mounts.has(m) || usedMounts.has(m) || x.weapon === a.weapon || x.weapon === b?.weapon) continue
    const rx = bt.weaponAttack(u, x.weapon, x.aim, 'barrage', { noBonusDamage: true })
    if (!rx.ok) continue
    usedMounts.add(m)
    bt.markFired(u, x.weapon)
    r.ctxs.push(...rx.ctxs)
  }
  return r
}

/** Auxiliary weapons that may follow up a barrage/skirmish with these weapons. */
export function auxFollowUps(bt: Battle, u: Unit, fired: Weapon[]): Weapon[] {
  const mounts = new Set(fired.map(w => w.mountIndex).filter(m => m >= 0))
  return u.weapons.filter(w => w.size === 'Auxiliary' && mounts.has(w.mountIndex) && !fired.includes(w) && bt.weaponUsable(u, w) === true)
}

/** Has this weapon attacked this turn? A record only: weapons may attack again whenever the action allows it
 *  (a free Skirmish, Overcharge...). Items whose own text cares (UNCLE) read it. */
export function firedThisTurn(bt: Battle, u: Unit, w: Weapon): boolean {
  return (u.flags['turn:fired'] ?? []).includes(w.uid)
}
