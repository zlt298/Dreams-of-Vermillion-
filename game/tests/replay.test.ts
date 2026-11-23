// Battle replays: record → export → replay must land on the same state.
import { describe, expect, it } from 'vitest'
import type { PilotBuild } from '../src/import/compcon'
import { buildMechUnit } from '../src/rules/stats'
import { Battle } from '../src/rules/battle'
import { autoBattle } from '../src/ai/ai'
import { exportBattle, importBattle, replayBattle, stateHash } from '../src/replay/replay'
import type { Unit } from '../src/rules/types'
import { flatMap, pregenUnit } from './helpers'

function mech(systems: string[], side: 'player' | 'enemy' = 'player'): Unit {
  const p = {
    id: `t-${Math.random()}`, callsign: 'Tester', name: 'T', level: 6, mechSkills: [2, 2, 2, 2], talents: [], coreBonuses: [],
    mech: { name: 'T', frameId: 'mf_standard_pattern_i_everest', mounts: [{ type: 'Main', slots: [{ size: 'Main', weaponId: 'mw_assault_rifle' }], bonusEffects: [] }], systems },
    unknown: [],
  } as unknown as PilotBuild
  return buildMechUnit(p, side)
}

describe('battle replays', () => {
  it('an AI vs AI battle replays to the identical state', () => {
    const a = pregenUnit('Assault'), c = pregenUnit('Hacker'), e1 = pregenUnit('Sniper', 'enemy'), e2 = pregenUnit('Assault', 'enemy')
    a.pos = { x: 2, y: 2 }; c.pos = { x: 6, y: 2 }; e1.pos = { x: 2, y: 12 }; e2.pos = { x: 6, y: 13 }
    const b = new Battle({ map: flatMap(12, 16), units: [a, c, e1, e2], seed: 77 })
    b.start()
    autoBattle(b, 6)
    const x = importBattle(JSON.stringify(exportBattle(b)))
    expect(x.commands.length).toBeGreaterThan(4)
    expect(x.commands.every(cmd => cmd.op === 'aiTurn')).toBe(true)
    const errors: string[] = []
    const r = replayBattle(x, { onError: (_i, _c, e) => errors.push(e.message) })
    expect(errors).toEqual([])
    expect(stateHash(r)).toBe(x.hash)
  })

  it('player commands (moves, attacks, custom actions, toggles, picker answers) replay exactly', () => {
    const a = mech(['ms_pattern_b_hex_charges'])
    const e = pregenUnit('Assault', 'enemy')
    a.pos = { x: 5, y: 4 }; e.pos = { x: 5, y: 9 }
    a.hp = 2; e.stats.attackBonus = 30 // set before start: the record captures it
    const b = new Battle({ map: flatMap(14, 16), units: [a, e], seed: 5 })
    b.start()
    b.chooser = () => undefined
    b.setPolicy(a, 'brace', 'ask')
    b.transaction(() => b.beginTurn(a))
    b.transaction(() => { b.move(a, { x: 5, y: 6 }) })
    const mine = b.customActions(a).find(x => /Explosive Mine/.test(x.name))!
    b.transaction(() => b.useCustom(a, mine, { x: 5, y: 7 }))
    b.transaction(() => { b.skirmish(a, a.weapons[0], { targetId: e.id }) })
    b.transaction(() => b.endTurn(a))
    // the enemy's turn: an attack that makes the player decide whether to Brace
    let r = b.transaction(() => b.beginTurn(e))
    r = b.transaction(() => { b.skirmish(e, e.weapons.find(w => b.weaponUsable(e, w) === true)!, { targetId: a.id }) })
    if ('pending' in r) b.transaction(() => { b.skirmish(e, e.weapons.find(w => b.weaponUsable(e, w) === true)!, { targetId: a.id }) }, [0])
    const x = exportBattle(b)
    expect(x.commands.map(c => c.op)).toEqual(expect.arrayContaining(['setPolicy', 'beginTurn', 'move', 'useCustom', 'skirmish', 'endTurn']))
    const errors: string[] = []
    const rep = replayBattle(x, { onError: (_i, c, err) => errors.push(`${c.op}: ${err.message}`) })
    expect(errors).toEqual([])
    expect(stateHash(rep)).toBe(x.hash)
  })

  it('a rolled-back transaction leaves no commands behind; replays can stop early', () => {
    const a = mech([])
    const e = pregenUnit('Assault', 'enemy')
    a.pos = { x: 5, y: 4 }; e.pos = { x: 5, y: 9 }
    const b = new Battle({ map: flatMap(14, 16), units: [a, e], seed: 5 })
    b.start()
    b.chooser = () => undefined
    b.transaction(() => b.beginTurn(a))
    const n = b.commands.length
    const r = b.transaction(() => { b.move(a, { x: 5, y: 5 }); b.choose({ kind: 'test', unit: a, title: 'x', options: [{ label: 'a' }, { label: 'b' }], defaultIndex: 0 }) })
    expect('pending' in r).toBe(true)
    expect(b.commands.length).toBe(n)
    b.transaction(() => { b.move(a, { x: 5, y: 5 }) })
    const early = replayBattle(exportBattle(b), { upTo: 1 })
    expect(early.unit(a.id)!.pos).toEqual({ x: 5, y: 4 })
  })
})
