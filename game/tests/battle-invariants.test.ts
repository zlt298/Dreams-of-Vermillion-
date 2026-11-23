// Whole-battle invariants: the same seed replays the same battle, and no auto-battle leaves a unit
// in an impossible state (HP above max, negative stress, a destroyed unit still acting...).
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Battle } from '../src/rules/battle'
import { autoBattle, aiErrors } from '../src/ai/ai'
import { buildTeam } from '../src/enemies/build'
import { generateMap } from '../src/run/mapgen'
import { pregenUnit } from './helpers'

const team = JSON.parse(readFileSync(join(__dirname, '../../data/enemies/t1-checkpoint-garrison.json'), 'utf8'))

function setup(seed: number) {
  const squad = ['Vanguard', 'Assault', 'Sniper', 'Hacker'].map(n => pregenUnit(n))
  const enemies = buildTeam(team, 4)
  const map = generateMap(seed, { w: 16, h: 16 })
  squad.forEach((u, k) => (u.pos = map.deployPlayer[k]))
  enemies.forEach((u, k) => (u.pos = map.deployEnemy[k % map.deployEnemy.length]))
  // unit ids come from a global counter, so compare by index rather than id
  const b = new Battle({ map, units: [...squad, ...enemies], seed })
  b.start()
  return b
}
const snapshot = (b: Battle) => ({
  round: b.round,
  winner: b.winner,
  units: b.units.map(u => [u.name, u.hp, u.heat, u.structure, u.stress, u.destroyed, u.pos.x, u.pos.y]),
  log: b.log.length,
})

describe('battle invariants', () => {
  it('the same seed replays the same battle', () => {
    for (const seed of [3, 11]) {
      const x = setup(seed), y = setup(seed)
      autoBattle(x, 4); autoBattle(y, 4)
      expect(x.units.some(u => u.hp < u.stats.hp || u.destroyed)).toBe(true) // something actually happened
      expect(snapshot(y)).toEqual(snapshot(x))
    }
  })

  it.each([1, 2, 5, 8])('seed %s: auto-battle keeps every unit in a legal state', seed => {
    aiErrors.length = 0
    const b = setup(seed)
    autoBattle(b, 10)
    expect(aiErrors).toEqual([])
    for (const u of b.units) {
      expect(u.hp).toBeLessThanOrEqual(u.stats.hp)
      expect(u.hp).toBeGreaterThanOrEqual(0)
      expect(u.heat).toBeGreaterThanOrEqual(0)
      expect(u.structure).toBeGreaterThanOrEqual(0)
      expect(u.structure).toBeLessThanOrEqual(u.stats.structure)
      expect(u.stress).toBeGreaterThanOrEqual(0)
      expect(u.overshield).toBeGreaterThanOrEqual(0)
      expect(Number.isFinite(u.hp)).toBe(true)
      if (!u.destroyed) {
        expect(u.pos.x).toBeGreaterThanOrEqual(0)
        expect(u.pos.y).toBeGreaterThanOrEqual(0)
        expect(u.pos.x).toBeLessThan(b.map.w)
        expect(u.pos.y).toBeLessThan(b.map.h)
      }
    }
    // no two living units stand on the same tile
    const alive = b.units.filter(u => !u.destroyed && u.kind === 'mech')
    const tiles = alive.map(u => `${u.pos.x},${u.pos.y}`)
    expect(new Set(tiles).size).toBe(tiles.length)
    // a battle that ended has a side with nobody left, or a sitrep win
    if (b.winner) expect(['player', 'enemy']).toContain(b.winner)
  })

  it('previews never change the battle', () => {
    const b = setup(4)
    const a = b.units.find(u => u.side === 'player')!
    const foes = b.units.filter(u => u.side === 'enemy')
    b.beginTurn(a)
    const before = JSON.stringify(snapshot(b)) + b.rng.state + JSON.stringify(b.units.map(u => [u.flags, u.statuses]))
    for (const w of a.weapons) for (const t of foes) { b.previewAttack(a, w, t); b.previewDetail(a, w, t) }
    expect(JSON.stringify(snapshot(b)) + b.rng.state + JSON.stringify(b.units.map(u => [u.flags, u.statuses]))).toBe(before)
  })
})
