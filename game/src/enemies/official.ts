// Encounters built from official NPC classes the player imported from an .lcp (browser storage only).
// Composition follows the core book's guidance per player character: 1–2 untemplated NPCs or 3–4
// Grunts; one Elite per 1–2 players; one Ultra per 4 players (bosses), within the same budget as
// the hand-made teams.
import { Rng } from '../rules/rng'
import type { OfficialClass } from '../import/lcp'
import { BUDGET_PER_PC, KIND_MULT, VETERAN_TRAITS, type EnemyTeam, type EnemyUnitDef, type Template, type Tier, unitBudget } from './ruleset'

/** Official classes are stronger per budget point at tier 3 and weaker at tiers 1–2 than the hand-made teams
 *  (tuned with the balance sim against the LL0/LL5/LL10 sample squads). */
const OFFICIAL_SCALE: Record<Tier, Record<'standard' | 'elite' | 'boss', number>> = {
  1: { standard: 1.4, elite: 1, boss: 1.2 },
  2: { standard: 1.4, elite: 1.0, boss: 0.8 },
  3: { standard: 0.85, elite: 0.75, boss: 0.7 },
}

/** One unit definition from an official class: all base features plus `optional` optional ones. */
export function officialUnitDef(cls: OfficialClass, tier: Tier, templates: Template[], rng: Rng, optional = 1, count = 1): EnemyUnitDef {
  const opts = cls.features.filter(f => !f.base)
  // prefer fully automated optional features (weapons and stat traits), then anything else
  const ranked = [...opts.filter(f => !f.partial), ...opts.filter(f => f.partial)]
  const chosen: typeof opts = []
  for (const f of ranked) {
    if (chosen.length >= optional) break
    if (rng.next() < (f.partial ? 0.35 : 0.7)) chosen.push(f)
  }
  const features = [...cls.features.filter(f => f.base), ...chosen].map(f => ({ ...f.byTier[tier - 1], script: f.id }))
  const def: EnemyUnitDef = {
    name: cls.name, role: cls.role, templates, count, features, baseStats: { ...cls.stats[tier - 1] }, officialClass: cls.id,
    description: `Official ${cls.name} (tier ${tier})${chosen.length ? ` with ${chosen.map(f => f.name).join(', ')}` : ''}.`,
  }
  if (templates.includes('Veteran')) def.veteranTrait = rng.pick([...VETERAN_TRAITS])
  return def
}

export function generateOfficialTeam(classes: OfficialClass[], tier: Tier, kind: 'standard' | 'elite' | 'boss', squadSize: number, seed: number): EnemyTeam {
  const rng = new Rng(seed ^ 0x0ff1c1a1)
  // pilots on foot and squads of infantry make poor mech opponents
  const pool = classes.filter(c => !/^(human|squad)$/i.test(c.name))
  const usable = pool.length ? pool : classes
  const budget = squadSize * BUDGET_PER_PC[tier] * KIND_MULT[kind] * OFFICIAL_SCALE[tier][kind]
  const units: EnemyUnitDef[] = []
  const spent = () => units.reduce((a, u) => a + unitBudget(u), 0)
  const used = new Map<string, number>()
  const pickClass = (roles?: string[]) => {
    const cand = usable.filter(c => (!roles || roles.includes(c.role)) && (used.get(c.id) ?? 0) < 2)
    const c = rng.pick(cand.length ? cand : usable)
    used.set(c.id, (used.get(c.id) ?? 0) + 1)
    return c
  }
  const optional = () => (tier === 1 ? rng.int(0, 1) : rng.int(1, 2))

  if (kind === 'boss') {
    units.push(officialUnitDef(pickClass(['Striker', 'Defender', 'Artillery', 'Controller']), tier, ['Ultra'], rng, tier === 3 ? 2 : 3))
  } else if (kind === 'elite') {
    const elites = Math.max(1, Math.floor(squadSize / 2))
    for (let i = 0; i < elites; i++) units.push(officialUnitDef(pickClass(), tier, [i === 0 ? 'Elite' : 'Veteran'], rng, optional()))
  }
  // always have something that hits hard
  if (!units.some(u => u.role === 'Striker')) units.push(officialUnitDef(pickClass(['Striker']), tier, [], rng, optional()))
  let guard = 0
  while (budget - spent() >= 0.75 && guard++ < 40) {
    const left = budget - spent()
    const r = rng.next()
    if (r < 0.3 && left >= 0.75) {
      // a pack of grunts: dangerous glass cannons that soak up player actions
      units.push(officialUnitDef(pickClass(['Striker', 'Artillery', 'Controller']), tier, ['Grunt'], rng, 0, Math.min(4, Math.floor(left / 0.25), rng.int(3, 4))))
    } else if (r < 0.45 && tier > 1 && left >= 1.5) {
      units.push(officialUnitDef(pickClass(), tier, ['Veteran'], rng, optional()))
    } else if (left >= 1) {
      units.push(officialUnitDef(pickClass(), tier, [], rng, optional()))
    } else {
      units.push(officialUnitDef(pickClass(['Striker', 'Artillery']), tier, ['Grunt'], rng, 0, Math.floor(left / 0.25)))
    }
  }
  // two picks of the same class get distinct names
  const seen = new Map<string, number>()
  for (const u of units) { const n = (seen.get(u.name) ?? 0) + 1; seen.set(u.name, n); if (n > 1) u.name = `${u.name} Mk ${['', 'I', 'II', 'III', 'IV'][n] ?? n}` }
  const lead = units[0]
  return {
    id: `official-${tier}-${kind}-${seed}`,
    name: `${lead.name}${kind === 'boss' ? ' (Ultra)' : ''} and escorts`,
    faction: 'Official NPCs (imported LCP)',
    tier, designedFor: squadSize, kind,
    description: 'Generated from the official NPC classes you imported.',
    units,
  }
}
