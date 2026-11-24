// Battle engine: movement. Methods of `Battle` live here as functions taking the battle (`bt`) first;
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

export function passable(bt: Battle, u: Unit, at: Pos, mover: Set<string>): 'ok' | 'pass' | 'blocked' {
  for (const p of footprint(u, at)) {
    const t = tileAt(bt.map, p)
    if (!t) return 'blocked'
  }
  let res: 'ok' | 'pass' = 'ok'
  const fp = new Set(footprint(u, at).map(key))
  for (const o of bt.units) {
    if (o === u || mover.has(o.id)) continue
    // Blademaster Trip: pass through the tripped character this turn (not end there)
    if (u.flags['turn:tripThrough'] === o.id && footprint(o).some(p => fp.has(key(p)))) { res = 'pass'; continue }
    // phased out (FADE Cloak): pass through anything, but not end a move inside it
    if (u.flags.intangible && !o.destroyed && footprint(o).some(p => fp.has(key(p)))) { res = 'pass'; continue }
    if (o.destroyed && !o.flags.wreck) continue
    if (!footprint(o).some(p => fp.has(key(p)))) continue
    if (o.destroyed) { res = 'pass'; continue } // wreckage: difficult terrain you can cross (not end a move on, simplification)
    if (o.flags.flat) continue // flat deployables (plates, open-topped bunkers) don't obstruct
    if (o.kind === 'deployable' && !o.flags.isCover && o.stats.size < 1) continue
    // flyers ignore obstructions on the ground (core p.63): they pass over, but can't end a move there
    if (u.flying && !o.flying) { res = 'pass'; continue }
    // objects obstruct by Size, whoever they belong to (core p.62): a larger mover passes through, but can't end there
    if (o.kind === 'deployable') {
      if (o.stats.size >= u.stats.size) return 'blocked'
      res = 'pass'; continue
    }
    // characters (drones included): hostiles the same SIZE or larger obstruct, Hidden or not; smaller ones and
    // allies can be passed through. Prowl (Infiltrator): pass freely through enemy spaces during your own turn
    if (bt.hostile(u, o) && o.stats.size >= u.stats.size && !(u.flags.prowl && u.activeTurn)) return 'blocked'
    res = 'pass' // may pass through, but not end the move here
  }
  return res
}

/** Hover (Dusk Wing, Hornet; or a `hover` flag): flight without the straight-line and keep-moving rules (core p.63). */
const HOVER_SCRIPTS = new Set(['frame:mf_dusk_wing', 'npc:npcf_ssc_total_suite_hornet'])
export function hovers(bt: Battle, u: Unit): boolean {
  return !!u.flags.hover || scriptsFor(u).some(s => HOVER_SCRIPTS.has(s.id))
}

/** Systems, frames and NPC features that give flight or propulsion (zero-g: not Slowed, core p.63). */
const FLIGHT_SCRIPTS = new Set([
  'ms_type_i_flight_system', 'ms_rapid_burst_jump_jet_system', 'ms_eva_module', 'cb_all_theater_movement_suite',
  'frame:mf_dusk_wing', 'npc:npcf_ssc_flight_system_ace', 'npc:npcf_ssc_total_suite_hornet',
])
export function hasFlightSystem(bt: Battle, u: Unit): boolean {
  return !!u.flags.flightCapable || scriptsFor(u).some(s => FLIGHT_SCRIPTS.has(s.id))
}

/**
 * Must this unit's voluntary moves follow a straight line? Ramjet and OASIS Wall say so, and so does flight
 * (core p.63) unless the flyer hovers. Teleports, zero-g floating and intangible movement are exempt.
 */
export function straightMovesOnly(bt: Battle, u: Unit): boolean {
  if (u.flags.teleportMoves) return false
  if (scriptsFor(u).some(sc => sc.straightMovesOnly?.(bt, u))) return true
  return u.flying && !u.flags.zeroG && !u.flags.intangible && (u.kind === 'mech' || u.kind === 'npc') && !hovers(bt, u)
}

