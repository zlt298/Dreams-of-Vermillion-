// Battle engine: attacks. Methods of `Battle` live here as functions taking the battle (`bt`) first;
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

export function triggerOverwatch(bt: Battle, mover: Unit) {
  if (bt.reactionDepth > 0) return
  for (const o of bt.alive()) {
    if (mover.destroyed) return
    if (!bt.hostile(o, mover) || o.policies.overwatch === 'off' || mover.flags.feint === o.id) continue
    if (bt.canSpend(o, 'reaction', 'overwatch') !== true) continue
    const w = bt.bestThreatWeapon(o, mover)
    if (!w) continue
    if (!bt.wantsReaction(o, 'overwatch', true, mover,
      `OVERWATCH? ${mover.name} is moving within threat of ${o.name}'s ${w.name} (${bt.distance(o, mover)} spaces). Spend ${o.name}'s reaction to attack it now?`)) continue
    bt.say(`${o.name} takes OVERWATCH on ${mover.name}!`, 'attack')
    bt.spend(o, 'reaction', 'overwatch')
    bt.reactionDepth++
    try { bt.weaponAttack(o, w, { targetId: mover.id }, 'overwatch') } finally { bt.reactionDepth-- }
  }
}

export function bestThreatWeapon(bt: Battle, o: Unit, target: Unit): Weapon | null {
  let best: Weapon | null = null, bestDmg = -1
  for (const w of o.weapons) {
    if (!bt.weaponReady(o, w)) continue
    const pr = w.profiles[w.profileIndex]
    if (bt.isAoE(pr)) continue
    const threat = bt.weaponThreat(o, w)
    if (threat <= 0 || bt.distance(o, target) > threat) continue
    // a target the attack would refuse (Hidden, intangible, no line of sight) doesn't provoke the reaction
    if (bt.validTarget(o, w, target) !== true) continue
    const avg = pr.damage.reduce((a, d) => a + averageDice(d.val), 0)
    if (avg > bestDmg) { best = w; bestDmg = avg }
  }
  return best
}

export function profile(bt: Battle, w: Weapon): Profile {
  return w.profiles[w.profileIndex]
}

export function weaponTags(bt: Battle, u: Unit, w: Weapon): TagData[] {
  return bt.profile(w).tags
}

export function isMelee(bt: Battle, w: Weapon): boolean {
  return w.type === 'Melee' || bt.profile(w).range.every(r => r.type === 'Threat' || r.type === 'Thrown')
}

export function isAoE(bt: Battle, p: Profile): boolean {
  return p.range.some(r => ['Blast', 'Burst', 'Line', 'Cone'].includes(r.type))
}

export function bonusApplies(bt: Battle, b: BonusData, w: Weapon, rangeType?: string, damageType?: string): boolean {
  if (b.weapon_types && !b.weapon_types.some(t => isWeaponType(w, t))) return false
  if (b.weapon_sizes && !b.weapon_sizes.includes(w.size)) return false
  if (rangeType && b.range_types && !b.range_types.includes(rangeType)) return false
  if (b.damage_types && !bt.profile(w).damage.some(d => b.damage_types!.includes(d.type))) return false
  if (damageType && b.damage_types && !b.damage_types.includes(damageType)) return false
  return true
}

export function ranges(bt: Battle, u: Unit, w: Weapon): RangeData[] {
  const pr = bt.profile(w)
  const all = [...u.bonuses, ...w.bonuses]
  return pr.range.map(r => {
    let v = Number(r.val) || 0
    for (const b of all) {
      if (b.condition && !bt.evalCondition(u, b.condition)) continue
      if ((b.id === 'range' || (b.id === 'threat' && r.type === 'Threat')) && bt.bonusApplies(b, w, r.type)) v += Number(b.val) || 0
    }
    return { ...r, val: v }
  })
}

export function weaponThreat(bt: Battle, u: Unit, w: Weapon): number {
  const rs = bt.ranges(u, w)
  const t = rs.find(r => r.type === 'Threat')
  let v = t ? Number(t.val) : bt.isMelee(w) ? 1 : 0
  if (u.flags.hyperReflex && !bt.isMelee(w) && !bt.isAoE(bt.profile(w))) v = Math.max(v, 3)
  return v
}

export function weaponReach(bt: Battle, u: Unit, w: Weapon): number {
  const rs = bt.ranges(u, w)
  let m = 0
  for (const r of rs) if (r.type === 'Range' || r.type === 'Threat' || r.type === 'Thrown' || r.type === 'Line' || r.type === 'Cone') m = Math.max(m, Number(r.val))
  if (!rs.length) m = 1
  const thrown = [...u.bonuses, ...w.bonuses].find(b => b.id === 'thrown' && bt.bonusApplies(b, w))
  if (thrown) m = Math.max(m, Number(thrown.val))
  return m
}

export function weaponReady(bt: Battle, u: Unit, w: Weapon): boolean {
  return !w.destroyed && w.loaded && w.usesLeft !== 0 && w.charged
}

