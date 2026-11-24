// Drones and deployables: deploy / recall / redeploy / move, plus the fields and auras they create.
// Deployed drones and deployables are units (kind 'drone' | 'deployable', ownerId = the deployer); their
// effects are implemented here on the *owner's* system script, finding its drones with `mine()`.
import type { Battle } from '../../battle'
import { blastTiles, burstTiles, chebyshev, distanceToTile, footprint, hasLineOfSightToTile, tileAt } from '../../grid'
import type { Pos, StatusId, SystemInst, Unit } from '../../types'
import { Lancer } from '../../../data/lancer'
import { deployableUnit } from '../generic'
import { registerScripts, type CustomAction, type DamageCtx, type FieldOverlay, type ItemScript } from '../registry'

// ------------------------------------------------------------------ framework
const sys = (u: Unit, id: string) => u.systems.find(s => s.dataId === id && !s.destroyed)
const chars = (b: Battle) => b.alive().filter(o => o.kind === 'mech' || o.kind === 'npc')
const hostiles = (b: Battle, u: Unit) => chars(b).filter(o => b.hostile(u, o))
const CONDITIONS: StatusId[] = ['impaired', 'slowed', 'immobilized', 'jammed', 'shredded', 'lockon', 'stunned']

/** This unit's deployed drones/deployables with the given name. */
export function mine(b: Battle, owner: Unit, name: string): Unit[] {
  return b.alive().filter(d => d.ownerId === owner.id && d.flags.dataName === name)
}

function nearestHostile(b: Battle, u: Unit, from: Pos = u.pos): Unit | undefined {
  let best: Unit | undefined
  for (const h of hostiles(b, u)) if (!best || chebyshev(h.pos, from) < chebyshev(best.pos, from)) best = h
  return best
}

/** Is `at` a valid footprint for a deployable of this size (on the map, not overlapping solid units)? */
function freeFor(b: Battle, size: number, at: Pos, ignore?: Unit): boolean {
  const fp = footprint({ pos: at, stats: { size } })
  return fp.every(p => tileAt(b.map, p) && !b.alive().some(o => o !== ignore && !o.flags.flat && footprint(o).some(q => q.x === p.x && q.y === p.y)))
}

type Placement = 'adjacent' | 'sensors' | number
interface DeploySpec {
  /** system id providing the deployable (also its charges) */
  sysId: string
  /** deployable data index in the system (default 0), or an explicit spec */
  dep?: number | { name: string; type: 'Drone' | 'Deployable'; size?: number; hp?: number; evasion?: number; edef?: number; armor?: number }
  name?: string
  activation?: CustomAction['activation']
  placement: Placement
  los?: boolean
  /** instances allowed at once (default 1); deploying again past the cap recycles the oldest (PCP) when `replaceOld` */
  instances?: number
  replaceOld?: boolean
  /** charges come from the system's Limited uses */
  limited?: boolean
  setup?: (b: Battle, self: Unit, d: Unit, at: Pos) => void
  text?: string
  aiTarget?: CustomAction['aiTarget']
  aiScore?: CustomAction['aiScore']
}

function depData(spec: DeploySpec) {
  if (spec.dep && typeof spec.dep === 'object') return spec.dep as any
  return Lancer.systems.get(spec.sysId)!.deployables![(spec.dep as number) ?? 0]
}

function placementRange(self: Unit, p: Placement) { return p === 'adjacent' ? 1 : p === 'sensors' ? self.stats.sensors : p }

function checkPlacement(b: Battle, self: Unit, spec: DeploySpec, size: number, at: Pos, ignore?: Unit): true | string {
  if (!tileAt(b.map, at)) return 'Off the map'
  if (spec.placement === 'adjacent') {
    const fp = footprint({ pos: at, stats: { size } })
    if (!fp.some(p => footprint(self).some(q => chebyshev(p, q) === 1))) return 'Must be adjacent'
  } else if (distanceToTile(b.map, self, at) > placementRange(self, spec.placement)) return 'Out of range'
  if (spec.los && !hasLineOfSightToTile(b.effectiveMap(), self, at)) return 'No line of sight'
  if (!freeFor(b, size, at, ignore)) return 'Space occupied'
  return true
}

/** Spawn a deployable for `self` at `at` (validated). */
export function place(b: Battle, self: Unit, spec: DeploySpec, at: Pos): Unit {
  const data = depData(spec)
  const d = deployableUnit(self, data, at)
  if (data.size && data.size > 3) d.stats.size = data.size
  const ok = checkPlacement(b, self, spec, d.stats.size, at)
  if (ok !== true) throw new Error(ok)
  if (Lancer.systems.get(spec.sysId)?.tags?.some(t => t.id === 'tg_resistall')) d.resist = ['all']
  spec.setup?.(b, self, d, at)
  b.spawn(d)
  b.say(`${self.name} deploys ${d.name}.`)
  return d
}

/** "Deploy X" (hidden once the cap is reached unless `replaceOld`). */
function deployAction(b: Battle, self: Unit, spec: DeploySpec): CustomAction | null {
  const data = depData(spec)
  const s = sys(self, spec.sysId)
  const live = mine(b, self, data.name)
  if (!spec.replaceOld && live.length >= (spec.instances ?? 1)) return null
  return {
    key: `deploy:${spec.sysId}:${data.name}`,
    name: spec.name ?? `Deploy ${data.name}`,
    activation: spec.activation ?? 'quick',
    text: spec.text ?? '',
    target: 'tile',
    range: placementRange(self, spec.placement),
    sourceUid: s?.uid,
    usable: () => (spec.limited && s?.usesLeft === 0 ? 'No charges left' : true),
    run: (bt, me, t) => {
      const at = t && 'x' in t ? t : (t as Unit)?.pos ?? me.pos
      const d = place(bt, me, spec, at)
      if (spec.replaceOld) for (const old of mine(bt, me, data.name)) if (old !== d && mine(bt, me, data.name).length > (spec.instances ?? 1)) bt.removeUnit(old, 'disintegrates')
      if (spec.limited && s && s.usesLeft != null) s.usesLeft--
    },
    aiTarget: spec.aiTarget,
    aiScore: spec.aiScore ?? (() => 2),
  }
}

function recallAction(self: Unit, d: Unit, label = 'Recall'): CustomAction {
  return {
    key: `recall:${d.id}`, name: `${label} ${d.name}`, activation: 'quick', target: 'none', text: `${label} the ${d.name}.`,
    usable: () => true,
    run: bt => bt.removeUnit(d, 'is recalled'),
  }
}

function redeployAction(b: Battle, self: Unit, d: Unit, spec: DeploySpec, label = 'Redeploy'): CustomAction {
  return {
    key: `redeploy:${d.id}`, name: `${label} ${d.name}`, activation: spec.activation ?? 'quick', target: 'tile', range: placementRange(self, spec.placement),
    text: `Move the ${d.name} to a new space.`,
    usable: () => true,
    run: (bt, me, t) => {
      const at = t && 'x' in t ? t : (t as Unit).pos
      const ok = checkPlacement(bt, me, spec, d.stats.size, at, d)
      if (ok !== true) throw new Error(ok)
      const from = d.pos
      d.pos = at
      spec.setup?.(bt, me, d, at)
      bt.invalidateTerrain()
      bt.emit({ type: 'move', unitId: d.id, path: [from, at] })
    },
    aiTarget: (bt, me) => {
      const t = spec.aiTarget?.(bt, me)
      if (!t || !('x' in t)) return null
      const h = nearestHostile(bt, me, d.pos)
      // only worth it if the drone has drifted out of the fight
      return h && chebyshev(h.pos, d.pos) > 4 && chebyshev(h.pos, t) < chebyshev(h.pos, d.pos) - 2 ? t : null
    },
    aiScore: () => 1.2,
  }
}

