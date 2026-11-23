// Higher talent ranks that were previously resolved by hand.
import type { Battle } from '../../battle'
import { isWeaponType } from '../../stats'
import { chebyshev, footprint, tileAt } from '../../grid'
import { rollDice } from '../../rng'
import type { Pos, Unit } from '../../types'
import { registerScripts, type CustomAction, type ItemScript } from '../registry'

const action = (a: Omit<CustomAction, 'usable'> & { usable?: CustomAction['usable'] }): CustomAction => ({ usable: () => true, ...a })
const chars = (b: Battle) => b.alive().filter(o => o.kind === 'mech' || o.kind === 'npc')
const hostiles = (b: Battle, u: Unit) => chars(b).filter(o => b.hostile(u, o))
const rank = (u: Unit, id: string) => u.talents.find(t => t.id === id)?.rank ?? 0
const once = (u: Unit, key: string, scope: 'round' | 'turn' | 'scene' = 'round') => { const k = `${scope}:${key}`; if (u.flags[k]) return false; u.flags[k] = true; return true }
const free = (b: Battle, p: Pos, except?: Unit) => !!tileAt(b.map, p) && !b.alive().some(o => o !== except && !o.flags.flat && footprint(o).some(q => q.x === p.x && q.y === p.y))
const narrative = (id: string, note: string): ItemScript => ({ id, note: `out of combat: ${note}` })

/** Bondmate: the nearest allied mech, fixed the first time it's needed this battle. */
function bondmate(b: Battle, u: Unit): Unit | undefined {
  let m = b.unit(u.flags.bondmate)
  if (!m || m.destroyed) {
    m = chars(b).filter(o => o !== u && o.kind === 'mech' && !b.hostile(u, o)).sort((x, y) => b.distance(u, x) - b.distance(u, y))[0]
    if (m) u.flags.bondmate = m.id
  }
  return m
}

/** Straight-line dash (Unstoppable Force); returns characters passed through. */
function charge(b: Battle, u: Unit, toward: Pos, max: number): Unit[] {
  const dx = Math.sign(toward.x - u.pos.x), dy = Math.sign(toward.y - u.pos.y)
  const passed: Unit[] = []
  const path: Pos[] = [u.pos]
  let last = u.pos, cur = u.pos
  for (let i = 0; i < max; i++) {
    const nx = { x: cur.x + dx, y: cur.y + dy }
    const t = tileAt(b.map, nx), t0 = tileAt(b.map, cur)
    if (!t || !t0) break
    if (t.h - t0.h > 1) { b.damageTerrain(nx, 20); const t2 = tileAt(b.map, nx)!; if (t2.h - t0.h > 1) break }
    const blockers = b.alive().filter(o => o !== u && !o.flags.flat && footprint(o).some(q => q.x === nx.x && q.y === nx.y))
    if (blockers.some(o => o.stats.size > u.stats.size || o.kind === 'deployable')) break
    for (const o of blockers) if (!passed.includes(o)) passed.push(o)
    cur = nx
    path.push(cur)
    if (!blockers.length) last = cur
  }
  const end = path.indexOf(last)
  if (end > 0) { u.pos = last; b.emit({ type: 'move', unitId: u.id, path: path.slice(0, end + 1) }) }
  return passed
}

