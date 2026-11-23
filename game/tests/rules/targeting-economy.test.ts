// Who can be targeted (validTarget), what an attack's accuracy/difficulty/defence come to (buildWeaponCtx), and the
// action economy gate (canSpend). src/rules/battle/attacks.ts and turns.ts.
import { describe, expect, it } from 'vitest'
import type { Unit } from '../../src/rules/types'
import { act, arena, duel, flatMap, mech } from '../support'

// a 2-high wall right next to the target, on the attacker's side (column 5)
const wallAt5 = (x: number, y: number) => (x === 5 && y === 5 ? { h: 2, kind: 'block' as const } : undefined)
// the same spot, 1 high: hard cover for a size-1 target without blocking line of sight
const lowWallAt5 = (x: number, y: number) => (x === 5 && y === 5 ? { h: 1, kind: 'block' as const } : undefined)
// a tall wall across the whole map at column 4: no line of sight between x < 4 and x > 4
const fullWall = (x: number) => (x === 4 ? { h: 4, kind: 'block' as const } : undefined)

const weapon = (u: Unit) => u.weapons[0]

describe('validTarget', () => {
  it('a character cannot target itself', () => {
    const { a, b } = duel()
    expect(b.validTarget(a, weapon(a), a)).toBe('Cannot target self')
  })

  it('an Intangible character cannot be targeted', () => {
    const { a, e, b } = duel()
    expect(b.validTarget(a, weapon(a), e)).toBe(true)
    e.flags.intangible = true
    expect(b.validTarget(a, weapon(a), e)).toBe('Intangible')
  })

  it('Ordnance cannot target a hostile engaged with the attacker, but can one 2 spaces away', () => {
    const a = mech({ weapons: [['Heavy', 'mw_anti_materiel_rifle']] }), e = mech({}, 'enemy')
    const b = arena([[a, { x: 3, y: 5 }], [e, { x: 4, y: 5 }]])
    expect(b.validTarget(a, weapon(a), e)).toBe('Ordnance can’t target characters engaged with you')
    e.pos = { x: 5, y: 5 }
    b.invalidateTerrain()
    expect(b.validTarget(a, weapon(a), e)).toBe(true)
    // a non-Ordnance weapon may shoot the adjacent hostile
    const r = mech({}), e2 = mech({}, 'enemy')
    const b2 = arena([[r, { x: 3, y: 5 }], [e2, { x: 4, y: 5 }]])
    expect(b2.validTarget(r, weapon(r), e2)).toBe(true)
  })

  it('Arcing and Seeking weapons ignore line of sight; a normal weapon is blocked', () => {
    const rifle = mech(), mortar = mech({ weapons: 'mw_mortar' }), seeker = mech({ weapons: 'mw_smartgun' }), e = mech({}, 'enemy')
    const b = arena([[rifle, { x: 1, y: 3 }], [mortar, { x: 1, y: 5 }], [seeker, { x: 1, y: 7 }], [e, { x: 7, y: 5 }]], { map: flatMap(12, 12, fullWall) })
    expect(b.validTarget(rifle, weapon(rifle), e)).toBe('No line of sight')
    expect(b.validTarget(mortar, weapon(mortar), e)).toBe(true)
    expect(b.validTarget(seeker, weapon(seeker), e)).toBe(true)
  })

  it('out of range reports distance and reach', () => {
    const { a, e, b } = duel({ size: 16, e: { x: 13, y: 5 } })
    expect(b.validTarget(a, weapon(a), e)).toBe('Out of range (12/10)')
    e.pos = { x: 11, y: 5 }
    expect(b.validTarget(a, weapon(a), e)).toBe(true)
  })
})

