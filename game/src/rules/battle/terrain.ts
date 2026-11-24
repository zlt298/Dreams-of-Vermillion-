// Battle engine: terrain. Methods of `Battle` live here as functions taking the battle (`bt`) first;
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
import { barrageOnly } from './actions'
import { useLockOn } from './tech'
import { AttackAim, AttackSummary, Battle, BattleEvent, ChoiceQuestion, Mine, MoveOpts, NEGATIVE, NO_NORMAL_ATTACK, PendingChoice, ReactionQuestion, Sitrep, actionLabel, averageRoll, fmtAcc, hitChance, maxOf, other, stripHtml } from './core'

/** Damage a terrain block. Every 10 damage knocks one level off; a block with no levels left becomes rubble. */
export function damageTerrain(bt: Battle, p: Pos, amount: number, opts: { source?: Unit; quiet?: boolean } = {}): boolean {
  const t = tileAt(bt.map, p)
  if (!t || t.kind !== 'block' || amount <= 0 || t.indestructible) return false
  const k = `${p.x},${p.y}`
  bt.touchTile(p)
  let dmg = (bt.terrainDamage.get(k) ?? 0) + amount
  let levels = 0
  while (dmg >= Battle.TERRAIN_SECTION_HP && t.h > 0) { dmg -= Battle.TERRAIN_SECTION_HP; t.h--; levels++ }
  if (t.h <= 0) { t.h = 0; t.kind = 'rubble'; dmg = 0 }
  bt.terrainDamage.set(k, dmg)
  if (!levels) { if (!opts.quiet) bt.say(`  The terrain takes ${amount} damage (${Battle.TERRAIN_SECTION_HP - dmg} left on this section).`); return false }
  bt.say(t.kind === 'rubble' ? '  The structure collapses into rubble!' : `  ${levels} level(s) of the structure are blown away.`, 'damage')
  bt.invalidateTerrain()
  bt.emit({ type: 'terrain', tiles: [{ ...p }] })
  return true
}

/** Objects in an area take automatic damage: deployables, and terrain blocks. */
export function damageObjectsIn(bt: Battle, tiles: Pos[], amount: number, opts: { source?: Unit; ap?: boolean } = {}) {
  for (const o of bt.alive().filter(o => (o.kind === 'deployable') && footprint(o).some(q => tiles.some(t => t.x === q.x && t.y === q.y)))) bt.applyDamage(o, [{ type: 'Explosive', amount }], { source: opts.source, ap: opts.ap })
  for (const p of tiles) bt.damageTerrain(p, amount, { source: opts.source, quiet: true })
}

/** Raise a size-1 section of hard cover on a free ground space (debris, barricades). */
export function raiseCover(bt: Battle, p: Pos, opts: { indestructible?: boolean; owner?: string } = {}): boolean {
  const t = tileAt(bt.map, p)
  if (!t || t.kind === 'block' || bt.alive().some(o => !o.flags.flat && footprint(o).some(q => q.x === p.x && q.y === p.y))) return false
  bt.touchTile(p)
  t.h += 1
  t.kind = 'block'
  if (opts.indestructible) t.indestructible = true
  if (opts.owner) t.owner = opts.owner
  bt.terrainDamage.delete(`${p.x},${p.y}`)
  bt.invalidateTerrain()
  bt.emit({ type: 'terrain', tiles: [{ ...p }] })
  return true
}

