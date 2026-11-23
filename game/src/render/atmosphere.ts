// Per-act atmosphere around the battlefield: a gradient backdrop, a ground apron that fades into
// the fog, drifting ambient particles (dust / steam and embers / red regolith) and a few practical
// lights (windows at dusk, sodium lamps, cleanroom strips and Martian breaches).
// Everything is created once per battle view; textures are freed in dispose(), meshes go with the
// scene traversal in BattleView.dispose().
import * as THREE from 'three'
import { tileAt, type GridMap, type MapTheme } from '../rules/grid'

export interface AtmosphereLook {
  sky: [number, number, number] // backdrop gradient: top, horizon, bottom
  apron: number
  particles: { count: number; colors: number[]; hdr: number; size: number; drift: [number, number, number]; rise: number; opacity: number }
  lamps: { color: number; intensity: number; distance: number }
}

export const ATMOSPHERE: Record<MapTheme, AtmosphereLook> = {
  outskirts: {
    sky: [0x3a2030, 0x1d1a22, 0x0c0d11], apron: 0x4a4a38,
    particles: { count: 240, colors: [0xffe0b0, 0xd8c8a8], hdr: 1.1, size: 2.4, drift: [0.22, 0, 0.1], rise: 0.03, opacity: 0.55 },
    lamps: { color: 0xffb060, intensity: 7, distance: 6 },
  },
  industrial: {
    sky: [0x3a2408, 0x1a1208, 0x080706], apron: 0x4a3c28,
    particles: { count: 300, colors: [0xff8a2a, 0xffb347, 0xcfc8bc, 0xcfc8bc], hdr: 2.2, size: 2.6, drift: [0.08, 0, 0.05], rise: 0.28, opacity: 0.7 },
    lamps: { color: 0xff9a32, intensity: 14, distance: 9 },
  },
  cleanroom: {
    sky: [0x1e2a36, 0x141a22, 0x2a0e0a], apron: 0x6a3a28,
    particles: { count: 320, colors: [0xd2683a, 0xb0482a, 0xe08a5a], hdr: 1.3, size: 2.2, drift: [0.45, 0, 0.18], rise: 0.0, opacity: 0.6 },
    lamps: { color: 0x9fe8ff, intensity: 4, distance: 6 },
  },
}

