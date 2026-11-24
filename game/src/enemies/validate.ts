// Validates enemy team files against the ruleset. Used by the game loader, the
// `npm run validate-enemies` script and the generate-enemies Claude skill.
import { Lancer } from '../data/lancer'
import { averageDice } from '../rules/rng'
import type { Effect } from '../rules/types'
import {
  type EnemyTeam, type EnemyUnitDef, type Feature, type NpcStats, type Tier,
  ROLES, TEMPLATES, TEMPLATE_RULES, VETERAN_TRAITS, DAMAGE_BAND, DAMAGE_TOLERANCE, STAT_TOLERANCE, baselineStats, featureSlots, teamBudget, veteranTraitsOf,
  BUDGET_PER_PC, KIND_MULT, MIN_STANDARD_PER_PC,
} from './ruleset'

export interface ValidationResult { ok: boolean; errors: string[]; warnings: string[]; budget: number }

const STATUSES = ['impaired', 'slowed', 'immobilized', 'jammed', 'lockon', 'shredded', 'stunned', 'exposed', 'prone', 'hidden', 'invisible']
const DAMAGE_TYPES = ['Kinetic', 'Explosive', 'Energy', 'Burn', 'Heat']
const RANGE_TYPES = ['Range', 'Threat', 'Thrown', 'Line', 'Cone', 'Blast', 'Burst']
const DURATIONS = ['end_of_turn', 'next_turn_end_target', 'next_turn_end_source', 'start_of_next_turn_target', 'until_cleared', 'scene']
const STATS = ['hull', 'agi', 'sys', 'eng']
const EFFECT_KINDS = ['status', 'damage', 'heat', 'burn', 'push', 'pull', 'overshield', 'heal', 'clear_heat', 'clear_status', 'bonus_damage', 'teleport', 'text']
const DICE = /^(\d+|\d*d\d+([+-]\d+)?)$/

function checkEffects(where: string, effects: Effect[] | undefined, errors: string[], warnings: string[]) {
  for (const [i, e] of (effects ?? []).entries()) {
    const w = `${where} effect[${i}]`
    if (!e || !EFFECT_KINDS.includes((e as any).do)) { errors.push(`${w}: unknown effect '${(e as any)?.do}'`); continue }
    if ('save' in e && e.save && !STATS.includes(e.save)) errors.push(`${w}: save must be one of ${STATS.join('/')}`)
    switch (e.do) {
      case 'status':
        if (!STATUSES.includes(e.status)) errors.push(`${w}: unknown status '${e.status}'`)
        if (e.duration && !DURATIONS.includes(e.duration)) errors.push(`${w}: unknown duration '${e.duration}'`)
        if (e.status === 'stunned' && !e.save) warnings.push(`${w}: unsaveable STUNNED is very strong`)
        break
      case 'damage':
        for (const d of e.damage) {
          if (!DAMAGE_TYPES.includes(d.type)) errors.push(`${w}: bad damage type '${d.type}'`)
          if (!DICE.test(String(d.val).replace(/\s/g, ''))) errors.push(`${w}: bad dice '${d.val}'`)
        }
        break
      case 'heat': case 'push': case 'pull': case 'overshield': case 'heal':
        if (!DICE.test(String(e.val))) errors.push(`${w}: bad value '${e.val}'`)
        break
      case 'text':
        warnings.push(`${w}: text effects are not executed by the engine ("${e.text.slice(0, 40)}…")`)
        break
    }
  }
}

function avgDamage(damage: { type: string; val: string | number }[]): number {
  return damage.filter(d => d.type !== 'Heat').reduce((a, d) => a + averageDice(d.val), 0)
}

