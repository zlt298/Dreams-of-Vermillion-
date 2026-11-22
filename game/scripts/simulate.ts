// Balance sim: AI vs AI. Tier 1 teams face the LL0 COMP/CON pregens, tier 2 the LL5 sample squad,
// tier 3 the LL10 sample squad.  npx tsx scripts/simulate.ts [N] [team-id-filter]
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildTeam } from '../src/enemies/build'
import { autoBattle } from '../src/ai/ai'
import { Battle } from '../src/rules/battle'
import { importPilots } from '../src/import/compcon'
import { buildMechUnit } from '../src/rules/stats'
import { generateMap } from '../src/run/mapgen'
import pregens from '../src/data/pregens/pregens.json'
import ll5 from '../src/data/squads/ll5.json'
import ll10 from '../src/data/squads/ll10.json'
import '../src/rules/effects/scripts'
import { readLcp } from '../src/import/lcp'
import { generateOfficialTeam } from '../src/enemies/official'

const N = Number(process.argv[2] ?? 6)
const filter = process.argv[3]
const squads: Record<number, any[]> = {
  1: ['Vanguard', 'Assault', 'Sniper', 'Fire Support'].map(n => (pregens as any[]).find(p => p.name === n)),
  2: ll5 as any[],
  3: ll10 as any[],
}
const dir = resolve(import.meta.dirname, '../../data/enemies')
const teams: { team: any; official?: boolean }[] = readdirSync(dir).filter(f => f.endsWith('.json')).map(f => ({ team: JSON.parse(readFileSync(join(dir, f), 'utf8')) }))
// LCP=<path to .lcp>: also simulate encounters generated from official NPC classes (read at runtime, never copied)
if (process.env.LCP) {
  const classes = readLcp(new Uint8Array(readFileSync(process.env.LCP))).classes
  for (const tier of [1, 2, 3] as const) for (const kind of ['standard', 'elite', 'boss'] as const) teams.push({ team: { id: `official-t${tier}-${kind}`, tier, kind, classes }, official: true })
}
for (const { team, official } of teams) {
  if (filter && !team.id.includes(filter)) continue
  let wins = 0, rounds = 0, lost = 0
  for (let s = 1; s <= N; s++) {
    const squad = squads[team.tier].map(raw => buildMechUnit(importPilots(raw)[0]))
    const enemies = buildTeam(official ? generateOfficialTeam(team.classes, team.tier, team.kind, 4, s * 31) : team, 4)
    const map = generateMap(s * 977)
    squad.forEach((u, i) => (u.pos = map.deployPlayer[i]))
    enemies.forEach((u, i) => (u.pos = map.deployEnemy[i % map.deployEnemy.length]))
    const b = new Battle({ map, units: [...squad, ...enemies], seed: s })
    b.start()
    autoBattle(b, Number(process.env.MAX_ROUNDS ?? 30))
    if (b.winner === 'player') wins++
    rounds += b.round
    lost += squad.filter(u => u.destroyed).length
  }
  const sq = team.tier === 1 ? 'LL0' : team.tier === 2 ? 'LL5' : 'LL10'
  console.log(`${team.id.padEnd(28)} vs ${sq}  player win ${wins}/${N}  avg rounds ${(rounds / N).toFixed(1)}  mechs lost/fight ${(lost / N).toFixed(1)}`)
}
