// Weapon areas and restrictions the AI aims with: Line templates reach their full range on any bearing, and
// Ordnance weapons can't be fired after moving.
import { describe, expect, it } from 'vitest'
import { lineTiles } from '../../src/rules/grid'
import { buildMechUnit } from '../../src/rules/stats'
import themed from '../../src/data/squads/themed.json'
import { battle, flatMap, pregenUnit } from '../support'

describe('Line weapons reach their stated range off the grid axes', () => {
  // regression: the ray was sampled every 0.25 and every grazed tile counted toward the 20, so it ended at (9,13)
  it('a Line 20 drawn toward a tile 20 spaces away reaches it on a diagonal bearing', () => {
    const map = flatMap(18, 36)
    const u = pregenUnit('Vanguard')
    u.pos = { x: 2, y: 26 }
    const target = { x: 12, y: 6 } // max(|dx|, |dy|) = 20 spaces: what range and validTarget measure
    const tiles = lineTiles(map, u, target, 20)
    expect(tiles.some(p => p.x === target.x && p.y === target.y)).toBe(true)
  })

  // regression: the line stopped short, so the AI (which aims Line weapons through aoeTiles) never fired at a target
  // the rules and the HUD called valid, and a lancer that clicked it hit nothing
  it('validTarget and the attack area agree: a target validTarget accepts for a Line weapon is inside its line', () => {
    const a = pregenUnit('Vanguard'), e = pregenUnit('Sniper', 'enemy')
    a.pos = { x: 5, y: 5 }; e.pos = { x: 9, y: 10 } // 5 spaces away (Chebyshev), Thermal Pistol is Line 5
    const b = battle([a, e], flatMap(16, 16))
    const pistol = a.weapons.find(w => b.profile(w).range.some(r => r.type === 'Line'))!
    expect(b.validTarget(a, pistol, e)).toBe(true)
    const tiles = b.aoeTiles(a, pistol, e.pos)
    expect(typeof tiles).not.toBe('string')
    expect((tiles as { x: number; y: number }[]).some(p => p.x === e.pos.x && p.y === e.pos.y)).toBe(true)
  })
})

describe('Ordnance', () => {
  // regression: nothing checked tg_ordnance (only coverage.ts listed it as supported), so the shot went off
  it('a lancer cannot fire an Ordnance weapon (Howitzer) after moving this turn', () => {
    const thresh = buildMechUnit(structuredClone((themed as any[]).find(s => s.id === 'longguns-ll2').pilots.find((p: any) => p.callsign === 'Thresh')))
    const e = pregenUnit('Sniper', 'enemy')
    thresh.pos = { x: 6, y: 18 }; e.pos = { x: 6, y: 4 }
    const b = battle([thresh, e], flatMap(14, 22))
    b.beginTurn(thresh)
    const howitzer = thresh.weapons.find(w => w.name === 'Howitzer')!
    expect(b.profile(howitzer).tags.some(t => t.id === 'tg_ordnance')).toBe(true)
    b.move(thresh, { x: 6, y: 17 })
    expect(thresh.pos).toEqual({ x: 6, y: 17 })
    // "can only be fired before the user moves or takes any other actions on their turn, excepting Protocols"
    const r = b.skirmish(thresh, howitzer, { tile: e.pos })
    expect(r.ok).toBe(false)
  })
})
