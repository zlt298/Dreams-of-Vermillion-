// Effect-script registry. Lancer content whose rules can't be expressed by structured
// lancer-data fields gets a hand-written script keyed by item id:
//   frame traits:  `frame:<frameId>`      core system: `core:<frameId>`
//   systems/weapons/mods/core bonuses: their lancer-data id
//   talents: `<talentId>:<rank>`          npc features: `npc:<featureKey>`
import type { DamageData } from '../../data/lancer'
import type { Battle, Mine } from '../battle'
import type { Duration, Pos, Profile, StatusId, Unit, Weapon } from '../types'

export interface AttackCtx {
  attacker: Unit
  target: Unit
  /** hits automatically (no roll, no crit): Autopod and similar */
  autoHit?: boolean
  /** the attack roll was already rerolled once (Valiant Aid) */
  rerolled?: boolean
  /** Brutal (Predator): deal maximum damage and bonus damage */
  maxDamage?: boolean
  /** Combat Drill: each Overkill activation adds +1d6 bonus damage (chaining on 1s) */
  overkillBonus?: boolean
  /** the attack consumed the target's Lock On */
  lockOnConsumed?: boolean
  weapon?: Weapon
  profile?: Profile
  tech: boolean
  melee: boolean
  ranged: boolean
  multiTarget: boolean
  /** positive accuracy / difficulty counts, combined at roll time */
  accuracy: number
  difficulty: number
  attackBonus: number
  bonusDamage: DamageData[]
  ignoreCover: boolean
  noLosNeeded: boolean
  reasons: string[]
  hit?: boolean
  crit?: boolean
  roll?: number
  total?: number
  damageDealt?: number
  /** scripts may cancel the attack's normal damage */
  cancelDamage?: boolean
  mode: 'skirmish' | 'barrage' | 'overwatch' | 'free' | 'tech' | 'improvised' | 'ram' | 'grapple' | 'secondary'
  /** reroll a missed attack once (Neurolink etc.) */
  /** reroll a missed attack once; a function is asked only when the attack misses (e.g. to spend a reaction) */
  rerollOnMiss?: boolean | (() => boolean)
  /** treat target as Invisible for this attack */
  forceInvisible?: boolean
  /** set by scripts: the weapon's Kinetic/Explosive damage is dealt as this type instead (Fusion Hemorrhage → Energy) */
  convertDamage?: string
  irreducible?: boolean
  /** set by scripts: the attack is AP (ignores Armor) like the tg_ap tag */
  ap?: boolean
  /** target gains resistance to all damage from this attack */
  resistAll?: boolean
  /** attack is prevented before the roll (counts as a miss) */
  cancelled?: boolean
  /** the attack roll ignores difficulty */
  ignoreDifficulty?: boolean
}

export type Activation = 'quick' | 'full' | 'protocol' | 'free' | 'reaction' | 'quick_tech' | 'full_tech'

export interface CustomAction {
  key: string
  name: string
  activation: Activation
  text: string
  target: 'none' | 'self' | 'unit' | 'ally' | 'enemy' | 'tile'
  range?: number
  /** For area previews in UI */
  area?: { shape: 'blast' | 'burst' | 'line' | 'cone'; size: number }
  heat?: number
  sourceUid?: string
  /** id of the script that offered the action (set by customActions); for scripts keyed by a system id, that system */
  scriptId?: string
  /** Quick Tech option this belongs to ('invade' for invasion options); different options may repeat in a turn */
  techOption?: string
  /** return true if usable, or a reason string */
  usable(b: Battle, self: Unit): true | string
  run(b: Battle, self: Unit, target?: Unit | Pos): void
  /** AI: where to aim this action (tile or unit); return null to skip it this turn */
  aiTarget?(b: Battle, self: Unit): Unit | Pos | null
  /** AI hint: rough value of using this action now */
  aiScore?(b: Battle, self: Unit, target?: Unit | Pos): number
}

