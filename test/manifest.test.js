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

test('the form asks for nothing: everything happens through the actions', () => {
  // The email and the code travel WITH the action that uses them, so the button
  // can stay disabled until they are valid and there is no "did you save first?".
  // A settings field here would be one the user fills in for nothing.
  manifest.config_schema.forEach((field) => {
    assert.equal(
      field.type,
      'section',
      `"${field.key}" is a settings field, which this form has none of`,
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

test('the account is linked by an email then a code, and can be undone', () => {
  const actions = new Map(manifest.actions.map((action) => [action.key, action]));
  const email = actions.get('roborock_send_code').fields.find((f) => f.key === 'email');
  assert.equal(email.required, true);
  // No `format` here on purpose: released Gladys versions reject an unknown field
  // key outright, so declaring one would make this integration impossible to
  // install. index.js checks the address itself instead.
  assert.equal(email.format, undefined);
  assert.match(indexSource, /EMAIL_REGEX\.test/, 'index.js must check the address itself');
  const code = actions.get('roborock_link').fields.find((f) => f.key === 'code');
  assert.equal(code.required, true);
  // and a way out, or an account linked by mistake could never be undone
  assert.ok(actions.has('roborock_unlink'));
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
