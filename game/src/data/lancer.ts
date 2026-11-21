// Indexed access to the official @massif/lancer-data compendium (GPL-3.0).
import frames from '@massif/lancer-data/lib/frames.json'
import weapons from '@massif/lancer-data/lib/weapons.json'
import systems from '@massif/lancer-data/lib/systems.json'
import mods from '@massif/lancer-data/lib/mods.json'
import talents from '@massif/lancer-data/lib/talents.json'
import coreBonuses from '@massif/lancer-data/lib/core_bonuses.json'
import statuses from '@massif/lancer-data/lib/statuses.json'
import tags from '@massif/lancer-data/lib/tags.json'
import actions from '@massif/lancer-data/lib/actions.json'
import rules from '@massif/lancer-data/lib/rules.json'
import sitreps from '@massif/lancer-data/lib/sitreps.json'
import pilotGear from '@massif/lancer-data/lib/pilot_gear.json'

export type DamageType = 'Kinetic' | 'Explosive' | 'Energy' | 'Burn' | 'Heat' | 'Variable'
export type RangeType = 'Range' | 'Threat' | 'Thrown' | 'Line' | 'Cone' | 'Blast' | 'Burst'

export interface DamageData { type: DamageType | string; val: string | number; aoe?: boolean; save?: string; save_half?: boolean }
export interface RangeData { type: RangeType | string; val: number | string; override?: boolean; bonus?: number }
export interface TagData { id: string; val?: number | string }
export interface BonusData {
  id: string
  val?: any
  accuracy?: number
  damage_types?: string[]
  range_types?: string[]
  weapon_types?: string[]
  weapon_sizes?: string[]
  condition?: string
  max?: number
}
export interface AddStatusData { id: string; duration?: string; save?: string }
export interface OnEffect { detail?: string; add_status?: AddStatusData[]; save?: any; bonus_damage?: { val: string; hit_type?: string }; damage?: DamageData[] }
export interface ActionData {
  id?: string
  name: string
  activation: string
  detail?: string
  trigger?: string
  frequency?: string
  range?: RangeData[]
  damage?: DamageData[]
  cost?: number
  tech_attack?: boolean
  heat_cost?: number
}
export interface DeployableData {
  name: string
  type: string
  detail?: string
  activation?: string
  size?: number
  hp?: number
  armor?: number
  evasion?: number
  edef?: number
  heatcap?: number
  speed?: number
  range?: RangeData[]
  damage?: DamageData[]
  actions?: ActionData[]
  counters?: any[]
}
export interface WeaponProfile {
  name?: string
  damage?: DamageData[]
  range?: RangeData[]
  tags?: TagData[]
  effect?: string
  on_hit?: string | OnEffect
  on_crit?: string | OnEffect
  on_attack?: string | OnEffect
  actions?: ActionData[]
}
export interface WeaponData extends WeaponProfile {
  id: string
  name: string
  mount: 'Auxiliary' | 'Main' | 'Heavy' | 'Superheavy' | 'Integrated'
  type: string
  sp?: number
  source?: string
  license?: string
  license_level?: number
  profiles?: WeaponProfile[]
  no_attack?: boolean
  no_mods?: boolean
  no_core_bonus?: boolean
  skirmish?: boolean
  barrage?: boolean
  deployables?: DeployableData[]
}
export interface SystemData {
  id: string
  name: string
  type?: string
  sp: number
  tags?: TagData[]
  effect?: string
  actions?: ActionData[]
  deployables?: DeployableData[]
  bonuses?: BonusData[]
  active_effects?: any[]
  synergies?: any[]
  ammo?: any[]
  counters?: any[]
  add_resist?: any
  license?: string
  license_level?: number
}
export interface FrameTrait { name: string; description: string; bonuses?: BonusData[]; actions?: ActionData[]; deployables?: DeployableData[]; use?: string }
export interface CoreSystem {
  name: string
  active_name?: string
  active_effect?: string
  activation?: string
  use?: string
  active_actions?: ActionData[]
  active_bonuses?: BonusData[]
  passive_name?: string
  passive_effect?: string
  passive_actions?: ActionData[]
  passive_bonuses?: BonusData[]
  deployables?: DeployableData[]
  integrated?: string[]
}
export interface FrameData {
  id: string
  name: string
  source: string
  license_level: number
  mechtype: string[]
  mounts: string[]
  stats: {
    size: number; structure: number; stress: number; armor: number; hp: number; evasion: number; edef: number
    heatcap: number; repcap: number; sensor_range: number; tech_attack: number; save: number; speed: number; sp: number
  }
  traits: FrameTrait[]
  core_system: CoreSystem
}
export interface TalentRank { name: string; description: string; bonuses?: BonusData[]; actions?: ActionData[]; synergies?: any[]; integrated?: string[] }
export interface TalentData { id: string; name: string; ranks: TalentRank[] }
export interface CoreBonusData { id: string; name: string; source: string; effect: string; bonuses?: BonusData[]; actions?: ActionData[] }
export interface ModData { id: string; name: string; sp: number; effect?: string; added_tags?: TagData[]; added_damage?: DamageData[]; added_range?: RangeData[]; bonuses?: BonusData[]; actions?: ActionData[]; allowed_types?: string[] }

function index<T extends { id: string }>(list: T[]): Map<string, T> {
  return new Map(list.map(x => [x.id, x]))
}

export const Lancer = {
  frames: index(frames as unknown as FrameData[]),
  weapons: index(weapons as unknown as WeaponData[]),
  systems: index(systems as unknown as SystemData[]),
  mods: index(mods as unknown as ModData[]),
  talents: index(talents as unknown as TalentData[]),
  coreBonuses: index(coreBonuses as unknown as CoreBonusData[]),
  statuses: statuses as any[],
  tags: index(tags as any[]),
  actions: index(actions as any[]),
  pilotGear: index(pilotGear as any[]),
  rules: rules as any,
  sitreps: sitreps as any[],
}

export function frame(id: string): FrameData {
  const f = Lancer.frames.get(id)
  if (!f) throw new Error(`Unknown frame '${id}'`)
  return f
}
