import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SESSION_KEYS,
  clearedSessionConfig,
  isSessionUsable,
  readSession,
  sameSession,
  sessionToConfig,
} from '../src/session.js';

const SESSION = {
  deviceId: 'ghijkl',
  username: 'user@example.com',
  token: 'account-token',
  rriot: { u: 'u', s: 's', h: 'h', k: 'k', r: { a: 'https://api', m: 'ssl://mqtt' } },
  baseUrl: 'https://euiot.roborock.com',
};

test('sessionToConfig round-trips through readSession', () => {
  assert.deepEqual(readSession(sessionToConfig(SESSION)), SESSION);
});

test('the rriot credentials survive as an object, not a string', () => {
  const stored = sessionToConfig(SESSION);
  assert.equal(typeof stored[SESSION_KEYS.RRIOT], 'string');
  assert.deepEqual(readSession(stored).rriot, SESSION.rriot);
});

test('readSession treats blank values and malformed rriot as absent', () => {
  const session = readSession({
    [SESSION_KEYS.TOKEN]: '   ',
    [SESSION_KEYS.USERNAME]: '',
    [SESSION_KEYS.RRIOT]: 'not json',
  });
  assert.equal(session.token, null);
  assert.equal(session.username, null);
  assert.equal(session.rriot, null);
});

test('isSessionUsable requires what a silent reconnection actually needs', () => {
  // the token alone gets nowhere: every IoT call is signed with the rriot secrets
  assert.equal(isSessionUsable(SESSION), true);
  assert.equal(isSessionUsable({ ...SESSION, token: null }), false);
  assert.equal(isSessionUsable({ ...SESSION, rriot: null }), false);
  assert.equal(isSessionUsable(null), false);
});

test('clearedSessionConfig blanks every session key', () => {
  const cleared = clearedSessionConfig();
  Object.values(SESSION_KEYS).forEach((key) => assert.equal(cleared[key], ''));
  assert.equal(isSessionUsable(readSession(cleared)), false);
});

test('sameSession tells our own config write apart from a real change', () => {
  assert.equal(sameSession(SESSION, { ...SESSION }), true);
  assert.equal(sameSession(SESSION, { ...SESSION, token: 'other' }), false);
  // the rriot object is compared by value: it comes back parsed from JSON, so it
  // is never the same object, and comparing by reference would loop for ever
  assert.equal(
    sameSession(SESSION, { ...SESSION, rriot: JSON.parse(JSON.stringify(SESSION.rriot)) }),
    true,
  );
  assert.equal(sameSession(SESSION, { ...SESSION, rriot: { u: 'other' } }), false);
  assert.equal(sameSession(null, SESSION), false);
});
