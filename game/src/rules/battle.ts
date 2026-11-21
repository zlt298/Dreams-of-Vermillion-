// The Lancer combat engine. Deterministic given a seed; UI-free.
import type { DamageData, RangeData, TagData, BonusData } from '../data/lancer'
import { Lancer } from '../data/lancer'
import {
  type AreaEffect, type GridMap, type Cover, tileAt, footprint, elevationAt, unitElevation, distanceBetween,
  distanceToTile, hasLineOfSight, hasLineOfSightToTile, coverBetween, burstTiles, blastTiles, lineTiles, coneTiles,
  unitsOnTiles, key, chebyshev, center, footprintSize,
} from './grid'
import { Rng, rollDice, rollAccuracy, averageDice } from './rng'
import { hasTag, tagVal, nextUid } from './stats'
import type { Duration, Effect, LogEntry, Pos, Profile, Side, Stat, StatusId, StatusInstance, Unit, Weapon } from './types'
import { type AttackCtx, type CustomAction, type DamageCtx, scriptsFor } from './effects/registry'
import { genericActionsFor } from './effects/generic'

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
  | { type: 'end'; winner: Side }
  | { type: 'text'; unitId?: string; text: string }

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
}

export interface MoveOpts { mode: 'standard' | 'boost' | 'free' | 'disengage' | 'involuntary'; ignoreEngagement?: boolean; flyingOk?: boolean }

export interface AttackAim { targetId?: string; tile?: Pos }

export interface AttackSummary { ctxs: AttackCtx[]; ok: boolean; reason?: string }

