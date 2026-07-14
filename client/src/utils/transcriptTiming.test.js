import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  findActiveWordIndex,
  snapStartTimeToWordBoundary,
  snapEndTimeToWordBoundary,
  getWordExclusionState,
  resolveVisibleActiveWordIndex,
} from "./transcriptTiming.js";

const words = [
  { word: "hello", start: 0, end: 0.4 },
  { word: "there", start: 0.5, end: 0.9 },
  { word: "friend", start: 1.5, end: 2.0 },
];

describe("findActiveWordIndex", () => {
  test("finds the word exactly at a time", () => {
    assert.equal(findActiveWordIndex(words, 0.2), 0);
    assert.equal(findActiveWordIndex(words, 1.7), 2);
  });

  test("retains the most recently spoken word during a pause", () => {
    assert.equal(findActiveWordIndex(words, 1.2), 1);
  });

  test("returns -1 before the first word starts", () => {
    assert.equal(findActiveWordIndex(words, -1), -1);
  });

  test("returns -1 for empty input", () => {
    assert.equal(findActiveWordIndex([], 1), -1);
  });
});

describe("word boundary snapping", () => {
  test("snaps a start time inside a word to that word's start", () => {
    assert.equal(snapStartTimeToWordBoundary(0.2, words), 0);
  });

  test("snaps an end time inside a word to that word's end", () => {
    assert.equal(snapEndTimeToWordBoundary(0.2, words), 0.4);
  });

  test("preserves a time that falls in silence between words", () => {
    assert.equal(snapStartTimeToWordBoundary(1.1, words), 1.1);
    assert.equal(snapEndTimeToWordBoundary(1.1, words), 1.1);
  });
});

describe("getWordExclusionState", () => {
  test("included when there is no overlap", () => {
    assert.equal(getWordExclusionState(words[0], [{ start: 5, end: 6 }]), "included");
  });

  test("excluded when fully covered", () => {
    assert.equal(getWordExclusionState(words[0], [{ start: 0, end: 0.4 }]), "excluded");
  });

  test("partial when only part of the word is covered", () => {
    assert.equal(getWordExclusionState(words[0], [{ start: 0.2, end: 0.6 }]), "partial");
  });
});

describe("resolveVisibleActiveWordIndex", () => {
  test("returns the raw active word when it is not excluded", () => {
    assert.equal(resolveVisibleActiveWordIndex(words, 1, []), 1);
  });

  test("walks backward past an excluded active word", () => {
    const excluded = [{ start: 0.5, end: 0.9 }]; // excludes words[1]
    assert.equal(resolveVisibleActiveWordIndex(words, 1, excluded), 0);
  });

  test("returns -1 when every preceding word is excluded too", () => {
    const excluded = [{ start: 0, end: 0.9 }];
    assert.equal(resolveVisibleActiveWordIndex(words, 1, excluded), -1);
  });
});
