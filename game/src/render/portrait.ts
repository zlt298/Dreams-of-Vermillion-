// Mech portraits for the Hangar, campaign dossiers and the battle unit panel: the unit's own
// procedural model (render/models.ts) rendered once at a 3/4 view with key and rim light, cached as
// a data URL. One small offscreen renderer is created on demand and released after a short idle, so
// it never holds a WebGL context alongside a battle for long.
import * as THREE from 'three'
import type { Unit } from '../rules/types'
import { buildUnitModel } from './models'

const SIZE = 160
const cache = new Map<string, string>()
let renderer: THREE.WebGLRenderer | null = null
let releaseTimer: ReturnType<typeof setTimeout> | null = null
let failed = false

function portraitKey(u: Unit): string {
  return [u.kind, u.frameId ?? u.role, u.side, u.color ?? '', u.stats.size, (u.templates ?? []).join('/'), u.weapons.map(w => w.type).join(',')].join('|')
}

function getRenderer(): THREE.WebGLRenderer | null {
  if (failed) return null
  if (!renderer) {
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
      renderer.setPixelRatio(1)
      renderer.setSize(SIZE, SIZE, false)
      renderer.toneMapping = THREE.ACESFilmicToneMapping
      renderer.toneMappingExposure = 1.3
      renderer.setClearColor(0x000000, 0)
    } catch { failed = true; return null }
  }
  if (releaseTimer) clearTimeout(releaseTimer)
  releaseTimer = setTimeout(releasePortraitRenderer, 2500)
  return renderer
}

/** Free the offscreen renderer (it is recreated on the next portrait request). */
export function releasePortraitRenderer() {
  if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = null }
  if (!renderer) return
  renderer.dispose()
  renderer.forceContextLoss()
  renderer = null
}

/** A data URL of the unit's model, or '' if WebGL is unavailable. */
export function portraitFor(u: Unit): string {
  const key = portraitKey(u)
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const r = getRenderer()
  if (!r) return ''
  const shared = new Map<string, THREE.Material>()
  const model = buildUnitModel(u, { shared: (k, make) => { let m = shared.get(k); if (!m) { m = make(); shared.set(k, m) } return m } })
  const scene = new THREE.Scene()
  scene.add(new THREE.HemisphereLight(0xdfe6ff, 0x2a1a14, 1.1))
  const key1 = new THREE.DirectionalLight(0xffe2c0, 2.6)
  key1.position.set(3, 4, 4)
  const rim = new THREE.DirectionalLight(u.side === 'player' ? 0x6fd8ff : 0xff5a3c, 3.2)
  rim.position.set(-3, 2.5, -4)
  scene.add(key1, rim, model.group)
  const box = new THREE.Box3().setFromObject(model.group)
  const centre = box.getCenter(new THREE.Vector3())
  const radius = Math.max(0.5, box.getSize(new THREE.Vector3()).length() * 0.5)
  const cam = new THREE.PerspectiveCamera(28, 1, 0.1, 100)
  const dist = radius / Math.sin(THREE.MathUtils.degToRad(14)) * 0.92
  cam.position.copy(centre).add(new THREE.Vector3(0.62, 0.38, 0.68).normalize().multiplyScalar(dist))
  cam.lookAt(centre.x, centre.y - radius * 0.05, centre.z)
  let url = ''
  try {
    r.render(scene, cam)
    url = r.domElement.toDataURL('image/png')
  } catch { url = '' }
  for (const m of model.own) m.dispose()
  for (const m of shared.values()) m.dispose()
  cache.set(key, url)
  return url
}

/** <img> markup for a unit's portrait ('' when unavailable). */
export function portraitImg(u: Unit, cls = 'portrait'): string {
  const src = portraitFor(u)
  return src ? `<img class="${cls}" src="${src}" alt="" draggable="false">` : ''
}
