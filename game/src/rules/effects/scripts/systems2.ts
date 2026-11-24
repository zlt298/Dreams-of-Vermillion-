// Systems previously resolved by hand: grenades and mines, shields and barriers, NHPs, utility.
import { PendingChoice, type Battle } from '../../battle'
import { blastTiles, burstTiles, chebyshev, distanceToTile, footprint, hasLineOfSightToTile, lineTiles, tileAt, unitsOnTiles } from '../../grid'
import { rollDice } from '../../rng'
import type { Pos, StatusId, SystemInst, Unit, Weapon } from '../../types'
import { deployableUnit } from '../generic'
import { registerScripts, type AttackCtx, type CustomAction, type FieldOverlay, type ItemScript } from '../registry'

// ------------------------------------------------------------------ helpers
const action = (a: Omit<CustomAction, 'usable'> & { usable?: CustomAction['usable'] }): CustomAction => ({ usable: () => true, ...a })
const sys = (u: Unit, id: string) => u.systems.find(s => s.dataId === id && !s.destroyed)
const usesOk = (s?: SystemInst): true | string => (!s ? 'Destroyed' : s.usesLeft === 0 ? 'No charges left' : true)
const spend = (s?: SystemInst) => { if (s && s.usesLeft != null) s.usesLeft-- }
const chars = (b: Battle) => b.alive().filter(o => o.kind === 'mech' || o.kind === 'npc')
const hostiles = (b: Battle, u: Unit) => chars(b).filter(o => b.hostile(u, o))
const allies = (b: Battle, u: Unit) => chars(b).filter(o => o !== u && !b.hostile(u, o))
const onTiles = (u: Unit, tiles: Pos[]) => footprint(u).some(p => tiles.some(t => t.x === p.x && t.y === p.y))
const fully = (u: Unit, tiles: Pos[]) => footprint(u).every(p => tiles.some(t => t.x === p.x && t.y === p.y))
const free = (b: Battle, p: Pos, except?: Unit) => !!tileAt(b.map, p) && !b.alive().some(o => o !== except && !o.flags.flat && footprint(o).some(q => q.x === p.x && q.y === p.y))
const oncePerRound = (u: Unit, key: string) => { const k = `round:${key}`; if (u.flags[k]) return false; u.flags[k] = true; return true }

/** a save that avoids Prone or Knockback (Stable Structure gives +1 Accuracy on those) */
function saveVs(b: Battle, u: Unit, stat: 'hull' | 'agi' | 'sys' | 'eng', src: Unit, avoid: 'prone' | 'knockback'): boolean {
  u.flags.saveAvoid = avoid
  try { return b.save(u, stat, src.stats.save, 0, src) } finally { delete u.flags.saveAvoid }
}
const at = (t?: Unit | Pos): Pos => (t && 'x' in t ? t : (t as Unit).pos)
const nearest = (b: Battle, u: Unit, list: Unit[]) => [...list].sort((x, y) => b.distance(u, x) - b.distance(u, y))[0]
const blind = (b: Battle, t: Unit) => { t.flags.blindUntil = b.round + 1; b.say(`${t.name} is blinded (line of sight to adjacent spaces only).`, 'status') }
const half = (b: Battle, t: Unit, src: Unit, stat: 'hull' | 'agi' | 'sys' | 'eng', dice: string, type: string, extra?: (failed: boolean) => void, ap = false) => {
  const dmg = rollDice(b.rng, dice).total
  const ok = b.save(t, stat, src.stats.save, 0, src)
  b.applyDamage(t, [{ type, amount: ok ? b.halfOnSave(t, dmg) : dmg }], { source: src, ap })
  extra?.(!ok)
}
/** Is `seg` between attacker and target, next to the target? */
const shields = (attacker: Unit, target: Unit, seg: Pos) => footprint(target).some(p => chebyshev(p, seg) <= 1) && chebyshev(attacker.pos, seg) < chebyshev(attacker.pos, target.pos)
/** A free tile within `range` of `u` near `toward`. */
function tileNear(b: Battle, u: Unit, toward: Pos, range: number): Pos | null {
  let best: Pos | null = null
  for (let dy = -range; dy <= range; dy++) for (let dx = -range; dx <= range; dx++) {
    const p = { x: u.pos.x + dx, y: u.pos.y + dy }
    if (!free(b, p, u)) continue
    if (!best || chebyshev(p, toward) < chebyshev(best, toward)) best = p
  }
  return best
}
/** Barrier segments in a line across the direction you face (Magnetic Shield). */
function spawnLine(b: Battle, owner: Unit, tile: Pos, name: string, n: number, setup: (d: Unit) => void): Unit[] {
  const dx = Math.sign(tile.x - owner.pos.x), dy = Math.sign(tile.y - owner.pos.y)
  if (!dx && !dy) throw new Error('Pick a space next to you')
  const perp = { x: -dy, y: dx }
  const out: Unit[] = []
  for (const k of [0, 1, -1, 2, -2]) {
    if (out.length >= n) break
    const p = { x: tile.x + perp.x * k, y: tile.y + perp.y * k }
    if (!free(b, p)) continue
    const d = deployableUnit(owner, { name, type: 'Deployable', size: 1, hp: 999, evasion: 5 } as any, p)
    d.resist = ['all']; d.flags.isCover = false
    setup(d)
    b.spawn(d)
    out.push(d)
  }
  if (!out.length) throw new Error('No room')
  return out
}
const mineOf = (b: Battle, u: Unit, name: string) => b.alive().filter(d => d.ownerId === u.id && d.flags.dataName === name)

// ------------------------------------------------------------------ Ammo Case (Walking Armory)
type Ammo = 'thumper' | 'shock' | 'mag' | 'hellfire' | 'jager' | 'sabot'
const AMMO: Record<Ammo, { cost: number; tier: 1 | 2; text: string }> = {
  thumper: { cost: 1, tier: 1, text: 'Knockback 1, explosive damage' },
  shock: { cost: 1, tier: 1, text: 'Energy damage; characters adjacent to the target take 1 AP energy' },
  mag: { cost: 1, tier: 1, text: 'Arcing, kinetic damage' },
  hellfire: { cost: 2, tier: 2, text: 'Energy damage; bonus damage becomes Burn' },
  jager: { cost: 2, tier: 2, text: 'Knockback 2, explosive damage; the target makes a Hull save or falls Prone' },
  sabot: { cost: 2, tier: 2, text: 'AP, kinetic damage' },
}
const ammoCase = (u: Unit) => u.systems.find(s => s.dataId.startsWith('ms_walking_armory') && !s.destroyed)
const ammoTier = (u: Unit) => (u.systems.some(s => s.dataId === 'ms_walking_armory_3') ? 3 : u.systems.some(s => s.dataId === 'ms_walking_armory_2') ? 2 : 1)
const ammoScript = (id: string): ItemScript => ({
  id, note: 'Ammo Case: choose a special round for your next Main ranged attack (1/turn); rank 3 refunds charges on a crit',
  actions: (_b, u) => {
    const s = ammoCase(u)
    if (!s || s.dataId !== id) return [] // one set of actions even with several ranks
    return (Object.keys(AMMO) as Ammo[]).filter(k => AMMO[k].tier <= ammoTier(u)).map(k => action({
      key: `ammo:${k}`, name: `${u.flags.ammo === k ? '✓ ' : ''}Load ${k.toUpperCase()} (${AMMO[k].cost})`, activation: 'free', target: 'none', text: AMMO[k].text,
      usable: () => ((s.usesLeft ?? 6) < AMMO[k].cost ? 'Not enough charges' : true),
      run: (bt, me) => { me.flags.ammo = me.flags.ammo === k ? undefined : k; bt.say(me.flags.ammo ? `${me.name} loads ${k.toUpperCase()} rounds.` : `${me.name} unloads special rounds.`) },
    }))
  },
  beforeAttack(b, self, ctx, role) {
    const k = self.flags.ammo as Ammo | undefined
    const s = ammoCase(self)
    if (role !== 'attacker' || !k || !s || s.dataId !== id || ctx.weapon?.size !== 'Main' || ctx.melee || ctx.tech || !ctx.profile || self.flags['turn:ammoUsed']) return
    if ((s.usesLeft ?? 6) < AMMO[k].cost) return
    self.flags['turn:ammoUsed'] = true
    self.flags.ammoFiring = { k, cost: AMMO[k].cost, target: ctx.target.id, saved: ctx.profile.damage.map(d => d.type), tags: ctx.profile.tags.length }
    if (s.usesLeft != null) s.usesLeft -= AMMO[k].cost
    const type = k === 'thumper' || k === 'jager' ? 'Explosive' : k === 'shock' || k === 'hellfire' ? 'Energy' : 'Kinetic'
    ctx.profile.damage = ctx.profile.damage.map(d => ({ ...d, type }))
    if (k === 'mag') ctx.profile.tags = [...ctx.profile.tags, { id: 'tg_arcing', ammo: true } as any]
    if (k === 'sabot') ctx.profile.tags = [...ctx.profile.tags, { id: 'tg_ap', ammo: true } as any]
    if (k === 'hellfire') ctx.bonusDamage = ctx.bonusDamage.map(d => ({ ...d, type: 'Burn' }))
    ctx.reasons.push(`Ammo: ${k.toUpperCase()}`)
  },
  afterAttack(b, self, ctx, role) {
    const f = self.flags.ammoFiring
    if (role !== 'attacker' || !f || f.target !== ctx.target.id || !ctx.profile) return
    self.flags.ammoFiring = undefined
    ctx.profile.damage = ctx.profile.damage.map((d, i) => ({ ...d, type: f.saved[i] ?? d.type }))
    ctx.profile.tags = ctx.profile.tags.filter(t => !(t as any).ammo)
    const t = ctx.target
    if (ctx.hit && !t.destroyed) {
      if (f.k === 'thumper') b.forceMove(t, self, 1, 1)
      if (f.k === 'jager') { b.forceMove(t, self, 2, 1); if (!t.destroyed && !saveVs(b, t, 'hull', self, 'prone')) b.addStatus(t, 'prone', 'until_cleared', self) }
    }
    if (f.k === 'shock') for (const o of chars(b)) if (o !== t && o !== self && b.adjacent(o, t)) b.applyDamage(o, [{ type: 'Energy', amount: 1 }], { source: self, ap: true })
    if (ctx.crit && ammoTier(self) >= 3) { const s = ammoCase(self); if (s && s.usesLeft != null) s.usesLeft += f.cost; b.say('  Efficiency: no charges spent.') }
  },
})

