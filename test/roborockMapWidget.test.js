import test from 'node:test';
import assert from 'node:assert/strict';

import { validateWidgetContent } from '@gladysassistant/integration-sdk';

import {
  MAP_WIDGET_KEY,
  WIDGET_LANGUAGES,
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

test('mapImageKey round-trips the duid with a hex (hash) signature', () => {
  const key = mapImageKey(DUID, 'a1b2c3d4e5');
  assert.match(key, /^[a-z0-9][a-z0-9-]{0,63}$/);
  assert.equal(duidFromImageKey(key), DUID);
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
  assert.ok(buttons.some((b) => b.device_feature === `${v}:dock` && b.value === 1)); // fixed dock
  assert.ok(buttons.some((b) => b.device_feature === `${v}:run-mode` && b.value === 0)); // stop
  // a suction level is a widget action, never the clean-mode feature (issue #13:
  // on a mop-capable robot that feature is the Vacuum / Vac & Mop / Mop choice)
  assert.ok(!buttons.some((b) => b.device_feature === `${v}:clean-mode`));
  const quiet = buttons.find((b) => b.action);
  assert.deepEqual(quiet.action, { key: 'fan_power', params: { level: 'quiet' } });
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

test('the battery tile, the surface tile and the map are each optional', () => {
  const build = (settings) =>
    buildMapWidgetContent(SAMPLE_MAP, {
      imageKey: 'map-x',
      vacuumExternalId: 'ext:roborock:vacuum:duid',
      status: { state: 8, clean_area: 12e6 },
      settings,
    });
  const types = (content) => content.components.map((c) => c.type);

  // on by default
  assert.deepEqual(types(build({})).slice(0, 3), ['value', 'gauge', 'image']);
  assert.deepEqual(
    types(build({ show_battery: true, show_surface: true, show_map: true })).slice(0, 3),
    ['value', 'gauge', 'image'],
  );

  const noBattery = build({ show_battery: false });
  assert.deepEqual(types(noBattery).slice(0, 2), ['gauge', 'image']);
  assert.deepEqual(validateWidgetContent(noBattery), []);

  const noMap = build({ show_map: false });
  assert.ok(!types(noMap).includes('image'));
  assert.deepEqual(validateWidgetContent(noMap), []);

  // status block and buttons only: no map at all, the surface scale still works
  const bare = buildMapWidgetContent(null, {
    vacuumExternalId: 'ext:roborock:vacuum:duid',
    status: { state: 8, clean_area: 12e6 },
    settings: { show_battery: false, show_surface: false, show_map: false },
  });
  assert.deepEqual(types(bare).slice(0, 1), ['status']);
  assert.deepEqual(validateWidgetContent(bare), []);

  // the surface tile without a map scales on the surface itself
  const surfaceOnly = buildMapWidgetContent(null, {
    vacuumExternalId: 'ext:roborock:vacuum:duid',
    status: { state: 8, clean_area: 12e6 },
    settings: { show_battery: false, show_map: false },
  });
  const gauge = surfaceOnly.components.find((c) => c.type === 'gauge');
  assert.equal(gauge.value, 12);
  assert.equal(gauge.max, 12);
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

test('roborockStateLabel speaks the user language and falls back to English', () => {
  assert.equal(roborockStateLabel(8, 'fr'), 'À la base');
  assert.equal(roborockStateLabel(5, 'fr'), 'Nettoyage');
  assert.equal(roborockStateLabel(5, 'de'), 'Reinigung');
  assert.equal(roborockStateLabel(5, 'es'), 'Limpiando');
  assert.equal(roborockStateLabel(5), 'Cleaning');
  assert.equal(roborockStateLabel(5, 'it'), 'Cleaning');
  assert.equal(roborockStateLabel(9999, 'de'), 'Unbekannt');
  assert.equal(roborockStateLabel(9999, 'fr'), 'Inconnu');
});

test('formatCleanTimestamp says today / yesterday in the user language', () => {
  const now = new Date(2026, 0, 2, 10, 0, 0).getTime();
  const ts = Math.floor(new Date(2026, 0, 2, 8, 12, 0).getTime() / 1000);
  assert.equal(formatCleanTimestamp(ts, now, 'fr'), "Aujourd'hui, 08:12");
  assert.equal(formatCleanTimestamp(ts, now, 'de'), 'Heute, 08:12');
  assert.equal(formatCleanTimestamp(ts, now), 'Today, 08:12');
  const yesterday = Math.floor(new Date(2026, 0, 1, 21, 5, 0).getTime() / 1000);
  assert.equal(formatCleanTimestamp(yesterday, now, 'es'), 'Ayer, 21:05');
  const older = Math.floor(new Date(2025, 11, 24, 7, 30, 0).getTime() / 1000);
  assert.equal(formatCleanTimestamp(older, now, 'de'), '24.12., 07:30');
  assert.equal(formatCleanTimestamp(older, now, 'fr'), '24/12, 07:30');
  assert.equal(formatCleanTimestamp(0, now, 'de'), '—');
});

test('every widget text exists in every Gladys language (issue #13)', () => {
  const content = buildMapWidgetContent(SAMPLE_MAP, {
    imageKey: 'map-x',
    vacuumExternalId: 'ext:roborock:vacuum:duid',
    status: { state: 5, last_clean_t: 1, clean_area: 1e6, clean_time: 60 },
    settings: { action1: 'quiet', action2: 'max' },
    language: 'de',
  });
  const texts = [];
  const collect = (value) => {
    if (value && typeof value === 'object') {
      if ('en' in value) {
        texts.push(value);
      } else {
        Object.values(value).forEach(collect);
      }
    }
  };
  collect(content.components);
  assert.ok(texts.length >= 12);
  for (const text of texts) {
    for (const language of WIDGET_LANGUAGES) {
      assert.ok(text[language], `${JSON.stringify(text)} lacks ${language}`);
    }
  }
  // the values the integration renders itself follow the language too
  const status = content.components.find((c) => c.type === 'status');
  assert.equal(status.items[0].value, 'Reinigung');
  assert.match(status.items[1].value, /^(Heute|Gestern|\d\d\.\d\d\.), \d\d:\d\d$/);
});
