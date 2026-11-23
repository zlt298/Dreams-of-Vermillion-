// Regression tests: Line templates, AI friendly fire with Jackhammer Round, and Ordnance (found in the final bug hunt).
import { describe, expect, it } from 'vitest'
import { lineTiles } from '../src/rules/grid'
import { battle, flatMap, pregenUnit } from './helpers'

describe('Line weapons fall short of their stated range off the grid axes', () => {
  it('a Line 20 drawn toward a tile 20 spaces away reaches it (it stops several spaces short on a diagonal bearing)', () => {
    const map = flatMap(18, 36)
    const u = pregenUnit('Vanguard')
    u.pos = { x: 2, y: 26 }
    const target = { x: 12, y: 6 } // max(|dx|, |dy|) = 20 spaces: what range and validTarget measure
    const tiles = lineTiles(map, u, target, 20)
    // BUG: the ray is sampled every 0.25 and every tile it grazes counts toward the 20, so it ends at (9,13)
    expect(tiles.some(p => p.x === target.x && p.y === target.y)).toBe(true)
  })

  it('validTarget and the attack area agree: a target validTarget accepts for a Line weapon is inside its line', () => {
    const a = pregenUnit('Vanguard'), e = pregenUnit('Sniper', 'enemy')
    a.pos = { x: 5, y: 5 }; e.pos = { x: 9, y: 10 } // 5 spaces away (Chebyshev), Thermal Pistol is Line 5
    const b = battle([a, e], flatMap(16, 16))
    const pistol = a.weapons.find(w => b.profile(w).range.some(r => r.type === 'Line'))!
    expect(b.validTarget(a, pistol, e)).toBe(true)
    const tiles = b.aoeTiles(a, pistol, e.pos)
    expect(typeof tiles).not.toBe('string')
    // BUG: the line stops short, so the AI (which aims Line weapons through aoeTiles) never fires at a target the
    // rules and the HUD call valid, and a lancer that clicks it hits nothing
    expect((tiles as { x: number; y: number }[]).some(p => p.x === e.pos.x && p.y === e.pos.y)).toBe(true)
  })
})

describe('AI friendly fire: Jackhammer Round', () => {
  it('the AI does not aim Jackhammer Round next to its own ally (2 kinetic + knockback 2 to every adjacent character)', async () => {
    const themed = (await import('../src/data/squads/themed.json')).default as any[]
    const { buildMechUnit } = await import('../src/rules/stats')
    const { chebyshev } = await import('../src/rules/grid')
    const pilots = themed.find(s => s.id === 'longguns-ll0').pilots
    const thresh = buildMechUnit(structuredClone(pilots.find((p: any) => p.callsign === 'Thresh')))
    const ally = pregenUnit('Assault')
    const e1 = pregenUnit('Sniper', 'enemy'), e2 = pregenUnit('Hacker', 'enemy')
    thresh.pos = { x: 6, y: 10 }
    e1.pos = { x: 5, y: 4 }; e2.pos = { x: 7, y: 4 } // the best impact for two hostiles is (6,4)...
    ally.pos = { x: 6, y: 5 } // ...where the lancer's own ally stands adjacent
    const b = battle([thresh, ally, e1, e2], flatMap(14, 14))
    b.beginTurn(thresh)
    const jack = b.customActions(thresh).find(a => a.key === 'jackhammer')!
    expect(jack).toBeTruthy()
    const aim = jack.aiTarget!(b, thresh) as { x: number; y: number } | null
    // BUG: aiTarget counts only hostiles around the impact, so it picks (6,4) and hits the ally too
    expect(aim && chebyshev(aim, ally.pos) === 1).toBeFalsy()
  })
})

describe('Ordnance is listed as supported but never enforced', () => {
  it('a lancer cannot fire an Ordnance weapon (Howitzer) after moving this turn', async () => {
    const themed = (await import('../src/data/squads/themed.json')).default as any[]
    const { buildMechUnit } = await import('../src/rules/stats')
    const thresh = buildMechUnit(structuredClone(themed.find(s => s.id === 'longguns-ll0').pilots.find((p: any) => p.callsign === 'Thresh')))
    const e = pregenUnit('Sniper', 'enemy')
    thresh.pos = { x: 6, y: 18 }; e.pos = { x: 6, y: 4 }
    const b = battle([thresh, e], flatMap(14, 22))
    b.beginTurn(thresh)
    const howitzer = thresh.weapons.find(w => w.name === 'Howitzer')!
    expect(b.profile(howitzer).tags.some(t => t.id === 'tg_ordnance')).toBe(true)
    b.move(thresh, { x: 6, y: 17 })
    expect(thresh.pos).toEqual({ x: 6, y: 17 })
    // "can only be fired before the user moves or takes any other actions on their turn, excepting Protocols"
    // BUG: nothing checks tg_ordnance (only coverage.ts lists it as supported), so the shot goes off
    const r = b.skirmish(thresh, howitzer, { tile: e.pos })
    expect(r.ok).toBe(false)
  })
})
