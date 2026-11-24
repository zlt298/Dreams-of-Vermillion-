// Frame traits, CORE powers and core bonuses, one describe per frame (alphabetical), then core bonuses.
import { describe, expect, it } from 'vitest'
import { autoBattle, aiErrors } from '../../src/ai/ai'
import { getScript } from '../../src/rules/effects/registry'
import type { Battle } from '../../src/rules/battle'
import type { Unit } from '../../src/rules/types'
import { act, arena, battle, flatMap, mech, pregenUnit, rigDice, type PilotOpts } from '../support'
import { custom, vs, weapon } from './helpers'

/** CORE scenario: a level-6 mech of this frame at (3,3), CORE available, vs an Assault at (3,8), seed 3. */
function coreSetup(frame: string) {
  const r = vs(mech({ frame, level: 6 }), { a: { x: 3, y: 3 }, e: { x: 3, y: 8 }, seed: 3 })
  r.a.coreAvailable = true
  return r
}
/** Level-6 mech vs an Assault with Evasion/E-Defense 1 (default positions, seed 13). */
const l6 = (o: PilotOpts = {}, opts: Parameters<typeof vs>[1] = {}) => vs(mech({ level: 6, ...o }), { ...opts, enemy: { evasion: 1, edef: 1 } })
/** Level-9 mech vs a plain Assault (default positions, seed 13). */
const l9 = (o: PilotOpts = {}) => vs(mech({ callsign: 'T', ...o }))
const roundTrip = (b: Battle, a: Unit, e: Unit) => { b.endTurn(a); b.beginTurn(e); b.endTurn(e); b.beginTurn(a) }

describe('Barbarossa', () => {
  it('Apocalypse Rail: the die counts down, the rail fires at 1-3 and resets', () => {
    const { a, e, b } = coreSetup('mf_barbarossa')
    b.activateCore(a)
    expect(custom(b, a, /Apocalypse Rail/).usable(b, a)).not.toBe(true)
    roundTrip(b, a, e)
    expect(a.flags.apocDie).toBe(3)
    e.pos = { x: 3, y: 12 }
    b.useCustom(a, custom(b, a, /Apocalypse Rail/), e.pos)
    expect(a.flags.apocDie).toBe(4)
    expect(a.actionsLeft).toBe(0)
  })
})

describe('Black Witch', () => {
  it('Mag Field: stops kinetic shots crossing its edge, then they resume', () => {
    const { a, e, b } = coreSetup('mf_black_witch')
    b.useCustom(a, custom(b, a, /Mag Field/), { x: 3, y: 6 })
    expect(a.coreAvailable).toBe(false)
    const f = a.flags.magField
    expect(f.tiles.length).toBe(49)
    e.pos = { x: 3, y: 12 }
    const ally = pregenUnit('Sniper')
    ally.pos = { x: 4, y: 6 }
    ally.activationsLeft = 0
    b.units.push(ally)
    b.endTurn(a); b.beginTurn(e)
    const r = b.weaponAttack(e, weapon(e, 'mw_assault_rifle'), { targetId: ally.id }, 'free')
    expect(r.ctxs[0].hit).toBe(false)
    expect(a.flags.magField.count).toBe(1)
    b.endTurn(e); b.beginTurn(a); b.endTurn(a)
    expect(a.flags.magField).toBeUndefined()
  })
})

describe("Death's Head", () => {
  // regression: Mark for Death added its crit bonus damage at any range
  it('Mark for Death: no crit bonus damage against a target within range 5', () => {
    const { a, e, b } = l9({ frame: 'mf_deaths_head' })
    a.flags.markTarget = e.id
    e.pos = { x: 5, y: 6 } // range 2
    e.stats.armor = 0
    const hp = e.hp
    const ctx = b.newAttackCtx(a, e, { weapon: a.weapons[0], hit: true, crit: true, ranged: true })
    getScript('core:mf_deaths_head')!.afterAnyRoll!(b, a, ctx)
    expect(ctx.bonusDamage).toEqual([])
    expect(e.hp).toBe(hp)
  })
})

