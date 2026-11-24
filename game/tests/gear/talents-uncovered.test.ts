// Talent ranks that had no behaviour test (Brawler, Combined Arms, Hunter, Skirmisher, Tactician, Vanguard,
// Grease Monkey, Nuclear Cavalier, Technophile). Titles quote the lancer-data rank text.
import { describe, expect, it } from 'vitest'
import type { Battle } from '../../src/rules/battle'
import type { Unit } from '../../src/rules/types'
import { act, arena, flatMap, mech, rigDice, type PilotOpts } from '../support'

const w = (u: Unit, id: string) => u.weapons.find(x => x.dataId === id)!
const custom = (b: Battle, u: Unit, re: RegExp) => {
  const x = b.customActions(u).find(c => re.test(c.name) || re.test(c.key))
  if (!x) throw new Error(`no action ${re}: ${b.customActions(u).map(c => c.name).join(', ')}`)
  return x
}
/** a mech with these talents (player, active, attack bonus 0 so rigged d20s don't crit by accident) and a plain enemy */
function setup(talents: [string, number][], eAt = { x: 5, y: 8 }, o: PilotOpts = {}, map = flatMap(16, 16)) {
  const a = mech({ talents, ...o })
  const e = mech({ callsign: 'Foe' }, 'enemy')
  const b = arena([[a, { x: 5, y: 4 }], [e, eAt]], { map })
  act(b, a)
  a.stats.attackBonus = 0
  return { a, e, b }
}
const toEnemy = (b: Battle, a: Unit, e: Unit) => { b.endTurn(a); act(b, e) }
const addUnit = (b: Battle, u: Unit, x: number, y: number) => { u.pos = { x, y }; b.units.push(u); return u }

describe('Brawler', () => {
  it('1 Hold and Lock: "+1 Accuracy on all melee attacks against targets you are Grappling"', () => {
    const { a, e, b } = setup([['t_brawler', 1]], { x: 5, y: 5 }, { weapons: 'mw_tactical_melee_weapon' })
    const blade = w(a, 'mw_tactical_melee_weapon')
    expect(b.buildWeaponCtx(a, blade, e, 'free', false).accuracy).toBe(0)
    rigDice(b, 20, 20) // the grapple hits
    b.grapple(a, e)
    expect(b.has(e, 'grappled')).toBe(true)
    expect(b.buildWeaponCtx(a, blade, e, 'free', false).accuracy).toBe(1)
  })
  it('2 Sledgehammer: "Your Improvised Attacks gain Knockback 2 and deal 2d6+2 Kinetic damage"', () => {
    const { a, e, b } = setup([['t_brawler', 2]], { x: 5, y: 5 })
    rigDice(b, 20, 15)
    rigDice(b, 6, 3, 3)
    b.improvisedAttack(a, e)
    expect(e.hp).toBe(e.stats.hp - 8)
    expect(e.pos).toEqual({ x: 5, y: 7 })
  })
  it('3 Knockout Blow: Ram/Grapple/Improvised lower the Brawler Die; at 1, a Knockout Blow (Hull save or Stunned) resets it to 6', () => {
    const { a, e, b } = setup([['t_brawler', 3]], { x: 5, y: 5 })
    expect(custom(b, a, /Knockout Blow/).usable(b, a)).toBe('Brawler die 6')
    rigDice(b, 20, 1)
    b.ram(a, e)
    expect(a.flags.brawlerDie).toBe(5)
    a.flags.brawlerDie = 1
    toEnemy(b, a, e); b.endTurn(e); act(b, a)
    e.pos = { x: 5, y: 5 }
    rigDice(b, 20, 1) // the Hull save
    b.useCustom(a, custom(b, a, /Knockout Blow/), e)
    expect(b.has(e, 'stunned')).toBe(true)
    expect(a.flags.brawlerDie).toBe(6)
  })
})

