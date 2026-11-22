// Frame traits (`frame:<id>`) and CORE systems (`core:<id>`) for the 29 core-book frames.
import { blastTiles, burstTiles, unitsOnTiles } from '../../grid'
import { rollDice } from '../../rng'
import type { Pos, Unit } from '../../types'
import type { Battle } from '../../battle'
import { registerScripts, type CustomAction, type ItemScript } from '../registry'

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
    note: 'Grapple Cable (range 5 grapple, pull adjacent); Lock/Kill (boost & react while grappling)',
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
        bt.addStatus(target, 'grappled', 'until_cleared', self, { by: self.id })
        bt.addStatus(self, 'grappled', 'until_cleared', self, { by: self.id, with: target.id })
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
        if (b.save(t, 'hull', u.stats.save)) { if (!t.isGrunt) b.applyDamage(t, [{ type: 'Kinetic', amount: Math.ceil(dmg / 2) }], { source: u }) }
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
    modifyIncoming: (b, self, d) => { if (isAoEAttack(b, d)) d.amount = Math.ceil(d.amount / 2) },
  },
  {
    id: 'core:mf_drake',
    partial: true,
    note: 'Fortress Protocol: immobilized, always in hard cover, immune to forced movement/prone (cover sections not modelled)',
    onCoreActivate(b, u) {
      u.flags.fortress = true
      b.addStatus(u, 'immobilized', 'until_cleared', u, { fortress: true })
      u.immune.push('prone')
    },
    adjustCover: (b, self, attacker, target, c) => (target === self && self.flags.fortress ? 'hard' : c),
    canBeMoved: (b, self) => !self.flags.fortress,
  },
  // ---------------- IPS-N Lancaster
  {
    id: 'frame:mf_lancaster',
    note: 'Insulated, Combat Repair',
    init: u => { u.immune.push('burn') },
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
    note: 'Supercharger: ally gains +1 accuracy and immunities; you take 1 heat each turn',
    onCoreActivate(b, u) {
      const ally = alliesWithin(b, u, 5).filter(a => a.kind === 'mech').sort((x, y) => y.stats.attackBonus - x.stats.attackBonus)[0] ?? u
      u.flags.superchargeTarget = ally.id
      ally.bonuses.push({ id: 'attack', accuracy: 1 }, { id: 'check', accuracy: 1 }, { id: 'save', accuracy: 1 })
      ally.immune.push('impaired', 'jammed', 'slowed', 'shredded', 'immobilized')
      b.say(`${ally.name} is supercharged.`)
    },
    onTurnStart: (b, u) => { if (u.flags.superchargeTarget) b.addHeat(u, 1) },
  },
  // ---------------- IPS-N Nelson
  {
    id: 'frame:mf_nelson',
    note: 'Momentum (+1d6 melee after boost, 1/round), Skirmisher step after attacking',
    beforeAttack(b, self, ctx, role) {
      if (role === 'attacker' && ctx.melee && self.flags['round:boosted'] && once(self, 'momentum')) {
        ctx.bonusDamage.push({ type: 'Kinetic', val: '1d6' })
        ctx.reasons.push('Momentum +1d6')
      }
    },
    actions: (b, u) => u.flags['turn:attacked'] ? [action({
      key: 'nelson-skirmisher', name: 'Skirmisher Step', activation: 'free', target: 'tile', range: u.flags.engageDrive ? 4 : 1,
      text: `Move ${u.flags.engageDrive ? 4 : 1} space(s); ignores engagement and doesn't provoke reactions.`,
      usable: (bt, self) => (self.flags['turn:stepped'] ? 'Already used' : bt.has(self, 'immobilized') || bt.has(self, 'slowed') ? 'Slowed/immobilized' : true),
      run: (bt, self, t) => {
        const p = t as Pos
        self.flags['turn:stepped'] = true
        self.flags.pendingMove = self.flags.engageDrive ? 4 : 1
        self.flags['turn:disengaged'] = true
        try { bt.move(self, p, { mode: 'free', ignoreEngagement: true }) } finally { delete self.flags.pendingMove; delete self.flags['turn:disengaged'] }
      },
    })] : [],
  },
  { id: 'core:mf_nelson', note: 'Engage Drive', onCoreActivate: (b, u) => { u.flags.engageDrive = true } },
  // ---------------- IPS-N Raleigh
  {
    id: 'frame:mf_raleigh',
    note: 'Full Metal Jacket (auto reload if no attacks), Shielded Magazines',
    init: u => { u.flags.shieldedMagazines = true },
    onTurnEnd(b, u) {
      if (u.flags['turn:attacked']) return
      const ws = u.weapons.filter(w => !w.loaded && !w.destroyed)
      if (ws.length) { ws.forEach(w => (w.loaded = true)); b.say(`${u.name} reloads (Full Metal Jacket).`) }
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
    note: 'Hyper-Reflex Mode',
    onCoreActivate(b, u) { u.flags.hyperReflex = true; u.reactionsPerRound++; u.reactionsLeft++ },
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
    modifyIncoming: (b, self, d) => { if (self.flags.tormentor && d.source && b.distance(self, d.source) <= 3) d.amount = Math.ceil(d.amount / 2) },
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
      self.reactionsLeft--
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
    note: 'Neural Shunt: Mark for Death (focus target 6-30 away; +1d6/2d6/3d6 on ranged crits, immobilized while focusing)',
    actions: (b, u) => u.coreActive ? [action({
      key: 'dh-mark', name: 'Mark for Death', activation: 'full', target: 'enemy', range: 30,
      text: 'Focus on a target 6-30 spaces away: ranged crits deal bonus damage by weapon size; you are Immobilized and can\'t react while focusing.',
      run: (bt, self, t) => {
        const target = t as Unit
        if (bt.distance(self, target) <= 5) throw new Error('Target must be further than range 5')
        self.flags.markTarget = target.id
        bt.addStatus(self, 'immobilized', 'until_cleared', self, { mark: true })
        self.reactionsLeft = 0
      },
    })] : [],
    beforeAttack(b, self, ctx, role) {
      if (role !== 'attacker' || self.flags.markTarget !== ctx.target.id || !ctx.ranged || !ctx.weapon) return
      if (b.cover(self, ctx.target) !== 'none') return
      const die = ctx.weapon.size === 'Auxiliary' ? '1d6' : ctx.weapon.size === 'Main' ? '2d6' : '3d6'
      ctx.reasons.push(`Marked (crit +${die})`)
    },
    afterAttack(b, self, ctx, role) {
      if (role === 'attacker' && ctx.crit && self.flags.markTarget === ctx.target.id && ctx.weapon && !ctx.target.destroyed) {
        const die = ctx.weapon.size === 'Auxiliary' ? '1d6' : ctx.weapon.size === 'Main' ? '2d6' : '3d6'
        b.applyDamage(ctx.target, [{ type: ctx.profile?.damage[0]?.type ?? 'Kinetic', amount: rollDice(b.rng, die, { crit: true }).total }], { source: self })
      }
    },
  },
  // ---------------- SSC Dusk Wing
  {
    id: 'frame:mf_dusk_wing',
    note: 'Maneuverability Jets (hover), Harlequin Cloak (invisible on own turn)',
    init: u => { u.flying = true },
    onTurnStart: (b, u) => { b.addStatus(u, 'invisible', 'end_of_turn', u) },
  },
  // ---------------- SSC Metalmark
  {
    id: 'frame:mf_metalmark',
    note: 'Flash Cloak (invisible vs reactions while moving), Carapace Adaptation',
    beforeAttack(b, self, ctx, role) {
      if (role !== 'target') return
      if (ctx.mode === 'overwatch') ctx.forceInvisible = true
      if (ctx.ranged && ctx.reasons.includes('Soft cover -1')) { ctx.difficulty++; ctx.reasons.push('Carapace -1') }
    },
  },
  { id: 'core:mf_metalmark', note: 'Tactical Cloak', onCoreActivate: (b, u) => { b.addStatus(u, 'invisible', 'scene', u) } },
  // ---------------- SSC Monarch
  {
    id: 'frame:mf_monarch',
    note: 'Avenger Silos, Seeking Payload',
    beforeAttack(b, self, ctx, role) {
      if (role === 'attacker' && ctx.weapon?.type === 'Launcher' && b.has(ctx.target, 'lockon')) {
        ctx.ignoreCover = true
        ctx.irreducible = true
        ctx.difficulty = Math.max(0, ctx.difficulty - (ctx.reasons.includes('Hard cover -2') ? 2 : ctx.reasons.includes('Soft cover -1') ? 1 : 0))
        ctx.reasons.push('Seeking Payload')
        b.removeStatus(ctx.target, 'lockon')
      }
    },
    afterAttack(b, self, ctx, role) {
      if (role !== 'attacker' || !ctx.crit || !ctx.ranged || !once(self, 'avenger')) return
      const t = hostilesWithin(b, self, 15).find(o => o !== ctx.target && b.los(self, o))
      if (t) { b.say(`${self.name}'s Avenger Silos fire!`); b.applyDamage(t, [{ type: 'Explosive', amount: 3 }], { source: self }) }
    },
  },
  {
    id: 'core:mf_monarch',
    note: 'Divine Punishment',
    onCoreActivate(b, u) {
      for (const t of hostilesWithin(b, u, 50)) {
        const dmg = rollDice(b.rng, '1d6+4').total
        const ok = b.save(t, 'agi', u.stats.save)
        if (ok && t.isGrunt) continue
        b.applyDamage(t, [{ type: 'Explosive', amount: ok ? Math.ceil(dmg / 2) : dmg }], { source: u })
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
      if (!others.length && once(self, 'hunter')) { ctx.bonusDamage.push({ type: 'Kinetic', val: '1d6' }); ctx.reasons.push('Hunter +1d6') }
    },
  },
  {
    id: 'core:mf_mourning_cloak',
    partial: true,
    note: 'Blinkspace Jump (teleport 3d6); Stabilize Singularity (teleporting moves: ignore engagement)',
    actions: (b, u) => [action({
      key: 'mc-blink', name: 'Blinkspace Jump', activation: 'full', target: 'tile', range: 18,
      text: 'Teleport to a space within range 3d6 (rolled). Occupied space: you stay put. Triples: you vanish until the end of the scene.',
      run: (bt, self, t) => {
        const p = t as Pos
        const dice = [bt.rng.d(6), bt.rng.d(6), bt.rng.d(6)]
        const r = dice[0] + dice[1] + dice[2]
        bt.say(`  Blinkspace range ${r} [${dice.join(',')}]`)
        if (dice[0] === dice[1] && dice[1] === dice[2]) { bt.say(`${self.name} vanishes into blinkspace!`); bt.destroy(self, 'lost in blinkspace'); return }
        const d = Math.max(Math.abs(p.x - self.pos.x), Math.abs(p.y - self.pos.y))
        if (d > r) { bt.say('  Out of range: the jump fails.'); return }
        const occupied = bt.alive().some(o => o !== self && o.pos.x === p.x && o.pos.y === p.y)
        if (occupied) { bt.say('  Occupied: the jump fails.'); return }
        self.pos = p
        bt.emit({ type: 'move', unitId: self.id, path: [p] })
      },
    })],
  },
  // ---------------- SSC Swallowtail
  {
    id: 'frame:mf_swallowtail',
    note: 'Integrated Cloak, Prophetic Scanners',
    onTurnEnd(b, u) { if (!u.flags['turn:moved']) b.addStatus(u, 'invisible', 'start_of_next_turn_target', u) },
    onStatusInflicted(b, self, t, st) { if (st === 'lockon' && once(self, 'prophetic')) b.addStatus(t, 'shredded', 'next_turn_end_target', self) },
  },
  {
    id: 'core:mf_swallowtail',
    note: 'Prophetic Interjection: Tactical Simulation reaction (auto, 1/round)',
    onCoreActivate: (b, u) => { u.flags.tacSim = true },
    afterAnyRoll(b, self, ctx) {
      if (!self.flags.tacSim || !ctx.hit || b.hostile(self, ctx.target) || b.distance(self, ctx.target) > self.stats.sensors) return
      if (b.canSpend(self, 'reaction') !== true || !once(self, 'tacsim')) return
      self.reactionsLeft--
      const r = b.rng.d(6)
      b.say(`${self.name}: Tactical Simulation (${r}).`)
      if (r >= 4) ctx.resistAll = true
    },
  },
  // ---------------- HORUS Balor
  {
    id: 'frame:mf_balor',
    note: 'Scouring Swarm, Regeneration',
    onAnyTurnStart(b, self, u) {
      if (!b.hostile(self, u) || (u.kind !== 'mech' && u.kind !== 'npc')) return
      if (b.adjacent(self, u)) b.applyDamage(u, [{ type: 'Kinetic', amount: self.flags.hiveFrenzy ? 4 : 2 }], { source: self })
    },
    onStructureDamage: (b, u) => { u.flags.noRegenRound = b.round + 1 },
    onHeat: (b, u) => { if (u.heat > u.stats.heatcap) u.flags.noRegenRound = b.round + 1 },
    onTurnEnd(b, u) {
      if (u.flags.noRegenRound && b.round <= u.flags.noRegenRound) return
      b.heal(u, Math.floor(u.stats.hp / (u.flags.hiveFrenzy ? 2 : 4)))
    },
  },
  {
    id: 'core:mf_balor',
    note: 'Hive Frenzy',
    onCoreActivate(b, u) { u.flags.hiveFrenzy = true; b.addStatus(u, 'shredded', 'scene', u) },
    adjustCover: (b, self, attacker, target, c) => (self.flags.hiveFrenzy && (target === self || (!b.hostile(self, target) && b.adjacent(self, target))) && c === 'none' ? 'soft' : c),
    onStructureDamage(b, u) {
      if (!u.flags.hiveFrenzy) return
      if (b.rng.d(6) === 6) { u.structure++; u.hp = 1; b.say(`${u.name} hellishly pulls itself together!`) }
    },
  },
  // ---------------- HORUS Goblin
  {
    id: 'frame:mf_goblin',
    partial: true,
    note: 'Liturgicode & Fragile via bonuses; Reactive Code (auto: copy a tech action used on an ally, approximated as +1 accuracy to next tech)',
    afterAttack(b, self, ctx, role) { if (role === 'target' && ctx.tech && b.canSpend(self, 'reaction') === true && once(self, 'reactive')) { self.reactionsLeft--; self.flags.reactiveCode = true } },
    beforeAttack(b, self, ctx, role) { if (role === 'attacker' && ctx.tech && self.flags.reactiveCode) { ctx.accuracy++; delete self.flags.reactiveCode } },
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
      if (!b.save(ctx.attacker, 'sys', self.stats.save)) {
        ctx.attacker.flags[`basilisk:${self.id}`] = true
        b.addStatus(ctx.attacker, 'stunned', 'next_turn_end_target', self)
        ctx.cancelled = true
      }
    },
  },
  // ---------------- HORUS Manticore
  {
    id: 'frame:mf_manticore',
    note: 'Slag Carapace; Unstable System (explodes when destroyed)',
    init: u => { u.resist.push('Energy', 'Burn') },
    onDestroyed(b, self, victim) {
      if (victim !== self || self.flags.exploded) return
      self.flags.exploded = true
      self.destroyed = false
      b.reactorExplosion(self, 'unstable system')
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
      if (u.flags.chargeDie) {
        u.flags.chargeDie++
        b.say(`${u.name} charge die: ${Math.min(6, u.flags.chargeDie)}`)
        if (u.flags.chargeDie >= 6) {
          u.flags.chargeDie = 1
          const tiles = burstTiles(b.map, u, 2)
          b.emit({ type: 'area', tiles, kind: 'explosion' })
          for (const t of unitsOnTiles(b.alive(), tiles)) if (t !== u) {
            const dmg = rollDice(b.rng, '6d6').total
            const ok = b.save(t, 'eng', u.stats.save)
            if (ok && t.isGrunt) continue
            b.applyDamage(t, [{ type: 'Energy', amount: ok ? Math.ceil(dmg / 2) : dmg }], { source: u, ap: true })
          }
        }
      }
    },
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
    note: 'Maze',
    actions: (b, u) => [],
    onCoreActivate(b, u) {
      const t = hostilesWithin(b, u, u.stats.sensors).filter(t => b.los(u, t)).sort((x, y) => (y.flags.budget ?? 1) - (x.flags.budget ?? 1))[0]
      if (!t) return
      b.addStatus(t, 'stunned', 'until_cleared', u, { maze: true })
      t.flags.mazeAcc = -3
    },
    onAnyTurnEnd(b, self, u) {
      const s = u.statuses.find(s => s.id === 'stunned' && s.data?.maze && s.source === self.id)
      if (!s) return
      if (b.save(u, 'sys', self.stats.save, u.flags.mazeAcc ?? -3)) b.removeStatus(u, 'stunned')
      else u.flags.mazeAcc = (u.flags.mazeAcc ?? -3) + 1
    },
  },
  // ---------------- HORUS Hydra / Pegasus: data bonuses + integrated items
  { id: 'frame:mf_hydra', note: 'System Link & Shepherd Field via deployable/drone bonuses' },
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
    note: 'Expose Power Cells',
    onCoreActivate: (b, u) => { u.flags.powerCells = true },
    beforeOverheat(b, u) {
      if (!u.flags.powerCells) return false
      u.flags.powerCells = false
      u.heat = 0
      const tiles = burstTiles(b.map, u, 3)
      b.addArea({ kind: 'soft_cover', tiles, expiresRound: b.round + 1, ownerId: u.id })
      b.addArea({ kind: 'damage', tiles, expiresRound: b.round + 1, damage: '2', ownerId: u.id })
      b.say(`${u.name} vents a burning cloud!`)
      for (const t of unitsOnTiles(b.alive(), tiles)) if (t !== u) b.applyDamage(t, [{ type: 'Burn', amount: 2 }, { type: 'Heat', amount: 2 }], { source: u })
      return true
    },
  },
  // ---------------- HA Iskander
  {
    id: 'frame:mf_iskander',
    note: 'Assault Launcher (grenade/mine range 15), Skeleton Key',
    init: u => { u.flags.skeletonKey = true; u.flags.assaultLauncher = true },
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
    partial: true,
    note: 'Flash Aegis (brace → damage 1); Heavy Shielding approximated in saves',
    init: u => { u.flags.flashAegis = true; u.flags.heavyShielding = true },
  },
  {
    id: 'core:mf_napoleon',
    note: 'Activate Aegis: all damage reduced to 1, immune to tech',
    onCoreActivate(b, u) { u.flags.aegis = true; for (const s of ['lockon', 'jammed'] as const) b.removeStatus(u, s) },
    modifyIncoming: (b, self, d) => { if (self.flags.aegis && d.amount > 1) d.amount = 1 },
    beforeAttack(b, self, ctx, role) { if (role === 'target' && self.flags.aegis && ctx.tech) ctx.cancelled = true },
  },
  // ---------------- HA Saladin
  {
    id: 'frame:mf_saladin',
    note: 'Reinforced Frame, Guardian, Warp Shield (auto reaction)',
    init: u => { u.immune.push('shredded'); u.flags.guardian = true },
    beforeAnyAttack(b, self, ctx) {
      if (b.hostile(self, ctx.target) || !b.hostile(self, ctx.attacker) || b.distance(self, ctx.target) > self.stats.sensors) return
      if (ctx.target.kind !== 'mech' || b.canSpend(self, 'reaction') !== true || !once(self, 'warpshield')) return
      self.reactionsLeft--
      ctx.difficulty++
      ctx.reasons.push(`${self.name} Warp Shield -1`)
    },
  },
  {
    id: 'core:mf_saladin',
    note: 'Tachyon Shield: Defensive Pulse (resist all from an attack on the shielded ally, 1/round)',
    onCoreActivate(b, u) {
      const t = [u, ...alliesWithin(b, u, u.stats.sensors)].sort((x, y) => x.hp / x.stats.hp - y.hp / y.stats.hp)[0]
      u.flags.tachyonTarget = t.id
      b.say(`Tachyon shield projected over ${t.name}.`)
    },
    beforeAnyAttack(b, self, ctx) {
      if (self.flags.tachyonTarget !== ctx.target.id || b.canSpend(self, 'reaction') !== true || !once(self, 'pulse')) return
      self.reactionsLeft--
      ctx.resistAll = true
      ctx.reasons.push('Defensive Pulse')
    },
  },
  // ---------------- HA Sherman
  {
    id: 'frame:mf_sherman',
    note: 'Superior Reactor via bonus; Vent Heat (soft cover after stabilize/overheat)',
    onHeat: (b, u) => { if (u.heat > u.stats.heatcap) u.flags.ventCover = b.round + 1 },
    adjustCover: (b, self, attacker, target, c) => (target === self && self.flags.ventCover && b.round <= self.flags.ventCover && c === 'none' ? 'soft' : c),
  },
  // ---------------- HA Tokugawa
  {
    id: 'frame:mf_tokugawa',
    note: 'Limit Break (+3 energy bonus, +5 range/+1 threat while Exposed)',
    init: u => {
      u.bonuses.push({ id: 'range', val: 5, range_types: ['Range'], condition: '{exposed}' }, { id: 'threat', val: 1, weapon_types: ['Melee'], condition: '{exposed}' })
    },
    beforeAttack(b, self, ctx, role) {
      if (role === 'attacker' && !ctx.tech && b.has(self, 'exposed') && ctx.weapon) { ctx.bonusDamage.push({ type: b.has(self, 'dangerzone') ? 'Burn' : 'Energy', val: '3' }); ctx.reasons.push('Limit Break +3') }
    },
  },
  {
    id: 'core:mf_tokugawa',
    note: 'Radiance',
    onCoreActivate(b, u) {
      u.bonuses.push({ id: 'range', val: 5, range_types: ['Range'], damage_types: ['Energy'] }, { id: 'threat', val: 2, weapon_types: ['Melee'], damage_types: ['Energy'] })
    },
  },
])

export { blastTiles }
