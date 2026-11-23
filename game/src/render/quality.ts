// Graphics quality: 'high' (post-processing, ambient particles, practical lights) or 'low'.
// Stored in localStorage; without a stored choice, software GL (SwiftShader, llvmpipe) defaults
// to low so headless tests and weak machines stay fast.
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
export function resolveQuality(gl: WebGLRenderingContext | WebGL2RenderingContext): Quality {
  return storedQuality() ?? (isSoftwareGL(gl) ? 'low' : 'high')
}
export const reducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
