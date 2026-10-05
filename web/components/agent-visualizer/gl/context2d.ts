/**
 * Canvas 2D's drawing calls, as the main view makes them, onto the painter: the view's draw code
 * runs as it is, and its paths, fills, strokes, text and pictures become the painter's triangles,
 * drawn in one call a frame. The browser no longer rasterizes each path: that was most of the view's
 * cost, on the CPU and the GPU.
 *
 * Only what the view uses is here. Paths are flattened as they're built, into the canvas's pixels
 * (CSS pixels, the painter scales to the device's). Gradients are drawn by the painter (radial as
 * rings, linear as bands colored at their edges). Shadows are drawn as canvas draws them where it
 * can't be told apart (a path or text drawn into the atlas with the real shadow) and as a soft edge
 * otherwise. A clip is a convex shape, as the view's are.
 */
import { quantize, quantizeBlur, rgba, type Painter } from './painter'
import { pathBounds } from './path-bounds'
import { glowSpecs } from '../canvas/render-cache'

class GlGradient {
  stops: Array<[number, string]> = []
  constructor(
    readonly kind: 'linear' | 'radial',
    readonly x0: number, readonly y0: number, readonly r0: number,
    readonly x1: number, readonly y1: number, readonly r1: number,
  ) {}
  addColorStop(offset: number, color: string) {
    this.stops.push([offset, color])
    this.stops.sort((a, b) => a[0] - b[0])
  }
}

type Style = string | GlGradient

interface State {
  // The transform: x' = a x + c y + e, y' = b x + d y + f
  a: number; b: number; c: number; d: number; e: number; f: number
  alpha: number
  fill: Style
  stroke: Style
  lineWidth: number
  dash: number[]
  dashOffset: number
  font: string
  align: CanvasTextAlign
  baseline: CanvasTextBaseline
  shadowBlur: number
  shadowColor: string
  shadowX: number
  shadowY: number
  /** The clip, a convex polygon in the canvas's pixels, or none */
  clip: number[] | null
}

const fresh = (): State => ({
  a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, alpha: 1, fill: '#000', stroke: '#000', lineWidth: 1,
  dash: [], dashOffset: 0, font: '10px sans-serif', align: 'start', baseline: 'alphabetic',
  shadowBlur: 0, shadowColor: 'rgba(0, 0, 0, 0)', shadowX: 0, shadowY: 0, clip: null,
})

/** Each Path2D's sprites, by a number of its own */
const pathIds = new WeakMap<Path2D, number>()
let nextPathId = 1
/** Pictures drawn with drawImage that aren't glows: each its own sprite, by a number of its own */
const imageIds = new WeakMap<object, number>()

export class GlContext2D {
  readonly canvas: HTMLCanvasElement
  private st: State = fresh()
  private stack: State[] = []
  /** The path: its subpaths, flat x, y pairs in the canvas's pixels, and which are closed */
  private subs: number[][] = []
  private closedSubs: boolean[] = []
  private cur: number[] | null = null
  /** When the path is one whole circle: drawn as a disc, round at any size */
  private circle: { x: number; y: number; r: number } | null = null
  private onlyCircle = true

  constructor(canvas: HTMLCanvasElement, private p: Painter, private dpr: () => number) {
    this.canvas = canvas
  }

  /** A new frame: the state as a fresh context's */
  reset() {
    this.st = fresh()
    this.stack.length = 0
    this.beginPath()
  }

  // ── State ───────────────────────────────────────────────────────────────────

