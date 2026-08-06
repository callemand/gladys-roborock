// -----------------------------------------------------------------------------
// Roborock crypto primitives (protocol family "1.0", which covers the vast
// majority of the vacuums).
//
// Mirror of python-roborock's protocol.py:
//   - the AES-128-ECB key is derived PER MESSAGE from a scrambled form of the
//     message timestamp, the device local key and a fixed salt;
//   - the payload is PKCS7-padded;
//   - messages carry a trailing CRC-32 (IEEE) over every preceding byte.
//
// Note this is a different scheme from the Xiaomi/miIO one (src/xiaomi):
// same vendor hardware, two different clouds.
// -----------------------------------------------------------------------------

import crypto from 'node:crypto';

import { ROBOROCK_V1_SALT } from '../constants.js';

/**
 * Raw 16-byte MD5 digest.
 * @param {Buffer|string} data input
 * @returns {Buffer} the digest
 */
export function md5(data) {
  return crypto.createHash('md5').update(data).digest();
}

/**
 * Lowercase hex MD5 digest.
 * @param {Buffer|string} data input
 * @returns {string} the hex digest
 */
export function md5hex(data) {
  return crypto.createHash('md5').update(data).digest('hex');
}

/**
 * Scramble the message timestamp: the 8-char zero-padded hex of the timestamp,
 * reordered by a fixed index permutation.
 * @param {number} timestamp unix timestamp (seconds)
 * @returns {string} the 8-char scrambled hex
 */
export function encodeTimestamp(timestamp) {
  const hex = Math.floor(timestamp).toString(16).padStart(8, '0');
  const order = [5, 6, 3, 7, 1, 2, 0, 4];
  return order.map((i) => hex[i]).join('');
}

/**
 * Derive the per-message AES-128 key.
 * @param {number} timestamp the message timestamp (seconds)
 * @param {string} localKey the device local key
 * @returns {Buffer} the 16-byte AES key
 */
export function deriveKey(timestamp, localKey) {
  return md5(
    Buffer.concat([
      Buffer.from(encodeTimestamp(timestamp)),
      Buffer.from(localKey),
      Buffer.from(ROBOROCK_V1_SALT),
    ]),
  );
}

/**
 * AES-128-ECB encrypt (PKCS7) a payload.
 * @param {Buffer} plaintext the clear payload
 * @param {number} timestamp the message timestamp
 * @param {string} localKey the device local key
 * @returns {Buffer} the ciphertext
 */
export function encrypt(plaintext, timestamp, localKey) {
  const cipher = crypto.createCipheriv('aes-128-ecb', deriveKey(timestamp, localKey), null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/**
 * AES-128-ECB decrypt (PKCS7) a payload.
 * @param {Buffer} ciphertext the encrypted payload
 * @param {number} timestamp the message timestamp (from the RECEIVED header:
 *   the key depends on it)
 * @param {string} localKey the device local key
 * @returns {Buffer} the plaintext
 */
export function decrypt(ciphertext, timestamp, localKey) {
  const decipher = crypto.createDecipheriv('aes-128-ecb', deriveKey(timestamp, localKey), null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// CRC-32 (IEEE 802.3) table, computed once.
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * Standard CRC-32 (IEEE) of a buffer, matching Python's binascii.crc32.
 * @param {Buffer} buffer the input bytes
 * @returns {number} the unsigned 32-bit CRC
 */
export function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
