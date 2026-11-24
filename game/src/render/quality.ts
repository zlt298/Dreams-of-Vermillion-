// Graphics quality: 'high' (post-processing, ambient particles, practical lights) or 'low'.
// Stored in localStorage; without a stored choice, software GL (SwiftShader, llvmpipe) and touch
// devices default to low so headless tests, weak machines and phones stay fast and cool.
export type Quality = 'high' | 'low'
const KEY = 'dov.gfx'

export function storedQuality(): Quality | null {
  try { const v = localStorage.getItem(KEY); return v === 'high' || v === 'low' ? v : null } catch { return null }
}
export function saveQuality(q: Quality) {
  try { localStorage.setItem(KEY, q) } catch { /* storage unavailable */ }
}
/** True when the context is a software rasteriser. */
export function isSoftwareGL(gl: WebGLRenderingContext | WebGL2RenderingContext): boolean {
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))
    return /swiftshader|llvmpipe|software|softpipe/i.test(name)
  } catch { return false }
}
/** Touch-first devices (phones, tablets): start on low to spare battery and heat. */
export const coarsePointer = (): boolean => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
export function resolveQuality(gl: WebGLRenderingContext | WebGL2RenderingContext): Quality {
  return storedQuality() ?? (isSoftwareGL(gl) || coarsePointer() ? 'low' : 'high')
}
/** Reduced motion, from the Motion setting or the system preference (see ui/settings.ts). */
export const reducedMotion = (): boolean => {
  const m = typeof document !== 'undefined' ? document.documentElement.dataset.motion : undefined
  if (m) return m === 'reduce'
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}
