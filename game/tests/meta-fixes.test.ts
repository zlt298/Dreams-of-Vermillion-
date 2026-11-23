// Regression tests for bugs around the battles: the campaign flow (act-boss debrief vs. level-up),
// refits and re-imports, events, malformed COMP/CON and LCP imports, and footprint-aware deployment.
import { describe, expect, it } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { importPilots, ImportError } from '../src/import/compcon'
import { readLcp } from '../src/import/lcp'
import pregens from '../src/data/pregens/pregens.json'
import themed from '../src/data/squads/themed.json'
import {
  newRun, recordBattle, squadUnits, applyReward, refitPilot, replacePilots, levelUp, rollRewards, freshCondition, repairOptions, availableNodes, type RunState,
} from '../src/run/run'
import { EVENTS } from '../src/run/events'
import { mechSP, buildMechUnit } from '../src/rules/stats'
import { validateBuild } from '../src/rules/legality'
import { validTeams } from '../src/enemies/catalog'
import { buildTeam } from '../src/enemies/build'
import { generateMap, placeUnits, themeForAct } from '../src/run/mapgen'
import { footprint, tileAt } from '../src/rules/grid'
import type { Unit } from '../src/rules/types'
import './helpers'

const squad = () => (pregens as any[]).slice(0, 4).map(p => importPilots(p)[0])
const bossOf = (run: RunState, act: number) => run.nodes.find(n => n.act === act && n.kind === 'boss')!

describe('campaign: the act-boss debrief survives the level-up', () => {
  // app.ts: boss win -> recordBattle (fullRepair) -> debrief() rewardPick -> repairs() -> maybeEvent() -> runMap()
  // -> levelUpScreen() -> levelUp(), which resets every condition (run.ts levelUp -> resetCondition).
  it('a Field Repair Kit taken as the act 1 boss reward survives the level-up', () => {
    const run = newRun(squad(), 3)
    const boss = bossOf(run, 1)
    recordBattle(run, boss, squadUnits(run), true)
    expect(rollRewards(boss.seed + 1, run).length).toBeGreaterThan(0)
    const pid = run.squad[0].id
    applyReward(run, 'repairs', pid) // "+2 Repairs for one mech (can exceed its Repair Cap)"
    const withKit = run.condition[pid].repairs
    levelUp(run) // what levelUpScreen does next
    expect(run.condition[pid].repairs).toBe(withKit) // was: back to the fresh Repair Cap (kit wasted)
  })

  it("a boss-node pact's cost survives the level-up along with its permanent boon", () => {
    const run = newRun(squad(), 3)
    const boss = bossOf(run, 1)
    recordBattle(run, boss, squadUnits(run), true)
    const pid = run.squad[1].id // Assault has systems
    const ev = EVENTS.find(e => e.id === 'targeting_core')!
    expect(ev.eligible!(run, pid)).toBe(true)
    ev.apply(run, pid)
    expect(run.condition[pid].destroyedSystems.length).toBe(1)
    levelUp(run)
    expect(run.boons.some(b => b.reward === 'perm_acc' && b.pilotId === pid)).toBe(true)
    expect(run.condition[pid].destroyedSystems.length).toBe(1) // was: 0, the +1 accuracy was free
  })
})

describe('campaign: refitPilot with an unchanged build keeps the condition', () => {
  it('Repairs above the Repair Cap (Field Repair Kit / events) survive a no-op refit', () => {
    const run = newRun(squad(), 3)
    const pid = run.squad[0].id
    applyReward(run, 'repairs', pid)
    const before = run.condition[pid].repairs
    refitPilot(run, structuredClone(run.squad[0]))
    expect(run.condition[pid].repairs).toBe(before) // was: before - 2
  })

  it('a locked Prototype Weapon set-up (kept "until the next Full Repair") survives a refit', () => {
    const run = newRun(squad(), 3)
    const pid = run.squad[0].id
    run.condition[pid].proto = { some_weapon: { type: 'Rifle', damage: 'Energy' } }
    refitPilot(run, structuredClone(run.squad[0]))
    expect(run.condition[pid].proto).toEqual({ some_weapon: { type: 'Rifle', damage: 'Energy' } }) // was: undefined
  })
})

