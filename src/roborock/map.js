// -----------------------------------------------------------------------------
// Roborock map (protocol 301) request + decode.
//
// EXPERIMENTAL — milestone 1 only captures and diagnoses the raw payload; it does
// NOT yet parse the RRMap structure into rooms/walls/path.
//
// Unlike get_status, the map is NOT returned in the RPC (102) answer. get_map_v1
// answers 102 with a bare ack (e.g. ["ok"] or a sequence number) and the real
// map is PUSHED back as a separate protocol-301 frame, on the same channel
// (local TCP or cloud MQTT). Getting a decodable one requires sending a
// `security` object in the command, and the 301 frame carries FOUR layers:
//
//   layer 1  per-message AES-128-ECB (timestamp key) — removed by decodeMessage()
//   layer 2  a 24-byte header: <endpoint(8) | 8 | request_id(uint16 LE) | 6>
//   layer 3  AES-128-CBC (key = the per-request nonce we sent, IV = zero)
//   layer 4  gzip -> the RRMap binary blob
//
// Mirror of python-roborock's create_map_response_decoder / SecurityData
// (Apache-2.0, same license as this project): the algorithm is reimplemented,
// not copied.
// -----------------------------------------------------------------------------

import crypto from 'node:crypto';

import { decryptCbc, gunzip, md5 } from './crypto.js';

const MAP_HEADER_SIZE = 24;

/**
 * Build the per-request `security` object get_map_v1 needs.
 *
 * The robot tags its 301 answer with `endpoint` so the client can tell its own
 * map apart from another client's, and encrypts the map body (layer 3) with
 * `nonce`. The endpoint is derived from the account `rriot.k`; the nonce is
 * fresh random bytes per request.
 * @param {string} rriotKey the account rriot.k value
 * @returns {{ endpoint: string, nonce: Buffer, payload: object }} the security,
 *   with `payload` ready to merge into the RPC command (nonce as lowercase hex)
 */
export function buildMapSecurity(rriotKey) {
  if (!rriotKey) {
    throw new Error('rriot.k is required to request a Roborock map');
  }
  // 6 bytes of the md5 digest, base64 -> exactly 8 characters (the header slot).
  const endpoint = md5(Buffer.from(String(rriotKey)))
    .subarray(8, 14)
    .toString('base64');
  const nonce = crypto.randomBytes(16);
  return {
    endpoint,
    nonce,
    payload: { security: { endpoint, nonce: nonce.toString('hex') } },
  };
}

/**
 * Decode a map (301) frame payload (AFTER layer 1, i.e. what decodeMessage()
 * returns as `payload`). Best-effort: never throws, returns every stage it could
 * reach plus an `error` so the caller can diagnose a partial result rather than
 * losing the capture.
 * @param {Buffer} payload the layer-1-decrypted 301 payload
 * @param {{ endpoint: string, nonce: Buffer }} security the security sent in the
 *   request
 * @returns {{
 *   ok: boolean,
 *   endpointHeader: string|null,
 *   requestId: number|null,
 *   endpointOk: boolean,
 *   body: Buffer|null,
 *   decrypted: Buffer|null,
 *   decompressed: Buffer|null,
 *   error: string|null,
 * }} the decoded stages
 */
export function decodeMapFrame(payload, security) {
  const result = {
    ok: false,
    endpointHeader: null,
    requestId: null,
    endpointOk: false,
    body: null,
    decrypted: null,
    decompressed: null,
    error: null,
  };

  if (!Buffer.isBuffer(payload) || payload.length < MAP_HEADER_SIZE) {
    result.error = `map frame too short: ${payload ? payload.length : 0} bytes`;
    return result;
  }

  const header = payload.subarray(0, MAP_HEADER_SIZE);
  result.endpointHeader = header.subarray(0, 8).toString('latin1');
  result.requestId = header.readUInt16LE(16);
  result.endpointOk = security ? result.endpointHeader.startsWith(security.endpoint) : false;
  result.body = payload.subarray(MAP_HEADER_SIZE);

  try {
    result.decrypted = decryptCbc(result.body, security.nonce);
  } catch (err) {
    result.error = `layer 3 (AES-CBC) failed: ${err.message}`;
    return result;
  }

  try {
    result.decompressed = gunzip(result.decrypted);
  } catch (err) {
    result.error = `layer 4 (gzip) failed: ${err.message}`;
    return result;
  }

  result.ok = true;
  return result;
}
