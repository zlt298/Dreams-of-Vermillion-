// SITREP endings (src/rules/battle/turns.ts endRound/checkVictory): holdout, control, extraction and assassination,
// plus the defeat paths every sitrep shares.
import { describe, expect, it } from 'vitest'
import { Battle, type Sitrep } from '../../src/rules/battle'
import type { Pos, Unit } from '../../src/rules/types'
import { act, flatMap, mech, rigDice } from '../support'

function sitrepBattle(placed: [Unit, Pos][], sitrep: Sitrep) {
  for (const [u, p] of placed) u.pos = { ...p }
  const b = new Battle({ map: flatMap(14, 14), units: placed.map(([u]) => u), seed: 3, sitrep })
  b.start()
  return b
}

/** Every combatant takes (and immediately ends) its turn until the round changes or the battle ends. */
function passRound(b: Battle) {
  const r = b.round
  while (!b.winner && b.round === r) {
    const u = b.combatants(b.currentSide).find(x => x.activationsLeft > 0)!
    b.beginTurn(u)
    b.endTurn(u)
  }
}

const ends = (b: Battle) => b.events.filter(e => e.type === 'end')
const lastLog = (b: Battle) => b.log[b.log.length - 1].text

const zone: Pos[] = [{ x: 6, y: 6 }, { x: 7, y: 6 }, { x: 6, y: 7 }, { x: 7, y: 7 }]

describe('holdout', () => {
  const holdout: Sitrep = { id: 'holdout', name: 'Holdout', rounds: 3, description: '' }

  it('the players win when round N ends, and not a round earlier', () => {
    const a = mech(), e = mech({}, 'enemy')
    const b = sitrepBattle([[a, { x: 1, y: 1 }], [e, { x: 12, y: 12 }]], holdout)
    passRound(b)
    passRound(b)
    expect(b.round).toBe(3)
    expect(b.winner).toBeNull()
    passRound(b)
    expect(b.winner).toBe('player')
    expect(b.round).toBe(3) // no round 4 starts
    expect(lastLog(b)).toBe('VICTORY: Held out for 3 rounds!')
    expect(ends(b)).toEqual([{ type: 'end', winner: 'player' }])
  })

  it('losing every lancer before the limit is a defeat', () => {
    const a = mech(), e = mech({}, 'enemy')
    const b = sitrepBattle([[a, { x: 1, y: 1 }], [e, { x: 12, y: 12 }]], holdout)
    passRound(b)
    b.destroy(a, 'test')
    expect(b.winner).toBe('enemy')
    expect(lastLog(b)).toBe('DEFEAT: All lancers are down.')
    expect(ends(b)).toHaveLength(1)
  })
})

describe('control', () => {
  const control: Sitrep = { id: 'control', name: 'Control', rounds: 2, zone, description: '' }

  it('scores each round the zone holds only players at round end, and wins at the target score', () => {
    const a = mech(), e = mech({}, 'enemy')
    const b = sitrepBattle([[a, { x: 6, y: 6 }], [e, { x: 12, y: 12 }]], control)
    passRound(b)
    expect(b.sitrepScore).toBe(1)
    expect(b.winner).toBeNull()
    passRound(b)
    expect(b.sitrepScore).toBe(2)
    expect(b.winner).toBe('player')
    expect(lastLog(b)).toBe('VICTORY: Control point secured!')
    expect(ends(b)).toHaveLength(1)
  })

  it('a contested zone (an enemy inside too) scores nothing', () => {
    const a = mech(), e = mech({}, 'enemy')
    const b = sitrepBattle([[a, { x: 6, y: 6 }], [e, { x: 7, y: 7 }]], control)
    for (let i = 0; i < 4; i++) passRound(b)
    expect(b.sitrepScore).toBeUndefined()
    expect(b.winner).toBeNull()
    expect(b.round).toBe(5)
  })

  it('an empty zone scores nothing', () => {
    const a = mech(), e = mech({}, 'enemy')
    const b = sitrepBattle([[a, { x: 1, y: 1 }], [e, { x: 12, y: 12 }]], control)
    for (let i = 0; i < 4; i++) passRound(b)
    expect(b.sitrepScore).toBeUndefined()
    expect(b.winner).toBeNull()
  })

  it('a hostile-only zone scores nothing', () => {
    const a = mech(), e = mech({}, 'enemy')
    const b = sitrepBattle([[a, { x: 1, y: 1 }], [e, { x: 6, y: 6 }]], control)
    for (let i = 0; i < 3; i++) passRound(b)
    expect(b.sitrepScore).toBeUndefined()
    expect(b.winner).toBeNull()
  })

  it('destroying all hostiles still wins outright', () => {
    const a = mech(), e = mech({}, 'enemy')
    const b = sitrepBattle([[a, { x: 1, y: 1 }], [e, { x: 12, y: 12 }]], control)
    b.destroy(e, 'test')
    expect(b.winner).toBe('player')
    expect(lastLog(b)).toBe('VICTORY: All hostiles destroyed.')
    expect(ends(b)).toHaveLength(1)
  })
})