function checkFeature(u: EnemyUnitDef, tier: Tier, f: Feature, i: number, errors: string[], warnings: string[]) {
  const where = `${u.name} feature[${i}] '${f?.name}'`
  if (!f || !f.name) { errors.push(`${u.name} feature[${i}]: missing name`); return }
  switch (f.type) {
    case 'weapon': {
      if (!f.range?.length) errors.push(`${where}: weapons need a range`)
      for (const r of f.range ?? []) if (!RANGE_TYPES.includes(r.type)) errors.push(`${where}: bad range type '${r.type}'`)
      if (!f.damage?.length && !f.onHit?.length) errors.push(`${where}: weapons need damage or onHit effects`)
      for (const d of f.damage ?? []) {
        if (!DAMAGE_TYPES.includes(d.type)) errors.push(`${where}: bad damage type '${d.type}'`)
        if (!DICE.test(String(d.val).replace(/\s/g, ''))) errors.push(`${where}: bad dice '${d.val}'`)
      }
      const avg = avgDamage(f.damage ?? [])
      const band = DAMAGE_BAND[u.role][tier - 1]
      const aoe = (f.range ?? []).some(r => ['Blast', 'Burst', 'Line', 'Cone'].includes(r.type))
      let max = band * (1 + DAMAGE_TOLERANCE) * (aoe ? 0.85 : 1)
      if (f.recharge || f.uses) max *= 1.5
      if ((u.templates ?? []).includes('Grunt')) max *= 0.8
      if (avg > max) errors.push(`${where}: average damage ${avg.toFixed(1)} exceeds ${u.role} T${tier} cap ${max.toFixed(1)}`)
      if (avg && avg < band * (1 - DAMAGE_TOLERANCE) * 0.5) warnings.push(`${where}: average damage ${avg.toFixed(1)} is very low for ${u.role} T${tier}`)
      if (f.recharge && (f.recharge < 4 || f.recharge > 6)) errors.push(`${where}: recharge must be 4-6`)
      checkEffects(where, f.onHit, errors, warnings)
      checkEffects(where, f.onCrit, errors, warnings)
      break
    }
    case 'tech':
      if (!['quick', 'full'].includes(f.kind)) errors.push(`${where}: kind must be quick|full`)
      if (!f.onHit?.length) errors.push(`${where}: tech features need onHit effects`)
      checkEffects(where, f.onHit, errors, warnings)
      break
    case 'system':
      if (!['quick', 'full', 'protocol'].includes(f.activation)) errors.push(`${where}: bad activation`)
      if (!['self', 'ally', 'enemy', 'self_burst', 'tile_blast'].includes(f.target)) errors.push(`${where}: bad target`)
      if ((f.target === 'self_burst' || f.target === 'tile_blast') && !f.radius) errors.push(`${where}: area systems need a radius`)
      checkEffects(where, f.effects, errors, warnings)
      for (const e of f.effects ?? []) if (e.do === 'damage') {
        const avg = avgDamage(e.damage)
        const cap = DAMAGE_BAND[u.role][tier - 1] * (1 + DAMAGE_TOLERANCE) * (f.recharge || f.uses ? 1.5 : 1)
        if (avg > cap) errors.push(`${where}: system damage ${avg.toFixed(1)} exceeds cap ${cap.toFixed(1)}`)
      }
      break
    case 'trait':
      for (const k of Object.keys(f.stats ?? {})) if (!(k in baselineStats('Striker', 1))) errors.push(`${where}: unknown stat '${k}'`)
      // Chaff and Weak: a Grunt can't gain HP, Structure or Stress
      if ((u.templates ?? []).includes('Grunt')) for (const k of ['hp', 'structure', 'stress']) if (f.stats && k in f.stats) errors.push(`${where}: a Grunt can't gain ${k}`)
      for (const s of f.immune ?? []) if (!STATUSES.includes(s)) errors.push(`${where}: unknown immunity '${s}'`)
      for (const r of f.resist ?? []) if (![...DAMAGE_TYPES, 'all'].includes(r)) errors.push(`${where}: unknown resistance '${r}'`)
      if ((f.resist ?? []).includes('all') && !(u.templates ?? []).some(t => t === 'Ultra')) errors.push(`${where}: resistance to all damage is Ultra-only`)
      for (const h of f.hooks ?? []) checkEffects(`${where} hook ${h.on}`, h.effects, errors, warnings)
      break
    case 'reaction':
      if (!f.effects?.length && !f.attackWith) errors.push(`${where}: reactions need effects or attackWith`)
      if (f.attackWith && !u.features.some(x => x.type === 'weapon' && x.name === f.attackWith)) errors.push(`${where}: attackWith '${f.attackWith}' is not one of this unit's weapons`)
      checkEffects(where, f.effects, errors, warnings)
      break
    default:
      errors.push(`${where}: unknown feature type '${(f as any).type}'`)
  }
}

