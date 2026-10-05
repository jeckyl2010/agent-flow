/**
 * The painter the canvases draw through on the GPU: the whole scene gathered into one vertex stream
 * and drawn in a single WebGL 2 call. Canvas 2D drew each of its thousands of strokes and dots as a path of its own, to be
 * filled, antialiased and blended by the browser; here each is a few triangles, and the shader
 * antialiases them as it colors them.
 *
 * One blend for everything: colors are premultiplied, so "over" is (rgb·a, a), and additive light,
 * the 2D scene's `lighter`, is the same color with an alpha of 0. Layers mix freely, in order,
 * without a change of state. Light with no alpha only shows on something opaque, so the canvas is:
 * the frame starts with the view's backdrop, and the page composites it without blending.
 *
 * Coordinates are CSS pixels, as the 2D scene's; the shader scales them to the device's.
 */
import { VERTEX as FULLSCREEN, blurShader } from '../gl-bloom'

const VERTEX = `#version 300 es
uniform vec2 res;
in vec2 pos;
in vec4 color;
in vec4 shape;
out vec4 vColor;
out vec3 vShape;
flat out int vMode;
void main() {
  vColor = color;
  vShape = shape.xyz;
  vMode = int(shape.w + 0.5);
  vec2 c = pos / res * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
}`

/**
 * By mode: 0 flat (fills and gradient meshes, colored per vertex); 1 a line, shape.x its signed
 * distance across and shape.y its half width; 2 a disc, shape.xy the offset from its center and
 * shape.z its radius; 3 a glow, fading from its center to its radius; 4 text, shape.xy into the atlas,
 * tinted; 5 the view's backdrop; 6 a soft line, fading from its middle to its edges (a shadow);
 * 7 an image from the atlas, in its own colors.
 * Distances are CSS pixels: `dpr` turns an edge into one device pixel of antialiasing.
 */
const FRAGMENT = `#version 300 es
precision highp float;
uniform float dpr;
uniform sampler2D atlas;
in vec4 vColor;
in vec3 vShape;
flat in int vMode;
out vec4 outColor;
void main() {
  float cover = 1.0;
  if (vMode == 1) cover = clamp((vShape.y - abs(vShape.x)) * dpr + 0.5, 0.0, 1.0);
  else if (vMode == 2) cover = clamp((vShape.z - length(vShape.xy)) * dpr + 0.5, 0.0, 1.0);
  else if (vMode == 3) cover = max(0.0, 1.0 - length(vShape.xy) / vShape.z);
  else if (vMode == 4) cover = texture(atlas, vShape.xy).a;
  else if (vMode == 6) cover = clamp(1.0 - abs(vShape.x) / vShape.y, 0.0, 1.0);
  else if (vMode == 7) { outColor = texture(atlas, vShape.xy) * vColor.a; return; }
  else if (vMode == 5) {
    // The view's backdrop, as its CSS draws it: an ellipse, shape.xy across it, 1 at its edge
    float t = length(vShape.xy);
    vec3 c = t < 0.45 ? mix(vec3(0.0706, 0.0471, 0.0941), vec3(0.0275, 0.0275, 0.102), t / 0.45)
           : mix(vec3(0.0275, 0.0275, 0.102), vec3(0.0196, 0.0196, 0.0627), clamp((t - 0.45) / 0.35, 0.0, 1.0));
    outColor = vec4(c, 1.0);
    return;
  }
  outColor = vColor * cover;
}`

/** Floats a vertex: x, y; r, g, b, a premultiplied; shape x, y, z, mode */
const STRIDE = 10
const FLAT = 0, LINE = 1, DISC = 2, GLOW = 3, TEXT = 4, BACKDROP = 5, SOFT = 6, IMAGE = 7

export type RGBA = readonly [number, number, number, number]
const parsed = new Map<string, RGBA>()
/** A CSS color as canvas takes one, 0 to 1: '#rgb(a)', '#rrggbb(aa)', 'rgb(a)(…)' or 'transparent' */
export function rgba(color: string): RGBA {
  let c = parsed.get(color)
  if (!c) {
    c = parseColor(color)
    parsed.set(color, c)
  }
  return c
}

function parseColor(color: string): RGBA {
  const s = color.trim()
  if (s[0] === '#') {
    const hex = s.slice(1)
    if (hex.length === 3 || hex.length === 4) {
      const n = (i: number) => parseInt(hex[i] + hex[i], 16) / 255
      return [n(0), n(1), n(2), hex.length === 4 ? n(3) : 1]
    }
    const n = (i: number) => parseInt(hex.slice(i, i + 2), 16) / 255
    return [n(0), n(2), n(4), hex.length >= 8 ? n(6) : 1]
  }
  const m = /^rgba?\(([^)]*)\)$/i.exec(s)
  if (m) {
    const [r, g, b, a = '1'] = m[1].split(/[\s,/]+/).filter(Boolean)
    return [parseFloat(r) / 255, parseFloat(g) / 255, parseFloat(b) / 255, a.endsWith('%') ? parseFloat(a) / 100 : parseFloat(a)]
  }
  if (s === 'white') return [1, 1, 1, 1]
  if (s === 'black') return [0, 0, 0, 1]
  return [0, 0, 0, 0]
}