export function weaponUsable(bt: Battle, u: Unit, w: Weapon, normalAttack = true): true | string {
  if (w.destroyed) return 'Destroyed'
  if (u.flags.intangible) return 'Intangible: cannot attack'
  if (u.flags.noAttacks) return 'Cannot attack (retracted profile)'
  if (normalAttack && w.dataId && NO_NORMAL_ATTACK.has(w.dataId)) return 'Cannot make normal attacks'
  if (w.flags?.locked) return String(w.flags.locked)
  if (!w.loaded) return 'Needs reloading'
  if (w.usesLeft === 0) return 'No uses left'
  if (!w.charged) return 'Recharging'
  // Jammed stops weapon attacks, but Improvised Attacks, Grapple and Ram are still allowed
  if (bt.has(u, 'jammed') && w.type !== 'Improvised' && !(u.flags.shieldedMagazines && !bt.isMelee(w))) return 'Jammed'
  const pr = bt.profile(w)
  if (!pr.damage.length && !pr.onHit.length && !w.tech) {
    const d = w.dataId ? Lancer.weapons.get(w.dataId) : undefined
    if (d?.no_attack) return 'This weapon cannot attack'
  }
  return true
}

/** Targets (or aim tile) validity for a weapon attack */
export function validTarget(bt: Battle, u: Unit, w: Weapon, t: Unit, from: Pos = u.pos): true | string {
  if (t.destroyed) return 'Destroyed'
  if (t === u) return 'Cannot target self'
  if (t.flags.intangible) return 'Intangible'
  if (bt.isBlinded(u) && chebyshev(from, t.pos) > 1 && distanceBetween(bt.map, { ...u, pos: from }, t) > 1) return 'Blinded: can only see adjacent spaces'
  if (bt.has(t, 'hidden') && bt.hostile(u, t)) return 'Hidden'
  const pr = bt.profile(w)
  const tags = pr.tags
  const reach = bt.weaponReach(u, w)
  const d = distanceBetween(bt.map, { ...u, pos: from }, t)
  if (d > reach) return `Out of range (${d}/${reach})`
  const minR = u.bonuses.find(b => b.id === 'min_range')
  void minR
  const magRound = u.flags.ammo === 'mag' && w.size === 'Main' && !bt.isMelee(w) && !u.flags['turn:ammoUsed']
  if (!hasTag(tags, 'tg_seeking') && !hasTag(tags, 'tg_arcing') && !magRound && !bt.los(u, t, from)) return 'No line of sight'
  return true
}

export function aoeTiles(bt: Battle, u: Unit, w: Weapon, aim: Pos): Pos[] | string {
  const rs = bt.ranges(u, w)
  const blast = rs.find(r => r.type === 'Blast')
  const burst = rs.find(r => r.type === 'Burst')
  const line = rs.find(r => r.type === 'Line')
  const cone = rs.find(r => r.type === 'Cone')
  // attacks made from somewhere else (drones, Ghost/attackOrigin scripts) draw their templates from there
  const origin = bt.attackOrigin ? { ...u, pos: bt.attackOrigin, stats: { ...u.stats, size: 1 } } : u
  if (burst) return burstTiles(bt.map, origin, Number(burst.val))
  // weapons that can fire as either Line or Cone (Plasma Thrower): the weapon card toggle picks
  const shape = line && cone ? (w.flags?.shape === 'line' ? 'line' : 'cone') : line ? 'line' : cone ? 'cone' : null
  if (shape === 'line') return lineTiles(bt.map, origin, aim, Number(line!.val))
  if (shape === 'cone') return coneTiles(bt.map, origin, aim, Number(cone!.val))
  if (blast) {
    const range = rs.find(r => r.type === 'Range')
    const reach = range ? Number(range.val) : 1
    if (distanceToTile(bt.map, u, aim) > reach) return 'Out of range'
    if (!hasTag(bt.profile(w).tags, 'tg_arcing') && !hasTag(bt.profile(w).tags, 'tg_seeking') && !hasLineOfSightToTile(bt.effectiveMap(), u, aim)) return 'No line of sight to blast centre'
    return blastTiles(bt.map, aim, Number(blast.val))
  }
  return 'Not an area weapon'
}

/** Damage bonus (flat) from bonuses, per damage type */
export function flatDamageBonus(bt: Battle, u: Unit, w: Weapon, type: string): number {
  let n = 0
  for (const b of [...u.bonuses, ...w.bonuses]) {
    if (b.id !== 'damage' || typeof b.val !== 'number') continue
    if (b.condition && !bt.evalCondition(u, b.condition)) continue
    if (bt.bonusApplies(b, w, undefined, type)) n += b.val
  }
  return n
}

export function newAttackCtx(bt: Battle, attacker: Unit, target: Unit, partial: Partial<AttackCtx>): AttackCtx {
  return {
    attacker, target, tech: false, melee: false, ranged: true, multiTarget: false, accuracy: 0, difficulty: 0,
    attackBonus: attacker.stats.attackBonus, bonusDamage: [], ignoreCover: false, noLosNeeded: false, reasons: [], mode: 'free',
    ...partial,
  }
}

