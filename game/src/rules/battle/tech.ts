// Battle engine: tech. Methods of `Battle` live here as functions taking the battle (`bt`) first;
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
import { AttackAim, AttackSummary, Battle, BattleEvent, ChoiceQuestion, Mine, MoveOpts, NEGATIVE, NO_NORMAL_ATTACK, PendingChoice, ReactionQuestion, Sitrep, actionLabel, averageRoll, fmtAcc, hitChance, maxOf, other, stripHtml } from './core'
import { seesHidden } from './attacks'

export function techTargetValid(bt: Battle, u: Unit, t: Unit, option?: string): true | string {
  if (bt.has(u, 'jammed')) return 'Jammed'
  // characters can't target themselves unless an item says so (core p.65)
  if (t === u) return 'Cannot target self'
  if (bt.inIceout(u)) return 'Inside an ICEOUT field: no tech actions'
  if (bt.inIceout(t)) return 'Target is protected by an ICEOUT field'
  if (t.flags.intangible || u.flags.intangible) return 'Intangible'
  if (u.flags.noAttacks && option === 'invade') return 'Cannot attack (retracted profile)'
  if (bt.isBlinded(u) && bt.distance(u, t) > 1) return 'Blinded: can only see adjacent spaces'
  if (t.role === 'Biological' && option !== 'scan' && option !== 'lock_on') return 'Biological characters are immune to tech actions (except Scan and Lock On)'
  if (t.destroyed) return 'Destroyed'
  if (bt.has(t, 'shutdown')) return 'Target is shut down (immune to tech)'
  if (t.flags.techImmune && t !== u) return 'Immune to tech actions'
  if (bt.hostile(u, t) && bt.has(t, 'hidden') && !seesHidden(bt, u, t)) return 'Hidden'
  // Jammed characters can't benefit from tech actions (core p.78): no Bolster or friendly Invade for them
  if (!bt.hostile(u, t) && bt.has(t, 'jammed') && option !== 'scan' && option !== 'lock_on') return 'Target is Jammed'
  if (bt.distance(u, t) > u.stats.sensors && !bt.viaMetahook(u, t)) return 'Out of sensor range'
  // Bolster only needs the target within Sensors; Scan, Lock On and Invade need line of sight (core p.69-70)
  if (option !== 'bolster' && !bt.los(u, t)) return 'No line of sight'
  return true
}

/**
 * Run a tech action: every status it puts on anyone is marked as caused by a tech action (`data.tech`), so Shut Down
 * can end exactly those (core p.72). A status merged into one already there keeps that one's origin.
 */
export function withTechScope<T>(bt: Battle, fn: () => T): T {
  const before = new Set<StatusInstance>()
  for (const x of bt.units) for (const s of x.statuses) before.add(s)
  try { return fn() } finally {
    // grapple holds are rebuilt on every sync: they aren't tech effects
    for (const x of bt.units) for (const s of x.statuses) if (!before.has(s) && s.id !== 'grappled' && !s.data?.grapple) s.data = { ...(s.data ?? {}), tech: true }
  }
}

/**
 * Lock On (core p.70): an attacker hostile to a Locked On target MAY take +1 Accuracy and clear it. Policy
 * `lockOn` on the attacker: unset/'auto' always uses it, 'off' never does, 'ask' asks each time.
 * `consume` false (previews) applies the bonus without clearing or asking.
 */
export function useLockOn(bt: Battle, u: Unit, t: Unit, ctx: AttackCtx, consume = true): boolean {
  if (!bt.has(t, 'lockon') || !bt.hostile(u, t)) return false
  const pol = u.policies?.lockOn ?? 'auto'
  if (pol === 'off') return false
  if (pol === 'ask' && consume && bt.choose({ kind: 'lock_on', unit: u, other: t, title: 'Lock On', text: `Use the Lock On on ${t.name} (+1 Accuracy, clears it)?`, options: [{ label: 'Use it' }, { label: 'Keep it' }], defaultIndex: 0 }) !== 0) return false
  ctx.accuracy++
  ctx.reasons.push('Lock On +1')
  if (consume) { bt.removeStatus(t, 'lockon'); ctx.lockOnConsumed = true }
  return true
}

/** Quick Tech can be taken more than once per turn, but a different option must be chosen each time
 * (Full Tech may pick the same option twice). Invasion options all count as the 'invade' option. */
export function spendTech(bt: Battle, u: Unit, option: string) {
  if (u.flags.freeTech) { delete u.flags.freeTech; return }
  if ((u.flags.fullTechLeft ?? 0) > 0) { u.flags.fullTechLeft--; u.actedThisTurn = true; return }
  bt.spend(u, 'quick', `quick_tech:${option}`)
}

export function canQuickTech(bt: Battle, u: Unit, option?: string): true | string {
  if (u.flags.hackSlash) return 'Hack/Slash: no tech actions until you reboot or Shut Down' // Hacker 2 (talents.ts)
  if (bt.inIceout(u)) return 'Inside an ICEOUT field: no tech actions'
  if (u.flags.freeTech) return true
  if ((u.flags.fullTechLeft ?? 0) > 0) return true
  return bt.canSpend(u, 'quick', option ? `quick_tech:${option}` : undefined)
}

