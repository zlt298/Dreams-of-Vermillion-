// The campaign map: act/layer structure, node links, sitrep wiring, and which enemy team a node fights.
import { describe, expect, it } from 'vitest'
import {
  newRun, availableNodes, recordBattle, squadUnits, chooseTeam, nodeTier, sitrepFor, ACTS, type RunState, type RunNode,
} from '../../src/run/run'
import { pregenPilots as squad } from '../support'

const bossOf = (run: RunState, act: number) => run.nodes.find(n => n.act === act && n.kind === 'boss')!

describe('campaign map', () => {
  const seeds = [1, 7, 42, 1234, 99999, 314159]

  it.each(seeds)('seed %s: three acts of six layers, one boss each, first layer all combat', seed => {
    const run = newRun(squad(), seed)
    for (let act = 1; act <= ACTS; act++) {
      const nodes = run.nodes.filter(n => n.act === act)
      expect(new Set(nodes.map(n => n.layer))).toEqual(new Set([0, 1, 2, 3, 4, 5]))
      expect(nodes.filter(n => n.kind === 'boss')).toHaveLength(1)
      expect(nodes.find(n => n.kind === 'boss')!.layer).toBe(5)
      expect(nodes.filter(n => n.layer === 0).every(n => n.kind === 'combat')).toBe(true)
      // the layer before the boss always offers a rest
      expect(nodes.some(n => n.layer === 4 && n.kind === 'rest')).toBe(true)
    }
  })

  it.each(seeds)('seed %s: edges only go one layer forward, ids are unique, every node is reachable', seed => {
    const run = newRun(squad(), seed)
    const byId = new Map(run.nodes.map(n => [n.id, n]))
    expect(byId.size).toBe(run.nodes.length)
    const order = (n: RunNode) => (n.act - 1) * 6 + n.layer
    for (const n of run.nodes) {
      expect(new Set(n.next).size).toBe(n.next.length)
      for (const id of n.next) {
        const m = byId.get(id)
        expect(m).toBeDefined()
        expect(order(m!)).toBe(order(n) + 1)
      }
      const isFinal = n.act === ACTS && n.kind === 'boss'
      expect(n.next.length > 0).toBe(!isFinal)
    }
    // BFS from the starting choices reaches every node, so no node is stranded
    const seen = new Set(availableNodes(run).map(n => n.id))
    const queue = [...seen]
    while (queue.length) for (const id of byId.get(queue.shift()!)!.next) if (!seen.has(id)) { seen.add(id); queue.push(id) }
    expect(seen.size).toBe(run.nodes.length)
  })

  it('is deterministic per seed', () => {
    expect(JSON.stringify(newRun(squad(), 77).nodes)).toBe(JSON.stringify(newRun(squad(), 77).nodes))
    expect(JSON.stringify(newRun(squad(), 77).nodes)).not.toBe(JSON.stringify(newRun(squad(), 78).nodes))
  })

  it('bosses fight standard combat; tiers follow the act', () => {
    const run = newRun(squad(), 5)
    for (let a = 1; a <= 3; a++) {
      expect(bossOf(run, a).sitrep).toBe('standard')
      expect(nodeTier(bossOf(run, a))).toBe(a)
    }
  })

  it('sitrepFor wires zones and targets through', () => {
    const map = { zones: [{ name: 'control', tiles: [{ x: 1, y: 1 }] }] }
    const n = (sitrep: any): RunNode => ({ id: 'x', act: 1, layer: 1, kind: 'combat', next: [], seed: 1, sitrep })
    expect(sitrepFor(n('control'), map).zone).toEqual([{ x: 1, y: 1 }])
    expect(sitrepFor(n('assassination'), map, 'boss1').targetId).toBe('boss1')
    expect(sitrepFor(n(undefined), map).id).toBe('standard')
  })

  it('availableNodes follows the cleared node', () => {
    const run = newRun(squad(), 5)
    expect(availableNodes(run).every(n => n.act === 1 && n.layer === 0)).toBe(true)
    const first = availableNodes(run)[0]
    recordBattle(run, first, squadUnits(run), true)
    expect(availableNodes(run).map(n => n.id)).toEqual(first.next)
  })
})

describe('team selection', () => {
  const teams = ['t1', 't2', 't3'].map(id => ({ id }) as any)
  it('is deterministic per node and avoids teams already beaten', () => {
    const run = newRun(squad(), 3)
    const n = availableNodes(run)[0]
    expect(chooseTeam(run, n, teams).id).toBe(chooseTeam(run, n, teams).id)
    run.nodes[0].cleared = true; run.nodes[0].teamId = 't1'
    run.nodes[1].cleared = true; run.nodes[1].teamId = 't2'
    for (const node of run.nodes.slice(2, 12)) expect(chooseTeam(run, node, teams).id).toBe('t3')
  })
  it('falls back to any team once all have been seen', () => {
    const run = newRun(squad(), 3)
    run.nodes.slice(0, 3).forEach((n, i) => { n.cleared = true; n.teamId = teams[i].id })
    expect(teams.map(t => t.id)).toContain(chooseTeam(run, run.nodes[5], teams).id)
  })
})
