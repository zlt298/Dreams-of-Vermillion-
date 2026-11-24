// Audit 2 fixes for pilot talents and core bonuses (lancer-data 4.0.12 text). One describe per talent tree.
import { describe, expect, it } from 'vitest'
import type { Battle } from '../../src/rules/battle'
import { getScript } from '../../src/rules/effects/registry'
import type { AttackCtx } from '../../src/rules/effects/registry'
import { applyRepair, freshCondition, repairOptions, newRun } from '../../src/run/run'
import type { Unit } from '../../src/rules/types'
import { act, arena, flatMap, mech, pilot, pregenUnit, rigDice, type PilotOpts } from '../support'
import { custom, toEnemyTurn, weapon } from './helpers'

/** `a` (a level-12 mech with these talents) at (5,4) against a plain enemy mech at `eAt`, on `a`'s turn; attack bonuses 0. */
function setup(talents: [string, number][], eAt = { x: 5, y: 8 }, o: PilotOpts = {}) {
  const a = mech({ level: 12, talents, ...o })
  const e = mech({ callsign: 'Foe' }, 'enemy')
  const b = arena([[a, { x: 5, y: 4 }], [e, eAt]], { map: flatMap(16, 16) })
  act(b, a)
  a.stats.attackBonus = 0
  e.stats.attackBonus = 0
  return { a, e, b }
}
const add = (b: Battle, u: Unit, x: number, y: number) => { u.pos = { x, y }; b.units.push(u); return u }
/** run `fn` answering the questions it asks with `answers` (in order); fail on any error */
function tx(b: Battle, fn: () => void, answers: number[] = []) {
  b.chooser = () => undefined
  const r = b.transaction(fn, answers)
  if ('error' in r && r.error) throw r.error
  if ('pending' in r) throw new Error(`unanswered question: ${r.pending.kind}`)
}

describe('Ace', () => {
  it('Ace 1 (Acrobatics): a flying Ace that is missed may fly 2 spaces as a reaction', () => {
    const { a, e, b } = setup([['t_ace', 1]])
    toEnemyTurn(b, a, e)
    a.flying = true // (a flyer that didn't move on its own turn lands, so take off after it)
    rigDice(b, 20, 1)
    const from = { ...a.pos }
    b.weaponAttack(e, weapon(e, 'mw_assault_rifle'), { targetId: a.id }, 'free')
    expect(a.reactionsLeft).toBe(0)
    expect(a.pos).not.toEqual(from)
    expect(Math.max(Math.abs(a.pos.x - from.x), Math.abs(a.pos.y - from.y))).toBeLessThanOrEqual(2)
  })
  it('Ace 1: not while landed', () => {
    const { a, e, b } = setup([['t_ace', 1]])
    toEnemyTurn(b, a, e)
    rigDice(b, 20, 1)
    b.weaponAttack(e, weapon(e, 'mw_assault_rifle'), { targetId: a.id }, 'free')
    expect(a.reactionsLeft).toBe(1)
  })
  it('Ace 2 (Afterburners) is optional: declining adds no move and no heat', () => {
    const { a, b } = setup([['t_ace', 2]])
    a.flying = true
    const heat = a.heat
    tx(b, () => b.boost(a), [1])
    expect(a.moveLeft).toBe(a.stats.speed * 2)
    expect(a.heat).toBe(heat)
    tx(b, () => { a.flags['turn:quickUsed'] = []; b.boost(a) }, [0])
    expect(a.moveLeft).toBeGreaterThan(a.stats.speed * 3)
  })
  it('Ace 2: the AI skips Afterburners when 3 heat could overheat it', () => {
    const { a, b } = setup([['t_ace', 2]])
    a.flying = true
    a.heat = a.stats.heatcap - 2
    b.boost(a)
    expect(a.heat).toBe(a.stats.heatcap - 2)
  })
})

