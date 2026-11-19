import { createHmac, timingSafeEqual } from 'node:crypto';

export const ASSERTION_HEADER = 'x-rulecanvas-assertion';
export const MAX_ASSERTION_LENGTH = 4096;
export const MAX_ASSERTION_TTL_SECONDS = 300;
export const MIN_SECRET_LENGTH_BYTES = 32;

export class HostedAuthError extends Error {
  constructor(code, status = 401) {
    super('Hosted authentication assertion is invalid.');
    this.name = 'HostedAuthError';
    this.code = code;
    this.status = status;
  }
}

function fail(code, status) {
  throw new HostedAuthError(code, status);
}

function validConfig(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('auth.configuration', 500);
  if (options.requireTenant !== undefined && typeof options.requireTenant !== 'boolean') fail('auth.configuration', 500);
  if (typeof options.issuer !== 'string' || !options.issuer.trim() ||
      typeof options.audience !== 'string' || !options.audience.trim()) {
    fail('auth.configuration', 500);
  }
  const secret = Buffer.isBuffer(options.secret)
    ? options.secret
    : typeof options.secret === 'string' ? Buffer.from(options.secret, 'utf8') : null;
  if (!secret || secret.length < MIN_SECRET_LENGTH_BYTES) fail('auth.configuration', 500);

  const maximumTtl = options.maxTtlSeconds ?? MAX_ASSERTION_TTL_SECONDS;
  if (!Number.isInteger(maximumTtl) || maximumTtl < 1 || maximumTtl > MAX_ASSERTION_TTL_SECONDS) {
    fail('auth.configuration', 500);
  }
  return { secret, maximumTtl };
}

function readNow(clock) {
  let value;
  try {
    value = clock === undefined ? Date.now() / 1000 : typeof clock === 'function' ? clock() : clock;
  } catch {
    fail('auth.clock', 500);
  }
  if (value instanceof Date) value = value.getTime() / 1000;
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('auth.clock', 500);
  return value;
}

function decodeCanonicalBase64Url(segment) {
  if (typeof segment !== 'string' || !segment || !/^[A-Za-z0-9_-]+$/.test(segment) || segment.length % 4 === 1) {
    fail('auth.malformed');
  }
  const decoded = Buffer.from(segment, 'base64url');
  if (decoded.toString('base64url') !== segment) fail('auth.malformed');
  return decoded;
}

function parseObject(segment) {
  let value;
  try {
    value = JSON.parse(decodeCanonicalBase64Url(segment).toString('utf8'));
  } catch (error) {
    if (error instanceof HostedAuthError) throw error;
    fail('auth.malformed');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('auth.malformed');
  return value;
}

/** Verify a compact JWT assertion and return only the trusted subject and standard time claims. */
export function verifyAssertion(token, options = {}) {
  const { secret, maximumTtl } = validConfig(options);
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_ASSERTION_LENGTH) fail('auth.token');
  const parts = token.split('.');
  if (parts.length !== 3) fail('auth.malformed');
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = parseObject(encodedHeader);
  const headerKeys = Object.keys(header).sort();
  if (header.alg !== 'HS256' || header.typ !== 'JWT' || headerKeys.length !== 2 || headerKeys[0] !== 'alg' || headerKeys[1] !== 'typ') {
    fail('auth.header');
  }

  const signature = decodeCanonicalBase64Url(encodedSignature);
  const expected = createHmac('sha256', secret).update(`${encodedHeader}.${encodedPayload}`, 'ascii').digest();
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) fail('auth.signature');

  const claims = parseObject(encodedPayload);
  const now = readNow(options.now);
  if (claims.iss !== options.issuer) fail('auth.issuer');
  const audienceMatches = claims.aud === options.audience ||
    (Array.isArray(claims.aud) && claims.aud.includes(options.audience) && claims.aud.every((item) => typeof item === 'string'));
  if (!audienceMatches) fail('auth.audience');
  if (typeof claims.sub !== 'string' || !claims.sub.trim() || claims.sub !== claims.sub.trim() || claims.sub.length > 256 || /[\x00-\x1f\x7f]/.test(claims.sub)) {
    fail('auth.subject');
  }
  if (typeof claims.iat !== 'number' || !Number.isFinite(claims.iat) ||
      typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) fail('auth.time_claims');
  if (claims.iat > now || claims.exp <= now || claims.exp <= claims.iat || claims.exp - claims.iat > maximumTtl) {
    fail('auth.time_window');
  }
  if (claims.nbf !== undefined) {
    if (typeof claims.nbf !== 'number' || !Number.isFinite(claims.nbf) || claims.nbf > now || claims.nbf > claims.exp) {
      fail('auth.not_before');
    }
  }

  let tenantId;
  if (options.requireTenant) {
    if (typeof claims.tenant !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(claims.tenant)) {
      fail('auth.tenant');
    }
    tenantId = claims.tenant;
  }

  const principal = {
    subject: claims.sub,
    issuer: claims.iss,
    issuedAt: claims.iat,
    expiresAt: claims.exp,
  };
  if (tenantId !== undefined) principal.tenantId = tenantId;
  return Object.freeze(principal);
}

/** Read the single configured credential header and verify it. */
export function verifyRequestAssertion(request, options = {}) {
  const rawHeaders = request?.rawHeaders;
  let values = [];
  if (Array.isArray(rawHeaders)) {
    for (let i = 0; i < rawHeaders.length; i += 2) {
      if (String(rawHeaders[i]).toLowerCase() === ASSERTION_HEADER) values.push(rawHeaders[i + 1]);
    }
  } else {
    const headers = request?.headers && typeof request.headers === 'object' ? request.headers : request;
    if (headers && typeof headers === 'object') {
      values = Object.entries(headers)
        .filter(([name]) => name.toLowerCase() === ASSERTION_HEADER)
        .flatMap(([, value]) => Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);
    }
  }
  if (values.length !== 1 || typeof values[0] !== 'string') fail(values.length > 1 ? 'auth.duplicate_credential' : 'auth.missing_credential');
  return verifyAssertion(values[0].trim(), options);
}
