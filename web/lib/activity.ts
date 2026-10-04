/**
 * Whether the canvas has something happening, to draw at full rate, or is settled.
 *
 * A new event counts, judged by the log's newest entry: the log is capped and drops its oldest
 * events, so past the cap its length stops changing while events keep arriving. So do particles
 * and effects in flight, a drag, and pointer input (reported with `touch`).
 */
export interface ActivityInput {
  /** The event log's newest entry */
  lastEvent: unknown
  particles: number
  effects: number
  dragging: boolean
}

export function activityTracker(windowMs: number) {
  let at = -Infinity
  let lastEvent: unknown
  return {
    /** Pointer input, or anything else from outside the frame */
    touch(now: number) { at = now },
    /** Whether the frame at `now` is within `windowMs` of the last thing that happened */
    active(now: number, input: ActivityInput): boolean {
      if (input.particles > 0 || input.effects > 0 || input.dragging || input.lastEvent !== lastEvent) at = now
      lastEvent = input.lastEvent
      return now - at < windowMs
    },
  }
}
