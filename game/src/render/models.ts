// Procedural low-poly unit models. Every unit is assembled from a handful of shared primitive
// geometries; its silhouette comes from manufacturer (player mechs), role (NPCs), size, templates
// and the weapons it actually carries. Only two materials per unit are unique (paint + dark), so
// hidden/invisible fading can change them without touching other units.
import * as THREE from 'three'
import { Lancer } from '../data/lancer'
import type { Unit, Weapon } from '../rules/types'

const G = {
  box: new THREE.BoxGeometry(1, 1, 1),
  cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 8),
  cylHex: new THREE.CylinderGeometry(0.5, 0.5, 1, 6),
  cone: new THREE.ConeGeometry(0.5, 1, 6),
  sphere: new THREE.SphereGeometry(0.5, 10, 8),
  oct: new THREE.OctahedronGeometry(0.5),
  tet: new THREE.TetrahedronGeometry(0.5),
}
export const MODEL_GEOMETRIES = new Set<THREE.BufferGeometry>(Object.values(G))

export type Archetype = 'gms' | 'ipsn' | 'ssc' | 'horus' | 'ha' | 'striker' | 'defender' | 'artillery' | 'controller' | 'support' | 'biological' | 'drone' | 'deployable'

interface Palette { paint: number; dark: number; trim: number; glow: number }

const MANUFACTURER: Record<string, { arch: Archetype; paint: number; trim: number }> = {
  GMS: { arch: 'gms', paint: 0x8d927f, trim: 0xd8d4c4 },
  'IPS-N': { arch: 'ipsn', paint: 0x55698f, trim: 0xd9cfb0 },
  SSC: { arch: 'ssc', paint: 0xd9d2c0, trim: 0xc9a23f },
  HORUS: { arch: 'horus', paint: 0x23262b, trim: 0x5bd16f },
  HA: { arch: 'ha', paint: 0x7a1f24, trim: 0xc89b3c },
}

export function archetypeOf(u: Unit): Archetype {
  if (u.kind === 'drone') return 'drone'
  if (u.kind === 'deployable') return 'deployable'
  if (u.kind === 'mech') return MANUFACTURER[Lancer.frames.get(u.frameId ?? '')?.source ?? 'GMS']?.arch ?? 'gms'
  switch (u.role) {
    case 'Defender': return 'defender'
    case 'Artillery': return 'artillery'
    case 'Controller': return 'controller'
    case 'Support': return 'support'
    case 'Biological': return 'biological'
    default: return 'striker'
  }
}

function paletteOf(u: Unit): Palette {
  const glow = u.side === 'player' ? 0x7ff3ff : 0xff5040
  if (u.kind === 'mech') {
    const m = MANUFACTURER[Lancer.frames.get(u.frameId ?? '')?.source ?? 'GMS'] ?? MANUFACTURER.GMS
    return { paint: m.paint, dark: 0x22262d, trim: u.side === 'player' ? 0x4fc3ff : m.trim, glow }
  }
  const c = u.color ? new THREE.Color(u.color).getHex() : 0xd9534f
  return { paint: c, dark: 0x1f2126, trim: 0xe8e2d0, glow }
}

/** Material helper: per-model unique paint/dark, shared accents from the caller's cache. */
export interface ModelMaterials {
  shared(key: string, make: () => THREE.Material): THREE.Material
}

export interface UnitModel {
  group: THREE.Group
  /** materials owned by this model (paint/dark) — safe to fade for hidden/invisible */
  own: THREE.MeshStandardMaterial[]
  height: number
}

class Builder {
  group = new THREE.Group()
  constructor(private mats: ModelMaterials, readonly paint: THREE.MeshStandardMaterial, readonly dark: THREE.MeshStandardMaterial, readonly pal: Palette) {}
  glow(): THREE.Material {
    return this.mats.shared(`glow:${this.pal.glow}`, () => new THREE.MeshBasicMaterial({ color: this.pal.glow }))
  }
  trim(): THREE.Material {
    return this.mats.shared(`trim:${this.pal.trim}`, () => new THREE.MeshStandardMaterial({ color: this.pal.trim, roughness: 0.5, metalness: 0.4 }))
  }
  metal(): THREE.Material {
    return this.mats.shared('metal', () => new THREE.MeshStandardMaterial({ color: 0x3a3f47, roughness: 0.4, metalness: 0.7 }))
  }
  part(geo: THREE.BufferGeometry, mat: THREE.Material, sx: number, sy: number, sz: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, parent: THREE.Object3D = this.group): THREE.Mesh {
    const m = new THREE.Mesh(geo, mat)
    m.scale.set(sx, sy, sz)
    m.position.set(x, y, z)
    m.rotation.set(rx, ry, rz)
    m.castShadow = true
    parent.add(m)
    return m
  }
}

