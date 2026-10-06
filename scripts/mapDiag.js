#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Standalone Roborock map diagnostic (milestone 1).
//
// Purpose: prove a QV 35A (or any Roborock-app robot) map can be RETRIEVED and
// identify its RAW format, WITHOUT a full Gladys poll cycle and WITHOUT touching
// a production Gladys. It runs its OWN isolated login and caches the resulting
// session in a local, gitignored file so later runs need no new email code.
//
// It never prints or stores secrets (token, localKey, rriot, MQTT credentials,
// the per-request map nonce). Only the ephemeral map `endpoint` tag is shown.
//
// Usage (from a machine on the same LAN as the robot, so the local TCP transport
// can be exercised):
//
//   # 1. ask Roborock to email a login code
//   node scripts/mapDiag.js request --email you@example.com
//
//   # 2. link with the code (caches the session for next time)
//   node scripts/mapDiag.js login --email you@example.com --code 123456
//
//   # 3. list the robots the account exposes
//   node scripts/mapDiag.js devices
//
//   # 4. fetch + diagnose the map (picks the only robot, or pass --duid)
//   node scripts/mapDiag.js map [--duid <duid>] [--timeout 10000]
//
// Session cache + raw dumps live under ./.mapdiag/ (override with MAPDIAG_DIR).
// -----------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';

import { RoborockAccountClient } from '../src/roborock/client.js';
import { parseRRMap } from '../src/roborock/mapParser.js';
import { attachRoomNames } from '../src/roborock/rooms.js';
import { renderMapPng } from '../src/roborock/mapRender.js';

const OUT_DIR = process.env.MAPDIAG_DIR || path.join(process.cwd(), '.mapdiag');
const SESSION_FILE = path.join(OUT_DIR, 'session.json');

// --- tiny arg parser ---------------------------------------------------------
function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    }
  }
  return { command, flags };
}

function ensureOutDir() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

function saveSession(session) {
  ensureOutDir();
  fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
  fs.chmodSync(SESSION_FILE, 0o600);
}

function loadSession() {
  if (!fs.existsSync(SESSION_FILE)) {
    throw new Error(`No cached session at ${SESSION_FILE}. Run "request" then "login" first.`);
  }
  return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
}

// --- hex / diagnostics helpers ----------------------------------------------
function hexDump(buffer, limit = 64) {
  if (!Buffer.isBuffer(buffer)) {
    return String(buffer);
  }
  const slice = buffer.subarray(0, limit);
  const lines = [];
  for (let offset = 0; offset < slice.length; offset += 16) {
    const chunk = slice.subarray(offset, offset + 16);
    const hex = [...chunk].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = [...chunk]
      .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.'))
      .join('');
    lines.push(`    ${offset.toString(16).padStart(4, '0')}  ${hex.padEnd(47)}  ${ascii}`);
  }
  return lines.join('\n');
}

function describeBuffer(name, buffer) {
  if (!Buffer.isBuffer(buffer)) {
    console.log(`  ${name}: <not a Buffer> (${typeof buffer})`);
    return;
  }
  const magic = buffer.subarray(0, 4);
  const isGzip = buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
  const isRRMap = buffer.length >= 2 && buffer[0] === 0x72 && buffer[1] === 0x72; // "rr"
  console.log(`  ${name}:`);
  console.log(`    JS type        : Buffer`);
  console.log(`    size           : ${buffer.length} bytes`);
  console.log(
    `    magic (hex)    : ${[...magic].map((b) => b.toString(16).padStart(2, '0')).join(' ')}` +
      `${isGzip ? '  (gzip 1f 8b)' : ''}${isRRMap ? '  (RRMap "rr")' : ''}`,
  );
  console.log(hexDump(buffer));
}

// --- commands ----------------------------------------------------------------
async function cmdRequest(flags) {
  const email = flags.email;
  if (!email) {
    throw new Error('Pass --email you@example.com');
  }
  const client = new RoborockAccountClient({});
  await client.requestEmailCode(email);
  // The deviceId MUST be reused between request and login or the code is refused
  // (2018). Persist a partial session so the "login" step picks up the same one.
  saveSession({ ...client.getSession(), username: email });
  console.log(`\n✅ A login code was emailed to ${email}.`);
  console.log(`   Now run: node scripts/mapDiag.js login --email ${email} --code <code>\n`);
}