const NEGATIVE: StatusId[] = ['impaired', 'slowed', 'immobilized', 'jammed', 'lockon', 'shredded', 'stunned', 'exposed', 'prone']

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
  /** prevents infinite reaction chains */
  private reactionDepth = 0

  constructor(cfg: { map: GridMap; units: Unit[]; seed: number; sitrep?: Sitrep }) {
    this.map = cfg.map
    this.units = cfg.units
    this.rng = new Rng(cfg.seed)
    this.sitrep = cfg.sitrep ?? { id: 'standard', name: 'Basic Combat', description: 'Defeat all enemy forces.' }
  }

  // ------------------------------------------------------------------ utils
  emit(e: BattleEvent) {
    this.events.push(e)
    for (const l of this.listeners) l(e)
  }
  say(text: string, kind: LogEntry['kind'] = 'info') {
    this.log.push({ round: this.round, text, kind })
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
  effectiveMap(): GridMap {
    const covers = this.units.filter(u => !u.destroyed && u.kind === 'deployable' && u.flags.isCover)
    if (!covers.length) return this.map
    const tiles = this.map.tiles.map(t => ({ ...t }))
    for (const c of covers) for (const p of footprint(c)) {
      const i = p.y * this.map.w + p.x
      if (tiles[i]) tiles[i] = { h: tiles[i].h + Math.max(1, c.stats.size), kind: 'block' }
    }
    return { ...this.map, tiles }
  }
  los(a: Unit, b: Unit, from?: Pos): boolean {
    return hasLineOfSight(this.effectiveMap(), a, b, from)
  }
  cover(attacker: Unit, target: Unit, from?: Pos): Cover {
    const m = this.effectiveMap()
    let c = coverBetween(m, attacker, target, this.areas, from)
    if (c !== 'hard') {
      // Guardian / Colossus: adjacent allied frames provide hard cover if they are between
      const ac = center(attacker, from ?? attacker.pos), tc = center(target)
      const dx = ac.x - tc.x, dy = ac.y - tc.y, dl = Math.hypot(dx, dy) || 1
      for (const g of this.alive()) {
        if (g === target || g === attacker || !g.flags.guardian || this.hostile(g, target) || !this.adjacent(g, target)) continue
        const gc = center(g)
        const vx = gc.x - tc.x, vy = gc.y - tc.y, vl = Math.hypot(vx, vy) || 1
        if ((vx * dx + vy * dy) / (vl * dl) >= 0.5) { c = 'hard'; break }
      }
    }
    for (const o of this.alive()) for (const sc of scriptsFor(o)) if (sc.adjustCover) c = sc.adjustCover(this, o, attacker, target, c)
    return c
  }

  // ------------------------------------------------------------------ statuses
  has(u: Unit, s: StatusId | 'engaged' | 'dangerzone'): boolean {
    if (s === 'engaged') return this.isEngaged(u)
    if (s === 'dangerzone') return u.stats.heatcap > 0 && u.heat >= Math.ceil(u.stats.heatcap / 2)
    if (s === 'stunned' && u.statuses.some(x => x.id === 'shutdown')) return true
    return u.statuses.some(x => x.id === s)
  }
  isEngaged(u: Unit, at: Pos = u.pos): boolean {
    if (u.kind === 'deployable') return false
    return this.alive().some(o => o !== u && this.hostile(u, o) && (o.kind === 'mech' || o.kind === 'npc') && !this.has(o, 'hidden') &&
      this.adjacent(u, o, at))
  }
  adjacent(a: Unit, b: Unit, aAt: Pos = a.pos): boolean {
    const fa = footprint(a, aAt), fb = footprint(b)
    return fa.some(p => fb.some(q => chebyshev(p, q) <= 1)) && Math.abs(elevationAt(this.map, a, aAt) - this.elevation(b)) <= Math.max(a.stats.size, b.stats.size) + 1
  }

  addStatus(u: Unit, id: StatusId, duration: Duration = 'until_cleared', source?: Unit, data?: any): boolean {
    if (u.destroyed) return false
    if (u.immune.includes(id)) { this.say(`${u.name} is immune to ${id}.`, 'status'); return false }
    for (const sc of scriptsFor(u)) if (sc.blockStatus?.(this, u, id, source)) { this.say(`${u.name} ignores ${id}.`, 'status'); return false }
    if (u.kind === 'deployable' && ['prone', 'slowed', 'immobilized', 'impaired', 'jammed'].includes(id) && u.stats.speed === 0) return false
    const inst: StatusInstance = { id, source: source?.id, data }
    if (duration === 'end_of_turn') { inst.clockUnit = this.activeId ?? u.id; inst.turnsLeft = 1 }
    else if (duration === 'next_turn_end_target') { inst.clockUnit = u.id; inst.turnsLeft = u.activeTurn ? 2 : 1 }
    else if (duration === 'next_turn_end_source' && source) { inst.clockUnit = source.id; inst.turnsLeft = source.activeTurn ? 2 : 1 }
    else if (duration === 'start_of_next_turn_target') { inst.clockUnit = u.id; inst.turnsLeft = 1; inst.atStart = true }
    const existing = u.statuses.find(s => s.id === id)
    if (existing) {
      // keep the longer of the two
      if (!existing.clockUnit) return true
      if (!inst.clockUnit) Object.assign(existing, inst)
      else if (existing.clockUnit === inst.clockUnit) existing.turnsLeft = Math.max(existing.turnsLeft ?? 0, inst.turnsLeft ?? 0)
      else Object.assign(existing, inst)
      return true
    }
    u.statuses.push(inst)
    this.emit({ type: 'status', unitId: u.id, status: id, added: true })
    this.say(`${u.name} is ${id.toUpperCase()}.`, 'status')
    if (source && source !== u) for (const sc of scriptsFor(source)) sc.onStatusInflicted?.(this, source, u, id)
    if (id === 'stunned' || id === 'shutdown') { u.flags.wasStunned = true }
    return true
  }
  removeStatus(u: Unit, id: StatusId) {
    const before = u.statuses.length
    u.statuses = u.statuses.filter(s => s.id !== id)
    if (u.statuses.length !== before) {
      this.emit({ type: 'status', unitId: u.id, status: id, added: false })
      this.say(`${u.name} is no longer ${id}.`, 'status')
    }
  }
  private tickStatuses(clock: Unit, atStart: boolean) {
    for (const u of this.units) {
      for (const s of [...u.statuses]) {
        if (s.clockUnit !== clock.id || !!s.atStart !== atStart) continue
        s.turnsLeft = (s.turnsLeft ?? 1) - 1
        if (s.turnsLeft <= 0) this.removeStatus(u, s.id)
      }
    }
  }

  // ------------------------------------------------------------------ rolls
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
    if (c === 'flying') return u.flying
    if (c === 'adjacent_ally') return this.alive().some(o => o !== u && !this.hostile(u, o) && (o.kind === 'mech' || o.kind === 'npc') && this.adjacent(u, o))
    return false
  }

  /** Skill check vs 10. */
  check(u: Unit, stat: Stat, extraAcc = 0): boolean {
    if ((stat === 'hull' || stat === 'agi') && this.has(u, 'stunned')) { this.say(`${u.name} automatically fails the ${stat.toUpperCase()} check (stunned).`); return false }
    const acc = this.accuracyFromStatuses(u, 'check', stat) + extraAcc
    const d = this.rng.d(20), a = rollAccuracy(this.rng, acc)
    const total = d + u.stats[stat] + a.bonus
    const ok = total >= 10
    this.say(`${u.name} ${stat.toUpperCase()} check: ${total} (${d}${fmtAcc(a.bonus)}+${u.stats[stat]}) ${ok ? 'success' : 'failure'}.`)
    return ok
  }
  /** Save vs a source's save target. */
  save(u: Unit, stat: Stat, target: number, extraAcc = 0): boolean {
    if ((stat === 'hull' || stat === 'agi') && this.has(u, 'stunned')) { this.say(`${u.name} automatically fails the ${stat.toUpperCase()} save (stunned).`); return false }
    const acc = this.accuracyFromStatuses(u, 'save', stat) + extraAcc
    const d = this.rng.d(20), a = rollAccuracy(this.rng, acc)
    const total = d + u.stats[stat] + a.bonus
    const ok = total >= target
    this.say(`${u.name} ${stat.toUpperCase()} save vs ${target}: ${total} — ${ok ? 'success' : 'failure'}.`)
    return ok
  }

  // ------------------------------------------------------------------ round / turn flow
  start() {
    this.startRound()
  }
  private startRound() {
    this.round++
    this.emit({ type: 'round', round: this.round })
    this.say(`— Round ${this.round} —`, 'turn')
    for (const u of this.alive()) {
      u.activationsLeft = u.kind === 'mech' || u.kind === 'npc' ? u.stats.activations : 0
      u.reactionsLeft = this.has(u, 'bracing_recovery') ? 0 : u.reactionsPerRound
      for (const k of Object.keys(u.flags)) if (k.startsWith('round:')) delete u.flags[k]
    }
    this.areas = this.areas.filter(a => a.expiresRound == null || a.expiresRound >= this.round)
    for (const u of this.alive()) {
      if (u.expiresRound != null && u.expiresRound < this.round) this.destroy(u, 'expired')
    }
    for (const u of this.alive()) for (const s of scriptsFor(u)) s.onRoundStart?.(this, u)
    this.currentSide = this.combatants('player').length ? 'player' : 'enemy'
    if (!this.hasActivations(this.currentSide)) this.currentSide = other(this.currentSide)
    this.checkVictory()
  }
  hasActivations(side: Side): boolean {
    return this.combatants(side).some(u => u.activationsLeft > 0)
  }
  canActivate(u: Unit): true | string {
    if (this.winner) return 'Battle over'
    if (this.activeId) return 'Another unit is acting'
    if (u.destroyed) return 'Destroyed'
    if (u.side !== this.currentSide) return 'Not your side’s turn'
    if (u.activationsLeft <= 0) return 'Already activated this round'
    return true
  }

  beginTurn(u: Unit) {
    const ok = this.canActivate(u)
    if (ok !== true) throw new Error(ok)
    this.activeId = u.id
    u.activationsLeft--
    u.activeTurn = true
    u.actionsLeft = 2
    u.flags.bonusQuick = 0
    u.overchargedThisTurn = false
    u.actedThisTurn = false
    u.boostedThisTurn = false
    u.flags.fullTechLeft = 0
    for (const k of Object.keys(u.flags)) if (k.startsWith('turn:')) delete u.flags[k]
    this.tickStatuses(u, true)
    u.moveLeft = u.stats.speed
    if (this.has(u, 'bracing_recovery')) { u.actionsLeft = 1; u.moveLeft = 0 }
    if (this.has(u, 'stunned')) { u.actionsLeft = 0; u.moveLeft = 0 }
    if (this.has(u, 'immobilized')) u.moveLeft = 0
    this.emit({ type: 'turn', unitId: u.id })
    this.say(`${u.name} activates.`, 'turn')
    // hazards at start of turn
    for (const a of this.areas) if (a.kind === 'damage' && a.damage && footprint(u).some(p => a.tiles.some(t => t.x === p.x && t.y === p.y))) {
      const r = rollDice(this.rng, a.damage)
      this.applyDamage(u, [{ type: 'Energy', amount: r.total }], { source: this.unit(a.ownerId) })
    }
    for (const s of scriptsFor(u)) s.onTurnStart?.(this, u)
    for (const o of this.alive()) if (o !== u) for (const s of scriptsFor(o)) s.onAnyTurnStart?.(this, o, u)
    // drones/deployables owned by this unit act on its turn: refresh their flags
    for (const d of this.alive().filter(d => d.ownerId === u.id)) for (const k of Object.keys(d.flags)) if (k.startsWith('turn:')) delete d.flags[k]
  }

  endTurn(u: Unit = this.active!) {
    if (!u || u.id !== this.activeId) throw new Error('Not the active unit')
    // burn
    if (u.burn > 0 && !u.destroyed) {
      if (this.check(u, 'eng')) { this.say(`${u.name} clears burn.`); u.burn = 0 }
      else { this.say(`${u.name} burns for ${u.burn}.`, 'damage'); this.applyDamage(u, [{ type: 'Burn-tick', amount: u.burn }], {}) }
    }
    for (const s of scriptsFor(u)) s.onTurnEnd?.(this, u)
    for (const o of this.alive()) if (o !== u) for (const s of scriptsFor(o)) s.onAnyTurnEnd?.(this, o, u)
    // reactor meltdown / self destruct
    if (!u.destroyed && u.meltdownTurns != null) {
      u.meltdownTurns--
      if (u.meltdownTurns <= 0) this.reactorExplosion(u, 'reactor meltdown')
      else this.say(`${u.name}'s reactor will melt down in ${u.meltdownTurns} turn(s)!`, 'warn')
    }
    if (!u.destroyed && u.selfDestructTurns != null) {
      u.selfDestructTurns--
      if (u.selfDestructTurns <= 0) this.reactorExplosion(u, 'self-destruct')
    }
    u.flags.hiddenMoveCheck = false
    this.tickStatuses(u, false)
    u.activeTurn = false
    this.activeId = null
    this.removeStatusIfExpiredRecovery(u)
    this.checkVictory()
    if (this.winner) return
    const opp = other(u.side)
    if (this.hasActivations(opp)) this.currentSide = opp
    else if (this.hasActivations(u.side)) this.currentSide = u.side
    else this.endRound()
  }
  private removeStatusIfExpiredRecovery(_u: Unit) {}
  private endRound() {
    if (this.sitrep.id === 'holdout' && this.sitrep.rounds && this.round >= this.sitrep.rounds) {
      this.finish('player', `Held out for ${this.sitrep.rounds} rounds!`)
      return
    }
    if (this.sitrep.id === 'control' && this.sitrep.zone) {
      const zone = new Set(this.sitrep.zone.map(key))
      const pIn = this.combatants('player').some(u => footprint(u).some(p => zone.has(key(p))))
      const eIn = this.combatants('enemy').some(u => footprint(u).some(p => zone.has(key(p))))
      if (pIn && !eIn) {
        this.sitrepScore = (this.sitrepScore ?? 0) + 1
        this.say(`Control point held (${this.sitrepScore}/${this.sitrep.rounds ?? 3}).`)
        if (this.sitrepScore >= (this.sitrep.rounds ?? 3)) { this.finish('player', 'Control point secured!'); return }
      }
    }
    this.startRound()
  }
  sitrepScore?: number

  checkVictory() {
    if (this.winner) return
    const p = this.combatants('player').length, e = this.combatants('enemy').length
    if (p === 0) this.finish('enemy', 'All lancers are down.')
    else if (e === 0) this.finish('player', 'All hostiles destroyed.')
    else if (this.sitrep.id === 'assassination' && this.sitrep.targetId && this.unit(this.sitrep.targetId)?.destroyed) this.finish('player', 'Target eliminated.')
    else if (this.sitrep.id === 'extraction' && this.sitrep.zone) {
      const zone = new Set(this.sitrep.zone.map(key))
      const all = this.combatants('player')
      if (all.length && all.every(u => footprint(u).some(q => zone.has(key(q))))) this.finish('player', 'All lancers extracted!')
    }
  }
  finish(w: Side, why: string) {
    if (this.winner) return
    this.winner = w
    this.say(`${w === 'player' ? 'VICTORY' : 'DEFEAT'}: ${why}`, 'turn')
    this.emit({ type: 'end', winner: w })
  }

  // ------------------------------------------------------------------ action economy
  canSpend(u: Unit, cost: 'quick' | 'full' | 'protocol' | 'free' | 'reaction' | 'move'): true | string {
    if (u.destroyed) return 'Destroyed'
    if (cost === 'reaction') {
      if (u.reactionsLeft <= 0) return 'No reactions left'
      if (this.has(u, 'stunned')) return 'Stunned'
      if (this.has(u, 'jammed')) return 'Jammed'
      if (this.has(u, 'bracing_recovery')) return 'Recovering from brace'
      return true
    }
    if (!u.activeTurn) return 'Not this unit’s turn'
    if (this.has(u, 'stunned') && cost !== 'free') return 'Stunned'
    if (this.has(u, 'stunned')) return 'Stunned'
    if (this.has(u, 'shutdown')) return 'Shut down'
    if (cost === 'protocol') return u.actedThisTurn ? 'Protocols must be used at the start of a turn' : true
    if (cost === 'free') return true
    if (cost === 'quick') return u.actionsLeft >= 1 || (u.flags.bonusQuick ?? 0) > 0 ? true : 'No actions left'
    if (cost === 'full') return u.actionsLeft >= 2 && !this.has(u, 'bracing_recovery') ? true : 'Needs a full action'
    return true
  }
  spend(u: Unit, cost: 'quick' | 'full' | 'protocol' | 'free' | 'reaction') {
    const ok = this.canSpend(u, cost)
    if (ok !== true) throw new Error(ok)
    if (cost === 'reaction') { u.reactionsLeft--; return }
    if (cost !== 'protocol') u.actedThisTurn = true
    if (cost === 'quick') {
      if (u.actionsLeft >= 1) u.actionsLeft--
      else u.flags.bonusQuick--
    } else if (cost === 'full') u.actionsLeft -= 2
  }

  // ------------------------------------------------------------------ heat, damage, structure
  addHeat(u: Unit, amount: number, source?: Unit) {
    if (amount <= 0 || u.destroyed) return
    if (u.stats.heatcap <= 0) return // deployables etc.
    u.heat += amount
    this.emit({ type: 'damage', unitId: u.id, amount, kind: 'heat' })
    for (const s of scriptsFor(u)) s.onHeat?.(this, u, amount)
    while (u.heat > u.stats.heatcap && !u.destroyed) {
      if (scriptsFor(u).some(s => s.beforeOverheat?.(this, u))) break
      const excess = u.heat - u.stats.heatcap
      if (u.kind === 'npc' && u.stats.stress <= 1) {
        u.heat = 0
        this.say(`${u.name} overheats and vents violently!`, 'damage')
        this.addStatus(u, 'exposed', 'until_cleared', source)
        break
      }
      u.stress--
      u.heat = excess
      this.emit({ type: 'damage', unitId: u.id, amount: 1, kind: 'stress' })
      this.say(`${u.name} OVERHEATS — takes 1 stress (${u.stress} left).`, 'damage')
      this.overheatCheck(u)
    }
  }

  private overheatCheck(u: Unit) {
    if (u.stress <= 0) { this.reactorExplosion(u, 'reactor meltdown'); return }
    const marked = u.stats.stress - u.stress
    const dice = Array.from({ length: marked }, () => this.rng.d(6))
    const ones = dice.filter(d => d === 1).length
    const low = Math.min(...dice)
    this.say(`Overheating check [${dice.join(', ')}]`)
    if (ones >= 2) { this.say('IRREVERSIBLE MELTDOWN!', 'warn'); u.meltdownTurns = u.activeTurn ? 2 : 1; return }
    if (low >= 5) { this.say('Emergency Shunt.'); this.addStatus(u, 'impaired', 'next_turn_end_target') }
    else if (low >= 2) { this.say('Destabilized Power Plant.'); this.addStatus(u, 'exposed') }
    else {
      this.say('MELTDOWN result.')
      if (u.stress >= 3) this.addStatus(u, 'exposed')
      else if (u.stress === 2) {
        if (this.check(u, 'eng')) this.addStatus(u, 'exposed')
        else { u.meltdownTurns = this.rng.d(6) + (u.activeTurn ? 1 : 0); this.say(`${u.name}'s reactor is going critical (${u.meltdownTurns} turns)!`, 'warn') }
      } else { u.meltdownTurns = u.activeTurn ? 2 : 1; this.say(`${u.name}'s reactor will melt down at the end of its next turn!`, 'warn') }
    }
  }

  private structureCheck(u: Unit) {
    if (u.structure <= 0) { this.destroy(u, 'structure'); return }
    if (u.isGrunt) { this.destroy(u, 'structure'); return }
    const marked = u.stats.structure - u.structure
    const dice = Array.from({ length: marked }, () => this.rng.d(6))
    const ones = dice.filter(d => d === 1).length
    const low = Math.min(...dice)
    this.say(`Structure check [${dice.join(', ')}]`)
    if (ones >= 2) { this.say('CRUSHING HIT!', 'warn'); this.destroy(u, 'crushing hit'); return }
    if (low >= 5) { this.say('Glancing Blow.'); this.addStatus(u, 'impaired', 'next_turn_end_target'); return }
    if (low >= 2) { this.systemTrauma(u); return }
    this.directHit(u)
  }
  private directHit(u: Unit) {
    this.say('DIRECT HIT!', 'warn')
    if (u.structure >= 3) this.addStatus(u, 'stunned', 'next_turn_end_target')
    else if (u.structure === 2) {
      if (this.check(u, 'hull')) this.addStatus(u, 'stunned', 'next_turn_end_target')
      else this.destroy(u, 'direct hit')
    } else this.destroy(u, 'direct hit')
  }
  private systemTrauma(u: Unit) {
    const validMounts = [...new Set(u.weapons.filter(w => !w.destroyed && w.mountIndex >= 0 && !(w.usesLeft === 0)).map(w => w.mountIndex))]
    const validSystems = u.systems.filter(s => !s.destroyed && !(s.usesLeft === 0) && !s.dataId.startsWith('npc_trait'))
    const r = this.rng.d(6)
    let doMount = r <= 3
    if (doMount && !validMounts.length) doMount = false
    if (!doMount && !validSystems.length) doMount = validMounts.length > 0
    if (!validMounts.length && !validSystems.length) { this.directHit(u); return }
    if (doMount) {
      const m = this.rng.pick(validMounts)
      const ws = u.weapons.filter(w => w.mountIndex === m && !w.destroyed)
      ws.forEach(w => (w.destroyed = true))
      this.say(`System Trauma: ${ws.map(w => w.name).join(', ')} destroyed!`, 'damage')
    } else {
      const s = this.rng.pick(validSystems)
      s.destroyed = true
      this.say(`System Trauma: ${s.name} destroyed!`, 'damage')
    }
  }

  reactorExplosion(u: Unit, why: string) {
    if (u.destroyed) return
    this.say(`${u.name} — ${why.toUpperCase()}! The reactor explodes.`, 'warn')
    const tiles = burstTiles(this.map, u, 2)
    this.emit({ type: 'area', tiles, kind: 'explosion' })
    this.destroy(u, why)
    const dmg = rollDice(this.rng, '4d6').total
    for (const t of unitsOnTiles(this.alive(), tiles)) {
      if (t === u) continue
      const ok = this.save(t, 'agi', u.stats.save || 10)
      if (ok && t.isGrunt) continue
      this.applyDamage(t, [{ type: 'Explosive', amount: ok ? this.halfOnSave(t, dmg) : dmg }], { source: u })
    }
  }

  /** Half damage on a successful save (Napoleon's Heavy Shielding reduces it to 1). */
  halfOnSave(t: Unit, amount: number): number {
    return t.flags.heavyShielding ? Math.min(1, amount) : Math.ceil(amount / 2)
  }

  destroy(u: Unit, why: string) {
    if (u.destroyed) return
    u.destroyed = true
    u.hp = 0
    this.emit({ type: 'destroyed', unitId: u.id })
    this.say(`${u.name} is DESTROYED (${why}).`, 'damage')
    for (const o of this.alive()) for (const s of scriptsFor(o)) s.onDestroyed?.(this, o, u)
    for (const s of scriptsFor(u)) s.onDestroyed?.(this, u, u)
    // drones/deployables persist; owned drones of destroyed mechs remain until the scene ends
    if (u.id === this.activeId) {
      u.activeTurn = false
      this.activeId = null
      this.checkVictory()
      if (!this.winner) {
        const opp = other(u.side)
        if (this.hasActivations(opp)) this.currentSide = opp
        else if (this.hasActivations(u.side)) this.currentSide = u.side
        else this.endRound()
      }
    } else this.checkVictory()
  }

  /**
   * Apply damage parts to a unit. Types: Kinetic, Explosive, Energy, Burn, Heat, plus internal 'Burn-tick'.
   */
  applyDamage(t: Unit, parts: { type: string; amount: number }[], opts: { source?: Unit; ap?: boolean; irreducible?: boolean; attack?: AttackCtx; resistAll?: boolean } = {}): number {
    if (t.destroyed) return 0
    const shredded = this.has(t, 'shredded')
    const resists = (type: string) => !opts.irreducible && !shredded && (opts.resistAll || t.resist.includes(type) || t.resist.includes('all') || (t.flags.resistAll ?? 0) > 0)
    let hpDmg = 0, heat = 0, burn = 0
    const exposed = this.has(t, 'exposed')
    const physical = parts.filter(p => ['Kinetic', 'Explosive', 'Energy', 'Variable'].includes(p.type)).map(p => ({ ...p, amount: exposed ? p.amount * 2 : p.amount }))
    // armor applies once to the attack's combined physical damage
    let armor = opts.ap || opts.irreducible || shredded ? 0 : t.stats.armor
    for (const p of physical) {
      const red = Math.min(armor, p.amount)
      p.amount -= red
      armor -= red
      if (resists(p.type)) p.amount = Math.ceil(p.amount / 2)
      hpDmg += p.amount
    }
    for (const p of parts) {
      if (p.type === 'Heat') heat += resists('Heat') ? Math.ceil(p.amount / 2) : p.amount
      if (p.type === 'Burn') burn += resists('Burn') ? Math.ceil(p.amount / 2) : p.amount
      if (p.type === 'Burn-tick') hpDmg += p.amount
    }
    const dctx: DamageCtx = { source: opts.source, attack: opts.attack, amount: hpDmg, kind: 'hp' }
    for (const s of scriptsFor(t)) s.modifyIncoming?.(this, t, dctx)
    hpDmg = Math.max(0, dctx.amount)
    if (burn > 0 && t.immune.includes('burn')) { this.say(`${t.name} is immune to burn.`); burn = 0 }
    if (burn > 0) {
      hpDmg += burn // burn deals its damage immediately, ignoring armor
      t.burn += burn
      this.say(`${t.name} catches fire (${burn} burn).`, 'damage')
    }
    if (heat > 0) {
      if (t.stats.heatcap > 0) this.addHeat(t, heat, opts.source)
      else hpDmg += 0
    }
    if (hpDmg > 0) this.loseHp(t, hpDmg, opts.source)
    if (hpDmg > 0 || heat > 0) for (const s of scriptsFor(t)) s.onDamaged?.(this, t, { ...dctx, amount: hpDmg })
    return hpDmg
  }

  loseHp(t: Unit, amount: number, _source?: Unit) {
    if (t.destroyed) return
    if (t.overshield > 0) {
      const a = Math.min(t.overshield, amount)
      t.overshield -= a
      amount -= a
      if (a) this.say(`${t.name}'s overshield absorbs ${a}.`)
    }
    if (amount <= 0) return
    t.hp -= amount
    this.emit({ type: 'damage', unitId: t.id, amount, kind: 'hp' })
    this.say(`${t.name} takes ${amount} damage (${Math.max(0, t.hp)}/${t.stats.hp} HP).`, 'damage')
    while (t.hp <= 0 && !t.destroyed) {
      if (t.kind === 'deployable' || t.kind === 'drone' || t.isGrunt || t.stats.structure <= 1) {
        this.destroy(t, 'HP depleted')
        return
      }
      const excess = -t.hp
      t.structure--
      this.emit({ type: 'damage', unitId: t.id, amount: 1, kind: 'structure' })
      this.say(`${t.name} takes STRUCTURE damage (${t.structure} left).`, 'damage')
      t.hp = t.stats.hp - excess
      for (const s of scriptsFor(t)) s.onStructureDamage?.(this, t)
      this.structureCheck(t)
    }
  }

  heal(u: Unit, amount: number) {
    if (u.destroyed) return
    u.hp = Math.min(u.stats.hp, u.hp + amount)
    this.say(`${u.name} recovers ${amount} HP.`)
  }

  // ------------------------------------------------------------------ movement
  private passable(u: Unit, at: Pos, mover: Set<string>): 'ok' | 'pass' | 'blocked' {
    for (const p of footprint(u, at)) {
      const t = tileAt(this.map, p)
      if (!t) return 'blocked'
    }
    let res: 'ok' | 'pass' = 'ok'
    const fp = new Set(footprint(u, at).map(key))
    for (const o of this.alive()) {
      if (o === u || mover.has(o.id)) continue
      if (!footprint(o).some(p => fp.has(key(p)))) continue
      if (o.kind === 'deployable' && !o.flags.isCover && o.stats.size < 1) continue
      if (this.hostile(u, o) && !this.has(o, 'hidden') && o.kind !== 'deployable') return 'blocked'
      if (o.flags.isCover || o.kind === 'deployable') return 'blocked'
      res = 'pass' // allies: may pass through, not stop
    }
    return res
  }

  stepCost(u: Unit, from: Pos, to: Pos): number {
    let c = 1
    if (u.flying) return 1
    const fp = footprint(u, to)
    const difficult = this.has(u, 'prone') || fp.some(p => {
      const t = tileAt(this.map, p)
      return t?.kind === 'rubble' || t?.kind === 'water' || this.areas.some(a => a.kind === 'difficult' && a.tiles.some(q => q.x === p.x && q.y === p.y))
    })
    if (difficult) c *= 2
    const dh = elevationAt(this.map, u, to) - elevationAt(this.map, u, from)
    if (dh > 1) c += dh - 1
    return c
  }

  /** Dijkstra over anchor positions. Returns reachable stop positions with cost and path. */
  reachable(u: Unit, budget: number, opts: { ignoreEngagement?: boolean } = {}): Map<string, { pos: Pos; cost: number; prev?: string }> {
    const startKey = key(u.pos)
    const dist = new Map<string, { pos: Pos; cost: number; prev?: string; terminal: boolean; stop: boolean }>()
    const startAdj = new Set(this.alive().filter(o => this.hostile(u, o) && this.adjacent(u, o)).map(o => o.id))
    dist.set(startKey, { pos: u.pos, cost: 0, terminal: false, stop: true })
    const open: string[] = [startKey]
    const mover = new Set([u.id])
    while (open.length) {
      open.sort((a, b) => dist.get(a)!.cost - dist.get(b)!.cost)
      const k = open.shift()!
      const cur = dist.get(k)!
      if (cur.terminal) continue
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue
        const np = { x: cur.pos.x + dx, y: cur.pos.y + dy }
        const pass = this.passable(u, np, mover)
        if (pass === 'blocked') continue
        const c = cur.cost + this.stepCost(u, cur.pos, np)
        if (c > budget) continue
        const nk = key(np)
        const prev = dist.get(nk)
        if (prev && prev.cost <= c) continue
        let terminal = false
        if (!opts.ignoreEngagement && u.kind !== 'deployable') {
          for (const o of this.alive()) {
            if (!this.hostile(u, o) || startAdj.has(o.id) || (o.kind !== 'mech' && o.kind !== 'npc') || this.has(o, 'hidden')) continue
            if ((o.stats.size >= u.stats.size || o.flags.localizedMaze) && this.adjacent(u, o, np)) { terminal = true; break }
          }
        }
        dist.set(nk, { pos: np, cost: c, prev: k, terminal, stop: pass === 'ok' })
        open.push(nk)
      }
    }
    const out = new Map<string, { pos: Pos; cost: number; prev?: string }>()
    for (const [k, v] of dist) if (v.stop) out.set(k, v)
    // keep pass-through nodes for path reconstruction
    ;(out as any).all = dist
    return out
  }

  pathTo(u: Unit, dest: Pos, budget: number, opts: { ignoreEngagement?: boolean } = {}): { path: Pos[]; cost: number } | null {
    const r = this.reachable(u, budget, opts)
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

  canMove(u: Unit, mode: MoveOpts['mode']): true | string {
    if (mode === 'involuntary') return true
    if (this.has(u, 'immobilized')) return 'Immobilized'
    if (this.has(u, 'stunned')) return 'Stunned'
    if (this.has(u, 'grappled') && u.statuses.find(s => s.id === 'grappled')?.data?.by !== u.id) return 'Grappled'
    if (mode !== 'standard' && this.has(u, 'slowed') && mode !== 'disengage') return 'Slowed'
    return true
  }

  /** Move a unit along the cheapest path. Standard moves spend moveLeft. */
  move(u: Unit, dest: Pos, opts: MoveOpts = { mode: 'standard' }): boolean {
    const ok = this.canMove(u, opts.mode)
    if (ok !== true) throw new Error(ok)
    if (this.has(u, 'prone') && opts.mode === 'standard') throw new Error('Stand up first')
    const budget = opts.mode === 'standard' ? u.moveLeft : u.flags.pendingMove ?? u.stats.speed
    const p = this.pathTo(u, dest, budget, { ignoreEngagement: opts.ignoreEngagement || opts.mode === 'involuntary' })
    if (!p) throw new Error('Unreachable')
    if (p.path.length <= 1) return true
    if (opts.mode === 'standard') u.moveLeft -= p.cost
    else if (u.flags.pendingMove != null) u.flags.pendingMove = Math.max(0, u.flags.pendingMove - p.cost)
    if (opts.mode !== 'involuntary') { u.actedThisTurn = true; u.flags['turn:moved'] = true }
    // overwatch triggers at the start of voluntary movement
    if (opts.mode !== 'involuntary' && !u.flags['turn:disengaged']) this.triggerOverwatch(u)
    if (u.destroyed) return false
    if (this.has(u, 'stunned') || this.has(u, 'immobilized')) return false
    this.followPath(u, p.path)
    return true
  }

  private followPath(u: Unit, path: Pos[]) {
    let maxDrop = 0
    let prevE = elevationAt(this.map, u, path[0])
    let lowest = prevE
    for (const step of path.slice(1)) {
      const e = elevationAt(this.map, u, step)
      if (e < prevE) maxDrop = Math.max(maxDrop, prevE - e)
      prevE = e
      lowest = Math.min(lowest, e)
      u.pos = step
      // mines
      for (const m of [...this.mines]) {
        if (m.side === u.side || u.flags.skeletonKey) continue
        if (footprint(u).some(q => chebyshev(q, m.pos) <= m.radius)) this.detonateMine(m)
      }
      // hazard tiles
      const hz = footprint(u).some(q => tileAt(this.map, q)?.kind === 'hazard')
      if (hz && !u.flags['round:hazard']) {
        u.flags['round:hazard'] = true
        if (!this.check(u, 'eng')) this.applyDamage(u, [{ type: 'Energy', amount: 5 }], {})
      }
      if (u.destroyed) break
    }
    this.emit({ type: 'move', unitId: u.id, path })
    for (const o of this.alive()) for (const s of scriptsFor(o)) s.onMove?.(this, o, u, path)
    if (!u.flying && maxDrop >= 3 && !u.destroyed) {
      const dmg = 3 * Math.floor(maxDrop / 3)
      this.say(`${u.name} falls ${maxDrop} spaces.`)
      this.applyDamage(u, [{ type: 'Kinetic', amount: dmg }], { ap: true })
    }
    // hidden is lost if no longer in cover / out of sight
    if (this.has(u, 'hidden') && !this.canHide(u)) this.removeStatus(u, 'hidden')
    this.updateEngagementTerminal(u)
  }
  private updateEngagementTerminal(_u: Unit) {}

  /** Push/pull (involuntary). dir: +1 away from source, -1 toward source. */
  forceMove(target: Unit, source: Unit | Pos, spaces: number, dir: 1 | -1) {
    if (target.destroyed || spaces <= 0) return
    if (target.kind === 'deployable' && target.stats.speed === 0) return
    const srcUnit = 'stats' in (source as any) ? (source as Unit) : undefined
    for (const s of scriptsFor(target)) if (s.canBeMoved && !s.canBeMoved(this, target, srcUnit)) { this.say(`${target.name} holds its ground.`); return }
    for (const o of this.alive()) for (const s of scriptsFor(o)) s.onAnyMovementAction?.(this, o, target, 'involuntary')
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
      if (this.passable(target, np, new Set([target.id])) !== 'ok') {
        this.say(`${target.name} slams into an obstacle.`)
        break
      }
      const climb = elevationAt(this.map, target, np) - elevationAt(this.map, target, target.pos)
      if (climb > 1 && !target.flying) { this.say(`${target.name} slams into a wall.`); break }
      target.pos = np
      path.push(np)
    }
    if (path.length > 1) {
      this.say(`${target.name} is ${dir === 1 ? 'knocked back' : 'pulled'} ${path.length - 1}.`)
      this.followPath(target, path)
    }
  }

  // ------------------------------------------------------------------ reactions
  private triggerOverwatch(mover: Unit) {
    if (this.reactionDepth > 0) return
    for (const o of this.alive()) {
      if (mover.destroyed) return
      if (!this.hostile(o, mover) || !o.policies.autoOverwatch) continue
      if (this.canSpend(o, 'reaction') !== true) continue
      const w = this.bestThreatWeapon(o, mover)
      if (!w) continue
      this.say(`${o.name} takes OVERWATCH on ${mover.name}!`, 'attack')
      o.reactionsLeft--
      this.reactionDepth++
      try { this.weaponAttack(o, w, { targetId: mover.id }, 'overwatch') } finally { this.reactionDepth-- }
    }
  }
  bestThreatWeapon(o: Unit, target: Unit): Weapon | null {
    let best: Weapon | null = null, bestDmg = -1
    for (const w of o.weapons) {
      if (!this.weaponReady(o, w)) continue
      const pr = w.profiles[w.profileIndex]
      if (this.isAoE(pr)) continue
      const threat = this.weaponThreat(o, w)
      if (threat <= 0 || this.distance(o, target) > threat) continue
      if (!this.los(o, target)) continue
      const avg = pr.damage.reduce((a, d) => a + averageDice(d.val), 0)
      if (avg > bestDmg) { best = w; bestDmg = avg }
    }
    return best
  }

  // ------------------------------------------------------------------ weapons
  profile(w: Weapon): Profile {
    return w.profiles[w.profileIndex]
  }
  weaponTags(u: Unit, w: Weapon): TagData[] {
    return this.profile(w).tags
  }
  isMelee(w: Weapon): boolean {
    return w.type === 'Melee' || this.profile(w).range.every(r => r.type === 'Threat' || r.type === 'Thrown')
  }
  isAoE(p: Profile): boolean {
    return p.range.some(r => ['Blast', 'Burst', 'Line', 'Cone'].includes(r.type))
  }
  private bonusApplies(b: BonusData, w: Weapon, rangeType?: string, damageType?: string): boolean {
    if (b.weapon_types && !b.weapon_types.includes(w.type)) return false
    if (b.weapon_sizes && !b.weapon_sizes.includes(w.size)) return false
    if (rangeType && b.range_types && !b.range_types.includes(rangeType)) return false
    if (b.damage_types && !this.profile(w).damage.some(d => b.damage_types!.includes(d.type))) return false
    if (damageType && b.damage_types && !b.damage_types.includes(damageType)) return false
    return true
  }
  ranges(u: Unit, w: Weapon): RangeData[] {
    const pr = this.profile(w)
    const all = [...u.bonuses, ...w.bonuses]
    return pr.range.map(r => {
      let v = Number(r.val) || 0
      for (const b of all) {
        if (b.condition && !this.evalCondition(u, b.condition)) continue
        if ((b.id === 'range' || (b.id === 'threat' && r.type === 'Threat')) && this.bonusApplies(b, w, r.type)) v += Number(b.val) || 0
      }
      return { ...r, val: v }
    })
  }
  weaponThreat(u: Unit, w: Weapon): number {
    const rs = this.ranges(u, w)
    const t = rs.find(r => r.type === 'Threat')
    let v = t ? Number(t.val) : this.isMelee(w) ? 1 : 0
    if (u.flags.hyperReflex && !this.isMelee(w) && !this.isAoE(this.profile(w))) v = Math.max(v, 3)
    return v
  }
  weaponReach(u: Unit, w: Weapon): number {
    const rs = this.ranges(u, w)
    let m = 0
    for (const r of rs) if (r.type === 'Range' || r.type === 'Threat' || r.type === 'Thrown' || r.type === 'Line' || r.type === 'Cone') m = Math.max(m, Number(r.val))
    if (!rs.length) m = 1
    const thrown = [...u.bonuses, ...w.bonuses].find(b => b.id === 'thrown' && this.bonusApplies(b, w))
    if (thrown) m = Math.max(m, Number(thrown.val))
    return m
  }
  weaponReady(u: Unit, w: Weapon): boolean {
    return !w.destroyed && w.loaded && w.usesLeft !== 0 && w.charged
  }
  weaponUsable(u: Unit, w: Weapon): true | string {
    if (w.destroyed) return 'Destroyed'
    if (!w.loaded) return 'Needs reloading'
    if (w.usesLeft === 0) return 'No uses left'
    if (!w.charged) return 'Recharging'
    if (this.has(u, 'jammed') && !(u.flags.shieldedMagazines && !this.isMelee(w))) return 'Jammed'
    const pr = this.profile(w)
    if (!pr.damage.length && !pr.onHit.length && !w.tech) {
      const d = w.dataId ? Lancer.weapons.get(w.dataId) : undefined
      if (d?.no_attack) return 'This weapon cannot attack'
    }
    return true
  }

  /** Targets (or aim tile) validity for a weapon attack */
  validTarget(u: Unit, w: Weapon, t: Unit, from: Pos = u.pos): true | string {
    if (t.destroyed) return 'Destroyed'
    if (t === u) return 'Cannot target self'
    if (this.has(t, 'hidden') && this.hostile(u, t)) return 'Hidden'
    const pr = this.profile(w)
    const tags = pr.tags
    const reach = this.weaponReach(u, w)
    const d = distanceBetween(this.map, { ...u, pos: from }, t)
    if (d > reach) return `Out of range (${d}/${reach})`
    const minR = u.bonuses.find(b => b.id === 'min_range')
    void minR
    if (!hasTag(tags, 'tg_seeking') && !hasTag(tags, 'tg_arcing') && !this.los(u, t, from)) return 'No line of sight'
    return true
  }

  aoeTiles(u: Unit, w: Weapon, aim: Pos): Pos[] | string {
    const rs = this.ranges(u, w)
    const blast = rs.find(r => r.type === 'Blast')
    const burst = rs.find(r => r.type === 'Burst')
    const line = rs.find(r => r.type === 'Line')
    const cone = rs.find(r => r.type === 'Cone')
    if (burst) return burstTiles(this.map, u, Number(burst.val))
    if (line) return lineTiles(this.map, u, aim, Number(line.val))
    if (cone) return coneTiles(this.map, u, aim, Number(cone.val))
    if (blast) {
      const range = rs.find(r => r.type === 'Range')
      const reach = range ? Number(range.val) : 1
      if (distanceToTile(this.map, u, aim) > reach) return 'Out of range'
      if (!hasTag(this.profile(w).tags, 'tg_arcing') && !hasTag(this.profile(w).tags, 'tg_seeking') && !hasLineOfSightToTile(this.effectiveMap(), u, aim)) return 'No line of sight to blast centre'
      return blastTiles(this.map, aim, Number(blast.val))
    }
    return 'Not an area weapon'
  }

  /** Damage bonus (flat) from bonuses, per damage type */
  private flatDamageBonus(u: Unit, w: Weapon, type: string): number {
    let n = 0
    for (const b of [...u.bonuses, ...w.bonuses]) {
      if (b.id !== 'damage' || typeof b.val !== 'number') continue
      if (b.condition && !this.evalCondition(u, b.condition)) continue
      if (this.bonusApplies(b, w, undefined, type)) n += b.val
    }
    return n
  }

  newAttackCtx(attacker: Unit, target: Unit, partial: Partial<AttackCtx>): AttackCtx {
    return {
      attacker, target, tech: false, melee: false, ranged: true, multiTarget: false, accuracy: 0, difficulty: 0,
      attackBonus: attacker.stats.attackBonus, bonusDamage: [], ignoreCover: false, noLosNeeded: false, reasons: [], mode: 'free',
      ...partial,
    }
  }

  /** Compute accuracy/difficulty and the to-hit chance for previews and the AI (no randomness consumed). */
  previewAttack(attacker: Unit, w: Weapon, target: Unit, from: Pos = attacker.pos, mode: AttackCtx['mode'] = 'skirmish'): { ctx: AttackCtx; chance: number; cover: Cover; expectedDamage: number } {
    const saved = attacker.pos
    attacker.pos = from
    try {
      const ctx = this.buildWeaponCtx(attacker, w, target, mode, false)
      const def = this.defenseOf(target, ctx)
      const chance = hitChance(ctx.attackBonus, ctx.accuracy - ctx.difficulty, def)
      const pr = this.profile(w)
      let dmg = 0
      for (const d of pr.damage) if (d.type !== 'Heat') dmg += averageDice(d.val) + this.flatDamageBonus(attacker, w, d.type)
      dmg = Math.max(0, dmg - (hasTag(pr.tags, 'tg_ap') ? 0 : target.stats.armor))
      if (this.has(target, 'exposed')) dmg *= 2
      let exp = dmg * chance
      const rel = tagVal(pr.tags, 'tg_reliable')
      if (rel) exp += (1 - chance) * rel
      return { ctx, chance, cover: this.cover(attacker, target), expectedDamage: exp }
    } finally {
      attacker.pos = saved
    }
  }

  defenseOf(t: Unit, ctx: AttackCtx): number {
    if (ctx.tech || (ctx.weapon && (ctx.weapon.vsEdef || hasTag(this.profile(ctx.weapon).tags, 'tg_smart')))) return t.stats.edef
    let ev = t.stats.evasion
    if (this.has(t, 'stunned')) ev = Math.min(ev, 5)
    return ev
  }

  private buildWeaponCtx(attacker: Unit, w: Weapon, target: Unit, mode: AttackCtx['mode'], consume: boolean, multi = false): AttackCtx {
    const pr = this.profile(w)
    const melee = this.isMelee(w)
    const ctx = this.newAttackCtx(attacker, target, { weapon: w, profile: pr, melee, ranged: !melee, mode, multiTarget: multi })
    if (w.attackBonus != null) ctx.attackBonus = w.attackBonus
    if (w.tech) { ctx.tech = true; ctx.ignoreCover = true; ctx.ranged = false; ctx.attackBonus = w.attackBonus ?? attacker.stats.techAttack }
    if (w.accuracy) { if (w.accuracy > 0) ctx.accuracy += w.accuracy; else ctx.difficulty -= w.accuracy }
    if (hasTag(pr.tags, 'tg_accurate')) { ctx.accuracy++; ctx.reasons.push('Accurate +1') }
    if (hasTag(pr.tags, 'tg_inaccurate')) { ctx.difficulty++; ctx.reasons.push('Inaccurate -1') }
    if (hasTag(pr.tags, 'tg_seeking')) ctx.ignoreCover = true
    if (this.has(attacker, 'impaired')) { ctx.difficulty++; ctx.reasons.push('Impaired -1') }
    if (this.has(target, 'prone')) { ctx.accuracy++; ctx.reasons.push('Prone target +1') }
    if (this.has(target, 'braced')) { ctx.difficulty++; ctx.reasons.push('Braced target -1') }
    if (!melee && this.isEngaged(attacker) && !ctx.tech) { ctx.difficulty++; ctx.reasons.push('Engaged -1') }
    if (this.has(target, 'lockon') && this.hostile(attacker, target)) {
      ctx.accuracy++
      ctx.reasons.push('Lock On +1')
      if (consume) this.removeStatus(target, 'lockon')
    }
    for (const b of [...attacker.bonuses, ...w.bonuses]) {
      if (b.id === 'attack' && typeof b.val === 'number' && !b.accuracy && this.bonusApplies(b, w)) { ctx.attackBonus += b.val; ctx.reasons.push(`+${b.val} attack`) }
    }
    for (const b of attacker.bonuses) {
      if (b.id === 'attack' && b.accuracy) { if (!b.condition || this.evalCondition(attacker, b.condition)) { ctx.accuracy += b.accuracy; ctx.reasons.push(`Bonus +${b.accuracy}`) } }
      if (b.id === 'tech_attack' && b.accuracy && ctx.tech) ctx.accuracy += b.accuracy
    }
    for (const b of w.bonuses) if (b.id === 'mount_accuracy') { ctx.accuracy += Number(b.val) || 1; ctx.reasons.push('Hardpoints +1') }
    if (!ctx.ignoreCover && !melee) {
      const c = this.cover(attacker, target)
      if (c === 'hard') { ctx.difficulty += 2; ctx.reasons.push('Hard cover -2') }
      else if (c === 'soft') { ctx.difficulty += 1; ctx.reasons.push('Soft cover -1') }
    }
    for (const s of scriptsFor(attacker)) s.beforeAttack?.(this, attacker, ctx, 'attacker')
    for (const s of scriptsFor(target)) s.beforeAttack?.(this, target, ctx, 'target')
    for (const o of this.alive()) for (const s of scriptsFor(o)) s.beforeAnyAttack?.(this, o, ctx)
    return ctx
  }

  /** Main entry for weapon attacks (skirmish/barrage call this). Handles AoE, rolls and on-hit effects. */
  weaponAttack(u: Unit, w: Weapon, aim: AttackAim, mode: AttackCtx['mode'] = 'free', opts: { noBonusDamage?: boolean } = {}): AttackSummary {
    const usable = this.weaponUsable(u, w)
    if (usable !== true) return { ctxs: [], ok: false, reason: usable }
    const pr = this.profile(w)
    let targets: Unit[] = []
    let tiles: Pos[] | null = null
    if (this.isAoE(pr)) {
      const aimTile = aim.tile ?? (aim.targetId ? this.unit(aim.targetId)!.pos : u.pos)
      const t = this.aoeTiles(u, w, aimTile)
      if (typeof t === 'string') return { ctxs: [], ok: false, reason: t }
      tiles = t
      targets = unitsOnTiles(this.alive(), t).filter(x => x !== u && (x.kind !== 'deployable' || this.hostile(u, x)))
      this.emit({ type: 'area', tiles: t, kind: 'attack' })
    } else {
      const t = this.unit(aim.targetId)
      if (!t) return { ctxs: [], ok: false, reason: 'No target' }
      const v = this.validTarget(u, w, t)
      if (v !== true) return { ctxs: [], ok: false, reason: v }
      targets = [t]
    }
    this.say(`${u.name} attacks with ${w.name}${pr.name !== w.name ? ` (${pr.name})` : ''}.`, 'attack')
    u.flags['turn:attacked'] = true
    if (this.has(u, 'hidden')) this.removeStatus(u, 'hidden')
    // on_attack effects
    for (const e of pr.onAttack) if (e.do === 'text') this.say(`  ${stripHtml(e.text)}`)
    const multi = targets.length > 1
    // roll damage once for all targets
    const overkill = hasTag(pr.tags, 'tg_overkill')
    const ctxs: AttackCtx[] = []
    for (const t of targets) {
      const ctx = this.buildWeaponCtx(u, w, t, mode, true, multi)
      if (opts.noBonusDamage || w.noBonusDamage) ctx.bonusDamage = []
      this.rollToHit(ctx)
      ctxs.push(ctx)
    }
    const anyCrit = ctxs.some(c => c.crit)
    const dmgNormal: { type: string; amount: number }[] = []
    const dmgCrit: { type: string; amount: number }[] = []
    let overkillHeat = 0
    for (const d of pr.damage) {
      const flat = this.flatDamageBonus(u, w, d.type)
      const r1 = rollDice(this.rng, d.val, { overkill })
      overkillHeat += r1.overkillHeat
      dmgNormal.push({ type: d.type, amount: Math.max(0, r1.total + flat) })
      if (anyCrit) {
        const r2 = rollDice(this.rng, d.val, { crit: true, overkill })
        overkillHeat += r2.overkillHeat
        dmgCrit.push({ type: d.type, amount: Math.max(0, r2.total + flat) })
      }
    }
    for (const ctx of ctxs) {
      const t = ctx.target
      if (ctx.hit) {
        const base = (ctx.crit ? dmgCrit : dmgNormal).map(x => ({ ...x, amount: u.flags.halfDamage ? Math.ceil(x.amount / 2) : x.amount }))
        // bonus damage (halved vs multiple targets)
        for (const bd of ctx.bonusDamage) {
          let a = rollDice(this.rng, bd.val, { crit: ctx.crit }).total
          if (multi) a = Math.ceil(a / 2)
          base.push({ type: bd.type, amount: a })
        }
        for (const e of [...pr.onHit, ...(ctx.crit ? pr.onCrit : [])]) if (e.do === 'bonus_damage') {
          let a = rollDice(this.rng, e.val, { crit: ctx.crit }).total
          if (multi) a = Math.ceil(a / 2)
          base.push({ type: e.type ?? pr.damage[0]?.type ?? 'Kinetic', amount: a })
        }
        const burnTag = tagVal(pr.tags, 'tg_burn')
        if (burnTag) base.push({ type: 'Burn', amount: burnTag })
        const heatTag = tagVal(pr.tags, 'tg_heat_target')
        if (heatTag) base.push({ type: 'Heat', amount: heatTag })
        let resistAll = !!ctx.resistAll
        if (!ctx.cancelDamage && !resistAll && t.policies.autoBrace && this.shouldBrace(t, base)) resistAll = this.brace(t)
        if (t.flags.flashAegis && resistAll && !ctx.resistAll) for (const p of base) p.amount = Math.min(p.amount, 1)
        if (!ctx.cancelDamage) ctx.damageDealt = this.applyDamage(t, base, {
          source: u, attack: ctx, ap: hasTag(pr.tags, 'tg_ap'), irreducible: hasTag(pr.tags, 'tg_irreducible') || ctx.irreducible, resistAll,
        })
        const kb = (tagVal(pr.tags, 'tg_knockback') ?? 0) + u.bonuses.filter(b => b.id === 'knockback' && this.bonusApplies(b, w)).reduce((a, b) => a + Number(b.val), 0)
        if (kb && !t.destroyed) this.forceMove(t, u, kb, 1)
        this.runEffects(u, t, pr.onHit.filter(e => e.do !== 'bonus_damage'), ctx)
        if (ctx.crit) this.runEffects(u, t, pr.onCrit.filter(e => e.do !== 'bonus_damage'), ctx)
      } else {
        const rel = tagVal(pr.tags, 'tg_reliable')
        if (rel && !t.isGrunt) {
          this.say(`  Reliable: ${rel} damage.`)
          this.applyDamage(t, [{ type: pr.damage[0]?.type ?? 'Kinetic', amount: rel }], { source: u, ap: hasTag(pr.tags, 'tg_ap') })
        }
      }
      for (const s of scriptsFor(u)) s.afterAttack?.(this, u, ctx, 'attacker')
      if (!t.destroyed) for (const s of scriptsFor(t)) s.afterAttack?.(this, t, ctx, 'target')
      if (this.reactionDepth < 2) {
        this.reactionDepth++
        try { for (const o of this.alive()) for (const s of scriptsFor(o)) s.afterAnyAttack?.(this, o, ctx) } finally { this.reactionDepth-- }
      }
    }
    // costs
    const heatSelf = tagVal(pr.tags, 'tg_heat_self')
    if (heatSelf) this.addHeat(u, heatSelf)
    if (overkillHeat) { this.say(`  Overkill: +${overkillHeat} heat.`); this.addHeat(u, overkillHeat) }
    if (hasTag(pr.tags, 'tg_loading')) w.loaded = false
    if (w.usesLeft != null) w.usesLeft--
    if (w.recharge != null) w.charged = false
    if (tiles && pr.onAttack.some(e => e.do !== 'text')) this.runEffects(u, u, pr.onAttack, undefined)
    return { ctxs, ok: true }
  }

  rollToHit(ctx: AttackCtx) {
    const t = ctx.target
    const net = ctx.accuracy - ctx.difficulty
    if (ctx.cancelled) {
      ctx.hit = false
      ctx.crit = false
      this.emit({ type: 'attack', attackerId: ctx.attacker.id, targetId: t.id, hit: false, crit: false, weapon: ctx.weapon?.name ?? 'tech', total: 0 })
      return
    }
    if ((this.has(t, 'invisible') || ctx.forceInvisible) && this.rng.d(6) <= 3) {
      ctx.hit = false
      ctx.crit = false
      this.say(`  vs ${t.name}: misses (invisible).`)
      this.emit({ type: 'attack', attackerId: ctx.attacker.id, targetId: t.id, hit: false, crit: false, weapon: ctx.weapon?.name ?? 'tech', total: 0 })
      return
    }
    let d20 = this.rng.d(20)
    let acc = rollAccuracy(this.rng, net)
    let total = d20 + ctx.attackBonus + acc.bonus
    const def = this.defenseOf(t, ctx)
    if (total < def && ctx.rerollOnMiss) {
      this.say(`  ${ctx.attacker.name} rerolls (${total}).`)
      d20 = this.rng.d(20)
      acc = rollAccuracy(this.rng, net)
      total = d20 + ctx.attackBonus + acc.bonus
    }
    ctx.roll = d20
    ctx.total = total
    ctx.hit = total >= def
    ctx.crit = ctx.hit && total >= 20 && ctx.attacker.canCrit && !ctx.tech
    const accTxt = net ? ` ${net > 0 ? '+' : '-'}${Math.abs(net)}${net > 0 ? 'acc' : 'diff'}[${acc.dice.join(',')}]` : ''
    this.say(`  vs ${t.name}: ${total} (d20 ${d20} +${ctx.attackBonus}${accTxt}) vs ${ctx.tech || (ctx.weapon && (ctx.weapon.vsEdef || hasTag(this.profile(ctx.weapon).tags, 'tg_smart'))) ? 'E-DEF' : 'EVA'} ${def} — ${ctx.crit ? 'CRITICAL HIT' : ctx.hit ? 'HIT' : 'MISS'}`, 'attack')
    for (const o of this.alive()) for (const sc of scriptsFor(o)) sc.afterAnyRoll?.(this, o, ctx)
    if (!ctx.hit) ctx.crit = false
    this.emit({ type: 'attack', attackerId: ctx.attacker.id, targetId: t.id, hit: !!ctx.hit, crit: !!ctx.crit, weapon: ctx.weapon?.name ?? 'tech', total })
  }

  /** Run DSL effects from `src` against `target`. */
  runEffects(src: Unit, target: Unit, effects: Effect[], ctx?: AttackCtx, saveTarget?: number) {
    const st = saveTarget ?? (src.stats.save || 10)
    for (const e of effects) {
      const who = e.do !== 'text' && e.do !== 'bonus_damage' && e.do !== 'teleport' && (e as any).target === 'self' ? src : target
      if (who.destroyed && e.do !== 'text') continue
      const saved = 'save' in e && e.save ? this.save(who, e.save, st) : false
      switch (e.do) {
        case 'text':
          this.say(`  ${stripHtml(e.text)}`)
          break
        case 'status':
          if (!saved) this.addStatus(who, e.status, e.duration ?? 'next_turn_end_target', src)
          break
        case 'damage': {
          const parts = e.damage.map(d => ({ type: d.type, amount: rollDice(this.rng, d.val).total }))
          if (saved) { if (e.saveHalf && !who.isGrunt) this.applyDamage(who, parts.map(p => ({ ...p, amount: this.halfOnSave(who, p.amount) })), { source: src, ap: e.ap }) }
          else this.applyDamage(who, parts, { source: src, ap: e.ap })
          break
        }
        case 'heat':
          if (!saved) this.applyDamage(who, [{ type: 'Heat', amount: rollDice(this.rng, e.val).total }], { source: src })
          break
        case 'burn':
          if (!saved) this.applyDamage(who, [{ type: 'Burn', amount: e.val }], { source: src })
          break
        case 'push':
        case 'pull':
          if (!saved) this.forceMove(who, src, rollDice(this.rng, e.val).total, e.do === 'push' ? 1 : -1)
          break
        case 'overshield': {
          const v = rollDice(this.rng, e.val).total
          who.overshield = Math.max(who.overshield, v)
          this.say(`${who.name} gains ${v} overshield.`)
          break
        }
        case 'heal':
          this.heal(who, rollDice(this.rng, e.val).total)
          break
        case 'clear_heat': {
          const v = e.val === 'all' ? who.heat : rollDice(this.rng, e.val).total
          who.heat = Math.max(0, who.heat - v)
          this.say(`${who.name} clears ${v} heat.`)
          break
        }
        case 'clear_status': {
          const s = e.status === 'any_negative' || !e.status ? who.statuses.find(s => NEGATIVE.includes(s.id))?.id : e.status
          if (s) this.removeStatus(who, s)
          break
        }
        case 'teleport':
          break
        case 'bonus_damage':
          break
      }
    }
  }

  // ------------------------------------------------------------------ brace
  shouldBrace(t: Unit, parts: { type: string; amount: number }[]): boolean {
    if (t.kind !== 'mech' && !(t.kind === 'npc' && t.stats.structure > 1)) return false
    if (this.canSpend(t, 'reaction') !== true) return false
    const est = parts.filter(p => p.type !== 'Heat').reduce((a, p) => a + p.amount, 0) * (this.has(t, 'exposed') ? 2 : 1) - t.stats.armor
    return est >= t.hp + t.overshield && t.structure <= Math.max(2, t.stats.structure - 1)
  }
  brace(t: Unit): boolean {
    if (this.canSpend(t, 'reaction') !== true) return false
    t.reactionsLeft--
    this.say(`${t.name} BRACES for impact!`, 'status')
    this.addStatus(t, 'braced', 'next_turn_end_target')
    this.addStatus(t, 'bracing_recovery', 'next_turn_end_target')
    return true
  }

  // ------------------------------------------------------------------ standard actions
  skirmish(u: Unit, w: Weapon, aim: AttackAim, aux?: { weapon: Weapon; aim: AttackAim }): AttackSummary {
    if (w.size === 'Superheavy') return { ctxs: [], ok: false, reason: 'Superheavy weapons require Barrage' }
    const c = this.canSpend(u, 'quick')
    if (c !== true) return { ctxs: [], ok: false, reason: c }
    const pre = this.weaponUsable(u, w)
    if (pre !== true) return { ctxs: [], ok: false, reason: pre }
    if (this.firedThisTurn(u, w)) return { ctxs: [], ok: false, reason: 'Each weapon can only attack once per turn' }
    this.spend(u, 'quick')
    this.markFired(u, w)
    const r = this.weaponAttack(u, w, aim, 'skirmish')
    if (aux && aux.weapon.size === 'Auxiliary' && aux.weapon !== w && aux.weapon.mountIndex === w.mountIndex && w.mountIndex >= 0 && !u.destroyed && !this.firedThisTurn(u, aux.weapon)) {
      this.markFired(u, aux.weapon)
      const r2 = this.weaponAttack(u, aux.weapon, aux.aim, 'skirmish', { noBonusDamage: true })
      r.ctxs.push(...r2.ctxs)
    }
    return r
  }

  barrage(u: Unit, a: { weapon: Weapon; aim: AttackAim }, b?: { weapon: Weapon; aim: AttackAim }): AttackSummary {
    const c = this.canSpend(u, 'full')
    if (c !== true) return { ctxs: [], ok: false, reason: c }
    if (b && a.weapon === b.weapon) return { ctxs: [], ok: false, reason: 'Barrage needs two different weapons' }
    if (this.firedThisTurn(u, a.weapon) || (b && this.firedThisTurn(u, b.weapon))) return { ctxs: [], ok: false, reason: 'Each weapon can only attack once per turn' }
    const ua = this.weaponUsable(u, a.weapon)
    if (ua !== true) return { ctxs: [], ok: false, reason: ua }
    this.markFired(u, a.weapon)
    if (b) this.markFired(u, b.weapon)
    if (a.weapon.size !== 'Superheavy' && !b) {
      // allowed but wasteful: barrage with one weapon
    }
    this.spend(u, 'full')
    const r = this.weaponAttack(u, a.weapon, a.aim, 'barrage')
    if (b && a.weapon.size !== 'Superheavy' && !u.destroyed) {
      const r2 = this.weaponAttack(u, b.weapon, b.aim, 'barrage')
      r.ctxs.push(...r2.ctxs)
    }
    return r
  }

  firedThisTurn(u: Unit, w: Weapon): boolean {
    return (u.flags['turn:fired'] ?? []).includes(w.uid)
  }
  markFired(u: Unit, w: Weapon) {
    u.flags['turn:fired'] = [...(u.flags['turn:fired'] ?? []), w.uid]
  }

  boost(u: Unit) {
    const c = this.canSpend(u, 'quick')
    if (c !== true) throw new Error(c)
    if (this.has(u, 'slowed') || this.has(u, 'immobilized')) throw new Error('Cannot boost while slowed/immobilized')
    this.spend(u, 'quick')
    const extra = u.bonuses.filter(b => b.id === 'boost').reduce((a, b) => a + Number(b.val), 0)
    u.moveLeft += u.stats.speed + extra
    u.boostedThisTurn = true
    if (this.has(u, 'hidden')) this.removeStatus(u, 'hidden')
    this.say(`${u.name} BOOSTS (+${u.stats.speed + extra} move).`)
    u.flags['round:boosted'] = true
    for (const o of this.alive()) for (const s of scriptsFor(o)) s.onAnyMovementAction?.(this, o, u, 'boost')
  }

  standUp(u: Unit) {
    if (!this.has(u, 'prone')) return
    if (this.has(u, 'immobilized')) throw new Error('Immobilized')
    u.moveLeft = 0
    this.removeStatus(u, 'prone')
  }

  overcharge(u: Unit) {
    if (u.kind !== 'mech') throw new Error('Only mechs can overcharge')
    if (!u.activeTurn || u.overchargedThisTurn) throw new Error('Already overcharged this turn')
    if (this.has(u, 'stunned') || this.has(u, 'bracing_recovery')) throw new Error('Cannot overcharge')
    const track = (u.bonuses.find(b => b.id === 'overcharge')?.val as string[]) ?? (Lancer.rules.overcharge as string[])
    const cost = rollDice(this.rng, track[Math.min(u.overchargeLevel, track.length - 1)]).total
    u.overchargeLevel = Math.min(u.overchargeLevel + 1, track.length - 1)
    u.overchargedThisTurn = true
    u.flags.bonusQuick = (u.flags.bonusQuick ?? 0) + 1
    this.say(`${u.name} OVERCHARGES (+${cost} heat) — gains a quick action.`, 'status')
    this.addHeat(u, cost)
  }

  stabilize(u: Unit, mode: 'cool' | 'repair', clear?: { unit: Unit; status?: StatusId | 'burn' }) {
    const c = this.canSpend(u, 'full')
    if (c !== true) throw new Error(c)
    if (mode === 'repair' && u.repairs <= 0) throw new Error('No repairs left')
    this.spend(u, 'full')
    if (mode === 'cool') {
      u.heat = 0
      this.removeStatus(u, 'exposed')
      this.say(`${u.name} STABILIZES: cools reactor.`)
    } else {
      u.repairs--
      u.hp = u.stats.hp
      this.say(`${u.name} STABILIZES: spends a repair, HP restored.`)
    }
    const tgt = clear?.unit ?? u
    if (tgt.side === u.side && this.distance(u, tgt) <= 1) {
      if (clear?.status === 'burn' || (!clear?.status && tgt.burn > 0)) { tgt.burn = 0; this.say(`${tgt.name}'s burn is extinguished.`) }
      else {
        const s = (clear?.status as StatusId) ?? tgt.statuses.find(x => ['impaired', 'slowed', 'immobilized', 'jammed', 'shredded', 'lockon'].includes(x.id))?.id
        if (s) this.removeStatus(tgt, s)
      }
    }
    if (u.flags.machineBond) for (const s of ['impaired', 'jammed', 'immobilized', 'slowed', 'lockon'] as const) {
      const inst = u.statuses.find(x => x.id === s)
      if (inst && inst.source !== u.id) this.removeStatus(u, s)
    }
  }

  disengage(u: Unit) {
    const c = this.canSpend(u, 'full')
    if (c !== true) throw new Error(c)
    this.spend(u, 'full')
    u.flags['turn:disengaged'] = true
    this.say(`${u.name} DISENGAGES (ignores engagement and reactions this turn).`)
  }

  /** Hide: needs to be out of LoS of all hostiles or in cover from them. */
  canHide(u: Unit): boolean {
    if (this.has(u, 'invisible')) return true
    return this.alive().filter(o => this.hostile(u, o) && (o.kind === 'mech' || o.kind === 'npc')).every(o => !this.los(o, u) || this.cover(o, u) !== 'none') && !this.isEngaged(u)
  }
  hide(u: Unit) {
    const c = this.canSpend(u, 'quick')
    if (c !== true) throw new Error(c)
    if (!this.canHide(u)) throw new Error('Need cover or to be out of sight of all hostiles')
    this.spend(u, 'quick')
    this.addStatus(u, 'hidden')
  }
  search(u: Unit) {
    const c = this.canSpend(u, 'quick')
    if (c !== true) throw new Error(c)
    this.spend(u, 'quick')
    for (const o of this.alive()) {
      if (!this.hostile(u, o) || !this.has(o, 'hidden') || this.distance(u, o) > u.stats.sensors) continue
      const roll = this.rng.d(20) + u.stats.sys
      const opp = this.rng.d(20) + o.stats.agi
      if (roll >= opp) { this.removeStatus(o, 'hidden'); this.say(`${u.name} finds ${o.name}!`) }
    }
  }

  ram(u: Unit, t: Unit) {
    const c = this.canSpend(u, 'quick')
    if (c !== true) throw new Error(c)
    if (!this.adjacent(u, t)) throw new Error('Must be adjacent')
    if (t.stats.size > u.stats.size) throw new Error('Target is too large')
    this.spend(u, 'quick')
    const ctx = this.newAttackCtx(u, t, { melee: true, ranged: false, mode: 'ram' })
    if (this.has(u, 'impaired')) ctx.difficulty++
    if (this.has(t, 'prone')) ctx.accuracy++
    for (const s of scriptsFor(u)) s.beforeAttack?.(this, u, ctx, 'attacker')
    this.say(`${u.name} RAMS ${t.name}.`, 'attack')
    this.rollToHit(ctx)
    if (ctx.hit) {
      this.addStatus(t, 'prone', 'until_cleared', u)
      this.forceMove(t, u, 1, 1)
    }
    for (const s of scriptsFor(u)) s.afterAttack?.(this, u, ctx, 'attacker')
  }

  grapple(u: Unit, t: Unit) {
    const c = this.canSpend(u, 'quick')
    if (c !== true) throw new Error(c)
    if (!this.adjacent(u, t)) throw new Error('Must be adjacent')
    this.spend(u, 'quick')
    const ctx = this.newAttackCtx(u, t, { melee: true, ranged: false, mode: 'grapple' })
    if (this.has(u, 'impaired')) ctx.difficulty++
    this.say(`${u.name} attempts to GRAPPLE ${t.name}.`, 'attack')
    this.rollToHit(ctx)
    if (ctx.hit) {
      this.addStatus(t, 'grappled', 'until_cleared', u, { by: u.id })
      this.addStatus(u, 'grappled', 'until_cleared', u, { by: u.id, with: t.id })
      if (t.stats.size < u.stats.size) this.addStatus(t, 'immobilized', 'until_cleared', u, { grapple: u.id })
    }
  }
  breakGrapple(u: Unit) {
    const c = this.canSpend(u, 'quick')
    if (c !== true) throw new Error(c)
    const g = u.statuses.find(s => s.id === 'grappled')
    if (!g) throw new Error('Not grappled')
    this.spend(u, 'quick')
    const other = this.unit(g.data?.by === u.id ? g.data?.with : g.data?.by)
    const mine = this.rng.d(20) + u.stats.hull
    const theirs = other ? this.rng.d(20) + other.stats.hull : 0
    if (mine > theirs || !other) {
      this.removeStatus(u, 'grappled')
      if (other) { this.removeStatus(other, 'grappled') }
      u.statuses = u.statuses.filter(s => !(s.id === 'immobilized' && s.data?.grapple))
      this.say(`${u.name} breaks free.`)
    } else this.say(`${u.name} fails to break the grapple.`)
  }

  improvisedAttack(u: Unit, t: Unit) {
    const c = this.canSpend(u, 'full')
    if (c !== true) throw new Error(c)
    if (!this.adjacent(u, t)) throw new Error('Must be adjacent')
    this.spend(u, 'full')
    const w: Weapon = {
      uid: 'improvised', name: 'Improvised Attack', mountIndex: -1, size: 'Main', type: 'Improvised', profileIndex: 0,
      profiles: [{ name: 'Improvised Attack', damage: [{ type: 'Kinetic', val: '1d6' }], range: [{ type: 'Threat', val: 1 }], tags: [], onAttack: [], onHit: [], onCrit: [] }],
      loaded: true, destroyed: false, charged: true, bonuses: [],
    }
    const brawler = u.bonuses.find(b => b.id === 'damage' && b.weapon_types?.includes('Improvised') && typeof b.val === 'string')
    if (brawler) w.profiles[0].damage = [{ type: 'Kinetic', val: brawler.val }]
    this.weaponAttack(u, w, { targetId: t.id }, 'improvised')
  }

  reload(u: Unit, w: Weapon) {
    const c = this.canSpend(u, 'quick')
    if (c !== true) throw new Error(c)
    this.spend(u, 'quick')
    w.loaded = true
    this.say(`${u.name} reloads ${w.name}.`)
  }

  shutDown(u: Unit) {
    const c = this.canSpend(u, 'quick')
    if (c !== true) throw new Error(c)
    this.spend(u, 'quick')
    u.heat = 0
    this.removeStatus(u, 'exposed')
    this.removeStatus(u, 'lockon')
    this.removeStatus(u, 'jammed')
    u.meltdownTurns = undefined
    this.addStatus(u, 'shutdown')
  }
  bootUp(u: Unit) {
    if (!u.activeTurn || !this.has(u, 'shutdown')) throw new Error('Not shut down')
    if (u.actionsLeft < 2) throw new Error('Needs a full action')
    u.actionsLeft = 0
    u.actedThisTurn = true
    this.removeStatus(u, 'shutdown')
    this.say(`${u.name} boots up.`)
  }
  selfDestruct(u: Unit) {
    const c = this.canSpend(u, 'quick')
    if (c !== true) throw new Error(c)
    this.spend(u, 'quick')
    u.selfDestructTurns = 2
    this.say(`${u.name} initiates SELF-DESTRUCT! It will explode at the end of its next turn.`, 'warn')
  }

  // ------------------------------------------------------------------ tech
  techTargetValid(u: Unit, t: Unit): true | string {
    if (this.has(u, 'jammed')) return 'Jammed'
    if (t.destroyed) return 'Destroyed'
    if (this.has(t, 'shutdown')) return 'Target is shut down (immune to tech)'
    if (this.hostile(u, t) && this.has(t, 'hidden')) return 'Hidden'
    if (this.distance(u, t) > u.stats.sensors) return 'Out of sensor range'
    if (!this.los(u, t)) return 'No line of sight'
    return true
  }
  private spendTech(u: Unit) {
    if ((u.flags.fullTechLeft ?? 0) > 0) { u.flags.fullTechLeft--; u.actedThisTurn = true; return }
    this.spend(u, 'quick')
  }
  canQuickTech(u: Unit): true | string {
    if ((u.flags.fullTechLeft ?? 0) > 0) return true
    return this.canSpend(u, 'quick')
  }
  /** Full Tech: two quick tech actions. */
  fullTech(u: Unit) {
    const c = this.canSpend(u, 'full')
    if (c !== true) throw new Error(c)
    this.spend(u, 'full')
    u.flags.fullTechLeft = 2
    this.say(`${u.name} begins a FULL TECH action (2 quick techs).`)
  }
  techAttackRoll(u: Unit, t: Unit, label: string): AttackCtx {
    const ctx = this.newAttackCtx(u, t, { tech: true, ranged: false, mode: 'tech', attackBonus: u.stats.techAttack })
    if (this.has(u, 'impaired')) ctx.difficulty++
    for (const b of u.bonuses) if (b.id === 'tech_attack' && b.accuracy) ctx.accuracy += b.accuracy
    for (const s of scriptsFor(u)) s.beforeAttack?.(this, u, ctx, 'attacker')
    for (const s of scriptsFor(t)) s.beforeAttack?.(this, t, ctx, 'target')
    this.say(`${u.name} — ${label} → ${t.name}.`, 'attack')
    if (this.has(u, 'hidden')) this.removeStatus(u, 'hidden')
    this.rollToHit(ctx)
    return ctx
  }
  invade(u: Unit, t: Unit, option: 'fragment' | { name: string; effects: Effect[]; heat?: number } = 'fragment') {
    const c = this.canQuickTech(u)
    if (c !== true) throw new Error(c)
    const v = this.techTargetValid(u, t)
    if (v !== true) throw new Error(v)
    if (!this.hostile(u, t)) throw new Error('Invade targets hostiles')
    this.spendTech(u)
    const ctx = this.techAttackRoll(u, t, option === 'fragment' ? 'INVADE: Fragment Signal' : `INVADE: ${option.name}`)
    if (ctx.hit) {
      this.applyDamage(t, [{ type: 'Heat', amount: 2 }], { source: u, attack: ctx })
      if (option === 'fragment') {
        this.addStatus(t, 'impaired', 'next_turn_end_target', u)
        this.addStatus(t, 'slowed', 'next_turn_end_target', u)
      } else this.runEffects(u, t, option.effects, ctx)
    }
    for (const s of scriptsFor(u)) s.afterAttack?.(this, u, ctx, 'attacker')
    return ctx
  }
  lockOn(u: Unit, t: Unit) {
    const c = this.canQuickTech(u)
    if (c !== true) throw new Error(c)
    const v = this.techTargetValid(u, t)
    if (v !== true) throw new Error(v)
    this.spendTech(u)
    this.say(`${u.name} LOCKS ON to ${t.name}.`)
    this.addStatus(t, 'lockon', 'until_cleared', u)
  }
  bolster(u: Unit, t: Unit) {
    const c = this.canQuickTech(u)
    if (c !== true) throw new Error(c)
    if (this.hostile(u, t)) throw new Error('Bolster targets allies')
    if (this.distance(u, t) > u.stats.sensors) throw new Error('Out of sensor range')
    this.spendTech(u)
    this.say(`${u.name} BOLSTERS ${t.name}.`)
    this.addStatus(t, 'bolstered', 'next_turn_end_target', u)
  }
  scan(u: Unit, t: Unit): string {
    const c = this.canQuickTech(u)
    if (c !== true) throw new Error(c)
    const v = this.techTargetValid(u, t)
    if (v !== true) throw new Error(v)
    this.spendTech(u)
    t.flags.scanned = true
    const info = `${t.name}: HP ${t.hp}/${t.stats.hp} ARM ${t.stats.armor} EVA ${t.stats.evasion} E-DEF ${t.stats.edef} HEAT ${t.heat}/${t.stats.heatcap} | ${t.weapons.map(w => w.name).join(', ')}${t.systems.length ? ' | ' + t.systems.map(s => s.name).join(', ') : ''}`
    this.say(`SCAN — ${info}`)
    return info
  }

  // ------------------------------------------------------------------ core power
  activateCore(u: Unit) {
    if (!u.frameId || !u.coreAvailable) throw new Error('Core power unavailable')
    const f = Lancer.frames.get(u.frameId)!
    const act = (f.core_system.activation ?? 'Quick').toLowerCase() as any
    const cost = act === 'protocol' ? 'protocol' : act === 'full' ? 'full' : act === 'free' ? 'free' : 'quick'
    const c = this.canSpend(u, cost)
    if (c !== true) throw new Error(c)
    this.spend(u, cost)
    u.coreAvailable = false
    u.coreActive = true
    this.say(`${u.name} activates CORE POWER: ${f.core_system.active_name ?? f.core_system.name}!`, 'warn')
    if (f.core_system.active_bonuses) u.bonuses.push(...f.core_system.active_bonuses)
    let scripted = false
    for (const s of scriptsFor(u)) if (s.onCoreActivate) { s.onCoreActivate(this, u); scripted = true }
    if (!scripted && !f.core_system.active_bonuses?.length) this.say(`  ${stripHtml(f.core_system.active_effect ?? '')}`)
  }

  // ------------------------------------------------------------------ deployables / mines / areas
  spawn(u: Unit) {
    this.units.push(u)
    this.emit({ type: 'spawn', unitId: u.id })
  }
  placeMine(owner: Unit, pos: Pos, m: Omit<Mine, 'id' | 'ownerId' | 'side' | 'pos'>) {
    this.mines.push({ ...m, id: nextUid('mine'), ownerId: owner.id, side: owner.side, pos })
    this.say(`${owner.name} arms ${m.name}.`)
  }
  detonateMine(m: Mine) {
    this.mines = this.mines.filter(x => x !== m)
    const owner = this.unit(m.ownerId)
    this.say(`${m.name} DETONATES!`, 'attack')
    const tiles = blastTiles(this.map, m.pos, m.radius)
    this.emit({ type: 'area', tiles, kind: 'explosion' })
    const parts = m.damage.map(d => ({ type: d.type, amount: rollDice(this.rng, d.val).total }))
    for (const t of unitsOnTiles(this.alive(), tiles)) {
      const ok = m.save ? this.save(t, m.save, owner?.stats.save ?? 10) : false
      if (ok && (!m.saveHalf || t.isGrunt)) continue
      this.applyDamage(t, ok ? parts.map(p => ({ ...p, amount: this.halfOnSave(t, p.amount) })) : parts, { source: owner })
    }
  }
  addArea(a: Omit<AreaEffect, 'id'>) {
    const area = { ...a, id: nextUid('area') }
    this.areas.push(area)
    this.emit({ type: 'area', tiles: a.tiles, kind: a.kind })
    return area
  }

  // ------------------------------------------------------------------ custom actions (systems, traits, talents...)
  customActions(u: Unit): CustomAction[] {
    const out: CustomAction[] = []
    for (const s of scriptsFor(u)) if (s.actions) out.push(...s.actions(this, u))
    out.push(...genericActionsFor(this, u))
    return out
  }
  useCustom(u: Unit, a: CustomAction, target?: Unit | Pos) {
    const ok = a.usable(this, u)
    if (ok !== true) throw new Error(ok)
    const cost = a.activation === 'quick_tech' ? null : a.activation === 'full_tech' ? 'full' : a.activation
    if (a.activation === 'quick_tech') {
      const c = this.canQuickTech(u)
      if (c !== true) throw new Error(c)
      if (this.has(u, 'jammed')) throw new Error('Jammed')
      this.spendTech(u)
    } else if (cost === 'reaction') this.spend(u, 'reaction')
    else this.spend(u, cost as any)
    if (a.heat) this.addHeat(u, a.heat)
    this.say(`${u.name} uses ${a.name}.`, 'attack')
    a.run(this, u, target)
  }
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
