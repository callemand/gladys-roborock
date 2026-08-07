// End-to-end test of the ROBOROCK account path: boots the real index.js against
// a fake Gladys host, a fake Roborock REST API and an in-process MQTT broker
// standing in for the robot. Exercises the silent token login, discovery,
// polling and commands — the Xiaomi path has its own e2e (test/e2e.test.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Aedes } from 'aedes';

import { ROBOROCK_MESSAGE_PROTOCOL } from '../src/constants.js';
import { md5hex } from '../src/roborock/crypto.js';
import { decodeMessage, encodeMessage } from '../src/roborock/message.js';
import { STATUS } from './fixtures.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SELECTOR = 'roborock-test';
const TOKEN = 'test-token';

const DUID = 'duid-abc';
const LOCAL_KEY = 'abcdef0123456789';
const EMAIL = 'user@example.com';
// a second address, so a save can change the email and trigger a code request
const OTHER_EMAIL = 'other@example.com';
const EMAIL_CODE = '482913';
const RRIOT = { u: 'user-u', s: 'secret-s', h: 'hmac-h', k: 'key-k' };
const MQTT_USERNAME = md5hex(`${RRIOT.u}:${RRIOT.k}`).slice(2, 10);
const RESP_TOPIC = `rr/m/o/${RRIOT.u}/${MQTT_USERNAME}/${DUID}`;

async function waitUntil(predicate, what, timeoutMs = 15000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// --- Fake Roborock broker standing in for the robot --------------------------
async function startFakeBroker() {
  const aedes = await Aedes.createBroker();
  const server = createNetServer(aedes.handle);
  const commands = [];

  aedes.on('publish', (packet) => {
    if (!packet.topic || !packet.topic.startsWith('rr/m/i/')) {
      return;
    }
    const decoded = decodeMessage(packet.payload, LOCAL_KEY);
    if (decoded.protocol !== ROBOROCK_MESSAGE_PROTOCOL.RPC_REQUEST) {
      return;
    }
    const inner = JSON.parse(JSON.parse(decoded.payload.toString()).dps['101']);
    commands.push(inner);

    let result = 'ok';
    if (inner.method === 'get_status') {
      result = [STATUS];
    } else if (inner.method === 'get_network_info') {
      // No IP: the integration stays on the cloud transport. The local TCP path
      // has its own coverage in test/roborockProtocol.test.js.
      result = {};
    }
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(
      JSON.stringify({ dps: { 102: JSON.stringify({ id: inner.id, result }) }, t: timestamp }),
    );
    aedes.publish({
      topic: RESP_TOPIC,
      payload: encodeMessage({
        protocol: ROBOROCK_MESSAGE_PROTOCOL.RPC_RESPONSE,
        payload,
        localKey: LOCAL_KEY,
        timestamp,
      }),
      qos: 0,
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ aedes, server, commands, port: server.address().port }),
    );
  });
}

// --- Fake Roborock REST API --------------------------------------------------
function startFakeRoborock(brokerPort, { emptyHome = false } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      requests.push({ method: req.method, path: url.pathname, query: url.searchParams });
      const base = `http://127.0.0.1:${server.address().port}`;
      res.writeHead(200, { 'Content-Type': 'application/json' });

      if (url.pathname === '/api/v1/login') {
        // the password endpoint is no longer used by the integration: answer as
        // the real one does for an account without a password, so that reaching
        // it at all is a visible failure
        res.end(JSON.stringify({ code: 2012, msg: 'username or password error', data: null }));
      } else if (url.pathname === '/api/v1/sendEmailCode') {
        res.end(JSON.stringify({ code: 200, data: {} }));
      } else if (url.pathname === '/api/v1/loginWithCode') {
        if (url.searchParams.get('verifycode') !== EMAIL_CODE) {
          res.end(JSON.stringify({ code: 2012, msg: 'verify code error', data: null }));
          return;
        }
        res.end(
          JSON.stringify({
            code: 200,
            data: {
              token: 'account-token',
              rriot: { ...RRIOT, r: { r: 'EU', a: base, m: `tcp://127.0.0.1:${brokerPort}` } },
            },
          }),
        );
      } else if (url.pathname === '/api/v1/getHomeDetail') {
        res.end(JSON.stringify({ code: 200, data: { rrHomeId: emptyHome ? 9 : 7 } }));
      } else if (url.pathname === '/v3/user/homes/9') {
        // A linked account with NO robot: everything paired in the Xiaomi Home
        // app instead. It must still count as connected.
        if (!String(req.headers.authorization || '').startsWith('Hawk ')) {
          res.end(JSON.stringify({ success: false }));
          return;
        }
        res.end(
          JSON.stringify({
            success: true,
            result: { products: [], devices: [], receivedDevices: [] },
          }),
        );
      } else if (url.pathname === '/v3/user/homes/7') {
        // The Hawk header must be present on the IoT API.
        if (!String(req.headers.authorization || '').startsWith('Hawk ')) {
          res.end(JSON.stringify({ success: false }));
          return;
        }
        res.end(
          JSON.stringify({
            success: true,
            result: {
              products: [{ id: 'prod-1', name: 'Roborock S8', model: 'roborock.vacuum.a70' }],
              devices: [
                {
                  duid: DUID,
                  name: 'Robot cuisine',
                  localKey: LOCAL_KEY,
                  pv: '1.0',
                  productId: 'prod-1',
                  online: true,
                },
              ],
              receivedDevices: [],
            },
          }),
        );
      } else {
        res.end(JSON.stringify({ code: 200, data: {} }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port }));
  });
}

