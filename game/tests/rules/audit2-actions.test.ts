// Audit 2, actions and wear (core book p.65-82 and the NPC rules p.280-282, p.327): Overcharge, Barrage, grapples and
// contested checks, Ram, Bolster/Lock On/Scan targeting, Stabilize (mech and NPC), Shut Down, meltdowns, System
// Trauma, burn and Resistance, 1-Stress NPC heat, Grunts, Custom Paint Job and data-driven system attacks.
import { describe, expect, it } from 'vitest'
import { buildNpc } from '../../src/enemies/build'
import type { EnemyUnitDef } from '../../src/enemies/ruleset'
import type { Unit } from '../../src/rules/types'
import { act, arena, flatMap, mech, rigDice } from '../support'

const said = (b: { log: { text: string }[] }, re: RegExp) => b.log.some(l => re.test(l.text))

/** a player mech at (2,5) and an enemy mech at (3,5), the player's turn begun */
function pair(aOpts = {}, eOpts = {}) {
  const a = mech(aOpts)
  const e = mech(eOpts, 'enemy')
  const b = arena([[a, { x: 2, y: 5 }], [e, { x: 3, y: 5 }]])
  act(b, a)
  return { a, e, b }
}

function npcDef(extra: Partial<EnemyUnitDef> = {}): EnemyUnitDef {
  return {
    name: 'Test NPC', role: 'Striker',
    features: [
      { type: 'weapon', name: 'Slug Rifle', weaponType: 'Rifle', range: [{ type: 'Range', val: 8 }], damage: [{ type: 'Kinetic', val: 4 }], tags: [{ id: 'tg_loading' }] },
      { type: 'trait', name: 'Plating', text: 'a trait' },
      { type: 'reaction', name: 'Retort', trigger: 'damaged', text: 'a reaction' },
    ],
    ...extra,
  }
}

describe('Overcharge (core p.73)', () => {
  it('Overcharge, then Boost, still leaves a full action: the free quick action pays first', () => {
    const { a, e, b } = pair({ weapons: [['Main', 'mw_assault_rifle'], ['Main', 'mw_assault_rifle']] })
    b.overcharge(a)
    b.boost(a)
    expect(a.actionsLeft).toBe(2)
    expect(b.canSpend(a, 'full')).toBe(true)
    a.stats.attackBonus = 40
    const [w1, w2] = a.weapons
    expect(b.barrage(a, { weapon: w1, aim: { targetId: e.id } }, { weapon: w2, aim: { targetId: e.id } }).ok).toBe(true)
    expect(b.canSpend(a, 'quick')).toBe('No actions left')
  })
})

describe('Barrage and Superheavy weapons (core p.71)', () => {
  it('a Superheavy weapon takes the whole Barrage: no second weapon, whichever slot it is in', () => {
    const { a, e, b } = pair({ weapons: [['Heavy', 'mw_tachyon_lance'], ['Main', 'mw_assault_rifle']] })
    e.pos = { x: 7, y: 5 } // the Tachyon Lance is Ordnance: not at an engaged target
    const lance = a.weapons.find(w => w.dataId === 'mw_tachyon_lance')!
    const rifle = a.weapons.find(w => w.dataId === 'mw_assault_rifle')!
    const aim = { targetId: e.id }
    expect(b.barrage(a, { weapon: rifle, aim }, { weapon: lance, aim }).reason).toMatch(/Superheavy/)
    expect(b.barrage(a, { weapon: lance, aim }, { weapon: rifle, aim }).reason).toMatch(/Superheavy/)
    expect(a.actionsLeft).toBe(2)
    expect(b.barrage(a, { weapon: lance, aim }).ok).toBe(true)
  })

  it('a Barrage with one ordinary weapon is allowed', () => {
    const { a, e, b } = pair()
    expect(b.barrage(a, { weapon: a.weapons[0], aim: { targetId: e.id } }).ok).toBe(true)
    expect(a.actionsLeft).toBe(0)
  })

  it('the Leviathan Heavy Assault Cannon can Skirmish; other Superheavy weapons cannot', () => {
    const { a, e, b } = pair({ weapons: [['Heavy', 'mw_leviathan_heavy_assault_cannon'], ['Heavy', 'mw_tachyon_lance']] })
    const lev = a.weapons.find(w => w.dataId === 'mw_leviathan_heavy_assault_cannon')!
    const lance = a.weapons.find(w => w.dataId === 'mw_tachyon_lance')!
    expect(b.skirmish(a, lance, { targetId: e.id }).reason).toMatch(/require Barrage/)
    expect(b.skirmish(a, lev, { targetId: e.id }).ok).toBe(true)
  })
})

