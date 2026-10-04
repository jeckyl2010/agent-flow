/**
 * Holds a requestAnimationFrame loop to a frame rate. rAF fires at the display's rate: 120 times a
 * second on a ProMotion screen, where an unlimited loop draws twice what anyone can see. Time
 * accumulates between calls, so the rate holds on average whatever the display delivers; it never
 * saves up more than one frame, so a pause doesn't come back as a burst.
 */
export function frameLimiter(): (now: number, fps: number) => boolean {
  let last: number | undefined
  let owed = 0
  return (now, fps) => {
    const interval = 1000 / fps
    if (last === undefined) { last = now; return true }
    owed = Math.min(owed + (now - last), interval * 2)
    last = now
    if (owed < interval) return false
    owed -= interval
    return true
  }
}