/** Compute accuracy/difficulty and the to-hit chance for previews and the AI (no state is changed). */
export function previewAttack(bt: Battle, attacker: Unit, w: Weapon, target: Unit, from: Pos = attacker.pos, mode: AttackCtx['mode'] = 'skirmish'): { ctx: AttackCtx; chance: number; cover: Cover; expectedDamage: number } {
  return bt.sandbox(() => bt.previewAttackRaw(attacker, w, target, from, mode))
}

/**
 * Detailed hover preview: Monte Carlo over the real attack math with a private RNG.
 * Damage figures are after Exposed, armor (per type) and resistance; heat is reported separately.
 */
export function previewDetail(bt: Battle, attacker: Unit, w: Weapon, target: Unit, samples = 1200): { chance: number; critChance: number; minDmg: number; maxDmg: number; avgDmg: number; heat: number; lethal: number; lethalLabel: 'destroy' | 'structure'; reliable: number } {
  return bt.sandbox(() => {
    const ctx = bt.buildWeaponCtx(attacker, w, target, 'skirmish', false)
    const pr = bt.profile(w)
    const def = bt.defenseOf(target, ctx)
    const net = ctx.accuracy - (ctx.ignoreDifficulty ? 0 : ctx.difficulty)
    const rng = new Rng(0x5eed ^ target.hp ^ (attacker.hp << 8))
    const ap = hasTag(pr.tags, 'tg_ap') || bt.has(target, 'shredded')
    const irreducible = hasTag(pr.tags, 'tg_irreducible') || !!ctx.irreducible
    const resists = (type: string) => !irreducible && !bt.has(target, 'shredded') && (!!ctx.resistAll || target.resist.includes(type) || target.resist.includes('all'))
    const exposed = bt.has(target, 'exposed')
    const pool = target.hp + target.overshield
    const destroyOnPool = target.isGrunt || target.kind === 'deployable' || target.kind === 'drone' || target.stats.structure <= 1 || target.structure <= 1
    const rel = tagVal(pr.tags, 'tg_reliable') ?? 0
    let hits = 0, crits = 0, lethal = 0, sum = 0, min = Infinity, max = 0, heat = 0
    const reduce = (parts: { type: string; amount: number }[]) => {
      // armor once from the attack's total (largest parts first), then resistance per type
      let total = 0
      const ps = parts.filter(p => p.type !== 'Heat' && p.type !== 'Burn').map(p => ({ type: p.type, amount: exposed ? p.amount * 2 : p.amount })).sort((x, y) => y.amount - x.amount)
      let armor = ap || irreducible || bt.has(target, 'shredded') ? 0 : target.stats.armor
      for (const p of ps) { const cut = Math.min(armor, p.amount); armor -= cut; p.amount -= cut; total += resists(p.type) ? Math.ceil(p.amount / 2) : p.amount }
      for (const p of parts) if (p.type === 'Burn') total += resists('Burn') ? Math.ceil(p.amount / 2) : p.amount
      return total
    }
    for (let i = 0; i < samples; i++) {
      const acc = rollAccuracy(rng, net)
      const total = rng.d(20) + ctx.attackBonus + acc.bonus
      const invisible = bt.has(target, 'invisible') || ctx.forceInvisible
      const hit = !(invisible && rng.d(6) <= 3) && total >= def
      if (!hit) {
        if (rel) { const d = reduce([{ type: pr.damage[0]?.type ?? 'Kinetic', amount: rel }]); if (d >= pool) lethal++ }
        continue
      }
      hits++
      const crit = total >= 20 && attacker.canCrit && !ctx.tech
      if (crit) crits++
      const parts: { type: string; amount: number }[] = []
      for (const d of pr.damage) parts.push({ type: d.type, amount: Math.max(0, rollDice(rng, d.val, { crit }).total + bt.flatDamageBonus(attacker, w, d.type)) })
      for (const bd of ctx.bonusDamage) parts.push({ type: bd.type, amount: rollDice(rng, bd.val, { crit }).total })
      for (const e of [...pr.onHit, ...(crit ? pr.onCrit : [])]) if (e.do === 'bonus_damage') parts.push({ type: e.type ?? pr.damage[0]?.type ?? 'Kinetic', amount: rollDice(rng, e.val, { crit }).total })
      const burnTag = tagVal(pr.tags, 'tg_burn')
      if (burnTag) parts.push({ type: 'Burn', amount: burnTag })
      for (const p of parts) if (p.type === 'Heat') heat += p.amount
      const dmg = reduce(parts)
      sum += dmg
      min = Math.min(min, dmg)
      max = Math.max(max, dmg)
      if (dmg >= pool) lethal++
    }
    return {
      chance: hits / samples, critChance: crits / samples, minDmg: hits ? min : 0, maxDmg: max, avgDmg: hits ? sum / hits : 0,
      heat: hits ? heat / hits : 0, lethal: lethal / samples, lethalLabel: destroyOnPool ? 'destroy' : 'structure', reliable: rel,
    }
  })
}

