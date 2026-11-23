// Regression tests for bugs fixed in the turn structure / action economy / damage / decision machinery
// (src/rules/battle/{turns,damage,decisions}.ts): turn hand-over on destruction, zone expiry, interjections, forced actions, Brace, PendingChoice, uid rollback.
import { describe, it, expect } from 'vitest'
import { flatMap, pregenUnit, battle } from './helpers'
import { uidState } from '../src/rules/stats'

const trio = () => {
  const a = pregenUnit('Assault'); const a2 = pregenUnit('Vanguard'); const e = pregenUnit('Sniper', 'enemy')
  a.pos = { x: 1, y: 5 }; a2.pos = { x: 1, y: 7 }; e.pos = { x: 9, y: 5 }
  const b = battle([a, a2, e], flatMap(14, 14))
  return { a, a2, e, b }
}

describe('found: turn order', () => {
  it('a character destroyed mid-turn as the last activation of the round: the other side opens the next round', () => {
    const { a, a2, e, b } = trio()
    b.beginTurn(a); b.endTurn(a)
    b.beginTurn(e); b.endTurn(e)
    b.beginTurn(a2)
    // killed during its own turn (an Overwatch shot, a mine, its own heat...)
    while (!a2.destroyed) b.applyDamage(a2, [{ type: 'Energy', amount: 999 }], {})
    expect(b.round).toBe(2)
    // a player took the last turn of round 1, so the enemy should open round 2 (as after a normal endTurn)
    expect(b.currentSide).toBe('enemy')
  })

  it('a zone lasting until the end of a character\'s next turn (Smoke Mine) expires even if that character is destroyed', () => {
    const { a, e, b } = trio()
    const e2 = pregenUnit('Assault', 'enemy'); e2.pos = { x: 9, y: 9 }; b.units.push(e2); e2.activationsLeft = 1
    b.addArea({ kind: 'soft_cover', tiles: [{ x: 5, y: 5 }], ownerId: a.id, expiresAfterTurnOf: e2.id, turnsLeft: 1 })
    b.destroy(e2, 'test')
    for (let i = 0; i < 8 && b.round < 4; i++) {
      const u = b.combatants(b.currentSide).find(x => x.activationsLeft > 0)!
      b.beginTurn(u); b.endTurn(u)
    }
    expect(b.round).toBeGreaterThanOrEqual(3)
    expect(b.areas.filter(x => x.expiresAfterTurnOf === e2.id)).toHaveLength(0)
  })
})

describe('found: interjections (Goblin Symbiosis)', () => {
  it('the interjecting character being destroyed hands control back to its host', () => {
    const { a, a2, b } = trio()
    b.beginTurn(a)
    b.interject(a2, a)
    b.destroy(a2, 'test')
    expect(b.interjection).toBeNull()
    expect(b.activeId).toBe(a.id)
  })

  it('the host being destroyed during an interjection does not deadlock the turn order', () => {
    const { a, a2, e, b } = trio()
    a2.activationsLeft = 0 // a Goblin in Symbiosis only acts on its host's turn
    b.beginTurn(a)
    b.interject(a2, a)
    b.destroy(a, 'test')
    b.endTurn(a2)
    expect(b.activeId).toBeNull()
    // nobody on the player side can act any more: the enemy must be able to take its turn
    expect(b.canActivate(e)).toBe(true)
  })
})

describe('found: action economy', () => {
  it('withForcedAction lets a character that is not acting take the forced action (Slave Systems)', () => {
    const { a, e, b } = trio()
    e.pos = { x: 2, y: 5 }
    b.beginTurn(a)
    // Slave Systems makes the (hostile, not active) target Improvised Attack / Grapple / Ram on the hacker's turn
    let err = ''
    try { b.withForcedAction(e, () => b.improvisedAttack(e, a)) } catch (x) { err = (x as Error).message }
    expect(err).toBe('')
  })

  it('after Bracing, the next turn allows no free actions or protocols (core book: Brace)', () => {
    const { a, b } = trio()
    b.addStatus(a, 'bracing_recovery', 'next_turn_end_target')
    b.beginTurn(a)
    expect(b.canSpend(a, 'quick')).toBe(true)
    expect(b.canSpend(a, 'free')).not.toBe(true)
    expect(b.canSpend(a, 'protocol')).not.toBe(true)
  })
})

describe('found: decision replay machinery', () => {
  it('a PendingChoice raised during a move steered by First Gate (OSIRIS) is not swallowed', () => {
    const a = pregenUnit('Assault'); const v = pregenUnit('Vanguard'); const e = pregenUnit('Sniper', 'enemy')
    a.systems.push({ uid: 'sosiris', dataId: 'ms_osiris_class_nhp', name: 'OSIRIS', destroyed: false, charged: true } as any)
    a.pos = { x: 1, y: 1 }; v.pos = { x: 6, y: 6 }; e.pos = { x: 7, y: 6 }
    v.policies.overwatch = 'ask'
    const b = battle([a, v, e], flatMap(14, 14))
    b.beginTurn(a); b.endTurn(a)
    e.flags.duatSteer = a.id
    const asked: string[] = []
    b.chooser = q => { asked.push(q.kind); return undefined }
    const r1: any = b.transaction(() => b.beginTurn(e))
    expect(r1.pending?.kind).toBe('duat_steer')
    // 'Toward me': the steered move starts inside the Vanguard's threat, so the player is asked about Overwatch
    const r2: any = b.transaction(() => b.beginTurn(e), [0])
    expect(asked).toContain('overwatch')
    // the question must suspend the command (and be replayed with its answer), not be silently dropped mid-move
    expect(r2.pending?.kind).toBe('overwatch')
  })

  it('rolling a command back for a decision also rolls back the id counter, so ids match an uninterrupted run (and replays)', () => {
    const { a, b } = trio()
    b.beginTurn(a)
    const u0 = uidState()
    const cmd = () => {
      const m = b.placeMine(a, { x: 2, y: 5 }, { name: 'Test Mine', radius: 1, damage: [] }, { noCheck: true })
      b.choose({ kind: 'test', unit: a, title: 'Pick', options: [{ label: 'A' }, { label: 'B' }], defaultIndex: 0 })
      return m
    }
    b.chooser = () => undefined
    const r1 = b.transaction(() => { cmd() })
    expect('pending' in r1).toBe(true)
    b.transaction(() => { cmd() }, [1])
    // one mine was planted; an uninterrupted run (and replayBattle, which runs each command once) names it mine<u0+1>
    expect(b.mines.map(m => m.id)).toEqual([`mine${u0 + 1}`])
  })
})