/** Free tile (for a `size` footprint) within `range` of `self`, as close as possible to `toward`. */
function tileToward(b: Battle, self: Unit, toward: Pos, spec: DeploySpec, size = 0.5, minFromTarget = 0): Pos | null {
  const r = placementRange(self, spec.placement)
  let best: Pos | null = null, bestD = Infinity
  for (let dy = -r - 1; dy <= r + 1; dy++) for (let dx = -r - 1; dx <= r + 1; dx++) {
    const p = { x: self.pos.x + dx, y: self.pos.y + dy }
    if (checkPlacement(b, self, spec, size, p) !== true) continue
    const d = chebyshev(p, toward)
    if (d < minFromTarget) continue
    if (d < bestD) { bestD = d; best = p }
  }
  return best
}
const aimAtEnemies = (spec: DeploySpec, size = 0.5, keepOff = 0): CustomAction['aiTarget'] => (b, self) => {
  const h = nearestHostile(b, self)
  return h ? tileToward(b, self, h.pos, spec, size, keepOff) : null
}
const aimNearSelf = (spec: DeploySpec, size = 0.5): CustomAction['aiTarget'] => (b, self) => {
  const h = nearestHostile(b, self)
  return tileToward(b, self, h ? { x: Math.round((self.pos.x * 3 + h.pos.x) / 4), y: Math.round((self.pos.y * 3 + h.pos.y) / 4) } : self.pos, spec, size)
}
const earlyWhenEngaged = (range = 14) => (b: Battle, self: Unit) => (hostiles(b, self).some(h => b.distance(self, h) <= range) ? 2.5 : 0)

/** Standard drone kit: deploy (if none out), then recall + redeploy for each deployed one. */
function droneKit(b: Battle, self: Unit, spec: DeploySpec, opts: { recall?: boolean; redeploy?: boolean } = {}): CustomAction[] {
  const out: CustomAction[] = []
  const dep = deployAction(b, self, spec)
  if (dep) out.push(dep)
  for (const d of mine(b, self, depData(spec).name)) {
    if (opts.recall !== false) out.push(recallAction(self, d))
    if (opts.redeploy !== false) out.push(redeployAction(b, self, d, spec))
  }
  return out
}

/** Once per round per (unit, key). */
const oncePerRound = (u: Unit, key: string) => { const k = `round:${key}`; if (u.flags[k]) return false; u.flags[k] = true; return true }

/** a save that avoids Prone or Knockback (Stable Structure gives +1 Accuracy on those) */
function saveVs(b: Battle, u: Unit, stat: 'hull' | 'agi' | 'sys' | 'eng', src: Unit, avoid: 'prone' | 'knockback'): boolean {
  u.flags.saveAvoid = avoid
  try { return b.save(u, stat, src.stats.save, 0, src) } finally { delete u.flags.saveAvoid }
}

/** Run `fx` for characters that start their turn in, or first enter in a round, a field (`inField`). */
function inDenial(b: Battle, self: Unit, u: Unit): boolean {
  const d = mine(b, self, 'Assassin Drone').find(x => x.flags.denial)
  return !!d && b.hostile(self, u) && (u.kind === 'mech' || u.kind === 'npc') && !u.destroyed && footprint(u).some(p => chebyshev(p, d.flags.denial) <= 2)
}
function areaDenial(b: Battle, self: Unit, u: Unit) {
  const d = mine(b, self, 'Assassin Drone').find(x => x.flags.denial)
  if (!d || u.destroyed || b.canSpend(self, 'reaction') !== true) return
  if (!b.offerReaction(self, 'area_denial', 'Area Denial?', `${u.name} is moving in the assassin drone's area. Spend a reaction to attack it (3 kinetic)?`)) return
  b.spend(self, 'reaction')
  b.say(`${self.name}: Area Denial!`, 'attack')
  const ctx = b.newAttackCtx(d, u, { mode: 'free', attackBonus: self.stats.grit, ranged: true })
  b.rollToHit(ctx)
  if (ctx.hit) b.applyDamage(u, [{ type: 'Kinetic', amount: 3 }], { source: self })
}
const DIR8: [number, number][] = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]]
const DIR8_NAMES = ['North', 'North-east', 'East', 'South-east', 'South', 'South-west', 'West', 'North-west']
/** Repulse: push 3 in a direction the plate owner picks; Prone on hitting an obstruction */
function pcpRepulse(b: Battle, self: Unit, plate: Unit, u: Unit) {
  const away = [Math.sign(u.pos.x - plate.pos.x), Math.sign(u.pos.y - plate.pos.y)]
  const def = Math.max(0, DIR8.findIndex(d => d[0] === away[0] && d[1] === away[1]))
  const i = b.choose({ kind: 'pcp_repulse', unit: self, title: `Repulse ${u.name}: push direction`, options: DIR8_NAMES.map(n => ({ label: n })), defaultIndex: def })
  const d = DIR8[i]
  const from = { ...u.pos }
  b.forceMove(u, { x: u.pos.x - d[0] * 20, y: u.pos.y - d[1] * 20 }, 3, 1)
  if (!u.destroyed && Math.max(Math.abs(u.pos.x - from.x), Math.abs(u.pos.y - from.y)) < 3 && !u.flying) b.addStatus(u, 'prone', 'until_cleared', self)
}
/** Repulse, allies: may fly 3 spaces in any direction (free) */
function pcpFly(b: Battle, u: Unit) {
  if (u.destroyed || b.canMove(u, 'free') !== true) return
  const opts = [...DIR8_NAMES.map(n => ({ label: `Fly 3 ${n}` })), { label: 'Stay' }]
  const i = b.choose({ kind: 'pcp_fly', unit: u, title: 'Command plate: fly 3?', options: opts, defaultIndex: 8 })
  if (i >= 8) return
  const d = DIR8[i]
  const path: Pos[] = [{ ...u.pos }]
  for (let k = 1; k <= 3; k++) {
    const p = { x: u.pos.x + d[0] * k, y: u.pos.y + d[1] * k }
    if (!freeFor(b, u.stats.size, p, u)) break
    path.push(p)
  }
  if (path.length < 2) return
  const was = u.flying
  u.flying = true
  try { b.moveAlong(u, path) } finally { u.flying = was }
}

function fieldTriggers(key: string, inField: (b: Battle, self: Unit, u: Unit) => boolean, fx: (b: Battle, self: Unit, u: Unit) => void): Pick<ItemScript, 'onAnyTurnStart' | 'onMove'> {
  return {
    onAnyTurnStart(b, self, u) { if ((u.kind === 'mech' || u.kind === 'npc') && !u.destroyed && inField(b, self, u) && oncePerRound(u, `${key}:${self.id}`)) fx(b, self, u) },
    onMove(b, self, mover) { if ((mover.kind === 'mech' || mover.kind === 'npc') && !mover.destroyed && inField(b, self, mover) && oncePerRound(mover, `${key}:${self.id}`)) fx(b, self, mover) },
  }
}

/** Is `between` (a unit or tile) roughly between attacker and target, next to the target? */
function shields(b: Battle, attacker: Unit, target: Unit, at: Pos): boolean {
  return footprint(target).some(p => chebyshev(p, at) <= 1) && chebyshev(attacker.pos, at) < chebyshev(attacker.pos, target.pos)
}