const ATLAS_W = 2048, ATLAS_H = 2048

/** A picture in the atlas: where it is, its size in the units it was drawn in, and the point it's placed by */
export interface Sprite { u0: number; v0: number; u1: number; v1: number; w: number; h: number; ax: number; ay: number }

/** The zoom a picture is drawn into the atlas at: steps of about 9%, so a zooming view reuses them */
export const quantize = (scale: number) => 2 ** (Math.round(Math.log2(Math.max(scale, 1 / 64)) * 8) / 8)

/** A shadow's blur, in steps of about 19%: a blur that breathes or pulses reuses a few pictures */
export const quantizeBlur = (blur: number) => (blur < 0.25 ? 0 : 2 ** (Math.round(Math.log2(blur) * 4) / 4))

export class Painter {
  readonly canvas: HTMLCanvasElement
  private gl: WebGL2RenderingContext | null = null
  private program: WebGLProgram | null = null
  private atlasTex: WebGLTexture | null = null
  private vao: WebGLVertexArrayObject | null = null
  private uRes: WebGLUniformLocation | null = null
  private uDpr: WebGLUniformLocation | null = null
  /**
   * The frame's geometry goes up into one of three buffer pairs in turn, written in place and grown
   * only when it must be: a buffer allocated anew each frame cost Safari a GPU copy pass of its own
   */
  private ring: Array<{ vbo: WebGLBuffer; ibo: WebGLBuffer; vCap: number; iCap: number }> = []
  private ringAt = 0

  private verts = new Float32Array(STRIDE * 65536)
  private idx = new Uint32Array(65536 * 3)
  private nv = 0
  private ni = 0
  private dpr = 1
  private resW = 0
  private resH = 0

  // A path being gathered: its points, and each point's half width and color
  private px: number[] = []
  private py: number[] = []
  private pw: number[] = []
  private pc: number[] = []

