// -----------------------------------------------------------------------------
// RRMap -> PNG renderer (no native dependency), "polished" look.
//
// The RRMap image is a low-resolution grid (50 mm per cell), so a nearest-
// neighbour upscale looks blocky. This renderer instead:
//   1. builds a small source-resolution layer (rooms + dilated walls),
//   2. BILINEAR-upscales it so room edges and walls come out smooth,
//   3. overlays, crisply, the cleaning path, no-go areas, virtual walls, the
//      dock and robot icons, and the room name labels (embedded 8x8 font).
//
// Everything is encoded by hand with node:zlib (RGBA PNG), so it runs anywhere,
// amd64 and arm64, with nothing to compile.
// -----------------------------------------------------------------------------

import zlib from 'node:zlib';

import { crc32 } from './crypto.js';
import { FONT8X8 } from './font8x8.js';

// Vivid room palette, close to the Roborock app (cycled over the segment ids).
const SEGMENT_PALETTE = [
  [0, 196, 180], // teal
  [240, 122, 92], // coral
  [86, 150, 230], // blue
  [242, 190, 70], // gold
  [38, 200, 200], // cyan
  [170, 130, 222], // purple
  [120, 200, 110], // green
  [240, 150, 70], // orange
  [232, 110, 150], // pink
  [120, 180, 214], // light blue
];

const COLOR = {
  background: [18, 20, 26, 255], // near-black, like the app
  wall: [96, 103, 116, 255], // subtle grey trace (visible on dark and on colours)
  floorUnsegmented: [70, 77, 88, 255],
  noGo: [235, 70, 70, 255],
  virtualWall: [245, 214, 40, 255], // yellow
  path: [255, 255, 255, 120], // faint white
  dock: [38, 198, 150, 255], // green charging badge
  robot: [40, 90, 150, 255], // navy robot badge
  white: [255, 255, 255, 255],
  labelText: [255, 255, 255, 255],
  labelBg: [12, 14, 20, 190],
};

const PIXEL_TYPE_MASK = 0x07;
const PIXEL_TYPE_WALL = 1;

function segmentColor(segmentId) {
  const [r, g, b] = SEGMENT_PALETTE[(segmentId - 1) % SEGMENT_PALETTE.length];
  return [r, g, b, 255];
}

// Uppercase + strip the accents our room names use, so the 8x8 ASCII font covers them.
const ACCENTS = {
  À: 'A',
  Â: 'A',
  Ä: 'A',
  É: 'E',
  È: 'E',
  Ê: 'E',
  Ë: 'E',
  Î: 'I',
  Ï: 'I',
  Ô: 'O',
  Ö: 'O',
  Ù: 'U',
  Û: 'U',
  Ü: 'U',
  Ç: 'C',
};
function asciiLabel(text) {
  return String(text || '')
    .toUpperCase()
    .replace(/[ÀÂÄÉÈÊËÎÏÔÖÙÛÜÇ]/g, (c) => ACCENTS[c] || c)
    .replace(/[^\x20-\x7e]/g, '');
}

/**
 * Render a parsed map to a PNG buffer.
 * @param {object} map a map from parseRRMap(data, { includePixels: true }), with
 *   room names attached (segment.roomName)
 * @param {object} [options] rendering options
 * @param {number} [options.scale] output pixels per map cell
 * @param {number} [options.margin] cells of padding around the content
 * @param {boolean} [options.flipY] flip vertically (world up = image up)
 * @param {boolean} [options.drawPath] overlay the cleaning path
 * @param {boolean} [options.drawLabels] overlay the room names
 * @returns {Buffer} the PNG bytes
 */