export function previewAttackRaw(bt: Battle, attacker: Unit, w: Weapon, target: Unit, from: Pos, mode: AttackCtx['mode']): { ctx: AttackCtx; chance: number; cover: Cover; expectedDamage: number } {
  const saved = attacker.pos
  attacker.pos = from
  try {
    const ctx = bt.buildWeaponCtx(attacker, w, target, mode, false)
    const def = bt.defenseOf(target, ctx)
    const chance = hitChance(ctx.attackBonus, ctx.accuracy - ctx.difficulty, def)
    const pr = bt.profile(w)
    // same order as applyDamage: Exposed doubles, Armor comes off the total once, then Resistance halves
    const shredded = bt.has(target, 'shredded')
    const exposed = bt.has(target, 'exposed')
    const resists = (type: string) => !shredded && (target.resist.includes(type) || target.resist.includes('all'))
    const parts = pr.damage.filter(d => d.type !== 'Heat').map(d => {
      const amount = averageDice(d.val) + bt.flatDamageBonus(attacker, w, d.type)
      return { type: d.type, amount: exposed && d.type !== 'Burn' ? amount * 2 : amount }
    }).sort((x, y) => y.amount - x.amount)
    let armor = hasTag(pr.tags, 'tg_ap') || shredded ? 0 : target.stats.armor
    let dmg = 0
    for (const p of parts) {
      if (p.type === 'Burn') { dmg += resists('Burn') ? p.amount / 2 : p.amount; continue }
      const cut = Math.min(armor, Math.max(0, p.amount)); armor -= cut
      const left = Math.max(0, p.amount - cut)
      dmg += resists(p.type) ? left / 2 : left
    }
    let exp = dmg * chance
    const rel = tagVal(pr.tags, 'tg_reliable')
    if (rel) exp += (1 - chance) * rel
    return { ctx, chance, cover: bt.cover(attacker, target), expectedDamage: exp }
  } finally {
    attacker.pos = saved
  }
}

export function defenseOf(bt: Battle, t: Unit, ctx: AttackCtx): number {
  if (ctx.tech || (ctx.weapon && (ctx.weapon.vsEdef || hasTag(bt.profile(ctx.weapon).tags, 'tg_smart')))) return t.stats.edef
  let ev = t.stats.evasion
  if (bt.has(t, 'stunned')) ev = Math.min(ev, 5)
  return ev
}

export function buildWeaponCtx(bt: Battle, attacker: Unit, w: Weapon, target: Unit, mode: AttackCtx['mode'], consume: boolean, multi = false): AttackCtx {
  const pr = bt.profile(w)
  // a Thrown attack made beyond threat range is a ranged attack: cover and Engaged apply
  const melee = bt.isMelee(w) && distanceBetween(bt.map, { ...attacker, pos: bt.attackOrigin ?? attacker.pos }, target) <= Math.max(1, bt.weaponThreat(attacker, w))
  const ctx = bt.newAttackCtx(attacker, target, { weapon: w, profile: pr, melee, ranged: !melee, mode, multiTarget: multi })
  if (w.attackBonus != null) ctx.attackBonus = w.attackBonus
  if (w.tech) { ctx.tech = true; ctx.ignoreCover = true; ctx.ranged = false; ctx.attackBonus = w.attackBonus ?? attacker.stats.techAttack }
  if (w.accuracy) { if (w.accuracy > 0) ctx.accuracy += w.accuracy; else ctx.difficulty -= w.accuracy }
  if (hasTag(pr.tags, 'tg_accurate')) { ctx.accuracy++; ctx.reasons.push('Accurate +1') }
  if (hasTag(pr.tags, 'tg_inaccurate')) { ctx.difficulty++; ctx.reasons.push('Inaccurate -1') }
  if (hasTag(pr.tags, 'tg_seeking')) ctx.ignoreCover = true
  if (bt.has(attacker, 'impaired')) { ctx.difficulty++; ctx.reasons.push('Impaired -1') }
  if (bt.has(target, 'prone')) { ctx.accuracy++; ctx.reasons.push('Prone target +1') }
  if (bt.has(target, 'braced')) { ctx.difficulty++; ctx.reasons.push('Braced target -1') }
  if (!melee && bt.isEngaged(attacker) && !ctx.tech) { ctx.difficulty++; ctx.reasons.push('Engaged -1') }
  if (bt.has(target, 'lockon') && bt.hostile(attacker, target)) {
    ctx.accuracy++
    ctx.reasons.push('Lock On +1')
    if (consume) { bt.removeStatus(target, 'lockon'); ctx.lockOnConsumed = true }
  }
  for (const b of [...attacker.bonuses, ...w.bonuses]) {
    if (b.id === 'attack' && typeof b.val === 'number' && !b.accuracy && bt.bonusApplies(b, w)) { ctx.attackBonus += b.val; ctx.reasons.push(`+${b.val} attack`) }
  }
  for (const b of attacker.bonuses) {
    if (b.id === 'attack' && b.accuracy) { if (!b.condition || bt.evalCondition(attacker, b.condition)) { ctx.accuracy += b.accuracy; ctx.reasons.push(`Bonus +${b.accuracy}`) } }
    if (b.id === 'tech_attack' && b.accuracy && ctx.tech) ctx.accuracy += b.accuracy
  }
  for (const b of w.bonuses) if (b.id === 'mount_accuracy') { ctx.accuracy += Number(b.val) || 1; ctx.reasons.push('Hardpoints +1') }
  for (const s of scriptsFor(attacker)) s.beforeAttack?.(bt, attacker, ctx, 'attacker')
  for (const s of scriptsFor(target)) s.beforeAttack?.(bt, target, ctx, 'target')
  for (const o of bt.alive()) for (const s of scriptsFor(o)) s.beforeAnyAttack?.(bt, o, ctx)
  // cover last, so any script can set ctx.ignoreCover (Seeking Payload, Gunslinger 3, ATHENA, See-Through Seeker…)
  if (!ctx.ignoreCover && !melee) {
    // BLAST attacks calculate cover from the centre of the blast rather than the attacker
    const c = bt.cover(attacker, target, bt.blastCentre ?? bt.attackOrigin ?? undefined)
    if (c === 'hard') { ctx.difficulty += 2; ctx.reasons.push('Hard cover -2') }
    else if (c === 'soft') { ctx.difficulty += 1; ctx.reasons.push('Soft cover -1') }
  }
  return ctx
}