describe('Brawler', () => {
  it('Brawler 3 (Knockout Blow): a failed Hull save deals 2d6+2 kinetic and Stuns', () => {
    const { a, e, b } = setup([['t_brawler', 3]], { x: 5, y: 5 })
    a.flags.brawlerDie = 1
    e.stats.armor = 0
    rigDice(b, 20, 1)
    rigDice(b, 6, 3, 4)
    b.useCustom(a, custom(b, a, /Knockout Blow/), e)
    expect(e.hp).toBe(e.stats.hp - 9)
    expect(b.has(e, 'stunned')).toBe(true)
  })
  it('Brawler 3: a passed save means nothing happens (no Prone)', () => {
    const { a, e, b } = setup([['t_brawler', 3]], { x: 5, y: 5 })
    a.flags.brawlerDie = 1
    rigDice(b, 20, 20)
    b.useCustom(a, custom(b, a, /Knockout Blow/), e)
    expect(e.hp).toBe(e.stats.hp)
    expect(b.has(e, 'prone')).toBe(false)
    expect(b.has(e, 'stunned')).toBe(false)
  })
  it('Brawler 3: a Grapple lowers the Brawler Die (grapples run the after-attack hooks)', () => {
    const { a, e, b } = setup([['t_brawler', 3]], { x: 5, y: 5 })
    rigDice(b, 20, 1)
    b.grapple(a, e)
    expect(a.flags.brawlerDie).toBe(5)
  })
})

describe('Crack Shot', () => {
  const steady = () => {
    const r = setup([['t_crack_shot', 2]], { x: 5, y: 8 }, { weapons: 'mw_assault_rifle' })
    r.a.flags.steady = r.b.round
    r.b.addStatus(r.a, 'immobilized', 'start_of_next_turn_target', r.a)
    return r
  }
  it('Crack Shot 2 (Zero In) is a choice: a normal shot keeps its Difficulty', () => {
    const { a, e, b } = steady()
    let ctx!: AttackCtx
    tx(b, () => { rigDice(b, 20, 5); ctx = b.weaponAttack(a, weapon(a, 'mw_assault_rifle'), { targetId: e.id }, 'free').ctxs[0] }, [1])
    expect(ctx.reasons).not.toContain('Zero In -1')
    expect(a.flags['round:zeroin']).toBeFalsy()
  })
  it('Crack Shot 2: aiming adds +1 Difficulty, and its crit adds +1d6 inside the attack\'s own damage roll', () => {
    const { a, e, b } = steady()
    a.stats.attackBonus = 30
    let ctx!: AttackCtx
    tx(b, () => { rigDice(b, 20, 20); ctx = b.weaponAttack(a, weapon(a, 'mw_assault_rifle'), { targetId: e.id }, 'free').ctxs[0] }, [0])
    expect(ctx.reasons).toContain('Zero In -1')
    expect(ctx.crit).toBe(true)
    expect(ctx.bonusDamage).toContainEqual({ type: 'Kinetic', val: '1d6' })
  })
})

describe('Centimane', () => {
  it('Centimane 2 (Expose Weakness): a drone of yours that consumes Lock On and crits Shreds the target', () => {
    const { a, e, b } = setup([['t_centimane', 2]])
    const drone = { ...pregenUnit('Hacker'), kind: 'drone', ownerId: a.id } as Unit
    const ctx = b.newAttackCtx(drone, e, { hit: true, crit: true, lockOnConsumed: true })
    getScript('t_centimane:2')!.afterAnyAttack!(b, a, ctx)
    expect(b.has(e, 'shredded')).toBe(true)
  })
  it('Centimane 2: no Shredded without consuming Lock On', () => {
    const { a, e, b } = setup([['t_centimane', 2]], { x: 5, y: 8 }, { weapons: 'mw_ghast_nexus' })
    const ctx = b.newAttackCtx(a, e, { weapon: weapon(a, 'mw_ghast_nexus'), hit: true, crit: true })
    getScript('t_centimane:2')!.afterAnyAttack!(b, a, ctx)
    expect(b.has(e, 'shredded')).toBe(false)
    getScript('t_centimane:2')!.afterAnyAttack!(b, a, { ...ctx, lockOnConsumed: true })
    expect(b.has(e, 'shredded')).toBe(true)
  })
})

