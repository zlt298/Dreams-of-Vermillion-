// Derived mech statistics and unit construction from an imported COMP/CON pilot.
import { Lancer, type BonusData, type OnEffect, type WeaponData, type WeaponProfile, type TagData } from '../data/lancer'
import type { PilotBuild } from '../import/compcon'
import type { Effect, Profile, Stats, StatusId, SystemInst, Unit, Weapon, WeaponSize, Duration, Stat } from './types'
import { scriptsFor } from './effects/registry'

let uidCounter = 0
export const nextUid = (p = 'u') => `${p}${++uidCounter}`

export function normalizeStatus(id: string): StatusId {
  const s = id.toLowerCase().replace(/[^a-z]/g, '')
  const map: Record<string, StatusId> = { lockon: 'lockon', downandout: 'downandout', shutdown: 'shutdown' }
  return (map[s] ?? s) as StatusId
}

const statOf = (s?: string): Stat | undefined => {
  if (!s) return undefined
  const k = s.toLowerCase()
  if (k.startsWith('hull')) return 'hull'
  if (k.startsWith('agi')) return 'agi'
  if (k.startsWith('sys')) return 'sys'
  if (k.startsWith('eng')) return 'eng'
  return undefined
}

/** Convert lancer-data on_hit/on_crit/on_attack into effects the engine runs. */
export function effectsFromData(e: string | OnEffect | undefined): Effect[] {
  if (!e) return []
  if (typeof e === 'string') return [{ do: 'text', text: e }]
  const out: Effect[] = []
  let handled = false
  for (const s of e.add_status ?? []) {
    out.push({ do: 'status', status: normalizeStatus(s.id), duration: (s.duration as Duration) ?? 'next_turn_end_target', save: statOf(s.save) })
    handled = true
  }
  if (e.bonus_damage) { out.push({ do: 'bonus_damage', val: e.bonus_damage.val }); handled = true }
  if (e.damage?.length) {
    out.push({ do: 'damage', damage: e.damage, save: statOf(e.damage[0].save), saveHalf: !!e.damage[0].save_half })
    handled = true
  }
  if (!handled && e.detail) out.push({ do: 'text', text: e.detail })
  return out
}

export function profileFromData(base: WeaponData, p: WeaponProfile, extraTags: TagData[] = []): Profile {
  return {
    name: p.name ?? base.name,
    damage: [...(p.damage ?? base.damage ?? [])],
    range: [...(p.range ?? base.range ?? [])],
    tags: [...(p.tags ?? base.tags ?? []), ...extraTags],
    onAttack: effectsFromData(p.on_attack ?? base.on_attack),
    onHit: effectsFromData(p.on_hit ?? base.on_hit),
    onCrit: effectsFromData(p.on_crit ?? base.on_crit),
    text: p.effect ?? base.effect,
  }
}

export function tagVal(tags: TagData[], id: string): number | undefined {
  const t = tags.find(t => t.id === id)
  if (!t) return undefined
  const v = typeof t.val === 'string' ? parseInt(t.val) : t.val
  return v ?? 1
}
export const hasTag = (tags: TagData[], id: string) => tags.some(t => t.id === id)

export function weaponFromData(id: string, mountIndex: number, opts: { modId?: string | null; profile?: number; bonuses?: BonusData[]; limitedBonus?: number } = {}): Weapon | null {
  const d = Lancer.weapons.get(id)
  if (!d) return null
  const mod = opts.modId ? Lancer.mods.get(opts.modId) : undefined
  const extraTags = mod?.added_tags ?? []
  const profiles = d.profiles?.length ? d.profiles.map(p => profileFromData(d, p, extraTags)) : [profileFromData(d, d, extraTags)]
  if (mod?.added_damage) for (const pr of profiles) pr.damage.push(...mod.added_damage)
  if (mod?.added_range) for (const pr of profiles) for (const r of mod.added_range) {
    const ex = pr.range.find(x => x.type === r.type)
    if (ex) ex.val = Number(ex.val) + Number(r.val)
  }
  const limited = tagVal(profiles[0].tags, 'tg_limited')
  return {
    uid: nextUid('w'),
    name: d.name,
    dataId: d.id,
    mountIndex,
    size: (d.mount === 'Integrated' ? 'Main' : d.mount) as WeaponSize,
    type: d.type,
    profiles,
    profileIndex: Math.min(opts.profile ?? 0, profiles.length - 1),
    loaded: true,
    destroyed: false,
    usesLeft: limited != null ? limited + (opts.limitedBonus ?? 0) : undefined,
    modId: mod?.id,
    charged: true,
    noBonusDamage: false,
    bonuses: opts.bonuses ?? [],
  }
}

