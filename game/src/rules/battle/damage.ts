// Battle engine: damage. Methods of `Battle` live here as functions taking the battle (`bt`) first;
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

export function addHeat(bt: Battle, u: Unit, amount: number, source?: Unit) {
  if (amount <= 0 || u.destroyed) return
  if (u.stats.heatcap <= 0) { bt.applyDamage(u, [{ type: 'Energy', amount }], { source }); return }
  if (u.isGrunt && source && source !== u) { bt.say(`${u.name} burns out under the heat.`, 'damage'); bt.destroy(u, 'heat'); return }
  u.heat += amount
  bt.emit({ type: 'damage', unitId: u.id, amount, kind: 'heat' })
  for (const s of scriptsFor(u)) s.onHeat?.(bt, u, amount)
  for (const o of bt.alive()) if (o !== u) for (const sc of scriptsFor(o)) sc.onAnyHeat?.(bt, o, u, amount, source)
  while (u.heat > u.stats.heatcap && !u.destroyed) {
    if (scriptsFor(u).some(s => s.beforeOverheat?.(bt, u))) break
    const excess = u.heat - u.stats.heatcap
    if (u.kind === 'npc' && u.stats.stress <= 1) {
      u.heat = Math.max(0, u.heat - u.stats.heatcap)
      bt.say(`${u.name} overheats and vents violently!`, 'damage')
      bt.addStatus(u, 'exposed', 'until_cleared', source)
      break
    }
    if (u.stress <= 0) { u.heat = Math.min(u.heat, u.stats.heatcap); break }
    u.stress--
    // heat clears; only the heat beyond what it took to exceed the cap (cap + 1) carries over
    u.heat = excess - 1
    bt.emit({ type: 'damage', unitId: u.id, amount: 1, kind: 'stress' })
    bt.say(`${u.name} OVERHEATS — takes 1 stress (${u.stress} left).`, 'damage')
    for (const s of scriptsFor(u)) s.onStressDamage?.(bt, u)
    if (u.flying && !u.destroyed && !bt.save(u, 'agi', 10)) bt.land(u, 'loses control')
    bt.overheatCheck(u)
  }
}

export function overheatCheck(bt: Battle, u: Unit) {
  if (u.stress <= 0) {
    // out of stress: the reactor melts down at the end of the mech's next turn
    if (u.meltdownTurns == null) u.meltdownTurns = u.activeTurn ? 2 : 1
    bt.say(`${u.name}'s REACTOR IS CRITICAL — meltdown at the end of its next turn!`, 'warn')
    return
  }
  let dice = bt.tableDice(u, u.stats.stress - u.stress)
  // Reactor Stabilizer: may reroll, keeping the second result
  if (u.flags.reactorStabilizer) {
    const bad = dice.filter(d => d === 1).length >= 1 || Math.min(...dice) <= 2
    bt.say(`Overheating check [${dice.join(', ')}]`)
    if (bt.choose({ kind: 'reactor_stabilizer', unit: u, title: 'Reactor Stabilizer', text: `Overheating check [${dice.join(', ')}]. Reroll? You must keep the second result.`, options: [{ label: 'Reroll' }, { label: 'Keep' }], defaultIndex: bad ? 0 : 1 }) === 0) {
      dice = bt.tableDice(u, u.stats.stress - u.stress)
      bt.say('  Reactor Stabilizer: rerolled.')
    }
  }
  const ones = dice.filter(d => d === 1).length
  const low = Math.min(...dice)
  bt.say(`Overheating check [${dice.join(', ')}]`)
  if (ones >= 2) { bt.say('IRREVERSIBLE MELTDOWN!', 'warn'); u.meltdownTurns = u.activeTurn ? 2 : 1; return }
  if (low >= 5) { bt.say('Emergency Shunt.'); bt.addStatus(u, 'impaired', 'next_turn_end_target') }
  else if (low >= 2) { bt.say('Destabilized Power Plant.'); bt.addStatus(u, 'exposed') }
  else {
    bt.say('MELTDOWN result.')
    if (u.stress >= 3) bt.addStatus(u, 'exposed')
    else if (u.stress === 2) {
      if (bt.check(u, 'eng')) bt.addStatus(u, 'exposed')
      else { u.meltdownTurns = bt.rng.d(6) + (u.activeTurn ? 1 : 0); bt.say(`${u.name}'s reactor is going critical (${u.meltdownTurns} turns)!`, 'warn') }
    } else { u.meltdownTurns = u.activeTurn ? 2 : 1; bt.say(`${u.name}'s reactor will melt down at the end of its next turn!`, 'warn') }
  }
}

