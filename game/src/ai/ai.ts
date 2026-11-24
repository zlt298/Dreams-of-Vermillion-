// Utility-based tactical AI. Evaluates reachable positions × available actions and executes the
// best plan through the normal Battle API, so the AI obeys exactly the same rules as players.
import { PendingChoice, type Battle } from '../rules/battle'
import { Lancer } from '../data/lancer'
import { blastTiles, lineTiles, coneTiles, burstTiles, key, unitsOnTiles, footprint, tileAt } from '../rules/grid'
import type { Effect, Pos, Unit, Weapon } from '../rules/types'
import type { CustomAction } from '../rules/effects/registry'
import { averageDice } from '../rules/rng'
import { hasTag, tagVal } from '../rules/stats'
import { sekhmetTurn } from '../rules/effects/scripts/systems2'
import { needsBarrage } from '../rules/battle/actions'

const STATUS_VALUE: Record<string, number> = {
  stunned: 9, exposed: 6, immobilized: 3.5, impaired: 3, jammed: 3, shredded: 3, slowed: 2, prone: 2.5, lockon: 1.5,
}

const CAUTION: Record<string, number> = {
  Striker: 0.45, Defender: 0.25, Artillery: 1.0, Support: 0.9, Controller: 0.8, Biological: 0.35, mech: 0.7,
}

type Option =
  | { kind: 'skirmish'; weapon: Weapon; aim: { targetId?: string; tile?: Pos }; value: number; cost: 'quick' }
  | { kind: 'barrage'; a: { weapon: Weapon; aim: { targetId?: string; tile?: Pos } }; b?: { weapon: Weapon; aim: { targetId?: string; tile?: Pos } }; value: number; cost: 'full' }
  | { kind: 'custom'; action: CustomAction; target?: Unit | Pos; value: number; cost: 'quick' | 'full' | 'protocol' | 'free' }
  | { kind: 'invade'; target: Unit; value: number; cost: 'quick' }
  | { kind: 'lockon'; target: Unit; value: number; cost: 'quick' }
  | { kind: 'stabilize'; value: number; cost: 'full' }
  | { kind: 'core'; value: number; cost: 'quick' | 'full' | 'protocol' | 'free' }

interface Plan { dest: Pos; boost: boolean; actions: Option[]; value: number }

function effectValue(b: Battle, src: Unit, t: Unit, effects: Effect[]): number {
  let v = 0
  for (const e of effects) {
    switch (e.do) {
      case 'status': if (!b.has(t, e.status) && !t.immune.includes(e.status)) v += (STATUS_VALUE[e.status] ?? 1) * (e.save ? 0.5 : 1); break
      case 'damage': v += e.damage.reduce((a, d) => a + averageDice(d.val), 0) * (e.save ? 0.6 : 1); break
      case 'heat': v += averageDice(e.val) * (t.stats.heatcap > 0 ? (t.heat + averageDice(e.val) > t.stats.heatcap ? 2.5 : 1.1) : 0) * (e.save ? 0.5 : 1); break
      case 'burn': v += e.val * 1.6; break
      case 'push': case 'pull': v += 0.5; break
      case 'bonus_damage': v += averageDice(e.val); break
    }
  }
  return v
}

/** Expected value of attacking `t` with `w` from position `from`. */
/**
 * Value of a hit with Fragment Signal: 2 heat plus Impaired and Slowed. Statuses the target already has are
 * worth nothing (repeat invades on a disabled target used to crowd out weapon attacks). Heat destroys a Grunt,
 * is Energy damage to a character without a Heat Cap, and matters most when it would overheat the target.
 */
function invadeValue(b: Battle, u: Unit, t: Unit): number {
  const status = effectValue(b, u, t, [{ do: 'status', status: 'impaired' } as Effect, { do: 'status', status: 'slowed' } as Effect])
  return status + invadeHeatValue(t)
}
/** The 2 heat every Invade deals on a hit (see invadeValue). */
function invadeHeatValue(t: Unit): number {
  return t.isGrunt ? 4 : !t.stats.heatcap ? 2 : t.heat + 2 > t.stats.heatcap ? 4 : 1
}
/** Chance that a tech attack from `u` hits `t` (d20 + Tech Attack vs E-Defense). */
function techHitChance(u: Unit, t: Unit): number {
  return Math.max(0.1, Math.min(0.95, (21 - (t.stats.edef - u.stats.techAttack)) / 20))
}

