// End-to-end test: boots the REAL integration process (index.js) against a
// fake Gladys host (WebSocket + REST), a fake Xiaomi cloud (HTTP: account login
// + Mi Home API) and a fake miIO device (UDP), then exercises the full flows:
// discovery, scan, poll and set-value commands over the local miIO transport.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { rc4, signedNonce } from '../src/xiaomi/miCrypto.js';
import { buildPacket, parsePacket } from '../src/xiaomi/miioPacket.js';
import { DID, MI_DEVICE, MI_OTHER_DEVICE, SSECURITY, STATUS, TOKEN_HEX } from './fixtures.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SELECTOR = 'roborock-test';
const TOKEN = 'test-token';
const token = Buffer.from(TOKEN_HEX, 'hex');
const DEVICE_ID = Buffer.from('0a0b0c0d', 'hex');

async function waitUntil(predicate, what, timeoutMs = 15000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// --- Fake miIO device (UDP) --------------------------------------------------
function startFakeDevice() {
  const received = [];
  const socket = dgram.createSocket('udp4');
  socket.on('message', (msg, rinfo) => {
    if (msg.readUInt16BE(2) === 0x20) {
      socket.send(
        buildPacket({ deviceId: DEVICE_ID, ts: 1700000000, token }),
        rinfo.port,
        rinfo.address,
      );
      return;
    }
    const parsed = parsePacket(msg, token);
    const req = JSON.parse(parsed.payload.toString());
    received.push(req);
    const result = req.method === 'get_status' ? [STATUS] : ['ok'];
    const payload = Buffer.from(JSON.stringify({ id: req.id, result }));
    socket.send(
      buildPacket({ deviceId: DEVICE_ID, ts: parsed.ts + 1, token, payload }),
      rinfo.port,
      rinfo.address,
    );
  });
  return new Promise((resolve) => {
    socket.bind(0, '127.0.0.1', () => resolve({ socket, received, port: socket.address().port }));
  });
}

// --- Fake Xiaomi cloud (silent passToken login + Mi Home API) ----------------
// LOGIN_NONCE is deliberately a 19-digit integer, beyond Number.MAX_SAFE_INTEGER:
// the fake /sts below only hands out the serviceToken when the clientSign was
// built from every digit of it, so a JSON.parse precision regression fails here.
const LOGIN_NONCE = '8847478910111751168';

function startFakeXiaomi() {
  const key = (nonce) => Buffer.from(signedNonce(SSECURITY, nonce), 'base64');
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      const base = `http://127.0.0.1:${server.address().port}`;

      if (url.pathname === '/pass/serviceLogin') {
        // Silent re-login with the persisted passToken cookie.
        const cookies = req.headers.cookie || '';
        if (!cookies.includes('passToken=') || !cookies.includes('userId=')) {
          res.end(`&&&START&&&${JSON.stringify({ code: 87001, _sign: 'x' })}`);
          return;
        }
        res.end(
          `&&&START&&&{"code":0,"result":"ok","userId":12345,"cUserId":"cuser",` +
            `"passToken":"ptoken-rotated","ssecurity":"${SSECURITY}",` +
            `"nonce":${LOGIN_NONCE},"location":"${base}/sts?d=1&ticket=0"}`,
        );
      } else if (url.pathname === '/sts') {
        const expected = crypto
          .createHash('sha1')
          .update(`nonce=${LOGIN_NONCE}&${SSECURITY}`)
          .digest('base64');
        if (url.searchParams.get('clientSign') !== expected) {
          res.writeHead(200);
          res.end('ok'); // exactly what Xiaomi does: no cookie, no error
          return;
        }
        res.writeHead(200, { 'Set-Cookie': 'serviceToken=svc-token-123; Path=/' });
        res.end('ok');
      } else if (url.pathname === '/app/home/device_list') {
        const form = new URLSearchParams(body);
        const nonce = form.get('_nonce');
        const responseJson = JSON.stringify({ result: { list: [MI_DEVICE, MI_OTHER_DEVICE] } });
        res.end(rc4(key(nonce), Buffer.from(responseJson)).toString('base64'));
      } else if (url.pathname.startsWith('/app/home/rpc/')) {
        const form = new URLSearchParams(body);
        const nonce = form.get('_nonce');
        res.end(
          rc4(key(nonce), Buffer.from(JSON.stringify({ result: ['ok'] }))).toString('base64'),
        );
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// --- Fake Gladys host (REST + WebSocket) -------------------------------------
function startFakeGladys() {
  const state = {
    discoveredDevicePosts: [],
    statePosts: [],
    transportPosts: [],
    connectionStatusPosts: [],
    commandResults: [],
    ws: null,
  };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const respond = (json) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      if (req.method === 'GET' && req.url === '/api/integration/v1/device') {
        respond([]);
      } else if (req.method === 'GET' && req.url === '/api/integration/v1/config') {
        respond({
          config: {
            session_region: 'de',
            session_user_id: '12345',
            session_pass_token: 'ptoken',
            session_device_id: 'STABLEDEVICEID01',
          },
        });
      } else if (req.method === 'POST' && req.url === '/api/integration/v1/discovered_device') {
        state.discoveredDevicePosts.push(JSON.parse(body).devices);
        respond({ success: true, count: JSON.parse(body).devices.length });
      } else if (req.method === 'POST' && req.url === '/api/integration/v1/state') {
        state.statePosts.push(JSON.parse(body).states);
        respond({ success: true });
      } else if (req.method === 'POST' && req.url === '/api/integration/v1/connection_status') {
        state.connectionStatusPosts.push(JSON.parse(body));
        respond({ success: true });
      } else if (req.method === 'POST' && req.url === '/api/integration/v1/device/transport') {
        state.transportPosts.push(JSON.parse(body).transports);
        respond({ success: true });
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    state.ws = ws;
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'authenticate.integration-request' && message.payload.token === TOKEN) {
        ws.send(JSON.stringify({ type: 'authentication.connected', payload: {} }));
      }
      if (message.type === 'external-integration.command-result') {
        state.commandResults.push(message.payload);
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
  });
}

test('the integration discovers, polls and controls a Xiaomi/Roborock robot', async (t) => {
  const device = await startFakeDevice();
  const xiaomi = await startFakeXiaomi();
  const gladys = await startFakeGladys();
  t.after(() => {
    device.socket.close();
    xiaomi.server.close();
    gladys.server.close();
  });

  let output = '';
  const child = spawn(process.execPath, ['index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      GLADYS_HOST_API_URL: `http://127.0.0.1:${gladys.port}`,
      GLADYS_INTEGRATION_TOKEN: TOKEN,
      GLADYS_INTEGRATION_SELECTOR: SELECTOR,
      XIAOMI_ACCOUNT_HOST: `http://127.0.0.1:${xiaomi.port}`,
      XIAOMI_API_BASE: `http://127.0.0.1:${xiaomi.port}/app`,
      XIAOMI_REGIONS: 'de',
      MIIO_PORT: String(device.port),
      LOG_LEVEL: 'debug',
    },
  });
  child.stdout.on('data', (d) => {
    output += d;
  });
  child.stderr.on('data', (d) => {
    output += d;
  });
  t.after(() => child.kill('SIGKILL'));

  const send = (type, payload) => gladys.state.ws.send(JSON.stringify({ type, payload }));

  await t.test(
    'on connection: logs in and publishes the discovered robot (vacuum only)',
    async () => {
      await waitUntil(
        () => gladys.state.discoveredDevicePosts.length >= 1,
        `initial discovery\n${output}`,
      );
      const devices = gladys.state.discoveredDevicePosts.at(-1);
      assert.equal(devices.length, 1); // the non-vacuum device is filtered out
      const robot = devices[0];
      assert.equal(robot.external_id, `ext:${SELECTOR}:vacuum:${DID}`);
      assert.equal(robot.name, 'Robot salon');
      assert.deepEqual(
        robot.features.map((f) => f.external_id.split(':').pop()),
        ['state', 'run-mode', 'clean-mode', 'dock', 'battery'],
      );
    },
  );

  await t.test('the connection state is reported on its own (no manual check)', async () => {
    await waitUntil(
      () => gladys.state.connectionStatusPosts.length >= 1,
      `connection status\n${output}`,
    );
    const status = gladys.state.connectionStatusPosts.at(-1);
    assert.equal(status.connected, true);
    // No message on success: the green badge is the whole story.
    assert.equal(status.message, undefined);
  });

  await t.test('a scan request republishes the robot', async () => {
    const before = gladys.state.discoveredDevicePosts.length;
    send('external-integration.scan-request', {});
    await waitUntil(
      () => gladys.state.discoveredDevicePosts.length > before,
      `scan republish\n${output}`,
    );
    assert.equal(gladys.state.discoveredDevicePosts.at(-1).length, 1);
  });

  const pollDevice = {
    external_id: `ext:${SELECTOR}:vacuum:${DID}`,
    selector: `ext-${SELECTOR}-vacuum-${DID}`,
    params: [],
  };

  await t.test('a poll publishes the robot states over the local miIO transport', async () => {
    send('external-integration.device.poll', { message_id: 'poll-1', device: pollDevice });
    await waitUntil(
      () => gladys.state.commandResults.some((r) => r.message_id === 'poll-1'),
      `poll ack\n${output}`,
    );
    const ack = gladys.state.commandResults.find((r) => r.message_id === 'poll-1');
    assert.equal(ack.success, true, ack.error);

    // STATUS: state=8 (charging->5), fan_power=102 (balanced->auto=0), battery=87.
    assert.deepEqual(gladys.state.statePosts.at(-1), [
      { device_feature_external_id: `ext:${SELECTOR}:vacuum:${DID}:state`, state: 5 },
      { device_feature_external_id: `ext:${SELECTOR}:vacuum:${DID}:run-mode`, state: 0 },
      { device_feature_external_id: `ext:${SELECTOR}:vacuum:${DID}:clean-mode`, state: 0 },
      { device_feature_external_id: `ext:${SELECTOR}:vacuum:${DID}:battery`, state: 87 },
    ]);
    assert.ok(
      device.received.some((r) => r.method === 'get_status'),
      'get_status was sent to the device',
    );

    await waitUntil(() => gladys.state.transportPosts.length >= 1, `transport badge\n${output}`);
    assert.deepEqual(gladys.state.transportPosts.at(-1), [
      { device_external_id: `ext:${SELECTOR}:vacuum:${DID}`, transport: 'local' },
    ]);
  });

  await t.test('a dock command forwards app_charge to the device', async () => {
    send('external-integration.device.set-value', {
      message_id: 'set-1',
      device: pollDevice,
      device_feature: {
        external_id: `ext:${SELECTOR}:vacuum:${DID}:dock`,
        category: 'vacuum-cleaner',
        type: 'dock',
      },
      value: 1,
    });
    await waitUntil(
      () => gladys.state.commandResults.some((r) => r.message_id === 'set-1'),
      `dock ack\n${output}`,
    );
    assert.equal(gladys.state.commandResults.find((r) => r.message_id === 'set-1').success, true);
    assert.ok(
      device.received.some((r) => r.method === 'app_charge'),
      'app_charge was sent',
    );
  });

  await t.test(
    'a clean-mode command forwards set_custom_mode with the fan-power code',
    async () => {
      send('external-integration.device.set-value', {
        message_id: 'set-2',
        device: pollDevice,
        device_feature: {
          external_id: `ext:${SELECTOR}:vacuum:${DID}:clean-mode`,
          category: 'vacuum-cleaner',
          type: 'clean-mode',
        },
        value: 2, // QUIET -> fan power 101
      });
      await waitUntil(
        () => gladys.state.commandResults.some((r) => r.message_id === 'set-2'),
        `clean ack\n${output}`,
      );
      assert.equal(gladys.state.commandResults.find((r) => r.message_id === 'set-2').success, true);
      const cmd = device.received.findLast((r) => r.method === 'set_custom_mode');
      assert.ok(cmd, 'set_custom_mode was sent');
      assert.deepEqual(cmd.params, [101]);
    },
  );
});
