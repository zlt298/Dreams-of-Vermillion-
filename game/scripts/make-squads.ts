// Generates the themed pre-built squads (src/data/squads/themed.json): 3 themes × 4 pilots × LL2/LL5/LL8,
// the License Levels of acts 1-3. Each pilot is specified by frame, licenses, talents, mech skills and core
// bonuses per level. The LL2 build is picked automatically from what those licenses allow, scored by the
// squad's theme; each later level carries the previous level's build forward (same frame, same weapons,
// systems and talents) and only spends the new points: empty slots and spare SP are filled, and at most one
// weapon and one system are swapped for gear the new licenses unlock. So a pilot stays recognizable from act
// to act. Every build is checked with validateBuild (legal, nothing left unspent).
// Usage: npx tsx scripts/make-squads.ts [-v]
import { writeFileSync } from 'node:fs'
import { Lancer, type WeaponData, type SystemData } from '../src/data/lancer'
import type { PilotBuild } from '../src/import/compcon'
import { validateBuild, effectiveLicenses, licensed } from '../src/rules/legality'
import { mechSP } from '../src/rules/stats'
import { averageDice } from '../src/rules/rng'
import { newDraft, setFrame, weaponOptions, systemOptions, setWeapon, syncMounts } from '../src/ui/builder'

/** The act levels (run.ts ACT_LEVEL). */
const LEVELS = [2, 5, 8] as const
type Level = (typeof LEVELS)[number]

type Theme = 'brawl' | 'long' | 'ghost' | 'drone' // 'ghost' scoring kept for a future stealth squad
type Hase = [number, number, number, number]
interface PilotSpec {
  callsign: string
  name: string
  frame: string
  /** Second, third... licenses after the frame's own (frame license is always first). */
  extra: string[]
  talents: string[]
  /** Mech skills per level; each level must be at least the previous one in every skill. */
  hase: Record<Level, Hase>
  /** Core bonuses (one every 3 LL: none at LL2); LL8 keeps LL5's. */
  cbs: Record<5 | 8, string[]>
  /** Weapons/systems this pilot favours. */
  prefer?: string[]
  /** Items never to pick for this pilot. */
  avoid?: string[]
}
/** How hard the squad plays at one act level, ranked by mechs lost per fight against every enemy team at that
 *  act (AI vs AI). The order differs by act, so each level has its own label. Re-check with the balance sim
 *  after changing a squad or the enemy rosters. A Ghosts (tech/stealth) squad was removed: even with a
 *  Striker/Defender/Controller/Artillery lineup it won ~36% of elite/boss-heavy fights against ~69% for the others. */
export type Difficulty = 'Easy' | 'Medium' | 'Hard'
interface SquadSpec { id: string; name: string; theme: Theme; difficulty: Record<Level, Difficulty>; blurb: string; pilots: PilotSpec[] }

const text = (x: { effect?: string; description?: string }) => `${x.effect ?? ''} ${(x as any).description ?? ''}`.toLowerCase()
const maxRange = (w: WeaponData) => Math.max(0, ...((w.range ?? []) as any[]).map(r => (r.type === 'Range' || r.type === 'Line' || r.type === 'Cone' ? r.val : r.val * 0.5) ?? 0))
/** Average damage of a weapon's first profile (0 for no-attack weapons). */
const avgDamage = (w: WeaponData) => ((((w as any).damage ?? (w as any).profiles?.[0]?.damage) ?? []) as { val: string | number }[]).reduce((a, d) => a + averageDice(d.val as any), 0)
const hasTag = (x: { tags?: { id: string }[] }, t: string) => !!x.tags?.some(g => g.id === t)