// ------------------------------------------------------------------ system specs
const HIVE: DeploySpec = { sysId: 'ms_hive_drone', placement: 'sensors', los: true }
HIVE.aiTarget = aimNearSelf(HIVE)
const SENTINEL: DeploySpec = { sysId: 'ms_sentinel_drone', placement: 'sensors', los: true }
SENTINEL.aiTarget = aimAtEnemies(SENTINEL, 0.5, 2)
const TEMPEST: DeploySpec = { sysId: 'ms_tempest_drone', placement: 'sensors', los: true }
TEMPEST.aiTarget = aimAtEnemies(TEMPEST, 0.5, 1)
const LOTUS: DeploySpec = { sysId: 'ms_lotus_projector', placement: 'sensors', los: true, setup: (_b, _s, d) => { d.flags.revealRadius = 2 } }
LOTUS.aiTarget = aimAtEnemies(LOTUS, 0.5, 1)
const ICEOUT: DeploySpec = { sysId: 'ms_iceout_drone', placement: 'sensors', los: true, limited: true, setup: (_b, _s, d) => { d.flags.iceoutRadius = 1 } }
ICEOUT.aiTarget = (b, self) => tileToward(b, self, self.pos, ICEOUT)
const RESTOCK: DeploySpec = { sysId: 'ms_restock_drone', placement: 'adjacent', limited: true, instances: 2 }
RESTOCK.aiTarget = (b, self) => tileToward(b, self, self.pos, RESTOCK)
const AUTOLOADER: DeploySpec = { sysId: 'ms_autoloader_drone', placement: 'adjacent', limited: true }
AUTOLOADER.aiTarget = (b, self) => tileToward(b, self, self.pos, AUTOLOADER)
const AEGIS: DeploySpec = { sysId: 'ms_aegis_shield_generator', placement: 'adjacent', limited: true, setup: (_b, _s, d) => { d.flags.aegisDice = 3 } }
AEGIS.aiTarget = (b, self) => tileToward(b, self, self.pos, AEGIS, 1)
const BUNKER: DeploySpec = {
  sysId: 'ms_portable_bunker', placement: 'adjacent', limited: true,
  setup: (b, _s, d) => { d.flags.flat = true; d.flags.isCover = false; d.flags.unfoldRound = b.round + 1 },
}
BUNKER.aiTarget = (b, self) => {
  // a 4x4 area next to us that we (and adjacent allies) can step into
  for (const [dx, dy] of [[1, -1], [-4, -1], [-1, 1], [-1, -4], [1, 1], [-4, -4], [1, -4], [-4, 1]]) {
    const p = { x: self.pos.x + dx, y: self.pos.y + dy }
    if (checkPlacement(b, self, BUNKER, 4, p) === true) return p
  }
  return null
}
const PCP = (setting: 'repulse' | 'attract'): DeploySpec => {
  const spec: DeploySpec = {
    sysId: 'ms_perimeter_command_plate', placement: 5, replaceOld: true, name: `Print Perimeter Command Plate (${setting === 'repulse' ? 'Repulse' : 'Attract'})`,
    setup: (_b, _s, d) => { d.flags.flat = true; d.flags.isCover = false; d.flags.pcp = setting },
    text: setting === 'repulse' ? 'Hostiles moving onto it: Hull save or pushed 3.' : 'Characters moving onto it: Hull save or Immobilized.',
  }
  spec.aiTarget = aimAtEnemies(spec, 2, 1)
  spec.aiScore = (b, self) => (setting === 'attract' && !mine(b, self, 'Perimeter Command Plate').length ? earlyWhenEngaged(10)(b, self) : 0)
  return spec
}
const ASSASSIN: DeploySpec = { sysId: 'ms_assassin_drone', placement: 'adjacent' }

// ------------------------------------------------------------------ scripts
const reduceWithAegis = (b: Battle, owner: Unit, target: Unit, d: DamageCtx) => {
  if (d.kind !== 'hp' || d.amount <= 0 || b.hostile(owner, target)) return
  const gen = mine(b, owner, 'Aegis Shield Generator').find(g => g.flags.aegisDice > 0 && b.distance(g, target) <= 1)
  if (!gen || d.amount < 3 || b.canSpend(owner, 'reaction', 'aegis_shield') !== true) return
  b.spend(owner, 'reaction', 'aegis_shield')
  gen.flags.aegisDice--
  const r = b.rng.d(6)
  d.amount = Math.max(0, d.amount - r)
  b.say(`  ${owner.name}'s shield generator absorbs ${r} (${gen.flags.aegisDice} dice left).`)
}

