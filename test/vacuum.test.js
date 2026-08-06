import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FEATURE_CODES,
  ROBOROCK_METHOD,
  VACUUM_CLEANER_CLEAN_MODE,
  VACUUM_CLEANER_MODE,
  VACUUM_CLEANER_STATE,
} from '../src/constants.js';
import { buildPollStates, buildSetCommand, buildVacuumFeatures } from '../src/devices/vacuum.js';
import { fakeVacuumIds } from './helpers/fakeGladys.js';

const ids = fakeVacuumIds('duid');

test('buildVacuumFeatures exposes state, run-mode, clean-mode, dock and battery', () => {
  const features = buildVacuumFeatures(ids);
  assert.deepEqual(
    features.map((f) => f.external_id.split(':').pop()),
    ['state', 'run-mode', 'clean-mode', 'dock', 'battery'],
  );
  const state = features.find((f) => f.external_id.endsWith(':state'));
  assert.equal(state.read_only, true);
  assert.equal(state.category, 'vacuum-cleaner');
  assert.equal(state.type, 'state');

  const dock = features.find((f) => f.external_id.endsWith(':dock'));
  assert.equal(dock.read_only, false);
  assert.equal(dock.has_feedback, false);

  const battery = features.find((f) => f.external_id.endsWith(':battery'));
  assert.equal(battery.category, 'battery');
  assert.equal(battery.unit, 'percent');
});

test('buildPollStates maps a charging status to the Gladys states', () => {
  const states = buildPollStates(ids, { state: 8, battery: 87, fan_power: 102 });
  assert.deepEqual(states, [
    {
      device_feature_external_id: 'ext:test:vacuum:duid:state',
      state: VACUUM_CLEANER_STATE.CHARGING,
    },
    {
      device_feature_external_id: 'ext:test:vacuum:duid:run-mode',
      state: VACUUM_CLEANER_MODE.IDLE,
    },
    {
      device_feature_external_id: 'ext:test:vacuum:duid:clean-mode',
      state: VACUUM_CLEANER_CLEAN_MODE.AUTO,
    },
    { device_feature_external_id: 'ext:test:vacuum:duid:battery', state: 87 },
  ]);
});

// Real values captured from a Roborock S6 (fw 3.5.8_2700) over local miIO.
test('buildPollStates maps the real S6 get_status payload', () => {
  const states = buildPollStates(ids, {
    msg_ver: 2,
    msg_seq: 11,
    state: 8,
    battery: 100,
    clean_time: 2027,
    clean_area: 33452500,
    error_code: 0,
    map_present: 1,
    in_cleaning: 0,
    in_returning: 0,
    fan_power: 102,
    water_box_status: 0,
  });
  assert.deepEqual(states, [
    {
      device_feature_external_id: 'ext:test:vacuum:duid:state',
      state: VACUUM_CLEANER_STATE.CHARGING,
    },
    {
      device_feature_external_id: 'ext:test:vacuum:duid:run-mode',
      state: VACUUM_CLEANER_MODE.IDLE,
    },
    {
      device_feature_external_id: 'ext:test:vacuum:duid:clean-mode',
      state: VACUUM_CLEANER_CLEAN_MODE.AUTO,
    },
    { device_feature_external_id: 'ext:test:vacuum:duid:battery', state: 100 },
  ]);
});

test('the fan-power 106 alias reads as AUTO but AUTO is written as 102 (S6 ignores 106)', () => {
  const states = buildPollStates(ids, { state: 8, fan_power: 106 });
  const cleanMode = states.find((s) => s.device_feature_external_id.endsWith(':clean-mode'));
  assert.equal(cleanMode.state, VACUUM_CLEANER_CLEAN_MODE.AUTO);
  assert.deepEqual(buildSetCommand(FEATURE_CODES.CLEAN_MODE, VACUUM_CLEANER_CLEAN_MODE.AUTO), {
    method: ROBOROCK_METHOD.SET_FAN_POWER,
    params: [102],
  });
});

test('buildPollStates derives a CLEANING run-mode from a cleaning state', () => {
  const states = buildPollStates(ids, { state: 5, battery: 50, fan_power: 104 });
  const runMode = states.find((s) => s.device_feature_external_id.endsWith(':run-mode'));
  assert.equal(runMode.state, VACUUM_CLEANER_MODE.CLEANING);
  const stateFeat = states.find((s) => s.device_feature_external_id.endsWith(':state'));
  assert.equal(stateFeat.state, VACUUM_CLEANER_STATE.RUNNING);
  const cleanMode = states.find((s) => s.device_feature_external_id.endsWith(':clean-mode'));
  assert.equal(cleanMode.state, VACUUM_CLEANER_CLEAN_MODE.VACUUM);
});

test('buildPollStates skips unknown states / fan-power codes', () => {
  const states = buildPollStates(ids, { state: 99999, battery: null, fan_power: 9999 });
  // Unknown state -> no state feature, but run-mode is still derived (IDLE).
  assert.equal(
    states.some((s) => s.device_feature_external_id.endsWith(':state')),
    false,
  );
  assert.equal(
    states.some((s) => s.device_feature_external_id.endsWith(':clean-mode')),
    false,
  );
  assert.equal(
    states.some((s) => s.device_feature_external_id.endsWith(':battery')),
    false,
  );
  const runMode = states.find((s) => s.device_feature_external_id.endsWith(':run-mode'));
  assert.equal(runMode.state, VACUUM_CLEANER_MODE.IDLE);
});

test('buildSetCommand maps run-mode CLEANING/IDLE to app_start/app_stop', () => {
  assert.deepEqual(buildSetCommand(FEATURE_CODES.RUN_MODE, VACUUM_CLEANER_MODE.CLEANING), {
    method: ROBOROCK_METHOD.APP_START,
    params: [],
  });
  assert.deepEqual(buildSetCommand(FEATURE_CODES.RUN_MODE, VACUUM_CLEANER_MODE.IDLE), {
    method: ROBOROCK_METHOD.APP_STOP,
    params: [],
  });
  assert.equal(buildSetCommand(FEATURE_CODES.RUN_MODE, VACUUM_CLEANER_MODE.MAPPING), null);
});

test('buildSetCommand maps clean-mode to set_custom_mode with the fan-power code', () => {
  assert.deepEqual(buildSetCommand(FEATURE_CODES.CLEAN_MODE, VACUUM_CLEANER_CLEAN_MODE.QUIET), {
    method: ROBOROCK_METHOD.SET_FAN_POWER,
    params: [101],
  });
  assert.deepEqual(buildSetCommand(FEATURE_CODES.CLEAN_MODE, VACUUM_CLEANER_CLEAN_MODE.VACUUM), {
    method: ROBOROCK_METHOD.SET_FAN_POWER,
    params: [104],
  });
  assert.equal(buildSetCommand(FEATURE_CODES.CLEAN_MODE, VACUUM_CLEANER_CLEAN_MODE.MOP), null);
});

test('buildSetCommand maps dock=1 to app_charge and ignores dock=0', () => {
  assert.deepEqual(buildSetCommand(FEATURE_CODES.DOCK, 1), {
    method: ROBOROCK_METHOD.APP_CHARGE,
    params: [],
  });
  assert.equal(buildSetCommand(FEATURE_CODES.DOCK, 0), null);
});
