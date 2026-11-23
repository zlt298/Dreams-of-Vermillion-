// Small helpers shared by the gear tests, built on the toolkit in tests/support.
import type { Battle } from '../../src/rules/battle'
import type { GridMap } from '../../src/rules/grid'
import type { MountBuild } from '../../src/import/compcon'
import type { Pos, Unit } from '../../src/rules/types'
import { act, arena, flatMap, pregenUnit } from '../support'

/** The unit's custom action (from a frame, system, talent...) whose name or key matches. */
export function custom(b: Battle, u: Unit, re: RegExp) {
  const x = b.customActions(u).find(c => re.test(c.name) || re.test(c.key))
  if (!x) throw new Error(`no action ${re}: ${b.customActions(u).map(c => c.name).join(', ')}`)
  return x
}

/** The unit's weapon with this data id. */
export const weapon = (u: Unit, id: string) => u.weapons.find(w => w.dataId === id)!
/** The unit's first working non-tech weapon. */
export const gun = (u: Unit) => u.weapons.find(w => !w.destroyed && !w.tech)!

export const toEnemyTurn = (b: Battle, a: Unit, e: Unit) => { b.endTurn(a); b.beginTurn(e) }

/** One mount holding one weapon (and optionally a mod). */
export const slot = (size: string, weaponId: string, modId?: string): MountBuild =>
  ({ type: size, slots: [modId ? { size, weaponId, modId } : { size, weaponId }], bonusEffects: [] })

/**
 * The usual gear scenario: `a` (already built) against a pregen Assault enemy, on a 16×16 map, seed 13,
 * `a` at (5,4) and the enemy at (5,8), with `a`'s turn begun. `enemy` overrides the enemy's stats.
 */
export function vs(a: Unit, o: { a?: Pos; e?: Pos; map?: GridMap; seed?: number; enemy?: Partial<Unit['stats']> } = {}) {
  const e = pregenUnit('Assault', 'enemy')
  Object.assign(e.stats, o.enemy ?? {})
  const b = arena([[a, o.a ?? { x: 5, y: 4 }], [e, o.e ?? { x: 5, y: 8 }]], { map: o.map ?? flatMap(16, 16), seed: o.seed ?? 13 })
  act(b, a)
  return { a, e, b }
}

