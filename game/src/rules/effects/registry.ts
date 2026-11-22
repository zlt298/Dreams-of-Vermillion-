// Effect-script registry. Lancer content whose rules can't be expressed by structured
// lancer-data fields gets a hand-written script keyed by item id:
//   frame traits:  `frame:<frameId>`      core system: `core:<frameId>`
//   systems/weapons/mods/core bonuses: their lancer-data id
//   talents: `<talentId>:<rank>`          npc features: `npc:<featureKey>`
import type { DamageData } from '../../data/lancer'
import type { Battle } from '../battle'
import type { Pos, Profile, Unit, Weapon } from '../types'

export interface AttackCtx {
  attacker: Unit
  target: Unit
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
  irreducible?: boolean
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
  /** Quick Tech option this belongs to ('invade' for invasion options); different options may repeat in a turn */
  techOption?: string
  /** return true if usable, or a reason string */
  usable(b: Battle, self: Unit): true | string
  run(b: Battle, self: Unit, target?: Unit | Pos): void
  /** AI hint: rough value of using this action now */
  aiScore?(b: Battle, self: Unit, target?: Unit | Pos): number
}

export interface DamageCtx {
  source?: Unit
  attack?: AttackCtx
  amount: number
  kind: 'hp' | 'heat' | 'burn'
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
  /** before damage is applied to this unit; may mutate amount */
  modifyIncoming?(b: Battle, self: Unit, d: DamageCtx): void
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
  /** this unit inflicted a status on someone */
  onStatusInflicted?(b: Battle, self: Unit, target: Unit, status: string): void
  /** after any attack roll is made (hit/miss known, damage not yet applied) */
  afterAnyRoll?(b: Battle, self: Unit, ctx: AttackCtx): void
  /** extra accuracy (or difficulty, if negative) this unit grants `u` on a check or save */
  checkAccuracy?(b: Battle, self: Unit, u: Unit, kind: 'check' | 'save', stat?: string): number
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
