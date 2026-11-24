// Turn enemy team definitions into battle units.
import { scriptsFor } from '../rules/effects/registry'
import { blankTurnState, defaultPolicies, nextUid, weaponFromData } from '../rules/stats'
import type { Profile, SystemInst, Unit, Weapon } from '../rules/types'
import { type EnemyTeam, type EnemyUnitDef, type NpcStats, type Tier, TEMPLATE_RULES, applyTemplates, baselineStats, finalizeStats, unitBudget, veteranTraitsOf, MIN_STANDARD_PER_PC } from './ruleset'

const ROLE_COLORS: Record<string, string> = {
  Striker: '#d9534f', Artillery: '#e08e2b', Controller: '#9b59b6', Defender: '#7f8c8d', Support: '#2e9e6b', Biological: '#a0522d',
}

export function npcStats(def: EnemyUnitDef, tier: Tier): NpcStats {
  const s = def.baseStats ? applyTemplates({ ...def.baseStats }, def.templates) : baselineStats(def.role, tier, def.templates)
  for (const f of def.features) if (f.type === 'trait' && f.stats) for (const [k, v] of Object.entries(f.stats)) (s as any)[k] += v
  for (const [k, v] of Object.entries(def.stats ?? {})) (s as any)[k] = v
  return finalizeStats(s, def.templates)
}

export function buildNpc(def: EnemyUnitDef, tier: Tier, index = 0): Unit {
  const s = npcStats(def, tier)
  const weapons: Weapon[] = []
  const systems: SystemInst[] = []
  def.features.forEach((f, i) => {
    if (f.type === 'weapon') {
      const tags = [...(f.tags ?? [])]
      if (f.smart && !tags.some(t => t.id === 'tg_smart')) tags.push({ id: 'tg_smart' })
      const profile: Profile = { name: f.name, damage: f.damage ?? [], range: f.range, tags, onAttack: [], onHit: f.onHit ?? [], onCrit: f.onCrit ?? [], text: f.text }
      weapons.push({
        uid: nextUid('w'), name: f.name, dataId: `npc_w_${i}`, mountIndex: i, size: f.size ?? 'Main', type: f.weaponType, profiles: [profile], profileIndex: 0,
        loaded: true, destroyed: false, usesLeft: f.uses, attackBonus: f.attackBonus ?? s.attackBonus, accuracy: f.accuracy, vsEdef: !!f.smart,
        recharge: f.recharge, charged: true, bonuses: [], activation: 'quick', script: f.script,
      })
    } else if (f.type === 'tech') {
      const profile: Profile = { name: f.name, damage: [], range: [{ type: 'Range', val: f.range ?? s.sensors }], tags: [], onAttack: [], onHit: f.onHit, onCrit: [], text: f.text }
      weapons.push({
        uid: nextUid('w'), name: f.name, dataId: `npc_t_${i}`, mountIndex: i, size: 'Main', type: 'Tech', profiles: [profile], profileIndex: 0,
        loaded: true, destroyed: false, usesLeft: f.uses, attackBonus: f.attackBonus ?? s.techAttack, accuracy: f.accuracy, vsEdef: true, tech: true,
        recharge: f.recharge, charged: true, bonuses: [], activation: f.kind, script: f.script,
      })
    } else {
      systems.push({ uid: nextUid('s'), dataId: 'npc_feature', name: f.name, destroyed: false, usesLeft: (f as any).uses, feature: f, charged: true })
    }
  })
  for (const id of def.mechWeapons ?? []) {
    const w = weaponFromData(id, 90 + weapons.length, {})
    if (w) { w.attackBonus = s.attackBonus; weapons.push(w) }
  }
  const resist: string[] = [], immune: string[] = []
  for (const f of def.features) if (f.type === 'trait') { resist.push(...(f.resist ?? [])); immune.push(...(f.immune ?? [])) }
  const templates = def.templates ?? []
  // official template traits
  const traits: string[] = []
  if (templates.includes('Veteran')) {
    const best = (['hull', 'agi', 'sys', 'eng'] as const).reduce((a, k) => (s[k] > s[a] ? k : a), 'hull' as 'hull' | 'agi' | 'sys' | 'eng')
    traits.push(`veterancy:${def.veterancy ?? best}`)
    traits.push(...veteranTraitsOf(def))
  }
  if (templates.includes('Ultra')) traits.push('deadly', 'legendary', 'reflex')
  if (traits.includes('insulated')) immune.push('burn')
  const name = (def.count ?? 1) > 1 ? `${def.name} ${String.fromCharCode(65 + index)}` : def.name
  const unit: Unit = {
    id: nextUid('npc'),
    name,
    side: 'enemy',
    kind: 'npc',
    pos: { x: 0, y: 0 },
    flying: def.features.some(f => f.type === 'trait' && (f.flying || /flying|flight|hover/i.test(f.name))),
    stats: {
      hp: s.hp, armor: s.armor, evasion: s.evasion, edef: s.edef, heatcap: s.heatcap, speed: s.speed, sensors: s.sensors, save: s.save,
      techAttack: s.techAttack, structure: s.structure, stress: s.stress, repcap: 0, size: s.size, hull: s.hull, agi: s.agi, sys: s.sys, eng: s.eng,
      grit: 0, limitedBonus: 0, attackBonus: s.attackBonus, activations: s.activations,
    },
    hp: s.hp, heat: 0, structure: s.structure, stress: s.stress, overshield: 0, burn: 0, repairs: 0,
    coreAvailable: false, coreActive: false, overchargeLevel: 0,
    statuses: [], resist, immune: [...immune, ...(s.heatcap === 0 ? [] : [])], weapons, systems, talents: [], coreBonuses: [],
    role: def.role, tier, templates, traits: [...new Set(traits)], isGrunt: templates.includes('Grunt'),
    // only Veterans and Ultras can score critical hits
    canCrit: templates.includes('Veteran') || templates.includes('Ultra'),
    ...blankTurnState(), activationsLeft: s.activations,
    bonuses: [], flags: { budget: unitBudget({ ...def, count: 1 }), description: def.description, ...(templates.some(t => TEMPLATE_RULES[t]?.reactionsEachTurn) ? { reactionsEachTurn: true } : {}) },
    destroyed: false, policies: defaultPolicies(), color: def.color ?? ROLE_COLORS[def.role],
  }
  for (const sc of scriptsFor(unit)) sc.init?.(unit)
  return unit
}

