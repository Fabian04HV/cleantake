import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeExcludedSegments,
  excludeTimeRange,
  includeTimeRange,
  removeSegmentsByOrigin,
  getTimeRangeState,
} from "./audioSegments.js";

describe("normalizeExcludedSegments", () => {
  test("clamps to duration and drops invalid/zero-length ranges", () => {
    const result = normalizeExcludedSegments(
      [
        { start: -5, end: 2 },
        { start: 8, end: 8 },
        { start: 20, end: 100 },
        { start: NaN, end: 5 },
      ],
      30
    );

    assert.deepEqual(
      result.map(({ start, end }) => ({ start, end })),
      [
        { start: 0, end: 2 },
        { start: 20, end: 30 },
      ]
    );
  });

  test("merges overlapping and directly adjacent ranges", () => {
    const result = normalizeExcludedSegments(
      [
        { start: 10, end: 15 },
        { start: 14.998, end: 20 },
        { start: 25, end: 30 },
      ],
      60
    );

    assert.equal(result.length, 2);
    assert.equal(result[0].start, 10);
    assert.equal(result[0].end, 20);
    assert.equal(result[1].start, 25);
    assert.equal(result[1].end, 30);
  });

  test("does not mutate the input array", () => {
    const input = [{ start: 1, end: 2 }];
    normalizeExcludedSegments(input, 10);
    assert.deepEqual(input, [{ start: 1, end: 2 }]);
  });

  test("generates stable ids from start/end", () => {
    const result = normalizeExcludedSegments([{ start: 4.25, end: 6.81 }], 30);
    assert.equal(result[0].id, "excluded-4.250-6.810");
  });
});

describe("excludeTimeRange", () => {
  test("adds and merges a new excluded range", () => {
    const current = normalizeExcludedSegments([{ start: 0, end: 2 }], 30);
    const result = excludeTimeRange(current, { start: 1.5, end: 4, origin: "manual" }, 30);

    assert.equal(result.length, 1);
    assert.equal(result[0].start, 0);
    assert.equal(result[0].end, 4);
  });
});

describe("includeTimeRange", () => {
  test("restores a range fully inside one excluded segment by splitting it", () => {
    const current = normalizeExcludedSegments([{ start: 10, end: 20 }], 30);
    const result = includeTimeRange(current, { start: 13, end: 16 }, 30);

    assert.equal(result.length, 2);
    assert.equal(result[0].start, 10);
    assert.equal(result[0].end, 13);
    assert.equal(result[1].start, 16);
    assert.equal(result[1].end, 20);
  });

  test("trims the beginning of an excluded segment", () => {
    const current = normalizeExcludedSegments([{ start: 10, end: 20 }], 30);
    const result = includeTimeRange(current, { start: 5, end: 12 }, 30);

    assert.equal(result.length, 1);
    assert.equal(result[0].start, 12);
    assert.equal(result[0].end, 20);
  });

  test("trims the end of an excluded segment", () => {
    const current = normalizeExcludedSegments([{ start: 10, end: 20 }], 30);
    const result = includeTimeRange(current, { start: 18, end: 25 }, 30);

    assert.equal(result.length, 1);
    assert.equal(result[0].start, 10);
    assert.equal(result[0].end, 18);
  });

  test("deletes a complete excluded segment", () => {
    const current = normalizeExcludedSegments([{ start: 10, end: 20 }], 30);
    const result = includeTimeRange(current, { start: 9, end: 21 }, 30);

    assert.equal(result.length, 0);
  });

  test("restores across several excluded segments at once", () => {
    const current = normalizeExcludedSegments(
      [
        { start: 2, end: 5 },
        { start: 8, end: 12 },
        { start: 15, end: 18 },
      ],
      30
    );
    const result = includeTimeRange(current, { start: 4, end: 16 }, 30);

    assert.equal(result.length, 2);
    assert.equal(result[0].start, 2);
    assert.equal(result[0].end, 4);
    assert.equal(result[1].start, 16);
    assert.equal(result[1].end, 18);
  });

  test("is a no-op when the range does not overlap anything", () => {
    const current = normalizeExcludedSegments([{ start: 10, end: 20 }], 30);
    const result = includeTimeRange(current, { start: 0, end: 5 }, 30);

    assert.equal(result.length, 1);
    assert.equal(result[0].start, 10);
    assert.equal(result[0].end, 20);
  });
});

describe("removeSegmentsByOrigin", () => {
  test("keeps manual edits while dropping stale automatic ones", () => {
    const current = [
      { id: "a", start: 1, end: 2, origin: "retake" },
      { id: "b", start: 5, end: 6, origin: "transcript" },
      { id: "c", start: 8, end: 9, origin: "waveform" },
    ];

    const result = removeSegmentsByOrigin(current, "retake");

    assert.equal(result.length, 2);
    assert.ok(result.every((segment) => segment.origin !== "retake"));
  });
});

describe("getTimeRangeState", () => {
  const excluded = normalizeExcludedSegments([{ start: 10, end: 20 }], 30);

  test("included: no overlap with excluded audio", () => {
    assert.equal(getTimeRangeState(0, 5, excluded), "included");
  });

  test("excluded: selection fully covered", () => {
    assert.equal(getTimeRangeState(11, 19, excluded), "excluded");
  });

  test("mixed: selection partially covered", () => {
    assert.equal(getTimeRangeState(5, 15, excluded), "mixed");
  });
});
