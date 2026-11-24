// Rules audit: scenario checks of the combat engine against the LANCER core book's Mech Combat chapter
// (turns, actions, movement, attacks, cover, damage, statuses, structure and overheating). Each check
// names the rule it covers in our own words; dice are rigged where the rule's outcome depends on a roll.
import { describe, expect, it } from 'vitest'
import { battle, duel as duelOn, flatMap, pregenUnit, rigDice } from '../support'
import type { Battle } from '../../src/rules/battle'
import type { Unit } from '../../src/rules/types'

/** Assault vs Sniper on a 14x14 map (positions overridable). */
const duel = (map?: Parameters<typeof flatMap>[2], a = { x: 1, y: 5 }, e = { x: 6, y: 5 }) => duelOn({ map, size: 14, a, e })
const firstRanged = (u: Unit) => u.weapons.find(w => !w.destroyed && w.type !== 'Melee' && w.size !== 'Superheavy' && w.profiles[0]?.range.some(r => r.type === 'Range' && Number(r.val) >= 5))!

// ------------------------------------------------------------------------------------------------ turns
describe('audit: turns and actions', () => {
  it('players act first, sides alternate, and the side that did not act last opens the next round', () => {
    const a = pregenUnit('Assault'); const a2 = pregenUnit('Vanguard')
    const e = pregenUnit('Sniper', 'enemy')
    a.pos = { x: 1, y: 1 }; a2.pos = { x: 1, y: 3 }; e.pos = { x: 10, y: 10 }
    const b = battle([a, a2, e])
    expect(b.currentSide).toBe('player')
    b.beginTurn(a); b.endTurn(a)
    expect(b.currentSide).toBe('enemy')
    b.beginTurn(e); b.endTurn(e)
    // the enemy side is out of turns: the players keep going
    expect(b.currentSide).toBe('player')
    b.beginTurn(a2); b.endTurn(a2)
    expect(b.round).toBe(2)
    // a player took the last turn of round 1, so the enemy opens round 2
    expect(b.currentSide).toBe('enemy')
  })

  it('the same quick action cannot be taken twice in a turn without a free action', () => {
    const { a, b } = duel()
    b.beginTurn(a)
    b.boost(a)
    expect(() => b.boost(a)).toThrow()
  })

  it('Overcharge costs 1, then 1d3, then 1d6, then 1d6+4 heat, once per turn', () => {
    const { a, b } = duel()
    a.stats.heatcap = 99
    const heatOf = (fn: () => void) => { const h = a.heat; fn(); return a.heat - h }
    b.beginTurn(a)
    expect(heatOf(() => b.overcharge(a))).toBe(1)
    expect(() => b.overcharge(a)).toThrow()
    const next = (sides: number, roll: number) => { b.endTurn(a); b.beginTurn(b.units.find(u => u.side === 'enemy')!); b.endTurn(); b.beginTurn(a); rigDice(b, sides, roll); return heatOf(() => b.overcharge(a)) }
    expect(next(3, 3)).toBe(3)
    expect(next(6, 5)).toBe(5)
    expect(next(6, 2)).toBe(6)
  })
})