export function systemFromData(id: string, limitedBonus = 0): SystemInst | null {
  const d = Lancer.systems.get(id)
  if (!d) return null
  const lim = tagVal(d.tags ?? [], 'tg_limited')
  return { uid: nextUid('s'), dataId: id, name: d.name, destroyed: false, usesLeft: lim != null ? lim + limitedBonus : undefined, charged: true }
}

/** All passive bonuses a mech build has (frame traits, core passive, systems, talents, core bonuses, mods). */
export function collectBonuses(p: PilotBuild): BonusData[] {
  const out: BonusData[] = []
  const f = Lancer.frames.get(p.mech.frameId)
  if (f) {
    for (const t of f.traits) out.push(...(t.bonuses ?? []))
    out.push(...(f.core_system.passive_bonuses ?? []))
  }
  for (const s of p.mech.systems) out.push(...(Lancer.systems.get(s)?.bonuses ?? []))
  for (const t of p.talents) {
    const td = Lancer.talents.get(t.id)
    if (!td) continue
    for (let i = 0; i < Math.min(t.rank, td.ranks.length); i++) out.push(...(td.ranks[i].bonuses ?? []))
  }
  for (const c of p.coreBonuses) {
    // mount-targeted core bonuses are attached to their mount's weapons instead
    if (c === 'cb_auto_stabilizing_hardpoints') continue
    out.push(...(Lancer.coreBonuses.get(c)?.bonuses ?? []))
  }
  return out
}

const num = (v: any) => (typeof v === 'number' ? v : parseInt(v) || 0)

export function deriveMechStats(p: PilotBuild, bonuses: BonusData[]): Stats {
  const f = Lancer.frames.get(p.mech.frameId)
  if (!f) throw new Error(`Unknown frame ${p.mech.frameId}`)
  const [hull, agi, sys, eng] = p.mechSkills
  const grit = Math.ceil(p.level / 2)
  const sum = (id: string) => bonuses.filter(b => b.id === id && b.val != null && !b.condition && !b.weapon_types && !b.damage_types).reduce((a, b) => a + num(b.val), 0)
  const fs = f.stats
  return {
    hp: fs.hp + grit + hull * 2 + sum('hp'),
    armor: Math.min(Lancer.rules.max_mech_armor ?? 4, fs.armor + sum('armor')),
    evasion: fs.evasion + agi + sum('evasion'),
    edef: fs.edef + sys + sum('edef'),
    heatcap: fs.heatcap + eng + sum('heatcap'),
    speed: fs.speed + Math.floor(agi / 2) + sum('speed'),
    sensors: fs.sensor_range + sum('sensor'),
    save: fs.save + grit + sum('save'),
    techAttack: fs.tech_attack + sys + sum('tech_attack'),
    structure: fs.structure + sum('structure'),
    stress: fs.stress + sum('stress'),
    repcap: fs.repcap + Math.floor(hull / 2) + sum('repcap'),
    size: fs.size + sum('size'),
    hull, agi, sys, eng,
    grit,
    limitedBonus: Math.floor(eng / 2) + sum('limited_bonus'),
    attackBonus: grit,
    activations: 1,
  }
}

export function mechSP(p: PilotBuild): { used: number; max: number } {
  const f = Lancer.frames.get(p.mech.frameId)
  const grit = Math.ceil(p.level / 2)
  const max = (f?.stats.sp ?? 0) + grit + Math.floor(p.mechSkills[2] / 2)
  let used = 0
  for (const s of p.mech.systems) used += Lancer.systems.get(s)?.sp ?? 0
  for (const m of p.mech.mounts) for (const s of m.slots) {
    if (s.weaponId) used += Lancer.weapons.get(s.weaponId)?.sp ?? 0
    if (s.modId) used += Lancer.mods.get(s.modId)?.sp ?? 0
  }
  return { used, max }
}

