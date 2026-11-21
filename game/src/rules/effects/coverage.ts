// Fidelity bookkeeping: which lancer-data items the engine executes automatically (structured
// data), which have hand-written scripts, and which still need manual adjudication.
import { Lancer, type OnEffect } from '../../data/lancer'
import type { Unit } from '../types'
import { actionIsStructured } from './generic'
import { getScript as rawGet } from './registry'

/** 'scripted' when a full script exists, 'partial' when it only approximates */
const getScript = (id: string) => rawGet(id)
const sc = (id: string): Coverage | null => { const s = rawGet(id); return s ? (s.partial ? 'partial' : 'scripted') : null }

export type Coverage = 'scripted' | 'partial' | 'auto' | 'manual'

const SUPPORTED_TAGS = new Set([
  'tg_ap', 'tg_accurate', 'tg_inaccurate', 'tg_arcing', 'tg_seeking', 'tg_smart', 'tg_reliable', 'tg_knockback', 'tg_loading',
  'tg_overkill', 'tg_heat_self', 'tg_limited', 'tg_unique', 'tg_burn', 'tg_heat_target', 'tg_irreducible', 'tg_threat', 'tg_range',
  'tg_line', 'tg_cone', 'tg_blast', 'tg_burst', 'tg_quick_action', 'tg_full_action', 'tg_protocol', 'tg_free_action', 'tg_ordnance',
  'tg_thrown', 'tg_grenade', 'tg_mine', 'tg_deployable', 'tg_drone', 'tg_mod', 'tg_archaic', 'tg_exotic', 'tg_resistall', 'tg_invulnerable',
  'tg_indestructible', 'tg_recharge', 'tg_round', 'tg_turn', 'tg_unlimited', 'tg_shield', 'tg_ai', 'tg_reaction', 'tg_quick_tech', 'tg_full_tech', 'tg_invade', 'tg_danger_zone',
])

const structured = (e: string | OnEffect | undefined) => e == null || (typeof e !== 'string' && !!(e.add_status?.length || e.bonus_damage || e.damage?.length))

export function weaponCoverage(id: string): Coverage {
  if (sc(id)) return sc(id)!
  const w = Lancer.weapons.get(id)
  if (!w) return 'manual'
  const profiles = w.profiles?.length ? w.profiles : [w]
  for (const p of profiles) {
    if (!structured(p.on_hit ?? w.on_hit) || !structured(p.on_crit ?? w.on_crit) || !structured(p.on_attack ?? w.on_attack)) return 'manual'
    if ((p.tags ?? w.tags ?? []).some(t => !SUPPORTED_TAGS.has(t.id))) return 'manual'
    if (p.effect && !(w.profiles?.length && /profile|spin|mode/i.test(p.effect))) return 'manual'
  }
  if (w.effect || w.deployables?.length) return 'manual'
  return 'auto'
}

export function systemCoverage(id: string): Coverage {
  if (sc(id)) return sc(id)!
  const s = Lancer.systems.get(id)
  if (!s) return 'manual'
  const acts = s.actions ?? []
  const deps = s.deployables ?? []
  if (!acts.length && !deps.length) return s.bonuses?.length || s.add_resist || !s.effect ? 'auto' : 'manual'
  if (acts.some(a => !actionIsStructured(a))) return 'manual'
  if (deps.some(d => d.type !== 'Mine' || !d.damage?.length)) return 'manual'
  return 'auto'
}

export function talentRankCoverage(id: string, rank: number): Coverage {
  if (sc(`${id}:${rank}`)) return sc(`${id}:${rank}`)!
  const r = Lancer.talents.get(id)?.ranks[rank - 1]
  if (!r) return 'manual'
  if (r.actions?.length || (r as any).active_effects?.length || r.synergies?.length) return 'manual'
  return r.bonuses?.length || r.integrated?.length ? 'auto' : 'manual'
}

export function coreBonusCoverage(id: string): Coverage {
  if (sc(id)) return sc(id)!
  const c = Lancer.coreBonuses.get(id)
  if (!c) return 'manual'
  return c.bonuses?.length && !c.actions?.length ? 'auto' : 'manual'
}

export function frameCoverage(id: string): { traits: Coverage; core: Coverage } {
  const f = Lancer.frames.get(id)
  if (!f) return { traits: 'manual', core: 'manual' }
  const traits: Coverage = sc(`frame:${id}`) ?? (f.traits.every(t => t.bonuses?.length && !t.actions?.length && !(t as any).active_effects?.length) ? 'auto' : 'manual')
  const cs = f.core_system
  const core: Coverage = sc(`core:${id}`) ?? (cs.active_bonuses?.length && !cs.active_actions?.length && !cs.deployables?.length && !cs.passive_effect ? 'auto' : 'manual')
  return { traits, core }
}

export function modCoverage(id: string): Coverage {
  if (sc(id)) return sc(id)!
  const m = Lancer.mods.get(id)
  if (!m) return 'manual'
  return (m.added_tags?.length || m.added_range?.length || m.added_damage?.length) && !/when|on a hit|1\/round|as a/i.test(m.effect ?? '') ? 'auto' : 'manual'
}

/** Per-unit summary used by the hangar. */
export function classify(u: Unit): { manual: string[]; scripted: string[]; auto: string[]; partial: string[] } {
  const out = { manual: [] as string[], scripted: [] as string[], auto: [] as string[], partial: [] as string[] }
  const add = (name: string, c: Coverage) => out[c].push(name)
  if (u.frameId) {
    const f = Lancer.frames.get(u.frameId)
    const fc = frameCoverage(u.frameId)
    add(`${f?.name} traits`, fc.traits)
    add(`${f?.name} core`, fc.core)
  }
  for (const w of u.weapons) if (w.dataId && !w.dataId.startsWith('npc_')) add(w.name, weaponCoverage(w.dataId))
  for (const w of u.weapons) if (w.modId) add(w.modId, modCoverage(w.modId))
  for (const s of u.systems) if (!s.feature) add(s.name, systemCoverage(s.dataId))
  for (const t of u.talents) for (let r = 1; r <= t.rank; r++) add(`${Lancer.talents.get(t.id)?.name} ${r}`, talentRankCoverage(t.id, r))
  for (const c of u.coreBonuses) add(Lancer.coreBonuses.get(c)?.name ?? c, coreBonusCoverage(c))
  return out
}
