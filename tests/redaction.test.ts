import test from 'node:test'
import assert from 'node:assert/strict'
import { redactSensitiveText } from '../src/util/redaction.js'

test('redaction removes common credentials before remote model calls', () => {
  const value = redactSensitiveText(
    'token=super-secret password: hunter2 Bearer abc.def https://example.test/private/path',
  )
  assert.match(value, /REDACTED_SECRET/u)
  assert.match(value, /REDACTED_TOKEN/u)
  assert.match(value, /REDACTED_PATH/u)
  assert.doesNotMatch(value, /hunter2|abc\.def|private\/path/u)
})

