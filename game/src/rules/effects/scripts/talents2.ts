// Higher talent ranks that were previously resolved by hand.
import type { Battle } from '../../battle'
import { isWeaponType } from '../../stats'
import { chebyshev, footprint, tileAt } from '../../grid'
import { rollDice } from '../../rng'
import type { Pos, Unit } from '../../types'
import { bondmate } from './bond'
import { registerScripts, type CustomAction, type ItemScript } from '../registry'

const action = (a: Omit<CustomAction, 'usable'> & { usable?: CustomAction['usable'] }): CustomAction => ({ usable: () => true, ...a })
const chars = (b: Battle) => b.alive().filter(o => o.kind === 'mech' || o.kind === 'npc')
const hostiles = (b: Battle, u: Unit) => chars(b).filter(o => b.hostile(u, o))
const rank = (u: Unit, id: string) => u.talents.find(t => t.id === id)?.rank ?? 0
const once = (u: Unit, key: string, scope: 'round' | 'turn' | 'scene' = 'round') => { const k = `${scope}:${key}`; if (u.flags[k]) return false; u.flags[k] = true; return true }
const free = (b: Battle, p: Pos, except?: Unit) => !!tileAt(b.map, p) && !b.alive().some(o => o !== except && !o.flags.flat && footprint(o).some(q => q.x === p.x && q.y === p.y))
const narrative = (id: string, note: string): ItemScript => ({ id, note: `out of combat: ${note}` })

