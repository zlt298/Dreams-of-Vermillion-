// Pilot talents (`<talentId>:<rank>`). Reactions that need a player decision are resolved with a
// sensible automatic policy (documented per script) so the engine stays non-blocking.
import { burstTiles, chebyshev, tileAt, unitsOnTiles } from '../../grid'
import { isWeaponType } from '../../stats'
import { averageDice, rollDice } from '../../rng'
import type { Pos, Unit, Weapon } from '../../types'
import type { Battle } from '../../battle'
import { registerScripts, type AttackCtx, type CustomAction } from '../registry'
import { bondmate, setBond } from './bond'

const once = (u: Unit, key: string, scope: 'round' | 'turn' | 'scene' = 'round'): boolean => {
  const k = `${scope}:${key}`
  if (u.flags[k]) return false
  u.flags[k] = true
  return true
}
const isRangedWeapon = (b: Battle, w?: Weapon) => !!w && !b.isMelee(w) && !w.tech
const heavyMelee = (b: Battle, w?: Weapon) => !!w && b.isMelee(w) && (w.size === 'Heavy' || w.size === 'Superheavy')
const action = (a: Omit<CustomAction, 'usable'> & { usable?: CustomAction['usable'] }): CustomAction => ({ usable: () => true, ...a })
const acc = (ctx: AttackCtx, n: number, why: string) => { ctx.accuracy += n; ctx.reasons.push(`${why} +${n}`) }
const chars = (b: Battle) => b.alive().filter(o => o.kind === 'mech' || o.kind === 'npc')
const nearestHostileDist = (b: Battle, u: Unit, p: Pos) => Math.min(99, ...chars(b).filter(h => b.hostile(u, h)).map(h => chebyshev(h.pos, p)))
const tileFree = (b: Battle, u: Unit, p: Pos) => b.passable(u, p, new Set([u.id])) === 'ok' && !b.endBlocked(u, p)

/**
 * The weapon a talent's Overwatch uses against `target` (Exemplar 2, Tactician 3): every weapon has Threat 1 unless it
 * says otherwise (core rules glossary), so a ranged gun can Overwatch an adjacent target too. Area and Ordnance
 * weapons can't Overwatch.
 */
export function overwatchWeapon(b: Battle, u: Unit, target: Unit): Weapon | null {
  let best: Weapon | null = null, bestDmg = -1
  for (const w of u.weapons) {
    if (w.tech || !b.weaponReady(u, w) || b.weaponUsable(u, w, false) !== true) continue
    const pr = b.profile(w)
    if (b.isAoE(pr) || pr.tags.some(t => t.id === 'tg_ordnance')) continue
    if (b.distance(u, target) > Math.max(1, b.weaponThreat(u, w)) || b.validTarget(u, w, target) !== true) continue
    const avg = pr.damage.reduce((a, d) => a + averageDice(d.val), 0)
    if (avg > bestDmg) { best = w; bestDmg = avg }
  }
  return best
}

/**
 * A short reaction move (Ace 1 Acrobatics, Skirmisher 2 Lockbreaker after Overwatch): the unit picks "away from
 * hostiles", "into cover" or "stay". Returns true if it moved. `ignoreEngagement` moves provoke nothing.
 */
function shortMove(b: Battle, u: Unit, spaces: number, kind: string, title: string, o: { ignoreEngagement?: boolean } = {}): boolean {
  if (u.destroyed || b.has(u, 'immobilized') || b.has(u, 'stunned') || b.has(u, 'grappled')) return false
  const spots = [...b.reachable(u, spaces, { ignoreEngagement: o.ignoreEngagement }).values()].filter(n => n.cost > 0 && !b.endBlocked(u, n.pos))
  if (!spots.length) return false
  const away = spots.reduce((x, y) => (nearestHostileDist(b, u, y.pos) > nearestHostileDist(b, u, x.pos) ? y : x))
  const nextToCover = (p: Pos) => [[0, 1], [1, 0], [0, -1], [-1, 0]].some(([dx, dy]) => tileAt(b.map, { x: p.x + dx, y: p.y + dy })?.kind === 'block')
    || b.alive().some(c => c.flags.isCover && chebyshev(c.pos, p) <= 1)
  const cover = spots.filter(n => nextToCover(n.pos)).sort((x, y) => nearestHostileDist(b, u, y.pos) - nearestHostileDist(b, u, x.pos))[0]
  const opts = [{ label: 'Away from hostiles', hint: `(${away.pos.x},${away.pos.y})`, to: away.pos as Pos | null }, ...(cover ? [{ label: 'Into cover', hint: `(${cover.pos.x},${cover.pos.y})`, to: cover.pos as Pos | null }] : []), { label: 'Stay', hint: '', to: null as Pos | null }]
  const i = b.choose({ kind, unit: u, title, options: opts.map(x => ({ label: x.label, hint: x.hint })), defaultIndex: cover ? 1 : 0 })
  const to = opts[i].to
  if (!to) return false
  const p = b.pathTo(u, to, spaces, { ignoreEngagement: o.ignoreEngagement })
  if (!p) return false
  if (o.ignoreEngagement) u.flags['turn:disengaged'] = true
  else b.triggerOverwatch(u) // a normal move provokes Overwatch at its start
  try { if (!u.destroyed) b.moveAlong(u, p.path) } finally { if (o.ignoreEngagement) delete u.flags['turn:disengaged'] }
  return true
}

/**
 * Offer a free-action Ram or Grapple against `t` (Duelist 3 Unstoppable, Titanomachy Mesh). `pay` runs once the
 * unit commits. The Ram or Grapple is the normal action (attack roll, Size limit), taken without an action.
 */
export function freeRamOrGrapple(b: Battle, u: Unit, t: Unit, kind: string, title: string, pay: () => void, aiDefault = true): boolean {
  if (u.destroyed || t.destroyed || !b.adjacent(u, t) || b.meleeTargetValid(u, t) !== true) return false
  const canRam = t.stats.size <= u.stats.size || !!u.flags.muscleNet
  const opts = [...(canRam ? [{ label: `Ram ${t.name}`, hint: 'knock Prone and back 1', k: 'ram' }] : []), { label: `Grapple ${t.name}`, hint: '', k: 'grapple' }, { label: 'No', hint: '', k: '' }]
  // the AI rams a target it can (Prone is worth +1 Accuracy to every attack on it), unless it is already Prone
  const def = !aiDefault ? opts.length - 1 : canRam && !b.has(t, 'prone') ? 0 : b.has(t, 'grappled') ? opts.length - 1 : opts.findIndex(o => o.k === 'grapple')
  const i = b.choose({ kind, unit: u, title, options: opts.map(o => ({ label: o.label, hint: o.hint })), defaultIndex: def })
  const k = opts[i].k
  if (!k) return false
  pay()
  b.withForcedAction(u, () => (k === 'ram' ? b.ram(u, t) : b.grapple(u, t)))
  return true
}

/** One SAFE_CRACKER Invade option (Hacker 2): a tech attack; on a hit, 2 heat and the option's effect. */
function safeCracker(u: Unit, key: string, name: string, text: string, onHit: (b: Battle, self: Unit, t: Unit) => void, ai: number): CustomAction {
  return action({
    key: `safecracker:${key}`, name: `Invade: ${name}`, activation: 'quick_tech', techOption: 'invade', target: 'enemy', range: u.stats.sensors, text,
    run: (bt, self, t) => {
      const target = t as Unit
      const v = bt.techTargetValid(self, target, 'invade'); if (v !== true) throw new Error(v)
      if (target === self) throw new Error('Cannot invade yourself')
      const ctx = bt.invadeRoll(self, target, `INVADE: ${name}`)
      if (!ctx.hit) return
      if (bt.hostile(self, target)) bt.applyDamage(target, [{ type: 'Heat', amount: 2 }], { source: self, attack: ctx })
      if (!target.destroyed) onHit(bt, self, target)
    },
    aiScore: (_bt, _self, t) => {
      if (!t || !('id' in t)) return 0
      const x = t as Unit
      if (key === 'hack_slash') return x.stats.techAttack > 0 && !x.flags.hackSlash ? ai : 0
      if (key === 'life_support') return x.flags.lifesupportdown ? 0 : ai
      return ai
    },
  })
}

/** Infiltrator 2 Ambush: characters reeling from your ambush have no reactions (re-applied after every refill). */
function ambushHold(b: Battle, self: Unit) {
  for (const o of b.units) if (o.flags.ambushedBy === self.id) o.reactionsLeft = 0
}

