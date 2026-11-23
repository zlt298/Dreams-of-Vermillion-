// Deployment onto generated maps (app.ts startBattle / skirmish: placeUnits): every footprint on the map, no overlaps.
import { describe, expect, it } from 'vitest'
import themed from '../../src/data/squads/themed.json'
import { buildMechUnit } from '../../src/rules/stats'
import { buildTeam } from '../../src/enemies/build'
import { generateMap, placeUnits, themeForAct } from '../../src/run/mapgen'
import { footprint, tileAt } from '../../src/rules/grid'
import type { Unit } from '../../src/rules/types'
import '../support'
import redWardenPreTrim from '../fixtures/red-warden-pre-trim.json'

describe('deployment (placeUnits)', () => {
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
  // regression: deployment ignored footprints, so a size-3 mech hung off the map and overlapped its neighbour
  it('the themed Brawlers LL5 squad: the size-3 Barbarossa deploys fully on the map, clear of the Tortuga', () => {
    const s = (themed as any[]).find(x => x.id === 'brawlers-ll5')
    const map = generateMap(1, { theme: themeForAct(2) })
    const units = s.pilots.map((p: any) => buildMechUnit(p)) as Unit[]
    units.forEach((u, i) => (u.pos = map.deployPlayer[i])) // the old placement was broken
    expect(offOrOverlap(map, units)).not.toEqual([])
    placeUnits(map, units, map.deployPlayer)
    expect(offOrOverlap(map, units)).toEqual([])
  })
  // regression: deployment ignored footprints, so a size-2 enemy overlapped its team mates
  it('the act 1 boss team at 4 pilots: the size-2 Choir Bulwark does not overlap other enemies', () => {
    // the roster as it was when this was found (the attrition trim later removed the Bulwark)
    const t = redWardenPreTrim as any
    const map = generateMap(123, { theme: themeForAct(1) })
    const enemies = buildTeam(t, 4)
    enemies.forEach((u, i) => (u.pos = map.deployEnemy[i % map.deployEnemy.length])) // the old placement was broken
    expect(offOrOverlap(map, enemies)).not.toEqual([])
    placeUnits(map, enemies, map.deployEnemy)
    expect(offOrOverlap(map, enemies)).toEqual([])
    for (const u of enemies) expect(u.pos.y).toBeLessThanOrEqual(2) // still in the enemy deployment rows
  })
})
