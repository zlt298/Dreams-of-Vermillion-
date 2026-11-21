// The Dreams of Vermillion enemy ruleset — an original NPC framework modelled on Lancer's
// NPC structure (roles, tiers, templates, features). The human-readable version lives in
// docs/enemy-ruleset.md; keep both in sync.
import type { DamageData, RangeData, TagData } from '../data/lancer'
import type { Effect, Stat } from '../rules/types'

export const ROLES = ['Striker', 'Artillery', 'Controller', 'Defender', 'Support', 'Biological'] as const
export type Role = (typeof ROLES)[number]

export const TEMPLATES = ['Grunt', 'Veteran', 'Elite', 'Commander', 'Ultra', 'Mercenary'] as const
export type Template = (typeof TEMPLATES)[number]

export type Tier = 1 | 2 | 3

export interface NpcStats {
  hp: number
  armor: number
  evasion: number
  edef: number
  heatcap: number
  speed: number
  sensors: number
  save: number
  size: number
  hull: number
  agi: number
  sys: number
  eng: number
  structure: number
  stress: number
  activations: number
  attackBonus: number
  techAttack: number
}

/** Tier-1 baseline per role. */
export const ROLE_BASE: Record<Role, Omit<NpcStats, 'save' | 'structure' | 'stress' | 'activations' | 'attackBonus' | 'techAttack'>> = {
  Striker:    { hp: 12, armor: 0, evasion: 10, edef: 8,  heatcap: 6, speed: 5, sensors: 10, size: 1, hull: 1, agi: 2, sys: 0, eng: 0 },
  Artillery:  { hp: 10, armor: 0, evasion: 6,  edef: 8,  heatcap: 8, speed: 3, sensors: 15, size: 1, hull: 0, agi: 0, sys: 1, eng: 1 },
  Controller: { hp: 10, armor: 0, evasion: 8,  edef: 12, heatcap: 8, speed: 4, sensors: 15, size: 1, hull: 0, agi: 0, sys: 2, eng: 1 },
  Defender:   { hp: 18, armor: 2, evasion: 6,  edef: 6,  heatcap: 6, speed: 3, sensors: 10, size: 2, hull: 2, agi: -1, sys: 0, eng: 1 },
  Support:    { hp: 12, armor: 1, evasion: 8,  edef: 10, heatcap: 8, speed: 4, sensors: 15, size: 1, hull: 0, agi: 0, sys: 1, eng: 2 },
  Biological: { hp: 14, armor: 0, evasion: 8,  edef: 4,  heatcap: 0, speed: 5, sensors: 8,  size: 1, hull: 2, agi: 1, sys: -2, eng: 0 },
}

/** Per-tier additions applied on top of the role baseline. */
export const TIER_SCALING: Record<Tier, { hp: number; hpDefender: number; evasion: number; edef: number; armor: number; save: number; attackBonus: number; stat: number; heatcap: number }> = {
  1: { hp: 0, hpDefender: 0, evasion: 0, edef: 0, armor: 0, save: 10, attackBonus: 1, stat: 0, heatcap: 0 },
  2: { hp: 4, hpDefender: 6, evasion: 1, edef: 1, armor: 0, save: 12, attackBonus: 2, stat: 1, heatcap: 2 },
  3: { hp: 8, hpDefender: 12, evasion: 2, edef: 2, armor: 1, save: 14, attackBonus: 3, stat: 2, heatcap: 4 },
}

/** Expected average damage for one standard attack feature (before accuracy), by role & tier. */
export const DAMAGE_BAND: Record<Role, [number, number, number]> = {
  Striker: [7, 9, 11],
  Artillery: [6, 8, 10],
  Controller: [4, 6, 8],
  Defender: [5, 7, 9],
  Support: [4, 6, 7],
  Biological: [6, 8, 10],
}
/** Tolerance on the damage band (fraction). Weapons with Recharge/Limited may exceed by a further 50%. */
export const DAMAGE_TOLERANCE = 0.35

