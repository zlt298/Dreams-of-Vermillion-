// Bonded talent: the Bondmate (a pilot chosen once; kept for the run).
import type { Battle } from '../../battle'
import type { Unit } from '../../types'

/** Make `m` the Bondmate of `u` (remembered by pilot id for the rest of a run). */
export function setBond(u: Unit, m: Unit) {
  u.flags.bondmate = m.id
  if (m.flags.pilotId) u.flags.bondmatePilot = m.flags.pilotId
}

/** The unit's Bondmate in this battle (an unbonded unit bonds with its nearest allied mech the first time it matters). */
export function bondmate(b: Battle, u: Unit): Unit | undefined {
  const pid = u.flags.bondmatePilot as string | undefined
  if (pid) {
    const m = b.units.find(o => o.flags.pilotId === pid)
    return m && !m.destroyed ? m : undefined
  }
  let m = b.unit(u.flags.bondmate)
  if (!m || m.destroyed) {
    if (u.flags.bondmate && m?.destroyed) return undefined
    m = b.alive().filter(o => o !== u && o.kind === 'mech' && !b.hostile(u, o)).sort((x, y) => b.distance(u, x) - b.distance(u, y))[0]
    if (m) setBond(u, m)
  }
  return m
}