// ------------------------------------------------------------------ scripts
/** SEKHMET in control: close on the closest visible character (any side) and attack it in melee only. */
export function sekhmetTurn(b: Battle, u: Unit) {
  const melee = () => u.weapons.filter(w => !w.destroyed && !w.tech && b.isMelee(w))
  const visible = (o: Unit) => o !== u && !o.destroyed && (o.kind === 'mech' || o.kind === 'npc') && !o.flags.intangible && !b.has(o, 'hidden') && (b.distance(u, o) <= 1 || b.los(u, o))
  const target = () => b.alive().filter(visible).sort((x, y) => b.distance(u, x) - b.distance(u, y))[0]
  const ready = (t: Unit) => melee().find(w => b.weaponUsable(u, w) === true && b.validTarget(u, w, t) === true)
  const approach = () => {
    const t = target()
    if (!t || u.moveLeft <= 0 || b.canMove(u, 'standard') !== true) return
    let best: Pos | null = null, bd = b.distance(u, t)
    for (const r of b.reachable(u, u.moveLeft).values()) { const d = Math.max(0, chebyshev(r.pos, t.pos) - 1); if (d < bd) { bd = d; best = r.pos } }
    if (best) try { b.move(u, best, { mode: 'standard' }) } catch (e) { if (e instanceof PendingChoice) throw e /* else path blocked */ }
  }
  if (!target()) return
  if (!ready(target()!)) approach()
  for (let guard = 0; guard < 6 && !u.destroyed; guard++) {
    const t = target()
    if (!t) break
    const w = ready(t)
    if (w && !u.flags['round:sekhmetFree']) { u.flags['round:sekhmetFree'] = true; b.say('SEKHMET strikes (free Skirmish).'); b.markFired(u, w); b.weaponAttack(u, w, { targetId: t.id }, 'skirmish'); continue }
    if (w && b.canSpend(u, 'quick', 'skirmish') === true) { b.skirmish(u, w, { targetId: t.id }); continue }
    if (!w && b.canSpend(u, 'quick', 'boost') === true && !b.has(u, 'slowed') && !b.has(u, 'immobilized') && !b.has(u, 'grappled')) { b.boost(u); approach(); continue }
    break
  }
}
function cutCable(b: Battle, owner: Unit) {
  const t = b.unit(owner.flags.tether)
  if (t) t.flags.tetheredTo = undefined
  if (owner.flags.tether) b.say(`${owner.name}'s cable is cut.`)
  owner.flags.tether = undefined
}

