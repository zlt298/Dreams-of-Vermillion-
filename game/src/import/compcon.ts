// Import pilots exported from COMP/CON (v3 "Save Pilot" exports, raw v3/v2 pilot data, or the
// COMP/CON pregen template format) into a compact PilotBuild the rules engine understands.
import { Lancer } from '../data/lancer'

export interface MountBuild {
  type: string            // Main, Flex, Heavy, Aux, Integrated, Superheavy...
  slots: { size: string; weaponId: string | null; modId?: string | null; profile?: number }[]
  bonusEffects: string[]  // core bonus ids applied to this mount (e.g. cb_auto_stabilizing_hardpoints)
}

export interface MechBuild {
  name: string
  frameId: string
  mounts: MountBuild[]
  systems: string[]
}

export interface PilotBuild {
  id: string
  callsign: string
  name: string
  level: number
  mechSkills: [number, number, number, number] // HASE
  talents: { id: string; rank: number }[]
  coreBonuses: string[]
  /** license ranks the pilot holds (frame id → rank); items' own licenses are implied on top of these */
  licenses?: { id: string; rank: number }[]
  mech: MechBuild
  /** ids the importer could not resolve against lancer-data (e.g. LCP content) */
  unknown: string[]
}

export class ImportError extends Error {}

const asId = (x: any): string | null => (x == null ? null : typeof x === 'string' ? x : x.id ?? null)

function mountFromV3(m: any): MountBuild {
  const slots: MountBuild['slots'] = []
  for (const s of [...(m.slots ?? []), ...(m.extra ?? [])]) {
    const w = s.weapon
    slots.push({ size: s.size, weaponId: asId(w), modId: asId(w?.mod), profile: w?.selectedProfile ?? 0 })
  }
  return { type: m.mount_type, slots, bonusEffects: (m.bonus_effects ?? []).map(asId).filter(Boolean) }
}

function convertPilotData(d: any, mechIndex?: number): PilotBuild {
  const mechs: any[] = d.mechs ?? []
  if (!mechs.length) throw new ImportError(`Pilot '${d.callsign ?? d.name}' has no mechs`)
  let mech = mechs[0]
  if (mechIndex != null && mechs[mechIndex]) mech = mechs[mechIndex]
  else if (d.favorite_mech) mech = mechs.find(m => m.id === d.favorite_mech) ?? mech
  else if (mechs.find(m => m.active)) mech = mechs.find(m => m.active)
  const lo = mech.loadouts?.[mech.active_loadout_index ?? 0] ?? mech.loadouts?.[0] ?? {}
  const mounts: MountBuild[] = []
  for (const m of lo.mounts ?? []) mounts.push(mountFromV3(m))
  for (const extra of ['improved_armament', 'integratedWeapon', 'superheavy_mounting']) {
    const m = lo[extra]
    if (m && (m.slots ?? []).some((s: any) => s.weapon)) {
      const mb = mountFromV3(m)
      if (extra === 'integratedWeapon') mb.type = 'CB-Integrated'
      mounts.push(mb)
    }
  }
  for (const m of lo.integratedMounts ?? []) {
    const w = m.weapon ?? m.slots?.[0]?.weapon
    if (w) mounts.push({ type: 'Integrated', slots: [{ size: 'Integrated', weaponId: asId(w) }], bonusEffects: [] })
  }
  const systems = [...(lo.systems ?? []), ...(lo.integratedSystems ?? [])].map(asId).filter((x): x is string => !!x)
  const ms = d.mechSkills ?? [0, 0, 0, 0]
  const talents = (d.talents ?? []).map((t: any) => (typeof t === 'string' ? { id: t, rank: 1 } : { id: t.id, rank: t.rank ?? 1 }))
  const coreBonuses = (d.core_bonuses ?? []).map(asId).filter(Boolean)
  const licenses = (d.licenses ?? [])
    .map((l: any) => ({ id: l?.id ?? l?.stub?.id ?? l?.license?.id, rank: Number(l?.rank) || 0 }))
    .filter((l: any) => typeof l.id === 'string' && l.rank > 0)
  return finish({
    id: d.id ?? crypto.randomUUID(),
    callsign: d.callsign ?? d.name ?? 'Lancer',
    name: d.name ?? d.callsign ?? 'Lancer',
    level: d.level ?? 0,
    mechSkills: [ms[0] ?? 0, ms[1] ?? 0, ms[2] ?? 0, ms[3] ?? 0],
    talents,
    coreBonuses,
    licenses,
    mech: { name: mech.name ?? 'Mech', frameId: mech.frame, mounts, systems },
    unknown: [],
  })
}

/** COMP/CON pregen template ({name, build:{mechSkills,talents,mech:{systems,mounts}}}). Pregens fly the Everest. */
function convertPregen(p: any): PilotBuild {
  const b = p.build
  const mounts: MountBuild[] = (b.mech.mounts ?? []).map((m: any) => ({
    type: m.mount_type,
    slots: (m.slots ?? []).map((w: string, i: number) => ({
      size: m.mount_type === 'Flex' && m.slots.length > 1 ? 'Auxiliary' : m.mount_type,
      weaponId: w,
    })),
    bonusEffects: [],
  }))
  return finish({
    id: `pregen_${p.name}`,
    callsign: p.name,
    name: p.name,
    level: 0,
    mechSkills: b.mechSkills,
    talents: (b.talents ?? []).map((id: string) => ({ id, rank: 1 })),
    coreBonuses: [],
    mech: { name: `${p.name} Everest`, frameId: 'mf_standard_pattern_i_everest', mounts, systems: b.mech.systems ?? [] },
    unknown: [],
  })
}

function finish(p: PilotBuild): PilotBuild {
  p.unknown = resolveUnknown(p)
  return p
}

/** Ids in the build that lancer-data doesn't know (LCP content). */
export function resolveUnknown(p: PilotBuild): string[] {
  const unknown: string[] = []
  if (!Lancer.frames.has(p.mech.frameId)) unknown.push(p.mech.frameId)
  for (const m of p.mech.mounts) for (const s of m.slots) {
    if (s.weaponId && !Lancer.weapons.has(s.weaponId)) unknown.push(s.weaponId)
    if (s.modId && !Lancer.mods.has(s.modId)) unknown.push(s.modId)
  }
  for (const s of p.mech.systems) if (!Lancer.systems.has(s)) unknown.push(s)
  for (const t of p.talents) if (!Lancer.talents.has(t.id)) unknown.push(t.id)
  for (const c of p.coreBonuses) if (!Lancer.coreBonuses.has(c)) unknown.push(c)
  return unknown
}

/** Accepts any supported JSON shape; returns one or more pilots. */
export function importPilots(json: unknown): PilotBuild[] {
  const j: any = json
  if (Array.isArray(j)) return j.flatMap(x => importPilots(x))
  if (!j || typeof j !== 'object') throw new ImportError('Not a COMP/CON pilot file')
  if (j.EXPORT_TYPE && j.data) return importPilots(j.data)
  if (j.build && j.build.mech) return [convertPregen(j)]
  if (j.mechs) return [convertPilotData(j)]
  if (j.pilots) return importPilots(j.pilots)
  throw new ImportError('Unrecognised file: expected a COMP/CON pilot export (.json)')
}