/** Skirmish against a terrain block: attack roll vs Evasion 5, weapon damage to the section. */
export function attackTerrain(bt: Battle, u: Unit, w: Weapon, p: Pos): AttackSummary {
  const t = tileAt(bt.map, p)
  if (!t || t.kind !== 'block') return { ctxs: [], ok: false, reason: 'Not a piece of terrain' }
  if (barrageOnly(w)) return { ctxs: [], ok: false, reason: 'Superheavy weapons require Barrage' }
  const c = bt.canSpend(u, 'quick', 'skirmish')
  if (c !== true) return { ctxs: [], ok: false, reason: c }
  const pre = bt.weaponUsable(u, w)
  if (pre !== true) return { ctxs: [], ok: false, reason: pre }
  if (distanceToTile(bt.map, u, p) > bt.weaponReach(u, w)) return { ctxs: [], ok: false, reason: 'Out of range' }
  bt.spend(u, 'quick', 'skirmish')
  bt.markFired(u, w)
  const pr = bt.profile(w)
  const roll = bt.rollD20(u, 'attack') + (w.attackBonus ?? u.stats.attackBonus)
  bt.say(`${u.name} attacks the terrain with ${w.name}: ${roll} vs Evasion 5.`, 'attack')
  if (hasTag(pr.tags, 'tg_loading')) w.loaded = false
  if (w.usesLeft != null) w.usesLeft--
  if (roll >= 5) {
    const dmg = pr.damage.filter(d => d.type !== 'Heat' && d.type !== 'Burn').reduce((n, d) => n + rollDice(bt.rng, d.val).total, 0)
    bt.damageTerrain(p, dmg, { source: u })
  } else bt.say('  Miss.')
  return { ctxs: [], ok: true }
}

export function markFired(bt: Battle, u: Unit, w: Weapon) {
  u.flags['turn:fired'] = [...(u.flags['turn:fired'] ?? []), w.uid]
}

export function boost(bt: Battle, u: Unit) {
  const c = bt.canSpend(u, 'quick', 'boost')
  if (c !== true) throw new Error(c)
  if (bt.has(u, 'slowed') || bt.has(u, 'immobilized')) throw new Error('Cannot boost while slowed/immobilized')
  if (bt.has(u, 'prone')) throw new Error('Cannot boost while prone (stand up first)') // Prone characters are Slowed
  if (bt.has(u, 'grappled')) throw new Error('Cannot boost while grappling or grappled')
  bt.spend(u, 'quick', 'boost')
  const extra = u.bonuses.filter(b => b.id === 'boost').reduce((a, b) => a + Number(b.val), 0)
  u.moveLeft += u.stats.speed + extra
  u.boostedThisTurn = true
  if (bt.has(u, 'hidden')) bt.removeStatus(u, 'hidden')
  bt.say(`${u.name} BOOSTS (+${u.stats.speed + extra} move).`)
  u.flags['round:boosted'] = true
  for (const o of bt.alive()) for (const s of scriptsFor(o)) s.onAnyMovementAction?.(bt, o, u, 'boost')
}

/** Standing up takes the standard move: only on your own turn, before moving, and not while Stunned or Immobilized. */
export function canStandUp(bt: Battle, u: Unit): true | string {
  if (!bt.has(u, 'prone')) return 'Not prone'
  if (!u.activeTurn) return 'Not this unit’s turn'
  if (bt.has(u, 'stunned')) return 'Stunned'
  if (bt.has(u, 'immobilized')) return 'Immobilized'
  if (u.flags['turn:moved'] || u.moveLeft < u.stats.speed) return 'Standard move already used'
  return true
}

export function standUp(bt: Battle, u: Unit) {
  if (!bt.has(u, 'prone')) return
  const ok = bt.canStandUp(u)
  if (ok !== true) throw new Error(ok)
  u.moveLeft = 0
  bt.removeStatus(u, 'prone')
}

export function overcharge(bt: Battle, u: Unit) {
  if (u.kind !== 'mech') throw new Error('Only mechs can overcharge')
  if (!u.activeTurn || u.overchargedThisTurn) throw new Error('Already overcharged this turn')
  if (bt.has(u, 'stunned') || bt.has(u, 'bracing_recovery') || u.flags.noOvercharge) throw new Error('Cannot overcharge')
  const track = (u.bonuses.find(b => b.id === 'overcharge')?.val as string[]) ?? (Lancer.rules.overcharge as string[])
  const cost = rollDice(bt.rng, track[Math.min(u.overchargeLevel, track.length - 1)]).total
  u.overchargeLevel = Math.min(u.overchargeLevel + 1, track.length - 1)
  u.overchargedThisTurn = true
  u.flags.bonusQuick = (u.flags.bonusQuick ?? 0) + 1
  bt.say(`${u.name} OVERCHARGES (+${cost} heat) — gains a quick action.`, 'status')
  bt.addHeat(u, cost)
}

