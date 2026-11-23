// Three.js 2.5D isometric battlefield: block terrain with elevation, unit tokens, highlights,
// camera rotation/zoom/pan, picking and event-driven animation.
import * as THREE from 'three'
import type { Battle, BattleEvent } from '../rules/battle'
import { footprintSize, tileAt, elevationAt, type GridMap, type MapTheme } from '../rules/grid'
import type { Pos, Unit } from '../rules/types'
import { buildUnitModel, MODEL_GEOMETRIES } from './models'

export const LEVEL = 0.55 // world units per elevation level

/** Geometries shared by every view: allocated once, never per frame / per hover. */
const SHARED = {
  tile: new THREE.PlaneGeometry(0.92, 0.92).rotateX(-Math.PI / 2),
  flashTile: new THREE.PlaneGeometry(0.95, 0.95).rotateX(-Math.PI / 2),
  hover: new THREE.PlaneGeometry(0.96, 0.96).rotateX(-Math.PI / 2),
  sphere: new THREE.SphereGeometry(1, 10, 8),
  box: new THREE.BoxGeometry(1, 1, 1),
  tree: new THREE.ConeGeometry(0.22, 0.9, 6),
  rubble: new THREE.BoxGeometry(0.22, 0.14, 0.18),
  window: new THREE.BoxGeometry(1.01, 0.08, 1.01),
  wreck: new THREE.BoxGeometry(0.6, 0.15, 0.5),
  rock: new THREE.DodecahedronGeometry(1, 0),
  mine: new THREE.CylinderGeometry(0.16, 0.2, 0.08, 10),
}
const SHARED_GEOMETRIES = new Set<THREE.BufferGeometry>(Object.values(SHARED))

const KIND_COLOR: Record<string, number> = {
  ground: 0x5d6b52, block: 0x7d7f86, forest: 0x3e6b3a, rubble: 0x6e5f4e, water: 0x2f5d7c, hazard: 0x8a3b1e,
}

/** Per-act look: palette, lighting and props. */
interface ThemeLook {
  colors: Record<string, number>
  mars?: Record<string, number>
  background: number; fog: number; hemiSky: number; hemiGround: number; hemi: number; sun: number; sunIntensity: number
  grid: number; gridOpacity: number; hazardGlow: number
}
const THEMES: Record<MapTheme, ThemeLook> = {
  // act 1: intercepted outside (the original look)
  outskirts: { colors: KIND_COLOR, background: 0x14161c, fog: 0x14161c, hemiSky: 0xcfd8ff, hemiGround: 0x3a2a20, hemi: 0.9, sun: 0xffe2c0, sunIntensity: 1.6, grid: 0x000000, gridOpacity: 0.18, hazardGlow: 0x5a1800 },
  // act 2: inside the industrial park — concrete, rust, sodium light
  industrial: {
    colors: { ground: 0x5a5d61, block: 0x5f574d, forest: 0x4a4844, rubble: 0x5b4a3a, water: 0x2f4d5c, hazard: 0x5e6e14 },
    background: 0x0e0c0a, fog: 0x17120d, hemiSky: 0xffd2a0, hemiGround: 0x2a2018, hemi: 0.75, sun: 0xffb36b, sunIntensity: 1.35, grid: 0x000000, gridOpacity: 0.22, hazardGlow: 0x3d5a00,
  },
  // act 3: the cleanroom, with Martian regolith breaking through
  cleanroom: {
    colors: { ground: 0xd3d9df, block: 0xe9eef2, forest: 0xc3d1da, rubble: 0xc9cfd5, water: 0x8fb8cc, hazard: 0x2a8fb0 },
    mars: { ground: 0xa14a2b, block: 0x7c3922, forest: 0xb0552f, rubble: 0x8c3d24, water: 0x7a3a26, hazard: 0xd2581a },
    background: 0x0b1016, fog: 0x101820, hemiSky: 0xeef7ff, hemiGround: 0x7d8894, hemi: 1.05, sun: 0xffffff, sunIntensity: 1.25, grid: 0x1d2a36, gridOpacity: 0.16, hazardGlow: 0x0a4a66,
  },
}
const CONTAINER_COLORS = [0x8a3b2a, 0x2f5d7c, 0x8a7428, 0x3f6b4a, 0x6b6f74]

export interface Highlight { tiles: Pos[]; color: number; opacity?: number }

interface UnitVisual { group: THREE.Group; own: THREE.MeshStandardMaterial[]; height: number; ring: THREE.Mesh; shown: Pos; elev: number; faded?: boolean }

export class BattleView {
  renderer: THREE.WebGLRenderer
  scene = new THREE.Scene()
  camera: THREE.OrthographicCamera
  container: HTMLElement
  map: GridMap
  battle: Battle
  tileMeshes: THREE.Mesh[] = []
  units = new Map<string, UnitVisual>()
  highlightGroup = new THREE.Group()
  /** markers for the mines the player side knows about */
  mineGroup = new THREE.Group()
  fxGroup = new THREE.Group()
  overlay: HTMLDivElement
  labels = new Map<string, HTMLDivElement>()
  azimuth = 0 // 0..3 quarter turns
  zoom = 1
  target = new THREE.Vector3()
  private animQueue: (() => Promise<void>)[] = []
  private animating = false
  private raycaster = new THREE.Raycaster()
  private pointer = new THREE.Vector2()
  onTileClick?: (p: Pos, e: MouseEvent) => void
  onTileHover?: (p: Pos | null) => void
  onUnitClick?: (u: Unit, e: MouseEvent) => void
  /** animation speed multiplier; 0 = skip animations entirely */
  speed = loadSpeed()
  /** max real time one drain of the queue may take before animations fast-forward */
  turnBudgetMs = 3500
  private drainStart = 0
  private disposed = false
  private rafId = 0
  private hoverMesh: THREE.Mesh
  /** per-view material cache (keyed by colour/opacity/kind); disposed with the view */
  private materials = new Map<string, THREE.Material>()
  /** instanced highlight layers keyed by colour+opacity, reused across calls */
  private layers = new Map<string, THREE.InstancedMesh>()
  private pathLine: THREE.Line | null = null
  private tracer: THREE.Line | null = null
  private battleListener = (e: BattleEvent) => this.onEvent(e)
  private dummy = new THREE.Object3D()
  private zoneMeshes: THREE.Object3D[] = []