describe('Drake', () => {
  it('Fortress: two indestructible cover sections; adjacent allies are immune to forced movement and Prone', () => {
    const { a, b } = l6({ frame: 'mf_drake' })
    const ally = mech({ level: 6, callsign: 'Ally' }); ally.pos = { x: 4, y: 3 }; b.units.push(ally)
    a.coreAvailable = true
    b.activateCore(a)
    const sections = b.map.tiles.filter(t => t.owner === a.id && t.kind === 'block')
    expect(sections.length).toBeGreaterThanOrEqual(3)
    const i = b.map.tiles.indexOf(sections[0])
    expect(b.damageTerrain({ x: i % 16, y: Math.floor(i / 16) }, 100)).toBe(false)
    const before = { ...ally.pos }
    b.forceMove(ally, { x: 9, y: 9 }, 3, 1)
    expect(ally.pos).toEqual(before)
    expect(b.addStatus(ally, 'prone')).toBe(false)
    expect(b.has(a, 'immobilized')).toBe(true)
    b.useCustom(a, custom(b, a, /Deactivate Fortress/))
    expect(b.has(a, 'immobilized')).toBe(false)
  })
  it('Fortress: a full action is allowed after Bracing', () => {
    const { a, b } = l6({ frame: 'mf_drake' })
    a.flags.fortress = true
    b.addStatus(a, 'bracing_recovery', 'next_turn_end_target')
    a.actionsLeft = 1
    expect(b.canSpend(a, 'full')).toBe(true)
  })
})

describe('Dusk Wing', () => {
  it('Hall of Mirrors: moving leaves a hologram that detonates on hostiles', () => {
    const { a, e, b } = coreSetup('mf_dusk_wing')
    b.activateCore(a)
    b.move(a, { x: 6, y: 3 })
    expect(a.flags.holos).toEqual([{ x: 3, y: 3 }])
    b.endTurn(a); b.beginTurn(e)
    e.stats.agi = -20
    const hp = e.hp
    b.move(e, { x: 3, y: 4 })
    expect(e.hp).toBeLessThan(hp)
    expect(a.flags.holos).toHaveLength(0)
  })
})