/** Blinkshield: a character straddling the border is moved fully inside or outside (Agility save: it picks; otherwise the owner does). */
function settleStraddler(b: Battle, owner: Unit, u: Unit, tiles: Pos[]) {
  const ok = b.save(u, 'agi', owner.stats.save, 0, owner)
  const chooser = ok ? u : owner
  const preferIn = !b.hostile(owner, u)
  const i = b.choose({ kind: 'blink_side', unit: chooser, title: `Blinkshield: where does ${u.name} go?`, options: [{ label: 'Inside the bubble' }, { label: 'Outside the bubble' }], defaultIndex: (chooser === u ? !b.hostile(owner, u) : preferIn) ? 0 : 1 })
  const wantIn = i === 0
  const okAt = (p: Pos) => { const fp = footprint({ pos: p, stats: u.stats }); return fp.every(q => free(b, q, u)) && (wantIn ? fp.every(q => tiles.some(t => t.x === q.x && t.y === q.y)) : !fp.some(q => tiles.some(t => t.x === q.x && t.y === q.y))) }
  for (let r = 1; r <= 6; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const p = { x: u.pos.x + dx, y: u.pos.y + dy }
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== r || !okAt(p)) continue
    const from = u.pos
    u.pos = p
    b.emit({ type: 'move', unitId: u.id, path: [from, p] })
    b.say(`${u.name} is shunted ${wantIn ? 'inside' : 'outside'} the Blinkshield.`)
    return
  }
}
const mineRange = (u: Unit) => (u.flags.assaultLauncher ? 15 : 1)
const nextTurnEnds = (u: Unit) => (u.activeTurn ? 2 : 1)
const scripts: ItemScript[] = [
  // ---------------- SEKHMET
  {
    id: 'ms_sekhmet_class_nhp',
    note: 'SEKHMET Protocol: the NHP drives your mech — it spends every move and action closing on the closest visible character (allied or hostile) and attacking it in melee only; 1/round a free melee Skirmish; melee crits +1d6; Take Back Control (protocol) stuns you until the start of your next turn',
    actions: (_b, u) => [u.flags.sekhmet
      ? action({ key: 'sekhmet_off', name: 'Take Back Control', activation: 'protocol', target: 'none', text: 'Retake your mech; you are Stunned until the start of your next turn.', run: (bt, me) => { me.flags.sekhmet = false; bt.addStatus(me, 'stunned', 'start_of_next_turn_target', me) }, aiScore: () => -1 })
      : action({
        key: 'sekhmet', name: 'SEKHMET Protocol', activation: 'protocol', target: 'none', text: 'Give your NHP control: it charges the closest visible character (ally or hostile) and attacks it in melee; melee crits +1d6.',
        run: (bt, me) => { me.flags.sekhmet = true; bt.say(`${me.name} hands control to SEKHMET.`, 'warn') },
        aiTarget: (_bt, me) => ({ ...me.pos }),
        aiScore: (bt, me) => (me.weapons.some(w => w.type === 'Melee') && hostiles(bt, me).some(h => bt.distance(me, h) <= me.stats.speed + 2) && !allies(bt, me).some(a => bt.distance(me, a) <= 3) ? 2 : 0),
      })],
    afterAnyRoll(b, self, ctx) { if (self.flags.sekhmet && ctx.attacker === self && ctx.crit && ctx.melee) ctx.bonusDamage.push({ type: 'Kinetic', val: '1d6' } as any) },
  },
  // ---------------- Cable Winch
  {
    id: 'ms_cable_winch_system',
    note: 'Cable Winch: attach to an adjacent character (Hull save unless Stunned or willing); neither may end up more than 5 apart — whoever moves tows the other (if it can drag it: up to twice its Size) and is Slowed; anyone can cut the cable with a melee or improvised hit against Evasion 10',
    actions: (_b, u) => [u.flags.tether
      ? action({ key: 'unwinch', name: 'Release Cable', activation: 'quick', target: 'none', text: 'Remove the cable.', run: (bt, me) => cutCable(bt, me) })
      : action({
        key: 'winch', name: 'Cable Winch', activation: 'quick', target: 'unit', range: 1, text: 'Attach a cable to an adjacent character.',
        run: (bt, me, t) => {
          const target = t as Unit
          if (!bt.adjacent(me, target)) throw new Error('Must be adjacent')
          if (bt.hostile(me, target) && !bt.has(target, 'stunned') && bt.save(target, 'hull', me.stats.save, 0, me)) return
          me.flags.tether = target.id; target.flags.tetheredTo = me.id
          bt.say(`${me.name} winches onto ${target.name}.`)
        },
      })],
    grantActions: (b, self, other) => {
      const t = b.unit(self.flags.tether)
      if (!t || t.destroyed || (other !== t && other !== self && !b.adjacent(other, self) && !b.adjacent(other, t))) return []
      if (other === self) return []
      return [action({
        key: `cutcable:${self.id}`, name: `Cut ${self.name}'s cable`, activation: 'quick', target: 'none', text: 'Melee attack against the cable (Evasion 10): on a hit it is cut.',
        run: (bt, me) => {
          const acc = bt.accuracyFromStatuses(me, 'attack')
          const r = bt.rng.d(20) + me.stats.attackBonus + (acc > 0 ? Math.max(...Array.from({ length: acc }, () => bt.rng.d(6))) : acc < 0 ? -Math.max(...Array.from({ length: -acc }, () => bt.rng.d(6))) : 0)
          bt.say(`  ${me.name} slashes at the cable: ${r} vs 10.`)
          if (r >= 10) cutCable(bt, self)
        },
        aiScore: (bt, me) => (bt.hostile(me, self) ? 2 : 0),
      })]
    },
    onMove(b, self, mover) {
      const t = b.unit(self.flags.tether)
      if (!t || t.destroyed) { if (self.flags.tether) cutCable(b, self); return }
      if (mover !== self && mover !== t) return
      const other = mover === self ? t : self
      const d = b.distance(self, t)
      if (d <= 5) return
      // tow the other end if the mover can drag it (twice its Size); otherwise the cable snaps taut and stops the mover
      if (other.stats.size <= mover.stats.size * 2) {
        b.forceMove(other, mover, d - 5, -1)
        b.addStatus(mover, 'slowed', 'end_of_turn', self)
        b.say(`${mover.name} tows ${other.name} on the cable.`)
      } else {
        b.forceMove(mover, other, d - 5, -1)
        b.say(`The cable pulls ${mover.name} up short.`)
      }
    },
    onDestroyed(b, self, v) { if (v === self || v.id === self.flags.tether) cutCable(b, self) },
  },
  // ---------------- MULE Harness
  {
    id: 'ms_mule_harness', note: 'MULE Harness: adjacent allies climb on (quick) and ride along with soft cover; riders fall off Prone if you are knocked down',
    grantActions: (b, self, other) => {
      if (b.hostile(self, other) || other.kind !== 'mech') return []
      if (other.flags.ridingOn === self.id) return [action({
        key: `mule_off:${self.id}`, name: `Climb down from ${self.name}`, activation: 'quick', target: 'none', text: 'Climb down to an adjacent space.',
        run: bt => dismount(bt, self, other, false),
      })]
      const load = b.alive().filter(r => r.flags.ridingOn === self.id).reduce((a, r) => a + r.stats.size, 0)
      if (!b.adjacent(self, other) || b.has(other, 'immobilized') || load + other.stats.size > self.stats.size - 0.5) return []
      return [action({
        key: `mule_on:${self.id}`, name: `Ride ${self.name}`, activation: 'quick', target: 'none', text: 'Climb onto the MULE harness: move with it and gain soft cover.',
        run: (bt, me) => { me.flags.ridingOn = self.id; me.flags.flat = true; const from = me.pos; me.pos = { ...self.pos }; bt.emit({ type: 'move', unitId: me.id, path: [from, me.pos] }); bt.say(`${me.name} climbs onto ${self.name}.`) },
      })]
    },
    onMove(b, self, mover) {
      if (mover !== self) return
      for (const r of b.alive().filter(r => r.flags.ridingOn === self.id)) { const from = r.pos; r.pos = { ...self.pos }; b.emit({ type: 'move', unitId: r.id, path: [from, r.pos] }) }
    },
    adjustCover: (_b, self, _a, target, c) => (target.flags.ridingOn === self.id && c === 'none' ? 'soft' : c),
    onStatusRemoved() { /* riders handled at turn start */ },
    onAnyTurnStart(b, self) {
      if (!(['prone', 'stunned', 'immobilized'] as StatusId[]).some(s => b.has(self, s))) return
      for (const r of b.alive().filter(r => r.flags.ridingOn === self.id)) dismount(b, self, r, true)
    },
    onDestroyed(b, self, v) { if (v === self) for (const r of b.alive().filter(r => r.flags.ridingOn === self.id)) dismount(b, self, r, true) },
  },
  // ---------------- Whitewash Sealant Spray
  {
    id: 'ms_whitewash_sealant_spray', note: 'Whitewash: hostiles (Agility save) or allies are Slowed and lose all Burn; on a free space, puts out fires in Blast 1 and the area becomes difficult terrain for the scene',
    actions: () => [action({
      key: 'whitewash', name: 'Whitewash Sealant', activation: 'quick', target: 'tile', range: 5, text: 'Spray a character or a space within range 5.',
      run: (bt, me, t) => {
        const p = at(t)
        if (!hasLineOfSightToTile(bt.effectiveMap(), me, p)) throw new Error('No line of sight')
        const who = chars(bt).find(o => footprint(o).some(q => q.x === p.x && q.y === p.y))
        if (who) {
          if (bt.hostile(me, who) && bt.save(who, 'agi', me.stats.save, 0, me)) return
          who.burn = 0
          bt.addStatus(who, 'slowed', 'next_turn_end_target', me)
        } else {
          if (distanceToTile(bt.map, me, p) > 5) throw new Error('Out of range (5)')
          const tiles = blastTiles(bt.map, p, 1)
          // fires (burning areas) are put out; other zones (caltrops...) stay
          bt.areas = bt.areas.filter(a => !(a.kind === 'damage' && a.tiles.some(x => tiles.some(y => x.x === y.x && x.y === y.y))))
          bt.addArea({ kind: 'difficult', tiles, ownerId: me.id, tag: 'sealant' })
        }
      },
      aiTarget: (bt, me) => {
        const burning = allies(bt, me).concat(me).find(a => a.burn >= 3 && bt.distance(me, a) <= 5)
        if (burning) return { ...burning.pos }
        const h = nearest(bt, me, hostiles(bt, me).filter(h => bt.distance(me, h) <= 5 && !bt.has(h, 'slowed')))
        return h ? { ...h.pos } : null
      },
      aiScore: () => 1.5,
    })],
  },
  // ---------------- Armor-Lock Plating
  {
    id: 'ms_armor_lock_plating',
    note: "Armor-Lock: you can Brace while grappled (every grapple on you ends); while Braced (until the end of your next turn): +1 difficulty against you, you can't fail Hull or Agility saves or contested checks, and you are immune to Knockback, grapples, Prone and being moved by anything smaller than Size 5",
    init: u => { u.flags.braceWhileGrappled = true },
    // while Braced (until the end of your following turn): can't fail Hull/Agility saves or contested checks; Heat 2 (Self) when it engages
    onStatusAdded(b, self, st) { if (st === 'braced') { self.flags.autoSaveUntil = 1e9; self.flags.winContests = true; b.say(`${self.name} locks its armor.`); b.addHeat(self, 2) } },
    onStatusRemoved(b, self, st) { if (st === 'braced') { delete self.flags.autoSaveUntil; delete self.flags.winContests } },
    beforeAttack(b, self, ctx, role) { if (role === 'target' && b.has(self, 'braced')) { ctx.difficulty++; ctx.reasons.push('Armor-Lock -1') } },
    canBeMoved: (b, self, source) => !(b.has(self, 'braced') && (!source || source.stats.size < 5)),
    blockStatus: (b, self, st) => (st === 'prone' || st === 'grappled') && b.has(self, 'braced'),
  },
  // ---------------- BB Breach/Blast Charges
  {
    id: 'ms_bb_breach_blast_charges', note: 'BB charges: Thermal Grenade (Blast 1, Agility save, 1d6 energy, half on success); Breaching Charge (planted adjacent, detonated as a quick action: 2d6 AP explosive)',
    actions: (b, u) => {
      const s = sys(u, 'ms_bb_breach_blast_charges')
      const out = [action({
        key: 'thermal_grenade', name: 'Thermal Grenade', activation: 'quick', target: 'tile', range: 5, area: { shape: 'blast', size: 1 }, text: 'Blast 1 within range 5: Agility save or 1d6 energy (half on success).',
        usable: () => usesOk(s),
        run: (bt, me, t) => { spend(s); const tiles = blastTiles(bt.map, at(t), 1); bt.emit({ type: 'area', tiles, kind: 'explosion' }); for (const v of unitsOnTiles(chars(bt), tiles)) if (v !== me) half(bt, v, me, 'agi', '1d6', 'Energy'); bt.damageObjectsIn(tiles, 10, { source: me, ap: true }) },
      }), action({
        key: 'breach_charge', name: 'Plant Breaching Charge', activation: 'quick', target: 'tile', range: 1, text: 'Plant a breaching charge in an adjacent space, wall or piece of cover; detonate it later as a quick action.',
        usable: () => usesOk(s),
        run: (bt, me, t) => { bt.placeMine(me, at(t), { name: 'Breaching Charge', radius: 1, damage: [], trigger: 'remote', tag: 'breach' }, { onWalls: true }); spend(s) },
        aiScore: () => -1,
      })]
      for (const m of b.mines.filter(x => x.ownerId === u.id && x.tag === 'breach')) out.push(action({
        key: `breach_boom:${m.id}`, name: 'Detonate Breaching Charge', activation: 'quick', target: 'none', text: 'Burst 1: Agility save or 2d6 AP explosive (half on success); objects and terrain take 30 AP explosive.',
        usable: (bt) => (bt.mines.includes(m) ? true : 'Gone'),
        run: (bt) => bt.detonateMine(m),
        aiTarget: (bt, me) => (unitsOnTiles(hostiles(bt, me), blastTiles(bt.map, m.pos, 1)).length && !unitsOnTiles(allies(bt, me), blastTiles(bt.map, m.pos, 1)).length ? { ...me.pos } : null),
        aiScore: () => 4,
      }))
      return out
    },
    onMineDetonate(b, self, m) {
      if (m.tag !== 'breach') return false
      const tiles = blastTiles(b.map, m.pos, 1)
      b.emit({ type: 'area', tiles, kind: 'explosion' })
      for (const v of unitsOnTiles(chars(b), tiles)) half(b, v, self, 'agi', '2d6', 'Explosive', undefined, true)
      b.damageObjectsIn(tiles, 30, { source: self, ap: true })
      return true
    },
  },
  // ---------------- Magnetic Shield
  {
    id: 'ms_magnetic_shield',
    note: 'Magnetic Shield: a Line 4 forcefield next to you for the scene (a new one replaces it): it obstructs mechs, does not block line of sight, gives soft cover, and characters it covers resist kinetic and explosive damage',
    actions: () => [action({
      key: 'magshield', name: 'Magnetic Shield', activation: 'quick', target: 'tile', range: 1, text: 'Raise a Line 4 forcefield next to you (replaces the old one).',
      run: (bt, me, t) => {
        for (const d of mineOf(bt, me, 'Magnetic Shield')) bt.removeUnit(d, 'deactivates')
        spawnLine(bt, me, at(t), 'Magnetic Shield', 4, d => { d.flags.magshield = true })
        bt.say(`${me.name} raises a magnetic shield.`)
      },
      aiTarget: (bt, me) => { const h = nearest(bt, me, hostiles(bt, me)); return h ? { x: me.pos.x + Math.sign(h.pos.x - me.pos.x), y: me.pos.y + Math.sign(h.pos.y - me.pos.y) } : null },
      aiScore: (bt, me) => (!mineOf(bt, me, 'Magnetic Shield').length && hostiles(bt, me).some(h => bt.distance(me, h) <= 12) ? 2 : 0),
    })],
    adjustCover(b, self, attacker, target, c) {
      if (c !== 'none') return c
      return mineOf(b, self, 'Magnetic Shield').some(s => shields(attacker, target, s.pos)) ? 'soft' : c
    },
    beforeAnyDamage(b, self, t, parts, opts) {
      const src = opts.attack?.attacker ?? opts.source
      if (!src || !parts.some(p => p.type === 'Kinetic' || p.type === 'Explosive')) return
      if (mineOf(b, self, 'Magnetic Shield').some(s => shields(src, t, s.pos))) opts.resistTypes = [...(opts.resistTypes ?? []), 'Kinetic', 'Explosive']
    },
    fields: (b, u) => { const segs = mineOf(b, u, 'Magnetic Shield'); return segs.length ? [{ tiles: segs.map(s => s.pos), effect: 'barrier' as const, label: `${u.name}'s magnetic shield: soft cover and resistance to kinetic/explosive` }] : [] },
  },
  // ---------------- Flicker Field Projector
  {
    id: 'ms_flicker_field_projector', note: 'Flicker Field: after a Boost or standard move, you count as Invisible the next time you are attacked',
    onAnyMovementAction(_b, self, mover, kind) { if (mover === self && kind !== 'involuntary') self.flags.flicker = true },
    beforeAttack(_b, self, ctx, role) { if (role === 'target' && self.flags.flicker) { ctx.forceInvisible = true; self.flags.flicker = false } },
  },
  // ---------------- Flash Charges
  {
    id: 'ms_flash_charges', note: "Flash Charges: Flash Grenade (range 5, Blast 3 until the end of your next turn: characters other than you at least partly inside can't draw line of sight out of it); Flash Mine (Burst 1 when a character moves adjacent to or over it: Agility save or line of sight to adjacent spaces only until the end of its next turn)",
    actions: (b, u) => {
      const s = sys(u, 'ms_flash_charges')
      return [action({
        key: 'flash_grenade', name: 'Flash Grenade', activation: 'quick', target: 'tile', range: 5, area: { shape: 'blast', size: 3 }, text: "Blast 3 zone: characters other than you inside it can't draw line of sight out.",
        usable: () => usesOk(s),
        run: (bt, me, t) => {
          if (chebyshev(me.pos, at(t)) > 5) throw new Error('Out of range')
          spend(s)
          me.flags.flash = { tiles: blastTiles(bt.map, at(t), 3), until: bt.round + 1 }
          bt.losZones.push({ tiles: me.flags.flash.tiles.map((p: Pos) => `${p.x},${p.y}`), exempt: me.id, untilRound: bt.round + 1 })
          bt.invalidateTerrain()
          bt.emit({ type: 'area', tiles: me.flags.flash.tiles, kind: 'attack' })
        },
        aiTarget: (bt, me) => { const h = nearest(bt, me, hostiles(bt, me).filter(h => bt.distance(me, h) <= 7)); return h ? { ...h.pos } : null },
        aiScore: (bt, me, t) => (t && 'x' in t ? unitsOnTiles(hostiles(bt, me), blastTiles(bt.map, t, 3)).length * 1.5 : 0),
      }), action({
        key: 'flash_mine', name: 'Flash Mine', activation: 'quick', target: 'tile', range: mineRange(u), text: 'Plant a mine: when a hostile comes next to it, characters in Burst 1 save (Agility) or see only adjacent spaces until the end of their next turn.',
        usable: () => usesOk(s),
        run: (bt, me, t) => { bt.placeMine(me, at(t), { name: 'Flash Mine', radius: 1, damage: [], tag: 'flash' }, { range: mineRange(me) }); spend(s) },
      })]
    },
    onMineDetonate(b, self, m) {
      if (m.tag !== 'flash') return false
      const tiles = blastTiles(b.map, m.pos, 1)
      b.emit({ type: 'area', tiles, kind: 'explosion' })
      for (const v of unitsOnTiles(chars(b), tiles)) if (!b.save(v, 'agi', self.stats.save, 0, self)) blind(b, v)
      return true
    },
    fields: (b, u): FieldOverlay[] => [
      ...(u.flags.flash && b.round <= u.flags.flash.until ? [{ tiles: u.flags.flash.tiles, effect: 'control' as const, label: `${u.name}'s flash zone: no line of sight out` }] : []),
    ],
  },
  // ---------------- Javelin Rockets
  {
    id: 'ms_javelin_rockets', note: 'Javelin Rockets: three free spaces you choose (range 15, line of sight, not adjacent to each other) until the start of your next turn; the first character to move into each takes 3 kinetic',
    actions: () => [action({
      key: 'javelin', name: 'Javelin Rockets', activation: 'quick', target: 'tile', range: 15, text: 'Choose three free spaces within range 15 and line of sight, not adjacent to each other; each hits the first character to enter it for 3 kinetic.',
      run: (bt, me, t) => {
        const ok = (p: Pos, picked: Pos[]) => !!tileAt(bt.map, p) && free(bt, p) && distanceToTile(bt.map, me, p) <= 15 && hasLineOfSightToTile(bt.effectiveMap(), me, p) && !picked.some(q => chebyshev(q, p) <= 1)
        const first = at(t)
        if (!ok(first, [])) throw new Error('Choose a free space within range 15 and line of sight')
        const picked: Pos[] = [first]
        const dx = Math.sign(first.x - me.pos.x), dy = Math.sign(first.y - me.pos.y)
        const perp = { x: -dy || 1, y: dx }
        for (let n = 0; n < 2; n++) {
          // candidate spaces near the first one (two across the line of fire first)
          const cands: Pos[] = []
          const add = (p: Pos) => { if (ok(p, picked) && !cands.some(c => c.x === p.x && c.y === p.y)) cands.push(p) }
          add({ x: first.x + perp.x * 2, y: first.y + perp.y * 2 }); add({ x: first.x - perp.x * 2, y: first.y - perp.y * 2 })
          for (let r = 2; r <= 4 && cands.length < 12; r++) for (let yy = -r; yy <= r; yy++) for (let xx = -r; xx <= r; xx++) if (Math.max(Math.abs(xx), Math.abs(yy)) === r) add({ x: first.x + xx, y: first.y + yy })
          if (!cands.length) break
          const opts = cands.slice(0, 12)
          const i = bt.choose({ kind: 'javelin_space', unit: me, title: `Javelin Rockets: space ${n + 2} of 3`, options: opts.map(p => ({ label: `(${p.x}, ${p.y})`, hint: `${chebyshev(p, first)} from the first` })), defaultIndex: 0 })
          picked.push(opts[i])
        }
        me.flags.javelins = picked
      },
      aiTarget: (bt, me) => { const h = nearest(bt, me, hostiles(bt, me).filter(h => bt.distance(me, h) <= 16)); return h ? { x: h.pos.x + Math.sign(me.pos.x - h.pos.x), y: h.pos.y + Math.sign(me.pos.y - h.pos.y) } : null },
      aiScore: (_bt, me) => (me.flags.javelins?.length ? 0 : 1.5),
    })],
    onTurnStart(_b, u) { u.flags.javelins = [] },
    onMove(b, self, mover, path) {
      if (!self.flags.javelins?.length || mover.destroyed) return
      for (const j of [...self.flags.javelins as Pos[]]) if (path.slice(1).some(p => footprint({ pos: p, stats: mover.stats }).some(q => q.x === j.x && q.y === j.y))) {
        self.flags.javelins = (self.flags.javelins as Pos[]).filter(x => x !== j)
        b.say(`A javelin rocket strikes ${mover.name}!`, 'attack')
        b.applyDamage(mover, [{ type: 'Kinetic', amount: 3 }], { source: self })
      }
    },
    fields: (_b, u) => (u.flags.javelins?.length ? [{ tiles: u.flags.javelins, effect: 'harm' as const, label: `${u.name}'s javelin rocket target (3 kinetic)` }] : []),
  },
  // ---------------- TLALOC
  {
    id: 'ms_tlaloc_class_nhp',
    note: 'TLALOC Protocol: Immobilized until the start of your next turn; reroll each missed attack once, at a new target within the attack\'s range (area attacks: inside the same area); no target is hit twice by one action',
    actions: () => [action({
      key: 'tlaloc', name: 'TLALOC Protocol', activation: 'protocol', heat: 2, target: 'none', text: 'Immobilized until your next turn; reroll each missed attack once at a new target in range.',
      run: (bt, me) => { me.flags.tlaloc = true; bt.addStatus(me, 'immobilized', 'start_of_next_turn_target', me) },
      aiTarget: (_bt, me) => ({ ...me.pos }),
      aiScore: (bt, me) => (me.heat + 2 < me.stats.heatcap && hostiles(bt, me).some(h => me.weapons.some(w => bt.validTarget(me, w, h) === true)) ? 2 : 0),
    })],
    onTurnStart: (b, u) => { delete u.flags.tlaloc },
    beforeAttack(b, self, ctx, role) {
      // area attacks: the reroll stays inside the same area — reroll against the same character
      if (role === 'attacker' && self.flags.tlaloc && !ctx.tech && ctx.multiTarget) ctx.rerollOnMiss = true
    },
    afterAttack(b, self, ctx, role) {
      if (role !== 'attacker' || !self.flags.tlaloc || ctx.tech || !ctx.weapon || ctx.multiTarget || self.flags.tlalocRerolling) return
      const k = `${b.lastAim?.targetId}:${ctx.weapon.uid}:${self.flags['turn:spent']?.length ?? 0}`
      if (self.flags.tlalocAction !== k) { self.flags.tlalocAction = k; self.flags.tlalocHit = [] }
      if (ctx.hit) { self.flags.tlalocHit = [...self.flags.tlalocHit, ctx.target.id]; return }
      const w = ctx.weapon
      const cands = b.alive().filter(o => (o.kind === 'mech' || o.kind === 'npc') && o !== self && b.hostile(self, o) && !self.flags.tlalocHit.includes(o.id) && b.validTarget(self, w, o) === true)
      if (!cands.length) return
      const def = Math.max(0, cands.indexOf(ctx.target))
      const i = b.choose({ kind: 'tlaloc', unit: self, title: 'TLALOC: reroll the miss', text: `Missed ${ctx.target.name}. Reroll against:`, options: [...cands.map(c => ({ label: c.name, hint: `${b.distance(self, c)} spaces` })), { label: 'No reroll' }], defaultIndex: def })
      if (i >= cands.length) return
      self.flags.tlalocRerolling = true
      b.say(`  TLALOC retargets: ${cands[i].name}.`)
      try {
        const r = b.weaponAttack(self, w, { targetId: cands[i].id }, 'free', { noBonusDamage: ctx.bonusDamage.length === 0 })
        if (r.ctxs.some(c => c.hit)) self.flags.tlalocHit = [...self.flags.tlalocHit, cands[i].id]
      } finally { delete self.flags.tlalocRerolling }
    },
  },
  // ---------------- FADE Cloak
  {
    id: 'ms_fade_cloak', note: "FADE Cloak: phase out (intangible: you can't interact with or be affected by anything; you move through obstructions but can't stop inside them); at each turn start, on 1–3 you are back in realspace until your next turn; deactivate as a quick action",
    actions: (_b, u) => [action({
      key: 'fade', name: u.flags.fade ? 'Deactivate FADE Cloak' : 'FADE Cloak', activation: 'quick', target: 'none', text: 'Toggle intangibility.',
      run: (bt, me) => { me.flags.fade = !me.flags.fade; me.flags.intangible = me.flags.fade; bt.say(me.flags.fade ? `${me.name} phases out of realspace.` : `${me.name} returns to realspace.`) },
      aiTarget: (_bt, me) => ({ ...me.pos }),
      aiScore: (_bt, me) => (!me.flags.fade && me.hp < me.stats.hp / 3 ? 2 : 0),
    })],
    onTurnStart(b, u) {
      if (!u.flags.fade) return
      const r = b.rng.d(6)
      u.flags.intangible = r >= 4
      b.say(`${u.name}'s FADE cloak (${r}): ${u.flags.intangible ? 'still phased out' : 'back in realspace this turn'}.`)
    },
  },
  // ---------------- Retractable Profile
  {
    id: 'ms_retractable_profile', note: "Retractable Profile: rolls to locate you while Hidden (Search) and ranged and tech attacks against you take +1 difficulty; you are Slowed and can't attack",
    actions: (_b, u) => [u.flags.noAttacks
      ? action({ key: 'retract_off', name: 'Deactivate Retractable Profile', activation: 'quick', target: 'none', text: 'Extend your systems again.', run: (_bt, me) => { me.flags.noAttacks = false; delete me.flags.locateDifficulty; me.statuses = me.statuses.filter(s => !s.data?.retract) } })
      : action({ key: 'retract', name: 'Retractable Profile', activation: 'protocol', target: 'none', text: "Retract: +1 difficulty against ranged/tech attacks on you; Slowed; can't attack.", run: (bt, me) => { me.flags.noAttacks = true; me.flags.locateDifficulty = 1; bt.addStatus(me, 'slowed', 'until_cleared', me, { retract: true }) } })],
    beforeAttack(_b, self, ctx, role) { if (role === 'target' && self.flags.noAttacks && (ctx.ranged || ctx.tech)) { ctx.difficulty++; ctx.reasons.push('Retracted -1') } },
  },
  // ---------------- ATHENA
  {
    id: 'ms_athena_class_nhp', note: "ATHENA Simulacrum: a Blast 3 model within range 50 for the scene (re-target as a quick action): you know the stats of everyone inside; hostiles inside get no cover and can't Hide or turn Invisible; hostiles ending their turn there are Locked On and lose Hidden/Invisible",
    actions: () => [action({
      key: 'athena', name: 'Simulacrum', activation: 'quick', target: 'tile', range: 50, area: { shape: 'blast', size: 3 }, text: 'Model a Blast 3 area: hostiles inside lose cover; ending a turn there gives Lock On and reveals them.',
      run: (bt, me, t) => { me.flags.athena = blastTiles(bt.map, at(t), 3); for (const u of bt.alive()) if (onTiles(u, me.flags.athena)) u.flags.scanned = true },
      aiTarget: (bt, me) => { const h = nearest(bt, me, hostiles(bt, me)); return h ? { ...h.pos } : null },
      aiScore: (bt, me, t) => (t && 'x' in t ? unitsOnTiles(hostiles(bt, me), blastTiles(bt.map, t, 3)).length * 1.2 - (me.flags.athena ? 2 : 0) : 0),
    })],
    beforeAnyAttack(b, self, ctx) { if (self.flags.athena && b.hostile(self, ctx.target) && onTiles(ctx.target, self.flags.athena)) ctx.ignoreCover = true },
    blockAnyStatus: (b, self, t, st) => !!self.flags.athena && (st === 'hidden' || st === 'invisible') && b.hostile(self, t) && onTiles(t, self.flags.athena),
    onMove(b, self, mover) { if (self.flags.athena && onTiles(mover, self.flags.athena)) mover.flags.scanned = true },
    onAnyTurnEnd(b, self, u) {
      if (!self.flags.athena || !b.hostile(self, u) || !onTiles(u, self.flags.athena)) return
      b.removeStatus(u, 'hidden'); b.removeStatus(u, 'invisible')
      b.addStatus(u, 'lockon', 'until_cleared', self)
    },
    fields: (_b, u) => (u.flags.athena ? [{ tiles: u.flags.athena, effect: 'reveal' as const, label: `${u.name}'s ATHENA simulacrum: hostiles lose cover` }] : []),
  },
  // ---------------- Swarm Body
  {
    id: 'ms_swarm_body', note: 'Swarm Body: Burst 1 swarm from the end of your turn; hostiles starting or entering it save (Systems) or take 3 kinetic (+3 per stationary turn, max 9); ends when you move',
    actions: (_b, u) => (u.flags.swarm ? [] : [action({
      key: 'swarm', name: 'Swarm Body', activation: 'quick', target: 'none', text: 'Release a Burst 1 swarm at the end of your turn.',
      run: (_bt, me) => { me.flags.swarmPending = true },
      aiTarget: (_bt, me) => ({ ...me.pos }),
      aiScore: (bt, me) => (hostiles(bt, me).some(h => bt.distance(me, h) <= 2) ? 2.5 : 0),
    })]),
    onTurnEnd(b, u) {
      if (u.flags.swarmPending) { u.flags.swarmPending = false; u.flags.swarm = 3; b.say(`${u.name} releases a swarm.`) }
      else if (u.flags.swarm && !u.flags['turn:moved']) u.flags.swarm = Math.min(9, u.flags.swarm + 3)
    },
    onAnyMovementAction(_b, self, mover) { if (mover === self) { self.flags.swarm = undefined } },
    onAnyTurnStart(b, self, u) { swarmHit(b, self, u) },
    onMove(b, self, mover) { if (mover !== self) swarmHit(b, self, mover) },
    fields: (b, u) => (u.flags.swarm ? [{ tiles: burstTiles(b.map, u, 1), effect: 'harm' as const, label: `${u.name}'s swarm: Systems save or ${u.flags.swarm} kinetic` }] : []),
  },
  // ---------------- H0R_OS II / III
  {
    id: 'ms_h0r_os_system_upgrade_ii',
    note: 'H0R_OS II: Ideal Image (a Size 2 construct next to you: hard cover, blocks line of sight, immune to damage, an obstruction that dissipates if something is pushed into it; an adjacent character can dispel it with a Systems check as a full action; a new one replaces it); False Idol (a decoy of you or an ally in a free space within Sensors — hostiles with line of sight to it save (Systems) before acting against the original, and on a failure go after the decoy instead until the end of their next turn; Evasion 10, E-Defense 10, 1 HP)',
    actions: (b, u) => [action({
      key: 'ideal_image', name: 'Construct: Ideal Image', activation: 'quick_tech', techOption: 'ideal_image', target: 'tile', range: 1, text: 'A Size 2 construct next to you: hard cover, blocks line of sight, immune to damage (replaces the previous one).',
      run: (bt, me, t) => {
        const p = at(t)
        const d = deployableUnit(me, { name: 'Ideal Image', type: 'Deployable', size: 2, hp: 1, evasion: 5 } as any, p)
        if (!footprint(d).every(q => free(bt, q)) || !footprint(d).some(q => footprint(me).some(r => chebyshev(q, r) === 1))) throw new Error('Needs a free adjacent Size 2 space')
        for (const old of mineOf(bt, me, 'Ideal Image')) bt.removeUnit(old, 'fades')
        d.flags.isCover = true
        d.flags.dissipateOnPush = true
        d.flags.immuneDamage = true
        bt.spawn(d)
        bt.invalidateTerrain()
      },
      aiTarget: (bt, me) => { const h = nearest(bt, me, hostiles(bt, me)); return h ? tileNear(bt, me, h.pos, 1) : null },
      aiScore: (bt, me) => (!mineOf(bt, me, 'Ideal Image').length && hostiles(bt, me).some(h => bt.distance(me, h) <= 10) ? 1.5 : 0),
    }), action({
      key: 'false_idol', name: 'Construct: False Idol', activation: 'quick_tech', techOption: 'false_idol', target: 'tile', range: u.stats.sensors, text: 'Place a decoy of yourself or an ally (within Sensors) in a free space within Sensors (replaces the previous one).',
      run: (bt, me, t) => {
        const p = at(t)
        const subjects = [me, ...allies(bt, me).filter(a => bt.distance(me, a) <= me.stats.sensors)]
        const i = bt.choose({ kind: 'false_idol', unit: me, title: 'False Idol: whose decoy?', options: subjects.map(x => ({ label: x === me ? 'Yourself' : x.name })), defaultIndex: 0 })
        const who = subjects[i]
        const d = deployableUnit(me, { name: `False Idol (${who.name})`, type: 'Deployable', size: who.stats.size, hp: 1, evasion: 10, edef: 10 } as any, p)
        if (!footprint(d).every(q => free(bt, q))) throw new Error('Space occupied')
        for (const old of bt.alive().filter(o => o.ownerId === me.id && o.flags.idolOf)) bt.removeUnit(old, 'fades')
        d.flags.idolOf = who.id
        d.flags.dataName = 'False Idol'
        bt.spawn(d)
      },
      aiTarget: (bt, me) => { const h = nearest(bt, me, hostiles(bt, me)); return h ? tileNear(bt, me, h.pos, me.stats.sensors) : null },
      aiScore: (bt, me) => (bt.alive().some(o => o.ownerId === me.id && o.flags.idolOf) ? 0 : 1.5),
    })],
    grantActions: (b, self, other) => mineOf(b, self, 'Ideal Image').filter(d => b.adjacent(other, d)).map(d => action({
      key: `dispel:${d.id}`, name: 'Dispel Ideal Image', activation: 'full', target: 'none', text: 'Systems check: on a success the construct is destroyed.',
      run: (bt, me) => { if (bt.check(me, 'sys')) bt.removeUnit(d, 'is dispelled') },
      aiScore: (bt, me) => (bt.hostile(me, self) ? 1 : 0),
    })),
    beforeAnyDamage(b, self, t, parts) { if (t.flags.immuneDamage && t.ownerId === self.id) for (const p of parts) p.amount = 0 },
    beforeAnyAttack(b, self, ctx) {
      const idol = b.alive().find(o => o.ownerId === self.id && o.flags.idolOf)
      if (!idol || ctx.target.id !== idol.flags.idolOf || !b.hostile(self, ctx.attacker) && !b.hostile(ctx.target, ctx.attacker)) return
      const a = ctx.attacker
      const fooled = a.flags.fooledBy === idol.id && b.round <= (a.flags.fooledUntil ?? -1)
      if (!fooled) {
        if (!b.los(a, idol)) return
        if (b.save(a, 'sys', self.stats.save, 0, self)) return
        a.flags.fooledBy = idol.id
        a.flags.fooledUntil = b.round + 1
        b.say(`  ${a.name} is fooled by the False Idol.`)
      }
      ctx.target = idol
      ctx.reasons.push('False Idol')
    },
  },
  {
    id: 'ms_h0r_os_system_upgrade_iii', note: 'H0R_OS III invades: Dimensional Emblems (three Size 1 constructs next to the target, not next to each other: passing through one deals 2 heat and removes it; an adjacent character can destroy one with a Systems check as a quick action; you can delete them as a free action; a new use replaces them); Celestial Shackles (teleport the target back to its marked space)',
    actions: (b, u) => {
      const out: CustomAction[] = [invadeOpt(u, 'emblems', 'Dimensional Emblems', 'Three constructs next to the target; passing through one deals 2 heat.', (bt, me, t) => {
        const spots: Pos[] = []
        for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]]) {
          const p = { x: t.pos.x + dx, y: t.pos.y + dy }
          if (spots.length < 3 && free(bt, p) && !spots.some(s => chebyshev(s, p) <= 1)) spots.push(p)
        }
        for (const old of bt.alive().filter(o => o.ownerId === me.id && o.flags.emblem)) bt.removeUnit(old, 'fades')
        for (const p of spots) {
          const d = deployableUnit(me, { name: 'Dimensional Emblem', type: 'Deployable', size: 1, hp: 10, evasion: 5 } as any, p)
          d.flags.emblem = true; d.flags.flat = true; d.flags.isCover = false
          bt.spawn(d)
        }
      }), invadeOpt(u, 'shackles', 'Celestial Shackles', 'Mark the target’s space; teleport it back there later (free action on your turn).', (_bt, me, t) => { t.flags.shackledBy = me.id; t.flags.shackleAt = { ...t.pos } })]
      for (const t of b.alive().filter(o => o.flags.shackledBy === u.id && (o.pos.x !== o.flags.shackleAt.x || o.pos.y !== o.flags.shackleAt.y))) out.push(action({
        key: `shackle_pull:${t.id}`, name: `Shackles: return ${t.name}`, activation: 'free', target: 'none', text: 'Teleport the shackled character back to its marked space.',
        usable: (_bt, me) => (me.activeTurn ? true : 'Only on your turn'),
        run: (bt) => { const p = free(bt, t.flags.shackleAt, t) ? t.flags.shackleAt : tileNear(bt, t, t.flags.shackleAt, 2); t.flags.shackledBy = undefined; if (p) { const from = t.pos; t.pos = p; bt.emit({ type: 'move', unitId: t.id, path: [from, p] }) } },
        aiTarget: () => ({ ...t.pos }), aiScore: () => 2,
      }))
      if (b.alive().some(o => o.ownerId === u.id && o.flags.emblem)) out.push(action({
        key: 'emblems_delete', name: 'Delete Dimensional Emblems', activation: 'free', target: 'none', text: 'Remove your dimensional emblems.',
        run: (bt, me) => { for (const o of bt.alive().filter(x => x.ownerId === me.id && x.flags.emblem)) bt.removeUnit(o, 'is deleted') },
        aiScore: () => -1,
      }))
      return out
    },
    grantActions: (b, self, other) => [...b.alive().filter(o => o.ownerId === self.id && o.flags.emblem && b.adjacent(other, o)).map(o => action({
      key: `emblem_break:${o.id}`, name: 'Destroy Dimensional Emblem', activation: 'quick', target: 'none', text: 'Systems check: on a success the construct is destroyed.',
      run: (bt, me) => { if (bt.check(me, 'sys')) bt.removeUnit(o, 'is destroyed') },
      aiScore: (bt, me) => (bt.hostile(me, self) ? 1 : 0),
    })), ...(other.flags.shackledBy === self.id ? [action({
      key: `shackle_break:${self.id}`, name: 'Break Celestial Shackles', activation: 'quick', target: 'none', text: 'Systems save to end the shackles.',
      run: (bt, me) => { if (bt.save(me, 'sys', self.stats.save, 0, self)) me.flags.shackledBy = undefined },
      aiTarget: () => ({ ...other.pos }), aiScore: () => 1.5,
    })] : [])],
    onMove(b, self, mover, path) {
      if (mover.kind !== 'mech' && mover.kind !== 'npc') return
      for (const e of b.alive().filter(o => o.ownerId === self.id && o.flags.emblem)) if (path.slice(1).some(p => footprint({ pos: p, stats: mover.stats }).some(q => q.x === e.pos.x && q.y === e.pos.y))) {
        b.removeUnit(e, 'disperses')
        b.applyDamage(mover, [{ type: 'Heat', amount: 2 }], { source: self })
      }
    },
    fields: (b, u) => { const es = b.alive().filter(o => o.ownerId === u.id && o.flags.emblem); return es.length ? [{ tiles: es.map(e => e.pos), effect: 'harm' as const, label: `${u.name}'s dimensional emblem: 2 heat when passed through` }] : [] },
  },
  // ---------------- Monitor Module
  {
    id: 'ms_monitor_module', note: 'Monitor Module: guard an adjacent ally with 1d3 charges until the end of your next turn; when it is attacked next to you, Skirmish the attacker for half damage (reaction)',
    actions: () => [action({
      key: 'monitor', name: 'Monitor Module', activation: 'quick', target: 'ally', range: 1, text: 'Guard an adjacent ally with 1d3 charges.',
      run: (bt, me, t) => { const a = t as Unit; if (!bt.adjacent(me, a)) throw new Error('Must be adjacent'); me.flags.monitor = { ally: a.id, charges: bt.rng.d(3), until: bt.round + 1 } },
      aiTarget: (bt, me) => allies(bt, me).filter(a => bt.adjacent(me, a)).sort((x, y) => x.hp - y.hp)[0] ?? null,
      aiScore: (bt, me) => (hostiles(bt, me).some(h => bt.distance(me, h) <= 8) ? 2 : 0),
    })],
    afterAnyAttack(b, self, ctx) {
      const m = self.flags.monitor
      if (!m || b.round > m.until || m.charges <= 0 || ctx.target.id !== m.ally || !b.adjacent(self, ctx.target) || ctx.attacker.destroyed) return
      if (b.canSpend(self, 'reaction') !== true) return
      // a Skirmish: no Superheavy weapons
      const w = self.weapons.find(x => !x.tech && x.size !== 'Superheavy' && b.weaponReady(self, x) && b.validTarget(self, x, ctx.attacker) === true)
      if (!w) return
      if (!b.offerReaction(self, 'monitor_module', 'Monitor Module?', `${ctx.attacker.name} attacked ${ctx.target.name}. Spend a charge (${m.charges} left) and your reaction to Skirmish it with ${w.name} for half damage?`)) return
      b.spend(self, 'reaction') // through spend(): reveals Hidden, ends Ghostweave, runs onAnyAction hooks
      m.charges--
      self.flags.halfDamage = true
      try { b.weaponAttack(self, w, { targetId: ctx.attacker.id }, 'free') } finally { self.flags.halfDamage = false }
    },
  },
  // ---------------- Mesmer Charges
  {
    id: 'ms_mesmer_charges', note: 'Mesmer: Beacon (Systems save or only move toward you until the end of its next turn); Mine (Burst 2, Systems save or Immobilized)',
    actions: (b, u) => {
      const s = sys(u, 'ms_mesmer_charges')
      return [action({
        key: 'mesmer_beacon', name: 'Mesmer Beacon', activation: 'quick', target: 'enemy', range: 5, text: 'Systems save, or the target can only move toward you until the end of its next turn.',
        usable: () => usesOk(s),
        run: (bt, me, t) => { spend(s); const v = t as Unit; if (!bt.save(v, 'sys', me.stats.save, 0, me)) { v.flags.mesmerBy = me.id; v.flags.mesmerUntil = bt.round + 1; bt.say(`${v.name} is mesmerized.`) } },
        aiScore: (bt, me, t) => (t && 'id' in t && bt.distance(me, t) > 2 ? 2 : 0),
      }), action({
        key: 'mesmer_mine', name: 'Mesmer Mine', activation: 'quick', target: 'tile', range: mineRange(u), area: { shape: 'blast', size: 2 }, text: 'Plant a mine: Burst 2, Systems save or Immobilized until the end of the next turn.',
        usable: () => usesOk(s),
        run: (bt, me, t) => { bt.placeMine(me, at(t), { name: 'Mesmer Mine', radius: 2, damage: [], save: 'sys', effects: [{ do: 'status', status: 'immobilized', duration: 'next_turn_end_target' }] }, { range: mineRange(me) }); spend(s) },
      })]
    },
  },
  // ---------------- Law of Blades
  {
    id: 'ms_law_of_blades',
    note: 'Law of Blades (full tech): Predator/Prey — on a hit the target attacks a character or object you choose with a weapon you choose, as its reaction; Slave Systems — on a hit it Boosts, Stabilizes, makes an Improvised Attack, Grapples or Rams as you choose (and at whom), as its reaction',
    actions: (_b, u) => [
      techOpt(u, 'predator', 'Predator/Prey Concepts', 'On a hit, the target attacks a character or object of your choice with a weapon of your choice (as its reaction).', (bt, me, t) => {
        const opts: { label: string; w: Weapon; v: Unit }[] = []
        for (const w of t.weapons.filter(w => !w.destroyed && !w.tech && bt.weaponReady(t, w) && !bt.isAoE(bt.profile(w))))
          for (const v of bt.alive().filter(o => o !== t && o.kind !== 'drone' && bt.validTarget(t, w, o) === true)) opts.push({ label: `${w.name} → ${v.name}${bt.hostile(me, v) ? '' : ' (your side!)'}`, w, v })
        if (!opts.length) { bt.say(`  ${t.name} has nothing to attack.`); return }
        const def = Math.max(0, opts.findIndex(o => bt.hostile(me, o.v)))
        const i = bt.choose({ kind: 'predator_prey', unit: me, title: `Predator/Prey: ${t.name} attacks…`, options: opts.slice(0, 12).map(o => ({ label: o.label })), defaultIndex: Math.min(def, 11) })
        const o = opts[i]
        t.reactionsLeft = Math.max(0, t.reactionsLeft - 1)
        bt.say(`${t.name} turns its ${o.w.name} on ${o.v.name}!`, 'attack')
        bt.weaponAttack(t, o.w, { targetId: o.v.id }, 'free')
      }),
      techOpt(u, 'slave', 'Slave Systems', 'On a hit, the target Boosts, Stabilizes, makes an Improvised Attack, Grapples or Rams — you choose the action and target (as its reaction).', (bt, me, t) => {
        type Opt = { label: string; run: () => void }
        const opts: Opt[] = []
        const adj = bt.alive().filter(o => o !== t && (o.kind === 'mech' || o.kind === 'npc') && bt.adjacent(o, t))
        const boostTo = (toward: Pos, dir: 1 | -1) => () => {
          const r = bt.reachable(t, t.stats.speed)
          const best = [...r.values()].sort((x, y) => dir * (chebyshev(y.pos, toward) - chebyshev(x.pos, toward)))[0]
          if (best && (best.pos.x !== t.pos.x || best.pos.y !== t.pos.y)) bt.move(t, best.pos, { mode: 'boost' })
        }
        if (bt.canMove(t, 'boost') === true) {
          opts.push({ label: 'Boost toward you', run: boostTo(me.pos, -1) })
          const its = chars(bt).filter(o => o !== t && !bt.hostile(t, o))
          if (its.length) { const c = { x: Math.round(its.reduce((a, o) => a + o.pos.x, 0) / its.length), y: Math.round(its.reduce((a, o) => a + o.pos.y, 0) / its.length) }; opts.push({ label: 'Boost away from its allies', run: boostTo(c, 1) }) }
        }
        opts.push({ label: 'Stabilize (it cools down)', run: () => { t.heat = 0; bt.removeStatus(t, 'exposed'); bt.say(`${t.name} stabilizes.`) } })
        for (const v of adj) {
          opts.push({ label: `Improvised Attack on ${v.name}`, run: () => bt.withForcedAction(t, () => bt.improvisedAttack(t, v)) })
          opts.push({ label: `Grapple ${v.name}`, run: () => bt.withForcedAction(t, () => bt.grapple(t, v)) })
          if (v.stats.size <= t.stats.size || t.flags.muscleNet) opts.push({ label: `Ram ${v.name}`, run: () => bt.withForcedAction(t, () => bt.ram(t, v)) })
        }
        const ramAlly = opts.findIndex(o => o.label.startsWith('Ram ') && adj.some(v => o.label === `Ram ${v.name}` && !bt.hostile(t, v)))
        const i = bt.choose({ kind: 'slave_systems', unit: me, title: `Slave Systems: ${t.name} must…`, options: opts.slice(0, 12).map(o => ({ label: o.label })), defaultIndex: ramAlly >= 0 && ramAlly < 12 ? ramAlly : 0 })
        t.reactionsLeft = Math.max(0, t.reactionsLeft - 1)
        try { opts[i].run() } catch (e) { if (e instanceof PendingChoice) throw e; bt.say(`  ${t.name} can't: ${(e as Error).message}`) }
      }),
    ],
  },
  // ---------------- SISYPHUS
  {
    id: 'ms_sisyphus_class_nhp', note: 'SISYPHUS: Bend Probability stores two d20 results; until the end of your next turn, replace up to two d20 rolls within Sensors (good results for allies, bad ones for hostiles)',
    actions: () => [action({
      key: 'bend', name: 'Bend Probability', activation: 'full_tech', target: 'none', text: 'Roll 2d20 and hold them; spend them on d20 rolls within Sensors.',
      run: (bt, me) => { me.flags.bend = { vals: [bt.rng.d(20), bt.rng.d(20)], until: bt.round + 1, uses: 2 }; bt.say(`${me.name} bends probability: ${me.flags.bend.vals.join(' and ')}.`) },
      aiTarget: (_bt, me) => ({ ...me.pos }),
      aiScore: (bt, me) => (me.flags.bend ? 0 : allies(bt, me).length + 1),
    })],
    overrideD20(b, self, roller, kind) {
      const bend = self.flags.bend
      if (!bend || b.round > bend.until || bend.uses <= 0 || !bend.vals.length || b.distance(self, roller) > self.stats.sensors) return undefined
      const friendly = !b.hostile(self, roller)
      const v = friendly ? Math.max(...bend.vals) : Math.min(...bend.vals)
      if (friendly ? v < 14 : v > 7) return undefined
      bend.vals.splice(bend.vals.indexOf(v), 1)
      bend.uses--
      b.say(`  ${self.name}'s SISYPHUS sets ${roller.name}'s ${kind} roll to ${v}.`)
      return v
    },
  },
  // ---------------- Roller charges
  {
    id: 'ms_roller_directed_payload_charges', note: 'Roller Grenade: rolls along a Line 10 from you, bouncing over obstructions up to Size 1 (taller terrain stops it), detonating on the first character it passes through or beside: Agility save or 1d6+3 explosive and knocked 3 along the roll (half and no knockback on a success); Bouncing Mine: when a flyer passes over or next to it, everyone in Burst 1 saves (Systems) or takes 2d6 explosive, lands and can\'t fly until the end of its next turn (half otherwise)',
    actions: (b, u) => {
      const s = sys(u, 'ms_roller_directed_payload_charges')
      return [action({
        key: 'roller', name: 'Roller Grenade', activation: 'quick', target: 'tile', range: 10, area: { shape: 'line', size: 10 }, text: 'Rolls along a Line 10; the first character it passes saves (Agility) or takes 1d6+3 explosive and is knocked back 3.',
        usable: () => usesOk(s),
        run: (bt, me, t) => {
          spend(s)
          const line = lineTiles(bt.map, me, at(t), 10)
          const base = tileAt(bt.map, me.pos)?.h ?? 0
          for (const p of line) {
            const tile = tileAt(bt.map, p)
            if (tile && tile.kind === 'block' && tile.h - base > 1) { bt.say('  The roller grenade fetches up against terrain.'); return }
            const v = chars(bt).find(o => o !== me && footprint(o).some(q => chebyshev(q, p) <= 1))
            if (!v) continue
            bt.emit({ type: 'area', tiles: [p], kind: 'explosion' })
            // knocked along the direction of the roll
            const dir = { x: p.x + (p.x - me.pos.x) * 10, y: p.y + (p.y - me.pos.y) * 10 }
            half(bt, v, me, 'agi', '1d6+3', 'Explosive', failed => { if (failed && !v.destroyed) bt.forceMove(v, { x: 2 * v.pos.x - dir.x, y: 2 * v.pos.y - dir.y }, 3, 1) })
            return
          }
        },
      }), action({
        key: 'bouncing_mine', name: 'Bouncing Mine', activation: 'quick', target: 'tile', range: mineRange(u), text: 'Plant a mine against flyers passing over or next to it: Systems save or 2d6 explosive and grounded.',
        usable: () => usesOk(s),
        run: (bt, me, t) => { bt.placeMine(me, at(t), { name: 'Bouncing Mine', radius: 1, damage: [], trigger: 'flying', tag: 'bounce' }, { range: mineRange(me) }); spend(s) },
      })]
    },
    onMineDetonate(b, self, m) {
      if (m.tag !== 'bounce') return false
      const tiles = burstTiles(b.map, { pos: m.pos, stats: { size: 1 } } as Unit, 1)
      b.emit({ type: 'area', tiles, kind: 'explosion' })
      for (const v of unitsOnTiles(chars(b), tiles)) half(b, v, self, 'sys', '2d6', 'Explosive', failed => { if (failed && !v.destroyed) { const fl = v.flying || v.flags.landed; if (v.flying) b.land(v, 'bouncing mine'); v.flags.landed = false; if (fl) { v.flags.groundedUntil = b.round + 1; v.flags.wasFlying = true } } })
      return true
    },
    onAnyTurnEnd(b, _self, u) { if (u.flags.wasFlying && b.round > (u.flags.groundedUntil ?? 0)) { u.flying = true; u.flags.wasFlying = false } },
  },
  // ---------------- Grounding Charges
  {
    id: 'ms_grounding_charges', note: 'Grounding: Gravity Grenade (Agility save or Slowed until it spends a turn without moving); Grounding Mine (remote: Hull save or pulled to it and Prone)',
    actions: (b, u) => {
      const s = sys(u, 'ms_grounding_charges')
      const out = [action({
        key: 'gravity_grenade', name: 'Gravity Grenade', activation: 'quick', target: 'enemy', range: 5, text: 'Agility save or Slowed until it makes no voluntary movement for a turn.',
        usable: () => usesOk(s),
        run: (bt, me, t) => { spend(s); const v = t as Unit; if (!bt.save(v, 'agi', me.stats.save, 0, me)) bt.addStatus(v, 'slowed', 'until_cleared', me, { gravity: true }) },
        aiScore: (bt, _me, t) => (t && 'id' in t && !bt.has(t, 'slowed') ? 2 : 0),
      }), action({
        key: 'grounding_mine', name: 'Plant Grounding Mine', activation: 'quick', target: 'tile', range: mineRange(u), text: 'Plant a mine you detonate later (quick action).',
        usable: () => usesOk(s),
        run: (bt, me, t) => { bt.placeMine(me, at(t), { name: 'Grounding Mine', radius: 5, damage: [], trigger: 'remote', tag: 'ground' }, { range: mineRange(me) }); spend(s) },
        aiScore: () => -1,
      })]
      for (const m of b.mines.filter(x => x.ownerId === u.id && x.tag === 'ground')) out.push(action({
        key: `grounding_boom:${m.id}`, name: 'Detonate Grounding Mine', activation: 'quick', target: 'unit', range: 99, text: 'One character within 5 of the mine: Hull save or pulled as far as possible toward it and knocked Prone (flyers land).',
        usable: (bt) => (bt.mines.includes(m) ? true : 'Gone'),
        run: (bt, me, t) => {
          const v = t as Unit
          if (!v || chebyshev(v.pos, m.pos) > 5) throw new Error('Target must be within 5 of the mine')
          bt.detonateMine(m, v)
        },
        aiTarget: (bt, me) => hostiles(bt, me).filter(h => chebyshev(h.pos, m.pos) <= 5)[0] ?? null,
        aiScore: () => 3,
      }))
      return out
    },
    onMineDetonate(b, self, m, v) {
      if (m.tag !== 'ground') return false
      if (!v || v.destroyed || saveVs(b, v, 'hull', self, 'prone')) return true
      b.forceMove(v, m.pos, chebyshev(v.pos, m.pos), -1)
      if (v.flying) { b.land(v, 'grounding mine'); v.flags.landed = false }
      b.addStatus(v, 'prone', 'until_cleared', self)
      return true
    },
    onAnyTurnEnd(b, _self, u) { if (!u.flags['turn:moved']) u.statuses = u.statuses.filter(s => !s.data?.gravity) },
  },
  // ---------------- Clamp Bombs
  {
    id: 'ms_clamp_bombs', note: 'Clamp Bombs: Engineering save or bombs clamp on; at the end of its next turn they deal 1d6+3 AP explosive (half to adjacent characters) unless it moved 4+ spaces',
    actions: (b, u) => {
      const s = sys(u, 'ms_clamp_bombs')
      return [action({
        key: 'clamp', name: 'Clamp Bombs', activation: 'quick', target: 'enemy', range: u.stats.sensors, text: 'Engineering save or the bombs clamp on.',
        usable: () => usesOk(s),
        run: (bt, me, t) => {
          const v = t as Unit
          if (!v || !('id' in v) || bt.distance(me, v) > me.stats.sensors) throw new Error('Out of Sensors')
          spend(s)
          if (!bt.save(v, 'eng', me.stats.save, 0, me)) { v.flags.clampBy = me.id; v.flags.clampMoved = 0; bt.say(`Bombs clamp onto ${v.name}!`) }
        },
        aiScore: (bt, _me, t) => (t && 'id' in t && !(t as Unit).flags.clampBy ? 2.5 : 0),
      })]
    },
    onMove(_b, self, mover, path) { if (mover.flags.clampBy === self.id && mover.activeTurn) mover.flags.clampMoved = (mover.flags.clampMoved ?? 0) + path.length - 1 },
    onAnyTurnEnd(b, self, u) {
      if (u.flags.clampBy !== self.id) return
      u.flags.clampBy = undefined
      if ((u.flags.clampMoved ?? 0) >= 4) { b.say(`${u.name} shakes off the clamp bombs.`); return }
      const dmg = rollDice(b.rng, '1d6+3').total
      b.emit({ type: 'area', tiles: footprint(u), kind: 'explosion' })
      b.applyDamage(u, [{ type: 'Explosive', amount: dmg }], { source: self, ap: true })
      for (const o of chars(b)) if (o !== u && b.adjacent(o, u)) b.applyDamage(o, [{ type: 'Explosive', amount: Math.ceil(dmg / 2) }], { source: self, ap: true })
    },
  },
  // ---------------- Tesseract
  {
    id: 'ms_tesseract', note: 'Tesseract: Spread Focus (Blast 3 zero-g area for the scene) and Pinpoint Focus (lift a character: Immobilized and flying until it sinks at the end of its next turn; hostiles Engineering save, 1/scene each)',
    actions: () => [action({
      key: 'spread_focus', name: 'Spread Focus', activation: 'quick_tech', techOption: 'spread_focus', target: 'tile', range: 10, area: { shape: 'blast', size: 3 },
      text: 'A Blast 3 zero-g area within Sensors for the rest of the scene (replaces your previous one).',
      run: (bt, me, t) => {
        const p = at(t)
        if (distanceToTile(bt.map, me, p) > me.stats.sensors) throw new Error('Out of Sensors')
        const old = bt.areas.filter(a => a.kind === 'zero_g' && a.ownerId === me.id)
        bt.areas = bt.areas.filter(a => !old.includes(a))
        bt.addArea({ kind: 'zero_g', tiles: blastTiles(bt.map, p, 3), ownerId: me.id })
        for (const u of bt.alive()) bt.syncZeroG(u)
      },
      aiTarget: () => null,
    }), action({
      key: 'pinpoint', name: 'Pinpoint Focus', activation: 'quick_tech', target: 'unit', range: 10, text: 'Lift a character into the air: Immobilized and flying until the end of its next turn.',
      run: (bt, me, t) => {
        const v = t as Unit
        if (!v || !('id' in v) || bt.distance(me, v) > me.stats.sensors) throw new Error('Out of Sensors')
        if (bt.hostile(me, v)) {
          if (v.flags[`scene:tesseract:${me.id}`]) throw new Error('Already lifted this scene')
          v.flags[`scene:tesseract:${me.id}`] = true
          if (bt.save(v, 'eng', me.stats.save, 0, me)) return
        }
        // hostiles sink at the end of their next turn; willing allies choose when (at the end of any of their turns)
        v.flags.liftedUntil = bt.hostile(me, v) ? bt.round + 1 : 1e9
        v.flags.liftWasFlying = v.flying
        v.flying = true
        bt.addStatus(v, 'immobilized', bt.hostile(me, v) ? 'next_turn_end_target' : 'until_cleared', me, { lift: true })
        bt.say(`${v.name} floats into the air.`)
      },
      aiScore: (bt, me, t) => (t && 'id' in t && bt.hostile(me, t) && t.weapons.some(w => bt.isMelee(w)) ? 2 : 0),
    })],
    onAnyTurnEnd(b, self, u) {
      if (u.flags.liftedUntil == null) return
      const sink = b.round >= u.flags.liftedUntil || b.choose({ kind: 'tesseract_sink', unit: u, title: 'Pinpoint Focus: sink to the ground?', options: [{ label: 'Stay aloft' }, { label: 'Sink harmlessly' }], defaultIndex: b.hostile(self, u) ? 1 : 0 }) === 1
      if (!sink) return
      u.flying = !!u.flags.liftWasFlying; u.flags.liftedUntil = undefined
      u.statuses = u.statuses.filter(s => !(s.id === 'immobilized' && s.data?.lift))
    },
  },
  // ---------------- Blinkshield
  {
    id: 'ms_blinkshield',
    note: 'Blinkshield: a stationary Burst 4 bubble until the end of your next turn: nothing crosses its border — movement, attacks, effects or line of sight; characters straddling it when it forms save (Agility): on a success they pick the side, on a failure you do',
    actions: () => [action({
      key: 'blinkshield', name: 'Blinkshield', activation: 'full', heat: 4, target: 'none', area: { shape: 'burst', size: 4 }, text: 'Burst 4 bubble until the end of your next turn: nothing can cross its border.',
      run: (bt, me) => {
        const tiles = burstTiles(bt.map, me, 4)
        me.flags.blink = { tiles, turns: 2 }
        bt.losZones.push({ id: `blink:${me.id}`, tiles: tiles.map(p => `${p.x},${p.y}`), untilRound: 9999, mode: 'border' })
        bt.invalidateTerrain()
        for (const u of chars(bt)) if (onTiles(u, tiles) && !fully(u, tiles)) settleStraddler(bt, me, u, tiles)
      },
      aiTarget: (_bt, me) => ({ ...me.pos }),
      aiScore: (bt, me) => (me.heat + 4 < me.stats.heatcap && hostiles(bt, me).filter(h => bt.distance(me, h) > 4 && bt.distance(me, h) <= 12).length >= 2 ? 2.5 : 0),
    })],
    onTurnEnd(b, self) { if (self.flags.blink && --self.flags.blink.turns <= 0) { delete self.flags.blink; b.losZones = b.losZones.filter(z => z.id !== `blink:${self.id}`); b.invalidateTerrain() } },
    beforeAnyAttack(b, self, ctx) {
      const f = self.flags.blink
      if (!f) return
      if (onTiles(ctx.attacker, f.tiles) !== onTiles(ctx.target, f.tiles)) { ctx.cancelled = true; b.say('  The attack cannot cross the Blinkshield.') }
    },
    validateAnyMove(b, self, mover, dest) {
      const f = self.flags.blink
      if (!f) return true
      const inNow = onTiles(mover, f.tiles), inThen = footprint({ pos: dest, stats: mover.stats }).some(p => f.tiles.some((t: Pos) => t.x === p.x && t.y === p.y))
      return inNow === inThen ? true : 'The Blinkshield cannot be crossed'
    },
    validateMove(b, self, dest) {
      const f = self.flags.blink
      if (!f) return true
      const inThen = footprint({ pos: dest, stats: self.stats }).some(p => f.tiles.some((t: Pos) => t.x === p.x && t.y === p.y))
      return onTiles(self, f.tiles) === inThen ? true : 'The Blinkshield cannot be crossed'
    },
    blockForcedStep(b, self, mover, from, to) {
      const f = self.flags.blink
      if (!f) return false
      const inside = (p: Pos) => footprint({ pos: p, stats: mover.stats }).some(q => f.tiles.some((t: Pos) => t.x === q.x && t.y === q.y))
      return inside(from) !== inside(to)
    },
    fields: (b, u) => (u.flags.blink ? [{ tiles: u.flags.blink.tiles, effect: 'barrier' as const, label: `${u.name}'s Blinkshield: nothing crosses its border` }] : []),
  },
  // ---------------- Flash Anchor
  {
    id: 'ms_flash_anchor', note: 'Flash Anchor (reaction, 2 heat): stop yourself or an ally in Sensors and line of sight being pushed, pulled or knocked Prone; immune to those until the start of their next turn',
    preventAnyMove(b, self, target, src) {
      if (b.hostile(self, target) || (src && !b.hostile(self, src)) || b.distance(self, target) > self.stats.sensors || !b.los(self, target)) return false
      if (target.flags.anchored) return true
      return anchor(b, self, target)
    },
    blockAnyStatus(b, self, target, status, src) {
      if (status !== 'prone' || b.hostile(self, target) || (src && !b.hostile(self, src)) || b.distance(self, target) > self.stats.sensors || !b.los(self, target)) return false
      if (target.flags.anchored) return true
      return anchor(b, self, target)
    },
    canBeMoved: (b, self, src) => !(src && b.hostile(self, src) && (self.flags.anchored || anchor(b, self, self))),
    blockStatus: (b, self, st, src) => st === 'prone' && !!src && b.hostile(self, src) && (self.flags.anchored || anchor(b, self, self)),
    // the Immunity lasts until the start of the protected character's next turn
    onTurnStart(_b, self) { delete self.flags.anchored },
    onAnyTurnStart(_b, _self, u) { delete u.flags.anchored },
  },
  // ---------------- Hardlight Defense System
  {
    id: 'ms_hardlight_defense_system',
    note: 'Hardlight Defense: a Burst 3 shield for the scene (you are Immobilized; deactivate as a protocol): it blocks line of sight both ways and attacks or effects can\'t pass it (characters straddling it are exempt); crossing it the first time in a round, or starting a turn on the boundary, deals 2 burn',
    actions: (_b, u) => [u.flags.hardlight
      ? action({ key: 'hardlight_off', name: 'Deactivate Hardlight Defense', activation: 'protocol', target: 'none', text: 'Drop the shield.', run: (bt, me) => { me.flags.hardlight = undefined; me.statuses = me.statuses.filter(s => !s.data?.hardlight); bt.losZones = bt.losZones.filter(z => z.id !== `hardlight:${me.id}`); bt.invalidateTerrain() } })
      : action({
        key: 'hardlight', name: 'Hardlight Defense System', activation: 'full', heat: 2, target: 'none', area: { shape: 'burst', size: 3 }, text: 'Raise a Burst 3 hardlight shield; you are Immobilized.',
        run: (bt, me) => {
          me.flags.hardlight = burstTiles(bt.map, me, 3)
          bt.addStatus(me, 'immobilized', 'until_cleared', me, { hardlight: true })
          bt.losZones.push({ id: `hardlight:${me.id}`, tiles: me.flags.hardlight.map((p: Pos) => `${p.x},${p.y}`), untilRound: 9999, mode: 'border', partialSeesThrough: true })
          bt.invalidateTerrain()
        },
        aiTarget: (_bt, me) => ({ ...me.pos }),
        aiScore: (bt, me) => (me.heat + 2 < me.stats.heatcap && hostiles(bt, me).filter(h => bt.distance(me, h) > 3 && bt.distance(me, h) <= 12).length >= 2 && allies(bt, me).some(a => bt.distance(me, a) <= 3) ? 2.5 : 0),
      })],
    beforeAnyAttack(b, self, ctx) {
      const tiles = self.flags.hardlight as Pos[] | undefined
      if (!tiles) return
      const partial = (u: Unit) => onTiles(u, tiles) && !fully(u, tiles)
      if (partial(ctx.attacker) || partial(ctx.target)) return
      if (onTiles(ctx.attacker, tiles) !== onTiles(ctx.target, tiles)) { ctx.cancelled = true; b.say('  The hardlight shield blocks the attack.') }
    },
    onMove(b, self, mover, path) {
      const tiles = self.flags.hardlight as Pos[] | undefined
      if (!tiles || path.length < 2) return
      const inside = (p: Pos) => footprint({ pos: p, stats: mover.stats }).some(q => tiles.some(t => t.x === q.x && t.y === q.y))
      if (path.some((p, i) => i > 0 && inside(p) !== inside(path[i - 1])) && oncePerRound(mover, `hardlight:${self.id}`)) b.applyDamage(mover, [{ type: 'Burn', amount: 2 }], { source: self })
    },
    onAnyTurnStart(b, self, u) {
      const tiles = self.flags.hardlight as Pos[] | undefined
      if (tiles && onTiles(u, tiles) && !fully(u, tiles) && oncePerRound(u, `hardlight:${self.id}`)) b.applyDamage(u, [{ type: 'Burn', amount: 2 }], { source: self })
    },
    fields: (_b, u) => (u.flags.hardlight ? [{ tiles: u.flags.hardlight, effect: 'barrier' as const, label: `${u.name}'s hardlight shield: blocks line of sight and attacks; crossing deals 2 burn` }] : []),
  },
  // ---------------- NOAH
  {
    id: 'ms_noah_class_nhp', note: "NOAH Diluvian Ark: until the end of your next turn you are Slowed; ranged attacks on you or adjacent allies: 1 heat and a d6, on 4+ another heat and it misses; attackers who miss take 4 kinetic",
    actions: () => [action({
      key: 'noah', name: 'Diluvian Ark', activation: 'quick', target: 'none', text: 'Protect yourself and adjacent allies from ranged attacks until the end of your next turn.',
      run: (bt, me) => { me.flags.ark = nextTurnEnds(me); bt.addStatus(me, 'slowed', 'next_turn_end_target', me) },
      aiTarget: (_bt, me) => ({ ...me.pos }),
      aiScore: (bt, me) => (me.heat + 3 < me.stats.heatcap && hostiles(bt, me).some(h => bt.distance(me, h) <= 15) ? 2 : 0),
    })],
    beforeAnyAttack(b, self, ctx) {
      if (!self.flags.ark || ctx.melee || ctx.tech || b.has(ctx.target, 'invisible') || b.hostile(self, ctx.target)) return
      if (ctx.target !== self && !b.adjacent(self, ctx.target)) return
      if (b.canSpend(self, 'reaction') !== true || self.heat + 2 > self.stats.heatcap) return
      b.spend(self, 'reaction') // through spend(): reveals Hidden, ends Ghostweave, runs onAnyAction hooks
      b.addHeat(self, 1)
      const r = b.rng.d(6)
      if (r >= 4) { b.addHeat(self, 1); ctx.cancelled = true; b.say(`  The Diluvian Ark deflects the shot (${r}).`) }
    },
    afterAnyAttack(b, self, ctx) {
      if (!self.flags.ark || ctx.melee || ctx.tech || ctx.hit || b.hostile(self, ctx.target) || ctx.attacker.destroyed) return
      if (ctx.target !== self && !b.adjacent(self, ctx.target)) return
      b.applyDamage(ctx.attacker, [{ type: 'Kinetic', amount: 4 }], { source: self })
    },
    // until the end of your next turn
    onTurnEnd(_b, self) { if (self.flags.ark && --self.flags.ark <= 0) delete self.flags.ark },
  },
  // ---------------- Ammo Cases
  ammoScript('ms_walking_armory_1'),
  ammoScript('ms_walking_armory_2'),
  ammoScript('ms_walking_armory_3'),
]