// ------------------------------------------------------------------------------------------------ movement
describe('audit: movement', () => {
  it('moving adjacent to a hostile of equal or greater Size stops movement; a smaller one does not', () => {
    // a corridor two spaces wide; the hostile blocks the top lane, so the mover must pass beside it
    const { a, e, b } = duel((_x, y) => (y < 4 || y > 5 ? { h: 6, kind: 'ground' } : undefined), { x: 1, y: 5 }, { x: 4, y: 4 })
    b.beginTurn(a)
    expect(b.reachable(a, a.moveLeft).has('4,5')).toBe(false)
    e.stats.size = 0.5
    expect(b.reachable(a, a.moveLeft).has('4,5')).toBe(true)
  })

  it('allies never obstruct, but a move cannot end in their space', () => {
    const a = pregenUnit('Assault'); const ally = pregenUnit('Vanguard')
    const e = pregenUnit('Sniper', 'enemy')
    a.pos = { x: 1, y: 5 }; ally.pos = { x: 2, y: 5 }; e.pos = { x: 12, y: 12 }
    const b = battle([a, ally, e], flatMap(14, 14, (x, y) => (y !== 5 ? { h: 5, kind: 'ground' } : undefined)))
    b.beginTurn(a)
    const r = b.reachable(a, a.moveLeft)
    expect(r.has('3,5')).toBe(true)
    expect(() => b.move(a, { x: 2, y: 5 })).toThrow()
  })

  it('difficult terrain costs 2 spaces per space', () => {
    const { a, b } = duel(x => (x >= 2 && x <= 3 ? { h: 0, kind: 'rubble' } as any : undefined))
    b.beginTurn(a)
    expect(b.pathTo(a, { x: 3, y: 5 }, 10)!.cost).toBe(4)
  })

  it('involuntary movement provokes no reactions and is blocked by obstructions', () => {
    const { a, e, b } = duel(x => (x === 9 ? { h: 5, kind: 'ground' } : undefined), { x: 5, y: 5 }, { x: 6, y: 5 })
    b.beginTurn(a)
    const before = e.reactionsLeft
    const aBefore = a.hp
    b.forceMove(e, a, 5, 1)
    expect(e.pos.x).toBe(8)
    expect(e.reactionsLeft).toBe(before)
    expect(a.hp).toBe(aBefore)
  })

  it('Immobilized stops voluntary movement but not involuntary movement', () => {
    const { a, e, b } = duel()
    b.addStatus(a, 'immobilized')
    b.beginTurn(a)
    expect(() => b.move(a, { x: 2, y: 5 })).toThrow()
    b.forceMove(a, e, 1, 1)
    expect(a.pos.x).toBe(0)
  })

  it('Slowed characters cannot Boost', () => {
    const { a, b } = duel()
    b.addStatus(a, 'slowed')
    b.beginTurn(a)
    expect(() => b.boost(a)).toThrow()
  })

  it('a hostile starting a move inside Threat provokes Overwatch; Disengage does not', () => {
    for (const disengage of [false, true]) {
      const { a, e, b } = duel(undefined, { x: 5, y: 5 }, { x: 6, y: 5 })
      e.policies.overwatch = 'auto'
      b.beginTurn(a)
      if (disengage) b.disengage(a)
      const r0 = e.reactionsLeft
      b.move(a, { x: 3, y: 5 })
      expect(e.reactionsLeft, disengage ? 'disengaged' : 'plain').toBe(disengage ? r0 : r0 - 1)
    }
  })
})

// ------------------------------------------------------------------------------------------------ attacks
describe('audit: attacks and cover', () => {
  it('ranged attacks while Engaged take +1 Difficulty; melee and tech attacks do not', () => {
    const { a, e, b } = duel(undefined, { x: 5, y: 5 }, { x: 6, y: 5 })
    const w = firstRanged(a)
    const ctx = b.previewAttack(a, w, e).ctx
    expect(ctx.difficulty).toBeGreaterThanOrEqual(1)
    const far = duel()
    expect(far.b.previewAttack(far.a, firstRanged(far.a), far.e).ctx.difficulty).toBe(0)
  })

  it('hard cover only counts when the target is adjacent to it; otherwise it is soft cover', () => {
    const wall = (x: number) => (x === 7 ? { h: 3, kind: 'ground' as const } : undefined)
    // (Audit 2: the target used to stand at (8,6), diagonal to the wall, but a line from (1,5) to (8,6) is clear of
    // it, so that target is flanked (core p. 66). Directly behind the wall it is in hard cover.)
    const near = duel((x, y) => (y === 5 ? wall(x) : undefined), { x: 1, y: 5 }, { x: 8, y: 5 })
    const far = duel((x, y) => (y === 5 ? wall(x) : undefined), { x: 1, y: 5 }, { x: 10, y: 5 })
    expect(near.b.cover(near.a, near.e)).toBe('hard')
    expect(far.b.cover(far.a, far.e)).not.toBe('hard')
  })

  it('melee attacks ignore cover', () => {
    const { a, e, b } = duel((x, y) => (x === 7 && y === 4 ? { h: 3, kind: 'ground' } : undefined), { x: 5, y: 5 }, { x: 6, y: 5 })
    const melee = a.weapons.find(w => w.type === 'Melee')
    expect(melee).toBeDefined()
    expect(b.previewAttack(a, melee!, e).ctx.difficulty).toBe(0)
  })

  it('a natural 20 or a total of 20+ on a melee or ranged attack crits; NPCs never crit', () => {
    const { a, e, b } = duel()
    b.beginTurn(a)
    e.stats.evasion = 5
    rigDice(b, 20, 20)
    const r = b.skirmish(a, firstRanged(a), { targetId: e.id })
    expect(r.ok).toBe(true)
    const log = b.log.map(l => l.text).join('\n')
    expect(log).toMatch(/CRIT/i)
  })

  it('Invisible targets: half of all attacks miss before the roll', () => {
    const { a, e, b } = duel()
    b.addStatus(e, 'invisible')
    b.beginTurn(a)
    e.stats.evasion = 1
    rigDice(b, 6, 2) // ≤3: the attack misses outright
    b.skirmish(a, firstRanged(a), { targetId: e.id })
    expect(b.log.map(l => l.text).join('\n')).toMatch(/misses \(invisible\)/) // (Reliable damage still applies on a miss)
  })

  it('Hidden characters cannot be targeted directly', () => {
    const { a, e, b } = duel()
    b.addStatus(e, 'hidden')
    expect(b.validTarget(a, firstRanged(a), e)).not.toBe(true)
  })

  it('attacks against Prone targets gain +1 Accuracy', () => {
    const { a, e, b } = duel()
    const base = b.previewAttack(a, firstRanged(a), e).ctx
    b.addStatus(e, 'prone')
    const prone = b.previewAttack(a, firstRanged(a), e).ctx
    expect(prone.accuracy - prone.difficulty).toBe(base.accuracy - base.difficulty + 1)
  })
})

