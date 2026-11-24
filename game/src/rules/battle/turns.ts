// Battle engine: turns. Methods of `Battle` live here as functions taking the battle (`bt`) first;
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
import { hazardCheck, hovers } from './movement'
import { AttackAim, AttackSummary, Battle, BattleEvent, ChoiceQuestion, Mine, MoveOpts, NEGATIVE, NO_NORMAL_ATTACK, PendingChoice, ReactionQuestion, Sitrep, actionLabel, averageRoll, fmtAcc, hitChance, maxOf, other, stripHtml } from './core'

export function start(bt: Battle) {
  bt.startRound()
}

export function startRound(bt: Battle) {
  bt.round++
  bt.emit({ type: 'round', round: bt.round })
  bt.say(`— Round ${bt.round} —`, 'turn')
  for (const u of bt.alive()) {
    u.activationsLeft = u.kind === 'mech' || u.kind === 'npc' ? u.stats.activations : 0
    u.reactionsLeft = bt.has(u, 'bracing_recovery') ? 0 : u.reactionsPerRound
    for (const k of Object.keys(u.flags)) if (k.startsWith('round:')) delete u.flags[k]
  }
  bt.areas = bt.areas.filter(a => a.expiresRound == null || a.expiresRound >= bt.round)
  bt.invalidateTerrain()
  for (const u of bt.alive()) {
    if (u.expiresRound != null && u.expiresRound < bt.round) bt.destroy(u, 'expired')
  }
  for (const u of bt.alive()) for (const s of scriptsFor(u)) s.onRoundStart?.(bt, u)
  // players open the battle; after that the turn order keeps alternating across rounds, so the side
  // that didn't take the last turn of the previous round goes first (core book: Turns and Rounds)
  bt.currentSide = bt.lastSide ? other(bt.lastSide) : bt.combatants('player').length ? 'player' : 'enemy'
  if (!bt.hasActivations(bt.currentSide)) bt.currentSide = other(bt.currentSide)
  bt.checkVictory()
}

export function hasActivations(bt: Battle, side: Side): boolean {
  return bt.combatants(side).some(u => u.activationsLeft > 0)
}

export function canActivate(bt: Battle, u: Unit): true | string {
  if (bt.winner) return 'Battle over'
  if (bt.activeId) return 'Another unit is acting'
  if (u.destroyed) return 'Destroyed'
  if (u.side !== bt.currentSide) return 'Not your side’s turn'
  if (u.activationsLeft <= 0) return 'Already activated this round'
  if (bt.chainTurn && bt.chainTurn !== u.id && bt.unit(bt.chainTurn)?.activationsLeft) return `${bt.unit(bt.chainTurn)!.name} acts next`
  return true
}

export function beginTurn(bt: Battle, u: Unit) {
  const ok = bt.canActivate(u)
  if (ok !== true) throw new Error(ok)
  if (bt.chainTurn === u.id) bt.chainTurn = null
  bt.activeId = u.id
  u.activationsLeft--
  u.activeTurn = true
  u.actionsLeft = 2
  u.flags.bonusQuick = 0
  u.overchargedThisTurn = false
  u.actedThisTurn = false
  u.boostedThisTurn = false
  u.flags.fullTechLeft = 0
  for (const k of Object.keys(u.flags)) if (k.startsWith('turn:')) delete u.flags[k]
  // "You can only take one reaction per turn – your turn or other characters' turns": refresh everyone's per-turn budget
  // (each specific reaction is 1/round on top of that: see canSpend; those refresh at round start)
  for (const o of bt.units) if (!o.destroyed) o.reactionsLeft = bt.has(o, 'bracing_recovery') ? 0 : o.reactionsPerRound
  bt.tickStatuses(u, true)
  if (bt.grapples.length) bt.grappleContest(u)
  bt.syncZeroG(u)
  u.moveLeft = u.stats.speed
  if (bt.has(u, 'bracing_recovery')) { u.actionsLeft = 1; u.moveLeft = 0 }
  // Shut Down counts as Stunned, but keeps its actions so it can Boot Up (a full action); canSpend refuses everything else
  if (u.statuses.some(x => x.id === 'stunned')) { u.actionsLeft = 0; u.moveLeft = 0 }
  else if (bt.has(u, 'shutdown')) u.moveLeft = 0
  if (bt.has(u, 'immobilized')) u.moveLeft = 0
  bt.emit({ type: 'turn', unitId: u.id })
  bt.say(`${u.name} activates.`, 'turn')
  // hazards at start of turn
  for (const a of bt.areas) if (a.kind === 'damage' && a.damage && footprint(u).some(p => a.tiles.some(t => t.x === p.x && t.y === p.y))) {
    const r = rollDice(bt.rng, a.damage)
    bt.applyDamage(u, [{ type: 'Energy', amount: r.total }], { source: bt.unit(a.ownerId) })
  }
  for (const s of scriptsFor(u)) s.onTurnStart?.(bt, u)
  for (const o of bt.alive()) if (o !== u) for (const s of scriptsFor(o)) s.onAnyTurnStart?.(bt, o, u)
  // drones/deployables owned by this unit act on its turn: refresh their flags
  for (const d of bt.alive().filter(d => d.ownerId === u.id)) for (const k of Object.keys(d.flags)) if (k.startsWith('turn:')) delete d.flags[k]
}

