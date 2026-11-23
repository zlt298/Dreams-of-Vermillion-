// Former partial scripts, batch 2a: frames, cores, weapons, mods and core bonuses.
import { describe, expect, it } from 'vitest'
import type { PilotBuild } from '../src/import/compcon'
import { buildMechUnit } from '../src/rules/stats'
import { Battle } from '../src/rules/battle'
import { autoBattle, aiErrors } from '../src/ai/ai'
import { getScript } from '../src/rules/effects/registry'
import type { Unit } from '../src/rules/types'
import { flatMap, pregenUnit } from './helpers'

type Slot = { size: string; weaponId: string; modId?: string }
function mech(o: { frame?: string; slots?: Slot[]; systems?: string[]; cbs?: string[]; side?: 'player' | 'enemy'; name?: string } = {}): Unit {
  const p = {
    id: `t-${Math.random()}`, callsign: o.name ?? 'Tester', name: 'T', level: 6, mechSkills: [2, 2, 2, 2], talents: [], coreBonuses: o.cbs ?? [],
    mech: { name: 'T', frameId: o.frame ?? 'mf_standard_pattern_i_everest', mounts: (o.slots ?? [{ size: 'Main', weaponId: 'mw_assault_rifle' }]).map(s => ({ type: s.size, slots: [s], bonusEffects: [] })), systems: o.systems ?? [] },
    unknown: [],
  } as unknown as PilotBuild
  return buildMechUnit(p, o.side ?? 'player')
}
function setup(a: Unit, opts: { map?: ReturnType<typeof flatMap>; seed?: number } = {}) {
  const e = pregenUnit('Assault', 'enemy')
  a.pos = { x: 5, y: 4 }
  e.pos = { x: 5, y: 8 }
  e.stats.evasion = 1; e.stats.edef = 1
  const b = new Battle({ map: opts.map ?? flatMap(16, 16), units: [a, e], seed: opts.seed ?? 13 })
  b.start()
  b.beginTurn(a)
  return { a, e, b }
}
const act = (b: Battle, u: Unit, re: RegExp) => {
  const x = b.customActions(u).find(c => re.test(c.name) || re.test(c.key))
  if (!x) throw new Error(`no action ${re}: ${b.customActions(u).map(c => c.name).join(', ')}`)
  return x
}
const W = (u: Unit, id: string) => u.weapons.find(w => w.dataId === id)!
const nextRound = (b: Battle, a: Unit, e: Unit) => { if (b.activeId) b.endTurn(b.active!); if (!e.destroyed && e.activationsLeft > 0) { b.beginTurn(e); b.endTurn(e) } }

describe('2a: no longer partial', () => {
  it('these scripts are complete (only Goblin INSTINCT Rig keeps a documented deviation)', () => {
    for (const id of ['frame:mf_goblin', 'frame:mf_napoleon', 'core:mf_drake', 'core:mf_mourning_cloak', 'mw_combat_drill', 'mw_pinaka_missiles', 'mw_ghast_nexus', 'mw_annihilation_nexus', 'mw_plasma_thrower', 'wm_shock_wreath', 'cb_overpower_caliber', 'cb_briareos_frame', 'cb_ghostweave', 'cb_the_lesson_of_the_open_door'])
      expect(getScript(id)?.partial, id).toBeFalsy()
  })
})

