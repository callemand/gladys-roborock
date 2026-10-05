import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildLastCleanStartState, extractLastCleanStart } from '../src/devices/lastClean.js';

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
});