function attackValue(b: Battle, u: Unit, w: Weapon, t: Unit, from: Pos): number {
  if (!b.hostile(u, t) || t.destroyed) return 0
  const saved = u.pos
  u.pos = from
  try {
    if (b.validTarget(u, w, t, from) !== true) return 0
  } finally { u.pos = saved }
  const p = b.previewAttack(u, w, t, from)
  let v = p.expectedDamage
  const pr = b.profile(w)
  v += p.chance * effectValue(b, u, t, pr.onHit)
  const hp = t.hp + t.overshield
  if (p.expectedDamage / Math.max(0.01, p.chance) >= hp) v += 4 * p.chance * (t.isGrunt ? 0.5 : 1) // likely kill / structure
  if (t.isGrunt) {
    // a grunt dies to any hit, and to Reliable damage on a miss
    const kill = tagVal(pr.tags, 'tg_reliable') ? 1 : p.chance
    v = 3 * kill + 1
  }
  if (t.kind === 'deployable' || t.kind === 'drone') v *= 0.4
  const heat = tagVal(pr.tags, 'tg_heat_self') ?? 0
  if (heat && u.stats.heatcap > 0) v -= heat * (u.heat + heat > u.stats.heatcap ? 4 : 0.5)
  return v
}

function aoeValue(b: Battle, u: Unit, w: Weapon, from: Pos): { value: number; tile: Pos } | null {
  const saved = u.pos
  u.pos = from
  try {
    let best: { value: number; tile: Pos } | null = null
    const aims = b.alive().filter(t => b.hostile(u, t)).map(t => t.pos)
    for (const aim of aims) {
      const tiles = b.aoeTiles(u, w, aim)
      if (typeof tiles === 'string') continue
      let v = 0
      for (const t of unitsOnTiles(b.alive(), tiles)) {
        if (t === u) continue
        const dmg = b.profile(w).damage.reduce((a, d) => a + averageDice(d.val), 0)
        const val = (dmg * 0.6 + effectValue(b, u, t, b.profile(w).onHit) * 0.6) * (t.isGrunt ? 0.6 : 1)
        v += b.hostile(u, t) ? val : -val * 1.5
      }
      if (!best || v > best.value) best = { value: v, tile: aim }
    }
    return best
  } finally { u.pos = saved }
}

function weaponReachOf(b: Battle, u: Unit): number {
  return Math.max(1, ...u.weapons.filter(w => !w.destroyed && !w.tech).map(w => b.weaponReach(u, w)))
}