export function stepCost(bt: Battle, u: Unit, from: Pos, to: Pos): number {
  let c = 1
  if (u.flying || u.flags.intangible) return 1
  const fp = footprint(u, to)
  const difficult = bt.has(u, 'prone') || !u.flags.ignoreDifficult && fp.some(p => {
    const t = tileAt(bt.map, p)
    return t?.kind === 'rubble' || t?.kind === 'water' || bt.areas.some(a => a.kind === 'difficult' && a.tiles.some(q => q.x === p.x && q.y === p.y))
  }) || fp.some(p => bt.units.some(o => o.destroyed && o.flags.wreck && footprint(o).some(q => q.x === p.x && q.y === p.y)))
  if (difficult) c *= 2
  // climbing (core p.63): jump up to your Size in levels for free; each level beyond that is climbed at half speed
  const dh = elevationAt(bt.map, u, to) - elevationAt(bt.map, u, from)
  const jump = Math.max(1, Math.floor(u.stats.size))
  if (dh > jump && !u.flags.magClamps) c += 2 * (dh - jump)
  return c
}

export type ReachOpts = { ignoreEngagement?: boolean; noTakeOff?: boolean; anyPath?: boolean }

/**
 * Dijkstra over anchor positions. Returns reachable stop positions with cost and path. Straight-line movers
 * (flight without hover, Ramjet, OASIS Wall) only reach spaces along the 8 straight lines, unless `anyPath`.
 */
export function reachable(bt: Battle, u: Unit, budget: number, opts: ReachOpts = {}): Map<string, { pos: Pos; cost: number; prev?: string }> {
  // a landed flyer takes off to move (see move()): preview its moves as flying, restoring its state afterwards
  if (u.flags.landed && !u.flying && !opts.noTakeOff) {
    u.flying = true; u.flags.landed = false
    try { return reachableNow(bt, u, budget, opts) } finally { u.flying = false; u.flags.landed = true }
  }
  return reachableNow(bt, u, budget, opts)
}

/** Does entering `np` engage `u` with a hostile that stops its move (core p.62)? */
function engagementStops(bt: Battle, u: Unit, np: Pos, startAdj: Set<string>, opts: ReachOpts): boolean {
  // a Hidden mover isn't Engaged by anyone (engagement with a Hidden character is ignored both ways, core p.77)
  if (opts.ignoreEngagement || u.flags['turn:disengaged'] || u.kind === 'deployable' || bt.has(u, 'hidden')) return false
  for (const o of bt.alive()) {
    // characters engage, drones included (core p.78); Hidden ones don't (p.77)
    if (!bt.hostile(u, o) || startAdj.has(o.id) || (o.kind !== 'mech' && o.kind !== 'npc' && o.kind !== 'drone') || bt.has(o, 'hidden') || u.flags.feint === o.id) continue
    if ((o.stats.size >= u.stats.size || o.flags.localizedMaze) && bt.adjacent(u, o, np)) return true
  }
  return false
}

