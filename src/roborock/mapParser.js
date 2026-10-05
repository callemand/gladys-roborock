// -----------------------------------------------------------------------------
// RRMap parser — the decompressed map blob (layer 4 of a get_map_v1 answer, see
// src/roborock/map.js) into a structured, JSON-friendly object.
//
// It extracts the elements Gladys needs: segments (rooms), robot and dock
// position, cleaning path, no-go areas and virtual walls — WITHOUT rendering
// anything. Coordinates stay in the robot's native millimetres; a pixel grid of
// PIXEL_SIZE_MM per cell is exposed so a renderer can place things later.
//
// Block layout (little-endian), as walked by scripts/mapInspect.js:
//   top header (20 bytes): "rr" | header_len(u16) | data_len(u32) |
//                          major(u16) | minor(u16) | map_index(u32) | map_seq(u32)
//   each block: type(u16) | header_len(u16) | data_len(u32) | <header> | <data>
//   next block = offset + header_len + data_len
//
// Verified against a real Roborock QV 35A (roborock.vacuum.a168) payload.
// Algorithm informed by python-roborock / Hypfer's RRMapParser (both Apache-2.0
// / permissive): reimplemented, not copied.
// -----------------------------------------------------------------------------

export const RRMAP_BLOCK = {
  CHARGER_LOCATION: 1,
  IMAGE: 2,
  PATH: 3,
  GOTO_PATH: 4,
  GOTO_PREDICTED_PATH: 5,
  CURRENTLY_CLEANED_ZONES: 6,
  GOTO_TARGET: 7,
  ROBOT_POSITION: 8,
  NO_GO_AREAS: 9,
  VIRTUAL_WALLS: 10,
  CURRENTLY_CLEANED_BLOCKS: 11,
  NO_MOPPING_AREAS: 12,
  OBSTACLES: 13,
  MOP_PATH: 18,
  DIGEST: 1024,
};

// Each map cell is 50 mm on Roborock vacuums.
export const PIXEL_SIZE_MM = 50;

// IMAGE pixel encoding (segment-aware / "g3" firmware): the low 3 bits are the
// cell type, the high 5 bits the segment id.
const PIXEL_TYPE_MASK = 0x07;
const PIXEL_TYPE_OUTSIDE = 0;
const PIXEL_TYPE_WALL = 1;

/**
 * Parse a decompressed RRMap blob into a structured object.
 * @param {Buffer} data the gunzipped RRMap bytes (must start with "rr")
 * @param {object} [options] options
 * @param {boolean} [options.includePixels] keep the raw IMAGE pixel bytes on
 *   `image.pixels` (needed to render the floor plan; off by default to keep the
 *   JSON small)
 * @returns {object} the structured map
 */