/** Structure/overheat dice; Legendary rolls twice and keeps the better result. */
export function tableDice(bt: Battle, u: Unit, marked: number): number[] {
  const roll = () => Array.from({ length: marked }, () => bt.rng.d(6))
  const dice = roll()
  if (!u.traits?.includes('legendary')) return dice
  const alt = roll()
  const score = (d: number[]) => (d.filter(x => x === 1).length >= 2 ? -10 : 0) + Math.min(...d)
  bt.say(`${u.name} is Legendary: [${dice.join(', ')}] or [${alt.join(', ')}]`)
  return score(alt) > score(dice) ? alt : dice
}

export function structureCheck(bt: Battle, u: Unit) {
  if (u.structure <= 0 && !u.flags.briareosZero) { bt.destroy(u, 'structure'); return }
  if (u.isGrunt) { bt.destroy(u, 'structure'); return }
  const dice = bt.tableDice(u, u.stats.structure - u.structure)
  const ones = dice.filter(d => d === 1).length
  const low = Math.min(...dice)
  bt.say(`Structure check [${dice.join(', ')}]`)
  if (ones >= 2) { bt.say('CRUSHING HIT!', 'warn'); bt.destroy(u, 'crushing hit'); return }
  if (low >= 5) { bt.say('Glancing Blow.'); bt.addStatus(u, 'impaired', 'next_turn_end_target'); return }
  if (low >= 2) { bt.systemTrauma(u); return }
  bt.directHit(u)
}

export function directHit(bt: Battle, u: Unit) {
  bt.say('DIRECT HIT!', 'warn')
  if (u.structure >= 3) bt.addStatus(u, 'stunned', 'next_turn_end_target')
  else if (u.structure === 2) {
    if (bt.check(u, 'hull')) bt.addStatus(u, 'stunned', 'next_turn_end_target')
    else bt.destroy(u, 'direct hit')
  } else bt.destroy(u, 'direct hit')
}

export function systemTrauma(bt: Battle, u: Unit) {
  const validMounts = [...new Set(u.weapons.filter(w => !w.destroyed && w.mountIndex >= 0 && !(w.usesLeft === 0)).map(w => w.mountIndex))]
  const validSystems = u.systems.filter(s => !s.destroyed && !(s.usesLeft === 0) && !s.dataId.startsWith('npc_trait'))
  const r = bt.rng.d(6)
  let doMount = r <= 3
  if (doMount && !validMounts.length) doMount = false
  if (!doMount && !validSystems.length) doMount = validMounts.length > 0
  if (!validMounts.length && !validSystems.length) { bt.directHit(u); return }
  if (doMount) {
    const m = bt.rng.pick(validMounts)
    const ws = u.weapons.filter(w => w.mountIndex === m && !w.destroyed)
    ws.forEach(w => (w.destroyed = true))
    bt.say(`System Trauma: ${ws.map(w => w.name).join(', ')} destroyed!`, 'damage')
  } else {
    const s = bt.rng.pick(validSystems)
    s.destroyed = true
    bt.say(`System Trauma: ${s.name} destroyed!`, 'damage')
  }
}

export function reactorExplosion(bt: Battle, u: Unit, why: string) {
  if (u.destroyed) return
  bt.say(`${u.name} — ${why.toUpperCase()}! The reactor explodes.`, 'warn')
  const tiles = burstTiles(bt.map, u, 2)
  bt.emit({ type: 'area', tiles, kind: 'explosion' })
  bt.destroy(u, why)
  const dmg = rollDice(bt.rng, '4d6').total
  for (const t of unitsOnTiles(bt.alive(), tiles)) {
    if (t === u) continue
    const ok = bt.save(t, 'agi', u.stats.save || 10, 0, u)
    if (ok && t.isGrunt) continue
    bt.applyDamage(t, [{ type: 'Explosive', amount: ok ? bt.halfOnSave(t, dmg) : dmg }], { source: u })
  }
}

/** Half damage on a successful save (Napoleon's Heavy Shielding reduces it to 1). */
export function halfOnSave(bt: Battle, t: Unit, amount: number): number {
  return t.flags.heavyShielding ? Math.min(1, amount) : Math.ceil(amount / 2)
}

