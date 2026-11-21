// Mech systems whose rules aren't fully structured in lancer-data.
import { blastTiles, burstTiles, footprint, unitsOnTiles, chebyshev } from '../../grid'
import { rollDice } from '../../rng'
import type { Effect, Pos, SystemInst, Unit } from '../../types'
import type { Battle } from '../../battle'
import { deployableUnit } from '../generic'
import { Lancer } from '../../../data/lancer'
import { registerScripts, type CustomAction, type ItemScript } from '../registry'

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
    key: `${id}:${name}`, name: `Invade: ${name}`, activation: 'quick_tech', target: 'enemy', range: u.stats.sensors, text,
    run: (bt, self, t) => {
      const target = t as Unit
      const v = bt.techTargetValid(self, target)
      if (v !== true) throw new Error(v)
      const ctx = bt.techAttackRoll(self, target, name)
      if (ctx.hit) { bt.applyDamage(target, [{ type: 'Heat', amount: 2 }], { source: self }); if (!target.destroyed) onHit(bt, self, target) }
    },
    aiScore: () => 4,
    ...extra,
  })
}

function aoeSave(b: Battle, self: Unit, tiles: Pos[], stat: 'hull' | 'agi' | 'sys' | 'eng', onFail: (t: Unit) => void, filter = (t: Unit) => b.hostile(self, t)) {
  b.emit({ type: 'area', tiles, kind: 'attack' })
  for (const t of unitsOnTiles(b.alive(), tiles)) if (t !== self && filter(t) && !b.save(t, stat, self.stats.save)) onFail(t)
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
      if (r === 6) { u.flags.paintUsed = true; u.structure++; u.hp = 1; b.say('  …the hit only scratched the paint!') }
    },
  },
  {
    id: 'ms_pattern_a_smoke_charges', note: 'Smoke grenade (blast 2 soft cover) and smoke mine (burst 3 soft cover on deploy)',
    init: u => { const s = sys(u, 'ms_pattern_a_smoke_charges'); if (s) s.usesLeft = 3 + u.stats.limitedBonus },
    actions: (b, u) => {
      const s = sys(u, 'ms_pattern_a_smoke_charges')
      return [action({
        key: 'smoke-grenade', name: 'Smoke Grenade', activation: 'quick', target: 'tile', range: u.flags.assaultLauncher ? 15 : 5, area: { shape: 'blast', size: 2 },
        text: 'Blast 2 within range 5: soft cover until the end of your next turn.', usable: () => usesOk(s),
        run: (bt, self, t) => { spend(s); bt.addArea({ kind: 'soft_cover', tiles: blastTiles(bt.map, t as Pos, 2), expiresRound: bt.round + 1, ownerId: self.id }) },
        aiScore: (bt, self) => (bt.round <= 2 ? 2 : 0.5),
      }), action({
        key: 'smoke-mine', name: 'Smoke Mine', activation: 'quick', target: 'tile', range: 5, area: { shape: 'blast', size: 3 },
        text: 'Detonates when allies move near it: burst 3 soft cover (resolved immediately).', usable: () => usesOk(s),
        run: (bt, self, t) => { spend(s); bt.addArea({ kind: 'soft_cover', tiles: blastTiles(bt.map, t as Pos, 3), expiresRound: bt.round + 1, ownerId: self.id }) },
      })]
    },
  },
  {
    id: 'ms_pattern_a_jericho_deployable_cover', note: 'Deploys two adjacent hard-cover sections (10 HP, evasion 5)',
    actions: (b, u) => [action({
      key: 'jericho', name: 'Deploy Jericho Cover', activation: 'quick', target: 'tile', range: 1,
      text: 'Two size-1 hard cover sections in free spaces adjacent to you and each other.',
      usable: (bt, self) => (bt.alive().some(d => d.ownerId === self.id && d.flags.dataName === 'Jericho Deployable Cover') ? 'Already deployed' : true),
      run: (bt, self, t) => {
        const p = t as Pos
        const d = Lancer.systems.get('ms_pattern_a_jericho_deployable_cover')!.deployables![0]
        const free = (q: Pos) => bt.map.tiles[q.y * bt.map.w + q.x] && !bt.alive().some(o => footprint(o).some(z => z.x === q.x && z.y === q.y))
        if (chebyshev(p, self.pos) > 1 || !free(p)) throw new Error('Choose a free adjacent space')
        const second = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => ({ x: p.x + dx, y: p.y + dy })).find(q => q.x >= 0 && q.y >= 0 && q.x < bt.map.w && q.y < bt.map.h && free(q) && chebyshev(q, self.pos) <= 1)
        for (const q of [p, second].filter(Boolean) as Pos[]) { const c = deployableUnit(self, { ...d, size: 1 }, q); c.flags.isCover = true; bt.spawn(c) }
        bt.say(`${self.name} deploys Jericho cover.`)
      },
      aiScore: () => 1.5,
    })],
  },
  {
    id: 'ms_stable_structure', note: '+1 accuracy on Hull saves (approximates "saves vs prone/knockback")',
    init: u => { u.bonuses.push({ id: 'hull', accuracy: 1 }) },
  },
  {
    id: 'ms_turret_drones', note: 'Turret drones + Turret Attack reaction (1d6 kinetic, range 10, 1/round each)',
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
        if (b.distance(d, ctx.attacker) > 10 || b.distance(d, ctx.target) > 10 || !once(d, 'turret')) continue
        const c = b.newAttackCtx(d, ctx.target, { mode: 'secondary', attackBonus: self.stats.grit })
        b.say(`${self.name}'s turret drone fires.`)
        b.rollToHit(c)
        if (c.hit) b.applyDamage(ctx.target, [{ type: 'Kinetic', amount: rollDice(b.rng, '1d6').total }], { source: self })
        if (ctx.target.destroyed) break
      }
    },
  },
  {
    id: 'ms_type_3_projected_shield', note: 'Project Shield',
    actions: (b, u) => [action({
      key: 'projshield', name: 'Project Shield', activation: 'protocol', target: 'enemy',
      text: 'Attacks between you and the nominated character gain +2 difficulty until the start of your next turn.',
      run: (bt, self, t) => { self.flags.projShield = (t as Unit).id },
      aiScore: () => 2,
    })],
    onTurnStart: (b, u) => { delete u.flags.projShield },
    beforeAnyAttack(b, self, ctx) {
      const s = self.flags.projShield
      if (s && ((ctx.attacker.id === s && ctx.target === self) || (ctx.attacker === self && ctx.target.id === s))) { ctx.difficulty += 2; ctx.reasons.push('Projected Shield -2') }
    },
  },
  {
    id: 'ms_rapid_burst_jump_jet_system', note: 'Fly when boosting',
    onAnyMovementAction: (b, self, mover, kind) => { if (mover === self && kind === 'boost') { self.flying = true; self.flags.jumpJets = true } },
    onTurnEnd: (b, u) => { if (u.flags.jumpJets) { u.flying = false; delete u.flags.jumpJets } },
  },
  {
    id: 'ms_type_i_flight_system', note: 'Toggle flight; take size+1 heat at the end of turns you fly',
    actions: (b, u) => [action({
      key: 'flight', name: u.flying ? 'Land (flight off)' : 'Take Flight', activation: 'free', target: 'none', text: 'Count your movement as flying (size+1 heat at end of turn).',
      run: (bt, self) => { self.flying = !self.flying; self.flags.flightSystem = self.flying },
    })],
    onTurnEnd: (b, u) => { if (u.flying && u.flags.flightSystem) b.addHeat(u, Math.max(1, Math.floor(u.stats.size)) + 1) },
  },
  // ------------------------------------------------------------ IPS-N
  { id: 'ms_synthetic_muscle_netting', note: 'Ram/Grapple larger targets', init: u => { u.flags.muscleNet = true } },
  {
    id: 'ms_reinforced_cabling', partial: true, note: 'Drag Down (Grapple Swing not modelled)',
    actions: (b, u) => [action({
      key: 'dragdown', name: 'Drag Down', activation: 'quick', target: 'enemy', range: 5, text: 'Contested Hull check vs a character within 5: the loser is knocked Prone.',
      run: (bt, self, t) => {
        const target = t as Unit
        const a = bt.rng.d(20) + self.stats.hull, d = bt.rng.d(20) + target.stats.hull
        bt.say(`  Drag Down: ${a} vs ${d}`)
        bt.addStatus(a >= d ? target : self, 'prone', 'until_cleared', self)
      },
      aiScore: () => 2,
    })],
  },
  {
    id: 'ms_argonaut_shield', partial: true, note: 'Ward gains resistance; you take the damage they actually take',
    actions: (b, u) => [action({
      key: 'argonaut', name: 'Argonaut Shield', activation: 'quick', target: 'ally', range: 1, text: 'An adjacent character gains Resistance to all damage while adjacent; you take part of the damage.',
      run: (bt, self, t) => { self.flags.argonautWard = (t as Unit).id },
      aiScore: () => 2,
    })],
    beforeAnyAttack(b, self, ctx) { if (self.flags.argonautWard === ctx.target.id && b.adjacent(self, ctx.target)) ctx.resistAll = true },
    afterAnyAttack(b, self, ctx) {
      if (self.flags.argonautWard === ctx.target.id && b.adjacent(self, ctx.target) && ctx.damageDealt) b.applyDamage(self, [{ type: 'Kinetic', amount: ctx.damageDealt }], { source: ctx.attacker })
    },
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
  },
  { id: 'ms_bulwark_mods', note: 'Ignore difficult terrain', init: u => { u.flags.ignoreDifficult = true } },
  {
    id: 'ms_ramjet', note: 'Boost +2, melee knockback 2 (straight-line restriction not enforced)', partial: true,
    actions: (b, u) => [action({
      key: 'ramjet', name: 'Ramjet', activation: 'protocol', target: 'none', text: 'Until your next turn: Boost +2 spaces, melee attacks Knockback 2.',
      run: (bt, self) => { self.flags.ramjet = true; self.bonuses.push({ id: 'boost', val: 2, condition: '{ramjet}' }) },
    })],
    onTurnStart: (b, u) => { delete u.flags.ramjet },
    afterAttack(b, self, ctx, role) { if (role === 'attacker' && self.flags.ramjet && ctx.melee && ctx.hit && !ctx.target.destroyed) b.forceMove(ctx.target, self, 2, 1) },
  },
  {
    id: 'ms_roland_chamber', note: 'After reloading: next Loading weapon hit +1d6 explosive and Hull save vs Prone',
    beforeAttack(b, self, ctx, role) {
      if (role === 'attacker' && self.flags.reloaded && ctx.profile?.tags.some(t => t.id === 'tg_loading')) { ctx.bonusDamage.push({ type: 'Explosive', val: '1d6' }); self.flags.roland = true; delete self.flags.reloaded }
    },
    afterAttack(b, self, ctx, role) {
      if (role === 'attacker' && self.flags.roland) { delete self.flags.roland; if (ctx.hit && !ctx.target.destroyed && !b.save(ctx.target, 'hull', self.stats.save)) b.addStatus(ctx.target, 'prone', 'until_cleared', self) }
    },
  },
  {
    id: 'ms_siege_ram', note: 'Ram deals 2 kinetic',
    afterAttack(b, self, ctx, role) { if (role === 'attacker' && ctx.mode === 'ram' && ctx.hit) b.applyDamage(ctx.target, [{ type: 'Kinetic', amount: 2 }], { source: self }) },
  },
  {
    id: 'ms_hyperdense_armor', note: 'Resistance to attacks from beyond range 3 while active',
    actions: (b, u) => [action({
      key: 'hyperdense', name: u.flags.hyperdense ? 'Deactivate HyperDense Armor' : 'HyperDense Armor', activation: 'quick', target: 'none',
      text: 'Toggle: Resistance to all damage, heat and burn from attacks originating beyond range 3.',
      run: (bt, self) => { self.flags.hyperdense = !self.flags.hyperdense },
    })],
    modifyIncoming(b, self, d) { if (self.flags.hyperdense && d.source && b.distance(self, d.source) > 3) d.amount = Math.ceil(d.amount / 2) },
  },
  {
    id: 'ms_webjaw_snare', note: 'Snare mine: Hull save or 1d6 AP + Immobilized',
    actions: (b, u) => {
      const s = sys(u, 'ms_webjaw_snare')
      return [action({
        key: 'webjaw', name: 'Deploy Webjaw Snare', activation: 'quick', target: 'tile', range: 1, text: 'Adjacent snare: hostiles entering it must pass a Hull save or take 1d6 AP kinetic and become Immobilized.', usable: () => usesOk(s),
        run: (bt, self, t) => { spend(s); bt.placeMine(self, t as Pos, { name: 'Webjaw Snare', radius: 0, damage: [{ type: 'Kinetic', val: '1d6' }], save: 'hull', effects: [{ do: 'status', status: 'immobilized', duration: 'until_cleared' }] }) },
      })]
    },
  },
  {
    id: 'ms_caltrop_launcher', note: 'Burst 1 difficult terrain + 1d3 damage zone for the scene',
    actions: (b, u) => {
      const s = sys(u, 'ms_caltrop_launcher')
      return [action({
        key: 'caltrops', name: 'Caltrop Launcher', activation: 'quick', target: 'tile', range: 5, area: { shape: 'blast', size: 1 }, text: 'Difficult terrain; mechs take 1d3 AP explosive in it.', usable: () => usesOk(s),
        run: (bt, self, t) => { spend(s); const tiles = blastTiles(bt.map, t as Pos, 1); bt.addArea({ kind: 'difficult', tiles, ownerId: self.id }); bt.addArea({ kind: 'damage', tiles, damage: '1d3', ownerId: self.id }) },
      })]
    },
  },
  {
    id: 'ms_charged_stake', note: 'Impale: Hull save or 1d6 AP energy + immobilized, 1d6 each turn end',
    actions: (b, u) => [action({
      key: 'stake', name: 'Charged Stake', activation: 'full', target: 'enemy', range: 1, text: 'Adjacent target: Hull save or impaled (1d6 AP energy, Immobilized, 1d6 at end of each turn).',
      run: (bt, self, t) => {
        const target = t as Unit
        if (!bt.adjacent(self, target)) throw new Error('Must be adjacent')
        if (bt.save(target, 'hull', self.stats.save)) return
        bt.applyDamage(target, [{ type: 'Energy', amount: rollDice(bt.rng, '1d6').total }], { source: self, ap: true })
        bt.addStatus(target, 'immobilized', 'until_cleared', self, { stake: true })
        target.flags.impaledBy = self.id
      },
      aiScore: () => 5,
    })],
    onAnyTurnEnd(b, self, u) {
      if (u.flags.impaledBy !== self.id || u.destroyed) return
      b.applyDamage(u, [{ type: 'Energy', amount: rollDice(b.rng, '1d6').total }], { source: self, ap: true })
      if (b.save(u, 'hull', self.stats.save)) { delete u.flags.impaledBy; u.statuses = u.statuses.filter(s => !s.data?.stake); b.say(`${u.name} tears the stake free.`) }
    },
  },
  // ------------------------------------------------------------ SSC
  {
    id: 'ms_ferrous_lash', note: 'Pull ally 5 or Agility save vs pull 5',
    actions: (b, u) => [action({
      key: 'lash', name: 'Ferrous Lash', activation: 'quick', target: 'unit', range: 8, text: 'Pull an ally 5, or a hostile on a failed Agility save.',
      run: (bt, self, t) => {
        const target = t as Unit
        if (bt.distance(self, target) > 8 || !bt.los(self, target)) throw new Error('Out of range/LoS')
        if (bt.hostile(self, target) && bt.save(target, 'agi', self.stats.save)) return
        bt.forceMove(target, self, 5, -1)
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
    id: 'ms_tracking_bug', note: 'Tracking bug: target cannot Hide, you ignore its Invisible',
    actions: (b, u) => [action({
      key: 'trackbug', name: 'Tracking Bug', activation: 'quick_tech', target: 'enemy', range: u.stats.sensors, text: 'Tech attack: the target cannot Hide and you ignore its Invisible.',
      run: (bt, self, t) => { const c = bt.techAttackRoll(self, t as Unit, 'Tracking Bug'); if (c.hit) { (t as Unit).flags.trackedBy = self.id; bt.removeStatus(t as Unit, 'hidden') } },
    })],
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
    id: 'ms_neurospike', note: 'Shrike Code / Mirage invades',
    actions: (b, u) => [
      invade('neurospike', 'Shrike Code', 'Target takes 2 heat whenever it attacks until the end of its next turn.', (bt, self, t) => { t.flags.shrikeUntil = bt.round + 1 })(b, u),
      invade('neurospike', 'Mirage', 'The target treats you as Invisible until the end of its next turn.', (bt, self, t) => { t.flags[`mirage:${self.id}`] = bt.round + 1 })(b, u),
    ],
    beforeAnyAttack(b, self, ctx) {
      if (ctx.attacker.flags.shrikeUntil && b.round <= ctx.attacker.flags.shrikeUntil && b.hostile(self, ctx.attacker)) b.applyDamage(ctx.attacker, [{ type: 'Heat', amount: 2 }], { source: self })
      const m = ctx.attacker.flags[`mirage:${self.id}`]
      if (m && b.round <= m && ctx.target === self) ctx.forceInvisible = true
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
            if (!bt.save(t, 'agi', self.stats.save)) bt.addStatus(t, 'jammed', 'next_turn_end_target', self)
            if (!bt.save(t, 'sys', self.stats.save)) bt.addStatus(t, 'impaired', 'next_turn_end_target', self)
          }
        },
        aiScore: (bt, self) => hostile(bt, self).filter(h => bt.distance(self, h) <= 3).length * 3,
      })]
    },
  },
  {
    id: 'ms_reactive_weave', note: 'Invisible after bracing',
    beforeAttack(b, self, ctx, role) { if (role === 'target' && b.has(self, 'braced') && !self.flags['round:weave']) { self.flags['round:weave'] = true; b.addStatus(self, 'invisible', 'next_turn_end_target', self) } },
  },
  {
    id: 'ms_active_camouflage', note: 'Invisible until damaged or end of next turn',
    actions: (b, u) => [action({ key: 'camo', name: 'Active Camouflage', activation: 'protocol', target: 'none', text: 'Invisible until you take damage or the end of your next turn.', run: (bt, self) => { bt.addStatus(self, 'invisible', 'next_turn_end_target', self, { camo: true }) }, aiScore: () => 2 })],
    onDamaged(b, self) { if (self.statuses.some(s => s.id === 'invisible' && s.data?.camo)) b.removeStatus(self, 'invisible') },
  },
  {
    id: 'ms_markerlight', partial: true, note: '2 heat + Lock On + no soft cover (weak-spot crit reaction not modelled)',
    actions: (b, u) => [action({
      key: 'markerlight', name: 'Markerlight', activation: 'full_tech', target: 'enemy', range: u.stats.sensors, text: 'Tech attack: 2 heat, Lock On, target loses soft cover until the Lock On is cleared.',
      run: (bt, self, t) => { const c = bt.techAttackRoll(self, t as Unit, 'Markerlight'); if (c.hit) { bt.applyDamage(t as Unit, [{ type: 'Heat', amount: 2 }], { source: self }); bt.addStatus(t as Unit, 'lockon', 'until_cleared', self); (t as Unit).flags.markerlit = true } },
      aiScore: () => 4,
    })],
    adjustCover: (b, self, attacker, target, c) => (target.flags.markerlit && b.has(target, 'lockon') && c === 'soft' ? 'none' : c),
  },
  {
    id: 'ms_hunter_logic_suite', note: 'Stalk Prey / Terrify invades',
    actions: (b, u) => [
      invade('hls', 'Stalk Prey', 'The target treats you as Invisible until it damages you.', (bt, self, t) => { t.flags[`stalked:${self.id}`] = true })(b, u),
      invade('hls', 'Terrify', 'Impaired until the end of its next turn (and can\'t approach you).', (bt, self, t) => { bt.addStatus(t, 'impaired', 'next_turn_end_target', self) })(b, u),
    ],
    beforeAnyAttack(b, self, ctx) { if (ctx.target === self && ctx.attacker.flags[`stalked:${self.id}`]) ctx.forceInvisible = true },
    onDamaged(b, self, d) { if (d.source) delete d.source.flags[`stalked:${self.id}`] },
  },
  {
    id: 'ms_singularity_motivator', note: 'Exposed Singularity: teleport 1d6 when hit (auto reaction, away from the attacker)',
    afterAttack(b, self, ctx, role) {
      if (role !== 'target' || !ctx.hit || self.destroyed || b.canSpend(self, 'reaction') !== true || !once(self, 'singularity')) return
      self.reactionsLeft--
      b.forceMove(self, ctx.attacker, b.rng.d(6), 1)
    },
  },
  {
    id: 'ms_lb_oc_cloaking_field', partial: true, note: 'Slowed; you and allies within burst 2 are Invisible (re-evaluated each turn)',
    actions: (b, u) => [action({
      key: 'lboc', name: u.flags.lboc ? 'Deactivate Cloaking Field' : 'LB/OC Cloaking Field', activation: 'quick', target: 'none', text: 'Toggle: you are Slowed; you and allies wholly inside burst 2 are Invisible.',
      run: (bt, self) => { self.flags.lboc = !self.flags.lboc; if (self.flags.lboc) bt.addStatus(self, 'slowed', 'until_cleared', self, { lboc: true }); else self.statuses = self.statuses.filter(s => !s.data?.lboc) },
    })],
    beforeAnyAttack(b, self, ctx) { if (self.flags.lboc && !b.hostile(self, ctx.target) && b.distance(self, ctx.target) <= 2) ctx.forceInvisible = true },
  },
  // ------------------------------------------------------------ HORUS
  { id: 'ms_scanner_swarm', note: '+1 acc on tech vs adjacent', beforeAttack(b, self, ctx, role) { if (role === 'attacker' && ctx.tech && b.adjacent(self, ctx.target)) ctx.accuracy++ } },
  {
    id: 'ms_h0r_os_system_upgrade_i', note: 'Puppet System / Eject Power Cores',
    actions: (b, u) => [
      invade('horos1', 'Puppet System', 'Target moves its speed away from you (involuntary).', (bt, self, t) => { bt.forceMove(t, self, t.stats.speed, 1) })(b, u),
      invade('horos1', 'Eject Power Cores', 'Jammed until end of next turn; adjacent characters take 2 energy (1/scene per target).', (bt, self, t) => {
        if (t.flags.ejected) return
        t.flags.ejected = true
        bt.addStatus(t, 'jammed', 'next_turn_end_target', self)
        for (const o of bt.alive()) if (o !== t && bt.adjacent(o, t)) bt.applyDamage(o, [{ type: 'Energy', amount: 2 }], { source: self })
      })(b, u),
    ],
  },
  {
    id: 'ms_metahook', partial: true, note: 'Link with an ally: they gain +1 accuracy on tech attacks',
    actions: (b, u) => [action({ key: 'metahook', name: 'Metahook', activation: 'quick_tech', target: 'ally', range: u.stats.sensors, text: 'Link systems with an ally within sensors.', run: (bt, self, t) => { (t as Unit).bonuses.push({ id: 'tech_attack', accuracy: 1 }) } })],
  },
  {
    id: 'ms_osiris_class_nhp', partial: true, note: 'Hurl Into the Duat: tech attack dealing heat equal to 2 + tech attack',
    actions: (b, u) => [action({
      key: 'duat', name: 'Hurl Into the Duat', activation: 'quick_tech', target: 'enemy', range: u.stats.sensors, text: 'Powerful system attack.',
      run: (bt, self, t) => { const c = bt.techAttackRoll(self, t as Unit, 'Hurl Into the Duat'); if (c.hit) bt.applyDamage(t as Unit, [{ type: 'Heat', amount: 2 + self.stats.techAttack }], { source: self }) },
    })],
  },
  {
    id: 'ms_mimic_mesh', partial: true, note: 'Battlefield Awareness modelled as +1 evasion for the linked ally',
    actions: (b, u) => [action({ key: 'mimic', name: 'Activate Mimic Mesh', activation: 'quick', target: 'ally', range: u.stats.sensors, text: 'Choose an ally: you may move toward them as a reaction.', run: () => {} })],
  },
  {
    id: 'ms___scorpion_v70.1', note: '//SCORPION: when a tech attack hits you, the attacker is Impaired and takes 2 heat',
    afterAttack(b, self, ctx, role) {
      if (role === 'target' && ctx.tech && b.canSpend(self, 'reaction') === true && once(self, 'scorpion')) {
        self.reactionsLeft--
        b.addStatus(ctx.attacker, 'impaired', 'next_turn_end_target', self)
        b.applyDamage(ctx.attacker, [{ type: 'Heat', amount: 2 }], { source: self })
      }
    },
  },
  {
    id: 'ms_scylla_class_nhp', partial: true, note: 'Unleash SCYLLA: two half-damage reaction skirmishes vs attackers',
    actions: (b, u) => [action({ key: 'scylla', name: 'Unleash SCYLLA', activation: 'quick', target: 'none', text: 'Until your next turn, gain two reactions to Skirmish (half damage) against attackers.', run: (bt, self) => { self.flags.scylla = 2 } })],
    onTurnStart: (b, u) => { delete u.flags.scylla },
    afterAttack(b, self, ctx, role) {
      if (role !== 'target' || !(self.flags.scylla > 0) || ctx.attacker.destroyed) return
      const w = b.bestThreatWeapon(self, ctx.attacker) ?? self.weapons.find(w => b.weaponReady(self, w) && b.validTarget(self, w, ctx.attacker) === true)
      if (!w) return
      self.flags.scylla--
      self.flags.halfDamage = true
      b.weaponAttack(self, w, { targetId: ctx.attacker.id }, 'free')
      delete self.flags.halfDamage
    },
  },
  {
    id: 'ms_puppetmaster', partial: true, note: 'Electropulse (Guide the Flock not modelled)',
    actions: (b, u) => [action({
      key: 'electropulse', name: 'Electropulse', activation: 'quick_tech', target: 'none', text: 'Hostiles within sensors adjacent to any drone/deployable take 2 energy.',
      run: (bt, self) => {
        const deps = bt.alive().filter(d => d.kind === 'drone' || d.kind === 'deployable')
        for (const t of hostile(bt, self)) if (bt.distance(self, t) <= self.stats.sensors && deps.some(d => bt.adjacent(d, t))) bt.applyDamage(t, [{ type: 'Energy', amount: 2 }], { source: self })
      },
    })],
  },
  {
    id: 'ms_beckoner', partial: true, note: 'Summon invade (Beckon swap not modelled)',
    actions: (b, u) => [invade('beckoner', 'Summon', 'All characters within 3 of the target are pulled adjacent to it.', (bt, self, t) => {
      for (const o of bt.alive()) if (o !== t && bt.distance(o, t) <= 3 && o.kind !== 'deployable') bt.forceMove(o, t, 3, -1)
    })(b, u)],
  },
  {
    id: 'ms_smite', note: 'Smite / Sear invades',
    actions: (b, u) => [
      invade('smite', 'Smite', 'You take 1d6 AP energy; target Systems save or Stunned (1/scene per target).', (bt, self, t) => {
        bt.applyDamage(self, [{ type: 'Energy', amount: rollDice(bt.rng, '1d6').total }], { ap: true })
        if (!t.flags.smitten && !bt.save(t, 'sys', self.stats.save)) { t.flags.smitten = true; bt.addStatus(t, 'stunned', 'next_turn_end_target', self) }
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
        for (const t of unitsOnTiles(bt.alive(), burstTiles(bt.map, self, 1))) if (t !== self && t.role !== 'Biological' && !t.flags.emped && !bt.save(t, 'sys', self.stats.save)) { t.flags.emped = true; bt.addStatus(t, 'stunned', 'next_turn_end_target', self) }
      },
    })],
  },
  {
    id: 'ms_lightning_generator', note: 'Protocol: 1 heat, 2 energy to adjacent; auto 4 AP in danger zone',
    actions: (b, u) => [action({
      key: 'lightning', name: 'Lightning Generator', activation: 'protocol', target: 'none', text: 'Take 1 heat; deal 2 energy to all adjacent characters and objects.',
      run: (bt, self) => { bt.addHeat(self, 1); for (const o of bt.alive()) if (o !== self && bt.adjacent(self, o)) bt.applyDamage(o, [{ type: 'Energy', amount: 2 }], { source: self }) },
      aiScore: (bt, self) => bt.alive().filter(o => bt.hostile(self, o) && bt.adjacent(self, o)).length * 2,
    })],
    onTurnStart(b, u) {
      if (!b.has(u, 'dangerzone')) return
      b.addHeat(u, 1)
      for (const o of b.alive()) if (o !== u && b.adjacent(u, o)) b.applyDamage(o, [{ type: 'Energy', amount: 4 }], { source: u, ap: true })
    },
  },
  {
    id: 'ms_viral_logic_suite', note: 'Logic Bomb / Banish invades',
    actions: (b, u) => [
      invade('vls', 'Logic Bomb', 'Characters of your choice within burst 2 of the target: Systems save or Slowed.', (bt, self, t) => {
        for (const o of unitsOnTiles(bt.alive(), burstTiles(bt.map, t, 2))) if (bt.hostile(self, o) && !bt.save(o, 'sys', self.stats.save)) bt.addStatus(o, 'slowed', 'next_turn_end_target', self)
      })(b, u),
      invade('vls', 'Banish', 'Target takes 2 heat per space it voluntarily moves (max 6) until the end of its next turn.', (bt, self, t) => { t.flags.banished = bt.round + 1 })(b, u),
    ],
    onMove(b, self, mover, path) {
      if (mover.flags.banished && b.round <= mover.flags.banished && b.hostile(self, mover)) b.applyDamage(mover, [{ type: 'Heat', amount: Math.min(6, 2 * (path.length - 1)) }], { source: self })
    },
  },
  {
    id: 'ms_aggressive_system_sync', partial: true, note: 'Chains of Prometheus (4 heat; 2 heat when ending turns beyond range 3)',
    actions: (b, u) => [action({
      key: 'chains', name: 'Chains of Prometheus', activation: 'full_tech', target: 'enemy', range: u.stats.sensors, text: 'Tech attack: 4 heat; for the scene, 2 heat whenever it ends a turn more than 3 from you.',
      run: (bt, self, t) => { const c = bt.techAttackRoll(self, t as Unit, 'Chains of Prometheus'); if (c.hit) { bt.applyDamage(t as Unit, [{ type: 'Heat', amount: 4 }], { source: self }); (t as Unit).flags.chainedBy = self.id } },
      aiScore: () => 5,
    })],
    onAnyTurnEnd(b, self, u) { if (u.flags.chainedBy === self.id && b.distance(self, u) > 3) b.applyDamage(u, [{ type: 'Heat', amount: 2 }], { source: self }) },
  },
  {
    id: 'ms_metafold_carver', partial: true, note: 'Ophidian Trek (pull 1d6+1); Fold Space not modelled',
    actions: (b, u) => [invade('carver', 'Ophidian Trek', 'Target is teleported 1d6+1 spaces toward you.', (bt, self, t) => { bt.forceMove(t, self, rollDice(bt.rng, '1d6+1').total, -1) })(b, u)],
  },
  {
    id: 'ms_hunter_lock', note: 'First hit each round vs the locked target deals +3',
    actions: (b, u) => [action({
      key: 'hunterlock', name: 'Hunter Lock', activation: 'quick', target: 'enemy', range: u.stats.sensors, text: 'For the scene, your first hit each round against this target deals +3 bonus damage.',
      usable: (bt, self) => (self.flags.hunterLock && !bt.unit(self.flags.hunterLock)?.destroyed ? 'Current target still active' : true),
      run: (bt, self, t) => { self.flags.hunterLock = (t as Unit).id },
      aiScore: () => 3,
    })],
    afterAttack(b, self, ctx, role) {
      if (role === 'attacker' && ctx.hit && !ctx.tech && ctx.target.id === self.flags.hunterLock && !ctx.target.destroyed && once(self, 'hunterlock')) b.applyDamage(ctx.target, [{ type: ctx.profile?.damage[0]?.type ?? 'Kinetic', amount: 3 }], { source: self })
    },
  },
  {
    id: 'ms_eye_of_horus', note: 'Ignore Hidden/Invisible within sensors until end of next turn',
    actions: (b, u) => [action({ key: 'horus', name: 'Eye of Horus', activation: 'quick', target: 'none', text: 'Hidden and Invisible don\'t protect hostiles within sensors against you.', run: (bt, self) => { self.flags.horusUntil = bt.round + 1; for (const t of hostile(bt, self)) if (bt.distance(self, t) <= self.stats.sensors) bt.removeStatus(t, 'hidden') } })],
    beforeAttack(b, self, ctx, role) { if (role === 'attacker' && self.flags.horusUntil && b.round <= self.flags.horusUntil && b.has(ctx.target, 'invisible')) { ctx.target.flags.horusPeek = true } },
  },
  // ------------------------------------------------------------ Harrison Armory
  {
    id: 'ms_siege_stabilizers', note: '+5 range, immobilized, no melee / targets within 5',
    actions: (b, u) => [action({
      key: 'stabilizers', name: u.flags.stabilizers ? 'Retract Stabilizers' : 'Extend Stabilizers', activation: 'quick', target: 'none', text: 'Ranged attacks +5 range; you are Immobilized and cannot attack within range 5 or in melee.',
      run: (bt, self) => {
        self.flags.stabilizers = !self.flags.stabilizers
        if (self.flags.stabilizers) { bt.addStatus(self, 'immobilized', 'until_cleared', self, { stab: true }); self.bonuses.push({ id: 'range', val: 5, range_types: ['Range'], condition: '{stabilizers}' }) }
        else self.statuses = self.statuses.filter(s => !s.data?.stab)
      },
    })],
    beforeAttack(b, self, ctx, role) { if (role === 'attacker' && self.flags.stabilizers && (ctx.melee || b.distance(self, ctx.target) <= 5)) ctx.cancelled = true },
  },
  { id: 'ms_external_ammo_feed', note: 'Equivalent to the Reload quick action (1/round)' },
  {
    id: 'ms_flak_launcher', note: 'Ground a flyer',
    actions: (b, u) => [action({
      key: 'flak', name: 'Flak Launcher', activation: 'quick', target: 'enemy', range: 15, text: 'A flying character must pass an Agility save or land, becoming Slowed and unable to fly.',
      usable: (bt, self) => (hostile(bt, self).some(h => h.flying) ? true : 'No flying targets'),
      run: (bt, self, t) => { const target = t as Unit; if (!target.flying) throw new Error('Target is not flying'); if (!bt.save(target, 'agi', self.stats.save)) { target.flying = false; bt.addStatus(target, 'slowed', 'next_turn_end_target', self) } },
    })],
  },
  {
    id: 'ms_explosive_vents', note: 'Burst 1 explosion (2 heat, 2 burn) when clearing all heat or taking stress',
    onHeat(b, u) {
      if (u.heat <= u.stats.heatcap) return
      for (const t of unitsOnTiles(b.alive(), burstTiles(b.map, u, 1))) if (t !== u) b.applyDamage(t, [{ type: 'Heat', amount: 2 }, { type: 'Burn', amount: 2 }], { source: u })
    },
  },
  {
    id: 'ms_auto_cooler', note: 'Clear all heat next turn if you neither move, take damage nor overheat',
    actions: (b, u) => [action({ key: 'autocool', name: 'Auto-Cooler', activation: 'protocol', target: 'none', text: 'Clear all heat at the start of your next turn if undisturbed.', run: (bt, self) => { self.flags.autoCool = true; self.flags['turn:moved'] = false } })],
    onDamaged: (b, u) => { delete u.flags.autoCool },
    onTurnEnd: (b, u) => { if (u.flags['turn:moved']) delete u.flags.autoCool },
    onTurnStart: (b, u) => { if (u.flags.autoCool) { u.heat = 0; delete u.flags.autoCool; b.say(`${u.name}'s auto-cooler purges its heat.`) } },
  },
  {
    id: 'ms_agni_class_nhp', note: 'AGNI: 1/scene vent all heat at end of turn in a burst 2 wave',
    actions: (b, u) => [action({ key: 'agni', name: 'AGNI Protocol', activation: 'protocol', target: 'none', text: 'At the end of this turn, clear all heat in a burst 2 wave (Engineering save or 2 burn and pushed out).', usable: (bt, self) => (self.flags['scene:agni'] ? 'Used this scene' : true), run: (bt, self) => { self.flags['scene:agni'] = true; self.flags['turn:agni'] = true } })],
    onTurnEnd(b, u) {
      if (!u.flags['turn:agni']) return
      u.heat = 0
      const tiles = burstTiles(b.map, u, 2)
      aoeSave(b, u, tiles, 'eng', t => { b.applyDamage(t, [{ type: 'Burn', amount: 2 }], { source: u }); b.forceMove(t, u, 3, 1) }, t => t !== u)
      b.addArea({ kind: 'soft_cover', tiles, expiresRound: b.round + 1, ownerId: u.id })
    },
  },
  {
    id: 'ms_repulser_field', note: 'Burst 2 Hull save or knocked back 2; detonates mines in the area',
    actions: (b, u) => [action({
      key: 'repulser', name: 'Repulser Field', activation: 'quick', target: 'self', area: { shape: 'burst', size: 2 }, text: 'Characters in burst 2: Hull save or knocked back 2.',
      run: (bt, self) => {
        const tiles = burstTiles(bt.map, self, 2)
        aoeSave(bt, self, tiles, 'hull', t => bt.forceMove(t, self, 2, 1), t => t !== self)
        const set = new Set(tiles.map(t => `${t.x},${t.y}`))
        for (const m of [...bt.mines]) if (set.has(`${m.pos.x},${m.pos.y}`)) bt.detonateMine(m)
      },
      aiScore: (bt, self) => bt.alive().filter(o => bt.hostile(self, o) && bt.distance(self, o) <= 2).length * 1.5,
    })],
  },
  {
    id: 'ms_stasis_generator', note: 'Stasis: target stunned and immune to everything until end of its next turn',
    actions: (b, u) => [action({
      key: 'stasis', name: 'Stasis Generator', activation: 'quick', target: 'unit', range: 5, text: 'Hostile (Engineering save) or ally: Stunned and immune to all damage until the end of its next turn. 1/scene per character.',
      run: (bt, self, t) => {
        const target = t as Unit
        if (target.flags.stasisUsed) throw new Error('Already used on this character this scene')
        target.flags.stasisUsed = true
        if (bt.hostile(self, target) && bt.save(target, 'eng', self.stats.save)) return
        bt.addStatus(target, 'stunned', 'next_turn_end_target', self, { stasis: true })
        target.flags.stasisUntilRound = bt.round + 1
      },
    })],
    beforeAnyAttack(b, self, ctx) { if (ctx.target.flags.stasisUntilRound && ctx.target.statuses.some(s => s.data?.stasis)) ctx.cancelled = true },
  },
  {
    id: 'ms_stasis_bolt', note: 'Interdiction Point: contested roll makes an attack miss',
    actions: (b, u) => [action({ key: 'stasisbolt', name: 'Charge Stasis Bolt', activation: 'quick', target: 'none', text: 'Gain the Interdiction Point reaction.', usable: (bt, self) => (self.flags.stasisBolt ? 'Already charged' : true), run: (bt, self) => { self.flags.stasisBolt = true } })],
    afterAnyRoll(b, self, ctx) {
      if (!self.flags.stasisBolt || !ctx.hit || b.hostile(self, ctx.target) || b.canSpend(self, 'reaction') !== true || !b.los(self, ctx.attacker)) return
      self.reactionsLeft--
      self.flags.stasisBolt = false
      const mine = b.rng.d(20) + self.stats.grit
      b.say(`${self.name} fires a stasis bolt (${mine} vs ${ctx.total}).`)
      if (mine >= (ctx.total ?? 0)) ctx.hit = false
    },
  },
  {
    id: 'ms_enclave_pattern_support_shield', partial: true, note: 'Burst 3 dome: +1 difficulty to attacks from outside; Blinkfield Intervention (2 heat → resistance)',
    actions: (b, u) => [action({ key: 'enclave', name: 'Enclave Support Shield', activation: 'quick', target: 'none', text: 'Burst 3 dome until the end of your next turn; you are Immobilized.', run: (bt, self) => { self.flags.enclaveUntil = bt.round + 1; bt.addStatus(self, 'immobilized', 'next_turn_end_target', self) } })],
    beforeAnyAttack(b, self, ctx) {
      if (!self.flags.enclaveUntil || b.round > self.flags.enclaveUntil || b.hostile(self, ctx.target) || b.distance(self, ctx.target) > 3 || b.distance(self, ctx.attacker) <= 3) return
      ctx.difficulty++
      if (b.canSpend(self, 'reaction') === true && ctx.target.hp <= ctx.target.stats.hp / 2) { self.reactionsLeft--; b.addHeat(self, 2); ctx.resistAll = true }
    },
  },
  {
    id: 'ms_reactor_stabilizer', partial: true, note: 'Overheat reroll (approximated as +1 accuracy on Engineering checks)',
    init: u => { u.bonuses.push({ id: 'engineering', accuracy: 1 }) },
  },
  {
    id: 'ms_redundant_systems_upgrade', note: 'Stabilize as a quick action',
    actions: (b, u) => {
      const s = sys(u, 'ms_redundant_systems_upgrade')
      return [action({
        key: 'rsu', name: 'Quick Stabilize', activation: 'quick', target: 'none', text: 'Expend a charge to Stabilize (cool) as a quick action.', usable: () => usesOk(s),
        run: (bt, self) => { spend(s); self.heat = 0; bt.removeStatus(self, 'exposed'); bt.say(`${self.name} stabilizes.`) },
        aiScore: (bt, self) => (bt.has(self, 'exposed') ? 6 : self.heat >= self.stats.heatcap - 1 ? 4 : 0),
      })]
    },
  },
  {
    id: 'ms_asura_class_nhp', note: 'ASURA: 1/scene two additional quick actions',
    actions: (b, u) => [action({ key: 'asura', name: 'ASURA Protocol', activation: 'protocol', target: 'none', text: '1/scene: take two additional quick actions this turn.', usable: (bt, self) => (self.flags['scene:asura'] ? 'Used this scene' : true), run: (bt, self) => { self.flags['scene:asura'] = true; self.flags.bonusQuick = (self.flags.bonusQuick ?? 0) + 2 }, aiScore: () => 6 })],
  },
  {
    id: 'ms_external_batteries', note: 'Explodes for 1d6 AP when you take structure damage (range bonuses via data)',
    onStructureDamage(b, u) {
      const s = sys(u, 'ms_external_batteries')
      if (!s) return
      s.destroyed = true
      b.say(`${u.name}'s external batteries explode!`)
      b.applyDamage(u, [{ type: 'Explosive', amount: rollDice(b.rng, '1d6').total }], { irreducible: true, ap: true })
    },
  },
  {
    id: 'ms_deep_well_heat_sink', note: 'Resistance to heat on turns started in the Danger Zone',
    onTurnStart(b, u) { if (b.has(u, 'dangerzone') && !u.resist.includes('Heat')) { u.resist.push('Heat'); u.flags['turn:deepwell'] = true } },
    onTurnEnd(b, u) { if (u.flags['turn:deepwell']) u.resist = u.resist.filter(r => r !== 'Heat') },
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
        const ok = bt.save(target, 'agi', self.stats.save)
        bt.applyDamage(target, [{ type: 'Energy', amount: ok ? bt.halfOnSave(target, dmg) : dmg }], { source: self, ap: true })
        if (!ok) bt.addStatus(target, 'prone', 'until_cleared', self)
        bt.addHeat(self, Math.ceil(dmg / 2))
        bt.addStatus(self, 'stunned', 'start_of_next_turn_target', self)
      },
      aiScore: () => 10,
    })],
  },
])

export type { Effect }