export function endTurn(bt: Battle, u: Unit = bt.active!) {
  if (!u || u.id !== bt.activeId) throw new Error('Not the active unit')
  // a character acting inside another's turn (Goblin INSTINCT Rig) hands the turn back
  if (bt.interjection?.unit === u.id) return endInterjection(bt, u)
  for (const o of bt.alive()) for (const s of scriptsFor(o)) s.beforeAnyTurnEnd?.(bt, o, u)
  if (u.id !== bt.activeId) return
  bt.endingTurnOf = u.id
  try { bt.endTurnInner(u) } finally { bt.endingTurnOf = null }
}

export function endTurnInner(bt: Battle, u: Unit) {
  if (bt.has(u, 'hidden') && bt.inRevealField(u)) bt.removeStatus(u, 'hidden')
  // Prowl ends with the turn: lose Hidden if exposed now
  if (u.flags.prowl && bt.has(u, 'hidden')) { u.activeTurn = false; const ok = bt.canHide(u); u.activeTurn = true; if (!ok) bt.removeStatus(u, 'hidden') }
  // flight (core p.63): a flyer that didn't move at least 1 space this turn falls (lands), unless it hovers
  if (!u.destroyed && u.flying && !u.flags['turn:moved'] && !u.flags.zeroG && !hovers(bt, u)) bt.land(u, 'stalls without moving')
  // dangerous terrain: ending a turn in it also requires the (once per round) Engineering check; flyers are above it
  if (!u.flying) hazardCheck(bt, u)
  // burn
  if (u.burn > 0 && !u.destroyed) {
    if (bt.check(u, 'eng')) { bt.say(`${u.name} clears burn.`); u.burn = 0 }
    else { bt.say(`${u.name} burns for ${u.burn}.`, 'damage'); bt.applyDamage(u, [{ type: 'Burn-tick', amount: u.burn }], {}) }
  }
  if (!u.destroyed) for (const s of scriptsFor(u)) s.onTurnEnd?.(bt, u)
  for (const o of bt.alive()) if (o !== u) for (const s of scriptsFor(o)) s.onAnyTurnEnd?.(bt, o, u)
  // reactor meltdown / self destruct
  if (!u.destroyed && u.meltdownTurns != null) {
    u.meltdownTurns--
    if (u.meltdownTurns <= 0) bt.reactorExplosion(u, 'reactor meltdown')
    else bt.say(`${u.name}'s reactor will melt down in ${u.meltdownTurns} turn(s)!`, 'warn')
  }
  if (!u.destroyed && u.selfDestructTurns != null) {
    u.selfDestructTurns--
    if (u.selfDestructTurns <= 0) bt.reactorExplosion(u, 'self-destruct')
  }
  u.flags.hiddenMoveCheck = false
  bt.tickStatuses(u, false)
  u.activeTurn = false
  bt.activeId = null
  bt.removeStatusIfExpiredRecovery(u)
  // areas that last until the end of a character's (next) turn
  if (bt.areas.some(a => a.expiresAfterTurnOf === u.id)) {
    for (const a of bt.areas) if (a.expiresAfterTurnOf === u.id) a.turnsLeft = (a.turnsLeft ?? 1) - 1
    bt.areas = bt.areas.filter(a => a.expiresAfterTurnOf !== u.id || (a.turnsLeft ?? 0) > 0)
    bt.invalidateTerrain()
  }
  for (const m of bt.mines) if (m.ownerId === u.id && !m.armed) { m.armed = true; bt.say(`${m.name} arms.`); bt.emit({ type: 'mine', mineId: m.id, pos: m.pos, added: true }) }
  bt.checkVictory()
  bt.handOverTurn(u)
}

/**
 * `u`'s turn has ended (normally, or by its destruction): pass the turn to whoever acts next
 * (a chained unit, the other side, the same side, or a new round). Does nothing once the battle is won.
 */