describe('buildWeaponCtx', () => {
  it('Accurate adds +1 accuracy; Inaccurate +1 difficulty', () => {
    const acc = mech({ weapons: [['Heavy', 'mw_anti_materiel_rifle']] }), inacc = mech({ weapons: [['Heavy', 'mw_heavy_machine_gun']] }), plain = mech(), e = mech({}, 'enemy')
    const b = arena([[acc, { x: 1, y: 3 }], [inacc, { x: 1, y: 5 }], [plain, { x: 1, y: 7 }], [e, { x: 6, y: 5 }]])
    const c1 = b.buildWeaponCtx(acc, weapon(acc), e, 'skirmish', false)
    expect([c1.accuracy, c1.difficulty, c1.reasons]).toEqual([1, 0, ['Accurate +1']])
    const c2 = b.buildWeaponCtx(inacc, weapon(inacc), e, 'skirmish', false)
    expect([c2.accuracy, c2.difficulty, c2.reasons]).toEqual([0, 1, ['Inaccurate -1']])
    const c3 = b.buildWeaponCtx(plain, weapon(plain), e, 'skirmish', false)
    expect([c3.accuracy, c3.difficulty, c3.reasons]).toEqual([0, 0, []])
  })

  it('Smart weapons attack E-Defense; others Evasion', () => {
    const smart = mech({ weapons: 'mw_nexus_hunter_killer' }), plain = mech(), e = mech({}, 'enemy')
    const b = arena([[smart, { x: 1, y: 3 }], [plain, { x: 1, y: 7 }], [e, { x: 6, y: 5 }]])
    e.stats.evasion = 7
    e.stats.edef = 12
    expect(b.defenseOf(e, b.buildWeaponCtx(smart, weapon(smart), e, 'skirmish', false))).toBe(12)
    expect(b.defenseOf(e, b.buildWeaponCtx(plain, weapon(plain), e, 'skirmish', false))).toBe(7)
  })

  it('a Blast attack takes cover from the blast centre, not from the attacker', () => {
    // attacker at x1, wall at x5, target at x6: the wall is between the attacker and the target
    const setup = () => {
      const a = mech({ weapons: [['Heavy', 'mw_howitzer']] }), e = mech({}, 'enemy')
      const b = arena([[a, { x: 1, y: 5 }], [e, { x: 6, y: 5 }]], { map: flatMap(14, 14, wallAt5) })
      a.stats.attackBonus = 30
      return { a, e, b }
    }
    const s0 = setup()
    expect(s0.b.cover(s0.a, s0.e)).toBe('hard')
    // centre beyond the target (x8): the wall is behind the target as seen from there, so no cover
    const s1 = setup()
    const r1 = s1.b.weaponAttack(s1.a, weapon(s1.a), { tile: { x: 8, y: 5 } }, 'free')
    expect(r1.ok).toBe(true)
    const t1 = r1.ctxs.find(c => c.target === s1.e)!
    expect(t1.reasons.filter(r => /cover/.test(r))).toEqual([])
    // centre on the attacker's side of the wall (x4): hard cover
    const s2 = setup()
    const r2 = s2.b.weaponAttack(s2.a, weapon(s2.a), { tile: { x: 4, y: 5 } }, 'free')
    const t2 = r2.ctxs.find(c => c.target === s2.e)!
    expect(t2.reasons).toContain('Hard cover -2')
    expect(s2.b.blastCentre).toBeNull()
  })

  it('a Thrown weapon beyond its threat is a ranged attack (cover applies); within threat it is melee', () => {
    // a Thrown range as the enemy data models it (data/enemies "Thrown Blades": Threat 1, Thrown 3)
    const a = mech({ weapons: [['Auxiliary', 'mw_tactical_knife']] }), e = mech({}, 'enemy')
    weapon(a).profiles[0].range = [{ type: 'Threat', val: 1 }, { type: 'Thrown', val: 3 }]
    const b = arena([[a, { x: 3, y: 5 }], [e, { x: 6, y: 5 }]], { map: flatMap(14, 14, lowWallAt5) })
    expect(b.weaponThreat(a, weapon(a))).toBe(1)
    expect(b.validTarget(a, weapon(a), e)).toBe(true)
    const far = b.buildWeaponCtx(a, weapon(a), e, 'skirmish', false)
    expect([far.melee, far.ranged]).toEqual([false, true])
    expect(far.reasons).toEqual(['Hard cover -2'])
    expect(far.difficulty).toBe(2)
    // adjacent (beside the wall, at y 6): melee, no cover
    e.pos = { x: 4, y: 6 }
    b.invalidateTerrain()
    const near = b.buildWeaponCtx(a, weapon(a), e, 'skirmish', false)
    expect([near.melee, near.ranged, near.difficulty]).toEqual([true, false, 0])
  })

  // BUG: the official THROWN X tag (Tactical Knife Thrown 3, Shock Knife Thrown 5, War Pike Thrown 5) never becomes a
  // reach: weaponReach only reads 'Thrown' range entries and 'thrown' bonuses, so validTarget says 'Out of range (3/1)'.
  // Core book: "Thrown X: this melee weapon can be thrown at targets within range X". coverage.ts lists tg_thrown as supported.
  it.fails('an official Thrown X weapon (Tactical Knife, Thrown 3) can be thrown 3 spaces', () => {
    const a = mech({ weapons: [['Auxiliary', 'mw_tactical_knife']] }), e = mech({}, 'enemy')
    const b = arena([[a, { x: 3, y: 5 }], [e, { x: 6, y: 5 }]])
    expect(b.validTarget(a, weapon(a), e)).toBe(true)
  })
})

