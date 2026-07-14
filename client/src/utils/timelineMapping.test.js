import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  sourceTimeToEditedTime,
  getEditedDuration,
  findExcludedSegmentAtTime,
  findNextPlayableTime,
  formatTime,
} from "./timelineMapping.js";

const excluded = [
  { start: 5, end: 8 },
  { start: 12, end: 14 },
];

describe("sourceTimeToEditedTime", () => {
  test("subtracts excluded duration before the current position", () => {
    assert.equal(sourceTimeToEditedTime(16, excluded), 11);
  });

  test("maps a time inside an excluded segment to that segment's start", () => {
    // 6 is inside 5-8; edited time should equal the edited time at 5.
    assert.equal(sourceTimeToEditedTime(6, excluded), sourceTimeToEditedTime(5, excluded));
  });

  test("returns the raw time when nothing is excluded yet", () => {
    assert.equal(sourceTimeToEditedTime(3, excluded), 3);
  });
});

describe("getEditedDuration", () => {
  test("subtracts total excluded duration from the source duration", () => {
    assert.equal(getEditedDuration(30, excluded), 30 - 3 - 2);
  });

  test("never goes negative", () => {
    assert.equal(getEditedDuration(4, [{ start: 0, end: 10 }]), 0);
  });
});

describe("findExcludedSegmentAtTime", () => {
  test("finds the segment containing a time", () => {
    assert.deepEqual(findExcludedSegmentAtTime(6, excluded), excluded[0]);
  });

  test("returns null for a playable time", () => {
    assert.equal(findExcludedSegmentAtTime(10, excluded), null);
  });
});

describe("findNextPlayableTime", () => {
  test("resolves forward to the end of the containing segment", () => {
    assert.equal(findNextPlayableTime(6, excluded, 30), 8);
  });

  test("resolves through adjacent/chained excluded segments", () => {
    const chained = [
      { start: 5, end: 8 },
      { start: 8, end: 10 },
    ];
    assert.equal(findNextPlayableTime(6, chained, 30), 10);
  });

  test("returns null when nothing playable remains", () => {
    assert.equal(findNextPlayableTime(9, [{ start: 5, end: 30 }], 30), null);
  });

  test("passes through a time that is already playable", () => {
    assert.equal(findNextPlayableTime(2, excluded, 30), 2);
  });
});

describe("formatTime", () => {
  test("formats seconds under a minute", () => {
    assert.equal(formatTime(0), "00:00");
  });

  test("formats minutes and seconds", () => {
    assert.equal(formatTime(84), "01:24");
  });

  test("formats hours, minutes and seconds", () => {
    assert.equal(formatTime(3738), "01:02:18");
  });
});
