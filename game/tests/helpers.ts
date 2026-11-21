import type { GridMap, Tile } from '../src/rules/grid'
import { Battle } from '../src/rules/battle'
import { importPilots } from '../src/import/compcon'
import { buildMechUnit } from '../src/rules/stats'
import pregens from '../src/data/pregens/pregens.json'
import type { Unit } from '../src/rules/types'
import '../src/rules/effects/scripts'

export function flatMap(w = 12, h = 12, f?: (x: number, y: number) => Partial<Tile> | undefined): GridMap {
  const tiles: Tile[] = []
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) tiles.push({ h: 0, kind: 'ground', ...(f?.(x, y) ?? {}) })
  return { w, h, tiles, deployPlayer: [], deployEnemy: [] }
}

export function pregenUnit(name: string, side: 'player' | 'enemy' = 'player'): Unit {
  const p = importPilots((pregens as any[]).find(p => p.name === name))[0]
  return buildMechUnit(p, side)
}

export function battle(units: Unit[], map = flatMap(), seed = 1) {
  const b = new Battle({ map, units, seed })
  b.start()
  return b
}
