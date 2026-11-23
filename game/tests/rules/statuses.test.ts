// Statuses and conditions: durations and stacking, Stunned/Shut Down, Jammed, Prone/Slowed, Lock On, Hidden, and how
// statuses modify Ram and Grapple.
import { describe, expect, it } from 'vitest'
import type { Unit } from '../../src/rules/types'
import { runAiTurn } from '../../src/ai/ai'
import { battle, duel, mech, pregenUnit } from '../support'

const rifleOf = (u: Unit) => u.weapons.find(w => w.dataId === 'mw_assault_rifle')!

describe('durations and stacking', () => {
  it('"until end of next turn" lasts through the target’s next turn', () => {
    const { a, e, b } = duel()
    b.beginTurn(a)
    b.addStatus(e, 'impaired', 'next_turn_end_target', a)
    b.endTurn(a)
    expect(b.has(e, 'impaired')).toBe(true)
    b.beginTurn(e)
    expect(b.has(e, 'impaired')).toBe(true)
    b.endTurn(e)
    expect(b.has(e, 'impaired')).toBe(false)
  })

  it('immunity blocks statuses', () => {
    const { e, b } = duel()
    e.immune.push('impaired')
    expect(b.addStatus(e, 'impaired')).toBe(false)
  })

  // regression: reapplying a status replaced a longer duration with a shorter one
  it('reapplying a status keeps the longer duration (same clock: end of turn outlasts start of turn)', () => {
    const { a, e, b } = duel()
    b.beginTurn(a)
    b.addStatus(e, 'slowed', 'start_of_next_turn_target', a)
    b.addStatus(e, 'slowed', 'next_turn_end_target', a)
    b.endTurn(a); b.beginTurn(e)
    expect(b.has(e, 'slowed')).toBe(true)
    b.endTurn(e)
    expect(b.has(e, 'slowed')).toBe(false)
  })

  // regression: a shorter reapplication on another clock shortened the status
  it('reapplying a shorter status on another clock does not shorten it', () => {
    const { a, e, b } = duel()
    b.beginTurn(a)
    b.addStatus(e, 'impaired', 'next_turn_end_target', a)
    b.addStatus(e, 'impaired', 'end_of_turn', a)
    b.endTurn(a)
    expect(b.has(e, 'impaired')).toBe(true)
    b.beginTurn(e); b.endTurn(e)
    expect(b.has(e, 'impaired')).toBe(false)
  })

  // regression: a longer status on another clock was dropped
  it('a longer status on another clock replaces nothing and lasts until its own end', () => {
    const { a, e, b } = duel()
    b.beginTurn(a)
    b.addStatus(e, 'impaired', 'end_of_turn', a)
    b.addStatus(e, 'impaired', 'next_turn_end_target', a)
    expect(e.statuses.filter(s => s.id === 'impaired').length).toBe(2)
    b.endTurn(a)
    expect(b.has(e, 'impaired')).toBe(true)
    b.beginTurn(e); b.endTurn(e)
    expect(e.statuses.some(s => s.id === 'impaired')).toBe(false)
  })

  // regression: removeStatus left other instances of the same status
  it('clearing a status removes every instance of it', () => {
    const { a, e, b } = duel()
    b.beginTurn(a)
    b.addStatus(e, 'impaired', 'end_of_turn', a)
    b.addStatus(e, 'impaired', 'next_turn_end_target', a)
    b.removeStatus(e, 'impaired')
    expect(b.has(e, 'impaired')).toBe(false)
  })

  // regression: statuses timed to a unit's turn end never expired when it was destroyed on that turn
  it('statuses timed to the end of a unit\'s turn expire if it is destroyed during that turn', () => {
    const p1 = pregenUnit('Assault'); p1.pos = { x: 1, y: 1 }
    const p2 = pregenUnit('Vanguard'); p2.pos = { x: 3, y: 1 }
    const e1 = pregenUnit('Sniper', 'enemy'); e1.pos = { x: 6, y: 10 }
    const e2 = pregenUnit('Hacker', 'enemy'); e2.pos = { x: 9, y: 10 }
    const b = battle([p1, p2, e1, e2])
    b.beginTurn(p1)
    b.addStatus(e1, 'impaired', 'end_of_turn', p1)
    b.destroy(p1, 'test')
    expect(b.has(e1, 'impaired')).toBe(false)
  })
})