describe('Duelist', () => {
  const duelist = () => {
    const r = setup([['t_duelist', 3]], { x: 5, y: 5 }, { weapons: 'mw_tactical_melee_weapon' })
    r.a.flags.bladeDice = 2
    r.e.stats.hp = 60; r.e.hp = 60
    return r
  }
  it('Duelist 3 (Unstoppable): the Ram is a real Ram — its roll can miss', () => {
    const { a, e, b } = duelist()
    tx(b, () => { rigDice(b, 20, 15, 1); b.weaponAttack(a, weapon(a, 'mw_tactical_melee_weapon'), { targetId: e.id }, 'free') }, [0])
    expect(a.flags.bladeDice).toBe(2) // +1 for the hit (Blademaster), -1 for Unstoppable
    expect(b.has(e, 'prone')).toBe(false)
  })
  it('Duelist 3: Grapple instead', () => {
    const { a, e, b } = duelist()
    tx(b, () => { rigDice(b, 20, 15, 18); b.weaponAttack(a, weapon(a, 'mw_tactical_melee_weapon'), { targetId: e.id }, 'free') }, [1])
    expect(b.has(e, 'grappled')).toBe(true)
    expect(a.actionsLeft).toBe(2) // a free action
  })
  it('Duelist 3: declining keeps the die', () => {
    const { a, e, b } = duelist()
    tx(b, () => { rigDice(b, 20, 15); b.weaponAttack(a, weapon(a, 'mw_tactical_melee_weapon'), { targetId: e.id }, 'free') }, [2])
    expect(a.flags.bladeDice).toBe(3) // the hit's new die, none spent
  })
})

describe('Exemplar', () => {
  it('Exemplar 2 (Punishment): the Overwatch resolves before the marked character\'s attack', () => {
    const { a, e, b } = setup([['t_exemplar', 2]], { x: 5, y: 5 })
    const ally = add(b, mech({ callsign: 'Ally' }), 6, 6)
    e.flags.exemplarMarkBy = a.id
    toEnemyTurn(b, a, e)
    b.weaponAttack(e, weapon(e, 'mw_assault_rifle'), { targetId: ally.id }, 'free')
    const i = b.log.findIndex(l => /punishes/.test(l.text))
    const j = b.log.findIndex(l => /vs Ally:/.test(l.text)) // the Mark's attack roll
    expect(i).toBeGreaterThanOrEqual(0)
    expect(i).toBeLessThan(j)
  })
})

describe('Gunslinger', () => {
  const gs = () => setup([['t_gunslinger', 2]], { x: 5, y: 8 }, { weapons: [['Main', 'mw_assault_rifle'], ['Auxiliary', 'mw_heavy_charged_blade']], aux: 'mw_pistol' })
  it('Gunslinger 2 (Return Fire): a miss does not trigger it', () => {
    const { a, e, b } = gs()
    toEnemyTurn(b, a, e)
    rigDice(b, 20, 1)
    b.weaponAttack(e, weapon(e, 'mw_assault_rifle'), { targetId: a.id }, 'free')
    expect(a.reactionsLeft).toBe(1)
  })
  it('Gunslinger 2: a hit lets it return fire with an Auxiliary ranged weapon', () => {
    const { a, e, b } = gs()
    toEnemyTurn(b, a, e)
    e.stats.attackBonus = 30
    b.weaponAttack(e, weapon(e, 'mw_assault_rifle'), { targetId: a.id }, 'free')
    expect(a.reactionsLeft).toBe(0)
    expect(b.log.some(l => /returns fire/.test(l.text))).toBe(true)
  })
})