function reachableNow(bt: Battle, u: Unit, budget: number, opts: ReachOpts): Map<string, { pos: Pos; cost: number; prev?: string }> {
  const startKey = key(u.pos)
  const dist = new Map<string, { pos: Pos; cost: number; prev?: string; terminal: boolean; stop: boolean }>()
  const startAdj = new Set(bt.alive().filter(o => bt.hostile(u, o) && bt.adjacent(u, o)).map(o => o.id))
  dist.set(startKey, { pos: u.pos, cost: 0, terminal: false, stop: true })
  const open: string[] = [startKey]
  const mover = new Set([u.id])
  if (u.flags.teleportMoves) {
    // teleporting (core p.63): one jump to any free space within Speed (and what's left of the move), ignoring
    // terrain, obstacles and engagement. It spends that whole movement however far it goes (owner ruling).
    const range = Math.min(budget, u.stats.speed)
    const out = new Map<string, { pos: Pos; cost: number; prev?: string }>()
    out.set(startKey, { pos: u.pos, cost: 0 })
    for (let y = u.pos.y - range; y <= u.pos.y + range; y++) for (let x = u.pos.x - range; x <= u.pos.x + range; x++) {
      const np = { x, y }
      const c = Math.max(Math.abs(x - u.pos.x), Math.abs(y - u.pos.y))
      if (!c || c > range || bt.passable(u, np, mover) !== 'ok' || bt.teleportBlocked(u, np) || bt.endBlocked(u, np)) continue
      out.set(key(np), { pos: np, cost: range, prev: startKey })
    }
    ;(out as any).all = out
    return out
  }
  if (!opts.anyPath && straightMovesOnly(bt, u)) {
    // one straight line (orthogonal or diagonal) per move
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue
      let prevKey = startKey, prevPos = u.pos, cost = 0
      for (let k = 1; ; k++) {
        const np = { x: u.pos.x + dx * k, y: u.pos.y + dy * k }
        const pass = bt.passable(u, np, mover)
        if (pass === 'blocked') break
        cost += bt.stepCost(u, prevPos, np)
        if (cost > budget) break
        const nk = key(np)
        const terminal = engagementStops(bt, u, np, startAdj, opts)
        dist.set(nk, { pos: np, cost, prev: prevKey, terminal, stop: pass === 'ok' })
        if (terminal) break
        prevKey = nk; prevPos = np
      }
    }
  } else while (open.length) {
    open.sort((a, b) => dist.get(a)!.cost - dist.get(b)!.cost)
    const k = open.shift()!
    const cur = dist.get(k)!
    if (cur.terminal) continue
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue
      const np = { x: cur.pos.x + dx, y: cur.pos.y + dy }
      const pass = bt.passable(u, np, mover)
      if (pass === 'blocked') continue
      const c = cur.cost + bt.stepCost(u, cur.pos, np)
      if (c > budget) continue
      const nk = key(np)
      const prev = dist.get(nk)
      if (prev && prev.cost <= c) continue
      const terminal = engagementStops(bt, u, np, startAdj, opts)
      dist.set(nk, { pos: np, cost: c, prev: k, terminal, stop: pass === 'ok' })
      open.push(nk)
    }
  }
  const out = new Map<string, { pos: Pos; cost: number; prev?: string }>()
  for (const [k, v] of dist) if (v.stop && (k === startKey || !bt.endBlocked(u, v.pos))) out.set(k, v)
  // keep pass-through nodes for path reconstruction
  ;(out as any).all = dist
  return out
}

export function pathTo(bt: Battle, u: Unit, dest: Pos, budget: number, opts: ReachOpts = {}):{ path: Pos[]; cost: number } | null {
  const r = bt.reachable(u, budget, opts)
  const all: Map<string, any> = (r as any).all
  const d = r.get(key(dest))
  if (!d) return null
  const path: Pos[] = []
  let k: string | undefined = key(dest)
  while (k) {
    const n = all.get(k)
    path.unshift(n.pos)
    k = n.prev
  }
  return { path, cost: d.cost }
}

export function canMove(bt: Battle, u: Unit, mode: MoveOpts['mode']): true | string {
  if (mode === 'involuntary') return true
  if (bt.has(u, 'immobilized')) return 'Immobilized'
  if (bt.has(u, 'stunned')) return 'Stunned'
  if (bt.grapples.some(g => g.a === u.id || g.d === u.id) && !bt.grappleInfo(u).dominant) return 'Grappled (held by a larger side)'
  if (mode !== 'standard' && (bt.has(u, 'slowed') || bt.has(u, 'prone')) && mode !== 'disengage') return bt.has(u, 'slowed') ? 'Slowed' : 'Prone (Slowed)'
  return true
}