  get fillStyle(): Style { return this.st.fill }
  set fillStyle(v: Style) { this.st.fill = v }
  get strokeStyle(): Style { return this.st.stroke }
  set strokeStyle(v: Style) { this.st.stroke = v }
  get lineWidth() { return this.st.lineWidth }
  set lineWidth(v: number) { if (v > 0 && Number.isFinite(v)) this.st.lineWidth = v }
  get globalAlpha() { return this.st.alpha }
  set globalAlpha(v: number) { if (v >= 0 && v <= 1) this.st.alpha = v }
  get font() { return this.st.font }
  set font(v: string) { this.st.font = v }
  get textAlign() { return this.st.align }
  set textAlign(v: CanvasTextAlign) { this.st.align = v }
  get textBaseline() { return this.st.baseline }
  set textBaseline(v: CanvasTextBaseline) { this.st.baseline = v }
  get shadowBlur() { return this.st.shadowBlur }
  set shadowBlur(v: number) { if (v >= 0 && Number.isFinite(v)) this.st.shadowBlur = v }
  get shadowColor() { return this.st.shadowColor }
  set shadowColor(v: string) { this.st.shadowColor = v }
  get shadowOffsetX() { return this.st.shadowX }
  set shadowOffsetX(v: number) { this.st.shadowX = v }
  get shadowOffsetY() { return this.st.shadowY }
  set shadowOffsetY(v: number) { this.st.shadowY = v }
  get lineDashOffset() { return this.st.dashOffset }
  set lineDashOffset(v: number) { this.st.dashOffset = v }
  // Accepted and not needed: the view draws everything over, with butt ends and mitred joins
  globalCompositeOperation = 'source-over'
  lineCap: CanvasLineCap = 'butt'
  lineJoin: CanvasLineJoin = 'miter'
  imageSmoothingEnabled = true
  imageSmoothingQuality: ImageSmoothingQuality = 'low'

  setLineDash(segments: number[]) {
    this.st.dash = segments.length % 2 ? [...segments, ...segments] : [...segments]
  }
  getLineDash() { return [...this.st.dash] }

  save() { this.stack.push({ ...this.st, dash: [...this.st.dash] }) }
  restore() { const s = this.stack.pop(); if (s) this.st = s }

  translate(x: number, y: number) {
    const s = this.st
    s.e += s.a * x + s.c * y
    s.f += s.b * x + s.d * y
  }
  scale(x: number, y: number) {
    const s = this.st
    s.a *= x; s.b *= x; s.c *= y; s.d *= y
  }
  rotate(angle: number) {
    const s = this.st, cos = Math.cos(angle), sin = Math.sin(angle)
    const a = s.a * cos + s.c * sin, b = s.b * cos + s.d * sin
    s.c = s.c * cos - s.a * sin; s.d = s.d * cos - s.b * sin
    s.a = a; s.b = b
  }
  setTransform(a: number | DOMMatrix2DInit = 1, b = 0, c = 0, d = 1, e = 0, f = 0) {
    if (typeof a === 'object') ({ a = 1, b = 0, c = 0, d = 1, e = 0, f = 0 } = a as Required<DOMMatrix2DInit>)
    Object.assign(this.st, { a, b, c, d, e, f })
  }
  resetTransform() { this.setTransform() }
  getTransform() { const s = this.st; return new DOMMatrix([s.a, s.b, s.c, s.d, s.e, s.f]) }

  /** How much the transform scales lengths */
  private get zoom() { const s = this.st; return Math.sqrt(Math.abs(s.a * s.d - s.b * s.c)) }

  // ── Paths ───────────────────────────────────────────────────────────────────

  beginPath() {
    this.subs = []
    this.closedSubs = []
    this.cur = null
    this.circle = null
    this.onlyCircle = true
  }

  private point(x: number, y: number) {
    const s = this.st
    this.cur!.push(s.a * x + s.c * y + s.e, s.b * x + s.d * y + s.f)
  }

  moveTo(x: number, y: number) {
    this.onlyCircle = false
    this.cur = []
    this.subs.push(this.cur)
    this.closedSubs.push(false)
    this.point(x, y)
  }

  lineTo(x: number, y: number) {
    this.onlyCircle = false
    if (!this.cur) { this.moveTo(x, y); return }
    this.point(x, y)
  }

  closePath() {
    if (!this.cur) return
    this.closedSubs[this.closedSubs.length - 1] = true
    this.cur = null
  }

