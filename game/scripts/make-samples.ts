// Generates the sample squads (src/data/squads/ll2.json, ll5.json, ll8.json) in COMP/CON pilot format: the
// same four pilots (Bastion's Drake, Kestrel's Monarch, Halo's Saladin, Lance's Blackbeard) at the act levels.
// Each level is the previous level's build plus the new points: the frame never changes, talents, licenses and
// mech skills only go up, and a level-up adds gear or swaps at most two pieces for what the new licenses unlock.
// Every build is checked with validateBuild (legal, nothing left unspent). Usage: npx tsx scripts/make-samples.ts [-v]
import { writeFileSync } from 'node:fs'
import { Lancer } from '../src/data/lancer'
import { importPilots, type PilotBuild } from '../src/import/compcon'
import { validateBuild } from '../src/rules/legality'
import { mechSP } from '../src/rules/stats'

const LEVELS = [2, 5, 8] as const
type Level = (typeof LEVELS)[number]
type Hase = [number, number, number, number]

interface LevelSpec {
  hase: Hase
  talents: [string, number][]
  licenses: [string, number][]
  cbs: string[]
  /** Weapons per frame mount, in the frame's mount order (a Flex mount takes one Main or two Auxiliaries). */
  mounts: string[][]
  systems: string[]
}
interface SampleSpec { id: string; callsign: string; name: string; frame: string; levels: Record<Level, LevelSpec> }