export function parseRRMap(data, { includePixels = false } = {}) {
  if (!Buffer.isBuffer(data) || data.length < 20 || data.toString('latin1', 0, 2) !== 'rr') {
    throw new Error('Not an RRMap blob (missing "rr" magic)');
  }

  const headerLength = data.readUInt16LE(2);
  const map = {
    version: { major: data.readUInt16LE(8), minor: data.readUInt16LE(10) },
    mapIndex: data.readUInt32LE(12),
    mapSequence: data.readUInt32LE(16),
    pixelSizeMm: PIXEL_SIZE_MM,
    image: null,
    robot: null,
    charger: null,
    gotoTarget: null,
    path: null,
    gotoPath: null,
    predictedPath: null,
    mopPath: null,
    segments: [],
    noGoAreas: [],
    noMoppingAreas: [],
    virtualWalls: [],
    cleanedZones: [],
    blocksSeen: [],
  };

  let offset = headerLength;
  while (offset + 8 <= data.length) {
    const type = data.readUInt16LE(offset);
    const blockHeaderLength = data.readUInt16LE(offset + 2);
    const blockDataLength = data.readUInt32LE(offset + 4);
    const dataStart = offset + blockHeaderLength;
    const dataEnd = dataStart + blockDataLength;
    map.blocksSeen.push(type);

    if (dataEnd > data.length) {
      break; // truncated / malformed: stop rather than read out of bounds
    }

    switch (type) {
      case RRMAP_BLOCK.IMAGE:
        map.image = parseImage(
          data,
          offset,
          blockHeaderLength,
          dataStart,
          blockDataLength,
          includePixels,
        );
        map.segments = map.image.segments;
        break;
      case RRMAP_BLOCK.CHARGER_LOCATION:
        map.charger = parsePosition(data, dataStart, blockDataLength);
        break;
      case RRMAP_BLOCK.ROBOT_POSITION:
        map.robot = parsePosition(data, dataStart, blockDataLength);
        break;
      case RRMAP_BLOCK.GOTO_TARGET:
        map.gotoTarget = parsePosition(data, dataStart, blockDataLength);
        break;
      case RRMAP_BLOCK.PATH:
        map.path = parsePath(data, offset, dataStart, blockDataLength);
        break;
      case RRMAP_BLOCK.GOTO_PATH:
        map.gotoPath = parsePath(data, offset, dataStart, blockDataLength);
        break;
      case RRMAP_BLOCK.GOTO_PREDICTED_PATH:
        map.predictedPath = parsePath(data, offset, dataStart, blockDataLength);
        break;
      case RRMAP_BLOCK.NO_GO_AREAS:
        map.noGoAreas = parseAreas(data, offset, dataStart, blockDataLength);
        break;
      case RRMAP_BLOCK.NO_MOPPING_AREAS:
        map.noMoppingAreas = parseAreas(data, offset, dataStart, blockDataLength);
        break;
      case RRMAP_BLOCK.CURRENTLY_CLEANED_ZONES:
        map.cleanedZones = parseAreas(data, offset, dataStart, blockDataLength);
        break;
      case RRMAP_BLOCK.VIRTUAL_WALLS:
        map.virtualWalls = parseWalls(data, offset, dataStart, blockDataLength);
        break;
      default:
        break; // other/empty blocks are recorded in blocksSeen only
    }

    const advance = blockHeaderLength + blockDataLength;
    if (advance <= 0) {
      break;
    }
    offset += advance;
  }

  return map;
}

/**
 * Parse an IMAGE block, aggregating the pixel grid into per-segment stats.
 * @param {Buffer} data the full blob
 * @param {number} blockStart the block start offset
 * @param {number} blockHeaderLength the block header length
 * @param {number} dataStart the pixel data start offset
 * @param {number} dataLength the pixel data length
 * @returns {object} the image descriptor
 */
function parseImage(data, blockStart, blockHeaderLength, dataStart, dataLength, includePixels) {
  // header_len > 24 marks the segment-aware layout, which inserts a segment
  // count word before top/left/height/width.
  const g3 = blockHeaderLength > 24 ? 4 : 0;
  const segmentCount = g3 ? data.readUInt32LE(blockStart + 8) : 0;
  const top = data.readUInt32LE(blockStart + 8 + g3);
  const left = data.readUInt32LE(blockStart + 12 + g3);
  const height = data.readUInt32LE(blockStart + 16 + g3);
  const width = data.readUInt32LE(blockStart + 20 + g3);

  const stats = new Map(); // segmentId -> { pixelCount, minX, minY, maxX, maxY }
  let floorPixels = 0;
  let wallPixels = 0;

  const expected = width * height;
  const usable = Math.min(dataLength, expected);
  for (let i = 0; i < usable; i += 1) {
    const value = data[dataStart + i];
    if (value === 0) {
      continue; // outside the map
    }
    const pixelType = value & PIXEL_TYPE_MASK;
    if (pixelType === PIXEL_TYPE_OUTSIDE) {
      continue;
    }
    if (pixelType === PIXEL_TYPE_WALL) {
      wallPixels += 1;
      continue;
    }
    const segmentId = value >> 3;
    if (segmentId === 0) {
      floorPixels += 1; // floor not assigned to a segment
      continue;
    }
    const x = i % width;
    const y = Math.floor(i / width);
    let entry = stats.get(segmentId);
    if (!entry) {
      entry = { pixelCount: 0, minX: x, minY: y, maxX: x, maxY: y };
      stats.set(segmentId, entry);
    }
    entry.pixelCount += 1;
    if (x < entry.minX) entry.minX = x;
    if (y < entry.minY) entry.minY = y;
    if (x > entry.maxX) entry.maxX = x;
    if (y > entry.maxY) entry.maxY = y;
  }

  const segments = [...stats.entries()]
    .map(([id, s]) => ({
      segmentId: id,
      pixelCount: s.pixelCount,
      bbox: { minX: s.minX, minY: s.minY, maxX: s.maxX, maxY: s.maxY },
    }))
    .sort((a, b) => a.segmentId - b.segmentId);

  const image = {
    top,
    left,
    width,
    height,
    segmentCountDeclared: segmentCount,
    segmentCountInPixels: segments.length,
    floorPixels,
    wallPixels,
    segments,
  };
  if (includePixels) {
    // A detached copy of the raw segment/type bytes (row-major, width*height).
    image.pixels = Buffer.from(data.subarray(dataStart, dataStart + usable));
  }
  return image;
}

