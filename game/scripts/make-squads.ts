// Generates the themed pre-built squads (src/data/squads/themed.json): 4 themes × 4 pilots × LL0/LL5/LL10.
// Each pilot is specified by frame, licenses, talents, mech skills and core bonuses per level; the gear is
// then picked automatically from what those licenses allow, scored by the squad's theme, and every build
// is checked with validateBuild (legal, nothing left unspent). Usage: npx tsx scripts/make-squads.ts
import { writeFileSync } from 'node:fs'
import { Lancer, type WeaponData, type SystemData } from '../src/data/lancer'
import type { PilotBuild } from '../src/import/compcon'
import { validateBuild } from '../src/rules/legality'
import { mechSP } from '../src/rules/stats'
import { newDraft, setFrame, weaponOptions, systemOptions, setWeapon, syncMounts, EVEREST } from '../src/ui/builder'

type Theme = 'brawl' | 'long' | 'ghost' | 'drone'
type Hase = [number, number, number, number]
interface PilotSpec {
  callsign: string
  name: string
  frame: string
  /** Second, third... licenses after the frame's own (frame license is always first). */
  extra: string[]
  talents: string[]
  hase: Record<0 | 5 | 10, Hase>
  cbs: Record<5 | 10, string[]>
  /** Weapons/systems this pilot favours: strongly at LL0 (where everyone has the same GMS list), lightly after. */
  prefer?: string[]
  /** Items never to pick for this pilot. */
  avoid?: string[]
}
interface SquadSpec { id: string; name: string; theme: Theme; blurb: string; pilots: PilotSpec[] }

const text = (x: { effect?: string; description?: string }) => `${x.effect ?? ''} ${(x as any).description ?? ''}`.toLowerCase()
const maxRange = (w: WeaponData) => Math.max(0, ...((w.range ?? []) as any[]).map(r => (r.type === 'Range' || r.type === 'Line' || r.type === 'Cone' ? r.val : r.val * 0.5) ?? 0))
const hasTag = (x: { tags?: { id: string }[] }, t: string) => !!x.tags?.some(g => g.id === t)

function weaponScore(theme: Theme, w: WeaponData, spec: PilotSpec, frameLic: string, p: PilotBuild): number {
  if (spec.avoid?.includes(w.id)) return -100
  let s = (w.license_level ?? 0) * 0.6 + (w.license_id === frameLic ? 2 : 0)
  if (spec.prefer?.includes(w.id)) s += p.level === 0 ? 30 : 1
  s -= 8 * p.mech.mounts.flatMap(m => m.slots).filter(x => x.weaponId === w.id).length
  if (w.no_attack) s -= 4
  if (w.mount === 'Superheavy') return -100
  const r = maxRange(w)
  if (theme === 'brawl') s += w.type === 'Melee' ? 10 : w.type === 'CQB' ? 6 : r <= 5 ? 2 : 0
  if (theme === 'long') s += w.type === 'Melee' ? -8 : Math.min(r, 20) * 0.6 + (['Rifle', 'Cannon', 'Launcher'].includes(w.type) ? 3 : 0)
  if (theme === 'ghost') s += w.type === 'Nexus' ? 6 : w.type === 'CQB' ? 4 : w.type === 'Rifle' ? 3 : w.type === 'Melee' ? 2 : 0
  if (theme === 'drone') s += w.type === 'Nexus' ? 10 : w.type === 'Launcher' ? 3 : 1
  return s
}

function systemScore(theme: Theme, x: SystemData, spec: PilotSpec, frameLic: string, p: PilotBuild): number {
  if (spec.avoid?.includes(x.id)) return -100
  const t = text(x)
  let s = ((x as any).license_level ?? 0) * 0.5 + ((x as any).license_id === frameLic ? 3 : 0)
  if (spec.prefer?.includes(x.id)) s += p.level === 0 ? 30 : 1
  if (['ms_personalizations', 'ms_custom_paint_job', 'ms_eva_module', 'ms_expanded_compartment'].includes(x.id)) s -= 6
  if (x.type === 'Flight System') s -= 2
  if (theme === 'brawl') s += (/resistance|armor|shield|structure|grapple|knockback|melee/.test(t) ? 4 : 0) + (x.type === 'Tech' ? -2 : 0)
  if (theme === 'long') s += (/lock on|range|line of sight|accuracy|sensor/.test(t) ? 4 : 0) + (x.type === 'Tech' ? -1 : 0)
  if (theme === 'ghost') s += (x.type === 'Tech' ? 8 : 0) + (/invisible|hidden|stealth|teleport/.test(t) ? 6 : 0)
  if (theme === 'drone') s += (x.type === 'Drone' ? 9 : 0) + (x.type === 'Deployable' ? 4 : 0) + (/drone/.test(t) ? 3 : 0)
  return s
}