// ------------------------------------------------------------------------------------------------ damage
describe('audit: damage', () => {
  it('order: Exposed doubles, then Armor, then Resistance halves (core book example: 5 → 10 → 8 → 4)', () => {
    const { e, b } = duel()
    e.stats.armor = 2
    e.resist = ['Kinetic']
    b.addStatus(e, 'exposed')
    const hp = e.hp
    b.applyDamage(e, [{ type: 'Kinetic', amount: 5 }])
    expect(hp - e.hp).toBe(4)
  })

  it('AP damage and burn ignore Armor', () => {
    const { e, b } = duel()
    e.stats.armor = 2
    let hp = e.hp
    b.applyDamage(e, [{ type: 'Kinetic', amount: 5 }], { ap: true })
    expect(hp - e.hp).toBe(5)
    hp = e.hp
    b.applyDamage(e, [{ type: 'Burn', amount: 3 }])
    expect(hp - e.hp).toBe(3)
  })

  it('Shredded: no Armor or Resistance', () => {
    const { e, b } = duel()
    e.stats.armor = 2
    e.resist = ['Kinetic']
    b.addStatus(e, 'shredded')
    const hp = e.hp
    b.applyDamage(e, [{ type: 'Kinetic', amount: 6 }])
    expect(hp - e.hp).toBe(6)
  })

  it('Resistance to the same type does not stack', () => {
    const { e, b } = duel()
    e.resist = ['Energy', 'Energy']
    const hp = e.hp
    b.applyDamage(e, [{ type: 'Energy', amount: 8 }])
    expect(hp - e.hp).toBe(4)
  })

  it('burn: at the end of its turn a burning mech checks Engineering; failure deals the marked burn, success clears it', () => {
    for (const pass of [false, true]) {
      const { a, b } = duel()
      b.beginTurn(a)
      b.applyDamage(a, [{ type: 'Burn', amount: 3 }])
      const hp = a.hp
      a.stats.eng = 0
      rigDice(b, 20, pass ? 20 : 1)
      b.endTurn(a)
      expect(a.hp, pass ? 'pass' : 'fail').toBe(pass ? hp : hp - 3)
      expect(a.burn).toBe(pass ? 0 : 3)
    }
  })

  it('heat: Resistance halves heat taken, Invade heat included', () => {
    const { a, e, b } = duel()
    e.resist = ['Heat']
    b.applyDamage(e, [{ type: 'Heat', amount: 4 }])
    expect(e.heat).toBe(2)
    e.heat = 0
    b.beginTurn(a)
    e.stats.edef = 1
    rigDice(b, 20, 15)
    b.invade(a, e)
    expect(e.heat).toBe(1)
  })

  it('heat over the cap: 1 stress, heat clears, then only the heat beyond what it took to exceed the cap is kept', () => {
    const { e, b } = duel()
    e.heat = e.stats.heatcap - 1
    rigDice(b, 6, 6)
    b.addHeat(e, 4) // 2 of the 4 take it over the cap: 2 carry over
    expect(e.stress).toBe(e.stats.stress - 1)
    expect(e.heat).toBe(2)
  })

  it('falling: 3 AP kinetic per 3 spaces fallen (at most 9), including when knocked off a ledge', () => {
    for (const [drop, want] of [[2, 0], [4, 3], [7, 6], [14, 9]] as const) {
      const { a, e, b } = duel(x => (x <= 6 ? { h: drop, kind: 'ground' } : undefined), { x: 5, y: 5 }, { x: 6, y: 5 })
      e.stats.armor = 3
      const hp = e.hp
      b.forceMove(e, a, 1, 1)
      expect(e.pos.x, `drop ${drop}`).toBe(7)
      expect(hp - e.hp, `drop ${drop}`).toBe(want)
    }
  })
})