function weaponScore(theme: Theme, w: WeaponData, spec: PilotSpec, frameLic: string, p: PilotBuild): number {
  if (spec.avoid?.includes(w.id)) return -100
  let s = (w.license_level ?? 0) * 0.6 + (w.license_id === frameLic ? 2 : 0)
  if (spec.prefer?.includes(w.id)) s += 1
  s -= 8 * p.mech.mounts.flatMap(m => m.slots).filter(x => x.weaponId === w.id).length
  if (w.no_attack) s -= 4
  if (w.mount === 'Superheavy') return -100
  const r = maxRange(w)
  if (theme === 'brawl') s += w.type === 'Melee' ? 10 : w.type === 'CQB' ? 6 : r <= 5 ? 2 : 0
  if (theme === 'long') s += w.type === 'Melee' ? -8 : Math.min(r, 20) * 0.6 + (['Rifle', 'Cannon', 'Launcher'].includes(w.type) ? 3 : 0)
  // ghosts: favour light, quiet weapons, but weigh damage too, or every mount fills with 2-damage Nexus/Pistols
  if (theme === 'ghost') s += (w.type === 'Nexus' ? 6 : w.type === 'CQB' ? 4 : w.type === 'Rifle' ? 3 : w.type === 'Melee' ? 2 : 0) + avgDamage(w) * 1.5
  if (theme === 'drone') s += w.type === 'Nexus' ? 10 : w.type === 'Launcher' ? 3 : 1
  return s
}

function systemScore(theme: Theme, x: SystemData, spec: PilotSpec, frameLic: string): number {
  if (spec.avoid?.includes(x.id)) return -100
  const t = text(x)
  let s = ((x as any).license_level ?? 0) * 0.5 + ((x as any).license_id === frameLic ? 3 : 0)
  if (spec.prefer?.includes(x.id)) s += 1
  if (['ms_personalizations', 'ms_custom_paint_job', 'ms_eva_module', 'ms_expanded_compartment'].includes(x.id)) s -= 6
  if (x.type === 'Flight System') s -= 2
  if (theme === 'brawl') s += (/resistance|armor|shield|structure|grapple|knockback|melee/.test(t) ? 4 : 0) + (x.type === 'Tech' ? -2 : 0)
  if (theme === 'long') s += (/lock on|range|line of sight|accuracy|sensor/.test(t) ? 4 : 0) + (x.type === 'Tech' ? -1 : 0)
  if (theme === 'ghost') s += (x.type === 'Tech' ? 8 : 0) + (/invisible|hidden|stealth|teleport/.test(t) ? 6 : 0)
  if (theme === 'drone') s += (x.type === 'Drone' ? 9 : 0) + (x.type === 'Deployable' ? 4 : 0) + (/drone/.test(t) ? 3 : 0)
  return s
}

/** LANCER progression: at LL n, 3+n talent ranks, n license ranks (max rank 3), 2+n mech skill points.
 *  Each level only raises ranks or adds a talent/license, so a build carries forward. */
const TALENT_RANKS: Record<Level, number[]> = { 2: [2, 2, 1], 5: [3, 2, 2, 1], 8: [3, 3, 3, 2] }
const LICENSE_RANKS: Record<Level, number[]> = { 2: [2], 5: [3, 2], 8: [3, 3, 2] }
/** A weapon or system is only swapped out on a level-up for one that scores at least this much better. */
const UPGRADE_GAIN = 2

/** Is slot `si` of mount `mi` usable (the second slot of a Flex mount holding a Main weapon is not)? */
const slotOpen = (p: PilotBuild, mi: number, si: number) => {
  const m = p.mech.mounts[mi]
  if (m.type !== 'Flex' || si === 0) return true
  const first = m.slots[0]?.weaponId
  return !first || Lancer.weapons.get(first)?.mount === 'Auxiliary'
}

/**
 * Build `spec` at `level`. With `prev` (the same pilot one act earlier), its build is carried forward: the
 * frame, weapons, systems and talents stay, and only the new points are spent.
 */