/** Move a unit along the cheapest path. Standard moves spend moveLeft. */
export function move(bt: Battle, u: Unit, dest: Pos, opts: MoveOpts = { mode: 'standard' }): boolean {
  const ok = bt.canMove(u, opts.mode)
  if (ok !== true) throw new Error(ok)
  // Mesmer Beacon: voluntary movement only toward the source
  const mes = u.flags.mesmerBy ? bt.unit(u.flags.mesmerBy) : undefined
  if (mes && !mes.destroyed && bt.round <= u.flags.mesmerUntil && opts.mode !== 'involuntary' && chebyshev(dest, mes.pos) >= chebyshev(u.pos, mes.pos)) throw new Error(`Mesmerized: can only move toward ${mes.name}`)
  const budget = opts.mode === 'standard' ? u.moveLeft : u.flags.pendingMove ?? u.stats.speed
  // a landed flyer takes off to move; pathing depends on it, so take off first and land again if the move is refused
  const takeOff = !!u.flags.landed && opts.mode !== 'involuntary'
  if (takeOff) { u.flying = true; u.flags.landed = false }
  let p: { path: Pos[]; cost: number } | null
  try {
    // teleporting movers (u.flags.teleportMoves) aren't held by engagement
    // flight (without hover), Ramjet, OASIS Wall: each voluntary move follows a straight line (reachable keeps to it)
    p = bt.pathTo(u, dest, budget, { ignoreEngagement: opts.ignoreEngagement || opts.mode === 'involuntary' || !!u.flags.teleportMoves, noTakeOff: opts.mode === 'involuntary', anyPath: opts.mode === 'involuntary' })
    // explain a refused straight-line move (straightPath throws the reason)
    if (!p && opts.mode !== 'involuntary' && straightMovesOnly(bt, u)) { bt.straightPath(u, dest, budget); throw new Error('Engagement stops the move before that space') }
    if (!p) throw new Error('Unreachable')
    if (opts.mode !== 'involuntary' && p.path.length > 1) for (const sc of scriptsFor(u)) { const v = sc.validateMove?.(bt, u, dest, p.path, opts.mode); if (v && v !== true) throw new Error(v) }
    if (p.path.length > 1) for (const o of bt.alive()) if (o !== u) for (const sc of scriptsFor(o)) { const v = sc.validateAnyMove?.(bt, o, u, dest, opts.mode); if (v && v !== true) throw new Error(v) }
  } catch (e) {
    if (takeOff) { u.flying = false; u.flags.landed = true }
    throw e
  }
  if (p.path.length <= 1) { if (takeOff) { u.flying = false; u.flags.landed = true } return true }
  if (takeOff) bt.say(`${u.name} takes off again.`)
  const snapshot = opts.mode === 'standard'
    ? { unitId: u.id, pos: { ...u.pos }, moveLeft: u.moveLeft, acted: u.actedThisTurn, moved: !!u.flags['turn:moved'], round: bt.round, startEvents: bt.eventCount, endEvents: -1 }
    : null
  bt.lastMove = null
  if (opts.mode === 'standard') u.moveLeft -= p.cost
  else if (u.flags.pendingMove != null) u.flags.pendingMove = Math.max(0, u.flags.pendingMove - p.cost)
  if (opts.mode !== 'involuntary') { u.actedThisTurn = true; u.flags['turn:moved'] = true }
  if (opts.mode === 'standard') for (const o of bt.alive()) for (const s of scriptsFor(o)) s.onAnyMovementAction?.(bt, o, u, 'standard')
  // overwatch triggers at the start of voluntary movement
  if (opts.mode !== 'involuntary' && !u.flags['turn:disengaged']) bt.triggerOverwatch(u)
  if (u.destroyed) return false
  if (bt.has(u, 'stunned') || bt.has(u, 'immobilized')) return false
  const movedFrom = { ...u.pos }
  // the larger side of a grapple drags its partner along: check adjacency only after the drag
  const drags = opts.mode !== 'involuntary' && bt.grapples.length > 0 && bt.grappleInfo(u).dominant
  if (drags) bt.draggingId = u.id
  try { bt.followPath(u, p.path) } finally { bt.draggingId = null }
  if (drags && !u.destroyed) bt.dragGrappled(u, movedFrom)
  // undo is only allowed if the move revealed/triggered nothing: its sole event is the move itself
  if (snapshot) {
    const last = bt.events[bt.events.length - 1]
    if (bt.eventCount - snapshot.startEvents === 1 && last?.type === 'move' && last.unitId === u.id && !u.destroyed) {
      snapshot.endEvents = bt.eventCount
      bt.lastMove = snapshot
    }
  }
  return true
}

export function canUndoMove(bt: Battle, u: Unit): boolean {
  const m = bt.lastMove
  return !!m && m.unitId === u.id && u.activeTurn && m.round === bt.round && bt.eventCount === m.endEvents
}

export function undoMove(bt: Battle, u: Unit) {
  if (!bt.canUndoMove(u)) throw new Error('Nothing to undo (or the move triggered something)')
  const m = bt.lastMove!
  bt.lastMove = null
  const from = { ...u.pos }
  u.pos = m.pos
  u.moveLeft = m.moveLeft
  u.actedThisTurn = m.acted
  if (!m.moved) delete u.flags['turn:moved']
  bt.say(`${u.name} reconsiders its move.`)
  bt.emit({ type: 'move', unitId: u.id, path: [from, m.pos] })
}