describe('canSpend', () => {
  it('no reactions while Grappled, except Brace with Armor-Lock Plating', () => {
    const a = mech(), lock = mech({ systems: ['ms_armor_lock_plating'] }), e = mech({}, 'enemy'), e2 = mech({}, 'enemy')
    const b = arena([[a, { x: 3, y: 3 }], [e, { x: 4, y: 3 }], [lock, { x: 3, y: 7 }], [e2, { x: 4, y: 7 }]])
    expect(b.canSpend(a, 'reaction', 'overwatch')).toBe(true)
    b.startGrapple(e, a)
    b.startGrapple(e2, lock)
    expect(b.has(a, 'grappled')).toBe(true)
    expect(b.canSpend(a, 'reaction', 'overwatch')).toBe('Grappled')
    expect(b.canSpend(a, 'reaction', 'brace')).toBe('Grappled')
    expect(b.canSpend(lock, 'reaction', 'overwatch')).toBe('Grappled')
    expect(b.canSpend(lock, 'reaction', 'brace')).toBe(true)
  })

  it('Overwatch is once per round, unless the character has the Reflex trait', () => {
    const plain = mech(), reflex = mech(), e1 = mech({}, 'enemy'), e2 = mech({}, 'enemy')
    reflex.traits = ['reflex']
    const b = arena([[plain, { x: 1, y: 1 }], [reflex, { x: 1, y: 3 }], [e1, { x: 10, y: 1 }], [e2, { x: 10, y: 3 }]])
    act(b, e1)
    b.spend(plain, 'reaction', 'overwatch')
    b.spend(reflex, 'reaction', 'overwatch')
    expect(b.canSpend(plain, 'reaction', 'overwatch')).toBe('Already reacted this turn')
    b.endTurn(e1)
    act(b, e2) // a new turn refreshes the one-reaction-per-turn budget, not the per-round Overwatch
    expect(b.canSpend(plain, 'reaction', 'overwatch')).toBe('Overwatch already used this round')
    expect(b.canSpend(plain, 'reaction', 'brace')).toBe(true)
    expect(b.canSpend(reflex, 'reaction', 'overwatch')).toBe(true)
  })

  it('protocols only at the start of a turn, before any action', () => {
    const { a, b } = duel()
    act(b, a)
    expect(b.canSpend(a, 'protocol')).toBe(true)
    b.spend(a, 'protocol')
    expect(b.canSpend(a, 'protocol')).toBe(true) // a protocol is not "acting"
    b.spend(a, 'quick', 'search')
    expect(b.canSpend(a, 'protocol')).toBe('Protocols must be used at the start of a turn')
    expect(b.canSpend(a, 'free')).toBe(true)
  })

  it('after Bracing: one quick action, no full action, no free actions or protocols', () => {
    const { a, e, b } = duel()
    act(b, e)
    expect(b.brace(a)).toBe(true)
    b.endTurn(e)
    act(b, a)
    expect(a.actionsLeft).toBe(1)
    expect(a.moveLeft).toBe(0)
    expect(b.canSpend(a, 'free')).toBe('Recovering from brace')
    expect(b.canSpend(a, 'protocol')).toBe('Recovering from brace')
    expect(b.canSpend(a, 'full')).toBe('Needs a full action')
    expect(b.canSpend(a, 'quick', 'search')).toBe(true)
    expect(b.canSpend(a, 'reaction', 'overwatch')).toBe('Already reacted this turn')
  })

  it('Drake Fortress: a full action is allowed in the turn after Bracing', () => {
    const d = mech({ frame: 'mf_drake' }), e = mech({}, 'enemy')
    const b = arena([[d, { x: 2, y: 2 }], [e, { x: 3, y: 4 }]], { map: flatMap(14, 14) })
    act(b, d)
    b.activateCore(d)
    expect(d.flags.fortress).toBe(true)
    b.endTurn(d)
    act(b, e)
    expect(b.brace(d)).toBe(true)
    b.endTurn(e)
    expect(b.round).toBe(2)
    act(b, d)
    expect(d.actionsLeft).toBe(1)
    expect(b.canSpend(d, 'full')).toBe(true)
    expect(b.canSpend(d, 'free')).toBe('Recovering from brace')
  })
})