/** Conditions Stabilize can end (core p.71): any condition, but not the Immobilized a grapple imposes. */
const STABILIZE_CONDITIONS: StatusId[] = ['impaired', 'slowed', 'immobilized', 'jammed', 'shredded', 'lockon', 'stunned']
/** Instances of `id` on `x` that Stabilize may clear: not caused by `x`'s own systems or talents, not a grapple's hold. */
function clearableInstances(x: Unit, id: StatusId): StatusInstance[] {
  return x.statuses.filter(s => s.id === id && s.source !== x.id && !s.data?.grapple)
}
/** Remove just these instances; the status only ends (with its events) when no instance is left. */
export function removeInstances(bt: Battle, u: Unit, drop: StatusInstance[]) {
  for (const id of new Set(drop.map(s => s.id))) {
    if (u.statuses.some(s => s.id === id && !drop.includes(s))) u.statuses = u.statuses.filter(s => !drop.includes(s))
    else bt.removeStatus(u, id)
  }
}

export function stabilize(bt: Battle, u: Unit, mode: 'cool' | 'repair', clear?: { unit: Unit; status?: StatusId | 'burn' | 'reload' }) {
  const c = bt.canSpend(u, 'full')
  if (c !== true) throw new Error(c)
  // NPC Stabilize (core p.281): cools and reloads every Loading weapon; NPCs don't repair, clear burn or clear conditions
  if (u.kind === 'npc') {
    if (mode === 'repair') throw new Error('NPCs cannot repair')
    if (clear && (clear.unit !== u || (clear.status && clear.status !== 'reload'))) throw new Error('NPC Stabilize only cools and reloads')
    bt.spend(u, 'full')
    for (const s of scriptsFor(u)) s.onStabilize?.(bt, u)
    u.heat = 0
    bt.removeStatus(u, 'exposed')
    const unloaded = u.weapons.filter(w => !w.loaded && !w.destroyed)
    unloaded.forEach(w => (w.loaded = true))
    if (unloaded.length) u.flags.reloaded = true
    bt.say(`${u.name} STABILIZES: cools reactor${unloaded.length ? ' and reloads' : ''}.`)
    return
  }
  // Stabilize ends burn on your own mech, reloads, or clears one condition (yours or an adjacent ally's)
  const tgt = clear?.unit ?? u
  if (tgt !== u) {
    if (bt.hostile(u, tgt) || tgt.destroyed) throw new Error('Stabilize can only help an ally')
    if (!bt.adjacent(u, tgt)) throw new Error('The ally must be adjacent')
  }
  if (clear?.status) {
    if (clear.status === 'burn' || clear.status === 'reload') { if (tgt !== u) throw new Error(`Stabilize can only ${clear.status === 'burn' ? 'clear burn on' : 'reload'} your own mech`) }
    else if (!STABILIZE_CONDITIONS.includes(clear.status)) throw new Error(`Stabilize can't clear ${clear.status}`)
    else if (!clearableInstances(tgt, clear.status).length) throw new Error(bt.has(tgt, clear.status) ? `That ${clear.status} was caused by ${tgt === u ? 'your' : 'its'} own systems` : `Not ${clear.status}`)
  }
  if (mode === 'repair' && u.repairs <= 0) throw new Error('No repairs left')
  if (mode === 'repair' && u.flags.briareosZero) throw new Error("Can't regain HP until a Full Repair (Briareos Frame)")
  bt.spend(u, 'full')
  for (const s of scriptsFor(u)) s.onStabilize?.(bt, u)
  if (mode === 'cool') {
    u.heat = 0
    bt.removeStatus(u, 'exposed')
    bt.say(`${u.name} STABILIZES: cools reactor.`)
    if (u.flags.adaptiveReactor && u.stress < u.stats.stress && u.repairs >= 2) { u.repairs -= 2; u.stress++; bt.say('  Adaptive Reactor repairs 1 stress.') }
  } else {
    u.repairs--
    u.hp = u.stats.hp
    bt.say(`${u.name} STABILIZES: spends a repair, HP restored.`)
  }
  // second choice: reload all Loading weapons, clear burn, or clear a condition (own or adjacent ally's)
  const conditionOf = (x: Unit) => STABILIZE_CONDITIONS.find(id => clearableInstances(x, id).length)
  const unloaded = u.weapons.filter(w => !w.loaded && !w.destroyed)
  let choice = clear?.status
  if (!choice) {
    // more than one useful option: the player picks (the AI and autoplay take the first)
    const opts: { id: StatusId | 'burn' | 'reload'; label: string }[] = []
    if (tgt === u && u.burn > 0) opts.push({ id: 'burn', label: `Clear burn (${u.burn})` })
    const cond = conditionOf(tgt)
    if (cond) opts.push({ id: cond, label: `Clear ${cond}` })
    if (tgt === u && unloaded.length) opts.push({ id: 'reload', label: `Reload ${unloaded.map(w => w.name).join(', ')}` })
    choice = opts.length > 1
      ? opts[bt.choose({ kind: 'stabilize_option', unit: u, title: 'Stabilize', text: 'Also choose one:', options: opts.map(o => ({ label: o.label })), defaultIndex: 0 })]?.id
      : opts[0]?.id
  }
  if (choice === 'reload') { unloaded.forEach(w => (w.loaded = true)); if (unloaded.length) { u.flags.reloaded = true; bt.say(`${u.name} reloads all Loading weapons.`) } }
  else if (choice === 'burn') { u.burn = 0; bt.say(`${u.name}'s burn is extinguished.`) }
  else if (choice) removeInstances(bt, tgt, clearableInstances(tgt, choice))
  if (u.flags.machineBond) for (const s of ['impaired', 'jammed', 'immobilized', 'slowed', 'lockon'] as const) {
    const inst = u.statuses.find(x => x.id === s)
    if (inst && inst.source !== u.id) bt.removeStatus(u, s)
  }
}