/**
 * Move along an explicit path (straight swings, scripted dashes): same triggers as a normal move, Overwatch
 * included (core p.73: any voluntary movement started in Threat), unless the movement provokes no reactions.
 */
export function moveAlong(bt: Battle, u: Unit, path: Pos[], opts: { noReactions?: boolean } = {}) {
  if (path.length < 2) return
  u.actedThisTurn = true
  u.flags['turn:moved'] = true
  if (!opts.noReactions && u.kind !== 'deployable' && !u.flags['turn:disengaged']) {
    bt.triggerOverwatch(u)
    if (u.destroyed || bt.has(u, 'stunned') || bt.has(u, 'immobilized')) return
  }
  bt.followPath(u, path)
}

export function followPath(bt: Battle, u: Unit, path: Pos[]) {
  let maxDrop = 0
  let prevE = elevationAt(bt.map, u, path[0])
  let lowest = prevE
  for (let si = 1; si < path.length; si++) {
    const step = path[si]
    const e = elevationAt(bt.map, u, step)
    // a teleport (a jump between non-adjacent spaces) lands on its destination: it is never a fall (core p.63)
    const teleport = chebyshev(path[si - 1], step) > 1
    if (e < prevE && !teleport) maxDrop = Math.max(maxDrop, prevE - e)
    prevE = e
    lowest = Math.min(lowest, e)
    const before = footprint(u, path[si - 1])
    u.pos = step
    // mines: triggered on entering a space next to them (or over them), never on leaving
    if (bt.mines.length && (u.kind === 'mech' || u.kind === 'npc')) for (const m of [...bt.mines]) {
      if (bt.mineTriggeredBy(m, u, before)) bt.detonateMine(m, u)
      if (u.destroyed) break
    }
    // dangerous terrain (core p.62): once per round, an Engineering check or 5 damage of the hazard's type; flyers pass over it
    if (!u.flying) hazardCheck(bt, u)
    if (u.destroyed) break
  }
  bt.emit({ type: 'move', unitId: u.id, path })
  for (const o of bt.alive()) for (const s of scriptsFor(o)) s.onMove?.(bt, o, u, path)
  if (!u.flying && maxDrop >= 3 && !u.destroyed) {
    const dmg = Math.min(9, 3 * Math.floor(maxDrop / 3))
    bt.say(`${u.name} falls ${maxDrop} spaces.`)
    bt.applyDamage(u, [{ type: 'Kinetic', amount: dmg }], { ap: true })
  }
  if (bt.grapples.length && bt.draggingId !== u.id) bt.syncGrapples()
  if (u.flags.zeroG || bt.areas.some(a => a.kind === 'zero_g')) bt.syncZeroG(u)
  // Hidden is lost by anyone (not just the mover) a hostile can now see without cover
  recheckHidden(bt)
  bt.updateEngagementTerminal(u)
}

/** Dangerous terrain (core p.62): entering it or ending a turn in it, once per round: Engineering check or 5 damage. */
export function hazardCheck(bt: Battle, u: Unit) {
  if (u.destroyed || u.flags.ignoreHazard || u.flags['round:hazard']) return
  const tile = footprint(u).map(q => tileAt(bt.map, q)).find(t => t?.kind === 'hazard')
  if (!tile) return
  u.flags['round:hazard'] = true
  // the hazard's damage type (kinetic, energy, explosive or burn) defaults to Energy
  if (!bt.check(u, 'eng')) bt.applyDamage(u, [{ type: tile.hazardType ?? 'Energy', amount: 5 }], {})
}

/**
 * Does `u` keep Hidden where it stands (core p.69)? It's lost once a hostile can draw line of sight to it without
 * the cover that hid it. Invisible characters keep it anywhere, and Prowl keeps it through the Infiltrator's own turn.
 */
export function keepsHidden(bt: Battle, u: Unit): boolean {
  if (u.flags.trackedBy && !bt.unit(u.flags.trackedBy)?.destroyed) return false
  if (u.flags.prowl && u.activeTurn) return true
  if (bt.has(u, 'invisible') && !bt.inRevealField(u)) return true
  const insideSoft = footprint(u).every(p => tileAt(bt.map, p)?.kind === 'forest' || bt.areas.some(a => a.kind === 'soft_cover' && a.tiles.some(t => t.x === p.x && t.y === p.y)))
  return bt.alive().filter(o => bt.hostile(u, o) && (o.kind === 'mech' || o.kind === 'npc')).every(o => {
    if (!bt.los(o, u)) return true
    const c = bt.cover(o, u)
    return c === 'hard' || (c === 'soft' && insideSoft)
  })
}

