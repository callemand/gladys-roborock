// -----------------------------------------------------------------------------
// Xiaomi Mi Home cloud crypto primitives.
//
// Reimplementation of the request signing/encryption used by the Mi Home API
// (mirror of the `micloud` Python package):
//   - nonce / signed_nonce derivation;
//   - the SHA1 "enc" signature over the request params;
//   - RC4 encryption of every param value (with the mandatory 1024-byte
//     keystream discard).
//
// RC4 is implemented in pure JS on purpose: recent OpenSSL builds (Node's
// crypto) disable RC4 unless the legacy provider is loaded.
// -----------------------------------------------------------------------------

import crypto from 'node:crypto';

/**
 * Raw SHA-256 digest.
 * @param {Buffer} data input bytes
 * @returns {Buffer} the 32-byte digest
 */
export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest();
}

/**
 * Base64 SHA-1 digest of a string.
 * @param {string} data input string
 * @returns {string} the base64 digest
 */
export function sha1Base64(data) {
  return crypto.createHash('sha1').update(data, 'utf8').digest('base64');
}

/**
 * Uppercase hex MD5 of a string (used for the login password hash).
 * @param {string} data input string
 * @returns {string} the uppercase hex digest
 */
export function md5HexUpper(data) {
  return crypto.createHash('md5').update(data, 'utf8').digest('hex').toUpperCase();
}

/**
 * RC4 encrypt/decrypt (symmetric) with an initial keystream discard.
 * @param {Buffer} key the RC4 key bytes
 * @param {Buffer} data the input bytes
 * @param {number} [skip] number of keystream bytes to discard first (Mi Home uses 1024)
 * @returns {Buffer} the transformed bytes
 */
export function rc4(key, data, skip = 1024) {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) {
    s[i] = i;
  }
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    const tmp = s[i];
    s[i] = s[j];
    s[j] = tmp;
  }
  const total = skip + data.length;
  const out = Buffer.alloc(data.length);
  let a = 0;
  let b = 0;
  for (let k = 0; k < total; k += 1) {
    a = (a + 1) & 0xff;
    b = (b + s[a]) & 0xff;
    const tmp = s[a];
    s[a] = s[b];
    s[b] = tmp;
    const keyByte = s[(s[a] + s[b]) & 0xff];
    if (k >= skip) {
      out[k - skip] = data[k - skip] ^ keyByte;
    }
  }
  return out;
}

/**
 * Generate a request nonce: base64(8 random bytes || 4-byte big-endian minutes).
 * @returns {string} the base64 nonce
 */
export function generateNonce() {
  const random = crypto.randomBytes(8);
  const minutes = Math.floor(Date.now() / 60000);
  const minutesBuf = Buffer.alloc(4);
  minutesBuf.writeUInt32BE(minutes >>> 0, 0);
  return Buffer.concat([random, minutesBuf]).toString('base64');
}

/**
 * Derive the signed nonce: base64(sha256(b64decode(ssecurity) || b64decode(nonce))).
 * @param {string} ssecurity the account ssecurity (base64)
 * @param {string} nonce the request nonce (base64)
 * @returns {string} the base64 signed nonce
 */
export function signedNonce(ssecurity, nonce) {
  return sha256(
    Buffer.concat([Buffer.from(ssecurity, 'base64'), Buffer.from(nonce, 'base64')]),
  ).toString('base64');
}

/**
 * The Mi Home API path used in the signature: everything after "com" in the
 * URL, with the leading "/app" stripped (e.g. "/home/device_list").
 * @param {string} url the full request URL
 * @returns {string} the signature path
 */
export function signaturePath(url) {
  // The Mi Home signature uses the path after "/app" (e.g. "/home/device_list").
  // Using the parsed pathname (instead of micloud's `url.split("com")[1]`) gives
  // the same result for the real hosts and also works for a test server.
  return new URL(url).pathname.replace('/app/', '/');
}

/**
 * Compute the SHA1 "enc" signature over a set of params.
 * The signed string is: METHOD & path & k1=v1 & k2=v2 ... & signedNonce.
 * @param {string} url the full request URL
 * @param {string} method the HTTP method
 * @param {string} signedNonceValue the signed nonce (base64)
 * @param {Record<string,string>} params the params (insertion order preserved)
 * @returns {string} the base64 SHA1 signature
 */
export function encSignature(url, method, signedNonceValue, params) {
  const parts = [String(method).toUpperCase(), signaturePath(url)];
  for (const [key, value] of Object.entries(params)) {
    parts.push(`${key}=${value}`);
  }
  parts.push(signedNonceValue);
  return sha1Base64(parts.join('&'));
}

/**
 * Build the RC4-encrypted POST form fields for a Mi Home API call.
 * @param {string} url the full request URL
 * @param {string} method the HTTP method
 * @param {string} ssecurity the account ssecurity (base64)
 * @param {string} nonce the request nonce (base64)
 * @param {Record<string,string>} params the plaintext params (e.g. { data })
 * @returns {Record<string,string>} the POST form fields
 */
export function buildEncParams(url, method, ssecurity, nonce, params) {
  const signed = signedNonce(ssecurity, nonce);
  const key = Buffer.from(signed, 'base64');

  // 1) signature over the PLAINTEXT params.
  const withHash = { ...params, rc4_hash__: encSignature(url, method, signed, params) };

  // 2) RC4-encrypt every value.
  const encrypted = {};
  for (const [k, v] of Object.entries(withHash)) {
    encrypted[k] = rc4(key, Buffer.from(String(v), 'utf8')).toString('base64');
  }

  // 3) signature over the ENCRYPTED params, plus the plaintext ssecurity/_nonce.
  return {
    ...encrypted,
    signature: encSignature(url, method, signed, encrypted),
    ssecurity,
    _nonce: nonce,
  };
}

/**
 * Decrypt a Mi Home API response body.
 * @param {string} ssecurity the account ssecurity (base64)
 * @param {string} nonce the request nonce that was sent (base64)
 * @param {string} body the RC4+base64 response text
 * @returns {string} the decrypted JSON text
 */
export function decryptResponse(ssecurity, nonce, body) {
  const key = Buffer.from(signedNonce(ssecurity, nonce), 'base64');
  return rc4(key, Buffer.from(body, 'base64')).toString('utf8');
}