describe('campaign: refits and re-imports keep the condition', () => {
  it('a re-import is not a free full repair (damage and a destroyed mech carry over)', () => {
    const run = newRun(squad(), 3)
    const [a, b] = run.squad
    run.condition[a.id].hp = 3
    run.condition[b.id].destroyed = true
    replacePilots(run, [structuredClone(a), structuredClone(b)])
    expect(run.condition[a.id].hp).toBe(3)
    expect(run.condition[b.id].destroyed).toBe(true)
  })
  it('a refit keeps destroyed marks for gear that left the build (no repair offered, no free repair on refitting it) and clamps Limited uses', () => {
    const run = newRun(squad(), 3)
    const p = run.squad[0]
    const c = run.condition[p.id]
    const u = squadUnits(run).find(x => x.flags.pilotId === p.id)!
    const lim = [...u.weapons, ...u.systems].find(x => x.usesLeft != null && x.dataId)!
    c.destroyedWeapons = ['not_in_build']
    c.destroyedSystems = ['also_not_in_build']
    c.limited[lim.dataId!] = 99
    refitPilot(run, structuredClone(p))
    expect(run.condition[p.id].destroyedWeapons).toEqual(['not_in_build'])
    expect(run.condition[p.id].destroyedSystems).toEqual(['also_not_in_build'])
    expect(repairOptions(run.squad[0], run.condition[p.id]).some(o => /not_in_build/.test(o.id))).toBe(false)
    expect(run.condition[p.id].limited[lim.dataId!]).toBe(lim.usesLeft)
  })
  it('taking a destroyed system off and fitting it back does not repair it (refit, battle, refit)', () => {
    const run = newRun(squad(), 3)
    const p = run.squad.find(x => x.mech.systems.length)!
    const sys = p.mech.systems[0]
    run.condition[p.id].destroyedSystems = [sys]
    const without = structuredClone(p); without.mech.systems = without.mech.systems.slice(1)
    refitPilot(run, without)
    recordBattle(run, availableNodes(run)[0], squadUnits(run), true)
    refitPilot(run, structuredClone(p))
    expect(squadUnits(run).find(x => x.flags.pilotId === p.id)!.systems.find(s => s.dataId === sys)!.destroyed).toBe(true)
  })
  it('Repairs spent after the boss stay spent through the level-up', () => {
    const run = newRun(squad(), 3)
    recordBattle(run, bossOf(run, 1), squadUnits(run), true)
    const pid = run.squad[0].id
    run.condition[pid].repairs -= 1
    const left = run.condition[pid].repairs
    levelUp(run)
    expect(run.condition[pid].repairs).toBe(left)
    expect(run.condition[pid].hp).toBe(buildMechUnit(run.squad[0]).stats.hp)
  })
})

describe('events', () => {
  it('Hot-Loaded Rounds is not offered when every Limited item is empty and no Repairs are left', () => {
    const run = newRun(squad(), 3)
    const ev = EVENTS.find(e => e.id === 'hot_loaded')!
    const p = run.squad[0]
    const c = run.condition[p.id]
    c.repairs = 0
    const u = squadUnits(run).find(x => x.flags.pilotId === p.id)!
    const lim = [...u.weapons, ...u.systems].filter(x => x.usesLeft != null && x.dataId)
    expect(lim.length).toBeGreaterThan(0)
    for (const x of lim) c.limited[x.dataId!] = 0
    expect(ev.eligible!(run, p.id)).toBe('Nothing to give up') // was: true
  })
})