export function validateTeam(t: EnemyTeam): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []
  if (!t || typeof t !== 'object') return { ok: false, errors: ['not an object'], warnings, budget: 0 }
  if (!t.id || !/^[a-z0-9-]+$/.test(t.id)) errors.push('id must be kebab-case [a-z0-9-]')
  if (!t.name) errors.push('missing name')
  if (![1, 2, 3].includes(t.tier)) errors.push('tier must be 1, 2 or 3')
  if (!t.designedFor || t.designedFor < 1 || t.designedFor > 6) errors.push('designedFor must be 1-6')
  if (!Array.isArray(t.units) || !t.units.length) errors.push('team needs units')
  const tier = (t.tier ?? 1) as Tier
  for (const u of t.units ?? []) {
    if (!u.name) errors.push('unit missing name')
    if (!ROLES.includes(u.role)) errors.push(`${u.name}: unknown role '${u.role}'`)
    for (const tp of u.templates ?? []) if (!TEMPLATES.includes(tp)) errors.push(`${u.name}: unknown template '${tp}'`)
    // Rank and File (Grunt), Career Soldier (Elite), Ultra: template exclusions
    for (const tp of u.templates ?? []) {
      const bad = (TEMPLATE_RULES[tp]?.excludes ?? []).filter(x => (u.templates ?? []).includes(x))
      if (bad.length) errors.push(`${u.name}: ${tp} cannot combine with ${bad.join('/')}`)
    }
    if ((u as any).baseStats || (u as any).officialClass) errors.push(`${u.name}: baseStats/officialClass are reserved for imported official NPCs`)
    const vts = veteranTraitsOf(u)
    if (vts.length && !(u.templates ?? []).includes('Veteran')) errors.push(`${u.name}: veteranTrait(s) requires the Veteran template`)
    for (const vt of vts) if (!VETERAN_TRAITS.includes(vt)) errors.push(`${u.name}: unknown veteranTrait '${vt}' (one of ${VETERAN_TRAITS.join(', ')})`)
    // Veteran Traits: one per tier (T1 one, T2 two, T3 three)
    if ((u.templates ?? []).includes('Veteran') && vts.length !== tier) errors.push(`${u.name}: a T${tier} Veteran takes ${tier} Veteran trait(s) (has ${vts.length})`)
    if (u.veterancy && !['hull', 'agi', 'sys', 'eng'].includes(u.veterancy)) errors.push(`${u.name}: veterancy must be hull, agi, sys or eng`)
    if (u.count != null && (u.count < 1 || u.count > 8)) errors.push(`${u.name}: count must be 1-8`)
    if (!ROLES.includes(u.role)) continue
    const base = baselineStats(u.role, tier, u.templates)
    for (const [k, v] of Object.entries(u.stats ?? {})) {
      const key = k as keyof NpcStats
      if (!(key in base)) { errors.push(`${u.name}: unknown stat '${k}'`); continue }
      const tol = STAT_TOLERANCE[key]
      if (tol == null) { errors.push(`${u.name}: stat '${k}' is set by role/tier/template and cannot be overridden`); continue }
      if (key === 'hp' && (u.templates ?? []).includes('Grunt')) { errors.push(`${u.name}: a Grunt has 1 HP; hp cannot be overridden`); continue }
      const delta = (v as number) - base[key]
      const lim = key === 'hp' ? Math.ceil(base.hp * tol) : tol
      if (Math.abs(delta) > lim) errors.push(`${u.name}: ${k} ${v} deviates from baseline ${base[key]} by more than ${lim}`)
    }
    if (!u.features?.length) errors.push(`${u.name}: needs at least one feature`)
    if (!u.features?.some(f => f.type === 'weapon' || f.type === 'tech' || (f.type === 'system' && f.effects?.some(e => e.do === 'damage' || e.do === 'heal' || e.do === 'overshield'))) && !(u.mechWeapons?.length))
      errors.push(`${u.name}: needs at least one way to act (weapon, tech or effective system)`)
    const slots = featureSlots(tier, u.templates)
    if ((u.features?.length ?? 0) > slots) errors.push(`${u.name}: ${u.features.length} features exceeds ${slots} slots for T${tier} ${(u.templates ?? []).join('+') || 'standard'}`)
    u.features?.forEach((f, i) => checkFeature(u, tier, f, i, errors, warnings))
    if (u.mechWeapons?.length) {
      if (!(u.templates ?? []).includes('Mercenary')) errors.push(`${u.name}: mechWeapons require the Mercenary template`)
      if (u.mechWeapons.length > 2) errors.push(`${u.name}: at most 2 mechWeapons`)
      for (const id of u.mechWeapons) {
        const w = Lancer.weapons.get(id)
        if (!w) errors.push(`${u.name}: unknown lancer-data weapon '${id}'`)
        else if (w.mount === 'Superheavy' && tier < 3) errors.push(`${u.name}: superheavy weapons are tier 3 only`)
      }
    }
    if (u.color && !/^#[0-9a-fA-F]{6}$/.test(u.color)) errors.push(`${u.name}: color must be #rrggbb`)
  }
  const budget = teamBudget(t)
  const target = BUDGET_PER_PC[tier] * (t.designedFor ?? 4) * KIND_MULT[t.kind ?? 'standard']
  if (t.kind === 'elite' && !t.units.some(u => u.templates?.includes('Elite'))) errors.push('an elite team needs at least one Elite')
  if (budget > target * 1.25) errors.push(`budget ${budget} exceeds ${(target * 1.25).toFixed(2)} (target ${target} for ${t.designedFor} PCs at T${tier}${t.kind ? ' ' + t.kind : ''})`)
  if (budget < target * 0.6) warnings.push(`budget ${budget} is well under the target ${target}`)
  // core book p.283: a standard fight has at least one NPC (1 budget point) per player
  const floor = MIN_STANDARD_PER_PC * (t.designedFor ?? 4)
  if ((t.kind ?? 'standard') === 'standard' && budget < floor) errors.push(`budget ${budget} is under ${floor}: a standard encounter needs at least one NPC per player`)
  if (t.kind === 'boss' && !t.units.some(u => (u.templates ?? []).includes('Ultra'))) warnings.push('boss teams should include an Ultra')
  if (t.units.reduce((n, u) => n + ((u.templates ?? []).includes('Ultra') ? u.count ?? 1 : 0), 0) > 1) warnings.push('the core book recommends at most one Ultra per encounter')
  return { ok: errors.length === 0, errors, warnings, budget }
}