describe('grapples and contested checks (core p.13, p.69)', () => {
  it('equal Size: the grappler counts as larger until a contest is won', () => {
    const { a, e, b } = pair()
    b.startGrapple(a, e)
    expect(a.statuses.some(s => s.id === 'immobilized')).toBe(false)
    expect(e.statuses.some(s => s.id === 'immobilized')).toBe(true)
  })

  it('the grappler can only release on its own turn', () => {
    const { a, e, b } = pair()
    b.startGrapple(a, e)
    b.endTurn(a)
    b.currentSide = 'enemy'
    act(b, e)
    expect(() => b.releaseGrapple(a)).toThrow()
    expect(b.grapples.length).toBe(1)
  })

  it('a tie goes to the one who starts the contest: the defender breaks free on equal Hull totals', () => {
    const { a, e, b } = pair()
    b.startGrapple(a, e)
    b.endTurn(a)
    b.currentSide = 'enemy'
    act(b, e)
    rigDice(b, 20, 10, 10)
    b.breakGrapple(e)
    expect(b.grapples.length).toBe(0)
  })

  it('contested checks take Accuracy: a Bolstered defender adds its +2 Accuracy breaking free', () => {
    const { a, e, b } = pair()
    b.startGrapple(a, e)
    b.endTurn(a)
    b.currentSide = 'enemy'
    act(b, e)
    b.addStatus(e, 'bolstered', 'next_turn_end_target')
    rigDice(b, 20, 10, 15) // defender 10 + 2 Hull, attacker 15 + 2 Hull
    rigDice(b, 6, 6, 1) // the defender's two Accuracy dice: +6
    b.breakGrapple(e)
    expect(b.grapples.length).toBe(0)
    expect(b.has(e, 'bolstered')).toBe(false)
  })
})

describe('Ram (core p.70)', () => {
  it('the knockback is optional; by default the target is pushed', () => {
    const { a, e, b } = pair()
    a.stats.attackBonus = 40
    b.transaction(() => b.ram(a, e), [1])
    expect(b.has(e, 'prone')).toBe(true)
    expect(e.pos).toEqual({ x: 3, y: 5 })

    const d = pair()
    d.a.stats.attackBonus = 40
    d.b.ram(d.a, d.e)
    expect(d.e.pos).toEqual({ x: 4, y: 5 })
  })
})

describe('tech targeting (core p.65, p.69-70, p.78)', () => {
  it('Bolster needs no line of sight, only Sensors', () => {
    const a = mech(), ally = mech({ callsign: 'Ally' }), e = mech({}, 'enemy')
    const map = flatMap(12, 12, (x, y) => (x === 3 && y === 5 ? { h: 4, kind: 'block' } : undefined))
    const b = arena([[a, { x: 2, y: 5 }], [ally, { x: 4, y: 5 }], [e, { x: 10, y: 10 }]], { map })
    act(b, a)
    expect(b.los(a, ally)).toBe(false)
    b.bolster(a, ally)
    expect(b.has(ally, 'bolstered')).toBe(true)
  })

  it('a Jammed ally cannot be Bolstered', () => {
    const a = mech(), ally = mech({ callsign: 'Ally' }), e = mech({}, 'enemy')
    const b = arena([[a, { x: 2, y: 5 }], [ally, { x: 4, y: 5 }], [e, { x: 10, y: 10 }]])
    act(b, a)
    b.addStatus(ally, 'jammed', 'until_cleared', e)
    expect(() => b.bolster(a, ally)).toThrow(/Jammed/)
  })

  it('Lock On and Scan cannot target yourself', () => {
    const { a, b } = pair()
    expect(() => b.lockOn(a, a)).toThrow(/self/)
    expect(() => b.scan(a, a)).toThrow(/self/)
  })

  it('using a Lock On is the attacker\'s choice (policy lockOn: off keeps it)', () => {
    const { a, e, b } = pair()
    a.stats.attackBonus = 40
    b.addStatus(e, 'lockon', 'until_cleared', a)
    a.policies.lockOn = 'off'
    b.grapple(a, e)
    expect(b.has(e, 'lockon')).toBe(true)
    a.policies.lockOn = 'auto'
    b.ram(a, e)
    expect(b.has(e, 'lockon')).toBe(false)
  })
})