// --- Fake Gladys host (REST + WebSocket) -------------------------------------
function startFakeGladys(config) {
  const state = {
    discoveredDevicePosts: [],
    statePosts: [],
    transportPosts: [],
    connectionStatusPosts: [],
    commandResults: [],
    configPosts: [],
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
        respond({ config });
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
      } else if (req.method === 'POST' && req.url === '/api/integration/v1/config') {
        const written = JSON.parse(body).config || JSON.parse(body);
        state.configPosts.push(written);
        Object.assign(config, written);
        respond({ config });
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

test('the integration drives a robot on a ROBOROCK account', async (t) => {
  const broker = await startFakeBroker();
  const roborock = await startFakeRoborock(broker.port);
  // A Roborock session already linked (token + rriot), as persisted after the
  // one-time email-code link.
  const gladys = await startFakeGladys({
    roborock_email: 'user@example.com',
    session_roborock_device_id: 'STABLEDEVICEID01',
    session_roborock_username: 'user@example.com',
    session_roborock_token: 'account-token',
    session_roborock_base_url: `http://127.0.0.1:${roborock.port}`,
    session_roborock_rriot: JSON.stringify({
      ...RRIOT,
      r: { r: 'EU', a: `http://127.0.0.1:${roborock.port}`, m: `tcp://127.0.0.1:${broker.port}` },
    }),
  });
  t.after(() => {
    broker.server.close();
    broker.aedes.close();
    roborock.server.close();
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
      ROBOROCK_BASE_URLS: `http://127.0.0.1:${roborock.port}`,
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

  await t.test('reconnects silently with the stored token and publishes the robot', async () => {
    await waitUntil(
      () => gladys.state.discoveredDevicePosts.length >= 1,
      `initial discovery\n${output}`,
    );
    const devices = gladys.state.discoveredDevicePosts.at(-1);
    assert.equal(devices.length, 1);
    assert.equal(devices[0].external_id, `ext:${SELECTOR}:vacuum:${DUID}`);
    assert.equal(devices[0].name, 'Robot cuisine');
    assert.equal(devices[0].model, 'roborock.vacuum.a70');
    // The very same five features as on a Xiaomi account: the device layer is shared.
    assert.deepEqual(
      devices[0].features.map((f) => f.external_id.split(':').pop()),
      ['state', 'run-mode', 'clean-mode', 'dock', 'battery'],
    );
    // The IoT API was called with a Hawk signature.
    assert.ok(
      roborock.requests.some((r) => r.path === '/v3/user/homes/7'),
      'home data fetched',
    );
  });

  await t.test('reports the connection state on its own', async () => {
    await waitUntil(
      () => gladys.state.connectionStatusPosts.length >= 1,
      `connection status\n${output}`,
    );
    const status = gladys.state.connectionStatusPosts.at(-1);
    assert.equal(status.connected, true);
    // One account, one badge: a message would only repeat what it already says.
    assert.equal(status.message, undefined);
  });

  const pollDevice = {
    external_id: `ext:${SELECTOR}:vacuum:${DUID}`,
    selector: `ext-${SELECTOR}-vacuum-${DUID}`,
    params: [],
  };

  await t.test('a poll publishes the robot states', async () => {
    send('external-integration.device.poll', { message_id: 'poll-1', device: pollDevice });
    await waitUntil(
      () => gladys.state.commandResults.some((r) => r.message_id === 'poll-1'),
      `poll ack\n${output}`,
    );
    assert.equal(gladys.state.commandResults.find((r) => r.message_id === 'poll-1').success, true);
    // Same STATUS fixture as the Xiaomi e2e: state 8 -> 5, fan_power 102 -> auto.
    assert.deepEqual(gladys.state.statePosts.at(-1), [
      { device_feature_external_id: `ext:${SELECTOR}:vacuum:${DUID}:state`, state: 5 },
      { device_feature_external_id: `ext:${SELECTOR}:vacuum:${DUID}:run-mode`, state: 0 },
      { device_feature_external_id: `ext:${SELECTOR}:vacuum:${DUID}:clean-mode`, state: 0 },
      { device_feature_external_id: `ext:${SELECTOR}:vacuum:${DUID}:battery`, state: 87 },
    ]);
    assert.ok(
      broker.commands.some((c) => c.method === 'get_status'),
      'get_status sent',
    );
  });

  await t.test('a dock command forwards app_charge over the Roborock cloud', async () => {
    send('external-integration.device.set-value', {
      message_id: 'set-1',
      device: pollDevice,
      device_feature: {
        external_id: `ext:${SELECTOR}:vacuum:${DUID}:dock`,
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
      broker.commands.some((c) => c.method === 'app_charge'),
      'app_charge sent',
    );
  });

  await t.test('a clean-mode command forwards the verified fan-power code', async () => {
    send('external-integration.device.set-value', {
      message_id: 'set-2',
      device: pollDevice,
      device_feature: {
        external_id: `ext:${SELECTOR}:vacuum:${DUID}:clean-mode`,
        category: 'vacuum-cleaner',
        type: 'clean-mode',
      },
      value: 2, // Quiet -> 101
    });
    await waitUntil(
      () => gladys.state.commandResults.some((r) => r.message_id === 'set-2'),
      `clean ack\n${output}`,
    );
    const cmd = broker.commands.findLast((c) => c.method === 'set_custom_mode');
    assert.ok(cmd, 'set_custom_mode sent');
    assert.deepEqual(cmd.params, [101]);
  });
});

test('a Roborock account is linked with the code Roborock emails', async (t) => {
  const broker = await startFakeBroker();
  const roborock = await startFakeRoborock(broker.port);
  // Nothing stored yet: the email alone, as after a first save. There is no
  // password anywhere in this flow — the code login covers every account,
  // including the many that have no password at all.
  const gladys = await startFakeGladys({ roborock_email: EMAIL });
  t.after(() => {
    broker.server.close();
    broker.aedes.close();
    roborock.server.close();
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
      ROBOROCK_BASE_URLS: `http://127.0.0.1:${roborock.port}`,
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

  const save = (config) =>
    gladys.state.ws.send(
      JSON.stringify({ type: 'external-integration.config-updated', payload: { config } }),
    );

  await t.test('asks for no code at boot: a restart must not email the user', async () => {
    await waitUntil(
      () => gladys.state.connectionStatusPosts.length >= 1,
      `initial status\n${output}`,
    );
    assert.equal(gladys.state.connectionStatusPosts.at(-1).connected, false);
    assert.equal(
      roborock.requests.some((r) => r.path === '/api/v1/sendEmailCode'),
      false,
      'a code was requested at boot, which would email the user on every restart',
    );
  });

  await t.test('saving the email asks Roborock for a code, and says where to put it', async () => {
    const before = gladys.state.connectionStatusPosts.length;
    save({ roborock_email: OTHER_EMAIL });
    await waitUntil(
      () => gladys.state.connectionStatusPosts.length > before,
      `code requested\n${output}`,
    );
    assert.ok(
      roborock.requests.some((r) => r.path === '/api/v1/sendEmailCode'),
      `a code was requested\n${output}`,
    );
    const status = gladys.state.connectionStatusPosts.at(-1);
    assert.equal(status.connected, false);
    assert.match(status.message.fr, /code/);
    assert.match(status.message.fr, /saisissez-le ci-dessous/);
  });

  await t.test('saving an UNCHANGED email asks for a code again', async () => {
    // The regression that made this whole flow unusable: the handler returned on
    // "nothing changed", so once the email was stored, saving never asked for
    // anything and no code ever arrived. A code expires fast, so asking again is
    // the normal case.
    const asked = roborock.requests.filter((r) => r.path === '/api/v1/sendEmailCode').length;
    const before = gladys.state.connectionStatusPosts.length;
    save({ roborock_email: OTHER_EMAIL }); // exactly what was saved a moment ago
    await waitUntil(
      () => gladys.state.connectionStatusPosts.length > before,
      `code requested again\n${output}`,
    );
    assert.ok(
      roborock.requests.filter((r) => r.path === '/api/v1/sendEmailCode').length > asked,
      `a second code was requested\n${output}`,
    );
    assert.match(gladys.state.connectionStatusPosts.at(-1).message.fr, /saisissez-le ci-dessous/);
  });

  await t.test('a refused code says it is single-use, not that the account is wrong', async () => {
    const before = gladys.state.connectionStatusPosts.length;
    save({ roborock_email: OTHER_EMAIL, roborock_code: 'stale-code' });
    await waitUntil(
      () => gladys.state.connectionStatusPosts.length > before,
      `code refused\n${output}`,
    );
    const message = gladys.state.connectionStatusPosts.at(-1).message.fr;
    assert.match(message, /[Cc]e code a été refusé/);
    assert.match(message, /ne sert qu'une fois/);
    // no English smuggled into the French
    assert.equal(message.includes('refused.'), false);
  });

  await t.test('the right code links the account and publishes the robot', async () => {
    const before = gladys.state.discoveredDevicePosts.length;
    save({ roborock_email: OTHER_EMAIL, roborock_code: EMAIL_CODE });
    await waitUntil(
      () => gladys.state.discoveredDevicePosts.length > before,
      `linked with the code\n${output}`,
    );
    const devices = gladys.state.discoveredDevicePosts.at(-1);
    assert.equal(devices.length, 1);
    assert.equal(devices[0].external_id, `ext:${SELECTOR}:vacuum:${DUID}`);
  });

  await t.test('persists the session, and clears the used code without looping', async () => {
    await waitUntil(
      () => gladys.state.configPosts.some((c) => c.session_roborock_token),
      `session persisted\n${output}`,
    );
    const stored = gladys.state.configPosts.findLast((c) => c.session_roborock_token);
    assert.equal(stored.session_roborock_token, 'account-token');
    assert.ok(stored.session_roborock_rriot, 'the rriot credentials are persisted too');

    // single-use: the code is cleared from the form, and clearing it must NOT
    // ask Roborock for another one — that would be one email per round, for ever
    await waitUntil(
      () => gladys.state.configPosts.some((c) => c.roborock_code === ''),
      `code cleared\n${output}`,
    );
    const asked = roborock.requests.filter((r) => r.path === '/api/v1/sendEmailCode').length;
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(
      roborock.requests.filter((r) => r.path === '/api/v1/sendEmailCode').length,
      asked,
      'clearing the used code asked Roborock for another one',
    );
  });

  await t.test('clearing the email unlinks the account', async () => {
    const before = gladys.state.configPosts.length;
    save({ roborock_email: '' });
    await waitUntil(
      () =>
        gladys.state.configPosts
          .slice(before)
          .some((c) => c.session_roborock_token === '' && c.session_roborock_rriot === ''),
      `session cleared\n${output}`,
    );
    await waitUntil(
      () => gladys.state.discoveredDevicePosts.at(-1).length === 0,
      `robots dropped\n${output}`,
    );
  });
});

test('an account with no robot still counts as linked', async (t) => {
  // Verified on a real account: everything paired in the Xiaomi Home app, so the
  // Roborock home is empty. The link succeeds and the screen must say so.
  const broker = await startFakeBroker();
  const roborock = await startFakeRoborock(broker.port, { emptyHome: true });
  const gladys = await startFakeGladys({ roborock_email: EMAIL });
  t.after(() => {
    broker.server.close();
    broker.aedes.close();
    roborock.server.close();
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
      ROBOROCK_BASE_URLS: `http://127.0.0.1:${roborock.port}`,
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

  await t.test('reports connected, with no robot to publish', async () => {
    // wait for the boot to have run through: the handlers are registered then
    await waitUntil(
      () => gladys.state.connectionStatusPosts.length >= 1,
      `initial status\n${output}`,
    );
    gladys.state.ws.send(
      JSON.stringify({
        type: 'external-integration.config-updated',
        payload: { config: { roborock_email: EMAIL, roborock_code: EMAIL_CODE } },
      }),
    );
    await waitUntil(
      () => gladys.state.configPosts.some((c) => c.session_roborock_token),
      `session persisted\n${output}`,
    );
    await waitUntil(
      () => gladys.state.connectionStatusPosts.some((s) => s.connected === true),
      `reported connected\n${output}`,
    );
    assert.deepEqual(gladys.state.discoveredDevicePosts.at(-1), []);
  });
});