/** Siege Specialist 2: push yourself 1 space in a direction of your choice (default: away from the target). */
function selfPush(b: Battle, u: Unit, target: Unit) {
  if (u.destroyed) return
  const dirs: [string, number, number][] = [['N', 0, -1], ['NE', 1, -1], ['E', 1, 0], ['SE', 1, 1], ['S', 0, 1], ['SW', -1, 1], ['W', -1, 0], ['NW', -1, -1]]
  const free = dirs.filter(([, dx, dy]) => { const p = { x: u.pos.x + dx, y: u.pos.y + dy }; return tileFree(b, u, p) && (u.flying || (tileAt(b.map, p)?.h ?? 99) - (tileAt(b.map, u.pos)?.h ?? 0) <= 1) })
  if (!free.length) { b.say(`  ${u.name} has nowhere to be pushed.`); return }
  const far = (d: [string, number, number]) => chebyshev({ x: u.pos.x + d[1], y: u.pos.y + d[2] }, target.pos)
  const best = free.reduce((x, y) => (far(y) > far(x) ? y : x))
  const i = b.choose({ kind: 'impact_push', unit: u, title: 'Impact: you are pushed 1 space', options: free.map(d => ({ label: d[0] })), defaultIndex: free.indexOf(best) })
  const [, dx, dy] = free[i]
  b.forceMove(u, { x: u.pos.x - dx, y: u.pos.y - dy }, 1, 1)
}