  // Text: each string drawn once into the atlas, white, its coverage read as alpha
  private glyphs = new Map<string, Sprite | null>()
  private shelfX = 0
  private shelfY = 0
  private shelfH = 0
  private scratch = document.createElement('canvas')
  private scratchCtx = this.scratch.getContext('2d')!
  private atlasDpr = 0

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    // In the document, as the 2D scene's canvas was: a detached canvas resolves `monospace` to
    // another font (Courier rather than Menlo, in Safari)
    this.scratch.style.cssText = 'position:absolute;width:0;height:0;visibility:hidden;pointer-events:none'
    canvas.after(this.scratch)
    canvas.addEventListener('webglcontextlost', this.onLost)
    canvas.addEventListener('webglcontextrestored', this.onRestored)
    this.init()
    if (!this.gl) this.dispose()
  }

  private onLost = (e: Event) => { e.preventDefault(); this.gl = null }
  private onRestored = () => this.init()

  get ok(): boolean { return !!this.gl }

  private init() {
    // Opaque: light that adds has no alpha, and shows only over something opaque (see above). No
    // multisampling: lines, discs and glows antialias in the shader, fills by a stroke round their
    // edge, and resolving 4× samples was a third of the GPU's time on the scene
    const gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false })
    if (!gl) return
    const shader = (type: number, src: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src); gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader')
      return s
    }
    const p = gl.createProgram()!
    gl.attachShader(p, shader(gl.VERTEX_SHADER, VERTEX))
    gl.attachShader(p, shader(gl.FRAGMENT_SHADER, FRAGMENT))
    gl.bindAttribLocation(p, 0, 'pos'); gl.bindAttribLocation(p, 1, 'color'); gl.bindAttribLocation(p, 2, 'shape')
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link')
    this.program = p
    this.uRes = gl.getUniformLocation(p, 'res')
    this.uDpr = gl.getUniformLocation(p, 'dpr')

    this.vao = gl.createVertexArray()
    gl.bindVertexArray(this.vao)
    gl.enableVertexAttribArray(0); gl.enableVertexAttribArray(1); gl.enableVertexAttribArray(2)
    // Made again on this context when it's needed
    this.bloomProgs = null; this.bloomTargets = []
    this.ring = Array.from({ length: 3 }, () => ({ vbo: gl.createBuffer(), ibo: gl.createBuffer(), vCap: 0, iCap: 0 }))

    this.atlasTex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex)
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, ATLAS_W, ATLAS_H)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)

    gl.useProgram(p)
    gl.uniform1i(gl.getUniformLocation(p, 'atlas'), 0)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.disable(gl.DEPTH_TEST)
    this.gl = gl
    // The atlas is empty again: every string is drawn into it anew
    this.glyphs.clear(); this.shelfX = this.shelfY = this.shelfH = 0
  }

  dispose() {
    this.canvas.removeEventListener('webglcontextlost', this.onLost)
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored)
    this.scratch.remove()
    // The context stays with the canvas, and a scene made on it again (React remounting) takes it up
    this.gl = null
  }

  /** A new frame, the canvas sized to its box at the device's resolution */
  begin(width: number, height: number, dpr: number) {
    this.dpr = dpr
    const w = Math.round(width * dpr), h = Math.round(height * dpr)
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h }
    if (dpr !== this.atlasDpr || this.shelfY > ATLAS_H * 0.85) {
      // Labels that change (counting down) fill the atlas over time: start it again
      this.glyphs.clear(); this.shelfX = this.shelfY = this.shelfH = 0; this.atlasDpr = dpr
    }
    this.nv = 0; this.ni = 0
    this.resW = width; this.resH = height
  }

  /**
   * Everything gathered this frame, in one draw. With `bloom`, the frame's light spread round it at
   * that strength: shrunk to a quarter, blurred, and added back
   */
  end(bloom = 0) {
    const gl = this.gl
    if (!gl) return
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.bindVertexArray(this.vao)
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    if (this.ni === 0) {
      gl.clearColor(0, 0, 0, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
      return
    }
    gl.useProgram(this.program)
    gl.uniform2f(this.uRes, this.resW, this.resH)
    gl.uniform1f(this.uDpr, this.dpr)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex)
    const r = this.ring[this.ringAt = (this.ringAt + 1) % this.ring.length]
    gl.bindBuffer(gl.ARRAY_BUFFER, r.vbo)
    if (r.vCap < this.nv * STRIDE) { r.vCap = this.verts.length; gl.bufferData(gl.ARRAY_BUFFER, r.vCap * 4, gl.DYNAMIC_DRAW) }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.verts, 0, this.nv * STRIDE)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, STRIDE * 4, 0)
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, STRIDE * 4, 8)
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, STRIDE * 4, 24)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, r.ibo)
    if (r.iCap < this.ni) { r.iCap = this.idx.length; gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, r.iCap * 4, gl.DYNAMIC_DRAW) }
    gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, this.idx, 0, this.ni)
    // The bloom's light first: the scene drawn again, small, then blurred
    if (bloom > 0) this.bloom(gl)
    // The scene's first draw covers the canvas: nothing to clear
    gl.drawElements(gl.TRIANGLES, this.ni, gl.UNSIGNED_INT, 0)
    if (bloom > 0) this.bloomAdd(gl, bloom)
  }

  // ── Bloom ─────────────────────────────────────────────────────────────────────

  private bloomProgs: { blur: WebGLProgram; add: WebGLProgram; dir: WebGLUniformLocation | null; k: WebGLUniformLocation | null } | null = null
  /** Two at a quarter size: the scene drawn small, then blurred across and down */
  private bloomTargets: Array<{ tex: WebGLTexture; fb: WebGLFramebuffer; w: number; h: number }> = []
  private fullscreen: WebGLVertexArrayObject | null = null

  private bloom(gl: WebGL2RenderingContext) {
    const W = this.canvas.width, H = this.canvas.height
    if (!this.bloomProgs) {
      const prog = (frag: string) => {
        const p = gl.createProgram()!
        for (const [type, src] of [[gl.VERTEX_SHADER, FULLSCREEN], [gl.FRAGMENT_SHADER, frag]] as const) {
          const sh = gl.createShader(type)!
          gl.shaderSource(sh, src); gl.compileShader(sh); gl.attachShader(p, sh)
        }
        gl.bindAttribLocation(p, 0, 'pos')
        gl.linkProgram(p)
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'bloom')
        return p
      }
      const blur = prog(blurShader())
      // Added as light: alpha 0, under the one blend
      const add = prog(`#version 300 es
precision mediump float;
uniform sampler2D src;
uniform float k;
in vec2 uv;
out vec4 color;
void main() { color = vec4(texture(src, uv).rgb * k, 0.0); }`)
      this.bloomProgs = { blur, add, dir: gl.getUniformLocation(blur, 'dir'), k: gl.getUniformLocation(add, 'k') }
      gl.useProgram(blur); gl.uniform1i(gl.getUniformLocation(blur, 'src'), 0)
      gl.useProgram(add); gl.uniform1i(gl.getUniformLocation(add, 'src'), 0)
      this.fullscreen = gl.createVertexArray()
      gl.bindVertexArray(this.fullscreen)
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
      gl.enableVertexAttribArray(0)
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    }
    const sizes = [[W >> 2, H >> 2], [W >> 2, H >> 2]]
    if (this.bloomTargets[0]?.w !== sizes[0][0] || this.bloomTargets[0]?.h !== sizes[0][1]) {
      for (const t of this.bloomTargets) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb) }
      this.bloomTargets = sizes.map(([w, h]) => {
        const tex = gl.createTexture()!
        gl.bindTexture(gl.TEXTURE_2D, tex)
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, Math.max(1, w), Math.max(1, h))
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        const fb = gl.createFramebuffer()!
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
        return { tex, fb, w: Math.max(1, w), h: Math.max(1, h) }
      })
    }
    const [q1, q2] = this.bloomTargets
    const p = this.bloomProgs!
    // Setting up bound other things: the scene's own, again
    gl.useProgram(this.program)
    gl.bindVertexArray(this.vao)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex)
    // The scene again, at a quarter of the size: its geometry is already up, and a sixteenth of the
    // pixels costs far less than reading the whole frame back to shrink it
    gl.bindFramebuffer(gl.FRAMEBUFFER, q1.fb)
    gl.viewport(0, 0, q1.w, q1.h)
    gl.uniform1f(this.uDpr, this.dpr / 4)
    gl.drawElements(gl.TRIANGLES, this.ni, gl.UNSIGNED_INT, 0)
    gl.uniform1f(this.uDpr, this.dpr)
    // Blurred across, then down
    gl.disable(gl.BLEND)
    gl.bindVertexArray(this.fullscreen)
    gl.useProgram(p.blur)
    gl.activeTexture(gl.TEXTURE0)
    gl.viewport(0, 0, q1.w, q1.h)
    gl.bindFramebuffer(gl.FRAMEBUFFER, q2.fb)
    gl.bindTexture(gl.TEXTURE_2D, q1.tex)
    gl.uniform2f(p.dir, 1 / q1.w, 0)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.bindFramebuffer(gl.FRAMEBUFFER, q1.fb)
    gl.bindTexture(gl.TEXTURE_2D, q2.tex)
    gl.uniform2f(p.dir, 0, 1 / q1.h)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    // Back to the frame, for the scene
    gl.enable(gl.BLEND)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, W, H)
    gl.useProgram(this.program)
    gl.bindVertexArray(this.vao)
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex)
  }

  /** The bloom's light, added over the frame */
  private bloomAdd(gl: WebGL2RenderingContext, strength: number) {
    const p = this.bloomProgs!, q1 = this.bloomTargets[0]
    gl.bindVertexArray(this.fullscreen)
    gl.useProgram(p.add)
    gl.uniform1f(p.k, strength)
    gl.bindTexture(gl.TEXTURE_2D, q1.tex)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.bindVertexArray(this.vao)
  }

  // ── The stream ────────────────────────────────────────────────────────────────

  private reserve(nv: number, ni: number) {
    if ((this.nv + nv) * STRIDE > this.verts.length) {
      const next = new Float32Array(Math.max(this.verts.length * 2, (this.nv + nv) * STRIDE))
      next.set(this.verts); this.verts = next
    }
    if (this.ni + ni > this.idx.length) {
      const next = new Uint32Array(Math.max(this.idx.length * 2, this.ni + ni))
      next.set(this.idx); this.idx = next
    }
  }

  /** A vertex; returns its index. Color premultiplied, and alpha 0 when the light adds */
  private v(x: number, y: number, r: number, g: number, b: number, a: number, add: boolean, s0: number, s1: number, s2: number, mode: number): number {
    const o = this.nv * STRIDE, f = this.verts
    f[o] = x; f[o + 1] = y
    f[o + 2] = r * a; f[o + 3] = g * a; f[o + 4] = b * a; f[o + 5] = add ? 0 : a
    f[o + 6] = s0; f[o + 7] = s1; f[o + 8] = s2; f[o + 9] = mode
    return this.nv++
  }

  private quad(a: number, b: number, c: number, d: number) {
    const i = this.idx, o = this.ni
    i[o] = a; i[o + 1] = b; i[o + 2] = c; i[o + 3] = a; i[o + 4] = c; i[o + 5] = d
    this.ni += 6
  }

  private tri(a: number, b: number, c: number) {
    const i = this.idx, o = this.ni
    i[o] = a; i[o + 1] = b; i[o + 2] = c
    this.ni += 3
  }

  /**
   * The view's backdrop over the whole canvas: CSS's `radial-gradient(ellipse at …)`, its center and
   * radii given in this canvas's pixels
   */
  backdrop(cx: number, cy: number, rx: number, ry: number) {
    const w = this.resW, h = this.resH
    this.reserve(4, 6)
    const i = this.v(0, 0, 0, 0, 0, 1, false, -cx / rx, -cy / ry, 0, BACKDROP)
    this.v(w, 0, 0, 0, 0, 1, false, (w - cx) / rx, -cy / ry, 0, BACKDROP)
    this.v(w, h, 0, 0, 0, 1, false, (w - cx) / rx, (h - cy) / ry, 0, BACKDROP)
    this.v(0, h, 0, 0, 0, 1, false, -cx / rx, (h - cy) / ry, 0, BACKDROP)
    this.quad(i, i + 1, i + 2, i + 3)
  }

  // ── Shapes ────────────────────────────────────────────────────────────────────

  /** A filled circle, antialiased. A circle smaller than a device pixel dims as its area does */
  disc(x: number, y: number, radius: number, color: string, alpha: number, add: boolean) {
    const [r, g, b, ca] = rgba(color)
    const min = 0.5 / this.dpr
    let a = ca * alpha
    if (radius < min) { a *= (radius / min) ** 2; radius = min }
    if (a <= 0.001) return
    const e = radius + 1 / this.dpr
    this.reserve(4, 6)
    const i = this.v(x - e, y - e, r, g, b, a, add, -e, -e, radius, DISC)
    this.v(x + e, y - e, r, g, b, a, add, e, -e, radius, DISC)
    this.v(x + e, y + e, r, g, b, a, add, e, e, radius, DISC)
    this.v(x - e, y + e, r, g, b, a, add, -e, e, radius, DISC)
    this.quad(i, i + 1, i + 2, i + 3)
  }

  /** A soft glow: `alpha` at its center, fading evenly to nothing at its radius */
  glow(x: number, y: number, radius: number, color: string, alpha: number, add: boolean) {
    const [r, g, b, ca] = rgba(color)
    const a = ca * alpha
    if (a <= 0.001 || radius <= 0) return
    this.reserve(4, 6)
    const i = this.v(x - radius, y - radius, r, g, b, a, add, -radius, -radius, radius, GLOW)
    this.v(x + radius, y - radius, r, g, b, a, add, radius, -radius, radius, GLOW)
    this.v(x + radius, y + radius, r, g, b, a, add, radius, radius, radius, GLOW)
    this.v(x - radius, y + radius, r, g, b, a, add, -radius, radius, radius, GLOW)
    this.quad(i, i + 1, i + 2, i + 3)
  }

  /**
   * A radial gradient from r0 to r1, as canvas draws one filled to r1: stops at offsets 0 to 1, and
   * inside r0 the first stop's color. Concentric bands of triangles, colored at their edges
   */
  radial(cx: number, cy: number, r0: number, r1: number, stops: ReadonlyArray<readonly [number, string, number]>, add: boolean, segments = 72) {
    const cols = stops.map(([, c, a]) => { const [r, g, b, ca] = rgba(c); return [r, g, b, ca * a] as const })
    const radii = stops.map(([o]) => r0 + (r1 - r0) * o)
    this.reserve((segments + 1) * (stops.length + 1), segments * 6 * stops.length)
    const ring = (rad: number, k: number) => {
      const [r, g, b, a] = cols[k]
      const first = this.nv
      for (let s = 0; s < segments; s++) {
        const t = (s / segments) * Math.PI * 2
        this.v(cx + Math.cos(t) * rad, cy + Math.sin(t) * rad, r, g, b, a, add, 0, 0, 0, FLAT)
      }
      return first
    }
    // The pad inside r0
    if (cols[0][3] > 0.001 && radii[0] > 0) {
      const [r, g, b, a] = cols[0]
      const c = this.v(cx, cy, r, g, b, a, add, 0, 0, 0, FLAT)
      const rim = ring(radii[0], 0)
      for (let s = 0; s < segments; s++) this.tri(c, rim + s, rim + (s + 1) % segments)
    }
    let inner = ring(radii[0], 0)
    for (let k = 1; k < stops.length; k++) {
      const outer = ring(radii[k], k)
      if (cols[k - 1][3] > 0.001 || cols[k][3] > 0.001) {
        for (let s = 0; s < segments; s++) {
          const n = (s + 1) % segments
          this.quad(inner + s, outer + s, outer + n, inner + n)
        }
      }
      inner = outer
    }
  }

  /** A filled polygon, flat x, y pairs, in one color */
  fill(points: ArrayLike<number>, color: string, alpha: number, add: boolean) {
    const [r, g, b, ca] = rgba(color)
    this.polygon(points, points.length / 2, r, g, b, ca * alpha, null, add)
  }

  /**
   * A filled polygon of any simple shape, n x, y pairs: in one color, or colored at each vertex
   * (`colors`, r, g, b, a for each, linear between them). Its edge antialiased by a fringe a device
   * pixel wide outside it, so a translucent fill isn't doubled along its edge
   */
  polygon(xy: ArrayLike<number>, n: number, r: number, g: number, b: number, a: number, colors: ArrayLike<number> | null, add: boolean) {
    if (n < 3 || (!colors && a <= 0.001)) return
    let area = 0
    for (let i = 0, j = n - 1; i < n; j = i++) area += xy[2 * j] * xy[2 * i + 1] - xy[2 * i] * xy[2 * j + 1]
    if (Math.abs(area) < 1e-6) return
    const tris = triangulate(xy, n, area > 0)
    this.reserve(n * 3, tris.length + n * 6)
    const first = this.nv
    for (let k = 0; k < n; k++) {
      if (colors) this.v(xy[2 * k], xy[2 * k + 1], colors[4 * k], colors[4 * k + 1], colors[4 * k + 2], colors[4 * k + 3], add, 0, 0, 0, FLAT)
      else this.v(xy[2 * k], xy[2 * k + 1], r, g, b, a, add, 0, 0, 0, FLAT)
    }
    for (let k = 0; k < tris.length; k += 3) this.tri(first + tris[k], first + tris[k + 1], first + tris[k + 2])
    // The fringe: from each vertex outward along its corner's mean normal, fading to nothing
    const f = 1 / this.dpr, sign = area > 0 ? 1 : -1
    const outer = this.nv
    for (let k = 0; k < n; k++) {
      const p = (k + n - 1) % n, q = (k + 1) % n
      let ex0 = xy[2 * k] - xy[2 * p], ey0 = xy[2 * k + 1] - xy[2 * p + 1]
      let ex1 = xy[2 * q] - xy[2 * k], ey1 = xy[2 * q + 1] - xy[2 * k + 1]
      const l0 = Math.hypot(ex0, ey0) || 1, l1 = Math.hypot(ex1, ey1) || 1
      ex0 /= l0; ey0 /= l0; ex1 /= l1; ey1 /= l1
      let nx = (ey0 + ey1) * sign, ny = -(ex0 + ex1) * sign
      const nl = Math.hypot(nx, ny)
      if (nl < 1e-6) { nx = ey1 * sign; ny = -ex1 * sign } else { nx /= nl; ny /= nl }
      const miter = Math.min(2, 1 / Math.max(0.5, nx * ey1 * sign - ny * ex1 * sign))
      const cr = colors ? colors[4 * k] : r, cg = colors ? colors[4 * k + 1] : g, cb = colors ? colors[4 * k + 2] : b, cc = colors ? colors[4 * k + 3] : a
      this.v(xy[2 * k] + nx * f * miter, xy[2 * k + 1] + ny * f * miter, cr, cg, cb, cc, add, f, 0, 0, LINE)
    }
    // The inner edge of the fringe: the polygon's own vertices, again, as a line's middle
    const inner = this.nv
    for (let k = 0; k < n; k++) {
      const cr = colors ? colors[4 * k] : r, cg = colors ? colors[4 * k + 1] : g, cb = colors ? colors[4 * k + 2] : b, cc = colors ? colors[4 * k + 3] : a
      this.v(xy[2 * k], xy[2 * k + 1], cr, cg, cb, cc, add, 0, 0, 0, LINE)
    }
    for (let k = 0; k < n; k++) {
      const q = (k + 1) % n
      this.quad(inner + k, outer + k, outer + q, inner + q)
    }
  }

  // ── Strokes: gathered point by point, then built into one strip with mitred joins ──

  /** Starts a stroke */
  path() { this.px.length = this.py.length = this.pw.length = this.pc.length = 0 }

  /** A point of the stroke: its width there and its color (premultiplied as drawn) */
  to(x: number, y: number, width: number, color: string, alpha: number) {
    const [r, g, b, ca] = rgba(color)
    this.px.push(x); this.py.push(y); this.pw.push(width / 2)
    this.pc.push(r, g, b, ca * alpha)
  }

  /**
   * Builds the stroke: butt ends, mitred joins (as canvas's defaults), closed back to its start if
   * asked. A soft one fades from its middle to its edges: a shadow's blur, roughly
   */
  stroke(add: boolean, closed = false, soft = false) {
    const px = this.px, py = this.py, pw = this.pw, pc = this.pc
    let n = px.length
    if (n < 2) return
    if (closed) { px.push(px[0]); py.push(py[0]); pw.push(pw[0]); pc.push(pc[0], pc[1], pc[2], pc[3]); n++ }
    const min = 0.5 / this.dpr, fringe = 1 / this.dpr
    this.reserve(n * 2, (n - 1) * 6)
    let base = -1
    let dxPrev = 0, dyPrev = 0
    for (let k = 0; k < n; k++) {
      // The direction of the segments either side
      let dx0: number, dy0: number, dx1: number, dy1: number
      if (k < n - 1) {
        dx1 = px[k + 1] - px[k]; dy1 = py[k + 1] - py[k]
        const l = Math.hypot(dx1, dy1)
        if (l > 1e-6) { dx1 /= l; dy1 /= l } else { dx1 = dxPrev; dy1 = dyPrev }
      } else if (closed) {
        dx1 = px[1] - px[0]; dy1 = py[1] - py[0]
        const l = Math.hypot(dx1, dy1) || 1; dx1 /= l; dy1 /= l
      } else { dx1 = dxPrev; dy1 = dyPrev }
      if (k > 0) { dx0 = dxPrev; dy0 = dyPrev } else if (closed) {
        dx0 = px[n - 1] - px[n - 2]; dy0 = py[n - 1] - py[n - 2]
        const l = Math.hypot(dx0, dy0) || 1; dx0 /= l; dy0 /= l
      } else { dx0 = dx1; dy0 = dy1 }
      if (dx1 === 0 && dy1 === 0) { dx1 = dx0; dy1 = dy0 }
      if (dx0 === 0 && dy0 === 0) { dx0 = dx1; dy0 = dy1 }
      // The miter: along the mean normal, longer as the join turns, up to twice the width
      let nx = -(dy0 + dy1), ny = dx0 + dx1
      const nl = Math.hypot(nx, ny)
      if (nl < 1e-6) { nx = -dy1; ny = dx1 } else { nx /= nl; ny /= nl }
      const cos = nx * -dy1 + ny * dx1
      const miter = Math.min(2, 1 / Math.max(0.5, cos))
      let hw = pw[k], a = pc[4 * k + 3]
      // Thinner than a device pixel: drawn a pixel wide, dimmed by what it covers
      if (hw < min) { a *= hw / min; hw = min }
      const e = soft ? hw : hw + fringe
      const r = pc[4 * k], g = pc[4 * k + 1], b = pc[4 * k + 2]
      const mode = soft ? SOFT : LINE
      const i = this.v(px[k] + nx * e * miter, py[k] + ny * e * miter, r, g, b, a, add, e, hw, 0, mode)
      this.v(px[k] - nx * e * miter, py[k] - ny * e * miter, r, g, b, a, add, -e, hw, 0, mode)
      if (base >= 0) this.quad(base, i, i + 1, base + 1)
      base = i
      dxPrev = dx1; dyPrev = dy1
    }
  }

  /** One straight line, the commonest stroke */
  line(x0: number, y0: number, x1: number, y1: number, width: number, color: string, alpha: number, add: boolean) {
    this.path(); this.to(x0, y0, width, color, alpha); this.to(x1, y1, width, color, alpha); this.stroke(add)
  }

  // ── Pictures and text ─────────────────────────────────────────────────────────

  /**
   * A picture drawn once into the atlas, kept by its key: `draw` paints it with the 2D canvas into
   * a w×h box of its own units, at `res` device pixels a unit, its placing point at (ax, ay).
   * Undefined when the atlas is full for this frame
   */
  sprite(key: string, w: number, h: number, ax: number, ay: number, res: number, draw: (g: CanvasRenderingContext2D) => void): Sprite | undefined {
    const gl = this.gl
    if (!gl) return undefined
    const had = this.glyphs.get(key)
    if (had !== undefined) return had ?? undefined
    const dw = Math.max(1, Math.ceil(w * res)), dh = Math.max(1, Math.ceil(h * res))
    if (dw > ATLAS_W || dh > ATLAS_H / 4) { this.glyphs.set(key, null); return undefined }
    // Entries kept a few texels apart, so filtering never reaches into a neighbor
    if (this.shelfX + dw > ATLAS_W) { this.shelfX = 0; this.shelfY += this.shelfH + 4; this.shelfH = 0 }
    if (this.shelfY + dh > ATLAS_H) return undefined
    const g = this.scratchCtx
    this.scratch.width = dw; this.scratch.height = dh
    g.setTransform(res, 0, 0, res, 0, 0)
    draw(g)
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, this.shelfX, this.shelfY, gl.RGBA, gl.UNSIGNED_BYTE, this.scratch)
    const sp: Sprite = {
      u0: this.shelfX / ATLAS_W, v0: this.shelfY / ATLAS_H, u1: (this.shelfX + dw) / ATLAS_W, v1: (this.shelfY + dh) / ATLAS_H,
      w: dw / res, h: dh / res, ax, ay,
    }
    this.glyphs.set(key, sp)
    this.shelfX += dw + 4
    this.shelfH = Math.max(this.shelfH, dh)
    return sp
  }

  /**
   * A sprite placed with its point at (x, y), `scale` of its units to a pixel: tinted by `color`
   * when it's coverage (text, drawn white), in its own colors otherwise
   */
  image(sp: Sprite, x: number, y: number, scale: number, alpha: number, tint?: string) {
    const [r, g, b, ca] = tint ? rgba(tint) : [1, 1, 1, 1] as const
    const a = ca * alpha
    if (a <= 0.001) return
    let x0 = x - sp.ax * scale, y0 = y - sp.ay * scale
    // Unzoomed: on whole device pixels, as crisp as the atlas drew it
    if (scale === 1) { x0 = Math.round(x0 * this.dpr) / this.dpr; y0 = Math.round(y0 * this.dpr) / this.dpr }
    const w = sp.w * scale, h = sp.h * scale
    const mode = tint ? TEXT : IMAGE
    this.reserve(4, 6)
    const i = this.v(x0, y0, r, g, b, a, false, sp.u0, sp.v0, 0, mode)
    this.v(x0 + w, y0, r, g, b, a, false, sp.u1, sp.v0, 0, mode)
    this.v(x0 + w, y0 + h, r, g, b, a, false, sp.u1, sp.v1, 0, mode)
    this.v(x0, y0 + h, r, g, b, a, false, sp.u0, sp.v1, 0, mode)
    this.quad(i, i + 1, i + 2, i + 3)
  }

  /** How wide text is, as canvas measures it */
  measure(str: string, font: string): TextMetrics {
    const g = this.scratchCtx
    g.font = font
    return g.measureText(str)
  }

  /**
   * Text as canvas's fillText draws it, at `scale` (the drawing's zoom): drawn once into the atlas,
   * white and tinted, or in its color when it casts a shadow
   */
  fillText(
    str: string, x: number, y: number, font: string, align: CanvasTextAlign, baseline: CanvasTextBaseline,
    color: string, alpha = 1, scale = 1, shadow?: { color: string; blur: number },
  ) {
    if (!str) return
    // A size that changes smoothly (an icon breathing with its node): drawn at the nearest quarter
    // pixel and scaled the rest of the way, so it reuses a picture
    const px = /(\d*\.?\d+)px/.exec(font)
    if (px) {
      const size = parseFloat(px[1]), even = Math.max(0.25, Math.round(size * 4) / 4)
      if (even !== size) { font = font.replace(px[0], `${even}px`); scale *= size / even }
    }
    const q = quantize(scale)
    if (shadow) shadow = { color: shadow.color, blur: quantizeBlur(shadow.blur) }
    if (shadow && shadow.blur === 0) shadow = undefined
    const key = `t|${font}|${baseline}|${q}|${shadow ? `${shadow.color}|${shadow.blur}|${color}` : ''}|${str}`
    let sp = this.glyphs.get(key) ?? undefined
    if (!sp) {
      const g = this.scratchCtx
      g.font = font
      g.textBaseline = baseline
      g.textAlign = 'left'
      const m = g.measureText(str)
      // A shadow's blur is in the canvas's pixels, which the transform doesn't scale: the atlas's
      // pixels here, as near as its zoom step is to the drawing's
      const pad = 2 + (shadow ? (shadow.blur * 1.5) / (q * this.dpr) : 0)
      const left = Math.max(0, m.actualBoundingBoxLeft), asc = m.actualBoundingBoxAscent
      const w = left + Math.max(m.width, m.actualBoundingBoxRight) + pad * 2
      const h = asc + m.actualBoundingBoxDescent + pad * 2
      sp = this.sprite(key, w, h, pad + left, pad + asc, q * this.dpr, c => {
        c.font = font
        c.textBaseline = baseline
        c.textAlign = 'left'
        c.fillStyle = shadow ? color : '#fff'
        if (shadow) { c.shadowColor = shadow.color; c.shadowBlur = shadow.blur }
        c.fillText(str, pad + left, pad + asc)
      })
      if (!sp) return
      ;(sp as Sprite & { advance?: number }).advance = m.width
    }
    const advance = (sp as Sprite & { advance?: number }).advance ?? 0
    const dx = align === 'center' ? -advance / 2 : align === 'right' || align === 'end' ? -advance : 0
    if (shadow) this.image(sp, x + dx * scale, y, scale, alpha * rgba(color)[3])
    else this.image(sp, x + dx * scale, y, scale, alpha, color)
  }

  /** The time horizon's labels: monospace, on an alphabetic baseline, unzoomed */
  text(str: string, x: number, y: number, size: number, bold: boolean, align: 'left' | 'center', color: string, alpha = 1) {
    this.fillText(str, x, y, `${bold ? 'bold ' : ''}${size}px monospace`, align, 'alphabetic', color, alpha)
  }
}

