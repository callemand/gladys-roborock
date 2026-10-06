import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeRoomMappings, roomMappingEntries, unnamedIotIds } from '../src/roborock/rooms.js';

test('roomMappingEntries reads the list, flat and wrapped shapes', () => {
  const expected = [
    { segmentId: 16, iotId: '1001' },
    { segmentId: 17, iotId: '1002' },
  ];
  assert.deepEqual(
    roomMappingEntries([
      [16, '1001', 14],
      [17, 1002, 14],
    ]),
    expected,
  );
  assert.deepEqual(
    roomMappingEntries([
      [
        [16, '1001'],
        [17, '1002'],
      ],
    ]),
    expected,
  );
  assert.deepEqual(roomMappingEntries([16, '1001']), [{ segmentId: 16, iotId: '1001' }]);
  assert.deepEqual(roomMappingEntries('ok'), []);
});

test('roomMappingEntries keeps the first pair of a repeated segment', () => {
  assert.deepEqual(
    roomMappingEntries([
      [16, '1001'],
      [16, '1002'],
      ['x', '1003'],
    ]),
    [{ segmentId: 16, iotId: '1001' }],
  );
});

test('unnamedIotIds lists the rooms HomeData does not name', () => {
  const mapping = [
    [16, '1001'],
    [17, '1002'],
    [18, '1003'],
  ];
  const homeRooms = [
    { id: 1001, name: 'Cuisine' },
    { id: 1003, name: '  ' },
  ];
  assert.deepEqual(unnamedIotIds(mapping, homeRooms), ['1002', '1003']);
  assert.deepEqual(unnamedIotIds(mapping, []), ['1001', '1002', '1003']);
});

test('normalizeRoomMappings names each segment, the later room list winning', () => {
  const mapping = [
    [16, '1001'],
    [17, '1002'],
  ];
  // HomeData first, then the room list fetched on its own
  const rooms = [
    { id: 1001, name: '' },
    { id: 1001, name: 'Cuisine' },
  ];
  assert.deepEqual(normalizeRoomMappings(mapping, rooms), [
    { id: 16, name: 'Cuisine' },
    { id: 17, name: 'Room 17' },
  ]);
});