/** Metahook: a linked ally's Sensors and line of sight count for your tech actions. */
export function viaMetahook(bt: Battle, u: Unit, t: Unit): boolean {
  const a = u.flags.metahook ? bt.unit(u.flags.metahook) : undefined
  return !!a && !a.destroyed && bt.distance(a, t) <= a.stats.sensors && bt.los(a, t)
}

/** A straight (orthogonal or diagonal) path to `dest`, or an error if there isn't one. */
export function straightPath(bt: Battle, u: Unit, dest: Pos, budget: number): { path: Pos[]; cost: number } {
  const dx = dest.x - u.pos.x, dy = dest.y - u.pos.y
  if (dx && dy && Math.abs(dx) !== Math.abs(dy)) throw new Error('Move in a straight line')
  const sx = Math.sign(dx), sy = Math.sign(dy), n = Math.max(Math.abs(dx), Math.abs(dy))
  const path: Pos[] = [{ ...u.pos }]
  let cost = 0
  const mover = new Set([u.id])
  for (let k = 1; k <= n; k++) {
    const q = { x: u.pos.x + sx * k, y: u.pos.y + sy * k }
    const pass = bt.passable(u, q, mover)
    if (pass === 'blocked' || (k === n && pass !== 'ok')) throw new Error('Something blocks the straight line')
    cost += bt.stepCost(u, path[k - 1], q)
    path.push(q)
  }
  if (cost > budget) throw new Error('Not enough movement')
  return { path, cost }
}

/** Interdiction Field and similar: may `u` teleport (out of where it is) to `p`? */
export function teleportBlocked(bt: Battle, u: Unit, p: Pos): boolean {
  return bt.alive().some(o => scriptsFor(o).some(sc => sc.blocksTeleport?.(bt, o, u, p)))
}

/** spaces a character may pass through but not end a move in (OASIS trail) */
export function endBlocked(bt: Battle, u: Unit, p: Pos): boolean {
  return bt.alive().some(o => scriptsFor(o).some(sc => sc.forbidsEndingAt?.(bt, o, u, p)))
}

/** Take one Quick Tech option without spending an action (reactions like Reactive Code). */
export function withFreeTech<T>(bt: Battle, u: Unit, fn: () => T): T {
  u.flags.freeTech = true
  try { return fn() } finally { delete u.flags.freeTech }
}

/** Full Tech: two quick tech actions. */
export function fullTech(bt: Battle, u: Unit) {
  if (u.flags.hackSlash) throw new Error('Hack/Slash: no tech actions until you reboot or Shut Down') // Hacker 2 (talents.ts)
  const c = bt.canSpend(u, 'full')
  if (c !== true) throw new Error(c)
  bt.spend(u, 'full')
  u.flags.fullTechLeft = 2
  bt.say(`${u.name} begins a FULL TECH action (2 quick techs).`)
}

/**
 * The roll for an INVADE: a tech attack against hostiles; a willing ally is invaded automatically
 * (no roll, it isn't an attack, and the caller deals no heat).
 */
export function invadeRoll(bt: Battle, u: Unit, t: Unit, label: string): AttackCtx {
  if (bt.hostile(u, t)) return bt.techAttackRoll(u, t, label)
  const ctx = bt.newAttackCtx(u, t, { tech: true, ranged: false, mode: 'tech', attackBonus: u.stats.techAttack })
  ctx.hit = true
  bt.say(`${u.name} — ${label} → ${t.name} (willing ally: automatic).`, 'attack')
  return ctx
}

export function techAttackRoll(bt: Battle, u: Unit, t: Unit, label: string): AttackCtx {
  const ctx = bt.newAttackCtx(u, t, { tech: true, ranged: false, mode: 'tech', attackBonus: u.stats.techAttack })
  if (bt.has(u, 'impaired')) ctx.difficulty++
  for (const b of u.bonuses) if (b.id === 'tech_attack' && b.accuracy) ctx.accuracy += b.accuracy
  for (const s of scriptsFor(u)) s.beforeAttack?.(bt, u, ctx, 'attacker')
  for (const s of scriptsFor(t)) s.beforeAttack?.(bt, t, ctx, 'target')
  for (const o of bt.alive()) for (const s of scriptsFor(o)) s.beforeAnyAttack?.(bt, o, ctx)
  // Prone, Braced and Lock On apply to every attack, tech included (after scripts, so Hacker's SNOW-CRASH can consume Lock On itself)
  if (bt.has(t, 'prone')) { ctx.accuracy++; ctx.reasons.push('Prone target +1') }
  if (bt.has(t, 'braced')) { ctx.difficulty++; ctx.reasons.push('Braced target -1') }
  useLockOn(bt, u, t, ctx)
  bt.say(`${u.name} — ${label} → ${t.name}.`, 'attack')
  if (bt.has(u, 'hidden')) bt.removeStatus(u, 'hidden')
  bt.rollToHit(ctx)
  // every tech attack (Invade and scripted ones like Markerlight) runs the after-attack hooks, as weapon attacks do:
  // SNOW_CRASH heat, //SCORPION on a miss, Thinking-Tomorrow's Thought on a hit…
  for (const s of scriptsFor(u)) s.afterAttack?.(bt, u, ctx, 'attacker')
  if (!t.destroyed) for (const s of scriptsFor(t)) s.afterAttack?.(bt, t, ctx, 'target')
  if (bt.reactionDepth < 2) {
    bt.reactionDepth++
    try { for (const o of bt.alive()) for (const s of scriptsFor(o)) s.afterAnyAttack?.(bt, o, ctx) } finally { bt.reactionDepth-- }
  }
  return ctx
}

