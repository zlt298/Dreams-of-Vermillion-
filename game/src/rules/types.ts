import type { DamageData, RangeData, TagData, BonusData } from '../data/lancer'

export type Side = 'player' | 'enemy' | 'neutral'
export type Stat = 'hull' | 'agi' | 'sys' | 'eng'
export interface Pos { x: number; y: number }

export type StatusId =
  | 'impaired' | 'slowed' | 'immobilized' | 'jammed' | 'lockon' | 'shredded' | 'stunned'
  | 'exposed' | 'prone' | 'hidden' | 'invisible' | 'shutdown' | 'braced' | 'bracing_recovery'
  | 'grappled' | 'bolstered' | 'downandout'

/** Lancer durations, normalised. */
export type Duration =
  | 'end_of_turn'            // end of the current turn (whoever is acting)
  | 'next_turn_end_target'   // end of the affected character's next turn
  | 'next_turn_end_source'   // end of the source's next turn
  | 'start_of_next_turn_target'
  | 'until_cleared'
  | 'scene'

export interface StatusInstance {
  id: StatusId
  /** The status ends at the end of `turnsLeft` more turns of `clockUnit` (0 = untimed). */
  clockUnit?: string
  turnsLeft?: number
  atStart?: boolean
  source?: string
  data?: any
}

// ---------- Effect DSL (shared by NPC features, lancer-data on_hit/on_crit and scripts) ----------
export type EffectTarget = 'target' | 'self' | 'ally' | 'allies_in_area' | 'area'
export type Effect =
  | { do: 'status'; status: StatusId; duration?: Duration; save?: Stat; target?: EffectTarget }
  | { do: 'damage'; damage: DamageData[]; save?: Stat; saveHalf?: boolean; ap?: boolean; target?: EffectTarget }
  | { do: 'heat'; val: number | string; save?: Stat; target?: EffectTarget }
  | { do: 'burn'; val: number; save?: Stat; target?: EffectTarget }
  | { do: 'push' | 'pull'; val: number | string; save?: Stat; target?: EffectTarget }
  | { do: 'overshield'; val: number | string; target?: EffectTarget }
  | { do: 'heal'; val: number | string; target?: EffectTarget }
  | { do: 'clear_heat'; val: number | string | 'all'; target?: EffectTarget }
  | { do: 'clear_status'; status?: StatusId | 'any_negative'; target?: EffectTarget }
  | { do: 'bonus_damage'; val: string; type?: string }
  | { do: 'teleport'; val: number }
  | { do: 'text'; text: string }

export type HitType = 'attack' | 'hit' | 'crit' | 'miss'

// ---------- Equipment ----------
export interface Profile {
  name: string
  damage: DamageData[]
  range: RangeData[]
  tags: TagData[]
  onAttack: Effect[]
  onHit: Effect[]
  onCrit: Effect[]
  text?: string
}

export type WeaponSize = 'Auxiliary' | 'Main' | 'Heavy' | 'Superheavy'

export interface Weapon {
  uid: string
  name: string
  dataId?: string        // lancer-data id (mech weapons) or feature id (npc)
  mountIndex: number     // -1 = integrated / npc
  size: WeaponSize
  type: string           // Rifle, Melee, CQB, ...
  profiles: Profile[]
  profileIndex: number
  loaded: boolean
  destroyed: boolean
  usesLeft?: number
  modId?: string
  /** official NPC feature id whose script (`npc:<id>`) implements this weapon's extra rules */
  script?: string
  /** NPC flat attack bonus (replaces grit). */
  attackBonus?: number
  /** Innate accuracy (+) / difficulty (-) */
  accuracy?: number
  /** Smart / tech NPC attack: target E-Defense */
  vsEdef?: boolean
  tech?: boolean
  /** NPC tech / heavy features: which action they cost */
  activation?: 'quick' | 'full'
  recharge?: number       // NPC Recharge X+
  charged: boolean
  noBonusDamage?: boolean
  bonuses: BonusData[]    // core bonus / mount bonuses that apply to this weapon
  flags?: Record<string, any>
  /** an integrated weapon (frame, talent or the Integrated Weapon core bonus mount): System Trauma can't destroy it and it takes no mods */
  integrated?: boolean
}

export interface SystemInst {
  uid: string
  dataId: string
  name: string
  destroyed: boolean
  usesLeft?: number
  /** NPC feature payload */
  feature?: any
  charged: boolean
}

export interface Stats {
  hp: number
  armor: number
  evasion: number
  edef: number
  heatcap: number
  speed: number
  sensors: number
  save: number
  techAttack: number
  structure: number
  stress: number
  repcap: number
  size: number
  hull: number
  agi: number
  sys: number
  eng: number
  grit: number
  limitedBonus: number
  attackBonus: number
  activations: number
}

/** auto = engine decides, ask = prompt the player (via Battle.choose), off = never */
export type ReactionPolicy = 'auto' | 'ask' | 'off'

export interface UnitPolicies {
  brace: ReactionPolicy
  overwatch: ReactionPolicy
  /** scripted reactions from systems, weapons and talents (Vorpal Gun, Intercede...); unset = ask */
  reactions?: ReactionPolicy
}

export type UnitKind = 'mech' | 'npc' | 'deployable' | 'drone'

export interface Unit {
  id: string
  name: string
  side: Side
  kind: UnitKind
  pos: Pos
  flying: boolean
  stats: Stats
  hp: number
  heat: number
  structure: number
  stress: number
  overshield: number
  burn: number
  repairs: number
  coreAvailable: boolean
  coreActive: boolean
  overchargeLevel: number
  statuses: StatusInstance[]
  resist: string[]
  immune: string[]
  weapons: Weapon[]
  systems: SystemInst[]
  talents: { id: string; rank: number }[]
  coreBonuses: string[]
  frameId?: string
  pilotName?: string
  // npc
  role?: string
  tier?: number
  templates?: string[]
  /** NPC template traits (official template features, e.g. deadly, legendary, veterancy:hull) */
  traits?: string[]
  isGrunt?: boolean
  canCrit: boolean
  // turn economy
  activationsLeft: number
  activeTurn: boolean
  moveLeft: number
  actionsLeft: number        // 2 = two quick, full costs 2
  overchargedThisTurn: boolean
  actedThisTurn: boolean     // protocols only before anything else
  reactionsLeft: number
  reactionsPerRound: number
  boostedThisTurn: boolean
  /** active scene bonuses (core power etc.) */
  /** active conditional bonuses (accuracy, ranges...) incl. scene-long core powers */
  bonuses: BonusData[]
  /** generic counters used by effect scripts (1/round, 1/scene...) */
  flags: Record<string, any>
  destroyed: boolean
  meltdownTurns?: number
  selfDestructTurns?: number
  ownerId?: string           // deployables / drones
  expiresRound?: number
  policies: UnitPolicies
  color?: string
}

export interface LogEntry { round: number; text: string; kind?: 'info' | 'attack' | 'damage' | 'status' | 'turn' | 'warn' }