function customValue(b: Battle, u: Unit, a: CustomAction, from: Pos): { value: number; target?: Unit | Pos } | null {
  if (a.usable(b, u) !== true) return null
  const saved = u.pos
  u.pos = from
  try {
    const f = (u.systems.find(s => s.uid === a.sourceUid)?.feature) as any
    const effects: Effect[] = f?.effects ?? []
    const allies = b.alive().filter(x => !b.hostile(u, x) && (x.kind === 'mech' || x.kind === 'npc'))
    const hostiles = b.alive().filter(x => b.hostile(u, x) && (x.kind === 'mech' || x.kind === 'npc'))
    const beneficial = (t: Unit) => {
      let v = 0
      for (const e of effects) {
        if (e.do === 'heal') v += Math.min(t.stats.hp - t.hp, averageDice(e.val)) * 1.2
        if (e.do === 'overshield') v += Math.max(0, averageDice(e.val) - t.overshield) * (b.alive().some(h => b.hostile(t, h) && b.distance(t, h) <= 8) ? 1 : 0.3)
        if (e.do === 'clear_heat') v += Math.min(t.heat, e.val === 'all' ? t.heat : averageDice(e.val)) * 0.8
        if (e.do === 'clear_status') v += t.statuses.some(s => STATUS_VALUE[s.id]) ? 3 : 0
        if (e.do === 'status' && (e.target === 'self' || a.target === 'self')) v += 1.5
      }
      return v
    }
    const heatPenalty = a.heat ? a.heat * (u.heat + a.heat > u.stats.heatcap ? 4 : 0.4) : 0
    if (a.target === 'self') {
      if (a.area) {
        const tiles = burstTiles(b.map, u, a.area.size)
        let v = 0
        for (const t of unitsOnTiles(b.alive(), tiles)) if (t !== u) v += b.hostile(u, t) ? effectValue(b, u, t, effects) * (f?.save ? 0.6 : 1) : beneficial(t)
        if (!f) v = a.aiScore?.(b, u) ?? 0
        return { value: v - heatPenalty }
      }
      return { value: (f ? beneficial(u) : a.aiScore?.(b, u) ?? 0) - heatPenalty }
    }
    if (a.target === 'ally') {
      let best: { value: number; target?: Unit } | null = null
      for (const t of allies) {
        if (a.range != null && b.distance(u, t) > a.range) continue
        const v = beneficial(t)
        if (!best || v > best.value) best = { value: v, target: t }
      }
      return best ? { ...best, value: best.value - heatPenalty } : null
    }
    if (a.target === 'enemy' || a.target === 'unit') {
      let best: { value: number; target?: Unit } | null = null
      for (const t of hostiles) {
        if (a.range != null && b.distance(u, t) > a.range) continue
        if (!b.los(u, t)) continue
        let v = f ? effectValue(b, u, t, effects) * (f.save ? 0.6 : 1) : (a.aiScore?.(b, u, t) ?? 0) * 0.6
        // scripted tech attacks (system invades, full techs): weigh by the hit chance, and count an invade's
        // own 2 heat, so they compare fairly with Fragment Signal (which is valued the same way)
        if (!f && a.aiScore && /tech/.test(a.activation)) {
          // the engine refuses tech actions on Biological, shut-down, hidden or out-of-range targets: don't plan them
          if (b.techTargetValid(u, t, a.techOption) !== true) continue
          v = techHitChance(u, t) * ((a.aiScore(b, u, t) ?? 0) + (a.techOption === 'invade' ? invadeHeatValue(t) : 0))
        }
        if (!best || v > best.value) best = { value: v, target: t }
      }
      return best ? { ...best, value: best.value - heatPenalty } : null
    }
    if (a.target === 'tile' && a.area) {
      let best: { value: number; target?: Pos } | null = null
      for (const h of hostiles) {
        const aim = h.pos
        if (a.range != null && b.distance(u, h) > a.range + 1) continue
        const tiles = a.area.shape === 'line' ? lineTiles(b.map, u, aim, a.area.size) : a.area.shape === 'cone' ? coneTiles(b.map, u, aim, a.area.size) : blastTiles(b.map, aim, a.area.size)
        let v = 0
        for (const t of unitsOnTiles(b.alive(), tiles)) if (t !== u) v += b.hostile(u, t) ? (f ? effectValue(b, u, t, effects) : (a.aiScore?.(b, u, t) ?? 3) * 0.6) : -4
        if (a.name.startsWith('Deploy')) v = 0.5
        if (!best || v > best.value) best = { value: v, target: aim }
      }
      return best ? { ...best, value: best.value - heatPenalty } : null
    }
    // untargeted actions (protocols like Active Camouflage, ASURA, Deactivate Fortress) score themselves
    if (a.target === 'none' && a.aiScore) return { value: a.aiScore(b, u) - heatPenalty }
    return null
  } finally { u.pos = saved }
}

function costOf(a: CustomAction): 'quick' | 'full' | 'protocol' | 'free' | null {
  if (a.activation === 'quick' || a.activation === 'quick_tech') return 'quick'
  if (a.activation === 'full' || a.activation === 'full_tech') return 'full'
  if (a.activation === 'protocol') return 'protocol'
  if (a.activation === 'free') return 'free'
  return null
}