export function renderMapPng(map, options = {}) {
  const {
    scale: scaleOption = 4,
    targetLongestPx = null,
    margin = 3,
    flipY = true,
    drawPath = true,
    drawLabels = true,
  } = options;
  const img = map && map.image;
  if (!img || !img.pixels) {
    throw new Error('renderMapPng needs parseRRMap(data, { includePixels: true })');
  }
  const { width, height, left, top, pixels } = img;

  const cellAt = (dx, dy) => pixels[(flipY ? height - 1 - dy : dy) * width + dx];

  // Only NAMED rooms are drawn, like the app: unnamed/auto segments, unsegmented
  // floor and the far exploration noise stay transparent, so the widget shows a
  // clean set of rooms on whatever background (light or dark theme) is behind it.
  const namedIds = new Set(map.segments.filter((s) => s.named).map((s) => Number(s.segmentId)));
  const isRoom = (dx, dy) => {
    if (dx < 0 || dy < 0 || dx >= width || dy >= height) return false;
    const v = cellAt(dx, dy);
    if (v === 0 || (v & PIXEL_TYPE_MASK) === PIXEL_TYPE_WALL) return false;
    return namedIds.has(v >> 3);
  };
  const isWallNearRoom = (dx, dy) => {
    const v = cellAt(dx, dy);
    if ((v & PIXEL_TYPE_MASK) !== PIXEL_TYPE_WALL) return false;
    for (let oy = -1; oy <= 1; oy += 1) {
      for (let ox = -1; ox <= 1; ox += 1) {
        if (isRoom(dx + ox, dy + oy)) return true;
      }
    }
    return false;
  };

  // Crop to the drawn rooms (+ margin).
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let dy = 0; dy < height; dy += 1) {
    for (let dx = 0; dx < width; dx += 1) {
      if (isRoom(dx, dy) || isWallNearRoom(dx, dy)) {
        if (dx < minX) minX = dx;
        if (dx > maxX) maxX = dx;
        if (dy < minY) minY = dy;
        if (dy > maxY) maxY = dy;
      }
    }
  }
  if (maxX < 0) {
    minX = 0;
    minY = 0;
    maxX = width - 1;
    maxY = height - 1;
  }
  minX = Math.max(0, minX - margin);
  minY = Math.max(0, minY - margin);
  maxX = Math.min(width - 1, maxX + margin);
  maxY = Math.min(height - 1, maxY + margin);
  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;

  // Derive the scale from the (room-based, stable) crop so the same home always
  // renders at the same output dimensions across refreshes: the frame no longer
  // jumps/rescales when only the robot or the path move. `scale` (explicit px per
  // cell) stays the fallback when no target size is requested.
  const scale = targetLongestPx
    ? Math.max(1, Math.min(6, Math.round(targetLongestPx / Math.max(cropW, cropH))))
    : scaleOption;

  // --- 1. source-resolution colour layer (named rooms + their walls) ----------
  // Transparent everywhere else: walls stay one cell wide (the bilinear upscale
  // turns them into thin, soft outlines rather than bold strokes).
  const srcColor = Buffer.alloc(cropW * cropH * 4);
  for (let y = 0; y < cropH; y += 1) {
    for (let x = 0; x < cropW; x += 1) {
      const gx = minX + x;
      const gy = minY + y;
      const i = y * cropW + x;
      let c = null;
      if (isRoom(gx, gy)) {
        c = segmentColor(cellAt(gx, gy) >> 3);
      } else if (isWallNearRoom(gx, gy)) {
        c = COLOR.wall;
      }
      if (c) {
        srcColor[i * 4] = c[0];
        srcColor[i * 4 + 1] = c[1];
        srcColor[i * 4 + 2] = c[2];
        srcColor[i * 4 + 3] = 255;
      }
      // else: left as 0,0,0,0 (transparent)
    }
  }

  // --- 2. bilinear upscale ----------------------------------------------------
  const outW = cropW * scale;
  const outH = cropH * scale;
  const rgba = bilinearUpscale(srcColor, cropW, cropH, outW, outH);

  // world (mm) -> output pixel (cell-centre aligned, matching the bilinear grid)
  const toOut = (xMm, yMm) => {
    const gx = xMm / map.pixelSizeMm - left;
    const gyRaw = yMm / map.pixelSizeMm - top;
    const gy = flipY ? height - 1 - gyRaw : gyRaw;
    return { x: (gx - minX + 0.5) * scale, y: (gy - minY + 0.5) * scale };
  };
  const thickness = Math.max(1, Math.round(scale / 2));

  // --- 3. overlays ------------------------------------------------------------
  if (drawPath && map.path && map.path.points.length > 1) {
    for (let i = 1; i < map.path.points.length; i += 1) {
      const a = toOut(map.path.points[i - 1].x, map.path.points[i - 1].y);
      const b = toOut(map.path.points[i].x, map.path.points[i].y);
      drawLine(rgba, outW, outH, a, b, COLOR.path, thickness);
    }
  }

  for (const area of map.noGoAreas) {
    const pts = area.map((p) => toOut(p.x, p.y));
    drawPolygon(rgba, outW, outH, pts, COLOR.noGo, Math.max(2, thickness));
    // "no entry" markers at the corners, like the app.
    for (const pt of pts) {
      drawDisc(rgba, outW, outH, pt.x, pt.y, Math.max(3, Math.round(scale * 1.1)), COLOR.white);
      drawDisc(rgba, outW, outH, pt.x, pt.y, Math.max(2, Math.round(scale * 0.8)), COLOR.noGo);
    }
  }
  for (const wall of map.virtualWalls) {
    drawLine(
      rgba,
      outW,
      outH,
      toOut(wall.x0, wall.y0),
      toOut(wall.x1, wall.y1),
      COLOR.virtualWall,
      Math.max(2, thickness + 1),
    );
  }

  if (drawLabels) {
    for (const seg of map.segments) {
      if (!seg.roomName) continue;
      const cx = (seg.bbox.minX + seg.bbox.maxX) / 2;
      const cyStored = (seg.bbox.minY + seg.bbox.maxY) / 2;
      const dispX = cx;
      const dispY = flipY ? height - 1 - cyStored : cyStored;
      const ox = (dispX - minX + 0.5) * scale;
      const oy = (dispY - minY + 0.5) * scale;
      const roomWidthPx = (seg.bbox.maxX - seg.bbox.minX + 1) * scale;
      drawLabel(rgba, outW, outH, asciiLabel(seg.roomName), ox, oy, roomWidthPx, scale);
    }
  }

  const r = Math.max(4, Math.round(scale * 1.7));
  if (map.charger) {
    const p = toOut(map.charger.x, map.charger.y);
    drawDockIcon(rgba, outW, outH, p.x, p.y, r);
  }
  if (map.robot) {
    const p = toOut(map.robot.x, map.robot.y);
    drawRobotIcon(rgba, outW, outH, p.x, p.y, r, map.robot.angle);
  }

  return encodePng(outW, outH, rgba);
}

