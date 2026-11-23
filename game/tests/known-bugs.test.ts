// Known rules-engine bugs, written as the behaviour LANCER requires.
// Each is marked `it.fails`: the suite stays green while the bug exists, and turns red when someone
// fixes it. That's the cue to drop `.fails` so the test becomes an ordinary regression test.
import { describe, expect, it } from 'vitest'
import { battle, flatMap, pregenUnit } from './helpers'

function duel() {
  const a = pregenUnit('Assault')
  const e = pregenUnit('Sniper', 'enemy')
  a.pos = { x: 1, y: 5 }
  e.pos = { x: 6, y: 5 }
  const b = battle([a, e], flatMap(12, 12))
  return { a, e, b }
}
const rifleOf = (a: ReturnType<typeof pregenUnit>) => a.weapons.find(w => w.dataId === 'mw_assault_rifle')!

describe('known bugs (core book rulings the engine gets wrong)', () => {
  it.fails('a Shut Down mech can Boot Up on its next turn (Shut Down counts as Stunned, which zeroes its actions)', () => {
    const { a, e, b } = duel()
    b.beginTurn(a); b.shutDown(a); b.endTurn(a)
    b.beginTurn(e); b.endTurn(e)
    b.beginTurn(a)
    expect(() => b.bootUp(a)).not.toThrow()
    expect(b.has(a, 'shutdown')).toBe(false)
  })

  it.fails('an invalid Skirmish costs nothing (the action is spent before the range check)', () => {
    const { a, e, b } = duel()
    e.pos = { x: 11, y: 11 }
    a.pos = { x: 0, y: 0 }
    b.beginTurn(a)
    const rifle = rifleOf(a)
    const r = b.skirmish(a, rifle, { targetId: e.id })
    expect(r.ok).toBe(false)
    expect(a.actionsLeft).toBe(2)
    expect(b.firedThisTurn(a, rifle)).toBe(false)
  })

  it.fails('Prone characters are Slowed and cannot Boost', () => {
    const { a, b } = duel()
    b.beginTurn(a)
    b.addStatus(a, 'prone')
    expect(() => b.boost(a)).toThrow()
  })

  it.fails('Jammed characters can still make Improvised Attacks', () => {
    const { a, e, b } = duel()
    e.pos = { x: 2, y: 5 }
    b.beginTurn(a)
    b.addStatus(a, 'jammed')
    const before = b.events.filter(ev => ev.type === 'attack').length
    b.improvisedAttack(a, e)
    expect(b.events.filter(ev => ev.type === 'attack').length).toBe(before + 1)
  })

  it.fails('Lock On gives +1 accuracy to the next tech attack too, and is consumed', () => {
    const { a, e, b } = duel()
    b.beginTurn(a)
    b.addStatus(e, 'lockon')
    const ctx = b.techAttackRoll(a, e, 'test')
    expect(ctx.accuracy).toBeGreaterThanOrEqual(1)
    expect(b.has(e, 'lockon')).toBe(false)
  })

  it.fails('a move that throws leaves the mover unchanged (a landed flyer is not put back in the air)', () => {
    const { a, b } = duel()
    b.beginTurn(a)
    a.flags.landed = true
    a.flying = false
    expect(() => b.move(a, { x: 11, y: 11 })).toThrow()
    expect(a.flying).toBe(false)
  })

  it.fails('when the last unit of a round burns to death, the next round starts with the players', () => {
    const p1 = pregenUnit('Assault'); p1.pos = { x: 1, y: 1 }
    const p2 = pregenUnit('Hacker'); p2.pos = { x: 3, y: 1 }
    const e = pregenUnit('Sniper', 'enemy'); e.pos = { x: 6, y: 10 }
    const b = battle([p1, p2, e])
    b.beginTurn(p1); b.endTurn(p1)
    b.beginTurn(e); b.endTurn(e)
    b.beginTurn(p2)
    p2.hp = 1; p2.structure = 1; p2.burn = 20; p2.stats.eng = -99
    b.endTurn(p2)
    expect(p2.destroyed).toBe(true)
    expect(b.round).toBe(2)
    expect(b.currentSide).toBe('player')
  })
})
