// LANCER build legality for a PilotBuild: point budgets (HASE, talents, licenses, core bonuses, SP)
// and whether each weapon, mod and system fits the mech. Used by the in-game builder and the tests.
import { Lancer, type WeaponData, type ModData } from '../data/lancer'
import type { MountBuild, PilotBuild } from '../import/compcon'
import { mechSP } from './stats'

export const MAX_LL = 12
export const MAX_SKILL = 6
export const MAX_LICENSE_RANK = 3

export interface Budget { used: number; max: number }
export interface Legality {
  errors: string[]
  /** unspent points and other non-blocking notes */
  warnings: string[]
  budgets: { hase: Budget; talents: Budget; licenses: Budget; coreBonuses: Budget; sp: Budget }
  /** license ranks in effect: explicit ranks, raised to whatever the equipped items need */
  licenses: Map<string, number>
}

/** Weapon sizes each slot of a mount type accepts (slot index → sizes). */
export const SLOT_SIZES: Record<string, string[][]> = {
  Main: [['Main', 'Auxiliary']],
  Heavy: [['Superheavy', 'Heavy', 'Main', 'Auxiliary']],
  Auxiliary: [['Auxiliary']],
  Flex: [['Main', 'Auxiliary'], ['Auxiliary']],
  'Main/Aux': [['Main', 'Auxiliary'], ['Auxiliary']],
  'Aux/Aux': [['Auxiliary'], ['Auxiliary']],
  'CB-Integrated': [['Auxiliary']],
}
/** Mount types added by the builder or importer that aren't part of the frame's own mount list. */
const EXTRA_MOUNTS = new Set(['CB-Integrated', 'Integrated'])

const hasTag = (x: { tags?: { id: string }[] } | undefined, id: string) => !!x?.tags?.some(t => t.id === id)

/** The license an item belongs to (frame id) and the rank it needs; null for GMS/unlicensed items. */
export function licenseOf(item: { license_id?: string; license_level?: number; source?: string } | undefined): { id: string; rank: number } | null {
  if (!item || !item.license_level || item.source === 'GMS' || !item.license_id) return null
  return { id: item.license_id, rank: item.license_level }
}
export function frameLicense(frameId: string): { id: string; rank: number } | null {
  const f = Lancer.frames.get(frameId)
  return f && f.source !== 'GMS' && f.license_level ? { id: f.id, rank: f.license_level } : null
}

/** License ranks the build's equipment needs. */
export function requiredLicenses(p: PilotBuild): Map<string, number> {
  const need = new Map<string, number>()
  const add = (l: { id: string; rank: number } | null) => { if (l) need.set(l.id, Math.max(need.get(l.id) ?? 0, l.rank)) }
  add(frameLicense(p.mech.frameId))
  for (const m of p.mech.mounts) for (const s of m.slots) {
    if (s.weaponId) add(licenseOf(Lancer.weapons.get(s.weaponId)))
    if (s.modId) add(licenseOf(Lancer.mods.get(s.modId)))
  }
  for (const id of p.mech.systems) add(licenseOf(Lancer.systems.get(id)))
  return need
}

export function effectiveLicenses(p: PilotBuild): Map<string, number> {
  const out = requiredLicenses(p)
  for (const l of p.licenses ?? []) out.set(l.id, Math.max(out.get(l.id) ?? 0, l.rank))
  return out
}

/** Can this pilot (with these license ranks) take the item? */
export function licensed(item: { license_id?: string; license_level?: number; source?: string } | undefined, lic: Map<string, number>): boolean {
  const l = licenseOf(item)
  return !l || (lic.get(l.id) ?? 0) >= l.rank
}

/** The mount types the mech should have: the frame's, plus mounts from core bonuses. */
export function expectedMounts(frameId: string, coreBonuses: string[]): string[] {
  const f = Lancer.frames.get(frameId)
  const out = [...(f?.mounts ?? [])]
  if (coreBonuses.includes('cb_improved_armament') && out.length < 3) out.push('Flex')
  if (coreBonuses.includes('cb_integrated_weapon')) out.push('CB-Integrated')
  return out
}

