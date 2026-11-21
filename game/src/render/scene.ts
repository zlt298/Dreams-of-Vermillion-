// Three.js 2.5D isometric battlefield: block terrain with elevation, unit tokens, highlights,
// camera rotation/zoom/pan, picking and event-driven animation.
import * as THREE from 'three'
import type { Battle, BattleEvent } from '../rules/battle'
import { footprintSize, tileAt, elevationAt, type GridMap } from '../rules/grid'
import type { Pos, Unit } from '../rules/types'

export const LEVEL = 0.55 // world units per elevation level

const KIND_COLOR: Record<string, number> = {
  ground: 0x5d6b52, block: 0x7d7f86, forest: 0x3e6b3a, rubble: 0x6e5f4e, water: 0x2f5d7c, hazard: 0x8a3b1e,
}

export interface Highlight { tiles: Pos[]; color: number; opacity?: number }

interface UnitVisual { group: THREE.Group; body: THREE.Mesh; ring: THREE.Mesh; shown: Pos; elev: number }

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
  speed = 1
  private disposed = false
  private hoverMesh: THREE.Mesh
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
    this.scene.background = new THREE.Color(0x14161c)
    this.scene.fog = new THREE.Fog(0x14161c, 60, 140)
    const hemi = new THREE.HemisphereLight(0xcfd8ff, 0x3a2a20, 0.9)
    this.scene.add(hemi)
    const sun = new THREE.DirectionalLight(0xffe2c0, 1.6)
    sun.position.set(-20, 40, 15)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    const s = Math.max(this.map.w, this.map.h)
    Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 120 })
    sun.target.position.set(this.map.w / 2, 0, this.map.h / 2)
    this.scene.add(sun, sun.target)
    this.scene.add(this.highlightGroup, this.fxGroup)
    this.buildTerrain()
    this.buildZones()
    for (const u of battle.units) this.addUnit(u)
    this.hoverMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.96, 0.96), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25, depthWrite: false }))
    this.hoverMesh.rotation.x = -Math.PI / 2
    this.hoverMesh.visible = false
    this.scene.add(this.hoverMesh)
    this.target.set(this.map.w / 2, 0, this.map.h / 2)
    this.zoom = 1
    this.resize()
    this.bindInput()
    battle.listeners.push(e => this.onEvent(e))
    const loop = () => {
      if (this.disposed) return
      this.renderer.render(this.scene, this.camera)
      this.updateLabels()
      requestAnimationFrame(loop)
    }
    loop()
  }

  dispose() {
    this.disposed = true
    this.renderer.dispose()
    this.renderer.domElement.remove()
    this.overlay.remove()
    window.removeEventListener('resize', this.onResize)
    window.removeEventListener('keydown', this.onKey)
  }

  // --------------------------------------------------------------- camera
  private onResize = () => this.resize()
  resize() {
    const w = this.container.clientWidth || window.innerWidth
    const h = this.container.clientHeight || window.innerHeight
    this.renderer.setSize(w, h)
    const aspect = w / h
    const span = (Math.max(this.map.w, this.map.h) * 0.75) / this.zoom
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
  private buildTerrain() {
    const geo = new THREE.BoxGeometry(1, 1, 1)
    for (let y = 0; y < this.map.h; y++) for (let x = 0; x < this.map.w; x++) {
      const t = tileAt(this.map, { x, y })!
      const height = 0.4 + t.h * LEVEL
      const base = new THREE.Color(KIND_COLOR[t.kind] ?? 0x666666)
      const jitter = ((x * 928371 + y * 1237) % 17) / 17 - 0.5
      base.offsetHSL(0, 0, jitter * 0.05 + ((x + y) % 2 ? 0.015 : -0.015))
      const mat = new THREE.MeshStandardMaterial({ color: base, roughness: 0.95, metalness: t.kind === 'block' ? 0.15 : 0, emissive: t.kind === 'hazard' ? 0x5a1800 : 0x000000 })
      const m = new THREE.Mesh(geo, mat)
      m.scale.set(1, height, 1)
      m.position.set(x + 0.5, height / 2 - 0.4, y + 0.5)
      m.receiveShadow = true
      m.castShadow = t.kind === 'block'
      m.userData = { x, y }
      this.scene.add(m)
      this.tileMeshes.push(m)
      const top = this.topY({ x, y })
      if (t.kind === 'forest') {
        const n = 1 + ((x * 7 + y * 3) % 2)
        for (let i = 0; i < n; i++) {
          const tree = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.9, 6), new THREE.MeshStandardMaterial({ color: 0x2f5a2c, roughness: 1 }))
          tree.position.set(x + 0.3 + i * 0.4, top + 0.45, y + 0.35 + ((x + i) % 2) * 0.3)
          tree.castShadow = true
          this.scene.add(tree)
        }
      }
      if (t.kind === 'rubble') {
        for (let i = 0; i < 3; i++) {
          const r = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.14, 0.18), new THREE.MeshStandardMaterial({ color: 0x80705c }))
          r.position.set(x + 0.25 + (i * 0.27), top + 0.07, y + 0.3 + ((i * 37) % 5) * 0.1)
          r.rotation.y = i
          this.scene.add(r)
        }
      }
      if (t.kind === 'block' && t.h >= 2) {
        // window strips on buildings
        const win = new THREE.Mesh(new THREE.BoxGeometry(1.01, 0.08, 1.01), new THREE.MeshBasicMaterial({ color: 0xffc46b }))
        win.position.set(x + 0.5, top - 0.35, y + 0.5)
        this.scene.add(win)
      }
    }
    // grid lines
    const pts: THREE.Vector3[] = []
    for (let y = 0; y < this.map.h; y++) for (let x = 0; x < this.map.w; x++) {
      const yy = this.topY({ x, y }) + 0.005
      pts.push(new THREE.Vector3(x, yy, y), new THREE.Vector3(x + 1, yy, y), new THREE.Vector3(x, yy, y), new THREE.Vector3(x, yy, y + 1))
    }
    const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.18 }))
    this.scene.add(lines)
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
    const group = new THREE.Group()
    const s = Math.max(0.5, u.stats.size)
    const fs = footprintSize(u)
    const col = this.unitColor(u)
    let body: THREE.Mesh
    const mat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.55, metalness: 0.35 })
    if (u.kind === 'drone') {
      body = new THREE.Mesh(new THREE.OctahedronGeometry(0.22), mat)
      body.position.y = 0.9
    } else if (u.kind === 'deployable') {
      body = new THREE.Mesh(new THREE.BoxGeometry(fs * 0.9, Math.max(0.5, s) * 0.8, fs * 0.25), mat)
      body.position.y = (Math.max(0.5, s) * 0.8) / 2
    } else {
      const h = 0.75 * s + 0.35
      body = new THREE.Mesh(new THREE.BoxGeometry(0.55 * fs, h, 0.45 * fs), mat)
      body.position.y = h / 2 + 0.05
      // head + shoulders so tokens read as mechs
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.28 * fs, 0.22 * s, 0.28 * fs), new THREE.MeshStandardMaterial({ color: 0x222831, roughness: 0.4, metalness: 0.6 }))
      head.position.y = h + 0.12 * s
      const eye = new THREE.Mesh(new THREE.BoxGeometry(0.2 * fs, 0.05, 0.02), new THREE.MeshBasicMaterial({ color: u.side === 'player' ? 0x7ff3ff : 0xff5040 }))
      eye.position.set(0, h + 0.14 * s, 0.15 * fs)
      const shoulders = new THREE.Mesh(new THREE.BoxGeometry(0.85 * fs, 0.18 * s, 0.35 * fs), mat)
      shoulders.position.y = h * 0.85
      group.add(head, eye, shoulders)
      if (u.weapons.some(w => !w.tech && !(w.type === 'Melee'))) {
        const gun = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.55 * fs), new THREE.MeshStandardMaterial({ color: 0x30343c }))
        gun.position.set(0.45 * fs, h * 0.7, 0.2)
        group.add(gun)
      }
      for (const c of group.children) (c as THREE.Mesh).castShadow = true
    }
    body.castShadow = true
    group.add(body)
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.36 * fs, 0.46 * fs, 24), new THREE.MeshBasicMaterial({ color: u.side === 'player' ? 0x4fc3ff : 0xff4d4d, side: THREE.DoubleSide, transparent: true, opacity: 0.85 }))
    ring.rotation.x = -Math.PI / 2
    ring.position.y = 0.03
    group.add(ring)
    const elev = elevationAt(this.map, u, u.pos) + (u.flying ? 1 : 0)
    group.position.set(u.pos.x + fs / 2, elev * LEVEL, u.pos.y + fs / 2)
    group.rotation.y = u.side === 'player' ? Math.PI : 0
    group.traverse(o => (o.userData.unitId = u.id))
    this.scene.add(group)
    this.units.set(u.id, { group, body, ring, shown: { ...u.pos }, elev })
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
      v.y += 0.75 * Math.max(0.5, u.stats.size) + 0.9
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
    for (const u of this.battle.units) {
      if (!this.units.has(u.id)) this.addUnit(u)
      const vis = this.units.get(u.id)!
      if (!this.animating) this.placeUnit(u, u.pos)
      vis.group.visible = !u.destroyed || vis.group.visible
      ;(vis.ring.material as THREE.MeshBasicMaterial).opacity = u.activeTurn ? 1 : u.activationsLeft > 0 ? 0.85 : 0.35
      ;(vis.body.material as THREE.MeshStandardMaterial).transparent = u.statuses.some(s => s.id === 'hidden' || s.id === 'invisible')
      ;(vis.body.material as THREE.MeshStandardMaterial).opacity = u.statuses.some(s => s.id === 'hidden' || s.id === 'invisible') ? 0.45 : 1
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

  // --------------------------------------------------------------- highlights
  setHighlights(hs: Highlight[]) {
    this.highlightGroup.clear()
    for (const h of hs) {
      const mat = new THREE.MeshBasicMaterial({ color: h.color, transparent: true, opacity: h.opacity ?? 0.35, depthWrite: false })
      for (const p of h.tiles) {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(0.92, 0.92), mat)
        m.rotation.x = -Math.PI / 2
        m.position.set(p.x + 0.5, this.topY(p) + 0.03, p.y + 0.5)
        this.highlightGroup.add(m)
      }
    }
  }
  setPath(path: Pos[] | null) {
    const old = this.highlightGroup.getObjectByName('path')
    if (old) this.highlightGroup.remove(old)
    if (!path || path.length < 2) return
    const pts = path.map(p => new THREE.Vector3(p.x + 0.5, this.topY(p) + 0.12, p.y + 0.5))
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x9ae6ff, linewidth: 2 }))
    line.name = 'path'
    this.highlightGroup.add(line)
  }

  // --------------------------------------------------------------- input
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
    window.addEventListener('pointerup', () => (drag = null))
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
    while (this.animQueue.length) {
      const f = this.animQueue.shift()!
      try { await f() } catch (err) { console.error(err) }
    }
    this.animating = false
    this.syncUnits()
  }
  /** Resolves once all queued animations have played. */
  idle(): Promise<void> {
    return new Promise(res => {
      const check = () => (!this.animating && !this.animQueue.length ? res() : setTimeout(check, 30))
      check()
    })
  }
  private wait(ms: number) {
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
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([ap, tp]), new THREE.LineBasicMaterial({ color: crit ? 0xfff066 : hit ? 0xffa64d : 0x8899aa }))
    this.fxGroup.add(line)
    await this.wait(160)
    this.fxGroup.remove(line)
    if (hit) {
      const flash = new THREE.Mesh(new THREE.SphereGeometry(crit ? 0.45 : 0.3, 10, 8), new THREE.MeshBasicMaterial({ color: crit ? 0xfff066 : 0xff8c3a, transparent: true, opacity: 0.85 }))
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
    const boom = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 10), new THREE.MeshBasicMaterial({ color: 0xff7a1a, transparent: true, opacity: 0.9 }))
    boom.position.copy(vis.group.position).add(new THREE.Vector3(0, 0.5, 0))
    this.fxGroup.add(boom)
    for (let i = 0; i < 10; i++) {
      boom.scale.setScalar(1 + i * 0.6)
      ;(boom.material as THREE.MeshBasicMaterial).opacity = 0.9 - i * 0.08
      vis.group.position.y -= 0.03
      await this.wait(25)
    }
    this.fxGroup.remove(boom)
    vis.group.visible = false
    const wreck = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.15, 0.5), new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 1 }))
    wreck.position.copy(vis.group.position).add(new THREE.Vector3(0, 0.1, 0))
    this.scene.add(wreck)
  }
  private async flashTiles(tiles: Pos[], color: number) {
    const g = new THREE.Group()
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, depthWrite: false })
    for (const p of tiles) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.95), mat)
      m.rotation.x = -Math.PI / 2
      m.position.set(p.x + 0.5, this.topY(p) + 0.06, p.y + 0.5)
      g.add(m)
    }
    this.fxGroup.add(g)
    await this.wait(220)
    this.fxGroup.remove(g)
  }
  private async floatText(id: string, text: string, color: string) {
    const vis = this.units.get(id)
    if (!vis) return
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
