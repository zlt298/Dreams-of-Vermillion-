// Regression tests for rules-engine bugs found in review, and combinations around each fix.
import { describe, expect, it } from 'vitest'
import type { PilotBuild } from '../src/import/compcon'
import { buildMechUnit } from '../src/rules/stats'
import { runAiTurn } from '../src/ai/ai'
import { battle, flatMap, pregenUnit } from './helpers'

function mech(talents: [string, number][], side: 'player' | 'enemy' = 'player') {
  const p = {
    id: `t-${Math.random()}`, callsign: 'Tester', name: 'T', level: 9, mechSkills: [2, 2, 2, 2],
    talents: talents.map(([id, rank]) => ({ id, rank })), coreBonuses: [],
    mech: { name: 'T', frameId: 'mf_standard_pattern_i_everest', mounts: [{ type: 'Heavy', slots: [{ size: 'Heavy', weaponId: 'mw_assault_rifle' }], bonusEffects: [] }], systems: [] },
    unknown: [],
  } as unknown as PilotBuild
  return buildMechUnit(p, side)
}

function duel() {
  const a = pregenUnit('Assault')
  const e = pregenUnit('Sniper', 'enemy')
  a.pos = { x: 1, y: 5 }
  e.pos = { x: 6, y: 5 }
  const b = battle([a, e], flatMap(12, 12))
  return { a, e, b }
}
const rifleOf = (a: ReturnType<typeof pregenUnit>) => a.weapons.find(w => w.dataId === 'mw_assault_rifle')!

