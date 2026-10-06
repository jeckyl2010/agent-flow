'use client'

/**
 * Procedural audio engine using Web Audio API.
 * All sounds are synthesized — no audio files needed.
 */

export class AudioEngine {
  private ctx: AudioContext | null = null
  private masterGain: GainNode | null = null
  private _muted = true  // default muted
  private _volume = 0.5

  private ensureContext() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume()
      return
    }
    this.ctx = new AudioContext()
    this.masterGain = this.ctx.createGain()
    this.masterGain.gain.value = this._muted ? 0 : this._volume
    this.masterGain.connect(this.ctx.destination)
  }

  get muted() { return this._muted }

  setMuted(muted: boolean) {
    this._muted = muted
    if (this.masterGain) {
      this.masterGain.gain.setTargetAtTime(muted ? 0 : this._volume, this.ctx!.currentTime, 0.05)
    }
  }

  toggleMute() {
    this.setMuted(!this._muted)
    return this._muted
  }

  /** Soft click — tool starts executing */
  private playClick(freq: number, vol: number) {
    this.ensureContext()
    if (!this.ctx || !this.masterGain) return

    const now = this.ctx.currentTime
    // Use a short noise-like burst via high-freq oscillator that decays instantly
    const osc = this.ctx.createOscillator()
    const gain = this.ctx.createGain()
    const filter = this.ctx.createBiquadFilter()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(freq, now)
    osc.frequency.exponentialRampToValueAtTime(freq * 0.5, now + 0.025)
    filter.type = 'lowpass'
    filter.frequency.value = 800
    filter.Q.value = 0.5
    gain.gain.setValueAtTime(vol, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.025)
    osc.connect(filter)
    filter.connect(gain)
    gain.connect(this.masterGain)
    osc.start(now)
    osc.stop(now + 0.025)
  }

  playToolStart() { this.playClick(480, 0.06) }
  playToolEnd() { this.playClick(600, 0.08) }

  /** Soft rising shimmer — new agent spawned */
  playAgentSpawn() {
    this.ensureContext()
    if (!this.ctx || !this.masterGain) return

    const now = this.ctx.currentTime
    // Two-note rising fifth (G5 → D6), very soft and brief
    const notes = [784, 1175]
    for (let i = 0; i < notes.length; i++) {
      const osc = this.ctx.createOscillator()
      const gain = this.ctx.createGain()
      const start = now + i * 0.06
      osc.type = 'sine'
      osc.frequency.value = notes[i]
      gain.gain.setValueAtTime(0.001, start)
      gain.gain.linearRampToValueAtTime(0.03, start + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.2)
      osc.connect(gain)
      gain.connect(this.masterGain!)
      osc.start(start)
      osc.stop(start + 0.2)
    }
  }

  /** Gentle arpeggiated chord — agent completes its task */
  playAgentComplete() {
    this.ensureContext()
    if (!this.ctx || !this.masterGain) return

    const notes = [261.63, 329.63, 392.00, 493.88] // Cmaj7: C4, E4, G4, B4
    const now = this.ctx.currentTime
    const stagger = 0.07 // arpeggiate notes slightly

    for (let i = 0; i < notes.length; i++) {
      const osc = this.ctx.createOscillator()
      const gain = this.ctx.createGain()
      const start = now + i * stagger
      osc.type = 'sine'
      osc.frequency.value = notes[i]
      // Soft attack per note, gentle sustain, smooth fade
      gain.gain.setValueAtTime(0.001, start)
      gain.gain.linearRampToValueAtTime(0.022, start + 0.03)
      gain.gain.setValueAtTime(0.022, start + 0.25)
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.5)
      osc.connect(gain)
      gain.connect(this.masterGain!)
      osc.start(start)
      osc.stop(start + 0.5)
    }
  }

  /** Soft low tone — error occurred */
  playError() {
    this.ensureContext()
    if (!this.ctx || !this.masterGain) return

    const now = this.ctx.currentTime
    const osc = this.ctx.createOscillator()
    const gain = this.ctx.createGain()
    osc.type = 'triangle' // much softer than sawtooth
    osc.frequency.setValueAtTime(220, now)
    osc.frequency.exponentialRampToValueAtTime(165, now + 0.25)
    // Soft attack, gentle decay
    gain.gain.setValueAtTime(0.001, now)
    gain.gain.linearRampToValueAtTime(0.08, now + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25)
    osc.connect(gain)
    gain.connect(this.masterGain)
    osc.start(now)
    osc.stop(now + 0.25)
  }

  /** A low swell — a compaction begins: the wormhole opens */
  playWormholeOpen() {
    this.ensureContext()
    if (!this.ctx || !this.masterGain) return

    const now = this.ctx.currentTime
    for (const [freq, detune] of [[55, 0], [82.4, 6], [110, -5]] as const) {
      const osc = this.ctx.createOscillator()
      const gain = this.ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      osc.detune.value = detune
      gain.gain.setValueAtTime(0.001, now)
      gain.gain.linearRampToValueAtTime(0.035, now + 0.9)
      gain.gain.exponentialRampToValueAtTime(0.001, now + 2)
      osc.connect(gain)
      gain.connect(this.masterGain)
      osc.start(now)
      osc.stop(now + 2)
    }
  }

  /** A falling sweep into a soft organ chord — the compaction jumps: time folds, and the
   *  conversation goes on from its summary */
  playWormholeJump(delay = 0) {
    this.ensureContext()
    if (!this.ctx || !this.masterGain) return

    const now = this.ctx.currentTime + delay
    const sweep = this.ctx.createOscillator()
    const sweepGain = this.ctx.createGain()
    sweep.type = 'triangle'
    sweep.frequency.setValueAtTime(880, now)
    sweep.frequency.exponentialRampToValueAtTime(55, now + 0.45)
    sweepGain.gain.setValueAtTime(0.001, now)
    sweepGain.gain.linearRampToValueAtTime(0.05, now + 0.05)
    sweepGain.gain.exponentialRampToValueAtTime(0.001, now + 0.5)
    sweep.connect(sweepGain)
    sweepGain.connect(this.masterGain)
    sweep.start(now)
    sweep.stop(now + 0.5)

    // A2, E3, A3, C#4: an organ's open chord, swelling in as the flash fades
    const chordAt = now + 0.42
    for (const freq of [110, 164.81, 220, 277.18]) {
      for (const harmonic of [1, 2]) {
        const osc = this.ctx.createOscillator()
        const gain = this.ctx.createGain()
        osc.type = 'sine'
        osc.frequency.value = freq * harmonic
        const peak = harmonic === 1 ? 0.018 : 0.006
        gain.gain.setValueAtTime(0.001, chordAt)
        gain.gain.linearRampToValueAtTime(peak, chordAt + 0.35)
        gain.gain.setValueAtTime(peak, chordAt + 0.9)
        gain.gain.exponentialRampToValueAtTime(0.001, chordAt + 2.6)
        osc.connect(gain)
        gain.connect(this.masterGain)
        osc.start(chordAt)
        osc.stop(chordAt + 2.6)
      }
    }
  }

  dispose() {
    if (this.ctx) {
      this.ctx.close()
      this.ctx = null
      this.masterGain = null
    }
  }
}
