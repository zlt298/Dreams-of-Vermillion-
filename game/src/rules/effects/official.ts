// Scripts for official NPC class features (from an .lcp the player imports; see import/lcp.ts).
// Keyed `npc:<official feature id>`. Only mechanics live here — no rules text from the pack.
// Features marked `partial` approximate part of their rules; the full text is still shown in the HUD.
import type { Battle } from '../battle'
import { burstTiles, chebyshev, footprint, tileAt, unitsOnTiles } from '../grid'
import type { Pos, StatusId, Unit, Weapon } from '../types'
import { registerScripts, type AttackCtx, type CustomAction, type ItemScript } from './registry'

// ------------------------------------------------------------------ helpers
const tv = (u: Unit, v: [number, number, number]) => v[Math.min(3, Math.max(1, u.tier ?? 1)) - 1]
const action = (a: Omit<CustomAction, 'usable'> & { usable?: CustomAction['usable'] }): CustomAction => ({ usable: () => true, ...a })
const chars = (b: Battle) => b.alive().filter(o => o.kind === 'mech' || o.kind === 'npc')
const hostilesOf = (b: Battle, u: Unit) => chars(b).filter(o => b.hostile(u, o))
const resist = (ctx: AttackCtx, why: string) => { if (!ctx.resistAll) { ctx.resistAll = true; ctx.reasons.push(why) } }
const melee = (u: Unit) => u.weapons.find(w => !w.destroyed && !w.tech && w.type === 'Melee')
const occupied = (b: Battle, p: Pos, except?: Unit) => b.alive().some(o => o !== except && footprint(o).some(q => q.x === p.x && q.y === p.y))
const NEGATIVE: StatusId[] = ['impaired', 'stunned', 'immobilized', 'shredded', 'slowed', 'exposed']

/** Ready a once-per-round reaction keyed `key`; spends it and returns true if available. */
function react(b: Battle, u: Unit, key: string): boolean {
  if (u.destroyed || b.canSpend(u, 'reaction', key) !== true) return false
  b.spend(u, 'reaction', key)
  return true
}

/** Move in a straight line toward `toward`, up to `max` spaces; may pass through characters but not stop on one. */
function dash(b: Battle, u: Unit, toward: Pos, max: number, onPass?: (o: Unit) => void): Pos[] {
  const dx = Math.sign(toward.x - u.pos.x), dy = Math.sign(toward.y - u.pos.y)
  if (!dx && !dy) return [u.pos]
  const path: Pos[] = [u.pos]
  let lastFree = u.pos
  let cur = u.pos
  for (let i = 0; i < max; i++) {
    const nx = { x: cur.x + dx, y: cur.y + dy }
    const t = tileAt(b.map, nx), t0 = tileAt(b.map, cur)
    if (!t || !t0 || Math.abs(t.h - t0.h) > 1) break
    if (nx.x === toward.x && nx.y === toward.y && occupied(b, nx, u)) break
    cur = nx
    path.push(cur)
    for (const o of b.alive()) if (o !== u && footprint(o).some(q => q.x === cur.x && q.y === cur.y)) onPass?.(o)
    if (!occupied(b, cur, u)) lastFree = cur
  }
  const end = path.findIndex(p => p === lastFree)
  const final = path.slice(0, end + 1)
  if (final.length > 1) { u.pos = lastFree; b.emit({ type: 'move', unitId: u.id, path: final }) }
  return final
}

/** A free space adjacent to `t`, within `range` of `u` (closest to `u`). */
function landingNear(b: Battle, u: Unit, t: Unit, range: number): Pos | null {
  let best: Pos | null = null
  for (let dy = -1; dy <= t.stats.size; dy++) for (let dx = -1; dx <= t.stats.size; dx++) {
    const p = { x: t.pos.x + dx, y: t.pos.y + dy }
    if (!tileAt(b.map, p) || occupied(b, p, u) || chebyshev(p, u.pos) > range) continue
    if (!best || chebyshev(p, u.pos) < chebyshev(best, u.pos)) best = p
  }
  return best
}

function attackWith(b: Battle, u: Unit, w: Weapon | undefined, t: Unit) {
  if (w && b.weaponReady(u, w) && b.validTarget(u, w, t) === true) b.weaponAttack(u, w, { targetId: t.id }, 'free')
}

// ------------------------------------------------------------------ shared features
const guardian = (id: string): ItemScript => ({
  id, note: 'Guardian: adjacent allies use it as hard cover',
  adjustCover(b, self, attacker, target, c) {
    if (c === 'hard' || target === self || self.destroyed || b.hostile(self, target) || !b.adjacent(self, target)) return c
    return self.stats.size >= target.stats.size && b.distance(attacker, self) < b.distance(attacker, target) ? 'hard' : c
  },
})
const heavyFrame = (id: string): ItemScript => ({
  id, note: "Heavy Frame: can't be moved or knocked Prone by smaller characters",
  canBeMoved: (_b, self, src) => !(src && src.stats.size < self.stats.size),
  blockStatus: (_b, self, st, src) => st === 'prone' && !!src && src.stats.size < self.stats.size,
})
const siegeArmor = (id: string): ItemScript => ({
  id, note: 'Siege Armor: resistance to attacks from beyond range 3',
  beforeAttack(b, self, ctx, role) { if (role === 'target' && b.distance(ctx.attacker, self) > 3) resist(ctx, 'Siege armor') },
})
const resistType = (id: string, type: string, note: string): ItemScript => ({ id, note, init(u) { if (!u.resist.includes(type)) u.resist.push(type) } })
const preDamageResist = (id: string, key: string, note: string, after?: (b: Battle, self: Unit) => void): ItemScript => ({
  id, note,
  afterAnyRoll(b, self, ctx) {
    if (ctx.target !== self || !ctx.hit || ctx.tech || ctx.resistAll || !react(b, self, key)) return
    resist(ctx, note.split(':')[0])
    b.say(`${self.name} reacts: ${note.split(':')[0]}!`, 'attack')
    after?.(b, self)
  },
})
const invisibleAlways = (id: string, note: string): ItemScript => ({
  id, note, init(u) { if (!u.statuses.some(s => s.id === 'invisible')) u.statuses.push({ id: 'invisible' }) },
})
const flier = (id: string, note: string): ItemScript => ({ id, note, init(u) { u.flying = true } })
const teleporter = (id: string): ItemScript => ({
  id, note: 'Teleports when making a standard move (ignores engagement, terrain and climbing)', partial: true,
  init(u) { u.flags.teleportMoves = true; u.flags.ignoreDifficult = true; u.flags.magClamps = true },
})
const noteOnly = (id: string, note: string): ItemScript => ({ id, note })

