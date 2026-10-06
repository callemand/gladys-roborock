// -----------------------------------------------------------------------------
// Roborock room mapping normalization.
//
// `get_room_mapping` returns the active map's segment ids paired with the IoT
// room ids used by HomeData. The robot knows the segments, while the cloud home
// data carries their human-readable names; both sources are therefore required.
// -----------------------------------------------------------------------------

/**
 * The `[segmentId, iotRoomId]` pairs of a get_room_mapping response.
 * Roborock has been observed returning either one flat pair or a list of pairs.
 * Some transports additionally wrap the result in a single-element array.
 * @param {*} response raw get_room_mapping RPC result
 * @returns {Array<{segmentId: number, iotId: string}>} the pairs, one per segment
 */
export function roomMappingEntries(response) {
  let entries = response;

  if (
    Array.isArray(entries) &&
    entries.length === 1 &&
    Array.isArray(entries[0]) &&
    Array.isArray(entries[0][0])
  ) {
    [entries] = entries;
  }

  if (Array.isArray(entries) && entries.length >= 2 && !Array.isArray(entries[0])) {
    entries = [entries];
  }

  if (!Array.isArray(entries)) {
    return [];
  }

  const seenSegmentIds = new Set();
  const pairs = [];

  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length < 2) {
      continue;
    }

    const segmentId = Number(entry[0]);

    if (!Number.isSafeInteger(segmentId) || segmentId < 0 || seenSegmentIds.has(segmentId)) {
      continue;
    }

    seenSegmentIds.add(segmentId);
    pairs.push({ segmentId, iotId: String(entry[1]) });
  }

  return pairs;
}

/**
 * The IoT room ids of a get_room_mapping response that have no name among the
 * given rooms. HomeData.rooms is not always complete (issue #5): a non-empty
 * result means the room list must be fetched on its own.
 * @param {*} response raw get_room_mapping RPC result
 * @param {Array<object>} homeRooms the known rooms (`{ id, name }`)
 * @returns {Array<string>} the unnamed IoT room ids
 */
export function unnamedIotIds(response, homeRooms = []) {
  const names = roomNamesByIotId(homeRooms);
  return roomMappingEntries(response)
    .map((entry) => entry.iotId)
    .filter((iotId) => !names.get(iotId));
}

function roomNamesByIotId(homeRooms) {
  return new Map(
    homeRooms
      .filter((room) => room && room.id !== undefined && room.id !== null)
      .map((room) => [String(room.id), String(room.name || '').trim()]),
  );
}

/**
 * Convert a get_room_mapping response into rooms usable by Gladys.
 * @param {*} response raw get_room_mapping RPC result
 * @param {Array<object>} homeRooms HomeData.rooms (`{ id, name }`)
 * @returns {Array<{id: number, name: string}>} active-map rooms
 */
export function normalizeRoomMappings(response, homeRooms = []) {
  const names = roomNamesByIotId(homeRooms);
  return roomMappingEntries(response).map(({ segmentId, iotId }) => ({
    id: segmentId,
    name: names.get(iotId) || `Room ${segmentId}`,
  }));
}

/**
 * Attach the human-readable room name to each parsed map segment.
 *
 * The IMAGE block of the map carries segment ids as pixel values; get_room_mapping
 * (already normalized to `{ id, name }` by normalizeRoomMappings) pairs those same
 * segment ids with their IoT room name. A segment with no match is a real map
 * segment the account did not name (a hallway, an auto-split area): it is kept,
 * flagged `named: false`, rather than dropped.
 * @param {Array<object>} segments the parsed map segments (`{ segmentId, ... }`)
 * @param {Array<{id: number, name: string}>} rooms the normalized room mappings
 * @returns {Array<object>} the segments, each with `roomName` and `named`
 */
export function attachRoomNames(segments = [], rooms = []) {
  const nameBySegmentId = new Map(
    rooms
      .filter((room) => room && room.id !== undefined && room.id !== null)
      .map((room) => [Number(room.id), room.name]),
  );
  return segments.map((segment) => {
    const roomName = nameBySegmentId.get(Number(segment.segmentId));
    return { ...segment, roomName: roomName ?? null, named: roomName !== undefined };
  });
}