// LL5 is the act 2 sample squad exactly as it was under the old LL0/LL5/LL10 act levels (act 2 is still LL5, so
// its balance numbers stay comparable); LL2 is cut back from it and LL8 is built on it.
const SAMPLES: SampleSpec[] = [
  {
    id: 'bastion', callsign: 'Bastion', name: 'Oyelaran Vance', frame: 'mf_drake',
    levels: {
      2: { hase: [2, 0, 0, 2], talents: [['t_heavy_gunner', 2], ['t_vanguard', 2], ['t_combined_arms', 1]], licenses: [['mf_drake', 2]], cbs: [],
        mounts: [['mw_assault_cannon'], ['mw_shotgun'], ['mw_heavy_machine_gun']], systems: ['ms_argonaut_shield', 'ms_aegis_shield_generator', 'ms_personalizations'] },
      // Tortuga 2: the Deck-Sweeper and Daisy Cutter replace the GMS shotgun and machine gun; + Siege Ram
      5: { hase: [3, 0, 1, 3], talents: [['t_heavy_gunner', 3], ['t_vanguard', 3], ['t_combined_arms', 2]], licenses: [['mf_drake', 3], ['mf_tortuga', 2]], cbs: ['cb_reinforced_frame'],
        mounts: [['mw_assault_cannon'], ['mw_deck_sweeper_automatic_shotgun'], ['mw_daisy_cutter']], systems: ['ms_argonaut_shield', 'ms_aegis_shield_generator', 'ms_siege_ram', 'ms_personalizations'] },
      // Drake 3: + Portable Bunker
      8: { hase: [5, 0, 1, 4], talents: [['t_heavy_gunner', 3], ['t_vanguard', 3], ['t_combined_arms', 3], ['t_bonded', 2]], licenses: [['mf_drake', 3], ['mf_tortuga', 3], ['mf_blackbeard', 2]], cbs: ['cb_reinforced_frame', 'cb_sloped_plating'],
        mounts: [['mw_assault_cannon'], ['mw_deck_sweeper_automatic_shotgun'], ['mw_daisy_cutter']], systems: ['ms_argonaut_shield', 'ms_aegis_shield_generator', 'ms_siege_ram', 'ms_personalizations', 'ms_portable_bunker'] },
    },
  },
  {
    id: 'kestrel', callsign: 'Kestrel', name: 'Ilse Marrow', frame: 'mf_monarch',
    levels: {
      2: { hase: [0, 1, 1, 2], talents: [['t_stormbringer', 2], ['t_crack_shot', 2], ['t_spotter', 1]], licenses: [['mf_monarch', 2]], cbs: [],
        mounts: [['mw_sharanga_missiles'], ['mw_assault_rifle'], ['mw_gandiva_missiles']], systems: ['ms_javelin_rockets', 'ms_manipulators', 'ms_pattern_b_hex_charges'] },
      // Death's Head 3: the Vulture DMR replaces the assault rifle; a Tracking Bug and a Kinetic Compensator replace the Manipulators
      5: { hase: [1, 2, 2, 2], talents: [['t_stormbringer', 3], ['t_crack_shot', 3], ['t_spotter', 2]], licenses: [['mf_monarch', 2], ['mf_deaths_head', 3]], cbs: ['cb_neurolink_targeting'],
        mounts: [['mw_sharanga_missiles'], ['mw_vulture_dmr'], ['mw_gandiva_missiles']], systems: ['ms_javelin_rockets', 'ms_tracking_bug', 'ms_kinetic_compensator', 'ms_pattern_b_hex_charges'] },
      // Barbarossa 2: + Autoloader Drone
      8: { hase: [1, 2, 4, 3], talents: [['t_stormbringer', 3], ['t_crack_shot', 3], ['t_spotter', 3], ['t_gunslinger', 2]], licenses: [['mf_monarch', 3], ['mf_deaths_head', 3], ['mf_barbarossa', 2]], cbs: ['cb_neurolink_targeting', 'cb_full_subjectivity_sync'],
        mounts: [['mw_sharanga_missiles'], ['mw_vulture_dmr'], ['mw_gandiva_missiles']], systems: ['ms_javelin_rockets', 'ms_tracking_bug', 'ms_kinetic_compensator', 'ms_pattern_b_hex_charges', 'ms_autoloader_drone'] },
    },
  },
  {
    id: 'warden', callsign: 'Halo', name: 'Tomas Achebe', frame: 'mf_saladin',
    levels: {
      2: { hase: [1, 0, 2, 1], talents: [['t_leader', 2], ['t_grease_monkey', 2], ['t_tactician', 1]], licenses: [['mf_saladin', 2]], cbs: [],
        mounts: [['mw_shatterhead_colony_missiles']], systems: ['ms_enclave_pattern_support_shield', 'ms_flash_anchor', 'ms_turret_drones', 'ms_type_3_projected_shield', 'ms_pattern_a_smoke_charges'] },
      // Lancaster 3: an Aceso Stabilizer and a Restock Drone replace the Turret Drones and the Type-3 Projected Shield
      5: { hase: [2, 0, 3, 2], talents: [['t_leader', 3], ['t_grease_monkey', 3], ['t_tactician', 2]], licenses: [['mf_saladin', 2], ['mf_lancaster', 3]], cbs: ['cb_universal_compatibility'],
        mounts: [['mw_shatterhead_colony_missiles']], systems: ['ms_enclave_pattern_support_shield', 'ms_flash_anchor', 'ms_aceso_stabilizer', 'ms_restock_drone', 'ms_pattern_a_smoke_charges'] },
      // + Hardlight Defense System
      8: { hase: [3, 0, 5, 2], talents: [['t_leader', 3], ['t_grease_monkey', 3], ['t_tactician', 3], ['t_technophile', 2]], licenses: [['mf_saladin', 3], ['mf_lancaster', 3], ['mf_barbarossa', 2]], cbs: ['cb_universal_compatibility', 'cb_superior_by_design'],
        mounts: [['mw_shatterhead_colony_missiles']], systems: ['ms_enclave_pattern_support_shield', 'ms_flash_anchor', 'ms_aceso_stabilizer', 'ms_restock_drone', 'ms_pattern_a_smoke_charges', 'ms_hardlight_defense_system'] },
    },
  },
  {
    id: 'lance', callsign: 'Lance', name: 'Juno Okafor', frame: 'mf_blackbeard',
    levels: {
      2: { hase: [2, 2, 0, 0], talents: [['t_duelist', 2], ['t_brutal', 2], ['t_executioner', 1]], licenses: [['mf_blackbeard', 2]], cbs: [],
        mounts: [['mw_charged_blade'], ['mw_chain_axe'], ['mw_nanocarbon_sword']], systems: ['ms_synthetic_muscle_netting', 'ms_stable_structure', 'ms_personalizations'] },
      // Nelson 2: the War Pike replaces the charged blade; Blackbeard 3: Reinforced Cabling replaces Stable Structure; + Bulwark Mods
      5: { hase: [3, 3, 0, 1], talents: [['t_duelist', 3], ['t_brutal', 3], ['t_executioner', 2]], licenses: [['mf_blackbeard', 3], ['mf_nelson', 2]], cbs: ['cb_gyges_frame'],
        mounts: [['mw_war_pike'], ['mw_chain_axe'], ['mw_nanocarbon_sword']], systems: ['ms_synthetic_muscle_netting', 'ms_reinforced_cabling', 'ms_personalizations', 'ms_bulwark_mods'] },
      // Nelson 3: + Ramjet
      8: { hase: [4, 5, 0, 1], talents: [['t_duelist', 3], ['t_brutal', 3], ['t_executioner', 3], ['t_skirmisher', 2]], licenses: [['mf_blackbeard', 3], ['mf_nelson', 3], ['mf_drake', 2]], cbs: ['cb_gyges_frame', 'cb_titanomachy_mesh'],
        mounts: [['mw_war_pike'], ['mw_chain_axe'], ['mw_nanocarbon_sword']], systems: ['ms_synthetic_muscle_netting', 'ms_reinforced_cabling', 'ms_personalizations', 'ms_bulwark_mods', 'ms_ramjet'] },
    },
  },
]

