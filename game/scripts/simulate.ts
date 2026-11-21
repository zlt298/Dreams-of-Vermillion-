// Balance sim: pregen squad vs every enemy team, N seeds.  npx tsx scripts/simulate.ts [N]
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildTeam } from '../src/enemies/build'
import { autoBattle } from '../src/ai/ai'
import { Battle } from '../src/rules/battle'
import { importPilots } from '../src/import/compcon'
import { buildMechUnit } from '../src/rules/stats'
import { generateMap } from '../src/run/mapgen'
import pregens from '../src/data/pregens/pregens.json'
import '../src/rules/effects/scripts'

const N = Number(process.argv[2] ?? 6)
const dir = resolve(import.meta.dirname, '../../data/enemies')
for (const f of readdirSync(dir).filter(f => f.endsWith('.json'))) {
  const team = JSON.parse(readFileSync(join(dir, f), 'utf8'))
  let wins = 0, rounds = 0, lost = 0
  for (let s = 1; s <= N; s++) {
    const squad = ['Vanguard', 'Assault', 'Sniper', 'Fire Support'].map(n => { const p = importPilots((pregens as any[]).find(p => p.name === n))[0]; p.level = (team.tier - 1) * 3; return buildMechUnit(p) })
    const enemies = buildTeam(team, 4)
    const map = generateMap(s * 977, { w: 18, h: 18 })
    squad.forEach((u, i) => (u.pos = map.deployPlayer[i]))
    enemies.forEach((u, i) => (u.pos = map.deployEnemy[i % map.deployEnemy.length]))
    const b = new Battle({ map, units: [...squad, ...enemies], seed: s })
    b.start()
    autoBattle(b, 12)
    if (b.winner === 'player') wins++
    rounds += b.round
    lost += squad.filter(u => u.destroyed).length
  }
  console.log(`${team.id.padEnd(28)} LL${(team.tier - 1) * 3} player win ${wins}/${N}  avg rounds ${(rounds / N).toFixed(1)}  mechs lost/fight ${(lost / N).toFixed(1)}`)
}
