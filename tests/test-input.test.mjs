import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldIncludeTypedValue } from '../public/typed-input.js';

test('includes a required empty string as a provided value but omits optional blank values', () => {
  assert.equal(shouldIncludeTypedValue({ type: 'string', required: true }, ''), true);
  assert.equal(shouldIncludeTypedValue({ type: 'string' }, ''), true);
  assert.equal(shouldIncludeTypedValue({ type: 'string', required: false }, ''), false);
  assert.equal(shouldIncludeTypedValue({ type: 'number', required: true }, ''), false);
  assert.equal(shouldIncludeTypedValue({ type: 'enum', required: true }, 'choice'), true);
});
