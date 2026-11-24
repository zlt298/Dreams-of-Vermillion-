// Frame traits (`frame:<id>`) and CORE systems (`core:<id>`) for the 29 core-book frames.
import { blastTiles, burstTiles, chebyshev, footprint, tileAt, unitsOnTiles } from '../../grid'
import { isWeaponType } from '../../stats'
import { rollDice } from '../../rng'
import { Lancer } from '../../../data/lancer'
import type { Pos, Unit } from '../../types'
import type { Battle } from '../../battle'
import { registerScripts, type AttackCtx, type CustomAction, type ItemScript } from '../registry'
import { burnZoneStart, burnZoneEnter, type BurnZone } from './cores'
import { deployableUnit } from '../generic'

// ------------------------------------------------------------------ helpers
const once = (u: Unit, key: string, scope: 'round' | 'turn' | 'scene' = 'round'): boolean => {
  const k = scope === 'scene' ? `scene:${key}` : `${scope}:${key}`
  if (u.flags[k]) return false
  u.flags[k] = true
  return true
}
const hostilesWithin = (b: Battle, u: Unit, r: number) => b.alive().filter(o => b.hostile(u, o) && (o.kind === 'mech' || o.kind === 'npc') && b.distance(u, o) <= r)
const alliesWithin = (b: Battle, u: Unit, r: number) => b.alive().filter(o => o !== u && !b.hostile(u, o) && (o.kind === 'mech' || o.kind === 'npc') && b.distance(u, o) <= r)
const heavyFrame: Pick<ItemScript, 'canBeMoved' | 'blockStatus'> = {
  canBeMoved: (b, self, src) => !src || src.stats.size >= self.stats.size,
  blockStatus: (b, self, st, src) => st === 'prone' && !!src && src.stats.size < self.stats.size,
}

const chars = (b: Battle) => b.alive().filter(o => o.kind === 'mech' || o.kind === 'npc')
/** `u` could stand at `p`: on the map, no wall, nothing else there */
function freeFor(b: Battle, u: Unit, p: Pos): boolean {
  if (!footprint(u, p).every(q => { const t = tileAt(b.map, q); return !!t && t.kind !== 'block' })) return false
  return b.passable(u, p, new Set([u.id])) === 'ok' && !b.alive().some(o => o !== u && !o.flags.flat && footprint(o).some(q => footprint(u, p).some(r => r.x === q.x && r.y === q.y)))
}
/** scripted teleport: no path, no engagement */
function teleportTo(b: Battle, u: Unit, p: Pos) {
  const from = { ...u.pos }
  u.pos = { ...p }
  b.emit({ type: 'move', unitId: u.id, path: [from, { ...p }] })
}
/** free spaces within `r` of `u` it could teleport to, best first by `score` (higher better), at most `n` */
function teleportSpots(b: Battle, u: Unit, r: number, score: (p: Pos) => number, n = 6): Pos[] {
  const out: { p: Pos; v: number }[] = []
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    if (!dx && !dy) continue
    const p = { x: u.pos.x + dx, y: u.pos.y + dy }
    if (!freeFor(b, u, p) || b.teleportBlocked(u, p)) continue
    out.push({ p, v: score(p) })
  }
  return out.sort((x, y) => y.v - x.v).slice(0, n).map(x => x.p)
}
const fmtPos = (p: Pos) => `(${p.x}, ${p.y})`
/** would `t` standing at `p` be seen by `from`? */
const seenAt = (b: Battle, from: Unit, t: Unit, p: Pos) => b.los(from, { ...t, pos: p } as Unit)

// ---- Lancaster Supercharger
const SUPERCHARGE_IMMUNE = ['impaired', 'jammed', 'slowed', 'shredded', 'immobilized']
function endSupercharge(b: Battle, self: Unit) {
  const t = b.unit(self.flags.superchargeTarget)
  if (!self.flags.superchargeTarget) return
  delete self.flags.superchargeTarget
  if (t) t.bonuses = t.bonuses.filter(x => (x as any).supercharge !== self.id)
  b.say(`${self.name}'s Supercharger disengages.`)
}

// ---- Nelson Skirmisher
function skirmishStep(b: Battle, self: Unit, p: Pos) {
  delete self.flags.skirmishStep
  self.flags.pendingMove = self.flags.engageDrive ? 4 : 1
  const dis = self.flags['turn:disengaged']
  self.flags['turn:disengaged'] = true
  try { b.move(self, p, { mode: 'free', ignoreEngagement: true }) } finally { delete self.flags.pendingMove; if (!dis) delete self.flags['turn:disengaged'] }
}

// ---- Death's Head Mark for Death
const markDie = (ctx: AttackCtx) => (ctx.weapon!.size === 'Auxiliary' ? '1d6' : ctx.weapon!.size === 'Main' ? '2d6' : '3d6')
function ceaseFocus(b: Battle, self: Unit) {
  if (!self.flags.markTarget) return
  delete self.flags.markTarget
  const inst = self.statuses.find(s => s.id === 'immobilized' && s.data?.mark)
  if (inst) {
    if (self.statuses.some(s => s !== inst && s.id === 'immobilized')) self.statuses = self.statuses.filter(s => s !== inst)
    else b.removeStatus(self, 'immobilized')
  }
  b.say(`${self.name} ceases focusing.`)
}
const markForDeath: Partial<ItemScript> = {
  // "while focusing, you become Immobilized and can't take reactions"
  forbidsAction: (_b, self, cost) => (cost === 'reaction' && self.flags.markTarget ? 'Focusing (Mark for Death)' : undefined),
  onDestroyed(b, self, v) { if (v.id === self.flags.markTarget) ceaseFocus(b, self) },
  beforeAttack(b, self, ctx, role) {
    if (role !== 'attacker' || self.flags.markTarget !== ctx.target.id || !ctx.ranged || !ctx.weapon) return
    if (b.distance(self, ctx.target) <= 5 || b.cover(self, ctx.target) !== 'none') return
    ctx.reasons.push(`Marked (crit +${markDie(ctx)})`)
  },
  // "bonus damage … on ranged critical hits against them, as long as they aren't in cover or within range 5": part of the
  // attack's damage (one packet, Armor once, halved against several targets)
  afterAnyRoll(b, self, ctx) {
    if (ctx.attacker !== self || !ctx.hit || !ctx.crit || !ctx.ranged || !ctx.weapon || self.flags.markTarget !== ctx.target.id) return
    if (b.distance(self, ctx.target) <= 5 || b.cover(self, ctx.target) !== 'none') return
    ctx.bonusDamage.push({ type: ctx.profile?.damage[0]?.type ?? 'Kinetic', val: markDie(ctx) })
  },
}

// ---- Balor
function noRegen(u: Unit) { u.flags.noRegenTurns = Math.max(u.flags.noRegenTurns ?? 0, u.activeTurn ? 2 : 1) }

// ---- Manticore
/** Agility save or `dice` explosive (half on a success) to everyone in Burst 2 of the (wrecked) Manticore; the wreck is vaporised */
function manticoreBlast(b: Battle, m: Unit, dice: string, why: string) {
  b.say(`${m.name}'s reactor ${why}!`, 'warn')
  const tiles = burstTiles(b.map, m, 2)
  b.emit({ type: 'area', tiles, kind: 'explosion' })
  if (m.flags.wreck) { m.flags.wreck = false; b.invalidateTerrain() }
  const dmg = rollDice(b.rng, dice).total
  for (const t of unitsOnTiles(b.alive(), tiles)) {
    if (t === m || (t.kind !== 'mech' && t.kind !== 'npc' && t.kind !== 'drone')) continue
    const ok = b.save(t, 'agi', m.stats.save || 10, 0, m)
    if (ok && t.isGrunt) continue
    b.applyDamage(t, [{ type: 'Explosive', amount: ok ? b.halfOnSave(t, dmg) : dmg }], { source: m })
  }
}
/**
 * Unstable System: the reactor goes up at the end of the Manticore's next turn. A destroyed mech takes no turns and its
 * scripts stop running, so an intangible marker on the wreck counts the turns of its side: the next one that ends
 * (not the one in progress, if an ally's) sets it off.
 */
function armUnstable(b: Battle, m: Unit) {
  const marker = deployableUnit(m, { name: `${m.name}'s unstable reactor`, type: 'Deployable', size: 0.5 } as any, { ...m.pos })
  Object.assign(marker.flags, { flat: true, intangible: true, isCover: false, reactorOf: m.id, skipTurns: b.active && b.active !== m && b.active.side === m.side ? 1 : 0 })
  marker.traits = ['manticore_reactor']
  b.spawn(marker)
  b.say(`${m.name}'s reactor is going unstable — it will explode at the end of its next turn!`, 'warn')
}

// ---- Minotaur Metafold Maze
function metafold(b: Battle, self: Unit, t: Unit) {
  const key = `metafoldStun:${self.id}`
  if (b.has(t, 'immobilized') && !t.flags[key]) { t.flags[key] = true; b.addStatus(t, 'stunned', 'next_turn_end_source', self) }
  else if (b.has(t, 'slowed') || b.has(t, 'immobilized')) b.addStatus(t, 'immobilized', 'next_turn_end_source', self)
  else b.addStatus(t, 'slowed', 'next_turn_end_source', self)
}

// ---- Genghis cloud
interface Cloud { tiles: Pos[]; phase: 1 | 2 }
const inCloud = (c: Cloud | undefined, u: Unit) => !!c && footprint(u).some(p => c.tiles.some(t => t.x === p.x && t.y === p.y))

