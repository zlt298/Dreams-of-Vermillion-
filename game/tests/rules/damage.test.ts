// Damage: Armor, Exposed, Resistance, Shredded, burn and overshield; heat, stress and meltdown; grunts.
import { describe, expect, it } from 'vitest'
import { duel, pregenUnit } from '../support'

describe('damage', () => {
  it('armor, exposed and resistance', () => {
    const { e, b } = duel()
    e.stats.armor = 2
    b.applyDamage(e, [{ type: 'Kinetic', amount: 5 }])
    expect(e.hp).toBe(e.stats.hp - 3)
    e.hp = e.stats.hp
    b.addStatus(e, 'exposed')
    b.applyDamage(e, [{ type: 'Kinetic', amount: 5 }])
    expect(e.hp).toBe(e.stats.hp - 8)
    e.hp = e.stats.hp
    b.removeStatus(e, 'exposed')
    e.resist.push('Kinetic')
    b.applyDamage(e, [{ type: 'Kinetic', amount: 6 }])
    expect(e.hp).toBe(e.stats.hp - 2)
    e.hp = e.stats.hp
    b.addStatus(e, 'shredded')
    b.applyDamage(e, [{ type: 'Kinetic', amount: 6 }])
    expect(e.hp).toBe(e.stats.hp - 6)
  })

  it('armor is subtracted once from the attack total (core book)', () => {
    const { e, b } = duel()
    e.stats.armor = 2
    b.applyDamage(e, [{ type: 'Kinetic', amount: 3 }, { type: 'Energy', amount: 3 }])
    expect(e.hp).toBe(e.stats.hp - 4)
  })

  it('resistance halves after armor, rounding up', () => {
    const { e, b } = duel()
    e.stats.armor = 1
    e.resist.push('Energy')
    b.applyDamage(e, [{ type: 'Energy', amount: 6 }])
    expect(e.hp).toBe(e.stats.hp - 3)
  })

  it('hp loss past zero marks structure and carries over', () => {
    const { e, b } = duel()
    e.hp = 3
    b.applyDamage(e, [{ type: 'Kinetic', amount: 5 }])
    expect(e.structure).toBe(3)
    // with 3 Structure left no structure-check result destroys the mech, so this always applies
    expect(e.destroyed).toBe(false)
    expect(e.hp).toBe(e.stats.hp - 2)
  })

  it('burn deals damage immediately and is marked', () => {
    const { e, b } = duel()
    b.applyDamage(e, [{ type: 'Burn', amount: 2 }])
    expect(e.burn).toBe(2)
    expect(e.hp).toBe(e.stats.hp - 2)
  })

  it('overshield absorbs damage first', () => {
    const { e, b } = duel()
    e.overshield = 4
    b.applyDamage(e, [{ type: 'Energy', amount: 6 }])
    expect(e.overshield).toBe(0)
    expect(e.hp).toBe(e.stats.hp - 2)
  })
})

describe('heat and stress', () => {
  it('heat beyond cap causes stress', () => {
    const { e, b } = duel()
    b.addHeat(e, e.stats.heatcap + 2)
    expect(e.stress).toBe(3)
    expect(e.heat).toBe(1) // cap + 1 exceeds the cap; only the 1 beyond that carries over
  })

  it('reaching 0 stress schedules a meltdown at the end of the next turn', () => {
    const { e, b } = duel()
    e.stress = 1
    b.addHeat(e, e.stats.heatcap + 1)
    expect(e.stress).toBe(0)
    expect(e.destroyed).toBe(false)
    expect(e.meltdownTurns).toBe(1)
  })

  it('characters without a heat cap take heat as energy damage', () => {
    const { e, b } = duel()
    e.stats.heatcap = 0
    e.stats.armor = 0
    b.addHeat(e, 3)
    expect(e.hp).toBe(e.stats.hp - 3)
  })
})

describe('grunts', () => {
  it('grunts are destroyed by external heat', () => {
    const { a, b } = duel()
    const g = pregenUnit('Hacker', 'enemy')
    g.isGrunt = true
    g.pos = { x: 9, y: 9 }
    b.units.push(g)
    b.addHeat(g, 1, a)
    expect(g.destroyed).toBe(true)
  })

  it('Reliable damage on a miss destroys a grunt', () => {
    const { a, b } = duel()
    const g = pregenUnit('Hacker', 'enemy')
    g.isGrunt = true; g.hp = 1; g.stats.hp = 1; g.stats.evasion = 99
    g.pos = { x: 4, y: 5 }
    b.units.push(g)
    b.beginTurn(a)
    const rifle = a.weapons.find(w => w.dataId === 'mw_assault_rifle')! // Reliable 2
    const r = b.skirmish(a, rifle, { targetId: g.id })
    expect(r.ctxs[0].hit).toBe(false)
    expect(g.destroyed).toBe(true)
  })

  it('a grunt that passes a save takes no damage', () => {
    const { a, b } = duel()
    const g = pregenUnit('Hacker', 'enemy')
    g.isGrunt = true; g.hp = 1; g.stats.hp = 1; g.stats.agi = 99
    g.pos = { x: 4, y: 5 }
    b.units.push(g)
    b.runEffects(a, g, [{ do: 'damage', damage: [{ type: 'Explosive', val: '2d6' }], save: 'agi', saveHalf: true }])
    expect(g.destroyed).toBe(false)
    expect(g.hp).toBe(1)
  })
})
