// Golden battles: fixed AI-vs-AI fights whose final state is pinned in battles.json, so any change that
// alters a fight (rules, scripts, AI, enemy data, maps) shows up. Regenerate on purpose with: npm run golden
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildTeam } from '../../../src/enemies/build'
import { autoBattle } from '../../../src/ai/ai'
import { Battle } from '../../../src/rules/battle'
import { importPilots } from '../../../src/import/compcon'
import { buildMechUnit, setUidState } from '../../../src/rules/stats'
import { generateMap } from '../../../src/run/mapgen'
import { stateHash } from '../../../src/replay/replay'
import ll2 from '../../../src/data/squads/ll2.json'
import ll5 from '../../../src/data/squads/ll5.json'
import ll8 from '../../../src/data/squads/ll8.json'
import '../../../src/rules/effects/scripts'

export const CASES = [
  { id: 't1-standard', team: 't1-checkpoint-garrison', seed: 11 },
  { id: 't1-boss', team: 't1-boss-red-warden', seed: 12 },
  { id: 't2-standard', team: 't2-gantry-witches', seed: 21 },
  { id: 't2-boss', team: 't2-boss-furnace-saint', seed: 22 },
  { id: 't3-standard', team: 't3-regolith-stalkers', seed: 31 },
  { id: 't3-boss', team: 't3-boss-voice-of-the-eye', seed: 32 },
]
const ROUNDS = 6

const squads: Record<number, any[]> = {
  1: ll2 as any[],
  2: ll5 as any[],
  3: ll8 as any[],
}

export interface GoldenResult { id: string; round: number; winner: string | null; commands: number; hash: string }

export function runCase(c: (typeof CASES)[number]): GoldenResult {
  setUidState(0) // ids must not depend on what ran before
  const team = JSON.parse(readFileSync(join(import.meta.dirname, '../../../../data/enemies', `${c.team}.json`), 'utf8'))
  const squad = squads[team.tier].map(raw => buildMechUnit(importPilots(raw)[0]))
  const enemies = buildTeam(team, 4)
  const map = generateMap(c.seed * 977)
  squad.forEach((u, i) => (u.pos = map.deployPlayer[i]))
  enemies.forEach((u, i) => (u.pos = map.deployEnemy[i % map.deployEnemy.length]))
  const b = new Battle({ map, units: [...squad, ...enemies], seed: c.seed })
  b.start()
  autoBattle(b, ROUNDS)
  return { id: c.id, round: b.round, winner: b.winner, commands: b.commands.length, hash: stateHash(b) }
}