/** Main entry for weapon attacks (skirmish/barrage call this). Handles AoE, rolls and on-hit effects. */
export function weaponAttack(bt: Battle, u: Unit, w: Weapon, aim: AttackAim, mode: AttackCtx['mode'] = 'free', opts: { noBonusDamage?: boolean; autoHit?: boolean; from?: Pos } = {}): AttackSummary {
  if (opts.from) {
    const prev = bt.attackOrigin
    bt.attackOrigin = opts.from
    try { return bt.weaponAttack(u, w, aim, mode, { ...opts, from: undefined }) } finally { bt.attackOrigin = prev }
  }
  if (!bt.attackOrigin) for (const sc of scriptsFor(u)) {
    const o = sc.attackOrigin?.(bt, u, w, aim)
    if (o) return bt.weaponAttack(u, w, aim, mode, { ...opts, from: o })
  }
  const usable = bt.weaponUsable(u, w, mode === 'skirmish' || mode === 'barrage' || mode === 'overwatch')
  if (usable !== true) return { ctxs: [], ok: false, reason: usable }
  bt.lastAim = { ...aim }
  const pr = bt.profile(w)
  let targets: Unit[] = []
  let tiles: Pos[] | null = null
  if (bt.isAoE(pr)) {
    const aimTile = aim.tile ?? (aim.targetId ? bt.unit(aim.targetId)!.pos : u.pos)
    const t = bt.aoeTiles(u, w, aimTile)
    if (typeof t === 'string') return { ctxs: [], ok: false, reason: t }
    tiles = t
    targets = unitsOnTiles(bt.alive(), t).filter(x => x !== u && (x.kind !== 'deployable' || bt.hostile(u, x)))
    bt.emit({ type: 'area', tiles: t, kind: 'attack' })
  } else {
    const t = bt.unit(aim.targetId)
    if (!t) return { ctxs: [], ok: false, reason: 'No target' }
    const v = bt.validTarget(u, w, t, bt.attackOrigin ?? u.pos)
    if (v !== true) return { ctxs: [], ok: false, reason: v }
    targets = [t]
  }
  bt.say(`${u.name} attacks with ${w.name}${pr.name !== w.name ? ` (${pr.name})` : ''}.`, 'attack')
  u.flags['turn:attacked'] = true
  if (bt.has(u, 'hidden')) bt.removeStatus(u, 'hidden')
  // on_attack effects
  for (const e of pr.onAttack) if (e.do === 'text') bt.say(`  ${stripHtml(e.text)}`)
  const multi = targets.length > 1
  // roll damage once for all targets
  const overkill = hasTag(pr.tags, 'tg_overkill')
  const ctxs: AttackCtx[] = []
  for (const t of targets) {
    const blast = bt.ranges(u, w).some(r => r.type === 'Blast')
    bt.blastCentre = blast && aim.tile ? aim.tile : null
    let ctx: AttackCtx
    try { ctx = bt.buildWeaponCtx(u, w, t, mode, true, multi) } finally { bt.blastCentre = null }
    if (opts.noBonusDamage || w.noBonusDamage) ctx.bonusDamage = []
    if (opts.autoHit) ctx.autoHit = true
    bt.rollToHit(ctx)
    ctxs.push(ctx)
  }
  const anyCrit = ctxs.some(c => c.crit)
  const dmgNormal: { type: string; amount: number }[] = []
  const dmgCrit: { type: string; amount: number }[] = []
  let overkillHeat = 0
  for (const d of pr.damage) {
    const flat = bt.flatDamageBonus(u, w, d.type)
    const r1 = u.flags.averageDamage ? averageRoll(d.val) : rollDice(bt.rng, d.val, { overkill })
    overkillHeat += r1.overkillHeat
    dmgNormal.push({ type: d.type, amount: Math.max(0, r1.total + flat) })
    if (anyCrit) {
      const r2 = u.flags.averageDamage ? averageRoll(d.val) : rollDice(bt.rng, d.val, { crit: true, overkill })
      overkillHeat += r2.overkillHeat
      dmgCrit.push({ type: d.type, amount: Math.max(0, r2.total + flat) })
    }
  }
  for (const ctx of ctxs) {
    const t = ctx.target
    if (ctx.hit) {
      // Brutal (Predator): a natural 20 crit deals maximum damage and bonus damage
      const base = ctx.maxDamage ? pr.damage.map(d => ({ type: d.type, amount: maxOf(d.val) + bt.flatDamageBonus(u, w, d.type) })) : (ctx.crit ? dmgCrit : dmgNormal).map(x => ({ ...x }))
      // bonus damage (halved vs multiple targets)
      for (const bd of ctx.bonusDamage) {
        let a = ctx.maxDamage ? maxOf(bd.val) : rollDice(bt.rng, bd.val, { crit: ctx.crit }).total
        if (multi) a = Math.ceil(a / 2)
        base.push({ type: bd.type, amount: a })
      }
      for (const e of [...pr.onHit, ...(ctx.crit ? pr.onCrit : [])]) if (e.do === 'bonus_damage') {
        let a = ctx.maxDamage ? maxOf(e.val) : rollDice(bt.rng, e.val, { crit: ctx.crit }).total
        if (multi) a = Math.ceil(a / 2)
        base.push({ type: e.type ?? pr.damage[0]?.type ?? 'Kinetic', amount: a })
      }
      // Combat Drill: each Overkill activation adds +1d6, chaining while the new die is a 1
      if (ctx.overkillBonus && overkillHeat > 0) {
        let n = overkillHeat, extra = 0, chained = 0
        while (n-- > 0 && chained < 50) { const r = bt.rng.d(6); extra += r; if (r === 1) { n++; chained++ } }
        overkillHeat += chained
        if (extra) { base.push({ type: pr.damage[0]?.type ?? 'Kinetic', amount: extra }); bt.say(`  Overkill drill: +${extra} bonus damage.`) }
      }
      // Deadly (Veteran trait / Ultra): +1d6 damage on critical hits
      if (ctx.crit && u.traits?.includes('deadly')) base.push({ type: pr.damage[0]?.type ?? 'Kinetic', amount: bt.rng.d(6) })
      const burnTag = tagVal(pr.tags, 'tg_burn')
      if (burnTag) base.push({ type: 'Burn', amount: burnTag })
      const heatTag = tagVal(pr.tags, 'tg_heat_target')
      if (heatTag) base.push({ type: 'Heat', amount: heatTag })
      // half damage, heat and burn (SCYLLA reactions)
      if (u.flags.halfDamage) for (const p of base) p.amount = Math.ceil(p.amount / 2)
      let resistAll = !!ctx.resistAll
      if (!ctx.cancelDamage && !resistAll && bt.braceWanted(t, u, base, ctx)) resistAll = bt.brace(t)
      if (t.flags.flashAegis && resistAll && !ctx.resistAll) for (const p of base) p.amount = Math.min(p.amount, 1)
      if (!ctx.cancelDamage) ctx.damageDealt = bt.applyDamage(t, base, {
        source: u, attack: ctx, ap: hasTag(pr.tags, 'tg_ap') || !!ctx.ap, irreducible: hasTag(pr.tags, 'tg_irreducible') || ctx.irreducible, resistAll,
      })
      const kb = (tagVal(pr.tags, 'tg_knockback') ?? 0) + u.bonuses.filter(b => b.id === 'knockback' && bt.bonusApplies(b, w)).reduce((a, b) => a + Number(b.val), 0)
      if (kb && !t.destroyed) bt.forceMove(t, u, kb, 1)
      bt.runEffects(u, t, pr.onHit.filter(e => e.do !== 'bonus_damage'), ctx)
      if (ctx.crit) bt.runEffects(u, t, pr.onCrit.filter(e => e.do !== 'bonus_damage'), ctx)
    } else {
      const rel = tagVal(pr.tags, 'tg_reliable')
      // Reliable damage applies to grunts too (it kills them); only successful saves leave grunts unharmed
      if (rel) {
        bt.say(`  Reliable: ${rel} damage.`)
        bt.applyDamage(t, [{ type: pr.damage[0]?.type ?? 'Kinetic', amount: rel }], { source: u, ap: hasTag(pr.tags, 'tg_ap') })
      }
    }
    for (const s of scriptsFor(u)) s.afterAttack?.(bt, u, ctx, 'attacker')
    if (!t.destroyed) for (const s of scriptsFor(t)) s.afterAttack?.(bt, t, ctx, 'target')
    if (bt.reactionDepth < 2) {
      bt.reactionDepth++
      try { for (const o of bt.alive()) for (const s of scriptsFor(o)) s.afterAnyAttack?.(bt, o, ctx) } finally { bt.reactionDepth-- }
    }
  }
  // costs
  const heatSelf = tagVal(pr.tags, 'tg_heat_self')
  if (heatSelf && !w.flags?.delayedImpact) bt.addHeat(u, heatSelf)
  if (overkillHeat) { bt.say(`  Overkill: +${overkillHeat} heat.`); bt.addHeat(u, overkillHeat) }
  if (hasTag(pr.tags, 'tg_loading')) w.loaded = false
  if (w.usesLeft != null) w.usesLeft--
  if (w.recharge != null) w.charged = false
  if (tiles && pr.onAttack.some(e => e.do !== 'text')) bt.runEffects(u, u, pr.onAttack, undefined)
  return { ctxs, ok: true }
}

