// Higher talent ranks scripted in rules/effects/scripts/talents2.ts.
import { describe, expect, it } from 'vitest'
import type { PilotBuild } from '../src/import/compcon'
import { buildMechUnit } from '../src/rules/stats'
import { Battle } from '../src/rules/battle'
import { autoBattle, aiErrors } from '../src/ai/ai'
import type { Unit } from '../src/rules/types'
import { flatMap, pregenUnit } from './helpers'

function mech(talents: [string, number][], opts: { weapon?: string; frame?: string; side?: 'player' | 'enemy'; name?: string } = {}): Unit {
  const p = {
    id: `t-${Math.random()}`, callsign: opts.name ?? 'Tester', name: 'T', level: 9, mechSkills: [2, 2, 2, 2],
    talents: talents.map(([id, rank]) => ({ id, rank })), coreBonuses: [],
    mech: { name: 'T', frameId: opts.frame ?? 'mf_standard_pattern_i_everest', mounts: [{ type: 'Heavy', slots: [{ size: 'Heavy', weaponId: opts.weapon ?? 'mw_assault_rifle' }], bonusEffects: [] }], systems: [] },
    unknown: [],
  } as unknown as PilotBuild
  return buildMechUnit(p, opts.side ?? 'player')
}
function setup(talents: [string, number][], opts: Parameters<typeof mech>[1] = {}) {
  const a = mech(talents, opts)
  const e = pregenUnit('Assault', 'enemy')
  a.pos = { x: 4, y: 4 }
  e.pos = { x: 4, y: 9 }
  const b = new Battle({ map: flatMap(16, 16), units: [a, e], seed: 9 })
  b.start()
  b.beginTurn(a)
  return { a, e, b }
}
const act = (b: Battle, u: Unit, re: RegExp) => {
  const x = b.customActions(u).find(c => re.test(c.name) || re.test(c.key))
  if (!x) throw new Error(`no action ${re}: ${b.customActions(u).map(c => c.name).join(', ')}`)
  return x
}

