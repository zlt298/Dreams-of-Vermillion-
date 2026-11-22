// Map themes per act: outskirts (unchanged), industrial park, cleanroom with Martian incursions.
import { describe, expect, it } from 'vitest'
import { generateMap, themeForAct } from '../src/run/mapgen'
import { Battle } from '../src/rules/battle'
import { pregenUnit } from './helpers'

describe('map themes', () => {
  it('acts map to themes', () => {
    expect([1, 2, 3].map(themeForAct)).toEqual(['outskirts', 'industrial', 'cleanroom'])
  })
  it('act 1 maps are unchanged by the theme option', () => {
    expect(generateMap(77, { theme: 'outskirts' }).tiles).toEqual(generateMap(77).tiles)
  })
  it.each(['outskirts', 'industrial', 'cleanroom'] as const)('%s maps are deployable and connected end to end', theme => {
    for (let seed = 1; seed <= 8; seed++) {
      const map = generateMap(seed * 101, { theme })
      expect(map.theme).toBe(theme)
      expect(map.deployPlayer.length).toBeGreaterThanOrEqual(4)
      const u = pregenUnit('Assault')
      u.pos = map.deployPlayer[0]
      const b = new Battle({ map, units: [u], seed })
      const reach = b.reachable(u, 200, { ignoreEngagement: true })
      expect([...reach.values()].some(r => r.pos.y <= 2)).toBe(true)
    }
  })
  it('the cleanroom has Martian incursions; the industrial park has buildings and spills', () => {
    const clean = generateMap(5, { theme: 'cleanroom' })
    expect(clean.tiles.filter(t => t.skin === 'mars').length).toBeGreaterThan(15)
    const ind = generateMap(5, { theme: 'industrial' })
    expect(ind.tiles.filter(t => t.kind === 'block').length).toBeGreaterThan(30)
    expect(ind.tiles.some(t => t.kind === 'hazard')).toBe(true)
  })
})