/** A persistent zone on the map. `effect` picks the overlay colour. */
export interface FieldOverlay {
  tiles: Pos[]
  effect: 'protect' | 'harm' | 'control' | 'reveal' | 'barrier' | 'terrain'
  label: string
  ownerId?: string
}

export interface DamageCtx {
  source?: Unit
  attack?: AttackCtx
  amount: number
  kind: 'hp' | 'heat' | 'burn'
  /** damage types of the parts dealt (applyDamage), e.g. ['Energy', 'Heat'] */
  types?: string[]
  /** the damage can't be reduced (Irreducible, Seeking Payload…) */
  irreducible?: boolean
}

export interface ItemScript {
  id: string
  /** short note shown in the coverage report */
  note?: string
  /** true when the script only approximates part of the item's rules */
  partial?: boolean
  beforeAttack?(b: Battle, self: Unit, ctx: AttackCtx, role: 'attacker' | 'target'): void
  afterAttack?(b: Battle, self: Unit, ctx: AttackCtx, role: 'attacker' | 'target'): void
  onTurnStart?(b: Battle, self: Unit): void
  onTurnEnd?(b: Battle, self: Unit): void
  onRoundStart?(b: Battle, self: Unit): void
  /** after this unit took damage */
  onDamaged?(b: Battle, self: Unit, d: DamageCtx): void
  /** measure this weapon attack from another point (Throughbolt); may apply its own effects first */
  attackOrigin?(b: Battle, self: Unit, w: Weapon, aim: { targetId?: string; tile?: Pos }): Pos | null | undefined
  /** one of your tagged mines went off (return true when you handled the explosion) */
  onMineDetonate?(b: Battle, self: Unit, mine: Mine, by?: Unit): boolean
  /** a character is about to end its turn (before any end-of-turn effects) */
  beforeAnyTurnEnd?(b: Battle, self: Unit, unit: Unit): void
  /** any character spent an action or reaction */
  onAnyAction?(b: Battle, self: Unit, actor: Unit, cost: string): void
  /** your voluntary moves must follow straight lines (Ramjet, OASIS Wall) */
  straightMovesOnly?(b: Battle, self: Unit): boolean
  /** veto a voluntary move: return a reason string to refuse it */
  validateMove?(b: Battle, self: Unit, dest: Pos, path: Pos[], mode: string): true | string | undefined
  /** forbid `mover` teleporting to `p` (Interdiction Field) */
  blocksTeleport?(b: Battle, self: Unit, mover: Unit, p: Pos): boolean
  /** `mover` may pass through `p` but not end a move there (OASIS trail) */
  forbidsEndingAt?(b: Battle, self: Unit, mover: Unit, p: Pos): boolean
  /** stop forced movement from crossing between two spaces (barriers) */
  blockForcedStep?(b: Battle, self: Unit, mover: Unit, from: Pos, to: Pos): boolean
  /** veto another unit's move (tethers): return a reason string to refuse it */
  validateAnyMove?(b: Battle, self: Unit, mover: Unit, dest: Pos, mode: string): true | string | undefined
  /** any character (you included) is about to take damage: parts and opts may be changed */
  beforeAnyDamage?(b: Battle, self: Unit, target: Unit, parts: { type: string; amount: number }[], opts: { source?: Unit; resistAll?: boolean; resistTypes?: string[]; ap?: boolean; attack?: AttackCtx }): void
  /** you gained a status */
  onStatusAdded?(b: Battle, self: Unit, status: StatusId, duration: Duration, source?: Unit): void
  /** a character failed a save against you */
  onSaveFailed?(b: Battle, self: Unit, target: Unit, stat: string): void
  /** another unit gained a status */
  onAnyStatusAdded?(b: Battle, self: Unit, target: Unit, status: StatusId, duration: Duration, source?: Unit): void
  /** another unit took heat */
  onAnyHeat?(b: Battle, self: Unit, target: Unit, amount: number, source?: Unit): void
  /** any character took HP damage or heat (after `onDamaged`) */
  onAnyDamaged?(b: Battle, self: Unit, target: Unit, d: DamageCtx): void
  /** before damage is applied to this unit; may mutate amount */
  modifyIncoming?(b: Battle, self: Unit, d: DamageCtx): void
  /** "You gain Resistance to …": return true to resist this damage type. Resistance never stacks, and Shredded or Irreducible cancel it */
  grantsResistance?(b: Battle, self: Unit, type: string, d: DamageCtx): boolean
  /** the same, granted to another character (e.g. allies sheltered by Drake Fortress) */
  grantsAnyResistance?(b: Battle, self: Unit, target: Unit, type: string, d: DamageCtx): boolean
  onMove?(b: Battle, self: Unit, mover: Unit, path: Pos[]): void
  onDestroyed?(b: Battle, self: Unit, victim: Unit): void
  actions?(b: Battle, self: Unit): CustomAction[]
  /** called for every living unit's scripts before/after any attack (auras, ally reactions) */
  beforeAnyAttack?(b: Battle, self: Unit, ctx: AttackCtx): void
  afterAnyAttack?(b: Battle, self: Unit, ctx: AttackCtx): void
  /** one-time setup when the unit is built (static resistances, immunities, flags) */
  init?(u: Unit): void
  /** adjust the cover a target has against an attacker; called for every living unit */
  adjustCover?(b: Battle, self: Unit, attacker: Unit, target: Unit, cover: 'none' | 'soft' | 'hard'): 'none' | 'soft' | 'hard'
  /** return false to prevent forced movement (push/pull/knockback) of this unit */
  canBeMoved?(b: Battle, self: Unit, source?: Unit): boolean
  /** return true to block a status being applied to this unit */
  blockStatus?(b: Battle, self: Unit, status: string, source?: Unit): boolean
  /** the attacker's own rule refuses this target (a reason), checked by validTarget (e.g. Siege Stabilizers within range 5) */
  forbidsTarget?(b: Battle, self: Unit, w: Weapon, target: Unit, from: Pos): string | undefined
  /** this unit inflicted a status on someone */
  onStatusInflicted?(b: Battle, self: Unit, target: Unit, status: string): void
  /** after any attack roll is made (hit/miss known, damage not yet applied) */
  afterAnyRoll?(b: Battle, self: Unit, ctx: AttackCtx): void
  /** extra accuracy (or difficulty, if negative) this unit grants `u` on a check or save */
  checkAccuracy?(b: Battle, self: Unit, u: Unit, kind: 'check' | 'save', stat?: string): number
  /** persistent zones this unit's systems project (drawn as map overlays, listed in tooltips) */
  fields?(b: Battle, self: Unit): FieldOverlay[]
  /** actions this unit's systems make available to another unit (`other`) */
  grantActions?(b: Battle, self: Unit, other: Unit): CustomAction[]
  /** any character took damage (after its own modifyIncoming): reduce it here (e.g. shield generators) */
  modifyAnyIncoming?(b: Battle, self: Unit, target: Unit, d: DamageCtx): void
  onAnyTurnStart?(b: Battle, self: Unit, unit: Unit): void
  onAnyTurnEnd?(b: Battle, self: Unit, unit: Unit): void
  onHeat?(b: Battle, self: Unit, amount: number): void
  /** return true to cancel the normal overheat (stress) result */
  beforeOverheat?(b: Battle, self: Unit): boolean
  onStructureDamage?(b: Battle, self: Unit): void
  onStressDamage?(b: Battle, self: Unit): void
  onAnyMovementAction?(b: Battle, self: Unit, mover: Unit, kind: 'boost' | 'involuntary' | 'standard'): void
  /** when the owner activates its CORE power */
  onCoreActivate?(b: Battle, self: Unit): void
  /** substitute the d20 that `roller` is about to roll (return undefined to leave it) */
  overrideD20?(b: Battle, self: Unit, roller: Unit, kind: 'attack' | 'check' | 'save', ctx?: AttackCtx): number | undefined
  /** another unit is about to be pushed/pulled: return true to prevent it */
  preventAnyMove?(b: Battle, self: Unit, target: Unit, source?: Unit): boolean
  /** another unit is about to gain a status: return true to prevent it */
  blockAnyStatus?(b: Battle, self: Unit, target: Unit, status: string, source?: Unit): boolean
  /** a status was removed from this unit */
  onStatusRemoved?(b: Battle, self: Unit, status: string): void
  /** this unit took the Stabilize action */
  onStabilize?(b: Battle, self: Unit): void
  /** refuse an action or reaction this unit would spend (canSpend): return a reason (Napoleon Activate Aegis) */
  forbidsAction?(b: Battle, self: Unit, cost: string, action?: string): string | undefined
  /** this unit is about to take structure damage: return true to take none (Balor Hive Frenzy) */
  beforeStructureDamage?(b: Battle, self: Unit): boolean
  /** this unit planted a mine */
  onMinePlaced?(b: Battle, self: Unit, mine: Mine): void
  /** this unit's attack with `w` against `target` counts as Seeking (no line of sight needed: Monarch Seeking Payload) */
  seeksTarget?(b: Battle, self: Unit, w: Weapon, target: Unit): boolean
}