/** Reroll a resolved attack roll (Valiant Aid): the second result stands. */
export function rerollToHit(bt: Battle, ctx: AttackCtx) {
  const net = ctx.accuracy - (ctx.ignoreDifficulty ? 0 : ctx.difficulty)
  const d20 = bt.rollD20(ctx.attacker, 'attack', ctx)
  const acc = rollAccuracy(bt.rng, net)
  const total = d20 + ctx.attackBonus + acc.bonus
  const def = bt.defenseOf(ctx.target, ctx)
  ctx.roll = d20
  ctx.total = total
  ctx.hit = total >= def
  ctx.crit = ctx.hit && total >= 20 && ctx.attacker.canCrit && !ctx.tech
  bt.say(`  Reroll vs ${ctx.target.name}: ${total} — ${ctx.crit ? 'CRITICAL HIT' : ctx.hit ? 'HIT' : 'MISS'}`, 'attack')
  bt.emit({ type: 'attack', attackerId: ctx.attacker.id, targetId: ctx.target.id, hit: !!ctx.hit, crit: !!ctx.crit, weapon: ctx.weapon?.name ?? 'tech', total })
}

export function rollToHit(bt: Battle, ctx: AttackCtx) {
  const t = ctx.target
  const net = ctx.accuracy - (ctx.ignoreDifficulty ? 0 : ctx.difficulty)
  if (ctx.cancelled) {
    ctx.hit = false
    ctx.crit = false
    bt.emit({ type: 'attack', attackerId: ctx.attacker.id, targetId: t.id, hit: false, crit: false, weapon: ctx.weapon?.name ?? 'tech', total: 0 })
    return
  }
  const seesThrough = t.flags.trackedBy === ctx.attacker.id || (ctx.attacker.flags.horusUntil && bt.round <= ctx.attacker.flags.horusUntil) || bt.inRevealField(t)
  if ((bt.has(t, 'invisible') || ctx.forceInvisible) && !seesThrough && bt.rng.d(6) <= 3) {
    ctx.hit = false
    ctx.crit = false
    bt.say(`  vs ${t.name}: misses (invisible).`)
    bt.emit({ type: 'attack', attackerId: ctx.attacker.id, targetId: t.id, hit: false, crit: false, weapon: ctx.weapon?.name ?? 'tech', total: 0 })
    return
  }
  if (ctx.autoHit) {
    ctx.hit = true
    ctx.crit = false
    ctx.total = 0
    bt.say(`  vs ${t.name}: automatic HIT`, 'attack')
    bt.emit({ type: 'attack', attackerId: ctx.attacker.id, targetId: t.id, hit: true, crit: false, weapon: ctx.weapon?.name ?? 'tech', total: 0 })
    return
  }
  let d20 = bt.rollD20(ctx.attacker, 'attack', ctx)
  let acc = rollAccuracy(bt.rng, net)
  let total = d20 + ctx.attackBonus + acc.bonus
  const def = bt.defenseOf(t, ctx)
  if (total < def && ctx.rerollOnMiss && (ctx.rerollOnMiss === true || ctx.rerollOnMiss())) {
    bt.say(`  ${ctx.attacker.name} rerolls (${total}).`)
    d20 = bt.rng.d(20)
    acc = rollAccuracy(bt.rng, net)
    total = d20 + ctx.attackBonus + acc.bonus
  }
  ctx.roll = d20
  ctx.total = total
  ctx.hit = total >= def
  ctx.crit = ctx.hit && total >= 20 && ctx.attacker.canCrit && !ctx.tech
  const accTxt = net ? ` ${net > 0 ? '+' : '-'}${Math.abs(net)}${net > 0 ? 'acc' : 'diff'}[${acc.dice.join(',')}]` : ''
  bt.say(`  vs ${t.name}: ${total} (d20 ${d20} +${ctx.attackBonus}${accTxt}) vs ${ctx.tech || (ctx.weapon && (ctx.weapon.vsEdef || hasTag(bt.profile(ctx.weapon).tags, 'tg_smart'))) ? 'E-DEF' : 'EVA'} ${def} — ${ctx.crit ? 'CRITICAL HIT' : ctx.hit ? 'HIT' : 'MISS'}`, 'attack')
  for (const o of bt.alive()) for (const sc of scriptsFor(o)) sc.afterAnyRoll?.(bt, o, ctx)
  if (!ctx.hit) ctx.crit = false
  bt.emit({ type: 'attack', attackerId: ctx.attacker.id, targetId: t.id, hit: !!ctx.hit, crit: !!ctx.crit, weapon: ctx.weapon?.name ?? 'tech', total })
}