  arc(x: number, y: number, r: number, a0: number, a1: number, ccw = false) {
    if (!(r >= 0)) return
    const TAU = Math.PI * 2
    let sweep: number
    if (!ccw) sweep = a1 - a0 >= TAU ? TAU : ((((a1 - a0) % TAU) + TAU) % TAU)
    else sweep = a0 - a1 >= TAU ? -TAU : -((((a0 - a1) % TAU) + TAU) % TAU)
    const whole = Math.abs(sweep) >= TAU - 1e-9
    const zoom = this.zoom
    const n = Math.max(6, Math.min(160, Math.ceil(Math.abs(sweep) * Math.sqrt(Math.max(1, r * zoom)) * 1.6)))
    // A whole circle and nothing else: the path may be drawn as a disc
    const s = this.st
    const round = Math.abs(s.a - s.d) < 1e-6 && Math.abs(s.b) < 1e-9 && Math.abs(s.c) < 1e-9
    if (whole && this.subs.length === 0 && this.onlyCircle && round) {
      this.circle = { x: s.a * x + s.e, y: s.d * y + s.f, r: r * zoom }
    } else {
      this.onlyCircle = false
      this.circle = null
    }
    const keep = this.onlyCircle
    for (let i = 0; i <= n; i++) {
      // A whole circle's last point is its first
      if (whole && i === n) break
      const t = a0 + (sweep * i) / n
      const px = x + Math.cos(t) * r, py = y + Math.sin(t) * r
      if (i === 0 && !this.cur) this.moveTo(px, py)
      else this.lineTo(px, py)
    }
    if (whole) this.closedSubs[this.closedSubs.length - 1] = true
    this.onlyCircle = keep
  }

  rect(x: number, y: number, w: number, h: number) {
    this.moveTo(x, y); this.lineTo(x + w, y); this.lineTo(x + w, y + h); this.lineTo(x, y + h); this.closePath()
  }

