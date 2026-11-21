// Utility-based tactical AI. Evaluates reachable positions × available actions and executes the
// best plan through the normal Battle API, so the AI obeys exactly the same rules as players.
import type { Battle } from '../rules/battle'
import { blastTiles, burstTiles, key, unitsOnTiles } from '../rules/grid'
import type { Effect, Pos, Unit, Weapon } from '../rules/types'
import type { CustomAction } from '../rules/effects/registry'
import { averageDice } from '../rules/rng'
import { hasTag, tagVal } from '../rules/stats'

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
  | { kind: 'reload'; weapon: Weapon; value: number; cost: 'quick' }
  | { kind: 'stabilize'; value: number; cost: 'full' }

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
  if (t.isGrunt) v = Math.min(v, 3 * p.chance + 1)
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
        const v = f ? effectValue(b, u, t, effects) * (f.save ? 0.6 : 1) : (a.aiScore?.(b, u, t) ?? 0) * 0.6
        if (!best || v > best.value) best = { value: v, target: t }
      }
      return best ? { ...best, value: best.value - heatPenalty } : null
    }
    if (a.target === 'tile' && a.area) {
      let best: { value: number; target?: Pos } | null = null
      for (const h of hostiles) {
        const aim = h.pos
        if (a.range != null && b.distance(u, h) > a.range + 1) continue
        const tiles = blastTiles(b.map, aim, a.area.size)
        let v = 0
        for (const t of unitsOnTiles(b.alive(), tiles)) if (t !== u) v += b.hostile(u, t) ? (f ? effectValue(b, u, t, effects) : (a.aiScore?.(b, u, t) ?? 3) * 0.6) : -4
        if (a.name.startsWith('Deploy')) v = 0.5
        if (!best || v > best.value) best = { value: v, target: aim }
      }
      return best ? { ...best, value: best.value - heatPenalty } : null
    }
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

