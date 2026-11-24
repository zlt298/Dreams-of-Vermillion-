// Mech systems whose rules aren't fully structured in lancer-data.
import { blastTiles, burstTiles, distanceToTile, footprint, hasLineOfSightToTile, lineTiles, unitsOnTiles, chebyshev } from '../../grid'
import { rollDice } from '../../rng'
import { dropSystemBonuses } from '../../stats'
import type { Effect, Pos, SystemInst, Unit } from '../../types'
import { PendingChoice, type Battle } from '../../battle'
import { deployableUnit } from '../generic'
import { Lancer } from '../../../data/lancer'
import { registerScripts, scriptsFor, type AttackCtx, type CustomAction, type ItemScript } from '../registry'
import { takeReload } from './weapons'

const once = (u: Unit, key: string, scope: 'round' | 'turn' | 'scene' = 'round'): boolean => {
  const k = `${scope}:${key}`
  if (u.flags[k]) return false
  u.flags[k] = true
  return true
}
const sys = (u: Unit, id: string) => u.systems.find(s => s.dataId === id && !s.destroyed)
const usesOk = (s?: SystemInst): true | string => (!s ? 'Destroyed' : s.usesLeft === 0 ? 'No charges left' : true)
const spend = (s?: SystemInst) => { if (s && s.usesLeft != null) s.usesLeft-- }
const action = (a: Omit<CustomAction, 'usable'> & { usable?: CustomAction['usable'] }): CustomAction => ({ usable: () => true, ...a })
const narrative = (id: string, note: string): ItemScript => ({ id, note: `narrative/out-of-combat: ${note}` })
const hostile = (b: Battle, u: Unit) => b.alive().filter(o => b.hostile(u, o) && (o.kind === 'mech' || o.kind === 'npc'))

/** An Invade option: tech attack; on hit 2 heat + effect. */
function invade(id: string, name: string, text: string, onHit: (b: Battle, self: Unit, t: Unit) => void, extra: Partial<CustomAction> = {}): (b: Battle, u: Unit) => CustomAction {
  return (b, u) => action({
    key: `${id}:${name}`, name: `Invade: ${name}`, activation: 'quick_tech', techOption: 'invade', target: 'unit', range: u.stats.sensors, text,
    run: (bt, self, t) => {
      const target = t as Unit
      const v = bt.techTargetValid(self, target)
      if (v !== true) throw new Error(v)
      const ctx = bt.invadeRoll(self, target, name)
      if (ctx.hit) { if (bt.hostile(self, target)) bt.applyDamage(target, [{ type: 'Heat', amount: 2 }], { source: self, attack: ctx }); if (!target.destroyed) onHit(bt, self, target) }
    },
    aiScore: () => 4,
    ...extra,
  })
}

function aoeSave(b: Battle, self: Unit, tiles: Pos[], stat: 'hull' | 'agi' | 'sys' | 'eng', onFail: (t: Unit) => void, filter = (t: Unit) => b.hostile(self, t)) {
  b.emit({ type: 'area', tiles, kind: 'attack' })
  for (const t of unitsOnTiles(b.alive(), tiles)) if (t !== self && filter(t) && !b.save(t, stat, self.stats.save, 0, self)) onFail(t)
}

const accFor = (b: Battle, u: Unit) => { const a = b.accuracyFromStatuses(u, 'check', 'hull'); return a ? (a > 0 ? Math.max(...Array.from({ length: a }, () => b.rng.d(6))) : -Math.max(...Array.from({ length: -a }, () => b.rng.d(6)))) : 0 }
function lbocSync(b: Battle, self: Unit) {
  const on = !!self.flags.lboc && !self.destroyed
  const tiles = on ? burstTiles(b.map, self, 2) : []
  const inside = (u: Unit) => footprint(u).every(p => tiles.some(t => t.x === p.x && t.y === p.y))
  for (const u of b.alive()) {
    if (u.kind !== 'mech' && u.kind !== 'npc') continue
    const mine = u.statuses.find(s => s.id === 'invisible' && s.data?.lboc === self.id)
    const want = on && !b.hostile(self, u) && inside(u)
    if (want && !b.has(u, 'invisible')) b.addStatus(u, 'invisible', 'until_cleared', self, { lboc: self.id })
    else if (!want && mine) b.removeStatus(u, 'invisible')
  }
}
function lbocOff(b: Battle, self: Unit) {
  delete self.flags.lboc
  self.statuses = self.statuses.filter(s => !(s.id === 'slowed' && s.data?.lboc))
  b.say(`${self.name}'s cloaking field drops.`)
  lbocSync(b, self)
}
const META_CONDITIONS = ['immobilized', 'impaired', 'jammed', 'lockon', 'shredded', 'slowed', 'stunned']
function metaUnlink(b: Battle, self: Unit) {
  const a = b.unit(self.flags.metahook)
  if (a && a.flags.metaOrigSys != null) { a.stats.sys = a.flags.metaOrigSys; delete a.flags.metaOrigSys }
  delete self.flags.metahook
}
function metaCheck(b: Battle, self: Unit) {
  const a = b.unit(self.flags.metahook)
  if (!self.flags.metahook) return
  if (!a || a.destroyed || b.distance(self, a) > self.stats.sensors || !b.los(self, a)) { metaUnlink(b, self); b.say(`${self.name}'s Metahook link breaks.`) }
}
const centroid = (ps: Pos[], fallback: Pos): Pos => (ps.length ? { x: Math.round(ps.reduce((a, p) => a + p.x, 0) / ps.length), y: Math.round(ps.reduce((a, p) => a + p.y, 0) / ps.length) } : fallback)
function turnTarget(b: Battle, self: Unit, t: Unit) {
  t.flags.turnedFrom = t.side
  t.flags.turnedBy = self.id
  // until the end of its next turn (the turn it is taking now, if any, doesn't count)
  t.flags.turnedTurns = t.activeTurn ? 2 : 1
  t.side = self.side
  b.say(`  Fourth Gate: ${t.name} turns on its allies until the end of its next turn!`, 'warn')
  b.emit({ type: 'status', unitId: t.id, status: 'turned', added: true })
}
function unturn(b: Battle, t: Unit) {
  if (!t.flags.turnedFrom) return
  t.side = t.flags.turnedFrom
  delete t.flags.turnedFrom; delete t.flags.turnedBy; delete t.flags.turnedTurns
  b.say(`${t.name} returns to its own side.`, 'status')
  b.emit({ type: 'status', unitId: t.id, status: 'turned', added: false })
  b.checkVictory()
}

function excomm(b: Battle, self: Unit, u: Unit) {
  if (u.flags['round:excomm']) return
  const ally = b.alive().find(o => o !== u && (o.kind === 'mech' || o.kind === 'npc') && !b.hostile(u, o) && b.adjacent(u, o))
  if (!ally) return
  u.flags['round:excomm'] = true
  b.say(`  Excommunicate: ${u.name} and ${ally.name} take 3 heat.`)
  b.applyDamage(u, [{ type: 'Heat', amount: 3 }], { source: self })
  b.applyDamage(ally, [{ type: 'Heat', amount: 3 }], { source: self })
}
const mineRange = (u: Unit) => (u.flags.assaultLauncher ? 15 : 1)
/** how many of `u`'s turn ends an effect "until the end of its next turn" lasts */
const nextTurnEnds = (u: Unit) => (u.activeTurn ? 2 : 1)
/** a save that avoids Prone or Knockback (Stable Structure gives +1 Accuracy on those) */
function saveAvoiding(b: Battle, u: Unit, stat: 'hull' | 'agi' | 'sys' | 'eng', target: number, src: Unit, avoid: 'prone' | 'knockback'): boolean {
  u.flags.saveAvoid = avoid
  try { return b.save(u, stat, target, 0, src) } finally { delete u.flags.saveAvoid }
}
const DIR8: [number, number][] = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]]
const DIR8_NAMES = ['North', 'North-east', 'East', 'South-east', 'South', 'South-west', 'West', 'North-west']
/** index of the direction closest to pointing from `from` to `to` */
const dirIndex = (from: Pos, to: Pos) => Math.max(0, DIR8.findIndex(d => d[0] === Math.sign(to.x - from.x) && d[1] === Math.sign(to.y - from.y)))
/** the first free, open space within `n` of `u` farthest from `away` (Exposed Singularity, Reactive Weave) */
function farthestFree(b: Battle, u: Unit, away: Pos, n: number, ok: (p: Pos) => boolean): Pos | null {
  let best: Pos | null = null
  for (let dy = -n; dy <= n; dy++) for (let dx = -n; dx <= n; dx++) {
    const p = { x: u.pos.x + dx, y: u.pos.y + dy }
    if ((!dx && !dy) || !ok(p)) continue
    if (!best || chebyshev(p, away) > chebyshev(best, away)) best = p
  }
  return best
}
/** a free footprint for `u` at `p` (on the map, not blocking terrain, no solid unit in it) */
const fits = (b: Battle, u: Unit, p: Pos) => footprint({ pos: p, stats: u.stats }).every(q => {
  const t = q.x >= 0 && q.y >= 0 && q.x < b.map.w && q.y < b.map.h ? b.map.tiles[q.y * b.map.w + q.x] : undefined
  return !!t && t.kind !== 'block' && !b.alive().some(o => o !== u && !o.flags.flat && footprint(o).some(z => z.x === q.x && z.y === q.y))
})
/** Is this the first time `ctx`'s attack is seen? One weapon attack (all its targets share b.lastAim) or one tech attack. */
const attackKeys = new WeakMap<Unit, object>()
function newAttack(b: Battle, ctx: AttackCtx): boolean {
  const k = ctx.weapon && b.lastAim ? b.lastAim : ctx
  if (attackKeys.get(ctx.attacker) === k) return false
  attackKeys.set(ctx.attacker, k)
  return true
}
const caltropAreas = (b: Battle, owner: Unit) => b.areas.filter(a => a.tag === 'caltrops' && a.ownerId === owner.id)
function caltropTurnEnd(b: Battle, self: Unit, u: Unit) {
  if (u.kind !== 'mech' || u.destroyed || u.flying) return
  if (!caltropAreas(b, self).some(a => footprint(u).some(q => a.tiles.some(t => t.x === q.x && t.y === q.y)))) return
  b.say(`${u.name} ends its turn on caltrops.`, 'damage')
  b.applyDamage(u, [{ type: 'Explosive', amount: rollDice(b.rng, '1d3').total }], { source: self, ap: true })
}
/**
 * Puppet System: `t` walks its Speed in a straight line in direction `d` (difficult terrain and obstructions as normal,
 * stopping when it becomes Engaged); involuntary, but it provokes Overwatch and other movement reactions.
 */
