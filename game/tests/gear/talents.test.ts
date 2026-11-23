// Pilot talents, one describe per talent tree (alphabetical). Scripts in rules/effects/scripts/talents*.ts.
import { describe, expect, it } from 'vitest'
import { autoBattle, aiErrors } from '../../src/ai/ai'
import { getScript } from '../../src/rules/effects/registry'
import { battle, flatMap, mech, pregenUnit, rigDice } from '../support'
import { custom, gun, toEnemyTurn, vs } from './helpers'

type Talents = [string, number][]
/** Level-12 Everest with these talents vs an Assault with Evasion 1 that fails Hull/Agility/Systems saves. */
function setup12(talents: Talents, o: { weapon?: string; size?: string } = {}) {
  const a = mech({ level: 12, talents, weapons: [[o.size ?? 'Main', o.weapon ?? 'mw_assault_rifle']] })
  return vs(a, { enemy: { evasion: 1, hull: -20, agi: -20, sys: -20 } })
}
const mate12 = (callsign: string) => mech({ level: 12, callsign })
/** Level-9 Everest (weapon in a Heavy mount) at (4,4) vs a plain Assault at (4,9), seed 9. */
function setup9(talents: Talents, o: { weapon?: string } = {}) {
  const a = mech({ talents, weapons: [['Heavy', o.weapon ?? 'mw_assault_rifle']] })
  return vs(a, { a: { x: 4, y: 4 }, e: { x: 4, y: 9 }, seed: 9 })
}
/** Level-9 Everest (callsign T) vs a plain Assault at the usual spots, seed 13. */
const setupT = (talents: Talents, o: { weapons?: [string, string][]; systems?: string[] } = {}) => vs(mech({ callsign: 'T', talents, ...o }))

describe('former partial talent ranks', () => {
  it('no partial talent rank scripts remain', () => {
    for (const id of ['t_ace:3', 't_bonded:1', 't_bonded:2', 't_bonded:3', 't_brutal:1', 't_crack_shot:3', 't_centimane:3', 't_duelist:2', 't_exemplar:1', 't_exemplar:3', 't_hacker:3', 't_heavy_gunner:1', 't_infiltrator:3', 't_leader:1', 't_stormbringer:2', 't_walking_armory:1'])
      expect(getScript(id)?.partial, id).toBeFalsy()
  })
})

describe('Ace', () => {
  it('Ace 3 (Supersonic): spin up and nominate a target when ending the turn flying', () => {
    const { a, b } = setup9([['t_ace', 3]])
    a.flying = true
    b.useCustom(a, custom(b, a, /Spin Up/))
    b.endTurn(a)
    expect(a.flags.supersonic).toBeDefined()
  })
  it('Ace 3: Supersonic flies you next to the nominee when its turn ends', () => {
    const { a, e, b } = setup12([['t_ace', 3]])
    a.flying = true
    b.useCustom(a, custom(b, a, /Spin Up/))
    b.endTurn(a)
    expect(a.flags.supersonic).toBe(e.id)
    b.beginTurn(e)
    b.endTurn(e)
    expect(b.adjacent(a, e)).toBe(true)
  })
})