const scripts: ItemScript[] = [
  {
    id: 'ms_restock_drone', note: 'Restock Drone: adjacent allies activate it (quick) to clear 1d6 heat and a condition and reload a Loading weapon',
    actions: (b, u) => [...droneKit(b, u, { ...RESTOCK, aiScore: (bt, me) => (me.heat >= me.stats.heatcap - 2 ? 3 : 0) }, { recall: false, redeploy: false }), ...restockUse(b, u, u)],
    onTurnEnd(b, self) { for (const d of mine(b, self, 'Restock Drone')) d.flags.primed = true },
    grantActions: (b, self, other) => (b.hostile(self, other) ? [] : restockUse(b, self, other)),
  },
  {
    id: 'ms_iceout_drone', note: 'ICEOUT Drone: Burst 1 field; characters inside are immune to tech actions and cannot take them; conditions and effects that tech actions already gave them are suppressed while they are inside',
    actions: (b, u) => {
      const out = droneKit(b, u, { ...ICEOUT, aiScore: (bt, me) => (hostiles(bt, me).some(h => h.weapons.some(w => w.tech) || h.kind === 'mech') && earlyWhenEngaged(12)(bt, me) ? 1.5 : 0) }, { recall: false, redeploy: false })
      for (const d of mine(b, u, 'ICEOUT Drone')) out.push({ ...redeployAction(b, u, d, ICEOUT, 'Move'), key: `move:${d.id}` })
      return out.map(a => ({ ...a, run: (bt: Battle, me: Unit, t?: Unit | Pos) => { a.run(bt, me, t); iceoutSync(bt) } }))
    },
    onMove: b => iceoutSync(b),
    onTurnStart: b => iceoutSync(b),
    onAnyTurnStart: b => iceoutSync(b),
    onTurnEnd: b => iceoutSync(b),
    onAnyTurnEnd: b => iceoutSync(b),
    onStatusAdded: b => iceoutSync(b),
    onAnyStatusAdded: b => iceoutSync(b),
    onDestroyed: b => iceoutSync(b),
  },
  {
    id: 'ms_hive_drone',
    fields: (b, u) => mine(b, u, 'Hive Drone').map(d => ({ tiles: burstTiles(b.map, d, 2), effect: 'protect' as const, label: `${u.name}'s hive swarm: allies get soft cover; hostiles take 1 AP kinetic` })), note: 'Hive Drone: Burst 2 greywash swarm; allies inside gain soft cover; hostiles starting or entering take 1 AP kinetic',
    actions: (b, u) => droneKit(b, u, { ...HIVE, aiScore: earlyWhenEngaged() }),
    adjustCover(b, self, _attacker, target, c) {
      if (c !== 'none' || b.hostile(self, target)) return c
      return mine(b, self, 'Hive Drone').some(d => d === target || b.distance(d, target) <= 2) ? 'soft' : c
    },
    ...fieldTriggers('hive', (b, self, u) => b.hostile(self, u) && mine(b, self, 'Hive Drone').some(d => b.distance(d, u) <= 2), (b, self, u) => {
      if (!oncePerRound(u, 'hive_any')) return // multiple hive drones don't stack
      b.applyDamage(u, [{ type: 'Kinetic', amount: 1 }], { source: self, ap: true })
    }),
  },
  {
    id: 'ms_sentinel_drone',
    fields: (b, u) => mine(b, u, 'Sentinel Drone').map(d => ({ tiles: burstTiles(b.map, d, 2), effect: 'harm' as const, label: `${u.name}'s sentinel perimeter: hostiles take 3 kinetic before attacking` })), note: 'Sentinel Drone: hostiles within its Burst 2 take 3 kinetic before making any attack',
    actions: (b, u) => droneKit(b, u, { ...SENTINEL, aiScore: earlyWhenEngaged() }),
    beforeAnyAttack(b, self, ctx) {
      const a = ctx.attacker
      if (a.destroyed || !b.hostile(self, a) || !mine(b, self, 'Sentinel Drone').some(d => b.distance(d, a) <= 2)) return
      // once per attack (all targets of one weapon attack share b.lastAim; each tech attack is its own)
      if (b.previewing) return
      const k = ctx.weapon && b.lastAim ? b.lastAim : ctx
      if (sentinelSeen.get(a) === k) return
      sentinelSeen.set(a, k)
      b.say(`  ${self.name}'s sentinel drone fires on ${a.name}.`)
      b.applyDamage(a, [{ type: 'Kinetic', amount: 3 }], { source: self })
    },
  },
  {
    id: 'ms_tempest_drone',
    fields: (b, u) => mine(b, u, 'Tempest Drone').map(d => ({ tiles: burstTiles(b.map, d, 1), effect: 'harm' as const, label: `${u.name}'s tempest drone: Hull save or 4 energy and knocked back 3` })), note: 'Tempest Drone: characters starting or moving adjacent: Hull save or 4 energy and knocked back 3',
    actions: (b, u) => droneKit(b, u, { ...TEMPEST, aiScore: earlyWhenEngaged() }),
    ...fieldTriggers('tempest', (b, self, u) => mine(b, self, 'Tempest Drone').some(d => b.distance(d, u) <= 1), (b, self, u) => {
      const d = mine(b, self, 'Tempest Drone').find(x => b.distance(x, u) <= 1)!
      if (saveVs(b, u, 'hull', self, 'knockback')) return
      b.applyDamage(u, [{ type: 'Energy', amount: 4 }], { source: self })
      if (!u.destroyed) b.forceMove(u, d, 3, 1)
    }),
  },
  {
    id: 'ms_assassin_drone',
    fields: (b, u) => mine(b, u, 'Assassin Drone').filter(d => d.flags.denial).map(d => ({ tiles: blastTiles(b.map, d.flags.denial, 2), effect: 'harm' as const, label: `${u.name}'s Area Denial zone` })), note: 'Assassin Drone: deploy adjacent and target a Blast 2 area within line of sight and Sensors; Area Denial (reaction, any number of times a round): when a hostile starts moving in the area or enters it, the drone attacks it (your Grit to hit, 3 kinetic)',
    actions: (b, u) => {
      const out: CustomAction[] = []
      const live = mine(b, u, 'Assassin Drone')
      const deploy = (label: string, replacing?: Unit): CustomAction => ({
        key: `assassin:${label}`, name: `${label} Assassin Drone`, activation: 'quick', target: 'tile', range: u.stats.sensors, area: { shape: 'blast', size: 2 },
        text: 'Deploy the drone next to you and target a Blast 2 area within line of sight and Sensors.',
        usable: () => true,
        run: (bt, me, t) => {
          const area = t && 'x' in t ? t : (t as Unit).pos
          if (distanceToTile(bt.map, me, area) > me.stats.sensors || !hasLineOfSightToTile(bt.effectiveMap(), me, area)) throw new Error('Area must be in line of sight and Sensors')
          if (replacing) bt.removeUnit(replacing, 'is redeployed')
          const spot = tileToward(bt, me, area, ASSASSIN)
          if (!spot) throw new Error('No free adjacent space')
          const d = place(bt, me, ASSASSIN, spot)
          d.flags.denial = area
        },
        aiTarget: (bt, me) => nearestHostile(bt, me)?.pos ?? null,
        aiScore: (bt, me) => (replacing ? 0 : earlyWhenEngaged(me.stats.sensors)(bt, me)),
      })
      if (!live.length) out.push(deploy('Deploy'))
      for (const d of live) out.push(deploy('Redeploy', d), recallAction(u, d))
      return out
    },
    onAnyMovementAction(b, self, mover) { if (inDenial(b, self, mover)) areaDenial(b, self, mover) },
    onMove(b, self, mover, path) {
      const d = mine(b, self, 'Assassin Drone').find(x => x.flags.denial)
      if (!d || !b.hostile(self, mover) || (mover.kind !== 'mech' && mover.kind !== 'npc') || mover.destroyed) return
      const area = blastTiles(b.map, d.flags.denial, 2)
      const inA = (p: Pos) => footprint({ pos: p, stats: mover.stats }).some(q => area.some(t => t.x === q.x && t.y === q.y))
      if (path.some((p, i) => i > 0 && inA(p) && !inA(path[i - 1]))) areaDenial(b, self, mover)
    },
  },
  {
    id: 'ms_autoloader_drone', note: 'Autoloader Drone: 1/round, a character adjacent to it may reload a Loading weapon (quick)',
    actions: (b, u) => [...droneKit(b, u, { ...AUTOLOADER, aiScore: (bt, me) => (me.weapons.some(w => !w.loaded) ? 2 : 0) }, { recall: false, redeploy: false }), ...autoload(b, u, u)],
    grantActions: (b, self, other) => (b.hostile(self, other) ? [] : autoload(b, self, other)),
  },
  {
    id: 'ms_lotus_projector', note: "Lotus Projector: Burst 2 field; hostiles can't Hide or benefit from Invisible in it, and lose Hidden when ending their turn there",
    actions: (b, u) => droneKit(b, u, { ...LOTUS, aiScore: (bt, me) => (hostiles(bt, me).some(h => bt.has(h, 'invisible') || bt.has(h, 'hidden')) ? 3 : earlyWhenEngaged()(bt, me) * 0.4) }),
  },
  {
    id: 'ms_perimeter_command_plate',
    fields: (b, u) => mine(b, u, 'Perimeter Command Plate').map(d => ({ tiles: footprint(d), effect: 'control' as const, label: `${u.name}'s command plate (${d.flags.pcp === 'repulse' ? 'Repulse: hostiles pushed 3' : 'Attract: Immobilized'}, Hull save)` })), note: 'Perimeter Command Plate: flat 2x2 plate within 5 (a new one replaces it); it triggers the first time a character enters it in a round or ends its turn on it — Repulse: hostiles save (Hull) or are pushed 3 in the direction you choose (Prone if they hit an obstruction), allies may fly 3 spaces; Attract: characters save (Hull) or are Immobilized (repeat the save as a quick action; cleared if the plate is destroyed)',
    actions: (b, u) => [deployAction(b, u, PCP('repulse')), deployAction(b, u, PCP('attract'))].filter((x): x is CustomAction => !!x),
    ...fieldTriggers('pcp', (b, self, u) => mine(b, self, 'Perimeter Command Plate').some(d => footprint(d).some(p => footprint(u).some(q => q.x === p.x && q.y === p.y))), (b, self, u) => {
      const d = mine(b, self, 'Perimeter Command Plate')[0]
      if (d.flags.pcp === 'repulse') {
        if (!b.hostile(self, u)) { pcpFly(b, u); return }
        if (saveVs(b, u, 'hull', self, 'knockback')) return
        pcpRepulse(b, self, d, u)
      } else if (!b.save(u, 'hull', self.stats.save, 0, self)) b.addStatus(u, 'immobilized', 'until_cleared', self, { pcp: d.id })
    }),
    onAnyTurnEnd(b, self, u) {
      if (u.kind !== 'mech' && u.kind !== 'npc') return
      const d = mine(b, self, 'Perimeter Command Plate').find(x => footprint(x).some(p => footprint(u).some(q => q.x === p.x && q.y === p.y)))
      if (!d) return
      if (d.flags.pcp === 'repulse') { if (b.hostile(self, u) && !b.save(u, 'hull', self.stats.save, 0, self)) pcpRepulse(b, self, d, u) }
      else if (!b.has(u, 'immobilized') && !b.save(u, 'hull', self.stats.save, 0, self)) b.addStatus(u, 'immobilized', 'until_cleared', self, { pcp: d.id })
    },
    grantActions: (b, self, other) => (other.statuses.some(s => s.id === 'immobilized' && s.data?.pcp && mine(b, self, 'Perimeter Command Plate').some(d => d.id === s.data.pcp))
      ? [{
        key: `pcp_free:${self.id}`, name: 'Break free of the command plate', activation: 'quick', target: 'none', text: 'Hull save to clear Immobilized.',
        usable: () => true,
        run: (bt, me) => { if (bt.save(me, 'hull', self.stats.save, 0, self)) me.statuses = me.statuses.filter(s => !s.data?.pcp) },
        aiTarget: () => ({ x: other.pos.x, y: other.pos.y }), aiScore: () => 3,
      }] : []),
    onDestroyed(b, self, v) { if (v.flags.pcp) for (const u of b.alive()) u.statuses = u.statuses.filter(s => s.data?.pcp !== v.id) },
  },
  {
    id: 'ms_aegis_shield_generator',
    fields: (b, u) => mine(b, u, 'Aegis Shield Generator').map(d => ({ tiles: burstTiles(b.map, d, 1), effect: 'protect' as const, label: `${u.name}'s shield generator: reduces damage to allies (${d.flags.aegisDice} dice left)` })), note: 'Aegis Shield Generator: Burst 1 shield; as a reaction, roll one of its 3 dice to reduce damage to an ally in the area',
    actions: (b, u) => droneKit(b, u, { ...AEGIS, aiScore: earlyWhenEngaged(10) }, { recall: false, redeploy: false }),
    modifyIncoming: (b, self, d) => reduceWithAegis(b, self, self, d),
    modifyAnyIncoming: (b, self, target, d) => reduceWithAegis(b, self, target, d),
  },
  {
    id: 'ms_portable_bunker',
    fields: (b, u) => mine(b, u, 'Portable Bunker').map(d => ({ tiles: footprint(d), effect: 'protect' as const, label: b.round >= (d.flags.unfoldRound ?? 0) ? `${u.name}'s bunker: hard cover and area-attack resistance inside` : `${u.name}'s bunker (unfolds next turn)` })), note: 'Portable Bunker: open-topped 4x4 emplacement (unfolds next turn); every character completely inside gains hard cover and Resistance to Blast/Line/Burst/Cone attacks from outside',
    actions: (b, u) => droneKit(b, u, { ...BUNKER, aiScore: earlyWhenEngaged(12) }, { recall: false, redeploy: false }),
    adjustCover(b, self, attacker, target, c) {
      const bk = bunkerHolding(b, self, target)
      return bk && !inside(bk, attacker) ? 'hard' : c
    },
    beforeAnyAttack(b, self, ctx) {
      const bk = bunkerHolding(b, self, ctx.target)
      // Blast, Line, Burst and Cone attacks (weapons or systems) from outside
      const aoe = ctx.weapon ? b.isAoE(b.profile(ctx.weapon)) : ctx.multiTarget
      if (bk && !inside(bk, ctx.attacker) && aoe) { ctx.resistAll = true; ctx.reasons.push('Bunker') }
    },
  },
  {
    id: 'ms_oasis_wall',
    fields: (_b, u) => (u.flags.oasis?.length ? [{ tiles: u.flags.oasis as Pos[], effect: 'barrier' as const, label: `${u.name}'s OASIS wall: hard cover and energy resistance to adjacent characters; can't end a move inside` }] : []),
    note: 'OASIS Wall (protocol): until the start of your next turn you move only in straight lines, leaving a light barrier (your Size) in each space you pass through; it gives hard cover and Resistance to energy to adjacent characters, is immune to damage, is not an obstruction, and nobody can end a move inside it; it lasts until you use the system again',
    actions: () => [{
      key: 'oasis', name: 'OASIS Wall', activation: 'protocol', heat: 2, target: 'none', text: 'Until your next turn, you move in straight lines and leave a light barrier behind you.',
      usable: () => true,
      run: (bt, me) => { me.flags.oasisActive = true; me.flags.oasis = []; bt.say(`${me.name} projects an OASIS wall trail.`) },
      aiTarget: (bt, me) => ({ x: me.pos.x, y: me.pos.y }),
      aiScore: (bt, me) => (!me.flags.oasisActive && me.heat + 2 <= me.stats.heatcap - 2 && hostiles(bt, me).some(h => bt.distance(me, h) <= 12) && !(me.flags.oasis?.length) ? 1.5 : 0),
    }],
    onTurnStart(_b, self) { self.flags.oasisActive = false },
    straightMovesOnly: (_b, self) => !!self.flags.oasisActive,
    onMove(_b, self, mover, path) {
      if (mover !== self || !self.flags.oasisActive) return
      const size = Math.max(1, Math.ceil(self.stats.size))
      const add = path.slice(0, -1).flatMap(p => footprint({ pos: p, stats: { size } }))
      const seen = new Set((self.flags.oasis as Pos[]).map(p => `${p.x},${p.y}`))
      self.flags.oasis = [...self.flags.oasis, ...add.filter(p => !seen.has(`${p.x},${p.y}`) && (seen.add(`${p.x},${p.y}`), true))]
    },
    forbidsEndingAt(_b, self, mover, p) {
      const t = self.flags.oasis as Pos[] | undefined
      return !!t?.length && footprint({ pos: p, stats: mover.stats }).some(q => t.some(x => x.x === q.x && x.y === q.y))
    },
    adjustCover(b, self, attacker, target, c) {
      if (c === 'hard' || !(self.flags.oasis?.length)) return c
      return (self.flags.oasis as Pos[]).some(p => shields(b, attacker, target, p)) ? 'hard' : c
    },
    beforeAnyDamage(b, self, t, parts, opts) {
      const src = opts.attack?.attacker ?? opts.source
      if (!src || !(self.flags.oasis?.length) || !parts.some(p => p.type === 'Energy')) return
      if ((self.flags.oasis as Pos[]).some(p => shields(b, src, t, p))) opts.resistTypes = [...(opts.resistTypes ?? []), 'Energy']
    },
  },
  {
    id: 'ms_stasis_barrier',
    fields: (b, u) => { const segs = mine(b, u, 'Stasis Barrier'); return segs.length ? [{ tiles: segs.map(sg => sg.pos), effect: 'barrier' as const, label: `${u.name}'s stasis barrier: soft cover; attacks on covered characters fail on 4+` }] : [] }, note: 'Stasis Barrier: Line 4 obstruction; soft cover to every character behind it; attacks on characters it covers are consumed on 4+',
    actions: (b, u) => {
      const segs = mine(b, u, 'Stasis Barrier')
      if (segs.length) return [{ key: 'stasis_off', name: 'Deactivate Stasis Barrier', activation: 'quick', target: 'none', text: 'Dismiss the barrier.', usable: () => true, run: bt => segs.forEach(s => bt.removeUnit(s, 'fades')) }]
      const s = sys(u, 'ms_stasis_barrier')
      return [{
        key: 'stasis', name: 'Stasis Barrier', activation: 'quick', target: 'tile', range: 1, text: 'A Line 4 barrier next to you, across the chosen direction.',
        usable: () => (s?.usesLeft === 0 ? 'No charges left' : true),
        run: (bt, me, t) => {
          const at = t && 'x' in t ? t : (t as Unit).pos
          const dx = Math.sign(at.x - me.pos.x), dy = Math.sign(at.y - me.pos.y)
          if (!dx && !dy) throw new Error('Pick a space next to you')
          const perp = { x: -dy, y: dx }
          let n = 0
          for (const k of [0, 1, -1, 2, -2]) {
            if (n >= 4) break
            const p = { x: at.x + perp.x * k, y: at.y + perp.y * k }
            if (!freeFor(bt, 1, p)) continue
            const d = deployableUnit(me, { name: 'Stasis Barrier', type: 'Deployable', size: 1, hp: 999, evasion: 5 } as any, p)
            d.resist = ['all']; d.flags.isCover = false; d.flags.stasis = true
            bt.spawn(d); n++
          }
          if (!n) throw new Error('No room for the barrier')
          if (s && s.usesLeft != null) s.usesLeft--
          bt.say(`${me.name} raises a stasis barrier.`)
        },
        aiTarget: (bt, me) => {
          const h = nearestHostile(bt, me)
          if (!h) return null
          return { x: me.pos.x + Math.sign(h.pos.x - me.pos.x), y: me.pos.y + Math.sign(h.pos.y - me.pos.y) }
        },
        aiScore: (bt, me) => (hostiles(bt, me).some(h => bt.distance(me, h) <= 10) ? 2 : 0),
      }]
    },
    // owner's ruling: like terrain, it shelters every character behind it (either side)
    adjustCover(b, self, attacker, target, c) {
      if (c !== 'none' || (target.kind !== 'mech' && target.kind !== 'npc' && target.kind !== 'drone')) return c
      return mine(b, self, 'Stasis Barrier').some(sg => shields(b, attacker, target, sg.pos)) ? 'soft' : c
    },
    beforeAnyAttack(b, self, ctx) {
      const t = ctx.target
      if ((t.kind !== 'mech' && t.kind !== 'npc' && t.kind !== 'drone') || b.has(t, 'invisible') || !mine(b, self, 'Stasis Barrier').some(sg => shields(b, ctx.attacker, t, sg.pos))) return
      if (b.rng.d(6) >= 4) { ctx.cancelled = true; b.say(`  The stasis barrier swallows the attack on ${t.name}.`) }
    },
  },
  {
    id: 'ms_interdiction_field',
    fields: (b, u) => (u.flags.interdiction ? [{ tiles: burstTiles(b.map, u, 3), effect: 'control' as const, label: `${u.name}'s interdiction field: hostiles save (Systems) or are Slowed` }] : []), note: 'Interdiction Field: Burst 3 around you until you deactivate it (quick; you are Slowed): hostiles starting their turn in it or entering it for the first time in a round save (Systems) or are Slowed until the end of their next turn; only characters you allow (your side) can teleport into, out of or within it',
    actions: (_b, u) => [{
      key: 'interdiction', name: u.flags.interdiction ? 'Deactivate Interdiction Field' : 'Interdiction Field', activation: 'quick', target: 'none', text: 'Toggle a Burst 3 field: you are Slowed; hostiles in it save (Systems) or are Slowed.',
      usable: () => true,
      run: (bt, me) => {
        me.flags.interdiction = !me.flags.interdiction
        if (me.flags.interdiction) bt.addStatus(me, 'slowed', 'until_cleared', me, { interdiction: true })
        else me.statuses = me.statuses.filter(s => !s.data?.interdiction)
      },
      aiTarget: (_bt, me) => ({ x: me.pos.x, y: me.pos.y }),
      aiScore: (bt, me) => (!me.flags.interdiction && hostiles(bt, me).filter(h => bt.distance(me, h) <= 4).length >= 2 ? 2.5 : 0),
    }],
    blocksTeleport(b, self, mover, p) {
      if (!self.flags.interdiction || !b.hostile(self, mover)) return false
      const field = burstTiles(b.map, self, 3)
      const inF = (q: Pos) => footprint({ pos: q, stats: mover.stats }).some(r => field.some(t => t.x === r.x && t.y === r.y))
      return inF(p) || inF(mover.pos)
    },
    ...fieldTriggers('interdiction', (b, self, u) => !!self.flags.interdiction && b.hostile(self, u) && b.distance(self, u) <= 3, (b, self, u) => {
      if (!b.save(u, 'sys', self.stats.save, 0, self)) b.addStatus(u, 'slowed', 'next_turn_end_target', self)
    }),
  },
]

