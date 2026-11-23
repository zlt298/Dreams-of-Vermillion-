// Battle replays: every battle records its seed, starting state and the top-level commands it ran
// (player actions, AI turns and the decisions taken in the HUD picker). Replaying them on a fresh
// battle reproduces the fight exactly, because the engine is deterministic given its seed.
import { Battle, type BattleRecord, type CommandEntry } from '../rules/battle'
import { runAiTurn } from '../ai/ai'
import { setUidState } from '../rules/stats'
import type { Unit } from '../rules/types'

export interface BattleExport {
  format: 'dov-battle'
  version: 1
  exportedAt: string
  record: BattleRecord
  commands: CommandEntry[]
  /** state hash at export time, to confirm a replay reproduces it */
  hash: string
  /** optional note from whoever exported it (what went wrong) */
  note?: string
}

export function exportBattle(b: Battle, note?: string): BattleExport {
  if (!b.record) throw new Error('The battle has not started')
  return { format: 'dov-battle', version: 1, exportedAt: new Date().toISOString(), record: b.record, commands: JSON.parse(JSON.stringify(b.commands)), hash: stateHash(b), ...(note ? { note } : {}) }
}

export function importBattle(json: string | unknown): BattleExport {
  const x = (typeof json === 'string' ? JSON.parse(json) : json) as BattleExport
  if (x?.format !== 'dov-battle' || x.version !== 1 || !x.record || !Array.isArray(x.commands)) throw new Error('Not a Dreams of Vermillion battle export')
  return x
}

function decode(b: Battle, v: unknown, actor?: Unit): unknown {
  if (v == null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(x => decode(b, x, actor))
  const o = v as any
  if ('$u' in o) return b.units.find(u => u.id === o.$u)
  if ('$w' in o) for (const u of b.units) { const w = u.weapons.find(x => x.uid === o.$w); if (w) return w }
  if ('$m' in o) return b.mines.find(m => m.id === o.$m)
  if ('$a' in o) {
    const a = actor ? b.customActions(actor).find(x => x.key === o.$a) : undefined
    if (!a) throw new Error(`action ${o.$a} is not available`)
    return a
  }
  const out: any = {}
  for (const k of Object.keys(o)) out[k] = decode(b, o[k], actor)
  return out
}

/**
 * Rebuild a battle from an export and re-run its commands. `upTo` stops early (to inspect the state just
 * before a bug). Commands that fail are reported and skipped; a faithful replay has none.
 */
export function replayBattle(x: BattleExport, opts: { upTo?: number; onError?: (i: number, c: CommandEntry, e: Error) => void } = {}): Battle {
  const r = x.record
  setUidState(r.uid)
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
  const b = new Battle({ map: clone(r.map), units: clone(r.units), seed: r.seed, sitrep: clone(r.sitrep) })
  b.start()
  const n = Math.min(opts.upTo ?? x.commands.length, x.commands.length)
  for (let i = 0; i < n; i++) {
    const c = x.commands[i]
    try {
      const first = decode(b, c.args[0]) as Unit | undefined
      const args = c.args.map(a => decode(b, a, first))
      b.answers = c.answers.slice()
      if (c.op === 'aiTurn') runAiTurn(b, args[0] as Unit)
      else (b as any)[c.op](...args)
    } catch (e) {
      opts.onError?.(i, c, e as Error)
    } finally { b.answers = [] }
  }
  return b
}

/** A short fingerprint of the battle state (units, mines, areas, round, dice). */
export function stateHash(b: Battle): string {
  const snap = JSON.stringify({
    round: b.round, rng: b.rng.state, winner: b.winner, side: b.currentSide,
    units: b.units.map(u => [u.id, u.pos.x, u.pos.y, u.hp, u.heat, u.structure, u.stress, u.burn, u.destroyed, u.statuses.map(s => s.id).sort(), u.weapons.map(w => [w.loaded, w.usesLeft, w.destroyed])]),
    mines: b.mines.map(m => [m.id, m.pos.x, m.pos.y, m.armed]),
    areas: b.areas.length,
  })
  let h = 2166136261
  for (let i = 0; i < snap.length; i++) { h ^= snap.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0).toString(16).padStart(8, '0')
}

const BOOKKEEPING = new Set(['beginTurn', 'setPolicy', 'setProfile', 'setWeaponFlag'])
/** A recorded command that is a player's action (not an enemy turn or bookkeeping). */
export function isAction(c: { op: string; args: unknown[] }, b?: Battle): boolean {
  if (BOOKKEEPING.has(c.op)) return false
  if (c.op !== 'aiTurn') return true
  const id = (c.args[0] as { $u?: string } | undefined)?.$u
  return !!b && b.unit(id)?.side === 'player'
}
/** The battle as it was just before its last player action (and everything after it). */
export function withoutLastAction(x: BattleExport, b: Battle): BattleExport | null {
  let i = x.commands.length - 1
  while (i >= 0 && !isAction(x.commands[i], b)) i--
  return i < 0 ? null : { ...x, commands: x.commands.slice(0, i) }
}
