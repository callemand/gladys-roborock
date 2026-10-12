import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FEATURE_CODES,
  ROBOROCK_METHOD,
  ROOM_SELECTION_NONE,
  VACUUM_CLEANER_CLEAN_MODE,
  VACUUM_CLEANER_MODE,
  VACUUM_CLEANER_STATE,
} from '../src/constants.js';

import {
  buildConsumableStates,
  buildDockFeatures,
  buildDockStates,
  buildPollStates,
  buildSegmentCleanCommand,
  buildSetCommand,
  buildVacuumFeatures,
  cleanModeFromStatus,
  isMopCapable,
  routineIdFromFeatureCode,
} from '../src/devices/vacuum.js';

import { fakeVacuumIds } from './helpers/fakeGladys.js';

const ids = fakeVacuumIds('duid');

test('buildVacuumFeatures exposes vacuum state and maintenance features', () => {
  const features = buildVacuumFeatures(ids);

  assert.deepEqual(
    features.map((feature) => feature.external_id.split(':').pop()),
    [
      'state',
      'run-mode',
      'clean-mode',
      'dock',
      'battery',
      'main-brush',
      'side-brush',
      'filter',
      'sensor-cleaning',
    ],
  );

  const state = features.find((feature) => feature.external_id.endsWith(':state'));

  assert.equal(state.read_only, true);
  assert.equal(state.category, 'vacuum-cleaner');
  assert.equal(state.type, 'state');

  const dock = features.find((feature) => feature.external_id.endsWith(':dock'));

  assert.equal(dock.read_only, false);
  assert.equal(dock.has_feedback, false);

  const battery = features.find((feature) => feature.external_id.endsWith(':battery'));

  assert.equal(battery.category, 'battery');
  assert.equal(battery.unit, 'percent');

  const maintenanceFeatures = features.filter((feature) => feature.category === 'maintenance');

  assert.deepEqual(
    maintenanceFeatures.map((feature) => ({
      name: feature.name,
      type: feature.type,
      unit: feature.unit,
      read_only: feature.read_only,
      min: feature.min,
      max: feature.max,
    })),
    [
      {
        name: 'Main brush',
        type: 'life-remaining',
        unit: 'percent',
        read_only: true,
        min: 0,
        max: 100,
      },
      {
        name: 'Side brush',
        type: 'life-remaining',
        unit: 'percent',
        read_only: true,
        min: 0,
        max: 100,
      },
      {
        name: 'Filter',
        type: 'life-remaining',
        unit: 'percent',
        read_only: true,
        min: 0,
        max: 100,
      },
      {
        name: 'Sensor cleaning',
        type: 'life-remaining',
        unit: 'percent',
        read_only: true,
        min: 0,
        max: 100,
      },
    ],
  );
});

test('buildVacuumFeatures exposes rooms as dynamic select options', () => {
  const features = buildVacuumFeatures(
    ids,
    [],
    [
      {
        id: 16,
        name: 'Kitchen',
      },
      {
        id: 17,
        name: 'Living room',
      },
    ],
  );

  const room = features.find((feature) => feature.external_id.endsWith(':room'));

  assert.ok(room);

  assert.equal(room.name, 'Room to clean');
  assert.equal(room.read_only, false);
  assert.equal(room.has_feedback, false);
  assert.equal(room.keep_history, false);
  assert.equal(room.min, 0);
  assert.equal(room.max, 0);
  assert.equal(room.category, 'text');
  assert.equal(room.type, 'select');

  assert.deepEqual(room.supported_options, [
    {
      value: ROOM_SELECTION_NONE,
      label: '—',
      sort_order: 0,
    },
    {
      value: '16',
      label: 'Kitchen',
      sort_order: 1,
    },
    {
      value: '17',
      label: 'Living room',
      sort_order: 2,
    },
  ]);
});

test('buildVacuumFeatures does not expose an empty room selector', () => {
  const features = buildVacuumFeatures(ids, [], []);

  assert.equal(
    features.some((feature) => feature.external_id.endsWith(':room')),
    false,
  );
});