/** Run DSL effects from `src` against `target`. */
export function runEffects(bt: Battle, src: Unit, target: Unit, effects: Effect[], ctx?: AttackCtx, saveTarget?: number) {
  const st = saveTarget ?? (src.stats.save || 10)
  for (const e of effects) {
    const who = e.do !== 'text' && e.do !== 'bonus_damage' && e.do !== 'teleport' && (e as any).target === 'self' ? src : target
    if (who.destroyed && e.do !== 'text') continue
    if ('save' in e && e.save && bt.hostile(src, who) && bt.has(src, 'hidden')) bt.removeStatus(src, 'hidden')
    const saved = 'save' in e && e.save ? bt.save(who, e.save, st, 0, src) : false
    switch (e.do) {
      case 'text':
        bt.say(`  ${stripHtml(e.text)}`)
        break
      case 'status':
        if (!saved) bt.addStatus(who, e.status, e.duration ?? 'next_turn_end_target', src)
        break
      case 'damage': {
        const parts = e.damage.map(d => ({ type: d.type, amount: rollDice(bt.rng, d.val).total }))
        if (saved) { if (e.saveHalf && !who.isGrunt) bt.applyDamage(who, parts.map(p => ({ ...p, amount: bt.halfOnSave(who, p.amount) })), { source: src, ap: e.ap }) }
        else bt.applyDamage(who, parts, { source: src, ap: e.ap })
        break
      }
      case 'heat':
        if (!saved) bt.applyDamage(who, [{ type: 'Heat', amount: rollDice(bt.rng, e.val).total }], { source: src })
        break
      case 'burn':
        if (!saved) bt.applyDamage(who, [{ type: 'Burn', amount: e.val }], { source: src })
        break
      case 'push':
      case 'pull':
        if (!saved) bt.forceMove(who, src, rollDice(bt.rng, e.val).total, e.do === 'push' ? 1 : -1)
        break
      case 'overshield': {
        const v = rollDice(bt.rng, e.val).total
        who.overshield = Math.max(who.overshield, v)
        bt.say(`${who.name} gains ${v} overshield.`)
        break
      }
      case 'heal':
        bt.heal(who, rollDice(bt.rng, e.val).total)
        break
      case 'clear_heat': {
        const v = e.val === 'all' ? who.heat : rollDice(bt.rng, e.val).total
        who.heat = Math.max(0, who.heat - v)
        bt.say(`${who.name} clears ${v} heat.`)
        break
      }
      case 'clear_status': {
        const s = e.status === 'any_negative' || !e.status ? who.statuses.find(s => NEGATIVE.includes(s.id))?.id : e.status
        if (s) bt.removeStatus(who, s)
        break
      }
      case 'teleport':
        break
      case 'bonus_damage':
        break
    }
  }
}

