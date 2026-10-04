/**
 * Bloom post-processing for holographic glow effect.
 * Takes the main canvas, extracts bright areas, blurs them,
 * and composites back with additive blending.
 */

/** The bloom's blur, in quarter-resolution pixels */
const BLUR_RADIUS = 5.4
/** Without canvas filters: how far the glow is shrunk, then scaled back up smoothly */
const DOWNSCALE = 0.125

/**
 * Whether this browser's canvas applies `filter`. Safari accepts the property and ignores it: its
 * "blur" drew a sharp copy of the whole canvas over itself, brightening it, every frame.
 */
export function canvasFilterBlurs(): boolean {
  const c = document.createElement('canvas')
  c.width = c.height = 32
  const ctx = c.getContext('2d')
  if (!ctx) return false
  ctx.filter = 'blur(4px)'
  ctx.fillStyle = '#fff'
  ctx.fillRect(12, 12, 8, 8)
  return ctx.getImageData(8, 16, 1, 1).data[3] > 0
}

export class BloomRenderer {
  private bloomCanvas: HTMLCanvasElement
  private bloomCtx: CanvasRenderingContext2D
  private tempCanvas: HTMLCanvasElement
  private tempCtx: CanvasRenderingContext2D
  private intensity: number

  private enabled: boolean
  /** Blur with the canvas filter, or, where it does nothing, by shrinking and enlarging */
  private filterBlurs: boolean

  constructor(intensity: number = 0.6) {
    this.intensity = intensity
    this.bloomCanvas = document.createElement('canvas')
    this.tempCanvas = document.createElement('canvas')
    const bCtx = this.bloomCanvas.getContext('2d')
    const tCtx = this.tempCanvas.getContext('2d')
    this.enabled = !!(bCtx && tCtx)
    this.bloomCtx = bCtx!
    this.tempCtx = tCtx!
    this.filterBlurs = this.enabled && canvasFilterBlurs()
  }

  resize(width: number, height: number): void {
    // A quarter resolution: a blurred image has no detail to lose, and it's a quarter the pixels.
    // Without filters, smaller still: shrinking averages, and enlarging smooths, into the glow
    const scale = this.filterBlurs ? 0.25 : DOWNSCALE
    this.bloomCanvas.width = width * scale
    this.bloomCanvas.height = height * scale
    this.tempCanvas.width = width * scale
    this.tempCanvas.height = height * scale
  }

  apply(sourceCanvas: HTMLCanvasElement, targetCtx: CanvasRenderingContext2D): void {
    const w = this.bloomCanvas.width
    const h = this.bloomCanvas.height

    if (w === 0 || h === 0 || !this.enabled) return

    // Draw the source at the bloom's resolution, averaging as it shrinks
    this.bloomCtx.clearRect(0, 0, w, h)
    this.bloomCtx.imageSmoothingQuality = 'high'
    this.bloomCtx.drawImage(sourceCanvas, 0, 0, w, h)

    // One blur pass. The filter is already Gaussian, and Gaussians in sequence are one wider
    // Gaussian: the three passes this replaces (8, 6 and 4 at half resolution) come to √(8² + 6² + 4²)
    // ≈ 10.8, which at a quarter resolution is half that. Without filters the shrinking, and the
    // smooth enlarging below, are the blur
    if (this.filterBlurs) this.boxBlur(this.bloomCtx, this.tempCtx, w, h, BLUR_RADIUS)

    // Composite bloom over the target with additive blending
    targetCtx.save()
    targetCtx.imageSmoothingEnabled = true
    targetCtx.imageSmoothingQuality = 'high'
    targetCtx.globalCompositeOperation = 'lighter'
    targetCtx.globalAlpha = this.intensity
    targetCtx.drawImage(this.bloomCanvas, 0, 0, sourceCanvas.width, sourceCanvas.height)
    targetCtx.restore()
  }

  private boxBlur(
    srcCtx: CanvasRenderingContext2D,
    tmpCtx: CanvasRenderingContext2D,
    w: number,
    h: number,
    radius: number,
  ): void {
    // Use CSS filter for fast blur
    tmpCtx.clearRect(0, 0, w, h)
    tmpCtx.filter = `blur(${radius}px)`
    tmpCtx.drawImage(srcCtx.canvas, 0, 0)
    tmpCtx.filter = 'none'

    srcCtx.clearRect(0, 0, w, h)
    srcCtx.drawImage(tmpCtx.canvas, 0, 0)
  }

  setIntensity(intensity: number): void {
    this.intensity = Math.max(0, Math.min(1, intensity))
  }
}