registerScripts([
  // ---------------- Ace 3: Supersonic
  {
    id: 't_ace:3', partial: true, note: 'Supersonic: spin up thrusters; if you end your turn flying, fly next to the nearest hostile in range when its turn ends (nominee chosen automatically)',
    actions: () => [action({
      key: 'spin_up', name: 'Spin Up Thrusters', activation: 'quick', target: 'none', text: 'If you end your turn flying, gain the Supersonic reaction against a nominated character.',
      usable: (_b, u) => (u.flags['turn:spun'] ? 'Already spun up' : true),
      run: (_b, u) => { u.flags['turn:spun'] = true; u.flags.spunUp = true },
      aiTarget: (_b, u) => (u.flying ? { ...u.pos } : null),
      aiScore: (b, u) => (u.flying && hostiles(b, u).some(h => b.distance(u, h) <= u.stats.speed) ? 1 : 0),
    })],
    onTurnEnd(b, u) {
      if (!u.flags.spunUp) return
      u.flags.spunUp = false
      if (!u.flying) return
      const t = hostiles(b, u).filter(h => b.distance(u, h) <= u.stats.speed && b.los(u, h)).sort((x, y) => b.distance(u, x) - b.distance(u, y))[0]
      if (t) { u.flags.supersonic = t.id; b.say(`${u.name} nominates ${t.name} (Supersonic).`) }
    },
    onAnyTurnEnd(b, self, u) {
      if (u.id !== self.flags.supersonic || self.destroyed) return
      self.flags.supersonic = undefined
      if (b.canSpend(self, 'reaction', 'supersonic') !== true) return
      let best: Pos | null = null
      for (let dy = -1; dy <= u.stats.size; dy++) for (let dx = -1; dx <= u.stats.size; dx++) {
        const p = { x: u.pos.x + dx, y: u.pos.y + dy }
        if (free(b, p, self) && (!best || chebyshev(p, self.pos) < chebyshev(best, self.pos))) best = p
      }
      if (!best) return
      b.spend(self, 'reaction', 'supersonic')
      const from = self.pos
      self.pos = best
      b.emit({ type: 'move', unitId: self.id, path: [from, best] })
      b.say(`${self.name} goes supersonic to ${u.name}!`)
    },
  },
  // ---------------- Bonded 2–3
  {
    id: 't_bonded:2', partial: true, note: 'Intercede: take damage meant for your adjacent Bondmate (Bondmate: the nearest allied mech)',
    modifyAnyIncoming(b, self, target, d) {
      if (d.kind !== 'hp' || d.amount < 3 || target !== bondmate(b, self) || !b.adjacent(self, target) || self.destroyed) return
      if (d.source && !b.los(self, d.source)) return
      if (self.hp + self.overshield <= d.amount && self.structure <= 1) return // not suicidally
      if (b.canSpend(self, 'reaction', 'intercede') !== true) return
      b.spend(self, 'reaction', 'intercede')
      const amount = d.amount
      d.amount = 0
      b.say(`${self.name} intercedes for ${target.name}!`, 'attack')
      b.applyDamage(self, [{ type: 'Kinetic', amount }], { source: d.source, irreducible: true })
    },
  },
  {
    id: 't_bonded:3', partial: true, note: 'Cover Me!: spend Overwatch when your Bondmate is attacked; the attacker presses on and you shoot first',
    beforeAnyAttack(b, self, ctx) {
      const mate = bondmate(b, self)
      if (!mate || ctx.target !== mate || !b.hostile(self, ctx.attacker) || ctx.attacker.destroyed || self.destroyed || !b.los(self, ctx.attacker)) return
      if (self.flags.coverMeBusy || b.canSpend(self, 'reaction', 'overwatch') !== true) return
      const w = b.bestThreatWeapon(self, ctx.attacker)
      if (!w) return
      b.spend(self, 'reaction', 'overwatch')
      self.flags.coverMeBusy = true
      b.say(`${self.name}: "Cover me!" — fires on ${ctx.attacker.name} first.`, 'attack')
      try { b.weaponAttack(self, w, { targetId: ctx.attacker.id }, 'overwatch') } finally { self.flags.coverMeBusy = false }
      if (ctx.attacker.destroyed) ctx.cancelled = true
    },
  },
  // ---------------- Centimane 3: Tidal Suppression (replaces Ten Thousand Teeth)
  {
    id: 't_centimane:3', partial: true, note: 'Tidal Suppression: 1/round on a Nexus crit, Systems save or Harrying (Impaired + Slowed) or Virulent (Shredded, spreading) swarm — chosen automatically',
    afterAttack(b, self, ctx, role) {
      if (role !== 'attacker' || !ctx.crit || ctx.weapon?.type !== 'Nexus' || ctx.target.destroyed || !once(self, 'tidal')) return
      const t = ctx.target
      if (b.save(t, 'sys', self.stats.save, 0, self)) return
      const near = chars(b).filter(o => o !== t && o !== self && b.hostile(self, o) && b.adjacent(o, t))
      if (near.length) {
        b.addStatus(t, 'shredded', 'next_turn_end_target', self)
        for (const o of near) if (!b.save(o, 'sys', self.stats.save, 0, self)) b.addStatus(o, 'shredded', 'next_turn_end_target', self)
        b.say('  Virulent swarm!')
      } else {
        b.addStatus(t, 'impaired', 'next_turn_end_target', self)
        b.addStatus(t, 'slowed', 'next_turn_end_target', self)
        b.say('  Harrying swarm!')
      }
    },
  },
  // ---------------- Exemplar 3: To the Death
  {
    id: 't_exemplar:3', partial: true, note: 'To the Death: duel your Mark: both take +3 difficulty attacking anyone else (paused for them after they attack you); no new marks (moving away is not restricted)',
    actions: (b, u) => {
      const mark = b.alive().find(o => o.flags.exemplarMarkBy === u.id)
      if (!mark || u.flags.duel) return []
      return [action({
        key: 'duel', name: 'Duel to the Death', activation: 'free', target: 'none', text: `Challenge ${mark.name} to a duel to the death.`,
        run: (bt, me) => { me.flags.duel = mark.id; bt.say(`${me.name} challenges ${mark.name} to a duel to the death!`, 'warn') },
        aiTarget: () => ({ ...mark.pos }),
        aiScore: (bt, me) => (bt.distance(me, mark) <= 3 ? 2 : 0),
      })]
    },
    onTurnStart(b, self) { const t = b.unit(self.flags.duel); if (t) t.flags.duelPaused = false },
    beforeAnyAttack(b, self, ctx) {
      const foe = b.unit(self.flags.duel)
      if (!foe || foe.destroyed) { self.flags.duel = undefined; return }
      if (ctx.attacker === self && ctx.target !== foe) { ctx.difficulty += 3; ctx.reasons.push('To the Death -3') }
      if (ctx.attacker === foe && ctx.target !== self && !foe.flags.duelPaused) { ctx.difficulty += 3; ctx.reasons.push('To the Death -3') }
      if (ctx.attacker === foe && ctx.target === self) foe.flags.duelPaused = true
    },
  },
  // ---------------- Grease Monkey 1, 3; Technophile 1–2 (no combat effect)
  narrative('t_grease_monkey:1', 'replenish Limited uses while resting (campaign rests already restore them)'),
  narrative('t_grease_monkey:3', 'once-per-mission supply drop while resting'),
  narrative('t_technophile:1', 'custom Servant-class NHP (personality only)'),
  narrative('t_technophile:2', 'custom Student-class NHP (personality only)'),
  // ---------------- Heavy Gunner 2–3 (implemented in Covering Fire, t_heavy_gunner:1)
  { id: 't_heavy_gunner:2', note: 'Hammerbeat: covering-fire hits Immobilize (handled by Covering Fire)' },
  { id: 't_heavy_gunner:3', note: 'Bracketing Fire: Covering Fire pins a second target (handled by Covering Fire)' },
  // ---------------- Infiltrator 1, 3
  { id: 't_infiltrator:1', note: 'Prowl: during your turn you stay Hidden in sight and out of cover, pass through enemies and can Hide in plain sight', init(u) { u.flags.prowl = true } },
  {
    id: 't_infiltrator:3', partial: true, note: 'Mastermind: on losing Hidden, flash an adjacent character (Systems save or blinded to adjacent spaces), then slip away up to your Speed (as a free action)',
    onStatusRemoved(b, self, status) {
      if (status !== 'hidden' || self.destroyed) return
      const t = hostiles(b, self).find(h => b.adjacent(self, h))
      if (t && !b.save(t, 'sys', self.stats.save, 0, self)) { t.flags.blindBy = self.id; t.flags.blindUntil = b.round + 1; b.say(`${self.name}'s flash bomb blinds ${t.name}!`) }
      self.flags.mastermindMove = true
    },
    beforeAnyAttack(b, self, ctx) {
      const a = ctx.attacker
      if (a.flags.blindBy === self.id && b.round <= a.flags.blindUntil && b.distance(a, ctx.target) > 1) { ctx.cancelled = true; b.say(`  ${a.name} is flash-blinded.`) }
    },
    actions: (_b, u) => (u.flags.mastermindMove ? [action({
      key: 'mastermind', name: 'Mastermind: slip away', activation: 'free', target: 'tile', range: u.stats.speed, text: 'Move up to your Speed, ignoring engagement and without provoking reactions.',
      run: (bt, me, t) => {
        const p = t && 'x' in t ? t : (t as Unit).pos
        me.flags.mastermindMove = false
        const was = me.flags['turn:disengaged']
        me.flags['turn:disengaged'] = true
        me.flags.pendingMove = me.stats.speed
        try { bt.move(me, p, { mode: 'free', ignoreEngagement: true }) } finally { me.flags['turn:disengaged'] = was; me.flags.pendingMove = undefined }
      },
      aiTarget: (bt, me) => {
        let best: Pos | null = null, bestD = -1
        for (const { pos } of bt.reachable(me, me.stats.speed, { ignoreEngagement: true }).values()) {
          const d = Math.min(...hostiles(bt, me).map(h => chebyshev(h.pos, pos)))
          if (d > bestD) { bestD = d; best = pos }
        }
        return best
      },
      aiScore: () => 2,
    })] : []),
    onTurnEnd(_b, u) { u.flags.mastermindMove = false },
  },
  // ---------------- Juggernaut 2–3
  {
    id: 't_juggernaut:2', note: 'Kinetic Mass Transfer: 1/round, Ram a target into a character (Hull save or Prone) or an obstruction (1d6 kinetic)',
    beforeAttack(_b, self, ctx, role) { if (role === 'attacker' && ctx.mode === 'ram') self.flags.ramFrom = { ...ctx.target.pos } },
    afterAttack(b, self, ctx, role) {
      if (role !== 'attacker' || ctx.mode !== 'ram' || !self.flags.ramFrom) return
      const from = self.flags.ramFrom as Pos
      self.flags.ramFrom = undefined
      const t = ctx.target
      if (!ctx.hit || t.destroyed || t.pos.x !== from.x || t.pos.y !== from.y || !once(self, 'kmt')) return
      // the knockback was stopped: by whom?
      const dir = { x: Math.sign(t.pos.x - self.pos.x), y: Math.sign(t.pos.y - self.pos.y) }
      const behind = { x: t.pos.x + dir.x * t.stats.size, y: t.pos.y + dir.y * t.stats.size }
      const other = chars(b).find(o => o !== t && footprint(o).some(q => q.x === behind.x && q.y === behind.y))
      if (other) { if (!b.save(other, 'hull', self.stats.save, 0, self)) b.addStatus(other, 'prone', 'until_cleared', self) }
      else b.applyDamage(t, [{ type: 'Kinetic', amount: rollDice(b.rng, '1d6').total }], { source: self })
    },
  },
  {
    id: 't_juggernaut:3', note: 'Unstoppable Force: boost your full speed in a straight line through same-size characters (Hull save or Prone) and walls (20 AP kinetic each), 1d3+3 heat',
    actions: (_b, u) => [action({
      key: 'unstoppable', name: 'Unstoppable Force (Boost)', activation: 'quick', target: 'tile', range: u.stats.speed,
      text: 'Boost in a straight line at full speed through characters your size or smaller; take 1d3+3 heat.',
      usable: (bt, me) => (me.flags['round:unstoppable'] ? 'Already used this round' : bt.canSpend(me, 'quick', 'boost')),
      run: (bt, me, t) => {
        const p = t && 'x' in t ? t : (t as Unit).pos
        me.flags['round:unstoppable'] = true
        me.flags['round:boosted'] = true
        const passed = charge(bt, me, p, me.stats.speed)
        for (const o of passed) if (!bt.save(o, 'hull', me.stats.save, 0, me)) bt.addStatus(o, 'prone', 'until_cleared', me)
        bt.addHeat(me, rollDice(bt.rng, '1d3+3').total)
      },
      aiTarget: (bt, me) => {
        const h = hostiles(bt, me).sort((x, y) => bt.distance(me, x) - bt.distance(me, y))[0]
        return h && bt.distance(me, h) > 2 && me.heat + 6 < me.stats.heatcap ? { ...h.pos } : null
      },
      aiScore: () => 1.5,
    })],
  },
  // ---------------- Leader 2–3 (Leadership dice are in t_leader:1)
  { id: 't_leader:2', note: 'Open Channels: 5 Leadership dice; orders any number of times (handled by Field Commander)' },
  {
    id: 't_leader:3', note: 'Inspiring Presence: 6 dice; allies holding a die can spend it to reduce incoming damage by 1d6',
    modifyAnyIncoming(b, self, target, d) {
      if (d.kind !== 'hp' || d.amount < 5 || b.hostile(self, target) || target === self || (self.flags.leaderDice ?? 0) <= 0) return
      if (target.flags[`scene:led:${self.id}`] || b.distance(self, target) > self.stats.sensors) return
      target.flags[`scene:led:${self.id}`] = true
      self.flags.leaderDice--
      const r = b.rng.d(6)
      d.amount = Math.max(0, d.amount - r)
      b.say(`  ${target.name} spends ${self.name}'s Leadership die: -${r} damage.`)
    },
  },
  // ---------------- Siege Specialist 1: Jackhammer
  {
    id: 't_siege_specialist:1', note: 'Jackhammer: 10 AP kinetic to an object or terrain section; characters adjacent to the impact are knocked back 2 and take 2 kinetic',
    actions: (b, u) => {
      const cannon = u.weapons.find(w => isWeaponType(w, 'Cannon') && !w.destroyed)
      if (!cannon) return []
      const range = Math.max(...b.profile(cannon).range.filter(r => r.type === 'Range').map(r => Number(r.val)), 5)
      return [action({
        key: 'jackhammer', name: 'Jackhammer Round', activation: 'quick', target: 'tile', range, text: '10 AP kinetic to an object; adjacent characters are knocked back 2 and take 2 kinetic.',
        run: (bt, me, t) => {
          const p = t && 'x' in t ? t : (t as Unit).pos
          bt.damageObjectsIn([p], 10, { source: me, ap: true })
          bt.emit({ type: 'area', tiles: [p], kind: 'explosion' })
          for (const o of chars(bt)) if (o !== me && footprint(o).some(q => chebyshev(q, p) === 1)) {
            bt.applyDamage(o, [{ type: 'Kinetic', amount: 2 }], { source: me })
            if (!o.destroyed) bt.forceMove(o, p, 2, 1)
          }
        },
        aiTarget: (bt, me) => {
          // hit a space next to a clump of hostiles
          let best: Pos | null = null, n = 0
          for (const h of hostiles(bt, me)) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const p = { x: h.pos.x + dx, y: h.pos.y + dy }
            if (!tileAt(bt.map, p) || chebyshev(p, me.pos) > range) continue
            const k = hostiles(bt, me).filter(o => footprint(o).some(q => chebyshev(q, p) === 1)).length
            if (k > n) { n = k; best = p }
          }
          return n >= 2 ? best : null
        },
        aiScore: () => 3,
      })]
    },
  },
  // ---------------- Spotter 2–3
  {
    id: 't_spotter:2', note: 'Panopticon: if you took Lock On and did not move, Lock On again at the end of your turn',
    onTurnEnd(b, self) {
      if (self.flags['turn:moved'] || !b.quickUsed(self, 'quick_tech:lock_on')) return
      const t = hostiles(b, self).filter(h => !b.has(h, 'lockon') && b.techTargetValid(self, h, 'lock_on') === true && b.distance(self, h) <= self.stats.sensors).sort((x, y) => b.distance(self, x) - b.distance(self, y))[0]
      if (t) { b.say(`${self.name} (Panopticon) locks on to ${t.name}.`); b.addStatus(t, 'lockon', 'until_cleared', self) }
    },
  },
  {
    id: 't_spotter:3', note: 'Bentham/Foucault Elimination: when you Lock On, an adjacent ally attacks the target at once as a reaction',
    onStatusInflicted(b, self, target, status) {
      if (status !== 'lockon' || !self.activeTurn || target.destroyed || !once(self, 'bentham', 'turn')) return
      for (const ally of chars(b).filter(a => a !== self && !b.hostile(self, a) && b.adjacent(self, a))) {
        if (b.canSpend(ally, 'reaction') !== true) continue
        const w = ally.weapons.find(x => !x.tech && b.weaponReady(ally, x) && b.validTarget(ally, x, target) === true)
        if (!w) continue
        ally.reactionsLeft--
        b.say(`${ally.name} fires on ${self.name}'s mark!`, 'attack')
        b.weaponAttack(ally, w, { targetId: target.id }, 'free')
        return
      }
    },
  },
  // ---------------- Stormbringer 3: Torrent
  {
    id: 't_stormbringer:3', note: 'Torrent: when the Torrent Die (lowered by Stormbending) reaches 1, make a Massive Attack (Agility save or 2d6 explosive, Stunned and Prone)',
    actions: (_b, u) => ((u.flags.torrent ?? 6) <= 1 ? [action({
      key: 'massive_attack', name: 'Massive Attack', activation: 'full', target: 'enemy', range: 15, text: 'Agility save or 2d6 explosive, Stunned and Prone; on a success, half damage and Prone.',
      run: (bt, me, t) => {
        const target = t as Unit
        if (!bt.los(me, target) || bt.distance(me, target) > 15) throw new Error('Needs line of sight and range 15')
        me.flags.torrent = 6
        const dmg = rollDice(bt.rng, '2d6').total
        if (bt.save(target, 'agi', me.stats.save, 0, me)) bt.applyDamage(target, [{ type: 'Explosive', amount: bt.halfOnSave(target, dmg) }], { source: me })
        else { bt.applyDamage(target, [{ type: 'Explosive', amount: dmg }], { source: me }); if (!target.destroyed) bt.addStatus(target, 'stunned', 'next_turn_end_target', me) }
        if (!target.destroyed) bt.addStatus(target, 'prone', 'until_cleared', me)
      },
      aiScore: (_bt, _me, t) => (t && 'id' in t ? 6 : 0),
    })] : []),
  },
])