/** Rough incoming HP damage before resistance (for brace decisions and prompts). */
export function estimateIncoming(bt: Battle, t: Unit, parts: { type: string; amount: number }[]): number {
  return Math.max(0, parts.filter(p => p.type !== 'Heat').reduce((a, p) => a + p.amount, 0) * (bt.has(t, 'exposed') ? 2 : 1) - t.stats.armor)
}

export function shouldBrace(bt: Battle, t: Unit, parts: { type: string; amount: number }[]): boolean {
  if (t.kind !== 'mech' && !(t.kind === 'npc' && t.stats.structure > 1)) return false
  if (bt.canSpend(t, 'reaction') !== true) return false
  const est = bt.estimateIncoming(t, parts)
  return est >= t.hp + t.overshield && t.structure <= Math.max(2, t.stats.structure - 1)
}

export function braceWanted(bt: Battle, t: Unit, attacker: Unit, parts: { type: string; amount: number }[], ctx: AttackCtx): boolean {
  if (t.policies.brace === 'off' || (t.kind !== 'mech' && !(t.kind === 'npc' && t.stats.structure > 1))) return false
  if (bt.canSpend(t, 'reaction') !== true) return false
  const est = bt.estimateIncoming(t, parts)
  if (t.policies.brace === 'ask') {
    // only bother the player when the hit actually matters
    if (est < Math.min(t.hp + t.overshield, Math.ceil(t.stats.hp / 2))) return false
    const structureHit = est >= t.hp + t.overshield
    return bt.wantsReaction(t, 'brace', true, attacker,
      `BRACE? ${attacker.name} ${ctx.crit ? 'CRITS' : 'hits'} ${t.name} for about ${est} damage (HP ${t.hp}/${t.stats.hp}${t.overshield ? ` +${t.overshield} OS` : ''}, structure ${t.structure})${structureHit ? ' — this will cause STRUCTURE damage' : ''}.\n\nBracing halves the damage, but next turn ${t.name} gets only one quick action and no reactions.`)
  }
  return bt.shouldBrace(t, parts)
}

export function brace(bt: Battle, t: Unit): boolean {
  if (bt.canSpend(t, 'reaction', 'brace') !== true) return false
  bt.spend(t, 'reaction', 'brace')
  bt.say(`${t.name} BRACES for impact!`, 'status')
  // Armor-Lock Plating: bracing breaks every grapple on you
  if (t.flags.braceWhileGrappled && bt.grapples.some(g => g.a === t.id || g.d === t.id)) {
    bt.grapples = bt.grapples.filter(g => g.a !== t.id && g.d !== t.id)
    bt.syncGrapples()
    bt.say(`  ${t.name} locks its armor and throws off every grapple.`)
  }
  bt.addStatus(t, 'braced', 'next_turn_end_target')
  bt.addStatus(t, 'bracing_recovery', 'next_turn_end_target')
  return true
}
