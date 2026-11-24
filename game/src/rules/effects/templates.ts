// Official NPC template features (core book / NPC data), as engine scripts.
// Template scripts are keyed `template:<Name>`; per-unit trait scripts `trait:<id>` (Unit.traits).
// Stat changes (Reinforced, Resilient, extra turns) are applied when the unit is built (enemies/build.ts).
import type { Unit } from '../types'
import { registerScripts } from './registry'

const CONDITIONS = ['stunned', 'jammed', 'immobilized', 'impaired', 'slowed', 'shredded', 'lockon'] as const

function adjacentAllyCommander(b: any, self: Unit, u: Unit) {
  return u !== self && !self.destroyed && !b.hostile(self, u) && !b.has(self, 'jammed') && b.adjacent(self, u)
}

registerScripts([
  // ---------------------------------------------------------------- templates
  {
    id: 'template:Commander',
    note: 'Voice of Authority (1/round reaction: an ally may reroll a failed attack, check or save) and Military Discipline (adjacent allies +1 accuracy)',
    partial: true,
    beforeAnyAttack(b, self, ctx) {
      if (self.destroyed || ctx.attacker === self || b.hostile(self, ctx.attacker)) return
      if (adjacentAllyCommander(b, self, ctx.attacker)) { ctx.accuracy++; ctx.reasons.push(`${self.name}: discipline +1`) }
      if (!ctx.rerollOnMiss && !b.has(self, 'jammed')) {
        ctx.rerollOnMiss = () => {
          if (b.canSpend(self, 'reaction', 'voice_of_authority') !== true) return false
          b.spend(self, 'reaction', 'voice_of_authority')
          b.say(`${self.name} (Voice of Authority): ${ctx.attacker.name} may reroll!`)
          return true
        }
      }
    },
    checkAccuracy(b, self, u) {
      return adjacentAllyCommander(b, self, u) ? 1 : 0
    },
    // Voice of Authority also covers failed checks and saves (core book p.326)
    rerollFailed(b, self, u, kind) {
      if (u === self || self.destroyed || b.hostile(self, u) || (u.kind !== 'mech' && u.kind !== 'npc') || b.has(self, 'jammed')) return false
      if (b.canSpend(self, 'reaction', 'voice_of_authority') !== true) return false
      b.spend(self, 'reaction', 'voice_of_authority')
      b.say(`${self.name} (Voice of Authority): ${u.name} may reroll the ${kind}!`)
      return true
    },
  },
  {
    id: 'template:Mercenary',
    note: 'Opportunist: +1 accuracy when the target is engaged by an ally',
    beforeAttack(b, self, ctx, role) {
      if (role !== 'attacker') return
      const t = ctx.target
      if (b.alive().some(a => a !== self && !b.hostile(self, a) && (a.kind === 'mech' || a.kind === 'npc') && b.adjacent(a, t))) {
        ctx.accuracy++
        ctx.reasons.push('Opportunist +1')
      }
    },
  },
  {
    id: 'template:Ultra',
    note: 'Juggernaut: clears a condition at turn start, repairs a destroyed weapon/system at turn end',
    onTurnStart(b, self) {
      const c = CONDITIONS.find(id => self.statuses.some(s => s.id === id))
      if (c) { b.removeStatus(self, c); b.say(`${self.name} shrugs off ${c} (Juggernaut).`) }
    },
    onTurnEnd(b, self) {
      const w = self.weapons.find(x => x.destroyed)
      const s = w ? undefined : self.systems.find(x => x.destroyed)
      if (w) w.destroyed = false
      if (s) s.destroyed = false
      if (w || s) b.say(`${self.name} repairs ${(w ?? s)!.name} (Juggernaut).`)
    },
  },
  // ---------------------------------------------------------------- traits
  {
    id: 'trait:veterancy',
    note: 'Veterancy: +1 accuracy on checks and saves with one skill',
    checkAccuracy(_b, self, u, _kind, stat) {
      if (u !== self) return 0
      const chosen = self.traits?.find(t => t.startsWith('veterancy:'))?.split(':')[1]
      return chosen && chosen === stat ? 1 : 0
    },
  },
  { id: 'trait:deadly', note: 'Deadly: +1d6 damage on critical hits (engine)' },
  { id: 'trait:legendary', note: 'Legendary: structure/overheat checks rolled twice, best kept (engine)' },
  { id: 'trait:reflex', note: 'Reflex: Overwatch any number of times per round (engine)' },
  { id: 'trait:feign_death', note: 'Feign Death: survives its first destruction on 1 HP, Hidden (engine)' },
  {
    id: 'trait:hacker',
    note: 'Hacker: +2 heat on successful tech attacks',
    afterAttack(b, self, ctx, role) {
      if (role === 'attacker' && ctx.tech && ctx.hit && !ctx.target.destroyed) b.applyDamage(ctx.target, [{ type: 'Heat', amount: 2 }], { source: self })
    },
  },
  {
    id: 'trait:hardened_target',
    note: 'Hardened Target: +1 accuracy on Systems saves; tech attacks against it +1 difficulty',
    beforeAttack(_b, _self, ctx, role) {
      if (role === 'target' && ctx.tech) { ctx.difficulty++; ctx.reasons.push('Hardened target -1') }
    },
    checkAccuracy(_b, self, u, kind, stat) { return u === self && kind === 'save' && stat === 'sys' ? 1 : 0 },
  },
  {
    id: 'trait:insulated',
    note: 'Insulated: immune to Burn',
    init(u) { if (!u.immune.includes('burn')) u.immune.push('burn') },
  },
  {
    id: 'trait:lightning_reflexes',
    note: 'Lightning Reflexes: Heavy/Superheavy attacks against it miss on a d6 roll of 5+',
    afterAnyRoll(b, self, ctx) {
      if (ctx.target !== self || !ctx.hit || !ctx.weapon || (ctx.weapon.size !== 'Heavy' && ctx.weapon.size !== 'Superheavy')) return
      if (b.rng.d(6) >= 5) { ctx.hit = false; ctx.crit = false; b.say(`  ${self.name} dodges with lightning reflexes!`) }
    },
  },
  {
    id: 'trait:shock_armor',
    note: 'Shock Armor: resistance to damage from Main weapons',
    beforeAttack(_b, _self, ctx, role) { if (role === 'target' && ctx.weapon?.size === 'Main') ctx.resistAll = true },
  },
  {
    id: 'trait:steel_jaw',
    note: 'Steel Jaw: Auxiliary weapons deal at most 1 damage to it',
    modifyIncoming(_b, _self, d) { if (d.attack?.weapon?.size === 'Auxiliary') d.amount = Math.min(d.amount, 1) },
  },
])
