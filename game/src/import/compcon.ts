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

/** A list field: missing → [], an array → itself, anything else is a malformed file. */
function list(x: any, what: string): any[] {
  if (x == null) return []
  if (!Array.isArray(x)) throw new ImportError(`Malformed pilot file: '${what}' is not a list`)
  return x
}

/** An object entry: null / non-objects are a malformed file. */
function obj(x: any, what: string): any {
  if (!x || typeof x !== 'object') throw new ImportError(`Malformed pilot file: bad ${what} entry`)
  return x
}

function toLevel(x: any): number {
  if (x == null || x === '') return 0
  const n = Number(x)
  if (!Number.isFinite(n)) throw new ImportError(`Malformed pilot file: level '${x}' is not a number`)
  return n
}

function toSkills(x: any): [number, number, number, number] {
  const ms = list(x, 'mechSkills')
  const at = (i: number) => Number(ms[i]) || 0
  return [at(0), at(1), at(2), at(3)]
}

function mountFromV3(m: any): MountBuild {
  const slots: MountBuild['slots'] = []
  obj(m, 'mount')
  for (const s of [...list(m.slots, 'slots'), ...list(m.extra, 'extra')]) {
    const w = obj(s, 'slot').weapon
    slots.push({ size: s.size, weaponId: asId(w), modId: asId(w?.mod), profile: w?.selectedProfile ?? 0 })
  }
  return { type: m.mount_type, slots, bonusEffects: list(m.bonus_effects, 'bonus_effects').map(asId).filter((x): x is string => !!x) }
}

function convertPilotData(d: any, mechIndex?: number): PilotBuild {
  const mechs: any[] = list(d.mechs, 'mechs')
  if (!mechs.length) throw new ImportError(`Pilot '${d.callsign ?? d.name}' has no mechs`)
  mechs.forEach(m => obj(m, 'mech'))
  let mech = mechs[0]
  if (mechIndex != null && mechs[mechIndex]) mech = mechs[mechIndex]
  else if (d.favorite_mech) mech = mechs.find(m => m.id === d.favorite_mech) ?? mech
  else if (mechs.find(m => m.active)) mech = mechs.find(m => m.active)
  const los = list(mech.loadouts, 'loadouts')
  const lo = obj(los[mech.active_loadout_index ?? 0] ?? los[0] ?? {}, 'loadout')
  const mounts: MountBuild[] = []
  for (const m of list(lo.mounts, 'mounts')) mounts.push(mountFromV3(m))
  for (const extra of ['improved_armament', 'integratedWeapon', 'superheavy_mounting']) {
    const m = lo[extra]
    if (m && list(m.slots, extra).some((s: any) => s?.weapon)) {
      const mb = mountFromV3(m)
      if (extra === 'integratedWeapon') mb.type = 'CB-Integrated'
      mounts.push(mb)
    }
  }
  for (const m of list(lo.integratedMounts, 'integratedMounts')) {
    const w = obj(m, 'integrated mount').weapon ?? m.slots?.[0]?.weapon
    if (w) mounts.push({ type: 'Integrated', slots: [{ size: 'Integrated', weaponId: asId(w) }], bonusEffects: [] })
  }
  const systems = [...list(lo.systems, 'systems'), ...list(lo.integratedSystems, 'integratedSystems')].map(asId).filter((x): x is string => !!x)
  const talents = list(d.talents, 'talents').map((t: any) => (typeof t === 'string' ? { id: t, rank: 1 } : { id: obj(t, 'talent').id, rank: t.rank ?? 1 }))
  const coreBonuses = list(d.core_bonuses, 'core_bonuses').map(asId).filter((x): x is string => !!x)
  const licenses = list(d.licenses, 'licenses')
    .map((l: any) => ({ id: l?.id ?? l?.stub?.id ?? l?.license?.id, rank: Number(l?.rank) || 0 }))
    .filter((l: any) => typeof l.id === 'string' && l.rank > 0)
  return finish({
    id: d.id ?? crypto.randomUUID(),
    callsign: d.callsign ?? d.name ?? 'Lancer',
    name: d.name ?? d.callsign ?? 'Lancer',
    level: toLevel(d.level),
    mechSkills: toSkills(d.mechSkills),
    talents,
    coreBonuses,
    licenses,
    mech: { name: mech.name ?? 'Mech', frameId: mech.frame, mounts, systems },
    unknown: [],
  })
}

/** COMP/CON pregen template ({name, build:{mechSkills,talents,mech:{systems,mounts}}}). Pregens fly the Everest. */
function convertPregen(p: any): PilotBuild {
  const b = obj(p.build, 'build')
  obj(b.mech, 'mech')
  const mounts: MountBuild[] = list(b.mech.mounts, 'mounts').map((m: any) => ({
    type: obj(m, 'mount').mount_type,
    slots: list(m.slots, 'slots').map((w: string) => ({
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
    mechSkills: toSkills(b.mechSkills),
    talents: list(b.talents, 'talents').map((id: string) => ({ id, rank: 1 })),
    coreBonuses: [],
    mech: { name: `${p.name} Everest`, frameId: 'mf_standard_pattern_i_everest', mounts, systems: list(b.mech.systems, 'systems') },
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

/** Any other shape error in a malformed file surfaces as an ImportError, never a raw TypeError. */
function guarded(f: () => PilotBuild): PilotBuild {
  try { return f() } catch (e) {
    if (e instanceof ImportError) throw e
    throw new ImportError(`Malformed pilot file: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Accepts any supported JSON shape; returns one or more pilots. */
export function importPilots(json: unknown): PilotBuild[] {
  const j: any = json
  if (Array.isArray(j)) return j.flatMap(x => importPilots(x))
  if (!j || typeof j !== 'object') throw new ImportError('Not a COMP/CON pilot file')
  if (j.EXPORT_TYPE && j.data) return importPilots(j.data)
  if (j.build && j.build.mech) return [guarded(() => convertPregen(j))]
  if (j.mechs) return [guarded(() => convertPilotData(j))]
  if (j.pilots) return importPilots(j.pilots)
  throw new ImportError('Unrecognised file: expected a COMP/CON pilot export (.json)')
}