  roundRect(x: number, y: number, w: number, h: number, radii?: number | DOMPointInit | Array<number | DOMPointInit>) {
    const first = Array.isArray(radii) ? radii[0] : radii
    let r = typeof first === 'number' ? first : first?.x ?? 0
    r = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2))
    if (r === 0) { this.rect(x, y, w, h); return }
    const corner = (cx: number, cy: number, from: number) => {
      for (let i = 0; i <= 6; i++) {
        const t = from + (Math.PI / 2) * (i / 6)
        const px = cx + Math.cos(t) * r, py = cy + Math.sin(t) * r
        if (!this.cur) this.moveTo(px, py)
        else this.lineTo(px, py)
      }
    }
    this.cur = null
    corner(x + w - r, y + r, -Math.PI / 2)
    corner(x + w - r, y + h - r, 0)
    corner(x + r, y + h - r, Math.PI / 2)
    corner(x + r, y + r, Math.PI)
    this.closePath()
  }

  quadraticCurveTo(cx: number, cy: number, x: number, y: number) {
    if (!this.cur) { this.moveTo(cx, cy) }
    // From the current point, in the path's own units: back through the transform
    const s = this.st, det = s.a * s.d - s.b * s.c
    const lx = this.cur![this.cur!.length - 2] - s.e, ly = this.cur![this.cur!.length - 1] - s.f
    const x0 = (s.d * lx - s.c * ly) / det, y0 = (-s.b * lx + s.a * ly) / det
    for (let i = 1; i <= 16; i++) {
      const t = i / 16, mt = 1 - t
      this.lineTo(mt * mt * x0 + 2 * mt * t * cx + t * t * x, mt * mt * y0 + 2 * mt * t * cy + t * t * y)
    }
  }

  // ── Filling ─────────────────────────────────────────────────────────────────

  fill(path?: Path2D | CanvasFillRule) {
    if (path instanceof Path2D) { this.fillPath2D(path); return }
    this.fillShape(this.subs, this.onlyCircle ? this.circle : null)
  }

  fillRect(x: number, y: number, w: number, h: number) {
    const { subs, closedSubs, cur, circle, onlyCircle } = this
    this.beginPath()
    this.rect(x, y, w, h)
    this.fillShape(this.subs, null)
    Object.assign(this, { subs, closedSubs, cur, circle, onlyCircle })
  }

  strokeRect(x: number, y: number, w: number, h: number) {
    const { subs, closedSubs, cur, circle, onlyCircle } = this
    this.beginPath()
    this.rect(x, y, w, h)
    this.stroke()
    Object.assign(this, { subs, closedSubs, cur, circle, onlyCircle })
  }

  /** The frame is cleared by the painter as it begins */
  clearRect() {}

  private fillShape(subs: number[][], circle: { x: number; y: number; r: number } | null) {
    const st = this.st, style = st.fill
    if (style instanceof GlGradient) { this.fillGradient(subs, style); return }
    const [r, g, b, ca] = rgba(style)
    const a = ca * st.alpha
    if (a <= 0.001) return
    this.shadowUnder(subs, circle, a)
    if (circle && !st.clip) { this.p.disc(circle.x, circle.y, circle.r, style, st.alpha, false); return }
    for (const sub of subs) {
      const poly = st.clip ? clipConvex(sub, st.clip) : sub
      if (poly.length >= 6) this.p.polygon(poly, poly.length / 2, r, g, b, a, null, false)
    }
  }

  private fillGradient(subs: number[][], grad: GlGradient) {
    const st = this.st, s = st
    if (grad.stops.length === 0) return
    if (grad.kind === 'radial') {
      // The view fills each radial gradient over its whole circle: drawn as the gradient's rings
      const zoom = this.zoom
      const cx = s.a * grad.x1 + s.c * grad.y1 + s.e, cy = s.b * grad.x1 + s.d * grad.y1 + s.f
      this.p.radial(cx, cy, grad.r0 * zoom, grad.r1 * zoom, grad.stops.map(([o, c]) => [o, c, st.alpha] as const), false)
      return
    }
    // Linear: across bands between its stops, each colored at its edges, so the color is exact
    const x0 = s.a * grad.x0 + s.c * grad.y0 + s.e, y0 = s.b * grad.x0 + s.d * grad.y0 + s.f
    const x1 = s.a * grad.x1 + s.c * grad.y1 + s.e, y1 = s.b * grad.x1 + s.d * grad.y1 + s.f
    const gx = x1 - x0, gy = y1 - y0, gl = gx * gx + gy * gy
    if (gl < 1e-9) return
    const at = (x: number, y: number) => ((x - x0) * gx + (y - y0) * gy) / gl
    const stops = grad.stops
    const colorAt = (t: number): [number, number, number, number] => {
      if (t <= stops[0][0]) return premul(stops[0][1])
      if (t >= stops[stops.length - 1][0]) return premul(stops[stops.length - 1][1])
      let k = 0
      while (t > stops[k + 1][0]) k++
      const [o0, c0] = stops[k], [o1, c1] = stops[k + 1]
      const u = o1 > o0 ? (t - o0) / (o1 - o0) : 0
      const p0 = premul(c0), p1 = premul(c1)
      return [p0[0] + (p1[0] - p0[0]) * u, p0[1] + (p1[1] - p0[1]) * u, p0[2] + (p1[2] - p0[2]) * u, p0[3] + (p1[3] - p0[3]) * u]
    }
    const cuts = [-Infinity, ...stops.map(([o]) => o), Infinity]
    for (const sub of subs) {
      const poly = st.clip ? clipConvex(sub, st.clip) : sub
      if (poly.length < 6) continue
      for (let k = 0; k < cuts.length - 1; k++) {
        if (cuts[k + 1] <= cuts[k]) continue
        let band = clipHalf(poly, (x, y) => at(x, y) - cuts[k])
        band = clipHalf(band, (x, y) => cuts[k + 1] - at(x, y))
        const n = band.length / 2
        if (n < 3) continue
        const colors = new Float32Array(n * 4)
        for (let i = 0; i < n; i++) {
          const [pr, pg, pb, pa] = colorAt(at(band[2 * i], band[2 * i + 1]))
          // Back from premultiplied, as the painter takes colors, and through the global alpha
          colors[4 * i] = pa > 0 ? pr / pa : 0; colors[4 * i + 1] = pa > 0 ? pg / pa : 0; colors[4 * i + 2] = pa > 0 ? pb / pa : 0
          colors[4 * i + 3] = pa * st.alpha
        }
        this.p.polygon(band, n, 0, 0, 0, 0, colors, false)
      }
    }
  }

  /**
   * A shadow under a fill, roughly as canvas casts one: the shape in the shadow's color, offset,
   * and a soft edge as wide as the blur. Its strength is the shadow's color's alpha times the fill's
   */
  private shadowUnder(subs: number[][], circle: { x: number; y: number; r: number } | null, fillAlpha: number) {
    const st = this.st
    if (st.shadowBlur <= 0 && st.shadowX === 0 && st.shadowY === 0) return
    const [r, g, b, sa] = rgba(st.shadowColor)
    const a = sa * fillAlpha
    if (a <= 0.004) return
    // A shadow's blur and offset are in the canvas's pixels (the device's), not transformed
    const dpr = this.dpr(), ox = st.shadowX / dpr, oy = st.shadowY / dpr, blur = st.shadowBlur / dpr
    const color = `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, 1)`
    for (const sub of circle ? [] : subs) {
      if (sub.length < 6) continue
      const moved = sub.map((v, i) => v + (i % 2 ? oy : ox))
      this.p.polygon(moved, moved.length / 2, r, g, b, a, null, false)
      if (blur > 0) {
        this.p.path()
        for (let i = 0; i < moved.length; i += 2) this.p.to(moved[i], moved[i + 1], blur * 2, color, a * 0.5)
        this.p.stroke(false, true, true)
      }
    }
    if (circle) {
      this.p.disc(circle.x + ox, circle.y + oy, circle.r, color, a, false)
      if (blur > 0) this.p.radial(circle.x + ox, circle.y + oy, circle.r, circle.r + blur, [[0, color, a * 0.5], [1, color, 0]], false, 48)
    }
  }

  /** A Path2D the context can't read: drawn into the atlas with canvas's own fill and shadow, once a size */
  private fillPath2D(path: Path2D) {
    const st = this.st, bounds = pathBounds.get(path)
    if (!bounds || typeof st.fill !== 'string') return
    let id = pathIds.get(path)
    if (!id) { id = nextPathId++; pathIds.set(path, id) }
    const zoom = this.zoom, dpr = this.dpr()
    const q = quantize(zoom)
    const [x0, y0, x1, y1] = bounds
    // The blur in steps, as the zoom is: the logo's breathes with the node
    const shadowBlur = quantizeBlur(st.shadowBlur)
    const pad = (shadowBlur * 1.5) / dpr / q + 2 / q
    const key = `p|${id}|${q}|${st.fill}|${st.shadowColor}|${shadowBlur}`
    const fill = st.fill, shadowColor = st.shadowColor
    const sp = this.p.sprite(key, x1 - x0 + pad * 2, y1 - y0 + pad * 2, pad - x0, pad - y0, q * dpr, g => {
      g.translate(pad - x0, pad - y0)
      g.fillStyle = fill
      if (shadowBlur > 0) { g.shadowColor = shadowColor; g.shadowBlur = shadowBlur }
      g.fill(path)
    })
    if (!sp) return
    // The path's origin, on the canvas
    this.p.image(sp, st.e, st.f, zoom, st.alpha)
  }

  // ── Stroking ────────────────────────────────────────────────────────────────

  stroke() {
    const st = this.st
    if (typeof st.stroke !== 'string') return
    const [, , , ca] = rgba(st.stroke)
    if (ca * st.alpha <= 0.001) return
    const width = st.lineWidth * this.zoom
    const dpr = this.dpr()
    const shadow = st.shadowBlur > 0 ? rgba(st.shadowColor) : null
    for (let k = 0; k < this.subs.length; k++) {
      const sub = this.subs[k]
      if (sub.length < 4) continue
      const closed = this.closedSubs[k]
      const pieces = st.dash.length ? dashed(sub, closed, st.dash.map(d => d * this.zoom), st.dashOffset * this.zoom) : [sub]
      const asClosed = !st.dash.length && closed
      // Its shadow: a soft line, the blur wide either side, under it. Blurring spreads a line's
      // light without adding to it: as much light, over its width, as the line had
      if (shadow && shadow[3] > 0) {
        const spread = width + (st.shadowBlur / dpr) * 2
        const peak = Math.min(1, (width * 2) / spread)
        for (const piece of pieces) {
          this.p.path()
          for (let i = 0; i < piece.length; i += 2) this.p.to(piece[i], piece[i + 1], spread, st.shadowColor, st.alpha * ca * peak)
          this.p.stroke(false, asClosed, true)
        }
      }
      for (const piece of pieces) {
        this.p.path()
        for (let i = 0; i < piece.length; i += 2) this.p.to(piece[i], piece[i + 1], width, st.stroke, st.alpha)
        this.p.stroke(false, asClosed)
      }
    }
  }

  // ── Clipping ────────────────────────────────────────────────────────────────

  /** Clips to the path's first shape, which the view's clips are: convex */
  clip() {
    const sub = this.subs.find(s => s.length >= 6)
    if (!sub) return
    this.st.clip = this.st.clip ? clipConvex(sub, this.st.clip) : [...sub]
  }

  // ── Text ────────────────────────────────────────────────────────────────────

  fillText(text: string, x: number, y: number) {
    const st = this.st
    if (typeof st.fill !== 'string' || !text) return
    const X = st.a * x + st.c * y + st.e, Y = st.b * x + st.d * y + st.f
    const shadow = st.shadowBlur > 0 && rgba(st.shadowColor)[3] > 0 ? { color: st.shadowColor, blur: st.shadowBlur } : undefined
    const align = st.align === 'start' ? 'left' : st.align === 'end' ? 'right' : st.align
    this.p.fillText(String(text), X, Y, st.font, align, st.baseline, st.fill, st.alpha, this.zoom, shadow)
  }

  measureText(text: string): TextMetrics {
    return this.p.measure(text, this.st.font)
  }

  // ── Pictures ────────────────────────────────────────────────────────────────

  drawImage(img: CanvasImageSource, x: number, y: number, w?: number, h?: number) {
    const st = this.st
    const iw = (img as HTMLCanvasElement).width, ih = (img as HTMLCanvasElement).height
    if (!iw || !ih) return
    const sx = (w ?? iw) / iw, sy = (h ?? ih) / ih
    const zoom = this.zoom
    // A glow sprite: its gradient, drawn by the painter, exact at any size
    const glow = glowSpecs.get(img as HTMLCanvasElement)
    if (glow) {
      const cx = x + (iw * sx) / 2, cy = y + (ih * sy) / 2
      const X = st.a * cx + st.c * cy + st.e, Y = st.b * cx + st.d * cy + st.f
      const k = zoom * sx
      const ia = parseInt(glow.innerAlpha, 16) / 255, oa = parseInt(glow.outerAlpha, 16) / 255
      this.p.radial(X, Y, glow.inner * k, glow.outer * k, [[0, glow.color, ia * st.alpha], [1, glow.color, oa * st.alpha]], false, 48)
      return
    }
    let id = imageIds.get(img as object)
    if (!id) { id = nextPathId++; imageIds.set(img as object, id) }
    const sp = this.p.sprite(`i|${id}`, iw, ih, 0, 0, 1, g => g.drawImage(img, 0, 0))
    if (sp) this.p.image(sp, st.a * x + st.c * y + st.e, st.b * x + st.d * y + st.f, zoom * sx, st.alpha)
  }

  // ── Gradients ───────────────────────────────────────────────────────────────

  createLinearGradient(x0: number, y0: number, x1: number, y1: number) {
    return new GlGradient('linear', x0, y0, 0, x1, y1, 0) as unknown as CanvasGradient
  }

  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number) {
    return new GlGradient('radial', x0, y0, r0, x1, y1, r1) as unknown as CanvasGradient
  }
}

