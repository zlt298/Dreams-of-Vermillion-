// Pure helpers behind the in-game pilot builder: draft creation, mount layout, and the item lists
// each picker offers. No DOM here, so the rules are testable headless.
import { Lancer, type WeaponData, type SystemData, type FrameData, type ModData, type CoreBonusData } from '../data/lancer'
import type { MountBuild, PilotBuild } from '../import/compcon'
import {
  SLOT_SIZES, coreBonusAllowed, effectiveLicenses, expectedMounts, licensed, modFits, requiredLicenses, slotSizes, MAX_LICENSE_RANK,
} from '../rules/legality'

export const EVEREST = 'mf_standard_pattern_i_everest'
/** Core bonuses that are attached to one chosen mount. */
export const MOUNT_CBS = ['cb_auto_stabilizing_hardpoints', 'cb_overpower_caliber', 'cb_mount_retrofitting']

const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name)
const isUnique = (x: { tags?: { id: string }[] }) => !!x.tags?.some(t => t.id === 'tg_unique')

/** Items that can be picked from a list (frame-integrated and talent-granted gear has no source). */
const pickableWeapon = (w: WeaponData) => !!w.source && w.mount !== 'Integrated' && w.mount !== ('Ship-class' as any)
const pickableSystem = (s: SystemData) => !!s.source

const emptySlots = (type: string): MountBuild['slots'] =>
  (SLOT_SIZES[type] ?? [['Auxiliary']]).map(sizes => ({ size: sizes[0], weaponId: null, modId: null }))

export function newDraft(level = 0): PilotBuild {
  return {
    id: crypto.randomUUID(),
    callsign: 'New Lancer',
    name: 'New Lancer',
    level,
    mechSkills: [0, 0, 0, 0],
    talents: [],
    coreBonuses: [],
    licenses: [],
    mech: { name: 'Everest', frameId: EVEREST, mounts: layoutMounts(EVEREST, [], []), systems: [] },
    unknown: [],
  }
}

/** A deep copy ready for editing: slots padded to the mount's capacity, auto-integrated mounts dropped. */
export function editable(p: PilotBuild): PilotBuild {
  const d: PilotBuild = structuredClone(p)
  d.licenses ??= []
  d.mech.mounts = d.mech.mounts.filter(m => m.type !== 'Integrated').map(m => {
    const want = SLOT_SIZES[m.type]?.length ?? m.slots.length
    const slots = m.slots.slice(0, want)
    while (slots.length < want) slots.push({ size: SLOT_SIZES[m.type][slots.length][0], weaponId: null, modId: null })
    return { ...m, slots }
  })
  return d
}

/**
 * Rebuild the mount list for a frame and core bonuses, keeping the weapons of the old layout wherever they
 * still fit (matched by position) and keeping which mount each mount-targeted core bonus is on.
 */
export function layoutMounts(frameId: string, coreBonuses: string[], old: MountBuild[]): MountBuild[] {
  const types = expectedMounts(frameId, coreBonuses)
  const oldFrame = old.filter(m => m.type !== 'CB-Integrated' && m.type !== 'Integrated')
  const oldCb = old.find(m => m.type === 'CB-Integrated')
  let frameIdx = 0
  const out: MountBuild[] = types.map(t => {
    const prev = t === 'CB-Integrated' ? oldCb : oldFrame[frameIdx++]
    const retro = !!prev?.bonusEffects.includes('cb_mount_retrofitting') && coreBonuses.includes('cb_mount_retrofitting') && t !== 'CB-Integrated'
    const type = retro ? 'Main/Aux' : t
    const bonusEffects = (prev?.bonusEffects ?? []).filter(b => coreBonuses.includes(b) && (b !== 'cb_mount_retrofitting' || retro))
    const m: MountBuild = { type, slots: emptySlots(type), bonusEffects }
    prev?.slots.forEach((s, i) => {
      if (i < m.slots.length && s.weaponId) {
        const w = Lancer.weapons.get(s.weaponId)
        if (w && slotSizes(m, i).includes(w.mount)) m.slots[i] = { ...m.slots[i], weaponId: s.weaponId, modId: s.modId ?? null, profile: s.profile }
      }
    })
    return m
  })
  return out
}

/** Re-derive the mounts after the frame or core bonuses change. */
export function syncMounts(p: PilotBuild) {
  p.mech.mounts = layoutMounts(p.mech.frameId, p.coreBonuses, p.mech.mounts)
}

export function setFrame(p: PilotBuild, frameId: string) {
  const oldName = Lancer.frames.get(p.mech.frameId)?.name
  p.mech.frameId = frameId
  if (!p.mech.name || p.mech.name === oldName) p.mech.name = Lancer.frames.get(frameId)?.name ?? 'Mech'
  syncMounts(p)
}

/** Put a mount-targeted core bonus on mount `idx` (or remove it with idx = -1). */
export function setMountBonus(p: PilotBuild, cb: string, idx: number) {
  p.mech.mounts.forEach((m, i) => {
    m.bonusEffects = m.bonusEffects.filter(b => b !== cb)
    if (i === idx) m.bonusEffects.push(cb)
  })
  // retrofitting changes a mount's type; the layout is rebuilt from the frame so a moved retrofit restores the old type
  if (cb === 'cb_mount_retrofitting') syncMounts(p)
}