test('buildConsumableStates maps robot maintenance to remaining percentages', () => {
  assert.deepEqual(
    buildConsumableStates(ids, {
      main_brush_work_time: 150 * 60 * 60,
      side_brush_work_time: 50 * 60 * 60,
      filter_work_time: 15 * 60 * 60,
      sensor_dirty_time: 15 * 60 * 60,
    }),
    [
      {
        device_feature_external_id: 'ext:test:vacuum:duid:main-brush',
        state: 50,
      },
      {
        device_feature_external_id: 'ext:test:vacuum:duid:side-brush',
        state: 75,
      },
      {
        device_feature_external_id: 'ext:test:vacuum:duid:filter',
        state: 90,
      },
      {
        device_feature_external_id: 'ext:test:vacuum:duid:sensor-cleaning',
        state: 50,
      },
    ],
  );
});

test('buildDockFeatures exposes generic maintenance features', () => {
  const dockIds = {
    device: 'ext:test:dock:duid',
    feature: (key) => `ext:test:dock:duid:${key}`,
  };

  const features = buildDockFeatures(dockIds);

  assert.deepEqual(
    features.map((feature) => feature.external_id.split(':').pop()),
    ['dock-strainer', 'dock-cleaning-brush', 'dust-collection'],
  );

  assert.deepEqual(
    features.map((feature) => ({
      name: feature.name,
      category: feature.category,
      type: feature.type,
      unit: feature.unit,
      read_only: feature.read_only,
      min: feature.min,
      max: feature.max,
    })),
    [
      {
        name: 'Strainer',
        category: 'maintenance',
        type: 'life-remaining',
        unit: 'percent',
        read_only: true,
        min: 0,
        max: 100,
      },
      {
        name: 'Cleaning brush',
        category: 'maintenance',
        type: 'life-remaining',
        unit: 'percent',
        read_only: true,
        min: 0,
        max: 100,
      },
      {
        name: 'Dust collection',
        category: 'maintenance',
        type: 'life-remaining',
        unit: 'percent',
        read_only: true,
        min: 0,
        max: 100,
      },
    ],
  );
});

test('buildDockStates maps station maintenance to remaining percentages', () => {
  const dockIds = {
    device: 'ext:test:dock:duid',
    feature: (key) => `ext:test:dock:duid:${key}`,
  };

  assert.deepEqual(
    buildDockStates(dockIds, {
      strainer_work_times: 15,
      cleaning_brush_work_times: 30,
      dust_collection_work_times: 9,
    }),
    [
      {
        device_feature_external_id: 'ext:test:dock:duid:dock-strainer',
        state: 90,
      },
      {
        device_feature_external_id: 'ext:test:dock:duid:dock-cleaning-brush',
        state: 90,
      },
      {
        device_feature_external_id: 'ext:test:dock:duid:dust-collection',
        state: 90,
      },
    ],
  );
});

test('buildPollStates maps a charging status to the Gladys states', () => {
  const states = buildPollStates(ids, {
    state: 8,
    battery: 87,
    fan_power: 102,
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
    {
      device_feature_external_id: 'ext:test:vacuum:duid:battery',
      state: 87,
    },
  ]);
});

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
    {
      device_feature_external_id: 'ext:test:vacuum:duid:battery',
      state: 100,
    },
  ]);
});

test('the fan-power 106 alias reads as AUTO but AUTO is written as 102', () => {
  const states = buildPollStates(ids, {
    state: 8,
    fan_power: 106,
  });

  const cleanMode = states.find((state) =>
    state.device_feature_external_id.endsWith(':clean-mode'),
  );

  assert.equal(cleanMode.state, VACUUM_CLEANER_CLEAN_MODE.AUTO);

  assert.deepEqual(buildSetCommand(FEATURE_CODES.CLEAN_MODE, VACUUM_CLEANER_CLEAN_MODE.AUTO), {
    method: ROBOROCK_METHOD.SET_FAN_POWER,
    params: [102],
  });
});

test('buildPollStates derives a CLEANING run-mode from a cleaning state', () => {
  const states = buildPollStates(ids, {
    state: 5,
    battery: 50,
    fan_power: 104,
  });

  const runMode = states.find((state) => state.device_feature_external_id.endsWith(':run-mode'));

  assert.equal(runMode.state, VACUUM_CLEANER_MODE.CLEANING);

  const stateFeature = states.find((state) => state.device_feature_external_id.endsWith(':state'));

  assert.equal(stateFeature.state, VACUUM_CLEANER_STATE.RUNNING);

  const cleanMode = states.find((state) =>
    state.device_feature_external_id.endsWith(':clean-mode'),
  );

  assert.equal(cleanMode.state, VACUUM_CLEANER_CLEAN_MODE.VACUUM);
});

