// Battle engine: fields. Methods of `Battle` live here as functions taking the battle (`bt`) first;
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

/** Every persistent zone on the map (terrain areas, drone and system fields), for overlays and tooltips. */
export function fieldOverlays(bt: Battle): FieldOverlay[] {
  const out: FieldOverlay[] = []
  for (const a of bt.areas) {
    const owner = a.ownerId ? bt.unit(a.ownerId) : undefined
    out.push({
      tiles: a.tiles, ownerId: a.ownerId,
      effect: a.kind === 'damage' ? 'harm' : a.kind === 'difficult' ? 'terrain' : a.kind === 'zero_g' ? 'control' : 'protect',
      label: `${a.kind === 'damage' ? 'Damaging area' : a.kind === 'difficult' ? 'Difficult terrain' : a.kind === 'zero_g' ? "Zero-g: everyone can fly and can't fall; Slowed without a flight system" : 'Soft cover (obscured)'}${owner ? ` — ${owner.name}` : ''}`,
    })
  }
  // mines the player side knows about: its own, and detected hostile ones
  for (const m of bt.mines) {
    if (!bt.mineVisibleTo(m, 'player')) continue
    const owner = bt.unit(m.ownerId)
    const how = m.trigger === 'remote' ? 'detonated remotely' : m.trigger === 'over' ? 'goes off when a hostile moves onto it' : m.trigger === 'flying' ? 'goes off when a hostile flyer comes next to it' : m.trigger === 'ally' ? 'goes off when an ally comes next to it' : 'goes off when a hostile enters an adjacent space'
    out.push({ tiles: [m.pos], effect: 'harm', ownerId: m.ownerId, label: m.side === 'player' ? `${m.name}${owner ? ` (${owner.name})` : ''}: ${m.armed ? how : 'arms at the end of the turn'}` : `Hostile ${m.name} (detected): disarm it from an adjacent space` })
  }
  for (const o of bt.alive()) {
    if (o.flags.revealRadius) out.push({ tiles: burstTiles(bt.map, o, o.flags.revealRadius), effect: 'reveal', ownerId: o.ownerId, label: `${o.name}: hostiles can't Hide or stay Invisible` })
    if (o.flags.iceoutRadius) out.push({ tiles: burstTiles(bt.map, o, o.flags.iceoutRadius), effect: 'control', ownerId: o.ownerId, label: `${o.name}: no tech actions in or into the field` })
    for (const s of scriptsFor(o)) if (s.fields) out.push(...s.fields(bt, o).map(f => ({ ownerId: o.id, ...f })))
  }
  return out
}

/** Zero-g areas: characters inside can fly and can't fall, but are Slowed unless they already fly. */
export function syncZeroG(bt: Battle, u: Unit) {
  if (u.destroyed || (u.kind !== 'mech' && u.kind !== 'npc')) return
  const inside = bt.areas.some(a => a.kind === 'zero_g' && footprint(u).some(p => a.tiles.some(t => t.x === p.x && t.y === p.y)))
  if (inside && !u.flags.zeroG) {
    u.flags.zeroG = true
    u.flags.zeroGNative = u.flying
    if (!u.flying) { u.flying = true; u.statuses.push({ id: 'slowed', source: u.id, data: { zeroG: true } }); bt.say(`${u.name} floats in zero-g.`, 'status') }
  } else if (!inside && u.flags.zeroG) {
    u.flags.zeroG = false
    u.flying = !!u.flags.zeroGNative
    u.statuses = u.statuses.filter(s => !s.data?.zeroG)
    bt.say(`${u.name} leaves the zero-g area.`, 'status')
  }
}

/** A flyer falls to the ground (the battlefield models one level of altitude, so no fall damage). */
export function land(bt: Battle, u: Unit, why: string) {
  if (!u.flying || u.flags.zeroG) return
  u.flying = false
  u.flags.landed = true
  bt.invalidateTerrain()
  bt.say(`${u.name} ${why} and drops to the ground.`, 'status')
}

