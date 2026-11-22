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

// Official templates (Lancer core book NPC templates). Traits marked (engine) are implemented in
// src/rules/effects/templates.ts and Battle.
export const TEMPLATE_RULES: Record<Template, TemplateRule> = {
  Grunt: {
    budget: 0.25, featureSlots: -1,
    apply: s => { s.hp = 1; s.structure = 1; s.stress = 1; s.armor = 0 },
    notes: 'Chaff/Weak: 1 HP; destroyed by any damage (hits, Reliable on a miss, enemy heat); unharmed on a successful save (no half damage). One fewer feature.',
  },
  Veteran: {
    budget: 1.5, featureSlots: 0,
    apply: s => { s.structure += 1; s.stress += 1 },
    notes: 'Reinforced (+1 structure, +1 stress); Veterancy (+1 accuracy on checks/saves with one skill, `veterancy`); one Veteran trait (`veteranTrait`). Can score critical hits.',
  },
  Elite: {
    budget: 2, featureSlots: 0,
    apply: s => { s.structure += 1; s.stress += 1; s.activations = 2 },
    notes: 'Reinforced (+1 structure, +1 stress); Ready and Waiting (two separate turns each round).',
  },
  Commander: {
    budget: 1.75, featureSlots: 0,
    apply: s => { s.structure += 1; s.stress += 1 },
    notes: 'Reinforced (+1/+1); Voice of Authority (1/round reaction: an ally rerolls a missed attack); Military Discipline (adjacent allies +1 accuracy on attacks, checks and saves).',
  },
  Ultra: {
    budget: 4, featureSlots: 3,
    apply: s => { s.structure += 3; s.stress += 3; s.activations = 2; s.hp += 5 },
    notes: 'Reinforced (+3/+3), Resilient (+5 HP), Shock and Awe (two turns, a third vs 5+ hostiles; reactions refresh every turn), Deadly (+1d6 on crits), Juggernaut (clear a condition at turn start, repair a weapon/system at turn end), Legendary (structure/overheat rolled twice, keep the better), Reflex (unlimited Overwatch). +3 optional features. One per encounter.',
  },
  Mercenary: {
    budget: 1.25, featureSlots: 0,
    apply: () => {},
    notes: 'Opportunist (+1 accuracy when the target is engaged by an ally). May also carry one or two licensed mech weapons from lancer-data (by id; house rule).',
  },
}

/** Veteran traits the engine supports (pick one per Veteran, in addition to Veterancy). */
export const VETERAN_TRAITS = ['deadly', 'feign_death', 'hacker', 'hardened_target', 'insulated', 'legendary', 'lightning_reflexes', 'shock_armor', 'steel_jaw'] as const
export type VeteranTrait = (typeof VETERAN_TRAITS)[number]
export type SkillStat = 'hull' | 'agi' | 'sys' | 'eng'

export const BASE_FEATURE_SLOTS: Record<Tier, number> = { 1: 3, 2: 4, 3: 5 }

/** Encounter budget per player mech, by act (run depth). Elite nodes x1.5, boss nodes x2. */
export const BUDGET_PER_PC: Record<Tier, number> = { 1: 1.0, 2: 1.5, 3: 2.0 }

// ------------------------------------------------------------------ feature schema
export interface WeaponFeature {
  type: 'weapon'
  /** official NPC feature id: rules implemented by the script `npc:<id>` (rules/effects/official.ts) */
  script?: string
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
  /** official NPC data only: mount size and the weapon's own attack bonus */
  size?: 'Auxiliary' | 'Main' | 'Heavy' | 'Superheavy'
  attackBonus?: number
}

export interface TechFeature {
  type: 'tech'
  /** official NPC feature id: rules implemented by the script `npc:<id>` (rules/effects/official.ts) */
  script?: string
  name: string
  kind: 'quick' | 'full'
  range?: number             // default: sensors
  /** official NPC data only: the feature's own tech attack bonus */
  attackBonus?: number
  onHit: Effect[]
  accuracy?: number
  recharge?: number
  uses?: number
  text?: string
}

export interface SystemFeature {
  type: 'system'
  /** official NPC feature id: rules implemented by the script `npc:<id>` (rules/effects/official.ts) */
  script?: string
  name: string
  activation: 'quick' | 'full' | 'protocol'
  target: 'self' | 'ally' | 'enemy' | 'self_burst' | 'tile_blast' | 'line' | 'cone'
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
  /** official NPC feature id: rules implemented by the script `npc:<id>` (rules/effects/official.ts) */
  script?: string
  name: string
  stats?: Partial<NpcStats>
  resist?: string[]
  immune?: string[]
  hooks?: { on: HookTrigger; effects: Effect[]; target?: 'self' | 'trigger' }[]
  /** the unit can fly */
  flying?: boolean
  text?: string
}

export interface ReactionFeature {
  type: 'reaction'
  /** official NPC feature id: rules implemented by the script `npc:<id>` (rules/effects/official.ts) */
  script?: string
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
  /** official NPC classes (imported LCP, browser only): full tier stats replacing the role baseline; templates still apply */
  baseStats?: NpcStats
  /** official NPC class id this unit was built from */
  officialClass?: string
  /** Veteran only: skill for Veterancy (default: the role's best skill) and the chosen Veteran trait */
  veterancy?: SkillStat
  veteranTrait?: VeteranTrait
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

export function applyTemplates(s: NpcStats, templates: Template[] = []): NpcStats {
  for (const tp of templates) TEMPLATE_RULES[tp].apply(s)
  return s
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
