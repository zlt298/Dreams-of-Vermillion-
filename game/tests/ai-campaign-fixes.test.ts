// Regression tests for bugs found by fuzzing the AI, sitreps and whole campaigns.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PilotBuild } from '../src/import/compcon'
import { importPilots } from '../src/import/compcon'
import { buildMechUnit } from '../src/rules/stats'
import { buildTeam } from '../src/enemies/build'
import { generateMap } from '../src/run/mapgen'
import { Battle } from '../src/rules/battle'
import { autoBattle, planFor } from '../src/ai/ai'
import { newRun, recordBattle, squadUnits, applyReward, availableNodes, minHp } from '../src/run/run'
import { EVENTS } from '../src/run/events'
import pregens from '../src/data/pregens/pregens.json'
import ll5 from '../src/data/squads/ll5.json'
import { battle, flatMap, pregenUnit } from './helpers'

const team = (id: string) => JSON.parse(readFileSync(join(__dirname, `../../data/enemies/${id}.json`), 'utf8'))
const squad = () => (pregens as any[]).slice(0, 4).map(p => importPilots(p)[0])

describe('previews cannot change whose turn it is or who won', () => {
  it('Cover Me! does not fire during an attack preview', () => {
    const p = {
      id: 'cover', callsign: 'Cover', name: 'C', level: 9, mechSkills: [2, 2, 2, 2], talents: [{ id: 't_bonded', rank: 3 }], coreBonuses: [],
      mech: { name: 'C', frameId: 'mf_standard_pattern_i_everest', mounts: [{ type: 'Main', slots: [{ size: 'Main', weaponId: 'mw_assault_rifle' }], bonusEffects: [] }], systems: [] },
      unknown: [],
    } as unknown as PilotBuild
    const guard = buildMechUnit(p); guard.pos = { x: 3, y: 5 }
    const mate = pregenUnit('Hacker'); mate.pos = { x: 5, y: 5 }
    const foe = pregenUnit('Assault', 'enemy'); foe.pos = { x: 6, y: 5 }
    foe.hp = 1; foe.structure = 1
    guard.flags.bondmate = mate.id
    const b = battle([guard, mate, foe])
    guard.activationsLeft = 0; mate.activationsLeft = 0
    b.currentSide = 'enemy'
    b.beginTurn(foe)
    for (const w of foe.weapons) { b.previewAttack(foe, w, mate); b.previewDetail(foe, w, mate) }
    expect(b.winner).toBeFalsy()
    expect(b.activeId).toBe(foe.id)
    expect(foe.destroyed).toBe(false)
    expect(guard.reactionsLeft).toBe(guard.reactionsPerRound)
  })

  it('a preview that destroys units or terrain leaves no trace (sandbox restores battle state and tiles)', () => {
    const a = pregenUnit('Assault'); a.pos = { x: 1, y: 5 }
    const e = pregenUnit('Sniper', 'enemy'); e.pos = { x: 6, y: 5 }
    const b = battle([a, e], flatMap(12, 12, (x, y) => (x === 3 && y === 3 ? { h: 1, kind: 'block' } : undefined)))
    b.beginTurn(a)
    const before = JSON.stringify(b.map.tiles)
    b.sandbox(() => {
      b.damageTerrain({ x: 3, y: 3 }, 50)
      b.raiseCover({ x: 4, y: 4 })
      b.destroy(e, 'test')
    })
    expect(JSON.stringify(b.map.tiles)).toBe(before)
    expect(b.winner).toBeFalsy()
    expect(b.activeId).toBe(a.id)
    expect(e.destroyed).toBe(false)
  })
})

