// CORE systems that need more than a passive bonus: Raleigh, Black Witch, Dusk Wing, Goblin, Pegasus,
// Barbarossa, Sherman (and the Pegasus frame traits).
import type { Battle } from '../../battle'
import { blastTiles, chebyshev, distanceToTile, footprint, hasLineOfSightToTile, lineTiles, tileAt, unitsOnTiles } from '../../grid'
import { rollDice } from '../../rng'
import type { Pos, Unit } from '../../types'
import { registerScripts, type CustomAction, type ItemScript } from '../registry'

const action = (a: Omit<CustomAction, 'usable'> & { usable?: CustomAction['usable'] }): CustomAction => ({ usable: () => true, ...a })
const weaponOf = (u: Unit, id: string) => u.weapons.find(w => w.dataId === id && !w.destroyed)
const chars = (b: Battle) => b.alive().filter(o => o.kind === 'mech' || o.kind === 'npc')
const hostiles = (b: Battle, u: Unit) => chars(b).filter(o => b.hostile(u, o))
const onTile = (u: Unit, tiles: Pos[]) => footprint(u).some(p => tiles.some(t => t.x === p.x && t.y === p.y))
const free = (b: Battle, p: Pos, except?: Unit) => !!tileAt(b.map, p) && !b.alive().some(o => o !== except && !o.flags.flat && footprint(o).some(q => q.x === p.x && q.y === p.y))
const oncePerRound = (u: Unit, key: string) => { const k = `round:${key}`; if (u.flags[k]) return false; u.flags[k] = true; return true }

/** Agility save or 1d6 energy (half on a success). */
function hologramBlast(b: Battle, src: Unit, t: Unit) {
  const dmg = rollDice(b.rng, '1d6').total
  const ok = b.save(t, 'agi', src.stats.save, 0, src)
  b.applyDamage(t, [{ type: 'Energy', amount: ok ? b.halfOnSave(t, dmg) : dmg }], { source: src })
}

// ------------------------------------------------------------------ Black Witch: Mag Field
interface MagField { c: Pos; tiles: Pos[]; until: number; count: number }
const field = (u: Unit): MagField | undefined => u.flags.magField
function endMagField(b: Battle, self: Unit) {
  const f = field(self)
  if (!f) return
  self.flags.magField = undefined
  b.areas = b.areas.filter(a => a.id !== `magfield-${self.id}`)
  b.invalidateTerrain()
  for (const u of b.alive()) u.statuses = u.statuses.filter(s => s.data?.magField !== self.id)
  const n = Math.min(6, f.count)
  if (!n) return
  b.say(`The mag field collapses: ${f.count} stopped attack(s) resume toward its centre!`, 'attack')
  for (const t of chars(b).filter(t => onTile(t, f.tiles))) {
    const ctx = b.newAttackCtx(self, t, { mode: 'free', attackBonus: n, ranged: true })
    b.rollToHit(ctx)
    if (ctx.hit) b.applyDamage(t, [{ type: 'Kinetic', amount: rollDice(b.rng, `${n}d6`).total }], { source: self })
  }
}

// ------------------------------------------------------------------ Goblin: Symbiosis
const CONDITIONS = ['immobilized', 'impaired', 'jammed', 'lockon', 'shredded', 'slowed', 'stunned']
function detach(b: Battle, self: Unit) {
  const host = b.unit(self.flags.host)
  self.flags.host = undefined
  self.flags.flat = false
  self.statuses = self.statuses.filter(s => !s.data?.symbiosis)
  if (host) {
    host.flags.goblin = undefined
    if (host.flags.symOrig) { host.stats.edef = host.flags.symOrig.edef; host.stats.techAttack = host.flags.symOrig.techAttack; host.stats.sys = host.flags.symOrig.sys ?? host.stats.sys; host.flags.symOrig = undefined }
    // when the effect ends, you don't take a turn until the next round
    if (self.flags.symbiosisTurns) { self.activationsLeft = 0; if (b.chainTurn === self.id) b.chainTurn = null }
    self.flags.symbiosisTurns = false
    delete self.flags.noOvercharge
    // step off the host into the nearest free space
    let best: Pos | null = null
    for (let r = 1; r <= 3 && !best; r++) for (let dy = -r; dy <= r && !best; dy++) for (let dx = -r; dx <= r && !best; dx++) {
      const p = { x: host.pos.x + dx, y: host.pos.y + dy }
      if (free(b, p, self)) best = p
    }
    if (best) { const from = self.pos; self.pos = best; b.emit({ type: 'move', unitId: self.id, path: [from, best] }) }
  }
  b.invalidateTerrain()
  b.say(`${self.name} detaches.`)
}