/** Weapon sizes a slot accepts, given what else is in the mount (a Flex mount holds one Main or two Auxiliary). */
export function slotSizes(m: MountBuild, slot: number): string[] {
  const sizes = SLOT_SIZES[m.type]?.[slot]
  if (!sizes) return m.type === 'Integrated' ? ['Auxiliary', 'Main', 'Heavy', 'Superheavy', 'Integrated'] : []
  if (m.type === 'Flex' && slot === 1) {
    const first = m.slots[0]?.weaponId ? Lancer.weapons.get(m.slots[0].weaponId!)?.mount : null
    if (first && first !== 'Auxiliary') return []
  }
  return sizes
}

export function modFits(mod: ModData | undefined, w: WeaponData | undefined): boolean {
  if (!mod || !w || w.no_mods) return false
  if (mod.allowed_types && !mod.allowed_types.includes(w.type)) return false
  if (mod.restricted_types?.includes(w.type)) return false
  if (mod.allowed_sizes && !mod.allowed_sizes.includes(w.mount)) return false
  if (mod.restricted_sizes?.includes(w.mount)) return false
  return true
}

/** Can a core bonus be taken? Non-GMS bonuses need 3 license ranks in that manufacturer per bonus. */
export function coreBonusAllowed(id: string, chosen: string[], lic: Map<string, number>): boolean {
  const cb = Lancer.coreBonuses.get(id)
  if (!cb) return false
  if (cb.source === 'GMS') return true
  const count = chosen.filter(c => c !== id && Lancer.coreBonuses.get(c)?.source === cb.source).length + 1
  return manufacturerRanks(cb.source, lic) >= 3 * count
}
export function manufacturerRanks(source: string, lic: Map<string, number>): number {
  let n = 0
  for (const [id, r] of lic) if (Lancer.frames.get(id)?.source === source) n += r
  return n
}

const nameOf = (id: string) =>
  Lancer.weapons.get(id)?.name ?? Lancer.systems.get(id)?.name ?? Lancer.mods.get(id)?.name ?? Lancer.talents.get(id)?.name ?? Lancer.coreBonuses.get(id)?.name ?? Lancer.frames.get(id)?.name ?? id