describe('extraction', () => {
  const extraction: Sitrep = { id: 'extraction', name: 'Extraction', zone, description: '' }

  it('wins once every surviving lancer stands in the zone', () => {
    const a = mech(), c = mech(), e = mech({}, 'enemy')
    const b = sitrepBattle([[a, { x: 6, y: 6 }], [c, { x: 3, y: 7 }], [e, { x: 12, y: 1 }]], extraction)
    act(b, a)
    b.endTurn(a)
    expect(b.winner).toBeNull() // c is still outside
    act(b, c)
    expect(b.move(c, { x: 7, y: 7 })).toBe(true)
    b.endTurn(c)
    expect(b.winner).toBe('player')
    expect(lastLog(b)).toBe('VICTORY: All lancers extracted!')
    expect(ends(b)).toHaveLength(1)
  })

  it('a destroyed lancer does not block extraction', () => {
    const a = mech(), c = mech(), e = mech({}, 'enemy')
    const b = sitrepBattle([[a, { x: 6, y: 6 }], [c, { x: 1, y: 1 }], [e, { x: 12, y: 1 }]], extraction)
    expect(b.winner).toBeNull()
    b.destroy(c, 'test')
    expect(b.winner).toBe('player')
    expect(lastLog(b)).toBe('VICTORY: All lancers extracted!')
  })

  it('a lancer lost in blinkspace (Mourning Cloak triples) does not block extraction', () => {
    const a = mech(), mc = mech({ frame: 'mf_mourning_cloak' }), e = mech({}, 'enemy')
    const b = sitrepBattle([[a, { x: 6, y: 6 }], [mc, { x: 1, y: 1 }], [e, { x: 12, y: 1 }]], extraction)
    act(b, mc)
    const blink = b.customActions(mc).find(x => x.key === 'mc-blink')!
    rigDice(b, 6, 4, 4, 4)
    b.useCustom(mc, blink, { x: 2, y: 2 })
    expect(mc.flags.vanished).toEqual({ hp: mc.stats.hp, structure: mc.stats.structure, stress: mc.stats.stress })
    expect(mc.destroyed).toBe(true)
    expect(b.winner).toBe('player')
    expect(lastLog(b)).toBe('VICTORY: All lancers extracted!')
    expect(ends(b)).toHaveLength(1)
  })

  it('nobody in the zone: no win; all lancers destroyed: defeat', () => {
    const a = mech(), e = mech({}, 'enemy')
    const b = sitrepBattle([[a, { x: 1, y: 1 }], [e, { x: 12, y: 1 }]], extraction)
    passRound(b)
    expect(b.winner).toBeNull()
    b.destroy(a, 'test')
    expect(b.winner).toBe('enemy')
    expect(lastLog(b)).toBe('DEFEAT: All lancers are down.')
  })
})

describe('assassination', () => {
  function setup() {
    const a = mech(), target = mech({}, 'enemy'), guard = mech({ weapons: 'mw_mortar' }, 'enemy')
    const b = sitrepBattle([[a, { x: 2, y: 6 }], [target, { x: 6, y: 6 }], [guard, { x: 12, y: 12 }]], { id: 'assassination', name: 'Assassination', targetId: target.id, description: '' })
    target.hp = 1
    target.structure = 1
    target.policies.brace = 'off'
    return { a, target, guard, b }
  }

  it('killing the target with an attack wins (once), with its bodyguard still standing', () => {
    const { a, target, guard, b } = setup()
    act(b, a)
    a.stats.attackBonus = 30
    const r = b.skirmish(a, a.weapons[0], { targetId: target.id })
    expect(r.ok).toBe(true)
    expect(target.destroyed).toBe(true)
    expect(guard.destroyed).toBe(false)
    expect(b.winner).toBe('player')
    expect(lastLog(b)).toBe('VICTORY: Target eliminated.')
    b.endTurn(a)
    expect(ends(b)).toEqual([{ type: 'end', winner: 'player' }])
  })

  it('the target melting down at the end of its own turn wins (once)', () => {
    const { target, guard, b } = setup()
    target.meltdownTurns = 1
    act(b, target)
    rigDice(b, 6, 1, 1, 1, 1) // the explosion's 4d6 (nobody else in range)
    b.endTurn(target)
    expect(target.destroyed).toBe(true)
    expect(guard.destroyed).toBe(false)
    expect(b.winner).toBe('player')
    expect(b.log.some(l => l.text === 'VICTORY: Target eliminated.')).toBe(true)
    expect(ends(b)).toHaveLength(1)
  })

  it("the target killed by its own ally's blast wins (once)", () => {
    const { target, guard, b } = setup()
    guard.pos = { x: 6, y: 12 }
    act(b, guard)
    guard.stats.attackBonus = 30
    const mortar = guard.weapons[0]
    const r = b.weaponAttack(guard, mortar, { tile: { x: 6, y: 6 } }, 'free')
    expect(r.ok).toBe(true)
    expect(r.ctxs.map(c => c.target.id)).toEqual([target.id])
    expect(target.destroyed).toBe(true)
    expect(guard.destroyed).toBe(false)
    expect(b.winner).toBe('player')
    expect(ends(b)).toHaveLength(1)
  })

  it('losing every lancer is a defeat even with the target alive', () => {
    const { a, target, b } = setup()
    b.destroy(a, 'test')
    expect(target.destroyed).toBe(false)
    expect(b.winner).toBe('enemy')
    expect(lastLog(b)).toBe('DEFEAT: All lancers are down.')
  })
})
