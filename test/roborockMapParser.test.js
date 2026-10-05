import test from 'node:test';
import assert from 'node:assert/strict';

import { parseRRMap, RRMAP_BLOCK, PIXEL_SIZE_MM } from '../src/roborock/mapParser.js';
import { attachRoomNames } from '../src/roborock/rooms.js';

// --- helpers to build a synthetic RRMap ------------------------------------
function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n >>> 0, 0);
  return b;
}
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}
function i32(n) {
  const b = Buffer.alloc(4);
  b.writeInt32LE(n, 0);
  return b;
}

// A block = type | header_len | data_len | headerExtra | data.
function block(type, headerExtra, data) {
  const headerLen = 8 + headerExtra.length;
  return Buffer.concat([u16(type), u16(headerLen), u32(data.length), headerExtra, data]);
}

// A segment pixel: low 3 bits = type (7 = floor-in-segment), high 5 = segment id.
function segPixel(id) {
  return ((id << 3) | 7) & 0xff;
}
const WALL = 1;

function buildSyntheticMap() {
  // 4x4 image: a wall row, then two 2-pixel segments (ids 2 and 3).
  const width = 4;
  const height = 4;
  // prettier-ignore
  const pixels = Buffer.from([
    0,    WALL, WALL, 0,
    0,    segPixel(2), segPixel(2), 0,
    0,    segPixel(3), segPixel(3), 0,
    0,    0,    0,    0,
  ]);
  const imageHeader = Buffer.concat([
    u32(2), // segment count (g3 layout, since headerExtra > 16 bytes)
    u32(5), // top
    u32(6), // left
    u32(height),
    u32(width),
  ]);
  const image = block(RRMAP_BLOCK.IMAGE, imageHeader, pixels);

  const charger = block(
    RRMAP_BLOCK.CHARGER_LOCATION,
    Buffer.alloc(0),
    Buffer.concat([i32(100), i32(200), i32(45)]),
  );
  const robot = block(
    RRMAP_BLOCK.ROBOT_POSITION,
    Buffer.alloc(0),
    Buffer.concat([i32(110), i32(210), i32(-90)]),
  );

  const pathHeader = Buffer.concat([u32(2), u32(4), i32(0)]); // pointCount, pointSize, angle
  const pathData = Buffer.concat([u16(300), u16(400), u16(320), u16(420)]);
  const path = block(RRMAP_BLOCK.PATH, pathHeader, pathData);

  // one no-go quadrilateral (4 points)
  const noGoData = Buffer.concat([
    u16(10),
    u16(10),
    u16(20),
    u16(10),
    u16(20),
    u16(20),
    u16(10),
    u16(20),
  ]);
  const noGo = block(RRMAP_BLOCK.NO_GO_AREAS, u32(1), noGoData);

  // two virtual walls (2 points each)
  const wallsData = Buffer.concat([u16(1), u16(2), u16(3), u16(4), u16(5), u16(6), u16(7), u16(8)]);
  const walls = block(RRMAP_BLOCK.VIRTUAL_WALLS, u32(2), wallsData);

  const digest = block(RRMAP_BLOCK.DIGEST, Buffer.alloc(0), u32(0));

  const body = Buffer.concat([image, charger, robot, path, noGo, walls, digest]);
  const header = Buffer.concat([
    Buffer.from('rr'),
    u16(20), // header length
    u32(body.length),
    u16(1), // major
    u16(0), // minor
    u32(42), // map index
    u32(7), // map sequence
  ]);
  return Buffer.concat([header, body]);
}

test('parseRRMap rejects a non-RRMap buffer', () => {
  assert.throws(() => parseRRMap(Buffer.from('not a map')), /rr/);
});

test('parseRRMap extracts the top-level header', () => {
  const map = parseRRMap(buildSyntheticMap());
  assert.deepEqual(map.version, { major: 1, minor: 0 });
  assert.equal(map.mapIndex, 42);
  assert.equal(map.mapSequence, 7);
  assert.equal(map.pixelSizeMm, PIXEL_SIZE_MM);
});

test('parseRRMap reads the image bounds and per-segment pixel stats', () => {
  const map = parseRRMap(buildSyntheticMap());
  assert.equal(map.image.width, 4);
  assert.equal(map.image.height, 4);
  assert.equal(map.image.top, 5);
  assert.equal(map.image.left, 6);
  assert.equal(map.image.segmentCountDeclared, 2);
  assert.equal(map.image.wallPixels, 2);
  assert.equal(map.image.segmentCountInPixels, 2);
  assert.deepEqual(
    map.segments.map((s) => ({ id: s.segmentId, px: s.pixelCount })),
    [
      { id: 2, px: 2 },
      { id: 3, px: 2 },
    ],
  );
});

test('parseRRMap reads robot and dock positions', () => {
  const map = parseRRMap(buildSyntheticMap());
  assert.deepEqual(map.charger, { x: 100, y: 200, angle: 45 });
  assert.deepEqual(map.robot, { x: 110, y: 210, angle: -90 });
});

test('parseRRMap reads the cleaning path points', () => {
  const map = parseRRMap(buildSyntheticMap());
  assert.equal(map.path.pointCount, 2);
  assert.deepEqual(map.path.points, [
    { x: 300, y: 400 },
    { x: 320, y: 420 },
  ]);
});

test('parseRRMap reads no-go areas and virtual walls', () => {
  const map = parseRRMap(buildSyntheticMap());
  assert.equal(map.noGoAreas.length, 1);
  assert.equal(map.noGoAreas[0].length, 4);
  assert.deepEqual(map.noGoAreas[0][0], { x: 10, y: 10 });
  assert.equal(map.virtualWalls.length, 2);
  assert.deepEqual(map.virtualWalls[0], { x0: 1, y0: 2, x1: 3, y1: 4 });
  assert.deepEqual(map.virtualWalls[1], { x0: 5, y0: 6, x1: 7, y1: 8 });
});

test('parseRRMap records every block type it walked, ending cleanly', () => {
  const map = parseRRMap(buildSyntheticMap());
  assert.ok(map.blocksSeen.includes(RRMAP_BLOCK.IMAGE));
  assert.ok(map.blocksSeen.includes(RRMAP_BLOCK.DIGEST));
});

test('attachRoomNames names the segments that get_room_mapping knows, keeps the rest', () => {
  const map = parseRRMap(buildSyntheticMap()); // segments 2 and 3
  // get_room_mapping named segment 2 "Cuisine" but not segment 3.
  const named = attachRoomNames(map.segments, [{ id: 2, name: 'Cuisine' }]);
  const seg2 = named.find((s) => s.segmentId === 2);
  const seg3 = named.find((s) => s.segmentId === 3);
  assert.equal(seg2.roomName, 'Cuisine');
  assert.equal(seg2.named, true);
  assert.equal(seg3.roomName, null);
  assert.equal(seg3.named, false);
  // the pixel stats are preserved through the merge
  assert.equal(seg2.pixelCount, 2);
});

test('attachRoomNames tolerates no room mapping', () => {
  const map = parseRRMap(buildSyntheticMap());
  const named = attachRoomNames(map.segments, []);
  assert.equal(named.length, map.segments.length);
  assert.ok(named.every((s) => s.named === false && s.roomName === null));
});