function build(squad: SquadSpec, spec: PilotSpec, level: Level, idx: number, prev?: PilotBuild): PilotBuild {
  const p: PilotBuild = prev ? structuredClone(prev) : newDraft(level)
  const prevLic = prev ? effectiveLicenses(prev) : new Map<string, number>()
  p.level = level
  p.id = `sq-${squad.id}-${idx + 1}-ll${level}`
  p.callsign = spec.callsign
  p.name = spec.name
  p.mechSkills = [...spec.hase[level]]
  p.talents = spec.talents.slice(0, TALENT_RANKS[level].length).map((id, i) => ({ id, rank: TALENT_RANKS[level][i] }))
  const lics = [spec.frame, ...spec.extra]
  p.licenses = LICENSE_RANKS[level].map((rank, i) => ({ id: lics[i], rank }))
  p.coreBonuses = level === 2 ? [] : [...spec.cbs[level]]
  if (!prev) {
    setFrame(p, spec.frame)
    p.mech.name = `${spec.callsign}'s ${Lancer.frames.get(spec.frame)!.name}`
  }
  syncMounts(p)
  const frame = spec.frame
  const wScore = (w: WeaponData) => weaponScore(squad.theme, w, spec, frame, p)
  const sScore = (x: SystemData) => systemScore(squad.theme, x, spec, frame)

  // weapons: fill every empty slot with the best option (a Flex mount takes a Main or two Auxiliaries)
  p.mech.mounts.forEach((m, mi) => {
    for (let si = 0; si < m.slots.length; si++) {
      if (m.slots[si].weaponId || !slotOpen(p, mi, si)) continue
      const best = weaponOptions(p, mi, si).sort((a, b) => wScore(b) - wScore(a))[0]
      if (!best || wScore(best) <= -50) continue
      setWeapon(p, mi, si, best.id)
    }
  })
  // a level-up may swap one weapon for a newly licensed one of the same size, if it is clearly better
  if (prev) {
    let swap: { mi: number; si: number; id: string; gain: number } | null = null
    p.mech.mounts.forEach((m, mi) => m.slots.forEach((s, si) => {
      if (!s.weaponId) return
      const old = Lancer.weapons.get(s.weaponId)!
      const keep = s.weaponId
      s.weaponId = null // score without the weapon itself counting as a duplicate
      const oldScore = wScore(old)
      for (const w of weaponOptions(p, mi, si)) {
        if (w.mount !== old.mount || licensed(w, prevLic)) continue
        const gain = wScore(w) - oldScore
        if (gain >= UPGRADE_GAIN && (!swap || gain > swap.gain)) swap = { mi, si, id: w.id, gain }
      }
      s.weaponId = keep
    }))
    if (swap) { const { mi, si, id } = swap; setWeapon(p, mi, si, id) }
  }

  // systems: a level-up may first swap the weakest system for a clearly better newly licensed one
  if (prev && p.mech.systems.length) {
    const worst = [...p.mech.systems].sort((a, b) => sScore(Lancer.systems.get(a)!) - sScore(Lancer.systems.get(b)!))[0]
    const without = p.mech.systems.filter(id => id !== worst)
    const cands = systemOptions(p).filter(x => !p.mech.systems.includes(x.id) && !licensed(x, prevLic))
      .filter(x => !(hasTag(x, 'tg_ai') && without.some(id => hasTag(Lancer.systems.get(id)!, 'tg_ai'))))
      .sort((a, b) => sScore(b) - sScore(a))
    for (const x of cands) {
      if (sScore(x) - sScore(Lancer.systems.get(worst)!) < UPGRADE_GAIN) break
      const before = p.mech.systems
      p.mech.systems = [...without, x.id]
      if (mechSP(p).used <= mechSP(p).max) break
      p.mech.systems = before
    }
  }
  // then greedy by score within the SP budget; at most one AI
  const tried = new Set<string>()
  for (;;) {
    const opts = systemOptions(p).filter(x => !tried.has(x.id) && !p.mech.systems.includes(x.id))
      .filter(x => !(hasTag(x, 'tg_ai') && p.mech.systems.some(id => hasTag(Lancer.systems.get(id)!, 'tg_ai'))))
      .sort((a, b) => sScore(b) - sScore(a))
    const x = opts[0]
    if (!x || sScore(x) <= -50) break
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
    // provisional until re-simulated: act 1 (LL2) keeps the old LL0 label, act 3 (LL8) the old LL10 one
    id: 'brawlers', name: 'Brawlers', theme: 'brawl', difficulty: { 2: 'Medium', 5: 'Medium', 8: 'Easy' }, blurb: 'Close the distance and hit hard: melee and shotguns, heavy armour.',
    pilots: [
      { callsign: 'Anvil', prefer: ['mw_heavy_melee_weapon', 'mw_shotgun', 'ms_stable_structure'], name: 'Teodor Brask', frame: 'mf_blackbeard', extra: ['mf_drake', 'mf_vlad', 'mf_tortuga'], talents: ['t_brawler', 't_juggernaut', 't_vanguard', 't_brutal', 't_executioner'],
        hase: { 2: H(2, 0, 0, 2), 5: H(3, 1, 0, 3), 8: H(4, 2, 0, 4) }, cbs: { 5: ['cb_reinforced_frame'], 8: ['cb_reinforced_frame', 'cb_sloped_plating'] } },
      { callsign: 'Gaff', prefer: ['mw_charged_blade', 'mw_tactical_knife', 'mw_pistol', 'ms_rapid_burst_jump_jet_system'], name: 'Ines Maro', frame: 'mf_vlad', extra: ['mf_blackbeard', 'mf_lancaster', 'mf_nelson'], talents: ['t_duelist', 't_hunter', 't_brawler', 't_skirmisher', 't_juggernaut'],
        hase: { 2: H(2, 2, 0, 0), 5: H(3, 3, 0, 1), 8: H(4, 4, 0, 2) }, cbs: { 5: ['cb_sloped_plating'], 8: ['cb_sloped_plating', 'cb_reinforced_frame'] } },
      { callsign: 'Cinder', prefer: ['mw_thermal_lance', 'mw_thermal_pistol', 'mw_thermal_rifle', 'ms_pattern_a_smoke_charges'], name: 'Ruth Okafor', frame: 'mf_barbarossa', extra: ['mf_genghis', 'mf_sherman', 'mf_tokugawa'], talents: ['t_heavy_gunner', 't_walking_armory', 't_brutal', 't_juggernaut', 't_vanguard'],
        hase: { 2: H(2, 0, 0, 2), 5: H(3, 0, 1, 3), 8: H(4, 0, 2, 4) }, cbs: { 5: ['cb_heatfall_coolant_system'], 8: ['cb_heatfall_coolant_system', 'cb_adaptive_reactor'] } },
      { callsign: 'Bulwark', prefer: ['mw_heavy_machine_gun', 'mw_tactical_melee_weapon', 'ms_pattern_a_jericho_deployable_cover', 'ms_type_3_projected_shield'], name: 'Sefa Lindqvist', frame: 'mf_tortuga', extra: ['mf_lancaster', 'mf_drake', 'mf_raleigh'], talents: ['t_vanguard', 't_juggernaut', 't_combined_arms', 't_leader', 't_brawler'],
        hase: { 2: H(3, 0, 0, 1), 5: H(4, 0, 1, 2), 8: H(5, 1, 1, 3) }, cbs: { 5: ['cb_titanomachy_mesh'], 8: ['cb_titanomachy_mesh', 'cb_gyges_frame'] } },
    ],
  },
  {
    // provisional until re-simulated: act 1 (LL2) keeps the old LL0 label, act 3 (LL8) the old LL10 one
    id: 'longguns', name: 'Long Guns', theme: 'long', difficulty: { 2: 'Easy', 5: 'Hard', 8: 'Hard' }, blurb: 'Hold the back line: rifles, cannons and missiles at long range.',
    pilots: [
      { callsign: 'Plumb', prefer: ['mw_anti_materiel_rifle', 'mw_assault_rifle', 'ms_manipulators'], name: 'Aster Vey', frame: 'mf_metalmark', extra: ['mf_monarch', 'mf_deaths_head', 'mf_swallowtail'], talents: ['t_crack_shot', 't_spotter', 't_ace', 't_gunslinger', 't_tactician'],
        hase: { 2: H(0, 2, 2, 0), 5: H(1, 3, 2, 1), 8: H(2, 4, 3, 1) }, cbs: { 5: ['cb_neurolink_targeting'], 8: ['cb_neurolink_targeting', 'cb_all_theater_movement_suite'] } },
      { callsign: 'Thresh', prefer: ['mw_howitzer', 'mw_mortar', 'ms_stable_structure'], name: 'Corin Hale', frame: 'mf_sherman', extra: ['mf_barbarossa', 'mf_napoleon', 'mf_saladin'], talents: ['t_heavy_gunner', 't_siege_specialist', 't_spotter', 't_crack_shot', 't_engineer'],
        hase: { 2: H(1, 0, 1, 2), 5: H(2, 0, 2, 3), 8: H(3, 0, 3, 4) }, cbs: { 5: ['cb_adaptive_reactor'], 8: ['cb_adaptive_reactor', 'cb_heatfall_coolant_system'] } },
      { callsign: 'Salvo', prefer: ['mw_missile_rack', 'mw_rocket_propelled_grenade', 'mw_assault_rifle', 'ms_turret_drones'], name: 'Mira Duenas', frame: 'mf_monarch', extra: ['mf_deaths_head', 'mf_metalmark', 'mf_black_witch'], talents: ['t_siege_specialist', 't_combined_arms', 't_spotter', 't_tactician', 't_crack_shot'],
        hase: { 2: H(1, 1, 1, 1), 5: H(2, 2, 2, 1), 8: H(3, 3, 2, 2) }, cbs: { 5: ['cb_neurolink_targeting'], 8: ['cb_neurolink_targeting', 'cb_integrated_nerveweave'] } },
      { callsign: 'Longwatch', prefer: ['mw_heavy_machine_gun', 'mw_thermal_rifle', 'ms_pattern_a_jericho_deployable_cover'], name: 'Pell Ansari', frame: 'mf_napoleon', extra: ['mf_barbarossa', 'mf_sherman', 'mf_saladin'], talents: ['t_heavy_gunner', 't_walking_armory', 't_siege_specialist', 't_spotter', 't_juggernaut'],
        hase: { 2: H(2, 0, 0, 2), 5: H(3, 0, 1, 3), 8: H(4, 0, 2, 4) }, cbs: { 5: ['cb_armory_sculpted_chassis'], 8: ['cb_armory_sculpted_chassis', 'cb_superior_by_design'] } },
    ],
  },
  {
    // provisional until re-simulated: act 1 (LL2) keeps the old LL0 label, act 3 (LL8) the old LL10 one
    id: 'dronewing', name: 'Drone Wing', theme: 'drone', difficulty: { 2: 'Hard', 5: 'Easy', 8: 'Medium' }, blurb: 'Fight by proxy: drones, turrets, nexuses and deployables.',
    pilots: [
      { callsign: 'Hive', prefer: ['ms_turret_drones', 'mw_nexus_hunter_killer', 'mw_nexus_light'], name: 'Ada Kestrel', frame: 'mf_hydra', extra: ['mf_goblin', 'mf_pegasus', 'mf_manticore'], talents: ['t_drone_commander', 't_technophile', 't_tactician', 't_engineer', 't_leader'],
        hase: { 2: H(0, 0, 2, 2), 5: H(1, 1, 3, 2), 8: H(2, 1, 4, 3) }, cbs: { 5: ['cb_the_lesson_of_shaping'], 8: ['cb_the_lesson_of_shaping', 'cb_the_lesson_of_thinking_tomorrows_thought'] } },
      { callsign: 'Minefield', prefer: ['ms_pattern_b_hex_charges', 'mw_mortar', 'mw_heavy_machine_gun'], name: 'Bram Okoye', frame: 'mf_iskander', extra: ['mf_saladin', 'mf_tokugawa', 'mf_sherman'], talents: ['t_engineer', 't_drone_commander', 't_grease_monkey', 't_siege_specialist', 't_tactician'],
        hase: { 2: H(1, 0, 1, 2), 5: H(2, 0, 2, 3), 8: H(3, 0, 3, 4) }, cbs: { 5: ['cb_superior_by_design'], 8: ['cb_superior_by_design', 'cb_stasis_shielding'] } },
      { callsign: 'Aegis', prefer: ['ms_type_3_projected_shield', 'ms_turret_drones', 'mw_nexus_light', 'mw_assault_rifle'], name: 'Lena Fairweather', frame: 'mf_saladin', extra: ['mf_iskander', 'mf_napoleon', 'mf_genghis'], talents: ['t_drone_commander', 't_leader', 't_engineer', 't_technophile', 't_grease_monkey'],
        hase: { 2: H(1, 0, 1, 2), 5: H(2, 0, 2, 3), 8: H(3, 0, 3, 4) }, cbs: { 5: ['cb_stasis_shielding'], 8: ['cb_stasis_shielding', 'cb_superior_by_design'] } },
      { callsign: 'Swarm', prefer: ['mw_nexus_light', 'mw_missile_rack', 'ms_turret_drones', 'mw_rocket_propelled_grenade'], name: 'Tobiah Quint', frame: 'mf_pegasus', extra: ['mf_hydra', 'mf_balor', 'mf_goblin'], talents: ['t_drone_commander', 't_combined_arms', 't_technophile', 't_tactician', 't_engineer'],
        hase: { 2: H(0, 1, 2, 1), 5: H(1, 2, 3, 1), 8: H(2, 2, 4, 2) }, cbs: { 5: ['cb_the_lesson_of_the_held_image'], 8: ['cb_the_lesson_of_the_held_image', 'cb_the_lesson_of_shaping'] } },
    ],
  },
]

