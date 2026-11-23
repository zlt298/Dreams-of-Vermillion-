// Combat effects for the battle view, driven only by BattleEvents and unit state (never by the rules
// RNG, so replays stay exact). Everything is pooled: a spark pool, a smoke pool, one projectile, one
// beam, one slash arc and one muzzle light are allocated per view and reused.
// Meshes live in the view's fxGroup and are freed by BattleView.dispose()'s scene traversal; the
// canvas textures made here are freed by FX.dispose().
import * as THREE from 'three'
import type { Unit, Weapon } from '../rules/types'
import { radialTexture } from './atmosphere'

export interface FxHost {
  fxGroup: THREE.Group
  wait(ms: number): Promise<void>
  readonly skipping: boolean
  readonly slowMotion: boolean
  shake(amount: number, ms: number): void
}

export type AttackStyle = 'ballistic' | 'cannon' | 'missile' | 'beam' | 'melee' | 'tech'

/** How an attack should look, from the weapon's type, tags and damage. */
export function attackStyle(w: Weapon | undefined): AttackStyle {
  if (!w) return 'ballistic'
  if (w.tech) return 'tech'
  const pr = w.profiles[w.profileIndex] ?? w.profiles[0]
  const tags = new Set(pr?.tags.map(t => t.id) ?? [])
  if (w.type === 'Melee') return 'melee'
  if (w.type === 'Launcher' || tags.has('tg_arcing') || tags.has('tg_seeking')) return 'missile'
  if (w.type === 'Nexus' || pr?.damage.some(d => d.type === 'Energy') || tags.has('tg_smart')) return 'beam'
  if (w.type === 'Cannon' || w.size === 'Heavy' || w.size === 'Superheavy') return 'cannon'
  return 'ballistic'
}

const STYLE_COLOR: Record<AttackStyle, number> = { ballistic: 0xffb35c, cannon: 0xff8a3a, missile: 0xffd27a, beam: 0x7ff3ff, melee: 0xfff1c0, tech: 0xc58cff }

/** A pool of additive point particles with velocity, gravity and lifetime. */
class ParticlePool {
  points: THREE.Points
  private pos: Float32Array
  private col: Float32Array
  private base: Float32Array
  private vel: Float32Array
  private life: Float32Array
  private max: Float32Array
  private grav: Float32Array
  private next = 0
  constructor(readonly n: number, size: number, tex: THREE.Texture, blending: THREE.Blending, opacity = 1) {
    this.pos = new Float32Array(n * 3).fill(-999)
    this.col = new Float32Array(n * 3)
    this.base = new Float32Array(n * 3)
    this.vel = new Float32Array(n * 3)
    this.life = new Float32Array(n)
    this.max = new Float32Array(n).fill(1)
    this.grav = new Float32Array(n)
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3))
    this.points = new THREE.Points(geo, new THREE.PointsMaterial({
      size: size * Math.min(2, window.devicePixelRatio || 1), map: tex, vertexColors: true, transparent: true, opacity,
      depthWrite: false, blending, sizeAttenuation: false,
    }))
    this.points.frustumCulled = false
  }
  emit(at: THREE.Vector3, count: number, color: THREE.Color, speed: number, life: number, gravity: number, spread = 1, up = 0) {
    for (let k = 0; k < count; k++) {
      const i = this.next
      this.next = (this.next + 1) % this.n
      const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1)
      const v = speed * (0.4 + Math.random() * 0.6)
      this.pos.set([at.x, at.y, at.z], i * 3)
      this.vel.set([Math.sin(ph) * Math.cos(th) * v * spread, Math.abs(Math.cos(ph)) * v + up, Math.sin(ph) * Math.sin(th) * v * spread], i * 3)
      this.base.set([color.r, color.g, color.b], i * 3)
      this.life[i] = this.max[i] = life * (0.6 + Math.random() * 0.4)
      this.grav[i] = gravity
    }
  }
  update(dt: number) {
    let any = false
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) continue
      any = true
      this.life[i] -= dt
      const j = i * 3
      if (this.life[i] <= 0) { this.pos[j + 1] = -999; continue }
      this.vel[j + 1] -= this.grav[i] * dt
      this.vel[j] *= 1 - 1.5 * dt; this.vel[j + 2] *= 1 - 1.5 * dt
      this.pos[j] += this.vel[j] * dt; this.pos[j + 1] += this.vel[j + 1] * dt; this.pos[j + 2] += this.vel[j + 2] * dt
      const f = this.life[i] / this.max[i]
      this.col[j] = this.base[j] * f; this.col[j + 1] = this.base[j + 1] * f; this.col[j + 2] = this.base[j + 2] * f
    }
    if (any) {
      this.points.geometry.getAttribute('position').needsUpdate = true
      this.points.geometry.getAttribute('color').needsUpdate = true
    }
  }
}