function anchor(b: Battle, self: Unit, target: Unit): boolean {
  if (b.canSpend(self, 'reaction', 'flash_anchor') !== true || self.heat + 2 > self.stats.heatcap) return false
  b.spend(self, 'reaction', 'flash_anchor')
  b.addHeat(self, 2)
  target.flags.anchored = true
  b.say(`${self.name}'s Flash Anchor holds ${target.name} in place.`)
  return true
}

function swarmHit(b: Battle, self: Unit, u: Unit) {
  if (!self.flags.swarm || !b.hostile(self, u) || (u.kind !== 'mech' && u.kind !== 'npc') || b.distance(self, u) > 1 || !oncePerRound(u, `swarm:${self.id}`)) return
  if (!b.save(u, 'sys', self.stats.save, 0, self)) b.applyDamage(u, [{ type: 'Kinetic', amount: self.flags.swarm }], { source: self })
}

function dismount(b: Battle, mule: Unit, r: Unit, prone: boolean) {
  r.flags.ridingOn = undefined
  r.flags.flat = false
  const p = tileNear(b, mule, mule.pos, 2)
  if (p) { const from = r.pos; r.pos = p; b.emit({ type: 'move', unitId: r.id, path: [from, p] }) }
  if (prone) b.addStatus(r, 'prone', 'until_cleared')
}