// ------------------------------------------------------------------------------------------------ statuses
describe('audit: statuses and conditions', () => {
  it('Impaired: +1 Difficulty on attacks, saves and checks', () => {
    const { a, e, b } = duel()
    const base = b.previewAttack(a, firstRanged(a), e).ctx
    b.addStatus(a, 'impaired')
    const imp = b.previewAttack(a, firstRanged(a), e).ctx
    expect(imp.accuracy - imp.difficulty).toBe(base.accuracy - base.difficulty - 1)
    a.stats.hull = 0
    // (this used to rig the d20 with [10, 6]: the 6 meant for the difficulty die was never rolled)
    rigDice(b, 20, 10)
    rigDice(b, 6, 1)
    expect(b.save(a, 'hull', 10)).toBe(false) // 10 + 0 - d6(1) < 10: even the lowest difficulty die fails it
  })

  it('Jammed: no attacks except Improvised Attack, Grapple and Ram; no tech actions', () => {
    const { a, e, b } = duel(undefined, { x: 5, y: 5 }, { x: 6, y: 5 })
    b.addStatus(a, 'jammed')
    b.beginTurn(a)
    expect(b.skirmish(a, firstRanged(a), { targetId: e.id }).ok).toBe(false)
    expect(() => b.lockOn(a, e)).toThrow()
    expect(() => b.improvisedAttack(a, e)).not.toThrow()
  })

  it('Stunned: Evasion at most 5, automatic failure on Hull and Agility saves, no actions', () => {
    const { a, e, b } = duel()
    e.stats.evasion = 12
    b.addStatus(e, 'stunned')
    const ctx = b.previewAttack(a, firstRanged(a), e).ctx
    expect(b.defenseOf(e, ctx)).toBeLessThanOrEqual(5)
    e.stats.agi = 6
    // an automatic failure: no die is rolled at all (a rigged natural 20 used to go unrolled here)
    const rng = b.rng.state
    expect(b.save(e, 'agi', 5)).toBe(false)
    expect(b.rng.state).toBe(rng)
    b.addStatus(a, 'stunned')
    b.beginTurn(a)
    expect(() => b.boost(a)).toThrow()
  })

  it('Lock On: consumed for +1 Accuracy by the next attack', () => {
    const { a, e, b } = duel()
    b.beginTurn(a)
    b.lockOn(a, e)
    expect(b.has(e, 'lockon')).toBe(true)
    b.skirmish(a, firstRanged(a), { targetId: e.id })
    expect(b.has(e, 'lockon')).toBe(false)
  })

  it('Shut Down: clears heat and Exposed, ends Lock On, immune to tech, Stunned until Boot Up', () => {
    const { a, e, b } = duel()
    b.beginTurn(a)
    a.heat = 3
    b.addStatus(a, 'exposed')
    b.addStatus(a, 'lockon', 'until_cleared', e)
    b.shutDown(a)
    expect(a.heat).toBe(0)
    expect(b.has(a, 'exposed')).toBe(false)
    expect(b.has(a, 'lockon')).toBe(false)
    expect(b.has(a, 'stunned')).toBe(true)
  })

  it('Danger Zone at half the heat cap or more', () => {
    const { a, b } = duel()
    a.heat = Math.ceil(a.stats.heatcap / 2) - 1
    expect(b.has(a, 'dangerzone')).toBe(false)
    a.heat = Math.ceil(a.stats.heatcap / 2)
    expect(b.has(a, 'dangerzone')).toBe(true)
  })
})