async function cmdLogin(flags) {
  const email = flags.email;
  const code = flags.code ? String(flags.code) : null;
  if (!email || !code) {
    throw new Error('Pass --email you@example.com --code 123456');
  }
  // Reuse the deviceId from the "request" step if present.
  let base = {};
  try {
    base = loadSession();
  } catch {
    // no prior session: a fresh deviceId is drawn, which only works if the code
    // was requested for it — normally "request" ran first
  }
  const client = new RoborockAccountClient({ deviceId: base.deviceId });
  await client.linkWithEmailCode(email, code);
  saveSession(client.getSession());
  const devices = client.listDevices();
  console.log(`\n✅ Account linked. ${devices.length} robot(s):`);
  devices.forEach((d) => console.log(`   - ${d.duid}  ${d.name}  [${d.model || 'unknown model'}]`));
  console.log('\nSession cached. Next: node scripts/mapDiag.js map\n');
  await client.logout();
}

async function withSession(fn) {
  const session = loadSession();
  const client = new RoborockAccountClient(session);
  await client.login();
  try {
    return await fn(client);
  } finally {
    await client.logout();
  }
}

async function cmdDevices() {
  await withSession(async (client) => {
    const devices = client.listDevices();
    console.log(`\n${devices.length} robot(s):`);
    devices.forEach((d) => {
      console.log(
        `   - ${d.duid}  ${d.name}  [${d.model || 'unknown model'}]  rooms=${d.rooms.length}`,
      );
    });
    console.log('');
  });
}

async function cmdMap(flags) {
  const timeoutMs = flags.timeout ? Number(flags.timeout) : 10000;
  await withSession(async (client) => {
    const devices = client.listDevices();
    if (devices.length === 0) {
      throw new Error('No robot on this account.');
    }
    const duid = flags.duid || devices[0].duid;
    const robot = devices.find((d) => d.duid === duid);
    console.log(
      `\n=== get_map_v1 on ${duid} (${robot ? robot.name : '?'}, ${robot ? robot.model : '?'}) ===`,
    );
    console.log(`waiting up to ${timeoutMs} ms for the 301 map push...\n`);

    const result = await client.getRawMap(duid, { timeoutMs });

    console.log(`transport used   : ${result.transport}`);
    console.log(`endpoint tag     : ${result.endpoint}`);
    console.log(
      `RPC (102) ack    : ${JSON.stringify(result.ack)}${result.ackError ? `  (error: ${result.ackError})` : ''}`,
    );
    if (result.frame) {
      console.log(
        `301 frame        : protocol=${result.frame.protocol} ts=${result.frame.timestamp} payload=${result.frame.payloadLength} bytes` +
          `${result.frame.decryptError ? `  (layer-1 decrypt error: ${result.frame.decryptError})` : ''}`,
      );
    }
    console.log('');

    if (!result.frame) {
      console.log(`❌ No 301 map frame captured: ${result.error}`);
      console.log(
        '   (The robot may push the map only over one transport, or need a different command.)',
      );
      dumpAttempts(result.attempts);
      return;
    }

    ensureOutDir();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const prefix = path.join(OUT_DIR, `map-${duid}-${stamp}`);

    // Always save what we have, even on a partial/failed decode.
    describeBuffer('layer 1 (ECB-decrypted 301 payload)', result.layer1);
    fs.writeFileSync(`${prefix}.layer1.bin`, result.layer1);

    const decoded = result.decoded || {};
    console.log('');
    console.log(
      `  layer 2 header : endpoint="${decoded.endpointHeader}" endpointOk=${decoded.endpointOk} requestId=${decoded.requestId}`,
    );

    if (decoded.decrypted) {
      console.log('');
      describeBuffer('layer 3 (AES-CBC decrypted)', decoded.decrypted);
      fs.writeFileSync(`${prefix}.layer3.bin`, decoded.decrypted);
    }
    if (decoded.decompressed) {
      console.log('');
      describeBuffer('layer 4 (gunzipped RRMap)', decoded.decompressed);
      fs.writeFileSync(`${prefix}.rrmap.bin`, decoded.decompressed);
    }

    console.log('');
    if (result.ok) {
      console.log(`✅ MAP RETRIEVED AND DECODED (${decoded.decompressed.length} bytes of RRMap).`);
      console.log(`   Raw dumps saved under ${OUT_DIR}/ (prefix map-${duid}-${stamp}).`);
      if (flags.json) {
        const map = parseRRMap(decoded.decompressed);
        // Reconcile segments with the room names loaded at discovery, exactly as
        // client.getMap() does.
        map.segments = attachRoomNames(map.segments, robot ? robot.rooms : []);
        console.log('\n--- structured map (parseRRMap + room names) ---');
        console.log(summarizeMap(map));
        fs.writeFileSync(`${prefix}.map.json`, JSON.stringify(map, null, 2));
        console.log(`   full JSON saved to ${prefix}.map.json`);
      } else {
        console.log('   Re-run with --json to print/save the structured map.');
      }
    } else {
      console.log(`⚠️  Partial decode: ${result.error}`);
      console.log(`   The raw bytes we DID get are saved under ${OUT_DIR}/ for analysis.`);
    }
  });
}