describe('Bonded', () => {
  it('Bonded 1: +1 Accuracy on checks and saves for both while adjacent; the Bondmate is chosen', () => {
    const { a, b } = setup12([['t_bonded', 1]])
    const m = mate12('Mate'); m.pos = { x: 6, y: 4 }; b.units.push(m)
    b.useCustom(a, custom(b, a, /Choose Bondmate/), m)
    expect(b.accuracyFromStatuses(a, 'save', 'hull')).toBe(1)
    expect(b.accuracyFromStatuses(m, 'check', 'agi')).toBe(1)
    m.pos = { x: 10, y: 10 }
    expect(b.accuracyFromStatuses(a, 'save', 'hull')).toBe(0)
  })
  it('Bonded 2 (Intercede): takes damage meant for the adjacent Bondmate', () => {
    const { a, e, b } = setup9([['t_bonded', 2]])
    const mate = pregenUnit('Sniper')
    mate.pos = { x: 5, y: 4 }
    b.units.push(mate)
    const hp = mate.hp, myHp = a.hp
    b.applyDamage(mate, [{ type: 'Kinetic', amount: 6 }], { source: e })
    expect(mate.hp).toBe(hp)
    expect(a.hp).toBe(myHp - 6)
  })
  it('Bonded 2: Intercede asks the player and takes the damage instead', () => {
    const { a, e, b } = setup12([['t_bonded', 2]])
    const m = mate12('Mate'); m.pos = { x: 6, y: 4 }; b.units.push(m)
    a.flags.bondmate = m.id
    b.chooser = () => undefined
    const hp = m.hp, ahp = a.hp
    const r = b.transaction(() => { b.applyDamage(m, [{ type: 'Kinetic', amount: 6 }], { source: e }) })
    expect('pending' in r && r.pending.kind).toBe('intercede')
    b.transaction(() => { b.applyDamage(m, [{ type: 'Kinetic', amount: 6 }], { source: e }) }, [0])
    expect(m.hp).toBe(hp)
    expect(a.hp).toBeLessThan(ahp)
  })
  it('Bonded 3: Cover Me! — the threatened attacker may switch targets', () => {
    const { a, e, b } = setup12([['t_bonded', 3]])
    const m = mate12('Mate'); m.pos = { x: 6, y: 6 }; b.units.push(m)
    const other = mate12('Other'); other.pos = { x: 4, y: 6 }; b.units.push(other)
    a.flags.bondmate = m.id
    toEnemyTurn(b, a, e)
    e.hp = 2 // a hurt attacker switches by default
    const r = b.weaponAttack(e, gun(e), { targetId: m.id }, 'free')
    expect(r.ctxs[0].target).not.toBe(m)
    expect(a.reactionsLeft).toBe(0)
  })
})

describe('Brutal', () => {
  it('Brutal 1: a natural 20 crit deals maximum damage', () => {
    const { a, e, b } = setup12([['t_brutal', 1]])
    e.stats.hp = 999; e.hp = 999; e.stats.armor = 0
    rigDice(b, 20, 20)
    const r = b.weaponAttack(a, gun(a), { targetId: e.id }, 'free')
    expect(r.ctxs[0].roll).toBe(20)
    expect(r.ctxs[0].crit).toBe(true)
    expect(r.ctxs[0].reasons).toContain('Predator: maximum damage')
    expect(999 - e.hp).toBe(6) // assault rifle 1d6, maxed
  })
})

describe('Centimane', () => {
  it('Centimane 3: Restricting swarm burns on every action', () => {
    const { a, e, b } = setup12([['t_centimane', 3]])
    const s = getScript('t_centimane:3')!
    b.chooser = () => undefined
    b.transaction(() => s.afterAttack!(b, a, { attacker: a, target: e, weapon: { ...gun(a), type: 'Nexus' }, crit: true, hit: true } as any, 'attacker'), [3])
    toEnemyTurn(b, a, e)
    b.boost(e)
    expect(e.burn).toBeGreaterThanOrEqual(1)
  })
})

describe('Crack Shot', () => {
  it('Crack Shot 3: on a steadied Rifle crit, the shooter picks the effect', () => {
    const { a, e, b } = setup12([['t_crack_shot', 3]], { weapon: 'mw_assault_rifle' })
    const s = getScript('t_crack_shot:3')!
    a.flags.steady = true
    b.chooser = () => undefined
    const ctx: any = { attacker: a, target: e, weapon: gun(a), crit: true, hit: true }
    b.transaction(() => s.afterAttack!(b, a, ctx, 'attacker'), [1])
    expect(b.has(e, 'immobilized')).toBe(true)
  })
})

describe('Drone Commander', () => {
  it('Drone Commander 3: Invigorate gives a chain of allies 4 overshield', () => {
    const a = mech({ level: 6, systems: ['ms_hive_drone'], talents: [['t_drone_commander', 3]] })
    const { b } = vs(a, { a: { x: 3, y: 3 }, e: { x: 3, y: 9 }, map: flatMap(14, 14), seed: 5 })
    const ally = pregenUnit('Sniper'); ally.pos = { x: 5, y: 3 }
    const ally2 = pregenUnit('Hacker'); ally2.pos = { x: 8, y: 3 }
    b.units.push(ally, ally2)
    b.useCustom(a, custom(b, a, /Invigorate/), ally)
    expect(ally.overshield).toBe(4)
    expect(ally2.overshield).toBe(4)
  })
})

