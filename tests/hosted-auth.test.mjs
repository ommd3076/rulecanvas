import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  ASSERTION_HEADER,
  HostedAuthError,
  MAX_ASSERTION_TTL_SECONDS,
  MIN_SECRET_LENGTH_BYTES,
  verifyAssertion,
  verifyRequestAssertion,
} from '../src/hosted-auth.mjs';

const secret = Buffer.from('0123456789abcdef0123456789abcdef');
const now = 1_700_000_000;
const options = { secret, issuer: 'https://auth.example.test', audience: 'rulecanvas-test', now };

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signSegments(header, payload, key = secret) {
  const input = `${header}.${payload}`;
  const signature = createHmac('sha256', key).update(input, 'ascii').digest('base64url');
  return `${input}.${signature}`;
}

function makeToken(payload = {}, header = { alg: 'HS256', typ: 'JWT' }, key = secret) {
  return signSegments(encode(header), encode({
    iss: options.issuer,
    aud: options.audience,
    sub: 'user-17',
    iat: now - 1,
    exp: now + 60,
    ...payload,
  }), key);
}

function assertAuthCode(fn, code) {
  assert.throws(fn, (error) => error instanceof HostedAuthError && error.code === code);
}

test('verifies a deterministic HS256 assertion and returns only trusted identity/time fields', () => {
  const principal = verifyAssertion(makeToken({ roles: ['admin'], tenant: 'tenant-secret', email: 'private@example.test' }), options);
  assert.deepEqual(principal, {
    subject: 'user-17',
    issuer: options.issuer,
    issuedAt: now - 1,
    expiresAt: now + 60,
  });
  assert.equal(Object.hasOwn(principal, 'roles'), false);
  assert.equal(Object.hasOwn(principal, 'tenant'), false);
  assert.equal(Object.hasOwn(principal, 'claims'), false);
  assert.equal(Object.isFrozen(principal), true);
});

test('requires exactly the fixed HS256 JWT header and a valid signature', () => {
  assertAuthCode(() => verifyAssertion(makeToken({}, { alg: 'none', typ: 'JWT' }), options), 'auth.header');
  assertAuthCode(() => verifyAssertion(makeToken({}, { alg: 'HS256', typ: 'JWT', kid: 'key-1' }), options), 'auth.header');
  assertAuthCode(() => verifyAssertion(makeToken({}, { alg: 'HS256', typ: 'JOSE' }), options), 'auth.header');
  const [header, payload, signature] = makeToken().split('.');
  const tampered = `${header}.${payload}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
  assertAuthCode(() => verifyAssertion(tampered, options), 'auth.signature');
});

test('rejects padded and noncanonical base64url segments and oversized assertions', () => {
  const token = makeToken();
  const [header, payload, signature] = token.split('.');
  assertAuthCode(() => verifyAssertion(signSegments(`${header}=`, payload), options), 'auth.malformed');
  assertAuthCode(() => verifyAssertion(signSegments(header, `${payload}=`), options), 'auth.malformed');
  assertAuthCode(() => verifyAssertion('x'.repeat(4097), options), 'auth.token');
});

test('requires explicit matching issuer and audience and a short required time window', () => {
  assertAuthCode(() => verifyAssertion(makeToken({ iss: 'other' }), options), 'auth.issuer');
  assertAuthCode(() => verifyAssertion(makeToken({ aud: 'other' }), options), 'auth.audience');
  assertAuthCode(() => verifyAssertion(makeToken({ iat: undefined }), options), 'auth.time_claims');
  assertAuthCode(() => verifyAssertion(makeToken({ exp: now }), options), 'auth.time_window');
  assertAuthCode(() => verifyAssertion(makeToken({ iat: now + 1 }), options), 'auth.time_window');
  assertAuthCode(() => verifyAssertion(makeToken({ exp: now + MAX_ASSERTION_TTL_SECONDS + 2 }), options), 'auth.time_window');
  assertAuthCode(() => verifyAssertion(makeToken({ nbf: now + 1 }), options), 'auth.not_before');
  assertAuthCode(() => verifyAssertion(makeToken({ nbf: 'soon' }), options), 'auth.not_before');
});

test('requires a strong key, valid configuration, and a finite injected clock', () => {
  assert.equal(MIN_SECRET_LENGTH_BYTES, 32);
  assertAuthCode(() => verifyAssertion(makeToken(), { ...options, secret: 'short' }), 'auth.configuration');
  assertAuthCode(() => verifyAssertion(makeToken(), { ...options, issuer: '' }), 'auth.configuration');
  assertAuthCode(() => verifyAssertion(makeToken(), { ...options, audience: '' }), 'auth.configuration');
  assertAuthCode(() => verifyAssertion(makeToken(), { ...options, now: Number.NaN }), 'auth.clock');
  assertAuthCode(() => verifyAssertion(makeToken(), { ...options, now: () => Infinity }), 'auth.clock');
  assertAuthCode(() => verifyAssertion(makeToken(), { ...options, now: () => { throw new Error('clock'); } }), 'auth.clock');
});

test('requires exactly one assertion credential and rejects duplicate raw Node headers', () => {
  const token = makeToken();
  assert.deepEqual(
    verifyRequestAssertion({ headers: { [ASSERTION_HEADER]: token } }, options),
    verifyAssertion(token, options),
  );
  assertAuthCode(() => verifyRequestAssertion({ headers: { authorization: `Bearer ${token}` } }, options), 'auth.missing_credential');
  assertAuthCode(() => verifyRequestAssertion({ headers: { [ASSERTION_HEADER]: [token, token] } }, options), 'auth.duplicate_credential');
  assertAuthCode(() => verifyRequestAssertion({ headers: { [ASSERTION_HEADER]: token, 'X-RuleCanvas-Assertion': token } }, options), 'auth.duplicate_credential');
  assertAuthCode(() => verifyRequestAssertion({
    rawHeaders: [ASSERTION_HEADER, token, 'X-RuleCanvas-Assertion', token],
    headers: { [ASSERTION_HEADER]: `${token}, ${token}` },
  }, options), 'auth.duplicate_credential');
});

test('ignores unsigned identity headers and never returns credential material', () => {
  const token = makeToken({ roles: ['owner'], tenant: 'signed-tenant' });
  const principal = verifyRequestAssertion({
    headers: {
      [ASSERTION_HEADER]: token,
      'x-user-id': 'forged-user',
      'x-forwarded-roles': 'admin',
    },
  }, options);
  assert.equal(principal.subject, 'user-17');
  assert.equal(JSON.stringify(principal).includes(token), false);
  assert.equal(JSON.stringify(principal).includes('forged-user'), false);
  assert.equal(JSON.stringify(principal).includes('admin'), false);
});
