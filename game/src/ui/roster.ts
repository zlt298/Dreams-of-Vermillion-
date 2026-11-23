// The pilot roster: everything imported from COMP/CON, kept in localStorage.
import { importPilots, type PilotBuild } from '../import/compcon'
import pregens from '../data/pregens/pregens.json'

const KEY = 'dov.roster.v1'

export function loadRoster(): PilotBuild[] {
  try {
    const s = localStorage.getItem(KEY)
    if (s) {
      const r = JSON.parse(s)
      // drop anything malformed rather than crashing the hangar
      if (Array.isArray(r)) return r.filter((p: any) => p?.id && p?.mech?.frameId && Array.isArray(p.mech.mounts))
    }
  } catch { /* ignore */ }
  return []
}
export function saveRoster(r: PilotBuild[]) {
  try { localStorage.setItem(KEY, JSON.stringify(r)) } catch { /* ignore */ }
}
export function addToRoster(r: PilotBuild[], builds: PilotBuild[]): PilotBuild[] {
  const out = [...r]
  for (const b of builds) {
    const i = out.findIndex(x => x.id === b.id)
    if (i >= 0) out[i] = b
    else out.push(b)
  }
  saveRoster(out)
  return out
}
import ll5 from '../data/squads/ll5.json'
import ll10 from '../data/squads/ll10.json'

/** Legal sample squads at License Level 5 and 10 — the act 2 and act 3 levels (also used by the balance sim). */
export function sampleSquad(level: 5 | 10): PilotBuild[] {
  return ((level === 5 ? ll5 : ll10) as any[]).map(p => importPilots(p)[0])
}

import themed from '../data/squads/themed.json'

/** A pre-built player squad: a theme at one License Level (act 1 = LL0, act 2 = LL5, act 3 = LL10). */
export type SquadDifficulty = 'Easy' | 'Medium' | 'Hard'
export const DIFFICULTY_ORDER: SquadDifficulty[] = ['Easy', 'Medium', 'Hard']
export interface SquadPreset { id: string; name: string; theme: string; difficulty: SquadDifficulty; blurb: string; level: number; pilots: PilotBuild[] }
/** The themed squads (generated and validated by scripts/make-squads.ts). */
export function squadPresets(): SquadPreset[] {
  return structuredClone(themed as unknown as SquadPreset[]).sort((a, b) => DIFFICULTY_ORDER.indexOf(a.difficulty) - DIFFICULTY_ORDER.indexOf(b.difficulty))
}

export function pregenBuilds(): PilotBuild[] {
  return (pregens as any[]).map(p => importPilots(p)[0])
}
export async function readFiles(files: FileList | File[]): Promise<{ builds: PilotBuild[]; errors: string[] }> {
  const builds: PilotBuild[] = []
  const errors: string[] = []
  for (const f of Array.from(files)) {
    try { builds.push(...importPilots(JSON.parse(await f.text()))) } catch (e) { errors.push(`${f.name}: ${(e as Error).message}`) }
  }
  return { builds, errors }
}
