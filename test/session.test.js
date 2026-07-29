import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SESSION_KEYS,
  clearedSessionConfig,
  isSessionUsable,
  readSession,
  sessionToConfig,
} from '../src/xiaomi/session.js';

test('readSession extracts the off-schema session keys', () => {
  const session = readSession({
    [SESSION_KEYS.DEVICE_ID]: 'abcdef',
    [SESSION_KEYS.USER_ID]: '12345',
    [SESSION_KEYS.PASS_TOKEN]: 'ptoken',
    [SESSION_KEYS.SSECURITY]: 'c2VjcmV0',
    [SESSION_KEYS.REGION]: 'de',
    username: 'user@example.com',
  });
  assert.deepEqual(session, {
    deviceId: 'abcdef',
    userId: '12345',
    passToken: 'ptoken',
    ssecurity: 'c2VjcmV0',
    region: 'de',
  });
});

test('readSession treats blank values as absent', () => {
  const session = readSession({ [SESSION_KEYS.USER_ID]: '   ', [SESSION_KEYS.PASS_TOKEN]: '' });
  assert.equal(session.userId, null);
  assert.equal(session.passToken, null);
});

test('isSessionUsable requires a userId and a passToken', () => {
  assert.equal(isSessionUsable({ userId: '1', passToken: 'p' }), true);
  assert.equal(isSessionUsable({ userId: '1', passToken: null }), false);
  assert.equal(isSessionUsable({ userId: null, passToken: 'p' }), false);
  assert.equal(isSessionUsable(null), false);
});

test('sessionToConfig round-trips through readSession', () => {
  const session = {
    deviceId: 'abcdef',
    userId: '12345',
    passToken: 'ptoken',
    ssecurity: 'c2VjcmV0',
    region: 'de',
  };
  assert.deepEqual(readSession(sessionToConfig(session)), session);
});

test('clearedSessionConfig blanks every session key', () => {
  const cleared = clearedSessionConfig();
  Object.values(SESSION_KEYS).forEach((key) => assert.equal(cleared[key], ''));
  assert.equal(isSessionUsable(readSession(cleared)), false);
});
