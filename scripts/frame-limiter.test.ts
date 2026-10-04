import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { frameLimiter } from '../web/lib/frame-limiter'

/** Frames drawn in `seconds` of a display calling back `hz` times a second, for a target `fps` */
function drawn(hz: number, fps: number, seconds = 10, jitter = 0) {
  const limit = frameLimiter()
  let count = 0, t = 0
  while (t < seconds * 1000) {
    if (limit(t, fps)) count++
    t += 1000 / hz + (jitter ? (Math.sin(t) * jitter) : 0)
  }
  return count / seconds
}

test('a 120 Hz display draws at the target rate, not at 120', () => {
  assert.ok(Math.abs(drawn(120, 60) - 60) <= 1)
  assert.ok(Math.abs(drawn(120, 30) - 30) <= 1)
  assert.ok(Math.abs(drawn(120, 15) - 15) <= 1)
})

test('an uneven display still averages the target', () => {
  // About 34 callbacks a second, jittering: 30 must not halve to 17
  assert.ok(Math.abs(drawn(34, 30, 10, 4) - 30) <= 2)
  // A display slower than the target draws every frame it gets
  assert.ok(Math.abs(drawn(24, 30) - 24) <= 1)
})

test('a pause doesn’t come back as a burst', () => {
  const limit = frameLimiter()
  limit(0, 60)
  assert.equal(limit(5000, 60), true)
  // After the long gap, the next frame 8 ms later is not drawn: at most one frame was saved up
  let burst = 0
  for (let t = 5008; t < 5050; t += 8) if (limit(t, 60)) burst++
  assert.ok(burst <= 3)
})