function symbiosisHost(b: Battle, self: Unit): Unit | null {
  return chars(b).find(a => a.kind === 'mech' && !b.hostile(self, a) && a !== self && b.adjacent(self, a) && a.stats.size > self.stats.size && !a.flags.goblin) ?? null
}
function attach(b: Battle, self: Unit, host: Unit) {
  self.flags.symbiosisReady = false
  self.flags.host = host.id
  self.flags.flat = true
  host.flags.goblin = self.id
  host.flags.symOrig = { edef: host.stats.edef, techAttack: host.stats.techAttack, sys: host.stats.sys }
  host.stats.sys = Math.max(host.stats.sys, self.stats.sys)
  self.flags.symbiosisRound = b.round
  host.stats.edef = Math.max(host.stats.edef, self.stats.edef)
  host.stats.techAttack = Math.max(host.stats.techAttack, self.stats.techAttack)
  const from = self.pos
  self.pos = { ...host.pos }
  b.addStatus(self, 'immobilized', 'until_cleared', self, { symbiosis: true })
  b.emit({ type: 'move', unitId: self.id, path: [from, self.pos] })
  b.invalidateTerrain()
  b.say(`${self.name} attaches to ${host.name}.`)
}

const scripts: ItemScript[] = [
  // ---------------------------------------------------------------- Raleigh
  {
    id: 'core:mf_raleigh',
    note: 'Thunder God: the Mjolnir chambers 2 rounds per turn it is not fired (max 6); fires all at 4 kinetic each, AP and Shredding at 4+',
    onCoreActivate(b, u) { u.flags.thunderGod = true; u.flags.chambers = 0; b.say(`${u.name} spins up the M35 Mjolnir.`) },
    onTurnEnd(b, u) {
      if (!u.flags.thunderGod || u.flags['turn:firedM35']) return
      u.flags.chambers = Math.min(6, (u.flags.chambers ?? 0) + 2)
      b.say(`${u.name}'s Mjolnir chambers rounds (${u.flags.chambers}).`)
    },
    beforeAttack(_b, self, ctx, role) {
      if (role !== 'attacker' || !self.flags.thunderGod || ctx.weapon?.dataId !== 'mw_raleigh_integrated') return
      const n = self.flags.chambers ?? 0
      self.flags['turn:firedM35'] = true
      if (n > 1) ctx.bonusDamage.push({ type: 'Kinetic', val: 4 * (n - 1) } as any)
      if (n >= 4 && ctx.profile && !ctx.profile.tags.some(t => t.id === 'tg_ap')) { ctx.profile.tags.push({ id: 'tg_ap', thunder: true } as any); ctx.reasons.push(`Thunder God ×${n} (AP)`) }
      else if (n) ctx.reasons.push(`Thunder God ×${n}`)
      self.flags.firedChambers = n
    },
    afterAttack(b, self, ctx, role) {
      if (role !== 'attacker' || ctx.weapon?.dataId !== 'mw_raleigh_integrated' || self.flags.firedChambers == null) return
      if (ctx.profile) ctx.profile.tags = ctx.profile.tags.filter(t => !(t as any).thunder)
      if (ctx.hit && self.flags.firedChambers >= 4 && !ctx.target.destroyed) b.addStatus(ctx.target, 'shredded', 'next_turn_end_target', self)
      self.flags.firedChambers = undefined
      self.flags.chambers = 0
    },
  },
  // ---------------------------------------------------------------- Black Witch
  {
    id: 'core:mf_black_witch',
    note: 'Mag Field: Blast 3 touching you until the end of your next turn: difficult terrain; kinetic/explosive ranged attacks crossing its edge stop and later resume; metal characters pulled in and Immobilized',
    // the aimed version of the CORE power (the generic CORE button aims at the nearest hostiles)
    actions: (_b, u) => (u.coreAvailable ? [action({
      key: 'magfield', name: 'CORE: Mag Field (aimed)', activation: 'full', target: 'tile', range: 4, area: { shape: 'blast', size: 3 },
      text: 'Activate your CORE power: project a Blast 3 magnetic field that touches a space adjacent to you.',
      run: (bt, self, t) => {
        const c = t && 'x' in t ? t : (t as Unit).pos
        if (chebyshev(c, self.pos) > 4) throw new Error('The field must touch a space adjacent to you')
        self.coreAvailable = false
        self.coreActive = true
        placeMagField(bt, self, c)
      },
      aiTarget: (bt, self) => magAim(bt, self),
      aiScore: (bt, self) => hostiles(bt, self).filter(h => bt.distance(self, h) <= 7).length * 2,
    })] : []),
    onCoreActivate(b, u) { const c = magAim(b, u); if (c) placeMagField(b, u, c) },
    fields: (_b, u) => (field(u) ? [{ tiles: field(u)!.tiles, effect: 'control' as const, label: `${u.name}'s mag field: kinetic/explosive shots across its edge are stopped (${field(u)!.count} held)` }] : []),
    beforeAnyAttack(b, self, ctx) {
      const f = field(self)
      if (!f || ctx.tech || ctx.melee || !ctx.profile?.damage.some(d => d.type === 'Kinetic' || d.type === 'Explosive')) return
      if (onTile(ctx.attacker, f.tiles) === onTile(ctx.target, f.tiles)) return
      ctx.cancelled = true
      f.count++
      b.say(`  The mag field catches the shot at ${ctx.target.name}.`)
    },
    onAnyTurnStart(b, self, u) { magPull(b, self, u) },
    onMove(b, self, mover) { magPull(b, self, mover) },
    onTurnEnd(b, self) { const f = field(self); if (f && b.round >= f.until) endMagField(b, self) },
  },
  // ---------------------------------------------------------------- Dusk Wing
  {
    id: 'core:mf_dusk_wing',
    note: 'Hall of Mirrors: your moves leave holograms that detonate on hostiles (Agility save, 1d6 energy, half on success); Hologram Teleport',
    onCoreActivate(_b, u) { u.flags.mirrors = true; u.flags.holos = [] },
    onTurnStart(_b, u) { u.flags.noHolo = false },
    onMove(b, self, mover, path) {
      if (!self.flags.mirrors) return
      if (mover === self) {
        if (self.activeTurn && !self.flags.noHolo && path.length > 1) {
          const p = path[0]
          if (!(self.flags.holos as Pos[]).some(h => h.x === p.x && h.y === p.y)) self.flags.holos.push({ ...p })
        }
        return
      }
      if (!b.hostile(self, mover) || mover.destroyed) return
      const hit = (self.flags.holos as Pos[]).filter(h => path.some(p => chebyshev(p, h) <= 1))
      for (const h of hit) detonate(b, self, h, mover)
    },
    onAnyTurnStart(b, self, u) {
      if (!self.flags.mirrors || !b.hostile(self, u) || (u.kind !== 'mech' && u.kind !== 'npc')) return
      for (const h of (self.flags.holos as Pos[]).filter(h => footprint(u).some(p => chebyshev(p, h) <= 1))) detonate(b, self, h, u)
    },
    fields: (_b, u) => (u.flags.holos?.length ? [{ tiles: u.flags.holos, effect: 'harm' as const, label: `${u.name}'s hologram: detonates on hostiles that come near (Agility save, 1d6 energy)` }] : []),
    actions: (_b, u) => (u.flags.mirrors && u.flags.holos?.length ? [action({
      key: 'holo_teleport', name: 'Hologram Teleport', activation: 'quick', target: 'tile', range: 50, text: 'Teleport to one of your holograms; all holograms detonate as Burst 1 blasts.',
      run: (bt, self, t) => {
        const p = t && 'x' in t ? t : (t as Unit).pos
        const holos = self.flags.holos as Pos[]
        if (!holos.some(h => h.x === p.x && h.y === p.y)) throw new Error('Pick one of your holograms')
        if (!free(bt, p, self)) throw new Error('The hologram space is occupied')
        const from = self.pos
        self.pos = { ...p }
        bt.emit({ type: 'move', unitId: self.id, path: [from, p] })
        for (const h of holos) {
          const tiles = blastTiles(bt.map, h, 1)
          bt.emit({ type: 'area', tiles, kind: 'explosion' })
          for (const v of unitsOnTiles(hostiles(bt, self), tiles)) hologramBlast(bt, self, v)
        }
        self.flags.holos = []
        self.flags.noHolo = true
      },
      aiTarget: (bt, self) => {
        let best: Pos | null = null, n = 0
        for (const h of self.flags.holos as Pos[]) {
          const k = hostiles(bt, self).filter(v => footprint(v).some(p => chebyshev(p, h) <= 1)).length
          if (k > n && free(bt, h, self)) { n = k; best = h }
        }
        return best
      },
      aiScore: (bt, self, t) => (t && 'x' in t ? 2 * hostiles(bt, self).filter(v => footprint(v).some(p => (self.flags.holos as Pos[]).some(h => chebyshev(p, h) <= 1))).length : 0),
    })] : []),
  },
  // ---------------------------------------------------------------- Goblin
  {
    id: 'core:mf_goblin', partial: true,
    note: "Symbiosis: attach to a larger adjacent ally: move with it, hard cover; it uses your Systems, E-Defense and Tech Attack; you share its conditions and heat; from the next round you no longer take your own turns but act (no moving or Overcharge) on your host's activation — right after its turn rather than at any point during it; ends on detach (quick) or when either is Stunned",
    onRoundStart(b, self) {
      if (self.flags.host && b.round > (self.flags.symbiosisRound ?? b.round)) { self.activationsLeft = 0; self.flags.symbiosisTurns = true }
    },
    onAnyTurnEnd(b, self, u) {
      if (!self.flags.host || u.id !== self.flags.host || !self.flags.symbiosisTurns || self.destroyed) return
      self.activationsLeft = 1
      b.chainTurn = self.id
      b.say(`${self.name} acts on its host's turn.`)
    },
    onTurnStart(b, self) {
      if (self.flags.host && b.has(self, 'stunned')) { detach(b, self); return }
      if (self.flags.host) { self.moveLeft = 0; self.flags.noOvercharge = true } else delete self.flags.noOvercharge
    },
    onAnyStatusAdded(b, self, target, st, duration, source) {
      if (!self.flags.host || target.id !== self.flags.host) return
      if (st === 'stunned') { detach(b, self); return }
      if (CONDITIONS.includes(st)) b.addStatus(self, st, duration, source)
    },
    onAnyHeat(b, self, target, amount, source) { if (self.flags.host && target.id === self.flags.host) b.addHeat(self, amount, source) },
    onCoreActivate(b, u) {
      const host = symbiosisHost(b, u)
      if (host) attach(b, u, host)
      else { u.flags.symbiosisReady = true; b.say(`${u.name} needs an adjacent, larger ally to attach to (Symbiosis stays ready this scene).`) }
    },
    actions: (b, u) => {
      if (u.flags.host) return [action({ key: 'detach', name: 'Detach (Symbiosis)', activation: 'quick', target: 'none', text: 'Detach from your host.', run: bt => detach(bt, u) })]
      if (!u.flags.symbiosisReady && !u.coreAvailable) return []
      return [action({
        key: 'symbiosis', name: u.coreAvailable ? 'CORE: Symbiosis' : 'Symbiosis', activation: 'quick', target: 'ally', range: 1, text: 'Attach to an adjacent allied mech larger than you.',
        run: (bt, self, t) => {
          const host = t as Unit
          if (!host || host.kind !== 'mech' || bt.hostile(self, host) || !bt.adjacent(self, host) || host.stats.size <= self.stats.size || host.flags.goblin) throw new Error('Needs an adjacent, larger allied mech without a Goblin')
          if (self.coreAvailable) { self.coreAvailable = false; self.coreActive = true }
          attach(bt, self, host)
        },
        aiTarget: (bt, self) => symbiosisHost(bt, self),
        aiScore: () => 3,
      })]
    },

    adjustCover: (_b, self, _a, target, c) => (target === self && self.flags.host ? 'hard' : c),
    onMove(b, self, mover) {
      if (mover.id !== self.flags.host) return
      const from = self.pos
      self.pos = { ...mover.pos }
      b.emit({ type: 'move', unitId: self.id, path: [from, self.pos] })
    },
    onAnyTurnStart(b, self, u) {
      if (!self.flags.host) return
      const host = b.unit(self.flags.host)
      if (!host || host.destroyed || b.has(self, 'stunned') || b.has(host, 'stunned')) detach(b, self)
      else if (u === host) { const from = self.pos; self.pos = { ...host.pos }; if (from.x !== host.pos.x || from.y !== host.pos.y) b.emit({ type: 'move', unitId: self.id, path: [from, self.pos] }) }
    },
    onDestroyed(b, self, v) { if (v.id === self.flags.host || v === self) { if (v === self) { const h = b.unit(self.flags.host); if (h) { h.flags.goblin = undefined; if (h.flags.symOrig) { h.stats.edef = h.flags.symOrig.edef; h.stats.techAttack = h.flags.symOrig.techAttack } } } else detach(b, self) } },
  },
  // ---------------------------------------------------------------- Pegasus
  {
    id: 'frame:mf_pegasus',
    note: '"By the Way, I Know Everything": toggle average damage instead of rolling (the GUN trait has no rules)',
    actions: (_b, u) => [action({
      key: 'pegasus_avg', name: u.flags.averageDamage ? 'Roll damage normally' : 'Use average damage', activation: 'free', target: 'none',
      text: 'Toggle: deal average damage (1d3=2, 1d6=4, 2d6=7, 3d6=11, 4d6=14) instead of rolling.',
      run: (bt, self) => { self.flags.averageDamage = !self.flags.averageDamage; bt.say(`${self.name} ${self.flags.averageDamage ? 'will deal average damage' : 'rolls damage again'}.`) },
    })],
  },
  {
    id: 'core:mf_pegasus',
    note: 'Ushabti Omnigun: free action 1/round (3/round after Unshackle Ushabti): 1 AP kinetic within 15 and line of sight that cannot be reduced',
    onCoreActivate(_b, u) { u.flags.omnigunUses = 3 },
    actions: (b, u) => [action({
      key: 'omnigun', name: 'Fire Ushabti Omnigun', activation: 'free', target: 'enemy', range: 15,
      text: 'Deal 1 AP kinetic damage to a character within range 15 and line of sight. Not an attack; hits automatically; cannot be reduced.',
      usable: (bt, self) => (!self.activeTurn ? 'Only on your turn' : (self.flags['round:omnigun'] ?? 0) >= (self.flags.omnigunUses ?? 1) ? 'Already used this round' : true),
      run: (bt, self, t) => {
        const target = t as Unit
        if (bt.distance(self, target) > 15 || !bt.los(self, target)) throw new Error('Needs range 15 and line of sight')
        self.flags['round:omnigun'] = (self.flags['round:omnigun'] ?? 0) + 1
        bt.say(`${self.name}'s Ushabti Omnigun touches ${target.name}.`, 'attack')
        bt.applyDamage(target, [{ type: 'Kinetic', amount: 1 }], { source: self, ap: true, irreducible: true })
      },
      aiTarget: (bt, self) => hostiles(bt, self).filter(h => bt.distance(self, h) <= 15 && bt.los(self, h)).sort((x, y) => (x.isGrunt ? -100 : x.hp) - (y.isGrunt ? -100 : y.hp))[0] ?? null,
      aiScore: () => 3,
    })],
  },
  // ---------------------------------------------------------------- Barbarossa
  {
    id: 'core:mf_barbarossa',
    note: 'Charge Rail: Apocalypse Die counts down from 4 (resets on moving, Stunned or Jammed); fire the Apocalypse Rail at 1–3 as a full action',
    onCoreActivate(b, u) { u.flags.apocDie = 4; b.say(`${u.name} begins charging the Apocalypse Rail (die 4).`) },
    onTurnStart(b, u) {
      if (u.flags.apocDie == null) return
      u.flags.apocDie = b.has(u, 'stunned') || b.has(u, 'jammed') ? 4 : Math.max(1, u.flags.apocDie - 1)
      b.say(`${u.name}'s Apocalypse Die: ${u.flags.apocDie}.`)
    },
    onMove(_b, self, mover) { if (mover === self && self.flags.apocDie != null) self.flags.apocDie = 4 },
    actions: (_b, u) => {
      const die = u.flags.apocDie
      if (die == null) return []
      const range = die === 3 ? 20 : die === 2 ? 25 : 30
      return [action({
        key: 'apocalypse_rail', name: `Fire Apocalypse Rail (die ${die})`, activation: 'full', target: 'tile', range, area: { shape: 'blast', size: 2 },
        text: die >= 4 ? 'The rail is still charging (die 4).' : 'Fire the Apocalypse Rail (no movement or other actions this turn; not within range 5).',
        usable: (_bt, self) => (die >= 4 ? 'Still charging (die 4)' : self.flags['turn:moved'] ? 'You moved this turn' : self.actionsLeft < 2 ? 'Must be your only action this turn' : true),
        run: (bt, self, t) => {
          const c = t && 'x' in t ? t : (t as Unit).pos
          if (distanceToTile(bt.map, self, c) <= 5) throw new Error('Cannot fire within range 5')
          if (!hasLineOfSightToTile(bt.effectiveMap(), self, c)) throw new Error('No line of sight')
          const w = weaponOf(self, 'mw_barbarossa_integrated')
          if (!w) throw new Error('No Apocalypse Rail')
          w.profileIndex = Math.min(w.profiles.length - 1, 4 - die)
          const r = bt.weaponAttack(self, w, { tile: c }, 'free')
          const tiles = blastTiles(bt.map, c, 2)
          for (const ctx of r.ctxs) if (ctx.hit && !ctx.target.destroyed) {
            if (die <= 2) bt.addStatus(ctx.target, 'shredded', 'next_turn_end_target', self)
            if (die === 2) bt.addStatus(ctx.target, 'impaired', 'next_turn_end_target', self)
            if (die === 1) bt.addStatus(ctx.target, 'stunned', 'next_turn_end_target', self)
          }
          bt.damageObjectsIn(tiles, die === 3 ? 20 : die === 2 ? 40 : 100, { source: self, ap: true })
          bt.areas.push({ id: `apoc-${bt.round}-${self.id}`, kind: 'soft_cover', tiles, ownerId: self.id, ...(die === 1 ? {} : { expiresRound: bt.round + 1 }) })
          if (die === 2) bt.areas.push({ id: `apoc-fire-${bt.round}-${self.id}`, kind: 'damage', tiles, damage: '4', ownerId: self.id, expiresRound: bt.round + 1 })
          if (die === 1) bt.areas.push({ id: `apoc-crater-${bt.round}-${self.id}`, kind: 'difficult', tiles, ownerId: self.id })
          bt.invalidateTerrain()
          self.flags.apocDie = 4
          self.moveLeft = 0
          self.actionsLeft = 0
        },
        aiTarget: (bt, self) => {
          let best: Pos | null = null, n = 0
          for (const h of hostiles(bt, self)) {
            if (distanceToTile(bt.map, self, h.pos) <= 5 || distanceToTile(bt.map, self, h.pos) > range) continue
            const k = unitsOnTiles(hostiles(bt, self), blastTiles(bt.map, h.pos, 2)).length
            if (k > n) { n = k; best = h.pos }
          }
          return best
        },
        aiScore: (bt, self, t) => (die >= 4 || !t ? 0 : 4 + (4 - die) * 2 + unitsOnTiles(hostiles(bt, self), blastTiles(bt.map, t as Pos, 2)).length * 2),
      })]
    },
  },
  // ---------------------------------------------------------------- Sherman
  {
    id: 'core:mf_sherman',
    note: 'ZF4 SOLIDCORE charges (Stabilize +1, max 4; the profile follows charges, reset after firing); COREBURN: +3 charges, Stabilize +2, 10 AP energy per charge to deployables hit',
    init(u) { u.flags.zfCharges = 1; syncZf(u) },
    onStabilize(b, u) {
      u.flags.zfCharges = Math.min(4, (u.flags.zfCharges ?? 1) + (u.flags.coreburn ? 2 : 1))
      syncZf(u)
      b.say(`${u.name}'s ZF4 SOLIDCORE: ${u.flags.zfCharges} charge(s).`)
    },
    onCoreActivate(b, u) {
      u.flags.coreburn = true
      u.flags.zfCharges = Math.min(4, (u.flags.zfCharges ?? 1) + 3)
      syncZf(u)
      b.say(`${u.name} engages COREBURN: ${u.flags.zfCharges} charges.`)
    },
    beforeAttack(_b, self, ctx, role) { if (role === 'attacker' && ctx.weapon?.dataId === 'mw_sherman_integrated') self.flags.zfFired = self.flags.zfCharges ?? 1 },
    afterAnyAttack(b, self, ctx) {
      // once the whole line attack has resolved: COREBURN scorches objects and terrain along the beam, then charges reset
      if (ctx.attacker !== self || self.flags.zfFired == null || ctx.weapon?.dataId !== 'mw_sherman_integrated') return
      if (self.flags.coreburn) b.damageObjectsIn(lineTiles(b.map, self, ctx.target.pos, 4 * self.flags.zfFired), 10 * self.flags.zfFired, { source: self, ap: true })
      self.flags.zfCharges = 1; syncZf(self); self.flags.zfFired = undefined
    },
  },
]

