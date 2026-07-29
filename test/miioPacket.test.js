import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  buildPacket,
  decryptPayload,
  encryptPayload,
  keyIv,
  parsePacket,
} from '../src/xiaomi/miioPacket.js';
import { TOKEN_HEX } from './fixtures.js';

const token = Buffer.from(TOKEN_HEX, 'hex');

test('keyIv derives key = md5(token) and iv = md5(key || token)', () => {
  const { key, iv } = keyIv(token);
  const expectedKey = crypto.createHash('md5').update(token).digest();
  const expectedIv = crypto
    .createHash('md5')
    .update(Buffer.concat([expectedKey, token]))
    .digest();
  assert.deepEqual(key, expectedKey);
  assert.deepEqual(iv, expectedIv);
});

test('encryptPayload / decryptPayload round-trip a JSON payload (trailing null stripped)', () => {
  const json = Buffer.from(JSON.stringify({ id: 1, method: 'get_status', params: [] }));
  const encrypted = encryptPayload(json, token);
  const decrypted = decryptPayload(encrypted, token);
  assert.deepEqual(JSON.parse(decrypted.toString()), JSON.parse(json.toString()));
});

test('buildPacket / parsePacket round-trip with a valid checksum', () => {
  const deviceId = Buffer.from('01020304', 'hex');
  const payload = Buffer.from(JSON.stringify({ id: 42, method: 'app_start', params: [] }));
  const packet = buildPacket({ deviceId, ts: 1700000000, token, payload });

  // Header sanity: magic, length, device id, ts.
  assert.equal(packet.readUInt16BE(0), 0x2131);
  assert.equal(packet.readUInt16BE(2), packet.length);
  assert.deepEqual(packet.subarray(8, 12), deviceId);
  assert.equal(packet.readUInt32BE(12), 1700000000);

  // Checksum = md5(header[0:16] || token || encryptedPayload).
  const encrypted = packet.subarray(32);
  const expected = crypto
    .createHash('md5')
    .update(Buffer.concat([packet.subarray(0, 16), token, encrypted]))
    .digest();
  assert.deepEqual(packet.subarray(16, 32), expected);

  const parsed = parsePacket(packet, token);
  assert.deepEqual(parsed.deviceId, deviceId);
  assert.equal(parsed.ts, 1700000000);
  assert.deepEqual(JSON.parse(parsed.payload.toString()), {
    id: 42,
    method: 'app_start',
    params: [],
  });
});

test('parsePacket rejects a non-miIO buffer', () => {
  assert.throws(() => parsePacket(Buffer.alloc(32), token));
});