export function disengage(bt: Battle, u: Unit) {
  const c = bt.canSpend(u, 'full')
  if (c !== true) throw new Error(c)
  bt.spend(u, 'full')
  u.flags['turn:disengaged'] = true
  bt.say(`${u.name} DISENGAGES (ignores engagement and reactions this turn).`)
}

/** Hide: needs to be out of LoS of all hostiles or in cover from them. */
export function canHide(bt: Battle, u: Unit): boolean {
  if (u.flags.trackedBy && !bt.unit(u.flags.trackedBy)?.destroyed) return false
  if (bt.inRevealField(u)) return false
  if (bt.has(u, 'invisible')) return true
  // Prowl (Infiltrator): Hide even in plain sight during your own turn
  if (u.flags.prowl && u.activeTurn && !bt.isEngaged(u)) return true
  if (bt.isEngaged(u)) return false
  const insideSoft = footprint(u).every(p => tileAt(bt.map, p)?.kind === 'forest' || bt.areas.some(a => a.kind === 'soft_cover' && a.tiles.some(t => t.x === p.x && t.y === p.y)))
  return bt.alive().filter(o => bt.hostile(u, o) && (o.kind === 'mech' || o.kind === 'npc')).every(o => {
    if (!bt.los(o, u)) return true
    const c = bt.cover(o, u)
    return c === 'hard' || (c === 'soft' && insideSoft)
  })
}

export function hide(bt: Battle, u: Unit) {
  const c = bt.canSpend(u, 'quick', 'hide')
  if (c !== true) throw new Error(c)
  if (!bt.canHide(u)) throw new Error('Need cover or to be out of sight of all hostiles')
  bt.spend(u, 'quick', 'hide')
  bt.addStatus(u, 'hidden')
}

export function search(bt: Battle, u: Unit) {
  const c = bt.canSpend(u, 'quick', 'search')
  if (c !== true) throw new Error(c)
  bt.spend(u, 'quick', 'search')
  for (const o of bt.alive()) {
    if (!bt.hostile(u, o) || !bt.has(o, 'hidden') || bt.distance(u, o) > u.stats.sensors) continue
    // contested check (core p.69): ties go to the one who started it
    const roll = contestTotal(bt, u, 'sys')
    const opp = contestTotal(bt, o, 'agi')
    if (roll >= opp) { bt.removeStatus(o, 'hidden'); bt.say(`${u.name} finds ${o.name}!`) }
  }
}

