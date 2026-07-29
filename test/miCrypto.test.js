import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildEncParams,
  decryptResponse,
  encSignature,
  generateNonce,
  rc4,
  signaturePath,
  signedNonce,
} from '../src/xiaomi/miCrypto.js';
import { SSECURITY } from './fixtures.js';

test('rc4 is symmetric with the 1024-byte keystream discard', () => {
  const key = Buffer.from('a-secret-key');
  const clear = Buffer.from('hello miio cloud payload');
  const encrypted = rc4(key, clear);
  assert.notDeepEqual(encrypted, clear);
  const decrypted = rc4(key, encrypted);
  assert.deepEqual(decrypted, clear);
});

test('signedNonce = base64(sha256(b64decode(ssecurity) || b64decode(nonce)))', () => {
  const nonce = generateNonce();
  const signed = signedNonce(SSECURITY, nonce);
  // Deterministic for the same inputs.
  assert.equal(signed, signedNonce(SSECURITY, nonce));
  assert.equal(Buffer.from(signed, 'base64').length, 32);
});

test('signaturePath strips the host and the /app prefix', () => {
  assert.equal(signaturePath('https://de.api.io.mi.com/app/home/device_list'), '/home/device_list');
  assert.equal(signaturePath('https://api.io.mi.com/app/home/rpc/123'), '/home/rpc/123');
});

test('encSignature is deterministic and order-sensitive', () => {
  const url = 'https://de.api.io.mi.com/app/home/device_list';
  const signed = signedNonce(SSECURITY, generateNonce());
  const a = encSignature(url, 'POST', signed, { data: '{"x":1}' });
  const b = encSignature(url, 'POST', signed, { data: '{"x":1}' });
  const c = encSignature(url, 'POST', signed, { data: '{"x":2}' });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('buildEncParams produces the expected form fields and round-trips the response', () => {
  const url = 'https://de.api.io.mi.com/app/home/device_list';
  const nonce = generateNonce();
  const form = buildEncParams(url, 'POST', SSECURITY, nonce, { data: '{"getVirtualModel":false}' });

  // The exact POST field set expected by the Mi Home API.
  assert.deepEqual(
    Object.keys(form).sort(),
    ['_nonce', 'data', 'rc4_hash__', 'signature', 'ssecurity'].sort(),
  );
  assert.equal(form._nonce, nonce);
  assert.equal(form.ssecurity, SSECURITY);

  // A server holding ssecurity + the sent _nonce can decrypt `data` back.
  const roundTrip = decryptResponse(SSECURITY, form._nonce, form.data);
  assert.equal(roundTrip, '{"getVirtualModel":false}');
});