/** Blinded: line of sight only to adjacent spaces (flash bombs, Blind tech). */
export function isBlinded(bt: Battle, u: Unit): boolean {
  return u.flags.blindUntil != null && bt.round <= u.flags.blindUntil
}

/** d20 for an attack, check or save; scripts (e.g. SISYPHUS) may substitute a stored result. */
export function rollD20(bt: Battle, u: Unit, kind: 'attack' | 'check' | 'save', ctx?: AttackCtx): number {
  for (const o of bt.alive()) for (const s of scriptsFor(o)) {
    const v = s.overrideD20?.(bt, o, u, kind, ctx)
    if (v != null) return v
  }
  return bt.rng.d(20)
}

/** Hostile reveal fields (e.g. Lotus Projector): no Hiding, no Invisibility benefit, Hidden lost at turn end. */
export function inRevealField(bt: Battle, u: Unit): boolean {
  return bt.alive().some(d => d.flags.revealRadius && bt.hostile(d, u) && bt.distance(d, u) <= d.flags.revealRadius)
}

/** ICEOUT fields: characters inside are immune to tech actions and can't take them. */
export function inIceout(bt: Battle, u: Unit): boolean {
  return bt.alive().some(d => d.flags.iceoutRadius && d !== u && bt.distance(d, u) <= d.flags.iceoutRadius)
}

/** Take a drone/deployable off the field without destroying it (recall, expiry, disintegration). */
export function removeUnit(bt: Battle, u: Unit, why: string) {
  if (u.destroyed) return
  u.destroyed = true
  u.flags.removed = true
  u.flags.wreck = false
  bt.invalidateTerrain()
  bt.emit({ type: 'destroyed', unitId: u.id })
  bt.say(`${u.name} ${why}.`)
}

export function spawn(bt: Battle, u: Unit) {
  bt.units.push(u)
  bt.invalidateTerrain()
  bt.emit({ type: 'spawn', unitId: u.id })
}

/**
 * Plant a mine (core book MINE tag): a free space within `range` (adjacent by default) that isn't next to another
 * mine; it arms at the end of the owner's turn and is Hidden from the other side until detected.
 */
export function placeMine(bt: Battle, owner: Unit, pos: Pos, m: Omit<Mine, 'id' | 'ownerId' | 'side' | 'pos'>, opts: { range?: number; onWalls?: boolean; noCheck?: boolean } = {}): Mine {
  if (!opts.noCheck) {
    const t = tileAt(bt.map, pos)
    if (!t) throw new Error('Off the map')
    if (distanceToTile(bt.map, owner, pos) > (opts.range ?? 1)) throw new Error(opts.range ? `Out of range (${opts.range})` : 'Mines are planted in an adjacent space')
    if (!opts.onWalls && (t.kind === 'block' || bt.alive().some(o => !o.flags.flat && footprint(o).some(q => q.x === pos.x && q.y === pos.y)))) throw new Error('The space must be free')
    if (bt.mines.some(x => chebyshev(x.pos, pos) <= 1)) throw new Error("Mines can't be planted next to another mine")
  }
  const mine: Mine = { ...m, id: nextUid('mine'), ownerId: owner.id, side: owner.side, pos: { ...pos }, armed: m.armed ?? !owner.activeTurn, detectedBy: [] }
  bt.mines.push(mine)
  bt.say(`${owner.name} plants ${m.name}${mine.armed ? '' : ' (it arms at the end of the turn)'}.`)
  bt.emit({ type: 'mine', mineId: mine.id, pos: mine.pos, added: true })
  return mine
}

export function mineVisibleTo(bt: Battle, m: Mine, side: Side): boolean {
  return m.side === side || !!m.detectedBy?.includes(side)
}

