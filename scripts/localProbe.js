#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Local TCP probe (diagnostic) — why does the QV35A reset the local connection?
//
// python-roborock's local channel performs a HELLO handshake (protocol 0 -> 1)
// before any RPC, then PINGs (2 -> 3) to keep the socket alive. This integration
// opens the socket and sends the RPC straight away, which recent firmware may
// reject with ECONNRESET. This probe tests three behaviours against the real
// robot to confirm the cause before changing the transport:
//
//   A) connect, send nothing, watch for bytes / reset
//   B) connect, send get_status immediately (current behaviour)
//   C) connect, send HELLO, await HELLO response, then send get_status
//
// Run on the same LAN as the robot, after a cached session exists:
//   node scripts/localProbe.js
// -----------------------------------------------------------------------------

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

import { RoborockAccountClient } from '../src/roborock/client.js';
import { ROBOROCK_LOCAL_PORT } from '../src/constants.js';
import {
  buildRequestPayload,
  decodePrefixedStream,
  encodeMessage,
  nextRequestId,
} from '../src/roborock/message.js';

const OUT_DIR = process.env.MAPDIAG_DIR || path.join(process.cwd(), '.mapdiag');
const SESSION_FILE = path.join(OUT_DIR, 'session.json');

const HELLO_REQUEST = 0;
const RPC_REQUEST = 101;

function describeFrames(frames) {
  return frames.map((f) => `proto=${f.protocol} payload=${f.payload.length}B`).join(', ') || 'none';
}

// Open a socket, run `afterConnect`, collect decoded frames and the outcome.
function runProbe(label, ip, localKey, afterConnect, waitMs = 5000) {
  return new Promise((resolve) => {
    const frames = [];
    let raw = Buffer.alloc(0);
    let buffer = Buffer.alloc(0);
    let decodeError = null;
    let outcome = 'closed by us (no reset, robot silent)';
    const socket = net.createConnection({ host: ip, port: ROBOROCK_LOCAL_PORT });
    socket.setTimeout(waitMs + 2000);

    const finish = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({
        label,
        outcome: result,
        frames,
        rawLen: raw.length,
        rawHead: raw.subarray(0, 64).toString('hex'),
        decodeError,
      });
    };

    socket.once('connect', () => {
      afterConnect(socket);
      setTimeout(() => finish(outcome), waitMs);
    });
    socket.on('data', (data) => {
      raw = Buffer.concat([raw, data]);
      buffer = Buffer.concat([buffer, data]);
      try {
        const decoded = decodePrefixedStream(buffer, localKey);
        buffer = decoded.rest;
        frames.push(...decoded.messages);
      } catch (err) {
        decodeError = err.message;
      }
    });
    socket.on('error', (err) => {
      outcome =
        err.code === 'ECONNRESET'
          ? 'ECONNRESET (robot reset the socket)'
          : `error ${err.code || err.message}`;
      finish(outcome);
    });
    socket.on('close', () => finish(outcome));
  });
}

function rpcGetStatus(localKey) {
  const timestamp = Math.floor(Date.now() / 1000);
  return encodeMessage({
    protocol: RPC_REQUEST,
    payload: buildRequestPayload({
      id: nextRequestId(),
      method: 'get_status',
      params: [],
      timestamp,
    }),
    localKey,
    timestamp,
    prefixed: true,
  });
}

function helloMessage(localKey) {
  // Empty payload: encodeMessage emits a header-only, CRC-less frame.
  return encodeMessage({
    protocol: HELLO_REQUEST,
    payload: Buffer.alloc(0),
    localKey,
    seq: 1,
    random: Math.floor(10000 + Math.random() * 22767),
    prefixed: true,
  });
}

async function main() {
  if (!fs.existsSync(SESSION_FILE)) {
    throw new Error(`No cached session at ${SESSION_FILE}. Run mapDiag login first.`);
  }
  const client = new RoborockAccountClient(JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')));
  await client.login();
  const duid = client.listDevices()[0].duid;
  const localKey = client.localKeys.get(duid);
  const info = await client.sendCommand(duid, 'get_network_info', []);
  const ip = info && (info.ip || (Array.isArray(info) && info[0] && info[0].ip));
  await client.logout();

  if (!ip) {
    throw new Error('Could not discover the robot local IP via get_network_info.');
  }
  console.log(`\nRobot ${duid} local IP: ${ip}:${ROBOROCK_LOCAL_PORT}\n`);

  const a = await runProbe('A connect only (send nothing)', ip, localKey, () => {});
  const b = await runProbe('B send get_status immediately (current behaviour)', ip, localKey, (s) =>
    s.write(rpcGetStatus(localKey)),
  );
  const c = await runProbe('C HELLO then get_status', ip, localKey, (s) => {
    s.write(helloMessage(localKey));
    // give the robot a moment to answer HELLO, then send the RPC
    setTimeout(() => s.write(rpcGetStatus(localKey)), 500);
  });

  for (const r of [a, b, c]) {
    console.log(`${r.label}`);
    console.log(`   outcome   : ${r.outcome}`);
    console.log(`   raw bytes : ${r.rawLen}${r.rawHead ? ` head=${r.rawHead}` : ''}`);
    console.log(`   frames    : ${describeFrames(r.frames)}`);
    if (r.decodeError) {
      console.log(`   decodeErr : ${r.decodeError}`);
    }
    console.log('');
  }

  console.log('Interpretation:');
  console.log('  - If B resets but C gets frames (proto=1 HELLO response + proto=102 status),');
  console.log('    the fix is a HELLO handshake before RPC in localTransport.js.');
}

main().then(
  () => setTimeout(() => process.exit(0), 200),
  (err) => {
    console.error(`\n❌ ${err.message}`);
    process.exit(1);
  },
);