describe('Duelist', () => {
  it('Duelist 2: Blademaster dice — Parry gives resistance; Trip knocks Prone', () => {
    const { a, e, b } = setup12([['t_duelist', 2]])
    a.flags.bladeDice = 2
    e.pos = { x: 5, y: 5 }
    b.useCustom(a, custom(b, a, /Trip/), e)
    expect(b.has(e, 'prone')).toBe(true)
    expect(a.flags.bladeDice).toBe(1)
  })
})

describe('Exemplar', () => {
  it('Exemplar 1: Valiant Aid lets an ally reroll a miss on your Mark', () => {
    const { a, e, b } = setup12([['t_exemplar', 1]])
    const al = mate12('Ally'); al.pos = { x: 6, y: 5 }; b.units.push(al)
    e.flags.exemplarMarkBy = a.id
    e.stats.evasion = 99
    b.weaponAttack(al, gun(al), { targetId: e.id }, 'free')
    expect(b.log.some(l => /Reroll vs/.test(l.text))).toBe(true)
    expect(a.reactionsLeft).toBe(0)
  })
  it('Exemplar 3: you cannot voluntarily move away from your Mark during the duel', () => {
    const { a, e, b } = setup12([['t_exemplar', 3]])
    a.flags.duel = e.id
    expect(() => b.move(a, { x: 5, y: 1 })).toThrow(/To the Death/)
    b.move(a, { x: 5, y: 6 })
  })
  it('Exemplar 3 (To the Death): +3 difficulty attacking anyone but the duelist', () => {
    const { a, e, b } = setup9([['t_exemplar', 3]])
    const other = pregenUnit('Hacker', 'enemy'); other.pos = { x: 8, y: 4 }; b.units.push(other)
    e.flags.exemplarMarkBy = a.id
    b.useCustom(a, custom(b, a, /Duel to the Death/))
    const rifle = a.weapons.find(w => w.dataId === 'mw_assault_rifle')!
    expect(b.previewAttack(a, rifle, other).ctx.reasons).toContain('To the Death -3')
    expect(b.previewAttack(a, rifle, e).ctx.reasons).not.toContain('To the Death -3')
  })
})

describe('Gunslinger', () => {
  // regression: the empowered attack was made Irreducible instead of AP + ignore cover
  it('Gunslinger 3 (I Kill With My Heart): the empowered attack gains AP and ignores cover (not Irreducible)', () => {
    const { a, e, b } = setupT([['t_gunslinger', 3]], { weapons: [['Auxiliary', 'mw_pistol']] })
    a.flags.gunslingerReady = true
    const ctx = b.previewAttack(a, a.weapons[0], e).ctx
    expect(ctx.ignoreCover).toBe(true)
    expect(ctx.irreducible).toBeFalsy()
  })
})

describe('Hacker', () => {
  // regression: a scripted invade consuming Lock On left SNOW_CRASH pending instead of dealing its heat
  it('Hacker 1 (SNOW_CRASH): a scripted invade that consumes Lock On also deals the 2 heat (and leaves no pending flag)', () => {
    const { a, e, b } = setupT([['t_hacker', 1]], { systems: ['ms_neurospike'] })
    e.stats.edef = -10
    b.addStatus(e, 'lockon', 'until_cleared', a)
    b.useCustom(a, custom(b, a, /Shrike Code/), e)
    expect(e.heat).toBe(4)
    expect(a.flags.snow).toBeFalsy()
  })
  it('Hacker 3: Last Argument of Kings deals Burn equal to Heat', () => {
    const { a, e, b } = setup12([['t_hacker', 3]])
    a.stats.techAttack = 30
    e.heat = 5
    b.useCustom(a, custom(b, a, /Last Argument/), e)
    expect(e.burn).toBe(5)
  })
})

describe('Heavy Gunner', () => {
  it('Heavy Gunner 1: Covering Fire triggers only after more than 1 space, for half damage', () => {
    const { a, e, b } = setup12([['t_heavy_gunner', 1]], { weapon: 'mw_heavy_machine_gun', size: 'Heavy' })
    b.useCustom(a, custom(b, a, /Covering Fire/), e)
    expect(b.has(e, 'impaired')).toBe(true)
    toEnemyTurn(b, a, e)
    b.move(e, { x: 6, y: 8 })
    expect(e.flags.coveredBy).toBe(a.id)
    b.move(e, { x: 8, y: 8 })
    expect(e.flags.coveredBy).toBeUndefined()
    expect(b.has(e, 'impaired')).toBe(false)
  })
  it('Heavy Gunner 3 (Bracketing Fire): Covering Fire pins two targets', () => {
    const { a, e, b } = setup9([['t_heavy_gunner', 3]], { weapon: 'mw_anti_materiel_rifle' })
    const e2 = pregenUnit('Hacker', 'enemy'); e2.pos = { x: 6, y: 9 }; b.units.push(e2)
    b.useCustom(a, custom(b, a, /Covering Fire/), e)
    expect(e.flags.coveredBy).toBe(a.id)
    expect(e2.flags.coveredBy).toBe(a.id)
  })
})