/** One pilot at one level in COMP/CON's pilot format (what the importer reads). */
function compcon(s: SampleSpec, level: Level) {
  const l = s.levels[level]
  const frame = Lancer.frames.get(s.frame)!
  const id = `ll${level}-${s.id}`
  return {
    itemType: 'pilot', id, callsign: s.callsign, name: s.name, level,
    mechSkills: l.hase,
    talents: l.talents.map(([tid, rank]) => ({ id: tid, rank })),
    core_bonuses: l.cbs.map(c => ({ id: c })),
    licenses: l.licenses.map(([lid, rank]) => ({ id: lid, rank })),
    mechs: [{
      id: `${id}-mech`, name: `${s.callsign}'s ${frame.name}`, frame: s.frame,
      loadouts: [{
        name: 'Primary',
        systems: l.systems.map(x => ({ id: x })),
        mounts: frame.mounts.map((type, i) => ({
          mount_type: type, lock: false,
          slots: l.mounts[i].map(w => ({ size: Lancer.weapons.get(w)!.mount, weapon: { id: w } })),
          extra: [], bonus_effects: [],
        })),
      }],
      active_loadout_index: 0,
    }],
  }
}

let bad = 0
const fail = (msg: string) => { bad++; console.log(`✗ ${msg}`) }
const gear = (p: PilotBuild) => [...p.mech.mounts.flatMap(m => m.slots.map(s => s.weaponId)).filter(Boolean), ...p.mech.systems] as string[]
const files: [Level, unknown[]][] = []
for (const level of LEVELS) {
  const out = SAMPLES.map(s => compcon(s, level))
  for (const raw of out) {
    const [p] = importPilots(structuredClone(raw))
    const v = validateBuild(p)
    const problems = [...v.errors, ...v.warnings, ...p.unknown.map(u => `unknown ${u}`)]
    if (problems.length) fail(`LL${level} ${p.callsign}: ${problems.join('; ')}`)
    const k = LEVELS.indexOf(level)
    if (k > 0) {
      // carried forward: same frame, nothing goes down, and at most two pieces of gear swapped out
      const spec = SAMPLES.find(s => s.callsign === p.callsign)!
      const [was] = importPilots(compcon(spec, LEVELS[k - 1]))
      if (p.mechSkills.some((x, i) => x < was.mechSkills[i])) fail(`${p.callsign} LL${level}: a mech skill went down`)
      if (was.talents.some(t => (p.talents.find(x => x.id === t.id)?.rank ?? 0) < t.rank)) fail(`${p.callsign} LL${level}: a talent rank went down`)
      if ((was.licenses ?? []).some(l => (p.licenses?.find(x => x.id === l.id)?.rank ?? 0) < l.rank)) fail(`${p.callsign} LL${level}: a license rank went down`)
      if (was.coreBonuses.some(c => !p.coreBonuses.includes(c))) fail(`${p.callsign} LL${level}: a core bonus was dropped`)
      const dropped = gear(was).filter(g => !gear(p).includes(g))
      if (dropped.length > 2) fail(`${p.callsign} LL${level}: more than two pieces of gear replaced (${dropped.join(', ')})`)
    }
    if (process.argv.includes('-v')) {
      const sp = mechSP(p)
      console.log(`LL${level} ${p.callsign} [${Lancer.frames.get(p.mech.frameId)?.name}] SP ${sp.used}/${sp.max}\n   W: ${p.mech.mounts.flatMap(m => m.slots.map(s => s.weaponId && Lancer.weapons.get(s.weaponId)?.name)).filter(Boolean).join(', ')}\n   S: ${p.mech.systems.map(x => Lancer.systems.get(x)?.name).join(', ')}`)
    }
  }
  files.push([level, out])
}
if (bad) { console.error(`${bad} problem(s) — not written`); process.exit(1) }
for (const [level, out] of files) writeFileSync(new URL(`../src/data/squads/ll${level}.json`, import.meta.url), JSON.stringify(out, null, 1) + '\n')
console.log(`wrote ${LEVELS.map(l => `ll${l}.json`).join(', ')}`)