  constructor(container: HTMLElement, battle: Battle) {
    this.container = container
    this.battle = battle
    this.map = battle.map
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    container.appendChild(this.renderer.domElement)
    this.overlay = document.createElement('div')
    this.overlay.className = 'world-overlay'
    container.appendChild(this.overlay)
    this.camera = new THREE.OrthographicCamera(-10, 10, 10, -10, -200, 400)
    const look = THEMES[this.map.theme ?? 'outskirts']
    this.scene.background = new THREE.Color(look.background)
    this.scene.fog = new THREE.Fog(look.fog, 60, 140)
    const hemi = new THREE.HemisphereLight(look.hemiSky, look.hemiGround, look.hemi)
    this.scene.add(hemi)
    const sun = new THREE.DirectionalLight(look.sun, look.sunIntensity)
    sun.position.set(-20, 40, 15)
    sun.castShadow = true
    sun.shadow.mapSize.set(this.map.h > 24 || this.map.w > 24 ? 4096 : 2048, this.map.h > 24 || this.map.w > 24 ? 4096 : 2048)
    const s = Math.max(this.map.w, this.map.h)
    Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 120 })
    sun.target.position.set(this.map.w / 2, 0, this.map.h / 2)
    this.scene.add(sun, sun.target)
    this.scene.add(this.highlightGroup, this.fxGroup, this.mineGroup)
    this.buildTerrain()
    this.buildZones()
    for (const u of battle.units) this.addUnit(u)
    this.hoverMesh = new THREE.Mesh(SHARED.hover, this.basic(0xffffff, 0.25))
    this.hoverMesh.visible = false
    this.scene.add(this.hoverMesh)
    this.target.set(this.map.w / 2, 0, this.map.h / 2)
    this.zoom = 1
    this.resize()
    this.bindInput()
    battle.listeners.push(this.battleListener)
    const loop = () => {
      if (this.disposed) return
      this.renderer.render(this.scene, this.camera)
      this.updateLabels()
      this.rafId = requestAnimationFrame(loop)
    }
    loop()
  }

  /** Cached transparent basic material (highlights, effects). */
  private basic(color: number, opacity = 1, depthWrite = false): THREE.MeshBasicMaterial {
    const k = `b:${color}:${opacity}:${depthWrite}`
    let m = this.materials.get(k) as THREE.MeshBasicMaterial | undefined
    if (!m) {
      m = new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, depthWrite })
      this.materials.set(k, m)
    }
    return m
  }
  private standard(color: number, roughness = 1): THREE.MeshStandardMaterial {
    const k = `s:${color}:${roughness}`
    let m = this.materials.get(k) as THREE.MeshStandardMaterial | undefined
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color, roughness })
      this.materials.set(k, m)
    }
    return m
  }

  /** Free every GPU resource this view created and detach from the battle and the window. */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    cancelAnimationFrame(this.rafId)
    const i = this.battle.listeners.indexOf(this.battleListener)
    if (i >= 0) this.battle.listeners.splice(i, 1)
    this.animQueue.length = 0
    const geos = new Set<THREE.BufferGeometry>()
    const mats = new Set<THREE.Material>()
    this.scene.traverse(o => {
      const m = o as THREE.Mesh
      if (m.geometry && !SHARED_GEOMETRIES.has(m.geometry) && !MODEL_GEOMETRIES.has(m.geometry)) geos.add(m.geometry)
      if (m.material) for (const x of Array.isArray(m.material) ? m.material : [m.material]) mats.add(x)
      if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose()
    })
    for (const g of geos) g.dispose()
    for (const m of mats) m.dispose()
    for (const m of this.materials.values()) m.dispose()
    this.materials.clear()
    this.layers.clear()
    this.units.clear()
    this.labels.clear()
    this.scene.clear()
    this.renderer.renderLists.dispose()
    this.renderer.forceContextLoss()
    this.renderer.dispose()
    this.renderer.domElement.remove()
    this.overlay.remove()
    window.removeEventListener('resize', this.onResize)
    window.removeEventListener('keydown', this.onKey)
    window.removeEventListener('pointerup', this.onPointerUp)
  }

  // --------------------------------------------------------------- camera
  private onResize = () => this.resize()
  resize() {
    const w = this.container.clientWidth || window.innerWidth
    const h = this.container.clientHeight || window.innerHeight
    this.renderer.setSize(w, h)
    const aspect = w / h
    // fit the map's width (long maps are panned, not shrunk to fit)
    const span = (Math.min(this.map.w, this.map.h) * 0.75) / this.zoom
    this.camera.left = -span * aspect
    this.camera.right = span * aspect
    this.camera.top = span
    this.camera.bottom = -span
    this.camera.updateProjectionMatrix()
    this.placeCamera()
  }
  placeCamera() {
    const ang = Math.PI / 4 + (this.azimuth * Math.PI) / 2
    const dist = 60
    const elev = Math.atan(1 / Math.SQRT2) // classic isometric
    this.camera.position.set(
      this.target.x + Math.sin(ang) * Math.cos(elev) * dist,
      this.target.y + Math.sin(elev) * dist,
      this.target.z + Math.cos(ang) * Math.cos(elev) * dist,
    )
    this.camera.lookAt(this.target)
  }
  rotate(dir: 1 | -1) {
    this.azimuth = (this.azimuth + dir + 4) % 4
    this.placeCamera()
  }
  setZoom(z: number) {
    this.zoom = Math.max(0.5, Math.min(3, z))
    this.resize()
  }
  pan(dx: number, dz: number) {
    const ang = Math.PI / 4 + (this.azimuth * Math.PI) / 2
    const fx = -Math.sin(ang), fz = -Math.cos(ang)
    const rx = Math.cos(ang), rz = -Math.sin(ang)
    this.target.x = Math.max(0, Math.min(this.map.w, this.target.x + rx * dx + fx * dz))
    this.target.z = Math.max(0, Math.min(this.map.h, this.target.z + rz * dx + fz * dz))
    this.placeCamera()
  }
  focus(p: Pos) {
    this.target.set(p.x + 0.5, 0, p.y + 0.5)
    this.placeCamera()
  }

  // --------------------------------------------------------------- terrain
  private tileGroups: THREE.Group[] = []
  private gridLines: THREE.LineSegments | null = null

  private buildTerrain() {
    for (let y = 0; y < this.map.h; y++) for (let x = 0; x < this.map.w; x++) this.buildTile(x, y)
    this.buildGrid()
  }

  /** Rebuild tiles whose terrain changed (destroyed cover, raised debris). */
  rebuildTiles(tiles: Pos[]) {
    for (const p of tiles) {
      const i = p.y * this.map.w + p.x
      const old = this.tileGroups[i]
      if (old) {
        this.scene.remove(old)
        old.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh && m.userData.tile) (m.material as THREE.Material).dispose() })
      }
      this.buildTile(p.x, p.y)
    }
    this.buildGrid()
  }

  private buildTile(x: number, y: number) {
    const theme = this.map.theme ?? 'outskirts'
    const look = THEMES[theme]
    const g = new THREE.Group()
    {
      const t = tileAt(this.map, { x, y })!
      const height = 0.4 + t.h * LEVEL
      const mars = t.skin === 'mars' && look.mars
      const hash = (x * 928371 + y * 1237) % 17
      let color = (mars ? look.mars! : look.colors)[t.kind] ?? 0x666666
      // industrial: low blocks are shipping containers in assorted colours
      if (theme === 'industrial' && t.kind === 'block' && t.h <= 2) color = CONTAINER_COLORS[(x * 3 + y * 7) % CONTAINER_COLORS.length]
      const base = new THREE.Color(color)
      const jitter = hash / 17 - 0.5
      base.offsetHSL(0, 0, jitter * (theme === 'cleanroom' && !mars ? 0.02 : 0.05) + ((x + y) % 2 ? 0.015 : -0.015))
      const mat = new THREE.MeshStandardMaterial({
        color: base, roughness: theme === 'cleanroom' && !mars ? 0.55 : 0.95, metalness: t.kind === 'block' ? (theme === 'industrial' ? 0.35 : 0.15) : 0,
        emissive: t.kind === 'hazard' ? look.hazardGlow : 0x000000,
      })
      const m = new THREE.Mesh(SHARED.box, mat)
      m.scale.set(1, height, 1)
      m.position.set(x + 0.5, height / 2 - 0.4, y + 0.5)
      m.receiveShadow = true
      m.castShadow = t.kind === 'block'
      m.userData = { x, y, tile: true }
      g.add(m)
      this.tileMeshes[y * this.map.w + x] = m
      const top = this.topY({ x, y })
      this.decorate(g, theme, t, x, y, top, !!mars)
    }
    this.scene.add(g)
    this.tileGroups[y * this.map.w + x] = g
  }

  private buildGrid() {
    const look = THEMES[this.map.theme ?? 'outskirts']
    if (this.gridLines) { this.scene.remove(this.gridLines); this.gridLines.geometry.dispose(); (this.gridLines.material as THREE.Material).dispose() }
    const pts: THREE.Vector3[] = []
    for (let y = 0; y < this.map.h; y++) for (let x = 0; x < this.map.w; x++) {
      const yy = this.topY({ x, y }) + 0.005
      pts.push(new THREE.Vector3(x, yy, y), new THREE.Vector3(x + 1, yy, y), new THREE.Vector3(x, yy, y), new THREE.Vector3(x, yy, y + 1))
    }
    const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: look.grid, transparent: true, opacity: look.gridOpacity }))
    this.scene.add(lines)
    this.gridLines = lines
  }

  /** Props on top of a tile, by theme: trees and windows outside; vents, scrap, lane paint and hazard
   *  stripes in the industrial park; glass partitions, light strips, red rock and dust in the cleanroom. */
  private decorate(g: THREE.Group, theme: MapTheme, t: { h: number; kind: string }, x: number, y: number, top: number, mars: boolean) {
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, px: number, py: number, pz: number, sx = 1, sy = 1, sz = 1, ry = 0, shadow = false) => {
      const m = new THREE.Mesh(geo, mat)
      m.position.set(px, py, pz); m.scale.set(sx, sy, sz); m.rotation.y = ry
      m.castShadow = shadow
      g.add(m)
    }
    const k = t.kind
    if (theme === 'outskirts') {
      if (k === 'forest') {
        const n = 1 + ((x * 7 + y * 3) % 2)
        for (let i = 0; i < n; i++) add(SHARED.tree, this.standard(0x2f5a2c), x + 0.3 + i * 0.4, top + 0.45, y + 0.35 + ((x + i) % 2) * 0.3, 1, 1, 1, 0, true)
      }
      if (k === 'rubble') for (let i = 0; i < 3; i++) add(SHARED.rubble, this.standard(0x80705c), x + 0.25 + i * 0.27, top + 0.07, y + 0.3 + ((i * 37) % 5) * 0.1, 1, 1, 1, i)
      if (k === 'block' && t.h >= 2) add(SHARED.window, this.basic(0xffc46b), x + 0.5, top - 0.35, y + 0.5)
      return
    }
    if (theme === 'industrial') {
      if (k === 'forest') { // steam vent: grating plus a plume
        add(SHARED.box, this.standard(0x2e2d2b), x + 0.5, top + 0.03, y + 0.5, 0.6, 0.06, 0.6)
        add(SHARED.sphere, this.translucent(0xd8d4cc, 0.28), x + 0.5, top + 0.55, y + 0.5, 0.32, 0.45, 0.32)
        add(SHARED.sphere, this.translucent(0xd8d4cc, 0.18), x + 0.45, top + 1.05, y + 0.55, 0.4, 0.4, 0.4)
      }
      if (k === 'rubble') { // scrap: rusted plates and a pipe stub
        for (let i = 0; i < 3; i++) add(SHARED.rubble, this.standard(i % 2 ? 0x8a4a22 : 0x5a5650, 0.8), x + 0.25 + i * 0.25, top + 0.07, y + 0.3 + ((i * 37) % 5) * 0.1, 1.3, 1, 1, i * 0.7)
        add(SHARED.box, this.standard(0x6b6f74, 0.6), x + 0.5, top + 0.08, y + 0.6, 0.7, 0.1, 0.1, 0.5)
      }
      if (k === 'block' && t.h >= 3) { // warehouse: hazard stripe and a sodium window band
        add(SHARED.window, this.basic(0xd9a400), x + 0.5, top - 0.06, y + 0.5)
        add(SHARED.window, this.basic(0xff9a3c), x + 0.5, top - 0.5, y + 0.5, 1, 0.6, 1)
      }
      if (k === 'block' && t.h <= 2) add(SHARED.box, this.standard(0x2b2b2b), x + 0.5, top + 0.01, y + 0.5, 0.9, 0.02, 0.1) // container ribbing
      if (k === 'hazard') add(SHARED.box, this.translucent(0xb8e02a, 0.45), x + 0.5, top + 0.01, y + 0.5, 0.85, 0.02, 0.85) // chemical sheen
      if (k === 'ground' && t.h === 0 && (y % 9 === 4 || x % 6 === 0) && (x + y) % 2 === 0) // lane paint
        add(SHARED.box, this.basic(0xc9a227), x + 0.5, top + 0.006, y + 0.5, y % 9 === 4 ? 0.7 : 0.1, 0.01, y % 9 === 4 ? 0.1 : 0.7)
      return
    }
    // cleanroom
    if (mars) {
      if (k === 'rubble') for (let i = 0; i < 3; i++) add(SHARED.rock, this.standard(i % 2 ? 0x7a3420 : 0x9c4a2c), x + 0.28 + i * 0.24, top + 0.08, y + 0.3 + ((i * 37) % 5) * 0.1, 0.16 + (i % 2) * 0.06, 0.12, 0.15, i)
      if (k === 'forest') { // red dust haze
        add(SHARED.sphere, this.translucent(0xc8673a, 0.3), x + 0.5, top + 0.35, y + 0.5, 0.48, 0.32, 0.48)
        add(SHARED.sphere, this.translucent(0xd98a55, 0.18), x + 0.4, top + 0.75, y + 0.6, 0.38, 0.28, 0.38)
      }
      if (k === 'block') add(SHARED.rock, this.standard(0x6e2f1c), x + 0.5, top + 0.12, y + 0.5, 0.45, 0.3, 0.4, x + y, true) // jagged crest
      if (k === 'ground' && (x * 13 + y * 7) % 5 === 0) add(SHARED.rock, this.standard(0x8e3f26), x + 0.3 + ((x * 3) % 4) * 0.12, top + 0.04, y + 0.35, 0.08, 0.06, 0.08, x)
      if (k === 'hazard') add(SHARED.sphere, this.translucent(0xff7a2a, 0.35), x + 0.5, top + 0.05, y + 0.5, 0.4, 0.08, 0.4) // glowing breach
      return
    }
    if (k === 'forest') { // frosted-glass partition
      const along = (x + y) % 2 === 0
      add(SHARED.box, this.translucent(0xd6eef8, 0.42), x + 0.5, top + 0.45, y + 0.5, along ? 0.92 : 0.06, 0.9, along ? 0.06 : 0.92)
      add(SHARED.box, this.standard(0x9fb2bf, 0.4), x + 0.5, top + 0.02, y + 0.5, along ? 0.95 : 0.1, 0.04, along ? 0.1 : 0.95)
    }
    if (k === 'block') add(SHARED.window, this.basic(t.h >= 2 ? 0x7ff3ff : 0x9fd8ff), x + 0.5, top - (t.h >= 2 ? 0.25 : 0.12), y + 0.5, 1, 0.5, 1) // light strip
    if (k === 'rubble') for (let i = 0; i < 2; i++) add(SHARED.box, this.standard(0xf2f4f6, 0.5), x + 0.3 + i * 0.4, top + 0.12, y + 0.45 + i * 0.1, 0.28, 0.24, 0.28, i) // equipment crates
    if (k === 'hazard') add(SHARED.box, this.translucent(0x5fd0ff, 0.4), x + 0.5, top + 0.01, y + 0.5, 0.85, 0.02, 0.85) // coolant spill
  }

  private translucent(color: number, opacity: number): THREE.MeshStandardMaterial {
    const k = `t:${color}:${opacity}`
    let m = this.materials.get(k) as THREE.MeshStandardMaterial | undefined
    if (!m) { m = new THREE.MeshStandardMaterial({ color, transparent: true, opacity, depthWrite: false, roughness: 0.3 }); this.materials.set(k, m) }
    return m
  }

  private buildZones() {
    for (const o of this.zoneMeshes) this.scene.remove(o)
    this.zoneMeshes = []
    const s = this.battle.sitrep
    if (!s.zone) return
    for (const p of s.zone) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: s.id === 'extraction' ? 0x45d483 : 0xf2c14e, transparent: true, opacity: 0.22, depthWrite: false }))
      m.rotation.x = -Math.PI / 2
      m.position.set(p.x + 0.5, this.topY(p) + 0.02, p.y + 0.5)
      this.scene.add(m)
      this.zoneMeshes.push(m)
    }
  }

  topY(p: Pos): number {
    const t = tileAt(this.map, p)
    return t ? t.h * LEVEL : 0
  }

  // --------------------------------------------------------------- units
  private unitColor(u: Unit): number {
    if (u.color) return new THREE.Color(u.color).getHex()
    if (u.side === 'player') return u.kind === 'mech' ? 0x3d8bd9 : 0x7fb6e8
    return 0xd9534f
  }
  addUnit(u: Unit) {
    if (this.units.has(u.id)) return
    const fs = footprintSize(u)
    const model = buildUnitModel(u, { shared: (k, make) => { let m = this.materials.get(k); if (!m) { m = make(); this.materials.set(k, m) } return m } })
    const group = model.group
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.36 * fs, 0.46 * fs, 24), new THREE.MeshBasicMaterial({ color: u.side === 'player' ? 0x4fc3ff : 0xff4d4d, side: THREE.DoubleSide, transparent: true, opacity: 0.85 }))
    ring.rotation.x = -Math.PI / 2
    ring.position.y = 0.03
    group.add(ring)
    const elev = elevationAt(this.map, u, u.pos) + (u.flying ? 1 : 0)
    group.position.set(u.pos.x + fs / 2, elev * LEVEL, u.pos.y + fs / 2)
    group.rotation.y = u.side === 'player' ? Math.PI : 0
    group.traverse(o => (o.userData.unitId = u.id))
    this.scene.add(group)
    this.units.set(u.id, { group, own: model.own, height: model.height, ring, shown: { ...u.pos }, elev })
    const label = document.createElement('div')
    label.className = `unit-label ${u.side}`
    this.overlay.appendChild(label)
    this.labels.set(u.id, label)
  }

  private updateLabels() {
    const w = this.renderer.domElement.clientWidth, h = this.renderer.domElement.clientHeight
    const v = new THREE.Vector3()
    for (const [id, label] of this.labels) {
      const u = this.battle.unit(id)
      const vis = this.units.get(id)
      if (!u || !vis || (u.destroyed && !vis.group.visible)) { label.style.display = 'none'; continue }
      v.copy(vis.group.position)
      v.y += vis.height + 0.35
      v.project(this.camera)
      label.style.display = v.z > 1 ? 'none' : 'block'
      label.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -100%)`
      const hpPct = Math.max(0, u.hp / u.stats.hp) * 100
      const heatPct = u.stats.heatcap ? Math.min(100, (u.heat / u.stats.heatcap) * 100) : 0
      const st = u.statuses.map(s => s.id).filter(s => s !== 'bracing_recovery')
      const html = `<div class="ln">${u.name}${u.activeTurn ? ' ◆' : ''}</div><div class="bar hp"><i style="width:${hpPct}%"></i>${u.overshield ? `<b style="width:${Math.min(100, (u.overshield / u.stats.hp) * 100)}%"></b>` : ''}</div>${u.stats.heatcap ? `<div class="bar heat"><i style="width:${heatPct}%"></i></div>` : ''}${u.kind === 'mech' || u.stats.structure > 1 ? `<div class="pips">${'■'.repeat(Math.max(0, u.structure))}<span>${'■'.repeat(Math.max(0, u.stats.structure - u.structure))}</span> ${'◆'.repeat(Math.max(0, u.stress))}<span>${'◆'.repeat(Math.max(0, u.stats.stress - u.stress))}</span></div>` : ''}${st.length ? `<div class="st">${st.join(' · ')}</div>` : ''}`
      if (label.dataset.html !== html) { label.innerHTML = html; label.dataset.html = html }
      label.classList.toggle('active', u.activeTurn)
      label.classList.toggle('dead', u.destroyed)
    }
  }

  syncUnits() {
    this.syncMines()
    for (const u of this.battle.units) {
      if (!this.units.has(u.id)) this.addUnit(u)
      const vis = this.units.get(u.id)!
      if (!this.animating) this.placeUnit(u, u.pos)
      vis.group.visible = !u.destroyed || vis.group.visible
      ;(vis.ring.material as THREE.MeshBasicMaterial).opacity = u.activeTurn ? 1 : u.activationsLeft > 0 ? 0.85 : 0.35
      const fade = u.statuses.some(s => s.id === 'hidden' || s.id === 'invisible')
      if (fade !== !!vis.faded) {
        vis.faded = fade
        for (const m of vis.own) { m.transparent = fade; m.opacity = fade ? 0.4 : 1; m.needsUpdate = true }
      }
      vis.group.rotation.z = u.statuses.some(s => s.id === 'prone') ? 0.9 : 0
    }
  }
  private placeUnit(u: Unit, p: Pos) {
    const vis = this.units.get(u.id)
    if (!vis) return
    const fs = footprintSize(u)
    const elev = elevationAt(this.map, u, p) + (u.flying ? 1 : 0)
    vis.group.position.set(p.x + fs / 2, elev * LEVEL, p.y + fs / 2)
    vis.shown = { ...p }
  }

  /** Rebuild the mine markers: own-side mines (dimmed until armed) and detected hostile mines. */
  syncMines() {
    this.mineGroup.clear()
    for (const m of this.battle.mines) {
      if (!this.battle.mineVisibleTo(m, 'player')) continue
      const own = m.side === 'player'
      const mat = own ? this.basic(m.armed ? 0xffb347 : 0x8a6a3a, m.armed ? 1 : 0.6) : this.basic(0xd04ad0)
      const mesh = new THREE.Mesh(SHARED.mine, mat)
      const h = tileAt(this.map, m.pos)?.h ?? 0
      mesh.position.set(m.pos.x + 0.5, h * LEVEL + 0.05, m.pos.y + 0.5)
      this.mineGroup.add(mesh)
    }
    // Javelin Rocket marks of the player side
    for (const u of this.battle.units) {
      if (u.side !== 'player' || u.destroyed || !Array.isArray(u.flags.javelins)) continue
      for (const p of u.flags.javelins as { x: number; y: number }[]) {
        const mesh = new THREE.Mesh(SHARED.mine, this.basic(0xff5a3c, 0.7))
        mesh.scale.set(0.7, 3, 0.7)
        mesh.position.set(p.x + 0.5, (tileAt(this.map, p)?.h ?? 0) * LEVEL + 0.15, p.y + 0.5)
        this.mineGroup.add(mesh)
      }
    }
  }

  // --------------------------------------------------------------- highlights
  /** Get (or lazily create) the instanced layer for a colour/opacity; capacity = every tile twice. */
  private layer(color: number, opacity: number, geometry = SHARED.tile): THREE.InstancedMesh {
    const k = `${color}:${opacity}:${geometry.uuid}`
    let l = this.layers.get(k)
    if (!l) {
      l = new THREE.InstancedMesh(geometry, this.basic(color, opacity), this.map.w * this.map.h * 2)
      l.frustumCulled = false
      l.count = 0
      this.layers.set(k, l)
      this.highlightGroup.add(l)
    }
    return l
  }
  private fillLayer(l: THREE.InstancedMesh, tiles: Pos[], lift: number, start = 0): number {
    let n = start
    const cap = l.instanceMatrix.count
    for (const p of tiles) {
      if (n >= cap) break
      this.dummy.position.set(p.x + 0.5, this.topY(p) + lift, p.y + 0.5)
      this.dummy.updateMatrix()
      l.setMatrixAt(n++, this.dummy.matrix)
    }
    l.count = n
    l.instanceMatrix.needsUpdate = true
    return n
  }
  /** Replace the tile highlights. Reuses instanced layers: no allocation after warm-up. */
  setHighlights(hs: Highlight[]) {
    const used = new Map<THREE.InstancedMesh, number>()
    const mine = [...this.layers.values()].filter(l => l.geometry === SHARED.tile)
    for (const l of mine) l.count = 0
    for (const h of hs) {
      const l = this.layer(h.color, h.opacity ?? 0.35)
      used.set(l, this.fillLayer(l, h.tiles, 0.03, used.get(l) ?? 0))
    }
    for (const l of mine) l.visible = l.count > 0
  }
  setPath(path: Pos[] | null) {
    if (!this.pathLine) {
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.map.w * this.map.h * 3 * 2), 3))
      this.pathLine = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x9ae6ff }))
      this.pathLine.frustumCulled = false
      this.highlightGroup.add(this.pathLine)
    }
    const line = this.pathLine
    if (!path || path.length < 2) { line.visible = false; return }
    const attr = line.geometry.getAttribute('position') as THREE.BufferAttribute
    const n = Math.min(path.length, attr.count)
    for (let i = 0; i < n; i++) attr.setXYZ(i, path[i].x + 0.5, this.topY(path[i]) + 0.12, path[i].y + 0.5)
    attr.needsUpdate = true
    line.geometry.setDrawRange(0, n)
    line.visible = true
  }

  // --------------------------------------------------------------- input
  private onPointerUp: () => void = () => {}
  private onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return
    const k = e.key.toLowerCase()
    if (k === 'q') this.rotate(-1)
    else if (k === 'e') this.rotate(1)
    else if (k === 'w' || k === 'arrowup') this.pan(0, 1.5)
    else if (k === 's' || k === 'arrowdown') this.pan(0, -1.5)
    else if (k === 'a' || k === 'arrowleft') this.pan(-1.5, 0)
    else if (k === 'd' || k === 'arrowright') this.pan(1.5, 0)
    else if (k === '=' || k === '+') this.setZoom(this.zoom * 1.15)
    else if (k === '-') this.setZoom(this.zoom / 1.15)
  }
  private bindInput() {
    window.addEventListener('resize', this.onResize)
    window.addEventListener('keydown', this.onKey)
    const el = this.renderer.domElement
    el.addEventListener('wheel', e => { e.preventDefault(); this.setZoom(this.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)) }, { passive: false })
    let drag: { x: number; y: number; moved: boolean } | null = null
    el.addEventListener('contextmenu', e => e.preventDefault())
    el.addEventListener('pointerdown', e => { if (e.button === 2 || e.button === 1) drag = { x: e.clientX, y: e.clientY, moved: false } })
    this.onPointerUp = () => (drag = null)
    window.addEventListener('pointerup', this.onPointerUp)
    el.addEventListener('pointermove', e => {
      if (drag) {
        const k = (this.camera.right - this.camera.left) / el.clientWidth
        this.pan(-(e.clientX - drag.x) * k, (e.clientY - drag.y) * k * 1.4)
        drag.x = e.clientX; drag.y = e.clientY; drag.moved = true
        return
      }
      const p = this.pick(e)
      if (p?.tile) {
        this.hoverMesh.visible = true
        this.hoverMesh.position.set(p.tile.x + 0.5, this.topY(p.tile) + 0.04, p.tile.y + 0.5)
      } else this.hoverMesh.visible = false
      this.onTileHover?.(p?.tile ?? null)
    })
    el.addEventListener('click', e => {
      const p = this.pick(e)
      if (!p) return
      if (p.unit && this.onUnitClick) this.onUnitClick(p.unit, e)
      else if (p.tile) this.onTileClick?.(p.tile, e)
    })
  }
  pick(e: MouseEvent): { tile?: Pos; unit?: Unit } | null {
    const r = this.renderer.domElement.getBoundingClientRect()
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const unitObjs: THREE.Object3D[] = []
    for (const [id, v] of this.units) if (v.group.visible && !this.battle.unit(id)?.destroyed) unitObjs.push(v.group)
    const hitU = this.raycaster.intersectObjects(unitObjs, true)[0]
    const hitT = this.raycaster.intersectObjects(this.tileMeshes, false)[0]
    const out: { tile?: Pos; unit?: Unit } = {}
    if (hitU) out.unit = this.battle.unit(hitU.object.userData.unitId)
    if (hitT) out.tile = { x: hitT.object.userData.x, y: hitT.object.userData.y }
    if (out.unit && !out.tile) out.tile = { ...out.unit.pos }
    return out.tile || out.unit ? out : null
  }

  // --------------------------------------------------------------- animation
  private onEvent(e: BattleEvent) {
    switch (e.type) {
      case 'move': {
        const path = e.path
        this.enqueue(() => this.animateMove(e.unitId, path))
        break
      }
      case 'attack':
        this.enqueue(() => this.animateAttack(e.attackerId, e.targetId, e.hit, e.crit))
        break
      case 'damage':
        if (e.kind === 'hp' || e.kind === 'heat' || e.kind === 'structure' || e.kind === 'stress') this.enqueue(() => this.floatText(e.unitId, e.kind === 'hp' ? `-${e.amount}` : e.kind === 'heat' ? `+${e.amount} heat` : e.kind.toUpperCase(), e.kind === 'hp' ? '#ff6b6b' : e.kind === 'heat' ? '#ffae42' : '#ff3355'), true)
        break
      case 'destroyed':
        this.enqueue(() => this.animateDestroyed(e.unitId))
        break
      case 'area':
        this.enqueue(() => this.flashTiles(e.tiles, e.kind === 'explosion' ? 0xff7b29 : e.kind === 'soft_cover' ? 0xb0b0b0 : 0xffb347), true)
        break
      case 'terrain':
        this.enqueue(async () => { this.rebuildTiles(e.tiles); this.syncUnits() }, true)
        break
      case 'mine':
        this.enqueue(async () => this.syncMines(), true)
        break
      case 'spawn':
        this.enqueue(async () => { const u = this.battle.unit(e.unitId); if (u) this.addUnit(u) }, true)
        break
      case 'status':
        this.enqueue(async () => this.syncUnits(), true)
        break
    }
  }
  private enqueue(f: () => Promise<void>, instant = false) {
    this.animQueue.push(instant ? async () => { await f() } : f)
    if (!this.animating) void this.drain()
  }
  private async drain() {
    this.animating = true
    this.drainStart = performance.now()
    while (this.animQueue.length) {
      const f = this.animQueue.shift()!
      try { await f() } catch (err) { console.error(err) }
    }
    this.animating = false
    this.syncUnits()
  }
  /** Resolves once all queued animations have played. */
  idle(timeoutMs = 10000): Promise<void> {
    const t0 = performance.now()
    return new Promise(res => {
      const check = () => (!this.animating && !this.animQueue.length) || performance.now() - t0 > timeoutMs ? res() : setTimeout(check, 30)
      check()
    })
  }
  get skipping(): boolean {
    return this.speed === 0 || performance.now() - this.drainStart > this.turnBudgetMs
  }
  setSpeed(v: number) {
    this.speed = v
    try { localStorage.setItem('dov.animSpeed', String(v)) } catch { /* ignore */ }
  }
  private wait(ms: number) {
    if (this.skipping) return Promise.resolve()
    // catch up quickly when a long chain of events (e.g. an AI turn) has queued up
    const backlog = this.animQueue.length > 24 ? 8 : 1
    return new Promise<void>(r => setTimeout(r, ms / (this.speed * backlog)))
  }
  private async animateMove(id: string, path: Pos[]) {
    const u = this.battle.unit(id)
    const vis = this.units.get(id)
    if (!u || !vis) return
    const fs = footprintSize(u)
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i]
      const ea = (elevationAt(this.map, u, a) + (u.flying ? 1 : 0)) * LEVEL
      const eb = (elevationAt(this.map, u, b) + (u.flying ? 1 : 0)) * LEVEL
      vis.group.rotation.y = Math.atan2(b.x - a.x, b.y - a.y)
      const steps = 6
      for (let s = 1; s <= steps; s++) {
        const t = s / steps
        vis.group.position.set(a.x + (b.x - a.x) * t + fs / 2, ea + (eb - ea) * t + Math.sin(t * Math.PI) * 0.08, a.y + (b.y - a.y) * t + fs / 2)
        await this.wait(14)
      }
    }
    vis.shown = { ...path[path.length - 1] }
  }
  private async animateAttack(aid: string, tid: string, hit: boolean, crit: boolean) {
    const a = this.units.get(aid), t = this.units.get(tid)
    if (!a || !t) return
    const ap = a.group.position.clone().add(new THREE.Vector3(0, 0.7, 0))
    const tp = t.group.position.clone().add(new THREE.Vector3(hit ? 0 : 0.6, 0.6, hit ? 0 : 0.4))
    a.group.rotation.y = Math.atan2(tp.x - ap.x, tp.z - ap.z)
    if (!this.tracer) {
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3))
      this.tracer = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffa64d }))
      this.tracer.frustumCulled = false
      this.tracer.visible = false
      this.fxGroup.add(this.tracer)
    }
    const attr = this.tracer.geometry.getAttribute('position') as THREE.BufferAttribute
    attr.setXYZ(0, ap.x, ap.y, ap.z)
    attr.setXYZ(1, tp.x, tp.y, tp.z)
    attr.needsUpdate = true
    ;(this.tracer.material as THREE.LineBasicMaterial).color.setHex(crit ? 0xfff066 : hit ? 0xffa64d : 0x8899aa)
    this.tracer.visible = true
    await this.wait(160)
    this.tracer.visible = false
    if (hit) {
      const flash = new THREE.Mesh(SHARED.sphere, this.basic(crit ? 0xfff066 : 0xff8c3a, 0.85))
      flash.scale.setScalar(crit ? 0.45 : 0.3)
      flash.position.copy(tp)
      this.fxGroup.add(flash)
      await this.wait(120)
      this.fxGroup.remove(flash)
    } else {
      await this.floatText(tid, 'MISS', '#9fb3c8')
    }
  }
  private async animateDestroyed(id: string) {
    const vis = this.units.get(id)
    if (!vis) return
    // the fading material is animated, so it is per-explosion and disposed right after
    const boomMat = new THREE.MeshBasicMaterial({ color: 0xff7a1a, transparent: true, opacity: 0.9 })
    const boom = new THREE.Mesh(SHARED.sphere, boomMat)
    boom.position.copy(vis.group.position).add(new THREE.Vector3(0, 0.5, 0))
    this.fxGroup.add(boom)
    for (let i = 0; i < 10; i++) {
      boom.scale.setScalar(0.2 * (1 + i * 0.6))
      boomMat.opacity = 0.9 - i * 0.08
      vis.group.position.y -= 0.03
      await this.wait(25)
    }
    this.fxGroup.remove(boom)
    boomMat.dispose()
    vis.group.visible = false
    const wreck = new THREE.Mesh(SHARED.wreck, this.standard(0x2b2b2b))
    wreck.position.copy(vis.group.position).add(new THREE.Vector3(0, 0.1, 0))
    this.scene.add(wreck)
  }
  private async flashTiles(tiles: Pos[], color: number) {
    if (this.skipping) return
    const l = this.layer(color, 0.5, SHARED.flashTile)
    this.fillLayer(l, tiles, 0.06)
    l.visible = true
    await this.wait(220)
    l.count = 0
    l.visible = false
  }
  private async floatText(id: string, text: string, color: string) {
    const vis = this.units.get(id)
    if (!vis || this.skipping) return
    const el = document.createElement('div')
    el.className = 'float-text'
    el.textContent = text
    el.style.color = color
    this.overlay.appendChild(el)
    const v = vis.group.position.clone().add(new THREE.Vector3(0, 1.4, 0)).project(this.camera)
    const w = this.renderer.domElement.clientWidth, h = this.renderer.domElement.clientHeight
    el.style.left = `${((v.x + 1) / 2) * w}px`
    el.style.top = `${((1 - v.y) / 2) * h}px`
    setTimeout(() => el.remove(), 1100)
    await this.wait(60)
  }

  screenshot(): string {
    this.renderer.render(this.scene, this.camera)
    return this.renderer.domElement.toDataURL('image/png')
  }
}

function loadSpeed(): number {
  try {
    const v = Number(localStorage.getItem('dov.animSpeed'))
    return [0, 1, 2, 4].includes(v) && localStorage.getItem('dov.animSpeed') !== null ? v : 1
  } catch { return 1 }
}