function restockUse(b: Battle, owner: Unit, user: Unit): CustomAction[] {
  return mine(b, owner, 'Restock Drone').filter(d => d.flags.primed && b.distance(d, user) <= 1).map(d => ({
    key: `restock:${d.id}`, name: 'Activate Restock Drone', activation: 'quick' as const, target: 'none' as const, text: 'Clear 1d6 heat and one condition, and reload a Loading weapon.',
    usable: () => true,
    run: (bt: Battle, me: Unit) => {
      const h = bt.rng.d(6)
      me.heat = Math.max(0, me.heat - h)
      const c = CONDITIONS.find(id => bt.has(me, id))
      if (c) bt.removeStatus(me, c)
      const w = me.weapons.find(x => !x.loaded && !x.destroyed)
      if (w) { w.loaded = true; me.flags.reloaded = true }
      bt.say(`${me.name} uses the restock drone: -${h} heat${c ? `, clears ${c}` : ''}${w ? `, reloads ${w.name}` : ''}.`)
      bt.removeUnit(d, 'disintegrates')
    },
    aiTarget: () => ({ x: user.pos.x, y: user.pos.y }),
    aiScore: () => (user.heat >= 3 || CONDITIONS.some(id => b.has(user, id)) || user.weapons.some(w => !w.loaded) ? 3 : 0),
  }))
}