/**
 * One side of a contested skill check: d20 + the stat + Accuracy/Difficulty from statuses, talents and Bolster
 * (core p.69). Stunned characters fail Hull and Agility checks outright.
 */
export function contestTotal(bt: Battle, u: Unit, stat: Stat): number {
  if ((stat === 'hull' || stat === 'agi') && bt.has(u, 'stunned')) return -Infinity
  const acc = bt.accuracyFromStatuses(u, 'check', stat)
  const d = bt.rollD20(u, 'check')
  return d + u.stats[stat] + rollAccuracy(bt.rng, acc).bonus
}
const fmtTotal = (n: number) => (n === -Infinity ? 'fails' : String(n))

/** Ram and Grapple are attacks: hidden, intangible or destroyed targets can't be chosen. */
export function meleeTargetValid(bt: Battle, u: Unit, t: Unit): true | string {
  if (t.destroyed) return 'Destroyed'
  if (t === u) return 'Cannot target self'
  if (t.flags.intangible || u.flags.intangible) return 'Intangible'
  if (bt.has(t, 'hidden') && bt.hostile(u, t)) return 'Hidden'
  return true
}

/** The status modifiers every attack gets (as buildWeaponCtx applies them), for Ram and Grapple. Attacking reveals a Hidden attacker. */
export function meleeAttackMods(bt: Battle, u: Unit, t: Unit, ctx: AttackCtx) {
  if (bt.has(u, 'impaired')) { ctx.difficulty++; ctx.reasons.push('Impaired -1') }
  if (bt.has(t, 'prone')) { ctx.accuracy++; ctx.reasons.push('Prone target +1') }
  if (bt.has(t, 'braced')) { ctx.difficulty++; ctx.reasons.push('Braced target -1') }
  useLockOn(bt, u, t, ctx)
  if (bt.has(u, 'hidden')) bt.removeStatus(u, 'hidden')
}

export function ram(bt: Battle, u: Unit, t: Unit) {
  const c = bt.canSpend(u, 'quick', 'ram')
  if (c !== true) throw new Error(c)
  if (!bt.adjacent(u, t)) throw new Error('Must be adjacent')
  if (t.stats.size > u.stats.size && !u.flags.muscleNet) throw new Error('Target is too large')
  const v = bt.meleeTargetValid(u, t)
  if (v !== true) throw new Error(v)
  bt.spend(u, 'quick', 'ram')
  const ctx = bt.newAttackCtx(u, t, { melee: true, ranged: false, mode: 'ram' })
  bt.meleeAttackMods(u, t, ctx)
  for (const s of scriptsFor(u)) s.beforeAttack?.(bt, u, ctx, 'attacker')
  bt.say(`${u.name} RAMS ${t.name}.`, 'attack')
  bt.rollToHit(ctx)
  if (ctx.hit) {
    bt.addStatus(t, 'prone', 'until_cleared', u)
    // core p.70: the attacker MAY also knock the target back 1 space
    if (!t.destroyed && bt.choose({ kind: 'ram_knockback', unit: u, other: t, title: 'Ram', text: `Also knock ${t.name} back 1 space?`, options: [{ label: 'Knock back' }, { label: 'Leave it in place' }], defaultIndex: 0 }) === 0) bt.forceMove(t, u, 1, 1)
  }
  for (const s of scriptsFor(u)) s.afterAttack?.(bt, u, ctx, 'attacker')
}

export function grapple(bt: Battle, u: Unit, t: Unit) {
  const c = bt.canSpend(u, 'quick', 'grapple')
  if (c !== true) throw new Error(c)
  if (!bt.adjacent(u, t)) throw new Error('Must be adjacent')
  const v = bt.meleeTargetValid(u, t)
  if (v !== true) throw new Error(v)
  bt.spend(u, 'quick', 'grapple')
  const ctx = bt.newAttackCtx(u, t, { melee: true, ranged: false, mode: 'grapple' })
  bt.meleeAttackMods(u, t, ctx)
  bt.say(`${u.name} attempts to GRAPPLE ${t.name}.`, 'attack')
  bt.rollToHit(ctx)
  if (ctx.hit) bt.startGrapple(u, t)
}