interface Threat { h: Unit; reach: number; best: number }

/** Per-plan summary of each hostile's reach and best damage (independent of our position). */
function threatsAgainst(b: Battle, u: Unit): Threat[] {
  return b.alive().filter(h => b.hostile(u, h) && (h.kind === 'mech' || h.kind === 'npc')).map(h => ({
    h,
    reach: Math.max(1, ...h.weapons.filter(w => !w.destroyed).map(w => b.weaponReach(h, w))),
    best: Math.max(0, ...h.weapons.filter(w => !w.destroyed && !w.tech).map(w => b.profile(w).damage.reduce((a, d) => a + averageDice(d.val), 0))),
  }))
}

/** Expected damage from ending a turn at `p`: dangerous terrain (5 energy on a failed Engineering check) and damage areas. */
function hazardCost(b: Battle, u: Unit, p: Pos): number {
  if (u.flying || u.flags.ignoreHazard) return 0
  const fp = footprint(u, p)
  let cost = 0
  if (!u.flags['round:hazard'] && fp.some(q => tileAt(b.map, q)?.kind === 'hazard')) cost += 3
  for (const a of b.areas) if (a.kind === 'damage' && a.damage && fp.some(q => a.tiles.some(t => t.x === q.x && t.y === q.y))) cost += averageDice(a.damage)
  return cost
}

/**
 * Rounds the fight has gone without anyone attacking, beyond a grace period for the opening
 * approach. Long-ranged teams that hang back can otherwise freeze both sides just outside each
 * other's reach until the round cap; the advance pull grows with this so somebody commits.
 */
/**
 * Rounds this unit has gone without making an attack, beyond the same grace period. The AI plans one turn
 * at a time, so a cautious unit two moves from the fight never commits while its allies are fighting (the
 * battle as a whole isn't stalled); this grows its advance pull the same way.
 */
export function unitIdleRounds(b: Battle, u: Unit, grace = 3): number {
  return Math.max(0, b.round - (u.flags.lastAttackRound ?? 0) - grace)
}
export function stallRounds(b: Battle, grace = 3): number {
  return Math.max(0, b.round - b.lastAttackRound - grace)
}
let stall = 0

function positionValue(b: Battle, u: Unit, p: Pos, threats: Threat[] = threatsAgainst(b, u)): number {
  const hazard = hazardCost(b, u, p)
  if (!threats.length) return -hazard
  const saved = u.pos
  u.pos = p
  try {
    let danger = 0
    let nearest = Infinity
    for (const { h, reach, best } of threats) {
      const d = b.distance(u, h)
      nearest = Math.min(nearest, d)
      if (d > reach + h.stats.speed) continue
      const cover = b.cover(h, u)
      const chance = cover === 'hard' ? 0.35 : cover === 'soft' ? 0.5 : 0.65
      danger += best * chance * (d <= reach ? 1 : 0.6)
    }
    const role = u.role ?? 'mech'
    let v = -danger * (CAUTION[role] ?? 0.7) * (u.hp < u.stats.hp / 2 ? 1.4 : 1)
    if (role === 'Striker' || role === 'Biological') v -= nearest * 0.25
    if (role === 'Artillery' && nearest <= 3) v -= (4 - nearest) * 1.5
    if (role === 'Defender') {
      const allies = b.alive().filter(a => a !== u && !b.hostile(u, a) && a.kind === 'npc')
      if (allies.length) v -= Math.min(...allies.map(a => b.distance(u, a))) * 0.2
      v -= nearest * 0.15
    }
    if (role === 'Support') {
      const allies = b.alive().filter(a => a !== u && !b.hostile(u, a) && a.kind === 'npc')
      if (allies.length) v -= Math.min(...allies.map(a => b.distance(u, a))) * 0.25
    }
    // advance pull: on long maps, units out of their own reach close the distance
    // (artillery/controllers more gently, so they settle near their preferred range)
    const myReach = Math.max(1, ...u.weapons.filter(w => !w.destroyed).map(w => b.weaponReach(u, w)))
    const k = (role === 'Artillery' || role === 'Controller' ? 0.25 : 0.35) * (1 + stall)
    if (nearest > myReach) v -= (nearest - myReach) * k
    // sitrep objectives
    const zone = b.sitrep.zone
    if (zone && (b.sitrep.id === 'control' || (b.sitrep.id === 'extraction' && u.side === 'player'))) {
      const inZone = zone.some(z => z.x === p.x && z.y === p.y)
      const dz = Math.min(...zone.map(z => Math.max(Math.abs(z.x - p.x), Math.abs(z.y - p.y))))
      v += inZone ? 4 : -dz * 0.35
    }
    if (b.isEngaged(u, p) && u.weapons.every(w => !b.isMelee(w))) v -= 1.5
    return v - hazard
  } finally { u.pos = saved }
}