export function validateBuild(p: PilotBuild): Legality {
  const errors: string[] = []
  const warnings: string[] = []
  const LL = p.level
  if (!Number.isInteger(LL) || LL < 0 || LL > MAX_LL) errors.push(`License Level must be 0–${MAX_LL}`)

  // HASE
  const hase = { used: p.mechSkills.reduce((a, b) => a + b, 0), max: 2 + LL }
  if (p.mechSkills.some(s => s < 0 || s > MAX_SKILL)) errors.push(`Mech skills must be 0–${MAX_SKILL}`)
  if (hase.used > hase.max) errors.push(`Too many mech skill points (${hase.used}/${hase.max})`)
  else if (hase.used < hase.max) warnings.push(`${hase.max - hase.used} mech skill point(s) unspent`)

  // talents
  const talents = { used: p.talents.reduce((a, t) => a + t.rank, 0), max: 3 + LL }
  const seenT = new Set<string>()
  for (const t of p.talents) {
    const td = Lancer.talents.get(t.id)
    if (seenT.has(t.id)) errors.push(`${nameOf(t.id)} is listed twice`)
    seenT.add(t.id)
    if (td && (t.rank < 1 || t.rank > td.ranks.length)) errors.push(`${td.name} rank must be 1–${td.ranks.length}`)
  }
  if (talents.used > talents.max) errors.push(`Too many talent ranks (${talents.used}/${talents.max})`)
  else if (talents.used < talents.max) warnings.push(`${talents.max - talents.used} talent rank(s) unspent`)

  // licenses
  const lic = effectiveLicenses(p)
  const licenses = { used: [...lic.values()].reduce((a, b) => a + b, 0), max: LL }
  for (const [id, r] of lic) if (r > MAX_LICENSE_RANK) errors.push(`${nameOf(id)} license can't go above rank ${MAX_LICENSE_RANK}`)
  if (licenses.used > licenses.max) errors.push(`Too many license ranks (${licenses.used}/${licenses.max})`)
  else if (licenses.used < licenses.max) warnings.push(`${licenses.max - licenses.used} license rank(s) unspent`)

  // core bonuses
  const coreBonuses = { used: p.coreBonuses.length, max: Math.floor(LL / 3) }
  if (new Set(p.coreBonuses).size !== p.coreBonuses.length) errors.push('A core bonus is listed twice')
  if (coreBonuses.used > coreBonuses.max) errors.push(`Too many core bonuses (${coreBonuses.used}/${coreBonuses.max})`)
  else if (coreBonuses.used < coreBonuses.max) warnings.push(`${coreBonuses.max - coreBonuses.used} core bonus(es) unchosen`)
  const bySource = new Map<string, number>()
  for (const c of p.coreBonuses) { const s = Lancer.coreBonuses.get(c)?.source; if (s && s !== 'GMS') bySource.set(s, (bySource.get(s) ?? 0) + 1) }
  for (const [src, n] of bySource) {
    const have = manufacturerRanks(src, lic)
    if (have < 3 * n) errors.push(`${n} ${src} core bonus(es) need ${3 * n} ${src} license ranks (have ${have})`)
  }

  // frame and mounts
  const f = Lancer.frames.get(p.mech.frameId)
  if (!f) errors.push(`Unknown frame ${p.mech.frameId}`)
  const frameMounts = p.mech.mounts.filter(m => !EXTRA_MOUNTS.has(m.type))
  const want = expectedMounts(p.mech.frameId, p.coreBonuses).filter(t => !EXTRA_MOUNTS.has(t))
  if (f && frameMounts.length !== want.length) errors.push(`${f.name} should have ${want.length} mounts, has ${frameMounts.length}`)
  if (p.coreBonuses.includes('cb_integrated_weapon') !== p.mech.mounts.some(m => m.type === 'CB-Integrated'))
    errors.push('The Integrated Weapon core bonus mount is missing or extra')
  if (p.mech.mounts.filter(m => m.bonusEffects.includes('cb_mount_retrofitting')).length > (p.coreBonuses.includes('cb_mount_retrofitting') ? 1 : 0))
    errors.push('Only one mount can be retrofitted, and only with Mount Retrofitting')

  const unique = new Map<string, number>()
  let superheavy = 0
  p.mech.mounts.forEach(m => {
    if (m.type !== 'Integrated' && m.slots.length > (SLOT_SIZES[m.type]?.length ?? 0)) errors.push(`${m.type} mount has too many slots`)
    m.slots.forEach((s, i) => {
      if (!s.weaponId) { if (s.modId) errors.push('A mod is fitted to an empty slot'); return }
      const w = Lancer.weapons.get(s.weaponId)
      if (!w) return
      if (w.mount === 'Superheavy') superheavy++
      if (!slotSizes(m, i).includes(w.mount)) errors.push(`${w.name} (${w.mount}) doesn't fit a ${m.type} mount`)
      if (hasTag(w as any, 'tg_unique')) unique.set(w.id, (unique.get(w.id) ?? 0) + 1)
      if (s.modId) {
        const mod = Lancer.mods.get(s.modId)
        if (mod && !modFits(mod, w)) errors.push(`${mod.name} can't be fitted to ${w.name}`)
      }
    })
  })
  if (superheavy) {
    const free = p.mech.mounts.filter(m => !EXTRA_MOUNTS.has(m.type) && m.slots.every(s => !s.weaponId)).length
    if (free < superheavy) errors.push('A Superheavy weapon needs one other mount left empty')
  }
  for (const id of p.mech.systems) {
    const s = Lancer.systems.get(id)
    if (s && hasTag(s, 'tg_unique')) unique.set(id, (unique.get(id) ?? 0) + 1)
  }
  for (const [id, n] of unique) if (n > 1) errors.push(`${nameOf(id)} is Unique: only one allowed`)

  const sp = mechSP(p)
  if (sp.used > sp.max) errors.push(`Over SP budget (${sp.used}/${sp.max})`)
  if (p.unknown?.length) warnings.push(`Content not in lancer-data: ${p.unknown.join(', ')}`)

  return { errors, warnings, budgets: { hase, talents, licenses, coreBonuses, sp }, licenses: lic }
}