describe('Infiltrator', () => {
  it('Infiltrator 1 (Prowl): Hide in plain sight on your turn; exposed at the end of it', () => {
    const { a, b } = setup9([['t_infiltrator', 1]])
    expect(b.canHide(a)).toBe(true)
    b.hide(a)
    expect(b.has(a, 'hidden')).toBe(true)
    b.endTurn(a)
    expect(b.has(a, 'hidden')).toBe(false)
  })
  it('Infiltrator 3 (Mastermind): losing Hidden slips you away at once (ignoring engagement)', () => {
    const { a, b } = setup9([['t_infiltrator', 3]])
    const from = { ...a.pos }
    b.addStatus(a, 'hidden')
    b.removeStatus(a, 'hidden')
    expect(a.pos).not.toEqual(from)
  })
})

describe('Juggernaut', () => {
  it('Juggernaut 3 (Unstoppable Force): charges in a straight line and takes heat', () => {
    const { a, b } = setup9([['t_juggernaut', 3]])
    b.useCustom(a, custom(b, a, /Unstoppable/), { x: 4, y: 0 })
    expect(a.pos.y).toBeLessThan(4)
    expect(a.heat).toBeGreaterThanOrEqual(4)
  })
})

describe('Leader', () => {
  it('Leader 1: Issue Order gives an ally a die it spends for +1 Accuracy', () => {
    const { a, e, b } = setup12([['t_leader', 1]])
    const al = mate12('Ally'); al.pos = { x: 6, y: 4 }; b.units.push(al)
    b.useCustom(a, custom(b, a, /Issue Order/), al)
    expect(al.flags.leaderDie).toBe(a.id)
    b.endTurn(a)
    b.currentSide = 'player'
    b.beginTurn(al)
    const p = b.previewAttack(al, gun(al), e)
    expect(p.ctx.reasons.some(r => /order/.test(r))).toBe(true)
  })
  it('Leader 3 (Inspiring Presence): an ally spends a die to reduce damage', () => {
    const { e, b } = setup9([['t_leader', 3]])
    const ally = pregenUnit('Sniper'); ally.pos = { x: 6, y: 4 }; b.units.push(ally)
    ally.stats.armor = 0
    const hp = ally.hp
    b.applyDamage(ally, [{ type: 'Kinetic', amount: 8 }], { source: e })
    expect(hp - ally.hp).toBeLessThan(8)
  })
})

describe('Siege Specialist', () => {
  it('Siege Specialist 1 (Jackhammer): characters next to the impact take 2 and are knocked back', () => {
    const { a, e, b } = setup9([['t_siege_specialist', 1]], { weapon: 'mw_assault_cannon' })
    e.stats.armor = 0
    const hp = e.hp
    b.useCustom(a, custom(b, a, /Jackhammer/), { x: 4, y: 8 })
    expect(e.hp).toBe(hp - 2)
    expect(e.pos.y).toBeGreaterThan(9)
  })
  // regression: Collateral Damage dealt 5 and never knocked back
  it('Siege Specialist 3 (Collateral Damage): characters in the burst take 2 explosive and are knocked back 2', () => {
    const { a, e, b } = setupT([['t_siege_specialist', 3]], { weapons: [['Heavy', 'mw_heavy_machine_gun']] })
    const e2 = pregenUnit('Hacker', 'enemy'); e2.pos = { x: 6, y: 8 }; b.units.push(e2)
    e2.stats.armor = 0
    const hp = e2.hp, pos = { ...e2.pos }
    const ctx = b.newAttackCtx(a, e, { weapon: a.weapons[0], hit: true, crit: true })
    getScript('t_siege_specialist:3')!.afterAttack!(b, a, ctx, 'attacker')
    expect(hp - e2.hp).toBe(2)
    expect(e2.pos).not.toEqual(pos)
  })
})