describe('Stabilize (core p.71)', () => {
  function trio() {
    const a = mech(), ally = mech({ callsign: 'Ally' }), e = mech({}, 'enemy')
    const b = arena([[a, { x: 2, y: 5 }], [ally, { x: 3, y: 5 }], [e, { x: 10, y: 10 }]])
    act(b, a)
    return { a, ally, e, b }
  }

  it("an adjacent ally's Stunned can be cleared", () => {
    const { a, ally, e, b } = trio()
    b.addStatus(ally, 'stunned', 'next_turn_end_target', e)
    b.stabilize(a, 'cool', { unit: ally, status: 'stunned' })
    expect(b.has(ally, 'stunned')).toBe(false)
  })

  it('a condition the mech caused itself cannot be cleared', () => {
    const { a, b } = trio()
    b.addStatus(a, 'impaired', 'until_cleared', a)
    expect(() => b.stabilize(a, 'cool', { unit: a, status: 'impaired' })).toThrow(/own systems/)
    expect(a.actionsLeft).toBe(2)
    // and the automatic pick skips it
    b.stabilize(a, 'cool')
    expect(b.has(a, 'impaired')).toBe(true)
  })

  it("an ally's burn cannot be cleared", () => {
    const { a, ally, b } = trio()
    ally.burn = 4
    expect(() => b.stabilize(a, 'cool', { unit: ally, status: 'burn' })).toThrow(/own mech/)
    expect(ally.burn).toBe(4)
    expect(a.actionsLeft).toBe(2)
  })

  it('a non-adjacent ally is refused before the action is spent', () => {
    const { a, ally, e, b } = trio()
    ally.pos = { x: 6, y: 5 }
    b.addStatus(ally, 'slowed', 'until_cleared', e)
    expect(() => b.stabilize(a, 'cool', { unit: ally, status: 'slowed' })).toThrow(/adjacent/)
    expect(a.actionsLeft).toBe(2)
    expect(b.has(ally, 'slowed')).toBe(true)
  })

  it('an NPC reloads all its Loading weapons and clears neither burn nor conditions (core p.281)', () => {
    const n = buildNpc(npcDef(), 1)
    const e = mech({}, 'enemy')
    e.side = 'player'
    const b = arena([[n, { x: 2, y: 2 }], [e, { x: 9, y: 9 }]])
    b.currentSide = n.side
    act(b, n)
    n.weapons[0].loaded = false
    n.burn = 3
    n.heat = 4
    b.addStatus(n, 'impaired', 'until_cleared', e)
    b.addStatus(n, 'exposed')
    b.stabilize(n, 'cool')
    expect(n.weapons[0].loaded).toBe(true)
    expect(n.burn).toBe(3)
    expect(b.has(n, 'impaired')).toBe(true)
    expect(n.heat).toBe(0)
    expect(b.has(n, 'exposed')).toBe(false)
  })
})

describe('Shut Down (core p.72)', () => {
  it("ends what tech actions caused (Fragment Signal's Impaired and Slowed) and keeps the rest; a meltdown keeps counting", () => {
    const { a, e, b } = pair()
    a.stats.techAttack = 40
    b.invade(a, e, 'fragment')
    expect(b.has(e, 'impaired') && b.has(e, 'slowed')).toBe(true)
    b.addStatus(e, 'jammed', 'until_cleared', a) // a weapon's Jammed, not a tech action's
    b.endTurn(a)
    b.currentSide = 'enemy'
    act(b, e)
    e.meltdownTurns = 2
    b.shutDown(e)
    expect(b.has(e, 'impaired')).toBe(false)
    expect(b.has(e, 'slowed')).toBe(false)
    expect(b.has(e, 'jammed')).toBe(true)
    expect(e.meltdownTurns).toBe(2)
  })

  it('a Jammed caused by a tech action ends', () => {
    const { a, e, b } = pair()
    a.stats.techAttack = 40
    b.invade(a, e, { name: 'Jam', effects: [{ do: 'status', status: 'jammed', duration: 'until_cleared' }] })
    expect(b.has(e, 'jammed')).toBe(true)
    b.endTurn(a)
    b.currentSide = 'enemy'
    act(b, e)
    b.shutDown(e)
    expect(b.has(e, 'jammed')).toBe(false)
  })
})