describe('frames and cores', () => {
  it('Drake Fortress: two indestructible cover sections; adjacent allies are immune to forced movement and Prone', () => {
    const a = mech({ frame: 'mf_drake' })
    const { b } = setup(a)
    const ally = mech({ name: 'Ally' }); ally.pos = { x: 4, y: 3 }; b.units.push(ally)
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
    b.useCustom(a, act(b, a, /Deactivate Fortress/))
    expect(b.has(a, 'immobilized')).toBe(false)
  })
  it('Drake Fortress: a full action is allowed after Bracing', () => {
    const a = mech({ frame: 'mf_drake' })
    const { b } = setup(a)
    a.flags.fortress = true
    b.addStatus(a, 'bracing_recovery', 'next_turn_end_target')
    a.actionsLeft = 1
    expect(b.canSpend(a, 'full')).toBe(true)
  })
  it('Mourning Cloak: after the core, moves teleport over walls and ignore engagement', () => {
    const map = flatMap(16, 16, (x, y) => (y === 5 && x >= 2 && x <= 8 ? { h: 4, kind: 'block' } : undefined))
    const a = mech({ frame: 'mf_mourning_cloak' })
    const { b } = setup(a, { map })
    a.coreAvailable = true
    b.activateCore(a)
    expect(a.flags.teleportMoves).toBe(true)
    expect(b.move(a, { x: 5, y: 7 })).toBe(true)
    expect(a.pos).toEqual({ x: 5, y: 7 })
  })
  it('Mourning Cloak: lost in blinkspace is not a destroyed mech for the run', () => {
    const a = mech({ frame: 'mf_mourning_cloak' })
    const { b } = setup(a)
    // find a seed where the three dice match
    const blink = act(b, a, /Blinkspace/)
    let found = false
    for (let s = 0; s < 4000 && !found; s++) {
      b.rng.state = s
      const r = [b.rng.d(6), b.rng.d(6), b.rng.d(6)]
      if (r[0] === r[1] && r[1] === r[2]) { b.rng.state = s; found = true }
    }
    expect(found).toBe(true)
    blink.run(b, a, { x: 6, y: 4 })
    expect(a.destroyed).toBe(true)
    expect(a.flags.vanished).toBeTruthy()
    expect(a.flags.wreck).toBeFalsy()
  })
  it('Goblin Reactive Code: when hit by a tech attack, take a Quick Tech option against the attacker', () => {
    const a = mech({ frame: 'mf_goblin' })
    const { e, b } = setup(a)
    b.endTurn(a); b.beginTurn(e)
    e.stats.techAttack = 30
    b.invade(e, a)
    expect(b.has(e, 'impaired') && b.has(e, 'slowed')).toBe(true) // default: Fragment Signal back
    expect(a.reactionsLeft).toBe(0)
  })
  it('Goblin INSTINCT Rig: the Goblin shares its host\'s conditions and heat, and acts on its host\'s activation', () => {
    const g = mech({ frame: 'mf_goblin', name: 'Gob' })
    const { e, b } = setup(g)
    const host = mech({ frame: 'mf_standard_pattern_i_everest', name: 'Host' })
    host.stats.size = 2; host.pos = { x: 6, y: 3 }
    b.units.push(host)
    g.coreAvailable = true
    b.useCustom(g, act(b, g, /Symbiosis/), host)
    expect(g.flags.host).toBe(host.id)
    b.addStatus(host, 'impaired', 'next_turn_end_target', e)
    expect(b.has(g, 'impaired')).toBe(true)
    b.addHeat(host, 3)
    expect(g.heat).toBeGreaterThanOrEqual(3)
    // next round: no own turn; acts right after the host
    b.endTurn(g)
    b.beginTurn(e); b.endTurn(e)
    if (host.activationsLeft) { b.beginTurn(host); b.endTurn(host) }
    if (b.round === 1) { /* finish round 1 */ }
    while (b.round === 1) { const u = b.combatants(b.currentSide).find(x => x.activationsLeft > 0); if (!u) break; b.beginTurn(u); b.endTurn(u) }
    expect(b.round).toBe(2)
    expect(g.activationsLeft).toBe(0)
    if (b.currentSide !== 'player') { b.beginTurn(e); b.endTurn(e) }
    b.beginTurn(host)
    b.endTurn(host)
    expect(b.chainTurn).toBe(g.id)
    expect(b.canActivate(g)).toBe(true)
    b.beginTurn(g)
    expect(g.moveLeft).toBe(0)
    expect(() => b.overcharge(g)).toThrow()
  })
  it('Napoleon Heavy Shielding: half damage on a successful save becomes 1', () => {
    const a = mech({ frame: 'mf_napoleon' })
    const { b } = setup(a)
    expect(b.halfOnSave(a, 9)).toBe(1)
  })
})