function positionValue(b: Battle, u: Unit, p: Pos): number {
  const hostiles = b.alive().filter(h => b.hostile(u, h) && (h.kind === 'mech' || h.kind === 'npc'))
  if (!hostiles.length) return 0
  const saved = u.pos
  u.pos = p
  try {
    let danger = 0
    let nearest = Infinity
    for (const h of hostiles) {
      const d = b.distance(u, h)
      nearest = Math.min(nearest, d)
      const reach = Math.max(1, ...h.weapons.filter(w => !w.destroyed).map(w => b.weaponReach(h, w)))
      if (d > reach + h.stats.speed) continue
      const cover = b.cover(h, u)
      const best = Math.max(0, ...h.weapons.filter(w => !w.destroyed && !w.tech).map(w => b.profile(w).damage.reduce((a, d) => a + averageDice(d.val), 0)))
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
    if (u.kind === 'mech') v -= Math.max(0, nearest - 8) * 0.3
    // sitrep objectives
    const zone = b.sitrep.zone
    if (zone && (b.sitrep.id === 'control' || (b.sitrep.id === 'extraction' && u.side === 'player'))) {
      const inZone = zone.some(z => z.x === p.x && z.y === p.y)
      const dz = Math.min(...zone.map(z => Math.max(Math.abs(z.x - p.x), Math.abs(z.y - p.y))))
      v += inZone ? 4 : -dz * 0.35
    }
    if (b.isEngaged(u, p) && u.weapons.every(w => !b.isMelee(w))) v -= 1.5
    return v
  } finally { u.pos = saved }
}

function optionsAt(b: Battle, u: Unit, p: Pos): Option[] {
  const opts: Option[] = []
  const hostiles = b.alive().filter(t => b.hostile(u, t))
  for (const w of u.weapons) {
    if (b.weaponUsable(u, w) !== true) {
      if (!w.loaded && !w.destroyed) opts.push({ kind: 'reload', weapon: w, value: 1, cost: 'quick' })
      continue
    }
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
    if (w.size === 'Superheavy' || w.activation === 'full') opts.push({ kind: 'barrage', a: { weapon: w, aim: best.aim }, value: best.value, cost: 'full' })
    else opts.push({ kind: 'skirmish', weapon: w, aim: best.aim, value: best.value, cost: 'quick' })
  }
  // barrage: best two skirmish-capable weapons
  const sk = opts.filter((o): o is Extract<Option, { kind: 'skirmish' }> => o.kind === 'skirmish' && !o.weapon.tech).sort((a, b) => b.value - a.value)
  if (sk.length >= 2) opts.push({ kind: 'barrage', a: { weapon: sk[0].weapon, aim: sk[0].aim }, b: { weapon: sk[1].weapon, aim: sk[1].aim }, value: sk[0].value + sk[1].value, cost: 'full' })
  for (const a of b.customActions(u)) {
    const c = costOf(a)
    if (!c) continue
    if (a.text && a.name.startsWith('Deploy') && !u.flags[`ai_deployed_${a.key}`]) {
      // deploy cover/drones once, early
      const tgt = a.target === 'tile' ? { x: Math.max(0, Math.min(b.map.w - 1, p.x + 1)), y: p.y } : undefined
      opts.push({ kind: 'custom', action: a, target: tgt, value: b.round <= 2 ? 1.5 : 0.3, cost: c })
      continue
    }
    const r = customValue(b, u, a, p)
    if (r && r.value > 0.5) opts.push({ kind: 'custom', action: a, target: r.target, value: r.value, cost: c })
  }
  if (u.kind === 'mech' && b.canQuickTech(u) === true && !b.has(u, 'jammed')) {
    for (const t of hostiles) {
      if (t.kind !== 'mech' && t.kind !== 'npc') continue
      const saved = u.pos
      u.pos = p
      try {
        if (b.techTargetValid(u, t) !== true) continue
        const chance = Math.max(0.1, Math.min(0.95, (21 - (t.stats.edef - u.stats.techAttack)) / 20))
        opts.push({ kind: 'invade', target: t, value: chance * (2 * (t.stats.heatcap ? 1 : 0) + 3), cost: 'quick' })
        if (!b.has(t, 'lockon')) opts.push({ kind: 'lockon', target: t, value: 1.2, cost: 'quick' })
      } finally { u.pos = saved }
    }
  }
  if (u.stats.heatcap > 0 && (b.has(u, 'exposed') || u.heat >= u.stats.heatcap - 1)) opts.push({ kind: 'stabilize', value: 3 + (b.has(u, 'exposed') ? 4 : 0) + u.heat * 0.5, cost: 'full' })
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
    const k = o.kind === 'custom' ? o.action.key : o.kind === 'skirmish' ? 'sk' + o.weapon.mountIndex : o.kind + ('target' in o ? (o as any).target?.id : '')
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
  const near = b.reachable(u, u.moveLeft)
  const far = canBoost ? b.reachable(u, u.moveLeft + u.stats.speed) : new Map()
  const cands: { pos: Pos; boost: boolean }[] = []
  for (const v of near.values()) cands.push({ pos: v.pos, boost: false })
  for (const [k, v] of far) if (!near.has(k)) cands.push({ pos: v.pos, boost: true })
  // prune candidates for speed: keep the most promising ones by position value
  let scored = cands.map(c => ({ ...c, pv: positionValue(b, u, c.pos) }))
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
    case 'barrage': return b.barrage(u, o.a, o.b)
    case 'custom': return b.useCustom(u, o.action, o.target)
    case 'invade': return b.invade(u, o.target)
    case 'lockon': return b.lockOn(u, o.target)
    case 'reload': return b.reload(u, o.weapon)
    case 'stabilize': return b.stabilize(u, 'cool')
  }
}

/** Take a complete turn for `u` (begin → act → end). */
export function runAiTurn(b: Battle, u: Unit) {
  if (b.activeId !== u.id) b.beginTurn(u)
  try {
    if (!u.destroyed && !b.has(u, 'stunned')) {
      if (b.has(u, 'shutdown')) { b.bootUp(u); return }
      if (b.has(u, 'prone') && !b.has(u, 'immobilized')) b.standUp(u)
      if (b.has(u, 'grappled') && u.statuses.find(s => s.id === 'grappled')?.data?.by !== u.id) { try { b.breakGrapple(u) } catch {} }
      const plan = planFor(b, u)
      // protocols first
      for (const o of plan.actions.filter(o => o.cost === 'protocol')) safe(() => execute(b, u, o))
      if (plan.boost) safe(() => b.boost(u))
      if (plan.dest.x !== u.pos.x || plan.dest.y !== u.pos.y) safe(() => b.move(u, plan.dest, { mode: 'standard' }))
      for (const o of plan.actions.filter(o => o.cost !== 'protocol')) {
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

function safe(f: () => unknown) {
  try { f() } catch { /* invalid in the new situation: skip */ }
}

/** Pick which unit on `side` should activate next. */
export function pickNextUnit(b: Battle, side: 'player' | 'enemy'): Unit | undefined {
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
