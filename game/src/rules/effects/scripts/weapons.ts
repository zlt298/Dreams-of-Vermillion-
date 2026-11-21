// Weapons, weapon mods and core bonuses with rules beyond the structured data.
// Weapon scripts run for every attack the owner makes, so each filters on ctx.weapon.dataId.
import { burstTiles, coneTiles, lineTiles, unitsOnTiles, footprint } from '../../grid'
import { rollDice } from '../../rng'
import type { Pos, Unit, Weapon } from '../../types'
import type { Battle } from '../../battle'
import { registerScripts, type AttackCtx, type CustomAction, type ItemScript } from '../registry'

const once = (u: Unit, key: string, scope: 'round' | 'turn' | 'scene' = 'round'): boolean => {
  const k = `${scope}:${key}`
  if (u.flags[k]) return false
  u.flags[k] = true
  return true
}
const action = (a: Omit<CustomAction, 'usable'> & { usable?: CustomAction['usable'] }): CustomAction => ({ usable: () => true, ...a })
const is = (ctx: AttackCtx, id: string) => ctx.weapon?.dataId === id
const primary = (ctx: AttackCtx) => ctx.mode !== 'secondary'
const weaponOf = (u: Unit, id: string) => u.weapons.find(w => w.dataId === id && !w.destroyed)

/** after-attack hook that fires once per weapon firing (not per target) */
function perFiring(id: string, f: (b: Battle, self: Unit, ctx: AttackCtx) => void): Pick<ItemScript, 'afterAttack'> {
  return {
    afterAttack(b, self, ctx, role) {
      if (role !== 'attacker' || !is(ctx, id) || !primary(ctx)) return
      const k = `firing:${id}:${b.events.length}`
      if (self.flags.lastFiring === k) return
      self.flags.lastFiring = k
      f(b, self, ctx)
    },
  }
}

function secondaryAttack(b: Battle, self: Unit, w: Weapon, t: Unit) {
  b.weaponAttack(self, w, { targetId: t.id }, 'secondary', { noBonusDamage: true })
}