describe('Hacker', () => {
  it('Hacker 1 (SNOW_CRASH): a target near its heat cap chooses to be pushed 3 spaces', () => {
    const { a, e, b } = setup([['t_hacker', 1]])
    a.stats.techAttack = 40
    e.heat = e.stats.heatcap - 1
    b.addStatus(e, 'lockon', 'until_cleared', a)
    const y = e.pos.y
    const ctx = b.techAttackRoll(a, e, 'test')
    expect(ctx.lockOnConsumed).toBe(true)
    expect(e.heat).toBe(e.stats.heatcap - 1)
    expect(e.pos.y).toBe(y + 3)
  })
  it('Hacker 1: otherwise the target takes the 2 heat', () => {
    const { a, e, b } = setup([['t_hacker', 1]])
    a.stats.techAttack = 40
    b.addStatus(e, 'lockon', 'until_cleared', a)
    b.techAttackRoll(a, e, 'test')
    expect(e.heat).toBe(2)
  })
  it('Hacker 2 (SAFE_CRACKER): the three real Invade options; no invented Jammed', () => {
    const { a, b } = setup([['t_hacker', 2]])
    const names = b.customActions(a).filter(c => c.key.startsWith('safecracker')).map(c => c.name)
    expect(names).toEqual(['Invade: Jam Cockpit', 'Invade: Disable Life Support', 'Invade: Hack/Slash'])
  })
  it('Hacker 2: Disable Life Support gives +1 Difficulty on saves until a Systems check reboots it', () => {
    const { a, e, b } = setup([['t_hacker', 2]])
    a.stats.techAttack = 40
    b.useCustom(a, custom(b, a, /Life Support/), e)
    expect(e.heat).toBe(2)
    expect(b.has(e, 'jammed')).toBe(false)
    expect(b.accuracyFromStatuses(e, 'save', 'hull')).toBe(-1)
    toEnemyTurn(b, a, e)
    rigDice(b, 20, 20)
    b.useCustom(e, custom(b, e, /Reboot Life Support/))
    expect(b.accuracyFromStatuses(e, 'save', 'hull')).toBe(0)
  })
  it('Hacker 2: Hack/Slash stops Quick and Full Tech until it Shuts Down or reboots', () => {
    const { a, e, b } = setup([['t_hacker', 2]])
    a.stats.techAttack = 40
    b.useCustom(a, custom(b, a, /Hack\/Slash/), e)
    toEnemyTurn(b, a, e)
    expect(b.canQuickTech(e, 'lock_on')).toMatch(/Hack\/Slash/)
    expect(() => b.lockOn(e, a)).toThrow(/Hack\/Slash/)
    b.shutDown(e)
    expect(e.flags.hackSlash).toBeUndefined()
  })
})

describe('Heavy Gunner', () => {
  it('Heavy Gunner 3 (Bracketing Fire): a new Covering Fire replaces the old targets — two at most', () => {
    const { a, e, b } = setup([['t_heavy_gunner', 3]], { x: 5, y: 8 }, { weapons: [['Heavy', 'mw_heavy_machine_gun']] })
    const e2 = add(b, mech({ callsign: 'Two' }, 'enemy'), 7, 8)
    const e3 = add(b, mech({ callsign: 'Three' }, 'enemy'), 3, 8)
    const e4 = add(b, mech({ callsign: 'Four' }, 'enemy'), 9, 8)
    b.useCustom(a, custom(b, a, /Covering Fire/), e)
    a.flags['turn:quickUsed'] = []; a.actionsLeft = 2
    tx(b, () => b.useCustom(a, custom(b, a, /Covering Fire/), e3), [2]) // pick the third candidate
    const covered = [e, e2, e3, e4].filter(u => u.flags.coveredBy === a.id)
    expect(covered.length).toBe(2)
    expect(covered).toContain(e3)
  })
})

describe('Infiltrator', () => {
  it('Infiltrator 2 (Ambush): the target can\'t react during its own next turn either', () => {
    const { a, e, b } = setup([['t_infiltrator', 2]])
    a.flags['turn:ambush'] = true
    a.stats.attackBonus = 30
    e.stats.hull = -30
    b.weaponAttack(a, weapon(a, 'mw_assault_rifle'), { targetId: e.id }, 'free')
    expect(e.reactionsLeft).toBe(0)
    toEnemyTurn(b, a, e)
    expect(e.reactionsLeft).toBe(0)
    expect(b.canSpend(e, 'reaction', 'overwatch')).not.toBe(true)
    b.endTurn(e)
    b.currentSide = 'player'; a.activationsLeft = 1
    b.beginTurn(a)
    expect(e.reactionsLeft).toBe(1)
  })
})

