import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SCENE_TRIGGERS,
  computeSceneEvents,
  errorLabel,
  snapshotFromStatus,
} from '../src/devices/sceneTriggers.js';

const CTX = { vacuum: 'ext:test:vacuum:duid-1', deviceName: 'Robot cuisine' };

// Helper: build a snapshot from a partial status + consumable percentages.
const snap = (status, percents = {}) => snapshotFromStatus(status, percents);
// Same, but flagged as belonging to an already-active cleaning session (what a
// previous computeSceneEvents call would have stored).
const active = (status, percents = {}) => {
  const snapshot = snap(status, percents);
  snapshot.sessionActive = true;
  return snapshot;
};

const keys = (events) => events.map((e) => e.key);
const find = (events, key) => events.find((e) => e.key === key);

test('a null previous snapshot only seeds the cache (no event)', () => {
  const events = computeSceneEvents(null, snap({ state: 5, battery: 80 }), CTX);
  assert.deepEqual(events, []);
});

test('cleaning_started fires on the idle -> cleaning transition', () => {
  const previous = snap({ state: 8, battery: 100 }); // docked
  const current = snap({ state: 5, battery: 99 }); // cleaning
  const events = computeSceneEvents(previous, current, CTX);
  assert.ok(keys(events).includes(SCENE_TRIGGERS.CLEANING_STARTED));
  const started = find(events, SCENE_TRIGGERS.CLEANING_STARTED);
  assert.equal(started.data.vacuum, CTX.vacuum);
  assert.equal(started.data.device_name, 'Robot cuisine');
});

test('cleaning_finished exposes duration and area, and docking fires returned_to_dock', () => {
  const previous = active({ state: 5, battery: 70, clean_time: 1800, clean_area: 40_000_000 });
  const current = snap({ state: 8, battery: 70 }); // back on the dock
  const events = computeSceneEvents(previous, current, CTX);
  assert.ok(keys(events).includes(SCENE_TRIGGERS.CLEANING_FINISHED));
  assert.ok(keys(events).includes(SCENE_TRIGGERS.RETURNED_TO_DOCK));
  const finished = find(events, SCENE_TRIGGERS.CLEANING_FINISHED);
  assert.equal(finished.data.duration_min, 30);
  assert.equal(finished.data.area_m2, 40);
  assert.equal(current.sessionActive, false);
});

test('pausing mid-clean does not finish the session', () => {
  const previous = active({ state: 5, battery: 70 }); // cleaning
  const current = snap({ state: 10, battery: 70 }); // paused
  const events = computeSceneEvents(previous, current, CTX);
  assert.equal(find(events, SCENE_TRIGGERS.CLEANING_FINISHED), undefined);
  assert.equal(current.sessionActive, true);
});

test('resuming from pause does not fire cleaning_started again', () => {
  const previous = active({ state: 10, battery: 70 }); // paused, session still active
  const current = snap({ state: 5, battery: 69 }); // cleaning again
  const events = computeSceneEvents(previous, current, CTX);
  assert.equal(find(events, SCENE_TRIGGERS.CLEANING_STARTED), undefined);
  assert.equal(current.sessionActive, true);
});

test('battery_low fires once when crossing the 20% threshold downward', () => {
  const low = computeSceneEvents(
    snap({ state: 8, battery: 25 }),
    snap({ state: 8, battery: 18 }),
    CTX,
  );
  const event = find(low, SCENE_TRIGGERS.BATTERY_LOW);
  assert.ok(event);
  assert.equal(event.data.level, 18);
  // Already below: no second event.
  const stillLow = computeSceneEvents(
    snap({ state: 8, battery: 18 }),
    snap({ state: 8, battery: 15 }),
    CTX,
  );
  assert.equal(find(stillLow, SCENE_TRIGGERS.BATTERY_LOW), undefined);
});

test('charging_complete fires when the battery reaches 100%', () => {
  const events = computeSceneEvents(
    snap({ state: 8, battery: 90 }),
    snap({ state: 8, battery: 100 }),
    CTX,
  );
  assert.ok(keys(events).includes(SCENE_TRIGGERS.CHARGING_COMPLETE));
});

test('robot_error carries the code and a label', () => {
  const events = computeSceneEvents(
    snap({ state: 5, battery: 60 }),
    snap({ state: 12, battery: 60, error_code: 8 }),
    CTX,
  );
  const error = find(events, SCENE_TRIGGERS.ROBOT_ERROR);
  assert.ok(error);
  assert.equal(error.data.error_code, 8);
  assert.equal(error.data.error_label, 'Robot coincé');
});

test('consumable_worn fires for the consumable that crossed 10%', () => {
  const previous = snap({ state: 8, battery: 100 }, { filter: 15, mainBrush: 50 });
  const current = snap({ state: 8, battery: 100 }, { filter: 8, mainBrush: 50 });
  const events = computeSceneEvents(previous, current, CTX);
  const worn = find(events, SCENE_TRIGGERS.CONSUMABLE_WORN);
  assert.ok(worn);
  assert.equal(worn.data.consumable, 'filter');
  assert.equal(worn.data.percent, 8);
});

test('state_changed carries a label and the raw code', () => {
  const events = computeSceneEvents(
    snap({ state: 8, battery: 100 }),
    snap({ state: 5, battery: 99 }),
    CTX,
  );
  const changed = find(events, SCENE_TRIGGERS.STATE_CHANGED);
  assert.ok(changed);
  assert.equal(changed.data.state_code, 5);
  assert.equal(typeof changed.data.state, 'string');
});

test('snapshotFromStatus normalizes states, battery and consumables', () => {
  const s = snap(
    { state: 5, battery: 42, clean_time: 600, clean_area: 10_000_000 },
    { filter: 73 },
  );
  assert.equal(s.cleaning, true);
  assert.equal(s.docked, false);
  assert.equal(s.battery, 42);
  assert.equal(s.cleanTimeSec, 600);
  assert.equal(s.percents.filter, 73);
  assert.equal(s.percents.mainBrush, null);
});

test('errorLabel maps known codes and falls back', () => {
  assert.equal(errorLabel(5), 'Brosse principale bloquée');
  assert.equal(errorLabel(999), 'Erreur 999');
});