registerScripts([
  // ---------------------------------------------------------------- Ace
  flier('npc:npcf_ssc_flight_system_ace', 'Flies when moving or boosting'),
  {
    id: 'npc:npcf_barrel_roll_ace', note: 'Barrel Roll (Recharge 5+): when hit, the attack misses and the Ace flies away 6', partial: true,
    onTurnStart(b, self) { if (self.flags.barrelSpent && b.rng.d(6) >= 5) { self.flags.barrelSpent = false; b.say(`${self.name}'s Barrel Roll recharges.`) } },
    afterAnyRoll(b, self, ctx) {
      if (ctx.target !== self || !ctx.hit || ctx.tech || self.flags.barrelSpent || !react(b, self, 'barrel_roll')) return
      self.flags.barrelSpent = true
      ctx.hit = false; ctx.crit = false
      b.say(`${self.name} barrel-rolls out of the way!`, 'attack')
      b.forceMove(self, ctx.attacker, 6, 1)
    },
  },
  // ---------------------------------------------------------------- Aegis
  {
    id: 'npc:npcf_defense_net_aegis',
    fields: (b, u) => (u.flags.defenseNet ? [{ tiles: burstTiles(b.map, u, 3), effect: 'protect' as const, label: `${u.name}'s Defense Net: +2 difficulty and no crits on attacks from outside` }] : []), note: 'Defense Net: burst 3 shield (+2 difficulty, no crits from outside; allies inside shrug off Impaired/Slowed); Immobilized while active', partial: true,
    actions: (_b, u) => [action({
      key: 'defense_net', name: u.flags.defenseNet ? 'End Defense Net' : 'Defense Net', activation: u.flags.defenseNet ? 'protocol' : 'full', target: 'self', area: { shape: 'burst', size: 3 },
      text: 'Toggle the Burst 3 repulsion shield. You are Immobilized while it is active.',
      run: (bt, self) => {
        self.flags.defenseNet = !self.flags.defenseNet
        if (self.flags.defenseNet) bt.addStatus(self, 'immobilized', 'until_cleared', self, { defenseNet: true })
        else self.statuses = self.statuses.filter(s => !s.data?.defenseNet)
      },
      aiScore: (bt, self) => (self.flags.defenseNet ? 0 : chars(bt).filter(a => !bt.hostile(self, a) && bt.distance(self, a) <= 3).length * 1.5),
    })],
    onTurnStart(b, self) {
      if (self.flags.defenseNet && (b.has(self, 'stunned') || b.has(self, 'jammed'))) { self.flags.defenseNet = false; self.statuses = self.statuses.filter(s => !s.data?.defenseNet) }
      if (self.flags.defenseNet) for (const a of chars(b)) if (!b.hostile(self, a) && b.distance(self, a) <= 3) { b.removeStatus(a, 'impaired'); b.removeStatus(a, 'slowed') }
    },
    beforeAnyAttack(b, self, ctx) {
      if (!self.flags.defenseNet || self.destroyed) return
      if (b.distance(self, ctx.target) <= 3 && b.distance(self, ctx.attacker) > 3) { ctx.difficulty += 2; ctx.reasons.push('Defense Net -2'); ctx.attacker.flags.netNoCrit = true }
    },
    afterAnyRoll(b, self, ctx) { if (ctx.attacker.flags.netNoCrit) { ctx.crit = false; ctx.attacker.flags.netNoCrit = false } },
  },
  {
    id: 'npc:npcf_regenerative_shielding_aegis', note: "Immune to Impaired and Slowed; can't be critically hit",
    init(u) { u.immune.push('impaired', 'slowed') },
    afterAnyRoll(_b, self, ctx) { if (ctx.target === self) ctx.crit = false },
  },
  // ---------------------------------------------------------------- Archer
  {
    id: 'npc:npcf_suppress_archer', note: 'Suppress: target is Impaired; Moving Target reaction attacks it when it moves', partial: true,
    actions: (_b, u) => [action({
      key: 'suppress', name: 'Suppress', activation: 'quick', target: 'enemy', range: 10, text: 'Impair a target in line of sight; attack it when it moves.',
      run: (bt, self, t) => {
        const target = t as Unit
        if (!bt.los(self, target)) throw new Error('No line of sight')
        endSuppress(bt, self)
        self.flags.suppress = target.id
        bt.addStatus(target, 'impaired', 'until_cleared', self, { suppress: self.id })
      },
      aiScore: (bt, self, t) => (t && 'id' in t && !bt.has(t, 'impaired') && self.flags.suppress !== t.id ? 4 : 0),
    })],
    onMove(b, self, mover) {
      if (mover.id !== self.flags.suppress || mover.destroyed || !react(b, self, 'moving_target')) return
      b.say(`${self.name}: Moving Target!`, 'attack')
      attackWith(b, self, self.weapons.find(w => !w.destroyed && !w.tech && w.type !== 'Melee' && b.validTarget(self, w, mover) === true), mover)
      endSuppress(b, self)
    },
    onDamaged(b, self, d) { if (d.source?.id === self.flags.suppress) endSuppress(b, self) },
    onTurnStart(b, self) {
      const t = b.unit(self.flags.suppress)
      if (t && (t.destroyed || !b.los(self, t) || b.has(self, 'stunned') || b.has(self, 'jammed'))) endSuppress(b, self)
    },
    onDestroyed(b, self, v) { if (v === self) endSuppress(b, self) },
  },
  {
    id: 'npc:npcf_superior_sentinel_archer', note: '+1 accuracy on reaction attacks',
    beforeAttack(b, self, ctx, role) { if (role === 'attacker' && (ctx.mode === 'overwatch' || b.activeId !== self.id)) { ctx.accuracy++; ctx.reasons.push('Superior Sentinel +1') } },
  },
  // ---------------------------------------------------------------- Assassin
  {
    id: 'npc:npcf_kai_bioplating_assassin', note: '+1 accuracy on Agility checks; ignores difficult terrain and climbs freely', partial: true,
    init(u) { u.flags.ignoreDifficult = true; u.flags.magClamps = true },
    checkAccuracy: (_b, self, u, kind, stat) => (u === self && kind === 'check' && stat === 'agi' ? 1 : 0),
  },
  {
    id: 'npc:npcf_assassins_mark_assassin', note: "Assassin's Mark: resistance to the mark's attacks; its damage to the mark can't be reduced", partial: true,
    actions: (_b, u) => [action({
      key: 'assassins_mark', name: "Assassin's Mark", activation: 'quick', target: 'enemy', range: 50, text: 'Mark a character in line of sight for the rest of the scene.',
      usable: (bt, self) => (bt.unit(self.flags.mark) && !bt.unit(self.flags.mark)!.destroyed ? 'Current mark still alive' : true),
      run: (bt, self, t) => { if (!bt.los(self, t as Unit)) throw new Error('No line of sight'); self.flags.mark = (t as Unit).id; bt.say(`${self.name} marks ${(t as Unit).name}.`) },
      aiScore: (_bt, _self, t) => (t && 'id' in t ? 3 + t.hp / 10 : 0),
    })],
    beforeAnyAttack(_b, self, ctx) {
      if (ctx.attacker.id === self.flags.mark && ctx.target === self) resist(ctx, "Assassin's Mark")
      if (ctx.attacker === self && ctx.target.id === self.flags.mark) ctx.irreducible = true
    },
  },
  {
    id: 'npc:npcf_leap_assassin', note: 'Leap: fly 6 and land; adjacent hostiles make an Agility save or are knocked Prone',
    actions: (_b, u) => [action({
      key: 'leap', name: 'Leap', activation: 'quick', target: 'enemy', range: 7, text: 'Fly 6 spaces and land; adjacent characters save (Agility) or are knocked Prone.',
      run: (bt, self, t) => {
        const p = landingNear(bt, self, t as Unit, 6)
        if (!p) throw new Error('No landing space')
        const from = self.pos
        self.pos = p
        bt.emit({ type: 'move', unitId: self.id, path: [from, p] })
        for (const o of chars(bt)) if (o !== self && bt.adjacent(self, o) && !bt.save(o, 'agi', self.stats.save)) bt.addStatus(o, 'prone', 'until_cleared', self)
      },
      aiScore: (bt, self, t) => (t && 'id' in t && !bt.adjacent(self, t) ? 4 : 0),
    })],
  },
  // ---------------------------------------------------------------- Assault / Demolisher / Ronin (pre-damage reactions)
  preDamageResist('npc:npcf_hunker_down_assault', 'hunker_down', 'Hunker Down: reaction on being hit, resistance to the attack'),
  preDamageResist('npc:npcf_dig_in_demolisher', 'dig_in', 'Dig In: reaction on being hit, resistance to the attack, then Slowed', (b, self) => b.addStatus(self, 'slowed', 'next_turn_end_target', self)),
  {
    id: 'npc:npcf_rebound_ronin', note: 'Rebound: on a ranged hit, 4+ on d6 gives resistance and turns the damage back on the attacker', partial: true,
    afterAnyRoll(b, self, ctx) {
      if (ctx.target !== self || !ctx.hit || ctx.tech || ctx.melee || !react(b, self, 'rebound')) return
      const r = b.rng.d(6)
      b.say(`${self.name} tries to rebound the shot (${r}).`, 'attack')
      if (r >= 4) { resist(ctx, 'Rebound'); self.flags.reboundOn = ctx.attacker.id }
    },
    afterAttack(b, self, ctx, role) {
      if (role !== 'target' || self.flags.reboundOn !== ctx.attacker.id) return
      self.flags.reboundOn = undefined
      const dmg = (ctx.damageDealt ?? 0) * 2
      if (dmg > 0 && !ctx.attacker.destroyed) { b.say(`  The shot rebounds into ${ctx.attacker.name}!`, 'attack'); b.applyDamage(ctx.attacker, [{ type: 'Kinetic', amount: dmg }], { source: self }) }
    },
  },
  // ---------------------------------------------------------------- Barricade
  resistType('npc:npcf_shock_plating_barricade', 'Kinetic', 'Resistance to kinetic damage'),
  { id: 'npc:npcf_bulwark_mods_barricade', note: 'Ignores difficult and dangerous terrain', init(u) { u.flags.ignoreDifficult = true; u.flags.ignoreHazard = true } },
  // ---------------------------------------------------------------- Bastion
  {
    id: 'npc:npcf_friendly_interdiction_bastion', note: 'Friendly Interdiction (protocol): the Bastion and allies adjacent to the marked character resist its attacks', partial: true,
    actions: (_b, _u) => [action({
      key: 'interdiction', name: 'Friendly Interdiction', activation: 'protocol', target: 'enemy', range: 50, text: 'Mark a character in line of sight; you and allies next to it resist its attacks.',
      run: (bt, self, t) => { if (!bt.los(self, t as Unit)) throw new Error('No line of sight'); self.flags.interdict = (t as Unit).id },
      aiScore: (bt, self, t) => (t && 'id' in t && self.flags.interdict !== t.id ? 2 + bt.alive().filter(a => !bt.hostile(self, a) && bt.adjacent(a, t)).length : 0),
    })],
    beforeAnyAttack(b, self, ctx) {
      if (self.destroyed || ctx.attacker.id !== self.flags.interdict || b.hostile(self, ctx.target)) return
      if (ctx.target === self || b.adjacent(ctx.target, ctx.attacker)) resist(ctx, 'Friendly Interdiction')
    },
  },
  guardian('npc:npcf_guardian_bastion'),
  // ---------------------------------------------------------------- Berserker
  {
    id: 'npc:npcf_stampede_defense_berserker', note: 'Resistance to all damage unless Impaired, Stunned, Immobilized, Shredded, Slowed or Exposed',
    beforeAttack(b, self, ctx, role) { if (role === 'target' && !NEGATIVE.some(s => b.has(self, s))) resist(ctx, 'Stampede Defense') },
    modifyIncoming(b, self, d) { if (!d.attack && !NEGATIVE.some(s => b.has(self, s))) d.amount = Math.ceil(d.amount / 2) },
  },
  {
    id: 'npc:npcf_aggression_berserker', note: 'Aggression: the first time it takes damage each round, it attacks a random adjacent character',
    onDamaged(b, self) {
      if (self.destroyed || self.flags.aggrRound === b.round) return
      self.flags.aggrRound = b.round
      const adj = chars(b).filter(o => o !== self && b.adjacent(self, o))
      if (adj.length) { b.say(`${self.name} lashes out in rage!`, 'attack'); attackWith(b, self, melee(self), b.rng.pick(adj)) }
    },
  },
  {
    id: 'npc:npcf_avalanche_charge_berserker', note: 'Avalanche Charge: straight-line move of Speed ignoring engagement, then attack a random adjacent character',
    actions: (_b, u) => [action({
      key: 'avalanche', name: 'Avalanche Charge', activation: 'quick', target: 'enemy', range: u.stats.speed + 1, text: 'Charge in a straight line, then attack a random adjacent character.',
      run: (bt, self, t) => {
        dash(bt, self, (t as Unit).pos, self.stats.speed)
        const adj = chars(bt).filter(o => o !== self && bt.adjacent(self, o))
        if (adj.length) attackWith(bt, self, melee(self), bt.rng.pick(adj))
      },
      aiScore: (bt, self, t) => (t && 'id' in t && !bt.adjacent(self, t) && chars(bt).filter(o => !bt.hostile(self, o) && o !== self && bt.distance(o, t) <= 1).length === 0 ? 5 : 0),
    })],
  },
  // ---------------------------------------------------------------- Bombard
  {
    id: 'npc:npcf_cluster_munitions_bombard', note: 'Cluster Munitions: bonus damage when an attack hits several targets', partial: true,
    beforeAttack(_b, self, ctx, role) { if (role === 'attacker' && ctx.multiTarget) ctx.bonusDamage.push({ type: 'Explosive', val: tv(self, [2, 3, 4]) } as any) },
  },
  {
    id: 'npc:npcf_earthshaker_shells_bombard', note: 'Earthshaker Shells: cannon hits force Hull saves vs Prone in Burst 3 (no cover segments yet)', partial: true,
    afterAttack(b, self, ctx, role) {
      if (role !== 'attacker' || ctx.weapon?.type !== 'Cannon' || self.flags['turn:earthshaker']) return
      self.flags['turn:earthshaker'] = true
      const tiles = burstTiles(b.map, ctx.target, 3)
      b.emit({ type: 'area', tiles, kind: 'attack' })
      for (const o of unitsOnTiles(chars(b), tiles)) if (o !== self && b.hostile(self, o) && !b.save(o, 'hull', self.stats.save)) b.addStatus(o, 'prone', 'until_cleared', self)
    },
  },
  siegeArmor('npc:npcf_siege_armor_bombard'),
  // ---------------------------------------------------------------- Breacher
  {
    id: 'npc:npcf_breach_ram_breacher', note: 'Breach Ram: 6-space straight charge through characters (Agility save or pushed aside and Prone)', partial: true,
    actions: () => [action({
      key: 'breach_ram', name: 'Breach Ram', activation: 'quick', target: 'enemy', range: 7, text: 'Charge 6 spaces in a straight line through characters.',
      run: (bt, self, t) => {
        const hit = new Set<Unit>()
        dash(bt, self, (t as Unit).pos, 6, o => hit.add(o))
        for (const o of hit) if (!bt.save(o, 'agi', self.stats.save)) { bt.forceMove(o, self, 1, 1); bt.addStatus(o, 'prone', 'until_cleared', self) }
      },
      aiScore: (bt, self, t) => (t && 'id' in t && !bt.adjacent(self, t) ? 3 : 0),
    })],
  },
  {
    id: 'npc:npcf_break_armor_breacher', note: 'Break Armor: a target hit twice in a turn by its shotguns is Shredded for the scene',
    afterAttack(b, self, ctx, role) {
      if (role !== 'attacker' || !ctx.hit || !/shotgun/i.test(ctx.weapon?.name ?? '')) return
      const k = `turn:brk:${ctx.target.id}`
      self.flags[k] = (self.flags[k] ?? 0) + 1
      if (self.flags[k] >= 2 && !ctx.target.destroyed) b.addStatus(ctx.target, 'shredded', 'scene', self)
    },
  },
  // ---------------------------------------------------------------- Cataphract
  {
    id: 'npc:npcf_impale_cataphract', note: 'Impale: 8-space straight charge; the target makes a Hull save (+1 difficulty) or is grappled', partial: true,
    actions: () => [action({
      key: 'impale', name: 'Impale', activation: 'full', target: 'enemy', range: 9, text: 'Charge 8 spaces in a straight line and try to grapple the target.',
      run: (bt, self, t) => {
        const target = t as Unit
        dash(bt, self, target.pos, 8)
        if (!bt.adjacent(self, target)) return
        if (!bt.save(target, 'hull', self.stats.save, -1)) {
          bt.addStatus(target, 'grappled', 'until_cleared', self, { by: self.id })
          bt.addStatus(self, 'grappled', 'until_cleared', self, { by: self.id, with: target.id })
        }
      },
      aiScore: (bt, self, t) => (t && 'id' in t && !bt.adjacent(self, t) ? 4 : 0),
    })],
  },
  {
    id: 'npc:npcf_point_defense_shield_cataphract', note: 'Resistance to all damage from the single closest hostile',
    beforeAttack(b, self, ctx, role) {
      if (role !== 'target') return
      const hs = hostilesOf(b, self)
      const d = Math.min(...hs.map(h => b.distance(self, h)))
      const closest = hs.filter(h => b.distance(self, h) === d)
      if (closest.length === 1 && closest[0] === ctx.attacker) resist(ctx, 'Point defense shield')
    },
  },
  // ---------------------------------------------------------------- Demolisher / Goliath / Sentinel (defenders)
  {
    id: 'npc:npcf_shock_armor_demolisher', note: 'Resistance to melee weapon damage',
    beforeAttack(_b, _self, ctx, role) { if (role === 'target' && ctx.melee && !ctx.tech) resist(ctx, 'Shock armor') },
  },
  heavyFrame('npc:npcf_heavy_frame_demolisher'),
  heavyFrame('npc:npcf_heavy_frame_goliath'),
  guardian('npc:npcf_guardian_goliath'),
  siegeArmor('npc:npcf_siege_armor_goliath'),
  {
    id: 'npc:npcf_crush_targeting_goliath', note: 'Crush Targeting: the target takes +3 difficulty attacking anyone but the Goliath until its next turn',
    beforeAttack(_b, _self, ctx, role) { if (role === 'attacker' && ctx.weapon?.script === 'npcf_crush_targeting_goliath') { ctx.attackBonus += 50; ctx.reasons.push('automatic') } },
    afterAttack(b, self, ctx, role) {
      if (role === 'attacker' && ctx.hit && ctx.weapon?.script === 'npcf_crush_targeting_goliath') { ctx.target.flags.crushBy = self.id; b.say(`${ctx.target.name} is locked onto ${self.name}.`) }
    },
    onTurnStart(b, self) { for (const h of chars(b)) if (h.flags.crushBy === self.id) h.flags.crushBy = undefined },
    beforeAnyAttack(_b, self, ctx) {
      if (!self.destroyed && ctx.attacker.flags.crushBy === self.id && ctx.target !== self) { ctx.difficulty += 3; ctx.reasons.push('Crush targeting -3') }
    },
  },
  {
    id: 'npc:npcf_eye_of_midnight_sentinel', note: 'Eye of Midnight: Slowed, but can Overwatch once every turn',
    actions: (_b, u) => [action({
      key: 'eye_of_midnight', name: u.flags.eye ? 'Deactivate Eye of Midnight' : 'Eye of Midnight', activation: 'quick', target: 'self', text: 'Toggle: Slowed, Overwatch 1/turn.',
      run: (bt, self) => {
        self.flags.eye = !self.flags.eye
        self.traits = (self.traits ?? []).filter(t => t !== 'reflex')
        if (self.flags.eye) { self.traits.push('reflex'); bt.addStatus(self, 'slowed', 'until_cleared', self, { eye: true }) }
        else self.statuses = self.statuses.filter(s => !s.data?.eye)
      },
      aiScore: (bt, self) => (!self.flags.eye && hostilesOf(bt, self).some(h => bt.distance(self, h) <= 8) ? 3 : 0),
    })],
  },
  guardian('npc:npcf_guardian_sentinel'),
  // ---------------------------------------------------------------- Hive / Hornet / Mirage / Witch / Priest (tech)
  noteOnly('npc:npcf_drone_barrage_hive', 'Drone Barrage: on a hit, Immobilized and Impaired (the alternative forced move is not offered)'),
  flier('npc:npcf_ssc_total_suite_hornet', 'Hovers when moving or boosting'),
  {
    id: 'npc:npcf_weave_hornet', note: 'Weave: the first reaction attack against it each round automatically misses',
    afterAnyRoll(b, self, ctx) {
      if (ctx.target !== self || !ctx.hit || self.flags.weaveRound === b.round) return
      if (ctx.mode !== 'overwatch' && b.activeId === ctx.attacker.id) return
      self.flags.weaveRound = b.round
      ctx.hit = false; ctx.crit = false
      b.say(`  ${self.name} weaves through the reaction fire.`)
    },
  },
  noteOnly('npc:npcf_impale_systems_hornet', 'Impale Systems: heat and Jammed on a hit'),
  {
    id: 'npc:npcf_warp_sensors_mirage', note: 'Warp Sensors: heat; the target treats everything as being in soft cover until the end of its next turn',
    afterAttack(b, self, ctx, role) { if (role === 'attacker' && ctx.hit && ctx.weapon?.script === 'npcf_warp_sensors_mirage') { ctx.target.flags.warpBy = self.id; ctx.target.flags.warpUntil = b.round + 1 } },
    beforeAnyAttack(b, self, ctx) {
      const a = ctx.attacker
      if (a.flags.warpBy === self.id && b.round <= a.flags.warpUntil && !ctx.melee && b.cover(a, ctx.target) === 'none') { ctx.difficulty++; ctx.reasons.push('Warped sensors -1') }
    },
  },
  teleporter('npc:npcf_reality_flicker_mirage'),
  invisibleAlways('npc:npcf_dataveil_mirage', 'Dataveil: Invisible (transferring it to an ally is not offered yet)'),
  {
    id: 'npc:npcf_tear_down_witch', note: 'Tear Down: heat now and 4 more at the start of the Witch’s next turn',
    afterAttack(_b, self, ctx, role) { if (role === 'attacker' && ctx.hit && ctx.weapon?.script === 'npcf_tear_down_witch') self.flags.tearDown = [...(self.flags.tearDown ?? []), ctx.target.id] },
    onTurnStart(b, self) {
      for (const id of self.flags.tearDown ?? []) { const t = b.unit(id); if (t && !t.destroyed) b.applyDamage(t, [{ type: 'Heat', amount: 4 }], { source: self }) }
      self.flags.tearDown = []
    },
  },
  {
    id: 'npc:npcf_blind_witch', note: 'Blind: the target can only see adjacent spaces until the end of its next turn',
    afterAttack(b, self, ctx, role) { if (role === 'attacker' && ctx.hit && ctx.weapon?.script === 'npcf_blind_witch') { ctx.target.flags.blindBy = self.id; ctx.target.flags.blindUntil = b.round + 1 } },
    beforeAnyAttack(b, self, ctx) {
      const a = ctx.attacker
      if (a.flags.blindBy === self.id && b.round <= a.flags.blindUntil && b.distance(a, ctx.target) > 1) { ctx.cancelled = true; b.say(`  ${a.name} is blinded and can't see ${ctx.target.name}.`) }
    },
  },
  {
    id: 'npc:npcf_predatory_logic_witch', note: 'Predatory Logic: the target attacks one of its allies with its own weapon',
    afterAttack(b, self, ctx, role) {
      if (role !== 'attacker' || !ctx.hit || ctx.weapon?.script !== 'npcf_predatory_logic_witch' || ctx.target.destroyed) return
      const v = ctx.target
      for (const w of v.weapons.filter(w => !w.destroyed && !w.tech && b.weaponReady(v, w))) {
        const victim = chars(b).find(o => o !== v && !b.hostile(v, o) && b.validTarget(v, w, o) === true)
        if (victim) { b.say(`${v.name}'s systems turn on ${victim.name}!`, 'attack'); b.weaponAttack(v, w, { targetId: victim.id }, 'free'); return }
      }
    },
  },
  {
    id: 'npc:npcf_blur_witch', note: 'Blur: Invisible during its own turn',
    onTurnStart(b, self) { b.addStatus(self, 'invisible', 'end_of_turn', self) },
  },
  {
    id: 'npc:npcf_abjure_priest', note: 'Abjure: the target takes heat whenever it attacks until the end of its next turn',
    afterAttack(b, self, ctx, role) { if (role === 'attacker' && ctx.hit && ctx.weapon?.script === 'npcf_abjure_priest') { ctx.target.flags.abjureBy = self.id; ctx.target.flags.abjureUntil = b.round + 1 } },
    afterAnyAttack(b, self, ctx) {
      const a = ctx.attacker
      if (a.flags.abjureBy === self.id && b.round <= a.flags.abjureUntil && !a.destroyed) b.applyDamage(a, [{ type: 'Heat', amount: tv(self, [2, 3, 4]) }], { source: self })
    },
  },
  {
    id: 'npc:npcf_hardened_target_priest', note: '+1 accuracy on Systems saves; tech attacks against it +1 difficulty',
    beforeAttack(_b, _self, ctx, role) { if (role === 'target' && ctx.tech) { ctx.difficulty++; ctx.reasons.push('Hardened target -1') } },
    checkAccuracy: (_b, self, u, kind, stat) => (u === self && kind === 'save' && stat === 'sys' ? 1 : 0),
  },
  {
    id: 'npc:npcf_investiture_priest', note: 'Investiture: a linked ally within 5 gains accuracy on attacks (shared conditions not modelled)', partial: true,
    actions: () => [action({
      key: 'investiture', name: 'Investiture', activation: 'quick', target: 'ally', range: 5, text: 'Link with an ally within range 5: it gains accuracy on attacks.',
      run: (_bt, self, t) => { self.flags.invested = (t as Unit).id },
      aiScore: () => 2,
    })],
    beforeAnyAttack(b, self, ctx) {
      if (!self.destroyed && ctx.attacker.id === self.flags.invested && b.distance(self, ctx.attacker) <= 5) { const n = tv(self, [1, 2, 3]); ctx.accuracy += n; ctx.reasons.push(`Investiture +${n}`) }
    },
  },
  {
    id: 'npc:npcf_dispersal_shield_priest', note: 'Dispersal Shield: an ally resists the next 1d3 attacks that hit it',
    actions: () => [action({
      key: 'dispersal', name: 'Dispersal Shield', activation: 'quick', target: 'ally', range: 10, text: 'You or an ally gain resistance against the next 1d3 attacks that hit.',
      run: (bt, self, t) => { const a = (t as Unit) ?? self; a.flags.dispersal = bt.rng.d(3); a.flags.dispersalBy = self.id },
      aiScore: () => 2.5,
    })],
    beforeAnyAttack(_b, self, ctx) { if (ctx.target.flags.dispersalBy === self.id && ctx.target.flags.dispersal > 0) resist(ctx, 'Dispersal shield') },
    afterAnyAttack(_b, self, ctx) { if (ctx.hit && ctx.target.flags.dispersalBy === self.id && ctx.target.flags.dispersal > 0) ctx.target.flags.dispersal-- },
  },
  // ---------------------------------------------------------------- Operator
  teleporter('npc:npcf_trace_drive_operator'),
  {
    id: 'npc:npcf_step_operator', note: 'Step: teleport to a free space in line of sight (range 50)',
    actions: () => [action({
      key: 'step', name: 'Step', activation: 'quick', target: 'tile', range: 50, text: 'Teleport to a free space in line of sight.',
      run: (bt, self, t) => {
        const p = t as Pos
        if (!tileAt(bt.map, p) || occupied(bt, p, self)) throw new Error('Not a free space')
        const from = self.pos
        self.pos = p
        bt.emit({ type: 'move', unitId: self.id, path: [from, p] })
      },
    })],
  },
  {
    id: 'npc:npcf_self_erasure_operator', note: 'Self-Erasure: on destruction, adjacent characters take energy damage (Agility save for half); no wreck remains',
    onDestroyed(b, self, v) {
      if (v !== self) return
      self.flags.wreck = false
      b.invalidateTerrain()
      for (const o of chars(b)) if (b.adjacent(self, o)) {
        const dmg = tv(self, [4, 6, 8])
        const ok = b.save(o, 'agi', self.stats.save)
        b.applyDamage(o, [{ type: 'Energy', amount: ok ? Math.ceil(dmg / 2) : dmg }], { source: self })
      }
    },
  },
  // ---------------------------------------------------------------- Pyro
  {
    id: 'npc:npcf_explosive_vent_pyro', note: 'Explosive Vent: clear all heat; Burst 1 Agility save or take half that heat and be knocked Prone',
    actions: () => [action({
      key: 'explosive_vent', name: 'Explosive Vent', activation: 'full', target: 'self', area: { shape: 'burst', size: 1 }, text: 'Clear all heat; adjacent characters save or take heat and fall Prone.',
      run: (bt, self) => {
        const cleared = self.heat
        self.heat = 0
        const tiles = burstTiles(bt.map, self, 1)
        bt.emit({ type: 'area', tiles, kind: 'attack' })
        for (const o of unitsOnTiles(chars(bt), tiles)) if (o !== self && !bt.save(o, 'agi', self.stats.save)) {
          if (cleared >= 2) bt.applyDamage(o, [{ type: 'Heat', amount: Math.floor(cleared / 2) }], { source: self })
          bt.addStatus(o, 'prone', 'until_cleared', self)
        }
      },
      aiScore: (bt, self) => self.heat / Math.max(1, self.stats.heatcap) * 6 + hostilesOf(bt, self).filter(h => bt.adjacent(self, h)).length,
    })],
  },
  { id: 'npc:npcf_insulated_pyro', note: 'Immune to Burn', init(u) { if (!u.immune.includes('burn')) u.immune.push('burn') } },
  // ---------------------------------------------------------------- Rainmaker
  {
    id: 'npc:npcf_huntsman_rainmaker', note: 'Huntsman: ignores cover and armor against Locked On targets', partial: true,
    beforeAttack(b, _self, ctx, role) { if (role === 'attacker' && b.has(ctx.target, 'lockon')) { ctx.ignoreCover = true; ctx.irreducible = true; ctx.reasons.push('Huntsman') } },
  },
  // ---------------------------------------------------------------- Scourer
  {
    id: 'npc:npcf_focus_down_scourer', note: 'Focus Down: lance hits on a target hit last round add Burn',
    afterAttack(b, self, ctx, role) {
      if (role !== 'attacker' || !ctx.hit || !/lance/i.test(ctx.weapon?.name ?? '')) return
      const k = `lance:${self.id}`
      if (ctx.target.flags[k] === b.round - 1 && !ctx.target.destroyed) b.applyDamage(ctx.target, [{ type: 'Burn', amount: tv(self, [5, 7, 8]) }], { source: self })
      ctx.target.flags[k] = b.round
    },
  },
  {
    id: 'npc:npcf_cooling_module_scourer', note: "Cooling Module: clears all heat at turn start if it hasn't moved since its last turn",
    onMove(_b, self, mover) { if (mover === self) self.flags.coolMoved = true },
    onTurnEnd(_b, self) { self.flags.coolMoved = false },
    onTurnStart(b, self) { if (!self.flags.coolMoved && self.heat > 0) { self.heat = 0; b.say(`${self.name} vents all heat.`) } },
  },
  resistType('npc:npcf_ablative_shielding_scourer', 'Energy', 'Resistance to energy damage'),
  // ---------------------------------------------------------------- Scout
  {
    id: 'npc:npcf_rebound_scan_scout', note: "Rebound Scan: hostiles within 5 make a Systems save or lose Hidden/Invisible and can't use cover until its next turn",
    actions: () => [action({
      key: 'rebound_scan', name: 'Rebound Scan', activation: 'full', target: 'self', area: { shape: 'burst', size: 5 }, text: 'Systems save or lose Hidden, Invisible and cover.',
      run: (bt, self) => {
        for (const h of hostilesOf(bt, self)) if (bt.distance(self, h) <= 5 && !bt.save(h, 'sys', self.stats.save)) {
          bt.removeStatus(h, 'hidden'); bt.removeStatus(h, 'invisible')
          h.flags.scannedBy = self.id; h.flags.scannedUntil = bt.round + 1
        }
      },
      aiScore: (bt, self) => hostilesOf(bt, self).filter(h => bt.distance(self, h) <= 5).length * 1.5,
    })],
    beforeAnyAttack(b, self, ctx) { const t = ctx.target; if (t.flags.scannedBy === self.id && b.round <= t.flags.scannedUntil) ctx.ignoreCover = true },
    onTurnStart(b, self) { for (const h of chars(b)) if (h.flags.scannedBy === self.id) h.flags.scannedBy = undefined },
  },
  {
    id: 'npc:npcf_cloaking_field_scout', note: 'Cloaking Field: it and allies within Burst 3 are Invisible until the end of its next turn; it is Immobilized',
    actions: () => [action({
      key: 'cloaking_field', name: 'Cloaking Field', activation: 'quick', target: 'self', area: { shape: 'burst', size: 3 }, text: 'You and allies within Burst 3 become Invisible; you are Immobilized.',
      run: (bt, self) => {
        for (const a of chars(bt)) if (!bt.hostile(self, a) && bt.distance(self, a) <= 3) bt.addStatus(a, 'invisible', 'next_turn_end_source', self)
        bt.addStatus(self, 'immobilized', 'next_turn_end_source', self)
      },
      aiScore: (bt, self) => chars(bt).filter(a => !bt.hostile(self, a) && bt.distance(self, a) <= 3).length * 1.2 - (hostilesOf(bt, self).some(h => bt.distance(self, h) <= 10) ? 0 : 3),
    })],
  },
  // ---------------------------------------------------------------- Sniper
  {
    id: 'npc:npcf_snipers_mark_sniper', note: "Sniper's Mark: the anti-materiel rifle deals 1 structure to the mark unless it's in cover or Prone",
    actions: () => [action({
      key: 'snipers_mark', name: "Sniper's Mark", activation: 'full', target: 'enemy', range: 25, text: 'Mark a character in line of sight.',
      run: (bt, self, t) => { if (!bt.los(self, t as Unit)) throw new Error('No line of sight'); self.flags.sniperMark = (t as Unit).id; bt.say(`${(t as Unit).name} has the Sniper's Mark.`) },
      aiScore: (bt, self, t) => (t && 'id' in t && self.flags.sniperMark !== t.id && bt.cover(self, t) === 'none' ? 3 + (t.structure ?? 1) : 0),
    })],
    afterAnyRoll(b, self, ctx) {
      const t = ctx.target
      if (ctx.attacker !== self || !ctx.hit || t.id !== self.flags.sniperMark || !/anti.?materi/i.test(ctx.weapon?.name ?? '')) return
      if (b.has(t, 'prone') || b.cover(self, t) !== 'none') return
      ctx.cancelDamage = true
      b.say(`  The Sniper's Mark: ${t.name} takes structure damage!`, 'attack')
      b.applyDamage(t, [{ type: 'Kinetic', amount: t.hp + t.overshield }], { source: self, irreducible: true })
    },
  },
  { id: 'npc:npcf_climber_sniper', note: 'Climbs any surface without penalty', init(u) { u.flags.magClamps = true } },
  // ---------------------------------------------------------------- Specter
  {
    id: 'npc:npcf_prowl_specter', note: "Prowl: move its Speed ignoring engagement (doesn't provoke), then become Hidden",
    actions: () => [action({
      key: 'prowl', name: 'Prowl', activation: 'quick', target: 'enemy', range: 50, text: 'Move your Speed, then become Hidden.',
      run: (bt, self, t) => {
        const target = t as Unit
        const reach = bt.reachable(self, self.stats.speed, { ignoreEngagement: true })
        let best: Pos | null = null
        for (const { pos } of reach.values()) if (!best || chebyshev(pos, target.pos) < chebyshev(best, target.pos)) best = pos
        if (best) {
          const was = self.flags['turn:disengaged']
          self.flags['turn:disengaged'] = true
          bt.move(self, best, { mode: 'free', ignoreEngagement: true })
          self.flags['turn:disengaged'] = was
        }
        bt.addStatus(self, 'hidden', 'until_cleared', self)
      },
      aiScore: (bt, self, t) => (t && 'id' in t && !bt.adjacent(self, t) ? 3.5 : 0),
    })],
  },
  invisibleAlways('npc:npcf_tactical_cloak_specter', 'Permanently Invisible'),
  {
    id: 'npc:npcf_hunt_specter', note: 'Hunt: +5 melee damage against targets with no other characters adjacent',
    beforeAttack(b, self, ctx, role) {
      if (role !== 'attacker' || !ctx.melee) return
      if (!chars(b).some(o => o !== self && o !== ctx.target && b.adjacent(o, ctx.target))) ctx.bonusDamage.push({ type: 'Kinetic', val: 5 } as any)
    },
  },
  // ---------------------------------------------------------------- Support
  {
    id: 'npc:npcf_sealant_gun_support', note: 'Sealant Gun: allies lose Burn but are Slowed; hostiles Agility save or Slowed; Burst 1 becomes difficult terrain',
    actions: () => [action({
      key: 'sealant', name: 'Sealant Gun', activation: 'quick', target: 'enemy', range: 5, text: 'Slow a target and coat the area in sealant.',
      run: (bt, self, t) => {
        const target = t as Unit
        if (!bt.los(self, target)) throw new Error('No line of sight')
        if (bt.hostile(self, target)) { if (!bt.save(target, 'agi', self.stats.save)) bt.addStatus(target, 'slowed', 'next_turn_end_target', self) }
        else { target.burn = 0; bt.addStatus(target, 'slowed', 'next_turn_end_target', self) }
        bt.areas.push({ id: `sealant-${bt.round}-${self.id}`, kind: 'difficult', tiles: burstTiles(bt.map, target, 1), ownerId: self.id })
        bt.invalidateTerrain()
      },
      aiScore: (bt, _self, t) => (t && 'id' in t && !bt.has(t, 'slowed') ? 2.5 : 0),
    })],
  },
  {
    id: 'npc:npcf_nano_repair_cloud_support', note: 'Nano-Repair Cloud: adjacent allies roll saves and checks with advantage (modelled as +1 accuracy)', partial: true,
    checkAccuracy: (b, self, u) => (u !== self && !self.destroyed && !b.hostile(self, u) && b.adjacent(self, u) ? 1 : 0),
  },
])

function endSuppress(b: Battle, self: Unit) {
  const t = b.unit(self.flags.suppress)
  if (t) t.statuses = t.statuses.filter(s => s.data?.suppress !== self.id)
  self.flags.suppress = undefined
}