describe('meltdowns (core p.81)', () => {
  it('a new meltdown result never lengthens a countdown already running', () => {
    const { a, b } = pair()
    a.meltdownTurns = 1
    a.stress = 2
    a.heat = a.stats.heatcap
    rigDice(b, 6, 1, 1) // two marked stress: two 1s, Irreversible Meltdown (2 turns on its own turn)
    b.addHeat(a, 1)
    expect(said(b, /IRREVERSIBLE/)).toBe(true)
    expect(a.meltdownTurns).toBe(1)
  })
})

describe('System Trauma (core p.80)', () => {
  it('the player chooses the mount; the default is the least valuable one', () => {
    const { a, b } = pair({ weapons: [['Heavy', 'mw_tachyon_lance'], ['Main', 'mw_assault_rifle']] })
    rigDice(b, 6, 2) // 1-3: a mount
    b.systemTrauma(a)
    expect(a.weapons.find(w => w.dataId === 'mw_assault_rifle')!.destroyed).toBe(true)
    expect(a.weapons.find(w => w.dataId === 'mw_tachyon_lance')!.destroyed).toBe(false)

    const d = pair({ weapons: [['Heavy', 'mw_tachyon_lance'], ['Main', 'mw_assault_rifle']] })
    const asked: string[][] = []
    d.b.chooser = q => { if (q.kind === 'system_trauma') asked.push(q.options.map(o => o.label)); return 0 }
    rigDice(d.b, 6, 2)
    d.b.transaction(() => d.b.systemTrauma(d.a))
    expect(asked).toEqual([['Tachyon Lance', 'Assault Rifle']])
    expect(d.a.weapons.find(w => w.dataId === 'mw_tachyon_lance')!.destroyed).toBe(true)
  })

  it('integrated weapons and the Integrated Weapon core bonus mount are never taken', () => {
    const { a, b } = pair({ weapons: [['Main', 'mw_assault_rifle'], ['Main', 'mw_heavy_machine_gun']] })
    a.weapons[0].flags = { cbIntegrated: true }
    a.weapons.push({ ...a.weapons[0], uid: 'int', mountIndex: -1, flags: {} })
    rigDice(b, 6, 1)
    b.systemTrauma(a)
    expect(a.weapons.filter(w => w.destroyed).map(w => w.dataId)).toEqual(['mw_heavy_machine_gun'])
  })

  it("never takes an NPC's traits or reactions", () => {
    const n = buildNpc(npcDef(), 1)
    const e = mech({}, 'enemy')
    e.side = 'player'
    const b = arena([[n, { x: 2, y: 2 }], [e, { x: 9, y: 9 }]])
    rigDice(b, 6, 5) // 4-6: a system, but traits and reactions aren't systems: the weapon goes instead
    b.systemTrauma(n)
    expect(n.systems.every(s => !s.destroyed)).toBe(true)
    expect(n.weapons[0].destroyed).toBe(true)
  })
})

