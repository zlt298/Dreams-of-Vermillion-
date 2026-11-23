// Battle replays: record → export → replay must land on the same state, including across undo, rollbacks and
// refunds (the battle save is a replay, so this is what resuming a fight relies on).
import { describe, expect, it } from 'vitest'
import { Battle } from '../../src/rules/battle'
import { autoBattle } from '../../src/ai/ai'
import { exportBattle, importBattle, replayBattle, stateHash } from '../../src/replay/replay'
import type { Unit } from '../../src/rules/types'
import { arena, flatMap, mech, pregenUnit } from '../support'

const ask = (b: Battle, u: Unit) => b.choose({ kind: 'test', unit: u, title: 'React?', options: [{ label: 'Yes' }, { label: 'No' }], defaultIndex: 0 })

describe('battle replays', () => {
  it('an AI vs AI battle replays to the identical state', () => {
    const a = pregenUnit('Assault'), c = pregenUnit('Hacker'), e1 = pregenUnit('Sniper', 'enemy'), e2 = pregenUnit('Assault', 'enemy')
    const b = arena([[a, { x: 2, y: 2 }], [c, { x: 6, y: 2 }], [e1, { x: 2, y: 12 }], [e2, { x: 6, y: 13 }]], { map: flatMap(12, 16), seed: 77 })
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
    const a = mech({ level: 6, systems: ['ms_pattern_b_hex_charges'] })
    const e = pregenUnit('Assault', 'enemy')
    a.hp = 2; e.stats.attackBonus = 30 // set before start: the record captures it
    const b = arena([[a, { x: 5, y: 4 }], [e, { x: 5, y: 9 }]], { map: flatMap(14, 16), seed: 5 })
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
    const a = mech({ level: 6 })
    const e = pregenUnit('Assault', 'enemy')
    const b = arena([[a, { x: 5, y: 4 }], [e, { x: 5, y: 9 }]], { map: flatMap(14, 16), seed: 5 })
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

describe('undo by replay', () => {
  it('rebuilds the battle as it was before the last player action, skipping enemy turns and bookkeeping', async () => {
    const { withoutLastAction, isAction } = await import('../../src/replay/replay')
    const { runAiTurn } = await import('../../src/ai/ai')
    const a = pregenUnit('Assault'), e = pregenUnit('Sniper', 'enemy')
    const b = arena([[a, { x: 5, y: 4 }], [e, { x: 5, y: 12 }]], { map: flatMap(14, 16), seed: 9 })
    b.beginTurn(a)
    b.move(a, { x: 5, y: 6 })
    const before = stateHash(b)
    const beforeCount = b.commands.length
    b.endTurn(a)
    runAiTurn(b, e) // the enemy's turn follows the player's last action
    expect(isAction(b.commands[b.commands.length - 1], b)).toBe(false)
    const x = withoutLastAction(exportBattle(b), b)!
    expect(x.commands.length).toBe(beforeCount)
    expect(stateHash(replayBattle(x))).toBe(before)
  })
})

describe('the uid counter is part of undo / rollback state', () => {
  // regression: checkpoint restore did not rewind the id counter, so the saved replay rebuilt a different battle
  it('in-session undo (checkpoint restore) rewinds the id counter: the saved replay rebuilds the same battle', () => {
    const a = mech({ level: 6, systems: ['ms_pattern_b_hex_charges'] }), e = mech({ level: 6 }, 'enemy')
    const b = arena([[a, { x: 5, y: 4 }], [e, { x: 5, y: 12 }]], { map: flatMap(14, 16), seed: 5 })
    b.chooser = () => undefined
    b.transaction(() => b.beginTurn(a))
    const mineAct = () => b.customActions(a).find(x => /Explosive Mine/.test(x.name))!
    // what BattleScreen.cmd + undo() do: snapshot, act, restore the snapshot, act again
    const snap = b.checkpoint()
    b.transaction(() => b.useCustom(a, mineAct(), { x: 5, y: 5 }), [], { rollbackOnError: true })
    snap()
    b.transaction(() => b.useCustom(a, mineAct(), { x: 5, y: 5 }), [], { rollbackOnError: true })
    const x = exportBattle(b) // what saveBattle stores
    const resumed = replayBattle(JSON.parse(JSON.stringify(x)))
    expect(resumed.mines.map(m => m.id)).toEqual(b.mines.map(m => m.id))
    expect(stateHash(resumed)).toBe(x.hash)
  })

  // regression: a PendingChoice rollback did not rewind the id counter, so after resume an attack on a spawned drone was lost
  it('a PendingChoice rollback rewinds the id counter: after resume, a recorded attack on a spawned drone still lands', () => {
    const a = mech({ level: 6 }), e = mech({ level: 6, systems: ['ms_turret_drones'] }, 'enemy')
    const b = arena([[a, { x: 5, y: 3 }], [e, { x: 5, y: 10 }]], { map: flatMap(12, 14), seed: 4 })
    b.chooser = () => undefined
    b.transaction(() => b.beginTurn(a)); b.transaction(() => b.endTurn(a))
    // enemy turn: deploys a drone, then the player is asked a question (e.g. a reaction) -> rollback + replay with the answer
    const enemyTurn = () => {
      b.beginTurn(e)
      b.useCustom(e, b.customActions(e).find(x => x.key === 'turret')!, { x: 5, y: 8 })
      ask(b, a)
      b.endTurn(e)
    }
    expect('pending' in b.transaction(enemyTurn)).toBe(true)
    b.transaction(enemyTurn, [1])
    const drone = b.units.find(u => u.kind === 'drone')!
    b.transaction(() => b.beginTurn(a))
    b.transaction(() => { b.skirmish(a, a.weapons[0], { targetId: drone.id }) })
    expect(drone.hp).toBeLessThan(drone.stats.hp) // the shot landed in the live battle
    const x = exportBattle(b)
    const resumed = replayBattle(JSON.parse(JSON.stringify(x)))
    expect(resumed.units.map(u => u.id)).toEqual(b.units.map(u => u.id))
    expect(resumed.units.find(u => u.kind === 'drone')!.hp).toBe(drone.hp)
  })

  // regression: a refund (checkpoint restore) inside a command detached currentCommand, so later player answers were not recorded
  it('a refund (checkpoint restore) inside a command keeps recording the player answers that follow', () => {
    const a = mech({ level: 6 }), e = mech({ level: 6 }, 'enemy')
    const b = arena([[a, { x: 5, y: 3 }], [e, { x: 5, y: 10 }]], { map: flatMap(12, 14), seed: 4 })
    b.chooser = () => undefined
    b.transaction(() => b.beginTurn(a)); b.transaction(() => b.endTurn(a))
    b.transaction(() => b.beginTurn(e))
    // inside one top-level command (as in an AI turn): an attack refused before rolling (skirmish refunds via
    // checkpoint) and then a player decision. AI turns do hit the refund path in normal autoBattles.
    const turn = () => b.command('aiTurn', [e], () => {
      b.skirmish(e, e.weapons[0], { targetId: 'nobody' })
      ask(b, a)
    })
    expect('pending' in b.transaction(turn)).toBe(true)
    b.transaction(turn, [1])
    const rec = b.commands[b.commands.length - 1]
    expect(rec.op).toBe('aiTurn')
    expect(rec.answers).toEqual([1]) // replays feed this back; without it they take the default (0)
  })
})
