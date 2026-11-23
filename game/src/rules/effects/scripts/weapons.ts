// Weapons, weapon mods and core bonuses with rules beyond the structured data.
// Weapon scripts run for every attack the owner makes, so each filters on ctx.weapon.dataId.
import { blastTiles, burstTiles, coneTiles, distanceToTile, lineTiles, unitsOnTiles, footprint } from '../../grid'
import { averageDice, rollDice } from '../../rng'
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
      const k = `firing:${id}:${b.eventCount}`
      if (self.flags.lastFiring === k) return
      self.flags.lastFiring = k
      f(b, self, ctx)
    },
  }
}

function secondaryAttack(b: Battle, self: Unit, w: Weapon, t: Unit) {
  b.weaponAttack(self, w, { targetId: t.id }, 'secondary', { noBonusDamage: true })
}

const avgDamage = (w: Weapon) => w.profiles[w.profileIndex]?.damage.reduce((a, d) => a + (typeof d.val === 'number' ? d.val : averageDice(String(d.val))), 0) ?? 0
function ghostReactCheck(b: Battle, u: Unit) {
  if (u.flags.ghostReact != null && u.reactionsLeft < u.flags.ghostReact && b.has(u, 'invisible')) { b.removeStatus(u, 'invisible'); b.say(`${u.name}'s Ghostweave fades (reaction).`) }
  u.flags.ghostReact = u.reactionsLeft
}
/** candidate centres for a second Pinaka area: on hostiles in range, not overlapping the given areas */
function pinakaCentres(b: Battle, self: Unit, w: Weapon, taken: Pos[]): { pos: Pos; label: string }[] {
  const used = new Set(taken.flatMap(c => blastTiles(b.map, c, 1)).map(p => `${p.x},${p.y}`))
  const reach = b.weaponReach(self, w)
  return b.alive()
    .filter(o => b.hostile(self, o) && (o.kind === 'mech' || o.kind === 'npc') && distanceToTile(b.map, self, o.pos) <= reach)
    .filter(o => !blastTiles(b.map, o.pos, 1).some(p => used.has(`${p.x},${p.y}`)))
    .slice(0, 6)
    .map(o => ({ pos: { ...o.pos }, label: o.name }))
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
    id: 'mw_combat_drill', note: 'Against Prone, Immobilized or Stunned targets each Overkill activation adds +1d6 bonus damage, chaining (and adding Overkill heat) while the new die is a 1',
    beforeAttack(b, self, ctx, role) {
      if (role === 'attacker' && is(ctx, 'mw_combat_drill') && ['prone', 'immobilized', 'stunned'].some(s => b.has(ctx.target, s as any))) ctx.overkillBonus = true
    },
  },
  {
    id: 'mw_magnetic_cannon', note: 'Hull save or pulled 1d3+1 toward you',
    afterAttack(b, self, ctx, role) {
      if (role === 'attacker' && is(ctx, 'mw_magnetic_cannon') && ctx.hit && !ctx.target.destroyed && !b.save(ctx.target, 'hull', self.stats.save, 0, self)) b.forceMove(ctx.target, self, rollDice(b.rng, '1d3+1').total, -1)
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
  {
    id: 'mw_pinaka_missiles',
    note: 'Up to two non-overlapping Blast 1 areas per attack (the second picked after the first); Delayed Strike marks the areas (visible to all) and they land for 3d6 at the end of the next round, leaving you Slowed until the end of your next turn',
    ...perFiring('mw_pinaka_missiles', (b, self, ctx) => {
      if (ctx.mode === 'secondary' || self.flags.pinakaSecond) return
      const first = b.lastAim?.tile
      if (!first) return
      const w = ctx.weapon!
      const cands = pinakaCentres(b, self, w, [first])
      if (!cands.length) return
      const opts = [...cands.map(c => ({ label: `Second area on ${c.label}` })), { label: 'No second area' }]
      const i = b.choose({ kind: 'pinaka_second', unit: self, title: 'Pinaka: second blast', text: 'Place the second Blast 1 area (it cannot overlap the first).', options: opts, defaultIndex: 0 })
      if (i >= cands.length) return
      self.flags.pinakaSecond = true
      try { b.weaponAttack(self, w, { tile: cands[i].pos }, 'secondary', { noBonusDamage: true }) } finally { delete self.flags.pinakaSecond }
    }),
    actions: (b, u) => {
      const w = weaponOf(u, 'mw_pinaka_missiles')
      if (!w) return []
      return [action({
        key: 'pinaka_delay', name: 'Pinaka: Delayed Strike', activation: 'quick', target: 'tile', range: 20, area: { shape: 'blast', size: 1 }, sourceUid: w.uid,
        text: 'Skirmish: mark up to two Blast 1 areas; the missiles land at the end of the next round for 3d6 explosive. You are Slowed until the end of your next turn.',
        usable: (bt, self) => (bt.firedThisTurn(self, w) ? 'Already fired this turn' : bt.weaponUsable(self, w) !== true ? bt.weaponUsable(self, w) : bt.canSpend(self, 'quick', 'skirmish')),
        run: (bt, self, t) => {
          const c = t && 'x' in t ? t : (t as Unit).pos
          if (distanceToTile(bt.map, self, c) > 20) throw new Error('Out of range')
          bt.spend(self, 'quick', 'skirmish')
          bt.markFired(self, w)
          const centres = [c]
          const cands = pinakaCentres(bt, self, w, centres)
          if (cands.length) {
            const opts = [...cands.map(x => ({ label: `Second area on ${x.label}` })), { label: 'No second area' }]
            const i = bt.choose({ kind: 'pinaka_second', unit: self, title: 'Pinaka: second blast', options: opts, defaultIndex: 0 })
            if (i < cands.length) centres.push(cands[i].pos)
          }
          self.flags.pinakaDelayed = { lands: bt.round + 2, centres }
          bt.addHeat(self, 2)
          bt.addStatus(self, 'slowed', 'next_turn_end_target', self)
          bt.say(`${self.name} launches a delayed Pinaka strike: ${centres.length} marked area(s) land at the end of next round.`)
          for (const x of centres) bt.emit({ type: 'area', tiles: blastTiles(bt.map, x, 1), kind: 'attack' })
        },
        aiTarget: () => null,
        aiScore: () => -1,
      })]
    },
    onRoundStart(b, self) {
      const d = self.flags.pinakaDelayed
      if (!d || b.round < d.lands) return
      delete self.flags.pinakaDelayed
      const w = self.weapons.find(x => x.dataId === 'mw_pinaka_missiles')
      if (!w) return
      const pr = w.profiles[w.profileIndex]
      const dmg = pr.damage
      pr.damage = dmg.map(x => ({ ...x, val: '3d6' }))
      ;(w.flags ??= {}).delayedImpact = true
      b.say(`${self.name}'s delayed Pinaka missiles land!`, 'attack')
      try { for (const c of d.centres) b.weaponAttack(self, w, { tile: c }, 'secondary', { noBonusDamage: true }) } finally { pr.damage = dmg; delete w.flags.delayedImpact }
    },
    fields: (b, u) => (u.flags.pinakaDelayed ? u.flags.pinakaDelayed.centres.map((c: Pos) => ({ tiles: blastTiles(b.map, c, 1), effect: 'harm' as const, label: `${u.name}'s Pinaka strike lands here at the end of round ${u.flags.pinakaDelayed.lands - 1} (3d6 explosive)` })) : []),
  },
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
  {
    id: 'mw_annihilation_nexus', note: 'Burst 2 centred on you or one of your drones within Sensors (picker); a second attack at the start of your next turn as a protocol (no bonus damage)',
    attackOrigin(b, self, w) {
      if (w.dataId !== 'mw_annihilation_nexus') return null
      const drones = b.alive().filter(d => d.ownerId === self.id && d.kind === 'drone' && b.distance(self, d) <= self.stats.sensors)
      if (!drones.length) return null
      const i = b.choose({ kind: 'annihilation_centre', unit: self, title: 'Annihilation Nexus: centre', options: [{ label: 'Yourself' }, ...drones.map(d => ({ label: d.name, hint: `at ${d.pos.x},${d.pos.y}` }))], defaultIndex: 0 })
      return i > 0 ? { ...drones[i - 1].pos } : null
    },
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
    id: 'mw_plasma_thrower', note: 'Cone 7 or Line 10 (weapon-card toggle); 3 free spaces of your choice in the area burn for the scene: 1d6 energy when a character starts its turn there or first enters one in a round',
    ...perFiring('mw_plasma_thrower', (b, self, ctx) => {
      const aim = b.lastAim?.tile ?? ctx.target.pos
      const area = b.aoeTiles(self, ctx.weapon!, aim)
      if (typeof area === 'string') return
      const free = area.filter(p => !b.alive().some(o => footprint(o).some(q => q.x === p.x && q.y === p.y)))
      if (!free.length) return
      const near = (p: Pos) => Math.min(...b.alive().filter(o => b.hostile(self, o)).map(o => Math.max(Math.abs(o.pos.x - p.x), Math.abs(o.pos.y - p.y))), 99)
      const dist = (p: Pos) => Math.max(Math.abs(self.pos.x - p.x), Math.abs(self.pos.y - p.y))
      const layouts = [
        { label: 'Next to hostiles', hint: 'the free spaces closest to enemies', tiles: [...free].sort((a, c) => near(a) - near(c)).slice(0, 3) },
        { label: 'Far end', hint: 'the farthest free spaces', tiles: [...free].sort((a, c) => dist(c) - dist(a)).slice(0, 3) },
        { label: 'Near you', hint: 'a burning screen in front of you', tiles: [...free].sort((a, c) => dist(a) - dist(c)).slice(0, 3) },
      ]
      const i = b.choose({ kind: 'plasma_fire', unit: self, title: 'Plasma Thrower: burning spaces', text: 'Choose where 3 spaces keep burning for the rest of the scene.', options: layouts.map(l => ({ label: l.label, hint: l.hint })), defaultIndex: 0 })
      b.addArea({ kind: 'damage', tiles: layouts[i].tiles, damage: '1d6', ownerId: self.id, tag: 'plasma' })
    }),
    onMove(b, self, mover, path) {
      if (mover.destroyed) return
      for (const a of b.areas) {
        if (a.ownerId !== self.id || a.tag !== 'plasma') continue
        const k = `round:plasma:${a.id}`
        if (mover.flags[k]) continue
        if (path.slice(1).some(p => footprint({ pos: p, stats: mover.stats }).some(q => a.tiles.some(t => t.x === q.x && t.y === q.y)))) {
          mover.flags[k] = true
          b.applyDamage(mover, [{ type: 'Energy', amount: rollDice(b.rng, '1d6').total }], { source: self })
        }
      }
    },
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
      for (const t of unitsOnTiles(b.alive(), tiles)) if (t !== self && !b.save(t, 'eng', self.stats.save, 0, self)) b.applyDamage(t, [{ type: 'Burn', amount: 4 }, { type: 'Heat', amount: 2 }], { source: self })
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
    id: 'wm_shock_wreath', note: '1/round, when you hit with the modded weapon, spend a quick action: the target takes 1d6 burn; if it was already burning it can only see adjacent spaces until the end of its next turn',
    afterAttack(b, self, ctx, role) {
      if (role !== 'attacker' || ctx.weapon?.modId !== 'wm_shock_wreath' || !ctx.hit || ctx.target.destroyed || self.flags['round:wreath'] || b.canSpend(self, 'quick') !== true || !self.activeTurn) return
      const t = ctx.target
      if (b.choose({ kind: 'shock_wreath', unit: self, title: 'Shock Wreath?', text: `Spend a quick action: ${t.name} takes 1d6 burn${t.burn > 0 ? ' and, already burning, is blinded to all but adjacent spaces until the end of its next turn' : ''}.`, options: [{ label: 'Activate (quick action)' }, { label: 'No' }], defaultIndex: 0 }) !== 0) return
      self.flags['round:wreath'] = true
      const burning = t.burn > 0
      b.spend(self, 'quick', 'shock_wreath')
      b.applyDamage(t, [{ type: 'Burn', amount: rollDice(b.rng, '1d6').total }], { source: self })
      if (burning && !t.destroyed) { t.flags.blindUntil = b.round + 1; b.say(`${t.name} is blinded (line of sight to adjacent spaces only).`, 'status') }
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
    id: 'cb_overpower_caliber', note: 'Choose one weapon (asked on its first hit each battle); 1/round, a hit with it deals +1d6 bonus damage',
    afterAnyRoll(b, self, ctx) {
      if (ctx.attacker !== self || !ctx.hit || ctx.tech || !ctx.weapon || ctx.weapon.tech || self.flags['round:overpower']) return
      if (!self.flags.overpowerUid) {
        const ws = self.weapons.filter(w => !w.destroyed && !w.tech && w.mountIndex >= 0)
        if (!ws.length) return
        const best = ws.reduce((x, y) => (avgDamage(y) > avgDamage(x) ? y : x), ws[0])
        const i = b.choose({ kind: 'overpower_weapon', unit: self, title: 'Overpower Caliber: choose a weapon', text: 'This weapon deals +1d6 bonus damage on a hit, once per round.', options: ws.map(w => ({ label: w.name, hint: `${w.size} ${w.type}` })), defaultIndex: ws.indexOf(best) })
        self.flags.overpowerUid = ws[i].uid
      }
      if (ctx.weapon.uid !== self.flags.overpowerUid) return
      self.flags['round:overpower'] = true
      ctx.bonusDamage.push({ type: ctx.profile?.damage[0]?.type ?? 'Kinetic', val: '1d6' })
      ctx.reasons.push('Overpower Caliber +1d6')
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
    onCoreActivate(b, u) { if (!u.flags.briareosZero) u.hp = u.stats.hp; u.heat = 0; if (b.rng.d(20) === 20) { u.coreAvailable = true; b.say('  Universal Compatibility: CORE power regained!') } },
  },
  {
    id: 'cb_briareos_frame', note: 'Resistance to all damage at 1 Structure or less; at 0 HP and 0 Structure the mech is not destroyed but makes a structure check each time it takes damage, and cannot regain HP until a Full Repair',
    init: u => { u.flags.briareos = true },
    modifyIncoming(b, self, d) { if (self.structure <= 1 && d.kind === 'hp') d.amount = Math.ceil(d.amount / 2) },
  },
  {
    id: 'cb_all_theater_movement_suite', note: 'Toggle flight; 1 heat at end of turn while flying',
    actions: (b, u) => [action({ key: 'atms', name: u.flying ? 'Land' : 'Fly (ATMS)', activation: 'free', target: 'none', text: 'Count your movement as flying (1 heat at end of turn).', run: (bt, self) => { self.flying = !self.flying; self.flags.atms = self.flying } })],
    onTurnEnd: (b, u) => { if (u.flying && u.flags.atms) b.addHeat(u, 1) },
  },
  {
    id: 'cb_ghostweave', note: 'Invisible during your turn; if you only make standard moves, Hide and Boost, you stay Invisible until the start of your next turn; taking a reaction ends it',
    init: u => { u.flags.ghostweave = true },
    onTurnStart: (b, u) => { b.addStatus(u, 'invisible', 'until_cleared', u, { ghostweave: true }); u.flags.ghostReact = u.reactionsLeft },
    onTurnEnd(b, u) {
      const spent: string[] = u.flags['turn:spent'] ?? []
      if (spent.every(x => x === 'boost' || x === 'hide')) { b.removeStatus(u, 'invisible'); b.addStatus(u, 'invisible', 'start_of_next_turn_target', u, { ghostweave: true }) }
      else b.removeStatus(u, 'invisible')
      u.flags.ghostReact = u.reactionsLeft
    },
    // reactions taken outside Battle.spend (scripted reactions) also end it
    onAnyTurnStart: (b, self) => ghostReactCheck(b, self),
    beforeAnyAttack: (b, self) => ghostReactCheck(b, self),
    afterAnyAttack: (b, self) => ghostReactCheck(b, self),
  },
  {
    id: 'cb_the_lesson_of_the_open_door', note: '+2 Save Target; 1/round, when a character fails a save against you, it takes 2 heat',
    init: u => { u.stats.save += 2 },
    onSaveFailed(b, self, target) {
      if (self.flags['round:opendoor'] || target.destroyed) return
      self.flags['round:opendoor'] = true
      b.say(`  The Lesson of the Open Door: ${target.name} takes 2 heat.`)
      b.addHeat(target, 2, self)
    },
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