describe('Combined Arms', () => {
  it('1 Shield of Blades: "As long as you\'re Engaged, you and any allies adjacent to you count as having soft cover"', () => {
    const { a, e, b } = setup([['t_combined_arms', 1]], { x: 5, y: 12 })
    const ally = addUnit(b, mech({ callsign: 'Ally' }), 4, 4)
    expect(b.cover(e, a)).toBe('none')
    addUnit(b, mech({ callsign: 'Brawler' }, 'enemy'), 6, 4)
    b.invalidateTerrain()
    expect(b.isEngaged(a)).toBe(true)
    expect(b.cover(e, a)).toBe('soft')
    expect(b.cover(e, ally)).toBe('soft')
  })
  it('2 CQB-Trained: "You don\'t gain Difficulty from being Engaged"', () => {
    const { a, e, b } = setup([['t_combined_arms', 2]], { x: 5, y: 10 })
    addUnit(b, mech({ callsign: 'Brawler' }, 'enemy'), 6, 4)
    const ctx = b.buildWeaponCtx(a, w(a, 'mw_assault_rifle'), e, 'free', false)
    expect(ctx.reasons).toContain('Engaged -1')
    expect(ctx.difficulty).toBe(0)
  })
  it('3 Storm of Violence: hitting in melee gives "+1 Accuracy on your next ranged attack against them"', () => {
    const { a, e, b } = setup([['t_combined_arms', 3]], { x: 5, y: 5 }, { weapons: [['Main', 'mw_tactical_melee_weapon'], ['Main', 'mw_assault_rifle']] })
    e.stats.hp = 40; e.hp = 40
    rigDice(b, 20, 15)
    b.weaponAttack(a, w(a, 'mw_tactical_melee_weapon'), { targetId: e.id }, 'free')
    const rifle = w(a, 'mw_assault_rifle')
    const ctx = b.buildWeaponCtx(a, rifle, e, 'free', false)
    expect(ctx.accuracy).toBe(1)
    expect(b.buildWeaponCtx(a, rifle, e, 'free', false).accuracy).toBe(0) // "This effect doesn't stack": used up
  })
})

describe('Hunter', () => {
  // regression (fixed): "1/round, when you attack with an Auxiliary melee weapon, you may fly up to 3 spaces directly towards the targeted
  // character before the attack." Lunge only runs inside beforeAttack and skips adjacent targets, but a non-adjacent target
  // is already refused as out of Threat, so the lunge can never happen.
  it('1 Lunge: "when you attack with an Auxiliary melee weapon, you may fly up to 3 spaces directly towards the targeted character"', () => {
    const { a, e, b } = setup([['t_hunter', 1]], { x: 5, y: 8 }, { weapons: [['Auxiliary', 'mw_segment_knife']] })
    rigDice(b, 20, 15)
    b.weaponAttack(a, w(a, 'mw_segment_knife'), { targetId: e.id }, 'free')
    expect(a.pos).toEqual({ x: 5, y: 7 })
    expect(e.hp).toBeLessThan(e.stats.hp)
  })
  it('2 Knife Juggler: "All your Auxiliary melee weapons gain Thrown 5"', () => {
    const { a, b } = setup([['t_hunter', 2]], undefined, { weapons: [['Auxiliary', 'mw_segment_knife']] })
    expect(b.weaponReach(a, w(a, 'mw_segment_knife'))).toBe(5)
    const plain = setup([], undefined, { weapons: [['Auxiliary', 'mw_segment_knife']] })
    expect(plain.b.weaponReach(plain.a, w(plain.a, 'mw_segment_knife'))).toBe(1)
  })
  it('3 Disdainful Blade: "when you hit … with a melee attack, you may also throw an Auxiliary melee weapon … as a free action"', () => {
    const { a, e, b } = setup([['t_hunter', 3]], { x: 5, y: 5 }, { weapons: [['Main', 'mw_tactical_melee_weapon'], ['Auxiliary', 'mw_tactical_knife']] })
    e.stats.hp = 40; e.hp = 40
    rigDice(b, 20, 15, 15) // the blade, then the thrown knife
    rigDice(b, 6, 3) // blade: 1d6+2
    rigDice(b, 3, 2) // knife: 1d3+1
    const r = b.weaponAttack(a, w(a, 'mw_tactical_melee_weapon'), { targetId: e.id }, 'free')
    expect(r.ctxs[0].hit).toBe(true)
    expect(e.hp).toBe(40 - 5 - 3)
  })
})