describe('fixed: core book rulings the engine used to get wrong', () => {
  it('a Shut Down mech can Boot Up on its next turn', () => {
    const { a, e, b } = duel()
    b.beginTurn(a); b.shutDown(a); b.endTurn(a)
    b.beginTurn(e); b.endTurn(e)
    b.beginTurn(a)
    expect(() => b.bootUp(a)).not.toThrow()
    expect(b.has(a, 'shutdown')).toBe(false)
  })

  it('an invalid Skirmish costs nothing', () => {
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

  it('Prone characters are Slowed and cannot Boost', () => {
    const { a, b } = duel()
    b.beginTurn(a)
    b.addStatus(a, 'prone')
    expect(() => b.boost(a)).toThrow()
  })

  it('Jammed characters can still make Improvised Attacks', () => {
    const { a, e, b } = duel()
    e.pos = { x: 2, y: 5 }
    b.beginTurn(a)
    b.addStatus(a, 'jammed')
    const before = b.events.filter(ev => ev.type === 'attack').length
    b.improvisedAttack(a, e)
    expect(b.events.filter(ev => ev.type === 'attack').length).toBe(before + 1)
  })

  it('Lock On gives +1 accuracy to the next tech attack too, and is consumed', () => {
    const { a, e, b } = duel()
    b.beginTurn(a)
    b.addStatus(e, 'lockon')
    const ctx = b.techAttackRoll(a, e, 'test')
    expect(ctx.accuracy).toBeGreaterThanOrEqual(1)
    expect(b.has(e, 'lockon')).toBe(false)
  })

  it('a move that throws leaves the mover unchanged (a landed flyer is not put back in the air)', () => {
    const { a, b } = duel()
    b.beginTurn(a)
    a.flags.landed = true
    a.flying = false
    expect(() => b.move(a, { x: 11, y: 11 })).toThrow()
    expect(a.flying).toBe(false)
  })

  it('when the last unit of a round burns to death, the next round still starts (with the other side: turns keep alternating)', () => {
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
    expect(b.currentSide).toBe('enemy')
  })
})

describe('combinations around the fixes', () => {
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

  it('an invalid Barrage costs nothing; one valid weapon is enough to spend it', () => {
    const { a, e, b } = duel()
    a.pos = { x: 0, y: 0 }; e.pos = { x: 11, y: 11 }
    b.beginTurn(a)
    const [w1, w2] = a.weapons.filter(w => !b.isAoE(b.profile(w)) && w.size !== 'Superheavy')
    const r = b.barrage(a, { weapon: w1, aim: { targetId: e.id } }, { weapon: w2, aim: { targetId: e.id } })
    expect(r.ok).toBe(false)
    expect(a.actionsLeft).toBe(2)
    expect(b.firedThisTurn(a, w1) || b.firedThisTurn(a, w2)).toBe(false)
    e.pos = { x: 5, y: 0 } // in rifle range, out of melee reach
    const rifle = rifleOf(a)
    const other = a.weapons.find(w => w !== rifle && !b.isAoE(b.profile(w)) && b.validTarget(a, w, e) !== true)!
    const r2 = b.barrage(a, { weapon: other, aim: { targetId: e.id } }, { weapon: rifle, aim: { targetId: e.id } })
    expect(r2.ok).toBe(true)
    expect(a.actionsLeft).toBe(0)
  })

  it('a refused Skirmish leaves the quick action free for a valid one', () => {
    const { a, e, b } = duel()
    b.beginTurn(a)
    b.addStatus(e, 'hidden')
    expect(b.skirmish(a, rifleOf(a), { targetId: e.id }).ok).toBe(false)
    b.removeStatus(e, 'hidden')
    expect(b.skirmish(a, rifleOf(a), { targetId: e.id }).ok).toBe(true)
    expect(a.actionsLeft).toBe(1)
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

  it('an Improvised Attack on a Hidden target is refused without spending the full action', () => {
    const { a, e, b } = duel()
    e.pos = { x: 2, y: 5 }
    b.beginTurn(a)
    b.addStatus(e, 'hidden')
    expect(() => b.improvisedAttack(a, e)).toThrow(/Hidden/)
    expect(a.actionsLeft).toBe(2)
  })

  it('a Prone target gives +1 accuracy to tech attacks; Lock On and Prone stack', () => {
    const { a, e, b } = duel()
    b.beginTurn(a)
    b.addStatus(e, 'prone')
    expect(b.techAttackRoll(a, e, 'test').accuracy).toBe(1)
    b.addStatus(e, 'lockon')
    expect(b.techAttackRoll(a, e, 'test').accuracy).toBe(2)
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
    const a = mech([['t_hacker', 1]])
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
    expect(b.canMove(a, 'boost' as any)).not.toBe(true)
    expect(b.canMove(a, 'involuntary')).toBe(true)
  })

  it('a landed flyer that makes a legal move takes off', () => {
    const { a, b } = duel()
    b.beginTurn(a)
    a.flags.landed = true
    a.flying = false
    b.move(a, { x: 3, y: 5 })
    expect(a.flying).toBe(true)
    expect(a.flags.landed).toBe(false)
  })

  it('a player command that throws part-way is rolled back by transaction(rollbackOnError)', () => {
    const { a, b } = duel()
    b.beginTurn(a)
    const hp = a.hp
    const r = b.transaction(() => { a.hp -= 3; throw new Error('refused') }, [], { rollbackOnError: true })
    expect('error' in r && r.error?.message).toBe('refused')
    expect(a.hp).toBe(hp)
    // without the option (the AI path), work done before the error is kept
    b.transaction(() => { a.hp -= 3; throw new Error('refused') })
    expect(a.hp).toBe(hp - 3)
  })

  it('the active unit destroyed by a reactor meltdown at the end of its turn hands over exactly once', () => {
    const p1 = pregenUnit('Assault'); p1.pos = { x: 1, y: 1 }
    const e1 = pregenUnit('Sniper', 'enemy'); e1.pos = { x: 6, y: 10 }
    const e2 = pregenUnit('Hacker', 'enemy'); e2.pos = { x: 9, y: 10 }
    const b = battle([p1, e1, e2])
    b.beginTurn(p1); b.endTurn(p1)
    b.beginTurn(e1)
    e1.meltdownTurns = 1
    b.endTurn(e1)
    expect(e1.destroyed).toBe(true)
    // player has no activations left this round, so the other enemy goes next
    expect(b.round).toBe(1)
    expect(b.currentSide).toBe('enemy')
    expect(b.activeId).toBeNull()
  })

  it('burn that kills a unit mid-round passes the turn to the other side', () => {
    const p1 = pregenUnit('Assault'); p1.pos = { x: 1, y: 1 }
    const p2 = pregenUnit('Hacker'); p2.pos = { x: 3, y: 1 }
    const e = pregenUnit('Sniper', 'enemy'); e.pos = { x: 6, y: 10 }
    const b = battle([p1, p2, e])
    b.beginTurn(p1)
    p1.hp = 1; p1.structure = 1; p1.burn = 20; p1.stats.eng = -99
    b.endTurn(p1)
    expect(p1.destroyed).toBe(true)
    expect(b.round).toBe(1)
    expect(b.currentSide).toBe('enemy')
  })
})

describe('attack previews match real damage rules', () => {
  const rifleSetup = () => {
    const { a, e, b } = duel()
    e.stats.armor = 2
    return { a, e, b, rifle: rifleOf(a) }
  }
  it('Exposed doubles before Armor (AI estimate)', () => {
    const { a, e, b, rifle } = rifleSetup()
    const base = b.previewAttack(a, rifle, e)
    b.addStatus(e, 'exposed')
    const exp = b.previewAttack(a, rifle, e)
    // assault rifle 1d6 (avg 3.5), Reliable 2 on a miss: per hit (3.5 - 2) = 1.5 normally, (7 - 2) = 5 when Exposed
    const c = base.chance
    expect(base.expectedDamage).toBeCloseTo(1.5 * c + 2 * (1 - c), 5)
    expect(exp.expectedDamage).toBeCloseTo(5 * c + 2 * (1 - c), 5)
  })
  it('Shredded ignores Armor and Resistance in both previews', () => {
    const { a, e, b, rifle } = rifleSetup()
    e.resist.push('Kinetic')
    const before = b.previewDetail(a, rifle, e)
    const est = b.previewAttack(a, rifle, e).expectedDamage
    b.addStatus(e, 'shredded')
    expect(b.previewDetail(a, rifle, e).maxDmg).toBeGreaterThan(before.maxDmg)
    expect(b.previewAttack(a, rifle, e).expectedDamage).toBeGreaterThan(est)
  })
  it('Resistance halves the estimate', () => {
    const { a, e, b, rifle } = rifleSetup()
    e.stats.armor = 0
    const base = b.previewAttack(a, rifle, e).expectedDamage
    e.resist.push('Kinetic')
    const half = b.previewAttack(a, rifle, e).expectedDamage
    expect(half).toBeLessThan(base)
    expect(half).toBeGreaterThan(base * 0.45)
  })
})

describe('forced actions', () => {
  it('withForcedAction does not leak into the turn\'s record of spent actions', () => {
    const { a, e, b } = duel()
    e.pos = { x: 2, y: 5 }
    b.beginTurn(a)
    b.lockOn(a, e)
    const spent = [...a.flags['turn:spent']]
    b.withForcedAction(a, () => b.improvisedAttack(a, e))
    expect(a.flags['turn:spent']).toEqual(spent)
    expect(a.actionsLeft).toBe(1)
  })
})

describe('fixed: status × action interactions', () => {
  const adjacent = () => {
    const { a, e, b } = duel()
    e.pos = { x: 2, y: 5 }
    b.beginTurn(a)
    const ctxs: any[] = []
    const roll = b.rollToHit.bind(b)
    b.rollToHit = (ctx: any) => { ctxs.push(ctx); return roll(ctx) }
    return { a, e, b, ctxs }
  }

  it.each(['ram', 'grapple'] as const)('%s: Lock On gives +1 accuracy and is consumed', act => {
    const { a, e, b, ctxs } = adjacent()
    b.addStatus(e, 'lockon')
    b[act](a, e)
    expect(ctxs[0].accuracy).toBe(1)
    expect(b.has(e, 'lockon')).toBe(false)
  })
  it.each(['ram', 'grapple'] as const)('%s: Braced target is +1 difficulty, Prone target +1 accuracy', act => {
    const { a, e, b, ctxs } = adjacent()
    b.addStatus(e, 'braced')
    b.addStatus(e, 'prone')
    b[act](a, e)
    expect(ctxs[0].difficulty).toBe(1)
    expect(ctxs[0].accuracy).toBe(1)
  })
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

  it('tech attacks against a Braced target get +1 difficulty', () => {
    const { a, e, b } = duel()
    b.beginTurn(a)
    b.addStatus(e, 'braced')
    expect(b.techAttackRoll(a, e, 'x').difficulty).toBe(1)
  })

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
  it('clearing a status removes every instance of it', () => {
    const { a, e, b } = duel()
    b.beginTurn(a)
    b.addStatus(e, 'impaired', 'end_of_turn', a)
    b.addStatus(e, 'impaired', 'next_turn_end_target', a)
    b.removeStatus(e, 'impaired')
    expect(b.has(e, 'impaired')).toBe(false)
  })

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

  it('after Disengage, engagement does not stop movement', () => {
    const { a, e, b } = duel()
    e.pos = { x: 3, y: 5 }
    b.beginTurn(a)
    expect(b.reachable(a, a.moveLeft).has('5,5')).toBe(false)
    b.disengage(a)
    b.move(a, { x: 5, y: 5 })
    expect(a.pos).toEqual({ x: 5, y: 5 })
  })

  it('a Hidden mover does not provoke (and waste) Overwatch', () => {
    const { a, e, b } = duel()
    e.pos = { x: 3, y: 5 }
    e.weapons.forEach(w => (w.profiles[w.profileIndex].range = [{ type: 'Threat', val: 3 }]))
    b.beginTurn(a)
    b.addStatus(a, 'hidden')
    b.move(a, { x: 1, y: 3 })
    expect(e.reactionsLeft).toBe(e.reactionsPerRound)
  })

  it('Stabilize clears only burn, reloads or a condition, and checks before spending', () => {
    const { a, b } = duel()
    b.beginTurn(a)
    b.addStatus(a, 'prone')
    expect(() => b.stabilize(a, 'cool', { unit: a, status: 'prone' })).toThrow()
    expect(a.actionsLeft).toBe(2)
    expect(b.has(a, 'prone')).toBe(true)
  })

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