function syncZf(u: Unit) {
  const w = weaponOf(u, 'mw_sherman_integrated')
  if (w) w.profileIndex = Math.max(0, Math.min(w.profiles.length - 1, (u.flags.zfCharges ?? 1) - 1))
}

function magAim(b: Battle, self: Unit): Pos | null {
  const h = hostiles(b, self).sort((a, b2) => b.distance(self, a) - b.distance(self, b2))[0]
  if (!h) return null
  const dx = Math.sign(h.pos.x - self.pos.x), dy = Math.sign(h.pos.y - self.pos.y)
  const c = { x: self.pos.x + dx * Math.min(4, Math.abs(h.pos.x - self.pos.x)), y: self.pos.y + dy * Math.min(4, Math.abs(h.pos.y - self.pos.y)) }
  return tileAt(b.map, c) ? c : self.pos
}
function placeMagField(b: Battle, self: Unit, c: Pos) {
  endMagField(b, self)
  const tiles = blastTiles(b.map, c, 3)
  self.flags.magField = { c, tiles, until: b.round + 1, count: 0 } as MagField
  b.areas.push({ id: `magfield-${self.id}`, kind: 'difficult', tiles, ownerId: self.id })
  b.invalidateTerrain()
  b.emit({ type: 'area', tiles, kind: 'attack' })
  b.say(`${self.name} projects a magnetic field.`)
}

function magPull(b: Battle, self: Unit, u: Unit) {
  const f = field(self)
  if (!f || u === self || u.destroyed || (u.kind !== 'mech' && u.kind !== 'npc') || u.role === 'Biological' || !onTile(u, f.tiles)) return
  if (!oncePerRound(u, `magfield:${self.id}`)) return
  if (b.save(u, 'hull', self.stats.save, 0, self)) return
  const d = chebyshev(u.pos, f.c)
  if (d > 0) b.forceMove(u, f.c, d, -1)
  if (!u.destroyed) b.addStatus(u, 'immobilized', 'until_cleared', self, { magField: self.id })
}

function detonate(b: Battle, self: Unit, h: Pos, victim: Unit) {
  self.flags.holos = (self.flags.holos as Pos[]).filter(x => x !== h)
  b.emit({ type: 'area', tiles: [h], kind: 'explosion' })
  b.say(`A hologram of ${self.name} detonates by ${victim.name}!`)
  hologramBlast(b, self, victim)
}

registerScripts(scripts)
