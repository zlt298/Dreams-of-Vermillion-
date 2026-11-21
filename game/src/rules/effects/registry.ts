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
  /** when the owner activates its CORE power */
  onCoreActivate?(b: Battle, self: Unit): void
}

const registry = new Map<string, ItemScript>()

export function registerScript(s: ItemScript) {
  registry.set(s.id, s)
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
  for (const s of u.systems) if (!s.destroyed) ids.push(s.feature ? `npc:${s.feature.script ?? s.dataId}` : s.dataId)
  for (const w of u.weapons) if (!w.destroyed) {
    if (w.dataId) ids.push(w.dataId.startsWith('npc_') ? `npc:${w.dataId}` : w.dataId)
    if (w.modId) ids.push(w.modId)
  }
  for (const t of u.talents) for (let r = 1; r <= t.rank; r++) ids.push(`${t.id}:${r}`)
  for (const c of u.coreBonuses) ids.push(c)
  for (const t of u.templates ?? []) ids.push(`template:${t}`)
  return ids
}

export function scriptsFor(u: Unit): ItemScript[] {
  return [...new Set(scriptIdsFor(u))].map(id => registry.get(id)).filter((x): x is ItemScript => !!x)
}