function puppetMove(b: Battle, t: Unit, d: [number, number]) {
  if (t.destroyed || b.has(t, 'immobilized') || b.has(t, 'stunned')) return
  const me = new Set([t.id])
  const startAdj = new Set(b.alive().filter(o => b.hostile(t, o) && b.adjacent(t, o)).map(o => o.id))
  const path: Pos[] = [{ ...t.pos }]
  let lastOk = 0, cost = 0
  for (let k = 1; k <= t.stats.speed; k++) {
    const prev = path[path.length - 1]
    const np = { x: prev.x + d[0], y: prev.y + d[1] }
    const pass = b.passable(t, np, me)
    if (pass === 'blocked') break
    cost += b.stepCost(t, prev, np)
    if (cost > t.stats.speed) break
    path.push(np)
    if (pass === 'ok') lastOk = path.length - 1
    // Engagement as normal: entering a new hostile's reach (same Size or larger) ends the move
    if (pass === 'ok' && b.alive().some(o => b.hostile(t, o) && (o.kind === 'mech' || o.kind === 'npc') && !startAdj.has(o.id) && o.stats.size >= t.stats.size && b.adjacent(t, o, np))) break
  }
  path.length = lastOk + 1
  if (path.length < 2) return
  b.say(`${t.name} is puppeted ${path.length - 1} spaces.`)
  for (const o of b.alive()) for (const s of scriptsFor(o)) s.onAnyMovementAction?.(b, o, t, 'involuntary')
  b.triggerOverwatch(t) // it provokes reactions as normal
  if (t.destroyed || b.has(t, 'immobilized') || b.has(t, 'stunned')) return
  const was = t.flags.movingInvoluntarily
  t.flags.movingInvoluntarily = true
  try { b.followPath(t, path) } finally { t.flags.movingInvoluntarily = was }
}
/** //SCORPION protects you and allied characters adjacent to you */
const scorpionCovers = (b: Battle, self: Unit, t: Unit) => t === self || ((t.kind === 'mech' || t.kind === 'npc') && !b.hostile(self, t) && b.adjacent(self, t))
function scorpionSting(b: Battle, self: Unit, attacker: Unit) {
  const i = b.choose({ kind: 'scorpion', unit: self, title: `//SCORPION: punish ${attacker.name}`, options: [{ label: 'Impaired and 2 heat', hint: 'until the end of its next turn' }, { label: 'Jammed', hint: 'until the end of its next turn' }], defaultIndex: 0 })
  b.say(`${self.name}'s //SCORPION strikes back at ${attacker.name}.`, 'attack')
  if (i === 1) b.addStatus(attacker, 'jammed', 'next_turn_end_target', self)
  else { b.addStatus(attacker, 'impaired', 'next_turn_end_target', self); b.applyDamage(attacker, [{ type: 'Heat', amount: 2 }], { source: self }) }
}
/** Explosive Vents (1/round): burst 1, characters take 2 heat and 2 burn */
function vent(b: Battle, u: Unit) {
  if (u.destroyed || !sys(u, 'ms_explosive_vents') || !once(u, 'vents')) return
  const tiles = burstTiles(b.map, u, 1)
  b.say(`${u.name}'s cooling vents blow open!`, 'attack')
  b.emit({ type: 'area', tiles, kind: 'explosion' })
  for (const t of unitsOnTiles(b.alive(), tiles)) if (t !== u && (t.kind === 'mech' || t.kind === 'npc' || t.kind === 'drone')) b.applyDamage(t, [{ type: 'Heat', amount: 2 }, { type: 'Burn', amount: 2 }], { source: u })
}
function unstake(b: Battle, u: Unit) {
  delete u.flags.impaledBy
  if (!u.statuses.some(s => s.data?.stake)) return
  if (u.statuses.some(s => s.id === 'immobilized' && !s.data?.stake)) u.statuses = u.statuses.filter(s => !s.data?.stake)
  else b.removeStatus(u, 'immobilized')
}
registerScripts([
  // ------------------------------------------------------------ GMS
  narrative('ms_comp_con_class_assistant_unit', 'AI tag; COMP/CON can pilot while you are out of the mech'),
  narrative('ms_expanded_compartment', 'passenger space'),
  narrative('ms_manipulators', 'fine manipulation'),
  narrative('ms_eva_module', 'zero-g / underwater flight'),
  narrative('ms_technophile_1', 'custom NHP personality'),
  narrative('ms_technophile_2', 'custom NHP personality'),
  {
    id: 'ms_custom_paint_job', note: 'Scratched your paint (1/full repair)',
    onStructureDamage(b, u) {
      const s = sys(u, 'ms_custom_paint_job')
      if (!s || s.usesLeft === 0 || u.flags.paintUsed) return
      const r = b.rng.d(6)
      b.say(`${u.name}'s Custom Paint Job (${r})…`)
      // "you return to 1 HP and ignore the damage": no structure check follows (damage.ts reads structureIgnored)
      if (r === 6) { u.flags.paintUsed = true; if (s.usesLeft != null) s.usesLeft = 0; u.structure++; u.hp = 1; u.flags.structureIgnored = true; b.say('  …the hit only scratched the paint!') }
    },
  },
  {
    id: 'ms_pattern_a_smoke_charges', note: 'Smoke Grenade (Blast 2 soft cover until the end of your next turn); Smoke Mine (planted adjacent; when an ally moves next to it, Burst 3 soft cover until the end of that ally\'s next turn)',
    init: u => { const s = sys(u, 'ms_pattern_a_smoke_charges'); if (s) s.usesLeft = 3 + u.stats.limitedBonus },
    actions: (b, u) => {
      const s = sys(u, 'ms_pattern_a_smoke_charges')
      return [action({
        key: 'smoke-grenade', name: 'Smoke Grenade', activation: 'quick', target: 'tile', range: 5, area: { shape: 'blast', size: 2 },
        text: 'Blast 2 within range 5: soft cover until the end of your next turn.', usable: () => usesOk(s),
        run: (bt, self, t) => { spend(s); bt.addArea({ kind: 'soft_cover', tiles: blastTiles(bt.map, t as Pos, 2), expiresRound: bt.round + 1, ownerId: self.id }) },
        aiScore: (bt, self) => (bt.round <= 2 ? 2 : 0.5),
      }), action({
        key: 'smoke-mine', name: 'Smoke Mine', activation: 'quick', target: 'tile', range: mineRange(u), area: { shape: 'blast', size: 3 },
        text: 'Plant a mine: when an ally moves next to it, Burst 3 of soft cover until the end of that ally\'s next turn.', usable: () => usesOk(s),
        run: (bt, self, t) => { bt.placeMine(self, t as Pos, { name: 'Smoke Mine', radius: 3, damage: [], trigger: 'ally', tag: 'smoke' }, { range: mineRange(self) }); spend(s) },
        aiScore: () => -1,
      })]
    },
    onMineDetonate(b, self, m, by) {
      if (m.tag !== 'smoke') return false
      const tiles = blastTiles(b.map, m.pos, 3)
      b.addArea({ kind: 'soft_cover', tiles, ownerId: self.id, ...(by ? { expiresAfterTurnOf: by.id, turnsLeft: by.activeTurn ? 2 : 1 } : { expiresRound: b.round + 1 }) })
      return true
    },
  },
  {
    id: 'ms_pattern_a_jericho_deployable_cover', note: 'Deploys two adjacent hard-cover sections (10 HP, evasion 5)',
    actions: (b, u) => {
      const live = b.alive().filter(d => d.ownerId === u.id && d.flags.dataName === 'Jericho Deployable Cover')
      if (live.length) return [action({
        key: 'jericho_pickup', name: 'Pick Up Jericho Cover', activation: 'full', target: 'none', text: 'Pick up both sections of cover (deploy them again later).',
        run: bt => { for (const d of live) bt.removeUnit(d, 'is picked up') },
        aiScore: () => -1,
      })]
      return [action({
        key: 'jericho', name: 'Deploy Jericho Cover', activation: 'quick', target: 'tile', range: 1,
        text: 'Two size-1 hard cover sections in free spaces adjacent to you and each other.',
        run: (bt, self, t) => {
          const p = t && 'x' in t ? t : (t as Unit).pos
          const d = Lancer.systems.get('ms_pattern_a_jericho_deployable_cover')!.deployables![0]
          const free = (q: Pos) => q.x >= 0 && q.y >= 0 && q.x < bt.map.w && q.y < bt.map.h && bt.map.tiles[q.y * bt.map.w + q.x].kind !== 'block' && !bt.alive().some(o => footprint(o).some(z => z.x === q.x && z.y === q.y))
          // adjacent to any space of your footprint (Size 2+ mechs too), and to each other
          const nextToMe = (q: Pos) => footprint(self).some(r => chebyshev(q, r) === 1)
          if (!nextToMe(p) || !free(p)) throw new Error('Choose a free adjacent space')
          const second = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]].map(([dx, dy]) => ({ x: p.x + dx, y: p.y + dy })).find(q => free(q) && nextToMe(q))
          for (const q of [p, second].filter(Boolean) as Pos[]) { const c = deployableUnit(self, { ...d, size: 1 }, q); c.flags.isCover = true; bt.spawn(c) }
          bt.say(`${self.name} deploys Jericho cover.`)
        },
        aiScore: () => 1.5,
      })]
    },
  },
  {
    id: 'ms_stable_structure', note: '+1 Accuracy on saves to avoid Prone or Knockback (any stat)',
    checkAccuracy: (_b, self, u, kind) => (u === self && kind === 'save' && (u.flags.saveAvoid === 'prone' || u.flags.saveAvoid === 'knockback') ? 1 : 0),
  },
  {
    id: 'ms_turret_drones', note: 'Turret drones + Turret Attack reaction (3 kinetic, no roll, ally within 10, needs line of sight; 1/round each)',
    actions: (b, u) => {
      const s = sys(u, 'ms_turret_drones')
      return [action({
        key: 'turret', name: 'Deploy Turret Drone', activation: 'quick', target: 'tile', range: u.stats.sensors,
        text: 'Attach a turret drone within sensors. When an ally within 10 of it hits, the turret attacks too.', usable: () => usesOk(s),
        run: (bt, self, t) => {
          spend(s)
          const d = Lancer.systems.get('ms_turret_drones')!.deployables![0]
          bt.spawn(deployableUnit(self, d, t as Pos))
        },
        aiScore: () => 2,
      })]
    },
    afterAnyAttack(b, self, ctx) {
      if (!ctx.hit || b.hostile(self, ctx.attacker) || ctx.target.destroyed || ctx.mode === 'secondary') return
      for (const d of b.alive().filter(d => d.ownerId === self.id && d.flags.dataName === 'Turret Drone')) {
        // "deals 3 Kinetic damage to their target, as long as it has line of sight": no attack roll
        if (b.distance(d, ctx.attacker) > 10 || !b.los(d, ctx.target) || !once(d, 'turret')) continue
        b.say(`${self.name}'s turret drone fires.`)
        b.applyDamage(ctx.target, [{ type: 'Kinetic', amount: 3 }], { source: self })
        if (ctx.target.destroyed) break
      }
    },
  },
  {
    id: 'ms_type_3_projected_shield', note: 'Project Shield',
    actions: (b, u) => [action({
      key: 'projshield', name: 'Project Shield', activation: 'protocol', target: 'unit',
      text: 'Nominate a character in line of sight: ranged and melee attacks between you and it gain +2 difficulty until the start of your next turn.',
      run: (bt, self, t) => {
        const target = t as Unit
        if (!target || !('id' in target) || target === self) throw new Error('Nominate another character')
        if (!bt.los(self, target)) throw new Error('No line of sight')
        self.flags.projShield = target.id
      },
      aiTarget: (bt, self) => hostile(bt, self).filter(h => bt.los(self, h)).sort((x, y) => bt.distance(self, x) - bt.distance(self, y))[0] ?? null,
      aiScore: () => 2,
    })],
    onTurnStart: (b, u) => { delete u.flags.projShield },
    beforeAnyAttack(b, self, ctx) {
      const s = self.flags.projShield
      // ranged or melee attacks only: tech attacks are unaffected
      if (s && !ctx.tech && ((ctx.attacker.id === s && ctx.target === self) || (ctx.attacker === self && ctx.target.id === s))) { ctx.difficulty += 2; ctx.reasons.push('Projected Shield -2') }
    },
  },
  {
    id: 'ms_rapid_burst_jump_jet_system', note: 'Fly when boosting',
    onAnyMovementAction: (b, self, mover, kind) => { if (mover === self && kind === 'boost' && !self.flags.noFly) { self.flying = true; self.flags.jumpJets = true } },
    onTurnEnd: (b, u) => { if (u.flags.jumpJets) { u.flying = false; delete u.flags.jumpJets } },
  },
  {
    id: 'ms_type_i_flight_system', note: 'Toggle flight; take size+1 heat at the end of turns you fly',
    actions: (b, u) => [action({
      key: 'flight', name: u.flying ? 'Land (flight off)' : 'Take Flight', activation: 'free', target: 'none', text: 'Count your movement as flying (size+1 heat at end of turn).',
      usable: (_bt, self) => (!self.flying && self.flags.noFly ? "Can't fly until the end of your next turn" : true),
      run: (bt, self) => { self.flying = !self.flying; self.flags.flightSystem = self.flying },
    })],
    onTurnEnd: (b, u) => { if (u.flying && u.flags.flightSystem) b.addHeat(u, Math.max(1, Math.floor(u.stats.size)) + 1) },
  },
  // ------------------------------------------------------------ IPS-N
  { id: 'ms_synthetic_muscle_netting', note: 'Ram/Grapple larger targets', init: u => { u.flags.muscleNet = true } },
  {
    id: 'ms_reinforced_cabling',
    note: 'Grapple Swing: 1/turn, instead of walking your standard move, fly your Speed in a straight line over a clear path to a free space; Drag Down: contested Hull check against a character within 5 and line of sight, the loser is knocked Prone',
    actions: (b, u) => [
      action({
        key: 'grappleswing', name: 'Grapple Swing', activation: 'free', target: 'tile', range: u.stats.speed,
        text: 'Use your standard move to fly your Speed in a straight line (orthogonal or diagonal) over a clear path, ending in a free space.',
        usable: (bt, self) => (self.flags['turn:swing'] ? 'Already used this turn' : self.moveLeft < self.stats.speed ? 'Use it instead of your standard move' : bt.canMove(self, 'standard')),
        run: (bt, self, t) => {
          const dest = t && 'x' in t ? t : (t as Unit).pos
          const dx = dest.x - self.pos.x, dy = dest.y - self.pos.y
          const n = Math.max(Math.abs(dx), Math.abs(dy))
          if (!n || (dx && dy && Math.abs(dx) !== Math.abs(dy))) throw new Error('Must be a straight line')
          if (n > self.stats.speed) throw new Error('Too far')
          const sx = Math.sign(dx), sy = Math.sign(dy)
          const path: Pos[] = [{ ...self.pos }]
          for (let k = 1; k <= n; k++) {
            const p = { x: self.pos.x + sx * k, y: self.pos.y + sy * k }
            if (bt.alive().some(o => o !== self && !o.flags.flat && footprint(o).some(q => footprint({ pos: p, stats: self.stats }).some(r => r.x === q.x && r.y === q.y)))) throw new Error('The path is not clear')
            path.push(p)
          }
          self.flags['turn:swing'] = true
          self.moveLeft = 0
          bt.say(`${self.name} swings on its cables.`)
          bt.moveAlong(self, path)
        },
        aiScore: () => -1,
      }),
      action({
        key: 'dragdown', name: 'Drag Down', activation: 'quick', target: 'enemy', range: 5, text: 'Contested Hull check vs a character within 5 and line of sight: the loser is knocked Prone.',
        run: (bt, self, t) => {
          const target = t as Unit
          if (bt.distance(self, target) > 5) throw new Error('Out of range')
          if (!bt.los(self, target)) throw new Error('No line of sight')
          const a = bt.rng.d(20) + self.stats.hull + accFor(bt, self), d = bt.rng.d(20) + target.stats.hull + accFor(bt, target)
          bt.say(`  Drag Down: ${a} vs ${d}`)
          // Armor-Lock Plating: a braced mech can't fail contested checks
          const iWin = target.flags.winContests ? false : self.flags.winContests ? true : a >= d
          bt.addStatus(iWin ? target : self, 'prone', 'until_cleared', self)
        },
        aiScore: () => 2,
      }),
    ],
  },
  {
    id: 'ms_argonaut_shield',
    note: 'Argonaut Shield: an adjacent character gains Resistance to all damage while it stays adjacent; you take half the damage it would take (before its Armor and Resistance)',
    actions: (b, u) => [action({
      key: 'argonaut', name: 'Argonaut Shield', activation: 'quick', target: 'ally', range: 1, text: 'An adjacent character gains Resistance to all damage while adjacent to you; you take half the damage it would take, before armor and resistance.',
      run: (bt, self, t) => {
        const w = t as Unit
        if (!w || w === self || !bt.adjacent(self, w)) throw new Error('Choose an adjacent character')
        self.flags.argonautWard = w.id
        bt.say(`${self.name} raises the Argonaut Shield over ${w.name}.`)
      },
      aiTarget: (bt, self) => bt.alive().filter(o => o !== self && !bt.hostile(self, o) && (o.kind === 'mech' || o.kind === 'npc') && bt.adjacent(self, o)).sort((x, y) => x.hp / x.stats.hp - y.hp / y.stats.hp)[0] ?? null,
      aiScore: () => 2,
    })],
    beforeAnyDamage(b, self, t, parts, opts) {
      if (self.flags.argonautWard !== t.id) return
      if (!b.adjacent(self, t)) { delete self.flags.argonautWard; return }
      const share = parts.filter(p => ['Kinetic', 'Explosive', 'Energy', 'Burn'].includes(p.type) && p.amount > 0).map(p => ({ type: p.type, amount: Math.ceil(p.amount / 2) }))
      opts.resistAll = true
      if (share.length && !self.flags.argonautTaking) {
        self.flags.argonautTaking = true
        try { b.applyDamage(self, share, { source: opts.source }) } finally { delete self.flags.argonautTaking }
      }
    },
    onAnyTurnStart(b, self) { const w = b.unit(self.flags.argonautWard); if (self.flags.argonautWard && (!w || w.destroyed || !b.adjacent(self, w))) delete self.flags.argonautWard },
  },
  {
    id: 'ms_aceso_stabilizer', note: 'Overshield grit+4 with immunity to Impaired/Jammed while it lasts',
    actions: (b, u) => {
      const s = sys(u, 'ms_aceso_stabilizer')
      return [action({
        key: 'aceso', name: 'Aceso Stabilizer', activation: 'quick', target: 'ally', range: 5, text: 'Allied mech gains overshield = grit + 4.', usable: () => usesOk(s),
        run: (bt, self, t) => {
          spend(s)
          const a = (t as Unit) ?? self
          a.overshield = Math.max(a.overshield, self.stats.grit + 4)
          for (const st of ['impaired', 'jammed'] as const) bt.removeStatus(a, st)
          a.flags.aceso = true
        },
      })]
    },
    // immunity to Impaired and Jammed for as long as the Aceso overshield lasts
    blockAnyStatus: (b, self, target, st) => !!target.flags.aceso && target.overshield > 0 && (st === 'impaired' || st === 'jammed'),
    blockStatus: (b, self, st) => !!self.flags.aceso && self.overshield > 0 && (st === 'impaired' || st === 'jammed'),
  },
  { id: 'ms_bulwark_mods', note: 'Ignore difficult terrain', init: u => { u.flags.ignoreDifficult = true } },
  {
    id: 'ms_ramjet',
    note: 'Ramjet (protocol): until your next turn, Boost +2 and melee attacks (Ram and Grapple too) gain Knockback 2; every move must be your full Speed in a straight line, stopping early only at an obstruction or hostile',
    actions: (b, u) => [action({
      key: 'ramjet', name: 'Ramjet', activation: 'protocol', target: 'none', text: 'Until your next turn: Boost +2, melee Knockback 2; moves must be full-Speed straight lines (you may stop at an obstruction or hostile).',
      run: (bt, self) => { self.flags.ramjet = true; self.bonuses.push({ id: 'boost', val: 2, condition: '{ramjet}' }) },
    })],
    onTurnStart: (b, u) => { if (u.flags.ramjet) { delete u.flags.ramjet; u.bonuses = u.bonuses.filter(x => x.condition !== '{ramjet}') } },
    straightMovesOnly: (_b, self) => !!self.flags.ramjet,
    validateMove(b, self, dest, path) {
      if (!self.flags.ramjet || self.flags.teleportMoves) return true
      const sx = Math.sign(dest.x - self.pos.x), sy = Math.sign(dest.y - self.pos.y)
      const n = path.length - 1
      // stopping short of your full Speed is allowed only against an obstruction, a hostile or the map edge
      const next = { x: dest.x + sx, y: dest.y + sy }
      const tile = next.x >= 0 && next.y >= 0 && next.x < b.map.w && next.y < b.map.h ? b.map.tiles[next.y * b.map.w + next.x] : undefined
      const blocked = !tile || tile.kind === 'block' || b.alive().some(o => o !== self && footprint(o).some(q => q.x === next.x && q.y === next.y))
      const full = Math.min(self.stats.speed, self.moveLeft + (self.flags['turn:moved'] ? 0 : 0))
      if (n < full && !blocked) return `Ramjet: move your full Speed (${full}) unless something blocks you`
      return true
    },
    afterAttack(b, self, ctx, role) { if (role === 'attacker' && self.flags.ramjet && ctx.melee && ctx.hit && !ctx.target.destroyed) b.forceMove(ctx.target, self, b.knockbackDistance(self, 2, ctx.weapon), 1) },
  },
  {
    id: 'ms_roland_chamber', note: 'After reloading: next Loading weapon hit +1d6 explosive and Hull save vs Prone',
    beforeAttack(b, self, ctx, role) {
      if (role !== 'attacker' || !ctx.profile?.tags.some(t => t.id === 'tg_loading')) return
      takeReload(self) // its own window, separate from the Mjolnir's free shot
      if (self.flags.rolandReady) { ctx.bonusDamage.push({ type: 'Explosive', val: '1d6' }); self.flags.roland = true; delete self.flags.rolandReady }
    },
    afterAttack(b, self, ctx, role) {
      if (role === 'attacker' && self.flags.roland) { delete self.flags.roland; if (ctx.hit && !ctx.target.destroyed && !saveAvoiding(b, ctx.target, 'hull', self.stats.save, self, 'prone')) b.addStatus(ctx.target, 'prone', 'until_cleared', self) }
    },
  },
  {
    id: 'ms_siege_ram', note: 'Ram deals 2 kinetic (10 AP kinetic to objects)',
    afterAttack(b, self, ctx, role) {
      if (role !== 'attacker' || ctx.mode !== 'ram' || !ctx.hit) return
      const object = ctx.target.kind === 'deployable'
      b.applyDamage(ctx.target, [{ type: 'Kinetic', amount: object ? 10 : 2 }], { source: self, ap: object })
    },
  },
  {
    id: 'ms_hyperdense_armor', note: 'HyperDense Armor (quick toggle): Resistance to damage, heat and burn from attacks originating beyond range 3; you are Slowed and deal half damage, heat and burn to characters beyond range 3',
    actions: (b, u) => [action({
      key: u.flags.hyperdense ? 'hyperdense_off' : 'hyperdense', name: u.flags.hyperdense ? 'Deactivate HyperDense Armor' : 'HyperDense Armor', activation: 'quick', target: 'none',
      text: u.flags.hyperdense ? 'Lose the Resistance, clear Slowed and deal normal damage again.' : 'Resistance to all damage, heat and burn from attacks originating beyond range 3; you become Slowed and deal half damage, heat and burn to characters beyond range 3.',
      run: (bt, self) => {
        self.flags.hyperdense = !self.flags.hyperdense
        if (self.flags.hyperdense) bt.addStatus(self, 'slowed', 'until_cleared', self, { hyperdense: true })
        else if (self.statuses.some(s => s.id === 'slowed' && s.data?.hyperdense)) {
          if (self.statuses.some(s => s.id === 'slowed' && !s.data?.hyperdense)) self.statuses = self.statuses.filter(s => !s.data?.hyperdense)
          else bt.removeStatus(self, 'slowed')
        }
      },
    })],
    grantsResistance: (b, self, _type, d) => !!self.flags.hyperdense && !!d.attack && b.distance(self, d.attack.attacker) > 3,
    // your own damage, heat and burn to characters beyond range 3 is halved
    beforeAnyDamage(b, self, t, parts, opts) {
      if (!self.flags.hyperdense || (opts.attack?.attacker ?? opts.source) !== self || t === self || (t.kind !== 'mech' && t.kind !== 'npc' && t.kind !== 'drone') || b.distance(self, t) <= 3) return
      for (const p of parts) if (['Kinetic', 'Explosive', 'Energy', 'Variable', 'Heat', 'Burn'].includes(p.type)) p.amount = Math.ceil(p.amount / 2)
    },
  },
  {
    id: 'ms_webjaw_snare', note: 'Webjaw Snare: an adjacent Deployable (10 HP, Evasion 5) that doesn\'t obstruct and can\'t be attacked until triggered; a hostile moving over it saves (Hull) or takes 1d6 AP kinetic and is Immobilized until the snare is destroyed',
    actions: (b, u) => {
      const s = sys(u, 'ms_webjaw_snare')
      return [action({
        key: 'webjaw', name: 'Deploy Webjaw Snare', activation: 'quick', target: 'tile', range: 1, text: 'An adjacent snare: a hostile that moves over it saves (Hull) or takes 1d6 AP kinetic and is Immobilized until the snare is destroyed.', usable: () => usesOk(s),
        run: (bt, self, t) => {
          const p = t as Pos
          if (Math.max(Math.abs(p.x - self.pos.x), Math.abs(p.y - self.pos.y)) > 1 && !footprint(self).some(q => chebyshev(q, p) === 1)) throw new Error('Must be adjacent')
          if (bt.alive().some(o => footprint(o).some(q => q.x === p.x && q.y === p.y))) throw new Error('Space occupied')
          const d = deployableUnit(self, { name: 'Webjaw Snare', type: 'Deployable', size: 1, hp: 10, evasion: 5 } as any, p)
          d.flags.flat = true
          d.flags.isCover = false
          d.flags.intangible = true // can't be attacked until triggered
          d.flags.webjaw = true
          d.flags.armed = !self.activeTurn // "it arms at the end of your turn"
          bt.spawn(d)
          spend(s)
          bt.say(`${self.name} sets a Webjaw Snare${d.flags.armed ? '' : ' (it arms at the end of the turn)'}.`)
        },
      })]
    },
    onTurnEnd(b, self) { for (const d of b.alive().filter(o => o.ownerId === self.id && o.flags.webjaw)) d.flags.armed = true },
    // owner's ruling: like mines, the owner's own side never springs it
    onMove(b, self, mover, path) {
      if (mover.kind !== 'mech' && mover.kind !== 'npc' || !b.hostile(self, mover) || mover.destroyed) return
      for (const d of b.alive().filter(o => o.ownerId === self.id && o.flags.webjaw && o.flags.intangible && o.flags.armed)) {
        if (!path.slice(1).some(p => footprint({ pos: p, stats: mover.stats }).some(q => q.x === d.pos.x && q.y === d.pos.y))) continue
        d.flags.intangible = false
        b.say(`${mover.name} springs the Webjaw Snare!`, 'attack')
        if (!b.save(mover, 'hull', self.stats.save, 0, self)) {
          b.applyDamage(mover, [{ type: 'Kinetic', amount: rollDice(b.rng, '1d6').total }], { source: self, ap: true })
          if (!mover.destroyed) b.addStatus(mover, 'immobilized', 'until_cleared', self, { snare: d.id })
        }
        return
      }
    },
    onDestroyed(b, self, v) { if (v.flags.webjaw) for (const u of b.alive()) u.statuses = u.statuses.filter(st => st.data?.snare !== v.id) },
  },
  {
    id: 'ms_caltrop_launcher', note: 'Caltrop Launcher: a Burst 1 area within range 5 becomes difficult terrain for the scene; mechs take 1d3 AP explosive when they enter it for the first time in a round or end their turn in it',
    actions: (b, u) => {
      const s = sys(u, 'ms_caltrop_launcher')
      return [action({
        key: 'caltrops', name: 'Caltrop Launcher', activation: 'quick', target: 'tile', range: 5, area: { shape: 'blast', size: 1 }, text: 'Difficult terrain for the scene; mechs take 1d3 AP explosive when they first enter it in a round or end their turn in it.', usable: () => usesOk(s),
        run: (bt, self, t) => {
          const p = t && 'x' in t ? t : (t as Unit).pos
          if (distanceToTile(bt.map, self, p) > 5) throw new Error('Out of range (5)')
          spend(s)
          // its own tag: Whitewash (which puts out fires) leaves it alone
          bt.addArea({ kind: 'difficult', tiles: blastTiles(bt.map, p, 1), ownerId: self.id, tag: 'caltrops' })
        },
      })]
    },
    // "mechs take 1d3 AP Explosive Damage when they enter the affected area for the first time in a round or end their turn within it"
    onMove(b, self, mover, path) {
      if (mover.kind !== 'mech' || mover.destroyed || mover.flying) return
      for (const a of caltropAreas(b, self)) {
        const inA = (p: Pos) => footprint({ pos: p, stats: mover.stats }).some(q => a.tiles.some(t => t.x === q.x && t.y === q.y))
        if (!path.some((p, i) => i > 0 && inA(p) && !inA(path[i - 1])) || !once(mover, `caltrops:${a.id}`)) continue
        b.say(`${mover.name} runs into caltrops.`, 'damage')
        b.applyDamage(mover, [{ type: 'Explosive', amount: rollDice(b.rng, '1d3').total }], { source: self, ap: true })
        if (mover.destroyed) return
      }
    },
    onAnyTurnEnd: (b, self, u) => caltropTurnEnd(b, self, u),
    onTurnEnd: (b, self) => caltropTurnEnd(b, self, self),
  },
  {
    id: 'ms_charged_stake', note: 'Charged Stake (full): adjacent target saves (Hull) or is impaled — 1d6 AP energy and Immobilized, 1d6 AP energy at the end of each of its turns; it repeats the save as a full action to pull the stake out (the only way to end it); one impaled character at a time',
    actions: (b, u) => [action({
      key: 'stake', name: 'Charged Stake', activation: 'full', target: 'enemy', range: 1, text: 'Adjacent target: Hull save or impaled (1d6 AP energy, Immobilized, 1d6 AP energy at the end of each of its turns until it pulls the stake out).',
      run: (bt, self, t) => {
        const target = t as Unit
        if (!bt.adjacent(self, target)) throw new Error('Must be adjacent')
        if (bt.save(target, 'hull', self.stats.save, 0, self)) return
        // "You can only affect one character with the stake at a time"
        for (const o of bt.units) if (o !== target && o.flags.impaledBy === self.id) unstake(bt, o)
        bt.applyDamage(target, [{ type: 'Energy', amount: rollDice(bt.rng, '1d6').total }], { source: self, ap: true })
        if (target.destroyed) return
        bt.addStatus(target, 'immobilized', 'until_cleared', self, { stake: self.id })
        target.flags.impaledBy = self.id
      },
      aiScore: () => 5,
    })],
    onAnyTurnEnd(b, self, u) {
      if (u.flags.impaledBy !== self.id || u.destroyed) return
      b.applyDamage(u, [{ type: 'Energy', amount: rollDice(b.rng, '1d6').total }], { source: self, ap: true })
    },
    grantActions: (b, self, other) => (other.flags.impaledBy === self.id ? [action({
      key: `unstake:${self.id}`, name: 'Pull Out the Stake', activation: 'full', target: 'none', text: `Hull save (vs ${self.stats.save}) to remove the stake and end the Immobilized.`,
      run: (bt, me) => { if (bt.save(me, 'hull', self.stats.save, 0, self)) { unstake(bt, me); bt.say(`${me.name} tears the stake free.`) } },
      aiTarget: (_bt, me) => ({ ...me.pos }),
      aiScore: () => 3,
    })] : []),
    onDestroyed(b, self, v) { if (v === self) for (const o of b.units) if (o.flags.impaledBy === self.id) unstake(b, o) },
  },
  // ------------------------------------------------------------ SSC
  {
    id: 'ms_ferrous_lash', note: 'Ferrous Lash (quick, range 8 and line of sight): pull an ally 5 spaces in any direction, or a hostile that fails an Agility save 5 spaces in a direction you choose (ignores engagement, no reactions); a hostile that collides with an obstruction or another mech stops and is knocked Prone',
    actions: (b, u) => [action({
      key: 'lash', name: 'Ferrous Lash', activation: 'quick', target: 'unit', range: 8, text: 'Pull an ally 5 spaces in any direction, or a hostile on a failed Agility save in a direction you choose (Prone if it collides).',
      run: (bt, self, t) => {
        const target = t as Unit
        if (!target || target === self || bt.distance(self, target) > 8 || !bt.los(self, target)) throw new Error('Out of range/LoS')
        const foe = bt.hostile(self, target)
        if (foe && bt.save(target, 'agi', self.stats.save, 0, self)) return
        const opts = [...DIR8_NAMES.map(n => ({ label: `Pull ${n}` })), ...(foe ? [] : [{ label: "Don't move it" }])]
        const i = bt.choose({ kind: 'ferrous_lash', unit: self, title: `Ferrous Lash: pull ${target.name}`, options: opts, defaultIndex: dirIndex(target.pos, self.pos) })
        if (i >= 8) return
        const d = DIR8[i]
        const from = { ...target.pos }
        bt.forceMove(target, { x: target.pos.x - d[0] * 50, y: target.pos.y - d[1] * 50 }, 5, 1)
        // stopped short by an obstruction or another mech: knocked Prone
        if (foe && !target.destroyed && Math.max(Math.abs(target.pos.x - from.x), Math.abs(target.pos.y - from.y)) < 5) bt.addStatus(target, 'prone', 'until_cleared', self)
      },
      aiScore: () => 1.5,
    })],
  },
  {
    id: 'ms_black_ice_module', note: 'Escalating tech difficulty vs you/adjacent allies',
    beforeAnyAttack(b, self, ctx) {
      if (!ctx.tech || !b.hostile(self, ctx.attacker) || (ctx.target !== self && (b.hostile(self, ctx.target) || !b.adjacent(self, ctx.target)))) return
      let n = (self.flags.blackIce ?? 0) + 1
      if (n > 3) n = 1
      self.flags.blackIce = n
      ctx.difficulty += n
      ctx.reasons.push(`Black ICE -${n}`)
    },
  },
  { id: 'ms_high_stress_mag_clamps', note: 'Climb walls as flat ground', init: u => { u.flags.magClamps = true } },
  {
    id: 'ms_tracking_bug', note: 'Tracking Bug (quick tech): on a hit the target can\'t Hide and you ignore its Invisible for the scene; it removes the bug with an Engineering check as a quick action',
    actions: (b, u) => [action({
      key: 'trackbug', name: 'Tracking Bug', activation: 'quick_tech', target: 'enemy', range: u.stats.sensors, text: 'Tech attack: the target cannot Hide and you ignore its Invisible.',
      run: (bt, self, t) => {
        const target = t as Unit
        const v = bt.techTargetValid(self, target)
        if (v !== true) throw new Error(v)
        const c = bt.techAttackRoll(self, target, 'Tracking Bug')
        if (c.hit) { target.flags.trackedBy = self.id; bt.removeStatus(target, 'hidden') }
      },
    })],
    grantActions: (b, self, other) => (other.flags.trackedBy === self.id ? [action({
      key: `untrack:${self.id}`, name: 'Remove Tracking Bug', activation: 'quick', target: 'none', text: 'Engineering check: on a success the tracking bug is removed.',
      run: (bt, me) => { if (bt.check(me, 'eng')) { delete me.flags.trackedBy; bt.say(`${me.name} pries off the tracking bug.`) } },
      aiTarget: (_bt, me) => ({ ...me.pos }),
      aiScore: () => 1,
    })] : []),
  },
  {
    id: 'ms_core_siphon', note: '+1 acc first attack, +1 diff on the rest this turn',
    actions: (b, u) => [action({
      key: 'siphon', name: 'Core Siphon', activation: 'protocol', target: 'none', text: '+1 accuracy on your first attack this turn, +1 difficulty on the others.',
      run: (bt, self) => { self.flags['turn:siphon'] = 1 },
    })],
    beforeAttack(b, self, ctx, role) {
      if (role !== 'attacker' || !self.flags['turn:siphon']) return
      if (self.flags['turn:siphon'] === 1) { ctx.accuracy++; self.flags['turn:siphon'] = 2 } else ctx.difficulty++
    },
  },
  {
    id: 'ms_kinetic_compensator', note: '+1 acc on the next ranged attack after a ranged miss',
    beforeAttack(b, self, ctx, role) { if (role === 'attacker' && ctx.ranged && self.flags.kcomp) { ctx.accuracy++; delete self.flags.kcomp; ctx.reasons.push('Kinetic Compensator +1') } },
    afterAttack(b, self, ctx, role) { if (role === 'attacker' && ctx.ranged && !ctx.hit) self.flags.kcomp = true },
  },
  {
    id: 'ms_neurospike', note: 'Neurospike invades: Shrike Code (until the end of its next turn the target first takes 2 heat whenever it attacks — once per attack); Mirage (the target treats you or an ally you choose as Invisible until the end of its next turn)',
    actions: (b, u) => [
      invade('neurospike', 'Shrike Code', 'Target takes 2 heat whenever it attacks until the end of its next turn.', (bt, self, t) => { t.flags[`shrike:${self.id}`] = nextTurnEnds(t) })(b, u),
      invade('neurospike', 'Mirage', 'The target treats you or an ally of your choice as Invisible until the end of its next turn.', (bt, self, t) => {
        const who = [self, ...bt.alive().filter(o => o !== self && o !== t && (o.kind === 'mech' || o.kind === 'npc') && !bt.hostile(self, o))]
        const i = who.length > 1 ? bt.choose({ kind: 'mirage', unit: self, title: 'Mirage: who is hidden from it?', options: who.map(o => ({ label: o === self ? 'Yourself' : o.name })), defaultIndex: 0 }) : 0
        t.flags[`mirage:${self.id}`] = { protect: who[i].id, turns: nextTurnEnds(t) }
      })(b, u),
    ],
    beforeAnyAttack(b, self, ctx) {
      // "they first take 2 heat whenever they attack": once per attack, not once per target of an area attack
      if (!b.previewing && ctx.attacker.flags[`shrike:${self.id}`] && newAttack(b, ctx)) b.applyDamage(ctx.attacker, [{ type: 'Heat', amount: 2 }], { source: self })
      const m = ctx.attacker.flags[`mirage:${self.id}`]
      if (m && ctx.target.id === m.protect) ctx.forceInvisible = true
    },
    onAnyTurnEnd(b, self, u) {
      if (u.flags[`shrike:${self.id}`] && --u.flags[`shrike:${self.id}`] <= 0) delete u.flags[`shrike:${self.id}`]
      const m = u.flags[`mirage:${self.id}`]
      if (m && --m.turns <= 0) delete u.flags[`mirage:${self.id}`]
    },
  },
  {
    id: 'ms_stuncrown', note: 'Burst 3 flash: Agility save vs Jammed, Systems save vs Impaired',
    actions: (b, u) => {
      const s = sys(u, 'ms_stuncrown')
      return [action({
        key: 'stuncrown', name: 'Stuncrown', activation: 'quick', target: 'self', area: { shape: 'burst', size: 3 }, text: 'Hostiles in burst 3 with LoS: Agility save or Jammed; Systems save or Impaired.', usable: () => usesOk(s),
        run: (bt, self) => {
          spend(s)
          for (const t of unitsOnTiles(bt.alive(), burstTiles(bt.map, self, 3))) {
            if (!bt.hostile(self, t) || !bt.los(t, self) || bt.cover(self, t) !== 'none') continue
            if (!bt.save(t, 'agi', self.stats.save, 0, self)) bt.addStatus(t, 'jammed', 'next_turn_end_target', self)
            if (!bt.save(t, 'sys', self.stats.save, 0, self)) bt.addStatus(t, 'impaired', 'next_turn_end_target', self)
          }
        },
        aiScore: (bt, self) => hostile(bt, self).filter(h => bt.distance(self, h) <= 3).length * 3,
      })]
    },
  },
  {
    id: 'ms_reactive_weave', note: 'Reactive Weave: when you Brace you become Invisible until the end of your next turn and may immediately move your Speed',
    onStatusAdded(b, self, st) {
      if (st !== 'braced' || self.destroyed) return
      b.addStatus(self, 'invisible', 'next_turn_end_target', self)
      if (b.canMove(self, 'free') !== true || self.stats.speed <= 0) return
      const foe = hostile(b, self).sort((x, y) => b.distance(self, x) - b.distance(self, y))[0]
      if (!foe) return
      const i = b.choose({ kind: 'reactive_weave', unit: self, title: 'Reactive Weave: move your Speed?', options: [{ label: `Move away from ${foe.name}`, hint: `up to ${self.stats.speed} spaces` }, { label: 'Stay' }], defaultIndex: 0 })
      if (i !== 0) return
      const best = [...b.reachable(self, self.stats.speed).values()].sort((x, y) => chebyshev(y.pos, foe.pos) - chebyshev(x.pos, foe.pos))[0]
      if (!best || (best.pos.x === self.pos.x && best.pos.y === self.pos.y)) return
      self.flags.pendingMove = self.stats.speed
      try { b.move(self, best.pos, { mode: 'free' }) } catch (e) { if (e instanceof PendingChoice) throw e } finally { delete self.flags.pendingMove }
    },
  },
  {
    id: 'ms_active_camouflage', note: 'Invisible until damaged or end of next turn',
    actions: (b, u) => [action({ key: 'camo', name: 'Active Camouflage', activation: 'protocol', target: 'none', text: 'Invisible until you take damage or the end of your next turn.', run: (bt, self) => { bt.addStatus(self, 'invisible', 'next_turn_end_target', self, { camo: true }) }, aiScore: () => 2 })],
    onDamaged(b, self) { if (self.statuses.some(s => s.id === 'invisible' && s.data?.camo)) b.removeStatus(self, 'invisible') },
  },
  {
    id: 'ms_markerlight',
    note: 'Markerlight (full tech): 2 heat, Lock On, no soft cover until the Lock On clears; once before your next turn, when an ally hits the target, you may declare a weak spot (reaction): the hit becomes a critical',
    actions: (b, u) => [action({
      key: 'markerlight', name: 'Markerlight', activation: 'full_tech', target: 'enemy', range: u.stats.sensors, text: 'Tech attack: 2 heat, Lock On, target loses soft cover until the Lock On is cleared; you may turn one ally hit on it into a critical before your next turn.',
      run: (bt, self, t) => {
        const target = t as Unit
        const v = bt.techTargetValid(self, target)
        if (v !== true) throw new Error(v)
        if (!bt.los(self, target) && !bt.viaMetahook(self, target)) throw new Error('No line of sight')
        const c = bt.techAttackRoll(self, target, 'Markerlight')
        if (c.hit) {
          bt.applyDamage(target, [{ type: 'Heat', amount: 2 }], { source: self })
          bt.addStatus(target, 'lockon', 'until_cleared', self)
          target.flags.markerlit = true
          self.flags.markerTarget = target.id
        }
      },
      aiScore: () => 4,
    })],
    onTurnStart: (b, u) => { delete u.flags.markerTarget },
    afterAnyRoll(b, self, ctx) {
      if (self.flags.markerTarget !== ctx.target.id || !ctx.hit || ctx.crit || ctx.tech || ctx.attacker === self || b.hostile(self, ctx.attacker) || !ctx.attacker.canCrit) return
      if (b.canSpend(self, 'reaction') !== true) return
      if (!b.offerReaction(self, 'markerlight', 'Weak spot?', `${ctx.attacker.name} hit ${ctx.target.name}. Spend ${self.name}'s reaction to make it a critical hit?`)) return
      b.spend(self, 'reaction') // through spend(): reveals Hidden, ends Ghostweave, runs onAnyAction hooks
      delete self.flags.markerTarget
      ctx.crit = true
      b.say(`  ${self.name} marks a weak spot: CRITICAL HIT!`, 'attack')
    },
    adjustCover: (b, self, attacker, target, c) => (target.flags.markerlit && b.has(target, 'lockon') && c === 'soft' ? 'none' : c),
  },
  {
    id: 'ms_hunter_logic_suite', note: 'Hunter Logic Suite invades: Stalk Prey (the target treats you as Invisible until you next take damage from it; one target at a time); Terrify (Impaired, and no voluntary movement that brings it closer to you, until the end of its next turn)',
    actions: (b, u) => [
      invade('hls', 'Stalk Prey', 'The target treats you as Invisible until it damages you (one target at a time).', (bt, self, t) => {
        for (const o of bt.units) delete o.flags[`stalked:${self.id}`]
        t.flags[`stalked:${self.id}`] = true
      })(b, u),
      invade('hls', 'Terrify', 'Impaired until the end of its next turn, and it can\'t voluntarily move closer to you.', (bt, self, t) => {
        bt.addStatus(t, 'impaired', 'next_turn_end_target', self)
        t.flags[`terrified:${self.id}`] = nextTurnEnds(t)
      })(b, u),
    ],
    beforeAnyAttack(b, self, ctx) { if (ctx.target === self && ctx.attacker.flags[`stalked:${self.id}`]) ctx.forceInvisible = true },
    onDamaged(b, self, d) { if (d.source) delete d.source.flags[`stalked:${self.id}`] },
    validateAnyMove(b, self, mover, dest, mode) {
      if (!mover.flags[`terrified:${self.id}`] || mode === 'involuntary') return true
      return b.distance({ ...mover, pos: dest } as Unit, self) < b.distance(mover, self) ? `Terrified: can't move closer to ${self.name}` : true
    },
    onAnyTurnEnd(b, self, u) { if (u.flags[`terrified:${self.id}`] && --u.flags[`terrified:${self.id}`] <= 0) delete u.flags[`terrified:${self.id}`] },
  },
  {
    id: 'ms_singularity_motivator', note: 'Exposed Singularity (reaction, 1/round): when your mech takes damage, you may teleport to a free space within 1d6',
    onDamaged(b, self, d) {
      if (d.kind !== 'hp' || d.amount <= 0 || self.destroyed || b.canSpend(self, 'reaction', 'singularity') !== true) return
      const src = d.attack?.attacker ?? d.source
      if (!b.offerReaction(self, 'singularity', 'Exposed Singularity?', `${self.name} took damage. Spend a reaction to teleport up to 1d6 spaces${src ? ` away from ${src.name}` : ''}?`)) return
      b.spend(self, 'reaction', 'singularity')
      const n = b.rng.d(6)
      const away = src && src !== self ? src.pos : self.pos
      const dest = farthestFree(b, self, away, n, p => fits(b, self, p) && !b.teleportBlocked(self, p) && !b.endBlocked(self, p))
      if (!dest) { b.say(`  ${self.name} finds no space to teleport to.`); return }
      const from = { ...self.pos }
      self.pos = dest
      b.emit({ type: 'move', unitId: self.id, path: [from, dest] })
      b.invalidateTerrain()
      b.say(`  ${self.name} blinks ${chebyshev(from, dest)} spaces (Exposed Singularity, ${n}).`)
    },
  },
  {
    id: 'ms_lb_oc_cloaking_field',
    note: 'LB/OC Cloaking Field: you are Slowed; you and allies completely inside a Burst 2 are Invisible; lasts until the end of your next turn or until you are Stunned, take damage or deactivate it (quick)',
    fields: (b, u) => (u.flags.lboc ? [{ tiles: burstTiles(b.map, u, 2), effect: 'protect' as const, label: `${u.name}'s cloaking field: allies wholly inside are Invisible` }] : []),
    actions: (b, u) => [action({
      key: 'lboc', name: u.flags.lboc ? 'Deactivate Cloaking Field' : 'LB/OC Cloaking Field', activation: 'quick', target: 'none', text: u.flags.lboc ? 'End the cloaking field.' : 'You are Slowed; you and allies wholly inside burst 2 are Invisible until the end of your next turn.',
      run: (bt, self) => { if (self.flags.lboc) lbocOff(bt, self); else { self.flags.lboc = { turns: 2 }; bt.addStatus(self, 'slowed', 'until_cleared', self, { lboc: true }); lbocSync(bt, self) } },
      aiScore: (bt, self) => (self.flags.lboc ? -1 : 2),
    })],
    onMove: (b, self) => lbocSync(b, self),
    onAnyTurnStart: (b, self) => lbocSync(b, self),
    onTurnStart: (b, self) => lbocSync(b, self),
    onTurnEnd(b, self) { if (self.flags.lboc && --self.flags.lboc.turns <= 0) lbocOff(b, self) },
    onDamaged(b, self, d) { if (self.flags.lboc && d.amount > 0 && d.kind === 'hp') lbocOff(b, self) },
    onStatusAdded(b, self, st) { if (st === 'stunned' && self.flags.lboc) lbocOff(b, self) },
  },
  // ------------------------------------------------------------ HORUS
  { id: 'ms_scanner_swarm', note: '+1 acc on tech vs adjacent', beforeAttack(b, self, ctx, role) { if (role === 'attacker' && ctx.tech && b.adjacent(self, ctx.target)) ctx.accuracy++ } },
  {
    id: 'ms_h0r_os_system_upgrade_i', note: 'H0R_OS I invades: Puppet System (the target moves its Speed in a direction you choose — into hazards too; involuntary, but it provokes reactions and Engagement as normal and is not a push or pull); Eject Power Cores (Jammed until the end of its next turn, adjacent characters take 2 energy; 1/scene per target)',
    actions: (b, u) => [
      invade('horos1', 'Puppet System', 'The target moves its Speed in a direction you choose (involuntary, but provokes reactions and Engagement).', (bt, self, t) => {
        const i = bt.choose({ kind: 'puppet_system', unit: self, title: `Puppet System: move ${t.name}`, options: DIR8_NAMES.map(n => ({ label: n })), defaultIndex: dirIndex(self.pos, t.pos) })
        puppetMove(bt, t, DIR8[i])
      })(b, u),
      invade('horos1', 'Eject Power Cores', 'Jammed until end of next turn; adjacent characters take 2 energy (1/scene per target).', (bt, self, t) => {
        if (t.flags.ejected) return
        t.flags.ejected = true
        bt.addStatus(t, 'jammed', 'next_turn_end_target', self)
        for (const o of bt.alive()) if (o !== t && bt.adjacent(o, t)) bt.applyDamage(o, [{ type: 'Energy', amount: 2 }], { source: self })
      })(b, u),
    ],
  },
  {
    id: 'ms_metahook',
    note: 'Metahook (quick tech): link with an ally within Sensors and line of sight while it stays there: your tech actions can use its Sensors and line of sight, it uses your Systems for checks and saves, and heat or conditions either of you takes are taken by the other; one link at a time',
    actions: (b, u) => [action({
      key: 'metahook', name: u.flags.metahook ? 'Metahook (relink)' : 'Metahook', activation: 'quick_tech', target: 'ally', range: u.stats.sensors, text: 'Link systems with an ally within Sensors and line of sight.',
      run: (bt, self, t) => {
        const a = t as Unit
        if (!a || a === self || bt.hostile(self, a)) throw new Error('Choose an ally')
        if (bt.distance(self, a) > self.stats.sensors || !bt.los(self, a)) throw new Error('Needs Sensors range and line of sight')
        metaUnlink(bt, self)
        self.flags.metahook = a.id
        a.flags.metaOrigSys = a.stats.sys
        a.stats.sys = Math.max(a.stats.sys, self.stats.sys)
        bt.say(`${self.name} links systems with ${a.name}.`)
      },
      aiScore: () => -1,
    })],
    onMove: (b, self) => metaCheck(b, self),
    onAnyTurnStart: (b, self) => metaCheck(b, self),
    onHeat(b, self, amount) { const a = b.unit(self.flags.metahook); if (a && !self.flags.metaSync) { self.flags.metaSync = true; try { b.addHeat(a, amount) } finally { delete self.flags.metaSync } } },
    onAnyHeat(b, self, t, amount) { if (t.id === self.flags.metahook && !self.flags.metaSync) { self.flags.metaSync = true; try { b.addHeat(self, amount) } finally { delete self.flags.metaSync } } },
    onStatusAdded(b, self, st, dur, src) { const a = b.unit(self.flags.metahook); if (a && META_CONDITIONS.includes(st)) b.addStatus(a, st, dur, src) },
    onAnyStatusAdded(b, self, t, st, dur, src) { if (t.id === self.flags.metahook && META_CONDITIONS.includes(st)) b.addStatus(self, st, dur, src) },
    onDestroyed(b, self, v) { if (v.id === self.flags.metahook || v === self) metaUnlink(b, self) },
  },
  {
    id: 'ms_osiris_class_nhp',
    note: 'Hurl Into the Duat (quick tech, 1/round; Gate progress persists between scenes until a rest or Full Repair): 2 heat and the next Gate in turn — I: you steer its next standard move; II: Slowed and Impaired; III: Stunned (until the end of its next turn); IV: it fights for your side until the end of its next turn (ends if your side harms, attacks or forces a save on it)',
    actions: (b, u) => [action({
      key: 'duat', name: `Hurl Into the Duat (Gate ${['I', 'II', 'III', 'IV'][u.flags.duatGate ?? 0]})`, activation: 'quick_tech', target: 'enemy', range: u.stats.sensors, text: 'Tech attack: 2 heat and the next Gate effect.',
      usable: (bt, self) => (self.flags['round:duat'] ? 'Once per round' : true),
      run: (bt, self, t) => {
        const target = t as Unit
        const v = bt.techTargetValid(self, target)
        if (v !== true) throw new Error(v)
        self.flags['round:duat'] = true
        const c = bt.techAttackRoll(self, target, 'Hurl Into the Duat')
        if (!c.hit || target.destroyed) return
        bt.applyDamage(target, [{ type: 'Heat', amount: 2 }], { source: self })
        if (target.destroyed) return
        const gate = self.flags.duatGate ?? 0
        self.flags.duatGate = (gate + 1) % 4
        if (gate === 0) { target.flags.duatSteer = self.id; bt.say(`  First Gate: ${self.name} controls ${target.name}'s next standard move.`) }
        else if (gate === 1) { bt.addStatus(target, 'slowed', 'next_turn_end_target', self); bt.addStatus(target, 'impaired', 'next_turn_end_target', self) }
        else if (gate === 2) bt.addStatus(target, 'stunned', 'next_turn_end_target', self)
        else turnTarget(bt, self, target)
      },
      aiScore: () => 4,
    })],
    onAnyTurnStart(b, self, u) {
      if (u.flags.duatSteer !== self.id) return
      delete u.flags.duatSteer
      if (u.moveLeft <= 0 || b.canMove(u, 'standard') !== true) return
      const opts = [
        { label: 'Toward me', hint: `${u.name} walks its Speed toward ${self.name}`, to: self.pos, dir: -1 },
        { label: 'Away from me', hint: 'as far from you as it can', to: self.pos, dir: 1 },
        { label: 'Away from its allies', hint: 'strand it from its team', to: centroid(b.alive().filter(o => o !== u && !b.hostile(u, o) && o.kind !== 'deployable').map(o => o.pos), u.pos), dir: 1 },
        { label: 'Stay put', hint: 'it does not move', to: u.pos, dir: 0 },
      ]
      const i = b.choose({ kind: 'duat_steer', unit: self, title: `First Gate: steer ${u.name}`, options: opts.map(o => ({ label: o.label, hint: o.hint })), defaultIndex: 2 })
      const o = opts[i]
      const r = b.reachable(u, u.moveLeft)
      const score = (p: Pos) => Math.max(Math.abs(p.x - o.to.x), Math.abs(p.y - o.to.y)) * o.dir
      const best = o.dir === 0 ? null : [...r.values()].sort((x, y) => score(y.pos) - score(x.pos))[0]
      if (best && (best.pos.x !== u.pos.x || best.pos.y !== u.pos.y)) { b.say(`${self.name} steers ${u.name}'s move.`); try { b.move(u, best.pos, { mode: 'standard' }) } catch (e) { if (e instanceof PendingChoice) throw e /* else blocked */ } }
      u.moveLeft = 0
    },
    onAnyTurnEnd(b, self, u) {
      if (u.flags.turnedBy !== self.id) return
      if (--u.flags.turnedTurns <= 0) unturn(b, u)
    },
    beforeAnyAttack(b, self, ctx) { if (ctx.target.flags.turnedBy === self.id && !b.hostile(ctx.attacker, self) && ctx.attacker !== ctx.target) unturn(b, ctx.target) },
    beforeAnyDamage(b, self, t, parts, opts) { if (t.flags.turnedBy === self.id && opts.source && !b.hostile(opts.source, self) && opts.source !== t) unturn(b, t) },
    // …or inflicts heat on it, or forces it to make a save
    onAnyHeat(b, self, t, _amount, source) { if (t.flags.turnedBy === self.id && source && source !== t && !b.hostile(source, self)) unturn(b, t) },
    onAnySave(b, self, u, _stat, _ok, source) { if (u.flags.turnedBy === self.id && source && source !== u && !b.hostile(source, self)) unturn(b, u) },
  },
  {
    id: 'ms_mimic_mesh',
    note: 'Mimic Mesh: choose an ally within Sensors; until the end of your next turn, Battlefield Awareness (reaction, any number of times): when a hostile action targets that ally, move 3 spaces straight toward it first, ignoring engagement and without provoking',
    actions: (b, u) => [action({
      key: 'mimic', name: 'Activate Mimic Mesh', activation: 'quick', target: 'ally', range: u.stats.sensors, text: 'Choose an ally within Sensors: until the end of your next turn you may move 3 toward it whenever a hostile acts against it.',
      run: (bt, self, t) => {
        const a = t as Unit
        if (!a || a === self || bt.hostile(self, a) || bt.distance(self, a) > self.stats.sensors) throw new Error('Choose an ally within Sensors')
        self.flags.mimicMesh = { ally: a.id, turns: 2 }
      },
      aiTarget: (bt, self) => bt.alive().filter(o => o !== self && !bt.hostile(self, o) && o.kind === 'mech' && bt.distance(self, o) <= self.stats.sensors).sort((x, y) => x.hp / x.stats.hp - y.hp / y.stats.hp)[0] ?? null,
      aiScore: () => 1,
    })],
    onTurnEnd(b, self) { if (self.flags.mimicMesh && --self.flags.mimicMesh.turns <= 0) delete self.flags.mimicMesh },
    beforeAnyAttack(b, self, ctx) {
      const m = self.flags.mimicMesh
      if (!m || ctx.target.id !== m.ally || !b.hostile(ctx.attacker, ctx.target) || b.adjacent(self, ctx.target)) return
      if (b.canSpend(self, 'reaction') !== true || b.has(self, 'immobilized') || b.has(self, 'stunned')) return
      if (!b.offerReaction(self, 'mimic_mesh', 'Battlefield Awareness?', `${ctx.attacker.name} acts against ${ctx.target.name}. Spend ${self.name}'s reaction to move 3 toward it first?`)) return
      b.spend(self, 'reaction') // through spend(): reveals Hidden, ends Ghostweave, runs onAnyAction hooks
      b.say(`${self.name} dashes toward ${ctx.target.name} (Battlefield Awareness).`)
      b.forceMove(self, ctx.target, 3, -1)
    },
  },
  {
    id: 'ms___scorpion_v70.1', note: '//SCORPION V70.1 (no action, no reaction): when you or an adjacent ally is missed by a hostile tech attack or succeeds on a save against a hostile tech action, the attacker is Impaired until the end of its next turn and takes 2 heat, or is Jammed until the end of its next turn (your choice)',
    afterAnyAttack(b, self, ctx) {
      if (!ctx.tech || ctx.hit || !b.hostile(self, ctx.attacker) || ctx.attacker.destroyed || !scorpionCovers(b, self, ctx.target)) return
      scorpionSting(b, self, ctx.attacker)
    },
    onAnySave(b, self, u, _stat, ok, source) {
      if (!ok || !source || !source.flags.techActing || source.destroyed || !b.hostile(self, source) || !scorpionCovers(b, self, u)) return
      scorpionSting(b, self, source)
    },
  },
  {
    id: 'ms_scylla_class_nhp',
    note: 'Unleash SCYLLA: until your next turn, two special reactions to Skirmish (half damage, heat and burn) the character that triggers them — chosen trigger: a hostile attacking you or an ally within 3, or a hostile attacking a chosen object',
    actions: (b, u) => [action({
      key: 'scylla', name: 'Unleash SCYLLA', activation: 'quick', target: 'none', text: 'Until your next turn, gain two special reactions to Skirmish (half damage) against hostiles that trigger them.',
      run: (bt, self) => {
        const objs = bt.alive().filter(o => (o.kind === 'deployable' || o.flags.isCover) && bt.los(self, o))
        const i = bt.choose({ kind: 'scylla_trigger', unit: self, title: 'Unleash SCYLLA: trigger', options: [{ label: 'Protect: attacks on you or allies within 3' }, ...objs.map(o => ({ label: `Guard ${o.name}`, hint: `at ${o.pos.x},${o.pos.y}` }))], defaultIndex: 0 })
        self.flags.scylla = { left: 2, guard: i > 0 ? objs[i - 1].id : null }
        if (i > 0) bt.say(`${self.name}'s SCYLLA guards ${objs[i - 1].name}.`)
      },
    })],
    onTurnStart: (b, u) => { delete u.flags.scylla },
    afterAnyAttack(b, self, ctx) {
      const sc = self.flags.scylla
      if (!sc || sc.left <= 0 || self.destroyed || ctx.attacker.destroyed || !b.hostile(self, ctx.attacker) || ctx.attacker === self) return
      const t = ctx.target
      const trig = sc.guard ? t.id === sc.guard : (t === self || (!b.hostile(self, t) && b.distance(self, t) <= 3 && t.kind !== 'deployable'))
      if (!trig || ctx.mode === 'secondary') return
      const k = `scyllaFired:${b.eventCount}:${ctx.attacker.id}`
      if (self.flags.scyllaLast === k) return
      const w = self.weapons.find(x => !x.tech && b.weaponUsable(self, x, false) === true && b.validTarget(self, x, ctx.attacker) === true && x.size !== 'Superheavy')
      if (!w) return
      if (!b.offerReaction(self, 'scylla', 'SCYLLA reaction?', `${ctx.attacker.name} attacked ${t.name}. Skirmish it with ${w.name} (half damage)? ${sc.left} left.`)) return
      self.flags.scyllaLast = k
      sc.left--
      self.flags.halfDamage = true
      try { b.weaponAttack(self, w, { targetId: ctx.attacker.id }, 'free') } finally { delete self.flags.halfDamage }
    },
  },
  {
    id: 'ms_puppetmaster',
    note: 'Guide the Flock (quick tech): move any number of drones within Sensors — anyone\'s — each up to 4 spaces to a space you choose (one "Guide" action per drone, until the end of your turn); Electropulse (quick tech): characters you choose within Sensors that are adjacent to any drone or deployable take 2 energy',
    onTurnEnd: (_b, u) => { delete u.flags.flock },
    actions: (b, u) => [
      action({
        key: 'guideflock', name: 'Guide the Flock', activation: 'quick_tech', target: 'none', text: 'Choose drones within Sensors (any owner) and move each up to 4 spaces, one at a time.',
        run: (bt, self) => {
          const ids = bt.alive().filter(d => d.kind === 'drone' && bt.distance(self, d) <= self.stats.sensors).map(d => d.id)
          if (!ids.length) throw new Error('No drones within Sensors')
          self.flags.flock = ids
          bt.say(`${self.name} takes control of ${ids.length} drone${ids.length > 1 ? 's' : ''}.`)
        },
        aiScore: () => -1,
      }),
      ...((u.flags.flock ?? []) as string[]).map(id => b.unit(id)).filter((d): d is Unit => !!d && !d.destroyed).map(d => action({
        key: `flock:${d.id}`, name: `Guide ${d.name} (${d.pos.x},${d.pos.y})`, activation: 'free', target: 'tile', range: u.stats.sensors + 4,
        text: `Move ${d.name} up to 4 spaces to a free space.`,
        run: (bt, self, t) => {
          const p = t && 'x' in t ? t : (t as Unit).pos
          if (chebyshev(d.pos, p) > 4) throw new Error('Drones move up to 4 spaces')
          if (bt.alive().some(o => o !== d && !o.flags.flat && footprint(o).some(q => q.x === p.x && q.y === p.y)) || !bt.map.tiles[p.y * bt.map.w + p.x]) throw new Error('Space occupied')
          const from = d.pos
          d.pos = { ...p }
          bt.emit({ type: 'move', unitId: d.id, path: [from, d.pos] })
          bt.invalidateTerrain()
          self.flags.flock = (self.flags.flock as string[]).filter(x => x !== d.id)
        },
        aiScore: () => -1,
      })),
      action({
        key: 'electropulse', name: 'Electropulse', activation: 'quick_tech', target: 'none', text: 'Characters you choose within Sensors that are adjacent to any drone or deployable take 2 energy damage.',
        run: (bt, self) => {
          const deps = bt.alive().filter(d => d.kind === 'drone' || d.kind === 'deployable')
          const inRange = bt.alive().filter(t => (t.kind === 'mech' || t.kind === 'npc') && t !== self && bt.distance(self, t) <= self.stats.sensors && deps.some(d => d !== t && bt.adjacent(d, t)))
          const opts = [{ label: 'Hostiles only' }, { label: 'Everyone in reach (allies too)' }]
          const i = inRange.some(t => !bt.hostile(self, t)) ? bt.choose({ kind: 'electropulse', unit: self, title: 'Electropulse: targets', options: opts, defaultIndex: 0 }) : 0
          for (const t of inRange) if (i === 1 || bt.hostile(self, t)) bt.applyDamage(t, [{ type: 'Energy', amount: 2 }], { source: self })
        },
      }),
    ],
  },
  {
    id: 'ms_beckoner',
    note: 'Beckon (invade): you take 1d6+2 AP energy and swap places with a mech of your Size or larger (teleport; fails if either space can\'t hold the other); Summon (invade): every character within 3 of the target is pulled adjacent to it, or as close as possible',
    actions: (b, u) => [
      invade('beckoner', 'Beckon', 'You take 1d6+2 AP energy and swap places with the target (a mech your Size or larger).', (bt, self, t) => {
        bt.applyDamage(self, [{ type: 'Energy', amount: rollDice(bt.rng, '1d6+2').total }], { ap: true })
        if (self.destroyed) return
        if (t.kind !== 'mech' && !(t.kind === 'npc' && !t.isGrunt) || t.stats.size < self.stats.size) { bt.say('  Beckon fails: the target must be a mech your Size or larger.'); return }
        const a = { ...self.pos }, c = { ...t.pos }
        const fits = (u: Unit, at: Pos) => footprint({ pos: at, stats: u.stats }).every(p => bt.map.tiles[p.y * bt.map.w + p.x] && p.x >= 0 && p.y >= 0 && p.x < bt.map.w && p.y < bt.map.h && !bt.alive().some(o => o !== u && o !== self && o !== t && !o.flags.flat && footprint(o).some(q => q.x === p.x && q.y === p.y)))
        if (!fits(self, c) || !fits(t, a)) { bt.say('  Beckon fails: no room to swap.'); return }
        if (bt.teleportBlocked(self, c) || bt.teleportBlocked(t, a)) { bt.say('  Beckon fails: an interdiction field blocks the swap.'); return }
        self.pos = c; t.pos = a
        bt.emit({ type: 'move', unitId: self.id, path: [a, c] })
        bt.emit({ type: 'move', unitId: t.id, path: [c, a] })
        bt.invalidateTerrain()
        bt.say(`  ${self.name} and ${t.name} swap places.`)
      })(b, u),
      invade('beckoner', 'Summon', 'All characters within 3 of the target are pulled adjacent to it (or as close as possible).', (bt, self, t) => {
        for (const o of bt.alive()) if (o !== t && bt.distance(o, t) <= 3 && o.kind !== 'deployable') bt.forceMove(o, t, 3, -1)
      })(b, u),
    ],
  },
  {
    id: 'ms_smite', note: 'Smite / Sear invades',
    actions: (b, u) => [
      invade('smite', 'Smite', 'You take 1d6 AP energy; target Systems save or Stunned (1/scene per target).', (bt, self, t) => {
        bt.applyDamage(self, [{ type: 'Energy', amount: rollDice(bt.rng, '1d6').total }], { ap: true })
        if (!t.flags.smitten && !bt.save(t, 'sys', self.stats.save, 0, self)) { t.flags.smitten = true; bt.addStatus(t, 'stunned', 'next_turn_end_target', self) }
      })(b, u),
      invade('smite', 'Sear', 'You take 1d6 AP energy; target takes 2 heat per adjacent character (max 6).', (bt, self, t) => {
        bt.applyDamage(self, [{ type: 'Energy', amount: rollDice(bt.rng, '1d6').total }], { ap: true })
        const n = bt.alive().filter(o => o !== t && o.stats.size >= 1 && bt.adjacent(o, t)).length
        bt.applyDamage(t, [{ type: 'Heat', amount: Math.min(6, 2 * n) }], { source: self })
      })(b, u),
    ],
  },
  {
    id: 'ms_emp_pulse', note: 'Self-stun; burst 1 Systems save or Stunned',
    actions: (b, u) => [action({
      key: 'emp', name: 'EMP Pulse', activation: 'quick', target: 'self', area: { shape: 'burst', size: 1 }, text: 'You are Stunned; non-biological characters in burst 1: Systems save or Stunned (1/scene each).',
      run: (bt, self) => {
        bt.addStatus(self, 'stunned', 'next_turn_end_target', self)
        for (const t of unitsOnTiles(bt.alive(), burstTiles(bt.map, self, 1))) if (t !== self && t.role !== 'Biological' && !t.flags.emped && !bt.save(t, 'sys', self.stats.save, 0, self)) { t.flags.emped = true; bt.addStatus(t, 'stunned', 'next_turn_end_target', self) }
      },
    })],
  },
  {
    id: 'ms_lightning_generator', note: 'Protocol: 1 heat, 2 energy to adjacent characters and objects; in the Danger Zone at the start of your turn it activates automatically with 4 AP energy (using up the protocol)',
    actions: (b, u) => [action({
      key: 'lightning', name: 'Lightning Generator', activation: 'protocol', heat: 1, target: 'none', text: 'Take 1 heat; deal 2 energy to all adjacent characters and objects.',
      run: (bt, self) => { for (const o of bt.alive()) if (o !== self && bt.adjacent(self, o)) bt.applyDamage(o, [{ type: 'Energy', amount: 2 }], { source: self }) },
      aiScore: (bt, self) => bt.alive().filter(o => bt.hostile(self, o) && bt.adjacent(self, o)).length * 2,
    })],
    onTurnStart(b, u) {
      if (!b.has(u, 'dangerzone')) return
      // it activates automatically: the protocol is used for this turn
      u.flags['turn:protocol:lightning'] = true
      b.say(`${u.name}'s lightning generator discharges (Danger Zone).`)
      b.addHeat(u, 1)
      for (const o of b.alive()) if (o !== u && b.adjacent(u, o)) b.applyDamage(o, [{ type: 'Energy', amount: 4 }], { source: u, ap: true })
    },
  },
  {
    id: 'ms_viral_logic_suite', note: 'Viral Logic Suite invades: Logic Bomb (characters of your choice within burst 2 of the target save (Systems) or are Slowed until they end one of their turns not adjacent to any character); Banish (until the end of its next turn the target takes 2 heat per space it voluntarily moves, 6 heat at most)',
    actions: (b, u) => [
      invade('vls', 'Logic Bomb', 'Characters of your choice within burst 2 of the target: Systems save or Slowed until they end a turn not adjacent to any character.', (bt, self, t) => {
        for (const o of unitsOnTiles(bt.alive(), burstTiles(bt.map, t, 2))) if (bt.hostile(self, o) && (o.kind === 'mech' || o.kind === 'npc') && !bt.save(o, 'sys', self.stats.save, 0, self)) bt.addStatus(o, 'slowed', 'until_cleared', self, { logicBomb: true })
      })(b, u),
      invade('vls', 'Banish', 'Target takes 2 heat per space it voluntarily moves (6 at most) until the end of its next turn.', (bt, self, t) => { t.flags[`banish:${self.id}`] = { turns: nextTurnEnds(t), heat: 0 } })(b, u),
    ],
    onMove(b, self, mover, path) {
      const ban = mover.flags[`banish:${self.id}`]
      // voluntary moves only; 6 heat in total for the whole effect
      if (!ban || mover.flags.movingInvoluntarily || mover.destroyed || ban.heat >= 6 || path.length < 2) return
      const heat = Math.min(6 - ban.heat, 2 * (path.length - 1))
      ban.heat += heat
      b.applyDamage(mover, [{ type: 'Heat', amount: heat }], { source: self })
    },
    onAnyTurnEnd(b, self, u) {
      const ban = u.flags[`banish:${self.id}`]
      if (ban && --ban.turns <= 0) delete u.flags[`banish:${self.id}`]
      // Logic Bomb: Slowed until it ends one of its turns not adjacent to any character
      if (u.statuses.some(s => s.id === 'slowed' && s.data?.logicBomb) && !b.alive().some(o => o !== u && (o.kind === 'mech' || o.kind === 'npc' || o.kind === 'drone') && b.adjacent(u, o))) {
        if (u.statuses.some(s => s.id === 'slowed' && !s.data?.logicBomb)) u.statuses = u.statuses.filter(s => !s.data?.logicBomb)
        else b.removeStatus(u, 'slowed')
      }
    },
  },
  {
    id: 'ms_aggressive_system_sync',
    note: 'Chains of Prometheus (full tech): 4 heat, then 2 heat whenever it ends a turn more than 3 from you; Excommunicate (full tech): the first time each round it starts its turn next to an ally or moves next to one on its turn, both take 3 heat; one target each; a successful Systems save as a full action ends either',
    actions: (b, u) => [
      action({
        key: 'chains', name: 'Chains of Prometheus', activation: 'full_tech', target: 'enemy', range: u.stats.sensors, text: 'Tech attack: 4 heat; for the scene, 2 heat whenever it ends a turn more than 3 from you.',
        run: (bt, self, t) => {
          const target = t as Unit
          const v = bt.techTargetValid(self, target); if (v !== true) throw new Error(v)
          const c = bt.techAttackRoll(self, target, 'Chains of Prometheus')
          if (!c.hit) return
          bt.applyDamage(target, [{ type: 'Heat', amount: 4 }], { source: self })
          for (const o of bt.units) if (o.flags.chainedBy === self.id) delete o.flags.chainedBy
          target.flags.chainedBy = self.id
        },
        aiScore: () => 5,
      }),
      action({
        key: 'excommunicate', name: 'Excommunicate', activation: 'full_tech', target: 'enemy', range: u.stats.sensors, text: 'Tech attack: for the scene, the first time each round it is next to an ally on its turn, both take 3 heat.',
        run: (bt, self, t) => {
          const target = t as Unit
          const v = bt.techTargetValid(self, target); if (v !== true) throw new Error(v)
          const c = bt.techAttackRoll(self, target, 'Excommunicate')
          if (!c.hit) return
          for (const o of bt.units) if (o.flags.excommBy === self.id) delete o.flags.excommBy
          target.flags.excommBy = self.id
          bt.say(`  ${target.name} is excommunicated.`)
        },
        aiScore: (bt, self, t) => (t && 'id' in t && bt.alive().some(o => o !== t && !bt.hostile(t as Unit, o) && bt.distance(o, t as Unit) <= 2) ? 4 : 1),
      }),
    ],
    grantActions: (b, self, other) => {
      const out: CustomAction[] = []
      for (const [flag, label] of [['chainedBy', 'Chains of Prometheus'], ['excommBy', 'Excommunicate']] as const) {
        if (other.flags[flag] !== self.id) continue
        out.push(action({
          key: `shake:${flag}:${self.id}`, name: `Break ${label}`, activation: 'full', target: 'none', text: `Systems save (vs ${self.stats.save}) to end ${label}.`,
          run: (bt, me) => { if (bt.save(me, 'sys', self.stats.save, 0, self)) { delete me.flags[flag]; bt.say(`${me.name} breaks free of ${label}.`) } },
          aiScore: (bt, me) => (me.heat >= me.stats.heatcap - 3 ? 3 : 0.5),
        }))
      }
      return out
    },
    onAnyTurnEnd(b, self, u) { if (u.flags.chainedBy === self.id && b.distance(self, u) > 3) b.applyDamage(u, [{ type: 'Heat', amount: 2 }], { source: self }) },
    onAnyTurnStart(b, self, u) { if (u.flags.excommBy === self.id) excomm(b, self, u) },
    onMove(b, self, mover) { if (mover.flags.excommBy === self.id && mover.activeTurn) excomm(b, self, mover) },
  },
  {
    id: 'ms_metafold_carver',
    note: 'Ophidian Trek (invade): the target teleports 1d6+1 straight toward you (or as close as possible); it fails if the space is occupied or terrain; Fold Space (invade): the target leaves the battlefield until the start of its next turn, returning to its space or the nearest free one',
    actions: (b, u) => [
      invade('carver', 'Ophidian Trek', 'The target teleports 1d6+1 spaces directly toward you (fails onto occupied spaces or terrain).', (bt, self, t) => {
        const n = rollDice(bt.rng, '1d6+1').total
        const d = Math.max(0, bt.distance(self, t) - 1)
        const k = Math.min(n, d)
        if (k <= 0) return
        const dx = self.pos.x - t.pos.x, dy = self.pos.y - t.pos.y, len = Math.max(Math.abs(dx), Math.abs(dy)) || 1
        const dest = { x: t.pos.x + Math.round((dx / len) * k), y: t.pos.y + Math.round((dy / len) * k) }
        const blocked = footprint({ pos: dest, stats: t.stats }).some(p => { const tile = bt.map.tiles[p.y * bt.map.w + p.x]; return !tile || tile.kind === 'block' || bt.alive().some(o => o !== t && !o.flags.flat && footprint(o).some(q => q.x === p.x && q.y === p.y)) })
        if (blocked || bt.teleportBlocked(t, dest)) { bt.say(`  Ophidian Trek fails: the space is occupied.`); return }
        const from = { ...t.pos }
        t.pos = dest
        bt.emit({ type: 'move', unitId: t.id, path: [from, dest] })
        bt.invalidateTerrain()
        bt.say(`  ${t.name} is folded ${k} spaces toward ${self.name}.`)
      })(b, u),
      invade('carver', 'Fold Space', 'The target disappears until the start of its next turn.', (bt, self, t) => {
        t.flags.folded = { at: { ...t.pos }, reactions: t.reactionsLeft }
        t.flags.intangible = true
        t.reactionsLeft = 0
        bt.say(`  ${t.name} is folded out of space.`, 'status')
        bt.emit({ type: 'status', unitId: t.id, status: 'folded', added: true })
      })(b, u),
    ],
    onAnyTurnStart(b, self, u) {
      const f = u.flags.folded
      if (!f) return
      delete u.flags.folded
      delete u.flags.intangible
      const occupied = (p: Pos) => b.alive().some(o => o !== u && !o.flags.flat && footprint(o).some(q => footprint({ pos: p, stats: u.stats }).some(r => r.x === q.x && r.y === q.y)))
      let at: Pos = f.at
      for (let r = 1; r <= 6 && occupied(at); r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const q = { x: f.at.x + dx, y: f.at.y + dy }; if (q.x >= 0 && q.y >= 0 && q.x < b.map.w && q.y < b.map.h && !occupied(q) && b.map.tiles[q.y * b.map.w + q.x].kind !== 'block' && occupied(at)) at = q }
      u.pos = at
      b.say(`${u.name} returns from folded space.`, 'status')
      b.emit({ type: 'status', unitId: u.id, status: 'folded', added: false })
      b.invalidateTerrain()
    },
  },
  {
    id: 'ms_hunter_lock', note: 'Hunter Lock: choose a character within Sensors; your first successful ranged or melee attack against it each round deals +3 bonus damage (added to the attack: Armor applies once); a new target only once it is destroyed',
    actions: (b, u) => [action({
      key: 'hunterlock', name: 'Hunter Lock', activation: 'quick', target: 'enemy', range: u.stats.sensors, text: 'For the scene, your first hit each round against this target deals +3 bonus damage.',
      usable: (bt, self) => (self.flags.hunterLock && !bt.unit(self.flags.hunterLock)?.destroyed ? 'Current target still active' : true),
      run: (bt, self, t) => {
        const target = t as Unit
        if (!target || bt.distance(self, target) > self.stats.sensors) throw new Error('Out of Sensors')
        self.flags.hunterLock = target.id
      },
      aiScore: () => 3,
    })],
    // bonus damage on the attack itself (one damage packet), until an attack on the target hits this round
    beforeAttack(b, self, ctx, role) {
      if (role !== 'attacker' || ctx.tech || ctx.target.id !== self.flags.hunterLock || self.flags['round:hunterlock'] || !ctx.weapon) return
      ctx.bonusDamage.push({ type: ctx.profile?.damage[0]?.type ?? 'Kinetic', val: 3 } as any)
      ctx.reasons.push('Hunter Lock +3')
    },
    afterAttack(b, self, ctx, role) { if (role === 'attacker' && ctx.hit && !ctx.tech && ctx.target.id === self.flags.hunterLock) self.flags['round:hunterlock'] = true },
  },
  {
    id: 'ms_eye_of_horus', note: 'Eye of HORUS: until the end of your next turn, characters within Sensors don\'t benefit from Hidden or Invisible against you',
    actions: (b, u) => [action({
      key: 'horus', name: 'Eye of Horus', activation: 'quick', target: 'none', text: 'Until the end of your next turn, Hidden and Invisible don\'t protect characters within Sensors against you.',
      run: (bt, self) => { self.flags.horus = 2; self.flags.seeHiddenWithin = self.stats.sensors },
    })],
    onTurnEnd(b, self) { if (self.flags.horus && --self.flags.horus <= 0) { delete self.flags.horus; delete self.flags.seeHiddenWithin } },
  },
  // ------------------------------------------------------------ Harrison Armory
  {
    id: 'ms_siege_stabilizers', note: 'Siege Stabilizers (quick toggle): ranged attacks +5 range; you are Immobilized, can\'t make melee attacks, and can\'t make ranged attacks against or centred on characters, objects or spaces within range 5',
    init: u => { u.bonuses.push({ id: 'range', val: 5, range_types: ['Range'], condition: '{stabilizers}' }) },
    actions: (b, u) => [action({
      key: 'stabilizers', name: u.flags.stabilizers ? 'Retract Stabilizers' : 'Extend Stabilizers', activation: 'quick', target: 'none', text: 'Ranged attacks +5 range; you are Immobilized and cannot attack within range 5 or in melee.',
      run: (bt, self) => {
        self.flags.stabilizers = !self.flags.stabilizers
        if (self.flags.stabilizers) {
          bt.addStatus(self, 'immobilized', 'until_cleared', self, { stab: true })
          // the +5 range is conditional on {stabilizers}: add it once, not again on every extension
          if (!self.bonuses.some(x => x.id === 'range' && x.condition === '{stabilizers}')) self.bonuses.push({ id: 'range', val: 5, range_types: ['Range'], condition: '{stabilizers}' })
        }
        else self.statuses = self.statuses.filter(s => !s.data?.stab)
      },
    })],
    // while extended: no melee attacks and no targets within range 5 (refused up front, so nothing — not even Reliable — lands)
    forbidsTarget(b, self, w, t, from) {
      if (!self.flags.stabilizers) return undefined
      if (b.isMelee(w)) return 'Siege Stabilizers: no melee attacks while extended'
      if (b.distance({ ...self, pos: from } as Unit, t) <= 5) return 'Siege Stabilizers: can’t attack targets within range 5'
      return undefined
    },
    forbidsAim(b, self, _w, aim) { return self.flags.stabilizers && distanceToTile(b.map, self, aim) <= 5 ? 'Siege Stabilizers: can’t centre an attack within range 5' : undefined },
    beforeAttack(b, self, ctx, role) { if (role === 'attacker' && self.flags.stabilizers && (ctx.melee || b.distance(self, ctx.target) <= 5)) ctx.cancelled = true },
  },
  {
    id: 'ms_external_ammo_feed', note: 'External Ammo Feed (quick, 1/round, 1d3+1 heat): reload a Loading weapon',
    actions: (b, u) => [action({
      key: 'ammofeed', name: 'External Ammo Feed', activation: 'quick', target: 'none', text: 'Reload a Loading weapon (1/round).',
      usable: (_bt, self) => (self.flags['round:ammofeed'] ? 'Once per round' : self.weapons.some(w => !w.loaded && !w.destroyed) ? true : 'Nothing to reload'),
      run: (bt, self) => {
        const unloaded = self.weapons.filter(w => !w.loaded && !w.destroyed)
        if (!unloaded.length) throw new Error('Nothing to reload')
        const i = unloaded.length > 1 ? bt.choose({ kind: 'ammo_feed', unit: self, title: 'External Ammo Feed: reload', options: unloaded.map(w => ({ label: w.name })), defaultIndex: 0 }) : 0
        self.flags['round:ammofeed'] = true
        unloaded[i].loaded = true
        self.flags.reloaded = true
        bt.say(`${self.name} feeds ${unloaded[i].name} a fresh belt.`)
      },
      aiScore: (_bt, self) => (self.heat + 4 < self.stats.heatcap ? 2.5 : 0),
    })],
  },
  {
    id: 'ms_flak_launcher', note: 'Flak Launcher (quick): a flying character within range 15 and line of sight saves (Agility) or lands (no fall damage), is Slowed and can\'t fly until the end of its next turn',
    actions: (b, u) => [action({
      key: 'flak', name: 'Flak Launcher', activation: 'quick', target: 'enemy', range: 15, text: 'A flying character must pass an Agility save or land, becoming Slowed and unable to fly until the end of its next turn.',
      usable: (bt, self) => (hostile(bt, self).some(h => h.flying) ? true : 'No flying targets'),
      run: (bt, self, t) => {
        const target = t as Unit
        if (!target.flying) throw new Error('Target is not flying')
        if (bt.distance(self, target) > 15) throw new Error('Out of range (15)')
        if (!bt.los(self, target)) throw new Error('No line of sight')
        if (bt.save(target, 'agi', self.stats.save, 0, self)) return
        bt.land(target, 'is hit by flak')
        target.flying = false
        // can't fly until the end of its next turn: no taking off again until then
        if (target.flags.landed || target.flags.flightSystem) target.flags.flakWasFlyer = true
        target.flags.landed = false
        target.flags.noFly = nextTurnEnds(target)
        bt.addStatus(target, 'slowed', 'next_turn_end_target', self)
      },
    })],
    onAnyTurnEnd(b, _self, u) {
      if (!u.flags.noFly || --u.flags.noFly > 0) return
      delete u.flags.noFly
      if (u.flags.flakWasFlyer && !u.flying) u.flags.landed = true // it may take off again
      delete u.flags.flakWasFlyer
    },
  },
  {
    id: 'ms_havok_charges', note: 'HAVOK charges (Limited 2): Napalm Grenade (impact within range 5 — 15 with an Assault Launcher — and line of sight, then a Line 5 path of your choice from the impact: Agility save or 2 burn, 1 on a success); HAVOK Mine (a Line 5 blast toward whoever triggers it: Agility save or 4 burn, 2 on a success)',
    actions: (b, u) => {
      const s = sys(u, 'ms_havok_charges')
      const range = u.flags.assaultLauncher ? 15 : 5
      return [action({
        key: 'napalm', name: 'Napalm Grenade', activation: 'quick', target: 'tile', range, text: 'Throw it within range, then spray napalm along a Line 5 path from the impact: Agility save or 2 burn (1 on a success).', usable: () => usesOk(s),
        run: (bt, self, t) => {
          const p = t && 'x' in t ? t : (t as Unit).pos
          if (distanceToTile(bt.map, self, p) > range) throw new Error(`Out of range (${range})`)
          if (!hasLineOfSightToTile(bt.effectiveMap(), self, p)) throw new Error('No line of sight')
          const path = (i: number) => [p, ...lineTiles(bt.map, { pos: p, stats: { size: 1 } } as Unit, { x: p.x + DIR8[i][0] * 4, y: p.y + DIR8[i][1] * 4 }, 4)]
          const value = (i: number) => unitsOnTiles(bt.alive(), path(i)).reduce((n, o) => n + (o.kind === 'deployable' ? 0 : bt.hostile(self, o) ? 1 : -1), 0)
          const def = DIR8.map((_, i) => i).sort((x, y) => value(y) - value(x))[0]
          const i = bt.choose({ kind: 'napalm_line', unit: self, title: 'Napalm Grenade: spray direction', options: DIR8_NAMES.map((n, k) => ({ label: n, hint: `${value(k)} net hostiles` })), defaultIndex: def })
          spend(s)
          const tiles = path(i)
          bt.emit({ type: 'area', tiles, kind: 'explosion' })
          for (const v of unitsOnTiles(bt.alive(), tiles)) {
            if (v.kind !== 'mech' && v.kind !== 'npc' && v.kind !== 'drone') continue
            const ok = bt.save(v, 'agi', self.stats.save, 0, self)
            const burn = ok ? bt.halfOnSave(v, 2) : 2
            if (burn > 0) bt.applyDamage(v, [{ type: 'Burn', amount: burn }], { source: self })
          }
        },
        aiTarget: (bt, self) => { const h = hostile(bt, self).filter(x => bt.distance(self, x) <= range).sort((x, y) => bt.distance(self, x) - bt.distance(self, y))[0]; return h ? { ...h.pos } : null },
        aiScore: () => 2,
      }), action({
        key: 'havok_mine', name: 'Deploy HAVOK Mine', activation: 'quick', target: 'tile', range: mineRange(u), text: 'Plant a mine: when a character moves over or next to it, a Line 5 blast toward it — Agility save or 4 burn (2 on a success).', usable: () => usesOk(s),
        run: (bt, self, t) => {
          const p = t && 'x' in t ? t : (t as Unit).pos
          bt.placeMine(self, p, { name: 'HAVOK Mine', radius: 1, line: 5, damage: [{ type: 'Burn', val: 4 } as any], save: 'agi', saveHalf: true }, { range: mineRange(self) })
          spend(s)
        },
        aiScore: () => -1,
      })]
    },
  },
  {
    id: 'ms_explosive_vents', note: 'Explosive Vents (1/round): when you clear all heat or take stress, a burst 1 explosion: characters in it take 2 heat and 2 burn',
    onClearHeat: (b, u) => vent(b, u),
    onStressDamage: (b, u) => vent(b, u),
  },
  {
    id: 'ms_auto_cooler', note: 'Auto-Cooler (protocol): clear all heat at the start of your next turn unless you take damage, move (even involuntarily) or exceed your Heat Cap first; taking heat alone doesn\'t cancel it',
    actions: (b, u) => [action({ key: 'autocool', name: 'Auto-Cooler', activation: 'protocol', target: 'none', text: 'Clear all heat at the start of your next turn if you don\'t take damage, move or exceed your Heat Cap.', run: (bt, self) => { self.flags.autoCool = true } })],
    // owner's ruling: only HP damage cancels it (not heat); any move does (voluntary or not); so does exceeding the Heat Cap
    onDamaged: (b, u, d) => { if (d.kind === 'hp' && d.amount > 0) delete u.flags.autoCool },
    onMove: (b, self, mover, path) => { if (mover === self && path.length > 1) delete self.flags.autoCool },
    onHeat: (b, u) => { if (u.heat > u.stats.heatcap) delete u.flags.autoCool },
    onTurnStart: (b, u) => {
      if (!u.flags.autoCool) return
      delete u.flags.autoCool
      const had = u.heat > 0
      u.heat = 0
      b.say(`${u.name}'s auto-cooler purges its heat.`)
      if (had) for (const s of scriptsFor(u)) s.onClearHeat?.(b, u)
    },
  },
  {
    id: 'ms_agni_class_nhp', note: 'AGNI (protocol, Limited 1, 1/scene): at the end of your turn clear all heat in a burst 2 wave — Engineering save or 2 burn and pushed out of the area; soft cover inside until the end of your next turn',
    actions: (b, u) => {
      const s = sys(u, 'ms_agni_class_nhp')
      return [action({
        key: 'agni', name: 'AGNI Protocol', activation: 'protocol', target: 'none', text: 'Expend a charge: at the end of this turn, clear all heat in a burst 2 wave (Engineering save or 2 burn and pushed out).',
        usable: (bt, self) => (self.flags['scene:agni'] ? 'Used this scene' : usesOk(s)),
        run: (bt, self) => { spend(s); self.flags['scene:agni'] = true; self.flags['turn:agni'] = true },
      })]
    },
    onTurnEnd(b, u) {
      if (!u.flags['turn:agni']) return
      const had = u.heat > 0
      u.heat = 0
      if (had) for (const s of scriptsFor(u)) s.onClearHeat?.(b, u)
      const tiles = burstTiles(b.map, u, 2)
      // pushed outside the area (or as far as possible): out to range 3
      aoeSave(b, u, tiles, 'eng', t => { b.applyDamage(t, [{ type: 'Burn', amount: 2 }], { source: u }); if (!t.destroyed) b.forceMove(t, u, Math.max(1, 3 - b.distance(u, t)), 1) }, t => t !== u)
      b.addArea({ kind: 'soft_cover', tiles, expiresAfterTurnOf: u.id, turnsLeft: 2, ownerId: u.id })
    },
  },
  {
    id: 'ms_repulser_field', note: 'Repulser Field (quick): characters in burst 2 save (Hull) or are knocked 2 directly away; then mines in the area detonate — you are immune to what they immediately do to you',
    actions: (b, u) => [action({
      key: 'repulser', name: 'Repulser Field', activation: 'quick', target: 'self', area: { shape: 'burst', size: 2 }, text: 'Characters in burst 2: Hull save or knocked back 2; mines in the area detonate.',
      run: (bt, self) => {
        const tiles = burstTiles(bt.map, self, 2)
        bt.emit({ type: 'area', tiles, kind: 'attack' })
        for (const t of unitsOnTiles(bt.alive(), tiles)) if (t !== self && !saveAvoiding(bt, t, 'hull', self.stats.save, self, 'knockback')) bt.forceMove(t, self, 2, 1)
        const set = new Set(tiles.map(t => `${t.x},${t.y}`))
        // "You count as having Immunity to any damage or effects immediately forced by mines detonated using this system"
        self.flags.repulsing = true
        try { for (const m of [...bt.mines]) if (set.has(`${m.pos.x},${m.pos.y}`) && bt.mines.includes(m)) bt.detonateMine(m) } finally { delete self.flags.repulsing }
      },
      aiScore: (bt, self) => bt.alive().filter(o => bt.hostile(self, o) && bt.distance(self, o) <= 2).length * 1.5,
    })],
    beforeAnyDamage(b, self, t, parts) { if (t === self && self.flags.repulsing) for (const p of parts) p.amount = 0 },
    blockStatus: (_b, self) => !!self.flags.repulsing,
    canBeMoved: (_b, self) => !self.flags.repulsing,
  },
  {
    id: 'ms_stasis_generator', note: 'Stasis Generator (quick): a hostile (Engineering save) or willing ally within line of sight and range 5 is Stunned, immune to all damage and effects and can\'t be targeted until the end of its next turn; 1/scene per character',
    actions: (b, u) => [action({
      key: 'stasis', name: 'Stasis Generator', activation: 'quick', target: 'unit', range: 5, text: 'Hostile (Engineering save) or ally within line of sight and range 5: Stunned and immune to all damage until the end of its next turn. 1/scene per character.',
      run: (bt, self, t) => {
        const target = t as Unit
        if (!target || !('id' in target)) throw new Error('Choose a character')
        if (bt.distance(self, target) > 5) throw new Error('Out of range (5)')
        if (target !== self && !bt.los(self, target)) throw new Error('No line of sight')
        if (target.flags.stasisUsed) throw new Error('Already used on this character this scene')
        target.flags.stasisUsed = true
        if (bt.hostile(self, target) && bt.save(target, 'eng', self.stats.save, 0, self)) return
        bt.addStatus(target, 'stunned', 'next_turn_end_target', self, { stasis: true })
        target.flags.stasisUntilRound = bt.round + 1
      },
    })],
    beforeAnyAttack(b, self, ctx) { if (ctx.target.flags.stasisUntilRound && ctx.target.statuses.some(s => s.data?.stasis)) ctx.cancelled = true },
    // "immune to all damage": Reliable damage and effects that hit without an attack deal nothing either
    modifyAnyIncoming(b, self, target, d) { if (target.flags.stasisUntilRound && target.statuses.some(s => s.data?.stasis)) d.amount = 0 },
  },
  {
    id: 'ms_stasis_bolt', note: 'Stasis Bolt: charge as a quick action (one charge, lasts the scene); Interdiction Point (reaction, 1/round): when you or an ally within range 5 is targeted by a ranged attack, make a contested ranged attack roll — if you win, the attack misses; the bolt loses its charge',
    actions: (b, u) => [action({ key: 'stasisbolt', name: 'Charge Stasis Bolt', activation: 'quick', target: 'none', text: 'Gain the Interdiction Point reaction.', usable: (bt, self) => (self.flags.stasisBolt ? 'Already charged' : true), run: (bt, self) => { self.flags.stasisBolt = true } })],
    afterAnyRoll(b, self, ctx) {
      // a ranged attack (not melee, not tech) on you or an ally within range 5
      if (!self.flags.stasisBolt || !ctx.hit || !ctx.ranged || ctx.tech || ctx.melee || b.hostile(self, ctx.target) || !b.hostile(self, ctx.attacker)) return
      if (ctx.target !== self && b.distance(self, ctx.target) > 5) return
      if (b.canSpend(self, 'reaction', 'interdiction_point') !== true) return
      if (!b.offerReaction(self, 'interdiction_point', 'Interdiction Point?', `${ctx.attacker.name} hits ${ctx.target.name} (${ctx.total}). Fire the stasis bolt for a contested roll to make it miss?`)) return
      b.spend(self, 'reaction', 'interdiction_point')
      self.flags.stasisBolt = false
      const acc = b.accuracyFromStatuses(self, 'attack')
      const mine = b.rollD20(self, 'attack') + self.stats.attackBonus + (acc > 0 ? Math.max(...Array.from({ length: acc }, () => b.rng.d(6))) : acc < 0 ? -Math.max(...Array.from({ length: -acc }, () => b.rng.d(6))) : 0)
      b.say(`${self.name} fires a stasis bolt (${mine} vs ${ctx.total}).`)
      if (mine >= (ctx.total ?? 0)) { ctx.hit = false; ctx.crit = false; b.say('  The attack is frozen in place: it misses.') }
    },
  },
  {
    id: 'ms_enclave_pattern_support_shield',
    note: 'ENCLAVE dome (burst 3, until the end of your next turn; you are Immobilized): ranged and melee attacks from outside on characters inside take +1 difficulty; Blinkfield Intervention (reaction): when a character or object inside is attacked, take 2 heat to give it Resistance to all damage from that attack',
    fields: (b, u) => (u.flags.enclave ? [{ tiles: burstTiles(b.map, u, 3), effect: 'protect' as const, label: `${u.name}'s Enclave dome: +1 difficulty on attacks from outside` }] : []),
    actions: (b, u) => [action({
      key: 'enclave', name: 'Enclave Support Shield', activation: 'quick', target: 'none', text: 'Burst 3 dome until the end of your next turn; you are Immobilized.',
      run: (bt, self) => { self.flags.enclave = { turns: 2 }; bt.addStatus(self, 'immobilized', 'until_cleared', self, { enclave: true }) },
    })],
    onTurnEnd(b, self) { if (self.flags.enclave && --self.flags.enclave.turns <= 0) { delete self.flags.enclave; self.statuses = self.statuses.filter(x => !(x.id === 'immobilized' && x.data?.enclave)) } },
    beforeAnyAttack(b, self, ctx) {
      if (!self.flags.enclave || self.destroyed) return
      const inside = (u: Unit) => b.distance(self, u) <= 3
      if (!inside(ctx.target)) return
      if (!ctx.tech && !inside(ctx.attacker)) { ctx.difficulty++; ctx.reasons.push('Enclave dome -1') }
      if (ctx.resistAll || b.canSpend(self, 'reaction') !== true || self.heat + 2 > self.stats.heatcap) return
      const want = !b.hostile(self, ctx.target) && b.hostile(self, ctx.attacker)
      if (!b.offerReaction(self, 'blinkfield', 'Blinkfield Intervention?', `${ctx.attacker.name} attacks ${ctx.target.name} inside the dome. Take 2 heat to give it Resistance to all damage from this attack?`, want && ctx.target.hp <= ctx.target.stats.hp / 2)) return
      b.spend(self, 'reaction') // through spend(): reveals Hidden, ends Ghostweave, runs onAnyAction hooks
      b.addHeat(self, 2)
      ctx.resistAll = true
      ctx.reasons.push('Blinkfield Intervention')
    },
  },
  {
    id: 'ms_reactor_stabilizer', note: 'Reroll overheating checks (you must keep the second result)',
    init: u => { u.flags.reactorStabilizer = true },
  },
  {
    id: 'ms_redundant_systems_upgrade', note: 'Redundant Systems Upgrade (quick, Limited 1): expend a charge to Stabilize as a quick action — every Stabilize option and hook',
    actions: (b, u) => {
      const s = sys(u, 'ms_redundant_systems_upgrade')
      return [action({
        key: 'rsu', name: 'Quick Stabilize', activation: 'quick', target: 'none', text: 'Expend a charge to Stabilize as a quick action: cool or spend a Repair, then reload, clear burn or clear a condition.', usable: () => usesOk(s),
        run: (bt, self) => {
          const canRepair = self.repairs > 0 && self.hp < self.stats.hp && !self.flags.briareosZero
          const mode = canRepair ? (bt.choose({ kind: 'rsu_mode', unit: self, title: 'Quick Stabilize', options: [{ label: 'Cool: clear all heat and Exposed' }, { label: 'Spend a Repair: restore all HP' }], defaultIndex: self.heat > 0 || bt.has(self, 'exposed') || self.hp > self.stats.hp / 2 ? 0 : 1 }) === 1 ? 'repair' : 'cool') : 'cool'
          spend(s)
          bt.stabilize(self, mode, undefined, { paid: true })
        },
        aiScore: (bt, self) => (bt.has(self, 'exposed') ? 6 : self.heat >= self.stats.heatcap - 1 ? 4 : 0),
      })]
    },
  },
  {
    id: 'ms_asura_class_nhp', note: 'ASURA (protocol, Limited 1, 3 heat, 1/scene): expend a charge to take two additional quick actions or one additional full action this turn',
    actions: (b, u) => {
      const s = sys(u, 'ms_asura_class_nhp')
      return [action({
        key: 'asura', name: 'ASURA Protocol', activation: 'protocol', target: 'none', text: '1/scene: take two additional quick actions or one additional full action this turn.',
        usable: (bt, self) => (self.flags['scene:asura'] ? 'Used this scene' : usesOk(s)),
        run: (bt, self) => {
          spend(s)
          self.flags['scene:asura'] = true
          // two more actions: two quick actions or one full action, and (unlike Overcharge) duplicates stay forbidden
          self.actionsLeft += 2
          bt.say(`${self.name}'s ASURA grants two quick actions or one full action.`)
        },
        aiScore: () => 6,
      })]
    },
  },
  {
    id: 'ms_external_batteries', note: 'Explodes for 1d6 AP when you take structure damage (range bonuses via data)',
    onStructureDamage(b, u) {
      const s = sys(u, 'ms_external_batteries')
      if (!s) return
      s.destroyed = true
      dropSystemBonuses(u, s)
      b.say(`${u.name}'s external batteries explode!`)
      b.applyDamage(u, [{ type: 'Explosive', amount: rollDice(b.rng, '1d6').total }], { irreducible: true, ap: true })
    },
  },
  {
    id: 'ms_deep_well_heat_sink', note: 'Resistance to heat on turns started in the Danger Zone',
    // a flag, not u.resist: other sources of heat Resistance (Manticore's core) must survive the end of the turn
    onTurnStart(b, u) { if (b.has(u, 'dangerzone')) u.flags.deepwell = true },
    onTurnEnd(b, u) { delete u.flags.deepwell },
    grantsResistance: (b, self, type) => type === 'Heat' && !!self.flags.deepwell,
  },
  {
    id: 'ms_lucifer_class_nhp', note: 'LUCIFER: next energy attack deals bonus damage equal to your heat',
    actions: (b, u) => [action({ key: 'lucifer', name: 'LUCIFER Protocol', activation: 'protocol', target: 'none', text: 'Next energy attack this turn deals +heat bonus damage on hit.', usable: () => usesOk(sys(u, 'ms_lucifer_class_nhp')), run: (bt, self) => { spend(sys(self, 'ms_lucifer_class_nhp')); self.flags['turn:lucifer'] = true } })],
    beforeAttack(b, self, ctx, role) {
      if (role === 'attacker' && self.flags['turn:lucifer'] && ctx.profile?.damage.some(d => d.type === 'Energy')) { delete self.flags['turn:lucifer']; ctx.bonusDamage.push({ type: 'Energy', val: String(self.heat) }) }
    },
  },
  {
    id: 'ms_plasma_gauntlet', note: 'Danger zone: adjacent Agility save or 4d6 AP energy + prone; half as heat to you; stunned',
    actions: (b, u) => [action({
      key: 'gauntlet', name: 'Plasma Gauntlet', activation: 'quick', target: 'enemy', range: 1, text: 'Danger Zone only. Adjacent target: Agility save or 4d6 AP energy and Prone (half on success). You take half as heat and are Stunned.',
      usable: (bt, self) => (!bt.has(self, 'dangerzone') ? 'Must be in the Danger Zone' : usesOk(sys(self, 'ms_plasma_gauntlet'))),
      run: (bt, self, t) => {
        const target = t as Unit
        if (!bt.adjacent(self, target)) throw new Error('Must be adjacent')
        spend(sys(self, 'ms_plasma_gauntlet'))
        const dmg = rollDice(bt.rng, '4d6').total
        const ok = saveAvoiding(bt, target, 'agi', self.stats.save, self, 'prone')
        const inflicted = ok ? bt.halfOnSave(target, dmg) : dmg
        bt.applyDamage(target, [{ type: 'Energy', amount: inflicted }], { source: self, ap: true })
        if (!ok) bt.addStatus(target, 'prone', 'until_cleared', self)
        // "half of the damage inflicted – before reduction": on a save, half of the halved damage (owner's ruling)
        bt.addHeat(self, Math.ceil(inflicted / 2))
        bt.addStatus(self, 'stunned', 'start_of_next_turn_target', self)
      },
      aiScore: () => 10,
    })],
  },
])

export type { Effect }
