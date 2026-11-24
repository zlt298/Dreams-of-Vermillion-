// Turn order and hand-over, the action economy (quick/full/free actions, Overcharge, Barrage, Stabilize), forced
// actions and Brace.
import { describe, expect, it } from 'vitest'
import type { Unit } from '../../src/rules/types'
import { arena, duel, flatMap, pregenUnit, battle } from '../support'

const rifleOf = (u: Unit) => u.weapons.find(w => w.dataId === 'mw_assault_rifle')!
/** Assault (1,5) and Vanguard (1,7) against a Sniper (9,5) on a 14x14 map. */
const trio = () => {
  const a = pregenUnit('Assault'); const a2 = pregenUnit('Vanguard'); const e = pregenUnit('Sniper', 'enemy')
  const b = arena([[a, { x: 1, y: 5 }], [a2, { x: 1, y: 7 }], [e, { x: 9, y: 5 }]], { map: flatMap(14, 14) })
  return { a, a2, e, b }
}
/** Assault (2,5) vs Sniper (6,5), with the Assault's turn begun unless `begin` is false. */
function choiceDuel(seed = 5, begin = true) {
  const d = duel({ a: { x: 2, y: 5 }, seed })
  if (begin) d.b.beginTurn(d.a)
  return d
}

describe('turn order and hand-over', () => {
  it('alternates sides and tracks actions', () => {
    const { a, e, b } = duel()
    expect(b.currentSide).toBe('player')
    b.beginTurn(a)
    b.boost(a)
    expect(a.actionsLeft).toBe(1)
    // the Boost used one action: a Barrage (a full action) is refused, without throwing and without spending anything
    const r = b.barrage(a, { weapon: a.weapons[0], aim: { targetId: e.id } })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('Needs a full action')
    expect(a.actionsLeft).toBe(1)
    expect(b.firedThisTurn(a, a.weapons[0])).toBe(false)
    b.endTurn(a)
    expect(b.currentSide).toBe('enemy')
    b.beginTurn(e)
    b.endTurn(e)
    expect(b.round).toBe(2)
  })

  // regression: a unit burning to death as the last activation of a round stalled the next round
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

  // regression: the wrong side opened the next round after the last activation was destroyed mid-turn
  it('a character destroyed mid-turn as the last activation of the round: the other side opens the next round', () => {
    const { a, a2, e, b } = trio()
    b.beginTurn(a); b.endTurn(a)
    b.beginTurn(e); b.endTurn(e)
    b.beginTurn(a2)
    // killed during its own turn (an Overwatch shot, a mine, its own heat...)
    while (!a2.destroyed) b.applyDamage(a2, [{ type: 'Energy', amount: 999 }], {})
    expect(b.round).toBe(2)
    // a player took the last turn of round 1, so the enemy should open round 2 (as after a normal endTurn)
    expect(b.currentSide).toBe('enemy')
  })

  // regression: zones timed to a destroyed character's turn never expired
  it('a zone lasting until the end of a character\'s next turn (Smoke Mine) expires even if that character is destroyed', () => {
    const { a, e, b } = trio()
    const e2 = pregenUnit('Assault', 'enemy'); e2.pos = { x: 9, y: 9 }; b.units.push(e2); e2.activationsLeft = 1
    b.addArea({ kind: 'soft_cover', tiles: [{ x: 5, y: 5 }], ownerId: a.id, expiresAfterTurnOf: e2.id, turnsLeft: 1 })
    b.destroy(e2, 'test')
    for (let i = 0; i < 8 && b.round < 4; i++) {
      const u = b.combatants(b.currentSide).find(x => x.activationsLeft > 0)!
      b.beginTurn(u); b.endTurn(u)
    }
    expect(b.round).toBeGreaterThanOrEqual(3)
    expect(b.areas.filter(x => x.expiresAfterTurnOf === e2.id)).toHaveLength(0)
  })

  // regression: a destroyed interjecting Goblin kept control of the turn
  it('the interjecting character being destroyed hands control back to its host', () => {
    const { a, a2, b } = trio()
    b.beginTurn(a)
    b.interject(a2, a)
    b.destroy(a2, 'test')
    expect(b.interjection).toBeNull()
    expect(b.activeId).toBe(a.id)
  })

  // regression: the host dying during an interjection deadlocked the turn order
  it('the host being destroyed during an interjection does not deadlock the turn order', () => {
    const { a, a2, e, b } = trio()
    a2.activationsLeft = 0 // a Goblin in Symbiosis only acts on its host's turn
    b.beginTurn(a)
    b.interject(a2, a)
    b.destroy(a, 'test')
    b.endTurn(a2)
    expect(b.activeId).toBeNull()
    // nobody on the player side can act any more: the enemy must be able to take its turn
    expect(b.canActivate(e)).toBe(true)
  })
})