let bad = 0
const fail = (msg: string) => { bad++; console.log(`✗ ${msg}`) }
const out: { id: string; name: string; theme: string; difficulty: Difficulty; blurb: string; level: number; pilots: PilotBuild[] }[] = []
const describe = (p: PilotBuild) => {
  const ws = p.mech.mounts.flatMap(m => m.slots.map(s => s.weaponId && Lancer.weapons.get(s.weaponId)?.name)).filter(Boolean)
  const ss = p.mech.systems.map(id => Lancer.systems.get(id)?.name)
  const sp = mechSP(p)
  return `[${Lancer.frames.get(p.mech.frameId)?.name}] SP ${sp.used}/${sp.max}\n   W: ${ws.join(', ')}\n   S: ${ss.join(', ')}`
}
for (const sq of SQUADS) {
  let prev: PilotBuild[] = []
  for (const level of LEVELS) {
    const pilots = sq.pilots.map((spec, i) => build(sq, spec, level, i, prev[i]))
    pilots.forEach((p, i) => {
      const v = validateBuild(p)
      const problems = [...v.errors, ...v.warnings]
      if (problems.length) fail(`${sq.name} LL${level} ${p.callsign}: ${problems.join('; ')}`)
      // carried forward: same frame, and every talent rank, license rank and mech skill at least as high
      const was = prev[i]
      if (was) {
        if (was.mech.frameId !== p.mech.frameId) fail(`${p.callsign} LL${level}: frame changed`)
        if (p.mechSkills.some((s, k) => s < was.mechSkills[k])) fail(`${p.callsign} LL${level}: a mech skill went down`)
        if (was.talents.some(t => (p.talents.find(x => x.id === t.id)?.rank ?? 0) < t.rank)) fail(`${p.callsign} LL${level}: a talent rank went down`)
        if (was.coreBonuses.some(c => !p.coreBonuses.includes(c))) fail(`${p.callsign} LL${level}: a core bonus was dropped`)
      }
      if (process.argv.includes('-v')) console.log(`${sq.name} LL${level} ${p.callsign} ${describe(p)}`)
    })
    out.push({ id: `${sq.id}-ll${level}`, name: sq.name, theme: sq.id, difficulty: sq.difficulty[level], blurb: sq.blurb, level, pilots })
    prev = pilots
  }
}
if (bad) { console.error(`${bad} problem(s) — not written`); process.exit(1) }
writeFileSync(new URL('../src/data/squads/themed.json', import.meta.url), JSON.stringify(out, null, 1) + '\n')
console.log(`wrote ${out.length} squads (${out.reduce((a, s) => a + s.pilots.length, 0)} pilots)`)
