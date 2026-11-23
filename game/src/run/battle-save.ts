// The battle in progress is saved after every action (as a replay: seed, starting state, commands),
// so closing the tab or reloading resumes the fight instead of restarting it.
import type { BattleExport } from '../replay/replay'

const KEY = 'dov.battle.v1'

export interface SavedBattle { runSeed: number; nodeId: string; title: string; data: BattleExport }

export function saveBattle(s: SavedBattle) {
  try { localStorage.setItem(KEY, JSON.stringify(s)) } catch { /* storage full or unavailable: the run save still works */ }
}
export function loadBattle(): SavedBattle | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as SavedBattle
    return s?.data?.format === 'dov-battle' ? s : null
  } catch { return null }
}
export function clearBattle() {
  try { localStorage.removeItem(KEY) } catch { /* ignore */ }
}
