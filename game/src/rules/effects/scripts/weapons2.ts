// Weapons and weapon mods whose rules replace the normal attack: Autopod, Vorpal Gun, Mimic Gun,
// Prototype Weapons, UNCLE, Throughbolt Rounds, plus the profile-driven Siege Cannon and the
// core-driven Apocalypse Rail. Rules text lives in lancer-data; these are original implementations.
import type { Battle } from '../../battle'
import { footprint, key, lineTiles, unitsOnTiles } from '../../grid'
import { rollDice } from '../../rng'
import type { Pos, Unit, Weapon } from '../../types'
import { registerScripts, type CustomAction } from '../registry'

const action = (a: Omit<CustomAction, 'usable'> & { usable?: CustomAction['usable'] }): CustomAction => ({ usable: () => true, ...a })
const weaponsOf = (u: Unit, id: string) => u.weapons.filter(w => w.dataId === id && !w.destroyed)
const modded = (u: Unit, id: string) => u.weapons.filter(w => w.modId === id && !w.destroyed)
const oncePerRound = (u: Unit, k: string) => { if (u.flags[`round:${k}`]) return false; u.flags[`round:${k}`] = true; return true }
const flags = (w: Weapon) => (w.flags ??= {})

// ---------------------------------------------------------------- Mimic Gun
function mimicSet(w: Weapon, range: number) {
  const pr = w.profiles[w.profileIndex]
  pr.range = [{ type: 'Range', val: range }]
  pr.damage = [{ type: 'Kinetic', val: 1 + Math.floor(range / 2) }]
  flags(w).mimicRange = range
}
function mimicRoll(b: Battle, u: Unit, w: Weapon) {
  const rolls = [b.rng.d(20), b.rng.d(20), b.rng.d(20)]
  flags(w).mimic = rolls
  flags(w).mimicIdx = 0
  mimicSet(w, rolls[0])
  b.say(`${u.name}'s Mimic Gun contorts: ranges ${rolls.join(' → ')} (now Range ${rolls[0]}, ${1 + Math.floor(rolls[0] / 2)} kinetic).`)
}

// ---------------------------------------------------------------- Prototype weapons
const PROTO_TYPES = ['Melee', 'CQB', 'Rifle', 'Cannon', 'Launcher', 'Nexus'] as const
const PROTO_DAMAGE = ['Kinetic', 'Energy', 'Explosive'] as const
/** Apply a saved Prototype Weapon set-up (from the run, until the next Full Repair). */
export function applyPrototypeConfig(w: Weapon, type: string, damage: string, locked = false) {
  protoConfigure(w, type, damage)
  if (locked) flags(w).protoLocked = true
}
function protoConfigure(w: Weapon, type: string, damage: string) {
  const pr = w.profiles[w.profileIndex]
  w.type = type
  pr.range = type === 'Melee' ? [{ type: 'Threat', val: 1 }] : [{ type: 'Range', val: 10 }]
  pr.damage = pr.damage.map(d => ({ ...d, type: damage as any }))
  flags(w).protoType = type
  flags(w).protoDamage = damage
}

// ---------------------------------------------------------------- Throughbolt
/** the Line 3 path a throughbolt punches out toward `toward` (through terrain) */
export function throughboltPath(b: Battle, u: Unit, toward: Pos): Pos[] {
  const own = new Set(footprint(u).map(key))
  return lineTiles(b.map, u, toward, 3).filter(p => !own.has(key(p)))
}