describe('Skirmisher', () => {
  it('1 Integrated Chaff Launchers: "At the start of your turn, you gain soft cover. You lose this cover if you attack"', () => {
    const { a, e, b } = setup([['t_skirmisher', 1]])
    expect(b.cover(e, a)).toBe('soft')
    rigDice(b, 20, 1)
    b.weaponAttack(a, w(a, 'mw_assault_rifle'), { targetId: e.id }, 'free')
    b.invalidateTerrain()
    expect(b.cover(e, a)).toBe('none')
  })
  it('2 Lockbreaker: after you Skirmish, "you may move 2 spaces. This movement ignores engagement"', () => {
    const { a, e, b } = setup([['t_skirmisher', 2]], { x: 5, y: 9 })
    addUnit(b, mech({ callsign: 'Brawler' }, 'enemy'), 6, 4)
    // "before or after you Skirmish": offered before it too, while a quick action is left for the Skirmish
    expect(custom(b, a, /Lockbreaker/).text).toMatch(/Before/)
    rigDice(b, 20, 1)
    b.skirmish(a, w(a, 'mw_assault_rifle'), { targetId: e.id })
    b.useCustom(a, custom(b, a, /Lockbreaker/), { x: 3, y: 4 })
    expect(a.pos).toEqual({ x: 3, y: 4 })
  })
  it('3 Weave: "The first attack taken as a reaction against you in any round automatically misses"', () => {
    const { a, e, b } = setup([['t_skirmisher', 3]], { x: 5, y: 7 })
    toEnemy(b, a, e)
    e.stats.attackBonus = 50
    rigDice(b, 20, 10, 10)
    const rifle = w(e, 'mw_assault_rifle')
    expect(b.weaponAttack(e, rifle, { targetId: a.id }, 'overwatch').ctxs[0].hit).toBe(false)
    expect(b.weaponAttack(e, rifle, { targetId: a.id }, 'overwatch').ctxs[0].hit).toBe(true)
  })
})

describe('Tactician', () => {
  it('1 Opportunist: "1/round, +1 Accuracy on any melee attack if at least one allied character is Engaged with your target"', () => {
    const { a, e, b } = setup([['t_tactician', 1]], { x: 5, y: 5 }, { weapons: 'mw_tactical_melee_weapon' })
    const blade = w(a, 'mw_tactical_melee_weapon')
    expect(b.buildWeaponCtx(a, blade, e, 'free', false).accuracy).toBe(0)
    addUnit(b, mech({ callsign: 'Ally' }), 6, 6)
    expect(b.buildWeaponCtx(a, blade, e, 'free', false).accuracy).toBe(1)
    expect(b.buildWeaponCtx(a, blade, e, 'free', false).accuracy).toBe(0) // 1/round
  })
  it('2 Solar Backdrop: "1/round, +1 Accuracy on any ranged attack made while you are at a higher elevation than your target"', () => {
    const map = flatMap(16, 16, (x, y) => (x === 5 && y === 4 ? { h: 2 } : undefined))
    const { a, e, b } = setup([['t_tactician', 2]], { x: 5, y: 8 }, {}, map)
    expect(b.elevation(a)).toBeGreaterThan(b.elevation(e))
    expect(b.buildWeaponCtx(a, w(a, 'mw_assault_rifle'), e, 'free', false).accuracy).toBe(1)
  })
  it('3 Overlapping Fire: Flank – when an ally hits a target within your threat, attack it as a reaction', () => {
    const { a, e, b } = setup([['t_tactician', 3]], { x: 5, y: 5 }, { weapons: 'mw_tactical_melee_weapon' })
    const ally = addUnit(b, mech({ callsign: 'Ally' }), 5, 9)
    b.endTurn(a)
    act(b, ally)
    ally.stats.attackBonus = 0
    e.stats.hp = 40; e.hp = 40
    const reactions = a.reactionsLeft
    rigDice(b, 20, 15, 15) // the ally's shot, then the flanking attack
    b.weaponAttack(ally, w(ally, 'mw_assault_rifle'), { targetId: e.id }, 'free')
    expect(a.reactionsLeft).toBe(reactions - 1)
  })
})

