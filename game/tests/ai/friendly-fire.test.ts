// The AI never hits its own side: area attacks are aimed away from allies, and a plan aimed from a tile the unit
// never reached is re-planned rather than fired.
import { describe, expect, it } from 'vitest'
import { importPilots } from '../../src/import/compcon'
import { buildMechUnit } from '../../src/rules/stats'
import { chebyshev } from '../../src/rules/grid'
import { buildTeam } from '../../src/enemies/build'
import { generateMap } from '../../src/run/mapgen'
import { Battle } from '../../src/rules/battle'
import { autoBattle, planFor, runAiTurn } from '../../src/ai/ai'
import themed from '../../src/data/squads/themed.json'
import ll5 from '../../src/data/squads/ll5.json'
import { arena, battle, flatMap, mech, pregenUnit, teamFile } from '../support'

/** Every attack event whose attacker and target are on the same side. */
function watchFriendlyFire(b: Battle) {
  const friendly: string[] = []
  ;(b as any).listeners.push((ev: any) => {
    if (ev.type !== 'attack') return
    const a = b.unit(ev.attackerId), t = b.unit(ev.targetId)
    if (a && t && a.side === t.side) friendly.push(`round ${b.round}: ${a.name} → ${t.name} (${ev.weapon})`)
  })
  return friendly
}

describe('AI friendly fire: Jackhammer Round', () => {
  // regression: aiTarget counted only hostiles around the impact, so it picked the tile next to an ally
  it('the AI does not aim Jackhammer Round next to its own ally (2 kinetic + knockback 2 to every adjacent character)', () => {
    const pilots = (themed as any[]).find(s => s.id === 'longguns-ll2').pilots
    const thresh = buildMechUnit(structuredClone(pilots.find((p: any) => p.callsign === 'Thresh')))
    const ally = pregenUnit('Assault')
    const e1 = pregenUnit('Sniper', 'enemy'), e2 = pregenUnit('Hacker', 'enemy')
    thresh.pos = { x: 6, y: 10 }
    e1.pos = { x: 5, y: 4 }; e2.pos = { x: 7, y: 4 } // the best impact for two hostiles is (6,4)...
    ally.pos = { x: 6, y: 5 } // ...where the lancer's own ally stands adjacent
    const b = battle([thresh, ally, e1, e2], flatMap(14, 14))
    b.beginTurn(thresh)
    const jack = b.customActions(thresh).find(a => a.key === 'jackhammer')!
    expect(jack).toBeTruthy()
    const aim = jack.aiTarget!(b, thresh) as { x: number; y: number } | null
    expect(aim && chebyshev(aim, ally.pos) === 1).toBeFalsy()
  })
})

describe('AI: a move that fails is re-planned', () => {
  // regression: when the move failed, the AI still fired the attacks it had aimed from the planned tile
  it('an AI immobilized as it moves does not fire its planned Line attack through an ally from where it stands', () => {
    const ai = mech({ weapons: [['Heavy', 'mw_thermal_lance']] }, 'enemy') // Line 10
    const ally = pregenUnit('Sniper', 'enemy')
    const foe = pregenUnit('Assault')
    // the ally stands on the straight line from the AI to its target, so the plan steps aside to shoot past it
    const b = arena([[ai, { x: 5, y: 1 }], [ally, { x: 5, y: 4 }], [foe, { x: 5, y: 8 }]])
    b.currentSide = 'enemy'; foe.activationsLeft = 0
    b.beginTurn(ai)
    const plan = planFor(b, ai)
    expect(plan.dest).not.toEqual({ x: 5, y: 1 })
    expect(plan.actions.some(o => o.kind === 'skirmish')).toBe(true)
    // something Immobilizes it just as it sets off (as a protocol or a reaction can): the move is refused
    const move = b.move.bind(b)
    b.move = ((u, dest, opts) => {
      if (u === ai) b.addStatus(ai, 'immobilized', 'end_of_turn')
      return move(u, dest, opts)
    }) as Battle['move']
    const friendly = watchFriendlyFire(b)
    runAiTurn(b, ai)
    expect(ai.pos).toEqual({ x: 5, y: 1 }) // the move really failed
    expect(friendly).toEqual([])
    expect(ally.hp).toBe(ally.stats.hp)
  })

  // regression: as above, found by fuzzing whole battles on a generated map (seed 1007)
  it('re-plans when its move fails instead of firing an attack aimed from elsewhere (no friendly fire in a full battle)', () => {
    const map = generateMap(1007, { theme: 'industrial' })
    const players = (ll5 as any[]).map(p => buildMechUnit(importPilots(p)[0]))
    const enemies = buildTeam(teamFile('t1-checkpoint-garrison'), players.length)
    players.forEach((u, k) => (u.pos = map.deployPlayer[k]))
    enemies.forEach((u, k) => (u.pos = map.deployEnemy[k % map.deployEnemy.length]))
    const b = new Battle({ map, units: [...players, ...enemies], seed: 1007 })
    b.start()
    const friendly = watchFriendlyFire(b)
    autoBattle(b, 12)
    expect(friendly).toEqual([])
  })
})
