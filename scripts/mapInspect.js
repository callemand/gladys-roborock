#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Read-only RRMap inspector (milestone 1 analysis).
//
// Walks the block table of a decoded RRMap blob (the layer-4 output of
// scripts/mapDiag.js, saved as *.rrmap.bin) and prints what it contains WITHOUT
// rendering anything: block types/sizes, the IMAGE segment count and bounds, the
// robot/charger positions, and the no-go / virtual-wall / zone counts.
//
// Block layout (little-endian):
//   top header (20 bytes): "rr" | header_len(u16) | data_len(u32) |
//                          major(u16) | minor(u16) | map_index(u32) | map_seq(u32)
//   each block: type(u16) | header_len(u16) | data_len(u32) | <block header> | <data>
//   next block = offset + header_len + data_len
//
// Usage: node scripts/mapInspect.js <file.rrmap.bin>
// -----------------------------------------------------------------------------

import fs from 'node:fs';

// RRMap block types (Hypfer RRMapParser / vacuum-map-parser-roborock numbering).
const TYPES = {
  1: 'CHARGER_LOCATION',
  2: 'IMAGE',
  3: 'PATH',
  4: 'GOTO_PATH',
  5: 'GOTO_PREDICTED_PATH',
  6: 'CURRENTLY_CLEANED_ZONES',
  7: 'GOTO_TARGET',
  8: 'ROBOT_POSITION',
  9: 'NO_GO_AREAS',
  10: 'VIRTUAL_WALLS',
  11: 'CURRENTLY_CLEANED_BLOCKS',
  12: 'NO_MOPPING_AREAS',
  13: 'OBSTACLES',
  14: 'IGNORED_OBSTACLES',
  15: 'OBSTACLES_WITH_PHOTO',
  16: 'IGNORED_OBSTACLES_WITH_PHOTO',
  17: 'CARPET_MAP',
  18: 'MOP_PATH',
  19: 'NO_CARPET_AREAS',
  1024: 'DIGEST',
};

const POSITION_TYPES = new Set([1, 7, 8]); // charger, goto target, robot
const PATH_TYPES = new Set([3, 4, 5, 18]); // path / goto / predicted / mop
const COUNT_TYPES = new Set([6, 9, 10, 11, 12]); // zones / no-go / walls / blocks / no-mop

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/mapInspect.js <file.rrmap.bin>');
  process.exit(1);
}

const data = fs.readFileSync(file);

if (data.toString('latin1', 0, 2) !== 'rr') {
  console.error(`Not an RRMap blob (magic = ${data.subarray(0, 2).toString('hex')})`);
  process.exit(1);
}

const headerLen = data.readUInt16LE(2);
const dataLen = data.readUInt32LE(4);
const major = data.readUInt16LE(8);
const minor = data.readUInt16LE(10);
const mapIndex = data.readUInt32LE(12);
const mapSeq = data.readUInt32LE(16);

console.log(`RRMap v${major}.${minor}`);
console.log(`  total file     : ${data.length} bytes`);
console.log(`  header_length  : ${headerLen}`);
console.log(`  data_length    : ${dataLen} (header + data = ${headerLen + dataLen})`);
console.log(`  map_index      : ${mapIndex}`);
console.log(`  map_sequence   : ${mapSeq}`);
console.log('\nblocks:');

let offset = headerLen;
let count = 0;
while (offset + 8 <= data.length) {
  const type = data.readUInt16LE(offset);
  const bHeaderLen = data.readUInt16LE(offset + 2);
  const bDataLen = data.readUInt32LE(offset + 4);
  const name = TYPES[type] || `UNKNOWN(${type})`;

  let extra = '';
  try {
    // Block-specific fields start right after the 8-byte common header
    // (type u16 | header_len u16 | data_len u32).
    if (type === 2) {
      // IMAGE: header_len > 24 means the segment-aware (g3) layout, which adds a
      // segment count before top/left/height/width.
      const g3 = bHeaderLen > 24 ? 4 : 0;
      const segCount = g3 ? data.readUInt32LE(offset + 8) : 0;
      const top = data.readUInt32LE(offset + 8 + g3);
      const left = data.readUInt32LE(offset + 12 + g3);
      const height = data.readUInt32LE(offset + 16 + g3);
      const width = data.readUInt32LE(offset + 20 + g3);
      extra = `segments=${segCount} size=${width}x${height} top=${top} left=${left}`;
    } else if (POSITION_TYPES.has(type)) {
      // x,y (int32) then optional angle, in the data section.
      const x = data.readInt32LE(offset + bHeaderLen);
      const y = data.readInt32LE(offset + bHeaderLen + 4);
      const angle = bDataLen >= 12 ? data.readInt32LE(offset + bHeaderLen + 8) : null;
      extra = `x=${x} y=${y}${angle !== null ? ` angle=${angle}` : ''}`;
    } else if (PATH_TYPES.has(type) && bHeaderLen >= 20) {
      // A full path header carries point_count, point_size, angle.
      const pointCount = data.readUInt32LE(offset + 8);
      const pointSize = data.readUInt32LE(offset + 12);
      const angle = data.readInt32LE(offset + 16);
      extra = `points=${pointCount} point_size=${pointSize} angle=${angle}`;
    } else if (COUNT_TYPES.has(type) && bHeaderLen >= 12) {
      // Area/wall families carry a uint32 count in the extra header word; the
      // data section holds that many entries.
      const n = data.readUInt32LE(offset + 8);
      extra = `count=${n} (data ${bDataLen} bytes)`;
    }
  } catch (err) {
    extra = `(decode error: ${err.message})`;
  }

  console.log(
    `  @${String(offset).padStart(7)}  type=${String(type).padStart(4)} ${name.padEnd(28)} ` +
      `hlen=${bHeaderLen} dlen=${bDataLen}  ${extra}`,
  );

  const advance = bHeaderLen + bDataLen;
  if (advance <= 0) {
    console.log('  (zero-length block — stopping)');
    break;
  }
  offset += advance;
  count += 1;
}

console.log(
  `\n${count} block(s). ${offset === data.length ? 'Clean end (offset == file size).' : `Ended at ${offset}/${data.length}.`}`,
);