const registry = new Map<string, ItemScript>()

export function registerScript(s: ItemScript) {
  registry.set(s.id, s)
  registryVersion++
}
export function hasScript(id: string): boolean {
  return registry.has(id)
}
export function registerScripts(list: ItemScript[]) {
  list.forEach(registerScript)
}
export function getScript(id: string): ItemScript | undefined {
  return registry.get(id)
}
export function allScriptIds(): string[] {
  return [...registry.keys()]
}

/** Script ids that apply to a unit right now. */
export function scriptIdsFor(u: Unit): string[] {
  const ids: string[] = []
  if (u.frameId) {
    ids.push(`frame:${u.frameId}`)
    ids.push(`core:${u.frameId}`)
  }
  for (const s of u.systems) if (!s.destroyed) {
    if (!s.feature) { ids.push(s.dataId); continue }
    ids.push(`npc:${s.dataId}`)
    if (s.feature.script) ids.push(`npc:${s.feature.script}`)
  }
  for (const w of u.weapons) if (!w.destroyed) {
    if (w.dataId) ids.push(w.dataId.startsWith('npc_') ? `npc:${w.dataId}` : w.dataId)
    if (w.script) ids.push(`npc:${w.script}`)
    if (w.modId) ids.push(w.modId)
  }
  for (const t of u.talents) for (let r = 1; r <= t.rank; r++) ids.push(`${t.id}:${r}`)
  for (const c of u.coreBonuses) ids.push(c)
  for (const t of u.templates ?? []) ids.push(`template:${t}`)
  for (const t of u.traits ?? []) ids.push(`trait:${t.split(':')[0]}`)
  return ids
}

const cache = new WeakMap<Unit, { sig: string; scripts: ItemScript[] }>()
let registryVersion = 0

/** Cheap signature of everything that changes which scripts apply to a unit. */
function signature(u: Unit): string {
  let d = 0
  for (const w of u.weapons) if (w.destroyed) d++
  let sd = 0
  for (const s of u.systems) if (s.destroyed) sd++
  return `${registryVersion}|${u.frameId}|${u.weapons.length}.${d}|${u.systems.length}.${sd}|${u.talents.length}|${u.coreBonuses.length}|${u.templates?.length ?? 0}|${u.traits?.length ?? 0}`
}

export function scriptsFor(u: Unit): ItemScript[] {
  const sig = signature(u)
  const hit = cache.get(u)
  if (hit && hit.sig === sig) return hit.scripts
  const scripts = [...new Set(scriptIdsFor(u))].map(id => registry.get(id)).filter((x): x is ItemScript => !!x)
  cache.set(u, { sig, scripts })
  return scripts
}
