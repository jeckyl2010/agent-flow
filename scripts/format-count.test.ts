import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { formatCount } from '../web/lib/utils'

test('counts read at a glance', () => {
  assert.equal(formatCount(895.4), '895')
  assert.equal(formatCount(12_400), '12.4k')
  assert.equal(formatCount(504_000), '504k')
  assert.equal(formatCount(62_305_000), '62.3M')
  assert.equal(formatCount(1_200_000_000), '1.2B')
  assert.equal(formatCount(0), '0')
})