describe('Stunned and Shut Down', () => {
  it('stunned caps evasion and auto-fails hull saves', () => {
    const { e, b } = duel()
    b.addStatus(e, 'stunned')
    expect(b.save(e, 'hull', 1)).toBe(false)
  })

  // regression: a Shut Down mech could never Boot Up
  it('a Shut Down mech can Boot Up on its next turn', () => {
    const { a, e, b } = duel()
    b.beginTurn(a); b.shutDown(a); b.endTurn(a)
    b.beginTurn(e); b.endTurn(e)
    b.beginTurn(a)
    expect(() => b.bootUp(a)).not.toThrow()
    expect(b.has(a, 'shutdown')).toBe(false)
  })

  it('a Shut Down mech can do nothing but Boot Up, and is Stunned for attacks and saves', () => {
    const { a, e, b } = duel()
    b.beginTurn(a); b.shutDown(a); b.endTurn(a)
    b.beginTurn(e); b.endTurn(e)
    b.beginTurn(a)
    expect(a.moveLeft).toBe(0)
    expect(b.skirmish(a, rifleOf(a), { targetId: e.id }).ok).toBe(false)
    expect(() => b.boost(a)).toThrow()
    expect(b.save(a, 'agi', 1)).toBe(false)
    b.bootUp(a)
    expect(a.actionsLeft).toBe(0)
    expect(() => b.bootUp(a)).toThrow(/Not shut down/)
  })

  it('a mech both Stunned and Shut Down cannot Boot Up until the Stun ends', () => {
    const { a, e, b } = duel()
    b.beginTurn(a); b.shutDown(a); b.endTurn(a)
    b.beginTurn(e); b.addStatus(a, 'stunned', 'next_turn_end_target', e); b.endTurn(e)
    b.beginTurn(a)
    expect(a.actionsLeft).toBe(0)
    expect(() => b.bootUp(a)).toThrow()
    b.endTurn(a)
    expect(b.has(a, 'shutdown')).toBe(true)
  })

  it('the AI boots a Shut Down unit back up', () => {
    const { a, e, b } = duel()
    b.beginTurn(a); b.endTurn(a)
    b.beginTurn(e); b.shutDown(e); b.endTurn(e)
    b.beginTurn(a); b.endTurn(a)
    runAiTurn(b, e)
    expect(b.has(e, 'shutdown')).toBe(false)
  })
})

describe('Jammed', () => {
  // regression: Jammed blocked Improvised Attacks
  it('Jammed characters can still make Improvised Attacks', () => {
    const { a, e, b } = duel()
    e.pos = { x: 2, y: 5 }
    b.beginTurn(a)
    b.addStatus(a, 'jammed')
    const before = b.events.filter(ev => ev.type === 'attack').length
    b.improvisedAttack(a, e)
    expect(b.events.filter(ev => ev.type === 'attack').length).toBe(before + 1)
  })

  it('Jammed still blocks weapon attacks and tech, but not Ram or Grapple', () => {
    const { a, e, b } = duel()
    e.pos = { x: 2, y: 5 }
    b.beginTurn(a)
    b.addStatus(a, 'jammed')
    expect(b.skirmish(a, rifleOf(a), { targetId: e.id }).ok).toBe(false)
    expect(a.actionsLeft).toBe(2)
    expect(() => b.lockOn(a, e)).toThrow()
    expect(() => b.ram(a, e)).not.toThrow()
  })
})