/** Weapon prop attached to an arm socket, pointing forward (+z). */
function weaponProp(b: Builder, w: Weapon | undefined, side: 1 | -1, x: number, y: number, s: number, tech = false) {
  const z = 0.12 * s
  if (tech) {
    b.part(G.cyl, b.metal(), 0.03 * s, 0.5 * s, 0.03 * s, x, y + 0.3 * s, 0)
    b.part(G.sphere, b.glow(), 0.07 * s, 0.07 * s, 0.07 * s, x, y + 0.56 * s, 0)
    return
  }
  const type = w?.type ?? 'Rifle'
  switch (type) {
    case 'Melee':
      b.part(G.box, b.trim(), 0.05 * s, 0.07 * s, 0.75 * s, x, y - 0.05 * s, z + 0.3 * s)
      b.part(G.box, b.metal(), 0.1 * s, 0.1 * s, 0.12 * s, x, y - 0.05 * s, z - 0.05 * s)
      break
    case 'Cannon':
      b.part(G.cyl, b.metal(), 0.14 * s, 0.75 * s, 0.14 * s, x, y, z + 0.3 * s, Math.PI / 2)
      b.part(G.box, b.dark, 0.2 * s, 0.2 * s, 0.3 * s, x, y, z)
      break
    case 'Launcher':
      b.part(G.box, b.dark, 0.3 * s, 0.24 * s, 0.34 * s, x, y + 0.08 * s, z + 0.05 * s)
      for (const dx of [-0.07, 0.07]) b.part(G.cyl, b.glow(), 0.05 * s, 0.02 * s, 0.05 * s, x + dx * s, y + 0.12 * s, z + 0.23 * s, Math.PI / 2)
      break
    case 'CQB':
      b.part(G.box, b.metal(), 0.14 * s, 0.14 * s, 0.42 * s, x, y, z + 0.15 * s)
      b.part(G.cyl, b.metal(), 0.1 * s, 0.12 * s, 0.1 * s, x, y, z + 0.4 * s, Math.PI / 2)
      break
    case 'Nexus':
    case 'Tech':
      b.part(G.oct, b.glow(), 0.16 * s, 0.16 * s, 0.16 * s, x, y + 0.05 * s, z + 0.2 * s)
      b.part(G.box, b.dark, 0.16 * s, 0.12 * s, 0.2 * s, x, y, z)
      break
    default: // Rifle, Spool, unknown
      b.part(G.box, b.metal(), 0.08 * s, 0.1 * s, 0.7 * s, x, y, z + 0.25 * s)
      b.part(G.box, b.dark, 0.1 * s, 0.16 * s, 0.18 * s, x, y - 0.06 * s, z)
  }
  void side
}