registerScripts([
  {
    id: 'mw_autopod',
    note: 'Autonomous Assault: when another character consumes Lock On against a target within 15, the Autopod automatically hits it (reaction, 1/round)',
    afterAnyAttack(b, self, ctx) {
      if (!ctx.lockOnConsumed || ctx.attacker === self || ctx.target.destroyed || !b.hostile(self, ctx.target)) return
      const w = weaponsOf(self, 'mw_autopod').find(x => b.weaponUsable(self, x, false) === true)
      if (!w || b.distance(self, ctx.target) > 15 || b.canSpend(self, 'reaction') !== true || self.flags['round:autopod']) return
      if (!b.offerReaction(self, 'autopod', 'Autonomous Assault?', `${ctx.attacker.name} consumed Lock On on ${ctx.target.name}. Spend ${self.name}'s reaction to hit it automatically with the Autopod?`)) return
      self.flags['round:autopod'] = true
      self.reactionsLeft--
      b.say(`${self.name}'s Autopod fires on ${ctx.target.name} (Autonomous Assault).`, 'attack')
      b.weaponAttack(self, w, { targetId: ctx.target.id }, 'free', { autoHit: true })
    },
  },
  {
    id: 'mw_vorpal_gun',
    note: 'Snicker-Snack: when a hostile within range and line of sight damages an ally, attack it with the Vorpal Gun (reaction, 1/round)',
    onAnyDamaged(b, self, target, d) {
      const src = d.source
      if (!src || src.destroyed || d.kind !== 'hp' || d.amount <= 0 || target === self || target.destroyed && target.kind !== 'mech') return
      if (b.hostile(self, target) || !b.hostile(self, src) || self.flags['round:vorpal'] || b.canSpend(self, 'reaction') !== true) return
      const w = weaponsOf(self, 'mw_vorpal_gun').find(x => b.weaponUsable(self, x, false) === true && b.validTarget(self, x, src) === true)
      if (!w) return
      if (!b.offerReaction(self, 'vorpal', 'Snicker-Snack?', `${src.name} damaged ${target.name}. Spend ${self.name}'s reaction to attack it with the Vorpal Gun?`)) return
      self.flags['round:vorpal'] = true
      self.reactionsLeft--
      b.weaponAttack(self, w, { targetId: src.id }, 'free')
    },
  },
  {
    id: 'mw_mimic_gun',
    note: 'Mimic Gun: 3d20 ranges cycled each turn (damage 1 + half the range); counts as every ranged type; no mods or core bonuses; Provoke rerolls (full action)',
    init(u) {
      for (const w of weaponsOf(u, 'mw_mimic_gun')) {
        flags(w).allRangedTypes = true
        w.type = 'Rifle'
        w.bonuses = []
        w.modId = undefined
        mimicSet(w, 10)
      }
    },
    onRoundStart(b, self) {
      if (b.round !== 1) return
      for (const w of weaponsOf(self, 'mw_mimic_gun')) if (!w.flags?.mimic) mimicRoll(b, self, w)
    },
    onTurnStart(b, self) {
      for (const w of weaponsOf(self, 'mw_mimic_gun')) {
        const f = flags(w)
        if (!f.mimic) { mimicRoll(b, self, w); f.mimicTurned = true; continue }
        if (!f.mimicTurned) { f.mimicTurned = true; continue } // the first turn keeps X
        f.mimicIdx = (f.mimicIdx + 1) % 3
        mimicSet(w, f.mimic[f.mimicIdx])
        b.say(`${self.name}'s Mimic Gun cycles to Range ${f.mimic[f.mimicIdx]}.`)
      }
    },
    actions: (_b, u) => weaponsOf(u, 'mw_mimic_gun').slice(0, 1).map(w => action({
      key: 'mimic_provoke', name: 'Provoke Mimic Gun', activation: 'full', target: 'none', sourceUid: w.uid,
      text: `Roll a new set of 3d20 ranges (now ${w.flags?.mimic?.join(' / ') ?? '—'}).`,
      run: (bt, self) => { mimicRoll(bt, self, w); flags(w).mimicTurned = true },
      aiScore: () => ((w.flags?.mimicRange ?? 10) < 5 ? 2 : -1),
    })),
  },
  {
    id: 'mw_siege_cannon',
    note: 'Siege Cannon: pick Siege Mode (Range 30 Blast 2, Arcing, Ordnance, Loading, 4 heat) or Direct Fire (Range 20, Knockback 2, 2 heat) with the profile buttons before firing',
  },
  {
    id: 'mw_barbarossa_integrated',
    note: 'Apocalypse Rail: fired through the Charge Rail CORE power (Apocalypse Die profiles, not within range 5, die resets to 4)',
  },
  ...(['mw_prototype_1', 'mw_prototype_2', 'mw_prototype_3'] as const).map(id => ({
    id,
    note: 'Prototype Weapon: Limited uses (1d6+2, or 2d6) rerolled after each Full Repair; set its weapon type and damage type before it first attacks after a Full Repair (kept for the run until then)',
    init(u: Unit) {
      for (const w of weaponsOf(u, id)) {
        protoConfigure(w, w.flags?.protoType ?? 'Rifle', w.flags?.protoDamage ?? 'Kinetic')
        w.usesLeft = -1 // rolled at the first battle after a Full Repair (a run restores the uses it has left)
      }
    },
    onRoundStart(b: Battle, self: Unit) {
      if (b.round !== 1) return
      for (const w of weaponsOf(self, id)) {
        if (flags(w).protoRolled || (w.usesLeft ?? -1) >= 0) continue
        flags(w).protoRolled = true
        const dice = id === 'mw_prototype_3' ? '2d6' : '1d6+2'
        w.usesLeft = rollDice(b.rng, dice).total + self.stats.limitedBonus
        b.say(`${self.name}'s ${w.name}: ${w.usesLeft} uses this battle.`)
      }
    },
    actions: (_b: Battle, u: Unit) => weaponsOf(u, id).filter(w => !w.flags?.protoLocked).map(w => action({
      key: `proto_config:${w.uid}`, name: `Configure ${w.name}`, activation: 'free', target: 'none', sourceUid: w.uid,
      text: `Currently ${w.type}, ${w.profiles[w.profileIndex].damage[0]?.type}. Choose the weapon type and damage type (before its first attack this battle).`,
      run: (bt: Battle, self: Unit) => {
        const t = bt.choose({ kind: 'proto_type', unit: self, title: `${w.name}: weapon type`, options: PROTO_TYPES.map(x => ({ label: x, hint: x === 'Melee' ? 'Threat 1' : 'Range 10' })), defaultIndex: Math.max(0, PROTO_TYPES.indexOf(w.type as any)) })
        const d = bt.choose({ kind: 'proto_damage', unit: self, title: `${w.name}: damage type`, options: PROTO_DAMAGE.map(x => ({ label: x })), defaultIndex: Math.max(0, PROTO_DAMAGE.indexOf(w.profiles[w.profileIndex].damage[0]?.type as any)) })
        protoConfigure(w, PROTO_TYPES[t], PROTO_DAMAGE[d])
        bt.say(`${self.name} configures ${w.name}: ${PROTO_TYPES[t]}, ${PROTO_DAMAGE[d]}.`)
      },
      aiScore: () => -1,
    })),
    afterAttack(_b: Battle, self: Unit, ctx: any, role: string) {
      if (role === 'attacker' && ctx.weapon?.dataId === id) flags(ctx.weapon).protoLocked = true
    },
  })),
  {
    id: 'wm_uncle_class_comp_con',
    note: 'UNCLE: 1/turn free-action attack at +2 difficulty with the modded weapon if it has not been used this turn; it is then locked until your next turn',
    onTurnStart(_b, self) { for (const w of modded(self, 'wm_uncle_class_comp_con')) if (w.flags) delete w.flags.locked },
    beforeAttack(_b, self, ctx, role) {
      if (role === 'attacker' && self.flags.uncleFiring && ctx.weapon?.modId === 'wm_uncle_class_comp_con') { ctx.difficulty += 2; ctx.reasons.push('UNCLE -2') }
    },
    actions: (b, u) => modded(u, 'wm_uncle_class_comp_con').slice(0, 1).map(w => action({
      key: 'uncle', name: `UNCLE: ${w.name}`, activation: 'free', target: b.isAoE(b.profile(w)) ? 'tile' : 'enemy', range: b.weaponReach(u, w), sourceUid: w.uid,
      text: 'Attack at +2 difficulty with UNCLE\'s weapon as a free action (1/turn). The weapon can\'t be used again until your next turn.',
      usable: (bt, self) => (self.flags['turn:uncle'] ? 'Already used this turn' : bt.firedThisTurn(self, w) ? 'This weapon was already used this turn' : bt.weaponUsable(self, w, false)),
      run: (bt, self, t) => {
        const aim = t && 'x' in t ? { tile: t } : { targetId: (t as Unit).id }
        self.flags['turn:uncle'] = true
        self.flags.uncleFiring = true
        let r
        try { r = bt.weaponAttack(self, w, aim, 'free') } finally { delete self.flags.uncleFiring }
        if (!r.ok) { delete self.flags['turn:uncle']; throw new Error(r.reason ?? 'Cannot attack') }
        bt.markFired(self, w)
        flags(w).locked = 'UNCLE: locked until your next turn'
      },
      aiTarget: (bt, self) => bt.alive().filter(h => bt.hostile(self, h) && h.kind !== 'deployable' && bt.validTarget(self, w, h) === true).sort((x, y) => x.hp - y.hp)[0] ?? null,
      aiScore: () => 3,
    })),
  },
  {
    id: 'wm_throughbolt_rounds',
    note: 'Throughbolt: toggle on the weapon card; the shot punches a Line 3 path (through terrain, 2 AP kinetic to each character and object on it), then range, cover and line of sight are measured from the end of the path',
    attackOrigin(b, self, w, aim) {
      if (w.modId !== 'wm_throughbolt_rounds' || !w.flags?.throughbolt || !aim.targetId) return null
      const t = b.unit(aim.targetId)
      if (!t) return null
      const path = throughboltPath(b, self, t.pos)
      if (!path.length) return null
      b.say(`${self.name} fires a throughbolt round.`, 'attack')
      b.emit({ type: 'area', tiles: path, kind: 'attack' })
      for (const o of unitsOnTiles(b.alive(), path)) if (o !== self && o !== t) b.applyDamage(o, [{ type: 'Kinetic', amount: 2 }], { source: self, ap: true })
      b.damageObjectsIn(path, 2, { source: self, ap: true })
      const end = path[path.length - 1]
      // range, cover and line of sight are measured from the end of the path
      return end
    },
  },
])