describe('AI', () => {
  it('re-plans when its move fails instead of firing an attack aimed from elsewhere (no friendly fire)', () => {
    const map = generateMap(1007, { theme: 'industrial' })
    const players = (ll5 as any[]).map(p => buildMechUnit(importPilots(p)[0]))
    const enemies = buildTeam(team('t1-checkpoint-garrison'), players.length)
    players.forEach((u, k) => (u.pos = map.deployPlayer[k]))
    enemies.forEach((u, k) => (u.pos = map.deployEnemy[k % map.deployEnemy.length]))
    const b = new Battle({ map, units: [...players, ...enemies], seed: 1007 })
    b.start()
    const friendly: string[] = []
    ;(b as any).listeners.push((ev: any) => {
      if (ev.type !== 'attack') return
      const a = b.unit(ev.attackerId), t = b.unit(ev.targetId)
      if (a && t && a.side === t.side) friendly.push(`round ${b.round}: ${a.name} → ${t.name} (${ev.weapon})`)
    })
    autoBattle(b, 12)
    expect(friendly).toEqual([])
  })

  it('does not choose to end its turn in dangerous terrain when a safe tile is as good', () => {
    const a = pregenUnit('Assault'); a.pos = { x: 6, y: 6 }
    const e = buildTeam(team('t1-checkpoint-garrison'), 1)[0]; e.pos = { x: 6, y: 1 }
    const b = battle([a, e], flatMap(12, 12), 3)
    b.currentSide = 'enemy'; a.activationsLeft = 0
    b.beginTurn(e)
    const dest = planFor(b, e).dest
    const map = flatMap(12, 12, (x, y) => (x === dest.x && y === dest.y ? { kind: 'hazard' } : undefined))
    const a2 = pregenUnit('Assault'); a2.pos = { x: 6, y: 6 }
    const e2 = buildTeam(team('t1-checkpoint-garrison'), 1)[0]; e2.pos = { x: 6, y: 1 }
    const b2 = battle([a2, e2], map, 3)
    b2.currentSide = 'enemy'; a2.activationsLeft = 0
    b2.beginTurn(e2)
    expect(dest).not.toEqual({ x: 6, y: 1 }) // the scenario only means something if the AI wants to move
    expect(planFor(b2, e2).dest).not.toEqual(dest)
  })
})

describe('status clocks of destroyed units', () => {
  it('a status timed to another unit\'s turns ends even if that unit is destroyed off-turn', () => {
    const p = pregenUnit('Assault'); p.pos = { x: 1, y: 1 }
    const e = pregenUnit('Sniper', 'enemy'); e.pos = { x: 8, y: 8 }
    const e2 = pregenUnit('Hacker', 'enemy'); e2.pos = { x: 10, y: 10 }
    const b = battle([p, e, e2])
    b.addStatus(p, 'impaired', 'next_turn_end_source', e)
    b.destroy(e, 'test')
    for (let i = 0; i < 4 && !b.winner; i++) {
      for (const u of [p, e2]) { if (b.currentSide === u.side && !b.activeId && u.activationsLeft > 0) { b.beginTurn(u); b.endTurn(u) } }
    }
    expect(b.has(p, 'impaired')).toBe(false)
  })
  it('during another unit\'s turn, the orphaned status ends with that turn', () => {
    const p = pregenUnit('Assault'); p.pos = { x: 1, y: 1 }
    const e = pregenUnit('Sniper', 'enemy'); e.pos = { x: 8, y: 8 }
    const e2 = pregenUnit('Hacker', 'enemy'); e2.pos = { x: 10, y: 10 }
    const b = battle([p, e, e2])
    b.addStatus(p, 'slowed', 'next_turn_end_source', e)
    b.beginTurn(p)
    b.destroy(e, 'test')
    expect(b.has(p, 'slowed')).toBe(true)
    b.endTurn(p)
    expect(b.has(p, 'slowed')).toBe(false)
  })
})

describe('campaign: Bondmate and HP boons', () => {
  const bonded = () => {
    const run = newRun(squad(), 3)
    const [a, b] = run.squad
    run.condition[a.id].bondmate = b.id
    return { run, a, b }
  }
  it('Emergency Print keeps the Bondmate', () => {
    const { run, a, b } = bonded()
    run.condition[a.id].destroyed = true
    applyReward(run, 'reprint', a.id)
    expect(run.condition[a.id].bondmate).toBe(b.id)
  })
  it('Ram the Gate and Through the Fire keep the Bondmate', () => {
    for (const id of ['ram_gate', 'through_fire']) {
      const ev = EVENTS.find(e => e.id === id)!
      const { run, a, b } = bonded()
      run.condition[a.id].destroyed = id === 'ram_gate'
      ev.apply(run, id === 'through_fire' ? b.id : a.id)
      expect(run.condition[a.id].bondmate).toBe(b.id)
    }
  })
  it('a "never below 1 HP" event does not heal a boosted mech left on 1 HP', () => {
    const run = newRun(squad(), 3)
    const pid = run.squad[0].id
    run.boons.push({ reward: 'perm_hp2', pilotId: pid })
    const units = squadUnits(run)
    const u = units.find(x => x.flags.pilotId === pid)!
    u.hp = 1
    recordBattle(run, availableNodes(run)[0], units, true)
    expect(run.condition[pid].hp).toBe(minHp(run, pid))
    const shortcut = EVENTS.find(e => e.id === 'shortcut')!
    shortcut.apply(run)
    expect(squadUnits(run).find(x => x.flags.pilotId === pid)!.hp).toBe(1)
  })
})