/** Begin a grapple (also used by systems such as Impale). */
export function startGrapple(bt: Battle, a: Unit, d: Unit) {
  if (a.destroyed || d.destroyed || bt.grapples.some(g => g.a === a.id && g.d === d.id)) return
  for (const s of scriptsFor(d)) if (s.blockStatus?.(bt, d, 'grappled', a)) { bt.say(`${d.name} can't be grappled.`, 'status'); return }
  if (d.immune.includes('grappled')) { bt.say(`${d.name} is immune to grapples.`, 'status'); return }
  bt.grapples.push({ a: a.id, d: d.id })
  bt.say(`${a.name} GRAPPLES ${d.name}.`, 'status')
  bt.syncGrapples()
}

/** Combined Size of everyone grappling `d`, against `d`'s own Size. */
export function grappleDominance(bt: Battle, g: { a: string; d: string; winner?: string }): 'attackers' | 'defender' {
  const d = bt.unit(g.d)!
  const attackers = bt.grapples.filter(x => x.d === g.d).map(x => bt.unit(x.a)).filter((x): x is Unit => !!x && !x.destroyed)
  const aSize = attackers.reduce((n, x) => n + x.stats.size, 0)
  if (aSize !== d.stats.size) return aSize > d.stats.size ? 'attackers' : 'defender'
  return g.winner === g.d ? 'defender' : 'attackers'
}

/** Units this one is holding or being held by, and whether it currently counts as the larger side. */
export function grappleInfo(bt: Battle, u: Unit): { partners: Unit[]; dominant: boolean; attacker: boolean; defender: boolean } {
  const mine = bt.grapples.filter(g => g.a === u.id || g.d === u.id)
  const partners = mine.map(g => bt.unit(g.a === u.id ? g.d : g.a)).filter((x): x is Unit => !!x)
  const dominant = mine.length > 0 && mine.every(g => (bt.grappleDominance(g) === 'attackers') === (g.a === u.id))
  return { partners, dominant, attacker: mine.some(g => g.a === u.id), defender: mine.some(g => g.d === u.id) }
}

/** Drop broken grapples (destroyed, no longer adjacent) and refresh Grappled/Immobilized. */
export function syncGrapples(bt: Battle) {
  const before = bt.grapples.length
  bt.grapples = bt.grapples.filter(g => {
    const a = bt.unit(g.a), d = bt.unit(g.d)
    const ok = !!a && !!d && !a.destroyed && !d.destroyed && bt.adjacent(a, d)
    if (!ok && a && d) bt.say(`The grapple between ${a.name} and ${d.name} breaks.`, 'status')
    return ok
  })
  const touched = new Set<Unit>()
  for (const u of bt.units) {
    const n = u.statuses.length
    u.statuses = u.statuses.filter(s => s.id !== 'grappled' && !(s.id === 'immobilized' && s.data?.grapple))
    if (u.statuses.length !== n) touched.add(u)
  }
  for (const g of bt.grapples) {
    const a = bt.unit(g.a)!, d = bt.unit(g.d)!
    a.statuses.push({ id: 'grappled', source: a.id, data: { by: a.id, with: d.id } })
    d.statuses.push({ id: 'grappled', source: a.id, data: { by: a.id } })
    const loser = bt.grappleDominance(g) === 'attackers' ? d : a
    if (!loser.statuses.some(s => s.id === 'immobilized' && s.data?.grapple)) loser.statuses.push({ id: 'immobilized', source: a.id, data: { grapple: true } })
    touched.add(a); touched.add(d)
  }
  if (touched.size || before !== bt.grapples.length) for (const u of touched) bt.emit({ type: 'status', unitId: u.id, status: 'grappled', added: bt.has(u, 'grappled') })
}