/** Bondmate: the nearest allied mech, fixed the first time it's needed this battle. */

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
    id: 't_ace:3', note: 'Supersonic: spin up your thrusters (quick); if you end your turn flying, nominate a character within your Speed and line of sight; when its turn ends you may fly to a free space next to it (reaction; there must be a path; ignores engagement and provokes nothing)',
    actions: () => [action({
      key: 'spin_up', name: 'Spin Up Thrusters', activation: 'quick', target: 'none', text: 'If you end your turn flying, nominate a character for the Supersonic reaction.',
      usable: (_b, u) => (u.flags['turn:spun'] ? 'Already spun up' : true),
      run: (_b, u) => { u.flags['turn:spun'] = true; u.flags.spunUp = true },
      aiTarget: (_b, u) => (u.flying ? { ...u.pos } : null),
      aiScore: (b, u) => (u.flying && hostiles(b, u).some(h => b.distance(u, h) <= u.stats.speed) ? 1 : 0),
    })],
    onTurnEnd(b, u) {
      if (!u.flags.spunUp) return
      u.flags.spunUp = false
      if (!u.flying) return
      const cands = chars(b).filter(h => h !== u && b.distance(u, h) <= u.stats.speed && b.los(u, h)).sort((x, y) => b.distance(u, x) - b.distance(u, y))
      if (!cands.length) return
      const def = Math.max(0, cands.findIndex(h => b.hostile(u, h)))
      const i = b.choose({ kind: 'supersonic', unit: u, title: 'Supersonic: nominate a character', options: [...cands.map(h => ({ label: h.name, hint: b.hostile(u, h) ? 'hostile' : 'ally' })), { label: 'Nobody' }], defaultIndex: def })
      if (i >= cands.length) return
      u.flags.supersonic = cands[i].id
      b.say(`${u.name} nominates ${cands[i].name} (Supersonic).`)
    },
    onAnyTurnEnd(b, self, u) {
      if (u.id !== self.flags.supersonic || self.destroyed) return
      self.flags.supersonic = undefined
      if (b.canSpend(self, 'reaction', 'supersonic') !== true) return
      const was = self.flying
      self.flying = true
      let best: { pos: Pos; cost: number } | null = null
      try {
        const r = b.reachable(self, 200, { ignoreEngagement: true })
        for (const n of r.values()) if (footprint(self).length && chebyshev(n.pos, u.pos) <= Math.max(1, Math.ceil(u.stats.size)) && b.adjacent({ ...self, pos: n.pos } as Unit, u) && (!best || n.cost < best.cost)) best = n
      } finally { self.flying = was }
      if (!best) return
      if (!b.offerReaction(self, 'supersonic', 'Supersonic?', `${u.name}'s turn ended. Fly to it?`)) return
      b.spend(self, 'reaction', 'supersonic')
      self.flying = true
      const p = b.pathTo(self, best.pos, 200, { ignoreEngagement: true })
      if (p) b.moveAlong(self, p.path)
      b.say(`${self.name} goes supersonic to ${u.name}!`)
    },
  },
  // ---------------- Bonded 2–3
  {
    id: 't_bonded:2', note: 'Sundance — Intercede (reaction): when your adjacent Bondmate takes damage from a source in your line of sight, you take it instead',
    modifyAnyIncoming(b, self, target, d) {
      if (d.kind !== 'hp' || d.amount <= 0 || target !== bondmate(b, self) || !b.adjacent(self, target) || self.destroyed) return
      // damage that is itself an Intercede can't be interceded back (two Bonded 2 pilots who are each other's Bondmate)
      if (target.flags.interceding) return
      if (d.source && !b.los(self, d.source)) return
      if (b.canSpend(self, 'reaction', 'intercede') !== true) return
      const sensible = d.amount >= 3 && !(self.hp + self.overshield <= d.amount && self.structure <= 1)
      if (!b.offerReaction(self, 'intercede', 'Intercede?', `${target.name} is about to take ${d.amount} damage. Take it instead?`, sensible)) return
      b.spend(self, 'reaction', 'intercede')
      const amount = d.amount
      d.amount = 0
      b.say(`${self.name} intercedes for ${target.name}!`, 'attack')
      self.flags.interceding = true
      try { b.applyDamage(self, [{ type: 'Kinetic', amount }], { source: d.source, irreducible: true }) } finally { delete self.flags.interceding }
    },
  },
  {
    id: 't_bonded:3', note: 'Cover Me!: when a character in your line of sight attacks your Bondmate, spend your Overwatch to threaten it — it either picks a different target (your Overwatch is spent for nothing) or attacks anyway and you attack it first with Overwatch (range and line of sight permitting)',
    beforeAnyAttack(b, self, ctx) {
      const mate = bondmate(b, self)
      if (!mate || ctx.target !== mate || !b.hostile(self, ctx.attacker) || ctx.attacker.destroyed || self.destroyed || !b.los(self, ctx.attacker)) return
      if (b.previewing || self.flags.coverMeBusy || ctx.mode === 'secondary' || b.canSpend(self, 'reaction', 'overwatch') !== true) return
      const w = b.bestThreatWeapon(self, ctx.attacker) ?? self.weapons.find(x => !x.tech && b.weaponUsable(self, x, false) === true && b.validTarget(self, x, ctx.attacker) === true)
      if (!b.offerReaction(self, 'cover_me', 'Cover Me!', `${ctx.attacker.name} is about to attack ${mate.name}. Spend your Overwatch to threaten it?`)) return
      b.spend(self, 'reaction', 'overwatch')
      const a = ctx.attacker
      // the attacker decides: switch targets, or press on and take the shot first
      const others = b.alive().filter(o => o !== mate && o !== a && (o.kind === 'mech' || o.kind === 'npc') && b.hostile(a, o) && (!ctx.weapon || b.validTarget(a, ctx.weapon, o) === true))
      const opts = [{ label: 'Attack anyway', hint: w ? `${self.name} shoots first` : `${self.name} can't reach you` }, ...others.map(o => ({ label: `Switch to ${o.name}` }))]
      const i = b.choose({ kind: 'cover_me_answer', unit: a, title: `${self.name} threatens you`, text: 'Attack anyway, or pick a different target?', options: opts, defaultIndex: !w || a.hp > a.stats.hp / 2 || !others.length ? 0 : 1 })
      if (i > 0) { ctx.target = others[i - 1]; b.say(`  ${a.name} switches to ${others[i - 1].name}.`); return }
      if (!w) return
      self.flags.coverMeBusy = true
      b.say(`${self.name}: "Cover me!" — fires on ${a.name} first.`, 'attack')
      try { b.weaponAttack(self, w, { targetId: a.id }, 'overwatch') } finally { self.flags.coverMeBusy = false }
      if (a.destroyed) ctx.cancelled = true
    },
  },
  // ---------------- Centimane 3: Tidal Suppression (replaces Ten Thousand Teeth)
  {
    id: 't_centimane:3', note: 'Tidal Suppression: 1/round on a Nexus crit the target saves (Systems) or you pick, until the end of its next turn: Harrying (Impaired and Slowed), Blinding (line of sight to adjacent spaces only), Virulent (Shredded; adjacent characters you choose save or are Shredded too) or Restricting (1 burn each time it takes an action or reaction)',
    afterAttack(b, self, ctx, role) {
      if (role !== 'attacker' || !ctx.crit || !isWeaponType(ctx.weapon, 'Nexus') || ctx.target.destroyed || !once(self, 'tidal')) return
      const t = ctx.target
      if (b.save(t, 'sys', self.stats.save, 0, self)) return
      const near = chars(b).filter(o => o !== t && o !== self && b.adjacent(o, t))
      const i = b.choose({ kind: 'tidal', unit: self, title: 'Tidal Suppression', text: `${t.name} failed its save. Choose the swarm:`, options: [{ label: 'Harrying', hint: 'Impaired and Slowed' }, { label: 'Blinding', hint: 'sees only adjacent spaces' }, { label: 'Virulent', hint: `Shredded${near.length ? `; ${near.length} adjacent may be too` : ''}` }, { label: 'Restricting', hint: '1 burn per action or reaction' }], defaultIndex: near.some(o => b.hostile(self, o)) ? 2 : 0 })
      if (i === 0) { b.addStatus(t, 'impaired', 'next_turn_end_target', self); b.addStatus(t, 'slowed', 'next_turn_end_target', self) }
      else if (i === 1) { t.flags.blindUntil = b.round + 1; b.say(`  ${t.name} is blinded by the swarm.`, 'status') }
      else if (i === 2) {
        b.addStatus(t, 'shredded', 'next_turn_end_target', self)
        for (const o of near) {
          const yes = b.choose({ kind: 'virulent', unit: self, title: `Virulent swarm: spread to ${o.name}?`, options: [{ label: 'Yes' }, { label: 'No' }], defaultIndex: b.hostile(self, o) ? 0 : 1 }) === 0
          if (yes && !b.save(o, 'sys', self.stats.save, 0, self)) b.addStatus(o, 'shredded', 'next_turn_end_target', self)
        }
      } else { t.flags.restricting = { by: self.id, turns: t.activeTurn ? 2 : 1 }; b.say(`  ${t.name} is wrapped in a restricting swarm.`, 'status') }
    },
    onAnyAction(b, self, actor) { if (actor.flags.restricting?.by === self.id && !actor.destroyed) b.applyDamage(actor, [{ type: 'Burn', amount: 1 }], { source: self }) },
    onAnyTurnEnd(b, self, u) { const r = u.flags.restricting; if (r?.by === self.id && --r.turns <= 0) delete u.flags.restricting },
  },
  // ---------------- Exemplar 3: To the Death
  {
    id: 't_exemplar:3', note: 'To the Death: duel your Mark for the scene: both take +3 difficulty attacking anyone else (paused for it until your next turn after it attacks you); you can\'t voluntarily move away from it and can\'t mark anyone else',
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
    validateMove(b, self, dest) {
      const foe = b.unit(self.flags.duel)
      if (!foe || foe.destroyed) return true
      return b.distance({ ...self, pos: dest } as Unit, foe) > b.distance(self, foe) ? 'To the Death: you cannot move away from your Mark' : true
    },
    beforeAnyAttack(b, self, ctx) {
      const foe = b.unit(self.flags.duel)
      if (!foe || foe.destroyed) { self.flags.duel = undefined; return }
      if (ctx.attacker === self && ctx.target !== foe) { ctx.difficulty += 3; ctx.reasons.push('To the Death -3') }
      if (ctx.attacker === foe && ctx.target !== self && !foe.flags.duelPaused) { ctx.difficulty += 3; ctx.reasons.push('To the Death -3') }
      if (ctx.attacker === foe && ctx.target === self) foe.flags.duelPaused = true
    },
  },
  // ---------------- Grease Monkey 1, 3; Technophile 1–2 (no combat effect)
  narrative('t_grease_monkey:1', 'field repairs offer "spend 2 Repairs: +1 use of every Limited item" (run.ts repairOptions)'),
  narrative('t_grease_monkey:3', 'field repairs offer a free supply drop once per Full Repair: every mech +1 Limited use and +1 Structure (run.ts repairOptions)'),
  narrative('t_technophile:1', 'custom Servant-class NHP (personality only)'),
  {
    id: 't_technophile:2', note: 'Student-Class NHP (Enlightenment-Class at rank 3) — NHP Assistance: 1/round, reroll a mech skill check or save (the new result stands; offered when it fails)',
    rerollFailed(b, self, kind, stat) {
      if (self.flags['round:nhpAssist'] || self.destroyed) return false
      if (b.choose({ kind: 'nhp_assistance', unit: self, title: 'NHP Assistance?', text: `Your ${stat.toUpperCase()} ${kind} failed. Reroll it (1/round; the new result stands)?`, options: [{ label: 'Reroll' }, { label: 'Keep it' }], defaultIndex: 0 }) !== 0) return false
      self.flags['round:nhpAssist'] = true
      return true
    },
  },
  // ---------------- Heavy Gunner 2–3 (implemented in Covering Fire, t_heavy_gunner:1)
  { id: 't_heavy_gunner:2', note: 'Hammerbeat: covering-fire hits Immobilize (handled by Covering Fire)' },
  { id: 't_heavy_gunner:3', note: 'Bracketing Fire: Covering Fire pins a second target (handled by Covering Fire)' },
  // ---------------- Infiltrator 1, 3
  { id: 't_infiltrator:1', note: 'Prowl: during your turn you stay Hidden in sight and out of cover, pass through enemies and can Hide in plain sight', init(u) { u.flags.prowl = true } },
  {
    id: 't_infiltrator:3', note: 'Mastermind: when you lose Hidden, first flash an adjacent character of your choice (Systems save or it sees only adjacent spaces until the end of its next turn), then move up to your Speed ignoring engagement and without provoking reactions',
    onStatusRemoved(b, self, status) {
      if (status !== 'hidden' || self.destroyed || self.flags.mastermindBusy) return
      self.flags.mastermindBusy = true
      try {
        const adj = chars(b).filter(o => o !== self && b.adjacent(self, o))
        if (adj.length) {
          const i = b.choose({ kind: 'mastermind_flash', unit: self, title: 'Mastermind: flash bomb', options: [...adj.map(o => ({ label: o.name, hint: b.hostile(self, o) ? 'hostile' : 'ally' })), { label: 'No flash' }], defaultIndex: Math.max(0, adj.findIndex(o => b.hostile(self, o))) })
          const t = adj[i]
          if (t && !b.save(t, 'sys', self.stats.save, 0, self)) { t.flags.blindUntil = b.round + 1; b.say(`${self.name}'s flash bomb blinds ${t.name}!`) }
        }
        if (b.has(self, 'immobilized') || b.has(self, 'stunned')) return
        const r = b.reachable(self, self.stats.speed, { ignoreEngagement: true })
        const far = (p: Pos) => Math.min(99, ...hostiles(b, self).map(h => chebyshev(h.pos, p)))
        const spots = [...r.values()].filter(n => n.cost > 0)
        if (!spots.length) return
        const away = spots.reduce((x, y) => (far(y.pos) > far(x.pos) ? y : x))
        const cover = spots.filter(n => b.alive().some(o => o.flags.isCover && chebyshev(o.pos, n.pos) <= 1) || footprint({ ...self, pos: n.pos } as Unit).some(p => [[0, 1], [1, 0], [0, -1], [-1, 0]].some(([dx, dy]) => b.map.tiles[(p.y + dy) * b.map.w + p.x + dx]?.kind === 'block'))).sort((x, y) => far(y.pos) - far(x.pos))[0]
        const opts = [{ label: 'Slip away', hint: `farthest from hostiles (${away.pos.x},${away.pos.y})`, to: away.pos }, ...(cover ? [{ label: 'Into cover', hint: `next to terrain (${cover.pos.x},${cover.pos.y})`, to: cover.pos }] : []), { label: 'Stay', hint: '', to: null as Pos | null }]
        const k = b.choose({ kind: 'mastermind_move', unit: self, title: 'Mastermind: move', options: opts.map(o => ({ label: o.label, hint: o.hint })), defaultIndex: 0 })
        const to = opts[k].to
        if (!to) return
        const p = b.pathTo(self, to, self.stats.speed, { ignoreEngagement: true })
        if (p) { b.say(`${self.name} slips away.`); b.moveAlong(self, p.path) }
      } finally { delete self.flags.mastermindBusy }
    },
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
        me.flags.momentum = true // it is a Boost: Momentum (Juggernaut 1) arms the next Ram
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
  {
    id: 't_leader:2', note: 'Open Channels: 5 Leadership Dice; at the start of any other allied pilot\'s turn you may issue a command as a reaction (any number of times per round), handing it a Leadership Die',
    onAnyTurnStart(b, self, u) {
      if (u === self || u.kind !== 'mech' || b.hostile(self, u) || u.flags.leaderDie || (self.flags.leaderDice ?? 0) <= 0 || self.destroyed) return
      if (b.canSpend(self, 'reaction') !== true) return
      if (!b.offerReaction(self, 'open_channels', 'Open Channels?', `${u.name} starts its turn. Issue a command and give it a Leadership Die (${self.flags.leaderDice} left)?`)) return
      b.spend(self, 'reaction') // no per-round limit: "any number of times per round"
      self.flags.leaderDice--
      u.flags.leaderDie = self.id
      b.say(`${self.name} issues a command to ${u.name} (Open Channels).`)
    },
  },
  {
    id: 't_leader:3', note: 'Inspiring Presence: 6 dice; an ally holding your Leadership Die can expend it to reduce damage it takes by 1d6, or to deal +1d6 bonus damage when it hits with an attack',
    afterAnyRoll(b, self, ctx) {
      const a = ctx.attacker
      if (a.flags.leaderDie !== self.id || !ctx.hit || ctx.target.destroyed || !b.hostile(a, ctx.target)) return
      if (b.choose({ kind: 'leader_damage', unit: a, title: 'Spend the Leadership Die?', text: `+1d6 bonus damage on this hit (${self.name}'s Inspiring Presence).`, options: [{ label: 'Spend it (+1d6 damage)' }, { label: 'Keep it' }], defaultIndex: ctx.crit ? 0 : 1 }) !== 0) return
      delete a.flags.leaderDie
      ctx.bonusDamage.push({ type: ctx.profile?.damage[0]?.type ?? 'Kinetic', val: '1d6' })
      ctx.reasons.push(`${self.name}'s Leadership Die +1d6`)
    },
    modifyAnyIncoming(b, self, target, d) {
      if (d.kind !== 'hp' || d.amount <= 0 || target.flags.leaderDie !== self.id || target.destroyed) return
      if (b.choose({ kind: 'leader_shield', unit: target, title: 'Spend the Leadership Die?', text: `Reduce ${d.amount} incoming damage by 1d6 (${self.name}'s Inspiring Presence).`, options: [{ label: 'Spend it (-1d6 damage)' }, { label: 'Keep it' }], defaultIndex: d.amount >= 5 || d.amount >= target.hp + target.overshield ? 0 : 1 }) !== 0) return
      delete target.flags.leaderDie
      const r = b.rng.d(6)
      d.amount = Math.max(0, d.amount - r)
      b.say(`  ${target.name} spends ${self.name}'s Leadership Die: -${r} damage.`)
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
          // hit a space next to a clump of hostiles, and never next to an ally (they take the 2 kinetic and knockback too)
          let best: Pos | null = null, n = 0
          const near = (o: Unit, p: Pos) => footprint(o).some(q => chebyshev(q, p) === 1)
          for (const h of hostiles(bt, me)) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const p = { x: h.pos.x + dx, y: h.pos.y + dy }
            if (!tileAt(bt.map, p) || chebyshev(p, me.pos) > range) continue
            if (chars(bt).some(o => o !== me && !bt.hostile(me, o) && near(o, p))) continue
            const k = hostiles(bt, me).filter(o => near(o, p)).length
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
    id: 't_spotter:3', note: 'Bentham/Foucault Elimination: when you Lock On (part of that quick action), you may nominate an adjacent ally: it may at once take a quick action as a reaction (an attack with one weapon, or Invade), consuming the target\'s Lock On',
    onStatusInflicted(b, self, target, status) {
      if (status !== 'lockon' || !self.activeTurn || target.destroyed || !b.hostile(self, target) || self.flags.benthamBusy) return
      const allies = chars(b).filter(a => a !== self && !b.hostile(self, a) && b.adjacent(self, a) && b.canSpend(a, 'reaction') === true)
      if (!allies.length) return
      const weaponOf = (a: Unit) => a.weapons.find(x => !x.tech && b.weaponReady(a, x) && b.weaponUsable(a, x, false) === true && b.validTarget(a, x, target) === true)
      const def = allies.findIndex(a => !!weaponOf(a))
      const i = b.choose({ kind: 'bentham', unit: self, title: 'Bentham/Foucault Elimination', text: `Nominate an adjacent ally to act on ${target.name}'s Lock On.`, options: [...allies.map(a => ({ label: a.name })), { label: 'Nobody' }], defaultIndex: def >= 0 ? def : allies.length })
      const ally = allies[i]
      if (!ally) return
      // the ally picks its quick action
      const ws = ally.weapons.filter(x => !x.tech && b.weaponReady(ally, x) && b.weaponUsable(ally, x, false) === true && b.validTarget(ally, x, target) === true)
      const canInvade = b.techTargetValid(ally, target, 'invade') === true
      const opts: { label: string; run: () => void }[] = [
        ...ws.map(w => ({ label: `Skirmish: ${w.name}`, run: () => { b.weaponAttack(ally, w, { targetId: target.id }, 'free') } })),
        ...(canInvade ? [{ label: 'Invade (Fragment Signal)', run: () => { b.withFreeTech(ally, () => b.invade(ally, target)) } }] : []),
        { label: 'No action', run: () => {} },
      ]
      const k = b.choose({ kind: 'bentham_action', unit: ally, title: `${self.name}'s mark: take a quick action`, options: opts.map(o => ({ label: o.label })), defaultIndex: 0 })
      if (k === opts.length - 1) return
      b.spend(ally, 'reaction') // through spend(): reveals Hidden, ends Ghostweave, runs onAnyAction hooks
      b.say(`${ally.name} acts on ${self.name}'s mark!`, 'attack')
      self.flags.benthamBusy = true
      try { opts[k].run() } finally { delete self.flags.benthamBusy }
      if (b.has(target, 'lockon')) b.removeStatus(target, 'lockon') // the action consumes the Lock On either way
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
