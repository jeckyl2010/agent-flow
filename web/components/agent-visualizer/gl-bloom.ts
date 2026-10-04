/**
 * Bloom on the GPU: the frame is shrunk to a quarter and blurred in shaders, onto a small canvas
 * laid over the main one. The browser stretches it and adds it to the frame (`plus-lighter`) as
 * it composites the page, so nothing full-size is drawn twice a frame.
 */

/** The bloom's blur, in quarter-resolution pixels: as the 2D bloom's */
const SIGMA = 5.4
/** The bloom's resolution, against the frame's */
const SCALE = 0.25

const VERTEX = `#version 300 es
in vec2 pos;
out vec2 uv;
void main() { uv = pos * 0.5 + 0.5; gl_Position = vec4(pos, 0.0, 1.0); }`

/** A quarter-size pixel is 4×4 of the frame's: four bilinear taps, each between 2×2, average them */
const DOWNSAMPLE = `#version 300 es
precision mediump float;
uniform sampler2D src;
uniform vec2 texel;
in vec2 uv;
out vec4 color;
void main() {
  color = 0.25 * (texture(src, uv + texel * vec2(-1.0, -1.0)) + texture(src, uv + texel * vec2(1.0, -1.0))
                + texture(src, uv + texel * vec2(-1.0, 1.0)) + texture(src, uv + texel * vec2(1.0, 1.0)));
}`

/** One direction of a Gaussian, two weights to a tap: bilinear sampling blends the pair */
function blurShader(): string {
  const radius = Math.ceil(SIGMA * 3)
  const w = Array.from({ length: radius + 1 }, (_, i) => Math.exp(-(i * i) / (2 * SIGMA * SIGMA)))
  const total = w[0] + 2 * w.slice(1).reduce((a, b) => a + b, 0)
  const taps = [`${(w[0] / total).toFixed(6)} * texture(src, uv)`]
  for (let i = 1; i <= radius; i += 2) {
    const a = w[i], b = w[i + 1] ?? 0
    const offset = (i * a + (i + 1) * b) / (a + b)
    const weight = ((a + b) / total).toFixed(6)
    taps.push(`${weight} * (texture(src, uv + dir * ${offset.toFixed(4)}) + texture(src, uv - dir * ${offset.toFixed(4)}))`)
  }
  return `#version 300 es
precision mediump float;
uniform sampler2D src;
uniform vec2 dir;
in vec2 uv;
out vec4 color;
void main() { color = ${taps.join('\n    + ')}; }`
}

type Pass = { program: WebGLProgram; uniforms: Record<string, WebGLUniformLocation | null> }

export class GlBloom {
  readonly canvas: HTMLCanvasElement
  private gl: WebGL2RenderingContext | null = null
  private down!: Pass
  private blur!: Pass
  private source!: WebGLTexture
  /** Two quarter-size targets: the shrunk frame, then its horizontal blur */
  private targets: { texture: WebGLTexture; buffer: WebGLFramebuffer }[] = []
  private width = 0
  private height = 0

  /** Null where WebGL 2 isn't available: the caller falls back to the 2D bloom */
  static create(intensity: number): GlBloom | null {
    const bloom = new GlBloom(intensity)
    return bloom.gl ? bloom : null
  }

  private constructor(intensity: number) {
    this.canvas = document.createElement('canvas')
    Object.assign(this.canvas.style, {
      position: 'absolute', inset: '0', width: '100%', height: '100%',
      pointerEvents: 'none', mixBlendMode: 'plus-lighter', opacity: String(intensity),
    })
    this.canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); this.gl = null })
    this.canvas.addEventListener('webglcontextrestored', () => this.init())
    this.init()
  }

  private init(): void {
    const gl = this.canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false })
    if (!gl) return
    const compile = (fragment: string, names: string[]): Pass => {
      const program = gl.createProgram()
      for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, fragment]] as const) {
        const shader = gl.createShader(type)!
        gl.shaderSource(shader, source)
        gl.compileShader(shader)
        gl.attachShader(program, shader)
      }
      gl.bindAttribLocation(program, 0, 'pos')
      gl.linkProgram(program)
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'bloom shader')
      return { program, uniforms: Object.fromEntries(names.map(n => [n, gl.getUniformLocation(program, n)])) }
    }
    this.down = compile(DOWNSAMPLE, ['src', 'texel'])
    this.blur = compile(blurShader(), ['src', 'dir'])

    // One triangle over the whole target
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

    this.source = this.texture(gl)
    // The 2D canvas is premultiplied; keep it so, and the right way up
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    this.targets = []
    this.gl = gl
    if (this.width) this.resize(this.width / SCALE, this.height / SCALE)
  }

  private texture(gl: WebGL2RenderingContext): WebGLTexture {
    const t = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return t
  }

  /** The frame's size in device pixels */
  resize(width: number, height: number): void {
    this.width = Math.max(1, Math.round(width * SCALE))
    this.height = Math.max(1, Math.round(height * SCALE))
    const gl = this.gl
    if (!gl) return
    this.canvas.width = this.width
    this.canvas.height = this.height
    for (const t of this.targets) { gl.deleteTexture(t.texture); gl.deleteFramebuffer(t.buffer) }
    this.targets = [0, 1].map(() => {
      const texture = this.texture(gl)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.width, this.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      const buffer = gl.createFramebuffer()
      gl.bindFramebuffer(gl.FRAMEBUFFER, buffer)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
      return { texture, buffer }
    })
  }

  apply(source: HTMLCanvasElement): void {
    const gl = this.gl
    if (!gl || !this.targets.length || source.width === 0) return
    gl.viewport(0, 0, this.width, this.height)

    // The frame, shrunk
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.source)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
    gl.useProgram(this.down.program)
    gl.uniform1i(this.down.uniforms.src, 0)
    gl.uniform2f(this.down.uniforms.texel, 1 / source.width, 1 / source.height)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets[0].buffer)
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    // Blurred across, then down, onto the overlay
    gl.useProgram(this.blur.program)
    gl.uniform1i(this.blur.uniforms.src, 0)
    gl.bindTexture(gl.TEXTURE_2D, this.targets[0].texture)
    gl.uniform2f(this.blur.uniforms.dir, 1 / this.width, 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets[1].buffer)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.bindTexture(gl.TEXTURE_2D, this.targets[1].texture)
    gl.uniform2f(this.blur.uniforms.dir, 0, 1 / this.height)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  dispose(): void {
    this.gl?.getExtension('WEBGL_lose_context')?.loseContext()
    this.canvas.remove()
  }
}
