// AI fixes found by the balance sim (themed squads vs the enemy teams)
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildMechUnit } from '../../src/rules/stats'
import { buildTeam } from '../../src/enemies/build'
import { planFor, stallRounds, pickNextUnit, runAiTurn } from '../../src/ai/ai'
import { Battle } from '../../src/rules/battle'
import { generateMap } from '../../src/run/mapgen'
// the Ghosts presets (removed from the game) are kept as a fixture: the fights these bugs were found in
import themed from '../fixtures/ghosts-squads.json'
import { battle, flatMap, pregenUnit } from '../helpers'

const ghost = (callsign: string, level = 10) => buildMechUnit(structuredClone((themed as any[]).find(s => s.theme === 'ghosts' && s.level === level).pilots.find((p: any) => p.callsign === callsign)))
const team = (id: string) => JSON.parse(readFileSync(join(import.meta.dirname, '../../../data/enemies', `${id}.json`), 'utf8'))

describe('AI found by the balance sim', () => {
  it('never plans tech actions against Biological targets (they are immune)', () => {
    const g = ghost('Glitch')
    const bugs = buildTeam(team('t3-regolith-stalkers'), 4).filter(u => u.role === 'Biological')
    g.pos = { x: 5, y: 5 }
    bugs.forEach((u, i) => (u.pos = { x: 3 + i, y: 8 }))
    const b = battle([g, ...bugs], flatMap(14, 14))
    b.beginTurn(g)
    const plan = planFor(b, g)
    const tech = plan.actions.filter(a => a.kind === 'invade' || (a.kind === 'custom' && /tech/.test(a.action.activation)))
    expect(tech).toEqual([])
  })

  it('stalemate pressure counts rounds without attacks, not log lines', () => {
    const a = pregenUnit('Assault'), e = pregenUnit('Sniper', 'enemy')
    a.pos = { x: 1, y: 1 }; e.pos = { x: 10, y: 10 }
    const b = battle([a, e], flatMap(12, 12))
    b.round = 20
    for (let i = 0; i < 2000; i++) b.say(`${a.name} uses Something.`, 'attack') // non-attack chatter, trimmed log
    expect(stallRounds(b)).toBe(17)
    b.lastAttackRound = 19
    expect(stallRounds(b)).toBe(0)
  })

  it('an unspent CORE does not pull a unit into the enemy blob', () => {
    // the fight where it was found: Ghosts (LL5) vs Gallowglass Company, seed 1, Wisp's round-2 turn
    const dest = (core: boolean) => {
      const squad = (themed as any[]).find(s => s.theme === 'ghosts' && s.level === 5).pilots.map((p: any) => buildMechUnit(structuredClone(p)))
      // the roster as it was when this was found (before the attrition roster trim)
      const foes = buildTeam(JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures/gallowglass-company-pre-trim.json'), 'utf8')), 4)
      const map = generateMap(977)
      squad.forEach((u: any, i: number) => (u.pos = map.deployPlayer[i]))
      foes.forEach((u, i) => (u.pos = map.deployEnemy[i % map.deployEnemy.length]))
      const b = new Battle({ map, units: [...squad, ...foes], seed: 1 })
      b.start()
      const wisp = squad.find((u: any) => u.name === 'Wisp')
      for (let g = 0; g < 200; g++) {
        const u = pickNextUnit(b, b.currentSide as 'player' | 'enemy')!
        if (u === wisp && b.round === 2) break
        runAiTurn(b, u)
      }
      wisp.coreAvailable = core
      b.beginTurn(wisp)
      const p = planFor(b, wisp)
      return Math.min(...foes.filter(f => !f.destroyed).map(f => Math.max(Math.abs(f.pos.x - p.dest.x), Math.abs(f.pos.y - p.dest.y))))
    }
    expect(dest(true)).toBeGreaterThanOrEqual(dest(false))
  })
})
