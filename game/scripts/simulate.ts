// Balance sim: AI vs AI. Tier 1 teams face the LL0 COMP/CON pregens, tier 2 the LL3 sample squad,
// tier 3 the LL6 sample squad.  npx tsx scripts/simulate.ts [N] [team-id-filter]
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildTeam } from '../src/enemies/build'
import { autoBattle } from '../src/ai/ai'
import { Battle } from '../src/rules/battle'
import { importPilots } from '../src/import/compcon'
import { buildMechUnit } from '../src/rules/stats'
import { generateMap } from '../src/run/mapgen'
import pregens from '../src/data/pregens/pregens.json'
import ll3 from '../src/data/squads/ll3.json'
import ll6 from '../src/data/squads/ll6.json'
import '../src/rules/effects/scripts'

const N = Number(process.argv[2] ?? 6)
const filter = process.argv[3]
const squads: Record<number, any[]> = {
  1: ['Vanguard', 'Assault', 'Sniper', 'Fire Support'].map(n => (pregens as any[]).find(p => p.name === n)),
  2: ll3 as any[],
  3: ll6 as any[],
}
const dir = resolve(import.meta.dirname, '../../data/enemies')
for (const f of readdirSync(dir).filter(f => f.endsWith('.json'))) {
  const team = JSON.parse(readFileSync(join(dir, f), 'utf8'))
  if (filter && !team.id.includes(filter)) continue
  let wins = 0, rounds = 0, lost = 0
  for (let s = 1; s <= N; s++) {
    const squad = squads[team.tier].map(raw => buildMechUnit(importPilots(raw)[0]))
    const enemies = buildTeam(team, 4)
    const map = generateMap(s * 977, { w: 18, h: 18 })
    squad.forEach((u, i) => (u.pos = map.deployPlayer[i]))
    enemies.forEach((u, i) => (u.pos = map.deployEnemy[i % map.deployEnemy.length]))
    const b = new Battle({ map, units: [...squad, ...enemies], seed: s })
    b.start()
    autoBattle(b, Number(process.env.MAX_ROUNDS ?? 12))
    if (b.winner === 'player') wins++
    rounds += b.round
    lost += squad.filter(u => u.destroyed).length
  }
  const sq = team.tier === 1 ? 'LL0' : team.tier === 2 ? 'LL3' : 'LL6'
  console.log(`${team.id.padEnd(28)} vs ${sq}  player win ${wins}/${N}  avg rounds ${(rounds / N).toFixed(1)}  mechs lost/fight ${(lost / N).toFixed(1)}`)
}