export function destroy(bt: Battle, u: Unit, why: string) {
  if (u.destroyed) return
  // Veteran trait Feign Death: the first time it would be destroyed it survives on 1 HP, apparently dead (Hidden)
  if (u.traits?.includes('feign_death') && !u.flags.feignUsed && !/meltdown|self-destruct|crushing/.test(why)) {
    u.flags.feignUsed = true
    u.hp = 1
    u.structure = Math.max(1, u.structure)
    bt.addStatus(u, 'hidden', 'until_cleared')
    bt.say(`${u.name} goes down… (feigning death)`, 'damage')
    return
  }
  u.destroyed = true
  u.hp = 0
  // destroyed mechs become wreckage: hard cover and an obstruction (unless vaporised)
  if ((u.kind === 'mech' || (u.kind === 'npc' && u.role !== 'Biological')) && !/meltdown|self-destruct|unstable|blinkspace|heat/.test(why)) u.flags.wreck = true
  if (u.flags.isCover || u.flags.wreck) bt.invalidateTerrain()
  if (bt.grapples.some(g => g.a === u.id || g.d === u.id)) bt.syncGrapples()
  bt.emit({ type: 'destroyed', unitId: u.id })
  bt.say(`${u.name} is DESTROYED (${why}).`, 'damage')
  for (const o of bt.alive()) for (const s of scriptsFor(o)) s.onDestroyed?.(bt, o, u)
  for (const s of scriptsFor(u)) s.onDestroyed?.(bt, u, u)
  // drones/deployables persist; owned drones of destroyed mechs remain until the scene ends
  const ownTurn = u.id === bt.activeId && bt.endingTurnOf !== u.id
  // its turn is over: statuses timed to the end of this unit's turn expire now
  if (ownTurn) bt.tickStatuses(u, false)
  // statuses timed to its future turns would never tick again: they end with the current turn instead
  // (or at the end of the affected unit's next turn, between turns). Dying during its own endTurn: that tick is about to run.
  for (const o of bt.units) for (const st of o.statuses) if (st.clockUnit === u.id && o !== u) {
    if (bt.endingTurnOf !== u.id) st.clockUnit = bt.activeId && bt.activeId !== u.id ? bt.activeId : o.id
    st.turnsLeft = 1
    delete st.atStart
  }
  if (ownTurn) {
    u.activeTurn = false
    bt.activeId = null
    bt.checkVictory()
    if (!bt.winner) {
      const opp = other(u.side)
      if (bt.hasActivations(opp)) bt.currentSide = opp
      else if (bt.hasActivations(u.side)) bt.currentSide = u.side
      else bt.endRound()
    }
  } else bt.checkVictory()
}

/**
 * Apply damage parts to a unit. Types: Kinetic, Explosive, Energy, Burn, Heat, plus internal 'Burn-tick'.
 */