/** Humanoid frame; proportions vary by archetype. Returns overall height. */
function humanoid(b: Builder, arch: Archetype, s: number, u: Unit): number {
  const P = {
    gms: { legW: 0.16, legH: 0.42, torsoW: 0.52, torsoH: 0.42, torsoD: 0.38, shoulder: 0.2, head: 0.2 },
    ipsn: { legW: 0.21, legH: 0.38, torsoW: 0.64, torsoH: 0.46, torsoD: 0.46, shoulder: 0.28, head: 0.17 },
    ssc: { legW: 0.11, legH: 0.52, torsoW: 0.42, torsoH: 0.4, torsoD: 0.3, shoulder: 0.15, head: 0.18 },
    horus: { legW: 0.14, legH: 0.46, torsoW: 0.48, torsoH: 0.44, torsoD: 0.34, shoulder: 0.18, head: 0.16 },
    ha: { legW: 0.17, legH: 0.48, torsoW: 0.54, torsoH: 0.5, torsoD: 0.4, shoulder: 0.22, head: 0.18 },
    striker: { legW: 0.14, legH: 0.46, torsoW: 0.46, torsoH: 0.4, torsoD: 0.34, shoulder: 0.18, head: 0.18 },
    defender: { legW: 0.22, legH: 0.36, torsoW: 0.66, torsoH: 0.48, torsoD: 0.48, shoulder: 0.28, head: 0.16 },
    artillery: { legW: 0.17, legH: 0.36, torsoW: 0.52, torsoH: 0.42, torsoD: 0.42, shoulder: 0.2, head: 0.16 },
    controller: { legW: 0.13, legH: 0.44, torsoW: 0.44, torsoH: 0.4, torsoD: 0.32, shoulder: 0.16, head: 0.2 },
    support: { legW: 0.16, legH: 0.4, torsoW: 0.5, torsoH: 0.42, torsoD: 0.4, shoulder: 0.18, head: 0.18 },
  } as Record<string, { legW: number; legH: number; torsoW: number; torsoH: number; torsoD: number; shoulder: number; head: number }>
  const p = P[arch] ?? P.gms
  const legH = p.legH * s, torsoY = legH + (p.torsoH * s) / 2
  // legs (SSC: digitigrade-looking thin legs with a backward knee)
  for (const side of [-1, 1] as const) {
    const lx = side * p.torsoW * 0.28 * s
    if (arch === 'ssc') {
      b.part(G.box, b.dark, p.legW * s, legH * 0.55, p.legW * s, lx, legH * 0.75, -0.05 * s, -0.3)
      b.part(G.box, b.paint, p.legW * s, legH * 0.55, p.legW * s, lx, legH * 0.28, 0.04 * s, 0.25)
    } else {
      b.part(G.box, b.dark, p.legW * s, legH, p.legW * 1.1 * s, lx, legH / 2, 0)
      b.part(G.box, b.paint, p.legW * 1.15 * s, legH * 0.35, p.legW * 1.25 * s, lx, legH * 0.65, 0.02 * s) // thigh armour
    }
    b.part(G.box, b.dark, p.legW * 1.3 * s, 0.07 * s, p.legW * 1.8 * s, lx, 0.035 * s, 0.04 * s) // foot
  }
  // torso + chest plate
  b.part(G.box, b.paint, p.torsoW * s, p.torsoH * s, p.torsoD * s, 0, torsoY, 0)
  b.part(G.box, b.dark, p.torsoW * 0.6 * s, p.torsoH * 0.45 * s, 0.04 * s, 0, torsoY - p.torsoH * 0.12 * s, (p.torsoD / 2) * s)
  // reactor glow on the chest
  b.part(G.cylHex, b.glow(), 0.07 * s, 0.02 * s, 0.07 * s, 0, torsoY + p.torsoH * 0.12 * s, (p.torsoD / 2 + 0.01) * s, Math.PI / 2)
  // shoulders / pauldrons
  const shY = torsoY + p.torsoH * 0.38 * s
  for (const side of [-1, 1] as const) {
    const sx = side * (p.torsoW / 2 + p.shoulder * 0.35) * s
    if (arch === 'ipsn' || arch === 'defender') b.part(G.box, b.paint, p.shoulder * 1.2 * s, p.shoulder * 0.8 * s, p.shoulder * 1.4 * s, sx, shY, 0)
    else b.part(G.sphere, b.paint, p.shoulder * s, p.shoulder * s, p.shoulder * s, sx, shY, 0)
    // arm
    b.part(G.box, b.dark, 0.1 * s, p.torsoH * 0.8 * s, 0.1 * s, sx, shY - p.torsoH * 0.45 * s, 0.02 * s)
  }
  // head
  const headY = torsoY + p.torsoH * 0.5 * s + p.head * 0.5 * s
  if (arch === 'horus') {
    b.part(G.tet, b.dark, p.head * 1.3 * s, p.head * 1.3 * s, p.head * 1.3 * s, 0.05 * s, headY, 0, 0.3, 0.6)
    b.part(G.sphere, b.glow(), 0.06 * s, 0.06 * s, 0.06 * s, 0.05 * s, headY, 0.1 * s)
  } else {
    b.part(G.box, b.dark, p.head * 1.1 * s, p.head * s, p.head * 1.1 * s, 0, headY, 0)
    b.part(G.box, b.glow(), p.head * 0.9 * s, 0.035 * s, 0.02 * s, 0, headY + 0.01 * s, p.head * 0.56 * s) // visor
  }
  // manufacturer flourishes
  if (arch === 'ssc') for (const side of [-1, 1]) b.part(G.box, b.trim(), 0.03 * s, 0.32 * s, 0.22 * s, side * 0.16 * s, torsoY + 0.18 * s, -p.torsoD * 0.55 * s, 0.4, 0, side * 0.5) // fins
  if (arch === 'ha') {
    b.part(G.box, b.trim(), 0.05 * s, 0.16 * s, 0.26 * s, 0, headY + p.head * 0.6 * s, -0.02 * s) // crest
    b.part(G.box, b.trim(), p.torsoW * 1.02 * s, 0.04 * s, p.torsoD * 1.02 * s, 0, torsoY - p.torsoH * 0.32 * s, 0) // brass belt
  }
  if (arch === 'horus') for (let i = 0; i < 3; i++) b.part(G.oct, b.dark, 0.09 * s, 0.09 * s, 0.09 * s, (i - 1) * 0.22 * s, headY + 0.28 * s + (i % 2) * 0.08 * s, -0.12 * s) // floating shards
  if (arch === 'gms') b.part(G.box, b.trim(), p.torsoW * 0.3 * s, 0.04 * s, 0.02 * s, -p.torsoW * 0.18 * s, torsoY + p.torsoH * 0.3 * s, (p.torsoD / 2 + 0.01) * s) // ID stripe
  // role kit for NPC humanoids
  if (arch === 'defender') b.part(G.box, b.trim(), 0.06 * s, p.torsoH * 1.6 * s, p.torsoW * 0.9 * s, -(p.torsoW / 2 + p.shoulder) * s - 0.05 * s, torsoY - 0.05 * s, 0.15 * s) // tower shield
  if (arch === 'artillery') for (const side of [-1, 1]) b.part(G.box, b.dark, 0.2 * s, 0.28 * s, 0.24 * s, side * 0.16 * s, shY + 0.15 * s, -0.18 * s, -0.4) // back pods
  if (arch === 'controller') { b.part(G.cyl, b.metal(), 0.025 * s, 0.6 * s, 0.025 * s, 0.14 * s, headY + 0.3 * s, -0.12 * s); b.part(G.sphere, b.glow(), 0.07 * s, 0.07 * s, 0.07 * s, 0.14 * s, headY + 0.62 * s, -0.12 * s) }
  if (arch === 'support') { b.part(G.box, b.paint, p.torsoW * 0.7 * s, p.torsoH * 0.8 * s, 0.18 * s, 0, torsoY, -(p.torsoD / 2 + 0.09) * s); b.part(G.box, b.glow(), 0.16 * s, 0.05 * s, 0.02 * s, 0, torsoY + 0.05 * s, -(p.torsoD / 2 + 0.19) * s); b.part(G.box, b.glow(), 0.05 * s, 0.16 * s, 0.02 * s, 0, torsoY + 0.05 * s, -(p.torsoD / 2 + 0.19) * s) }
  // weapons in the hands: first two non-integrated weapons
  const ws = u.weapons.filter(w => !w.destroyed)
  const armX = (p.torsoW / 2 + p.shoulder * 0.35) * s
  const handY = shY - p.torsoH * 0.85 * s
  weaponProp(b, ws[0], 1, armX, handY, s, ws[0]?.tech)
  if (ws[1]) weaponProp(b, ws[1], -1, -armX, handY, s, ws[1]?.tech)
  // a launcher anywhere in the loadout also mounts on the shoulder
  if (ws.slice(2).some(w => w.type === 'Launcher')) b.part(G.box, b.dark, 0.18 * s, 0.14 * s, 0.24 * s, armX, shY + 0.14 * s, -0.02 * s)
  return headY + p.head * s
}