describe('Juggernaut', () => {
  it('Juggernaut 1 (Momentum): only the next Ram after a Boost gets +1 Accuracy', () => {
    const { a, e, b } = setup([['t_juggernaut', 1]], { x: 5, y: 5 })
    b.boost(a)
    const accs: number[] = []
    const keep = b.rollToHit.bind(b)
    b.rollToHit = (ctx: AttackCtx) => { accs.push(ctx.accuracy); ctx.hit = false; ctx.crit = false }
    try {
      b.withForcedAction(a, () => b.ram(a, e))
      b.withForcedAction(a, () => b.ram(a, e))
    } finally { b.rollToHit = keep }
    expect(accs).toEqual([1, 0])
  })
})

describe('Leader', () => {
  it('Leader 2 (Open Channels): at an ally\'s turn start, the Leader hands it a die as a reaction', () => {
    const { a, b } = setup([['t_leader', 2]])
    const ally = add(b, mech({ callsign: 'Ally' }), 7, 4)
    b.endTurn(a)
    b.currentSide = 'player'
    b.beginTurn(ally)
    expect(ally.flags.leaderDie).toBe(a.id)
    expect(a.flags.leaderDice).toBe(4)
    expect(a.reactionsLeft).toBe(0)
  })
  it('Leader 3 (Inspiring Presence): an ally without a die takes full damage', () => {
    const { a, e, b } = setup([['t_leader', 3]])
    const ally = add(b, mech({ callsign: 'Ally' }), 7, 4)
    ally.stats.armor = 0
    b.applyDamage(ally, [{ type: 'Kinetic', amount: 8 }], { source: e })
    expect(ally.hp).toBe(ally.stats.hp - 8)
    expect(a.flags.leaderDice).toBe(6)
  })
  it('Leader 3: an ally holding the die can spend it for +1d6 bonus damage on a hit', () => {
    const { a, e, b } = setup([['t_leader', 3]])
    const ally = add(b, mech({ callsign: 'Ally' }), 5, 6)
    ally.flags.leaderDie = a.id
    ally.stats.attackBonus = 0
    rigDice(b, 20, 20) // a crit: the AI spends the die
    const ctx = b.weaponAttack(ally, weapon(ally, 'mw_assault_rifle'), { targetId: e.id }, 'free').ctxs[0]
    expect(ctx.reasons.some(r => /Leadership Die \+1d6/.test(r))).toBe(true)
    expect(ally.flags.leaderDie).toBeUndefined()
  })
})

describe('Siege Specialist', () => {
  it('Siege Specialist 2 (Impact): after the saves, you are pushed 1 space', () => {
    const { a, e, b } = setup([['t_siege_specialist', 2]], { x: 5, y: 9 }, { weapons: [['Heavy', 'mw_siege_cannon']] })
    void e
    const from = { ...a.pos }
    b.buildWeaponCtx(a, weapon(a, 'mw_siege_cannon'), e, 'free', true)
    expect(Math.max(Math.abs(a.pos.x - from.x), Math.abs(a.pos.y - from.y))).toBe(1)
  })
  it('Siege Specialist 3 (Collateral Damage): a character with a reaction drops Prone instead of taking the blast', () => {
    const { a, e, b } = setup([['t_siege_specialist', 3]], { x: 5, y: 8 }, { weapons: [['Heavy', 'mw_siege_cannon']] })
    const e2 = add(b, mech({ callsign: 'Two' }, 'enemy'), 6, 8)
    e2.stats.armor = 0
    const ctx = b.newAttackCtx(a, e, { weapon: weapon(a, 'mw_siege_cannon'), hit: true, crit: true })
    getScript('t_siege_specialist:3')!.afterAttack!(b, a, ctx, 'attacker')
    expect(b.has(e2, 'prone')).toBe(true)
    expect(e2.hp).toBe(e2.stats.hp)
    expect(e2.reactionsLeft).toBe(0)
    expect(b.has(e, 'prone')).toBe(false) // the primary target is not in its own explosion
  })
})