export function toggleCoreBonus(p: PilotBuild, id: string) {
  if (p.coreBonuses.includes(id)) p.coreBonuses = p.coreBonuses.filter(c => c !== id)
  else p.coreBonuses = [...p.coreBonuses, id]
  syncMounts(p)
}

export function setTalentRank(p: PilotBuild, id: string, rank: number) {
  p.talents = p.talents.filter(t => t.id !== id)
  if (rank > 0) p.talents.push({ id, rank })
}

/** License rank shown for a frame license (explicit, or raised by equipment) and the floor set by equipment. */
export function licenseRank(p: PilotBuild, id: string): { rank: number; min: number } {
  return { rank: effectiveLicenses(p).get(id) ?? 0, min: requiredLicenses(p).get(id) ?? 0 }
}
export function setLicenseRank(p: PilotBuild, id: string, rank: number) {
  const min = requiredLicenses(p).get(id) ?? 0
  const r = Math.max(min, Math.min(MAX_LICENSE_RANK, rank))
  p.licenses = (p.licenses ?? []).filter(l => l.id !== id)
  if (r > 0) p.licenses.push({ id, rank: r })
}

/** Drop core bonuses the pilot no longer qualifies for (after a license rank goes down). */
export function pruneCoreBonuses(p: PilotBuild) {
  const lic = effectiveLicenses(p)
  const keep: string[] = []
  for (const c of p.coreBonuses) if (coreBonusAllowed(c, keep, lic)) keep.push(c)
  if (keep.length !== p.coreBonuses.length) { p.coreBonuses = keep; syncMounts(p) }
}

// ------------------------------------------------------------------ picker contents
export function frameOptions(p: PilotBuild): FrameData[] {
  const lic = effectiveLicenses(p)
  return [...Lancer.frames.values()].filter(f => f.source === 'GMS' || (lic.get(f.id) ?? 0) >= f.license_level || f.id === p.mech.frameId).sort((a, b) =>
    a.source === 'GMS' ? -1 : b.source === 'GMS' ? 1 : a.source.localeCompare(b.source) || byName(a, b))
}

/** Weapons that can go in slot `slot` of mount `mi`. */
export function weaponOptions(p: PilotBuild, mi: number, slot: number): WeaponData[] {
  const m = p.mech.mounts[mi]
  if (!m) return []
  let sizes = slotSizes(m, slot)
  // a Flex mount with an Auxiliary in its second slot can only take another Auxiliary in its first
  if (m.type === 'Flex' && slot === 0 && m.slots[1]?.weaponId) sizes = sizes.filter(s => s === 'Auxiliary')
  const lic = effectiveLicenses(p)
  const current = m.slots[slot]?.weaponId
  const taken = new Set(p.mech.mounts.flatMap((mm, i) => mm.slots.filter((_, j) => !(i === mi && j === slot)).map(s => s.weaponId)).filter(Boolean))
  return [...Lancer.weapons.values()]
    .filter(w => w.id === current || (pickableWeapon(w) && sizes.includes(w.mount) && licensed(w, lic) && !(isUnique(w as any) && taken.has(w.id))))
    .sort(byName)
}

export function modOptions(p: PilotBuild, weaponId: string | null | undefined): ModData[] {
  const w = weaponId ? Lancer.weapons.get(weaponId) : undefined
  if (!w) return []
  const lic = effectiveLicenses(p)
  return [...Lancer.mods.values()].filter(m => modFits(m, w) && licensed(m, lic)).sort(byName)
}

export function systemOptions(p: PilotBuild): SystemData[] {
  const lic = effectiveLicenses(p)
  const have = new Set(p.mech.systems)
  return [...Lancer.systems.values()].filter(s => pickableSystem(s) && licensed(s, lic) && !(isUnique(s) && have.has(s.id))).sort(byName)
}

export function coreBonusOptions(p: PilotBuild): { cb: CoreBonusData; allowed: boolean }[] {
  const lic = effectiveLicenses(p)
  return [...Lancer.coreBonuses.values()].map(cb => ({ cb, allowed: p.coreBonuses.includes(cb.id) || coreBonusAllowed(cb.id, p.coreBonuses, lic) }))
}

export function setWeapon(p: PilotBuild, mi: number, slot: number, weaponId: string | null) {
  const m = p.mech.mounts[mi]
  const s = m.slots[slot]
  s.weaponId = weaponId || null
  s.profile = 0
  if (s.modId && !modFits(Lancer.mods.get(s.modId), weaponId ? Lancer.weapons.get(weaponId) : undefined)) s.modId = null
  if (!weaponId) s.modId = null
  // a Main weapon in a Flex mount uses the whole mount
  if (m.type === 'Flex' && slot === 0 && weaponId && Lancer.weapons.get(weaponId)?.mount !== 'Auxiliary' && m.slots[1]) m.slots[1] = { ...m.slots[1], weaponId: null, modId: null }
}