export function handOverTurn(bt: Battle, u: Unit) {
  if (bt.winner) return
  const chain = bt.chainTurn ? bt.unit(bt.chainTurn) : undefined
  if (chain && !chain.destroyed && chain.activationsLeft > 0) { bt.currentSide = chain.side; return }
  bt.chainTurn = null
  bt.lastSide = u.side
  const opp = other(u.side)
  if (bt.hasActivations(opp)) bt.currentSide = opp
  else if (bt.hasActivations(u.side)) bt.currentSide = u.side
  else bt.endRound()
}

export function endRound(bt: Battle) {
  if (bt.sitrep.id === 'holdout' && bt.sitrep.rounds && bt.round >= bt.sitrep.rounds) {
    bt.finish('player', `Held out for ${bt.sitrep.rounds} rounds!`)
    return
  }
  if (bt.sitrep.id === 'control' && bt.sitrep.zone) {
    const zone = new Set(bt.sitrep.zone.map(key))
    const pIn = bt.combatants('player').some(u => footprint(u).some(p => zone.has(key(p))))
    const eIn = bt.combatants('enemy').some(u => footprint(u).some(p => zone.has(key(p))))
    if (pIn && !eIn) {
      bt.sitrepScore = (bt.sitrepScore ?? 0) + 1
      bt.say(`Control point held (${bt.sitrepScore}/${bt.sitrep.rounds ?? 3}).`)
      if (bt.sitrepScore >= (bt.sitrep.rounds ?? 3)) { bt.finish('player', 'Control point secured!'); return }
    }
  }
  bt.startRound()
}

export function checkVictory(bt: Battle) {
  if (bt.winner) return
  // temporarily turned characters (OSIRIS Fourth Gate) still count for their own side
  const sideOf = (u: Unit) => (u.flags.turnedFrom as Side | undefined) ?? u.side
  const all = bt.combatants()
  const p = all.filter(u => sideOf(u) === 'player').length, e = all.filter(u => sideOf(u) === 'enemy').length
  if (p === 0) bt.finish('enemy', 'All lancers are down.')
  else if (e === 0) bt.finish('player', 'All hostiles destroyed.')
  else if (bt.sitrep.id === 'assassination' && bt.sitrep.targetId && bt.unit(bt.sitrep.targetId)?.destroyed) bt.finish('player', 'Target eliminated.')
  else if (bt.sitrep.id === 'extraction' && bt.sitrep.zone) {
    const zone = new Set(bt.sitrep.zone.map(key))
    const all = bt.combatants('player')
    if (all.length && all.every(u => footprint(u).some(q => zone.has(key(q))))) bt.finish('player', 'All lancers extracted!')
  }
}

export function finish(bt: Battle, w: Side, why: string) {
  if (bt.winner) return
  bt.winner = w
  bt.say(`${w === 'player' ? 'VICTORY' : 'DEFEAT'}: ${why}`, 'turn')
  bt.emit({ type: 'end', winner: w })
}

/**
 * Quick actions can't be repeated in a turn from the normal action pool, but a repeat can be
 * paid with a free-action quick (Overcharge, Everest Initiative, ASURA...).
 */
export function quickUsed(bt: Battle, u: Unit, action: string): boolean {
  return (u.flags['turn:quickUsed'] ?? []).includes(action)
}

export function canSpend(bt: Battle, u: Unit, cost: 'quick' | 'full' | 'protocol' | 'free' | 'reaction' | 'move', action?: string): true | string {
  if (u.destroyed) return 'Destroyed'
  if (cost === 'reaction') {
    // one reaction per turn (any character's turn); each specific reaction 1/round, refreshing at round start
    if (u.reactionsLeft <= 0) return 'Already reacted this turn'
    if (action && u.flags[`round:react:${action}`] && !(action === 'overwatch' && u.traits?.includes('reflex'))) return `${actionLabel(action)} already used this round`
    if (bt.has(u, 'grappled') && !(action === 'brace' && u.flags.braceWhileGrappled)) return 'Grappled'
    if (bt.has(u, 'stunned')) return 'Stunned'
    if (bt.has(u, 'jammed')) return 'Jammed'
    if (bt.has(u, 'bracing_recovery')) return 'Recovering from brace'
    return true
  }
  if (!u.activeTurn) return 'Not this unit’s turn'
  // Brace: the next turn allows only one quick action (or a full action with Drake Fortress), no free actions or protocols
  if ((cost === 'free' || cost === 'protocol') && bt.has(u, 'bracing_recovery')) return 'Recovering from brace'
  if (bt.has(u, 'stunned') && cost !== 'free') return 'Stunned'
  if (bt.has(u, 'stunned')) return 'Stunned'
  if (bt.has(u, 'shutdown')) return 'Shut down'
  if (cost === 'protocol') return u.actedThisTurn ? 'Protocols must be used at the start of a turn' : true
  if (cost === 'free') return true
  if (cost === 'quick') {
    // a free Ram or Grapple (Titanomachy Mesh) and similar: listed actions cost nothing, once
    if (action && (u.flags['turn:freeQuick'] ?? []).includes(action)) return true
    if (action && bt.quickUsed(u, action)) return (u.flags.bonusQuick ?? 0) > 0 ? true : `${actionLabel(action)} already taken this turn (repeat it via Overcharge or another free action)`
    return u.actionsLeft >= 1 || (u.flags.bonusQuick ?? 0) > 0 ? true : 'No actions left'
  }
  if (cost === 'full') {
    if (bt.has(u, 'bracing_recovery')) return u.flags.fortress && u.actionsLeft >= 1 ? true : 'Needs a full action' // Drake Fortress: a full action after Bracing
    return u.actionsLeft >= 2 ? true : 'Needs a full action'
  }
  return true
}