function creature(b: Builder, s: number, u: Unit): number {
  // multi-legged beast: segmented body, six legs, mandibles; crystalline if teal
  const bodyY = 0.38 * s
  b.part(G.oct, b.paint, 0.6 * s, 0.34 * s, 0.75 * s, 0, bodyY, -0.08 * s)
  b.part(G.oct, b.paint, 0.4 * s, 0.3 * s, 0.4 * s, 0, bodyY + 0.03 * s, 0.38 * s)
  b.part(G.sphere, b.dark, 0.5 * s, 0.3 * s, 0.6 * s, 0, bodyY + 0.12 * s, -0.4 * s)
  for (const side of [-1, 1] as const) for (let i = 0; i < 3; i++) {
    const z = (0.25 - i * 0.25) * s
    b.part(G.box, b.dark, 0.05 * s, 0.5 * s, 0.05 * s, side * 0.36 * s, bodyY * 0.55, z, 0, 0, side * 0.7)
  }
  for (const side of [-1, 1]) b.part(G.cone, b.trim(), 0.06 * s, 0.22 * s, 0.06 * s, side * 0.1 * s, bodyY, 0.62 * s, Math.PI / 2)
  for (const side of [-1, 1]) b.part(G.sphere, b.glow(), 0.05 * s, 0.05 * s, 0.05 * s, side * 0.08 * s, bodyY + 0.12 * s, 0.55 * s)
  if ((u.templates ?? []).includes('Elite')) for (let i = 0; i < 4; i++) b.part(G.cone, b.trim(), 0.06 * s, 0.25 * s, 0.06 * s, (i - 1.5) * 0.12 * s, bodyY + 0.35 * s, -0.2 * s)
  return bodyY + 0.4 * s
}