/**
 * Render a map to a RAW base64 PNG (no `data:` prefix) for a dashboard widget,
 * kept under the core's decoded-size budget by lowering the scale.
 * @param {object} map a parsed map with pixels and room names
 * @param {object} [options] options
 * @param {number} [options.maxBytes] maximum decoded PNG size (core limit 300 KB)
 * @param {number} [options.startScale] the scale to try first
 * @returns {string} the raw base64 PNG
 */
export function renderMapPngBase64(map, options = {}) {
  const { maxBytes = 300 * 1024, targetLongestPx = 900 } = options;
  let target = targetLongestPx;
  let png = renderMapPng(map, { ...options, targetLongestPx: target });
  // Deterministic byte guard: shrink the target in fixed steps if the fixed-size
  // render is over budget. It depends only on the (stable) content, so it does
  // not flip between two sizes from one refresh to the next.
  while (png.length > maxBytes && target > 320) {
    target = Math.round(target * 0.82);
    png = renderMapPng(map, { ...options, targetLongestPx: target });
  }
  return png.toString('base64');
}

// --- image helpers -----------------------------------------------------------
function bilinearUpscale(src, sw, sh, dw, dh) {
  const dst = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y += 1) {
    const fy = ((y + 0.5) * sh) / dh - 0.5;
    let y0 = Math.floor(fy);
    const wy = fy - y0;
    let y1 = y0 + 1;
    y0 = Math.min(Math.max(y0, 0), sh - 1);
    y1 = Math.min(Math.max(y1, 0), sh - 1);
    for (let x = 0; x < dw; x += 1) {
      const fx = ((x + 0.5) * sw) / dw - 0.5;
      let x0 = Math.floor(fx);
      const wx = fx - x0;
      let x1 = x0 + 1;
      x0 = Math.min(Math.max(x0, 0), sw - 1);
      x1 = Math.min(Math.max(x1, 0), sw - 1);
      const o00 = (y0 * sw + x0) * 4;
      const o10 = (y0 * sw + x1) * 4;
      const o01 = (y1 * sw + x0) * 4;
      const o11 = (y1 * sw + x1) * 4;
      const o = (y * dw + x) * 4;
      // Weights of the four samples.
      const w00 = (1 - wx) * (1 - wy);
      const w10 = wx * (1 - wy);
      const w01 = (1 - wx) * wy;
      const w11 = wx * wy;
      // Premultiplied-alpha bilinear: interpolate colour weighted by alpha, so a
      // transparent neighbour never bleeds a dark/coloured halo into the edge.
      const a00 = src[o00 + 3];
      const a10 = src[o10 + 3];
      const a01 = src[o01 + 3];
      const a11 = src[o11 + 3];
      const outA = w00 * a00 + w10 * a10 + w01 * a01 + w11 * a11;
      dst[o + 3] = Math.round(outA);
      for (let c = 0; c < 3; c += 1) {
        const pc =
          w00 * src[o00 + c] * a00 +
          w10 * src[o10 + c] * a10 +
          w01 * src[o01 + c] * a01 +
          w11 * src[o11 + c] * a11;
        dst[o + c] = outA > 0 ? Math.round(pc / outA) : 0;
      }
    }
  }
  return dst;
}

function putPixel(rgba, w, h, x, y, color) {
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const o = (y * w + x) * 4;
  const alpha = color[3] / 255;
  if (alpha >= 1) {
    rgba[o] = color[0];
    rgba[o + 1] = color[1];
    rgba[o + 2] = color[2];
    rgba[o + 3] = 255;
    return;
  }
  rgba[o] = Math.round(color[0] * alpha + rgba[o] * (1 - alpha));
  rgba[o + 1] = Math.round(color[1] * alpha + rgba[o + 1] * (1 - alpha));
  rgba[o + 2] = Math.round(color[2] * alpha + rgba[o + 2] * (1 - alpha));
  rgba[o + 3] = 255;
}