/** A color premultiplied: r, g, b times a, and a */
function premul(color: string): [number, number, number, number] {
  const [r, g, b, a] = rgba(color)
  return [r * a, g * a, b * a, a]
}

/** A polygon cut to where `side` is 0 or more, `side` linear across it */
function clipHalf(poly: number[], side: (x: number, y: number) => number): number[] {
  const out: number[] = []
  const n = poly.length / 2
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const ax = poly[2 * i], ay = poly[2 * i + 1], bx = poly[2 * j], by = poly[2 * j + 1]
    const sa = side(ax, ay), sb = side(bx, by)
    if (sa >= 0) out.push(ax, ay)
    if ((sa >= 0) !== (sb >= 0)) {
      const t = sa / (sa - sb)
      out.push(ax + (bx - ax) * t, ay + (by - ay) * t)
    }
  }
  return out
}

/** A polygon cut to a convex one: by each of its edges in turn */
function clipConvex(poly: number[], clip: number[]): number[] {
  const n = clip.length / 2
  let area = 0
  for (let i = 0, j = n - 1; i < n; j = i++) area += clip[2 * j] * clip[2 * i + 1] - clip[2 * i] * clip[2 * j + 1]
  const sign = area > 0 ? 1 : -1
  let out = poly
  for (let i = 0; i < n && out.length >= 6; i++) {
    const j = (i + 1) % n
    const ax = clip[2 * i], ay = clip[2 * i + 1], ex = clip[2 * j] - ax, ey = clip[2 * j + 1] - ay
    out = clipHalf(out, (x, y) => sign * (ex * (y - ay) - ey * (x - ax)))
  }
  return out
}

