import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { activityTracker } from '../web/lib/activity'

const quiet = (lastEvent: unknown) => ({ lastEvent, particles: 0, effects: 0, dragging: false })

test('a new event keeps the canvas active, even once the capped log stops growing', () => {
  const t = activityTracker(4000)
  const log = Array.from({ length: 5000 }, (_, i) => ({ i }))
  t.active(0, quiet(log.at(-1)))
  assert.equal(t.active(5000, quiet(log.at(-1))), false)   // settled
  // At the cap: the oldest event goes, a new one arrives, the length stays 5000
  log.shift(); log.push({ i: 5000 })
  assert.equal(log.length, 5000)
  assert.equal(t.active(5100, quiet(log.at(-1))), true)
  assert.equal(t.active(9000, quiet(log.at(-1))), true)    // within the window
  assert.equal(t.active(9200, quiet(log.at(-1))), false)   // and settled after it
})

test('particles, effects, a drag and pointer input keep it active', () => {
  const t = activityTracker(4000)
  const e = {}
  t.active(0, quiet(e))
  assert.equal(t.active(5000, { ...quiet(e), particles: 3 }), true)
  assert.equal(t.active(9100, quiet(e)), false)
  t.touch(9200)
  assert.equal(t.active(9300, quiet(e)), true)
  assert.equal(t.active(20000, { ...quiet(e), dragging: true }), true)
})