const TALENT_RANKS: Record<0 | 5 | 10, number[]> = { 0: [1, 1, 1], 5: [3, 2, 2, 1], 10: [3, 3, 3, 2, 2] }
const LICENSE_RANKS: Record<5 | 10, number[]> = { 5: [3, 2], 10: [3, 3, 3, 1] }

function build(squad: SquadSpec, spec: PilotSpec, level: 0 | 5 | 10, idx: number): PilotBuild {
  const p = newDraft(level)
  p.id = `sq-${squad.id}-${idx + 1}-ll${level}`
  p.callsign = spec.callsign
  p.name = spec.name
  p.mechSkills = [...spec.hase[level]]
  p.talents = spec.talents.slice(0, TALENT_RANKS[level].length).map((id, i) => ({ id, rank: TALENT_RANKS[level][i] }))
  const frame = level === 0 ? EVEREST : spec.frame
  if (level) {
    const lics = [spec.frame, ...spec.extra]
    p.licenses = LICENSE_RANKS[level].map((rank, i) => ({ id: lics[i], rank }))
    p.coreBonuses = [...spec.cbs[level]]
  }
  setFrame(p, frame)
  syncMounts(p)
  p.mech.name = `${spec.callsign}'s ${Lancer.frames.get(frame)!.name}`
  // weapons: best per slot (a Flex mount takes a Main or two Auxiliaries)
  p.mech.mounts.forEach((m, mi) => {
    for (let si = 0; si < m.slots.length; si++) {
      const opts = weaponOptions(p, mi, si).sort((a, b) => weaponScore(squad.theme, b, spec, frame, p) - weaponScore(squad.theme, a, spec, frame, p))
      const best = opts[0]
      if (!best || weaponScore(squad.theme, best, spec, frame, p) <= -50) continue
      // in a Flex mount, two good Auxiliaries can beat one Main; keep it simple: take the best, and if it's a Main the second slot clears
      setWeapon(p, mi, si, best.id)
      if (m.type === 'Flex' && best.mount !== 'Auxiliary') break
    }
  })
  // systems: greedy by score within the SP budget; at most one AI
  const tried = new Set<string>()
  for (;;) {
    const opts = systemOptions(p).filter(x => !tried.has(x.id) && !(p.mech.systems.includes(x.id) && !hasTag(x, 'tg_unique') && true))
      .filter(x => !(hasTag(x, 'tg_ai') && p.mech.systems.some(id => hasTag(Lancer.systems.get(id)!, 'tg_ai'))))
      .sort((a, b) => systemScore(squad.theme, b, spec, frame, p) - systemScore(squad.theme, a, spec, frame, p))
    const x = opts[0]
    if (!x || systemScore(squad.theme, x, spec, frame, p) <= -50) break
    tried.add(x.id)
    p.mech.systems.push(x.id)
    const sp = mechSP(p)
    if (sp.used > sp.max) p.mech.systems.pop()
  }
  return p
}

const H = (h: number, a: number, s: number, e: number): Hase => [h, a, s, e]