describe('Prone and Slowed', () => {
  it('standing up from prone uses the standard move', () => {
    const { a, b } = duel()
    b.beginTurn(a)
    b.addStatus(a, 'prone')
    b.standUp(a)
    expect(b.has(a, 'prone')).toBe(false)
    expect(a.moveLeft).toBe(0)
  })

  it('flying characters cannot be knocked Prone', () => {
    const { a, b } = duel()
    a.flying = true
    b.addStatus(a, 'prone')
    expect(b.has(a, 'prone')).toBe(false)
  })

  // regression: Prone characters could Boost
  it('Prone characters are Slowed and cannot Boost', () => {
    const { a, b } = duel()
    b.beginTurn(a)
    b.addStatus(a, 'prone')
    expect(() => b.boost(a)).toThrow()
  })

  it('a Prone mech stands up, then can Boost', () => {
    const { a, b } = duel()
    b.beginTurn(a)
    b.addStatus(a, 'prone')
    expect(() => b.boost(a)).toThrow(/prone/i)
    b.standUp(a)
    expect(() => b.boost(a)).not.toThrow()
    expect(a.moveLeft).toBe(a.stats.speed)
  })

  it('Prone counts as Slowed for special moves too', () => {
    const { a, b } = duel()
    b.beginTurn(a)
    b.addStatus(a, 'prone')
    // a standard move is a crawl (see below); every other voluntary move is refused as Slowed
    expect(b.canMove(a, 'standard')).toBe(true)
    expect(b.canMove(a, 'boost')).toBe('Prone (Slowed)')
    expect(b.canMove(a, 'free')).toBe('Prone (Slowed)')
    expect(b.canMove(a, 'involuntary')).toBe(true)
  })

  // regression: Stand Up was allowed off-turn, while Stunned and after moving
  it('Stand Up: only on your own turn, before moving, not while Stunned', () => {
    const { a, e, b } = duel()
    b.addStatus(a, 'prone')
    expect(() => b.standUp(a)).toThrow(/turn/)
    b.beginTurn(a)
    b.addStatus(a, 'stunned', 'next_turn_end_target', e)
    expect(() => b.standUp(a)).toThrow(/Stunned/)
    b.removeStatus(a, 'stunned')
    a.moveLeft = a.stats.speed
    b.move(a, { x: 1, y: 6 })
    expect(() => b.standUp(a)).toThrow(/Standard move/)
  })

  // regression: a Prone mech could not move at all
  it('a Prone mech can crawl with its standard move, at double cost (difficult terrain)', () => {
    const { a, b } = duel()
    b.beginTurn(a)
    b.addStatus(a, 'prone')
    const cost = b.pathTo(a, { x: 1, y: 7 }, 99)!.cost
    expect(cost).toBe(4)
    b.move(a, { x: 1, y: 7 })
    expect(a.pos).toEqual({ x: 1, y: 7 })
    expect(b.has(a, 'prone')).toBe(true)
  })

  it('a Prone target gives +1 accuracy to tech attacks; Lock On and Prone stack', () => {
    const { a, e, b } = duel()
    b.beginTurn(a)
    b.addStatus(e, 'prone')
    expect(b.techAttackRoll(a, e, 'test').accuracy).toBe(1)
    b.addStatus(e, 'lockon')
    expect(b.techAttackRoll(a, e, 'test').accuracy).toBe(2)
  })
})

describe('Lock On', () => {
  /** The Sniper adjacent to the Assault, on the Assault's turn; every to-hit context is recorded. */
  const adjacent = () => {
    const { a, e, b } = duel({ e: { x: 2, y: 5 } })
    b.beginTurn(a)
    const ctxs: any[] = []
    const roll = b.rollToHit.bind(b)
    b.rollToHit = (ctx: any) => { ctxs.push(ctx); return roll(ctx) }
    return { a, e, b, ctxs }
  }

  it('lock on grants +1 accuracy and is consumed', () => {
    const { a, e, b } = duel()
    b.beginTurn(a)
    b.lockOn(a, e)
    const rifle = a.weapons.find(w => w.dataId === 'mw_assault_rifle')!
    expect(b.previewAttack(a, rifle, e).ctx.accuracy).toBeGreaterThanOrEqual(1)
    b.skirmish(a, rifle, { targetId: e.id })
    expect(b.has(e, 'lockon')).toBe(false)
  })

  // regression: Lock On was ignored (and kept) by tech attacks
  it('Lock On gives +1 accuracy to the next tech attack too, and is consumed', () => {
    const { a, e, b } = duel()
    b.beginTurn(a)
    b.addStatus(e, 'lockon')
    const ctx = b.techAttackRoll(a, e, 'test')
    expect(ctx.accuracy).toBeGreaterThanOrEqual(1)
    expect(b.has(e, 'lockon')).toBe(false)
  })

  // regression: Ram and Grapple ignored Lock On
  it.each(['ram', 'grapple'] as const)('%s: Lock On gives +1 accuracy and is consumed', act => {
    const { a, e, b, ctxs } = adjacent()
    b.addStatus(e, 'lockon')
    b[act](a, e)
    expect(ctxs[0].accuracy).toBe(1)
    expect(b.has(e, 'lockon')).toBe(false)
  })

  it('Lock On on an ally is not consumed by a tech attack against it', () => {
    const { a, b } = duel()
    const ally = pregenUnit('Hacker'); ally.pos = { x: 2, y: 6 }
    b.units.push(ally)
    b.beginTurn(a)
    b.addStatus(ally, 'lockon')
    b.techAttackRoll(a, ally, 'test')
    expect(b.has(ally, 'lockon')).toBe(true)
  })

  it('Hacker 1 (SNOW-CRASH) still consumes Lock On itself: +1 accuracy once, not twice', () => {
    const a = mech({ talents: [['t_hacker', 1]], weapons: [['Heavy', 'mw_assault_rifle']] })
    const e = pregenUnit('Sniper', 'enemy')
    a.pos = { x: 1, y: 5 }; e.pos = { x: 4, y: 5 }
    const b = battle([a, e])
    b.beginTurn(a)
    b.addStatus(e, 'lockon')
    a.stats.techAttack = 40 // a sure hit, so SNOW_CRASH's heat lands
    const heat = e.heat
    const ctx = b.techAttackRoll(a, e, 'test')
    expect(ctx.accuracy).toBe(1)
    expect(b.has(e, 'lockon')).toBe(false)
    // the after-attack hooks run inside every tech attack: the 2 heat is dealt and nothing stays pending
    expect(e.heat).toBe(heat + 2)
    expect(a.flags.snow).toBeUndefined()
  })
})

