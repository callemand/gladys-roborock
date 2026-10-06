import test from 'node:test';
import assert from 'node:assert/strict';

import { POLL_FREQUENCY } from '../src/constants.js';
import {
  convertDevice,
  convertDockDevice,
  dockExternalIds,
  vacuumExternalIds,
} from '../src/devices/convertDevice.js';
import { createFakeGladys } from './helpers/fakeGladys.js';

const gladys = createFakeGladys();

test('convertDevice builds the Gladys discovered device for a robot', () => {
  const device = convertDevice(gladys, {
    duid: 'duid-1',
    name: 'Living room robot',
    model: 'roborock.vacuum.a15',
    localKey: 'abcdef0123456789',
    online: true,
  });

  assert.equal(device.external_id, 'ext:test:vacuum:duid-1');
  assert.equal(device.name, 'Living room robot');
  assert.equal(device.model, 'roborock.vacuum.a15');
  assert.equal(device.poll_frequency, POLL_FREQUENCY);
  assert.equal(device.should_poll, true);

  assert.deepEqual(
    device.features.map((f) => f.external_id.split(':').pop()),
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
      'last-clean-start',
    ],
  );
  // Each feature carries a unique selector equal to its external_id.
  device.features.forEach((f) => assert.equal(f.selector, f.external_id));
});

test('vacuumExternalIds builds the device + feature ids', () => {
  const ids = vacuumExternalIds(gladys, 'duid-2');
  assert.equal(ids.device, 'ext:test:vacuum:duid-2');
  assert.equal(ids.feature('state'), 'ext:test:vacuum:duid-2:state');
});

test('convertDockDevice builds a separate Gladys device for the station', () => {
  const device = convertDockDevice(gladys, { duid: 'duid-2', name: 'Living room robot' }, 21);
  assert.equal(device.external_id, 'ext:test:dock:duid-2');
  assert.equal(device.name, 'Living room robot - Dock');
  assert.equal(device.model, 'Roborock dock type 21');
  assert.deepEqual(
    device.features.map((feature) => feature.external_id.split(':').pop()),
    ['dock-strainer', 'dock-cleaning-brush', 'dust-collection'],
  );
  device.features.forEach((feature) => assert.equal(feature.selector, feature.external_id));
  assert.equal(dockExternalIds(gladys, 'duid-2').device, 'ext:test:dock:duid-2');
});

test('convertDevice adds one push button per Roborock routine', () => {
  const device = convertDevice(gladys, {
    duid: 'duid-3',
    name: 'Kitchen robot',
    routines: [
      { id: 42, name: 'After lunch' },
      { id: 84, name: 'Kitchen and zones' },
    ],
  });

  const routines = device.features.filter((feature) => feature.external_id.includes(':routine-'));
  assert.deepEqual(
    routines.map(({ name, external_id, category, type }) => ({
      name,
      external_id,
      category,
      type,
    })),
    [
      {
        name: 'Routine - After lunch',
        external_id: 'ext:test:vacuum:duid-3:routine-42',
        category: 'button',
        type: 'push',
      },
      {
        name: 'Routine - Kitchen and zones',
        external_id: 'ext:test:vacuum:duid-3:routine-84',
        category: 'button',
        type: 'push',
      },
    ],
  );
  routines.forEach((feature) => {
    assert.equal(feature.has_feedback, false);
    assert.equal(feature.selector, feature.external_id);
  });
});