function optionsAt(b: Battle, u: Unit, p: Pos): Option[] {
  const opts: Option[] = []
  const hostiles = b.alive().filter(t => b.hostile(u, t))
  for (const w of u.weapons) {
    if (b.weaponUsable(u, w) !== true) continue
    const pr = b.profile(w)
    let best: { value: number; aim: { targetId?: string; tile?: Pos } } | null = null
    if (b.isAoE(pr)) {
      const r = aoeValue(b, u, w, p)
      if (r && r.value > 0) best = { value: r.value, aim: { tile: r.tile } }
    } else for (const t of hostiles) {
      const v = attackValue(b, u, w, t, p)
      if (v > 0 && (!best || v > best.value)) best = { value: v, aim: { targetId: t.id } }
    }
    if (!best) continue
    if (needsBarrage(w) || w.activation === 'full') opts.push({ kind: 'barrage', a: { weapon: w, aim: best.aim }, value: best.value, cost: 'full' })
    else opts.push({ kind: 'skirmish', weapon: w, aim: best.aim, value: best.value, cost: 'quick' })
  }
  // barrage: best two skirmish-capable weapons
  const sk = opts.filter((o): o is Extract<Option, { kind: 'skirmish' }> => o.kind === 'skirmish' && !o.weapon.tech && o.weapon.size !== 'Superheavy').sort((a, b) => b.value - a.value)
  if (sk.length >= 2) opts.push({ kind: 'barrage', a: { weapon: sk[0].weapon, aim: sk[0].aim }, b: { weapon: sk[1].weapon, aim: sk[1].aim }, value: sk[0].value + sk[1].value, cost: 'full' })
  for (const a of b.customActions(u)) {
    const c = costOf(a)
    if (!c) continue
    if (a.aiTarget) {
      // scripts that know how to aim themselves (drones, deployables, fields)
      if (a.usable(b, u) !== true) continue
      const saved = u.pos
      u.pos = p
      let t: Unit | Pos | null = null
      let v = 0
      try { t = a.aiTarget(b, u); v = t ? a.aiScore?.(b, u, t) ?? 1 : 0 } finally { u.pos = saved }
      if (t && v > 0.5) opts.push({ kind: 'custom', action: a, target: t, value: v, cost: c })
      continue
    }
    if (a.text && a.name.startsWith('Deploy') && !u.flags[`ai_deployed_${a.key}`]) {
      if (a.usable(b, u) !== true) continue
      // deploy cover/drones once, early
      const tgt = a.target === 'tile' ? { x: Math.max(0, Math.min(b.map.w - 1, p.x + 1)), y: p.y } : undefined
      opts.push({ kind: 'custom', action: a, target: tgt, value: b.round <= 2 ? 1.5 : 0.3, cost: c })
      continue
    }
    const r = customValue(b, u, a, p)
    if (r && r.value > 0.5) opts.push({ kind: 'custom', action: a, target: r.target, value: r.value, cost: c })
  }
  if (u.kind === 'mech' && !b.has(u, 'jammed') && (b.canQuickTech(u, 'invade') === true || b.canQuickTech(u, 'lock_on') === true)) {
    for (const t of hostiles) {
      if (t.kind !== 'mech' && t.kind !== 'npc') continue
      const saved = u.pos
      u.pos = p
      try {
        if (b.techTargetValid(u, t, 'lock_on') !== true) continue
        const canInvade = b.canQuickTech(u, 'invade') === true && b.techTargetValid(u, t) === true
        const chance = techHitChance(u, t)
        if (canInvade) opts.push({ kind: 'invade', target: t, value: chance * invadeValue(b, u, t), cost: 'quick' })
        if (!b.has(t, 'lockon') && b.canQuickTech(u, 'lock_on') === true) opts.push({ kind: 'lockon', target: t, value: 1.2, cost: 'quick' })
      } finally { u.pos = saved }
    }
  }
  // Stabilize: cool down when hot or Exposed; it is also the only general way to reload Loading weapons
  const unloaded = u.weapons.filter(w => !w.loaded && !w.destroyed).length
  const loadedLeft = u.weapons.filter(w => !w.destroyed && w.loaded && b.weaponUsable(u, w) === true).length
  if (u.stats.heatcap > 0 && (b.has(u, 'exposed') || u.heat >= u.stats.heatcap - 1)) opts.push({ kind: 'stabilize', value: 3 + (b.has(u, 'exposed') ? 4 : 0) + u.heat * 0.5 + unloaded, cost: 'full' })
  else if (unloaded && !loadedLeft) opts.push({ kind: 'stabilize', value: 1.5 + unloaded, cost: 'full' })
  if (u.kind === 'mech' && u.coreAvailable && u.frameId) {
    const act = (Lancer.frames.get(u.frameId)?.core_system.activation ?? 'Quick').toLowerCase()
    const near = hostiles.filter(h => (h.kind === 'mech' || h.kind === 'npc') && Math.max(Math.abs(h.pos.x - p.x), Math.abs(h.pos.y - p.y)) <= 10).length
    // Drake Fortress Protocol roots the mech: only worth it with a hostile already inside its own reach
    const rooted = u.frameId === 'mf_drake' && !hostiles.some(h => (h.kind === 'mech' || h.kind === 'npc') && Math.max(Math.abs(h.pos.x - p.x), Math.abs(h.pos.y - p.y)) <= weaponReachOf(b, u))
    // value from where the unit stands now (capped), not from the candidate tile: counting hostiles around the
    // destination rewarded diving into the enemy blob just to spend the CORE, whatever the CORE does
    const nearNow = Math.min(3, hostiles.filter(h => (h.kind === 'mech' || h.kind === 'npc') && Math.max(Math.abs(h.pos.x - u.pos.x), Math.abs(h.pos.y - u.pos.y)) <= 10).length)
    if (near && b.round >= 2 && !rooted) opts.push({ kind: 'core', value: 4 + nearNow, cost: act === 'protocol' ? 'protocol' : act === 'full' ? 'full' : act === 'free' ? 'free' : 'quick' })
  }
  return opts
}