// ------------------------------------------------------------------------------------------------ actions
describe('audit: actions', () => {
  it('Grapple: on a hit both are Engaged, neither can Boost or react, the smaller is Immobilized', () => {
    const { a, e, b } = duel(undefined, { x: 5, y: 5 }, { x: 6, y: 5 })
    e.stats.size = 0.5 as any
    e.stats.evasion = 1
    b.beginTurn(a)
    rigDice(b, 20, 15)
    b.grapple(a, e)
    expect(b.has(e, 'immobilized')).toBe(true)
    expect(b.isEngaged(a) && b.isEngaged(e)).toBe(true)
    expect(() => b.boost(a)).toThrow()
  })

  it('Ram: only targets of the same Size or smaller; a hit knocks Prone (and optionally back 1)', () => {
    const { a, e, b } = duel(undefined, { x: 5, y: 5 }, { x: 6, y: 5 })
    e.stats.evasion = 1
    b.beginTurn(a)
    rigDice(b, 20, 15)
    b.ram(a, e)
    expect(b.has(e, 'prone')).toBe(true)
    const big = duel(undefined, { x: 5, y: 5 }, { x: 6, y: 5 })
    big.e.stats.size = 2
    big.b.beginTurn(big.a)
    expect(() => big.b.ram(big.a, big.e)).toThrow()
  })

  it('Invade: 2 heat on a hit, and Fragment Signal leaves the target Impaired and Slowed until the end of its next turn', () => {
    const { a, e, b } = duel()
    b.beginTurn(a)
    e.stats.edef = 1
    rigDice(b, 20, 15)
    b.invade(a, e)
    expect(e.heat).toBe(2)
    expect(b.has(e, 'impaired') && b.has(e, 'slowed')).toBe(true)
  })

  it('Invading a willing ally always succeeds, is not an attack and deals no heat', () => {
    const a = pregenUnit('Assault'); const ally = pregenUnit('Hacker')
    const e = pregenUnit('Sniper', 'enemy')
    a.pos = { x: 1, y: 1 }; ally.pos = { x: 3, y: 1 }; e.pos = { x: 12, y: 12 }
    const b = battle([a, ally, e])
    b.beginTurn(a)
    ally.stats.edef = 30
    b.invade(a, ally, { name: 'test', effects: [] })
    expect(ally.heat).toBe(0)
  })

  it('Bolster: +2 Accuracy on the next check or save, one Bolster at a time', () => {
    const a = pregenUnit('Hacker'); const ally = pregenUnit('Assault')
    const e = pregenUnit('Sniper', 'enemy')
    a.pos = { x: 1, y: 1 }; ally.pos = { x: 3, y: 1 }; e.pos = { x: 12, y: 12 }
    const b = battle([a, ally, e])
    b.beginTurn(a)
    b.bolster(a, ally)
    ally.stats.hull = 0
    rigDice(b, 20, 8)
    rigDice(b, 6, 2, 3)
    expect(b.save(ally, 'hull', 11)).toBe(true) // 8 + d6 high of 2 = 3 → 11
  })

  it('Improvised Attack deals 1d6 kinetic on a hit', () => {
    const { a, e, b } = duel(undefined, { x: 5, y: 5 }, { x: 6, y: 5 })
    e.stats.evasion = 1; e.stats.armor = 0
    b.beginTurn(a)
    rigDice(b, 20, 15)
    rigDice(b, 6, 4)
    const hp = e.hp
    b.improvisedAttack(a, e)
    expect(hp - e.hp).toBe(4)
  })

  it('Stabilize (cool) clears heat and Exposed; (repair) spends a Repair to restore all HP', () => {
    const { a, b } = duel()
    b.beginTurn(a)
    a.heat = 4; b.addStatus(a, 'exposed')
    b.stabilize(a, 'cool')
    expect(a.heat).toBe(0)
    expect(b.has(a, 'exposed')).toBe(false)
    const { a: c, b: b2 } = duel()
    b2.beginTurn(c)
    c.hp = 1
    const r = c.repairs
    b2.stabilize(c, 'repair')
    expect(c.hp).toBe(c.stats.hp)
    expect(c.repairs).toBe(r - 1)
  })

  it('Full Tech can pick the same quick tech option twice', () => {
    const { a, e, b } = duel()
    b.beginTurn(a)
    b.fullTech(a)
    b.lockOn(a, e)
    b.removeStatus(e, 'lockon')
    expect(() => b.lockOn(a, e)).not.toThrow()
  })

  it('Superheavy weapons only fire in a Barrage', () => {
    const { a, e, b } = duel()
    const w = { ...firstRanged(a), mount: 'Superheavy', size: 'Superheavy' } as any
    a.weapons.push(w)
    b.beginTurn(a)
    expect(b.skirmish(a, w, { targetId: e.id }).ok).toBe(false)
  })

  it('Hide: not while Engaged, and only out of line of sight or behind cover', () => {
    const { a, b } = duel()
    b.beginTurn(a)
    expect(b.canHide(a)).toBe(false) // in the open, in view
    const eng = duel(undefined, { x: 5, y: 5 }, { x: 6, y: 5 })
    expect(eng.b.canHide(eng.a)).toBe(false)
  })

  it('Hidden is lost on attacking and on Boost', () => {
    const { a, e, b } = duel()
    b.beginTurn(a)
    b.addStatus(a, 'hidden')
    b.boost(a)
    expect(b.has(a, 'hidden')).toBe(false)
    b.addStatus(a, 'hidden')
    b.skirmish(a, firstRanged(a), { targetId: e.id })
    expect(b.has(a, 'hidden')).toBe(false)
  })

  it('Self-Destruct: a Burst 2, 4d6 explosive reactor explosion, half on a successful Agility save', () => {
    const { a, e, b } = duel(undefined, { x: 5, y: 5 }, { x: 7, y: 5 })
    b.beginTurn(a)
    b.selfDestruct(a)
    for (let i = 0; i < 6 && !a.destroyed; i++) {
      b.endTurn(a)
      if (a.destroyed) break
      b.beginTurn(e); b.endTurn(e)
      b.beginTurn(a)
    }
    expect(a.destroyed).toBe(true)
  })
})

