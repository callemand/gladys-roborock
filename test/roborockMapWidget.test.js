import test from 'node:test';
import assert from 'node:assert/strict';

import { validateWidgetContent } from '@gladysassistant/integration-sdk';

import {
  MAP_WIDGET_KEY,
  buildMapWidgetContent,
  duidFromImageKey,
  formatCleanTimestamp,
  homeAreaM2,
  mapImageKey,
  roborockStateLabel,
} from '../src/devices/mapWidget.js';

const DUID = '4BkY56LGaXdwSTMoHOAWgy';

test('the widget key is "map"', () => {
  assert.equal(MAP_WIDGET_KEY, 'map');
});

test('mapImageKey builds a core-valid key and round-trips the duid', () => {
  const key = mapImageKey(DUID, 4);
  assert.match(key, /^[a-z0-9][a-z0-9-]{0,63}$/);
  assert.equal(duidFromImageKey(key), DUID);
});

test('mapImageKey changes with the map sequence', () => {
  assert.notEqual(mapImageKey(DUID, 4), mapImageKey(DUID, 5));
});

test('mapImageKey stays within the 64-char core limit and still round-trips a long duid', () => {
  const longDuid = 'D'.repeat(48); // hex form would overflow 64 chars
  const key = mapImageKey(longDuid, 7);
  assert.ok(key.length <= 64, `key is ${key.length} chars`);
  assert.match(key, /^[a-z0-9][a-z0-9-]{0,63}$/);
  assert.equal(duidFromImageKey(key), longDuid);
});

test('duidFromImageKey rejects a foreign key', () => {
  assert.equal(duidFromImageKey('something-else'), null);
  assert.equal(duidFromImageKey('map-zzzz-1'), null); // not valid hex
});

const SAMPLE_MAP = {
  mapSequence: 4,
  pixelSizeMm: 50,
  segments: [
    { named: true, pixelCount: 3214 },
    { named: true, pixelCount: 7499 },
    { named: false, pixelCount: 2657 },
  ],
  noGoAreas: [[], []],
  virtualWalls: [{}, {}, {}],
};

test('buildMapWidgetContent is accepted by the core validator', () => {
  const v = `ext:roborock:vacuum:${DUID}`;
  const content = buildMapWidgetContent(SAMPLE_MAP, {
    imageKey: mapImageKey(DUID, SAMPLE_MAP.mapSequence),
    vacuumExternalId: v,
    status: { state: 8, battery: 82, clean_area: 43_000_000, clean_time: 2280, last_clean_t: 1 },
    consumables: { filter: 72, mainBrush: 50, sideBrush: 20, sensor: 5 },
    settings: { action1: 'quiet', action2: 'stop' },
    now: Date.UTC(2026, 0, 2),
  });

  assert.deepEqual(validateWidgetContent(content), []);

  const byType = (t) => content.components.filter((c) => c.type === t);
  assert.equal(byType('image')[0].key, mapImageKey(DUID, 4));
  assert.ok(byType('value').some((c) => c.device_feature === `${v}:battery`));
  assert.ok(byType('gauge').some((c) => c.unit === 'm²'));
  // fixed start + fixed dock + the two configured actions
  const buttons = byType('button');
  assert.equal(buttons.length, 4);
  assert.ok(buttons.every((b) => typeof b.device_feature === 'string' && 'value' in b));
  assert.ok(buttons.some((b) => b.device_feature === `${v}:dock`)); // fixed dock
  assert.ok(buttons.some((b) => b.device_feature === `${v}:clean-mode`)); // quiet
  // status block with the duration and every consumable percentage
  const status = byType('status')[0];
  assert.ok(status.items.some((i) => i.value === '38 min')); // 2280s -> 38 min
  for (const pct of ['72 %', '50 %', '20 %', '5 %']) {
    assert.ok(
      status.items.some((i) => i.value === pct),
      `status has ${pct}`,
    );
  }
});

test('configured action "none" adds no button', () => {
  const v = `ext:roborock:vacuum:${DUID}`;
  const content = buildMapWidgetContent(SAMPLE_MAP, {
    imageKey: mapImageKey(DUID, 4),
    vacuumExternalId: v,
    settings: { action1: 'none', action2: 'none' },
  });
  assert.deepEqual(validateWidgetContent(content), []);
  assert.equal(content.components.filter((c) => c.type === 'button').length, 2); // fixed start + dock only
});

test('homeAreaM2 sums only the named segments', () => {
  // (3214 + 7499) cells * 0.0025 m² = ~26.8 -> 27
  assert.equal(homeAreaM2(SAMPLE_MAP), 27);
});

test('roborockStateLabel maps known states and falls back', () => {
  assert.equal(roborockStateLabel(8), 'À la base');
  assert.equal(roborockStateLabel(5), 'Nettoyage');
  assert.equal(roborockStateLabel(9999), 'Inconnu');
});

test('formatCleanTimestamp says Aujourd’hui for the same day', () => {
  const now = new Date(2026, 0, 2, 10, 0, 0).getTime();
  const ts = Math.floor(new Date(2026, 0, 2, 8, 12, 0).getTime() / 1000);
  assert.equal(formatCleanTimestamp(ts, now), "Aujourd'hui, 08:12");
});