function fillRect(rgba, w, h, x, y, rw, rh, color) {
  for (let dy = 0; dy < rh; dy += 1) {
    for (let dx = 0; dx < rw; dx += 1) {
      putPixel(rgba, w, h, x + dx, y + dy, color);
    }
  }
}

function drawDisc(rgba, w, h, cx, cy, r, color) {
  const x0 = Math.round(cx);
  const y0 = Math.round(cy);
  for (let dy = -r; dy <= r; dy += 1) {
    for (let dx = -r; dx <= r; dx += 1) {
      if (dx * dx + dy * dy <= r * r) putPixel(rgba, w, h, x0 + dx, y0 + dy, color);
    }
  }
}

function drawLine(rgba, w, h, a, b, color, thickness = 1) {
  let x0 = Math.round(a.x);
  let y0 = Math.round(a.y);
  const x1 = Math.round(b.x);
  const y1 = Math.round(b.y);
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  const t = Math.max(0, thickness - 1);
  for (;;) {
    for (let oy = -t; oy <= t; oy += 1) {
      for (let ox = -t; ox <= t; ox += 1) {
        putPixel(rgba, w, h, x0 + ox, y0 + oy, color);
      }
    }
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x0 += sx;
    }
    if (e2 < dx) {
      err += dx;
      y0 += sy;
    }
  }
}

function drawPolygon(rgba, w, h, points, color, thickness) {
  for (let i = 0; i < points.length; i += 1) {
    drawLine(rgba, w, h, points[i], points[(i + 1) % points.length], color, thickness);
  }
}

function drawDockIcon(rgba, w, h, cx, cy, r) {
  // white rounded base + blue square, so it reads as a charging dock.
  fillRect(
    rgba,
    w,
    h,
    Math.round(cx - r - 1),
    Math.round(cy - r - 1),
    2 * r + 2,
    2 * r + 2,
    COLOR.white,
  );
  fillRect(
    rgba,
    w,
    h,
    Math.round(cx - r + 1),
    Math.round(cy - r + 1),
    2 * r - 2,
    2 * r - 2,
    COLOR.dock,
  );
}

function drawRobotIcon(rgba, w, h, cx, cy, r, angleDeg) {
  drawDisc(rgba, w, h, cx, cy, r + 1, COLOR.white); // white ring
  drawDisc(rgba, w, h, cx, cy, r, COLOR.robot);
  // heading notch
  const a = ((Number(angleDeg) || 0) * Math.PI) / 180;
  const hx = cx + Math.cos(a) * r;
  const hy = cy + Math.sin(a) * r;
  drawDisc(rgba, w, h, hx, hy, Math.max(1, Math.round(r / 3)), COLOR.white);
}

// --- text (embedded 8x8 font) ------------------------------------------------
function drawLabel(rgba, w, h, text, cx, cy, roomWidthPx, scale) {
  if (!text) return;
  // pick a pixel size that fits the room width, within [1, scale]
  let px = Math.max(1, Math.min(scale, Math.round(scale / 2)));
  const glyphW = 6; // 5px glyph body + 1px spacing
  while (px > 1 && text.length * glyphW * px > roomWidthPx * 0.95) px -= 1;
  const textW = text.length * glyphW * px;
  const textH = 7 * px;
  if (textW > roomWidthPx * 1.05) return; // still too wide: skip rather than overflow
  const startX = Math.round(cx - textW / 2);
  const startY = Math.round(cy - textH / 2);
  // readability pill
  fillRect(rgba, w, h, startX - 2 * px, startY - px, textW + 4 * px, textH + 2 * px, COLOR.labelBg);
  for (let ci = 0; ci < text.length; ci += 1) {
    const glyph = FONT8X8[text.charCodeAt(ci)];
    if (!glyph) continue;
    const gx = startX + ci * glyphW * px;
    for (let row = 0; row < 7; row += 1) {
      const bits = glyph[row];
      for (let col = 0; col < 6; col += 1) {
        if (bits & (1 << col)) {
          fillRect(rgba, w, h, gx + col * px, startY + row * px, px, px, COLOR.labelText);
        }
      }
    }
  }
}

// --- minimal PNG encoder (RGBA, filter 0) ------------------------------------
function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

/**
 * Encode an RGBA buffer as a PNG.
 * @param {number} width the image width
 * @param {number} height the image height
 * @param {Buffer} rgba width*height*4 bytes
 * @returns {Buffer} the PNG bytes
 */
export function encodePng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None)
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw);

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