function autoload(b: Battle, owner: Unit, user: Unit): CustomAction[] {
  return mine(b, owner, 'Autoloader Drone').filter(d => b.distance(d, user) <= 1 && !d.flags[`round:autoload`] && user.weapons.some(w => !w.loaded && !w.destroyed)).map(d => ({
    key: `autoload:${d.id}`, name: 'Autoloader: reload', activation: 'quick' as const, target: 'none' as const, text: 'Reload a Loading weapon (1/round).',
    usable: () => true,
    run: (bt: Battle, me: Unit) => {
      d.flags['round:autoload'] = true
      const w = me.weapons.find(x => !x.loaded && !x.destroyed)
      if (w) { w.loaded = true; me.flags.reloaded = true; bt.say(`${me.name} reloads ${w.name} from the autoloader.`) }
    },
    aiTarget: () => ({ x: user.pos.x, y: user.pos.y }),
    aiScore: () => 2.5,
  }))
}

/** the last attack each attacker was shot at for (Sentinel Drone) */
const sentinelSeen = new WeakMap<Unit, object>()

/**
 * ICEOUT: a character inside the field is immune to conditions and effects that tech actions gave it; they come back
 * when it leaves (while suppressed they keep their clocks, under the id 'iceout').
 */
function iceoutSync(b: Battle) {
  for (const u of b.units) {
    if (u.destroyed || (u.kind !== 'mech' && u.kind !== 'npc')) continue
    const inside = b.inIceout(u)
    for (const s of u.statuses) {
      if (inside && s.tech && s.id !== ('iceout' as StatusId)) { s.data = { ...s.data, iceoutOf: s.id }; s.id = 'iceout' as StatusId }
      else if (!inside && s.id === ('iceout' as StatusId) && s.data?.iceoutOf) { s.id = s.data.iceoutOf; delete s.data.iceoutOf }
    }
  }
}