describe('talent ranks', () => {
  it('Bonded 2 (Intercede): takes damage meant for the adjacent Bondmate', () => {
    const { a, e, b } = setup([['t_bonded', 2]])
    const mate = pregenUnit('Sniper')
    mate.pos = { x: 5, y: 4 }
    b.units.push(mate)
    const hp = mate.hp, myHp = a.hp
    b.applyDamage(mate, [{ type: 'Kinetic', amount: 6 }], { source: e })
    expect(mate.hp).toBe(hp)
    expect(a.hp).toBe(myHp - 6)
  })
  it('Exemplar 3 (To the Death): +3 difficulty attacking anyone but the duelist', () => {
    const { a, e, b } = setup([['t_exemplar', 3]])
    const other = pregenUnit('Hacker', 'enemy'); other.pos = { x: 8, y: 4 }; b.units.push(other)
    e.flags.exemplarMarkBy = a.id
    b.useCustom(a, act(b, a, /Duel to the Death/))
    const rifle = a.weapons.find(w => w.dataId === 'mw_assault_rifle')!
    expect(b.previewAttack(a, rifle, other).ctx.reasons).toContain('To the Death -3')
    expect(b.previewAttack(a, rifle, e).ctx.reasons).not.toContain('To the Death -3')
  })
  it('Infiltrator 1 (Prowl): Hide in plain sight on your turn; exposed at the end of it', () => {
    const { a, b } = setup([['t_infiltrator', 1]])
    expect(b.canHide(a)).toBe(true)
    b.hide(a)
    expect(b.has(a, 'hidden')).toBe(true)
    b.endTurn(a)
    expect(b.has(a, 'hidden')).toBe(false)
  })
  it('Infiltrator 3 (Mastermind): losing Hidden offers a free slip-away move', () => {
    const { a, b } = setup([['t_infiltrator', 3]])
    b.addStatus(a, 'hidden')
    b.removeStatus(a, 'hidden')
    expect(a.flags.mastermindMove).toBe(true)
    b.useCustom(a, act(b, a, /Mastermind/), { x: 1, y: 1 })
    expect(a.pos).toEqual({ x: 1, y: 1 })
  })
  it('Juggernaut 3 (Unstoppable Force): charges in a straight line and takes heat', () => {
    const { a, b } = setup([['t_juggernaut', 3]])
    b.useCustom(a, act(b, a, /Unstoppable/), { x: 4, y: 0 })
    expect(a.pos.y).toBeLessThan(4)
    expect(a.heat).toBeGreaterThanOrEqual(4)
  })
  it('Leader 3 (Inspiring Presence): an ally spends a die to reduce damage', () => {
    const { a, e, b } = setup([['t_leader', 3]])
    const ally = pregenUnit('Sniper'); ally.pos = { x: 6, y: 4 }; b.units.push(ally)
    ally.stats.armor = 0
    const hp = ally.hp
    b.applyDamage(ally, [{ type: 'Kinetic', amount: 8 }], { source: e })
    expect(hp - ally.hp).toBeLessThan(8)
  })
  it('Spotter 3 (Bentham/Foucault): Lock On makes an adjacent ally attack the target', () => {
    const { a, e, b } = setup([['t_spotter', 3]])
    const ally = pregenUnit('Assault'); ally.pos = { x: 5, y: 4 }; b.units.push(ally)
    e.pos = { x: 4, y: 7 }
    b.lockOn(a, e)
    expect(b.log.some(l => /fires on .*'s mark/.test(l.text))).toBe(true)
  })
  it('Stormbringer 3 (Torrent): at Torrent 1, Massive Attack knocks the target Prone', () => {
    const { a, e, b } = setup([['t_stormbringer', 3]])
    a.flags.torrent = 1
    b.useCustom(a, act(b, a, /Massive Attack/), e)
    expect(b.has(e, 'prone')).toBe(true)
    expect(a.flags.torrent).toBe(6)
  })
  it('Siege Specialist 1 (Jackhammer): characters next to the impact take 2 and are knocked back', () => {
    const { a, e, b } = setup([['t_siege_specialist', 1]], { weapon: 'mw_assault_cannon' })
    e.stats.armor = 0
    const hp = e.hp
    b.useCustom(a, act(b, a, /Jackhammer/), { x: 4, y: 8 })
    expect(e.hp).toBe(hp - 2)
    expect(e.pos.y).toBeGreaterThan(9)
  })
  it('Heavy Gunner 3 (Bracketing Fire): Covering Fire pins two targets', () => {
    const { a, e, b } = setup([['t_heavy_gunner', 3]], { weapon: 'mw_anti_materiel_rifle' })
    const e2 = pregenUnit('Hacker', 'enemy'); e2.pos = { x: 6, y: 9 }; b.units.push(e2)
    b.useCustom(a, act(b, a, /Covering Fire/), e)
    expect(e.flags.coveredBy).toBe(a.id)
    expect(e2.flags.coveredBy).toBe(a.id)
  })
  it('Ace 3 (Supersonic): spin up and nominate a target when ending the turn flying', () => {
    const { a, b } = setup([['t_ace', 3]])
    a.flying = true
    b.useCustom(a, act(b, a, /Spin Up/))
    b.endTurn(a)
    expect(a.flags.supersonic).toBeDefined()
  })
  it('AI battles with all of these talents without errors', () => {
    aiErrors.length = 0
    const sets: [string, number][][] = [
      [['t_bonded', 3], ['t_exemplar', 3]], [['t_infiltrator', 3], ['t_juggernaut', 3]], [['t_leader', 3], ['t_spotter', 3]], [['t_stormbringer', 3], ['t_ace', 3], ['t_centimane', 3]],
    ]
    const ps = sets.map((t, i) => { const u = mech(t, { name: `P${i}` }); u.pos = { x: 2 + i * 3, y: 1 }; return u })
    const es = sets.map((t, i) => { const u = mech(t, { name: `E${i}`, side: 'enemy' }); u.pos = { x: 2 + i * 3, y: 14 }; return u })
    const b = new Battle({ map: flatMap(16, 16), units: [...ps, ...es], seed: 31 })
    b.start()
    autoBattle(b, 10)
    expect(aiErrors).toEqual([])
  })
})