function bestCombo(opts: Option[], quickSlots: number, fullOk: boolean): { actions: Option[]; value: number } {
  const free = opts.filter(o => o.cost === 'protocol' || o.cost === 'free').sort((a, b) => b.value - a.value)
  const prot = free.filter(o => o.cost === 'protocol').slice(0, 1)
  const freeVal = prot.reduce((a, o) => a + o.value, 0)
  const quick = opts.filter(o => o.cost === 'quick').sort((a, b) => b.value - a.value)
  let qa: Option[] = []
  const usedKeys = new Set<string>()
  for (const o of quick) {
    if (qa.length >= quickSlots) break
    const k = o.kind === 'custom' ? o.action.key : o.kind === 'skirmish' ? (o.weapon.tech ? 'tech' + o.weapon.uid : 'skirmish') : o.kind + ('target' in o ? (o as any).target?.id : '')
    if (usedKeys.has(k)) continue
    usedKeys.add(k)
    qa.push(o)
  }
  const qv = qa.reduce((a, o) => a + o.value, 0)
  const full = fullOk ? opts.filter(o => o.cost === 'full').sort((a, b) => b.value - a.value)[0] : undefined
  if (full && full.value > qv) return { actions: [...prot, full], value: full.value + freeVal }
  return { actions: [...prot, ...qa], value: qv + freeVal }
}

