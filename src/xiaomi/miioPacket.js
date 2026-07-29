// -----------------------------------------------------------------------------
// miIO local protocol packet framing + payload crypto (mirror of python-miio's
// protocol.py).
//
// Packet = 32-byte header || encrypted payload:
//   magic     uint16 = 0x2131
//   length    uint16 = 32 + payloadLen
//   unknown   uint32 = 0
//   deviceId  4 raw bytes (echoed from the handshake)
//   ts        uint32 (device clock, seconds)
//   checksum  16 bytes = md5(header[0:16] || token || encryptedPayload)
//
// Payload crypto: AES-128-CBC (PKCS7), key = md5(token), iv = md5(key||token).
// The clear JSON has a trailing 0x00 appended before padding.
// -----------------------------------------------------------------------------

import crypto from 'node:crypto';

const MAGIC = 0x2131;
const HEADER_SIZE = 32;

// The fixed 32-byte handshake ("hello") packet.
export const HELLO_PACKET = Buffer.from(
  '21310020ffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  'hex',
);

/**
 * Raw 16-byte MD5 digest.
 * @param {Buffer} data input
 * @returns {Buffer} the digest
 */
function md5(data) {
  return crypto.createHash('md5').update(data).digest();
}

/**
 * Derive the AES key + iv from a device token.
 * @param {Buffer} token the 16-byte token
 * @returns {{ key: Buffer, iv: Buffer }} the key and iv
 */
export function keyIv(token) {
  const key = md5(token);
  const iv = md5(Buffer.concat([key, token]));
  return { key, iv };
}

/**
 * Encrypt a clear JSON buffer for a miIO payload.
 * @param {Buffer} json the clear JSON bytes
 * @param {Buffer} token the 16-byte token
 * @returns {Buffer} the encrypted payload
 */
export function encryptPayload(json, token) {
  const { key, iv } = keyIv(token);
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(Buffer.concat([json, Buffer.from([0])])), cipher.final()]);
}

/**
 * Decrypt a miIO payload into a clear JSON buffer (trailing nulls stripped).
 * @param {Buffer} encrypted the encrypted payload
 * @param {Buffer} token the 16-byte token
 * @returns {Buffer} the clear JSON bytes
 */
export function decryptPayload(encrypted, token) {
  const { key, iv } = keyIv(token);
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(true);
  const clear = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  let end = clear.length;
  while (end > 0 && clear[end - 1] === 0) {
    end -= 1;
  }
  return clear.subarray(0, end);
}

/**
 * Build a miIO packet.
 * @param {object} params packet params
 * @param {Buffer} params.deviceId the 4-byte device id (from the handshake)
 * @param {number} params.ts the timestamp to stamp (seconds)
 * @param {Buffer} params.token the 16-byte token
 * @param {Buffer} [params.payload] the CLEAR JSON payload (empty for hello/ping)
 * @returns {Buffer} the encoded packet
 */
export function buildPacket({ deviceId, ts, token, payload }) {
  const encrypted =
    payload && payload.length > 0 ? encryptPayload(payload, token) : Buffer.alloc(0);

  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt16BE(MAGIC, 0);
  header.writeUInt16BE(HEADER_SIZE + encrypted.length, 2);
  header.writeUInt32BE(0, 4); // unknown
  deviceId.copy(header, 8, 0, 4);
  header.writeUInt32BE(ts >>> 0, 12);

  const checksum = md5(Buffer.concat([header.subarray(0, 16), token, encrypted]));
  checksum.copy(header, 16);

  return Buffer.concat([header, encrypted]);
}

/**
 * Parse a received miIO packet.
 * @param {Buffer} data the raw packet bytes
 * @param {Buffer} [token] the 16-byte token (to decrypt the payload)
 * @returns {{ deviceId: Buffer, ts: number, payload: Buffer|null }} the parsed packet
 */
export function parsePacket(data, token) {
  if (data.length < HEADER_SIZE || data.readUInt16BE(0) !== MAGIC) {
    throw new Error('Not a miIO packet');
  }
  const length = data.readUInt16BE(2);
  const deviceId = Buffer.from(data.subarray(8, 12));
  const ts = data.readUInt32BE(12);
  const encrypted = data.subarray(HEADER_SIZE, length);
  const payload = encrypted.length > 0 && token ? decryptPayload(encrypted, token) : null;
  return { deviceId, ts, payload };
}
