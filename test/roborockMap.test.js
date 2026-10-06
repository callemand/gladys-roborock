import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { createServer } from 'node:net';

import { ROBOROCK_MESSAGE_PROTOCOL } from '../src/constants.js';
import { md5 } from '../src/roborock/crypto.js';
import {
  buildRequestPayload,
  decodePrefixedStream,
  encodeMessage,
} from '../src/roborock/message.js';
import { buildMapSecurity, decodeMapFrame } from '../src/roborock/map.js';
import { RoborockLocalTransport } from '../src/roborock/localTransport.js';

const LOCAL_KEY = 'abcdef0123456789';

// Build a protocol-301 map payload the way a robot does: 24-byte header
// (endpoint tag + request id) then AES-128-CBC(gzip(rrmap), nonce), zero IV.
function buildMapPayload({ endpoint, nonce, requestId, rrmap }) {
  const header = Buffer.alloc(24);
  Buffer.from(endpoint, 'latin1').copy(header, 0); // 8 bytes
  header.writeUInt16LE(requestId, 16);
  const gz = zlib.gzipSync(rrmap);
  const cipher = crypto.createCipheriv('aes-128-cbc', nonce, Buffer.alloc(16));
  const body = Buffer.concat([cipher.update(gz), cipher.final()]);
  return Buffer.concat([header, body]);
}

test('buildMapSecurity derives the 8-char endpoint and a 16-byte nonce', () => {
  const key = 'some-rriot-k-value';
  const security = buildMapSecurity(key);
  assert.equal(security.endpoint, md5(Buffer.from(key)).subarray(8, 14).toString('base64'));
  assert.equal(security.endpoint.length, 8);
  assert.equal(security.nonce.length, 16);
  assert.equal(security.payload.security.endpoint, security.endpoint);
  assert.equal(security.payload.security.nonce, security.nonce.toString('hex'));
});

test('buildMapSecurity refuses to build without rriot.k', () => {
  assert.throws(() => buildMapSecurity(null), /rriot\.k is required/);
});

test('buildRequestPayload embeds the security object get_map_v1 needs', () => {
  const security = buildMapSecurity('k');
  const payload = buildRequestPayload({
    id: 42,
    method: 'get_map_v1',
    params: [],
    extra: security.payload,
  });
  const inner = JSON.parse(JSON.parse(payload.toString()).dps['101']);
  assert.equal(inner.method, 'get_map_v1');
  assert.deepEqual(inner.security, security.payload.security);
});

test('decodeMapFrame unwraps header + AES-CBC + gzip to the RRMap bytes', () => {
  const security = buildMapSecurity('k');
  const rrmap = Buffer.concat([Buffer.from('rr'), crypto.randomBytes(200)]);
  const payload = buildMapPayload({
    endpoint: security.endpoint,
    nonce: security.nonce,
    requestId: 777,
    rrmap,
  });

  const decoded = decodeMapFrame(payload, security);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.endpointOk, true);
  assert.equal(decoded.requestId, 777);
  assert.deepEqual(decoded.decompressed, rrmap);
});

test('decodeMapFrame flags a frame addressed to another client', () => {
  // The endpoint tag is derived from the account rriot.k, so a DIFFERENT account
  // key is what makes a frame "someone else's".
  const mine = buildMapSecurity('my-account-key');
  const other = buildMapSecurity('another-account-key');
  const rrmap = Buffer.from('rr-data');
  const payload = buildMapPayload({
    endpoint: other.endpoint,
    nonce: other.nonce,
    requestId: 1,
    rrmap,
  });
  // Decoded with MY security: the endpoint tag will not match, and the body
  // cannot be decrypted with my nonce.
  const decoded = decodeMapFrame(payload, mine);
  assert.equal(decoded.endpointOk, false);
  assert.equal(decoded.ok, false);
  assert.match(decoded.error, /AES-CBC|gzip/);
});

test('decodeMapFrame never throws on a short/garbage frame', () => {
  const security = buildMapSecurity('k');
  const tooShort = decodeMapFrame(Buffer.alloc(10), security);
  assert.equal(tooShort.ok, false);
  assert.match(tooShort.error, /too short/);

  const garbageBody = Buffer.concat([Buffer.alloc(24), crypto.randomBytes(48)]);
  Buffer.from(security.endpoint, 'latin1').copy(garbageBody, 0);
  const garbage = decodeMapFrame(garbageBody, security);
  assert.equal(garbage.ok, false);
  assert.equal(garbage.endpointOk, true);
  assert.ok(garbage.error);
});

test('the local transport captures a 301 map push after get_map_v1', async (t) => {
  const rrmap = Buffer.concat([Buffer.from('rr'), crypto.randomBytes(500)]);

  // A fake robot: answers get_map_v1 with a 102 ack AND a 301 map frame built
  // from the security the client sent.
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      const { messages, rest } = decodePrefixedStream(buffer, LOCAL_KEY);
      buffer = rest;
      for (const message of messages) {
        if (message.protocol !== ROBOROCK_MESSAGE_PROTOCOL.RPC_REQUEST) {
          continue;
        }
        const inner = JSON.parse(JSON.parse(message.payload.toString()).dps['101']);
        if (inner.method !== 'get_map_v1') {
          continue;
        }
        const timestamp = Math.floor(Date.now() / 1000);
        // 102 ack
        socket.write(
          encodeMessage({
            protocol: ROBOROCK_MESSAGE_PROTOCOL.RPC_RESPONSE,
            payload: Buffer.from(
              JSON.stringify({
                dps: { 102: JSON.stringify({ id: inner.id, result: ['ok'] }) },
                t: timestamp,
              }),
            ),
            localKey: LOCAL_KEY,
            timestamp,
            prefixed: true,
          }),
        );
        // 301 map, encrypted with the nonce the client asked us to use
        const payload = buildMapPayload({
          endpoint: inner.security.endpoint,
          nonce: Buffer.from(inner.security.nonce, 'hex'),
          requestId: inner.id,
          rrmap,
        });
        socket.write(
          encodeMessage({
            protocol: ROBOROCK_MESSAGE_PROTOCOL.MAP_RESPONSE,
            payload,
            localKey: LOCAL_KEY,
            timestamp,
            prefixed: true,
          }),
        );
      }
    });
  });

  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });

  const transport = new RoborockLocalTransport('duid-test', '127.0.0.1', LOCAL_KEY, port);
  t.after(() => {
    transport.disconnect();
    server.close();
  });

  const security = buildMapSecurity('rriot-k');
  const framePromise = transport.armRawFrame(ROBOROCK_MESSAGE_PROTOCOL.MAP_RESPONSE, 3000);
  const ack = await transport.request('get_map_v1', [], security.payload);
  assert.deepEqual(ack, ['ok']);

  const frame = await framePromise;
  assert.equal(frame.protocol, ROBOROCK_MESSAGE_PROTOCOL.MAP_RESPONSE);

  const decoded = decodeMapFrame(frame.payload, security);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.endpointOk, true);
  assert.deepEqual(decoded.decompressed, rrmap);
});
