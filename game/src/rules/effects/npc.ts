// Runtime for enemy-ruleset features (systems, traits, reactions, templates).
import type { Battle } from '../battle'
import { blastTiles, burstTiles, distanceToTile, hasLineOfSightToTile, unitsOnTiles } from '../grid'
import type { Effect, Pos, SystemInst, Unit } from '../types'
import type { HookTrigger, ReactionFeature, SystemFeature, TraitFeature } from '../../enemies/ruleset'
import { registerScripts, type CustomAction } from './registry'

const features = (u: Unit) => u.systems.filter(s => s.feature && !s.destroyed)

function runHooks(b: Battle, self: Unit, on: HookTrigger, trigger?: Unit) {
  for (const s of features(self)) {
    const f = s.feature as TraitFeature
    if (f.type !== 'trait') continue
    for (const h of f.hooks ?? []) if (h.on === on) {
      const target = h.target === 'trigger' && trigger ? trigger : self
      b.say(`${self.name}: ${f.name}.`)
      b.runEffects(self, target, h.effects.map(e => ({ ...e, target: (e as any).target ?? 'target' })) as Effect[], undefined, self.stats.save)
    }
  }
}

function react(b: Battle, self: Unit, trigger: ReactionFeature['trigger'], other: Unit) {
  if (self.destroyed || other.destroyed) return
  for (const s of features(self)) {
    const f = s.feature as ReactionFeature
    if (f.type !== 'reaction' || f.trigger !== trigger) continue
    if (b.canSpend(self, 'reaction') !== true) return
    const flag = f.frequency === '1/scene' ? `scene:${s.uid}` : `round:${s.uid}`
    if (self.flags[flag]) continue
    self.flags[flag] = true
    self.reactionsLeft--
    b.say(`${self.name} reacts: ${f.name}!`, 'attack')
    if (f.attackWith) {
      const w = self.weapons.find(w => w.name === f.attackWith)
      if (w && b.weaponReady(self, w) && b.validTarget(self, w, other) === true) b.weaponAttack(self, w, { targetId: other.id }, 'free')
    }
    if (f.effects?.length) b.runEffects(self, other, f.effects, undefined, self.stats.save)
    return
  }
}

function systemAction(b: Battle, self: Unit, s: SystemInst): CustomAction {
  const f = s.feature as SystemFeature
  const range = f.range ?? (f.target === 'self' || f.target === 'self_burst' ? 0 : self.stats.sensors)
  return {
    key: `${s.uid}`,
    name: f.name,
    activation: f.activation,
    text: f.text ?? '',
    target: f.target === 'self' || f.target === 'self_burst' ? 'self' : f.target === 'tile_blast' ? 'tile' : f.target,
    range,
    area: f.target === 'self_burst' ? { shape: 'burst', size: f.radius ?? 1 } : f.target === 'tile_blast' ? { shape: 'blast', size: f.radius ?? 1 } : undefined,
    heat: f.heat,
    sourceUid: s.uid,
    usable: () => (s.destroyed ? 'Destroyed' : s.usesLeft === 0 ? 'No uses left' : !s.charged ? 'Recharging' : true),
    run: (bt, me, target) => {
      if (s.usesLeft != null) s.usesLeft--
      if (f.recharge) s.charged = false
      let victims: Unit[] = []
      if (f.target === 'self') victims = [me]
      else if (f.target === 'self_burst' || f.target === 'tile_blast') {
        let tiles: Pos[]
        if (f.target === 'self_burst') tiles = burstTiles(bt.map, me, f.radius ?? 1)
        else {
          const p = target && 'x' in target ? target : (target as Unit)?.pos ?? me.pos
          if (distanceToTile(bt.map, me, p) > range) throw new Error('Out of range')
          if (!hasLineOfSightToTile(bt.effectiveMap(), me, p)) throw new Error('No line of sight')
          tiles = blastTiles(bt.map, p, f.radius ?? 1)
        }
        bt.emit({ type: 'area', tiles, kind: 'attack' })
        victims = unitsOnTiles(bt.alive(), tiles).filter(v => v !== me)
      } else if (target && 'id' in target) {
        if (bt.distance(me, target) > range) throw new Error('Out of range')
        victims = [target]
      }
      for (const v of victims) {
        const hostile = bt.hostile(me, v)
        // effects aimed at allies are beneficial; effects aimed at hostiles allow the listed save
        const effects = f.effects.map(e => (hostile && f.save && !('save' in e && e.save) ? { ...e, save: f.save } : e)) as Effect[]
        const relevant = effects.filter(e => (hostile ? !['heal', 'overshield', 'clear_heat', 'clear_status'].includes(e.do) : ['heal', 'overshield', 'clear_heat', 'clear_status'].includes(e.do)))
        bt.runEffects(me, v, f.target === 'self' ? effects : relevant, undefined, me.stats.save)
      }
    },
  }
}

registerScripts([
  {
    id: 'npc:npc_feature',
    note: 'Enemy ruleset features (systems, traits, reactions)',
    onTurnStart(b, self) {
      for (const w of self.weapons) if (w.recharge && !w.charged) {
        const r = b.rng.d(6)
        if (r >= w.recharge) { w.charged = true; b.say(`${self.name}'s ${w.name} recharges (${r}).`) }
      }
      for (const s of features(self)) if ((s.feature as SystemFeature).recharge && !s.charged) {
        const r = b.rng.d(6)
        if (r >= (s.feature as SystemFeature).recharge!) { s.charged = true; b.say(`${self.name}'s ${s.name} recharges (${r}).`) }
      }
      runHooks(b, self, 'turn_start')
    },
    onTurnEnd(b, self) { runHooks(b, self, 'turn_end') },
    afterAttack(b, self, ctx, role) {
      if (role !== 'target') return
      if (ctx.hit && ctx.melee) { runHooks(b, self, 'hit_by_melee', ctx.attacker); react(b, self, 'hit_by_melee', ctx.attacker) }
      if (!ctx.hit) { runHooks(b, self, 'attacked_and_missed', ctx.attacker); react(b, self, 'attacked_and_missed', ctx.attacker) }
    },
    afterAnyAttack(b, self, ctx) {
      if (ctx.target === self || ctx.attacker === self || b.hostile(self, ctx.target)) return
      if (b.hostile(self, ctx.attacker) && b.adjacent(self, ctx.target)) react(b, self, 'ally_attacked_adjacent', ctx.attacker)
    },
    onDamaged(b, self, d) {
      runHooks(b, self, 'damaged', d.source)
      if (d.source && b.hostile(self, d.source)) react(b, self, 'damaged', d.source)
    },
    onDestroyed(b, self, victim) {
      if (victim !== self && !b.hostile(self, victim) && b.distance(self, victim) <= 3) runHooks(b, self, 'ally_destroyed_nearby', victim)
    },
    onMove(b, self, mover) {
      if (b.hostile(self, mover) && !mover.destroyed && b.adjacent(self, mover)) react(b, self, 'enemy_moves_adjacent', mover)
    },
    actions(b, self) {
      return features(self).filter(s => (s.feature as any).type === 'system').map(s => systemAction(b, self, s))
    },
  },
])