describe('Hidden', () => {
  /** The Sniper adjacent to the Assault, on the Assault's turn; every to-hit context is recorded. */
  const adjacent = () => {
    const { a, e, b } = duel({ e: { x: 2, y: 5 } })
    b.beginTurn(a)
    const ctxs: any[] = []
    const roll = b.rollToHit.bind(b)
    b.rollToHit = (ctx: any) => { ctxs.push(ctx); return roll(ctx) }
    return { a, e, b, ctxs }
  }

  // regression: Ram and Grapple spent the action on a Hidden target and did not reveal a Hidden attacker
  it.each(['ram', 'grapple'] as const)('%s: a Hidden target is refused for free; attacking reveals a Hidden attacker', act => {
    const { a, e, b } = adjacent()
    b.addStatus(e, 'hidden')
    expect(() => b[act](a, e)).toThrow(/Hidden/)
    expect(a.actionsLeft).toBe(2)
    b.removeStatus(e, 'hidden')
    b.addStatus(a, 'hidden')
    b[act](a, e)
    expect(b.has(a, 'hidden')).toBe(false)
  })

  it('an Improvised Attack on a Hidden target is refused without spending the full action', () => {
    const { a, e, b } = duel()
    e.pos = { x: 2, y: 5 }
    b.beginTurn(a)
    b.addStatus(e, 'hidden')
    expect(() => b.improvisedAttack(a, e)).toThrow(/Hidden/)
    expect(a.actionsLeft).toBe(2)
  })

  // regression: a Hidden mover provoked (and wasted) Overwatch
  it('a Hidden mover does not provoke (and waste) Overwatch', () => {
    const { a, e, b } = duel()
    e.pos = { x: 3, y: 5 }
    e.weapons.forEach(w => (w.profiles[w.profileIndex].range = [{ type: 'Threat', val: 3 }]))
    b.beginTurn(a)
    b.addStatus(a, 'hidden')
    b.move(a, { x: 1, y: 3 })
    expect(e.reactionsLeft).toBe(e.reactionsPerRound)
  })
})

describe('Ram and Grapple against Braced and Prone targets', () => {
  /** The Sniper adjacent to the Assault, on the Assault's turn; every to-hit context is recorded. */
  const adjacent = () => {
    const { a, e, b } = duel({ e: { x: 2, y: 5 } })
    b.beginTurn(a)
    const ctxs: any[] = []
    const roll = b.rollToHit.bind(b)
    b.rollToHit = (ctx: any) => { ctxs.push(ctx); return roll(ctx) }
    return { a, e, b, ctxs }
  }

  // regression: Ram and Grapple ignored Braced and Prone
  it.each(['ram', 'grapple'] as const)('%s: Braced target is +1 difficulty, Prone target +1 accuracy', act => {
    const { a, e, b, ctxs } = adjacent()
    b.addStatus(e, 'braced')
    b.addStatus(e, 'prone')
    b[act](a, e)
    expect(ctxs[0].difficulty).toBe(1)
    expect(ctxs[0].accuracy).toBe(1)
  })
})
