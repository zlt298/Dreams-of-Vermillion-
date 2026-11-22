// AI performance benchmark: average ms per AI turn.  npx tsx scripts/bench-ai.ts
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildTeam } from '../src/enemies/build'
import { runAiTurn, pickNextUnit } from '../src/ai/ai'
import { Battle } from '../src/rules/battle'
import { importPilots } from '../src/import/compcon'
import { buildMechUnit } from '../src/rules/stats'
import { generateMap } from '../src/run/mapgen'
import pregens from '../src/data/pregens/pregens.json'
import '../src/rules/effects/scripts'

const team = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../data/enemies/t1-scrapjaw-raiders.json'), 'utf8'))
const times: number[] = []
for (let s = 1; s <= 3; s++) {
  const squad = ['Vanguard', 'Assault', 'Sniper', 'Fire Support'].map(n => buildMechUnit(importPilots((pregens as any[]).find(p => p.name === n))[0]))
  const enemies = buildTeam(team, 4)
  const map = generateMap(s * 31)
  squad.forEach((u, i) => (u.pos = map.deployPlayer[i]))
  enemies.forEach((u, i) => (u.pos = map.deployEnemy[i]))
  const b = new Battle({ map, units: [...squad, ...enemies], seed: s })
  b.start()
  for (let i = 0; i < 40 && !b.winner; i++) {
    const u = pickNextUnit(b, b.currentSide as any)
    if (!u) break
    const t0 = performance.now()
    runAiTurn(b, u)
    times.push(performance.now() - t0)
  }
}
times.sort((a, b) => a - b)
console.log(`turns ${times.length}  mean ${(times.reduce((a, b) => a + b, 0) / times.length).toFixed(1)}ms  p50 ${times[times.length >> 1].toFixed(1)}ms  p95 ${times[Math.floor(times.length * 0.95)].toFixed(1)}ms  max ${times[times.length - 1].toFixed(1)}ms`)