/** How far authored stats may deviate from the computed baseline. */
export const STAT_TOLERANCE: Partial<Record<keyof NpcStats, number>> = {
  hp: 0.3, // fraction
  armor: 1,
  evasion: 2,
  edef: 2,
  heatcap: 2,
  speed: 2,
  sensors: 5,
  hull: 1, agi: 1, sys: 1, eng: 1,
}

export interface TemplateRule {
  budget: number            // encounter budget cost multiplier relative to a standard unit (1.0)
  featureSlots: number      // additional feature slots
  apply(s: NpcStats): void
  notes: string
}

export const TEMPLATE_RULES: Record<Template, TemplateRule> = {
  Grunt: {
    budget: 0.25, featureSlots: -1,
    apply: s => { s.hp = 1; s.structure = 1; s.stress = 1; s.armor = 0 },
    notes: '1 HP; ignore damage from misses and successful saves (Reliable, half damage); destroyed by any hit. One fewer feature.',
  },
  Veteran: {
    budget: 1.5, featureSlots: 1,
    apply: s => { s.hp += 4; s.attackBonus += 1; s.evasion += 1 },
    notes: '+4 HP, +1 attack bonus, +1 evasion, +1 feature.',
  },
  Elite: {
    budget: 2, featureSlots: 1,
    apply: s => { s.structure = 2; s.stress = 2; s.hp += 2 },
    notes: '2 structure and 2 stress (uses structure/overheat tables), +2 HP, +1 feature.',
  },
  Commander: {
    budget: 2, featureSlots: 1,
    apply: s => { s.structure = Math.max(s.structure, 2); s.stress = Math.max(s.stress, 2) },
    notes: 'Aura: allies within 3 gain +1 accuracy on attacks. Rally: when an ally within 5 is destroyed, allies within 5 gain 2 overshield. 2 structure/stress.',
  },
  Ultra: {
    budget: 4, featureSlots: 3,
    apply: s => { s.structure = 3; s.stress = 3; s.activations = 2; s.hp += 6; s.save += 1 },
    notes: '3 structure, 3 stress, 2 activations per round, +6 HP, +1 save target, +3 features. Use for bosses.',
  },
  Mercenary: {
    budget: 1.25, featureSlots: 0,
    apply: s => { s.hp += 2 },
    notes: 'May carry one or two licensed mech weapons from lancer-data (by id) in addition to its features. +2 HP.',
  },
}

export const BASE_FEATURE_SLOTS: Record<Tier, number> = { 1: 3, 2: 4, 3: 5 }

/** Encounter budget per player mech, by act (run depth). Elite nodes x1.5, boss nodes x2. */
export const BUDGET_PER_PC: Record<Tier, number> = { 1: 1.0, 2: 1.25, 3: 1.5 }

// ------------------------------------------------------------------ feature schema
export interface WeaponFeature {
  type: 'weapon'
  name: string
  weaponType: 'Melee' | 'CQB' | 'Rifle' | 'Cannon' | 'Launcher' | 'Nexus' | 'Spool'
  range: RangeData[]
  damage: DamageData[]
  tags?: TagData[]
  accuracy?: number
  smart?: boolean
  onHit?: Effect[]
  onCrit?: Effect[]
  recharge?: number          // Recharge X+ (d6 at start of turn)
  uses?: number              // Limited
  text?: string
}

export interface TechFeature {
  type: 'tech'
  name: string
  kind: 'quick' | 'full'
  range?: number             // default: sensors
  onHit: Effect[]
  accuracy?: number
  recharge?: number
  uses?: number
  text?: string
}

export interface SystemFeature {
  type: 'system'
  name: string
  activation: 'quick' | 'full' | 'protocol'
  target: 'self' | 'ally' | 'enemy' | 'self_burst' | 'tile_blast'
  range?: number
  radius?: number
  effects: Effect[]
  /** if set, enemy targets get a save of this stat against the unit's save target */
  save?: Stat
  recharge?: number
  uses?: number
  heat?: number
  text?: string
}

