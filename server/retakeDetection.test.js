import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { findRetakesFromWords } from "./retakeDetection.js";

// Builds a realistic Deepgram-like `words` array from a list of punctuated
// tokens. `pauseBefore` lets a test insert an explicit pause (in seconds)
// before a given token index, overriding the default inter-word gap.
function buildWords(tokens, { pauseBefore = {}, wordDuration = 0.3, defaultGap = 0.05 } = {}) {
  let time = 0;

  return tokens.map((text, index) => {
    const gap = pauseBefore[index] ?? defaultGap;
    time += gap;
    const start = Number(time.toFixed(3));
    time = Number((time + wordDuration).toFixed(3));
    const end = time;

    const bare = text.replace(/^[^a-z0-9']+|[^a-z0-9']+$/gi, "");

    return {
      word: bare.toLowerCase(),
      punctuated_word: text,
      start,
      end,
      confidence: 0.95,
    };
  });
}

function textOf(words, startIndex, endIndex) {
  return words
    .slice(startIndex, endIndex + 1)
    .map((word) => word.punctuated_word)
    .join(" ");
}

// Words that survive after applying every returned retake's exclusion.
function keptText(words, retakes) {
  const excluded = new Set();
  for (const retake of retakes) {
    for (let index = retake.startWordIndex; index <= retake.endWordIndex; index++) {
      excluded.add(index);
    }
  }
  return words
    .filter((_, index) => !excluded.has(index))
    .map((word) => word.punctuated_word)
    .join(" ");
}

