// Mech systems whose rules aren't fully structured in lancer-data.
import { blastTiles, burstTiles, footprint, unitsOnTiles, chebyshev } from '../../grid'
import { rollDice } from '../../rng'
import { dropSystemBonuses } from '../../stats'
import type { Effect, Pos, SystemInst, Unit } from '../../types'
import { PendingChoice, type Battle } from '../../battle'
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
    key: `${id}:${name}`, name: `Invade: ${name}`, activation: 'quick_tech', techOption: 'invade', target: 'unit', range: u.stats.sensors, text,
    run: (bt, self, t) => {
      const target = t as Unit
      const v = bt.techTargetValid(self, target)
      if (v !== true) throw new Error(v)
      const ctx = bt.invadeRoll(self, target, name)
      if (ctx.hit) { if (bt.hostile(self, target)) bt.applyDamage(target, [{ type: 'Heat', amount: 2 }], { source: self }); if (!target.destroyed) onHit(bt, self, target) }
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
    id: 'ms_pattern_a_smoke_charges', note: 'Smoke Grenade (Blast 2 soft cover until the end of your next turn); Smoke Mine (planted adjacent; when an ally moves next to it, Burst 3 soft cover until the end of that ally\'s next turn)',
    init: u => { const s = sys(u, 'ms_pattern_a_smoke_charges'); if (s) s.usesLeft = 3 + u.stats.limitedBonus },
    actions: (b, u) => {
      const s = sys(u, 'ms_pattern_a_smoke_charges')
      return [action({
        key: 'smoke-grenade', name: 'Smoke Grenade', activation: 'quick', target: 'tile', range: u.flags.assaultLauncher ? 15 : 5, area: { shape: 'blast', size: 2 },
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
          bt.addStatus(a >= d ? target : self, 'prone', 'until_cleared', self)
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
    afterAttack(b, self, ctx, role) { if (role === 'attacker' && self.flags.ramjet && ctx.melee && ctx.hit && !ctx.target.destroyed) b.forceMove(ctx.target, self, 2, 1) },
  },
  {
    id: 'ms_roland_chamber', note: 'After reloading: next Loading weapon hit +1d6 explosive and Hull save vs Prone',
    beforeAttack(b, self, ctx, role) {
      if (role === 'attacker' && self.flags.reloaded && ctx.profile?.tags.some(t => t.id === 'tg_loading')) { ctx.bonusDamage.push({ type: 'Explosive', val: '1d6' }); self.flags.roland = true; delete self.flags.reloaded }
    },
    afterAttack(b, self, ctx, role) {
      if (role === 'attacker' && self.flags.roland) { delete self.flags.roland; if (ctx.hit && !ctx.target.destroyed && !b.save(ctx.target, 'hull', self.stats.save, 0, self)) b.addStatus(ctx.target, 'prone', 'until_cleared', self) }
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
    grantsResistance: (b, self, _type, d) => !!self.flags.hyperdense && !!d.source && b.distance(self, d.source) > 3,
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
          bt.spawn(d)
          spend(s)
          bt.say(`${self.name} sets a Webjaw Snare.`)
        },
      })]
    },
    onMove(b, self, mover, path) {
      if (mover.kind !== 'mech' && mover.kind !== 'npc' || !b.hostile(self, mover) || mover.destroyed) return
      for (const d of b.alive().filter(o => o.ownerId === self.id && o.flags.webjaw && o.flags.intangible)) {
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
        if (bt.save(target, 'hull', self.stats.save, 0, self)) return
        bt.applyDamage(target, [{ type: 'Energy', amount: rollDice(bt.rng, '1d6').total }], { source: self, ap: true })
        bt.addStatus(target, 'immobilized', 'until_cleared', self, { stake: true })
        target.flags.impaledBy = self.id
      },
      aiScore: () => 5,
    })],
    onAnyTurnEnd(b, self, u) {
      if (u.flags.impaledBy !== self.id || u.destroyed) return
      b.applyDamage(u, [{ type: 'Energy', amount: rollDice(b.rng, '1d6').total }], { source: self, ap: true })
      if (b.save(u, 'hull', self.stats.save, 0, self)) { delete u.flags.impaledBy; u.statuses = u.statuses.filter(s => !s.data?.stake); b.say(`${u.name} tears the stake free.`) }
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
        if (bt.hostile(self, target) && bt.save(target, 'agi', self.stats.save, 0, self)) return
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
      if (!b.previewing && ctx.attacker.flags.shrikeUntil && b.round <= ctx.attacker.flags.shrikeUntil && b.hostile(self, ctx.attacker)) b.applyDamage(ctx.attacker, [{ type: 'Heat', amount: 2 }], { source: self })
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
            if (!bt.save(t, 'agi', self.stats.save, 0, self)) bt.addStatus(t, 'jammed', 'next_turn_end_target', self)
            if (!bt.save(t, 'sys', self.stats.save, 0, self)) bt.addStatus(t, 'impaired', 'next_turn_end_target', self)
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
      b.spend(self, 'reaction') // through spend(): reveals Hidden, ends Ghostweave, runs onAnyAction hooks
      b.forceMove(self, ctx.attacker, b.rng.d(6), 1)
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
    note: 'Hurl Into the Duat (quick tech, 1/round): 2 heat and the next Gate in turn — I: you steer its next standard move; II: Slowed and Impaired; III: Stunned (until the end of its next turn); IV: it fights for your side until the end of its next turn (ends if your side harms, attacks or forces a save on it)',
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
    id: 'ms___scorpion_v70.1', note: '//SCORPION: when a hostile tech attack misses you, the attacker is Impaired and takes 2 heat',
    afterAttack(b, self, ctx, role) {
      if (role === 'target' && ctx.tech && !ctx.hit && b.hostile(self, ctx.attacker) && !ctx.attacker.destroyed && b.canSpend(self, 'reaction') === true && once(self, 'scorpion')) {
        b.spend(self, 'reaction') // through spend(): reveals Hidden, ends Ghostweave, runs onAnyAction hooks
        b.addStatus(ctx.attacker, 'impaired', 'next_turn_end_target', self)
        b.applyDamage(ctx.attacker, [{ type: 'Heat', amount: 2 }], { source: self })
      }
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
    id: 'ms_lightning_generator', note: 'Protocol: 1 heat, 2 energy to adjacent; auto 4 AP in danger zone',
    actions: (b, u) => [action({
      key: 'lightning', name: 'Lightning Generator', activation: 'protocol', heat: 1, target: 'none', text: 'Take 1 heat; deal 2 energy to all adjacent characters and objects.',
      run: (bt, self) => { for (const o of bt.alive()) if (o !== self && bt.adjacent(self, o)) bt.applyDamage(o, [{ type: 'Energy', amount: 2 }], { source: self }) },
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
        for (const o of unitsOnTiles(bt.alive(), burstTiles(bt.map, t, 2))) if (bt.hostile(self, o) && !bt.save(o, 'sys', self.stats.save, 0, self)) bt.addStatus(o, 'slowed', 'next_turn_end_target', self)
      })(b, u),
      invade('vls', 'Banish', 'Target takes 2 heat per space it voluntarily moves (max 6) until the end of its next turn.', (bt, self, t) => { t.flags.banished = bt.round + 1 })(b, u),
    ],
    onMove(b, self, mover, path) {
      if (mover.flags.banished && b.round <= mover.flags.banished && b.hostile(self, mover)) b.applyDamage(mover, [{ type: 'Heat', amount: Math.min(6, 2 * (path.length - 1)) }], { source: self })
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
      run: (bt, self, t) => { const target = t as Unit; if (!target.flying) throw new Error('Target is not flying'); if (!bt.save(target, 'agi', self.stats.save, 0, self)) { target.flying = false; bt.addStatus(target, 'slowed', 'next_turn_end_target', self) } },
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
        if (bt.hostile(self, target) && bt.save(target, 'eng', self.stats.save, 0, self)) return
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
      b.spend(self, 'reaction') // through spend(): reveals Hidden, ends Ghostweave, runs onAnyAction hooks
      self.flags.stasisBolt = false
      const mine = b.rng.d(20) + self.stats.grit
      b.say(`${self.name} fires a stasis bolt (${mine} vs ${ctx.total}).`)
      if (mine >= (ctx.total ?? 0)) ctx.hit = false
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
        const ok = bt.save(target, 'agi', self.stats.save, 0, self)
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