export function applyDamage(bt: Battle, t: Unit, parts: { type: string; amount: number }[], opts: { source?: Unit; ap?: boolean; irreducible?: boolean; attack?: AttackCtx; resistAll?: boolean; resistTypes?: string[] } = {}): number {
  if (t.destroyed) return 0
  if (t.flags.intangible) { bt.say(`${t.name} is intangible: unaffected.`); return 0 }
  for (const o of bt.alive()) for (const sc of scriptsFor(o)) sc.beforeAnyDamage?.(bt, o, t, parts, opts)
  const shredded = bt.has(t, 'shredded')
  const rctx: DamageCtx = { source: opts.source, attack: opts.attack, amount: 0, kind: 'hp' }
  // Resistance from any number of sources halves once
  const scriptResist = (type: string) => scriptsFor(t).some(s => s.grantsResistance?.(bt, t, type, rctx)) ||
    bt.alive().some(o => o !== t && scriptsFor(o).some(s => s.grantsAnyResistance?.(bt, o, t, type, rctx)))
  const resists = (type: string) => !opts.irreducible && !shredded && (opts.resistAll || opts.resistTypes?.includes(type) || t.resist.includes(type) || t.resist.includes('all') || (t.flags.resistAll ?? 0) > 0 || scriptResist(type))
  let hpDmg = 0, heat = 0, burn = 0
  const exposed = bt.has(t, 'exposed')
  // Grunts are destroyed by heat from any source other than their own systems
  if (t.isGrunt && opts.source && opts.source !== t && parts.some(p => p.type === 'Heat' && p.amount > 0)) {
    bt.say(`${t.name} burns out under the heat.`, 'damage')
    bt.destroy(t, 'heat')
    return 0
  }
  // characters without a Heat Cap (biological, drones, objects) take heat as energy damage
  const noHeatCap = t.stats.heatcap <= 0
  const physical = parts
    .filter(p => ['Kinetic', 'Explosive', 'Energy', 'Variable'].includes(p.type) || (noHeatCap && p.type === 'Heat'))
    .map(p => ({ type: p.type === 'Heat' ? 'Energy' : p.type, amount: exposed ? p.amount * 2 : p.amount }))
  // Core book p.67: damage is rolled (and doubled by Exposed), ARMOR is subtracted once from the
  // attack's total, then RESISTANCE halves (rounded up) whatever remains of resisted types.
  let armor = opts.ap || opts.irreducible || shredded ? 0 : t.stats.armor
  for (const p of [...physical].sort((a, b) => b.amount - a.amount)) {
    const red = Math.min(armor, p.amount)
    p.amount -= red
    armor -= red
  }
  for (const p of physical) hpDmg += resists(p.type) ? Math.ceil(p.amount / 2) : p.amount
  for (const p of parts) {
    if (p.type === 'Heat' && !noHeatCap) heat += resists('Heat') ? Math.ceil(p.amount / 2) : p.amount
    if (p.type === 'Burn') burn += resists('Burn') ? Math.ceil(p.amount / 2) : p.amount
    if (p.type === 'Burn-tick') hpDmg += p.amount
  }
  const dctx: DamageCtx = { source: opts.source, attack: opts.attack, amount: hpDmg, kind: 'hp' }
  for (const s of scriptsFor(t)) s.modifyIncoming?.(bt, t, dctx)
  for (const o of bt.alive()) if (o !== t) for (const s of scriptsFor(o)) s.modifyAnyIncoming?.(bt, o, t, dctx)
  hpDmg = Math.max(0, dctx.amount)
  if (burn > 0 && t.immune.includes('burn')) { bt.say(`${t.name} is immune to burn.`); burn = 0 }
  if (burn > 0) {
    hpDmg += burn // burn deals its damage immediately, ignoring armor
    t.burn += burn
    bt.say(`${t.name} catches fire (${burn} burn).`, 'damage')
  }
  if (heat > 0) bt.addHeat(t, heat, opts.source)
  if (hpDmg > 0) bt.loseHp(t, hpDmg, opts.source)
  if (hpDmg > 0 || heat > 0) for (const s of scriptsFor(t)) s.onDamaged?.(bt, t, { ...dctx, amount: hpDmg })
  if (hpDmg > 0 || heat > 0) for (const o of bt.alive()) for (const s of scriptsFor(o)) s.onAnyDamaged?.(bt, o, t, { ...dctx, amount: hpDmg })
  return hpDmg
}

export function loseHp(bt: Battle, t: Unit, amount: number, _source?: Unit) {
  if (t.destroyed) return
  if (t.overshield > 0) {
    const a = Math.min(t.overshield, amount)
    t.overshield -= a
    amount -= a
    if (a) bt.say(`${t.name}'s overshield absorbs ${a}.`)
  }
  if (amount <= 0) return
  t.hp -= amount
  bt.emit({ type: 'damage', unitId: t.id, amount, kind: 'hp' })
  bt.say(`${t.name} takes ${amount} damage (${Math.max(0, t.hp)}/${t.stats.hp} HP).`, 'damage')
  // Briareos Frame: at 0 HP and 0 Structure the mech holds together; each hit forces a structure check
  if (t.flags.briareosZero) { t.hp = 0; bt.structureCheck(t); return }
  while (t.hp <= 0 && !t.destroyed) {
    if (t.kind === 'deployable' || t.kind === 'drone' || t.isGrunt || t.stats.structure <= 1) {
      bt.destroy(t, 'HP depleted')
      return
    }
    if (t.flags.briareos && t.structure <= 1) {
      t.structure = 0
      t.hp = 0
      t.flags.briareosZero = true
      bt.emit({ type: 'damage', unitId: t.id, amount: 1, kind: 'structure' })
      bt.say(`${t.name} is reduced to 0 Structure but the Briareos frame holds together!`, 'warn')
      return
    }
    const excess = -t.hp
    t.structure--
    bt.emit({ type: 'damage', unitId: t.id, amount: 1, kind: 'structure' })
    bt.say(`${t.name} takes STRUCTURE damage (${t.structure} left).`, 'damage')
    t.hp = t.stats.hp - excess
    for (const s of scriptsFor(t)) s.onStructureDamage?.(bt, t)
    if (t.flying && !t.destroyed && !bt.save(t, 'agi', 10)) bt.land(t, 'loses control')
    bt.structureCheck(t)
  }
}

export function heal(bt: Battle, u: Unit, amount: number) {
  if (u.destroyed) return
  if (u.flags.briareosZero) { bt.say(`${u.name} can't regain HP until a Full Repair (Briareos).`); return }
  u.hp = Math.min(u.stats.hp, u.hp + amount)
  bt.say(`${u.name} recovers ${amount} HP.`)
}
