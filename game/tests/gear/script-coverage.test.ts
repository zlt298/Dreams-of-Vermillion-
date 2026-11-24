// Guard: every registered effect script is referenced by some test (or explicitly allowlisted with a reason).
// A script counts as referenced when its id, or its item id (prefix `frame:`/`core:`/`npc:`/... and `:rank` stripped),
// appears in the text of any file under tests/.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { allScriptIds } from '../../src/rules/effects/registry'
import '../../src/rules/effects/scripts'

/** Scripts whose item has nothing a behaviour test could assert. */
const NARRATIVE_ONLY: Record<string, string> = {
  ms_expanded_compartment: 'passenger space; no combat rule',
  ms_manipulators: 'fine manipulation; no combat rule',
  ms_eva_module: 'zero-g / underwater flight; no such environments',
  ms_technophile_1: 'custom NHP personality',
  ms_technophile_2: 'custom NHP personality',
}
/** Scripts that still have no behaviour test. Keep this short: write the test, then delete the line. */
const OFFICIAL_SMOKE = 'official NPC feature: only the official-scripts smoke battle runs it'
const WEAPON = 'weapon script: only the scripts.test.ts stress battle runs it'
const NOT_YET_TESTED: Record<string, string> = {
  ms_walking_armory_3: 'Walking Armory rank 3 Ammo Case tier (ranks 1-2 are tested)',
  'npc:npcf_defense_net_aegis': OFFICIAL_SMOKE,
  'npc:npcf_suppress_archer': OFFICIAL_SMOKE,
  'npc:npcf_assassins_mark_assassin': OFFICIAL_SMOKE,
  'npc:npcf_rebound_ronin': OFFICIAL_SMOKE,
  'npc:npcf_friendly_interdiction_bastion': OFFICIAL_SMOKE,
  'npc:npcf_avalanche_charge_berserker': OFFICIAL_SMOKE,
  'npc:npcf_cluster_munitions_bombard': OFFICIAL_SMOKE,
  'npc:npcf_earthshaker_shells_bombard': OFFICIAL_SMOKE,
  'npc:npcf_breach_ram_breacher': OFFICIAL_SMOKE,
  'npc:npcf_break_armor_breacher': OFFICIAL_SMOKE,
  'npc:npcf_impale_cataphract': OFFICIAL_SMOKE,
  'npc:npcf_focus_down_scourer': OFFICIAL_SMOKE,
  'npc:npcf_rebound_scan_scout': OFFICIAL_SMOKE,
  'npc:npcf_prowl_specter': OFFICIAL_SMOKE,
  mw_bristlecrown_flechette_launcher: WEAPON,
  mw_cutter_mkii_plasma_torch: WEAPON,
  mw_daisy_cutter: WEAPON,
  mw_impact_lance: WEAPON,
  mw_magnetic_cannon: WEAPON,
  mw_veil_rifle: WEAPON,
  mw_sharanga_missiles: WEAPON,
  mw_nanobot_whip: WEAPON,
  mw_ghoul_nexus: WEAPON,
  mw_arc_projector: WEAPON,
  mw_autogun: WEAPON,
  mw_shatterhead_colony_missiles: WEAPON,
  mw_tachyon_lance: WEAPON,
  mw_annihilator: WEAPON,
  mw_fuel_rod_gun: WEAPON,
  mw_lancaster_integrated: 'Lancaster integrated weapon (Latch Drone): only the stress battle runs it',
  wm_phase_ready_mod: 'weapon mod: only the stress battle runs it',
  cb_all_theater_movement_suite: 'core bonus: only the stress battle runs it',
  cb_the_lesson_of_the_held_image: 'core bonus: only the stress battle runs it',
  cb_the_lesson_of_transubstantiation: 'core bonus: only the stress battle runs it',
  cb_adaptive_reactor: 'core bonus: only the stress battle runs it',
  cb_stasis_shielding: 'core bonus: only the stress battle runs it',
}

function testFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(f => {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) return f === 'node_modules' ? [] : testFiles(p)
    return /\.(ts|tsx)$/.test(f) && p !== __filename ? [p] : []
  })
}

/** `frame:mf_x` → `mf_x`, `t_brawler:2` → `t_brawler`, `npc:npcf_x` → `npcf_x` */
const itemId = (id: string) => id.replace(/^(frame|core|npc|template|trait):/, '').split(':')[0]

describe('effect script coverage', () => {
  const corpus = testFiles(join(__dirname, '..')).map(p => readFileSync(p, 'utf8')).join('\n')
  const ids = allScriptIds()
  const referenced = (id: string) => corpus.includes(id) || corpus.includes(itemId(id))

  it('registers scripts', () => {
    expect(ids.length).toBeGreaterThan(300)
  })
  it('every script id is referenced by a test or allowlisted with a reason', () => {
    const missing = ids.filter(id => !(id in NARRATIVE_ONLY) && !(id in NOT_YET_TESTED) && !referenced(id))
    expect(missing, `scripts with no test (add a test, or an allowlist entry with a reason):\n${missing.join('\n')}`).toEqual([])
  })
  it('the allowlists name only registered scripts that are still unreferenced', () => {
    const stale = [...Object.keys(NARRATIVE_ONLY), ...Object.keys(NOT_YET_TESTED)].filter(id => !ids.includes(id) || referenced(id))
    expect(stale, `stale allowlist entries (remove them):\n${stale.join('\n')}`).toEqual([])
  })
})
