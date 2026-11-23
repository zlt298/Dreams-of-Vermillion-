// Bugs that only show when several effect scripts (or a script and a core rule) meet.
import { describe, expect, it } from 'vitest'
import type { PilotBuild } from '../src/import/compcon'
import { buildMechUnit } from '../src/rules/stats'
import { Battle } from '../src/rules/battle'
import type { Unit } from '../src/rules/types'
import { flatMap, pregenUnit } from './helpers'

interface Opts { frame?: string; aux?: string; systems?: string[]; talents?: [string, number][]; cbs?: string[]; side?: 'player' | 'enemy'; weapon?: string }
function mech(o: Opts = {}): Unit {
  const p = {
    id: `t-${Math.random()}`, callsign: 'T', name: 'T', level: 9, mechSkills: [2, 2, 2, 2],
    talents: (o.talents ?? []).map(([id, rank]) => ({ id, rank })), coreBonuses: o.cbs ?? [],
    mech: {
      name: 'T', frameId: o.frame ?? 'mf_standard_pattern_i_everest',
      mounts: [
        { type: 'Main', slots: [{ size: 'Main', weaponId: o.weapon ?? 'mw_assault_rifle' }], bonusEffects: [] },
        ...(o.aux ? [{ type: 'Flex', slots: [{ size: 'Auxiliary', weaponId: o.aux }], bonusEffects: [] }] : []),
      ],
      systems: o.systems ?? [],
    },
    unknown: [],
  } as unknown as PilotBuild
  return buildMechUnit(p, o.side ?? 'player')
}
function world(a: Unit, e: Unit, extra: Unit[] = []) {
  a.pos = { x: 4, y: 4 }
  if (e.pos.x === 0 && e.pos.y === 0) e.pos = { x: 4, y: 9 }
  const b = new Battle({ map: flatMap(16, 16), units: [a, e, ...extra], seed: 9 })
  b.start()
  return b
}
const tanky = (u: Unit) => { u.stats.armor = 0; u.stats.hp = u.hp = 60 }

describe('Resistance from scripts behaves like Resistance', () => {
  it('Briareos Frame (≤1 Structure) does not stack with other Resistance', () => {
    const a = mech({ cbs: ['cb_briareos_frame'] }), e = pregenUnit('Sniper', 'enemy')
    const b = world(a, e)
    tanky(a); a.structure = 1
    expect(b.applyDamage(a, [{ type: 'Kinetic', amount: 20 }], { source: e, resistAll: true })).toBe(10)
    expect(b.applyDamage(a, [{ type: 'Kinetic', amount: 20 }], { source: e })).toBe(10)
  })
  it('Briareos Resistance is cancelled by Shredded and by Irreducible damage', () => {
    const a = mech({ cbs: ['cb_briareos_frame'] }), e = pregenUnit('Sniper', 'enemy')
    const b = world(a, e)
    tanky(a); a.structure = 1
    expect(b.applyDamage(a, [{ type: 'Kinetic', amount: 20 }], { source: e, irreducible: true })).toBe(20)
    b.addStatus(a, 'shredded')
    expect(b.applyDamage(a, [{ type: 'Kinetic', amount: 20 }], { source: e })).toBe(20)
  })
  it('Briareos does nothing above 1 Structure', () => {
    const a = mech({ cbs: ['cb_briareos_frame'] }), e = pregenUnit('Sniper', 'enemy')
    const b = world(a, e)
    tanky(a)
    expect(b.applyDamage(a, [{ type: 'Kinetic', amount: 20 }], { source: e })).toBe(20)
  })
  it('HyperDense Armor: Resistance beyond range 3 only, once', () => {
    const a = mech({ frame: 'mf_black_witch', systems: ['ms_hyperdense_armor'] }), e = pregenUnit('Sniper', 'enemy')
    const b = world(a, e)
    tanky(a); a.flags.hyperdense = true
    // Energy: the Black Witch already resists Kinetic
    expect(b.applyDamage(a, [{ type: 'Energy', amount: 20 }], { source: e, resistAll: true })).toBe(10)
    expect(b.applyDamage(a, [{ type: 'Energy', amount: 20 }], { source: e })).toBe(10)
    e.pos = { x: 5, y: 5 }
    expect(b.applyDamage(a, [{ type: 'Energy', amount: 20 }], { source: e })).toBe(20)
  })
  it('Vlad Tormentor Spines: Resistance within range 3 only, once', () => {
    const a = mech({ frame: 'mf_vlad' }), e = pregenUnit('Sniper', 'enemy')
    const b = world(a, e)
    tanky(a); a.flags.tormentor = true
    e.pos = { x: 5, y: 5 }
    expect(b.applyDamage(a, [{ type: 'Kinetic', amount: 20 }], { source: e, resistAll: true })).toBe(10)
    e.pos = { x: 4, y: 12 }
    expect(b.applyDamage(a, [{ type: 'Kinetic', amount: 20 }], { source: e })).toBe(20)
  })
})

