// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest is validated by the store indexer, but nothing there can know
// which keys the code actually reads — these tests keep both in sync.
//
// They exist because this integration drifted more than once while being built:
// a config key renamed on one side only leaves a field the user fills in and the
// code never reads, with no error anywhere.
// -----------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { SESSION_KEYS } from '../src/session.js';

const root = new URL('..', import.meta.url);
const manifest = JSON.parse(
  await readFile(new URL('gladys-assistant-integration.json', root), 'utf8'),
);
const indexSource = await readFile(new URL('index.js', root), 'utf8');

const fieldsByKey = new Map(manifest.config_schema.map((field) => [field.key, field]));

// The settings index.js reads off the config, as `newConfig.<key>`.
const CONFIG_KEYS_READ = ['roborock_email', 'roborock_code'];

test('every setting the code reads is declared in the config_schema', () => {
  CONFIG_KEYS_READ.forEach((key) => {
    assert.ok(fieldsByKey.has(key), `index.js reads "${key}", which the manifest does not declare`);
  });
});

test('every declared setting is either read by the code or presentational', () => {
  manifest.config_schema.forEach((field) => {
    if (field.type === 'section') {
      return; // no value at all
    }
    if (field.type === 'account_link' || field.type === 'oauth2') {
      // its value IS the Connect flow: the code must never read the key itself
      assert.equal(
        indexSource.includes(`.${field.key}`),
        false,
        `index.js must not read the value of the account field "${field.key}"`,
      );
      return;
    }
    assert.ok(
      CONFIG_KEYS_READ.includes(field.key),
      `the manifest declares "${field.key}", which no code reads: the user would fill it in for nothing`,
    );
  });
});

test('the session keys stay OUT of the config_schema', () => {
  // They are integration-managed state persisted through setConfig(). Declaring
  // one would render it as a form field, and the server would then refuse the
  // integration's own write.
  Object.values(SESSION_KEYS).forEach((key) => {
    assert.equal(
      fieldsByKey.has(key),
      false,
      `session key "${key}" must not be declared in the config_schema`,
    );
  });
});

test('the two fields of the account link are there, and nothing else', () => {
  // Saving the email asks Roborock for a code; saving the code links the account.
  // Anything more would be a setting the user has to understand for nothing.
  assert.deepEqual(
    manifest.config_schema.map((field) => field.key),
    ['roborock_email', 'roborock_code'],
  );
  assert.equal(fieldsByKey.get('roborock_email').type, 'string');
  assert.equal(fieldsByKey.get('roborock_code').type, 'string');
});

test('every manifest action has a registered handler, and vice versa', () => {
  const declared = (manifest.actions ?? []).map((action) => action.key).sort();
  const handled = [...indexSource.matchAll(/gladys\.onAction\('([^']+)'/g)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(declared, handled);
});

test('the docker image tag matches the manifest version', () => {
  // Publishing a manifest whose version and image disagree installs the wrong
  // code, and the store cannot catch it.
  assert.equal(
    manifest.docker_image.endsWith(`:${manifest.version}`),
    true,
    `docker_image "${manifest.docker_image}" does not end with the manifest version ${manifest.version}`,
  );
});

test('the cover image points to a file that exists in the repository', async () => {
  const fileName = manifest.cover_image.split('/').pop();
  const cover = await readFile(new URL(fileName, root));
  assert.ok(cover.length > 0, `${fileName} is empty`);
  // the store expects a 800x534 cover; check the JPEG dimensions from the SOF0
  // marker rather than trusting the file name
  const sof = cover.indexOf(Buffer.from([0xff, 0xc0]));
  assert.ok(sof > 0, 'no JPEG SOF0 marker found in the cover');
  assert.equal(cover.readUInt16BE(sof + 7), 800, 'cover width must be 800');
  assert.equal(cover.readUInt16BE(sof + 5), 534, 'cover height must be 534');
});
