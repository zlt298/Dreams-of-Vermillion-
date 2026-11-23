// Tech actions: Invade, quick tech repeats, Bolster, Biological immunity, invading a willing ally.
import { describe, expect, it } from 'vitest'
import type { GridMap } from '../../src/rules/grid'
import { duel, pregenUnit } from '../support'

/** Assault at (5,5) beside the Sniper at (5,6), seed 3, with the Assault's turn begun. */
function besideDuel(map?: GridMap) {
  const d = duel({ a: { x: 5, y: 5 }, e: { x: 5, y: 6 }, seed: 3, map })
  d.b.beginTurn(d.a)
  return d
}

describe('tech', () => {
  it('invade deals 2 heat on a hit', () => {
    const { a, e, b } = duel()
    b.beginTurn(a)
    a.stats.techAttack = 30
    b.invade(a, e)
    expect(e.heat).toBe(2)
    expect(b.has(e, 'impaired')).toBe(true)
  })

  it('a second plain quick tech in a turn is refused', () => {
    const { a, e, b } = duel()
    b.beginTurn(a)
    b.lockOn(a, e)
    expect(() => b.lockOn(a, e)).toThrow(/already taken/)
  })

  it('quick tech can repeat with a different option, not the same one', () => {
    const { a, e, b } = duel()
    b.beginTurn(a)
    b.lockOn(a, e)
    expect(b.canQuickTech(a, 'lock_on')).not.toBe(true)
    expect(b.canQuickTech(a, 'scan')).toBe(true)
  })

  it('biological targets are immune to tech other than Scan and Lock On', () => {
    const { a, e, b } = duel()
    e.role = 'Biological' as any
    expect(b.techTargetValid(a, e, 'invade')).not.toBe(true)
    expect(b.techTargetValid(a, e, 'lock_on')).toBe(true)
  })

  // regression: Bolster ignored Jammed, Shut Down allies and self-targeting
  it('Bolster obeys the tech rules: not while Jammed, not on a Shut Down ally, not on yourself', () => {
    const { a, b } = duel()
    const ally = pregenUnit('Hacker'); ally.pos = { x: 2, y: 5 }
    b.units.push(ally)
    b.beginTurn(a)
    expect(() => b.bolster(a, a)).toThrow()
    b.addStatus(ally, 'shutdown')
    expect(() => b.bolster(a, ally)).toThrow(/shut down/)
    b.removeStatus(ally, 'shutdown')
    b.addStatus(a, 'jammed')
    expect(() => b.bolster(a, ally)).toThrow(/Jammed/)
    b.removeStatus(a, 'jammed')
    expect(() => b.bolster(a, ally)).not.toThrow()
  })

  it('succeeds automatically, deals no heat and is not an attack', () => {
    const { a, b } = besideDuel()
    const ally = pregenUnit('Hacker'); ally.pos = { x: 6, y: 5 }; b.units.push(ally)
    const heat = ally.heat
    const ctx = b.invadeRoll(a, ally, 'test')
    expect(ctx.hit).toBe(true)
    b.invade(a, ally)
    expect(ally.heat).toBe(heat)
    expect(b.events.filter(e => e.type === 'attack' && e.targetId === ally.id)).toHaveLength(0)
  })
})