export function defaultPolicies() {
  return { brace: 'auto' as const, overwatch: 'auto' as const }
}

export function blankTurnState() {
  return {
    activationsLeft: 1, activeTurn: false, moveLeft: 0, actionsLeft: 2, overchargedThisTurn: false,
    actedThisTurn: false, reactionsLeft: 1, reactionsPerRound: 1, boostedThisTurn: false,
  }
}

export function buildMechUnit(p: PilotBuild, side: 'player' | 'enemy' = 'player'): Unit {
  const bonuses = collectBonuses(p)
  const stats = deriveMechStats(p, bonuses)
  const f = Lancer.frames.get(p.mech.frameId)!
  const weapons: Weapon[] = []
  p.mech.mounts.forEach((m, mi) => {
    const mountBonuses: BonusData[] = []
    for (const cb of m.bonusEffects) mountBonuses.push(...(Lancer.coreBonuses.get(cb)?.bonuses ?? []))
    for (const s of m.slots) {
      if (!s.weaponId) continue
      const w = weaponFromData(s.weaponId, mi, { modId: s.modId, profile: s.profile, bonuses: mountBonuses, limitedBonus: stats.limitedBonus })
      if (w && m.type === 'CB-Integrated') w.flags = { cbIntegrated: true }
      if (w) weapons.push(w)
    }
  })
  // integrated weapons from frame core systems / talents
  const integrated = [...(f.core_system.integrated ?? [])]
  for (const t of p.talents) {
    const td = Lancer.talents.get(t.id)
    for (let i = 0; i < Math.min(t.rank, td?.ranks.length ?? 0); i++) integrated.push(...(td!.ranks[i].integrated ?? []))
  }
  const systems: SystemInst[] = []
  for (const id of integrated) {
    if (weapons.some(w => w.dataId === id)) continue
    const w = weaponFromData(id, -1, { limitedBonus: stats.limitedBonus })
    if (w) weapons.push(w)
    else { const s = systemFromData(id, stats.limitedBonus); if (s) systems.push(s) }
  }
  for (const id of p.mech.systems) {
    const s = systemFromData(id, stats.limitedBonus)
    if (s) systems.push(s)
  }
  const resist: string[] = []
  for (const s of p.mech.systems) {
    const ar = Lancer.systems.get(s)?.add_resist
    for (const r of Array.isArray(ar) ? ar : ar ? [ar] : []) if (r.resist) resist.push(r.resist)
  }
  const immune: string[] = []
  for (const b of bonuses) if (b.id === 'immunity') immune.push(...(b.val as string[]).map(x => x.toLowerCase()))
  const extraReaction = bonuses.filter(b => b.id === 'extra_action' && b.val === 'reaction').length
  const unit: Unit = {
    id: nextUid('mech'),
    name: p.callsign,
    pilotName: p.name,
    side,
    kind: 'mech',
    pos: { x: 0, y: 0 },
    flying: false,
    stats,
    hp: stats.hp,
    heat: 0,
    structure: stats.structure,
    stress: stats.stress,
    overshield: 0,
    burn: 0,
    repairs: stats.repcap,
    coreAvailable: true,
    coreActive: false,
    overchargeLevel: 0,
    statuses: [],
    resist,
    immune,
    weapons,
    systems,
    talents: p.talents,
    coreBonuses: p.coreBonuses,
    frameId: p.mech.frameId,
    canCrit: true,
    ...blankTurnState(),
    reactionsPerRound: 1 + extraReaction,
    reactionsLeft: 1 + extraReaction,
    bonuses: bonuses.filter(b => b.accuracy != null || b.weapon_types || b.range_types || b.damage_types || b.condition || ['knockback', 'thrown', 'min_range', 'damage', 'range', 'threat', 'boost', 'overcharge', 'cheap_struct', 'no_cascade', 'drone_hp', 'deployable_hp', 'drone_resist', 'deployable_resist', 'ai_cap', 'mount_accuracy'].includes(b.id)),
    flags: {},
    destroyed: false,
    policies: defaultPolicies(),
  }
  for (const sc of scriptsFor(unit)) sc.init?.(unit)
  return unit
}