/** An Invade option (tech attack; on a hit 2 heat plus the effect). */
function invadeOpt(u: Unit, key: string, name: string, text: string, onHit: (b: Battle, self: Unit, t: Unit) => void): CustomAction {
  return action({
    key: `invade:${key}`, name: `Invade: ${name}`, activation: 'quick_tech', techOption: 'invade', target: 'unit', range: u.stats.sensors, text,
    run: (bt, me, t) => {
      const target = t as Unit
      const v = bt.techTargetValid(me, target, 'invade')
      if (v !== true) throw new Error(v)
      const ctx = bt.invadeRoll(me, target, name)
      if (ctx.hit) { if (bt.hostile(me, target)) bt.applyDamage(target, [{ type: 'Heat', amount: 2 }], { source: me, attack: ctx }); if (!target.destroyed) onHit(bt, me, target) }
    },
    aiScore: () => 3,
  })
}
/** A Full Tech option: tech attack, effect on a hit. */
function techOpt(u: Unit, key: string, name: string, text: string, onHit: (b: Battle, self: Unit, t: Unit) => void): CustomAction {
  return action({
    key: `tech:${key}`, name, activation: 'full_tech', target: 'enemy', range: u.stats.sensors, text,
    run: (bt, me, t) => {
      const target = t as Unit
      const v = bt.techTargetValid(me, target)
      if (v !== true) throw new Error(v)
      const ctx: AttackCtx = bt.techAttackRoll(me, target, name)
      if (ctx.hit && !target.destroyed) onHit(bt, me, target)
    },
    aiScore: () => 3,
  })
}

registerScripts(scripts)