export function mineTriggeredBy(bt: Battle, m: Mine, u: Unit, before: Pos[]): boolean {
  if (!m.armed || u.flags.skeletonKey) return false
  const trig = m.trigger ?? 'adjacent'
  if (trig === 'remote') return false
  // house rule: your own side never sets off your mines (except mines meant for allies)
  if (trig === 'ally' ? u.side !== m.side : u.side === m.side) return false
  const now = footprint(u)
  if (trig === 'over') return now.some(q => q.x === m.pos.x && q.y === m.pos.y) && !before.some(q => q.x === m.pos.x && q.y === m.pos.y)
  if (trig === 'flying' && !u.flying) return false
  const near = (fp: Pos[]) => fp.some(q => chebyshev(q, m.pos) <= 1)
  return near(now) && !near(before)
}

/** Detonate a mine (triggered by `by`, or remotely). */
export function detonateMine(bt: Battle, m: Mine, by?: Unit) {
  bt.mines = bt.mines.filter(x => x !== m)
  bt.emit({ type: 'mine', mineId: m.id, pos: m.pos, added: false })
  const owner = bt.unit(m.ownerId)
  bt.say(`${m.name} DETONATES!`, 'attack')
  if (m.tag && owner && scriptsFor(owner).some(sc => sc.onMineDetonate?.(bt, owner, m, by))) return
  const src: Unit = owner ?? ({ id: m.ownerId, pos: m.pos, stats: { size: 1 } } as Unit)
  const tiles = m.line && by
    ? lineTiles(bt.map, { ...src, pos: m.pos, stats: { ...src.stats, size: 1 } } as Unit, by.pos, m.line)
    : blastTiles(bt.map, m.pos, m.radius)
  bt.emit({ type: 'area', tiles, kind: 'explosion' })
  const parts = m.damage.map(d => ({ type: d.type, amount: rollDice(bt.rng, d.val).total }))
  for (const t of unitsOnTiles(bt.alive(), tiles)) {
    if (t.kind !== 'mech' && t.kind !== 'npc' && t.kind !== 'drone') continue
    const ok = m.save ? bt.save(t, m.save, owner?.stats.save ?? 10, 0, owner) : false
    if (!ok && m.effects?.length && owner) bt.runEffects(owner, t, m.effects)
    if (!parts.length || (ok && (!m.saveHalf || t.isGrunt))) continue
    bt.applyDamage(t, ok ? parts.map(p => ({ ...p, amount: bt.halfOnSave(t, p.amount) })) : parts, { source: owner })
  }
}

/** Search for Mines (quick): a Systems check finds every hostile mine within Sensors. */
export function searchMines(bt: Battle, u: Unit, paid = false): number {
  if (!paid) {
    const c = bt.canSpend(u, 'quick', 'search_mines')
    if (c !== true) throw new Error(c)
    bt.spend(u, 'quick', 'search_mines')
  }
  if (!bt.check(u, 'sys')) { bt.say(`${u.name} scans for mines but finds nothing.`); return 0 }
  let n = 0
  for (const m of bt.mines) if (m.side !== u.side && !m.detectedBy?.includes(u.side) && distanceToTile(bt.map, u, m.pos) <= u.stats.sensors) { (m.detectedBy ??= []).push(u.side); n++; bt.emit({ type: 'mine', mineId: m.id, pos: m.pos, added: true }) }
  bt.say(n ? `${u.name} detects ${n} mine${n > 1 ? 's' : ''}.` : `${u.name} finds no mines within Sensors.`)
  return n
}

/** Disarm Mine (quick): a detected mine in an adjacent space; a failed Systems check sets it off. */
export function disarmMine(bt: Battle, u: Unit, m: Mine, paid = false) {
  if (!paid) { const c = bt.canSpend(u, 'quick', 'disarm_mine'); if (c !== true) throw new Error(c) }
  if (!bt.mineVisibleTo(m, u.side)) throw new Error('No known mine there')
  if (!footprint(u).some(q => chebyshev(q, m.pos) === 1 || (q.x === m.pos.x && q.y === m.pos.y))) throw new Error('Must be adjacent to the mine')
  if (!paid) bt.spend(u, 'quick', 'disarm_mine')
  if (bt.check(u, 'sys')) {
    bt.mines = bt.mines.filter(x => x !== m)
    bt.emit({ type: 'mine', mineId: m.id, pos: m.pos, added: false })
    bt.say(`${u.name} disarms ${m.name}.`)
  } else { bt.say(`${u.name} fumbles the disarm!`, 'warn'); bt.detonateMine(m, u) }
}