/**
 * Triangles covering a simple polygon, by clipping its ears: a fan where it's convex, as most
 * are. Indices into its vertices, three a triangle
 */
function triangulate(xy: ArrayLike<number>, n: number, ccw: boolean): number[] {
  const out: number[] = []
  const cross = (a: number, b: number, c: number) =>
    (xy[2 * b] - xy[2 * a]) * (xy[2 * c + 1] - xy[2 * a + 1]) - (xy[2 * b + 1] - xy[2 * a + 1]) * (xy[2 * c] - xy[2 * a])
  const turn = (a: number, b: number, c: number) => (ccw ? cross(a, b, c) : -cross(a, b, c))
  let convex = true
  for (let i = 0; i < n && convex; i++) if (turn(i, (i + 1) % n, (i + 2) % n) < -1e-9) convex = false
  if (convex) {
    for (let i = 1; i < n - 1; i++) out.push(0, i, i + 1)
    return out
  }
  const idx = Array.from({ length: n }, (_, i) => i)
  const inside = (p: number, a: number, b: number, c: number) =>
    turn(a, b, p) >= 0 && turn(b, c, p) >= 0 && turn(c, a, p) >= 0
  let guard = n * n
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false
    for (let i = 0; i < idx.length; i++) {
      const a = idx[(i + idx.length - 1) % idx.length], b = idx[i], c = idx[(i + 1) % idx.length]
      if (turn(a, b, c) <= 1e-9) continue
      let ear = true
      for (const p of idx) if (p !== a && p !== b && p !== c && inside(p, a, b, c)) { ear = false; break }
      if (!ear) continue
      out.push(a, b, c)
      idx.splice(i, 1)
      clipped = true
      break
    }
    // Not simple after all (it crosses itself): what's left as a fan
    if (!clipped) break
  }
  for (let i = 1; i < idx.length - 1; i++) out.push(idx[0], idx[i], idx[i + 1])
  return out
}