function gradientTexture(stops: [number, number, number]): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 4; c.height = 256
  const g = c.getContext('2d')!
  const grad = g.createLinearGradient(0, 0, 0, 256)
  const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`
  grad.addColorStop(0, hex(stops[0])); grad.addColorStop(0.55, hex(stops[1])); grad.addColorStop(1, hex(stops[2]))
  g.fillStyle = grad
  g.fillRect(0, 0, 4, 256)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

/** Soft round sprite (particles, contact shadows). */
export function radialTexture(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)'): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  grad.addColorStop(0, inner); grad.addColorStop(1, outer)
  g.fillStyle = grad
  g.fillRect(0, 0, 64, 64)
  return new THREE.CanvasTexture(c)
}

export class Atmosphere {
  private textures: THREE.Texture[] = []
  private points: THREE.Points
  private vel: Float32Array
  private lights: THREE.Object3D[] = []
  private bounds: { w: number; h: number; top: number }
  private lamps: THREE.PointLight[] = []
  private lampBase: number[] = []

  constructor(scene: THREE.Scene, private map: GridMap, theme: MapTheme, level: number) {
    const look = ATMOSPHERE[theme]
    const sky = gradientTexture(look.sky)
    this.textures.push(sky)
    scene.background = sky

    // ground apron: the map no longer floats in a void
    // (radial falloff: lit near the battlefield, dark at the edges of the world)
    const fall = radialTexture('rgba(255,255,255,1)', 'rgba(0,0,0,1)')
    fall.colorSpace = THREE.SRGBColorSpace
    this.textures.push(fall)
    const span = Math.max(map.w, map.h) * 2.6
    const apron = new THREE.Mesh(new THREE.PlaneGeometry(span, span), new THREE.MeshStandardMaterial({ color: look.apron, map: fall, roughness: 1 }))
    apron.rotation.x = -Math.PI / 2
    apron.position.set(map.w / 2, -0.41, map.h / 2)
    apron.receiveShadow = true
    scene.add(apron)

    // ambient particles
    const p = look.particles
    this.bounds = { w: map.w, h: map.h, top: 5 }
    const pos = new Float32Array(p.count * 3)
    const col = new Float32Array(p.count * 3)
    this.vel = new Float32Array(p.count * 3)
    const rnd = mulberry(map.w * 7919 + map.h * 104729)
    const c = new THREE.Color()
    for (let i = 0; i < p.count; i++) {
      pos[i * 3] = rnd() * map.w; pos[i * 3 + 1] = rnd() * this.bounds.top; pos[i * 3 + 2] = rnd() * map.h
      const k = (rnd() * p.colors.length) | 0
      c.setHex(p.colors[k]).multiplyScalar(k < 2 ? p.hdr : 1) // the first colours are the bright ones (embers)
      col.set([c.r, c.g, c.b], i * 3)
      const j = 0.5 + rnd()
      this.vel[i * 3] = p.drift[0] * j; this.vel[i * 3 + 1] = p.rise * (0.4 + rnd()); this.vel[i * 3 + 2] = p.drift[2] * j
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
    const sprite = radialTexture()
    this.textures.push(sprite)
    this.points = new THREE.Points(geo, new THREE.PointsMaterial({
      size: p.size * Math.min(2, window.devicePixelRatio || 1), map: sprite, vertexColors: true, transparent: true, opacity: p.opacity,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: false, toneMapped: true,
    }))
    this.points.frustumCulled = false
    scene.add(this.points)

    // practical lights, placed deterministically
    const spots = this.lampSpots(theme)
    const headGeo = new THREE.SphereGeometry(0.07, 8, 6)
    for (const s of spots) {
      const light = new THREE.PointLight(s.color, look.lamps.intensity * s.k, look.lamps.distance, 1.6)
      light.position.set(s.x + 0.5, s.h * level + s.lift, s.y + 0.5)
      scene.add(light)
      this.lamps.push(light)
      this.lampBase.push(light.intensity)
      const head = new THREE.Mesh(headGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(s.color).multiplyScalar(4) }))
      head.position.copy(light.position)
      scene.add(head)
      this.lights.push(light, head)
    }
  }

  private lampSpots(theme: MapTheme): { x: number; y: number; h: number; lift: number; color: number; k: number }[] {
    const look = ATMOSPHERE[theme]
    const cand: { x: number; y: number; h: number; lift: number; color: number; k: number; score: number }[] = []
    for (let y = 0; y < this.map.h; y++) for (let x = 0; x < this.map.w; x++) {
      const t = tileAt(this.map, { x, y })!
      const score = (x * 928371 + y * 1237) % 101
      if (theme === 'outskirts' && t.kind === 'block' && t.h >= 2) cand.push({ x, y, h: t.h, lift: 0.5, color: look.lamps.color, k: 1, score })
      if (theme === 'industrial' && t.kind === 'block' && t.h >= 3) cand.push({ x, y, h: t.h, lift: 1.1, color: look.lamps.color, k: 1, score })
      if (theme === 'cleanroom') {
        if (t.skin === 'mars' && t.kind === 'hazard') cand.push({ x, y, h: t.h, lift: 0.4, color: 0xff4a1a, k: 1.2, score: score + 200 })
        else if (t.skin !== 'mars' && t.kind === 'block' && t.h >= 2) cand.push({ x, y, h: t.h, lift: 0.6, color: look.lamps.color, k: 1, score })
      }
    }
    cand.sort((a, b) => b.score - a.score)
    const out: typeof cand = []
    for (const c of cand) {
      if (out.length >= 6) break
      if (out.every(o => Math.abs(o.x - c.x) + Math.abs(o.y - c.y) >= 7)) out.push(c)
    }
    return out
  }

  /** Turn the costly parts on or off (quality setting). */
  setEnabled(on: boolean) {
    this.points.visible = on
    for (const l of this.lights) l.visible = on
  }

  update(dt: number, time: number, slow: boolean) {
    if (!this.points.visible) return
    const k = slow ? 0.3 : 1
    const attr = this.points.geometry.getAttribute('position') as THREE.BufferAttribute
    const a = attr.array as Float32Array
    const { w, h, top } = this.bounds
    for (let i = 0; i < a.length; i += 3) {
      a[i] += (this.vel[i] + Math.sin(time * 0.6 + i) * 0.05) * dt * k
      a[i + 1] += this.vel[i + 1] * dt * k
      a[i + 2] += this.vel[i + 2] * dt * k
      if (a[i] > w) a[i] -= w; else if (a[i] < 0) a[i] += w
      if (a[i + 2] > h) a[i + 2] -= h; else if (a[i + 2] < 0) a[i + 2] += h
      if (a[i + 1] > top) a[i + 1] = 0
    }
    attr.needsUpdate = true
    // lamps breathe a little (sodium flicker)
    if (!slow) for (let i = 0; i < this.lamps.length; i++) this.lamps[i].intensity = this.lampBase[i] * (1 + Math.sin(time * 3.1 + i * 1.7) * Math.sin(time * 7.3 + i) * 0.06)
  }

  dispose() {
    for (const t of this.textures) t.dispose()
    this.textures = []
  }
}

/** Small seeded PRNG for cosmetic placement (never touches the battle's RNG). */
export function mulberry(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
