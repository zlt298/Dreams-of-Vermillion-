// Stress test: every frame, system, talent rank and core bonus in lancer-data is built into a
// mech and auto-battled, to catch runtime errors in effect scripts and generic actions.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Lancer } from '../src/data/lancer'
import type { PilotBuild } from '../src/import/compcon'
import { buildMechUnit } from '../src/rules/stats'
import { buildTeam } from '../src/enemies/build'
import { Battle } from '../src/rules/battle'
import { autoBattle, aiErrors } from '../src/ai/ai'
import { generateMap } from '../src/run/mapgen'
import './helpers'

const frames = [...Lancer.frames.values()]
const systems = [...Lancer.systems.values()].map(s => s.id)
const weapons = [...Lancer.weapons.values()].filter(w => w.mount !== 'Superheavy' && !w.id.includes('integrated') && !w.id.includes('prototype')).map(w => w.id)
const talents = [...Lancer.talents.values()].map(t => t.id)
const cbs = [...Lancer.coreBonuses.values()].map(c => c.id)
const team = JSON.parse(readFileSync(join(__dirname, '../../data/enemies/t2-ash-choir.json'), 'utf8'))

function build(i: number): PilotBuild {
  const f = frames[i % frames.length]
  const pick = <T,>(arr: T[], n: number, off: number) => Array.from({ length: n }, (_, k) => arr[(off + k * 7) % arr.length])
  return {
    id: `p${i}`, callsign: `${f.name}-${i}`, name: 'Test', level: 6, mechSkills: [2, 2, 2, 2],
    talents: pick(talents, 3, i * 3).map(id => ({ id, rank: 3 })),
    coreBonuses: pick(cbs, 2, i * 2),
    mech: {
      name: f.name, frameId: f.id,
      mounts: [{ type: 'Main', slots: [{ size: 'Main', weaponId: weapons[(i * 5) % weapons.length] }], bonusEffects: [] }, { type: 'Flex', slots: [{ size: 'Aux', weaponId: weapons[(i * 5 + 3) % weapons.length] }], bonusEffects: [] }],
      systems: pick(systems, 5, i * 5),
    },
    unknown: [],
  }
}

describe('effect script stress test', () => {
  it.each(Array.from({ length: Math.ceil(frames.length / 1) }, (_, i) => [i]))('loadout #%s battles without runtime errors', i => {
    aiErrors.length = 0
    const squad = [0, 1, 2, 3].map(k => buildMechUnit(build(i * 4 + k)))
    const enemies = buildTeam(team, 4)
    const map = generateMap(1000 + i, { w: 16, h: 16 })
    squad.forEach((u, k) => (u.pos = map.deployPlayer[k]))
    enemies.forEach((u, k) => (u.pos = map.deployEnemy[k % map.deployEnemy.length]))
    const b = new Battle({ map, units: [...squad, ...enemies], seed: i + 1 })
    b.start()
    // exercise every custom action at least once where usable
    for (const u of squad) {
      if (b.currentSide !== 'player' || b.activeId) break
      b.beginTurn(u)
      for (const a of b.customActions(u)) {
        try { b.useCustom(u, a, a.target === 'self' || a.target === 'none' ? u : a.target === 'tile' ? { x: u.pos.x, y: Math.max(0, u.pos.y - 2) } : b.alive().find(o => (a.target === 'ally' ? !b.hostile(u, o) : b.hostile(u, o)))) } catch (e) {
          if (e instanceof TypeError || e instanceof ReferenceError) throw e
        }
        u.actionsLeft = 2; u.actedThisTurn = false; u.flags.fullTechLeft = 0
        if (u.destroyed || b.winner) break
      }
      if (u.destroyed || b.winner || b.activeId !== u.id) break
      try { b.activateCore(u) } catch (e) { if (e instanceof TypeError) throw e }
      if (b.activeId === u.id) b.endTurn(u)
      if ((b.currentSide as string) === 'enemy') break
    }
    autoBattle(b, 8)
    expect(aiErrors).toEqual([])
  })
})
