// Exercises the miIO local (UDP) transport against a fake device that speaks
// the real protocol: it answers the handshake, then decrypts the command and
// replies with an encrypted get_status result.

import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';

import { buildPacket, parsePacket } from '../src/xiaomi/miioPacket.js';
import { MiioLocalTransport } from '../src/xiaomi/miioLocalTransport.js';
import { STATUS, TOKEN_HEX } from './fixtures.js';

const token = Buffer.from(TOKEN_HEX, 'hex');
const DEVICE_ID = Buffer.from('0a0b0c0d', 'hex');

function startFakeDevice() {
  const received = [];
  const socket = dgram.createSocket('udp4');
  socket.on('message', (msg, rinfo) => {
    const isHello = msg.readUInt16BE(2) === 0x20;
    if (isHello) {
      const reply = buildPacket({ deviceId: DEVICE_ID, ts: 1700000000, token });
      socket.send(reply, rinfo.port, rinfo.address);
      return;
    }
    const parsed = parsePacket(msg, token);
    const req = JSON.parse(parsed.payload.toString());
    received.push(req);
    const payload = Buffer.from(JSON.stringify({ id: req.id, result: [STATUS] }));
    const reply = buildPacket({ deviceId: DEVICE_ID, ts: parsed.ts + 1, token, payload });
    socket.send(reply, rinfo.port, rinfo.address);
  });
  return new Promise((resolve) => {
    socket.bind(0, '127.0.0.1', () => resolve({ socket, received, port: socket.address().port }));
  });
}

test('the miIO local transport handshakes then resolves a get_status', async (t) => {
  const device = await startFakeDevice();
  const transport = new MiioLocalTransport('127.0.0.1', token, device.port);
  t.after(() => {
    transport.disconnect();
    device.socket.close();
  });

  const result = await transport.request('get_status', []);
  assert.deepEqual(result, [STATUS]);
  assert.equal(device.received.length, 1);
  assert.equal(device.received[0].method, 'get_status');
});

test('the miIO local transport rejects when the device is unreachable', async (t) => {
  // Nothing listening on this port -> handshake times out.
  const transport = new MiioLocalTransport('127.0.0.1', token, 1);
  t.after(() => transport.disconnect());
  await assert.rejects(() => transport.request('get_status', []));
});