registerScripts([
  // ------------------------------------------------------------ weapons
  {
    id: 'mw_chain_axe', note: 'On crit: Shredded until end of turn',
    afterAttack(b, self, ctx, role) { if (role === 'attacker' && is(ctx, 'mw_chain_axe') && ctx.crit && !ctx.target.destroyed) b.addStatus(ctx.target, 'shredded', 'end_of_turn', self) },
  },
  {
    id: 'mw_bristlecrown_flechette_launcher', note: 'Ignores engaged penalty; 3 damage to grappled/biological',
    beforeAttack(b, self, ctx, role) { if (role === 'attacker' && is(ctx, 'mw_bristlecrown_flechette_launcher') && ctx.reasons.includes('Engaged -1')) ctx.difficulty-- },
    afterAttack(b, self, ctx, role) {
      if (role === 'attacker' && is(ctx, 'mw_bristlecrown_flechette_launcher') && ctx.hit && !ctx.target.destroyed && (b.has(ctx.target, 'grappled') || ctx.target.role === 'Biological')) b.applyDamage(ctx.target, [{ type: 'Kinetic', amount: 2 }], { source: self })
    },
  },
  { id: 'mw_cutter_mkii_plasma_torch', note: 'Bonus vs objects/terrain only (no effect on characters)' },
  {
    id: 'mw_daisy_cutter', note: 'Soft-cover cloud in the cone until the end of your next turn',
    ...perFiring('mw_daisy_cutter', (b, self, ctx) => b.addArea({ kind: 'soft_cover', tiles: coneTiles(b.map, self, ctx.target.pos, 7), expiresRound: b.round + 1, ownerId: self.id })),
  },
  {
    id: 'mw_impact_lance', note: 'Also attacks everyone in a line to the target (+1 heat per extra target)',
    ...perFiring('mw_impact_lance', (b, self, ctx) => {
      const w = ctx.weapon!
      const line = lineTiles(b.map, self, ctx.target.pos, Math.max(1, b.distance(self, ctx.target)))
      for (const t of unitsOnTiles(b.alive(), line)) {
        if (t === ctx.target || t === self) continue
        b.addHeat(self, 1)
        b.weaponAttack(self, w, { targetId: t.id }, 'secondary')
      }
    }),
  },
  {
    id: 'mw_combat_drill', partial: true, note: '+1d6 bonus damage vs Prone/Immobilized/Stunned (approximates chained Overkill)',
    beforeAttack(b, self, ctx, role) {
      if (role === 'attacker' && is(ctx, 'mw_combat_drill') && ['prone', 'immobilized', 'stunned'].some(s => b.has(ctx.target, s as any))) ctx.bonusDamage.push({ type: 'Kinetic', val: '1d6' })
    },
  },
  {
    id: 'mw_magnetic_cannon', note: 'Hull save or pulled 1d3+1 toward you',
    afterAttack(b, self, ctx, role) {
      if (role === 'attacker' && is(ctx, 'mw_magnetic_cannon') && ctx.hit && !ctx.target.destroyed && !b.save(ctx.target, 'hull', self.stats.save)) b.forceMove(ctx.target, self, rollDice(b.rng, '1d3+1').total, -1)
    },
  },
  {
    id: 'mw_veil_rifle', note: 'Allies in the line gain soft cover instead of being attacked',
    beforeAttack(b, self, ctx, role) {
      if (role !== 'attacker' || !is(ctx, 'mw_veil_rifle') || b.hostile(self, ctx.target)) return
      ctx.cancelled = true
      b.addArea({ kind: 'soft_cover', tiles: footprint(ctx.target), expiresRound: b.round + 1, ownerId: self.id })
    },
  },
  {
    id: 'mw_sharanga_missiles', note: 'Attacks a second target',
    ...perFiring('mw_sharanga_missiles', (b, self, ctx) => {
      const t = b.alive().find(o => o !== ctx.target && b.hostile(self, o) && b.validTarget(self, ctx.weapon!, o) === true)
      if (t) b.weaponAttack(self, ctx.weapon!, { targetId: t.id }, 'secondary')
    }),
  },
  { id: 'mw_pinaka_missiles', partial: true, note: 'Fires as a normal blast (second area / delayed 3d6 impact not modelled)' },
  {
    id: 'mw_fold_knife', note: 'Teleport 2 after attacking',
    actions: (b, u) => (u.flags['turn:foldknife'] ? [action({
      key: 'foldknife', name: 'Fold Knife Teleport', activation: 'free', target: 'tile', range: 2, text: 'Teleport 2 spaces in any direction.',
      run: (bt, self, t) => {
        const p = t as Pos
        if (Math.max(Math.abs(p.x - self.pos.x), Math.abs(p.y - self.pos.y)) > 2) throw new Error('Out of range')
        if (bt.alive().some(o => o !== self && footprint(o).some(q => q.x === p.x && q.y === p.y))) throw new Error('Occupied')
        delete self.flags['turn:foldknife']
        self.pos = p
        bt.emit({ type: 'move', unitId: self.id, path: [p] })
      },
    })] : []),
    afterAttack(b, self, ctx, role) { if (role === 'attacker' && is(ctx, 'mw_fold_knife')) self.flags['turn:foldknife'] = true },
  },
  {
    id: 'mw_nanobot_whip', note: 'On crit: pull target adjacent',
    afterAttack(b, self, ctx, role) { if (role === 'attacker' && is(ctx, 'mw_nanobot_whip') && ctx.crit && !ctx.target.destroyed) b.forceMove(ctx.target, self, 3, -1) },
  },
  {
    id: 'mw_ghoul_nexus', note: 'Picks the damage type the target resists least',
    beforeAttack(b, self, ctx, role) {
      if (role !== 'attacker' || !is(ctx, 'mw_ghoul_nexus') || !ctx.profile) return
      const pick = ['Energy', 'Kinetic', 'Explosive'].find(t => !ctx.target.resist.includes(t)) ?? 'Energy'
      ctx.profile.damage = ctx.profile.damage.map(d => ({ ...d, type: pick }))
    },
  },
  { id: 'mw_ghast_nexus', partial: true, note: 'Attacks normally (drone deployment mode not modelled)' },
  {
    id: 'mw_annihilation_nexus', partial: true, note: 'Echo attack next turn (centred on you; drone centring not modelled)',
    ...perFiring('mw_annihilation_nexus', (b, self) => { self.flags.annihilationEcho = b.round + 1 }),
    actions: (b, u) => (u.flags.annihilationEcho === b.round ? [action({
      key: 'annecho', name: 'Annihilation Echo', activation: 'protocol', target: 'none', text: 'Second attack (no bonus damage).',
      run: (bt, self) => { delete self.flags.annihilationEcho; const w = weaponOf(self, 'mw_annihilation_nexus'); if (w) bt.weaponAttack(self, w, { tile: self.pos }, 'secondary', { noBonusDamage: true }) },
      aiScore: () => 5,
    })] : []),
  },
  {
    id: 'mw_arc_projector', note: 'Chains to new targets within 3 on hits (1 heat each, no bonus damage)',
    ...perFiring('mw_arc_projector', (b, self, ctx) => {
      const w = ctx.weapon!
      const hit = new Set([ctx.target.id])
      let last = ctx.target, lastHit = !!ctx.hit
      while (lastHit && !self.destroyed) {
        const next = b.alive().find(o => b.hostile(self, o) && !hit.has(o.id) && b.distance(last, o) <= 3 && o.kind !== 'deployable')
        if (!next) break
        hit.add(next.id)
        b.addHeat(self, 1)
        const r = b.weaponAttack(self, w, { targetId: next.id }, 'secondary', { noBonusDamage: true })
        lastHit = !!r.ctxs[0]?.hit
        last = next
      }
    }),
  },
  {
    id: 'mw_autogun', note: 'Fires automatically as a free action at the end of your turn',
    onTurnEnd(b, u) {
      const w = weaponOf(u, 'mw_autogun')
      if (!w || !w.loaded) return
      const t = b.alive().filter(o => b.hostile(u, o) && (o.kind === 'mech' || o.kind === 'npc') && b.validTarget(u, w, o) === true).sort((a, c) => a.hp - c.hp)[0]
      if (t) { b.say(`${u.name}'s autogun fires.`); b.weaponAttack(u, w, { targetId: t.id }, 'free') }
    },
  },
  {
    id: 'mw_plasma_thrower', partial: true, note: 'Leaves 3 burning spaces for the scene (cone/line choice uses line)',
    ...perFiring('mw_plasma_thrower', (b, self, ctx) => {
      const tiles = lineTiles(b.map, self, ctx.target.pos, 10).slice(-3)
      b.addArea({ kind: 'damage', tiles, damage: '1d6', ownerId: self.id })
    }),
  },
  {
    id: 'mw_shatterhead_colony_missiles', note: 'Attack rolls ignore difficulty',
    beforeAttack(b, self, ctx, role) { if (role === 'attacker' && is(ctx, 'mw_shatterhead_colony_missiles')) ctx.ignoreDifficulty = true },
  },
  {
    id: 'mw_tachyon_lance', note: 'Danger Zone backblast (cone 3 behind you)',
    ...perFiring('mw_tachyon_lance', (b, self, ctx) => {
      if (!b.has(self, 'dangerzone')) return
      const back = { x: 2 * self.pos.x - ctx.target.pos.x, y: 2 * self.pos.y - ctx.target.pos.y }
      const tiles = coneTiles(b.map, self, back, 3)
      b.emit({ type: 'area', tiles, kind: 'explosion' })
      for (const t of unitsOnTiles(b.alive(), tiles)) if (t !== self && !b.save(t, 'eng', self.stats.save)) b.applyDamage(t, [{ type: 'Burn', amount: 4 }, { type: 'Heat', amount: 2 }], { source: self })
      b.addArea({ kind: 'soft_cover', tiles, expiresRound: b.round + 1, ownerId: self.id })
    }),
  },
  {
    id: 'mw_annihilator', note: 'Secondary attacks against everyone in burst 1 of the target',
    ...perFiring('mw_annihilator', (b, self, ctx) => {
      for (const t of unitsOnTiles(b.alive(), burstTiles(b.map, ctx.target, 1))) if (t !== ctx.target && t !== self) secondaryAttack(b, self, ctx.weapon!, t)
    }),
  },
  {
    id: 'mw_fuel_rod_gun', note: 'Clear 4 heat on attack',
    ...perFiring('mw_fuel_rod_gun', (b, self) => { self.heat = Math.max(0, self.heat - 4); b.say(`${self.name} vents 4 heat.`) }),
  },
  {
    id: 'mw_lancaster_integrated', note: 'Latch Drone: attack an ally vs Evasion 8; on hit spend 1 Repair to restore half their HP',
    actions: (b, u) => [action({
      key: 'latch', name: 'Latch Drone Repair', activation: 'quick', target: 'ally', range: 8, text: 'Ranged attack vs Evasion 8 on an allied mech; on a hit spend 1 Repair to restore half its HP.',
      usable: (bt, self) => (self.repairs <= 0 ? 'No repairs' : true),
      run: (bt, self, t) => {
        const target = t as Unit
        const r = bt.rng.d(20) + self.stats.grit
        bt.say(`  Latch drone: ${r} vs 8`)
        if (r >= 8) { self.repairs--; bt.heal(target, Math.ceil(target.stats.hp / 2)) }
      },
      aiScore: (bt, self, t) => (t && 'hp' in t ? (t.stats.hp - t.hp) * 0.6 : 0),
    })],
  },
  {
    id: 'mw_raleigh_integrated', note: 'Mjolnir: may also fire as a free action when you reload (1/round)',
    actions: (b, u) => (u.flags.reloaded && !u.flags['round:mjolnir'] ? [action({
      key: 'mjolnir', name: 'M35 Mjolnir (free)', activation: 'free', target: 'enemy', range: 5, text: 'Fire the Mjolnir as a free action after reloading.',
      run: (bt, self, t) => { self.flags['round:mjolnir'] = true; delete self.flags.reloaded; const w = weaponOf(self, 'mw_raleigh_integrated'); if (w) bt.weaponAttack(self, w, { targetId: (t as Unit).id }, 'free') },
    })] : []),
  },
  // ------------------------------------------------------------ mods
  {
    id: 'wm_thermal_charge', note: 'On hit: +1d6 explosive (3 charges)',
    beforeAttack(b, self, ctx, role) {
      if (role === 'attacker' && ctx.weapon?.modId === 'wm_thermal_charge' && (self.flags.thermalCharges ?? 3) > 0) self.flags.thermalReady = true
    },
    afterAttack(b, self, ctx, role) {
      if (role !== 'attacker' || !self.flags.thermalReady) return
      delete self.flags.thermalReady
      if (ctx.hit && !ctx.target.destroyed) { self.flags.thermalCharges = (self.flags.thermalCharges ?? 3) - 1; b.applyDamage(ctx.target, [{ type: 'Explosive', amount: rollDice(b.rng, '1d6').total }], { source: self }) }
    },
  },
  {
    id: 'wm_shock_wreath', partial: true, note: '1/round on hit: 1d6 burn (quick-action cost waived)',
    afterAttack(b, self, ctx, role) {
      if (role === 'attacker' && ctx.weapon?.modId === 'wm_shock_wreath' && ctx.hit && !ctx.target.destroyed && once(self, 'wreath')) b.applyDamage(ctx.target, [{ type: 'Burn', amount: rollDice(b.rng, '1d6').total }], { source: self })
    },
  },
  {
    id: 'wm_phase_ready_mod', note: 'Ignores LoS and cover; targets count as Invisible',
    beforeAttack(b, self, ctx, role) {
      if (role === 'attacker' && ctx.weapon?.modId === 'wm_phase_ready_mod') {
        ctx.ignoreCover = true
        ctx.forceInvisible = true
        ctx.difficulty -= ctx.reasons.includes('Hard cover -2') ? 2 : ctx.reasons.includes('Soft cover -1') ? 1 : 0
      }
    },
  },
  // ------------------------------------------------------------ core bonuses
  {
    id: 'cb_overpower_caliber', partial: true, note: '1/round +1d6 bonus damage on a hit (applies to any weapon; the chosen weapon is not exported by COMP/CON)',
    afterAttack(b, self, ctx, role) {
      if (role === 'attacker' && ctx.hit && !ctx.tech && !ctx.target.destroyed && ctx.weapon && once(self, 'overpower')) b.applyDamage(ctx.target, [{ type: ctx.profile?.damage[0]?.type ?? 'Kinetic', amount: rollDice(b.rng, '1d6', { crit: ctx.crit }).total }], { source: self })
    },
  },
  {
    id: 'cb_integrated_weapon', note: 'Integrated aux fires free (1/round) when you fire another weapon',
    afterAttack(b, self, ctx, role) {
      if (role !== 'attacker' || !ctx.weapon || !primary(ctx) || ctx.mode === 'overwatch') return
      const w = self.weapons.find(w => w.flags?.cbIntegrated && w !== ctx.weapon && b.weaponReady(self, w))
      if (!w || !once(self, 'cbint')) return
      const t = b.validTarget(self, w, ctx.target) === true ? ctx.target : b.alive().find(o => b.hostile(self, o) && b.validTarget(self, w, o) === true)
      if (t) b.weaponAttack(self, w, { targetId: t.id }, 'secondary')
    },
  },
  { id: 'cb_mount_retrofitting', note: 'Mount layout handled by COMP/CON export' },
  {
    id: 'cb_universal_compatibility', note: 'On CORE activation: restore HP, cool, 1-in-20 regain CORE',
    onCoreActivate(b, u) { u.hp = u.stats.hp; u.heat = 0; if (b.rng.d(20) === 20) { u.coreAvailable = true; b.say('  Universal Compatibility: CORE power regained!') } },
  },
  {
    id: 'cb_briareos_frame', partial: true, note: 'Resistance to all damage at 1 structure (0-structure survival not modelled)',
    modifyIncoming(b, self, d) { if (self.structure <= 1) d.amount = Math.ceil(d.amount / 2) },
  },
  {
    id: 'cb_all_theater_movement_suite', note: 'Toggle flight; 1 heat at end of turn while flying',
    actions: (b, u) => [action({ key: 'atms', name: u.flying ? 'Land' : 'Fly (ATMS)', activation: 'free', target: 'none', text: 'Count your movement as flying (1 heat at end of turn).', run: (bt, self) => { self.flying = !self.flying; self.flags.atms = self.flying } })],
    onTurnEnd: (b, u) => { if (u.flying && u.flags.atms) b.addHeat(u, 1) },
  },
  {
    id: 'cb_ghostweave', partial: true, note: 'Invisible during your turn',
    onTurnStart: (b, u) => { b.addStatus(u, 'invisible', 'end_of_turn', u) },
  },
  {
    id: 'cb_the_lesson_of_the_open_door', partial: true, note: '+2 save target (2-heat rider not modelled)',
    init: u => { u.stats.save += 2 },
  },
  {
    id: 'cb_the_lesson_of_the_held_image', note: '1/round reaction: Lock On at the start of an ally’s turn',
    onAnyTurnStart(b, self, u) {
      if (b.hostile(self, u) || u === self || b.canSpend(self, 'reaction') !== true || b.has(self, 'jammed')) return
      const t = b.alive().find(o => b.hostile(self, o) && (o.kind === 'mech' || o.kind === 'npc') && !b.has(o, 'lockon') && b.techTargetValid(self, o) === true)
      if (!t || !once(self, 'heldimage')) return
      self.reactionsLeft--
      b.say(`${self.name}: The Lesson of the Held Image.`)
      b.addStatus(t, 'lockon', 'until_cleared', self)
    },
  },
  {
    id: 'cb_the_lesson_of_thinking_tomorrows_thought', note: 'Tech hit → next melee vs the target +1 acc, irreducible',
    afterAttack(b, self, ctx, role) { if (role === 'attacker' && ctx.tech && ctx.hit) self.flags.tomorrow = ctx.target.id },
    beforeAttack(b, self, ctx, role) {
      if (role === 'attacker' && ctx.melee && self.flags.tomorrow === ctx.target.id) { ctx.accuracy++; ctx.irreducible = true; delete self.flags.tomorrow; ctx.reasons.push('Tomorrow’s Thought +1') }
    },
  },
  {
    id: 'cb_the_lesson_of_transubstantiation', note: 'Untargetable after structure damage until your next turn',
    onStructureDamage: (b, u) => { u.flags.nonSpace = true; b.say(`${u.name} slips into non-space.`) },
    onTurnStart: (b, u) => { delete u.flags.nonSpace },
    beforeAttack(b, self, ctx, role) { if (role === 'target' && self.flags.nonSpace) ctx.cancelled = true },
  },
  { id: 'cb_adaptive_reactor', note: 'Stabilize (cool) also spends 2 repairs to clear 1 stress', init: u => { u.flags.adaptiveReactor = true } },
  {
    id: 'cb_stasis_shielding', note: 'Resistance to all damage after taking stress, until your next turn',
    onStressDamage: (b, u) => { u.flags.resistAll = 1; u.flags.stasisShield = true },
    onTurnStart: (b, u) => { if (u.flags.stasisShield) { u.flags.resistAll = 0; delete u.flags.stasisShield } },
  },
])
