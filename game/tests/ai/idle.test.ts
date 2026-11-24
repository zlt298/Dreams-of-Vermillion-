// AI units left idle at the back of the map: cautious roles parked at the edge of a long-ranged squad's threat range,
// Supports anchored to an ally who was itself at the back, Loading main guns fired once a fight, and shots wasted on
// cover. Found by measuring, per NPC, activations without an attack or a meaningful move across every enemy team.
import { describe, expect, it } from 'vitest'
import { buildTeam } from '../../src/enemies/build'
import { planFor } from '../../src/ai/ai'
import type { Pos, Unit } from '../../src/rules/types'
import { battle, flatMap, pregenUnit, teamFile } from '../helpers'

const npc = (team: string, name: string) => {
  const u = buildTeam(teamFile(team), 4).find(x => x.name.replace(/ [A-Z]$/, '') === name)
  if (!u) throw new Error(`${name} not in ${team}`)
  return u
}
const squad = () => ['Vanguard', 'Assault', 'Sniper', 'Fire Support'].map(n => pregenUnit(n))
const cheb = (a: Pos, b: Pos) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))
const nearestFrom = (p: Pos, hostiles: Unit[]) => Math.min(...hostiles.map(h => cheb(p, h.pos)))
/** Plan `u`'s turn on the enemy side. */
const enemyPlan = (units: Unit[], u: Unit, round = 2, lastAttackRound = round - 1) => {
  const b = battle(units, flatMap(18, 36))
  b.currentSide = 'enemy'
  b.round = round
  b.lastAttackRound = lastAttackRound
  u.flags.lastAttackRound = lastAttackRound
  b.beginTurn(u)
  return { b, plan: planFor(b, u) }
}

describe('AI: no idling at the back', () => {
  it('a controller joins the fight its allies are in instead of waiting at the edge of the threat range', () => {
    // t1-checkpoint-garrison vs the pregens: the Acolyte sat at y 8 for rounds while its riflemen fought at y 21
    const players = squad()
    players.forEach((u, i) => (u.pos = { x: 4 + 3 * i, y: 33 }))
    const team = buildTeam(teamFile('t1-checkpoint-garrison'), 4)
    const acolyte = team.find(x => x.name === 'Choir Signals Acolyte')!
    const [r1, r2] = team.filter(x => x.name.startsWith('Choir Rifleman'))
    acolyte.pos = { x: 2, y: 8 }; r1.pos = { x: 4, y: 24 }; r2.pos = { x: 9, y: 24 }
    const { plan } = enemyPlan([...players, acolyte, r1, r2], acolyte)
    expect(nearestFrom(plan.dest, players)).toBeLessThanOrEqual(nearestFrom(acolyte.pos, players) - 4)
  })

  it('a lone ranged unit closes in once the fight has stalled, rather than waiting outside the threat range', () => {
    const players = squad()
    players.forEach((u, i) => (u.pos = { x: 4 + 3 * i, y: 34 }))
    const gunner = npc('t2-gallowglass-company', 'Gallowglass Gunner')
    gunner.pos = { x: 8, y: 9 }
    const { plan } = enemyPlan([...players, gunner], gunner, 4, 0)
    expect(nearestFrom(plan.dest, players)).toBeLessThanOrEqual(nearestFrom(gunner.pos, players) - 4)
  })

  it('reloads a Loading main gun even while its sidearm is loaded', () => {
    // Sun-Eye Longshot (Gauss Rifle: Loading, range 15; Carbine: range 8) fired the Gauss once a fight
    const p = pregenUnit('Assault')
    const longshot = npc('t1-hunter-cell', 'Sun-Eye Longshot')
    p.pos = { x: 8, y: 26 }; longshot.pos = { x: 8, y: 14 }
    const gauss = longshot.weapons.find(w => w.name === 'Gauss Rifle')!
    gauss.loaded = false
    const { plan } = enemyPlan([p, longshot], longshot)
    expect(plan.actions.map(a => a.kind)).toContain('stabilize')
  })

  it('a Support stays with the allies who are fighting, not the one hanging back', () => {
    const players = squad()
    players.forEach((u, i) => (u.pos = { x: 4 + 3 * i, y: 30 }))
    const team = buildTeam(teamFile('t1-scrapjaw-raiders'), 4)
    const patcher = team.find(x => x.name === 'Misprint Patcher')!
    const lobber = team.find(x => x.name === 'Misprint Lobber')!
    const foreman = team.find(x => x.name === 'Misprint Foreman')!
    foreman.pos = { x: 8, y: 24 }; lobber.pos = { x: 3, y: 4 }; patcher.pos = { x: 4, y: 6 }
    const { plan } = enemyPlan([...players, patcher, lobber, foreman], patcher)
    expect(cheb(plan.dest, foreman.pos)).toBeLessThanOrEqual(cheb(patcher.pos, foreman.pos) - 3)
  })

  it('does not fire its Loading rifle at cover it cannot destroy', () => {
    // a Laminar Sniper (range 18) alternated reloading and shooting a Jericho cover section 18 spaces away for
    // the rest of the fight, the mechs behind it one space out of reach
    const players = squad()
    const builder = players.find(u => u.systems.some(s => s.dataId === 'ms_pattern_a_jericho_deployable_cover'))!
    players.forEach((u, i) => (u.pos = { x: 4 + 3 * i, y: 34 }))
    const sniper = npc('t3-cleanroom-wardens', 'Laminar Sniper')
    sniper.pos = { x: builder.pos.x, y: 15 }
    const b = battle([...players, sniper], flatMap(18, 36))
    b.beginTurn(builder)
    b.useCustom(builder, b.customActions(builder).find(a => a.key === 'jericho')!, { x: builder.pos.x, y: 33 })
    b.endTurn(builder)
    const cover = b.alive().filter(u => u.kind === 'deployable')
    expect(cover.length).toBeGreaterThan(0)
    b.currentSide = 'enemy'
    b.beginTurn(sniper)
    sniper.moveLeft = 0 // pinned where only the cover is in reach
    const plan = planFor(b, sniper)
    const aims = plan.actions.flatMap(a => a.kind === 'skirmish' ? [a.aim.targetId] : a.kind === 'barrage' ? [a.a.aim.targetId, a.b?.aim.targetId] : [])
    for (const c of cover) expect(aims).not.toContain(c.id)
  })

  it('focuses fire on a target already down structure', () => {
    const fresh = pregenUnit('Assault'), hurt = pregenUnit('Assault')
    const striker = npc('t1-scrapjaw-raiders', 'Misprint Foreman')
    fresh.pos = { x: 7, y: 10 }; hurt.pos = { x: 9, y: 10 }; striker.pos = { x: 8, y: 11 }
    hurt.structure = hurt.stats.structure - 2
    const { plan } = enemyPlan([fresh, hurt, striker], striker)
    const aims = plan.actions.flatMap(a => a.kind === 'skirmish' ? [a.aim.targetId] : a.kind === 'barrage' ? [a.a.aim.targetId, a.b?.aim.targetId] : [])
    expect(aims.length).toBeGreaterThan(0)
    expect(aims).toContain(hurt.id)
    expect(aims).not.toContain(fresh.id)
  })
})

