// Post-processing for the 'high' quality setting: bloom on HDR emissives, then a per-theme grade
// applied after tone mapping and sRGB output: vignette, film grain, faint scanlines and a chromatic
// fringe for the act 3 "red dream" bleed. Render targets are created once and freed in dispose().
import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'

export interface GradeLook {
  bloom: number; bloomRadius: number; bloomThreshold: number
  vignette: number; grain: number; scan: number; fringe: number
  tint: number
}

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    time: { value: 0 },
    vignette: { value: 0.35 },
    grain: { value: 0.04 },
    scan: { value: 0.03 },
    fringe: { value: 0 },
    tint: { value: new THREE.Color(1, 1, 1) },
    resolution: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float time, vignette, grain, scan, fringe; uniform vec3 tint; uniform vec2 resolution;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);
      vec4 col = texture2D(tDiffuse, vUv);
      if (fringe > 0.0) {
        vec2 off = c * fringe * r2 * 0.06;
        col.r = texture2D(tDiffuse, vUv + off).r;
        col.b = texture2D(tDiffuse, vUv - off).b;
      }
      col.rgb *= tint;
      col.rgb *= 1.0 - vignette * smoothstep(0.08, 0.55, r2);
      col.rgb *= 1.0 - scan * (0.5 + 0.5 * sin(vUv.y * resolution.y * 1.5708));
      col.rgb += (hash(vUv * resolution + fract(time * 7.13)) - 0.5) * grain;
      gl_FragColor = col;
    }`,
}

export class PostFX {
  composer: EffectComposer
  private bloom: UnrealBloomPass
  private grade: ShaderPass
  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, look: GradeLook) {
    const size = renderer.getSize(new THREE.Vector2())
    this.composer = new EffectComposer(renderer)
    this.composer.addPass(new RenderPass(scene, camera))
    this.bloom = new UnrealBloomPass(size, look.bloom, look.bloomRadius, look.bloomThreshold)
    this.composer.addPass(this.bloom)
    this.grade = new ShaderPass(GradeShader)
    const u = this.grade.uniforms
    u.vignette.value = look.vignette; u.grain.value = look.grain; u.scan.value = look.scan; u.fringe.value = look.fringe
    ;(u.tint.value as THREE.Color).setHex(look.tint)
    // grade after tone mapping, in display space, so grain and vignette read the same in every act
    this.composer.addPass(new OutputPass())
    this.composer.addPass(this.grade)
    this.setSize(size.x, size.y, renderer.getPixelRatio())
  }
  setSize(w: number, h: number, pixelRatio: number) {
    this.composer.setPixelRatio(pixelRatio)
    this.composer.setSize(w, h)
    ;(this.grade.uniforms.resolution.value as THREE.Vector2).set(w * pixelRatio, h * pixelRatio)
  }
  render(time: number, grainOn: boolean) {
    this.grade.uniforms.time.value = grainOn ? time : 0
    this.composer.render()
  }
  dispose() {
    this.bloom.dispose()
    this.grade.material.dispose()
    this.composer.dispose()
  }
}