describe('Vanguard', () => {
  it('1 Handshake Etiquette: "+1 Accuracy when using CQB weapons to attack targets within Range 3"', () => {
    const { a, e, b } = setup([['t_vanguard', 1]], { x: 5, y: 7 }, { weapons: 'mw_shotgun' })
    const shotgun = w(a, 'mw_shotgun')
    expect(b.buildWeaponCtx(a, shotgun, e, 'free', false).accuracy).toBe(1)
    e.pos = { x: 5, y: 8 }
    expect(b.buildWeaponCtx(a, shotgun, e, 'free', false).accuracy).toBe(0)
  })
  it('2 See-Through Seeker: "you ignore both soft and hard cover when using CQB weapons to attack targets within Range 3"', () => {
    const { a, e, b } = setup([['t_vanguard', 2]], { x: 5, y: 7 }, { weapons: 'mw_shotgun' })
    b.addArea({ kind: 'soft_cover', tiles: [{ x: 5, y: 7 }], expiresRound: 99, ownerId: e.id })
    expect(b.cover(a, e)).toBe('soft')
    const ctx = b.buildWeaponCtx(a, w(a, 'mw_shotgun'), e, 'free', false)
    expect(ctx.difficulty).toBe(0)
    expect(ctx.reasons).toContain('See-Through Seeker')
  })
  it('3 Semper Vigilo: "You may attack with Overwatch using CQB weapons when hostile characters enter … spaces within your Threat"', () => {
    const { a, e, b } = setup([['t_vanguard', 3]], { x: 5, y: 10 }, { weapons: 'mw_shotgun' })
    toEnemy(b, a, e)
    const reactions = a.reactionsLeft
    b.move(e, { x: 5, y: 7 }) // into Threat 3
    expect(a.reactionsLeft).toBe(reactions - 1)
  })
})

describe('Grease Monkey, Nuclear Cavalier, Technophile', () => {
  it('Grease Monkey 2 Machine Bond: "When you STABILIZE, you clear all IMPAIRED, JAMMED, IMMOBILIZED, SLOWED, and LOCK ON"', () => {
    const { a, e, b } = setup([['t_grease_monkey', 2]])
    for (const s of ['impaired', 'jammed', 'immobilized', 'slowed', 'lockon'] as const) b.addStatus(a, s, 'until_cleared', e)
    b.stabilize(a, 'cool')
    expect(a.statuses.map(s => s.id)).toEqual([])
  })
  it('Nuclear Cavalier 1 Aggressive Heat Bleed: "The first attack roll you make on your turn while in the Danger Zone deals +2 Heat on a hit"', () => {
    const { a, e, b } = setup([['t_nuclear_cavalier', 1]])
    a.heat = Math.ceil(a.stats.heatcap / 2)
    e.stats.hp = 40; e.hp = 40
    rigDice(b, 20, 15, 15)
    const rifle = w(a, 'mw_assault_rifle')
    b.weaponAttack(a, rifle, { targetId: e.id }, 'free')
    expect(e.heat).toBe(2)
    b.weaponAttack(a, rifle, { targetId: e.id }, 'free')
    expect(e.heat).toBe(2)
  })
  it('Nuclear Cavalier 2 Fusion Hemorrhage: the first attack in the Danger Zone deals "+1d6 Energy bonus damage on a hit"', () => {
    const { a, e, b } = setup([['t_nuclear_cavalier', 2]])
    a.heat = Math.ceil(a.stats.heatcap / 2)
    e.stats.hp = 40; e.hp = 40
    rigDice(b, 20, 15)
    rigDice(b, 6, 4, 2)
    const r = b.weaponAttack(a, w(a, 'mw_assault_rifle'), { targetId: e.id }, 'free')
    expect(r.ctxs[0].bonusDamage).toContainEqual({ type: 'Energy', val: '1d6' })
    expect(e.hp).toBe(40 - 6)
  })
  // regression (fixed): "The first ranged or melee attack roll … deals Energy instead of Kinetic or Explosive" — only the bonus is added.
  it('Nuclear Cavalier 2 Fusion Hemorrhage: the attack "deals Energy instead of Kinetic" (Kinetic resistance does not apply)', () => {
    const { a, e, b } = setup([['t_nuclear_cavalier', 2]])
    a.heat = Math.ceil(a.stats.heatcap / 2)
    e.stats.hp = 40; e.hp = 40
    e.resist.push('Kinetic')
    rigDice(b, 20, 15)
    rigDice(b, 6, 4, 2)
    b.weaponAttack(a, w(a, 'mw_assault_rifle'), { targetId: e.id }, 'free')
    expect(e.hp).toBe(40 - 6)
  })
  it('Technophile 3 Enlightenment: "AIs installed in your mech cannot enter cascade" (the no-cascade bonus)', () => {
    const plain = mech({})
    const a = mech({ talents: [['t_technophile', 3]] })
    expect(plain.bonuses.some(x => x.id === 'no_cascade')).toBe(false)
    expect(a.bonuses.some(x => x.id === 'no_cascade')).toBe(true)
  })
})
