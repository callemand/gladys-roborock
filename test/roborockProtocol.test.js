import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { ROBOROCK_MESSAGE_PROTOCOL } from '../src/constants.js';
import { crc32, decrypt, encodeTimestamp, encrypt } from '../src/roborock/crypto.js';
import {
  buildRequestPayload,
  decodeMessage,
  decodePrefixedStream,
  encodeMessage,
  parseResponsePayload,
} from '../src/roborock/message.js';

// A Roborock local key is a 16-char string.
const LOCAL_KEY = 'abcdef0123456789';

test('encodeTimestamp scrambles the 8-char hex by the fixed permutation', () => {
  const hex = '05f5e100';
  const order = [5, 6, 3, 7, 1, 2, 0, 4];
  assert.equal(encodeTimestamp(0x5f5e100), order.map((i) => hex[i]).join(''));
  assert.equal(encodeTimestamp(0x5f5e100).length, 8);
});

test('encrypt / decrypt round-trip with the timestamp-derived key', () => {
  const timestamp = 1_700_000_000;
  const plaintext = Buffer.from(JSON.stringify({ hello: 'world' }));
  const encrypted = encrypt(plaintext, timestamp, LOCAL_KEY);
  assert.notDeepEqual(encrypted, plaintext);
  assert.deepEqual(decrypt(encrypted, timestamp, LOCAL_KEY), plaintext);
});

test('the key depends on the timestamp: a wrong one cannot decrypt', () => {
  const encrypted = encrypt(Buffer.from('a padded secret payload'), 1000, LOCAL_KEY);
  assert.throws(() => decrypt(encrypted, 2000, LOCAL_KEY));
});

test('crc32 matches the standard IEEE CRC-32', () => {
  const data = Buffer.from('The quick brown fox jumps over the lazy dog');
  assert.equal(crc32(data), zlib.crc32(data) >>> 0);
});

test('encodeMessage / decodeMessage round-trip a cloud (non-prefixed) message', () => {
  const timestamp = 1_700_000_123;
  const payload = buildRequestPayload({ id: 12345, method: 'get_status', params: [], timestamp });
  const message = encodeMessage({
    protocol: ROBOROCK_MESSAGE_PROTOCOL.RPC_REQUEST,
    payload,
    localKey: LOCAL_KEY,
    timestamp,
    seq: 100001,
    random: 55555,
    prefixed: false,
  });

  // Header layout: version, seq, random, ts, protocol, payload length.
  assert.equal(message.toString('ascii', 0, 3), '1.0');
  assert.equal(message.readUInt32BE(3), 100001);
  assert.equal(message.readUInt32BE(7), 55555);
  assert.equal(message.readUInt32BE(11), timestamp);
  assert.equal(message.readUInt16BE(15), ROBOROCK_MESSAGE_PROTOCOL.RPC_REQUEST);

  const decoded = decodeMessage(message, LOCAL_KEY);
  assert.equal(decoded.timestamp, timestamp);
  assert.deepEqual(JSON.parse(decoded.payload.toString()), JSON.parse(payload.toString()));
});

test('the trailing CRC covers the whole message', () => {
  const timestamp = 1_700_000_123;
  const payload = buildRequestPayload({ id: 1, method: 'app_charge', timestamp });
  const message = encodeMessage({ protocol: 101, payload, localKey: LOCAL_KEY, timestamp });
  const body = message.subarray(0, message.length - 4);
  assert.equal(message.readUInt32BE(message.length - 4), crc32(body));
});

test('a local (prefixed) message is 4 bytes longer and decodes from a stream', () => {
  const timestamp = 1_700_000_123;
  const payload = buildRequestPayload({ id: 1, method: 'app_start', timestamp });
  const plain = encodeMessage({ protocol: 101, payload, localKey: LOCAL_KEY, timestamp });
  const prefixed = encodeMessage({
    protocol: 101,
    payload,
    localKey: LOCAL_KEY,
    timestamp,
    prefixed: true,
  });
  assert.equal(prefixed.length, plain.length + 4);
  assert.equal(prefixed.readUInt32BE(0), plain.length);

  const { messages, rest } = decodePrefixedStream(prefixed, LOCAL_KEY);
  assert.equal(messages.length, 1);
  assert.equal(rest.length, 0);
});

test('decodePrefixedStream keeps an incomplete trailing frame as leftover', () => {
  const timestamp = 1_700_000_123;
  const payload = buildRequestPayload({ id: 1, method: 'get_status', timestamp });
  const frame = encodeMessage({
    protocol: 101,
    payload,
    localKey: LOCAL_KEY,
    timestamp,
    prefixed: true,
  });
  const { messages, rest } = decodePrefixedStream(
    Buffer.concat([frame, frame.subarray(0, 10)]),
    LOCAL_KEY,
  );
  assert.equal(messages.length, 1);
  assert.equal(rest.length, 10);
});

test('a 102 response payload is parsed to { id, result, error }', () => {
  const inner = JSON.stringify({ id: 999, result: [{ state: 8, battery: 87 }] });
  const parsed = parseResponsePayload(Buffer.from(JSON.stringify({ dps: { 102: inner }, t: 1 })));
  assert.equal(parsed.id, 999);
  assert.deepEqual(parsed.result, [{ state: 8, battery: 87 }]);
});

test('parseResponsePayload ignores anything that is not a 102 answer', () => {
  // 121 is an unsolicited state push, not an answer to our request.
  assert.equal(parseResponsePayload(Buffer.from(JSON.stringify({ dps: { 121: '5' } }))), null);
  assert.equal(parseResponsePayload(Buffer.alloc(0)), null);
  assert.equal(parseResponsePayload(Buffer.from('not json')), null);
});