/** Same-size grapples: contested Hull check at the start of a turn decides who counts as larger. */
export function grappleContest(bt: Battle, u: Unit) {
  for (const g of bt.grapples.filter(x => x.a === u.id || x.d === u.id)) {
    const a = bt.unit(g.a), d = bt.unit(g.d)
    if (!a || !d) continue
    const attackersSize = bt.grapples.filter(x => x.d === g.d).reduce((n, x) => n + (bt.unit(x.a)?.stats.size ?? 0), 0)
    if (attackersSize !== d.stats.size) continue
    const iAmAttacker = g.a === u.id
    if ((bt.grappleDominance(g) === 'attackers') === iAmAttacker) continue // already on top
    const other = iAmAttacker ? d : a
    // the one who starts the contest wins ties (core p.13, p.69)
    const mine = contestTotal(bt, u, 'hull'), theirs = contestTotal(bt, other, 'hull')
    bt.say(`${u.name} contests the grapple (Hull ${fmtTotal(mine)} vs ${fmtTotal(theirs)}).`)
    if (mine >= theirs) { g.winner = u.id === g.d ? g.d : g.a; bt.say(`  ${u.name} gains the upper hand.`) }
  }
  bt.syncGrapples()
}

/** Defender: contested Hull check as a quick action to break free. */
export function breakGrapple(bt: Battle, u: Unit) {
  const c = bt.canSpend(u, 'quick', 'break_grapple')
  if (c !== true) throw new Error(c)
  const holds = bt.grapples.filter(g => g.d === u.id)
  if (!holds.length) throw new Error(bt.grapples.some(g => g.a === u.id) ? 'You are the grappler: release it as a free action' : 'Not grappled')
  bt.spend(u, 'quick', 'break_grapple')
  const best = holds.map(g => bt.unit(g.a)).filter((x): x is Unit => !!x).sort((x, y) => y.stats.hull - x.stats.hull)[0]
  // the defender starts this contest, so it wins ties
  const mine = contestTotal(bt, u, 'hull')
  const theirs = best ? contestTotal(bt, best, 'hull') : 0
  if (mine >= theirs || !best) {
    bt.grapples = bt.grapples.filter(g => g.d !== u.id)
    bt.say(`${u.name} breaks free (Hull ${fmtTotal(mine)} vs ${fmtTotal(theirs)}).`)
  } else bt.say(`${u.name} fails to break the grapple (Hull ${fmtTotal(mine)} vs ${fmtTotal(theirs)}).`)
  bt.syncGrapples()
}

/** Attacker: end your grapples as a free action (so only on your own turn). */
export function releaseGrapple(bt: Battle, u: Unit) {
  if (!bt.grapples.some(g => g.a === u.id)) throw new Error('Not grappling anyone')
  const c = bt.canSpend(u, 'free')
  if (c !== true) throw new Error(c)
  bt.grapples = bt.grapples.filter(g => g.a !== u.id)
  bt.say(`${u.name} releases its grapple.`)
  bt.syncGrapples()
}

/** The larger side drags the smaller along when it moves (mirroring its movement). */
export function dragGrappled(bt: Battle, u: Unit, from: Pos) {
  const info = bt.grappleInfo(u)
  if (!info.dominant) return
  const dx = u.pos.x - from.x, dy = u.pos.y - from.y
  if (!dx && !dy) return
  for (const p of info.partners) {
    if (p.destroyed) continue
    const want = { x: p.pos.x + dx, y: p.pos.y + dy }
    let dest: Pos | null = bt.dragSpot(p, want, u)
    if (!dest) continue
    bt.say(`${u.name} drags ${p.name} along.`)
    // involuntary movement through the normal machinery (mines, hazards, onMove scripts, hidden/zero-g updates);
    // grapples are re-checked once every partner has been dragged
    const outer = bt.draggingId
    bt.draggingId = p.id
    try { bt.followPath(p, [p.pos, dest]) } finally { bt.draggingId = outer }
  }
  bt.syncGrapples()
}

