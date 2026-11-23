// Pilot talents (`<talentId>:<rank>`). Reactions that need a player decision are resolved with a
// sensible automatic policy (documented per script) so the engine stays non-blocking.
import { burstTiles, unitsOnTiles } from '../../grid'
import { isWeaponType } from '../../stats'
import { rollDice } from '../../rng'
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

registerScripts([
  // ---------------- Ace
  {
    id: 't_ace:1', note: 'Acrobatics: +1 acc agility while flying (via bonus); auto-dodge reposition logged',
    init: u => { u.bonuses.push({ id: 'agility', accuracy: 1, condition: '{flying}' }) },
  },
  {
    id: 't_ace:2', note: 'Afterburners: extra 1d6 move on boost while flying, half as heat',
    onAnyMovementAction(b, self, mover, kind) {
      if (mover !== self || kind !== 'boost' || !self.flying) return
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
      text: 'Brawler die at 1: adjacent target must pass a Hull save or be Stunned until the end of its next turn; on success, Prone. (Reset die to 6.)',
      usable: (bt, self) => ((self.flags.brawlerDie ?? 6) <= 1 ? true : `Brawler die ${self.flags.brawlerDie ?? 6}`),
      run: (bt, self, t) => {
        const target = t as Unit
        if (!bt.adjacent(self, target)) throw new Error('Must be adjacent')
        self.flags.brawlerDie = 6
        if (!bt.save(target, 'hull', self.stats.save, 0, self)) bt.addStatus(target, 'stunned', 'next_turn_end_target', self)
        else bt.addStatus(target, 'prone', 'until_cleared', self)
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
    id: 't_crack_shot:2', note: 'Zero In (auto when steady: +1 diff, +1d6 on crit)',
    beforeAttack(b, self, ctx, role) {
      if (role === 'attacker' && isWeaponType(ctx.weapon, 'Rifle') && self.flags.steady && once(self, 'zeroin')) { ctx.difficulty++; self.flags.zeroIn = true }
    },
    afterAttack(b, self, ctx, role) {
      if (role === 'attacker' && self.flags.zeroIn) {
        delete self.flags.zeroIn
        if (ctx.crit && !ctx.target.destroyed) b.applyDamage(ctx.target, [{ type: 'Kinetic', amount: rollDice(b.rng, '1d6', { crit: true }).total }], { source: self })
      }
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
    id: 't_centimane:2', note: 'Expose Weakness',
    beforeAttack(b, self, ctx, role) { if (role === 'attacker' && ctx.reasons.includes('Lock On +1')) self.flags.consumedLock = true },
    afterAttack(b, self, ctx, role) {
      if (role === 'attacker' && self.flags.consumedLock && ctx.crit && isWeaponType(ctx.weapon, 'Nexus')) b.addStatus(ctx.target, 'shredded', 'start_of_next_turn_target', self)
      delete self.flags.consumedLock
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
    id: 't_duelist:3', note: 'Unstoppable (auto-Ram after a melee hit using a blademaster die)',
    afterAttack(b, self, ctx, role) {
      if (role !== 'attacker' || !ctx.hit || !ctx.melee || !self.activeTurn || (self.flags.bladeDice ?? 0) <= 0 || ctx.target.destroyed || !once(self, 'unstoppable')) return
      if (ctx.target.stats.size > self.stats.size || !b.adjacent(self, ctx.target)) return
      self.flags.bladeDice--
      b.addStatus(ctx.target, 'prone', 'until_cleared', self)
      b.forceMove(ctx.target, self, 1, 1)
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
    id: 't_exemplar:2', note: 'Punishment (marked attacker triggers your overwatch)',
    afterAnyAttack(b, self, ctx) {
      if (ctx.attacker.flags.exemplarMarkBy !== self.id || ctx.target === self || b.distance(self, ctx.target) > 3 || ctx.attacker.destroyed) return
      if (b.canSpend(self, 'reaction') !== true || !once(self, 'punish')) return
      const w = b.bestThreatWeapon(self, ctx.attacker)
      if (!w) return
      b.spend(self, 'reaction') // through spend(): reveals Hidden, ends Ghostweave, runs onAnyAction hooks
      b.say(`${self.name} punishes ${ctx.attacker.name}!`)
      b.weaponAttack(self, w, { targetId: ctx.attacker.id }, 'overwatch')
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
    id: 't_gunslinger:2', note: 'Return Fire (auto reaction with an aux ranged weapon when attacked)',
    afterAttack(b, self, ctx, role) {
      if (role !== 'target' || ctx.attacker.destroyed || !ctx.ranged || b.canSpend(self, 'reaction') !== true || !once(self, 'returnfire')) return
      const w = self.weapons.find(w => w.size === 'Auxiliary' && isRangedWeapon(b, w) && b.weaponReady(self, w) && b.validTarget(self, w, ctx.attacker) === true)
      if (!w) return
      b.spend(self, 'reaction') // through spend(): reveals Hidden, ends Ghostweave, runs onAnyAction hooks
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
    id: 't_hacker:1', note: 'SNOW_CRASH (2 heat on tech hits consuming lock on)',
    beforeAttack(b, self, ctx, role) { if (role === 'attacker' && ctx.tech && b.has(ctx.target, 'lockon')) { b.removeStatus(ctx.target, 'lockon'); acc(ctx, 1, 'Lock On'); self.flags.snow = true } },
    afterAttack(b, self, ctx, role) {
      if (role === 'attacker' && self.flags.snow) { delete self.flags.snow; if (ctx.hit && !ctx.target.destroyed) b.applyDamage(ctx.target, [{ type: 'Heat', amount: 2 }], { source: self }) }
    },
  },
  {
    id: 't_hacker:2', note: 'SAFE_CRACKER invade options',
    actions: (b, u) => [action({
      key: 'safecracker-jam', name: 'Invade: Disable', activation: 'quick_tech', techOption: 'invade', target: 'enemy', range: u.stats.sensors,
      text: 'Tech attack: 2 heat and the target is Jammed until the end of its next turn.',
      run: (bt, self, t) => {
        const ctx = bt.techAttackRoll(self, t as Unit, 'SAFE_CRACKER')
        if (ctx.hit) { bt.applyDamage(t as Unit, [{ type: 'Heat', amount: 2 }], { source: self }); bt.addStatus(t as Unit, 'jammed', 'next_turn_end_target', self) }
      },
    })],
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
        for (const o of bt.units) if (o.flags.coveredBy === self.id && !self.talents.some(x => x.id === 't_heavy_gunner' && x.rank >= 3)) { delete o.flags.coveredBy; o.statuses = o.statuses.filter(s => !(s.id === 'impaired' && s.data?.covering && s.source === self.id)) }
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
          const second = bt.alive().filter(o => o !== target && bt.hostile(self, o) && (o.kind === 'mech' || o.kind === 'npc') && bt.validTarget(self, w, o) === true).sort((x, y) => bt.distance(target, x) - bt.distance(target, y))[0]
          if (second) cover(second, w)
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
    id: 't_infiltrator:2', note: 'Ambush',
    onTurnStart: (b, u) => { if (b.has(u, 'hidden')) u.flags['turn:ambush'] = true },
    afterAttack(b, self, ctx, role) {
      if (role !== 'attacker' || !self.flags['turn:ambush']) return
      delete self.flags['turn:ambush']
      if (ctx.hit && !ctx.target.destroyed && !b.save(ctx.target, 'hull', self.stats.save, 0, self)) {
        for (const s of ['slowed', 'impaired'] as const) b.addStatus(ctx.target, s, 'next_turn_end_target', self)
        ctx.target.reactionsLeft = 0
      }
    },
  },
  // ---------------- Juggernaut
  {
    id: 't_juggernaut:1', note: 'Momentum: Ram after boost +1 acc, +2 knockback',
    beforeAttack(b, self, ctx, role) { if (role === 'attacker' && ctx.mode === 'ram' && self.flags['round:boosted']) acc(ctx, 1, 'Momentum') },
    afterAttack(b, self, ctx, role) { if (role === 'attacker' && ctx.mode === 'ram' && ctx.hit && self.flags['round:boosted'] && !ctx.target.destroyed) b.forceMove(ctx.target, self, 2, 1) },
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
    id: 't_siege_specialist:2', note: 'Impact',
    beforeAttack(b, self, ctx, role) {
      if (role !== 'attacker' || ctx.weapon?.type !== 'Cannon' || !once(self, 'impact')) return
      for (const o of b.alive()) if (o !== self && b.adjacent(self, o) && o.kind !== 'deployable' && !b.save(o, 'hull', self.stats.save, 0, self)) { b.forceMove(o, self, 1, 1); b.addStatus(o, 'prone', 'until_cleared', self) }
    },
  },
  {
    id: 't_siege_specialist:3', note: 'Collateral Damage',
    afterAttack(b, self, ctx, role) {
      if (role !== 'attacker' || !ctx.crit || ctx.weapon?.type !== 'Cannon' || !once(self, 'collateral')) return
      for (const o of unitsOnTiles(b.alive(), burstTiles(b.map, ctx.target, 2))) {
        if (o === ctx.target || o === self) continue
        if (o.side === self.side) { b.addStatus(o, 'prone', 'until_cleared', self); continue }
        // "drop Prone as a reaction, or take 2 Explosive damage and be knocked back 2 spaces from the centre"
        b.applyDamage(o, [{ type: 'Explosive', amount: 2 }], { source: self })
        if (!o.destroyed) b.forceMove(o, ctx.target, 2, 1)
      }
    },
  },
  // ---------------- Skirmisher
  {
    id: 't_skirmisher:1', note: 'Integrated Chaff Launchers',
    onTurnStart: (b, u) => { u.flags.chaff = true },
    afterAttack(b, self, ctx, role) { if (role === 'attacker') self.flags.chaff = false },
    adjustCover: (b, self, attacker, target, c) => (target === self && self.flags.chaff && c === 'none' ? 'soft' : c),
  },
  {
    id: 't_skirmisher:2', note: 'Lockbreaker (2-space step after skirmishing)',
    actions: (b, u) => u.flags['turn:attacked'] ? [action({
      key: 'lockbreaker', name: 'Lockbreaker Step', activation: 'free', target: 'tile', range: 2, text: 'Move 2 spaces ignoring engagement and reactions.',
      usable: (bt, self) => (self.flags['turn:lockbreaker'] ? 'Already used' : true),
      run: (bt, self, t) => {
        self.flags['turn:lockbreaker'] = true
        self.flags.pendingMove = 2
        self.flags['turn:disengaged'] = true
        try { bt.move(self, t as Pos, { mode: 'free', ignoreEngagement: true }) } finally { delete self.flags.pendingMove; delete self.flags['turn:disengaged'] }
      },
    })] : [],
  },
  {
    id: 't_skirmisher:3', note: 'Weave',
    afterAnyRoll(b, self, ctx) {
      if (ctx.target === self && (ctx.mode === 'overwatch' || !ctx.attacker.activeTurn) && ctx.hit && once(self, 'weave')) { ctx.hit = false; b.say(`  ${self.name} weaves clear!`) }
    },
  },
  // ---------------- Spotter
  {
    id: 't_spotter:1', note: 'Particularize (adjacent ally consuming Lock On rolls twice)',
    beforeAnyAttack(b, self, ctx) {
      if (ctx.attacker !== self && !b.hostile(self, ctx.attacker) && b.adjacent(self, ctx.attacker) && ctx.reasons.includes('Lock On +1')) ctx.rerollOnMiss = true
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
    id: 't_tactician:3', note: 'Overlapping Fire (Flank: when an ally hits a target you threaten, attack it as a reaction)',
    afterAnyAttack(b, self, ctx) {
      if (ctx.attacker === self || b.hostile(self, ctx.attacker) || !ctx.hit || ctx.target.destroyed || b.canSpend(self, 'reaction') !== true) return
      const w = b.bestThreatWeapon(self, ctx.target)
      if (!w || !once(self, 'flank')) return
      b.spend(self, 'reaction') // through spend(): reveals Hidden, ends Ghostweave, runs onAnyAction hooks
      b.say(`${self.name} flanks!`)
      b.weaponAttack(self, w, { targetId: ctx.target.id }, 'overwatch')
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
    id: 't_vanguard:3', note: 'Semper Vigilo (CQB overwatch when hostiles enter threat)',
    onMove(b, self, mover, path) {
      if (!b.hostile(self, mover) || mover.destroyed || b.canSpend(self, 'reaction') !== true || self.policies.overwatch === 'off') return
      const w = self.weapons.find(w => isWeaponType(w, 'CQB') && b.weaponReady(self, w) && b.weaponThreat(self, w) >= b.distance(self, mover) && b.validTarget(self, w, mover) === true)
      if (!w || path.length < 2) return
      b.spend(self, 'reaction') // through spend(): reveals Hidden, ends Ghostweave, runs onAnyAction hooks
      b.say(`${self.name}: Semper Vigilo!`)
      b.weaponAttack(self, w, { targetId: mover.id }, 'overwatch')
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
