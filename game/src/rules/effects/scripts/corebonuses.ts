// Core bonuses whose rules go beyond their lancer-data bonuses (the older core-bonus scripts live in weapons.ts).
import { Lancer } from '../../../data/lancer'
import { tagVal } from '../../stats'
import { registerScripts } from '../registry'
import { freeRamOrGrapple } from './talents'

registerScripts([
  {
    id: 'cb_armory_sculpted_chassis', note: '+1 Accuracy on Engineering checks and saves (bonus); when you Overcharge, you gain soft cover until the start of your next turn',
    // overchargedThisTurn is set by Overcharge and cleared when your next turn begins
    adjustCover: (_b, self, _attacker, target, c) => (target === self && self.overchargedThisTurn && c === 'none' ? 'soft' : c),
  },
  {
    id: 'cb_kai_bioplating', note: '+1 Accuracy on Agility checks and saves (bonus); you climb at normal speed and ignore difficult terrain (no water on these maps; the long jumps are not modelled)',
    init(u) { u.flags.ignoreDifficult = true; u.flags.magClamps = true },
  },
  {
    id: 'cb_titanomachy_mesh', note: 'Melee attacks that knock a target back knock it 1 space further (Ram included); 1/round, when you successfully Ram or Grapple a mech, you may Ram or Grapple again as a free action',
    init(u) {
      // the lancer-data bonus would give every melee hit Knockback 1: only attacks that already knock back get the extra space
      const own = Lancer.coreBonuses.get('cb_titanomachy_mesh')?.bonuses ?? []
      u.bonuses = u.bonuses.filter(b => !own.includes(b))
    },
    afterAttack(b, self, ctx, role) {
      if (role !== 'attacker' || !ctx.hit || !ctx.melee || ctx.tech) return
      const t = ctx.target
      if (ctx.mode === 'ram' || ctx.mode === 'grapple') {
        if (ctx.mode === 'ram' && !t.destroyed) b.forceMove(t, self, 1, 1)
        if (t.destroyed || (t.kind !== 'mech' && t.kind !== 'npc') || t.role === 'Biological' || self.flags['round:titanomachy']) return
        freeRamOrGrapple(b, self, t, 'titanomachy', 'Titanomachy Mesh: Ram or Grapple again (free action)?', () => { self.flags['round:titanomachy'] = true })
        return
      }
      if (!ctx.weapon || t.destroyed) return
      const w = ctx.weapon
      const kb = (tagVal(b.profile(w).tags, 'tg_knockback') ?? 0) + self.bonuses.filter(x => x.id === 'knockback' && b.bonusApplies(x, w)).reduce((a, x) => a + Number(x.val), 0)
      if (kb > 0) b.forceMove(t, self, 1, 1)
    },
  },
])