export function dragSpot(bt: Battle, p: Unit, want: Pos, holder: Unit): Pos | null {
  const free = (q: Pos) => footprint(p, q).every(t => tileAt(bt.map, t) && !bt.alive().some(o => o !== p && !o.flags.flat && footprint(o).some(z => z.x === t.x && z.y === t.y)))
  if (free(want) && bt.adjacent(holder, p, holder.pos) && chebyshev(want, holder.pos) <= Math.max(holder.stats.size, p.stats.size)) return want
  let best: Pos | null = null
  for (let dy = -p.stats.size - 1; dy <= holder.stats.size; dy++) for (let dx = -p.stats.size - 1; dx <= holder.stats.size; dx++) {
    const q = { x: holder.pos.x + dx, y: holder.pos.y + dy }
    if (!free(q)) continue
    const save = p.pos; p.pos = q
    const adj = bt.adjacent(holder, p)
    p.pos = save
    if (adj && (!best || chebyshev(q, want) < chebyshev(best, want))) best = q
  }
  return best
}

export function improvisedAttack(bt: Battle, u: Unit, t: Unit) {
  const c = bt.canSpend(u, 'full')
  if (c !== true) throw new Error(c)
  if (!bt.adjacent(u, t)) throw new Error('Must be adjacent')
  const refund = bt.checkpoint()
  bt.spend(u, 'full')
  const w: Weapon = {
    uid: 'improvised', name: 'Improvised Attack', mountIndex: -1, size: 'Main', type: 'Improvised', profileIndex: 0,
    profiles: [{ name: 'Improvised Attack', damage: [{ type: 'Kinetic', val: '1d6' }], range: [{ type: 'Threat', val: 1 }], tags: [], onAttack: [], onHit: [], onCrit: [] }],
    loaded: true, destroyed: false, charged: true, bonuses: [],
  }
  const brawler = u.bonuses.find(b => b.id === 'damage' && b.weapon_types?.includes('Improvised') && typeof b.val === 'string')
  if (brawler) w.profiles[0].damage = [{ type: 'Kinetic', val: brawler.val }]
  // NPC Improvised Attack (core p.281): fixed 3/4/6 kinetic by tier
  if (u.kind === 'npc') w.profiles[0].damage = [{ type: 'Kinetic', val: String([3, 4, 6][Math.min(3, Math.max(1, u.tier ?? 1)) - 1]) }]
  const r = bt.weaponAttack(u, w, { targetId: t.id }, 'improvised')
  if (!r.ok && !r.ctxs.length) { refund(); throw new Error(r.reason ?? 'Cannot attack') }
}

/**
 * There is no Reload action in LANCER: a mech reloads its Loading weapons with Stabilize (a full action) or
 * through specific gear and talents. Kept as a refusing stub so old replay files fail with a clear reason.
 */
export function reload(_bt: Battle, _u: Unit, _w: Weapon) {
  throw new Error('No quick-action reload: Stabilize reloads all Loading weapons')
}

export function shutDown(bt: Battle, u: Unit) {
  const c = bt.canSpend(u, 'quick', 'shut_down')
  if (c !== true) throw new Error(c)
  bt.spend(u, 'quick', 'shut_down')
  u.heat = 0
  bt.removeStatus(u, 'exposed')
  // core p.72: statuses and conditions caused by tech actions end (Lock On always comes from one); others stay.
  // A meltdown already counting down is not stopped.
  bt.removeStatus(u, 'lockon')
  removeInstances(bt, u, u.statuses.filter(s => s.data?.tech))
  bt.addStatus(u, 'shutdown')
}

export function bootUp(bt: Battle, u: Unit) {
  if (!u.activeTurn || !bt.has(u, 'shutdown')) throw new Error('Not shut down')
  if (u.statuses.some(x => x.id === 'stunned')) throw new Error('Stunned')
  if (u.actionsLeft < 2) throw new Error('Needs a full action')
  u.actionsLeft = 0
  u.actedThisTurn = true
  bt.removeStatus(u, 'shutdown')
  bt.say(`${u.name} boots up.`)
}

export function selfDestruct(bt: Battle, u: Unit) {
  const c = bt.canSpend(u, 'quick', 'self_destruct')
  if (c !== true) throw new Error(c)
  bt.spend(u, 'quick', 'self_destruct')
  u.selfDestructTurns = 2
  bt.say(`${u.name} initiates SELF-DESTRUCT! It will explode at the end of its next turn.`, 'warn')
}