const SQUADS: SquadSpec[] = [
  {
    id: 'brawlers', name: 'Brawlers', theme: 'brawl', blurb: 'Close the distance and hit hard: melee and shotguns, heavy armour.',
    pilots: [
      { callsign: 'Anvil', prefer: ['mw_heavy_melee_weapon', 'mw_shotgun', 'ms_stable_structure'], name: 'Teodor Brask', frame: 'mf_blackbeard', extra: ['mf_drake', 'mf_vlad', 'mf_tortuga'], talents: ['t_brawler', 't_juggernaut', 't_vanguard', 't_brutal', 't_executioner'],
        hase: { 0: H(1, 0, 0, 1), 5: H(3, 1, 0, 3), 10: H(5, 2, 1, 4) }, cbs: { 5: ['cb_reinforced_frame'], 10: ['cb_reinforced_frame', 'cb_sloped_plating', 'cb_overpower_caliber'] } },
      { callsign: 'Gaff', prefer: ['mw_charged_blade', 'mw_tactical_knife', 'mw_pistol', 'ms_rapid_burst_jump_jet_system'], name: 'Ines Maro', frame: 'mf_vlad', extra: ['mf_blackbeard', 'mf_lancaster', 'mf_nelson'], talents: ['t_duelist', 't_hunter', 't_brawler', 't_skirmisher', 't_juggernaut'],
        hase: { 0: H(1, 1, 0, 0), 5: H(3, 3, 0, 1), 10: H(4, 5, 1, 2) }, cbs: { 5: ['cb_sloped_plating'], 10: ['cb_sloped_plating', 'cb_reinforced_frame', 'cb_auto_stabilizing_hardpoints'] } },
      { callsign: 'Cinder', prefer: ['mw_thermal_lance', 'mw_thermal_pistol', 'mw_thermal_rifle', 'ms_pattern_a_smoke_charges'], name: 'Ruth Okafor', frame: 'mf_genghis', extra: ['mf_barbarossa', 'mf_sherman', 'mf_tokugawa'], talents: ['t_heavy_gunner', 't_walking_armory', 't_brutal', 't_juggernaut', 't_vanguard'],
        hase: { 0: H(1, 0, 0, 1), 5: H(3, 0, 1, 3), 10: H(4, 1, 2, 5) }, cbs: { 5: ['cb_heatfall_coolant_system'], 10: ['cb_heatfall_coolant_system', 'cb_adaptive_reactor', 'cb_improved_armament'] } },
      { callsign: 'Bulwark', prefer: ['mw_heavy_machine_gun', 'mw_tactical_melee_weapon', 'ms_pattern_a_jericho_deployable_cover', 'ms_type_3_projected_shield'], name: 'Sefa Lindqvist', frame: 'mf_tortuga', extra: ['mf_lancaster', 'mf_drake', 'mf_raleigh'], talents: ['t_vanguard', 't_juggernaut', 't_combined_arms', 't_leader', 't_brawler'],
        hase: { 0: H(1, 0, 0, 1), 5: H(4, 0, 1, 2), 10: H(6, 1, 2, 3) }, cbs: { 5: ['cb_titanomachy_mesh'], 10: ['cb_titanomachy_mesh', 'cb_gyges_frame', 'cb_improved_armament'] } },
    ],
  },
  {
    id: 'longguns', name: 'Long Guns', theme: 'long', blurb: 'Hold the back line: rifles, cannons and missiles at long range.',
    pilots: [
      { callsign: 'Plumb', prefer: ['mw_anti_materiel_rifle', 'mw_assault_rifle', 'ms_manipulators'], name: 'Aster Vey', frame: 'mf_deaths_head', extra: ['mf_monarch', 'mf_swallowtail', 'mf_mourning_cloak'], talents: ['t_crack_shot', 't_spotter', 't_ace', 't_gunslinger', 't_tactician'],
        hase: { 0: H(0, 1, 1, 0), 5: H(1, 3, 2, 1), 10: H(2, 4, 4, 2) }, cbs: { 5: ['cb_neurolink_targeting'], 10: ['cb_neurolink_targeting', 'cb_all_theater_movement_suite', 'cb_auto_stabilizing_hardpoints'] } },
      { callsign: 'Thresh', prefer: ['mw_howitzer', 'mw_mortar', 'ms_stable_structure'], name: 'Corin Hale', frame: 'mf_sherman', extra: ['mf_barbarossa', 'mf_napoleon', 'mf_saladin'], talents: ['t_heavy_gunner', 't_siege_specialist', 't_spotter', 't_crack_shot', 't_engineer'],
        hase: { 0: H(1, 0, 0, 1), 5: H(2, 0, 2, 3), 10: H(3, 1, 3, 5) }, cbs: { 5: ['cb_adaptive_reactor'], 10: ['cb_adaptive_reactor', 'cb_heatfall_coolant_system', 'cb_overpower_caliber'] } },
      { callsign: 'Salvo', prefer: ['mw_missile_rack', 'mw_rocket_propelled_grenade', 'mw_assault_rifle', 'ms_turret_drones'], name: 'Mira Duenas', frame: 'mf_monarch', extra: ['mf_deaths_head', 'mf_metalmark', 'mf_white_witch'], talents: ['t_siege_specialist', 't_combined_arms', 't_spotter', 't_tactician', 't_crack_shot'],
        hase: { 0: H(0, 1, 1, 0), 5: H(2, 2, 2, 1), 10: H(3, 3, 3, 3) }, cbs: { 5: ['cb_neurolink_targeting'], 10: ['cb_neurolink_targeting', 'cb_integrated_nerveweave', 'cb_improved_armament'] } },
      { callsign: 'Longwatch', prefer: ['mw_heavy_machine_gun', 'mw_thermal_rifle', 'ms_pattern_a_jericho_deployable_cover'], name: 'Pell Ansari', frame: 'mf_barbarossa', extra: ['mf_sherman', 'mf_iskander', 'mf_genghis'], talents: ['t_heavy_gunner', 't_walking_armory', 't_siege_specialist', 't_spotter', 't_juggernaut'],
        hase: { 0: H(1, 0, 0, 1), 5: H(3, 0, 1, 3), 10: H(5, 0, 2, 5) }, cbs: { 5: ['cb_armory_sculpted_chassis'], 10: ['cb_armory_sculpted_chassis', 'cb_superior_by_design', 'cb_overpower_caliber'] } },
    ],
  },
  {
    id: 'ghosts', name: 'Ghosts', theme: 'ghost', blurb: 'Tech and stealth: invasions, invisibility and slipping through the lines.',
    pilots: [
      { callsign: 'Wisp', prefer: ['mw_tactical_knife', 'mw_charged_blade', 'ms_pattern_a_smoke_charges', 'ms_rapid_burst_jump_jet_system'], name: 'Noor Calloway', frame: 'mf_mourning_cloak', extra: ['mf_swallowtail', 'mf_dusk_wing', 'mf_black_witch'], talents: ['t_infiltrator', 't_skirmisher', 't_duelist', 't_ace', 't_hunter'],
        hase: { 0: H(0, 1, 1, 0), 5: H(1, 3, 2, 1), 10: H(1, 5, 4, 2) }, cbs: { 5: ['cb_ghostweave'], 10: ['cb_ghostweave', 'cb_all_theater_movement_suite', 'cb_auto_stabilizing_hardpoints'] } },
      { callsign: 'Glitch', prefer: ['mw_nexus_light', 'mw_pistol', 'ms_pattern_b_hex_charges'], name: 'Oren Sato', frame: 'mf_goblin', extra: ['mf_minotaur', 'mf_hydra', 'mf_manticore'], talents: ['t_hacker', 't_technophile', 't_tactician', 't_infiltrator', 't_skirmisher'],
        hase: { 0: H(0, 0, 2, 0), 5: H(0, 2, 4, 1), 10: H(1, 3, 6, 2) }, cbs: { 5: ['cb_the_lesson_of_the_open_door'], 10: ['cb_the_lesson_of_the_open_door', 'cb_the_lesson_of_disbelief', 'cb_integrated_weapon'] } },
      { callsign: 'Snare', prefer: ['mw_nexus_hunter_killer', 'mw_segment_knife', 'ms_pattern_a_smoke_charges'], name: 'Ilse Varga', frame: 'mf_minotaur', extra: ['mf_goblin', 'mf_balor', 'mf_gorgon'], talents: ['t_hacker', 't_tactician', 't_technophile', 't_leader', 't_infiltrator'],
        hase: { 0: H(0, 0, 1, 1), 5: H(1, 1, 3, 2), 10: H(2, 2, 5, 3) }, cbs: { 5: ['cb_the_lesson_of_disbelief'], 10: ['cb_the_lesson_of_disbelief', 'cb_the_lesson_of_the_held_image', 'cb_improved_armament'] } },
      { callsign: 'Shade', prefer: ['mw_assault_rifle', 'mw_pistol', 'ms_rapid_burst_jump_jet_system'], name: 'Juno Reyes', frame: 'mf_swallowtail', extra: ['mf_mourning_cloak', 'mf_white_witch', 'mf_dusk_wing'], talents: ['t_infiltrator', 't_spotter', 't_skirmisher', 't_hacker', 't_ace'],
        hase: { 0: H(0, 1, 1, 0), 5: H(0, 3, 3, 1), 10: H(1, 5, 4, 2) }, cbs: { 5: ['cb_all_theater_movement_suite'], 10: ['cb_all_theater_movement_suite', 'cb_ghostweave', 'cb_universal_compatibility'] } },
    ],
  },
  {
    id: 'dronewing', name: 'Drone Wing', theme: 'drone', blurb: 'Fight by proxy: drones, turrets, nexuses and deployables.',
    pilots: [
      { callsign: 'Hive', prefer: ['ms_turret_drones', 'mw_nexus_hunter_killer', 'mw_nexus_light'], name: 'Ada Kestrel', frame: 'mf_hydra', extra: ['mf_goblin', 'mf_pegasus', 'mf_manticore'], talents: ['t_drone_commander', 't_technophile', 't_tactician', 't_engineer', 't_leader'],
        hase: { 0: H(0, 0, 1, 1), 5: H(1, 1, 3, 2), 10: H(2, 2, 5, 3) }, cbs: { 5: ['cb_the_lesson_of_shaping'], 10: ['cb_the_lesson_of_shaping', 'cb_the_lesson_of_thinking_tomorrows_thought', 'cb_improved_armament'] } },
      { callsign: 'Minefield', prefer: ['ms_pattern_b_hex_charges', 'mw_mortar', 'mw_heavy_machine_gun'], name: 'Bram Okoye', frame: 'mf_iskander', extra: ['mf_saladin', 'mf_tokugawa', 'mf_sherman'], talents: ['t_engineer', 't_drone_commander', 't_grease_monkey', 't_siege_specialist', 't_tactician'],
        hase: { 0: H(1, 0, 0, 1), 5: H(2, 0, 2, 3), 10: H(3, 1, 3, 5) }, cbs: { 5: ['cb_superior_by_design'], 10: ['cb_superior_by_design', 'cb_stasis_shielding', 'cb_improved_armament'] } },
      { callsign: 'Aegis', prefer: ['ms_type_3_projected_shield', 'ms_turret_drones', 'mw_nexus_light', 'mw_assault_rifle'], name: 'Lena Fairweather', frame: 'mf_saladin', extra: ['mf_iskander', 'mf_napoleon', 'mf_genghis'], talents: ['t_drone_commander', 't_leader', 't_engineer', 't_technophile', 't_grease_monkey'],
        hase: { 0: H(1, 0, 0, 1), 5: H(2, 0, 2, 3), 10: H(4, 0, 3, 5) }, cbs: { 5: ['cb_stasis_shielding'], 10: ['cb_stasis_shielding', 'cb_superior_by_design', 'cb_integrated_weapon'] } },
      { callsign: 'Swarm', prefer: ['mw_nexus_light', 'mw_missile_rack', 'ms_turret_drones', 'mw_rocket_propelled_grenade'], name: 'Tobiah Quint', frame: 'mf_pegasus', extra: ['mf_hydra', 'mf_balor', 'mf_goblin'], talents: ['t_drone_commander', 't_combined_arms', 't_technophile', 't_tactician', 't_engineer'],
        hase: { 0: H(0, 1, 1, 0), 5: H(1, 2, 3, 1), 10: H(2, 3, 5, 2) }, cbs: { 5: ['cb_the_lesson_of_the_held_image'], 10: ['cb_the_lesson_of_the_held_image', 'cb_the_lesson_of_shaping', 'cb_auto_stabilizing_hardpoints'] } },
    ],
  },
]

