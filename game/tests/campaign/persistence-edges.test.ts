// Edge cases of battle persistence: replay import validation, replay decode failures, undo with nothing to undo,
// and the in-progress battle save (src/replay/replay.ts, src/run/battle-save.ts).
import { describe, expect, it } from 'vitest'
import { exportBattle, importBattle, replayBattle, stateHash, withoutLastAction, type BattleExport } from '../../src/replay/replay'
import { clearBattle, loadBattle, saveBattle } from '../../src/run/battle-save'
import { MemStorage, duel, useLocalStorage } from '../support'

const KEY = 'dov.battle.v1'

describe('importBattle', () => {
  const valid = () => { const { b } = duel(); return exportBattle(b) }
  const REJECT = 'Not a Dreams of Vermillion battle export'

  it('accepts its own export, as an object or as JSON', () => {
    const x = valid()
    expect(importBattle(x)).toBe(x)
    expect(importBattle(JSON.stringify(x))).toEqual(x)
  })

  it('rejects a foreign format, another version, a missing record or missing commands', () => {
    const x = valid()
    expect(() => importBattle({ ...x, format: 'something-else' })).toThrow(REJECT)
    expect(() => importBattle({ ...x, version: 2 })).toThrow(REJECT)
    expect(() => importBattle({ ...x, record: undefined })).toThrow(REJECT)
    expect(() => importBattle({ ...x, commands: {} })).toThrow(REJECT)
    expect(() => importBattle(null)).toThrow(REJECT)
    expect(() => importBattle('42')).toThrow(REJECT)
  })

  it('a string that is not JSON throws a parse error', () => {
    expect(() => importBattle('{nope')).toThrow(SyntaxError)
  })
})

describe('replay decode failures are reported and skipped', () => {
  function withCommands(extra: (aId: string) => BattleExport['commands']) {
    const { a, b } = duel()
    b.beginTurn(a)
    const x = exportBattle(b)
    x.commands = [...x.commands, ...extra(a.id), { op: 'move', args: [{ $u: a.id }, { x: 2, y: 5 }, { mode: 'standard' }], answers: [] }]
    return { a, x }
  }

  it('an unknown custom action ($a)', () => {
    const { a, x } = withCommands(id => [{ op: 'useCustom', args: [{ $u: id }, { $a: 'no-such-action' }, { x: 1, y: 1 }], answers: [] }])
    const errors: [number, string, string][] = []
    const r = replayBattle(x, { onError: (i, c, e) => errors.push([i, c.op, e.message]) })
    expect(errors).toEqual([[1, 'useCustom', 'action no-such-action is not available']])
    // the commands after it still run
    expect(r.unit(a.id)!.pos).toEqual({ x: 2, y: 5 })
  })

  it('a mine that does not exist ($m)', () => {
    const { a, x } = withCommands(id => [{ op: 'disarmMine', args: [{ $u: id }, { $m: 'm-missing' }], answers: [] }])
    const errors: [number, string][] = []
    // decode leaves a missing mine undefined (no message of its own, unlike $a): disarmMine then fails on it
    const r = replayBattle(x, { onError: (i, c) => errors.push([i, c.op]) })
    expect(errors).toEqual([[1, 'disarmMine']])
    expect(r.unit(a.id)!.actionsLeft).toBe(2) // the failed disarm spent nothing
    expect(r.unit(a.id)!.pos).toEqual({ x: 2, y: 5 })
  })
})

describe('withoutLastAction', () => {
  it('returns null when there is no player action to undo', () => {
    const { a, b } = duel()
    expect(withoutLastAction(exportBattle(b), b)).toBeNull() // no commands at all
    b.beginTurn(a)
    b.setPolicy(a, 'brace', 'off')
    expect(b.commands.map(c => c.op)).toEqual(['beginTurn', 'setPolicy'])
    expect(withoutLastAction(exportBattle(b), b)).toBeNull() // bookkeeping only
  })

  it('drops the last action and everything after it', () => {
    const { a, b } = duel()
    b.beginTurn(a)
    const before = stateHash(b)
    b.move(a, { x: 2, y: 5 })
    b.setPolicy(a, 'brace', 'off')
    const x = withoutLastAction(exportBattle(b), b)!
    expect(x.commands.map(c => c.op)).toEqual(['beginTurn'])
    expect(stateHash(replayBattle(x))).toBe(before)
  })
})

describe('the in-progress battle save', () => {
  const saved = () => { const { b } = duel(); return { runSeed: 1, nodeId: 'a1l0n0', title: 'Fight', data: exportBattle(b) } }

  it('round-trips through saveBattle/loadBattle, and clearBattle removes it', () => {
    const ls = useLocalStorage() as MemStorage
    const s = saved()
    saveBattle(s)
    expect(loadBattle()).toEqual(JSON.parse(JSON.stringify(s)))
    clearBattle()
    expect(ls.getItem(KEY)).toBeNull()
    expect(loadBattle()).toBeNull()
  })

  it('returns null with nothing saved, bad JSON, a missing nodeId, or a foreign battle record', () => {
    const ls = useLocalStorage() as MemStorage
    expect(loadBattle()).toBeNull()
    ls.setItem(KEY, '{not json')
    expect(loadBattle()).toBeNull()
    ls.setItem(KEY, 'null')
    expect(loadBattle()).toBeNull()
    const { nodeId: _, ...noNode } = saved()
    ls.setItem(KEY, JSON.stringify(noNode))
    expect(loadBattle()).toBeNull()
    ls.setItem(KEY, JSON.stringify({ ...saved(), nodeId: 7 }))
    expect(loadBattle()).toBeNull()
    ls.setItem(KEY, JSON.stringify({ ...saved(), data: { ...saved().data, format: 'other-game' } }))
    expect(loadBattle()).toBeNull()
    ls.setItem(KEY, JSON.stringify({ ...saved(), data: { format: 'dov-battle', version: 1 } }))
    expect(loadBattle()).toBeNull()
  })

  it('storage that throws (unavailable, full) is never fatal', () => {
    useLocalStorage({ getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('full') }, removeItem: () => { throw new Error('denied') } })
    expect(() => saveBattle(saved())).not.toThrow()
    expect(loadBattle()).toBeNull()
    expect(() => clearBattle()).not.toThrow()
  })
})