export function addArea(bt: Battle, a: Omit<AreaEffect, 'id'>) {
  const area = { ...a, id: nextUid('area') }
  bt.areas.push(area)
  bt.invalidateTerrain()
  bt.emit({ type: 'area', tiles: a.tiles, kind: a.kind })
  return area
}

export function customActions(bt: Battle, u: Unit): CustomAction[] {
  const out: CustomAction[] = []
  for (const s of scriptsFor(u)) if (s.actions) out.push(...s.actions(bt, u).map(a => (a.scriptId ? a : { ...a, scriptId: s.id })))
  // actions other units' systems make available to this one (e.g. activating an ally's restock drone)
  if (u.kind === 'mech' || u.kind === 'npc') for (const o of bt.alive()) if (o !== u) for (const s of scriptsFor(o)) if (s.grantActions) out.push(...s.grantActions(bt, o, u))
  out.push(...genericActionsFor(bt, u))
  return out
}

/**
 * Heat (Self) for activating a system's action, from the system's tg_heat_self tag (rolled when it is dice, e.g.
 * LUCIFER's 1d3+3). Actions that set `heat` themselves keep it; switching a system off costs nothing.
 */
function heatSelfOf(bt: Battle, u: Unit, a: CustomAction): number {
  if (/^(Deactivate|Drop|Disable)\b/i.test(a.name) || /_off$/.test(a.key)) return 0
  const sys = u.systems.find(s => s.uid === a.sourceUid) ?? (a.scriptId ? u.systems.find(s => s.dataId === a.scriptId) : undefined)
  if (!sys || sys.destroyed) return 0
  const tag = Lancer.systems.get(sys.dataId)?.tags?.find(t => t.id === 'tg_heat_self')
  if (!tag || tag.val == null) return 0
  return rollDice(bt.rng, tag.val as any).total
}

export function useCustom(bt: Battle, u: Unit, a: CustomAction, target?: Unit | Pos) {
  const ok = a.usable(bt, u)
  if (ok !== true) throw new Error(ok)
  const cost = a.activation === 'quick_tech' ? null : a.activation === 'full_tech' ? 'full' : a.activation
  if (a.activation === 'quick_tech') {
    const option = a.techOption ?? `qt:${a.sourceUid ?? a.key}`
    const c = bt.canQuickTech(u, option)
    if (c !== true) throw new Error(c)
    if (bt.has(u, 'jammed')) throw new Error('Jammed')
    if (target && 'id' in target && (target as Unit).role === 'Biological') throw new Error('Biological characters are immune to tech actions')
    bt.spendTech(u, option)
  } else if (cost === 'reaction') bt.spend(u, 'reaction', `custom:${a.sourceUid ?? a.key}`)
  else if (cost === 'protocol') {
    // each Protocol can only be taken once per turn
    const k = `turn:protocol:${a.sourceUid ?? a.key}`
    if (u.flags[k]) throw new Error('That protocol was already used this turn')
    bt.spend(u, 'protocol')
    u.flags[k] = true
  }
  // ACTIVATE: any number per turn, but not the same SYSTEM more than once (unless free)
  else bt.spend(u, cost as any, cost === 'quick' || cost === 'full' ? `activate:${a.sourceUid ?? a.key}` : undefined)
  const heat = a.heat ?? heatSelfOf(bt, u, a)
  if (heat) bt.addHeat(u, heat)
  bt.say(`${u.name} uses ${a.name}.`, 'attack')
  a.run(bt, u, target)
}