/** A polyline cut into its dashes: canvas's dash pattern, from its offset, along the line's length */
function dashed(pts: number[], closed: boolean, pattern: number[], offset: number): number[][] {
  const total = pattern.reduce((a, b) => a + b, 0)
  if (total <= 0) return [pts]
  const line = closed ? [...pts, pts[0], pts[1]] : pts
  const out: number[][] = []
  // Where in the pattern the line starts
  let k = 0, left = pattern[0]
  let o = ((offset % total) + total) % total
  while (o > 0) {
    if (o >= left) { o -= left; k = (k + 1) % pattern.length; left = pattern[k] }
    else { left -= o; o = 0 }
  }
  let piece: number[] | null = k % 2 === 0 ? [line[0], line[1]] : null
  for (let i = 0; i + 3 < line.length; i += 2) {
    let ax = line[i], ay = line[i + 1]
    const bx = line[i + 2], by = line[i + 3]
    let seg = Math.hypot(bx - ax, by - ay)
    while (seg > 0) {
      const step = Math.min(seg, left)
      const t = step / seg
      const nx = ax + (bx - ax) * t, ny = ay + (by - ay) * t
      if (piece) piece.push(nx, ny)
      seg -= step; left -= step; ax = nx; ay = ny
      if (left <= 1e-9) {
        k = (k + 1) % pattern.length
        left = pattern[k]
        if (piece) { if (piece.length >= 4) out.push(piece); piece = null }
        else piece = [ax, ay]
      }
    }
  }
  if (piece && piece.length >= 4) out.push(piece)
  return out
}
