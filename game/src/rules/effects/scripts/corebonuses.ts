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
  // cb_titanomachy_mesh lives in the engine: knockbackDistance and titanomachyFollowUp (rules/battle/attacks.ts)
])