describe('Spotter', () => {
  it('Spotter 3 (Bentham/Foucault): Lock On makes an adjacent ally attack the target', () => {
    const { a, e, b } = setup9([['t_spotter', 3]])
    const ally = pregenUnit('Assault'); ally.pos = { x: 5, y: 4 }; b.units.push(ally)
    e.pos = { x: 4, y: 7 }
    b.lockOn(a, e)
    expect(b.log.some(l => /fires on .*'s mark/.test(l.text))).toBe(true)
  })
})

describe('Stormbringer', () => {
  it('Stormbringer 2: Thunder knocks back everyone else near the target', () => {
    const { a, e, b } = setup12([['t_stormbringer', 2]])
    const e2 = pregenUnit('Sniper', 'enemy'); e2.pos = { x: 6, y: 9 }; e2.stats.agi = -20; b.units.push(e2)
    b.chooser = () => undefined
    const s = getScript('t_stormbringer:2')!
    const from = { ...e2.pos }
    b.transaction(() => s.afterAttack!(b, a, { attacker: a, target: e, weapon: { ...gun(a), type: 'Launcher' }, hit: true } as any, 'attacker'), [1])
    expect(e2.pos).not.toEqual(from)
  })
  it('Stormbringer 3 (Torrent): at Torrent 1, Massive Attack knocks the target Prone', () => {
    const { a, e, b } = setup9([['t_stormbringer', 3]])
    a.flags.torrent = 1
    b.useCustom(a, custom(b, a, /Massive Attack/), e)
    expect(b.has(e, 'prone')).toBe(true)
    expect(a.flags.torrent).toBe(6)
  })
})

describe('AI with these talents', () => {
  it('AI battles with the higher talent ranks without errors', () => {
    const sets: Talents[] = [
      [['t_bonded', 3], ['t_exemplar', 3]], [['t_infiltrator', 3], ['t_juggernaut', 3]], [['t_leader', 3], ['t_spotter', 3]], [['t_stormbringer', 3], ['t_ace', 3], ['t_centimane', 3]],
    ]
    const ps = sets.map((t, i) => { const u = mech({ talents: t, weapons: [['Heavy', 'mw_assault_rifle']], callsign: `P${i}` }); u.pos = { x: 2 + i * 3, y: 1 }; return u })
    const es = sets.map((t, i) => { const u = mech({ talents: t, weapons: [['Heavy', 'mw_assault_rifle']], callsign: `E${i}` }, 'enemy'); u.pos = { x: 2 + i * 3, y: 14 }; return u })
    const b = battle([...ps, ...es], flatMap(16, 16), 31)
    autoBattle(b, 10)
    expect(aiErrors).toEqual([])
  })
  it('AI battles with the former partial talent ranks run cleanly', () => {
    const l12 = (talents: Talents, o: { weapon?: string; size?: string } = {}, side: 'player' | 'enemy' = 'player') =>
      mech({ level: 12, talents, weapons: [[o.size ?? 'Main', o.weapon ?? 'mw_assault_rifle']] }, side)
    const p1 = l12([['t_bonded', 3], ['t_exemplar', 3], ['t_leader', 1]])
    const p2 = l12([['t_duelist', 2], ['t_brutal', 1], ['t_bonded', 2]], { weapon: 'mw_chain_axe' })
    const p3 = l12([['t_heavy_gunner', 1], ['t_ace', 3], ['t_centimane', 3]], { weapon: 'mw_heavy_machine_gun', size: 'Heavy' })
    const e1 = l12([['t_infiltrator', 3], ['t_crack_shot', 3]], {}, 'enemy'), e2 = pregenUnit('Sniper', 'enemy'), e3 = l12([['t_stormbringer', 2], ['t_hacker', 3]], {}, 'enemy')
    p1.pos = { x: 3, y: 2 }; p2.pos = { x: 7, y: 2 }; p3.pos = { x: 10, y: 2 }; e1.pos = { x: 3, y: 12 }; e2.pos = { x: 7, y: 13 }; e3.pos = { x: 10, y: 12 }
    const b = battle([p1, p2, p3, e1, e2, e3], flatMap(14, 16), 9)
    autoBattle(b, 8)
    expect(aiErrors).toHaveLength(0)
  })
})
