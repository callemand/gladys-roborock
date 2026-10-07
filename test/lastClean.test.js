import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildCleanedTodayState,
  buildLastCleanStartState,
  extractLastCleanStart,
  isCleanedToday,
} from '../src/devices/lastClean.js';

describe('Roborock last cleaning', () => {
  it('extracts the latest start timestamp from a QV 35A clean summary', () => {
    const summary = {
      clean_time: 60710,
      clean_area: 932775000,
      clean_count: 47,
      dust_collection_count: 35,
      records: [1786961500, 1786885623, 1786875671],
    };

    assert.equal(extractLastCleanStart(summary), 1786961500);
  });

  it('supports the single-element array RPC response shape', () => {
    const summary = [
      {
        records: [1786961500, 1786885623],
      },
    ];

    assert.equal(extractLastCleanStart(summary), 1786961500);
  });

  it('returns null for an empty cleaning history', () => {
    assert.equal(extractLastCleanStart({ records: [] }), null);
    assert.equal(extractLastCleanStart({}), null);
    assert.equal(extractLastCleanStart(null), null);
  });

  it('rejects invalid timestamps', () => {
    assert.equal(extractLastCleanStart({ records: ['abc'] }), null);
    assert.equal(extractLastCleanStart({ records: [0] }), null);
    assert.equal(extractLastCleanStart({ records: [-1] }), null);
    assert.equal(extractLastCleanStart({ records: [999999999999] }), null);
  });

  it('builds a Gladys numeric state', () => {
    const ids = {
      feature(code) {
        return `ext:test:vacuum:robot:${code}`;
      },
    };

    assert.deepEqual(buildLastCleanStartState(ids, 1786961500), {
      device_feature_external_id: 'ext:test:vacuum:robot:last-clean-start',
      state: 1786961500,
    });
  });

  it('does not publish an invalid state', () => {
    const ids = {
      feature(code) {
        return code;
      },
    };

    assert.equal(buildLastCleanStartState(ids, null), null);
  });

  it('tells whether the vacuum ran today', () => {
    const now = new Date(2026, 9, 6, 20, 0, 0).getTime(); // 6 Oct 2026, local
    const earlierToday = Math.floor(new Date(2026, 9, 6, 8, 15, 0).getTime() / 1000);
    const yesterday = Math.floor(new Date(2026, 9, 5, 23, 59, 0).getTime() / 1000);

    assert.equal(isCleanedToday(earlierToday, now), true);
    assert.equal(isCleanedToday(yesterday, now), false);
    assert.equal(isCleanedToday(null, now), false);
    assert.equal(isCleanedToday(0, now), false);
  });

  it('builds a 0/1 "cleaned today" state usable as a scene condition', () => {
    const ids = {
      feature(code) {
        return `ext:test:vacuum:robot:${code}`;
      },
    };
    const now = new Date(2026, 9, 6, 20, 0, 0).getTime();
    const earlierToday = Math.floor(new Date(2026, 9, 6, 8, 15, 0).getTime() / 1000);
    const yesterday = Math.floor(new Date(2026, 9, 5, 12, 0, 0).getTime() / 1000);

    assert.deepEqual(buildCleanedTodayState(ids, earlierToday, now), {
      device_feature_external_id: 'ext:test:vacuum:robot:cleaned-today',
      state: 1,
    });
    assert.equal(buildCleanedTodayState(ids, yesterday, now).state, 0);
    // Always resolved, even with no history, so the "no" branch works too.
    assert.equal(buildCleanedTodayState(ids, null, now).state, 0);
  });
});