describe('Skirmisher', () => {
  it('Skirmisher 1 (Chaff): forcing a save also loses the soft cover', () => {
    const { a, e, b } = setup([['t_skirmisher', 1]])
    expect(b.cover(e, a)).toBe('soft')
    b.save(e, 'hull', a.stats.save, 0, a)
    expect(b.cover(e, a)).toBe('none')
  })
  it('Skirmisher 2 (Lockbreaker): after an Overwatch attack, move 2 spaces', () => {
    const { a, e, b } = setup([['t_skirmisher', 2]], { x: 5, y: 5 })
    toEnemyTurn(b, a, e)
    rigDice(b, 20, 1)
    const from = { ...a.pos }
    b.weaponAttack(a, weapon(a, 'mw_assault_rifle'), { targetId: e.id }, 'overwatch')
    expect(a.pos).not.toEqual(from)
  })
  it('Skirmisher 3 (Weave): the first reaction attack uses it up even when it misses anyway', () => {
    const { a, e, b } = setup([['t_skirmisher', 3]], { x: 5, y: 7 })
    toEnemyTurn(b, a, e)
    rigDice(b, 20, 1, 15)
    e.stats.attackBonus = 0
    const rifle = weapon(e, 'mw_assault_rifle')
    expect(b.weaponAttack(e, rifle, { targetId: a.id }, 'overwatch').ctxs[0].hit).toBe(false)
    expect(b.weaponAttack(e, rifle, { targetId: a.id }, 'overwatch').ctxs[0].hit).toBe(true)
  })
})

describe('Spotter', () => {
  it('Spotter 1 (Particularize): roll twice and keep the better — a hit can become a crit', () => {
    const { a, e, b } = setup([['t_spotter', 1]])
    const ally = add(b, mech({ callsign: 'Ally' }), 6, 4)
    ally.stats.attackBonus = 0
    b.addStatus(e, 'lockon', 'until_cleared', a)
    rigDice(b, 20, 15, 20)
    const ctx = b.weaponAttack(ally, weapon(ally, 'mw_assault_rifle'), { targetId: e.id }, 'free').ctxs[0]
    expect(ctx.crit).toBe(true)
  })
  it('Spotter 1: a worse second roll is not kept', () => {
    const { a, e, b } = setup([['t_spotter', 1]])
    const ally = add(b, mech({ callsign: 'Ally' }), 6, 4)
    ally.stats.attackBonus = 0
    b.addStatus(e, 'lockon', 'until_cleared', a)
    rigDice(b, 20, 15, 1)
    const ctx = b.weaponAttack(ally, weapon(ally, 'mw_assault_rifle'), { targetId: e.id }, 'free').ctxs[0]
    expect(ctx.hit).toBe(true)
    expect(ctx.roll).toBe(15)
  })
  it('Spotter 3 (Bentham/Foucault): the nominated ally picks its quick action; the Lock On is consumed', () => {
    const { a, e, b } = setup([['t_spotter', 3]])
    const ally = add(b, mech({ callsign: 'Ally' }), 6, 4)
    tx(b, () => b.lockOn(a, e), [0, 1]) // nominate the ally; it picks its second option (Invade)
    expect(ally.reactionsLeft).toBe(0)
    expect(b.has(e, 'lockon')).toBe(false)
    expect(b.log.some(l => /INVADE/.test(l.text))).toBe(true)
  })
})