/**
 * Re-check every Hidden character: after any unit moves, after terrain changes or cover is destroyed, and when
 * Invisible ends. Those no longer in cover from every hostile that can see them lose Hidden.
 */
export function recheckHidden(bt: Battle) {
  if ((bt as any).recheckingHidden) return
  const hidden = bt.alive().filter(u => u.statuses.some(s => s.id === 'hidden'))
  if (!hidden.length) return
  ;(bt as any).recheckingHidden = true
  try {
    for (const u of hidden) if (!u.destroyed && bt.has(u, 'hidden') && !keepsHidden(bt, u)) bt.removeStatus(u, 'hidden')
  } finally { (bt as any).recheckingHidden = false }
}

/** Push/pull (involuntary). dir: +1 away from source, -1 toward source. */
export function forceMove(bt: Battle, target: Unit, source: Unit | Pos, spaces: number, dir: 1 | -1) {
  if (target.destroyed || spaces <= 0) return
  if (target.kind === 'deployable' && target.stats.speed === 0) return
  const srcUnit = 'stats' in (source as any) ? (source as Unit) : undefined
  for (const s of scriptsFor(target)) if (s.canBeMoved && !s.canBeMoved(bt, target, srcUnit)) { bt.say(`${target.name} holds its ground.`); return }
  for (const o of bt.alive()) for (const s of scriptsFor(o)) if (s.preventAnyMove?.(bt, o, target, srcUnit)) { bt.say(`${target.name} is anchored in place.`); return }
  for (const o of bt.alive()) for (const s of scriptsFor(o)) s.onAnyMovementAction?.(bt, o, target, 'involuntary')
  if (target.destroyed) return
  const sc = 'stats' in (source as any) ? center(source as Unit) : { x: (source as Pos).x + 0.5, y: (source as Pos).y + 0.5 }
  const path: Pos[] = [target.pos]
  for (let i = 0; i < spaces; i++) {
    const tc = center(target)
    let vx = (tc.x - sc.x) * dir, vy = (tc.y - sc.y) * dir
    if (dir === -1 && Math.max(Math.abs(tc.x - sc.x), Math.abs(tc.y - sc.y)) <= footprintSize(target) / 2 + 1) break
    const step = { x: Math.sign(Math.round(vx * 10) / 10), y: Math.sign(Math.round(vy * 10) / 10) }
    if (!step.x && !step.y) break
    const np = { x: target.pos.x + step.x, y: target.pos.y + step.y }
    // constructs that dissipate when something is pushed into them (H0R_OS Ideal Image)
    for (const o of bt.alive()) if (o.flags.dissipateOnPush && footprint(o).some(q => footprint(target, np).some(r => r.x === q.x && r.y === q.y))) bt.removeUnit(o, 'dissipates')
    if (bt.alive().some(o => scriptsFor(o).some(sc => sc.blockForcedStep?.(bt, o, target, target.pos, np)))) { bt.say(`${target.name} is stopped by a barrier.`); break }
    // involuntary movement passes through allies and smaller characters (core p.62), but can't end there (below)
    if (bt.passable(target, np, new Set([target.id])) === 'blocked') {
      bt.say(`${target.name} slams into an obstacle.`)
      break
    }
    const climb = elevationAt(bt.map, target, np) - elevationAt(bt.map, target, target.pos)
    if (climb > 1 && !target.flying) { bt.say(`${target.name} slams into a wall.`); break }
    target.pos = np
    path.push(np)
  }
  const self = new Set([target.id])
  while (path.length > 1 && (bt.passable(target, path[path.length - 1], self) !== 'ok' || bt.endBlocked(target, path[path.length - 1]))) { path.pop(); target.pos = path[path.length - 1] }
  if (path.length > 1) {
    bt.say(`${target.name} is ${dir === 1 ? 'knocked back' : 'pulled'} ${path.length - 1}.`)
    bt.followPath(target, path)
  }
}