describe('weapons, mods and core bonuses', () => {
  it('Combat Drill: Overkill chains add bonus damage against Prone targets', () => {
    const a = mech({ slots: [{ size: 'Main', weaponId: 'mw_combat_drill' }] })
    const { e, b } = setup(a)
    e.pos = { x: 5, y: 5 }
    b.addStatus(e, 'prone')
    a.stats.attackBonus = 30
    let saw = false
    for (let i = 0; i < 30 && !saw; i++) {
      e.hp = 999; e.stats.hp = 999
      b.weaponAttack(a, W(a, 'mw_combat_drill'), { targetId: e.id }, 'free')
      saw = b.log.some(l => /Overkill drill/.test(l.text))
    }
    expect(saw).toBe(true)
  })
  it('Pinaka: a second, non-overlapping blast; Delayed Strike lands at the end of the next round for 3d6', () => {
    const a = mech({ slots: [{ size: 'Main', weaponId: 'mw_pinaka_missiles' }] })
    const { e, b } = setup(a)
    const e2 = pregenUnit('Sniper', 'enemy'); e2.pos = { x: 10, y: 10 }; e2.stats.evasion = 1; b.units.push(e2)
    a.stats.attackBonus = 30
    const hp2 = e2.hp
    b.weaponAttack(a, W(a, 'mw_pinaka_missiles'), { tile: e.pos }, 'free')
    expect(e2.hp).toBeLessThan(hp2)
    // delayed
    nextRound(b, a, e)
    while (b.round < 2) { const u = b.combatants(b.currentSide).find(x => x.activationsLeft > 0); if (!u) break; b.beginTurn(u); b.endTurn(u) }
    if (b.currentSide !== 'player') { const u = b.combatants('enemy').find(x => x.activationsLeft > 0)!; b.beginTurn(u); b.endTurn(u) }
    b.beginTurn(a)
    b.useCustom(a, act(b, a, /Delayed Strike/), e.pos)
    expect(b.has(a, 'slowed')).toBe(true)
    expect(a.flags.pinakaDelayed.lands).toBe(b.round + 2)
    expect(b.fieldOverlays().some(f => /Pinaka strike/.test(f.label))).toBe(true)
  })
  it('Ghast Nexus: deploy as a drone; attacks trace range and line of sight from it; losing the drone loses the weapon', () => {
    const map = flatMap(16, 16, (x, y) => (y === 6 && x >= 3 && x <= 7 ? { h: 4, kind: 'block' } : undefined))
    const a = mech({ slots: [{ size: 'Main', weaponId: 'mw_ghast_nexus' }] })
    const { e, b } = setup(a, { map })
    const w = W(a, 'mw_ghast_nexus')
    expect(b.validTarget(a, w, e)).toMatch(/line of sight/i)
    b.useCustom(a, act(b, a, /Deploy Ghast/), { x: 9, y: 6 })
    const d = b.alive().find(u => u.name === 'Ghast Drone')!
    expect(d).toBeTruthy()
    const r = b.weaponAttack(a, w, { targetId: e.id }, 'free')
    expect(r.ok).toBe(true)
    b.applyDamage(d, [{ type: 'Kinetic', amount: 50 }], { source: e })
    expect(w.destroyed).toBe(true)
  })
  it('Annihilation Nexus: the burst can be centred on one of your drones', () => {
    const a = mech({ slots: [{ size: 'Main', weaponId: 'mw_annihilation_nexus' }, { size: 'Main', weaponId: 'mw_ghast_nexus' }] })
    const { e, b } = setup(a)
    b.useCustom(a, act(b, a, /Deploy Ghast/), { x: 5, y: 7 })
    b.chooser = () => undefined
    const hp = e.hp
    a.stats.attackBonus = 30
    b.transaction(() => { b.weaponAttack(a, W(a, 'mw_annihilation_nexus'), { tile: a.pos }, 'free') }, [1])
    expect(e.hp).toBeLessThan(hp)
  })
  it('Plasma Thrower: Cone or Line toggle; 3 burning spaces that hurt on entry once per round', () => {
    const a = mech({ slots: [{ size: 'Heavy', weaponId: 'mw_plasma_thrower' }] })
    const { e, b } = setup(a)
    const w = W(a, 'mw_plasma_thrower')
    const cone = b.aoeTiles(a, w, { x: 5, y: 9 }) as any[]
    ;(w.flags ??= {}).shape = 'line'
    const line = b.aoeTiles(a, w, { x: 5, y: 9 }) as any[]
    expect(line.length).not.toBe(cone.length)
    a.stats.attackBonus = 30
    b.weaponAttack(a, w, { tile: { x: 5, y: 9 } }, 'free')
    const fire = b.areas.find(x => x.tag === 'plasma')!
    expect(fire.tiles).toHaveLength(3)
  })
  it('Shock Wreath: spend a quick action on a hit for 1d6 burn; an already-burning target is blinded', () => {
    const a = mech({ slots: [{ size: 'Main', weaponId: 'mw_assault_rifle', modId: 'wm_shock_wreath' }] })
    const { e, b } = setup(a)
    a.stats.attackBonus = 30
    e.burn = 2
    b.skirmish(a, W(a, 'mw_assault_rifle'), { targetId: e.id })
    expect(a.actionsLeft).toBe(0)
    expect(e.flags.blindUntil).toBeTruthy()
  })
  it('Overpower Caliber: the chosen weapon adds +1d6 once per round', () => {
    const a = mech({ cbs: ['cb_overpower_caliber'] })
    const { e, b } = setup(a)
    a.stats.attackBonus = 30
    b.weaponAttack(a, W(a, 'mw_assault_rifle'), { targetId: e.id }, 'free')
    expect(a.flags.overpowerUid).toBe(W(a, 'mw_assault_rifle').uid)
    expect(b.log.some(l => /Overpower/.test(l.text)) || a.flags['round:overpower']).toBeTruthy()
  })
  it('Briareos Frame: at 0 HP and 0 Structure the mech survives and makes structure checks', () => {
    const a = mech({ cbs: ['cb_briareos_frame'] })
    const { b } = setup(a)
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
  it('Ghostweave: invisible on your turn; stays invisible after only moving; a reaction ends it', () => {
    const a = mech({ cbs: ['cb_ghostweave'] })
    const { e, b } = setup(a)
    expect(b.has(a, 'invisible')).toBe(true)
    b.move(a, { x: 6, y: 4 })
    b.endTurn(a)
    expect(b.has(a, 'invisible')).toBe(true)
    b.beginTurn(e)
    a.reactionsLeft--
    b.weaponAttack(e, e.weapons[0], { targetId: a.id }, 'free')
    expect(b.has(a, 'invisible')).toBe(false)
  })
  it('Ghostweave: attacking on your turn ends the invisibility at the end of it', () => {
    const a = mech({ cbs: ['cb_ghostweave'] })
    const { e, b } = setup(a)
    b.skirmish(a, W(a, 'mw_assault_rifle'), { targetId: e.id })
    b.endTurn(a)
    expect(b.has(a, 'invisible')).toBe(false)
  })
  it('The Lesson of the Open Door: a failed save against you deals 2 heat, once per round', () => {
    const a = mech({ cbs: ['cb_the_lesson_of_the_open_door'] })
    const { e, b } = setup(a)
    e.stats.hull = -30
    const h = e.heat
    b.save(e, 'hull', a.stats.save, 0, a)
    b.save(e, 'hull', a.stats.save, 0, a)
    expect(e.heat).toBe(h + 2)
  })
  it('AI battles with these items run cleanly', () => {
    const a = mech({ frame: 'mf_drake', slots: [{ size: 'Main', weaponId: 'mw_pinaka_missiles' }, { size: 'Heavy', weaponId: 'mw_plasma_thrower' }], cbs: ['cb_briareos_frame', 'cb_overpower_caliber'] })
    const c = mech({ frame: 'mf_goblin', slots: [{ size: 'Main', weaponId: 'mw_ghast_nexus' }, { size: 'Main', weaponId: 'mw_annihilation_nexus', modId: 'wm_shock_wreath' }], cbs: ['cb_ghostweave', 'cb_the_lesson_of_the_open_door'] })
    const m = mech({ frame: 'mf_mourning_cloak', slots: [{ size: 'Main', weaponId: 'mw_combat_drill' }] })
    const e1 = pregenUnit('Assault', 'enemy'), e2 = pregenUnit('Sniper', 'enemy'), e3 = pregenUnit('Hacker', 'enemy')
    a.pos = { x: 3, y: 2 }; c.pos = { x: 7, y: 2 }; m.pos = { x: 10, y: 2 }; e1.pos = { x: 3, y: 12 }; e2.pos = { x: 7, y: 13 }; e3.pos = { x: 10, y: 12 }
    for (const u of [a, c, m]) u.coreAvailable = true
    const b = new Battle({ map: flatMap(14, 16), units: [a, c, m, e1, e2, e3], seed: 9 })
    b.start()
    aiErrors.length = 0
    autoBattle(b, 8)
    expect(aiErrors).toHaveLength(0)
  })
})