describe('action economy', () => {
  it('overcharge grants a quick action and heat', () => {
    const { a, b } = duel()
    b.beginTurn(a)
    b.overcharge(a)
    expect(a.heat).toBe(1)
    expect(a.flags.bonusQuick).toBe(1)
    expect(() => b.overcharge(a)).toThrow()
  })

  it('Skirmish is a quick action: a second plain Skirmish in a turn is refused', () => {
    const { a, e, b } = duel()
    b.beginTurn(a)
    const [w1, w2] = a.weapons.filter(w => !b.isAoE(b.profile(w)))
    expect(b.skirmish(a, w1, { targetId: e.id }).ok).toBe(true)
    const r = b.skirmish(a, w2, { targetId: e.id })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/already taken this turn/)
  })

  it('a quick action can be repeated when paid with a free-action quick (Overcharge)', () => {
    const { a, e, b } = duel()
    e.pos = { x: 2, y: 5 } // adjacent, so both the rifle and the melee weapon can reach
    b.beginTurn(a)
    const [w1, w2] = a.weapons.filter(w => !b.isAoE(b.profile(w)))
    expect(b.skirmish(a, w1, { targetId: e.id }).ok).toBe(true)
    e.destroyed = false; e.hp = e.stats.hp; e.structure = e.stats.structure; e.pos = { x: 2, y: 5 }
    b.overcharge(a)
    expect(b.skirmish(a, w2, { targetId: e.id }).ok).toBe(true)
    // the repeat came out of the overcharge quick, so one normal action remains
    expect(a.actionsLeft).toBe(1)
    expect(a.flags.bonusQuick).toBe(0)
  })

  it('Everest Initiative allows a second Boost; the Power Up free boost does not consume an action', () => {
    const { a, b } = duel()
    b.beginTurn(a)
    b.boost(a)
    expect(() => b.boost(a)).toThrow(/already taken/)
    const init = b.customActions(a).find(c => c.name === 'Initiative')!
    b.useCustom(a, init)
    b.boost(a)
    expect(a.actionsLeft).toBe(1)
    a.coreActive = true
    const free = b.customActions(a).find(c => c.name === 'Boost (Power Up)')!
    b.useCustom(a, free)
    expect(a.actionsLeft).toBe(1)
  })

  it('reactions: one per turn, each reaction type once per round', () => {
    const { a, e, b } = duel()
    b.beginTurn(a)
    expect(b.canSpend(a, 'reaction', 'overwatch')).toBe(true)
    b.spend(a, 'reaction', 'overwatch')
    expect(b.canSpend(a, 'reaction', 'brace')).not.toBe(true)
    b.endTurn(a)
    b.beginTurn(e) // another character's turn: reaction refreshes, overwatch stays used this round
    expect(b.canSpend(a, 'reaction', 'brace')).toBe(true)
    expect(b.canSpend(a, 'reaction', 'overwatch')).not.toBe(true)
  })

  // regression: a refused Skirmish still spent the action and marked the weapon fired
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

  it('Barrage fires an extra Auxiliary on a fired mount, without bonus damage', () => {
    const { a, e, b } = duel()
    e.pos = { x: 2, y: 5 }
    b.beginTurn(a)
    const main = a.weapons.filter(w => w.size !== 'Auxiliary' && !b.isAoE(b.profile(w)))
    const aux = a.weapons.find(w => w.size === 'Auxiliary')!
    expect(aux).toBeDefined()
    expect(main.length).toBeGreaterThanOrEqual(1)
    aux.mountIndex = main[0].mountIndex
    const r = b.barrage(a, { weapon: main[0], aim: { targetId: e.id } }, main[1] ? { weapon: main[1], aim: { targetId: e.id } } : undefined, [{ weapon: aux, aim: { targetId: e.id } }])
    expect(r.ok).toBe(true)
    expect(b.validTarget(a, aux, e)).toBe(true)
    expect(b.firedThisTurn(a, aux)).toBe(true)
  })

  it('the same weapon can attack again when the action allows it: Skirmish, then Overcharge and Skirmish again', () => {
    const { a, e, b } = duel()
    b.beginTurn(a)
    const rifle = rifleOf(a)
    e.stats.hp = 99; e.hp = 99
    expect(b.skirmish(a, rifle, { targetId: e.id }).ok).toBe(true)
    expect(b.skirmish(a, rifle, { targetId: e.id }).reason).toMatch(/already taken this turn/) // the action, not the weapon
    b.overcharge(a)
    expect(b.skirmish(a, rifle, { targetId: e.id }).ok).toBe(true)
  })

  it('a weapon used in a Skirmish can be used again in a Barrage the same turn', () => {
    const { a, e, b } = duel()
    e.pos = { x: 2, y: 5 }
    e.stats.hp = 99; e.hp = 99
    b.beginTurn(a)
    const [w1, w2] = a.weapons.filter(w => !b.isAoE(b.profile(w)) && w.size !== 'Superheavy' && b.validTarget(a, w, e) === true)
    expect(b.skirmish(a, w1, { targetId: e.id }).ok).toBe(true)
    b.overcharge(a) // a full action needs two actions left: use the overcharge quick for something else first
    a.actionsLeft = 2
    expect(b.barrage(a, { weapon: w1, aim: { targetId: e.id } }, { weapon: w2, aim: { targetId: e.id } }).ok).toBe(true)
  })

  it('a Loading weapon still needs reloading between attacks, and there is no quick-action Reload', () => {
    const { a, e, b } = duel()
    b.beginTurn(a)
    const rifle = rifleOf(a)
    rifle.profiles[rifle.profileIndex].tags.push({ id: 'tg_loading' })
    e.stats.hp = 99; e.hp = 99
    expect(b.skirmish(a, rifle, { targetId: e.id }).ok).toBe(true)
    expect(rifle.loaded).toBe(false)
    b.overcharge(a)
    expect(b.skirmish(a, rifle, { targetId: e.id }).ok).toBe(false)
    expect(() => b.reload(a, rifle)).toThrow(/Stabilize/)
  })

  it('Stabilize asks which extra option to take when several apply (burn, a condition, reloading)', () => {
    const { a, b } = duel()
    b.beginTurn(a)
    a.weapons.forEach(w => (w.loaded = false))
    b.applyDamage(a, [{ type: 'Burn', amount: 2 }])
    let asked: string[] = []
    b.chooser = q => { asked = q.options.map(o => o.label); return q.options.findIndex(o => o.label.startsWith('Reload')) }
    b.transaction(() => b.stabilize(a, 'cool'))
    expect(asked[0]).toMatch(/burn/)
    expect(a.weapons.every(w => w.loaded)).toBe(true)
    expect(a.burn).toBeGreaterThan(0)
    expect(a.flags.reloaded).toBe(true)
  })

  it('Stabilize can reload all Loading weapons', () => {
    const { a, b } = duel()
    b.beginTurn(a)
    a.weapons.forEach(w => (w.loaded = false))
    b.stabilize(a, 'cool', { unit: a, status: 'reload' })
    expect(a.weapons.every(w => w.loaded)).toBe(true)
  })

  // regression: Stabilize spent the action before refusing an invalid condition to clear
  it('Stabilize clears only burn, reloads or a condition, and checks before spending', () => {
    const { a, b } = duel()
    b.beginTurn(a)
    b.addStatus(a, 'prone')
    expect(() => b.stabilize(a, 'cool', { unit: a, status: 'prone' })).toThrow()
    expect(a.actionsLeft).toBe(2)
    expect(b.has(a, 'prone')).toBe(true)
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

  // regression: a forced action (Slave Systems) was refused for a character not taking its turn
  it('withForcedAction lets a character that is not acting take the forced action (Slave Systems)', () => {
    const { a, e, b } = trio()
    e.pos = { x: 2, y: 5 }
    b.beginTurn(a)
    // Slave Systems makes the (hostile, not active) target Improvised Attack / Grapple / Ram on the hacker's turn
    let err = ''
    try { b.withForcedAction(e, () => b.improvisedAttack(e, a)) } catch (x) { err = (x as Error).message }
    expect(err).toBe('')
  })
})

describe('Brace', () => {
  // regression: the turn after Bracing still allowed free actions and protocols
  it('after Bracing, the next turn allows no free actions or protocols (core book: Brace)', () => {
    const { a, b } = trio()
    b.addStatus(a, 'bracing_recovery', 'next_turn_end_target')
    b.beginTurn(a)
    expect(b.canSpend(a, 'quick')).toBe(true)
    expect(b.canSpend(a, 'free')).not.toBe(true)
    expect(b.canSpend(a, 'protocol')).not.toBe(true)
  })

  // regression: Braced gave no +1 difficulty to tech attacks
  it('tech attacks against a Braced target get +1 difficulty', () => {
    const { a, e, b } = duel()
    b.beginTurn(a)
    b.addStatus(e, 'braced')
    expect(b.techAttackRoll(a, e, 'x').difficulty).toBe(1)
  })

  it("'ask' brace consults Battle.choose for player units; enemies take the default", () => {
    const { a, e, b } = duel()
    const asked: string[] = []
    b.chooser = q => { asked.push(q.kind); return 0 }
    e.side = 'player'; a.side = 'enemy'; b.currentSide = 'enemy'
    e.policies.brace = 'ask'
    e.hp = 3
    const rifle = a.weapons.find(w => w.dataId === 'mw_assault_rifle')!
    b.beginTurn(a)
    a.stats.attackBonus = 40
    b.transaction(() => b.skirmish(a, rifle, { targetId: e.id }))
    expect(asked).toContain('brace')
    expect(b.has(e, 'braced')).toBe(true)
  })

  it("an 'ask' brace pauses an enemy attack until the player answers", () => {
    const { a, e, b } = choiceDuel()
    b.chooser = () => undefined
    a.policies.brace = 'ask'
    a.hp = 2
    b.endTurn(a)
    b.currentSide = 'enemy'
    b.beginTurn(e)
    e.stats.attackBonus = 40
    const w = e.weapons.find(x => b.weaponUsable(e, x) === true)!
    const fire = () => { b.skirmish(e, w, { targetId: a.id }) }
    const r = b.transaction(fire)
    expect('pending' in r && r.pending.kind).toBe('brace')
    expect(b.has(a, 'braced')).toBe(false)
    b.transaction(fire, [0])
    expect(b.has(a, 'braced')).toBe(true)
  })
})