export function buildTeam(team: EnemyTeam, squadSize = team.designedFor): Unit[] {
  const units: Unit[] = []
  // scale the roster to the squad: drop/duplicate the cheapest non-boss units
  const defs = team.units.map(u => ({ ...u }))
  const ratio = squadSize / team.designedFor
  if (ratio !== 1) {
    for (const d of defs) {
      const ts = d.templates ?? []
      if (ts.includes('Ultra')) continue
      const c = d.count ?? 1
      d.count = Math.max(ts.includes('Grunt') ? 1 : c > 1 ? 1 : c, Math.round(c * ratio))
    }
  }
  // a rescaled standard encounter keeps at least one NPC (or its Grunt equivalent) per player: top up with the
  // cheapest units (at its design size the validator already holds a standard team to that floor)
  if (ratio !== 1 && (team.kind ?? 'standard') === 'standard') {
    const spent = () => defs.reduce((a, d) => a + unitBudget(d), 0)
    const cost = (d: EnemyUnitDef) => unitBudget({ ...d, count: 1 })
    const filler = defs.filter(d => !(d.templates ?? []).includes('Ultra')).sort((a, b) => cost(a) - cost(b))
    for (let guard = 0; filler.length && spent() < squadSize * MIN_STANDARD_PER_PC && guard < 40; guard++) {
      // round-robin over the units that don't overshoot what's missing (the cheapest one if none fits)
      const need = squadSize * MIN_STANDARD_PER_PC - spent()
      const fits = filler.filter(d => cost(d) <= need)
      const pick = fits.length ? fits : filler.slice(0, 1)
      const d = pick[guard % pick.length]
      d.count = (d.count ?? 1) + 1
    }
  }
  for (const d of defs) for (let i = 0; i < (d.count ?? 1); i++) units.push(buildNpc(d, team.tier, i))
  // Shock and Awe: an Ultra facing five or more hostiles takes a third turn each round
  if (squadSize >= 5) for (const u of units) if (u.templates?.includes('Ultra')) { u.stats.activations = 3; u.activationsLeft = 3 }
  return units
}