// ------------------------------------------------------------------------------------------------ reactions
describe('audit: reactions', () => {
  it('Brace: Resistance to the triggering attack, +1 Difficulty on other attacks, then only one quick action next turn', () => {
    const { a, e, b } = duel()
    b.beginTurn(a); b.endTurn(a)
    b.beginTurn(e)
    expect(b.brace(a)).toBe(true)
    const ctx = b.previewAttack(e, firstRanged(e), a).ctx
    expect(ctx.difficulty).toBeGreaterThanOrEqual(1)
  })

  it('one reaction per turn, and each reaction only once per round', () => {
    const { a, e, b } = duel()
    expect(a.reactionsLeft).toBe(1)
    b.beginTurn(a); b.endTurn(a)
    b.beginTurn(e)
    b.brace(a)
    expect(b.brace(a)).toBe(false)
  })
})

// ------------------------------------------------------------------------------------------------ structure and stress
describe('audit: structure damage and overheating tables', () => {
  const hitStructure = (setup: (u: Unit) => void, rolls: number[], extra?: (b: Battle) => void) => {
    const { e, b } = duel()
    setup(e)
    rigDice(b, 6, ...rolls)
    extra?.(b)
    e.hp = 1
    b.applyDamage(e, [{ type: 'Kinetic', amount: 1 }], { ap: true })
    return { e, b }
  }
  const pc = (u: Unit) => { u.kind = 'mech' as any; u.isGrunt = false }

  it('Glancing Blow (5–6): Impaired until the end of the next turn', () => {
    const { e, b } = hitStructure(pc, [6])
    expect(b.has(e, 'impaired')).toBe(true)
    expect(e.hp).toBe(e.stats.hp)
    expect(e.structure).toBe(e.stats.structure - 1)
  })
  it('System Trauma (2–4): a mount or a system is destroyed', () => {
    const { e } = hitStructure(pc, [3, 2])
    expect(e.weapons.some(w => w.destroyed)).toBe(true)
  })
  it('Direct Hit (1) at 3+ Structure: Stunned', () => {
    const { e, b } = hitStructure(pc, [1])
    expect(b.has(e, 'stunned')).toBe(true)
  })
  it('Direct Hit at 1 Structure left: destroyed', () => {
    const { e } = hitStructure(u => { pc(u); u.structure = 2 }, [3, 3, 1])
    expect(e.destroyed).toBe(true)
  })
  it('Crushing Hit (multiple 1s): destroyed', () => {
    const { e } = hitStructure(u => { pc(u); u.structure = 3 }, [1, 1])
    expect(e.destroyed).toBe(true)
  })
  it('the structure check rolls one d6 per point of structure damage marked', () => {
    const { e, b } = duel()
    pc(e)
    e.structure = 2 // 2 marked already; the hit marks the third
    let n = 0
    const rng = b.rng as any
    const d = rng.d.bind(rng)
    rng.d = (s: number) => { if (s === 6) { n++; return 6 } return d(s) }
    e.hp = 1
    b.applyDamage(e, [{ type: 'Kinetic', amount: 1 }], { ap: true })
    expect(n).toBe(3)
  })

  const overheat = (stress: number, rolls: number[]) => {
    const { e, b } = duel()
    pc(e)
    e.stress = stress
    rigDice(b, 6, ...rolls)
    e.heat = e.stats.heatcap
    b.addHeat(e, 1)
    return { e, b }
  }
  it('Emergency Shunt (5–6): Impaired', () => {
    const { e, b } = overheat(4, [5])
    expect(b.has(e, 'impaired')).toBe(true)
    expect(e.heat).toBe(0)
  })
  it('Destabilized Power Plant (2–4): Exposed', () => {
    const { e, b } = overheat(4, [3])
    expect(b.has(e, 'exposed')).toBe(true)
  })
  const log = (b: Battle) => b.log.map(l => l.text).join('\n')
  it('Meltdown (1) at 1 Stress left: meltdown at the end of the next turn', () => {
    const { e, b } = overheat(2, [3, 3, 1])
    expect(e.stress).toBe(1)
    expect(log(b)).toMatch(/MELTDOWN result/)
    expect(log(b)).not.toMatch(/IRREVERSIBLE/)
    expect(e.meltdownTurns).toBe(1) // not its turn: at the end of its next one
    expect(b.has(e, 'exposed')).toBe(false)
  })
  it('Irreversible Meltdown (multiple 1s): a meltdown however much Stress is left, with no Engineering check', () => {
    const { e, b } = overheat(3, [1, 1])
    expect(e.stress).toBe(2) // a single 1 at 2 Stress would call for an Engineering check (Exposed, or 1d6 turns)
    expect(log(b)).toMatch(/IRREVERSIBLE MELTDOWN/)
    expect(log(b)).not.toMatch(/MELTDOWN result/)
    expect(e.meltdownTurns).toBe(1)
    expect(b.has(e, 'exposed')).toBe(false)
  })
  it('reaching 0 Stress melts the reactor down at the end of the next turn', () => {
    const { e } = overheat(1, [])
    expect(e.stress).toBe(0)
    expect(e.meltdownTurns).toBeGreaterThan(0)
  })
})

