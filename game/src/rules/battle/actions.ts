// Battle engine: actions. Methods of `Battle` live here as functions taking the battle (`bt`) first;
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

export function skirmish(bt: Battle, u: Unit, w: Weapon, aim: AttackAim, aux?: { weapon: Weapon; aim: AttackAim }): AttackSummary {
  if (w.size === 'Superheavy') return { ctxs: [], ok: false, reason: 'Superheavy weapons require Barrage' }
  const c = bt.canSpend(u, 'quick', w.tech ? `tech:${w.uid}` : 'skirmish')
  if (c !== true) return { ctxs: [], ok: false, reason: c }
  const pre = bt.weaponUsable(u, w)
  if (pre !== true) return { ctxs: [], ok: false, reason: pre }
  if (bt.firedThisTurn(u, w)) return { ctxs: [], ok: false, reason: 'Each weapon can only attack once per turn' }
  bt.spend(u, 'quick', w.tech ? `tech:${w.uid}` : 'skirmish')
  bt.markFired(u, w)
  const r = bt.weaponAttack(u, w, aim, 'skirmish')
  if (aux && aux.weapon.size === 'Auxiliary' && aux.weapon !== w && aux.weapon.mountIndex === w.mountIndex && w.mountIndex >= 0 && !u.destroyed && !bt.firedThisTurn(u, aux.weapon)) {
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
  if (bt.firedThisTurn(u, a.weapon) || (b && bt.firedThisTurn(u, b.weapon))) return { ctxs: [], ok: false, reason: 'Each weapon can only attack once per turn' }
  const ua = bt.weaponUsable(u, a.weapon)
  if (ua !== true) return { ctxs: [], ok: false, reason: ua }
  bt.markFired(u, a.weapon)
  if (b) bt.markFired(u, b.weapon)
  if (a.weapon.size !== 'Superheavy' && !b) {
    // allowed but wasteful: barrage with one weapon
  }
  bt.spend(u, 'full')
  const r = bt.weaponAttack(u, a.weapon, a.aim, 'barrage')
  if (b && a.weapon.size !== 'Superheavy' && !u.destroyed) {
    const r2 = bt.weaponAttack(u, b.weapon, b.aim, 'barrage')
    r.ctxs.push(...r2.ctxs)
  }
  // additional AUXILIARY weapon on each mount that was fired (no bonus damage)
  const mounts = new Set([a.weapon.mountIndex, b?.weapon.mountIndex].filter((m): m is number => m != null && m >= 0))
  const usedMounts = new Set<number>()
  for (const x of auxes) {
    if (u.destroyed) break
    const m = x.weapon.mountIndex
    if (x.weapon.size !== 'Auxiliary' || !mounts.has(m) || usedMounts.has(m) || bt.firedThisTurn(u, x.weapon)) continue
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
  return u.weapons.filter(w => w.size === 'Auxiliary' && mounts.has(w.mountIndex) && !fired.includes(w) && !bt.firedThisTurn(u, w) && bt.weaponUsable(u, w) === true)
}

export function firedThisTurn(bt: Battle, u: Unit, w: Weapon): boolean {
  return (u.flags['turn:fired'] ?? []).includes(w.uid)
}