/**
 * Parse a position block (robot / charger / goto target): x, y, optional angle.
 * @param {Buffer} data the full blob
 * @param {number} dataStart the data start offset
 * @param {number} dataLength the data length
 * @returns {{x: number, y: number, angle: number|null}} the position (mm, deg)
 */
function parsePosition(data, dataStart, dataLength) {
  const x = data.readInt32LE(dataStart);
  const y = data.readInt32LE(dataStart + 4);
  const angle = dataLength >= 12 ? data.readInt32LE(dataStart + 8) : null;
  return { x, y, angle };
}

/**
 * Parse a path block (path / goto path / predicted path): a point header then
 * point_count points of (x, y) uint16, in millimetres.
 * @param {Buffer} data the full blob
 * @param {number} blockStart the block start offset
 * @param {number} dataStart the point data start offset
 * @param {number} dataLength the point data length
 * @returns {object|null} the path, or null when the header is absent
 */
function parsePath(data, blockStart, dataStart, dataLength) {
  const pointCount = data.readUInt32LE(blockStart + 8);
  const pointSize = data.readUInt32LE(blockStart + 12);
  const angle = data.readInt32LE(blockStart + 16);
  const points = [];
  for (let i = 0; i + 4 <= dataLength; i += 4) {
    points.push({ x: data.readUInt16LE(dataStart + i), y: data.readUInt16LE(dataStart + i + 2) });
  }
  return { pointCount, pointSize, angle, points };
}

/**
 * Parse an area block (no-go / no-mop / zones) into a list of 4-point polygons.
 * @param {Buffer} data the full blob
 * @param {number} blockStart the block start offset
 * @param {number} dataStart the data start offset
 * @param {number} dataLength the data length
 * @returns {Array<Array<{x: number, y: number}>>} the polygons (mm)
 */
function parseAreas(data, blockStart, dataStart, dataLength) {
  const count = data.readUInt32LE(blockStart + 8);
  const areas = [];
  // Each area is a quadrilateral: 4 points of (x, y) uint16 = 16 bytes.
  const perArea = 16;
  for (let a = 0; a < count && (a + 1) * perArea <= dataLength; a += 1) {
    const base = dataStart + a * perArea;
    const polygon = [];
    for (let p = 0; p < 4; p += 1) {
      polygon.push({ x: data.readUInt16LE(base + p * 4), y: data.readUInt16LE(base + p * 4 + 2) });
    }
    areas.push(polygon);
  }
  return areas;
}

/**
 * Parse a virtual-walls block into a list of segments (x0,y0)->(x1,y1).
 * @param {Buffer} data the full blob
 * @param {number} blockStart the block start offset
 * @param {number} dataStart the data start offset
 * @param {number} dataLength the data length
 * @returns {Array<{x0: number, y0: number, x1: number, y1: number}>} the walls (mm)
 */
function parseWalls(data, blockStart, dataStart, dataLength) {
  const count = data.readUInt32LE(blockStart + 8);
  const walls = [];
  const perWall = 8; // 2 points of (x, y) uint16
  for (let w = 0; w < count && (w + 1) * perWall <= dataLength; w += 1) {
    const base = dataStart + w * perWall;
    walls.push({
      x0: data.readUInt16LE(base),
      y0: data.readUInt16LE(base + 2),
      x1: data.readUInt16LE(base + 4),
      y1: data.readUInt16LE(base + 6),
    });
  }
  return walls;
}