// ---- Napoleon Activate Aegis
/** a Shield system activated through Battle.useCustom (`activate:<system uid>`) */
function shieldSystem(u: Unit, action: string): boolean {
  const id = action.slice('activate:'.length)
  const s = u.systems.find(x => x.uid === id || x.dataId === id)
  return !!s && !!Lancer.systems.get(s.dataId)?.tags?.some(t => t.id === 'tg_shield')
}

// ---- Iskander Mine Deployers
/** the unit's actions that plant a mine at `p` (found by trying each in a preview) */
function minePlanters(b: Battle, u: Unit, p: Pos): CustomAction[] {
  return b.customActions(u).filter(a => a.key !== 'iskander-mines' && a.target === 'tile' && a.activation !== 'reaction' && a.usable(b, u) === true && b.sandbox(() => {
    const n = b.mines.length
    u.flags.deployingMines = true
    try { a.run(b, u, p) } catch { return false } finally { delete u.flags.deployingMines }
    return b.mines.length > n
  }))
}

// ---- Dusk Wing hover
function duskLand(b: Battle, u: Unit) { if (u.flying && !u.flags.zeroG) { u.flying = false; u.flags.landed = true; b.invalidateTerrain() } }

// ---- Swallowtail Integrated Cloak
function dropCloak(b: Battle, u: Unit) {
  const inst = u.statuses.find(s => s.id === 'invisible' && s.data?.integratedCloak)
  if (!inst) return
  if (u.statuses.some(s => s !== inst && s.id === 'invisible')) u.statuses = u.statuses.filter(s => s !== inst)
  else b.removeStatus(u, 'invisible')
}

const DIRS: [number, number][] = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]]
const DIR_NAMES = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
/** a Line 2 section drawn outward from the mech's edge in direction d */
function fortressLine(b: Battle, u: Unit, d: [number, number]): Pos[] {
  const fp = footprint(u)
  const edge = fp.reduce((best, p) => (p.x * d[0] + p.y * d[1] > best.x * d[0] + best.y * d[1] ? p : best), fp[0])
  return [1, 2].map(k => ({ x: edge.x + d[0] * k, y: edge.y + d[1] * k })).filter(p => p.x >= 0 && p.y >= 0 && p.x < b.map.w && p.y < b.map.h)
}
/** an ally getting hard cover from a Fortress Drake or its sections (adjacent to either) */
function fortressShelters(b: Battle, drake: Unit, t: Unit): boolean {
  if (!drake.flags.fortress || b.hostile(drake, t) || drake.destroyed) return false
  if (b.adjacent(drake, t)) return true
  const fp = footprint(t)
  return b.map.tiles.some((tile, i) => tile.owner === drake.id && tile.kind === 'block' && fp.some(p => Math.max(Math.abs(p.x - i % b.map.w), Math.abs(p.y - Math.floor(i / b.map.w))) === 1))
}
/** Destruction of the Temple: +1 to the Charge Die; at 6 it discharges as a Burst 2 inferno and the effect ends. */
function manticoreCharge(b: Battle, u: Unit) {
  if (!u.flags.chargeDie || u.destroyed) return
  u.flags.chargeDie++
  b.say(`${u.name} charge die: ${Math.min(6, u.flags.chargeDie)}`)
  if (u.flags.chargeDie < 6) return
  delete u.flags.chargeDie // "Once discharged, this effect ends" (the heat Resistance lasts the scene)
  const tiles = burstTiles(b.map, u, 2)
  b.emit({ type: 'area', tiles, kind: 'explosion' })
  for (const t of unitsOnTiles(b.alive(), tiles)) if (t !== u) {
    const dmg = rollDice(b.rng, '6d6').total
    const ok = b.save(t, 'eng', u.stats.save, 0, u)
    if (ok && t.isGrunt) continue
    b.applyDamage(t, [{ type: 'Energy', amount: ok ? b.halfOnSave(t, dmg) : dmg }], { source: u, ap: true })
  }
}

const isAoEAttack = (b: Battle, d: { attack?: { profile?: { range: { type: string }[] } } }) =>
  !!d.attack?.profile && d.attack.profile.range.some(r => ['Blast', 'Burst', 'Line', 'Cone'].includes(r.type))

function action(a: Omit<CustomAction, 'usable'> & { usable?: CustomAction['usable'] }): CustomAction {
  return { usable: () => true, ...a }
}