export function planFor(b: Battle, u: Unit): Plan {
  const quickBase = u.actionsLeft + (u.flags.bonusQuick ?? 0)
  const canBoost = !b.has(u, 'slowed') && !b.has(u, 'immobilized') && quickBase >= 1 && u.moveLeft > 0
  // one pathfinding pass covers both the plain move and the boosted move
  const all = b.reachable(u, u.moveLeft + (canBoost ? u.stats.speed : 0))
  const cands: { pos: Pos; boost: boolean }[] = []
  for (const v of all.values()) cands.push({ pos: v.pos, boost: v.cost > u.moveLeft })
  // prune candidates for speed: keep the most promising ones by position value
  const threats = threatsAgainst(b, u)
  stall = Math.max(stallRounds(b), unitIdleRounds(b, u))
  let scored = cands.map(c => ({ ...c, pv: positionValue(b, u, c.pos, threats) }))
  if (scored.length > 70) {
    scored.sort((a, b2) => b2.pv - a.pv)
    const keep = scored.slice(0, 50)
    // always keep positions close to hostiles (attack opportunities)
    const hostiles = b.alive().filter(h => b.hostile(u, h))
    const close = scored.filter(c => hostiles.some(h => Math.max(Math.abs(h.pos.x - c.pos.x), Math.abs(h.pos.y - c.pos.y)) <= 2)).slice(0, 25)
    scored = [...new Map([...keep, ...close].map(c => [key(c.pos) + c.boost, c])).values()]
  }
  let best: Plan = { dest: u.pos, boost: false, actions: [], value: -Infinity }
  for (const c of scored) {
    const slots = quickBase - (c.boost ? 1 : 0)
    const fullOk = !c.boost && u.actionsLeft >= 2
    const combo = bestCombo(optionsAt(b, u, c.pos), slots, fullOk)
    const v = combo.value + c.pv - (c.boost ? 0.3 : 0)
    if (v > best.value) best = { dest: c.pos, boost: c.boost, actions: combo.actions, value: v }
  }
  return best
}

function execute(b: Battle, u: Unit, o: Option) {
  switch (o.kind) {
    case 'skirmish': return b.skirmish(u, o.weapon, o.aim)
    case 'barrage': {
      // follow up with an Auxiliary on each mount fired, at the primary target (skipped if it can't reach)
      const auxes = b.auxFollowUps(u, [o.a.weapon, ...(o.b ? [o.b.weapon] : [])]).map(w => ({ weapon: w, aim: o.a.aim }))
      return b.barrage(u, o.a, o.b, auxes)
    }
    case 'custom':
      // generic "deploy once, early" options are tried once (a failed placement must not repeat every turn)
      if (o.action.name.startsWith('Deploy') && !o.action.aiTarget) u.flags[`ai_deployed_${o.action.key}`] = true
      return b.useCustom(u, o.action, o.target)
    case 'invade': return b.invade(u, o.target)
    case 'lockon': return b.lockOn(u, o.target)
    case 'stabilize': return b.stabilize(u, 'cool')
    case 'core': return b.activateCore(u)
  }
}