let bad = 0
const out: { id: string; name: string; theme: string; blurb: string; level: number; pilots: PilotBuild[] }[] = []
for (const sq of SQUADS) for (const level of [0, 5, 10] as const) {
  const pilots = sq.pilots.map((spec, i) => build(sq, spec, level, i))
  for (const p of pilots) {
    const v = validateBuild(p)
    const sp = mechSP(p)
    const problems = [...v.errors, ...v.warnings]
    if (problems.length) { bad++; console.log(`✗ ${sq.name} LL${level} ${p.callsign}: ${problems.join('; ')}`) }
    const ws = p.mech.mounts.flatMap(m => m.slots.map(s => s.weaponId && Lancer.weapons.get(s.weaponId)?.name)).filter(Boolean)
    const ss = p.mech.systems.map(id => Lancer.systems.get(id)?.name)
    if (process.argv.includes('-v')) console.log(`${sq.name} LL${level} ${p.callsign} [${Lancer.frames.get(p.mech.frameId)?.name}] SP ${sp.used}/${sp.max}\n   W: ${ws.join(', ')}\n   S: ${ss.join(', ')}`)
  }
  out.push({ id: `${sq.id}-ll${level}`, name: sq.name, theme: sq.id, blurb: sq.blurb, level, pilots })
}
if (bad) { console.error(`${bad} build(s) not legal and fully spent — not written`); process.exit(1) }
writeFileSync(new URL('../src/data/squads/themed.json', import.meta.url), JSON.stringify(out, null, 1) + '\n')
console.log(`wrote ${out.length} squads (${out.reduce((a, s) => a + s.pilots.length, 0)} pilots)`)