export type HookTrigger = 'turn_start' | 'turn_end' | 'hit_by_melee' | 'damaged' | 'ally_destroyed_nearby' | 'attacked_and_missed'

export interface TraitFeature {
  type: 'trait'
  name: string
  stats?: Partial<NpcStats>
  resist?: string[]
  immune?: string[]
  hooks?: { on: HookTrigger; effects: Effect[]; target?: 'self' | 'trigger' }[]
  text?: string
}

export interface ReactionFeature {
  type: 'reaction'
  name: string
  trigger: 'hit_by_melee' | 'ally_attacked_adjacent' | 'enemy_moves_adjacent' | 'damaged' | 'attacked_and_missed'
  frequency?: '1/round' | '1/scene'
  effects?: Effect[]
  /** name of one of the unit's weapon features to attack the triggering character with */
  attackWith?: string
  text?: string
}

export type Feature = WeaponFeature | TechFeature | SystemFeature | TraitFeature | ReactionFeature

export interface EnemyUnitDef {
  name: string
  role: Role
  templates?: Template[]
  count?: number
  color?: string
  /** explicit stat adjustments on top of baseline + tier + templates */
  stats?: Partial<NpcStats>
  features: Feature[]
  /** Mercenary only: lancer-data weapon ids */
  mechWeapons?: string[]
  description?: string
}

export interface EnemyTeam {
  id: string
  name: string
  faction?: string
  theme?: string
  tier: Tier
  /** player squad size this team was balanced for */
  designedFor: number
  /** run depth range (1-based node depth) where it can appear */
  depth?: [number, number]
  kind?: 'standard' | 'elite' | 'boss'
  sitrep?: 'standard' | 'holdout' | 'control' | 'extraction' | 'assassination'
  description?: string
  units: EnemyUnitDef[]
}

export function baselineStats(role: Role, tier: Tier, templates: Template[] = []): NpcStats {
  const b = ROLE_BASE[role]
  const t = TIER_SCALING[tier]
  const s: NpcStats = {
    ...b,
    hp: b.hp + (role === 'Defender' ? t.hpDefender : t.hp),
    armor: b.armor + t.armor,
    evasion: b.evasion + t.evasion,
    edef: b.edef + t.edef,
    heatcap: b.heatcap ? b.heatcap + t.heatcap : 0,
    hull: b.hull + (b.hull > 0 ? t.stat : 0),
    agi: b.agi + (b.agi > 0 ? t.stat : 0),
    sys: b.sys + (b.sys > 0 ? t.stat : 0),
    eng: b.eng + (b.eng > 0 ? t.stat : 0),
    save: t.save,
    structure: 1,
    stress: 1,
    activations: 1,
    attackBonus: t.attackBonus,
    techAttack: t.attackBonus + Math.max(0, b.sys),
  }
  for (const tp of templates) TEMPLATE_RULES[tp].apply(s)
  return s
}

export function unitBudget(u: EnemyUnitDef): number {
  const all = u.templates ?? []
  const ts = all.filter(t => t !== 'Grunt')
  let cost: number
  if (all.includes('Grunt')) cost = 0.25 + 0.25 * ts.length
  else cost = ts.length ? Math.max(...ts.map(t => TEMPLATE_RULES[t].budget)) + 0.5 * (ts.length - 1) : 1
  return cost * (u.count ?? 1)
}

export function teamBudget(t: EnemyTeam): number {
  return t.units.reduce((a, u) => a + unitBudget(u), 0)
}

export function featureSlots(tier: Tier, templates: Template[] = []): number {
  return BASE_FEATURE_SLOTS[tier] + templates.reduce((a, t) => a + TEMPLATE_RULES[t].featureSlots, 0)
}