// ------------------------------------------------------------------ scripts
registerScripts([
  // ---------------- GMS Everest
  {
    id: 'frame:mf_standard_pattern_i_everest',
    note: 'Initiative (1/scene free quick action); Replaceable Parts via bonus',
    actions: (b, u) => [action({
      key: 'everest-initiative', name: 'Initiative', activation: 'free', target: 'none',
      text: '1/scene: take any quick action as a free action.',
      usable: () => (u.flags['scene:initiative'] ? 'Already used this scene' : true),
      run: (bt, self) => { self.flags['scene:initiative'] = true; self.flags.bonusQuick = (self.flags.bonusQuick ?? 0) + 1 },
    })],
  },
  {
    id: 'core:mf_standard_pattern_i_everest',
    note: 'Power Up: +1 accuracy (data bonuses) and 1/turn free Boost',
    actions: (b, u) => u.coreActive ? [action({
      key: 'everest-freeboost', name: 'Boost (Power Up)', activation: 'free', target: 'none', text: '1/turn, Boost as a free action.',
      usable: (bt, self) => (self.flags['turn:freeboost'] ? 'Once per turn' : bt.has(self, 'slowed') || bt.has(self, 'immobilized') ? 'Slowed/immobilized' : true),
      run: (bt, self) => { self.flags['turn:freeboost'] = true; self.flags.bonusQuick = (self.flags.bonusQuick ?? 0) + 1; self.flags.payWithBonus = true; bt.boost(self) },
    })] : [],
  },
  // ---------------- IPS-N Blackbeard
  {
    id: 'frame:mf_blackbeard',
    note: 'Grapple Cable (range 5 grapple, pull adjacent); Lock/Kill Subsystem (Boost and reactions while grappling: flag read by Boost and canSpend)',
    init: u => { u.flags.lockKill = true },
    actions: (b, u) => [action({
      key: 'bb-cable', name: 'Grapple Cable', activation: 'quick', target: 'enemy', range: 5,
      text: 'Grapple a target within range 5; on a success you are pulled adjacent to it.',
      run: (bt, self, t) => {
        const target = t as Unit
        if (!target || bt.distance(self, target) > 5) throw new Error('Out of range')
        if (!bt.los(self, target)) throw new Error('No line of sight')
        const ctx = bt.newAttackCtx(self, target, { melee: true, ranged: false, mode: 'grapple' })
        if (bt.has(self, 'impaired')) ctx.difficulty++
        bt.rollToHit(ctx)
        if (!ctx.hit) return
        bt.forceMove(self, target, 10, -1)
        if (!bt.adjacent(self, target)) { bt.say('  No space to land: the grapple breaks.'); return }
        bt.startGrapple(self, target)
        if (target.stats.size < self.stats.size) bt.addStatus(target, 'immobilized', 'until_cleared', self, { grapple: self.id })
      },
    })],
  },
  {
    id: 'core:mf_blackbeard',
    note: 'Omni-harpoon',
    onCoreActivate(b, u) {
      for (const t of hostilesWithin(b, u, 5).filter(t => b.los(u, t))) {
        const dmg = rollDice(b.rng, '2d6').total
        if (b.save(t, 'hull', u.stats.save, 0, u)) { if (!t.isGrunt) b.applyDamage(t, [{ type: 'Kinetic', amount: b.halfOnSave(t, dmg) }], { source: u }) }
        else {
          b.applyDamage(t, [{ type: 'Kinetic', amount: dmg }], { source: u })
          b.addStatus(t, 'prone', 'until_cleared', u)
          b.forceMove(t, u, 10, -1)
          b.addStatus(t, 'immobilized', 'next_turn_end_target', u)
        }
      }
    },
  },
  // ---------------- IPS-N Drake
  {
    id: 'frame:mf_drake',
    note: 'Heavy Frame, Blast Plating, Guardian',
    init: u => { u.flags.guardian = true },
    ...heavyFrame,
    grantsResistance: (b, _self, _type, d) => isAoEAttack(b, d),
  },
  {
    id: 'core:mf_drake',
    note: 'Fortress Protocol: two indestructible Line 2 cover sections (directions chosen); Immobilized, always in hard cover, immune to knockback, Prone and involuntary movement; a full action after Bracing; allies in hard cover from you or the sections share the immunities and Blast Plating; deactivate as a protocol',
    onCoreActivate(b, u) {
      u.flags.fortress = true
      b.addStatus(u, 'immobilized', 'until_cleared', u, { fortress: true })
      u.immune.push('prone')
      const near = b.alive().filter(o => b.hostile(u, o) && (o.kind === 'mech' || o.kind === 'npc')).sort((x, y) => b.distance(u, x) - b.distance(u, y))[0]
      const toward = near ? DIRS.findIndex(d => d[0] === Math.sign(near.pos.x - u.pos.x) && d[1] === Math.sign(near.pos.y - u.pos.y)) : 4
      const opts = DIRS.map((d, i) => ({ label: DIR_NAMES[i], hint: `${d[0] ? (d[0] > 0 ? 'east' : 'west') : ''}${d[0] && d[1] ? '-' : ''}${d[1] ? (d[1] > 0 ? 'south' : 'north') : ''}` }))
      const first = Math.max(0, toward)
      const a = b.choose({ kind: 'fortress_1', unit: u, title: 'Fortress: first cover section', text: 'Direction of the first Line 2 hard-cover section.', options: opts, defaultIndex: first })
      const c = b.choose({ kind: 'fortress_2', unit: u, title: 'Fortress: second cover section', text: 'Direction of the second Line 2 hard-cover section.', options: opts, defaultIndex: (a + 2) % 8 })
      let n = 0
      for (const i of [a, c]) for (const p of fortressLine(b, u, DIRS[i])) if (b.raiseCover(p, { indestructible: true, owner: u.id })) n++
      b.say(`${u.name} deploys Fortress stabilizers (${n} cover sections).`)
    },
    adjustCover: (b, self, attacker, target, c) => (target === self && self.flags.fortress ? 'hard' : c),
    canBeMoved: (b, self) => !self.flags.fortress,
    preventAnyMove: (b, self, target) => target !== self && fortressShelters(b, self, target),
    blockAnyStatus: (b, self, target, st) => st === 'prone' && target !== self && fortressShelters(b, self, target),
    grantsAnyResistance: (b, self, target, _type, d) => target !== self && fortressShelters(b, self, target) && isAoEAttack(b, d),
    actions: (_b, u) => (u.flags.fortress ? [action({
      key: 'fortress_off', name: 'Deactivate Fortress', activation: 'protocol', target: 'none', text: 'Fold the stabilizers away: you can move again (the cover sections stay).',
      run: (bt, self) => {
        delete self.flags.fortress
        bt.removeStatus(self, 'immobilized')
        const i = self.immune.indexOf('prone'); if (i >= 0) self.immune.splice(i, 1)
        bt.say(`${self.name} deactivates Fortress.`)
      },
      // AI: fold up when nothing hostile is within reach of any weapon (otherwise it is rooted out of the fight)
      aiScore: (bt, self) => {
        const reach = Math.max(1, ...self.weapons.filter(w => !w.destroyed && !w.tech).map(w => bt.weaponReach(self, w)))
        return bt.alive().some(o => bt.hostile(self, o) && (o.kind === 'mech' || o.kind === 'npc') && bt.distance(self, o) <= reach) ? -1 : 3
      },
    })] : []),
  },
  // ---------------- IPS-N Lancaster
  {
    id: 'frame:mf_lancaster',
    note: 'Insulated, Combat Repair (adjacent wreck), Redundant Systems (adjacent allies may draw on your Repairs)',
    init: u => { u.immune.push('burn') },
    // Redundant Systems: "other characters adjacent to the Lancaster can spend its Repairs as their own" — an adjacent ally
    // with none left borrows one for its turn (unspent, it goes back at the end of that turn)
    grantActions: (b, self, other) => (!b.hostile(self, other) && other.kind === 'mech' && b.adjacent(self, other) && self.repairs > 0 && other.repairs <= 0 && !other.flags['turn:borrowedRepair'] ? [action({
      key: `redundant:${self.id}`, name: `Draw a Repair from ${self.name}`, activation: 'free', target: 'none',
      text: `Redundant Systems: spend one of ${self.name}'s Repairs as your own this turn (e.g. to Stabilize).`,
      run: (bt, me) => { self.repairs--; me.repairs++; me.flags['turn:borrowedRepair'] = self.id; bt.say(`${me.name} draws on ${self.name}'s Repairs.`) },
      aiScore: () => -1,
    })] : []),
    onAnyTurnEnd(b, self, u) {
      if (u.flags['turn:borrowedRepair'] !== self.id) return
      delete u.flags['turn:borrowedRepair']
      if (u.repairs > 0) { u.repairs--; self.repairs++ }
    },
    actions: (b, u) => [action({
      key: 'lanc-combat-repair', name: 'Combat Repair', activation: 'full', target: 'ally', range: 1,
      text: 'Spend 4 Repairs to return an adjacent destroyed mech to 1 Structure, 1 Stress and 1 HP.',
      usable: (bt, self) => (self.repairs < 4 ? 'Needs 4 repairs' : true),
      run: (bt, self) => {
        const wreck = bt.units.find(o => o.destroyed && o.kind === 'mech' && o.side === self.side && bt.distance(self, { ...o, destroyed: false } as Unit) <= 1)
        if (!wreck) throw new Error('No adjacent destroyed allied mech')
        self.repairs -= 4
        Object.assign(wreck, { destroyed: false, hp: 1, structure: 1, stress: 1, heat: 0, activationsLeft: 0, statuses: [] })
        wreck.flags.wreck = false
        bt.invalidateTerrain()
        bt.say(`${wreck.name} is brought back online!`)
        bt.emit({ type: 'spawn', unitId: wreck.id })
      },
    })],
  },
  {
    id: 'core:mf_lancaster',
    note: 'Supercharger: the Latch Drone clamps onto an allied mech within range 8 and line of sight (chosen): +1 accuracy on attacks, checks and saves, Immunity to Impaired/Jammed/Slowed/Shredded/Immobilized from others; you take 1 heat each turn; ends if either is Stunned; the Latch Drone is busy meanwhile',
    onCoreActivate(b, u) {
      const opts = alliesWithin(b, u, 8).filter(a => a.kind === 'mech' && b.los(u, a)).sort((x, y) => y.stats.attackBonus - x.stats.attackBonus)
      if (!opts.length) {
        // nothing to clamp onto: the CORE is not spent
        u.coreAvailable = true; u.coreActive = false
        b.say('  No allied mech within range 8 and line of sight: the Latch Drone stays put.')
        return
      }
      const i = b.choose({ kind: 'supercharger', unit: u, title: 'Supercharger', text: 'Clamp the Latch Drone onto which allied mech?', options: opts.map(a => ({ label: a.name, hint: `${b.distance(u, a)} spaces` })), defaultIndex: 0 })
      const ally = opts[i]
      u.flags.superchargeTarget = ally.id
      ally.bonuses.push({ id: 'attack', accuracy: 1, supercharge: u.id } as any, { id: 'check', accuracy: 1, supercharge: u.id } as any, { id: 'save', accuracy: 1, supercharge: u.id } as any)
      b.say(`${ally.name} is supercharged.`)
    },
    onTurnStart: (b, u) => { if (u.flags.superchargeTarget) b.addHeat(u, 1) },
    blockAnyStatus: (b, self, target, st, src) => self.flags.superchargeTarget === target.id && SUPERCHARGE_IMMUNE.includes(st) && src !== target,
    onStatusAdded(b, self, st) { if (st === 'stunned') endSupercharge(b, self) },
    onAnyStatusAdded(b, self, target, st) { if (st === 'stunned' && target.id === self.flags.superchargeTarget) endSupercharge(b, self) },
    onDestroyed(b, self, v) { if (v === self || v.id === self.flags.superchargeTarget) endSupercharge(b, self) },
    // "you cannot use the Latch Drone for any other purpose"
    forbidsAction: (b, self, _cost, a) => (self.flags.superchargeTarget && a === 'activate:latch' ? 'The Latch Drone is clamped on (Supercharger)' : undefined),
  },
  // ---------------- IPS-N Nelson
  {
    id: 'frame:mf_nelson',
    note: 'Momentum (+1d6 melee after boost, 1/round), Skirmisher: a step after every attack (on your turn a free action until you do something else; after an attack outside your turn you are asked at once)',
    beforeAttack(b, self, ctx, role) {
      if (role === 'attacker' && ctx.melee && self.flags['round:boosted'] && once(self, 'momentum')) {
        ctx.bonusDamage.push({ type: 'Kinetic', val: '1d6' })
        ctx.reasons.push('Momentum +1d6')
      }
    },
    afterAttack(b, self, ctx, role) {
      if (role !== 'attacker' || ctx.mode === 'grapple' || self.destroyed || b.sandboxDepth) return
      if (self.activeTurn) { self.flags.skirmishStep = true; return }
      // an attack outside its own turn (Overwatch and other reactions): step now or never
      if (b.has(self, 'immobilized') || b.has(self, 'slowed') || b.has(self, 'stunned')) return
      const n = self.flags.engageDrive ? 4 : 1
      const spots = [...b.reachable(self, n, { ignoreEngagement: true, noTakeOff: true }).values()].filter(v => v.cost > 0).map(v => v.pos)
      const opts = spots.sort((x, y) => chebyshev(y, ctx.target.pos) - chebyshev(x, ctx.target.pos)).slice(0, 6)
      if (!opts.length) return
      const i = b.choose({ kind: 'skirmisher', unit: self, policy: 'reactions', title: 'Skirmisher', text: `Move ${n} space${n > 1 ? 's' : ''} after the attack?`, options: [{ label: 'Stay' }, ...opts.map(p => ({ label: `Move to ${fmtPos(p)}` }))], defaultIndex: 0 })
      if (i > 0) skirmishStep(b, self, opts[i - 1])
    },
    // the step is "immediately" after attacking: anything else the Nelson does forfeits it
    onAnyAction(b, self, actor) { if (actor === self) delete self.flags.skirmishStep },
    onTurnEnd(b, self) { delete self.flags.skirmishStep },
    actions: (b, u) => u.flags.skirmishStep ? [action({
      key: 'nelson-skirmisher', name: 'Skirmisher Step', activation: 'free', target: 'tile', range: u.flags.engageDrive ? 4 : 1,
      text: `Move ${u.flags.engageDrive ? 4 : 1} space(s); ignores engagement and doesn't provoke reactions.`,
      usable: (bt, self) => (bt.has(self, 'immobilized') || bt.has(self, 'slowed') ? 'Slowed/immobilized' : true),
      run: (bt, self, t) => skirmishStep(bt, self, t as Pos),
    })] : [],
  },
  { id: 'core:mf_nelson', note: 'Engage Drive', onCoreActivate: (b, u) => { u.flags.engageDrive = true } },
  // ---------------- IPS-N Raleigh
  {
    id: 'frame:mf_raleigh',
    note: 'Full Metal Jacket (auto reload if no attacks or forced saves this turn), Shielded Magazines',
    init: u => { u.flags.shieldedMagazines = true },
    onTurnEnd(b, u) {
      if (u.flags['turn:attacked'] || u.flags['turn:forcedSave']) return
      const ws = u.weapons.filter(w => !w.loaded && !w.destroyed)
      if (ws.length) { ws.forEach(w => (w.loaded = true)); u.flags.reloaded = true; b.say(`${u.name} reloads (Full Metal Jacket).`) }
    },
  },
  // ---------------- IPS-N Tortuga
  {
    id: 'frame:mf_tortuga',
    note: 'Sentinel, Guardian',
    init: u => { u.flags.guardian = true },
    beforeAttack(b, self, ctx, role) { if (role === 'attacker' && (ctx.mode === 'overwatch' || !self.activeTurn)) { ctx.accuracy++; ctx.reasons.push('Sentinel +1') } },
  },
  {
    id: 'core:mf_tortuga',
    note: 'Hyper-Reflex Mode: threat 3 for ranged weapons, 1/round an additional Overwatch (only), Overwatch hits Immobilize',
    onCoreActivate(b, u) { u.flags.hyperReflex = true; u.flags.extraOverwatch = 1 },
    onRoundStart(b, u) { if (u.flags.hyperReflex) u.flags.extraOverwatch = 1 },
    afterAttack(b, self, ctx, role) {
      if (role === 'attacker' && self.flags.hyperReflex && ctx.mode === 'overwatch' && ctx.hit) b.addStatus(ctx.target, 'immobilized', 'next_turn_end_target', self)
    },
  },
  // ---------------- IPS-N Vlad
  {
    id: 'frame:mf_vlad',
    note: 'Dismemberment, Shrike Armor',
    onStatusInflicted(b, self, t, st) {
      if (st === 'immobilized') { const inst = t.statuses.find(s => s.id === 'immobilized'); b.addStatus(t, 'shredded', inst?.clockUnit ? 'next_turn_end_target' : 'until_cleared', self) }
    },
    beforeAttack(b, self, ctx, role) {
      if (role === 'target' && ctx.attacker !== self && b.distance(self, ctx.attacker) <= 3) {
        b.say(`  Shrike Armor lashes ${ctx.attacker.name}.`)
        b.applyDamage(ctx.attacker, [{ type: 'Kinetic', amount: self.flags.tormentor ? 3 : 1 }], { source: self, ap: true })
        if (ctx.attacker.destroyed) ctx.cancelled = true
      }
    },
  },
  {
    id: 'core:mf_vlad',
    note: 'Tormentor Spines',
    onCoreActivate: (b, u) => { u.flags.tormentor = true },
    grantsResistance: (b, self, _type, d) => !!self.flags.tormentor && !!d.source && b.distance(self, d.source) <= 3,
  },
  // ---------------- SSC Black Witch
  {
    id: 'frame:mf_black_witch',
    note: 'Repulsor Field, Mag Parry (auto reaction)',
    init: u => { u.resist.push('Kinetic') },
    afterAnyRoll(b, self, ctx) {
      if (!ctx.hit || !ctx.profile?.damage.some(d => d.type === 'Kinetic')) return
      if (ctx.target !== self && (b.hostile(self, ctx.target) || !b.adjacent(self, ctx.target))) return
      if (b.has(ctx.target, 'invisible') || b.canSpend(self, 'reaction') !== true || !once(self, 'magparry')) return
      b.spend(self, 'reaction') // through spend(): reveals Hidden, ends Ghostweave, runs onAnyAction hooks
      const r = b.rng.d(6)
      b.say(`${self.name} attempts a Mag Parry (${r}).`)
      if (r >= 5) { ctx.hit = false; b.say('  Parried!') }
    },
  },
  // ---------------- SSC Death's Head
  {
    id: 'frame:mf_deaths_head',
    note: 'Neurolink (reroll first ranged miss each round); Perfected Targeting via bonus',
    beforeAttack(b, self, ctx, role) { if (role === 'attacker' && ctx.ranged && !ctx.tech && once(self, 'neurolink')) ctx.rerollOnMiss = true },
  },
  {
    id: 'core:mf_deaths_head',
    note: 'Neural Shunt: Mark for Death (focus a character 6-30 away; +1d6/2d6/3d6 bonus damage on ranged crits vs it out of cover; Immobilized and no reactions while focusing); Cease Focus protocol; the focus ends with the target',
    actions: (b, u) => u.coreActive ? [action({
      key: 'dh-mark', name: 'Mark for Death', activation: 'full', target: 'unit', range: 30,
      text: 'Focus on a character 6-30 spaces away: ranged crits against it deal bonus damage by weapon size while it is out of cover; you are Immobilized and can\'t react while focusing.',
      run: (bt, self, t) => {
        const target = t as Unit
        if (!target || !('id' in target) || target === self || (target.kind !== 'mech' && target.kind !== 'npc')) throw new Error('Choose a character')
        if (bt.distance(self, target) > 30) throw new Error('Out of range (30)')
        if (bt.distance(self, target) <= 5) throw new Error('Target must be further than range 5')
        self.flags.markTarget = target.id
        if (!self.statuses.some(s => s.id === 'immobilized' && s.data?.mark)) bt.addStatus(self, 'immobilized', 'until_cleared', self, { mark: true })
        bt.say(`${self.name} focuses on ${target.name}.`)
      },
      aiTarget: (bt, self) => chars(bt).filter(o => bt.hostile(self, o) && bt.distance(self, o) > 5 && bt.distance(self, o) <= 30).sort((x, y) => (y.flags.budget ?? 1) - (x.flags.budget ?? 1))[0] ?? null,
      aiScore: (bt, self) => (self.flags.markTarget ? -1 : 0),
    }), ...(u.flags.markTarget ? [action({
      key: 'dh-cease', name: 'Cease Focus', activation: 'protocol', target: 'none', text: 'End your focus on your Mark for Death target.',
      run: (bt, self) => ceaseFocus(bt, self),
      aiScore: (bt, self) => (bt.unit(self.flags.markTarget)?.destroyed ? 3 : -1),
    })] : [])] : [],
    ...markForDeath,
  },
  // ---------------- SSC Dusk Wing
  {
    id: 'frame:mf_dusk_wing',
    note: 'Maneuverability Jets (hovers while it moves and is on the ground again once it acts or its turn ends), Harlequin Cloak (invisible on own turn)',
    // hover: it takes off for each move (movement treats a landed flyer that way) and is back on the ground afterwards
    init: u => { u.flying = false; u.flags.landed = true; u.flags.hover = true },
    onTurnStart: (b, u) => { b.addStatus(u, 'invisible', 'end_of_turn', u); duskLand(b, u) },
    onTurnEnd: (b, u) => duskLand(b, u),
    onAnyAction: (b, self, actor) => { if (actor === self) duskLand(b, self) },
  },
  // ---------------- SSC Metalmark
  {
    id: 'frame:mf_metalmark',
    note: 'Flash Cloak (invisible vs reactions while moving), Carapace Adaptation',
    beforeAttack(b, self, ctx, role) {
      if (role !== 'target') return
      if (ctx.mode === 'overwatch') ctx.forceInvisible = true
      // cover is added after the attack hooks, so look at it directly: soft cover gives +2 difficulty instead of +1
      if (ctx.ranged && !ctx.ignoreCover && b.cover(ctx.attacker, self, b.blastCentre ?? b.attackOrigin ?? undefined) === 'soft') { ctx.difficulty++; ctx.reasons.push('Carapace -1') }
    },
  },
  { id: 'core:mf_metalmark', note: 'Tactical Cloak', onCoreActivate: (b, u) => { b.addStatus(u, 'invisible', 'scene', u) } },
  // ---------------- SSC Monarch
  {
    id: 'frame:mf_monarch',
    note: 'Avenger Silos (1/round on a ranged crit: 3 explosive to a character of your choice within 15 and line of sight); Seeking Payload (Launcher attacks vs a Locked On character count as Seeking, consume the Lock On and cannot be reduced)',
    // the attack itself consumes the Lock On (buildWeaponCtx, before the scripts run); a preview leaves it in place
    seeksTarget: (b, self, w, t) => isWeaponType(w, 'Launcher') && b.hostile(self, t) && b.has(t, 'lockon'),
    beforeAttack(b, self, ctx, role) {
      if (role !== 'attacker' || !isWeaponType(ctx.weapon, 'Launcher') || !b.hostile(self, ctx.target)) return
      if (!ctx.lockOnConsumed && !b.has(ctx.target, 'lockon')) return
      ctx.ignoreCover = true
      ctx.noLosNeeded = true
      ctx.irreducible = true
      ctx.reasons.push('Seeking Payload')
    },
    afterAttack(b, self, ctx, role) {
      if (role !== 'attacker' || !ctx.crit || !ctx.ranged || self.flags['round:avenger']) return
      const opts = chars(b).filter(o => o !== ctx.target && o !== self && b.distance(self, o) <= 15 && b.los(self, o))
        .sort((x, y) => (b.hostile(self, y) ? 1 : 0) - (b.hostile(self, x) ? 1 : 0) || x.hp - y.hp)
      if (!opts.length) return
      const def = b.hostile(self, opts[0]) ? 1 : 0
      const i = b.choose({ kind: 'avenger_silos', unit: self, title: 'Avenger Silos', text: 'Deal 3 explosive to a different character within range 15 and line of sight?', options: [{ label: 'Hold fire' }, ...opts.map(o => ({ label: o.name, hint: b.hostile(self, o) ? 'hostile' : 'allied' }))], defaultIndex: def })
      if (!i) return
      self.flags['round:avenger'] = true
      b.say(`${self.name}'s Avenger Silos fire!`)
      b.applyDamage(opts[i - 1], [{ type: 'Explosive', amount: 3 }], { source: self })
    },
  },
  {
    id: 'core:mf_monarch',
    note: 'Divine Punishment',
    onCoreActivate(b, u) {
      for (const t of hostilesWithin(b, u, 50)) {
        const dmg = rollDice(b.rng, '1d6+4').total
        const ok = b.save(t, 'agi', u.stats.save, 0, u)
        if (ok && t.isGrunt) continue
        b.applyDamage(t, [{ type: 'Explosive', amount: ok ? b.halfOnSave(t, dmg) : dmg }], { source: u })
      }
    },
  },
  // ---------------- SSC Mourning Cloak
  {
    id: 'frame:mf_mourning_cloak',
    note: 'Hunter (+1d6 vs isolated targets, 1/round); Biotic Components via bonus',
    beforeAttack(b, self, ctx, role) {
      if (role !== 'attacker' || !ctx.melee) return
      const others = b.alive().filter(o => o !== ctx.target && o !== self && b.adjacent(o, ctx.target) && o.kind !== 'deployable')
      // 1/round "on hit": offered while unused this round, and only spent by a hit (afterAttack)
      if (!others.length && !self.flags['round:hunter']) { ctx.bonusDamage.push({ type: 'Kinetic', val: '1d6' }); ctx.reasons.push('Hunter +1d6') }
    },
    afterAttack(b, self, ctx, role) { if (role === 'attacker' && ctx.hit && ctx.reasons.includes('Hunter +1d6')) once(self, 'hunter') },
  },
  {
    id: 'core:mf_mourning_cloak',
    note: 'Blinkspace Jump (full action: roll 3d6, then teleport to a space within that range, no line of sight needed; occupied space: you stay and the action is lost; triples: you vanish until the rest, without being destroyed); Stabilize Singularity: Boosts and standard moves teleport for the scene',
    onCoreActivate(b, u) { u.flags.teleportMoves = true; b.say(`${u.name} stabilizes its singularity: its moves now teleport.`) },
    actions: (b, u) => [u.flags['turn:blinkRange'] ? action({
      key: 'mc-blink-to', name: `Blinkspace: teleport (range ${u.flags['turn:blinkRange']})`, activation: 'free', target: 'tile', range: u.flags['turn:blinkRange'],
      text: `Teleport to a space within range ${u.flags['turn:blinkRange']} (the Blinkspace Jump roll). An occupied space: you stay put and the jump is lost.`,
      run: (bt, self, t) => {
        const p = t && 'x' in t ? t : (t as Unit).pos
        const r = self.flags['turn:blinkRange']
        if (chebyshev(p, self.pos) > r) throw new Error(`Out of range (${r})`)
        delete self.flags['turn:blinkRange']
        if (!freeFor(bt, self, p)) { bt.say('  Occupied: the jump fails.'); return }
        if (bt.teleportBlocked(self, p)) { bt.say('  An interdiction field blocks the jump.'); return }
        teleportTo(bt, self, p)
      },
      aiTarget: (bt, self) => {
        const h = chars(bt).filter(o => bt.hostile(self, o)).sort((x, y) => bt.distance(self, x) - bt.distance(self, y))[0]
        return h ? teleportSpots(bt, self, self.flags['turn:blinkRange'], p => -chebyshev(p, h.pos), 1)[0] ?? null : null
      },
      aiScore: () => 1,
    }) : action({
      key: 'mc-blink', name: 'Blinkspace Jump', activation: 'full', target: 'none',
      text: 'Roll 3d6, then teleport to a space within that range (no line of sight needed). An occupied space: you stay put. Triples: you vanish until the rest.',
      run: (bt, self) => {
        const dice = [bt.rng.d(6), bt.rng.d(6), bt.rng.d(6)]
        const r = dice[0] + dice[1] + dice[2]
        bt.say(`  Blinkspace range ${r} [${dice.join(',')}]`)
        if (dice[0] === dice[1] && dice[1] === dice[2]) {
          bt.say(`${self.name} vanishes into blinkspace — it will reappear after the rest.`)
          self.flags.vanished = { hp: self.hp, structure: self.structure, stress: self.stress }
          // gone, not destroyed: no wreck and no destruction effects
          bt.removeUnit(self, 'is lost in blinkspace')
          if (bt.activeId === self.id) { self.activeTurn = false; bt.activeId = null; bt.checkVictory(); bt.handOverTurn(self) } else bt.checkVictory()
          return
        }
        self.flags['turn:blinkRange'] = r
      },
      aiScore: () => -1,
    })],
  },
  // ---------------- SSC Swallowtail
  {
    id: 'frame:mf_swallowtail',
    note: 'Integrated Cloak (Invisible after a turn without moving, until it moves or reacts, or its next turn starts), Prophetic Scanners',
    onTurnEnd(b, u) { if (!u.flags['turn:moved']) b.addStatus(u, 'invisible', 'start_of_next_turn_target', u, { integratedCloak: true }) },
    onMove(b, self, mover) { if (mover === self) dropCloak(b, self) },
    onAnyAction(b, self, actor, cost) { if (actor === self && cost === 'reaction') dropCloak(b, self) },
    onStatusInflicted(b, self, t, st) { if (st === 'lockon' && once(self, 'prophetic')) b.addStatus(t, 'shredded', 'next_turn_end_target', self) },
  },
  {
    id: 'core:mf_swallowtail',
    note: 'Prophetic Interjection: Tactical Simulation reaction (1/round, offered): an allied character in line of sight is hit by another character in line of sight: 1d6, 4+ Resistance to the attack and a teleport up to 3, else a teleport up to 6',
    onCoreActivate: (b, u) => { u.flags.tacSim = true },
    afterAnyRoll(b, self, ctx) {
      const t = ctx.target, att = ctx.attacker
      if (!self.flags.tacSim || !ctx.hit || ctx.cancelDamage || t === self || att === t || b.hostile(self, t) || (t.kind !== 'mech' && t.kind !== 'npc')) return
      if (!b.los(self, t) || !b.los(self, att) || self.flags['round:tacsim'] || b.canSpend(self, 'reaction', 'tactical_simulation') !== true) return
      if (!b.offerReaction(self, 'tactical_simulation', 'Tactical Simulation', `${att.name} hit ${t.name}. Roll the simulation (1d6: 4+ Resistance and a 3-space teleport, else a 6-space teleport)?`)) return
      self.flags['round:tacsim'] = true
      b.spend(self, 'reaction', 'tactical_simulation') // through spend(): reveals Hidden, ends Ghostweave, runs onAnyAction hooks
      const r = b.rng.d(6)
      b.say(`${self.name}: Tactical Simulation (${r}).`)
      if (r >= 4) ctx.resistAll = true
      const reach = r >= 4 ? 3 : 6
      // the ally picks where its "true" location was: spaces out of the attacker's sight first, then away from it
      const spots = teleportSpots(b, t, reach, p => (seenAt(b, att, t, p) ? 0 : 100) + chebyshev(p, att.pos))
      if (!spots.length) return
      const i = b.choose({ kind: 'tactical_simulation_move', unit: t, title: 'Tactical Simulation', text: `Teleport up to ${reach} spaces?`, options: [{ label: 'Stay' }, ...spots.map(p => ({ label: `Teleport to ${fmtPos(p)}`, hint: seenAt(b, att, t, p) ? undefined : `out of ${att.name}'s sight` }))], defaultIndex: seenAt(b, att, t, spots[0]) ? 0 : 1 })
      if (i > 0) { teleportTo(b, t, spots[i - 1]); b.say(`  ${t.name} was never there.`) }
    },
  },
  // ---------------- HORUS Balor
  {
    id: 'frame:mf_balor',
    note: 'Scouring Swarm, Regeneration (ceases until the end of its next turn after stress or structure damage), Self-Perpetuating (full HP at each rest, without repairs: run layer)',
    onAnyTurnStart(b, self, u) {
      if (!b.hostile(self, u) || (u.kind !== 'mech' && u.kind !== 'npc')) return
      if (b.adjacent(self, u)) b.applyDamage(u, [{ type: 'Kinetic', amount: self.flags.hiveFrenzy ? 4 : 2 }], { source: self })
    },
    // "ceases until the end of its next turn": during its own turn that is this turn's end and the next; otherwise its coming turn
    onStructureDamage: (b, u) => noRegen(u),
    onStressDamage: (b, u) => noRegen(u),
    onTurnEnd(b, u) {
      if ((u.flags.noRegenTurns ?? 0) > 0) { u.flags.noRegenTurns--; return }
      b.heal(u, Math.floor(u.stats.hp / (u.flags.hiveFrenzy ? 2 : 4)))
    },
  },
  {
    id: 'core:mf_balor',
    note: 'Hive Frenzy: soft cover for you and adjacent allies, Scouring Swarm 4, Regeneration 1/2, Shredded; structure damage: 1d6, on a 6 no structure damage, back to 1 HP and Immunity to all damage until the end of the turn',
    onCoreActivate(b, u) { u.flags.hiveFrenzy = true; b.addStatus(u, 'shredded', 'scene', u) },
    adjustCover: (b, self, attacker, target, c) => (self.flags.hiveFrenzy && (target === self || (!b.hostile(self, target) && b.adjacent(self, target))) && c === 'none' ? 'soft' : c),
    beforeStructureDamage(b, u) {
      if (!u.flags.hiveFrenzy) return false
      const r = b.rng.d(6)
      if (r !== 6) { b.say(`${u.name}'s Hive Frenzy (${r}).`); return false }
      u.hp = 1
      u.flags.hiveImmune = true
      b.say(`${u.name} hellishly pulls itself together! (Immune to all damage this turn)`, 'warn')
      return true
    },
    beforeAnyDamage(b, self, target, parts) { if (target === self && self.flags.hiveImmune) for (const p of parts) p.amount = 0 },
    onTurnEnd: (b, u) => { delete u.flags.hiveImmune },
    onAnyTurnEnd: (b, self) => { delete self.flags.hiveImmune },
  },
  // ---------------- HORUS Goblin
  {
    id: 'frame:mf_goblin',
    note: 'Liturgicode & Fragile via bonuses; Reactive Code: when hit by a tech attack, take any Quick Tech option against the attacker as a reaction (1/round)',
    afterAnyRoll(b, self, ctx) {
      if (ctx.target !== self || !ctx.tech || !ctx.hit || ctx.attacker === self || ctx.attacker.destroyed || !b.hostile(self, ctx.attacker)) return
      if (self.flags['round:reactive'] || b.canSpend(self, 'reaction') !== true || b.techTargetValid(self, ctx.attacker) !== true) return
      const att = ctx.attacker
      const invades = b.customActions(self).filter(a => a.techOption === 'invade' && a.target !== 'none' && a.target !== 'tile')
      const opts = [{ label: 'Lock On' }, { label: 'Invade: Fragment Signal', hint: '2 heat, Impaired and Slowed' }, ...invades.map(a => ({ label: `Invade: ${a.name}` })), { label: 'Scan' }, { label: 'No reaction' }]
      if ((self.policies.reactions ?? 'ask') === 'off' && self.side === 'player') return
      const pick = b.choose({ kind: 'reactive_code', unit: self, policy: 'reactions', title: 'Reactive Code', text: `${att.name} hit ${self.name} with a tech attack. Take a Quick Tech option against it as a reaction?`, options: opts, defaultIndex: 1 })
      if (pick === opts.length - 1) return
      self.flags['round:reactive'] = true
      b.spend(self, 'reaction') // through spend(): reveals Hidden, ends Ghostweave, runs onAnyAction hooks
      b.say(`${self.name}'s Reactive Code answers ${att.name}.`)
      b.withFreeTech(self, () => {
        if (pick === 0) b.lockOn(self, att)
        else if (pick === 1) b.invade(self, att)
        else if (pick === opts.length - 2) b.scan(self, att)
        else { const a = invades[pick - 2]; b.say(`  ${a.name}`); a.run(b, self, att) }
      })
    },
  },
  // ---------------- HORUS Gorgon
  {
    id: 'frame:mf_gorgon',
    note: 'Metastatic Paralysis, Gaze (extra reaction via bonus), Guardian',
    init: u => { u.flags.guardian = true },
    afterAnyRoll(b, self, ctx) {
      if (ctx.target !== self || ctx.roll == null || ctx.roll > 2) return
      ctx.hit = false
      b.say(`  Metastatic Paralysis! ${ctx.attacker.name} is stunned.`)
      b.addStatus(ctx.attacker, 'stunned', 'next_turn_end_target', self)
    },
  },
  {
    id: 'core:mf_gorgon',
    note: 'Extrude Basilisk',
    onCoreActivate: (b, u) => { u.flags.basilisk = true },
    beforeAnyAttack(b, self, ctx) {
      if (!self.flags.basilisk || !b.hostile(self, ctx.attacker) || ctx.attacker.flags[`basilisk:${self.id}`]) return
      if (ctx.target !== self && (b.hostile(self, ctx.target) || b.distance(self, ctx.target) > 3)) return
      if (!b.save(ctx.attacker, 'sys', self.stats.save, 0, self)) {
        ctx.attacker.flags[`basilisk:${self.id}`] = true
        b.addStatus(ctx.attacker, 'stunned', 'next_turn_end_target', self)
        ctx.cancelled = true
      }
    },
  },
  // ---------------- HORUS Manticore
  {
    id: 'frame:mf_manticore',
    note: 'Slag Carapace; Unstable System (when destroyed, explodes as a reactor meltdown at the end of its next turn); Castigate the Enemies of the Godhead (the Castigation State, chosen at a rest: explodes at once when destroyed, 8d6 in Burst 2)',
    init: u => { u.resist.push('Energy', 'Burn') },
    onDestroyed(b, self, victim) {
      if (victim !== self || self.flags.exploded || self.flags.removed) return
      self.flags.exploded = true
      if (self.flags.castigation) { manticoreBlast(b, self, '8d6', 'goes up in the Castigation State'); return }
      // a reactor meltdown or self-destruct has already exploded
      if ((self.meltdownTurns != null && self.meltdownTurns <= 0) || (self.selfDestructTurns != null && self.selfDestructTurns <= 0)) return
      armUnstable(b, self)
    },
  },
  {
    id: 'trait:manticore_reactor',
    note: "a destroyed Manticore's unstable reactor: explodes at the end of its side's next turn",
    onAnyTurnEnd(b, self, u) {
      if (u.side !== self.side || u.kind === 'deployable' || u.kind === 'drone') return
      if ((self.flags.skipTurns ?? 0) > 0) { self.flags.skipTurns--; return }
      const m = b.unit(self.flags.reactorOf)
      b.removeUnit(self, 'goes critical')
      if (m) manticoreBlast(b, m, '4d6', 'explodes (Unstable System)')
    },
  },
  {
    id: 'core:mf_manticore',
    note: 'Charged Exoskeleton passive; Destruction of the Temple (charge die, burst 2 inferno)',
    onHeat(b, u, amount) {
      if (amount > 0 && once(u, 'charged-exo')) {
        const t = hostilesWithin(b, u, 3)[0]
        if (t) { b.say(`${u.name}'s Charged Exoskeleton arcs.`); b.applyDamage(t, [{ type: 'Energy', amount: 2 }], { source: u, ap: true }) }
      }
      manticoreCharge(b, u)
    },
    // "Whenever you take heat or energy": energy damage charges too (a hit with heat already counted in onHeat)
    onDamaged(b, u, d) { if (d.types?.includes('Energy') && !d.types.includes('Heat')) manticoreCharge(b, u) },
    onCoreActivate(b, u) { u.resist.push('Heat'); u.flags.chargeDie = 1 },
  },
  // ---------------- HORUS Minotaur
  {
    id: 'frame:mf_minotaur',
    note: 'Localized Maze (hostiles always stop when engaged)',
    init: u => { u.flags.localizedMaze = true },
  },
  {
    id: 'core:mf_minotaur',
    note: 'Maze (CORE: a character of your choice within Sensors is Stunned; Systems save at +3 difficulty at the end of each of its turns, +1 accuracy per failure); Metafold Maze (quick, after a tech hit: Slowed, then Immobilized, then Stunned (once per combat per character), until the end of your next turn)',
    afterAttack(b, self, ctx, role) {
      if (role !== 'attacker' || !ctx.tech || !ctx.hit || !self.activeTurn || ctx.target.destroyed) return
      const hits: string[] = self.flags['turn:mazeHits'] ?? []
      if (!hits.includes(ctx.target.id)) self.flags['turn:mazeHits'] = [...hits, ctx.target.id]
    },
    actions: (b, u) => (u.flags['turn:mazeHits']?.length ? [action({
      key: 'metafold-maze', name: 'Metafold Maze', activation: 'quick', target: 'unit', range: 50,
      text: 'A character you hit with a tech attack this turn becomes Slowed until the end of your next turn; if already Slowed, Immobilized; if already Immobilized, Stunned (once per combat per character).',
      run: (bt, self, t) => {
        const tg = t as Unit
        const hits: string[] = self.flags['turn:mazeHits'] ?? []
        if (!tg || !('id' in tg) || !hits.includes(tg.id) || tg.destroyed) throw new Error('Choose a character you hit with a tech attack this turn')
        self.flags['turn:mazeHits'] = hits.filter(x => x !== tg.id)
        metafold(bt, self, tg)
      },
      aiTarget: (bt, self) => ((self.flags['turn:mazeHits'] ?? []) as string[]).map(id => bt.unit(id)).find(x => x && !x.destroyed && bt.hostile(self, x)) ?? null,
      aiScore: () => 3,
    })] : []),
    onCoreActivate(b, u) {
      // (an ally is a legal choice in the text but never a useful one: hostiles only)
      const opts = chars(b).filter(t => b.hostile(u, t) && b.distance(u, t) <= u.stats.sensors).sort((x, y) => (y.flags.budget ?? 1) - (x.flags.budget ?? 1))
      if (!opts.length) { b.say('  No hostile character within Sensors.'); return }
      const i = b.choose({ kind: 'maze', unit: u, title: 'Maze', text: 'Trap which character within Sensors?', options: opts.map(o => ({ label: o.name, hint: `${b.distance(u, o)} spaces` })), defaultIndex: 0 })
      const t = opts[i]
      b.addStatus(t, 'stunned', 'until_cleared', u, { maze: true })
      t.flags.mazeAcc = -3
    },
    onAnyTurnEnd(b, self, u) {
      const s = u.statuses.find(s => s.id === 'stunned' && s.data?.maze && s.source === self.id)
      if (!s) return
      if (b.save(u, 'sys', self.stats.save, u.flags.mazeAcc ?? -3, self)) b.removeStatus(u, 'stunned')
      else u.flags.mazeAcc = (u.flags.mazeAcc ?? -3) + 1
    },
  },
  // ---------------- HORUS Hydra / Pegasus: data bonuses + integrated items
  {
    id: 'frame:mf_hydra',
    note: 'System Link (+5 HP via bonuses); Shepherd Field: drones, deployables and objects adjacent to the Hydra have Resistance to all damage',
    grantsAnyResistance: (b, self, target) => (target.kind === 'drone' || target.kind === 'deployable') && b.adjacent(self, target),
  },
  // ---------------- HA Barbarossa
  {
    id: 'frame:mf_barbarossa',
    note: 'Heavy Frame, Pressure Plating, Colossus, Slow',
    init: u => { u.flags.guardian = true; u.resist.push('Explosive') },
    ...heavyFrame,
  },
  // ---------------- HA Genghis
  {
    id: 'frame:mf_genghis',
    note: 'Insulated, Emergency Vent',
    init: u => { u.immune.push('burn') },
    onStructureDamage: (b, u) => { u.heat = 0; b.say(`${u.name} vents all heat.`) },
  },
  {
    id: 'core:mf_genghis',
    note: 'Expose Power Cells: the next time you exceed your Heat Cap, clear all heat and vent a Burst 3 cloud: until the start of your next turn characters in it are Invisible to all but you, and others take 2 burn and 2 heat when they start their turn in it or first enter it in a round; then soft cover (ignored by you) until the start of your following turn',
    onCoreActivate: (b, u) => { u.flags.powerCells = true },
    beforeOverheat(b, u) {
      if (!u.flags.powerCells) return false
      u.flags.powerCells = false
      u.heat = 0
      const tiles = burstTiles(b.map, u, 3)
      u.flags.cloud = { tiles, phase: 1 } as Cloud
      u.flags.burnZones = [...(u.flags.burnZones ?? []), { id: `cloud-${u.id}`, tiles, burn: 2, heat: 2, spareOwner: true } as BurnZone]
      b.emit({ type: 'area', tiles, kind: 'soft_cover' })
      b.say(`${u.name} vents a burning cloud!`)
      return true
    },
    onTurnStart(b, u) {
      const c = u.flags.cloud as Cloud | undefined
      if (!c) return
      if (c.phase === 1) { c.phase = 2; u.flags.burnZones = (u.flags.burnZones ?? []).filter((z: BurnZone) => z.id !== `cloud-${u.id}`); b.say(`${u.name}'s cloud stops burning and thins to cover.`) }
      else { delete u.flags.cloud; b.say(`${u.name}'s cloud disperses.`) }
    },
    onAnyTurnStart: (b, self, u) => burnZoneStart(b, self, u),
    onMove: (b, self, mover, path) => burnZoneEnter(b, self, mover, path),
    beforeAnyAttack(b, self, ctx) {
      const c = self.flags.cloud as Cloud | undefined
      if (c?.phase === 1 && ctx.attacker !== self && inCloud(c, ctx.target)) { ctx.forceInvisible = true; ctx.reasons.push('Burning cloud (Invisible)') }
    },
    adjustCover: (b, self, attacker, target, cov) => {
      const c = self.flags.cloud as Cloud | undefined
      return c?.phase === 2 && attacker !== self && cov === 'none' && inCloud(c, target) ? 'soft' : cov
    },
    fields: (_b, u) => (u.flags.cloud ? [{ tiles: (u.flags.cloud as Cloud).tiles, effect: (u.flags.cloud as Cloud).phase === 1 ? 'harm' as const : 'protect' as const, label: (u.flags.cloud as Cloud).phase === 1 ? `${u.name}'s burning cloud: Invisible inside (except to ${u.name}); 2 burn and 2 heat on starting a turn in it or entering it` : `${u.name}'s cloud: soft cover (ignored by ${u.name})` }] : []),
  },
  // ---------------- HA Iskander
  {
    id: 'frame:mf_iskander',
    note: 'Assault Launcher (1/round a grenade or mine at range 15), Mine Deployers (1/round after planting a Mine: up to two more Mines in free adjacent spaces, free), Skeleton Key',
    init: u => { u.flags.skeletonKey = true; u.flags.assaultLauncher = true },
    onRoundStart: (b, u) => { u.flags.assaultLauncher = true },
    onMinePlaced(b, self, mine) {
      // planted beyond reach: that was the Assault Launcher (1/round)
      if (chebyshev(mine.pos, self.pos) > Math.max(1, Math.floor(self.stats.size))) self.flags.assaultLauncher = false
      if (self.flags.deployingMines || self.flags['round:mineDeployers'] || !self.activeTurn) return
      self.flags['round:mineDeployers'] = true
      self.flags.extraMines = 2
    },
    onTurnEnd: (b, u) => { delete u.flags.extraMines },
    actions: (b, u) => ((u.flags.extraMines ?? 0) > 0 ? [action({
      key: 'iskander-mines', name: `Deploy Additional Mines (${u.flags.extraMines} left)`, activation: 'free', target: 'tile', range: 1,
      text: 'Mine Deployers: plant another of your Mines in a free space adjacent to you (up to two).',
      run: (bt, self, t) => {
        const p = t && 'x' in t ? t : (t as Unit).pos
        if (!footprint(self).some(q => chebyshev(q, p) === 1) || footprint(self).some(q => q.x === p.x && q.y === p.y)) throw new Error('Pick a space adjacent to you')
        const opts = minePlanters(bt, self, p)
        if (!opts.length) throw new Error('No Mine you can plant there')
        const i = bt.choose({ kind: 'mine_deployers', unit: self, title: 'Mine Deployers', text: 'Plant which Mine?', options: opts.map(a => ({ label: a.name })), defaultIndex: 0 })
        self.flags.deployingMines = true
        try { opts[i].run(bt, self, p) } finally { delete self.flags.deployingMines }
        self.flags.extraMines--
      },
      aiTarget: (bt, self) => {
        for (const q of footprint(self)) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const p = { x: q.x + dx, y: q.y + dy }
          if (footprint(self).some(r => r.x === p.x && r.y === p.y) || !tileAt(bt.map, p)) continue
          if (minePlanters(bt, self, p).length) return p
        }
        return null
      },
      aiScore: () => 2,
    })] : []),
  },
  {
    id: 'core:mf_iskander',
    note: 'Death Cloud',
    onCoreActivate: (b, u) => { u.flags.deathCloud = true },
    onAnyMovementAction(b, self, mover, kind) {
      if (!self.flags.deathCloud || !b.hostile(self, mover) || kind === 'standard') return
      if (mover.flags[`round:deathcloud:${self.id}`]) return
      mover.flags[`round:deathcloud:${self.id}`] = true
      b.applyDamage(mover, [{ type: 'Explosive', amount: 3 }], { source: self, ap: true })
    },
  },
  // ---------------- HA Napoleon
  {
    id: 'frame:mf_napoleon',
    note: 'Heavy Shielding (half damage on a successful check or save becomes 1); Flash Aegis (Bracing reduces incoming damage to 1 instead of Resistance)',
    init: u => { u.flags.flashAegis = true; u.flags.heavyShielding = true },
  },
  {
    id: 'core:mf_napoleon',
    note: 'Activate Aegis: all damage (burn included) reduced to 1 unless it ignores reduction; Immunity to all tech actions; only Shield systems; no quick/full actions or reactions except standard moves, Grapple, Ram, Improvised Attack, Activate (Shield), Skill Check and Boost; no Overcharge',
    onCoreActivate(b, u) {
      u.flags.aegis = true
      u.flags.noOvercharge = true
      u.flags.techImmune = true
      for (const s of ['lockon', 'jammed', 'bolstered'] as const) b.removeStatus(u, s)
    },
    modifyIncoming: (b, self, d) => { if (self.flags.aegis && !d.irreducible && d.amount > 1) d.amount = 1 },
    beforeAnyDamage(b, self, target, parts, opts) {
      if (target !== self || !self.flags.aegis || (opts as { irreducible?: boolean }).irreducible) return
      for (const p of parts) if (p.type === 'Burn' && p.amount > 1) p.amount = 1
    },
    beforeAttack(b, self, ctx, role) { if (role === 'target' && self.flags.aegis && ctx.tech) ctx.cancelled = true },
    forbidsAction(b, self, cost, a) {
      if (!self.flags.aegis) return undefined
      if (cost === 'reaction') return 'Aegis: no reactions'
      if (cost === 'quick') return !a || ['boost', 'grapple', 'ram'].includes(a) || (a.startsWith('activate:') && shieldSystem(self, a)) ? undefined : 'Aegis: only standard moves, Boost, Grapple, Ram, Improvised Attacks and Shield systems'
      if (cost === 'full') return a === 'improvised' || (a?.startsWith('activate:') && shieldSystem(self, a)) ? undefined : 'Aegis: only standard moves, Boost, Grapple, Ram, Improvised Attacks and Shield systems'
      return undefined
    },
  },
  // ---------------- HA Saladin
  {
    id: 'frame:mf_saladin',
    note: 'Reinforced Frame, Guardian, Warp Shield (1/round reaction, offered: +1 difficulty to an attack on you or an allied character within Sensors)',
    init: u => { u.immune.push('shredded'); u.flags.guardian = true },
    beforeAnyAttack(b, self, ctx) {
      const t = ctx.target
      if (b.hostile(self, t) || !b.hostile(self, ctx.attacker) || (t.kind !== 'mech' && t.kind !== 'npc') || b.distance(self, t) > self.stats.sensors) return
      if (self.flags['round:warpshield'] || b.canSpend(self, 'reaction', 'warp_shield') !== true) return
      if (!b.offerReaction(self, 'warp_shield', 'Warp Shield', `${ctx.attacker.name} attacks ${t.name}. Give the attack +1 difficulty?`)) return
      self.flags['round:warpshield'] = true
      b.spend(self, 'reaction', 'warp_shield') // through spend(): reveals Hidden, ends Ghostweave, runs onAnyAction hooks
      ctx.difficulty++
      ctx.reasons.push(`${self.name} Warp Shield -1`)
    },
  },
  {
    id: 'core:mf_saladin',
    note: 'Tachyon Shield over an allied character within Sensors (chosen; Retarget as a quick action); Defensive Pulse (1/round reaction, offered): Resistance to all damage from an attack on the target, and on a miss the attacker rerolls against a character of your choice, from the target',
    onCoreActivate(b, u) {
      const allies = alliesWithin(b, u, u.stats.sensors)
      const opts = (allies.length ? allies : [u]).sort((x, y) => x.hp / x.stats.hp - y.hp / y.stats.hp)
      const i = b.choose({ kind: 'tachyon_shield', unit: u, title: 'Tachyon Shield', text: 'Project the shield over which allied character?', options: opts.map(o => ({ label: o.name, hint: `${o.hp}/${o.stats.hp} HP` })), defaultIndex: 0 })
      u.flags.tachyonTarget = opts[i].id
      b.say(`Tachyon shield projected over ${opts[i].name}.`)
    },
    actions: (b, u) => (u.flags.tachyonTarget ? [action({
      key: 'tachyon-retarget', name: 'Retarget Tachyon Shield', activation: 'quick', target: 'ally', range: u.stats.sensors,
      text: 'Move your Tachyon Shield to another allied character within Sensors.',
      run: (bt, self, t) => {
        const tg = t as Unit
        if (!tg || !('id' in tg) || tg === self || bt.hostile(self, tg) || (tg.kind !== 'mech' && tg.kind !== 'npc') || bt.distance(self, tg) > self.stats.sensors) throw new Error('Choose an allied character within Sensors')
        self.flags.tachyonTarget = tg.id
        bt.say(`Tachyon shield moves to ${tg.name}.`)
      },
      aiScore: () => -1,
    })] : []),
    beforeAnyAttack(b, self, ctx) {
      if (self.flags.tachyonTarget !== ctx.target.id || !b.hostile(self, ctx.attacker) || self.flags['round:pulse'] || b.canSpend(self, 'reaction', 'defensive_pulse') !== true) return
      if (!b.offerReaction(self, 'defensive_pulse', 'Defensive Pulse', `${ctx.attacker.name} attacks ${ctx.target.name}. Pulse the tachyon shield (Resistance to the attack; a miss may be redirected)?`)) return
      self.flags['round:pulse'] = true
      b.spend(self, 'reaction', 'defensive_pulse') // through spend(): reveals Hidden, ends Ghostweave, runs onAnyAction hooks
      ctx.resistAll = true
      ctx.reasons.push('Defensive Pulse')
      ;(ctx as AttackCtx & { pulseBy?: string }).pulseBy = self.id
    },
    afterAnyRoll(b, self, ctx) {
      const shielded = ctx.target
      if ((ctx as AttackCtx & { pulseBy?: string }).pulseBy !== self.id || ctx.hit || ctx.cancelled || !ctx.weapon || ctx.multiTarget || b.sandboxDepth || b.reactionDepth >= 2) return
      const w = ctx.weapon, att = ctx.attacker
      if (b.isAoE(b.profile(w))) return
      // the reroll is checked from the shielded target: range and line of sight from there
      const opts = chars(b).filter(o => o !== shielded && b.validTarget(att, w, o, shielded.pos) === true)
        .sort((x, y) => (b.hostile(self, y) ? 1 : 0) - (b.hostile(self, x) ? 1 : 0))
      if (!opts.length) return
      const i = b.choose({ kind: 'defensive_pulse_redirect', unit: self, title: 'Defensive Pulse', text: `The attack missed. Force ${att.name} to reroll it against another character?`, options: [{ label: 'No' }, ...opts.map(o => ({ label: o.name, hint: b.hostile(self, o) ? 'hostile' : 'allied' }))], defaultIndex: b.hostile(self, opts[0]) ? 1 : 0 })
      if (!i) return
      b.say(`  The pulse turns ${att.name}'s attack toward ${opts[i - 1].name}!`)
      b.reactionDepth++
      try { b.weaponAttack(att, w, { targetId: opts[i - 1].id }, 'free', { from: { ...shielded.pos } }) } finally { b.reactionDepth-- }
    },
  },
  // ---------------- HA Sherman
  {
    id: 'frame:mf_sherman',
    note: 'Superior Reactor via bonus; Mathur Stop (after a Stabilize clears all heat: a free action takes heat equal to half the Heat Cap); Vent Heat (soft cover until the start of your next turn after Stabilizing or exceeding the Heat Cap)',
    onHeat: (b, u) => { if (u.heat > u.stats.heatcap) u.flags.ventCover = true },
    onStabilize: (b, u) => { u.flags.ventCover = true; u.flags['turn:mathur'] = true },
    onTurnStart: (b, u) => { delete u.flags.ventCover },
    adjustCover: (b, self, attacker, target, c) => (target === self && self.flags.ventCover && c === 'none' ? 'soft' : c),
    actions: (b, u) => (u.flags['turn:mathur'] && u.heat === 0 ? [action({
      key: 'mathur-stop', name: 'Mathur Stop', activation: 'free', target: 'none',
      text: `Take heat equal to half your Heat Cap (${Math.floor(u.stats.heatcap / 2)}), putting you in the Danger Zone.`,
      run: (bt, self) => { delete self.flags['turn:mathur']; bt.addHeat(self, Math.floor(self.stats.heatcap / 2), self) },
      aiScore: () => -1,
    })] : []),
  },
  // ---------------- HA Tokugawa
  {
    id: 'frame:mf_tokugawa',
    note: 'Limit Break (while Exposed: +3 energy bonus damage, kinetic/explosive weapons deal energy, +5 range/+1 threat); Plasma Sheath (in the Danger Zone with a weapon dealing energy, all bonus damage becomes burn)',
    init: u => {
      u.bonuses.push({ id: 'range', val: 5, range_types: ['Range'], condition: '{exposed}' }, { id: 'threat', val: 1, weapon_types: ['Melee'], condition: '{exposed}' })
    },
    beforeAttack(b, self, ctx, role) {
      if (role !== 'attacker' || ctx.tech || !ctx.weapon || !b.has(self, 'exposed')) return
      ctx.convertDamage = 'Energy'
      ctx.bonusDamage.push({ type: 'Energy', val: '3' })
      ctx.reasons.push('Limit Break +3')
    },
    // after the attacker's own scripts have added their bonus damage
    beforeAnyAttack(b, self, ctx) {
      if (ctx.attacker !== self || ctx.tech || !ctx.weapon || !ctx.bonusDamage.length || !b.has(self, 'dangerzone')) return
      if (ctx.convertDamage !== 'Energy' && !ctx.profile?.damage.some(d => d.type === 'Energy')) return
      ctx.bonusDamage = ctx.bonusDamage.map(d => ({ ...d, type: 'Burn' }))
    },
  },
  {
    id: 'core:mf_tokugawa',
    note: 'Radiance (energy weapons +5 range / +2 threat; while Exposed, Limit Break makes kinetic and explosive weapons energy ones too); Overclock protocol (Exposed until the end of your next turn)',
    onCoreActivate(b, u) {
      u.bonuses.push(
        { id: 'range', val: 5, range_types: ['Range'], damage_types: ['Energy'] }, { id: 'threat', val: 2, weapon_types: ['Melee'], damage_types: ['Energy'] },
        { id: 'range', val: 5, range_types: ['Range'], damage_types: ['Kinetic', 'Explosive'], condition: '{exposed}' }, { id: 'threat', val: 2, weapon_types: ['Melee'], damage_types: ['Kinetic', 'Explosive'], condition: '{exposed}' },
      )
    },
    actions: (b, u) => [action({
      key: 'tokugawa-overclock', name: 'Overclock', activation: 'protocol', target: 'none',
      text: 'Your mech becomes Exposed until the end of your next turn (Limit Break).',
      run: (bt, self) => { bt.addStatus(self, 'exposed', 'next_turn_end_target', self, { overclock: true }) },
      aiScore: () => -1,
    })],
  },
  // ---------------- Core bonus: Fomorian Frame (Size via its bonus)
  {
    id: 'cb_fomorian_frame',
    note: 'Size +1 (max 3); cannot be knocked Prone, pulled or knocked back by smaller characters',
    init: u => { if (u.stats.size > 3) u.stats.size = 3 },
    ...heavyFrame,
  },
])

export { blastTiles }
