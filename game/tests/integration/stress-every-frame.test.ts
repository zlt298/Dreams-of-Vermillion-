// Stress test: every frame, system, talent rank and core bonus in lancer-data is built into a
// mech and auto-battled, to catch runtime errors in effect scripts and generic actions.
import { afterAll, describe, expect, it } from 'vitest'
import { Lancer } from '../../src/data/lancer'
import type { MountBuild } from '../../src/import/compcon'
import { buildMechUnit } from '../../src/rules/stats'
import { buildTeam } from '../../src/enemies/build'
import { Battle, PendingChoice } from '../../src/rules/battle'
import type { CustomAction } from '../../src/rules/effects/registry'
import type { Pos, Unit } from '../../src/rules/types'
import { autoBattle, aiErrors } from '../../src/ai/ai'
import { generateMap } from '../../src/run/mapgen'
import { act, pilot, teamFile } from '../support'

const frames = [...Lancer.frames.values()]
const systems = [...Lancer.systems.values()].map(s => s.id)
const weapons = [...Lancer.weapons.values()].filter(w => w.mount !== 'Superheavy' && !w.id.includes('integrated') && !w.id.includes('prototype')).map(w => w.id)
const talents = [...Lancer.talents.values()].map(t => t.id)
const cbs = [...Lancer.coreBonuses.values()].map(c => c.id)
const team = teamFile('t2-ash-choir')

function build(i: number) {
  const f = frames[i % frames.length]
  const pick = <T,>(arr: T[], n: number, off: number) => Array.from({ length: n }, (_, k) => arr[(off + k * 7) % arr.length])
  const mounts = [
    { type: 'Main', slots: [{ size: 'Main', weaponId: weapons[(i * 5) % weapons.length] }], bonusEffects: [] },
    { type: 'Flex', slots: [{ size: 'Aux', weaponId: weapons[(i * 5 + 3) % weapons.length] }], bonusEffects: [] },
  ] as MountBuild[]
  return pilot({
    frame: f.id, level: 6, callsign: `${f.name}-${i}`,
    talents: pick(talents, 3, i * 3).map(id => [id, 3] as [string, number]),
    coreBonuses: pick(cbs, 2, i * 2),
    weapons: mounts,
    systems: pick(systems, 5, i * 5),
  })
}

/** Targets to try for an action, best first: the AI's own pick, then the nearest units / tiles of the right kind. */
function targetsFor(b: Battle, u: Unit, a: CustomAction): (Unit | Pos | undefined)[] {
  if (a.target === 'self' || a.target === 'none') return [u]
  const ai = a.aiTarget?.(b, u) ?? undefined
  const dist = (p: Pos) => Math.max(Math.abs(p.x - u.pos.x), Math.abs(p.y - u.pos.y))
  if (a.target === 'tile') {
    const tiles: Pos[] = []
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const p = { x: u.pos.x + dx, y: u.pos.y + dy }
      if ((dx || dy) && p.x >= 0 && p.y >= 0 && p.x < b.map.w && p.y < b.map.h) tiles.push(p)
    }
    tiles.sort((p, q) => dist(p) - dist(q))
    return [...(ai ? [ai] : []), ...tiles.filter((_, k) => k % 6 === 0).slice(0, 4)]
  }
  const units = b.alive().filter(o => o !== u && (a.target === 'ally' ? !b.hostile(u, o) : a.target === 'enemy' ? b.hostile(u, o) : true))
  units.sort((p, q) => dist(p.pos) - dist(q.pos))
  return [...(ai ? [ai] : []), ...units.slice(0, 3), ...(a.target === 'enemy' ? [] : [u])]
}

/**
 * A rules refusal is a plain Error whose message is the reason (bad target, out of range, no line of sight...).
 * Anything else a usable action throws (TypeError, RangeError, ReferenceError...) is a crash and fails the test.
 * (PendingChoice is not raised outside a transaction, but would be a legitimate suspension.)
 */
function attempt(fn: () => void): 'ok' | 'refused' {
  try { fn(); return 'ok' } catch (e) {
    if (e instanceof PendingChoice) return 'refused'
    if (e instanceof Error && e.constructor === Error) return 'refused'
    throw e
  }
}

let ranTotal = 0, refusedTotal = 0
describe('effect script stress test', () => {
  afterAll(() => {
    // most usable actions find a target that works: an action refused for every target tried is the exception
    expect(ranTotal).toBeGreaterThan(refusedTotal * 3)
  })

  it.each(Array.from({ length: frames.length }, (_, i) => [i]))('loadout #%s battles without runtime errors', i => {
    const squad = [0, 1, 2, 3].map(k => buildMechUnit(build(i * 4 + k)))
    const enemies = buildTeam(team, 4)
    const map = generateMap(1000 + i, { w: 16, h: 16 })
    squad.forEach((u, k) => (u.pos = map.deployPlayer[k]))
    enemies.forEach((u, k) => (u.pos = map.deployEnemy[k % map.deployEnemy.length]))
    const b = new Battle({ map, units: [...squad, ...enemies], seed: i + 1 })
    b.start()
    // every squad mech takes a turn and tries each custom action it can use and pay for, each from the same fresh
    // start of its turn (a checkpoint, not a hand reset of the action economy); then its core power; then ends its turn
    let turns = 0, ran = 0
    const refused: string[] = []
    for (const u of squad) {
      expect(u.destroyed, `${u.name} destroyed before its turn`).toBe(false)
      act(b, u)
      expect(b.activeId).toBe(u.id)
      turns++
      const fresh = b.checkpoint()
      for (const a of b.customActions(u)) {
        if (a.usable(b, u) !== true) continue
        const cost = a.activation === 'quick_tech' ? 'quick' : a.activation === 'full_tech' ? 'full' : a.activation
        if (b.canSpend(u, cost as any) !== true) continue
        // usable and affordable: no target may crash it, and (across the suite) most find a target that works
        let worked = false
        for (const t of targetsFor(b, u, a)) {
          worked = attempt(() => b.useCustom(u, a, t)) === 'ok'
          fresh()
          if (worked) break
        }
        if (worked) ran++
        else refused.push(a.name)
      }
      // the turn is fresh, so an available core power can be paid for: it must activate
      if (u.coreAvailable) expect(attempt(() => b.activateCore(u))).toBe('ok')
      expect(b.winner).toBeNull()
      if (b.activeId === u.id) b.endTurn(u)
    }
    expect(turns).toBe(squad.length)
    expect(ran, `no custom action ran (refused: ${refused.join(', ')})`).toBeGreaterThan(0)
    ranTotal += ran; refusedTotal += refused.length
    autoBattle(b, 8)
    expect(aiErrors).toEqual([])
  })
})