export function buildUnitModel(u: Unit, mats: ModelMaterials): UnitModel {
  const pal = paletteOf(u)
  const paint = new THREE.MeshStandardMaterial({ color: pal.paint, roughness: 0.6, metalness: 0.3 })
  const dark = new THREE.MeshStandardMaterial({ color: pal.dark, roughness: 0.5, metalness: 0.5 })
  const b = new Builder(mats, paint, dark, pal)
  const arch = archetypeOf(u)
  const fs = Math.max(1, Math.floor(u.stats.size))
  const ts = u.templates ?? []
  // half-size frames are visibly smaller; Ultras loom
  let s = (u.stats.size < 1 ? 0.75 : 0.95 + (fs - 1) * 0.7) * (ts.includes('Ultra') ? 1.15 : 1) * (ts.includes('Grunt') ? 0.85 : 1)
  let height: number
  if (arch === 'drone') {
    b.part(G.oct, paint, 0.3, 0.22, 0.3, 0, 0.9, 0)
    b.part(G.box, dark, 0.5, 0.03, 0.08, 0, 0.92, 0)
    b.part(G.box, dark, 0.08, 0.03, 0.5, 0, 0.92, 0)
    b.part(G.sphere, b.glow(), 0.08, 0.08, 0.08, 0, 0.86, 0.12)
    height = 1.05
  } else if (arch === 'deployable' && u.flags.flat) {
    // flat plates and open-topped emplacements
    b.part(G.box, paint, fs * 0.96, 0.06, fs * 0.96, 0, 0.03, 0)
    b.part(G.box, b.trim(), fs * 0.98, 0.1, 0.08, 0, 0.05, fs * 0.45)
    b.part(G.box, b.trim(), fs * 0.98, 0.1, 0.08, 0, 0.05, -fs * 0.45)
    height = 0.15
  } else if (arch === 'deployable') {
    const w = fs * 0.9, h = Math.max(0.5, u.stats.size) * 0.8
    b.part(G.box, paint, w, h, fs * 0.25, 0, h / 2, 0)
    b.part(G.box, b.trim(), w * 1.02, 0.06, fs * 0.27, 0, h * 0.85, 0)
    for (const side of [-1, 1]) b.part(G.box, dark, 0.08, h * 0.6, 0.4, side * w * 0.42, h * 0.3, -0.1)
    height = h
  } else if (arch === 'biological') {
    height = creature(b, s, u)
  } else {
    height = humanoid(b, arch, s, u)
    if (ts.includes('Ultra')) for (let i = 0; i < 5; i++) b.part(G.cone, b.trim(), 0.05 * s, 0.22 * s, 0.05 * s, (i - 2) * 0.09 * s, height + 0.08 * s, 0, 0, 0, (i - 2) * 0.15)
    if (ts.includes('Elite') || ts.includes('Veteran') || ts.includes('Commander')) b.part(G.box, b.trim(), 0.5 * s, 0.05 * s, 0.4 * s, 0, height * 0.62, 0)
    if (ts.includes('Commander')) b.part(G.box, b.glow(), 0.02 * s, 0.3 * s, 0.18 * s, -0.15 * s, height + 0.05 * s, -0.12 * s)
  }
  void s
  return { group: b.group, own: [paint, dark], height }
}