const inside = (bk: Unit, u: Unit) => footprint(u).every(p => footprint(bk).some(q => q.x === p.x && q.y === p.y))
function bunkerHolding(b: Battle, owner: Unit, u: Unit): Unit | undefined {
  // "All characters completely within" — whichever side they are on
  return mine(b, owner, 'Portable Bunker').find(bk => b.round >= (bk.flags.unfoldRound ?? 0) && inside(bk, u) && (u.kind === 'mech' || u.kind === 'npc' || u.kind === 'drone'))
}

registerScripts(scripts)

// ------------------------------------------------------------------ Hydra OROCHI and Drone Commander
const OROCHI = ['Guardian', 'Snare', 'Shredder', 'Hunter'] as const
type Orochi = (typeof OROCHI)[number]
const orochiName = (k: Orochi) => `${k} OROCHI Drone`
const orochiSpec = (self: Unit, k: Orochi): DeploySpec => ({
  sysId: 'orochi', placement: 'sensors',
  dep: { name: orochiName(k), type: 'Drone', size: 0.5, hp: 5 + self.stats.grit, evasion: self.stats.evasion, edef: self.stats.edef },
  setup: (_b, me, d) => { d.stats.speed = me.stats.speed; d.flying = true; d.flags.orochi = k },
})
const myOrochi = (b: Battle, u: Unit) => b.alive().filter(d => d.ownerId === u.id && d.flags.orochi)

/** Move one of your drones to a free space within `max` (no reactions). */
function moveDrone(b: Battle, d: Unit, at: Pos, max: number) {
  if (chebyshev(d.pos, at) > max) throw new Error(`Too far (max ${max})`)
  if (!freeFor(b, d.stats.size, at, d)) throw new Error('Space occupied')
  const from = d.pos
  d.pos = at
  b.invalidateTerrain()
  b.emit({ type: 'move', unitId: d.id, path: [from, at] })
}

function orochiTrigger(kind: Orochi, fx: (b: Battle, self: Unit, u: Unit, d: Unit) => void) {
  return fieldTriggers(`orochi_${kind}`, (b, self, u) => b.hostile(self, u) && myOrochi(b, self).some(d => d.flags.orochi === kind && b.distance(d, u) <= 1), (b, self, u) => {
    const d = myOrochi(b, self).find(x => x.flags.orochi === kind && b.distance(x, u) <= 1)!
    if (b.canSpend(self, 'reaction', `orochi_${kind}`) !== true) return
    b.spend(self, 'reaction', `orochi_${kind}`)
    fx(b, self, u, d)
  })
}
const merge = (...parts: Partial<ItemScript>[]): Partial<ItemScript> => {
  const out: any = {}
  for (const p of parts) for (const [k, f] of Object.entries(p)) {
    const prev = out[k]
    out[k] = prev ? (...args: any[]) => { prev(...args); (f as any)(...args) } : f
  }
  return out
}

// ---------------------------------------------------------------- Ghast Nexus (a weapon that can deploy as a drone)
const ghastSpec = (): DeploySpec => ({
  sysId: 'mw_ghast_nexus', dep: Lancer.weapons.get('mw_ghast_nexus')!.deployables![0] as any, activation: 'free', placement: 'sensors', los: true,
  text: 'Deploy the Ghast nexus as a stationary drone within Sensors and line of sight; it still attacks as a weapon, with range and line of sight traced from the drone.',
  aiScore: () => -1,
})
registerScripts([
  {
    id: 'mw_ghast_nexus',
    note: 'Attack normally, or deploy as a drone (free action, Sensors and line of sight): Skirmish/Barrage with it trace range and line of sight from the drone; recall or redeploy as a quick action; if the drone is destroyed the weapon is unusable until repaired',
    actions: (b, u) => {
      if (!u.weapons.some(x => x.dataId === 'mw_ghast_nexus' && !x.destroyed)) return []
      const live = mine(b, u, 'Ghast Drone')
      if (!live.length) { const a = deployAction(b, u, ghastSpec()); return a ? [a] : [] }
      return [recallAction(u, live[0]), redeployAction(b, u, live[0], { ...ghastSpec(), activation: 'quick' })]
    },
    attackOrigin(b, self, w) {
      if (w.dataId !== 'mw_ghast_nexus') return null
      const d = mine(b, self, 'Ghast Drone')[0]
      return d ? { ...d.pos } : null
    },
    onDestroyed(b, self, victim) {
      if (victim.ownerId !== self.id || victim.name !== 'Ghast Drone' || victim.flags.removed) return
      const w = self.weapons.find(x => x.dataId === 'mw_ghast_nexus' && !x.destroyed)
      if (w) { w.destroyed = true; b.say(`${self.name}'s Ghast nexus is destroyed with its drone.`, 'damage') }
    },
  },
])