describe('Deep Well Heat Sink', () => {
  it('gives no heat Resistance outside the Danger Zone', () => {
    const a = mech({ systems: ['ms_deep_well_heat_sink'] }), e = pregenUnit('Sniper', 'enemy')
    const b = world(a, e)
    b.beginTurn(a)
    expect(a.resist).not.toContain('Heat')
    b.addHeat(a, 2)
    expect(a.heat).toBe(2)
  })
  it('halves heat for the rest of a turn started in the Danger Zone, then stops', () => {
    const a = mech({ systems: ['ms_deep_well_heat_sink'] }), e = pregenUnit('Sniper', 'enemy')
    const b = world(a, e)
    a.heat = Math.ceil(a.stats.heatcap / 2)
    b.beginTurn(a)
    const h = a.heat
    b.applyDamage(a, [{ type: 'Heat', amount: 2 }], { source: e })
    expect(a.heat).toBe(h + 1)
    b.endTurn(a)
    b.applyDamage(a, [{ type: 'Heat', amount: 2 }], { source: e })
    expect(a.heat).toBe(h + 3)
  })
  it('does not strip the Manticore core\'s scene-long heat Resistance', () => {
    const a = mech({ frame: 'mf_manticore', systems: ['ms_deep_well_heat_sink'] }), e = pregenUnit('Sniper', 'enemy')
    const b = world(a, e)
    a.heat = Math.ceil(a.stats.heatcap / 2)
    b.beginTurn(a)
    b.activateCore(a)
    b.endTurn(a)
    expect(a.resist).toContain('Heat')
  })
})

describe('Bonded 2 (Intercede)', () => {
  it('two Bondmates with Intercede do not bounce damage back and forth', () => {
    const a = mech({ talents: [['t_bonded', 2]] }), m = mech({ talents: [['t_bonded', 2]] }), e = pregenUnit('Sniper', 'enemy')
    m.pos = { x: 5, y: 4 }
    const b = world(a, e, [m])
    a.flags.bondmate = m.id; m.flags.bondmate = a.id
    tanky(a); tanky(m)
    b.applyDamage(m, [{ type: 'Kinetic', amount: 6 }], { source: e })
    expect(a.hp).toBe(54)
    expect(m.hp).toBe(60)
    expect(m.reactionsLeft).toBe(m.reactionsPerRound)
  })
})

describe('script reactions go through Battle.spend()', () => {
  it('Return Fire (Gunslinger 2) triggers Centimane\'s Restricting burn', () => {
    const a = mech({ talents: [['t_gunslinger', 2]], aux: 'mw_pistol' })
    const e = mech({ talents: [['t_centimane', 3]], side: 'enemy' })
    e.pos = { x: 4, y: 8 }
    const b = world(a, e)
    b.beginTurn(a); b.endTurn(a)
    b.beginTurn(e)
    a.flags.restricting = { by: e.id, turns: 2 }
    const before = a.reactionsLeft
    e.stats.attackBonus = 50
    b.weaponAttack(e, e.weapons[0], { targetId: a.id }, 'skirmish')
    expect(a.reactionsLeft).toBe(before - 1)
    expect(a.burn).toBeGreaterThanOrEqual(1)
  })
  it('no script decrements reactionsLeft directly (spend() handles reveal, Ghostweave and onAnyAction)', () => {
    const fs = require('node:fs') as typeof import('node:fs')
    const dir = `${__dirname}/../src/rules/effects/scripts`
    const offenders = fs.readdirSync(dir).filter(f => /reactionsLeft\s*(--|-=)/.test(fs.readFileSync(`${dir}/${f}`, 'utf8')))
    expect(offenders).toEqual([])
  })
})

describe('previews never reshape weapons', () => {
  it('Ammo Case (Walking Armory): previewing with THUMPER loaded leaves the rifle Kinetic', () => {
    const a = mech({ talents: [['t_walking_armory', 1]] }), e = pregenUnit('Sniper', 'enemy')
    const b = world(a, e)
    b.beginTurn(a)
    const rifle = a.weapons.find(w => w.dataId === 'mw_assault_rifle')!
    const uses = a.systems.map(s => s.usesLeft)
    a.flags.ammo = 'thumper'
    b.previewAttack(a, rifle, e)
    b.previewDetail(a, rifle, e)
    a.flags.ammo = undefined
    expect(b.profile(rifle).damage.every(d => d.type === 'Kinetic')).toBe(true)
    expect(a.systems.map(s => s.usesLeft)).toEqual(uses)
  })
  it('Ammo Case: MAG and SABOT tags do not stick after a preview', () => {
    const a = mech({ talents: [['t_walking_armory', 1]] }), e = pregenUnit('Sniper', 'enemy')
    const b = world(a, e)
    b.beginTurn(a)
    const rifle = a.weapons.find(w => w.dataId === 'mw_assault_rifle')!
    const tags = JSON.stringify(b.profile(rifle).tags)
    for (const k of ['mag', 'sabot']) { a.flags.ammo = k; b.previewAttack(a, rifle, e) }
    expect(JSON.stringify(b.profile(rifle).tags)).toBe(tags)
  })
  it('Thunder God: previewing a 4-chamber shot does not leave the M35 permanently AP', () => {
    const a = mech({ frame: 'mf_raleigh' }), e = pregenUnit('Sniper', 'enemy')
    const b = world(a, e)
    b.beginTurn(a)
    const m35 = a.weapons.find(w => w.dataId === 'mw_raleigh_integrated')!
    a.flags.thunderGod = true; a.flags.chambers = 4
    b.previewAttack(a, m35, e)
    expect(b.profile(m35).tags.some(t => t.id === 'tg_ap')).toBe(false)
  })
})
