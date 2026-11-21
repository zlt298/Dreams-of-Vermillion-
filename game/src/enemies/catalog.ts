// Loads every enemy team in /data/enemies (bundled by Vite at build time).
import type { EnemyTeam, Tier } from './ruleset'
import { validateTeam } from './validate'

const modules = import.meta.glob('../../../data/enemies/*.json', { eager: true, import: 'default' }) as Record<string, EnemyTeam>

export interface CatalogEntry { team: EnemyTeam; file: string; errors: string[] }

export const catalog: CatalogEntry[] = Object.entries(modules).map(([file, team]) => ({
  team, file: file.split('/').pop()!, errors: validateTeam(team).errors,
}))

export function validTeams(): EnemyTeam[] {
  return catalog.filter(c => !c.errors.length).map(c => c.team)
}

export function teamsFor(tier: Tier, kind: 'standard' | 'elite' | 'boss', depth?: number): EnemyTeam[] {
  const all = validTeams().filter(t => t.tier === tier)
  let pool = all.filter(t => (t.kind ?? 'standard') === kind && (!depth || !t.depth || (depth >= t.depth[0] && depth <= t.depth[1])))
  if (!pool.length) pool = all.filter(t => (t.kind ?? 'standard') === kind)
  if (!pool.length) pool = all
  if (!pool.length) pool = validTeams()
  return pool
}