function summarizeMap(map) {
  const img = map.image;
  const lines = [
    `  version        : ${map.version.major}.${map.version.minor}  (index ${map.mapIndex}, seq ${map.mapSequence})`,
    `  image          : ${img.width}x${img.height} px, ${map.pixelSizeMm} mm/px, top=${img.top} left=${img.left}`,
    `  segments       : declared=${img.segmentCountDeclared} inPixels=${img.segmentCountInPixels} walls=${img.wallPixels}px`,
    `  robot          : ${map.robot ? `x=${map.robot.x} y=${map.robot.y} angle=${map.robot.angle}` : 'none'}`,
    `  dock           : ${map.charger ? `x=${map.charger.x} y=${map.charger.y} angle=${map.charger.angle}` : 'none'}`,
    `  path           : ${map.path ? `${map.path.points.length} points` : 'none'}`,
    `  no-go areas    : ${map.noGoAreas.length}`,
    `  no-mop areas   : ${map.noMoppingAreas.length}`,
    `  virtual walls  : ${map.virtualWalls.length}`,
  ];
  map.segments.forEach((s) => {
    const room = s.roomName ? `"${s.roomName}"` : '(unnamed)';
    lines.push(
      `    segment ${s.segmentId}: ${room} ${s.pixelCount}px bbox=[${s.bbox.minX},${s.bbox.minY} → ${s.bbox.maxX},${s.bbox.maxY}]`,
    );
  });
  return lines.join('\n');
}

function dumpAttempts(attempts) {
  if (!attempts || attempts.length === 0) {
    return;
  }
  console.log('\nattempts:');
  attempts.forEach((a) => {
    console.log(`   - ${a.transport}: ok=${a.ok} error=${a.error || 'none'}`);
  });
}

// Render the map to a PNG: from a saved *.rrmap.bin (--file) or live from the robot.
async function cmdRender(flags) {
  const scale = flags.scale ? Number(flags.scale) : 3;
  ensureOutDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  const renderAndSave = (rrmap, rooms, name) => {
    const map = parseRRMap(rrmap, { includePixels: true });
    map.segments = attachRoomNames(map.segments, rooms);
    const png = renderMapPng(map, { scale });
    const out = path.join(OUT_DIR, `${name}.png`);
    fs.writeFileSync(out, png);
    console.log(`\n✅ rendered ${png.length} bytes -> ${out}`);
    console.log(summarizeMap(map));
  };

  if (flags.file) {
    renderAndSave(fs.readFileSync(flags.file), [], `render-${stamp}`);
    return;
  }

  await withSession(async (client) => {
    const devices = client.listDevices();
    const duid = flags.duid || devices[0].duid;
    const robot = devices.find((d) => d.duid === duid);
    const result = await client.getRawMap(duid, {
      timeoutMs: flags.timeout ? Number(flags.timeout) : 10000,
    });
    if (!result.ok) {
      throw new Error(`Map retrieval failed (${result.transport}): ${result.error}`);
    }
    renderAndSave(result.decoded.decompressed, robot ? robot.rooms : [], `render-${duid}-${stamp}`);
  });
}

// --- main --------------------------------------------------------------------
async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  switch (command) {
    case 'request':
      await cmdRequest(flags);
      break;
    case 'login':
      await cmdLogin(flags);
      break;
    case 'devices':
      await cmdDevices(flags);
      break;
    case 'map':
      await cmdMap(flags);
      break;
    case 'render':
      await cmdRender(flags);
      break;
    default:
      console.log(
        'Commands: request | login | devices | map [--json] | render [--file f | --scale n]',
      );
      process.exitCode = command ? 1 : 0;
  }
}

main().then(
  () => {
    // Give any lingering MQTT socket a tick to close, then exit cleanly.
    setTimeout(() => process.exit(process.exitCode || 0), 200);
  },
  (err) => {
    console.error(`\n❌ ${err.message}`);
    process.exit(1);
  },
);