/** Take a complete turn for `u` (begin → act → end). */
export function runAiTurn(b: Battle, u: Unit) {
  // an AI-driven player unit (Auto, SEKHMET) answers its own side's questions with the defaults
  const prevSide = b.aiSide
  if (u.side === 'player') b.aiSide = 'player'
  try { b.command('aiTurn', [u], () => runAiTurnInner(b, u)) } finally { b.aiSide = prevSide }
}
function runAiTurnInner(b: Battle, u: Unit) {
  if (b.activeId !== u.id) b.beginTurn(u)
  try {
    if (!u.destroyed && b.has(u, 'shutdown') && !u.statuses.some(x => x.id === 'stunned') && u.actionsLeft >= 2) { b.bootUp(u); return }
    if (!u.destroyed && !b.has(u, 'stunned')) {
      if (b.has(u, 'prone') && b.canStandUp(u) === true) b.standUp(u)
      if (b.has(u, 'grappled') && u.statuses.find(s => s.id === 'grappled')?.data?.by !== u.id) { try { b.breakGrapple(u) } catch (e) { if (e instanceof PendingChoice) throw e } }
      if (u.flags.sekhmet) { sekhmetTurn(b, u); return }
      const plan = planFor(b, u)
      // protocols first
      for (const o of plan.actions.filter(o => o.cost === 'protocol')) safe(() => execute(b, u, o))
      if (plan.boost) safe(() => b.boost(u))
      if (plan.dest.x !== u.pos.x || plan.dest.y !== u.pos.y) safe(() => b.move(u, plan.dest, { mode: 'standard' }))
      // the plan was aimed from plan.dest: if the move failed or was cut short (a protocol Immobilized us, overwatch,
      // knockback), re-plan the actions from where the unit actually stands instead of firing blind
      const arrived = u.pos.x === plan.dest.x && u.pos.y === plan.dest.y
      const actions = arrived ? plan.actions.filter(o => o.cost !== 'protocol')
        : bestCombo(optionsAt(b, u, u.pos).filter(o => o.cost !== 'protocol'), u.actionsLeft + (u.flags.bonusQuick ?? 0), u.actionsLeft >= 2).actions.filter(o => o.cost !== 'protocol')
      for (const o of actions) {
        if (u.destroyed || b.winner) break
        safe(() => execute(b, u, o))
      }
      // second pass: spend any leftover quick action on something useful from the new position
      if (!u.destroyed && !b.winner && (u.actionsLeft > 0 || (u.flags.bonusQuick ?? 0) > 0)) {
        const extra = bestCombo(optionsAt(b, u, u.pos).filter(o => o.cost === 'quick'), u.actionsLeft + (u.flags.bonusQuick ?? 0), false)
        for (const o of extra.actions) if (o.value > 0.8) safe(() => execute(b, u, o))
      }
    }
  } finally {
    if (!u.destroyed && b.activeId === u.id && !b.winner) b.endTurn(u)
  }
}

/** Programming errors raised while the AI acts (rule rejections are expected and ignored). */
export const aiErrors: unknown[] = []

function safe(f: () => unknown) {
  try { f() } catch (e) {
    if (e instanceof PendingChoice) throw e
    // invalid in the new situation: skip; but keep genuine bugs visible
    if (e instanceof TypeError || e instanceof ReferenceError || e instanceof RangeError) { aiErrors.push(e); console.error(e) }
  }
}

/** Pick which unit on `side` should activate next. */
export function pickNextUnit(b: Battle, side: 'player' | 'enemy'): Unit | undefined {
  const chained = b.chainTurn ? b.unit(b.chainTurn) : undefined
  if (chained && chained.side === side && chained.activationsLeft > 0 && !chained.destroyed) return chained
  const ready = b.combatants(side).filter(u => u.activationsLeft > 0)
  if (ready.length <= 1) return ready[0]
  // prefer units that are already in contact, then artillery/support
  const order = (u: Unit) => {
    const hostiles = b.alive().filter(h => b.hostile(u, h))
    const d = Math.min(...hostiles.map(h => b.distance(u, h)))
    return d - (u.role === 'Controller' ? 2 : 0) - (u.role === 'Support' ? -1 : 0)
  }
  return ready.sort((a, c) => order(a) - order(c))[0]
}

/** Utility for tests / auto-battle: play until someone wins or `maxRounds` passes. */
export function autoBattle(b: Battle, maxRounds = 12) {
  let guard = 0
  while (!b.winner && b.round <= maxRounds && guard++ < 500) {
    const u = pickNextUnit(b, b.currentSide as 'player' | 'enemy')
    if (!u) break
    runAiTurn(b, u)
  }
}

export { hasTag }
