import test from 'node:test';
import assert from 'node:assert/strict';

import { POLL_FREQUENCY } from '../src/constants.js';
import { convertDevice, vacuumExternalIds } from '../src/devices/convertDevice.js';
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
    ['state', 'run-mode', 'clean-mode', 'dock', 'battery'],
  );
  // Each feature carries a unique selector equal to its external_id.
  device.features.forEach((f) => assert.equal(f.selector, f.external_id));
});

test('vacuumExternalIds builds the device + feature ids', () => {
  const ids = vacuumExternalIds(gladys, 'duid-2');
  assert.equal(ids.device, 'ext:test:vacuum:duid-2');
  assert.equal(ids.feature('state'), 'ext:test:vacuum:duid-2:state');
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

  const routines = device.features.slice(5);
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
