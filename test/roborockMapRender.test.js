import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { parseRRMap, RRMAP_BLOCK } from '../src/roborock/mapParser.js';
import { renderMapPng, encodePng } from '../src/roborock/mapRender.js';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
}
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}
function i32(n) {
  const b = Buffer.alloc(4);
  b.writeInt32LE(n, 0);
  return b;
}
function block(type, headerExtra, data) {
  return Buffer.concat([
    u16(type),
    u16(8 + headerExtra.length),
    u32(data.length),
    headerExtra,
    data,
  ]);
}
const segPixel = (id) => ((id << 3) | 7) & 0xff;

function buildMap() {
  const width = 4;
  const height = 4;
  // prettier-ignore
  const pixels = Buffer.from([
    0, 1, 1, 0,
    0, segPixel(2), segPixel(2), 0,
    0, segPixel(3), segPixel(3), 0,
    0, 0, 0, 0,
  ]);
  const image = block(
    RRMAP_BLOCK.IMAGE,
    Buffer.concat([u32(2), u32(0), u32(0), u32(height), u32(width)]),
    pixels,
  );
  const robot = block(
    RRMAP_BLOCK.ROBOT_POSITION,
    Buffer.alloc(0),
    Buffer.concat([i32(100), i32(100), i32(0)]),
  );
  const body = Buffer.concat([image, robot]);
  const header = Buffer.concat([
    Buffer.from('rr'),
    u16(20),
    u32(body.length),
    u16(1),
    u16(0),
    u32(1),
    u32(1),
  ]);
  return Buffer.concat([header, body]);
}

test('encodePng writes a valid PNG signature and IHDR dimensions', () => {
  const rgba = Buffer.alloc(2 * 3 * 4, 255);
  const png = encodePng(2, 3, rgba);
  assert.deepEqual(png.subarray(0, 8), PNG_SIGNATURE);
  // first chunk is IHDR; width/height are the two uint32be right after the type
  assert.equal(png.toString('latin1', 12, 16), 'IHDR');
  assert.equal(png.readUInt32BE(16), 2);
  assert.equal(png.readUInt32BE(20), 3);
  // the IDAT payload must inflate back to (width*4 + 1) * height bytes
  const idatStart = png.indexOf(Buffer.from('IDAT'));
  const idatLen = png.readUInt32BE(idatStart - 4);
  const idat = png.subarray(idatStart + 4, idatStart + 4 + idatLen);
  assert.equal(zlib.inflateSync(idat).length, (2 * 4 + 1) * 3);
});

test('renderMapPng produces a PNG from a parsed map with pixels', () => {
  const map = parseRRMap(buildMap(), { includePixels: true });
  const png = renderMapPng(map, { scale: 2, margin: 1 });
  assert.deepEqual(png.subarray(0, 8), PNG_SIGNATURE);
  assert.ok(png.length > 8);
});

test('renderMapPng requires the pixel data', () => {
  const map = parseRRMap(buildMap()); // no includePixels
  assert.throws(() => renderMapPng(map), /includePixels/);
});

test('with targetLongestPx the output size is stable when only the robot moves', () => {
  const dims = (png) => ({ w: png.readUInt32BE(16), h: png.readUInt32BE(20) });
  const map = parseRRMap(buildMap(), { includePixels: true });
  // Name the segments so the crop is based on the (stable) rooms, like in prod.
  map.segments.forEach((segment) => {
    segment.named = true;
    segment.roomName = `Room ${segment.segmentId}`;
  });

  const before = dims(renderMapPng(map, { targetLongestPx: 300 }));
  // The robot (and its path) move far away: the fixed frame must not resize.
  map.robot = { x: 9_000_000, y: 9_000_000, angle: 0 };
  const after = dims(renderMapPng(map, { targetLongestPx: 300 }));

  assert.deepEqual(after, before);
  assert.ok(before.w > 0 && before.h > 0);
});
