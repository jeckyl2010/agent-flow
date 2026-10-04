/**
 * Bloom post-processing for holographic glow effect.
 * Takes the main canvas, extracts bright areas, blurs them,
 * and composites back with additive blending.
 */

/** The bloom's blur, in quarter-resolution pixels */
const BLUR_RADIUS = 5.4

export class BloomRenderer {
  private bloomCanvas: HTMLCanvasElement
  private bloomCtx: CanvasRenderingContext2D
  private tempCanvas: HTMLCanvasElement
  private tempCtx: CanvasRenderingContext2D
  private intensity: number

  private enabled: boolean

  constructor(intensity: number = 0.6) {
    this.intensity = intensity
    this.bloomCanvas = document.createElement('canvas')
    this.tempCanvas = document.createElement('canvas')
    const bCtx = this.bloomCanvas.getContext('2d')
    const tCtx = this.tempCanvas.getContext('2d')
    this.enabled = !!(bCtx && tCtx)
    this.bloomCtx = bCtx!
    this.tempCtx = tCtx!
  }

  resize(width: number, height: number): void {
    // A quarter resolution: a blurred image has no detail to lose, and it's a quarter the pixels
    const scale = 0.25
    this.bloomCanvas.width = width * scale
    this.bloomCanvas.height = height * scale
    this.tempCanvas.width = width * scale
    this.tempCanvas.height = height * scale
  }

  apply(sourceCanvas: HTMLCanvasElement, targetCtx: CanvasRenderingContext2D): void {
    const w = this.bloomCanvas.width
    const h = this.bloomCanvas.height

    if (w === 0 || h === 0 || !this.enabled) return

    // Draw source at half resolution
    this.bloomCtx.clearRect(0, 0, w, h)
    this.bloomCtx.drawImage(sourceCanvas, 0, 0, w, h)

    // One blur pass. The filter is already Gaussian, and Gaussians in sequence are one wider
    // Gaussian: the three passes this replaces (8, 6 and 4 at half resolution) come to √(8² + 6² + 4²)
    // ≈ 10.8, which at a quarter resolution is half that
    this.boxBlur(this.bloomCtx, this.tempCtx, w, h, BLUR_RADIUS)

    // Composite bloom over the target with additive blending
    targetCtx.save()
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