describe('burn, heat and wear', () => {
  it('end-of-turn burn respects Resistance to burn', () => {
    const { a, b } = pair()
    a.resist = ['Burn']
    a.burn = 4
    const hp = a.hp
    rigDice(b, 20, 1) // the Engineering check fails
    b.endTurn(a)
    expect(a.hp).toBe(hp - 2)
  })

  it('a 1-Stress NPC over its cap clears heat like a mech, repeating while still over (owner ruling)', () => {
    const n = buildNpc(npcDef(), 1)
    const e = mech({}, 'enemy')
    e.side = 'player'
    const b = arena([[n, { x: 2, y: 2 }], [e, { x: 9, y: 9 }]])
    expect(n.stats.stress).toBe(1)
    const cap = n.stats.heatcap
    n.heat = cap
    b.addHeat(n, 3)
    expect(n.heat).toBe(2)
    expect(b.has(n, 'exposed')).toBe(true)
    b.addHeat(n, 3 * cap)
    expect(n.heat).toBeLessThanOrEqual(cap)
    expect(n.stress).toBe(1)
  })

  it('Custom Paint Job: when it saves the structure, no structure check is rolled', () => {
    const { a, b } = pair({ systems: ['ms_custom_paint_job'] })
    a.hp = 1
    const s = a.structure
    rigDice(b, 6, 6)
    b.loseHp(a, 5)
    expect(a.structure).toBe(s)
    expect(a.hp).toBe(1)
    expect(said(b, /Structure check/)).toBe(false)
  })
})

describe('NPC odds and ends', () => {
  it('a T3 NPC Improvised Attack deals a fixed 6 kinetic (core p.281)', () => {
    const n = buildNpc(npcDef(), 3)
    const e = mech({}, 'enemy')
    e.side = 'player'
    const b = arena([[n, { x: 2, y: 2 }], [e, { x: 3, y: 2 }]])
    b.currentSide = n.side
    act(b, n)
    n.stats.attackBonus = 40
    e.stats.armor = 0
    const hp = e.hp
    b.improvisedAttack(n, e)
    expect(e.hp).toBe(hp - 6)
  })

  it('Feign Death works on any first destruction, a crushing hit included (core p.332)', () => {
    const n = buildNpc(npcDef(), 1)
    n.traits = [...(n.traits ?? []), 'feign_death']
    const e = mech({}, 'enemy')
    e.side = 'player'
    const b = arena([[n, { x: 2, y: 2 }], [e, { x: 9, y: 9 }]])
    b.destroy(n, 'crushing hit')
    expect(n.destroyed).toBe(false)
    expect(n.hp).toBe(1)
    b.destroy(n, 'crushing hit')
    expect(n.destroyed).toBe(true)
  })
})

describe('Grunts (core p.327)', () => {
  function grunt(): { g: Unit; b: ReturnType<typeof arena> } {
    const g = buildNpc(npcDef(), 1)
    g.isGrunt = true; g.hp = 1; g.stats.hp = 1
    const e = mech({}, 'enemy')
    e.side = 'player'
    const b = arena([[g, { x: 2, y: 2 }], [e, { x: 9, y: 9 }]])
    return { g, b }
  }

  it('halfOnSave gives a Grunt nothing', () => {
    const { g, b } = grunt()
    expect(b.halfOnSave(g, 10)).toBe(0)
  })

  it('Grunts ignore Overshield', () => {
    const { g, b } = grunt()
    g.overshield = 5
    b.loseHp(g, 1)
    expect(g.destroyed).toBe(true)
  })

  it('heat with no source destroys a Grunt; its own heat does not', () => {
    const { g, b } = grunt()
    b.addHeat(g, 1, g)
    expect(g.destroyed).toBe(false)
    b.addHeat(g, 1)
    expect(g.destroyed).toBe(true)
  })
})

describe('data-driven system attacks (core p.64, p.77)', () => {
  const vents = (b: ReturnType<typeof arena>, a: Unit) => b.customActions(a).find(x => x.name === 'Explosive Vents')!
  it('get the usual attack modifiers: Engaged gives a ranged attack (this Burst) +1 Difficulty', () => {
    const { a, b } = pair({ systems: ['ms_explosive_vents'] })
    b.useCustom(a, vents(b, a))
    expect(said(b, /-1diff/)).toBe(true)
  })
  it('Prone and Lock On give +1 Accuracy each (net +1 with Engaged), and the Lock On is spent', () => {
    const { a, e, b } = pair({ systems: ['ms_explosive_vents'] })
    b.addStatus(e, 'prone', 'until_cleared', a)
    b.addStatus(e, 'lockon', 'until_cleared', a)
    b.useCustom(a, vents(b, a))
    expect(said(b, /\+1acc/)).toBe(true)
    expect(b.has(e, 'lockon')).toBe(false)
  })
})