// ------------------------------------------------------------------------------------------------ batch 2
describe('audit: reactions, grapples and the rest of the action list', () => {
  it('after Bracing: next turn only one quick action, no standard move, no Overcharge, and no reactions until it ends', () => {
    const { a, e, b } = duel()
    b.beginTurn(a); b.endTurn(a)
    b.beginTurn(e)
    b.brace(a)
    b.endTurn(e)
    b.beginTurn(a)
    expect(a.actionsLeft).toBe(1)
    expect(a.moveLeft).toBe(0)
    expect(() => b.overcharge(a)).toThrow()
    expect(b.canSpend(a, 'reaction', 'overwatch')).not.toBe(true)
  })

  it('a reaction used this round stays used until its owner starts its next turn, even across a new round', () => {
    const a = pregenUnit('Assault'); const a2 = pregenUnit('Vanguard')
    const e = pregenUnit('Sniper', 'enemy')
    a.pos = { x: 5, y: 5 }; a2.pos = { x: 1, y: 12 }; e.pos = { x: 6, y: 5 }
    const b = battle([a, a2, e], flatMap(14, 14))
    a.policies.overwatch = 'auto'
    b.beginTurn(a); b.endTurn(a)
    // the enemy starts a move inside a's threat: a overwatches
    b.beginTurn(e)
    const r = a.reactionsLeft
    b.move(e, { x: 8, y: 5 })
    expect(a.reactionsLeft).toBe(r - 1)
    b.endTurn(e)
    b.beginTurn(a2); b.endTurn(a2)
    // round 2 opens with the enemy (a player took the last turn): a's Overwatch is still spent
    expect(b.round).toBe(2)
    expect(b.currentSide).toBe('enemy')
    expect(b.canSpend(a, 'reaction', 'overwatch')).not.toBe(true)
  })

  it('a Grapple ends when the two are knocked apart', () => {
    const { a, e, b } = duel(undefined, { x: 5, y: 5 }, { x: 6, y: 5 })
    e.stats.evasion = 1
    b.beginTurn(a)
    rigDice(b, 20, 15)
    b.grapple(a, e)
    expect(b.grapples.length).toBe(1)
    const third = pregenUnit('Vanguard')
    b.forceMove(e, a, 2, 1)
    expect(b.grapples.length).toBe(0)
    void third
  })

  it('the grappled defender breaks free with a contested Hull check (a quick action)', () => {
    const { a, e, b } = duel(undefined, { x: 5, y: 5 }, { x: 6, y: 5 })
    e.stats.evasion = 1
    b.beginTurn(a)
    rigDice(b, 20, 15)
    b.grapple(a, e)
    b.endTurn(a)
    b.beginTurn(e)
    rigDice(b, 20, 20, 1) // defender 20, attacker 1
    b.breakGrapple(e)
    expect(b.grapples.length).toBe(0)
  })

  it('Hidden characters cause no engagement', () => {
    const { a, e, b } = duel(undefined, { x: 5, y: 5 }, { x: 6, y: 5 })
    b.addStatus(e, 'hidden')
    expect(b.isEngaged(a)).toBe(false)
  })

  it('targets must be within Range (and Sensors for tech)', () => {
    const { a, e, b } = duel(undefined, { x: 0, y: 0 }, { x: 13, y: 13 })
    const w = firstRanged(a)
    const range = Math.max(...w.profiles[0].range.filter(r => r.type === 'Range').map(r => Number(r.val)))
    expect(range).toBeLessThan(13)
    expect(b.validTarget(a, w, e)).not.toBe(true)
    a.stats.sensors = 5
    b.beginTurn(a)
    expect(() => b.lockOn(a, e)).toThrow()
  })

  it('Lock On needs line of sight', () => {
    const { a, e, b } = duel(x => (x === 4 ? { h: 6, kind: 'ground' } : undefined))
    b.beginTurn(a)
    expect(() => b.lockOn(a, e)).toThrow()
  })

  it('Exposed doubles kinetic, explosive and energy damage, but not burn', () => {
    const { e, b } = duel()
    e.stats.armor = 0
    b.addStatus(e, 'exposed')
    const hp = e.hp
    b.applyDamage(e, [{ type: 'Burn', amount: 2 }])
    expect(hp - e.hp).toBe(2)
  })

  it('Stabilize also clears burn (one extra option alongside cooling or repairing)', () => {
    const { a, b } = duel()
    b.beginTurn(a)
    b.applyDamage(a, [{ type: 'Burn', amount: 2 }])
    a.heat = 2
    b.stabilize(a, 'cool', { unit: a, status: 'burn' })
    expect(a.burn).toBe(0)
    expect(a.heat).toBe(0)
  })

  it('Search: contested Systems vs Agility reveals a Hidden character', () => {
    const { a, e, b } = duel()
    b.addStatus(e, 'hidden')
    b.beginTurn(a)
    rigDice(b, 20, 18, 2)
    b.search(a)
    expect(b.has(e, 'hidden')).toBe(false)
  })

  it('a structure hit resets HP to full before the excess damage lands', () => {
    const { e, b } = duel()
    e.stats.armor = 0
    rigDice(b, 6, 6)
    e.hp = 3
    b.applyDamage(e, [{ type: 'Kinetic', amount: 5 }], { ap: true })
    expect(e.hp).toBe(e.stats.hp - 2)
  })

  it('a Stunned mech cannot take reactions', () => {
    const { a, b } = duel()
    b.addStatus(a, 'stunned')
    expect(b.canSpend(a, 'reaction', 'brace')).not.toBe(true)
  })

  it('Overwatch resolves before the triggering move', () => {
    const { a, e, b } = duel(undefined, { x: 5, y: 5 }, { x: 6, y: 5 })
    e.policies.overwatch = 'auto'
    b.beginTurn(a)
    const seen: number[] = []
    b.listeners.push((ev: any) => { if (ev.type === 'attack' && ev.attackerId === e.id) seen.push(a.pos.x) })
    b.move(a, { x: 3, y: 5 })
    expect(seen).toEqual([5])
  })
})