describe('Tactician', () => {
  it('Tactician 3 (Flank): a target in the open from the Tactician — Overwatch for half damage, even with a gun (Threat 1)', () => {
    const { a, e, b } = setup([['t_tactician', 3]], { x: 5, y: 5 })
    const ally = add(b, mech({ callsign: 'Ally' }), 5, 9)
    b.endTurn(a)
    act(b, ally)
    e.stats.armor = 0; e.stats.hp = 60; e.hp = 60
    ally.stats.attackBonus = 30
    rigDice(b, 20, 10, 15)
    rigDice(b, 6, 2, 6) // ally's 1d6+2... then the flank's
    b.weaponAttack(ally, weapon(ally, 'mw_assault_rifle'), { targetId: e.id }, 'free')
    expect(a.reactionsLeft).toBe(0)
    expect(e.hp).toBe(60 - 4 - 4) // full 4, then half of 8
  })
  it('Tactician 3: no Flank against a target in cover from the Tactician', () => {
    const map = flatMap(16, 16, (x, y) => (x === 5 && y === 6 ? { h: 1, kind: 'block' } : undefined))
    const a = mech({ level: 12, talents: [['t_tactician', 3]] })
    const e = mech({ callsign: 'Foe' }, 'enemy')
    const ally = mech({ callsign: 'Ally' })
    const b = arena([[a, { x: 5, y: 4 }], [e, { x: 5, y: 7 }], [ally, { x: 8, y: 7 }]], { map })
    expect(b.cover(a, e)).not.toBe('none')
    act(b, ally)
    ally.stats.attackBonus = 30
    b.weaponAttack(ally, weapon(ally, 'mw_assault_rifle'), { targetId: e.id }, 'free')
    expect(a.reactionsLeft).toBe(1)
  })
})

describe('Vanguard', () => {
  it('Vanguard 3 (Semper Vigilo): a hostile passing through Threat and ending outside it still triggers', () => {
    const { a, e, b } = setup([['t_vanguard', 3]], { x: 9, y: 8 }, { weapons: 'mw_shotgun' })
    toEnemyTurn(b, a, e)
    e.moveLeft = 10
    b.move(e, { x: 1, y: 8 }) // starts and ends 4 away, passing within the shotgun's Threat 3
    expect(a.reactionsLeft).toBe(0)
    expect(b.log.some(l => /Semper Vigilo/.test(l.text))).toBe(true)
    expect(e.pos.x).toBeLessThanOrEqual(2)
  })
})

describe('Technophile', () => {
  it('Technophile 2 (NHP Assistance): a failed save is rerolled once per round; the new result stands', () => {
    const { a, b } = setup([['t_technophile', 2]])
    rigDice(b, 20, 1, 20, 1, 20)
    expect(b.save(a, 'hull', 15)).toBe(true)
    expect(b.save(a, 'hull', 15)).toBe(false) // already used this round
    b.rng.d(20) // the leftover rigged roll
  })
})

describe('Engineer', () => {
  it('Engineer 2 (Revision): Tweaked Optics +1 Accuracy and Tweaked Computer (Smart, vs E-Defense) by default', () => {
    const { a, e, b } = setup([['t_engineer', 2]])
    const proto = a.weapons.find(w => w.dataId === 'mw_prototype_2')!
    const ctx = b.buildWeaponCtx(a, proto, e, 'free', false)
    expect(ctx.reasons).toContain('Tweaked Optics +1')
    expect(b.defenseOf(e, ctx)).toBe(e.stats.edef)
  })
  it('Engineer 2: Stripped reactor shielding adds Cone 3, Line 5 and Blast 1 profiles that cost 2 heat', () => {
    const { a, b } = setup([['t_engineer', 2]])
    const proto = a.weapons.find(w => w.dataId === 'mw_prototype_2')!
    tx(b, () => b.useCustom(a, custom(b, a, new RegExp(`proto_config:${proto.uid}`)), undefined), [2, 0, 1]) // Rifle, Kinetic, Optics + Stripped
    expect(proto.flags?.protoRevision).toEqual(['optics', 'stripped'])
    expect(proto.profiles.map(p => p.range.map(r => r.type).join('+'))).toEqual(['Range', 'Cone', 'Line', 'Range+Blast'])
    expect(proto.profiles[1].tags).toContainEqual(expect.objectContaining({ id: 'tg_heat_self', val: 2 }))
    expect(b.defenseOf(b.units[1], b.newAttackCtx(a, b.units[1], { weapon: proto }))).toBe(b.units[1].stats.evasion)
  })
})