describe('COMP/CON import: malformed files', () => {
  const cases: [string, unknown][] = [
    ['null mech', { mechs: [null] }],
    ['null mount', { mechs: [{ frame: 'mf_standard_pattern_i_everest', loadouts: [{ mounts: [null] }] }] }],
    ['null slot', { mechs: [{ frame: 'mf_standard_pattern_i_everest', loadouts: [{ mounts: [{ mount_type: 'Main', slots: [null] }] }] }] }],
    ['null talent', { talents: [null], mechs: [{ frame: 'mf_standard_pattern_i_everest' }] }],
    ['mounts object', { mechs: [{ frame: 'mf_standard_pattern_i_everest', loadouts: [{ mounts: {} }] }] }],
    ['systems number', { mechs: [{ frame: 'mf_standard_pattern_i_everest', loadouts: [{ systems: 5 }] }] }],
    ['talents object', { talents: {}, mechs: [{ frame: 'mf_standard_pattern_i_everest' }] }],
    ['core_bonuses string', { core_bonuses: 'abc', mechs: [{ frame: 'mf_standard_pattern_i_everest' }] }],
    ['pregen null mount', { name: 'X', build: { mech: { mounts: [null] } } }],
  ]
  it.each(cases)('%s: throws ImportError, not a raw TypeError', (_n, json) => {
    let err: unknown
    try { importPilots(json) } catch (e) { err = e }
    if (err) expect(err).toBeInstanceOf(ImportError) // was: TypeError
  })

  it('a pregen-shaped file without mechSkills defaults them, so mechSP/validateBuild (the hangar card) work', () => {
    const [p] = importPilots({ name: 'X', build: { mech: {} } }) // accepted: no ImportError
    expect(() => mechSP(p)).not.toThrow() // was: TypeError reading '2' of undefined (pilotCard calls mechSP outside its try)
    expect(() => validateBuild(p)).not.toThrow()
  })

  it('a string level is coerced to a number (not "2" + "5" = 25 mech skill points)', () => {
    const [p] = importPilots({ level: '5', mechs: [{ frame: 'mf_standard_pattern_i_everest' }] })
    expect(validateBuild(p).budgets.hase.max).toBe(7) // was: "25" (2 + "5")
  })
})

describe('LCP import: malformed packs', () => {
  const z = (files: Record<string, unknown>) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(JSON.stringify(v))])))
  const cls = { id: 'c', name: 'Cls', role: 'striker', stats: { hp: [10, 12, 14] } }
  const cases: [string, Record<string, unknown>][] = [
    ['v1 features object', { 'npc_classes.json': [cls], 'npc_features.json': {} }],
    ['v1 null class', { 'npc_classes.json': [null, cls] }],
    ['v2 null feature', { 'npcc_a.json': [cls, null] }],
    ['numeric class name', { 'npcc_a.json': [{ ...cls, name: 5 }], 'npcc_b.json': [cls] }],
    ['tags object', { 'npcc_a.json': [cls, { id: 'f', name: 'F', type: 'Weapon', tags: {} }] }],
    ['bonuses object', { 'npcc_a.json': [cls, { id: 'f', name: 'F', type: 'Trait', bonuses: {} }] }],
  ]
  it.each(cases)('%s: no raw TypeError', (_n, files) => {
    expect(() => readLcp(z(files))).not.toThrow(TypeError)
  })
})

describe('deployment (app.ts startBattle / skirmish: placeUnits)', () => {
  const offOrOverlap = (map: ReturnType<typeof generateMap>, units: Unit[]) => {
    const bad: string[] = []
    const occ = new Map<string, string>()
    for (const u of units) for (const p of footprint(u)) {
      const k = `${p.x},${p.y}`
      if (!tileAt(map, p)) bad.push(`${u.name} off map at ${k}`)
      else if (occ.has(k)) bad.push(`${u.name} overlaps ${occ.get(k)} at ${k}`)
      occ.set(k, u.name)
    }
    return bad
  }
  it('the themed Brawlers LL5 squad: the size-3 Barbarossa deploys fully on the map, clear of the Tortuga', () => {
    const s = (themed as any[]).find(x => x.id === 'brawlers-ll5')
    const map = generateMap(1, { theme: themeForAct(2) })
    const units = s.pilots.map((p: any) => buildMechUnit(p)) as Unit[]
    units.forEach((u, i) => (u.pos = map.deployPlayer[i])) // the old placement was broken
    expect(offOrOverlap(map, units)).not.toEqual([])
    placeUnits(map, units, map.deployPlayer)
    expect(offOrOverlap(map, units)).toEqual([])
  })
  it('the act 1 boss team at 4 pilots: the size-2 Choir Bulwark does not overlap other enemies', () => {
    const t = validTeams().find(x => x.id === 't1-boss-red-warden')!
    const map = generateMap(123, { theme: themeForAct(1) })
    const enemies = buildTeam(t, 4)
    enemies.forEach((u, i) => (u.pos = map.deployEnemy[i % map.deployEnemy.length])) // the old placement was broken
    expect(offOrOverlap(map, enemies)).not.toEqual([])
    placeUnits(map, enemies, map.deployEnemy)
    expect(offOrOverlap(map, enemies)).toEqual([])
    for (const u of enemies) expect(u.pos.y).toBeLessThanOrEqual(2) // still in the enemy deployment rows
  })
})
