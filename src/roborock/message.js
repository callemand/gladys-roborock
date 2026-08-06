// -----------------------------------------------------------------------------
// Roborock binary message framing + the RPC payload it carries.
//
// Byte layout (big-endian):
//   version    3 bytes ASCII  ("1.0")
//   seq        uint32
//   random     uint32
//   timestamp  uint32
//   protocol   uint16
//   payloadLen uint16
//   payload    <payloadLen> bytes (AES-128-ECB encrypted)
//   crc32      uint32         (CRC over every preceding byte)
//
// Local (TCP) frames add a 4-byte big-endian total-length prefix per message;
// cloud (MQTT) frames do not — MQTT provides its own framing.
//
// RPC payload (clear), protocol 101:
//   { "dps": { "101": "<json string of {id, method, params}>" }, "t": <ts> }
// The answer comes back as protocol 102 with the payload under dps["102"].
// -----------------------------------------------------------------------------

import { ROBOROCK_MESSAGE_PROTOCOL, ROBOROCK_PROTOCOL_VERSION } from '../constants.js';
import { crc32, decrypt, encrypt } from './crypto.js';

const HEADER_SIZE = 3 + 4 + 4 + 4 + 2 + 2; // 19 bytes, up to and including payloadLen

// Seeded from the clock: a counter restarting from a low value on every process
// start risks colliding with ids the device has just seen (the lesson learnt on
// the miIO side, where such a request is silently ignored).
let sequenceCounter = 100000 + (Math.floor(Date.now() / 1000) % 800000);
let requestCounter = 10000 + (Math.floor(Date.now() / 1000) % 20000);

/**
 * Next message sequence number.
 * @returns {number} the sequence number
 */
function nextSequence() {
  sequenceCounter += 1;
  if (sequenceCounter > 999999) {
    sequenceCounter = 100000;
  }
  return sequenceCounter;
}

/**
 * Next RPC request id.
 * @returns {number} the request id
 */
export function nextRequestId() {
  requestCounter += 1;
  if (requestCounter >= 32767) {
    requestCounter = 10000;
  }
  return requestCounter;
}

/**
 * Encode a big-endian uint32.
 * @param {number} value the value
 * @returns {Buffer} a 4-byte buffer
 */
function uint32be(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
}

/**
 * Build the clear payload bytes of an RPC request.
 * @param {object} params request parameters
 * @param {number} params.id the RPC request id
 * @param {string} params.method the Roborock method (e.g. "get_status")
 * @param {Array|object} [params.params] the method params
 * @param {number} [params.timestamp] unix timestamp in seconds
 * @returns {Buffer} the clear payload bytes
 */
export function buildRequestPayload({
  id,
  method,
  params = [],
  timestamp = Math.floor(Date.now() / 1000),
}) {
  const inner = JSON.stringify({ id, method, params });
  return Buffer.from(JSON.stringify({ dps: { 101: inner }, t: timestamp }));
}

/**
 * Parse the clear payload of a response message.
 * @param {Buffer} payload the decrypted payload bytes
 * @returns {{ id: number|null, result: *, error: * }|null} the parsed RPC
 *   response, or null when the payload is not a 102 RPC answer
 */
export function parseResponsePayload(payload) {
  if (!payload || payload.length === 0) {
    return null;
  }
  let outer;
  try {
    outer = JSON.parse(payload.toString('utf8'));
  } catch {
    return null;
  }
  const dps = outer && outer.dps;
  if (!dps || dps['102'] === undefined) {
    return null;
  }
  let inner;
  try {
    inner = typeof dps['102'] === 'string' ? JSON.parse(dps['102']) : dps['102'];
  } catch {
    return null;
  }
  return { id: inner.id ?? null, result: inner.result, error: inner.error };
}

/**
 * Encode a message: frame the header, encrypt the payload, append the CRC.
 * @param {object} params message parameters
 * @param {number} params.protocol the message protocol id
 * @param {Buffer} params.payload the CLEAR payload bytes
 * @param {string} params.localKey the device local key
 * @param {number} [params.timestamp] unix timestamp in seconds
 * @param {number} [params.seq] sequence number
 * @param {number} [params.random] random field
 * @param {boolean} [params.prefixed] add the 4-byte length prefix (local/TCP)
 * @returns {Buffer} the encoded message
 */
export function encodeMessage({
  protocol,
  payload,
  localKey,
  timestamp = Math.floor(Date.now() / 1000),
  seq = nextSequence(),
  random = Math.floor(10000 + Math.random() * 89999),
  prefixed = false,
}) {
  const encrypted =
    payload && payload.length > 0 ? encrypt(payload, timestamp, localKey) : Buffer.alloc(0);

  const header = Buffer.alloc(HEADER_SIZE);
  header.write(ROBOROCK_PROTOCOL_VERSION, 0, 'ascii');
  header.writeUInt32BE(seq >>> 0, 3);
  header.writeUInt32BE(random >>> 0, 7);
  header.writeUInt32BE(timestamp >>> 0, 11);
  header.writeUInt16BE(protocol, 15);
  header.writeUInt16BE(encrypted.length, 17);

  const body = Buffer.concat([header, encrypted]);
  // The CRC is only present when there is a payload.
  const message = encrypted.length > 0 ? Buffer.concat([body, uint32be(crc32(body))]) : body;

  return prefixed ? Buffer.concat([uint32be(message.length), message]) : message;
}

/**
 * Decode a single message (without the local length prefix).
 * @param {Buffer} data the raw message bytes
 * @param {string} localKey the device local key
 * @returns {{ version: string, seq: number, random: number, timestamp: number,
 *   protocol: number, payload: Buffer }} the decoded message
 */
export function decodeMessage(data, localKey) {
  if (data.length < HEADER_SIZE) {
    throw new Error(`Roborock message too short: ${data.length} bytes`);
  }
  const version = data.toString('ascii', 0, 3);
  const seq = data.readUInt32BE(3);
  const random = data.readUInt32BE(7);
  const timestamp = data.readUInt32BE(11);
  const protocol = data.readUInt16BE(15);
  const payloadLen = data.readUInt16BE(17);

  const encrypted = data.subarray(HEADER_SIZE, HEADER_SIZE + payloadLen);
  // The key depends on the timestamp of THIS message, not on ours.
  const payload = payloadLen > 0 ? decrypt(encrypted, timestamp, localKey) : Buffer.alloc(0);

  return { version, seq, random, timestamp, protocol, payload };
}

/**
 * Pull the complete messages out of a length-prefixed local (TCP) stream.
 * @param {Buffer} buffer the accumulated stream bytes
 * @param {string} localKey the device local key
 * @returns {{ messages: Array<object>, rest: Buffer }} decoded messages + leftover
 */
export function decodePrefixedStream(buffer, localKey) {
  const messages = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const length = buffer.readUInt32BE(offset);
    if (buffer.length - offset - 4 < length) {
      break; // wait for more bytes
    }
    messages.push(decodeMessage(buffer.subarray(offset + 4, offset + 4 + length), localKey));
    offset += 4 + length;
  }
  return { messages, rest: buffer.subarray(offset) };
}

export { ROBOROCK_MESSAGE_PROTOCOL };