registerScripts([
  // ---------------- Ace
  {
    id: 't_ace:1', note: 'Acrobatics: while flying, +1 Accuracy on Agility checks and saves; when an attack misses you, you may fly up to 2 spaces as a reaction',
    init: u => { u.bonuses.push({ id: 'agility', accuracy: 1, condition: '{flying}' }) },
    afterAttack(b, self, ctx, role) {
      if (role !== 'target' || ctx.hit || !self.flying || self.destroyed || ctx.target !== self || b.canSpend(self, 'reaction', 'acrobatics') !== true) return
      if (!b.offerReaction(self, 'acrobatics', 'Acrobatics?', `${ctx.attacker.name}'s attack missed. Fly up to 2 spaces as a reaction?`)) return
      b.spend(self, 'reaction', 'acrobatics')
      b.say(`${self.name} flips clear (Acrobatics).`)
      shortMove(b, self, 2, 'acrobatics_move', 'Acrobatics: fly up to 2 spaces')
    },
  },
  {
    id: 't_ace:2', note: 'Afterburners: when you Boost while flying, you may move an extra 1d6 spaces and take half that (rounded up) as heat',
    onAnyMovementAction(b, self, mover, kind) {
      if (mover !== self || kind !== 'boost' || !self.flying) return
      // worst case 3 heat: the AI declines when that could overheat it
      const safe = self.heat + 3 < self.stats.heatcap
      if (b.choose({ kind: 'afterburners', unit: self, title: 'Afterburners?', text: 'Move an extra 1d6 spaces and take half that as heat?', options: [{ label: 'Yes (+1d6 move)' }, { label: 'No' }], defaultIndex: safe ? 0 : 1 }) !== 0) return
      const r = b.rng.d(6)
      self.moveLeft += r
      b.addHeat(self, Math.ceil(r / 2))
      b.say(`  Afterburners: +${r} move.`)
    },
  },
  // ---------------- Bonded
  {
    id: 't_bonded:1', note: "I'm Your Huckleberry: choose a Bondmate (kept for the run); while you're adjacent, both of you gain +1 Accuracy on mech skill checks and saves (+2 if both of you have Bonded)",
    actions: (b, u) => (u.flags.bondmatePilot || (u.flags.bondmate && b.unit(u.flags.bondmate)) ? [] : [action({
      key: 'bondmate', name: 'Choose Bondmate', activation: 'free', target: 'ally', range: 99, text: 'Choose your Bondmate (another pilot). It stays your Bondmate for the run.',
      run: (bt, self, t) => { const m = t as Unit; if (!m || m === self || m.kind !== 'mech' || bt.hostile(self, m)) throw new Error('Choose an allied mech'); setBond(self, m); bt.say(`${self.name} bonds with ${m.name}.`) },
      aiScore: () => -1,
    })]),
    checkAccuracy(b, self, u, kind) {
      if (kind !== 'check' && kind !== 'save') return 0
      const mate = bondmate(b, self)
      if (!mate || !b.adjacent(self, mate)) return 0
      return u === self || u === mate ? 1 : 0
    },
  },
  // ---------------- Brawler
  {
    id: 't_brawler:1', note: 'Hold and Lock',
    beforeAttack(b, self, ctx, role) {
      if (role === 'attacker' && ctx.melee && ctx.target.statuses.some(s => s.id === 'grappled' && s.data?.by === self.id)) acc(ctx, 1, 'Hold and Lock')
    },
  },
  { id: 't_brawler:2', note: 'Sledgehammer via bonuses (2d6+2, knockback 2 on improvised)' },
  {
    id: 't_brawler:3', note: 'Knockout Blow (brawler die)',
    afterAttack(b, self, ctx, role) {
      if (role === 'attacker' && ['ram', 'grapple', 'improvised'].includes(ctx.mode)) self.flags.brawlerDie = Math.max(1, (self.flags.brawlerDie ?? 6) - 1)
    },
    actions: (b, u) => [action({
      key: 'knockout', name: 'Knockout Blow', activation: 'full', target: 'enemy', range: 1,
      text: 'Brawler die at 1: an adjacent character must pass a Hull save or take 2d6+2 kinetic and be Stunned until the end of its next turn. (Resets the die to 6.)',
      usable: (bt, self) => ((self.flags.brawlerDie ?? 6) <= 1 ? true : `Brawler die ${self.flags.brawlerDie ?? 6}`),
      run: (bt, self, t) => {
        const target = t as Unit
        if (!bt.adjacent(self, target)) throw new Error('Must be adjacent')
        self.flags.brawlerDie = 6
        if (bt.save(target, 'hull', self.stats.save, 0, self)) return
        bt.applyDamage(target, [{ type: 'Kinetic', amount: rollDice(bt.rng, '2d6+2').total }], { source: self })
        if (!target.destroyed) bt.addStatus(target, 'stunned', 'next_turn_end_target', self)
      },
    })],
  },
  // ---------------- Brutal
  {
    id: 't_brutal:1', note: 'Predator: a natural 20 that crits deals maximum damage and bonus damage',
    afterAnyRoll(b, self, ctx) { if (ctx.attacker === self && ctx.crit && ctx.roll === 20) { ctx.maxDamage = true; ctx.reasons.push('Predator: maximum damage') } },
  },
  {
    id: 't_brutal:2', note: 'Cull the Herd',
    afterAttack(b, self, ctx, role) { if (role === 'attacker' && ctx.crit && !ctx.target.destroyed) b.forceMove(ctx.target, self, 1, 1) },
  },
  {
    id: 't_brutal:3', note: 'Relentless',
    beforeAttack(b, self, ctx, role) { if (role === 'attacker' && self.flags.relentless) acc(ctx, self.flags.relentless, 'Relentless') },
    afterAttack(b, self, ctx, role) { if (role === 'attacker') self.flags.relentless = ctx.hit ? 0 : (self.flags.relentless ?? 0) + 1 },
  },
  // ---------------- Crack Shot
  {
    id: 't_crack_shot:1', note: 'Stable, Steady',
    actions: (b, u) => [action({
      key: 'steady', name: 'Steady Aim', activation: 'protocol', target: 'none', text: 'Immobilized until your next turn; +1 accuracy with Rifles.',
      run: (bt, self) => { self.flags.steady = bt.round; bt.addStatus(self, 'immobilized', 'start_of_next_turn_target', self) },
    })],
    beforeAttack(b, self, ctx, role) { if (role === 'attacker' && isWeaponType(ctx.weapon, 'Rifle') && b.has(self, 'immobilized') && self.flags.steady) acc(ctx, 1, 'Steady') },
    onTurnStart: (b, u) => { delete u.flags.steady },
  },
  {
    id: 't_crack_shot:2', note: 'Zero In: 1/round, while steadying your aim and making a ranged Rifle attack, you may aim for a weak point: +1 Difficulty, and +1d6 bonus damage (in the same damage roll) on a critical hit',
    beforeAttack(b, self, ctx, role) {
      if (role !== 'attacker' || !ctx.ranged || ctx.tech || !isWeaponType(ctx.weapon, 'Rifle') || !self.flags.steady || self.flags['round:zeroin']) return
      // the AI aims for the weak point only when the shot already has Accuracy to spare
      const net = ctx.accuracy - ctx.difficulty
      if (b.choose({ kind: 'zero_in', unit: self, title: 'Zero In?', text: '+1 Difficulty on this attack; +1d6 bonus damage on a critical hit.', options: [{ label: 'Aim for a weak point' }, { label: 'Normal shot' }], defaultIndex: net > 0 ? 0 : 1 }) !== 0) return
      self.flags['round:zeroin'] = true
      ctx.difficulty++
      ctx.reasons.push('Zero In -1')
    },
    afterAnyRoll(b, self, ctx) {
      if (ctx.attacker !== self || !ctx.reasons.includes('Zero In -1') || ctx.reasons.includes('Zero In +1d6')) return
      if (ctx.crit) { ctx.bonusDamage.push({ type: ctx.profile?.damage[0]?.type ?? 'Kinetic', val: '1d6' }); ctx.reasons.push('Zero In +1d6') }
    },
  },
  {
    id: 't_crack_shot:3', note: 'Watch This: 1/round, a Rifle crit while steadying your aim — the target saves (Hull) or you pick Headshot (line of sight to adjacent spaces only), Leg Shot (Immobilized) until the end of its next turn, or Body Shot (Prone)',
    afterAttack(b, self, ctx, role) {
      if (role !== 'attacker' || !ctx.crit || !isWeaponType(ctx.weapon, 'Rifle') || !self.flags.steady || ctx.target.destroyed || !once(self, 'watchthis')) return
      const t = ctx.target
      if (b.save(t, 'hull', self.stats.save, 0, self)) return
      const i = b.choose({ kind: 'watch_this', unit: self, title: 'Watch This!', text: `${t.name} failed its save. Choose the shot:`, options: [{ label: 'Headshot', hint: 'line of sight to adjacent spaces only until the end of its next turn' }, { label: 'Leg shot', hint: 'Immobilized until the end of its next turn' }, { label: 'Body shot', hint: 'knocked Prone' }], defaultIndex: b.has(t, 'prone') ? 1 : 2 })
      if (i === 0) { t.flags.blindUntil = b.round + 1; b.say(`  Headshot: ${t.name} is blinded.`, 'status') }
      else if (i === 1) b.addStatus(t, 'immobilized', 'next_turn_end_target', self)
      else b.addStatus(t, 'prone', 'until_cleared', self)
    },
  },
  // ---------------- Centimane
  {
    id: 't_centimane:1', note: 'Ten Thousand Teeth',
    afterAttack(b, self, ctx, role) {
      if (self.talents.some(t => t.id === 't_centimane' && t.rank >= 3)) return // replaced by Tidal Suppression
      if (role !== 'attacker' || !ctx.crit || ctx.weapon?.type !== 'Nexus' || ctx.target.destroyed || !once(self, 'teeth')) return
      if (!b.save(ctx.target, 'sys', self.stats.save, 0, self)) { b.addStatus(ctx.target, 'impaired', 'next_turn_end_target', self); b.addStatus(ctx.target, 'slowed', 'next_turn_end_target', self) }
    },
  },
  {
    id: 't_centimane:2', note: 'Expose Weakness: when you consume Lock On with a Nexus or Drone attack (yours or one of your drones\') and crit, the target is Shredded until the start of your next turn',
    afterAnyAttack(b, self, ctx) {
      if (!ctx.lockOnConsumed || !ctx.crit || ctx.target.destroyed) return
      const mine = ctx.attacker === self && isWeaponType(ctx.weapon, 'Nexus')
      const drone = ctx.attacker.kind === 'drone' && ctx.attacker.ownerId === self.id
      if (!mine && !drone) return
      b.addStatus(ctx.target, 'shredded', 'start_of_next_turn_target', self)
    },
  },
  // ---------------- Combined Arms
  {
    id: 't_combined_arms:1', note: 'Shield of Blades',
    adjustCover: (b, self, attacker, target, c) => (c === 'none' && b.isEngaged(self) && (target === self || (!b.hostile(self, target) && b.adjacent(self, target))) ? 'soft' : c),
  },
  {
    id: 't_combined_arms:2', note: 'CQB-Trained',
    beforeAttack(b, self, ctx, role) {
      if (role === 'attacker' && ctx.reasons.includes('Engaged -1')) { ctx.difficulty--; ctx.reasons.push('CQB-Trained') }
    },
  },
  {
    id: 't_combined_arms:3', note: 'Storm of Violence',
    beforeAttack(b, self, ctx, role) {
      if (role !== 'attacker') return
      const key = ctx.melee ? `sov:melee:${ctx.target.id}` : `sov:ranged:${ctx.target.id}`
      if (self.flags[key]) { acc(ctx, 1, 'Storm of Violence'); delete self.flags[key] }
    },
    afterAttack(b, self, ctx, role) {
      if (role === 'attacker' && ctx.hit && !ctx.tech) self.flags[ctx.melee ? `sov:ranged:${ctx.target.id}` : `sov:melee:${ctx.target.id}`] = true
    },
  },
  // ---------------- Duelist
  {
    id: 't_duelist:1', note: 'Partisan',
    beforeAttack(b, self, ctx, role) {
      if (role === 'attacker' && self.activeTurn && ctx.melee && ctx.weapon?.size === 'Main' && once(self, 'partisan', 'turn')) acc(ctx, 1, 'Partisan')
    },
  },
  {
    id: 't_duelist:2', note: 'Blademaster: 1/round a Main melee hit gives a Blademaster die (max 3, for the scene); spend them to Parry (reaction vs a melee hit: Resistance to its damage, heat and burn), Deflect (reaction vs a ranged hit: roll any number, a 5+ gives that Resistance), Feint (free: ignore an adjacent character\'s engagement and reactions until your next turn) or Trip (quick: adjacent Agility save or Prone; you may pass through it this turn)',
    afterAttack(b, self, ctx, role) {
      if (role === 'attacker' && ctx.hit && ctx.melee && ctx.weapon?.size === 'Main' && once(self, 'blademaster')) { self.flags.bladeDice = Math.min(3, (self.flags.bladeDice ?? 0) + 1); b.say(`  ${self.name} gains a Blademaster die (${self.flags.bladeDice}).`) }
    },
    afterAnyRoll(b, self, ctx) {
      const dice = self.flags.bladeDice ?? 0
      if (ctx.target !== self || !ctx.hit || ctx.tech || dice <= 0 || ctx.resistAll || b.canSpend(self, 'reaction') !== true) return
      if (ctx.melee) {
        if (!b.offerReaction(self, 'parry', 'Blademaster: Parry?', `${ctx.attacker.name} hit you in melee. Spend a Blademaster die for Resistance to this attack? (${dice} left)`, ctx.crit || self.hp <= self.stats.hp / 2)) return
        b.spend(self, 'reaction')
        self.flags.bladeDice--
        ctx.resistAll = true
        ctx.reasons.push('Parry')
      } else {
        const opts = [{ label: "Don't deflect" }, ...Array.from({ length: dice }, (_, i) => ({ label: `Roll ${i + 1} die${i ? 's' : ''}` }))]
        const n = b.choose({ kind: 'deflect', unit: self, policy: 'reactions', title: 'Blademaster: Deflect?', text: `${ctx.attacker.name} hit you at range. Roll Blademaster dice: any 5+ gives Resistance to this attack.`, options: opts, defaultIndex: ctx.crit || self.hp <= self.stats.hp / 2 ? Math.min(dice, 2) : 0 })
        if (n <= 0) return
        b.spend(self, 'reaction')
        self.flags.bladeDice -= n
        const r = Array.from({ length: n }, () => b.rng.d(6))
        b.say(`  Deflect [${r.join(', ')}]`)
        if (r.some(x => x >= 5)) { ctx.resistAll = true; ctx.reasons.push('Deflect') }
      }
    },
    onTurnStart: (_b, self) => { delete self.flags.feint },
    actions: (b, u) => ((u.flags.bladeDice ?? 0) > 0 ? [
      action({
        key: 'feint', name: `Blademaster: Feint (${u.flags.bladeDice})`, activation: 'free', target: 'enemy', range: 1, text: 'Spend a die: ignore an adjacent character\'s engagement and reactions when moving, until your next turn.',
        run: (bt, self, t) => { const x = t as Unit; if (!x || !bt.adjacent(self, x)) throw new Error('Choose an adjacent character'); self.flags.bladeDice--; self.flags.feint = x.id; bt.say(`${self.name} feints ${x.name}.`) },
        aiScore: () => -1,
      }),
      action({
        key: 'trip', name: `Blademaster: Trip (${u.flags.bladeDice})`, activation: 'quick', target: 'enemy', range: 1, text: 'Spend a die: an adjacent character saves (Agility) or falls Prone; you may pass through its space this turn.',
        run: (bt, self, t) => { const x = t as Unit; if (!x || !bt.adjacent(self, x)) throw new Error('Choose an adjacent character'); self.flags.bladeDice--; if (!bt.save(x, 'agi', self.stats.save, 0, self)) bt.addStatus(x, 'prone', 'until_cleared', self); self.flags['turn:tripThrough'] = x.id },
        aiScore: (bt, self, t) => (t && 'id' in t && !bt.has(t as Unit, 'prone') ? 1.5 : 0),
      }),
    ] : []),
  },
  {
    id: 't_duelist:3', note: 'Unstoppable: 1/round, when you hit with a melee attack on your turn, you may spend a Blademaster Die to Ram or Grapple the target as a free action (a normal Ram or Grapple, with its own attack roll)',
    afterAttack(b, self, ctx, role) {
      if (role !== 'attacker' || !ctx.hit || !ctx.melee || ctx.tech || !self.activeTurn || (self.flags.bladeDice ?? 0) <= 0 || ctx.target.destroyed || self.flags['round:unstoppable']) return
      if (!['skirmish', 'barrage', 'free', 'secondary', 'improvised'].includes(ctx.mode) || !b.adjacent(self, ctx.target) || b.meleeTargetValid(self, ctx.target) !== true) return
      freeRamOrGrapple(b, self, ctx.target, 'unstoppable', `Unstoppable: spend a Blademaster Die (${self.flags.bladeDice} left)?`, () => {
        self.flags['round:unstoppable'] = true
        self.flags.bladeDice--
      }, false)
    },
  },
  // ---------------- Drone Commander
  {
    id: 't_drone_commander:2', note: 'Energized Swarm',
    afterAttack(b, self, ctx, role) {
      if (role !== 'attacker' || !ctx.reasons.includes('Lock On +1') || !once(self, 'swarm')) return
      const hit = new Set<Unit>()
      for (const d of b.alive().filter(d => d.ownerId === self.id && d.kind === 'drone')) for (const t of unitsOnTiles(b.alive(), burstTiles(b.map, d, 1))) if (b.hostile(self, t)) hit.add(t)
      for (const t of hit) b.applyDamage(t, [{ type: 'Energy', amount: rollDice(b.rng, '1d6').total }], { source: self })
    },
  },
  // ---------------- Executioner
  {
    id: 't_executioner:1', note: 'Backswing Cut (auto: half-damage follow-up vs another target in threat)',
    afterAttack(b, self, ctx, role) {
      if (role !== 'attacker' || !ctx.hit || !heavyMelee(b, ctx.weapon) || ctx.mode === 'secondary' || !once(self, 'backswing')) return
      const w = ctx.weapon!
      const t = b.alive().find(o => o !== ctx.target && b.hostile(self, o) && b.validTarget(self, w, o) === true)
      if (!t) return
      b.say(`${self.name}: Backswing Cut!`)
      const before = t.hp
      self.flags.halfDamage = true
      b.weaponAttack(self, w, { targetId: t.id }, 'secondary')
      delete self.flags.halfDamage
      void before
    },
  },
  {
    id: 't_executioner:2', note: 'Wide Arc Cleave',
    afterAttack(b, self, ctx, role) {
      if (role !== 'attacker' || !ctx.crit || !heavyMelee(b, ctx.weapon) || !once(self, 'cleave')) return
      const th = b.weaponThreat(self, ctx.weapon!)
      for (const o of b.alive()) if (o !== ctx.target && b.hostile(self, o) && b.distance(self, o) <= th) b.applyDamage(o, [{ type: 'Kinetic', amount: 3 }], { source: self })
    },
  },
  {
    id: 't_executioner:3', note: 'No Escape',
    afterAttack(b, self, ctx, role) {
      if (role !== 'attacker' || ctx.hit || !ctx.melee || !ctx.weapon || ctx.mode === 'secondary' || !once(self, 'noescape')) return
      const t = b.alive().find(o => o !== ctx.target && b.hostile(self, o) && b.validTarget(self, ctx.weapon!, o) === true)
      if (t) { b.say(`${self.name}: No Escape!`); b.weaponAttack(self, ctx.weapon, { targetId: t.id }, 'secondary') }
    },
  },
  // ---------------- Exemplar
  {
    id: 't_exemplar:1', note: "Honorable Challenge: the first time on your turn you attack a hostile within 3, you may give it your Exemplar's Mark (until the start of your next turn; one mark per character); Valiant Aid (reaction): when an ally misses your Mark, it may reroll (the second result stands)",
    afterAttack(b, self, ctx, role) {
      if (self.flags.duel) return // To the Death: no new marks
      if (role !== 'attacker' || !self.activeTurn || !b.hostile(self, ctx.target) || b.distance(self, ctx.target) > 3 || ctx.target.destroyed || !once(self, 'mark', 'turn')) return
      if (b.choose({ kind: 'exemplar_mark', unit: self, title: "Exemplar's Mark?", text: `Mark ${ctx.target.name}?`, options: [{ label: 'Mark it' }, { label: 'No' }], defaultIndex: 0 }) !== 0) return
      for (const o of b.units) if (o.flags.exemplarMarkBy) delete o.flags.exemplarMarkBy // one mark per character, newest wins
      ctx.target.flags.exemplarMarkBy = self.id
      b.say(`${self.name} marks ${ctx.target.name}.`)
    },
    onTurnStart(b, self) { if (!self.flags.duel) for (const o of b.units) if (o.flags.exemplarMarkBy === self.id) delete o.flags.exemplarMarkBy },
    afterAnyRoll(b, self, ctx) {
      if (ctx.hit || ctx.target.flags.exemplarMarkBy !== self.id || ctx.attacker === self || b.hostile(self, ctx.attacker) || ctx.rerolled || b.canSpend(self, 'reaction') !== true) return
      if (!b.offerReaction(self, 'valiant_aid', 'Valiant Aid?', `${ctx.attacker.name} missed your Mark. Let it reroll (the second result stands)?`)) return
      b.spend(self, 'reaction')
      ctx.rerolled = true
      b.rerollToHit(ctx)
    },
  },
  {
    id: 't_exemplar:2', note: 'Punishment: 1/round, when your Mark attacks a character within Range 3 of you (not you), it triggers your Overwatch, which resolves before its attack',
    beforeAnyAttack(b, self, ctx) {
      const a = ctx.attacker
      if (a.flags.exemplarMarkBy !== self.id || ctx.target === self || a === self || a.destroyed || self.destroyed || b.distance(self, ctx.target) > 3) return
      if (b.previewing || ctx.mode === 'secondary' || self.flags['round:punish'] || self.flags.punishBusy || b.canSpend(self, 'reaction', 'overwatch') !== true) return
      const w = overwatchWeapon(b, self, a)
      if (!w) return
      if (!b.offerReaction(self, 'punishment', 'Punishment?', `${a.name} (your Mark) is about to attack ${ctx.target.name}. Overwatch it first?`)) return
      self.flags['round:punish'] = true
      b.spend(self, 'reaction', 'overwatch') // through spend(): reveals Hidden, ends Ghostweave, runs onAnyAction hooks
      b.say(`${self.name} punishes ${a.name}!`, 'attack')
      self.flags.punishBusy = true
      try { b.weaponAttack(self, w, { targetId: a.id }, 'overwatch') } finally { delete self.flags.punishBusy }
      if (a.destroyed) ctx.cancelled = true
    },
  },
  // ---------------- Gunslinger
  {
    id: 't_gunslinger:1', note: 'Opening Argument',
    beforeAttack(b, self, ctx, role) {
      if (role === 'attacker' && self.activeTurn && ctx.weapon?.size === 'Auxiliary' && isRangedWeapon(b, ctx.weapon) && once(self, 'opening', 'turn')) acc(ctx, 1, 'Opening Argument')
    },
  },
  {
    id: 't_gunslinger:2', note: 'Return Fire (reaction, 1/round): when a character hits you with a ranged attack, you may attack it with one Auxiliary ranged weapon if it is in range',
    afterAttack(b, self, ctx, role) {
      if (role !== 'target' || !ctx.hit || ctx.attacker.destroyed || !ctx.ranged || ctx.tech || b.canSpend(self, 'reaction', 'return_fire') !== true) return
      const w = self.weapons.find(w => w.size === 'Auxiliary' && isRangedWeapon(b, w) && b.weaponReady(self, w) && b.validTarget(self, w, ctx.attacker) === true)
      if (!w) return
      if (!b.offerReaction(self, 'return_fire', 'Return Fire?', `${ctx.attacker.name} hit you. Return fire with ${w.name}?`)) return
      b.spend(self, 'reaction', 'return_fire') // through spend(): reveals Hidden, ends Ghostweave, runs onAnyAction hooks
      b.say(`${self.name} returns fire!`)
      b.weaponAttack(self, w, { targetId: ctx.attacker.id }, 'free')
    },
  },
  {
    id: 't_gunslinger:3', note: 'I Kill With My Heart (gunslinger die)',
    beforeAttack(b, self, ctx, role) {
      if (role === 'attacker' && self.flags.gunslingerReady && ctx.weapon?.size === 'Auxiliary' && isRangedWeapon(b, ctx.weapon)) {
        // +2d6 bonus damage and AP, and the attack ignores cover (AP: armor only, Resistance still applies)
        ctx.bonusDamage.push({ type: ctx.profile?.damage[0]?.type ?? 'Kinetic', val: '2d6' }); ctx.ap = true; ctx.ignoreCover = true; ctx.reasons.push('I Kill With My Heart')
        delete self.flags.gunslingerReady
      }
    },
    afterAttack(b, self, ctx, role) {
      if (role === 'attacker' && ctx.hit && ctx.weapon?.size === 'Auxiliary' && isRangedWeapon(b, ctx.weapon)) {
        self.flags.gunslingerDie = (self.flags.gunslingerDie ?? 6) - 1
        if (self.flags.gunslingerDie <= 1) { self.flags.gunslingerDie = 6; self.flags.gunslingerReady = true }
      }
    },
  },
  // ---------------- Grease Monkey
  {
    id: 't_grease_monkey:2', note: 'Machine Bond: Stabilize clears impaired/jammed/immobilized/slowed/lock on',
    init: u => { u.flags.machineBond = true },
  },
  // ---------------- Hacker
  {
    id: 't_hacker:1', note: 'SNOW_CRASH: when you hit with a tech attack that consumes Lock On, the target chooses: take 2 heat, or be pushed 3 spaces (away from you)',
    afterAttack(b, self, ctx, role) {
      if (role !== 'attacker' || !ctx.tech || !ctx.hit || !ctx.lockOnConsumed || ctx.target.destroyed) return
      const t = ctx.target
      // the target's call: heat, unless 2 more would overheat it
      const i = b.choose({ kind: 'snow_crash', unit: t, other: self, title: 'SNOW_CRASH', text: `${self.name}'s SNOW_CRASH: take 2 heat or be pushed 3 spaces?`, options: [{ label: 'Take 2 heat' }, { label: 'Be pushed 3 spaces' }], defaultIndex: t.heat + 2 > t.stats.heatcap ? 1 : 0 })
      if (i === 0) b.applyDamage(t, [{ type: 'Heat', amount: 2 }], { source: self })
      else b.forceMove(t, self, 3, 1)
    },
  },
  {
    id: 't_hacker:2', note: 'SAFE_CRACKER: Invade options Jam Cockpit (no Mount/Dismount: no effect here, pilots stay in their mechs), Disable Life Support (+1 Difficulty on all saves until a Systems check, quick action) and Hack/Slash (no Quick or Full Tech until Shut Down or a Systems check, quick action)',
    actions: (b, u) => [
      safeCracker(u, 'jam_cockpit', 'Jam Cockpit', 'Characters may not Mount or Dismount the target until it is fixed (pilots stay in their mechs in this game: only the 2 heat matters).', (bt, _self, t) => { t.flags.cockpitJammed = true; bt.say(`  ${t.name}'s cockpit is jammed.`) }, 1),
      safeCracker(u, 'life_support', 'Disable Life Support', '+1 Difficulty on all the target\'s saves until it reboots life support (Systems check, quick action).', (bt, self, t) => {
        if (!t.bonuses.some(x => x.condition === '{lifesupportdown}')) t.bonuses.push({ id: 'save', accuracy: -1, condition: '{lifesupportdown}' })
        t.flags.lifesupportdown = self.id
        bt.say(`  ${t.name}'s life support is down: +1 Difficulty on saves.`, 'status')
      }, 3),
      safeCracker(u, 'hack_slash', 'Hack/Slash', 'The target cannot take or benefit from Quick or Full Tech actions until it Shuts Down or reboots (Systems check, quick action).', (bt, self, t) => {
        t.flags.hackSlash = self.id
        bt.say(`  ${t.name}'s core computer is hacked: no tech actions.`, 'status')
      }, 3.5),
    ],
    grantActions: (b, self, other) => {
      const out: CustomAction[] = []
      const reboot = (key: string, name: string, flag: string, text: string) => action({
        key: `${key}:${self.id}`, name, activation: 'quick', target: 'none', text,
        run: (bt, me) => {
          if (!bt.check(me, 'sys')) { bt.say(`  ${me.name} fails to reboot.`); return }
          delete me.flags[flag]
          bt.say(`  ${me.name} reboots.`)
        },
        aiScore: () => 2.5,
      })
      if (other.flags.lifesupportdown === self.id) out.push(reboot('reboot_life_support', 'Reboot Life Support', 'lifesupportdown', 'Systems check: on a success, clear Disable Life Support.'))
      if (other.flags.hackSlash === self.id) out.push(reboot('reboot_core', 'Reboot Core Computer', 'hackSlash', 'Systems check: on a success, you can use tech actions again.'))
      return out
    },
    onAnyStatusAdded(b, self, target, status) { if (status === 'shutdown' && target.flags.hackSlash === self.id) delete target.flags.hackSlash },
  },
  {
    id: 't_hacker:3', note: 'Last Argument of Kings (full tech): a tech attack within Sensors and line of sight; on a hit the target takes Burn equal to its current Heat',
    actions: (b, u) => [action({
      key: 'laok', name: 'Last Argument of Kings', activation: 'full_tech', target: 'enemy', range: u.stats.sensors,
      text: 'Tech attack: the target takes Burn equal to its current Heat.',
      run: (bt, self, t) => {
        const target = t as Unit
        const v = bt.techTargetValid(self, target); if (v !== true) throw new Error(v)
        if (!bt.los(self, target) && !bt.viaMetahook(self, target)) throw new Error('No line of sight')
        const ctx = bt.techAttackRoll(self, target, 'Last Argument of Kings')
        if (ctx.hit && target.heat > 0) bt.applyDamage(target, [{ type: 'Burn', amount: target.heat }], { source: self })
      },
      aiScore: (bt, self, t) => (t && 'heat' in t ? (t as Unit).heat / 2 : 0),
    })],
  },
  // ---------------- Heavy Gunner
  {
    id: 't_heavy_gunner:1', note: 'Covering Fire (quick): a character within 10, line of sight and a Heavy ranged weapon\'s range is Impaired until the start of your next turn; if it moves more than 1 space it clears Impaired and you may attack it with that weapon as a reaction for half damage, heat and burn; one target at a time; ends if it damages you',
    actions: (b, u) => [action({
      key: 'coverfire', name: 'Covering Fire', activation: 'quick', target: 'enemy', range: 10,
      text: 'Pin a target with a Heavy ranged weapon: it is Impaired; if it moves 1+ spaces you may attack it as a reaction.',
      usable: (bt, self) => (self.weapons.some(w => w.size === 'Heavy' && isRangedWeapon(bt, w) && bt.weaponReady(self, w)) ? true : 'Needs a Heavy ranged weapon'),
      run: (bt, self, t) => {
        const target = t as Unit
        if (bt.distance(self, target) > 10) throw new Error('Out of range (10)')
        // one use at a time: a new Covering Fire replaces the previous targets (Bracketing Fire too)
        for (const o of bt.units) if (o.flags.coveredBy === self.id) { delete o.flags.coveredBy; o.statuses = o.statuses.filter(s => !(s.id === 'impaired' && s.data?.covering && s.source === self.id)) }
        const w = self.weapons.find(w => w.size === 'Heavy' && isRangedWeapon(bt, w) && bt.validTarget(self, w, target) === true)
        if (!w) throw new Error('No Heavy ranged weapon in range')
        const cover = (x: Unit, wp: Weapon) => {
          x.flags.coveredBy = self.id
          x.flags.coveredWeapon = wp.uid
          bt.addStatus(x, 'impaired', 'until_cleared', self, { covering: true })
        }
        cover(target, w)
        // Bracketing Fire (rank 3): a second target
        if (self.talents.some(t => t.id === 't_heavy_gunner' && t.rank >= 3)) {
          const cands = bt.alive().filter(o => o !== target && bt.hostile(self, o) && (o.kind === 'mech' || o.kind === 'npc') && bt.distance(self, o) <= 10 && bt.validTarget(self, w, o) === true).sort((x, y) => bt.distance(target, x) - bt.distance(target, y))
          if (cands.length) {
            const i = bt.choose({ kind: 'bracketing_fire', unit: self, title: 'Bracketing Fire: second target', options: [...cands.map(o => ({ label: o.name, hint: `${bt.distance(self, o)} spaces` })), { label: 'No second target' }], defaultIndex: 0 })
            if (cands[i]) cover(cands[i], w)
          }
        }
      },
    })],
    onTurnStart(b, self) { for (const o of b.units) if (o.flags.coveredBy === self.id) { delete o.flags.coveredBy; o.statuses = o.statuses.filter(s => !(s.id === 'impaired' && s.data?.covering && s.source === self.id)) } },
    onDamaged(b, self, d) { const src = d.source; if (src && src.flags.coveredBy === self.id) { delete src.flags.coveredBy; src.statuses = src.statuses.filter(s => !(s.id === 'impaired' && s.data?.covering && s.source === self.id)) } },
    onMove(b, self, mover, path) {
      if (mover.flags.coveredBy !== self.id || mover.destroyed || path.length - 1 <= 1) return
      delete mover.flags.coveredBy
      mover.statuses = mover.statuses.filter(s => !(s.id === 'impaired' && s.data?.covering && s.source === self.id))
      const w = self.weapons.find(w => w.uid === mover.flags.coveredWeapon)
      if (!w || b.canSpend(self, 'reaction') !== true || b.validTarget(self, w, mover) !== true) return
      if (!b.offerReaction(self, 'covering_fire', 'Covering Fire?', `${mover.name} broke cover. Attack it with ${w.name} (half damage)?`)) return
      b.spend(self, 'reaction')
      b.say(`${self.name}'s covering fire triggers!`)
      self.flags.halfDamage = true
      let r
      try { r = b.weaponAttack(self, w, { targetId: mover.id }, 'free') } finally { delete self.flags.halfDamage }
      if (self.talents.some(t => t.id === 't_heavy_gunner' && t.rank >= 2) && r.ctxs[0]?.hit) b.addStatus(mover, 'immobilized', 'next_turn_end_target', self)
    },
  },
  // ---------------- Hunter
  {
    id: 't_hunter:1', note: 'Lunge (fly 3 toward target before aux melee attack)',
    beforeAttack(b, self, ctx, role) {
      // the weapon is melee (the attack only counts as melee once the lunge has closed the distance)
      if (role !== 'attacker' || !ctx.weapon || !b.isMelee(ctx.weapon) || ctx.weapon.size !== 'Auxiliary' || b.adjacent(self, ctx.target) || !once(self, 'lunge')) return
      self.flags['turn:disengaged'] = true
      b.forceMove(self, ctx.target, 3, -1)
      delete self.flags['turn:disengaged']
      if (b.adjacent(self, ctx.target)) { ctx.melee = true; ctx.ranged = false }
    },
  },
  { id: 't_hunter:2', note: 'Knife Juggler: aux melee gain Thrown 5 (bonus)' },
  {
    id: 't_hunter:3', note: 'Disdainful Blade',
    afterAttack(b, self, ctx, role) {
      if (role !== 'attacker' || !ctx.hit || !ctx.melee || ctx.mode === 'secondary' || !once(self, 'disdain')) return
      const w = self.weapons.find(w => w.size === 'Auxiliary' && b.isMelee(w) && w !== ctx.weapon && b.weaponReady(self, w))
      const t = w && b.alive().find(o => b.hostile(self, o) && b.validTarget(self, w, o) === true)
      if (w && t) b.weaponAttack(self, w, { targetId: t.id }, 'secondary', { noBonusDamage: true })
    },
  },
  // ---------------- Infiltrator
  {
    id: 't_infiltrator:2', note: 'Ambush: when you start your turn Hidden, your first attack roll that hits makes the target save (Hull) or be Slowed, Impaired and unable to take reactions until the end of its next turn',
    onTurnStart: (b, u) => { if (b.has(u, 'hidden')) u.flags['turn:ambush'] = true; ambushHold(b, u) },
    afterAttack(b, self, ctx, role) {
      if (role !== 'attacker' || !self.flags['turn:ambush']) return
      delete self.flags['turn:ambush']
      const t = ctx.target
      if (ctx.hit && !t.destroyed && !b.save(t, 'hull', self.stats.save, 0, self)) {
        for (const s of ['slowed', 'impaired'] as const) b.addStatus(t, s, 'next_turn_end_target', self)
        // no reactions until the end of its next turn: every turn start refills reactions, so they are emptied again
        t.flags.ambushedBy = self.id
        t.flags.ambushTurns = t.activeTurn ? 2 : 1
        t.reactionsLeft = 0
        b.say(`  ${t.name} is reeling: no reactions until the end of its next turn.`, 'status')
      }
    },
    onRoundStart: (b, self) => ambushHold(b, self),
    onAnyTurnStart: (b, self) => ambushHold(b, self),
    onAnyTurnEnd(b, self, u) {
      if (u.flags.ambushedBy !== self.id) return
      if (--u.flags.ambushTurns <= 0) { delete u.flags.ambushedBy; delete u.flags.ambushTurns }
    },
  },
  // ---------------- Juggernaut
  {
    id: 't_juggernaut:1', note: 'Momentum: when you Boost, your next Ram before the start of your next turn gains +1 Accuracy and knocks the target back 2 more spaces',
    onTurnStart: (_b, self) => { delete self.flags.momentum },
    onAnyMovementAction(_b, self, mover, kind) { if (mover === self && kind === 'boost') self.flags.momentum = true },
    beforeAttack(b, self, ctx, role) {
      if (role !== 'attacker' || ctx.mode !== 'ram' || !self.flags.momentum) return
      delete self.flags.momentum // only the next Ram
      acc(ctx, 1, 'Momentum')
      ctx.reasons.push('Momentum knockback')
    },
    afterAttack(b, self, ctx, role) { if (role === 'attacker' && ctx.mode === 'ram' && ctx.hit && ctx.reasons.includes('Momentum knockback') && !ctx.target.destroyed) b.forceMove(ctx.target, self, 2, 1) },
  },
  // ---------------- Leader (leadership dice: +1d6 to an ally's attack, auto)
  {
    id: 't_leader:1', note: 'Field Commander: Leadership Dice (3; 5 at rank 2, 6 at rank 3); Issue Order (free, 1/turn): give an ally without one a die; it may spend it for +1 Accuracy on a following attack, check or save, or hand it back (free)',
    init: u => { u.flags.leaderDice = u.talents.find(t => t.id === 't_leader')!.rank >= 3 ? 6 : u.talents.find(t => t.id === 't_leader')!.rank >= 2 ? 5 : 3 },
    actions: (b, u) => ((u.flags.leaderDice ?? 0) > 0 ? [action({
      key: 'issue_order', name: `Issue Order (${u.flags.leaderDice} dice)`, activation: 'free', target: 'ally', range: 99, text: 'Give an allied mech a Leadership Die: +1 Accuracy on an action that follows your order.',
      usable: (_bt, self) => (self.flags['turn:order'] ? 'Once per turn' : !self.activeTurn ? 'On your turn' : true),
      run: (bt, self, t) => {
        const a = t as Unit
        if (!a || a === self || bt.hostile(self, a) || a.kind !== 'mech') throw new Error('Choose an allied mech')
        if (a.flags.leaderDie) throw new Error(`${a.name} already holds a Leadership Die`)
        self.flags['turn:order'] = true
        self.flags.leaderDice--
        a.flags.leaderDie = self.id
        bt.say(`${self.name} issues an order to ${a.name}.`)
      },
      aiTarget: (bt, self) => bt.alive().filter(o => o !== self && o.kind === 'mech' && !bt.hostile(self, o) && !o.flags.leaderDie && o.activationsLeft > 0)[0] ?? null,
      aiScore: () => 1,
    })] : []),
    grantActions: (b, self, other) => (other.flags.leaderDie === self.id ? [action({
      key: `return_die:${self.id}`, name: 'Return Leadership Die', activation: 'free', target: 'none', text: `Give the die back to ${self.name}.`,
      run: (bt, me) => { delete me.flags.leaderDie; self.flags.leaderDice = (self.flags.leaderDice ?? 0) + 1; bt.say(`${me.name} returns the Leadership Die.`) },
      aiScore: () => -1,
    })] : []),
    beforeAnyAttack(b, self, ctx) {
      const a = ctx.attacker
      if (a.flags.leaderDie !== self.id || !a.activeTurn) return
      if (b.choose({ kind: 'leader_die', unit: a, title: 'Spend the Leadership Die?', text: `+1 Accuracy on this attack (an order from ${self.name}).`, options: [{ label: 'Spend it (+1 Accuracy)' }, { label: 'Keep it' }], defaultIndex: 0 }) !== 0) return
      delete a.flags.leaderDie
      ctx.accuracy++
      ctx.reasons.push(`${self.name}'s order +1`)
    },
    checkAccuracy(b, self, u, kind) {
      if (u.flags.leaderDie !== self.id || !u.activeTurn || (kind !== 'check' && kind !== 'save')) return 0
      if (b.choose({ kind: 'leader_die', unit: u, title: 'Spend the Leadership Die?', text: `+1 Accuracy on this ${kind}.`, options: [{ label: 'Spend it (+1 Accuracy)' }, { label: 'Keep it' }], defaultIndex: 0 }) !== 0) return 0
      delete u.flags.leaderDie
      return 1
    },
  },
  // ---------------- Nuclear Cavalier
  {
    id: 't_nuclear_cavalier:1', note: 'Aggressive Heat Bleed',
    afterAttack(b, self, ctx, role) {
      if (role === 'attacker' && self.activeTurn && b.has(self, 'dangerzone') && once(self, 'heatbleed', 'turn') && ctx.hit && !ctx.target.destroyed) b.applyDamage(ctx.target, [{ type: 'Heat', amount: 2 }], { source: self })
    },
  },
  {
    id: 't_nuclear_cavalier:2', note: 'Fusion Hemorrhage',
    beforeAttack(b, self, ctx, role) {
      if (role === 'attacker' && self.activeTurn && !ctx.tech && b.has(self, 'dangerzone') && once(self, 'fusion', 'turn')) { ctx.bonusDamage.push({ type: 'Energy', val: '1d6' }); ctx.convertDamage = 'Energy'; ctx.reasons.push('Fusion Hemorrhage') }
    },
  },
  // ---------------- Siege Specialist
  {
    id: 't_siege_specialist:2', note: 'Impact: 1/round, before rolling a Cannon attack, adjacent characters save (Hull) or are knocked back 1 and Prone; you are then pushed 1 space in a direction of your choice',
    beforeAttack(b, self, ctx, role) {
      if (role !== 'attacker' || b.previewing || !isWeaponType(ctx.weapon, 'Cannon') || ctx.mode === 'secondary' || !once(self, 'impact')) return
      for (const o of b.alive()) if (o !== self && b.adjacent(self, o) && o.kind !== 'deployable' && !b.save(o, 'hull', self.stats.save, 0, self)) { b.forceMove(o, self, 1, 1); b.addStatus(o, 'prone', 'until_cleared', self) }
      selfPush(b, self, ctx.target)
    },
  },
  {
    id: 't_siege_specialist:3', note: 'Collateral Damage: 1/round, on a Cannon crit you may set off a Burst 2 explosion around the target; every other character in it either drops Prone as a reaction or takes 2 explosive and is knocked back 2 from the centre',
    afterAttack(b, self, ctx, role) {
      if (role !== 'attacker' || !ctx.crit || !isWeaponType(ctx.weapon, 'Cannon') || self.flags['round:collateral']) return
      const centre = ctx.target
      const caught = unitsOnTiles(b.alive(), burstTiles(b.map, centre, 2)).filter(o => o !== centre && (o.kind === 'mech' || o.kind === 'npc'))
      const foes = caught.filter(o => b.hostile(self, o)).length, friends = caught.length - foes
      if (b.choose({ kind: 'collateral', unit: self, title: 'Collateral Damage?', text: `Set off a Burst 2 explosion around ${centre.name} (${caught.length} other character${caught.length === 1 ? '' : 's'} caught)?`, options: [{ label: 'Detonate' }, { label: 'No' }], defaultIndex: foes > friends ? 0 : 1 }) !== 0) return
      self.flags['round:collateral'] = true
      b.emit({ type: 'area', tiles: burstTiles(b.map, centre, 2), kind: 'explosion' })
      for (const o of caught) {
        if (o.destroyed) continue
        // each character chooses: drop Prone (a reaction), or take 2 explosive and the knockback; it drops when it can
        // and the blast would hurt it (armor below 2) or knock it into trouble
        const canDrop = !o.flying && !b.has(o, 'prone') && b.canSpend(o, 'reaction', 'collateral') === true
        const hurts = Math.max(0, 2 - (o.stats.armor ?? 0)) > 0
        const drop = canDrop && b.choose({ kind: 'collateral_answer', unit: o, other: self, title: 'Collateral Damage', text: 'Drop Prone as a reaction, or take 2 explosive and be knocked back 2?', options: [{ label: 'Drop Prone' }, { label: 'Take the blast' }], defaultIndex: hurts ? 0 : 1 }) === 0
        if (drop) { b.spend(o, 'reaction', 'collateral'); b.addStatus(o, 'prone', 'until_cleared', self); continue }
        b.applyDamage(o, [{ type: 'Explosive', amount: 2 }], { source: self })
        if (!o.destroyed) b.forceMove(o, centre, 2, 1)
      }
    },
  },
  // ---------------- Skirmisher
  {
    id: 't_skirmisher:1', note: 'Integrated Chaff Launchers: soft cover from the start of your turn until you attack or force another character to make a save',
    onTurnStart: (b, u) => { u.flags.chaff = true },
    afterAttack(b, self, ctx, role) { if (role === 'attacker') self.flags.chaff = false },
    onSaveForced(b, self, target) { if (target !== self) self.flags.chaff = false },
    adjustCover: (b, self, attacker, target, c) => (target === self && self.flags.chaff && c === 'none' ? 'soft' : c),
  },
  {
    id: 't_skirmisher:2', note: 'Lockbreaker: before or after you Skirmish, and after you Skirmish as a reaction (Overwatch), you may move 2 spaces, ignoring engagement and provoking no reactions',
    actions: (b, u) => (u.activeTurn && !u.flags['turn:lockbreaker'] && (u.flags['turn:skirmished'] || b.canSpend(u, 'quick', 'skirmish') === true) ? [action({
      key: 'lockbreaker', name: 'Lockbreaker Step', activation: 'free', target: 'tile', range: 2, text: u.flags['turn:skirmished'] ? 'After your Skirmish: move 2 spaces ignoring engagement and reactions.' : 'Before you Skirmish: move 2 spaces ignoring engagement and reactions.',
      run: (bt, self, t) => {
        self.flags['turn:lockbreaker'] = true
        self.flags.pendingMove = 2
        self.flags['turn:disengaged'] = true
        try { bt.move(self, t as Pos, { mode: 'free', ignoreEngagement: true }) } finally { delete self.flags.pendingMove; delete self.flags['turn:disengaged'] }
      },
    })] : []),
    afterAttack(b, self, ctx, role) {
      if (role !== 'attacker' || ctx.tech) return
      if (ctx.mode === 'skirmish' && self.activeTurn) self.flags['turn:skirmished'] = true
      // a Skirmish taken as a reaction (Overwatch): the step comes right after it, once per attack
      if (ctx.mode === 'overwatch' && !self.activeTurn && !self.destroyed && !self.flags.lockbreakerBusy) {
        self.flags.lockbreakerBusy = true
        try { shortMove(b, self, 2, 'lockbreaker_move', 'Lockbreaker: move 2 spaces (ignores engagement and reactions)', { ignoreEngagement: true }) } finally { delete self.flags.lockbreakerBusy }
      }
    },
  },
  {
    id: 't_skirmisher:3', note: 'Weave: the first attack made against you as a reaction each round automatically misses',
    afterAnyRoll(b, self, ctx) {
      if (ctx.target !== self || !(ctx.mode === 'overwatch' || !ctx.attacker.activeTurn) || !once(self, 'weave')) return
      if (ctx.hit) { ctx.hit = false; ctx.crit = false; b.say(`  ${self.name} weaves clear!`) }
    },
  },
  // ---------------- Spotter
  {
    id: 't_spotter:1', note: 'Particularize: an adjacent ally that consumes Lock On with an attack rolls twice and keeps either result (the better one)',
    afterAnyRoll(b, self, ctx) {
      const a = ctx.attacker
      if (a === self || b.hostile(self, a) || !ctx.lockOnConsumed || !b.adjacent(self, a) || ctx.crit || ctx.reasons.includes('Particularize')) return
      ctx.reasons.push('Particularize')
      const first = { roll: ctx.roll, total: ctx.total, hit: ctx.hit, crit: ctx.crit }
      b.say(`  ${a.name} rolls twice (${self.name}'s Particularize).`)
      b.rerollToHit(ctx)
      const score = (x: { hit?: boolean; crit?: boolean; total?: number }) => (x.crit ? 2000 : x.hit ? 1000 : 0) + (x.total ?? 0)
      if (score(first) > score(ctx)) { Object.assign(ctx, first); b.say(`  ${a.name} keeps the first roll (${first.total}).`) }
    },
  },
  // ---------------- Stormbringer
  {
    id: 't_stormbringer:1', note: 'Seismic Deluge',
    beforeAttack(b, self, ctx, role) { if (role === 'attacker' && isWeaponType(ctx.weapon, 'Launcher') && ctx.reasons.includes('Lock On +1')) self.flags.deluge = true },
    afterAttack(b, self, ctx, role) {
      if (role === 'attacker' && self.flags.deluge) { delete self.flags.deluge; if (ctx.hit && !ctx.target.destroyed && once(self, 'deluge')) b.addStatus(ctx.target, 'prone', 'until_cleared', self) }
    },
  },
  {
    id: 't_stormbringer:2', note: 'Stormbending: 1/round, when you hit with a Launcher, choose Lightning (the target saves (Hull) or is knocked 3 away from you, and you are knocked 3 back) or Thunder (everyone else in Burst 2 of the target saves (Agility) or is knocked 1 away from it)',
    afterAttack(b, self, ctx, role) {
      if (role !== 'attacker' || !ctx.hit || !isWeaponType(ctx.weapon, 'Launcher') || !once(self, 'stormbend')) return
      const t = ctx.target
      self.flags.torrent = Math.max(1, (self.flags.torrent ?? 6) - 1)
      const i = b.choose({ kind: 'stormbending', unit: self, title: 'Stormbending', options: [{ label: 'Lightning', hint: 'the target saves (Hull) or is knocked 3 away; you are knocked back 3' }, { label: 'Thunder', hint: 'Burst 2 around the target: Agility save or knocked back 1' }, { label: 'Neither' }], defaultIndex: t.destroyed ? 1 : 0 })
      if (i === 0 && !t.destroyed) {
        if (!b.save(t, 'hull', self.stats.save, 0, self)) b.forceMove(t, self, 3, 1)
        b.forceMove(self, t, 3, 1)
      } else if (i === 1) {
        for (const o of unitsOnTiles(b.alive(), burstTiles(b.map, t, 2))) if (o !== t && (o.kind === 'mech' || o.kind === 'npc') && !b.save(o, 'agi', self.stats.save, 0, self)) b.forceMove(o, t, 1, 1)
      }
    },
  },
  // ---------------- Tactician
  {
    id: 't_tactician:1', note: 'Opportunist',
    beforeAttack(b, self, ctx, role) {
      if (role === 'attacker' && ctx.melee && b.alive().some(o => o !== self && !b.hostile(self, o) && b.adjacent(o, ctx.target) && o.kind !== 'deployable') && once(self, 'opportunist')) acc(ctx, 1, 'Opportunist')
    },
  },
  {
    id: 't_tactician:2', note: 'Solar Backdrop',
    beforeAttack(b, self, ctx, role) {
      if (role === 'attacker' && ctx.ranged && !ctx.tech && b.elevation(self) > b.elevation(ctx.target) && once(self, 'solar')) acc(ctx, 1, 'Solar Backdrop')
    },
  },
  {
    id: 't_tactician:3', note: 'Overlapping Fire — Flank (reaction, 1/round): when an ally successfully attacks a character that has no cover from you, Overwatch it for half damage, heat and burn',
    afterAnyAttack(b, self, ctx) {
      const t = ctx.target
      if (ctx.attacker === self || b.hostile(self, ctx.attacker) || !b.hostile(self, t) || !ctx.hit || t.destroyed || self.destroyed) return
      if (self.flags['round:flank'] || b.canSpend(self, 'reaction', 'overwatch') !== true || b.cover(self, t) !== 'none') return
      const w = overwatchWeapon(b, self, t)
      if (!w) return
      if (!b.offerReaction(self, 'flank', 'Flank?', `${ctx.attacker.name} hit ${t.name}, which has no cover from you. Overwatch it for half damage?`)) return
      self.flags['round:flank'] = true
      b.spend(self, 'reaction', 'overwatch') // through spend(): reveals Hidden, ends Ghostweave, runs onAnyAction hooks
      b.say(`${self.name} flanks!`, 'attack')
      self.flags.halfDamage = true
      try { b.weaponAttack(self, w, { targetId: t.id }, 'overwatch') } finally { delete self.flags.halfDamage }
    },
  },
  // ---------------- Technophile
  { id: 't_technophile:3', note: 'Enlightenment: no cascade (bonus)' },
  // ---------------- Vanguard
  {
    id: 't_vanguard:1', note: 'Handshake Etiquette',
    beforeAttack(b, self, ctx, role) { if (role === 'attacker' && isWeaponType(ctx.weapon, 'CQB') && b.distance(self, ctx.target) <= 3) acc(ctx, 1, 'Handshake Etiquette') },
  },
  {
    id: 't_vanguard:2', note: 'See-Through Seeker',
    beforeAttack(b, self, ctx, role) {
      if (role !== 'attacker' || ctx.weapon?.type !== 'CQB' || b.distance(self, ctx.target) > 3) return
      if (!ctx.ignoreCover && b.cover(self, ctx.target) !== 'none') ctx.reasons.push('See-Through Seeker')
      ctx.ignoreCover = true
    },
  },
  {
    id: 't_vanguard:3', note: 'Semper Vigilo: Overwatch with CQB weapons when a hostile enters, leaves or moves through spaces within your Threat (wherever it started), at the first such space',
    onMove(b, self, mover, path) {
      if (!b.hostile(self, mover) || mover.destroyed || self.destroyed || path.length < 2 || b.reactionDepth > 0) return
      if (self.policies.overwatch === 'off' || b.canSpend(self, 'reaction', 'overwatch') !== true) return
      const end = mover.pos
      const cqb = self.weapons.filter(w => isWeaponType(w, 'CQB') && b.weaponReady(self, w) && b.weaponUsable(self, w, false) === true)
      // the first space of the move within Threat (the start counts: leaving it triggers too)
      let at: Pos | null = null, w: Weapon | undefined
      for (const p of path) {
        mover.pos = p
        w = cqb.find(x => b.distance(self, mover) <= Math.max(1, b.weaponThreat(self, x)) && b.validTarget(self, x, mover) === true)
        if (w) { at = p; break }
      }
      mover.pos = end
      if (!w || !at) return
      if (!b.wantsReaction(self, 'overwatch', true, mover, `SEMPER VIGILO? ${mover.name} moves within the threat of ${self.name}'s ${w.name}. Attack it?`)) return
      b.spend(self, 'reaction', 'overwatch') // through spend(): reveals Hidden, ends Ghostweave, runs onAnyAction hooks
      b.say(`${self.name}: Semper Vigilo!`, 'attack')
      // the attack happens at that point of the move; the mover then finishes it (unless the attack moved it)
      mover.pos = at
      b.reactionDepth++
      try { b.weaponAttack(self, w, { targetId: mover.id }, 'overwatch') } finally { b.reactionDepth-- }
      if (!mover.destroyed && mover.pos.x === at.x && mover.pos.y === at.y) mover.pos = end
    },
  },
  // ---------------- Walking Armory (Ammo Case: auto THUMPER = +knockback 1, +? …)
  {
    id: 't_walking_armory:1', note: 'Armament: gives the Ammo Case system — load THUMPER, SHOCK or MAG for a Main ranged attack (1/turn) from the action bar',
  },
])

function maxDice(v: string | number): number {
  if (typeof v === 'number') return v
  const m = v.replace(/\s/g, '').match(/^(\d*)d(\d+)([+-]\d+)?$/)
  if (!m) return Number(v) || 0
  return Number(m[1] || 1) * Number(m[2]) + Number(m[3] || 0)
}