describe('Grease Monkey (campaign)', () => {
  it('Grease Monkey 1 and 3: field repairs offer the Limited refill (2 Repairs) and a free supply drop', () => {
    const p = pilot({ level: 12, talents: [['t_grease_monkey', 3]], systems: ['ms_pattern_a_smoke_charges'] })
    const run = newRun([p], 1)
    const c = run.condition[p.id]
    c.limited.ms_pattern_a_smoke_charges = 0
    c.structure = c.structure - 1
    const ids = repairOptions(p, c).map(o => o.id)
    expect(ids).toContain('gm_limited')
    expect(ids).toContain('gm_supply')
    const repairs = c.repairs
    applyRepair(run, p.id, 'gm_limited')
    expect(c.limited.ms_pattern_a_smoke_charges).toBe(1)
    expect(c.repairs).toBe(repairs - 2)
    applyRepair(run, p.id, 'gm_supply')
    expect(c.limited.ms_pattern_a_smoke_charges).toBe(2)
    expect(c.structure).toBe(freshCondition(p).structure)
    expect(repairOptions(p, c).map(o => o.id)).not.toContain('gm_supply') // once until the next Full Repair
  })
})

describe('Core bonuses', () => {
  it('The Lesson of the Open Door: +2 Save Target, once', () => {
    const base = mech({ level: 12 }).stats.save
    expect(mech({ level: 12, coreBonuses: ['cb_the_lesson_of_the_open_door'] }).stats.save).toBe(base + 2)
  })
  it('Armory-Sculpted Chassis: soft cover after you Overcharge, until your next turn', () => {
    const { a, e, b } = setup([], { x: 5, y: 8 }, { coreBonuses: ['cb_armory_sculpted_chassis'] })
    expect(b.cover(e, a)).toBe('none')
    b.overcharge(a)
    expect(b.cover(e, a)).toBe('soft')
  })
  it('Kai Bioplating: difficult terrain costs nothing extra; climbing is at normal speed', () => {
    const map = flatMap(16, 16, (x, y) => (x === 5 && y === 5 ? { h: 0, kind: 'rubble' } : x === 6 && y === 4 ? { h: 3 } : undefined))
    const a = mech({ level: 12, coreBonuses: ['cb_kai_bioplating'] })
    const plain = mech({ level: 12, callsign: 'Plain' })
    const b = arena([[a, { x: 5, y: 4 }], [plain, { x: 9, y: 9 }]], { map })
    expect(b.stepCost(a, { x: 5, y: 4 }, { x: 5, y: 5 })).toBe(1)
    expect(b.stepCost(a, { x: 5, y: 4 }, { x: 6, y: 4 })).toBe(1)
    expect(b.stepCost(plain, { x: 5, y: 4 }, { x: 5, y: 5 })).toBe(2)
  })
  it('Titanomachy Mesh: no knockback for a melee weapon without Knockback; a Ram knocks back 2', () => {
    const { a, e, b } = setup([], { x: 5, y: 5 }, { coreBonuses: ['cb_titanomachy_mesh'], weapons: 'mw_tactical_melee_weapon' })
    a.stats.attackBonus = 30
    e.stats.hp = 60; e.hp = 60
    b.weaponAttack(a, weapon(a, 'mw_tactical_melee_weapon'), { targetId: e.id }, 'free')
    expect(e.pos).toEqual({ x: 5, y: 5 })
    rigDice(b, 20, 15)
    b.ram(a, e)
    expect(e.pos).toEqual({ x: 5, y: 7 })
  })
  it('Titanomachy Mesh: after a successful Grapple of a mech, Ram or Grapple again as a free action (1/round)', () => {
    const { a, e, b } = setup([], { x: 5, y: 5 }, { coreBonuses: ['cb_titanomachy_mesh'] })
    rigDice(b, 20, 15)
    b.grapple(a, e)
    expect(a.flags['round:titanomachy']).toBe(true)
    expect(a.actionsLeft).toBe(1)
    // the follow-up Ram costs nothing (engine: titanomachyFollowUp grants a free Ram or Grapple)
    b.releaseGrapple(a)
    rigDice(b, 20, 15)
    b.ram(a, e)
    expect(b.has(e, 'prone')).toBe(true)
    expect(a.actionsLeft).toBe(1)
  })
})