export function spend(bt: Battle, u: Unit, cost: 'quick' | 'full' | 'protocol' | 'free' | 'reaction', action?: string) {
  const ok = bt.canSpend(u, cost, action)
  if (ok !== true) throw new Error(ok)
  if (cost === 'reaction') {
    for (const o of bt.alive()) for (const sc of scriptsFor(o)) sc.onAnyAction?.(bt, o, u, 'reaction')
    u.reactionsLeft--
    if (u.flags.ghostweave && bt.has(u, 'invisible')) bt.removeStatus(u, 'invisible')
    if (action) u.flags[`round:react:${action}`] = true
    if (bt.has(u, 'hidden')) bt.removeStatus(u, 'hidden') // taking reactions reveals you
    return
  }
  if (cost !== 'protocol') u.actedThisTurn = true
  ;(u.flags['turn:spent'] ??= []).push(action ?? cost)
  for (const o of bt.alive()) for (const sc of scriptsFor(o)) sc.onAnyAction?.(bt, o, u, cost)
  if (cost === 'quick' && action && (u.flags['turn:freeQuick'] ?? []).includes(action)) {
    delete u.flags['turn:freeQuick']
    return
  }
  if (cost === 'quick') {
    // a repeated action must be paid from the free-action pool
    if ((action && bt.quickUsed(u, action)) || (u.flags.payWithBonus && (u.flags.bonusQuick ?? 0) > 0)) u.flags.bonusQuick--
    else if (u.actionsLeft >= 1) u.actionsLeft--
    else u.flags.bonusQuick--
    delete u.flags.payWithBonus
    if (action) u.flags['turn:quickUsed'] = [...(u.flags['turn:quickUsed'] ?? []), action]
  } else if (cost === 'full') u.actionsLeft = Math.max(0, u.actionsLeft - 2)
}

/**
 * `u` acts in the middle of `host`'s turn (Goblin INSTINCT Rig): two quick actions or one full action, no
 * movement or Overcharge. Ending its turn hands control back to the host, whose turn carries on.
 */
export function interject(bt: Battle, u: Unit, host: Unit) {
  if (bt.activeId !== host.id) throw new Error(`${host.name} is not acting`)
  if (bt.interjection) throw new Error('Someone is already acting inside this turn')
  bt.interjection = { unit: u.id, host: host.id }
  host.activeTurn = false
  bt.activeId = u.id
  u.activeTurn = true
  u.actionsLeft = u.statuses.some(x => x.id === 'stunned') ? 0 : 2
  u.flags.bonusQuick = 0
  u.overchargedThisTurn = false
  u.actedThisTurn = false
  u.boostedThisTurn = false
  u.flags.fullTechLeft = 0
  u.flags.noOvercharge = true
  u.moveLeft = 0
  bt.emit({ type: 'turn', unitId: u.id })
  bt.say(`${u.name} acts on ${host.name}'s turn.`, 'turn')
}
export function endInterjection(bt: Battle, u: Unit) {
  const host = bt.unit(bt.interjection?.host)
  bt.interjection = null
  u.activeTurn = false
  bt.say(`${u.name} hands control back${host ? ` to ${host.name}` : ''}.`, 'turn')
  if (host && !host.destroyed) { bt.activeId = host.id; host.activeTurn = true; bt.emit({ type: 'turn', unitId: host.id }) }
  else {
    // the host was destroyed during the interjection: its turn is over, so the turn passes on as usual
    bt.activeId = null
    bt.checkVictory()
    if (host) bt.handOverTurn(host)
  }
}