registerScripts([
  {
    id: 'core:mf_hydra',
    fields: (b, u) => myOrochi(b, u).map((d): FieldOverlay => ({ tiles: burstTiles(b.map, d, 1), effect: d.flags.orochi === 'Guardian' ? 'protect' : 'control', label: `${d.name}: ${({ Guardian: 'ranged attacks on adjacent allies +1 difficulty', Snare: 'Agility save or Immobilized', Shredder: 'Hull save or 1 kinetic and Shredded', Hunter: 'Systems save or Lock On' } as Record<string, string>)[d.flags.orochi]}` })),
    note: 'OROCHI: one companion drone (Guardian/Snare/Shredder/Hunter) to deploy, recall, redeploy and move; Full Deployment deploys all four',
    actions: (b, u) => {
      const out: CustomAction[] = []
      const live = myOrochi(b, u)
      const kinds: Orochi[] = u.flags.orochiAll ? [...OROCHI] : u.flags.orochiChoice ? [u.flags.orochiChoice] : [...OROCHI]
      for (const k of kinds) if (!live.some(d => d.flags.orochi === k)) {
        const spec = orochiSpec(u, k)
        out.push({
          key: `orochi:${k}`, name: `Deploy ${orochiName(k)}`, activation: 'quick', target: 'tile', range: u.stats.sensors, text: 'Deploy an OROCHI drone within Sensors.',
          usable: () => (!u.flags.orochiAll && live.length ? 'Your companion drone is already out' : true),
          run: (bt, me, t) => { place(bt, me, spec, t && 'x' in t ? t : (t as Unit).pos); if (!me.flags.orochiAll) me.flags.orochiChoice = k },
          aiTarget: aimAtEnemies(spec, 0.5, k === 'Guardian' ? 3 : 1),
          aiScore: (bt, me) => (live.length ? 0 : earlyWhenEngaged()(bt, me)),
        })
      }
      for (const d of live) {
        out.push({ ...recallAction(u, d), usable: (bt, me) => (bt.distance(me, d) <= me.stats.sensors ? true : 'Out of Sensors') })
        out.push(redeployAction(b, u, d, orochiSpec(u, d.flags.orochi)))
        out.push({
          key: `orochi_move:${d.id}`, name: `Move ${d.name}`, activation: 'free', target: 'tile', range: d.stats.speed, text: 'OROCHI drones move independently on your turn.',
          usable: () => (d.flags['turn:moved'] ? 'Already moved this turn' : true),
          run: (bt, _me, t) => { moveDrone(bt, d, t && 'x' in t ? t : (t as Unit).pos, d.stats.speed); d.flags['turn:moved'] = true },
          aiTarget: (bt, me) => {
            const h = nearestHostile(bt, me, d.pos)
            if (!h || bt.distance(d, h) <= 1) return null
            let best: Pos | null = null
            for (let dy = -d.stats.speed; dy <= d.stats.speed; dy++) for (let dx = -d.stats.speed; dx <= d.stats.speed; dx++) {
              const p = { x: d.pos.x + dx, y: d.pos.y + dy }
              if (!freeFor(bt, 0.5, p, d)) continue
              if (!best || chebyshev(p, h.pos) < chebyshev(best, h.pos)) best = p
            }
            return d.flags.orochi === 'Guardian' ? null : best
          },
          aiScore: () => 1,
        })
      }
      return out
    },
    onCoreActivate(b, u) {
      u.flags.orochiAll = true
      for (const k of OROCHI) {
        if (myOrochi(b, u).some(d => d.flags.orochi === k)) continue
        const spec = orochiSpec(u, k)
        const at = aimAtEnemies(spec, 0.5, k === 'Guardian' ? 3 : 1)!(b, u) ?? tileToward(b, u, u.pos, spec)
        if (at && !('id' in at)) place(b, u, spec, at)
      }
    },
    beforeAnyAttack(b, self, ctx) {
      if (ctx.tech || ctx.melee || b.hostile(self, ctx.target) || !myOrochi(b, self).some(d => d.flags.orochi === 'Guardian' && b.distance(d, ctx.target) <= 1)) return
      ctx.difficulty++
      ctx.reasons.push('Guardian OROCHI -1')
    },
    grantActions: (b, self, other) => (other.statuses.some(s => s.id === 'immobilized' && s.data?.snare) ? [{
      key: `snare_free:${self.id}`, name: 'Break free of the snare', activation: 'quick', target: 'none', text: 'Agility save to clear Immobilized.',
      usable: () => true,
      run: (bt, me) => { if (bt.save(me, 'agi', self.stats.save, 0, self)) me.statuses = me.statuses.filter(s => !s.data?.snare) },
      aiTarget: () => ({ x: other.pos.x, y: other.pos.y }), aiScore: () => 3,
    }] : []),
    ...(merge(
      orochiTrigger('Snare', (b, self, u, d) => { if (!b.save(u, 'agi', self.stats.save, 0, self)) b.addStatus(u, 'immobilized', 'until_cleared', self, { snare: d.id }) }),
      orochiTrigger('Shredder', (b, self, u) => { if (!b.save(u, 'hull', self.stats.save, 0, self)) { b.applyDamage(u, [{ type: 'Kinetic', amount: 1 }], { source: self }); b.addStatus(u, 'shredded', 'next_turn_end_target', self) } }),
      orochiTrigger('Hunter', (b, self, u) => { if (!b.save(u, 'sys', self.stats.save, 0, self)) b.addStatus(u, 'lockon', 'until_cleared', self) }),
      {
        // snared characters go free once the drone is gone or no longer adjacent
        onAnyTurnStart(b: Battle, self: Unit, u: Unit) {
          for (const st of u.statuses.filter(s => s.data?.snare)) {
            const d = b.unit(st.data.snare)
            if (!d || d.destroyed || b.distance(d, u) > 1) u.statuses = u.statuses.filter(s => s !== st)
          }
        },
      },
    ) as Omit<ItemScript, 'id'>),
  } as ItemScript,
  {
    id: 't_drone_commander:1', note: 'Shepherd: drone HP via bonus; Shepherd Drone protocol (move a drone within Sensors up to 4)',
    actions: (b, u) => b.alive().filter(d => d.ownerId === u.id && d.kind === 'drone').map(d => ({
      key: `shepherd:${d.id}`, name: `Shepherd ${d.name}`, activation: 'protocol' as const, target: 'tile' as const, range: 50, sourceUid: 'shepherd_drone',
      text: 'Move a drone you control within Sensors up to 4 spaces.',
      usable: (bt: Battle, me: Unit) => (bt.distance(me, d) <= me.stats.sensors ? true : 'Out of Sensors'),
      run: (bt: Battle, _me: Unit, t?: Unit | Pos) => moveDrone(bt, d, t && 'x' in t ? t : (t as Unit).pos, 4),
    })),
  },
  {
    id: 't_drone_commander:3', note: 'Invigorate: a chained pulse; allies in it gain 4 overshield, hostiles on the line take 2 energy',
    actions: () => [{
      key: 'invigorate', name: 'Invigorate', activation: 'quick', target: 'ally', range: 3, text: 'Pulse between allies within 3 of each other (drones too): 4 overshield; hostiles on the line take 2 energy.',
      usable: () => true,
      run: (bt, me, t) => {
        const first = t as Unit
        if (!first || bt.hostile(me, first) || bt.distance(me, first) > 3) throw new Error('Pick an ally within range 3')
        const allies = bt.alive().filter(a => !bt.hostile(me, a) && a !== me)
        const chain: Unit[] = [first]
        for (;;) {
          const last = chain[chain.length - 1]
          const next = allies.filter(a => !chain.includes(a) && bt.distance(last, a) <= 3).sort((x, y) => bt.distance(last, x) - bt.distance(last, y))[0]
          if (!next) break
          chain.push(next)
        }
        const burned = new Set<Unit>(), shielded = new Set<Unit>(chain)
        let from: Unit = me
        for (const to of chain) {
          const steps = Math.max(1, chebyshev(from.pos, to.pos))
          for (let i = 1; i < steps; i++) {
            const p = { x: Math.round(from.pos.x + ((to.pos.x - from.pos.x) * i) / steps), y: Math.round(from.pos.y + ((to.pos.y - from.pos.y) * i) / steps) }
            for (const o of bt.alive()) if (footprint(o).some(q => q.x === p.x && q.y === p.y)) (bt.hostile(me, o) ? burned : shielded).add(o)
          }
          from = to
        }
        for (const a of shielded) a.overshield = Math.max(a.overshield, 4)
        for (const h of burned) bt.applyDamage(h, [{ type: 'Energy', amount: 2 }], { source: me })
        bt.say(`${me.name} invigorates ${[...shielded].map(a => a.name).join(', ')}.`)
      },
      aiTarget: (bt, me) => bt.alive().filter(a => !bt.hostile(me, a) && a !== me && bt.distance(me, a) <= 3).sort((x, y) => x.overshield - y.overshield)[0] ?? null,
      aiScore: (bt, me) => bt.alive().filter(a => !bt.hostile(me, a) && a !== me && bt.distance(me, a) <= 6 && a.overshield < 4).length * 1.2,
    }],
  },
])