test('buildPollStates skips unknown states and fan-power codes', () => {
  const states = buildPollStates(ids, {
    state: 99999,
    battery: null,
    fan_power: 9999,
  });

  assert.equal(
    states.some((state) => state.device_feature_external_id.endsWith(':state')),
    false,
  );

  assert.equal(
    states.some((state) => state.device_feature_external_id.endsWith(':clean-mode')),
    false,
  );

  assert.equal(
    states.some((state) => state.device_feature_external_id.endsWith(':battery')),
    false,
  );

  const runMode = states.find((state) => state.device_feature_external_id.endsWith(':run-mode'));

  assert.equal(runMode.state, VACUUM_CLEANER_MODE.IDLE);
});

test('buildSetCommand maps run-mode CLEANING and IDLE', () => {
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

test('buildSetCommand maps clean-mode to set_custom_mode', () => {
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

test('buildSetCommand maps dock=1 to app_charge', () => {
  assert.deepEqual(buildSetCommand(FEATURE_CODES.DOCK, 1), {
    method: ROBOROCK_METHOD.APP_CHARGE,
    params: [],
  });

  assert.equal(buildSetCommand(FEATURE_CODES.DOCK, 0), null);
});

test('buildSetCommand maps a selected room to app_segment_clean', () => {
  assert.deepEqual(buildSetCommand(FEATURE_CODES.ROOM, '16'), {
    method: ROBOROCK_METHOD.APP_SEGMENT_CLEAN,
    params: [{ segments: [16], repeat: 1 }],
  });

  assert.deepEqual(buildSegmentCleanCommand([16, 17]), {
    method: ROBOROCK_METHOD.APP_SEGMENT_CLEAN,
    params: [{ segments: [16, 17], repeat: 1 }],
  });

  assert.equal(buildSetCommand(FEATURE_CODES.ROOM, ROOM_SELECTION_NONE), null);

  assert.equal(buildSetCommand(FEATURE_CODES.ROOM, 'not-a-room'), null);
});

// --- Mop-capable robots (Saros 10R and friends, issue #13) -------------------

const SAROS_STATUS = { state: 8, fan_power: 103, water_box_mode: 235, mop_mode: 300 };

test('a robot reporting a water flow is mop-capable, an older one is not', () => {
  assert.equal(isMopCapable(SAROS_STATUS), true);
  assert.equal(isMopCapable({ state: 8, fan_power: 102 }), false);
  assert.equal(isMopCapable(null), false);
});

test('the clean-mode options only list what the robot can do', () => {
  const suctionOnly = buildVacuumFeatures(ids).find((f) => f.external_id.endsWith(':clean-mode'));
  assert.deepEqual(
    suctionOnly.supported_options.map((o) => o.value),
    [
      VACUUM_CLEANER_CLEAN_MODE.AUTO,
      VACUUM_CLEANER_CLEAN_MODE.QUIET,
      VACUUM_CLEANER_CLEAN_MODE.LOW_NOISE,
      VACUUM_CLEANER_CLEAN_MODE.DEEP_CLEAN,
      VACUUM_CLEANER_CLEAN_MODE.VACUUM,
    ],
  );

  const mop = buildVacuumFeatures(ids, [], [], { mopCapable: true }).find((f) =>
    f.external_id.endsWith(':clean-mode'),
  );
  assert.deepEqual(mop.supported_options, [
    { value: VACUUM_CLEANER_CLEAN_MODE.AUTO, label: 'Vac & Mop', sort_order: 0 },
    { value: VACUUM_CLEANER_CLEAN_MODE.VACUUM, label: 'Vacuum', sort_order: 1 },
    { value: VACUUM_CLEANER_CLEAN_MODE.MOP, label: 'Mop', sort_order: 2 },
  ]);
  // the core refuses an option without a label
  for (const option of [...suctionOnly.supported_options, ...mop.supported_options]) {
    assert.ok(typeof option.label === 'string' && option.label.trim(), 'labelled option');
  }
});

test('a mop-capable status reads as Vacuum / Vac & Mop / Mop, not as a suction level', () => {
  // turbo suction + water on: Vac & Mop (AUTO), not DEEP_CLEAN
  assert.equal(cleanModeFromStatus(SAROS_STATUS), VACUUM_CLEANER_CLEAN_MODE.AUTO);
  // water off: Vacuum, whatever the suction
  assert.equal(
    cleanModeFromStatus({ ...SAROS_STATUS, water_box_mode: 200, fan_power: 104 }),
    VACUUM_CLEANER_CLEAN_MODE.VACUUM,
  );
  // fan "off" (105) + water on: Mop only (105 is "gentle" on the older robots)
  assert.equal(
    cleanModeFromStatus({ ...SAROS_STATUS, fan_power: 105 }),
    VACUUM_CLEANER_CLEAN_MODE.MOP,
  );
  assert.equal(cleanModeFromStatus({ fan_power: 105 }), VACUUM_CLEANER_CLEAN_MODE.LOW_NOISE);
  assert.equal(cleanModeFromStatus({ water_box_mode: 202 }), undefined);

  const states = buildPollStates(ids, { ...SAROS_STATUS, fan_power: 105 });
  const cleanMode = states.find((s) => s.device_feature_external_id.endsWith(':clean-mode'));
  assert.equal(cleanMode.state, VACUUM_CLEANER_CLEAN_MODE.MOP);
});

test('on a mop-capable robot the clean mode is set with set_clean_motor_mode', () => {
  const context = { status: SAROS_STATUS };

  // Vacuum: water off, the robot's own suction and route kept
  assert.deepEqual(
    buildSetCommand(FEATURE_CODES.CLEAN_MODE, VACUUM_CLEANER_CLEAN_MODE.VACUUM, context),
    {
      method: ROBOROCK_METHOD.SET_CLEAN_MOTOR_MODE,
      params: [{ fan_power: 103, water_box_mode: 200, mop_mode: 300 }],
    },
  );

  // Vac & Mop from Vacuum: the water flow the robot last reported, not a
  // hard-coded 202 (a Saros only knows its own slider codes)
  assert.deepEqual(
    buildSetCommand(FEATURE_CODES.CLEAN_MODE, VACUUM_CLEANER_CLEAN_MODE.AUTO, {
      status: { ...SAROS_STATUS, water_box_mode: 200 },
      waterBoxMode: 235,
    }),
    {
      method: ROBOROCK_METHOD.SET_CLEAN_MOTOR_MODE,
      params: [{ fan_power: 103, water_box_mode: 235, mop_mode: 300 }],
    },
  );
  // ...and 202 only when it never mopped since the integration started
  assert.deepEqual(
    buildSetCommand(FEATURE_CODES.CLEAN_MODE, VACUUM_CLEANER_CLEAN_MODE.AUTO, {
      status: { state: 8, fan_power: 105, water_box_mode: 200 },
    }).params,
    [{ fan_power: 102, water_box_mode: 202 }],
  );

  // Mop: suction off, water on
  assert.deepEqual(
    buildSetCommand(FEATURE_CODES.CLEAN_MODE, VACUUM_CLEANER_CLEAN_MODE.MOP, context).params,
    [{ fan_power: 105, water_box_mode: 235, mop_mode: 300 }],
  );

  // suction levels stay a suction change (widget buttons, scene action)...
  assert.deepEqual(
    buildSetCommand(FEATURE_CODES.CLEAN_MODE, VACUUM_CLEANER_CLEAN_MODE.QUIET, context),
    {
      method: ROBOROCK_METHOD.SET_FAN_POWER,
      params: [101],
    },
  );
  // ...except LOW_NOISE, whose code means "no suction" on these robots
  assert.equal(
    buildSetCommand(FEATURE_CODES.CLEAN_MODE, VACUUM_CLEANER_CLEAN_MODE.LOW_NOISE, context),
    null,
  );
});

test('routineIdFromFeatureCode accepts only valid routine feature codes', () => {
  assert.equal(routineIdFromFeatureCode('routine-1234'), 1234);

  assert.equal(routineIdFromFeatureCode('run-mode'), null);

  assert.equal(routineIdFromFeatureCode('routine-nope'), null);

  assert.equal(routineIdFromFeatureCode('routine--1'), null);
});