describe('Goblin', () => {
  it('Symbiosis: attaches to a larger ally, shares E-Defense, and detaches', () => {
    const { a, b } = coreSetup('mf_goblin')
    const host = mech({ frame: 'mf_barbarossa', level: 6, callsign: 'Host' })
    host.pos = { x: 4, y: 3 }
    host.stats.edef = 6
    b.units.push(host)
    b.useCustom(a, custom(b, a, /Symbiosis/), host)
    expect(a.pos).toEqual(host.pos)
    expect(host.stats.edef).toBe(Math.max(6, a.stats.edef))
    b.useCustom(a, custom(b, a, /Detach/))
    expect(host.stats.edef).toBe(6)
    expect(a.pos).not.toEqual(host.pos)
  })
  it('Reactive Code: when hit by a tech attack, take a Quick Tech option against the attacker', () => {
    const { e, a, b } = l6({ frame: 'mf_goblin' })
    b.endTurn(a); b.beginTurn(e)
    e.stats.techAttack = 30
    b.invade(e, a)
    expect(b.has(e, 'impaired') && b.has(e, 'slowed')).toBe(true) // default: Fragment Signal back
    expect(a.reactionsLeft).toBe(0)
  })
  it("INSTINCT Rig: the Goblin shares its host's conditions and heat, and acts on its host's activation", () => {
    const { a: g, e, b } = l6({ frame: 'mf_goblin', callsign: 'Gob' })
    const host = mech({ level: 6, callsign: 'Host' })
    host.stats.size = 2; host.pos = { x: 6, y: 3 }
    b.units.push(host)
    g.coreAvailable = true
    b.useCustom(g, custom(b, g, /Symbiosis/), host)
    expect(g.flags.host).toBe(host.id)
    b.addStatus(host, 'impaired', 'next_turn_end_target', e)
    expect(b.has(g, 'impaired')).toBe(true)
    b.addHeat(host, 3)
    expect(g.heat).toBeGreaterThanOrEqual(3)
    // next round: no own turn; acts inside the host's turn, then hands control back
    b.endTurn(g)
    b.beginTurn(e); b.endTurn(e)
    if (host.activationsLeft) { b.beginTurn(host); b.endTurn(host) }
    while (b.round === 1) { const u = b.combatants(b.currentSide).find(x => x.activationsLeft > 0); if (!u) break; b.beginTurn(u); b.endTurn(u) }
    expect(b.round).toBe(2)
    expect(g.activationsLeft).toBe(0)
    if (b.currentSide !== 'player') { b.beginTurn(e); b.endTurn(e) }
    b.beginTurn(host)
    b.move(host, { x: 6, y: 2 }) // part of the host's turn first
    const acts = b.customActions(host).find(c => /Gob acts/.test(c.name))
    expect(acts?.name).toBe('Gob acts')
    b.useCustom(host, acts!)
    expect(b.activeId).toBe(g.id)
    expect(g.moveLeft).toBe(0)
    expect(() => b.overcharge(g)).toThrow()
    b.endTurn(g)
    expect(b.activeId).toBe(host.id) // back to the host, who can keep acting
    expect(b.customActions(host).some(c => /Gob acts/.test(c.name))).toBe(false) // once per host turn
    expect(getScript('core:mf_goblin')?.partial).toBeFalsy()
  })
  it('INSTINCT Rig: an AI-run Goblin acts before its host ends its turn', () => {
    const g = mech({ frame: 'mf_goblin', level: 6, callsign: 'Gob' }, 'enemy')
    const host = mech({ level: 6, callsign: 'Host' }, 'enemy')
    const p = pregenUnit('Assault')
    host.stats.size = 2
    const b = arena([[p, { x: 5, y: 12 }], [g, { x: 5, y: 4 }], [host, { x: 6, y: 3 }]], { map: flatMap(16, 16), seed: 3 })
    act(b, g)
    g.coreAvailable = true
    b.useCustom(g, custom(b, g, /Symbiosis/), host)
    g.flags.symbiosisTurns = true
    b.endTurn(g)
    b.currentSide = 'enemy'
    b.beginTurn(host)
    b.endTurn(host)
    expect(g.flags.hostTurnActed).toBe(true)
    expect(b.log.some(l => /Gob acts on Host's turn/.test(l.text))).toBe(true)
  })
})

describe('Hydra', () => {
  it('Full Deployment puts out all four OROCHI drones; Guardian adds difficulty to ranged attacks on adjacent allies', () => {
    const { a, e, b } = vs(mech({ frame: 'mf_hydra', level: 6 }), { a: { x: 3, y: 3 }, e: { x: 3, y: 9 }, map: flatMap(14, 14), seed: 5 })
    a.coreAvailable = true
    b.activateCore(a)
    const orochi = b.alive().filter(d => d.ownerId === a.id && d.flags.orochi)
    expect(orochi).toHaveLength(4)
    const g = orochi.find(d => d.flags.orochi === 'Guardian')!
    const ally = pregenUnit('Sniper')
    ally.pos = { x: g.pos.x + 1, y: g.pos.y }
    if (b.alive().some(o => o !== ally && o.pos.x === ally.pos.x && o.pos.y === ally.pos.y)) ally.pos = { x: g.pos.x - 1, y: g.pos.y }
    b.units.push(ally)
    expect(b.previewAttack(e, weapon(e, 'mw_assault_rifle'), ally).ctx.reasons).toContain('Guardian OROCHI -1')
  })
})

describe('Manticore', () => {
  // regression: the Charge Die reset to 1 and kept charging after discharging
  it('CORE: the Charge Die discharges once, then the effect ends', () => {
    const { a, b } = l9({ frame: 'mf_manticore' })
    b.activateCore(a)
    for (let i = 0; i < 5; i++) b.addHeat(a, 1) // 1 -> 6: discharge
    expect(a.flags.chargeDie ?? 0).toBe(0)
  })
  it('CORE: taking energy damage raises the Charge Die', () => {
    const { a, e, b } = l9({ frame: 'mf_manticore' })
    b.activateCore(a)
    b.applyDamage(a, [{ type: 'Energy', amount: 3 }], { source: e })
    expect(a.flags.chargeDie).toBe(2)
  })
})

describe('Mourning Cloak', () => {
  it('after the core, moves teleport over walls and ignore engagement', () => {
    const map = flatMap(16, 16, (x, y) => (y === 5 && x >= 2 && x <= 8 ? { h: 4, kind: 'block' } : undefined))
    const { a, b } = l6({ frame: 'mf_mourning_cloak' }, { map })
    a.coreAvailable = true
    b.activateCore(a)
    expect(a.flags.teleportMoves).toBe(true)
    expect(b.move(a, { x: 5, y: 7 })).toBe(true)
    expect(a.pos).toEqual({ x: 5, y: 7 })
  })
  it('lost in blinkspace (triples) is not a destroyed mech for the run', () => {
    const { a, b } = l6({ frame: 'mf_mourning_cloak' })
    const kept = { hp: a.hp, structure: a.structure, stress: a.stress }
    rigDice(b, 6, 4, 4, 4)
    custom(b, a, /Blinkspace/).run(b, a, { x: 6, y: 4 })
    expect(a.destroyed).toBe(true)
    expect(a.flags.vanished).toEqual(kept)
    expect(a.flags.wreck).toBeFalsy()
  })
  // regression: a melee miss used up the once-per-round Hunter bonus
  it('Hunter: a melee miss does not use up the 1/round +1d6 on hit', () => {
    const { a, e, b } = l9({ frame: 'mf_mourning_cloak', weapons: [['Main', 'mw_tactical_melee_weapon']] })
    e.pos = { x: 5, y: 5 }
    e.stats.evasion = 40
    b.skirmish(a, a.weapons[0], { targetId: e.id })
    expect(a.flags['round:hunter']).toBeFalsy()
  })
})

describe('Napoleon', () => {
  it('Heavy Shielding: half damage on a successful save becomes 1', () => {
    const { a, b } = l6({ frame: 'mf_napoleon' })
    expect(b.halfOnSave(a, 9)).toBe(1)
  })
})

describe('Pegasus', () => {
  it('the Ushabti Omnigun deals 1 unreducible damage 1/round (3/round after the CORE)', () => {
    const { a, e, b } = coreSetup('mf_pegasus')
    e.stats.armor = 5
    const hp = e.hp
    b.useCustom(a, custom(b, a, /Omnigun/), e)
    expect(e.hp).toBe(hp - 1)
    expect(custom(b, a, /Omnigun/).usable(b, a)).not.toBe(true)
    roundTrip(b, a, e)
    b.activateCore(a)
    b.useCustom(a, custom(b, a, /Omnigun/), e)
    expect(custom(b, a, /Omnigun/).usable(b, a)).toBe(true)
  })
  it('average damage toggle', () => {
    const { a, b } = coreSetup('mf_pegasus')
    b.useCustom(a, custom(b, a, /average damage/))
    expect(a.flags.averageDamage).toBe(true)
  })
})

describe('Raleigh', () => {
  it('Thunder God: chambers 2 rounds per turn not fired; firing 4+ is AP and Shreds', () => {
    const { a, e, b } = coreSetup('mf_raleigh')
    b.activateCore(a)
    roundTrip(b, a, e)
    roundTrip(b, a, e)
    expect(a.flags.chambers).toBe(4)
    const m35 = weapon(a, 'mw_raleigh_integrated')
    e.pos = { x: 3, y: 5 }
    e.stats.evasion = -50
    e.stats.hp = 100; e.hp = 100
    b.weaponAttack(a, m35, { targetId: e.id }, 'free')
    expect(100 - e.hp).toBeGreaterThanOrEqual(10)
    expect(b.has(e, 'shredded')).toBe(true)
    expect(a.flags.chambers).toBe(0)
  })
})

describe('Sherman', () => {
  it('Stabilize adds charges (the profile follows), COREBURN adds 3 and doubles Stabilize', () => {
    const { a, e, b } = coreSetup('mf_sherman')
    const zf = weapon(a, 'mw_sherman_integrated')
    expect(zf.profileIndex).toBe(0)
    b.stabilize(a, 'cool')
    expect(a.flags.zfCharges).toBe(2)
    expect(zf.profileIndex).toBe(1)
    roundTrip(b, a, e)
    a.coreAvailable = true
    b.activateCore(a)
    expect(a.flags.zfCharges).toBe(4)
  })
})

describe('AI with CORE frames', () => {
  it('AI battles with Raleigh, Black Witch, Dusk Wing, Goblin, Pegasus, Barbarossa and Sherman without errors', () => {
    const frames = ['mf_raleigh', 'mf_black_witch', 'mf_dusk_wing', 'mf_goblin', 'mf_pegasus', 'mf_barbarossa', 'mf_sherman']
    const ps = frames.map((f, i) => { const u = mech({ frame: f, level: 6, callsign: `P${i}` }); u.pos = { x: 1 + i * 2, y: 1 }; u.coreAvailable = true; return u })
    const es = frames.map((f, i) => { const u = mech({ frame: f, level: 6, callsign: `E${i}` }, 'enemy'); u.pos = { x: 1 + i * 2, y: 18 }; u.coreAvailable = true; return u })
    const b = battle([...ps, ...es], flatMap(16, 20), 21)
    autoBattle(b, 10)
    expect(aiErrors).toEqual([])
  })
})

describe('core bonuses', () => {
  describe('Briareos Frame', () => {
    it('at 0 HP and 0 Structure the mech survives and makes structure checks', () => {
      const { a, b } = l6({ coreBonuses: ['cb_briareos_frame'] })
      a.structure = 1
      a.hp = 1
      b.loseHp(a, 5)
      expect(a.destroyed).toBe(false)
      expect(a.flags.briareosZero).toBe(true)
      b.heal(a, 5)
      expect(a.hp).toBe(0)
      let n = 0
      while (!a.destroyed && n++ < 200) b.loseHp(a, 1)
      expect(a.destroyed).toBe(true)
    })
  })
  describe('Ghostweave', () => {
    it('invisible on your turn; stays invisible after only moving; a reaction ends it', () => {
      const { a, e, b } = l6({ coreBonuses: ['cb_ghostweave'] })
      expect(b.has(a, 'invisible')).toBe(true)
      b.move(a, { x: 6, y: 4 })
      b.endTurn(a)
      expect(b.has(a, 'invisible')).toBe(true)
      b.beginTurn(e)
      a.reactionsLeft--
      b.weaponAttack(e, e.weapons[0], { targetId: a.id }, 'free')
      expect(b.has(a, 'invisible')).toBe(false)
    })
    it('attacking on your turn ends the invisibility at the end of it', () => {
      const { a, e, b } = l6({ coreBonuses: ['cb_ghostweave'] })
      b.skirmish(a, weapon(a, 'mw_assault_rifle'), { targetId: e.id })
      b.endTurn(a)
      expect(b.has(a, 'invisible')).toBe(false)
    })
  })
  describe('The Lesson of the Open Door', () => {
    it('a failed save against you deals 2 heat, once per round', () => {
      const { a, e, b } = l6({ coreBonuses: ['cb_the_lesson_of_the_open_door'] })
      e.stats.hull = -30
      const h = e.heat
      b.save(e, 'hull', a.stats.save, 0, a)
      b.save(e, 'hull', a.stats.save, 0, a)
      expect(e.heat).toBe(h + 2)
    })
  })
  describe('Overpower Caliber', () => {
    it('the chosen weapon adds +1d6 once per round', () => {
      const { a, e, b } = l6({ coreBonuses: ['cb_overpower_caliber'] })
      a.stats.attackBonus = 30
      const r = b.weaponAttack(a, weapon(a, 'mw_assault_rifle'), { targetId: e.id }, 'free')
      expect(a.flags.overpowerUid).toBe(weapon(a, 'mw_assault_rifle').uid)
      expect(r.ctxs[0].reasons).toContain('Overpower Caliber +1d6')
      expect(a.flags['round:overpower']).toBe(true)
    })
  })
})