describe("findRetakesFromWords", () => {
  test("A. immediate duplicate word is excluded", () => {
    const tokens = ["Welcome", "back,", "let's", "let's", "talk", "about", "functions."];
    const words = buildWords(tokens);

    const retakes = findRetakesFromWords(words);

    assert.equal(retakes.length, 1);
    assert.equal(retakes[0].startWordIndex, 2);
    assert.equal(retakes[0].endWordIndex, 2);
    assert.equal(keptText(words, retakes), "Welcome back, let's talk about functions.");
  });

  test("B. immediate two-word duplicate phrase is excluded", () => {
    const tokens = ["And", "how", "and", "how", "default", "parameters", "help", "us."];
    const words = buildWords(tokens);

    const retakes = findRetakesFromWords(words);

    assert.equal(retakes.length, 1);
    assert.equal(retakes[0].startWordIndex, 0);
    assert.equal(retakes[0].endWordIndex, 1);
    assert.equal(keptText(words, retakes), "and how default parameters help us.");
  });

  test("C. local repeated sentence start keeps the later complete attempt", () => {
    const tokens = [
      "Because", "in", "real", "world", "code.",
      "Because", "in", "real", "world", "code,",
      "you", "will", "often", "have", "functions.",
    ];
    const words = buildWords(tokens, { pauseBefore: { 5: 0.4 } });

    const retakes = findRetakesFromWords(words);

    assert.equal(retakes.length, 1);
    assert.equal(retakes[0].startWordIndex, 0);
    assert.equal(retakes[0].endWordIndex, 4);
    assert.equal(retakes[0].keepFromWordIndex, 5);
    assert.equal(
      keptText(words, retakes),
      "Because in real world code, you will often have functions."
    );
  });

  test("D. corrected sentence ending keeps the valid prefix", () => {
    const tokens = [
      "This", "is", "exactly", "the", "kind", "of", "problem",
      "this", "CSS", "property", "tries", "to", "solve.",
      "This", "CSS", "property", "tries", "to", "solve.",
    ];
    const words = buildWords(tokens, { pauseBefore: { 13: 0.4 } });

    const retakes = findRetakesFromWords(words);

    assert.equal(retakes.length, 1);
    assert.equal(retakes[0].startWordIndex, 7);
    assert.equal(retakes[0].endWordIndex, 12);
    assert.equal(
      keptText(words, retakes),
      "This is exactly the kind of problem This CSS property tries to solve."
    );
  });

  test("E. a chain of retake attempts keeps only the final successful take", () => {
    const tokens = [
      "So", "you", "will", "often",
      "you", "will", "often", "have", "functions",
      "you", "will", "often", "have", "functions", "where", "arguments", "are", "optional.",
    ];
    const words = buildWords(tokens, { pauseBefore: { 4: 0.4, 9: 0.4 } });

    const retakes = findRetakesFromWords(words);

    assert.equal(keptText(words, retakes), "So you will often have functions where arguments are optional.");
  });

  test("F. the same short phrase far apart is not a retake", () => {
    const tokens = [
      "A", "default", "parameter", "is", "a", "value", "assigned", "automatically",
      "when", "a", "function", "is", "called", "without", "that", "argument", "being", "provided.",
      "Now,", "let's", "see", "how", "javascript", "handles", "a", "default", "parameter", "in", "practice.",
    ];
    // Pushes the second occurrence well beyond both MAX_LOOKBACK_SECONDS and
    // MAX_LOOKBACK_WORDS - this mimics the same phrase resurfacing much later
    // in the explanation rather than an immediate restart.
    const words = buildWords(tokens, { pauseBefore: { 18: 20 } });

    const retakes = findRetakesFromWords(words);

    assert.equal(retakes.length, 0);
  });

  test("G. a shared three-word phrase across separate complete sentences is not a retake", () => {
    const tokens = [
      "Sometimes", "bugs", "appear", "in", "real", "world", "code.",
      "Let's", "look", "at", "another", "bug", "that", "also", "happens", "in", "real", "world", "code.",
    ];
    const words = buildWords(tokens);

    const retakes = findRetakesFromWords(words);

    assert.equal(retakes.length, 0);
  });

  test("H. a short incomplete later fragment does not remove the earlier complete sentence", () => {
    const tokens = [
      "Default", "parameters", "help", "us", "solve", "this", "problem.",
      "Default", "parameters", "help",
    ];
    const words = buildWords(tokens);

    const retakes = findRetakesFromWords(words);

    assert.equal(retakes.length, 0);
    assert.equal(
      keptText(words, retakes).startsWith("Default parameters help us solve this problem."),
      true
    );
  });

  test("I. an immediately re-recorded full sentence keeps the later version", () => {
    const tokens = [
      "Let's", "see", "why", "this", "can", "be", "a", "problem", "and", "how",
      "default", "parameters", "can", "help", "us.",
      "Let's", "see", "why", "this", "can", "be", "a", "problem", "and", "how",
      "default", "parameters", "help", "us.",
    ];
    const words = buildWords(tokens, { pauseBefore: { 15: 0.4 } });

    const retakes = findRetakesFromWords(words);

    assert.equal(retakes.length, 1);
    assert.equal(retakes[0].startWordIndex, 0);
    assert.equal(retakes[0].keepFromWordIndex, 15);
    assert.equal(
      keptText(words, retakes),
      textOf(words, 15, tokens.length - 1)
    );
  });

  test("J. unrelated adjacent candidates are not merged into one", () => {
    // Two independent, unrelated micro-retakes placed right next to each
    // other in the word stream.
    const tokens = [
      "So,", "let's", "let's", "start", "with", "arrays,",
      "and", "how", "and", "how", "objects", "differ", "from", "them.",
    ];
    const words = buildWords(tokens);

    const retakes = findRetakesFromWords(words);

    assert.equal(retakes.length, 2);
    assert.equal(retakes[0].startWordIndex, 1);
    assert.equal(retakes[0].endWordIndex, 1);
    assert.equal(retakes[1].startWordIndex, 6);
    assert.equal(retakes[1].endWordIndex, 7);
  });

  test("rejects malformed input instead of throwing", () => {
    assert.deepEqual(findRetakesFromWords(null), []);
    assert.deepEqual(findRetakesFromWords([]), []);
    assert.deepEqual(findRetakesFromWords([{ word: "hi", start: 0, end: 0.3 }]), []);
  });

  test("debug mode reports rejected candidates without changing the default output", () => {
    const tokens = ["Welcome", "back,", "let's", "let's", "talk", "about", "functions."];
    const words = buildWords(tokens);

    const normal = findRetakesFromWords(words);
    const debugResult = findRetakesFromWords(words, { debug: true });

    assert.ok(Array.isArray(normal));
    assert.deepEqual(debugResult.retakes, normal);
    assert.ok(Array.isArray(debugResult.rejected));
  });
});