interface Debris { mesh: THREE.Mesh; vel: THREE.Vector3; spin: THREE.Vector3; floor: number; settled: boolean }
interface Emitter { pos: THREE.Vector3; until: number; every: number; acc: number; kind: 'smoke' | 'embers' }
interface UnitFx { bubble?: THREE.Mesh; reticle?: THREE.Sprite; burnAcc: number; crackleAcc: number }

export class FX {
  private textures: THREE.Texture[] = []
  private sparks: ParticlePool
  private smoke: ParticlePool
  private projectile: THREE.Mesh
  private streak: THREE.Mesh
  private beam: THREE.Mesh
  private slash: THREE.Mesh
  private fireball: THREE.Sprite
  private shock: THREE.Mesh
  private muzzle: THREE.PointLight
  private muzzleUntil = 0
  private debris: Debris[] = []
  private emitters: Emitter[] = []
  private perUnit = new Map<string, UnitFx>()
  private bubbleGeo = new THREE.SphereGeometry(0.62, 18, 12)
  private bubbleMat: THREE.ShaderMaterial
  private reticleMat: THREE.SpriteMaterial
  private debrisGeo = new THREE.BoxGeometry(0.12, 0.08, 0.1)
  private debrisMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2c, roughness: 0.9, emissive: 0x3a1000, emissiveIntensity: 0.6 })
  private scorch: THREE.InstancedMesh
  private scorched = new Set<string>()
  private dummy = new THREE.Object3D()
  private time = 0
  private c = new THREE.Color()

  constructor(private host: FxHost, mapTiles: number) {
    const dot = radialTexture()
    const puff = radialTexture('rgba(255,255,255,0.9)', 'rgba(255,255,255,0)')
    const scorchTex = radialTexture('rgba(10,6,4,0.85)', 'rgba(10,6,4,0)')
    this.textures.push(dot, puff, scorchTex)
    this.sparks = new ParticlePool(384, 3.2, dot, THREE.AdditiveBlending)
    this.smoke = new ParticlePool(256, 14, puff, THREE.NormalBlending, 0.42)
    const g = host.fxGroup
    g.add(this.sparks.points, this.smoke.points)

    const hot = (hex: number, k: number) => new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(k), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
    this.projectile = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), hot(0xffd27a, 4))
    this.streak = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.006, 1, 6, 1, true).rotateX(Math.PI / 2).translate(0, 0, -0.5), hot(0xffb35c, 3))
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1, 8, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.5), hot(0x7ff3ff, 3.5))
    this.slash = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.035, 4, 24, Math.PI * 0.9), hot(0xfff1c0, 4))
    const fire = fireTexture()
    this.textures.push(fire)
    this.fireball = new THREE.Sprite(new THREE.SpriteMaterial({ map: fire, color: new THREE.Color(1, 1, 1).multiplyScalar(2.2), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }))
    this.shock = new THREE.Mesh(new THREE.RingGeometry(0.93, 1, 48).rotateX(-Math.PI / 2), hot(0xffa860, 1.6))
    for (const m of [this.projectile, this.streak, this.beam, this.slash, this.fireball, this.shock]) { m.visible = false; m.frustumCulled = false; g.add(m) }
    this.muzzle = new THREE.PointLight(0xffb35c, 0, 5, 1.5)
    g.add(this.muzzle)

    this.bubbleMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { color: { value: new THREE.Color(0x6fd8ff).multiplyScalar(1.6) }, time: { value: 0 } },
      vertexShader: `varying vec3 vN; varying float vY; void main() { vN = normalize(normalMatrix * normal); vY = position.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform vec3 color; uniform float time; varying vec3 vN; varying float vY;
        void main() { float rim = pow(1.0 - abs(vN.z), 2.2); float band = 0.5 + 0.5 * sin(vY * 30.0 - time * 3.0);
          gl_FragColor = vec4(color * (rim * 0.9 + band * 0.08), rim * 0.75 + 0.05); }`,
    })
    const ret = reticleTexture()
    this.textures.push(ret)
    this.reticleMat = new THREE.SpriteMaterial({ map: ret, color: new THREE.Color(0xff4a3a).multiplyScalar(1.8), transparent: true, depthTest: false, depthWrite: false })

    this.scorch = new THREE.InstancedMesh(new THREE.PlaneGeometry(1.3, 1.3).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: scorchTex, transparent: true, depthWrite: false, toneMapped: false }), mapTiles)
    this.scorch.count = 0
    this.scorch.frustumCulled = false
    this.scorch.renderOrder = -1
    g.add(this.scorch)
  }

  // ----------------------------------------------------------------- per-frame
  update(dt: number) {
    this.time += dt
    this.sparks.update(dt)
    this.smoke.update(dt)
    if (this.muzzle.intensity > 0 && this.time > this.muzzleUntil) this.muzzle.intensity = Math.max(0, this.muzzle.intensity - dt * 120)
    for (const d of this.debris) {
      if (d.settled) continue
      d.vel.y -= 9 * dt
      d.mesh.position.addScaledVector(d.vel, dt)
      d.mesh.rotation.x += d.spin.x * dt; d.mesh.rotation.y += d.spin.y * dt
      if (d.mesh.position.y <= d.floor) { d.mesh.position.y = d.floor; d.settled = true }
    }
    for (const e of this.emitters) {
      if (this.time > e.until) continue
      e.acc += dt
      if (e.acc < e.every) continue
      e.acc = 0
      if (e.kind === 'smoke') this.smoke.emit(e.pos, 1, this.c.setHex(0x3a3634), 0.25, 3.2, -0.25, 0.4, 0.45)
      else this.sparks.emit(e.pos, 1, this.c.setHex(0xff6a1a).multiplyScalar(2), 0.4, 0.9, -0.6, 0.6, 0.3)
    }
    this.bubbleMat.uniforms.time.value = this.time
    this.reticleMat.rotation = this.host.slowMotion ? 0 : this.time * 0.9
  }

  // ----------------------------------------------------------------- attacks
  async attack(a: THREE.Group, from: THREE.Vector3, to: THREE.Vector3, style: AttackStyle, hit: boolean, crit: boolean) {
    const host = this.host
    const color = this.c.setHex(STYLE_COLOR[style])
    if (style !== 'melee' && style !== 'tech') this.flashMuzzle(from, STYLE_COLOR[style])
    if (style === 'melee') {
      const home = a.position.clone()
      const dir = to.clone().sub(from).setY(0).normalize()
      for (let s = 1; s <= 4; s++) { a.position.copy(home).addScaledVector(dir, 0.09 * s); await host.wait(16) }
      this.slash.position.copy(to)
      this.slash.lookAt(from)
      this.slash.rotation.z = Math.random() * Math.PI
      this.slash.visible = true
      for (let s = 0; s < 5; s++) { this.slash.rotation.z += 0.45; this.slash.scale.setScalar(0.7 + s * 0.12); await host.wait(18) }
      this.slash.visible = false
      for (let s = 3; s >= 0; s--) { a.position.copy(home).addScaledVector(dir, 0.09 * s); await host.wait(16) }
    } else if (style === 'beam' || style === 'tech') {
      const len = from.distanceTo(to)
      this.beam.position.copy(from)
      this.beam.lookAt(to)
      ;(this.beam.material as THREE.MeshBasicMaterial).color.setHex(STYLE_COLOR[style]).multiplyScalar(3.5)
      this.beam.visible = true
      for (let s = 0; s < 6; s++) {
        const w = style === 'tech' ? 0.5 : (1 - s / 6) * (crit ? 2 : 1.3)
        this.beam.scale.set(w, w, len)
        if (style === 'tech') this.beam.scale.set(0.4 + Math.random() * 0.4, 0.4 + Math.random() * 0.4, len)
        await host.wait(26)
      }
      this.beam.visible = false
    } else if (style === 'missile') {
      const mid = from.clone().lerp(to, 0.5)
      mid.y += Math.max(1.5, from.distanceTo(to) * 0.35)
      const p = new THREE.Vector3(), q = new THREE.Vector3()
      this.projectile.visible = true
      const steps = 14
      for (let s = 1; s <= steps; s++) {
        const t = s / steps
        q.copy(p)
        p.copy(from).multiplyScalar((1 - t) * (1 - t)).addScaledVector(mid, 2 * (1 - t) * t).addScaledVector(to, t * t)
        this.projectile.position.copy(p)
        if (!host.skipping) this.smoke.emit(p, 1, this.c.setHex(0x8a8580), 0.12, 1.4, -0.2, 0.3)
        await host.wait(20)
      }
      this.projectile.visible = false
    } else {
      // ballistic / cannon: bright head with a streak behind it
      const dir = to.clone().sub(from)
      const len = dir.length()
      const steps = style === 'cannon' ? 6 : 5
      const thick = style === 'cannon' ? 2.2 : 1
      ;(this.streak.material as THREE.MeshBasicMaterial).color.copy(color).multiplyScalar(3)
      this.projectile.visible = this.streak.visible = true
      this.projectile.scale.setScalar(thick)
      for (let s = 1; s <= steps; s++) {
        const t = s / steps
        this.projectile.position.copy(from).addScaledVector(dir, t)
        this.streak.position.copy(this.projectile.position)
        this.streak.lookAt(to.x + dir.x, to.y + dir.y, to.z + dir.z)
        this.streak.scale.set(thick, thick, Math.min(len * t, 1.6))
        await host.wait(18)
      }
      this.projectile.visible = this.streak.visible = false
      this.projectile.scale.setScalar(1)
    }
    if (hit) {
      this.sparks.emit(to, crit ? 46 : style === 'cannon' ? 30 : 18, this.c.setHex(crit ? 0xfff066 : STYLE_COLOR[style]).multiplyScalar(3), crit ? 3.4 : 2.4, 0.5, 6)
      if (style === 'cannon' || style === 'missile' || crit) this.smoke.emit(to, crit ? 6 : 3, this.c.setHex(0x4a4440), 0.6, 1.6, -0.3, 1, 0.3)
      if (crit) { host.shake(0.18, 220); await host.wait(60) }
    } else {
      this.sparks.emit(to, 5, this.c.setHex(0x9fb3c8).multiplyScalar(1.5), 1.2, 0.3, 4)
    }
  }

  flashMuzzle(at: THREE.Vector3, color: number) {
    this.muzzle.position.copy(at)
    this.muzzle.color.setHex(color)
    this.muzzle.intensity = 18
    this.muzzleUntil = this.time + 0.06
    this.sparks.emit(at, 6, this.c.setHex(color).multiplyScalar(3), 1.4, 0.18, 0, 0.8)
  }

  /** Structure / stress damage on a unit. */
  hurt(at: THREE.Vector3, kind: 'structure' | 'stress' | 'heat') {
    if (kind === 'structure') {
      this.sparks.emit(at, 30, this.c.setHex(0xffe08a).multiplyScalar(3), 3, 0.7, 7)
      this.smoke.emit(at, 4, this.c.setHex(0x2e2a28), 0.5, 2, -0.3, 1, 0.4)
      this.host.shake(0.14, 200)
    } else if (kind === 'stress') {
      this.smoke.emit(at, 8, this.c.setHex(0xd8d4cc), 0.9, 1.4, -0.6, 0.8, 0.8)
      this.sparks.emit(at, 10, this.c.setHex(0xff8a2a).multiplyScalar(2.5), 1.5, 0.6, 2)
    } else {
      this.smoke.emit(at, 2, this.c.setHex(0xbfb8ae), 0.5, 1, -0.5, 0.6, 0.6)
    }
  }

  /** Movement dust at a footfall. */
  footstep(at: THREE.Vector3, color: number) {
    this.smoke.emit(at, 2, this.c.setHex(color), 0.35, 0.9, -0.1, 1.4, 0.05)
  }

  // ----------------------------------------------------------------- destruction
  async explode(at: THREE.Vector3, size: number, floor: number) {
    const host = this.host
    this.flashMuzzle(at, 0xff8a3a)
    this.muzzle.intensity = 40
    this.sparks.emit(at, 60, this.c.setHex(0xffb347).multiplyScalar(3), 4 * size, 0.9, 5)
    this.smoke.emit(at, 14, this.c.setHex(0x2a2624), 0.9 * size, 2.8, -0.35, 1, 0.5)
    for (let i = 0; i < 8; i++) {
      const mesh = new THREE.Mesh(this.debrisGeo, this.debrisMat)
      mesh.position.copy(at)
      mesh.castShadow = true
      const ang = Math.random() * Math.PI * 2
      const sp = 1.5 + Math.random() * 2.2
      this.debris.push({ mesh, vel: new THREE.Vector3(Math.cos(ang) * sp, 2.5 + Math.random() * 2.5, Math.sin(ang) * sp), spin: new THREE.Vector3(Math.random() * 9, Math.random() * 9, 0), floor: floor + 0.04, settled: false })
      host.fxGroup.add(mesh)
    }
    const fbm = this.fireball.material as THREE.SpriteMaterial
    const shm = this.shock.material as THREE.MeshBasicMaterial
    this.fireball.position.copy(at)
    this.shock.position.set(at.x, floor + 0.06, at.z)
    this.fireball.visible = this.shock.visible = true
    host.shake(0.25 * size, 320)
    for (let i = 0; i < 12; i++) {
      const t = i / 11
      const sc = size * (0.8 + Math.sqrt(t) * 2.2)
      this.fireball.scale.set(sc, sc, 1)
      this.fireball.material.rotation = t * 0.6
      fbm.opacity = (1 - t) * (1 - t)
      this.shock.scale.setScalar(size * (0.3 + t * 2.6))
      shm.opacity = 0.7 * (1 - t) * (1 - t)
      await host.wait(24)
    }
    this.fireball.visible = this.shock.visible = false
    // the wreck smoulders for a while
    this.emitters.push({ pos: at.clone().setY(floor + 0.3), until: this.time + 45, every: 0.35, acc: 0, kind: 'smoke' })
    this.emitters.push({ pos: at.clone().setY(floor + 0.15), until: this.time + 20, every: 0.5, acc: 0, kind: 'embers' })
    if (this.emitters.length > 40) this.emitters.splice(0, this.emitters.length - 40)
  }

  /** Area explosion (Blast, mines, charges): a flash and ring at the centre, scorch on every tile. */
  areaBlast(centre: THREE.Vector3, tiles: { x: number; y: number; top: number }[]) {
    this.sparks.emit(centre, 30, this.c.setHex(0xffa040).multiplyScalar(3), 3, 0.6, 5)
    this.smoke.emit(centre, 8, this.c.setHex(0x2e2a28), 0.8, 2.2, -0.3, 1, 0.4)
    this.flashMuzzle(centre, 0xff7b29)
    this.muzzle.intensity = 30
    for (const t of tiles) {
      const k = `${t.x},${t.y}`
      if (this.scorched.has(k) || this.scorch.count >= this.scorch.instanceMatrix.count) continue
      this.scorched.add(k)
      this.dummy.position.set(t.x + 0.5, t.top + 0.012, t.y + 0.5)
      this.dummy.rotation.set(0, (t.x * 7 + t.y * 13) % 6, 0)
      this.dummy.updateMatrix()
      this.scorch.setMatrixAt(this.scorch.count++, this.dummy.matrix)
    }
    this.scorch.instanceMatrix.needsUpdate = true
  }

  // ----------------------------------------------------------------- persistent unit state
  /** Heat glow, burning, overshield bubble, Lock On reticle, Stunned/Jammed crackle. */
  syncUnit(u: Unit, group: THREE.Group, height: number, dark: THREE.MeshStandardMaterial | undefined, dt: number) {
    let f = this.perUnit.get(u.id)
    if (!f) { f = { burnAcc: 0, crackleAcc: 0 }; this.perUnit.set(u.id, f) }
    const alive = !u.destroyed && group.visible
    // heat: the dark plating glows orange, then white, as heat nears the cap
    if (dark) {
      const h = u.stats.heatcap ? Math.min(1, Math.max(0, u.heat / u.stats.heatcap)) : 0
      const glow = alive ? Math.max(0, h - 0.25) / 0.75 : 0
      if (glow > 0) {
        dark.emissive.setHex(0xff3a08).lerp(this.c.setHex(0xffd27a), glow * glow)
        dark.emissiveIntensity = glow * (1.6 + (this.host.slowMotion ? 0 : Math.sin(this.time * 6) * 0.25))
      } else if (dark.emissiveIntensity !== 0) dark.emissiveIntensity = 0
    }
    const os = alive && u.overshield > 0
    if (os && !f.bubble) { f.bubble = new THREE.Mesh(this.bubbleGeo, this.bubbleMat); f.bubble.renderOrder = 2; group.add(f.bubble) }
    if (f.bubble) {
      f.bubble.visible = os
      const s = Math.max(1, height * 0.9)
      f.bubble.scale.set(s, s * 1.05, s)
      f.bubble.position.y = height * 0.5
    }
    const locked = alive && u.statuses.some(s => s.id === 'lockon')
    if (locked && !f.reticle) { f.reticle = new THREE.Sprite(this.reticleMat); f.reticle.renderOrder = 3; group.add(f.reticle) }
    if (f.reticle) {
      f.reticle.visible = locked
      f.reticle.position.y = height * 0.55
      const s = 0.9 + Math.max(0.6, height * 0.5) + (this.host.slowMotion ? 0 : Math.sin(this.time * 4) * 0.05)
      f.reticle.scale.set(s, s, 1)
    }
    if (!alive) return
    const at = group.position
    if (u.burn > 0) {
      f.burnAcc += dt
      if (f.burnAcc > 0.09) {
        f.burnAcc = 0
        this.c.setHex(Math.random() < 0.5 ? 0xff5a14 : 0xffb347).multiplyScalar(2.6)
        this.sparks.emit(new THREE.Vector3(at.x + (Math.random() - 0.5) * 0.5, at.y + height * (0.2 + Math.random() * 0.6), at.z + (Math.random() - 0.5) * 0.5), 1, this.c, 0.3, 0.7, -1.4, 0.3)
      }
    }
    if (u.statuses.some(s => s.id === 'stunned' || s.id === 'jammed')) {
      f.crackleAcc += dt
      if (f.crackleAcc > 0.7 + Math.random()) {
        f.crackleAcc = 0
        this.sparks.emit(new THREE.Vector3(at.x, at.y + height * 0.7, at.z), 7, this.c.setHex(0x9fd8ff).multiplyScalar(3), 1.6, 0.25, 0, 1)
      }
    }
  }

  dispose() {
    for (const t of this.textures) t.dispose()
    this.textures = []
    this.bubbleGeo.dispose(); this.bubbleMat.dispose(); this.reticleMat.dispose()
    this.debrisGeo.dispose(); this.debrisMat.dispose()
    this.scorch.dispose()
    this.perUnit.clear()
    this.debris = []
    this.emitters = []
  }
}

/** Lock On reticle: four brackets and a centre tick, drawn once. */
function reticleTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')!
  g.strokeStyle = '#fff'
  g.lineWidth = 6
  g.lineCap = 'square'
  for (let i = 0; i < 4; i++) {
    g.save(); g.translate(64, 64); g.rotate((i * Math.PI) / 2)
    g.beginPath(); g.moveTo(-44, -26); g.lineTo(-44, -44); g.lineTo(-26, -44); g.stroke()
    g.beginPath(); g.moveTo(0, -54); g.lineTo(0, -40); g.stroke()
    g.restore()
  }
  g.beginPath(); g.arc(64, 64, 4, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill()
  return new THREE.CanvasTexture(c)
}

/** Fireball sprite: white-hot core, orange body, smoky red edge. */
function fireTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64)
  grad.addColorStop(0, 'rgba(255,250,220,1)')
  grad.addColorStop(0.25, 'rgba(255,190,90,0.95)')
  grad.addColorStop(0.55, 'rgba(240,90,20,0.6)')
  grad.addColorStop(0.8, 'rgba(120,30,10,0.2)')
  grad.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, 128, 128)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}