export function invade(bt: Battle, u: Unit, t: Unit, option: 'fragment' | { name: string; effects: Effect[]; heat?: number } = 'fragment') {
  const c = bt.canQuickTech(u, 'invade')
  if (c !== true) throw new Error(c)
  if (t === u) throw new Error('Cannot invade yourself')
  const v = bt.techTargetValid(u, t)
  if (v !== true) throw new Error(v)
  bt.spendTech(u, 'invade')
  const wasActing = u.flags.techActing
  u.flags.techActing = true // a tech action in progress (//SCORPION, ICEOUT)
  try { return withTechScope(bt, () => {
    const ctx = bt.invadeRoll(u, t, option === 'fragment' ? 'INVADE: Fragment Signal' : `INVADE: ${option.name}`)
    if (ctx.hit) {
      if (bt.hostile(u, t)) bt.applyDamage(t, [{ type: 'Heat', amount: 2 }], { source: u, attack: ctx })
      if (option === 'fragment') {
        bt.addStatus(t, 'impaired', 'next_turn_end_target', u)
        // an NPC's Invade (core book p.280) deals 2 heat and Impairs; it doesn't Slow
        if (u.kind !== 'npc') bt.addStatus(t, 'slowed', 'next_turn_end_target', u)
      } else bt.runEffects(u, t, option.effects, ctx)
    }
    return ctx
  }) } finally { u.flags.techActing = wasActing }
}

export function lockOn(bt: Battle, u: Unit, t: Unit) {
  const c = bt.canQuickTech(u, 'lock_on')
  if (c !== true) throw new Error(c)
  const v = bt.techTargetValid(u, t, 'lock_on')
  if (v !== true) throw new Error(v)
  bt.spendTech(u, 'lock_on')
  bt.say(`${u.name} LOCKS ON to ${t.name}.`)
  bt.addStatus(t, 'lockon', 'until_cleared', u)
}

export function bolster(bt: Battle, u: Unit, t: Unit) {
  const c = bt.canQuickTech(u, 'bolster')
  if (c !== true) throw new Error(c)
  if (bt.hostile(u, t)) throw new Error('Bolster targets allies')
  if (t === u) throw new Error('Bolster targets another character')
  const v = bt.techTargetValid(u, t, 'bolster')
  if (v !== true) throw new Error(v)
  bt.spendTech(u, 'bolster')
  bt.say(`${u.name} BOLSTERS ${t.name}.`)
  withTechScope(bt, () => bt.addStatus(t, 'bolstered', 'next_turn_end_target', u))
}

export function scan(bt: Battle, u: Unit, t: Unit): string {
  const c = bt.canQuickTech(u, 'scan')
  if (c !== true) throw new Error(c)
  const v = bt.techTargetValid(u, t, 'scan')
  if (v !== true) throw new Error(v)
  bt.spendTech(u, 'scan')
  t.flags.scanned = true
  const info = `${t.name}: HP ${t.hp}/${t.stats.hp} ARM ${t.stats.armor} EVA ${t.stats.evasion} E-DEF ${t.stats.edef} HEAT ${t.heat}/${t.stats.heatcap} | ${t.weapons.map(w => w.name).join(', ')}${t.systems.length ? ' | ' + t.systems.map(s => s.name).join(', ') : ''}`
  bt.say(`SCAN — ${info}`)
  return info
}

export function activateCore(bt: Battle, u: Unit) {
  if (!u.frameId || !u.coreAvailable) throw new Error('Core power unavailable')
  const f = Lancer.frames.get(u.frameId)!
  const act = (f.core_system.activation ?? 'Quick').toLowerCase() as any
  const cost = act === 'protocol' ? 'protocol' : act === 'full' ? 'full' : act === 'free' ? 'free' : 'quick'
  const c = bt.canSpend(u, cost, cost === 'quick' ? 'core' : undefined)
  if (c !== true) throw new Error(c)
  bt.spend(u, cost, cost === 'quick' ? 'core' : undefined)
  u.coreAvailable = false
  u.coreActive = true
  bt.say(`${u.name} activates CORE POWER: ${f.core_system.active_name ?? f.core_system.name}!`, 'warn')
  if (f.core_system.active_bonuses) u.bonuses.push(...f.core_system.active_bonuses)
  let scripted = false
  for (const s of scriptsFor(u)) if (s.onCoreActivate) { s.onCoreActivate(bt, u); scripted = true }
  if (!scripted && !f.core_system.active_bonuses?.length) bt.say(`  ${stripHtml(f.core_system.active_effect ?? '')}`)
}
