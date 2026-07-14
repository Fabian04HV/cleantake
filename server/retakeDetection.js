// Deterministic, local-window retake detection.
//
// The previous implementation searched the *entire* transcript for repeated
// 3-word n-grams and assumed every repetition anywhere was a retake. That
// produced heavy false positives on completely normal teaching language
// ("a default parameter", "in real world code", ...) that simply gets
// reused minutes apart.
//
// This version is intentionally conservative: a candidate can only exist
// when a matching phrase re-occurs *close by* (a handful of seconds/words),
// which is how real retakes behave - the speaker stops and restarts almost
// immediately. Everything else (confidence scoring, dedup, chaining) exists
// to further weed out coincidental matches within that already-small
// candidate set. False negatives are preferred over false positives; the
// user can always remove more manually.

// ---------------------------------------------------------------------------
// Tunable constants
// ---------------------------------------------------------------------------

const NORMAL_MIN_MATCH_LENGTH = 4;
const MAX_LOOKBACK_SECONDS = 12;
const MAX_LOOKBACK_WORDS = 45;

const MICRO_MAX_GAP_SECONDS = 1.5;
const MICRO_MAX_DISTANCE_WORDS = 5;
const MICRO_MAX_ANCHOR_LENGTH = 3;

// Shorter anchors are far more likely to recur by pure chance (especially
// single common words like "a" or "is"), so they need noticeably tighter
// proximity to count as evidence of a stutter/false start.
const MICRO_DISTANCE_LIMITS_BY_ANCHOR_LENGTH = {
  1: { maxWords: 2, maxSeconds: 0.6 },
  2: { maxWords: 3, maxSeconds: 1.0 },
  3: { maxWords: MICRO_MAX_DISTANCE_WORDS, maxSeconds: MICRO_MAX_GAP_SECONDS },
};

function microDistanceLimitsFor(anchorLength) {
  return (
    MICRO_DISTANCE_LIMITS_BY_ANCHOR_LENGTH[anchorLength] ?? {
      maxWords: MICRO_MAX_DISTANCE_WORDS,
      maxSeconds: MICRO_MAX_GAP_SECONDS,
    }
  );
}

const ATTEMPT_BOUNDARY_PAUSE_SECONDS = 0.8;
// A restart that happens shortly after a "complete" sentence can still be a
// retake (Deepgram sometimes punctuates an aborted take as if it were a full
// sentence); only ignore the completed-sentence signal when the restart is
// this close.
const ABORT_AFTER_COMPLETE_SENTENCE_WINDOW_SECONDS = ATTEMPT_BOUNDARY_PAUSE_SECONDS * 2;
// How soon after a candidate's "kept" take another restart may not be
// considered a genuine restart of *that specific* take.
const FOLLOW_UP_RESTART_WINDOW_WORDS = 8;

const MIN_CONFIDENCE = 0.72;
// Micro-retakes lean almost entirely on immediate adjacency as evidence, so
// they use their own, more lenient acceptance bar.
const MICRO_MIN_CONFIDENCE = 0.6;

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "to", "of", "in", "on", "for", "with",
  "is", "are", "was", "were", "be", "been", "this", "that", "it", "you", "we",
  "they", "can", "will", "would", "should", "as",
]);

const SENTENCE_END_PATTERN = /[.!?]["')\]]*$/;

// ---------------------------------------------------------------------------
// Token / word helpers
// ---------------------------------------------------------------------------

// `word.word` is Deepgram's raw, unpunctuated token and is preferred here so
// punctuation never causes two otherwise-identical words to mismatch.
function normalizeToken(word) {
  const text = word?.word ?? word?.punctuated_word ?? "";
  return text.toLowerCase().replace(/[^a-z0-9']/g, "");
}

function countContentWords(tokens) {
  return tokens.filter((token) => token !== "" && !STOP_WORDS.has(token)).length;
}

function endsSentence(word) {
  const text = word?.punctuated_word ?? word?.word ?? "";
  return SENTENCE_END_PATTERN.test(text.trim());
}

function pauseAfter(words, index) {
  const current = words[index];
  const next = words[index + 1];
  if (!current || !next) return Infinity; // end of transcript is a hard boundary
  const gap = next.start - current.end;
  return Number.isFinite(gap) ? gap : 0;
}

function pauseBefore(words, index) {
  if (index <= 0) return Infinity;
  return pauseAfter(words, index - 1);
}

function containsSentenceEnd(words, startIndex, endIndex) {
  for (let index = startIndex; index <= endIndex; index++) {
    if (endsSentence(words[index])) return true;
  }
  return false;
}

// Walks forward from startIndex until sentence punctuation, a meaningful
// pause, or the end of the transcript - i.e. the end of "this attempt".
function getAttemptBoundaryEnd(words, startIndex, limitIndex) {
  for (let index = startIndex; index <= limitIndex; index++) {
    if (endsSentence(words[index])) return index;
    if (pauseAfter(words, index) >= ATTEMPT_BOUNDARY_PAUSE_SECONDS) return index;
  }
  return limitIndex;
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

// Extends a match forward for as long as both token streams keep agreeing,
// without ever letting the earlier occurrence run into the later one.
function extendMatch(tokens, previousStart, currentStart, initialLength) {
  let length = initialLength;
  while (
    previousStart + length < currentStart &&
    currentStart + length < tokens.length &&
    tokens[currentStart + length] !== "" &&
    tokens[previousStart + length] === tokens[currentStart + length]
  ) {
    length++;
  }
  return length;
}

// ---------------------------------------------------------------------------
// Candidate generation
// ---------------------------------------------------------------------------

// Immediate stutters/false starts: "Let's let's talk", "the the", "and how
// and how default parameters...". These need almost no context - extreme
// closeness *is* the evidence - so they get their own, much stricter search.
function findMicroRetakeCandidates(words, tokens) {
  const candidates = [];

  for (let i = 0; i < tokens.length; i++) {
    for (let anchorLength = MICRO_MAX_ANCHOR_LENGTH; anchorLength >= 1; anchorLength--) {
      if (i + anchorLength * 2 > tokens.length) continue;

      const anchorTokens = tokens.slice(i, i + anchorLength);
      if (anchorTokens.some((token) => token === "")) continue;

      const { maxWords: maxDistanceWords, maxSeconds: maxGapSeconds } =
        microDistanceLimitsFor(anchorLength);

      const maxCurrentStart = Math.min(
        tokens.length - anchorLength,
        i + anchorLength + maxDistanceWords
      );

      let matchStart = null;
      for (let j = i + anchorLength; j <= maxCurrentStart; j++) {
        if (anchorTokens.every((token, offset) => tokens[j + offset] === token)) {
          matchStart = j;
          break; // nearest occurrence wins
        }
      }

      if (matchStart === null) continue;

      const previousWord = words[i];
      const currentWord = words[matchStart];
      const timeDistance = currentWord.start - previousWord.start;

      if (
        !Number.isFinite(timeDistance) ||
        timeDistance < 0 ||
        timeDistance > maxGapSeconds
      ) {
        continue;
      }

      const matchedLength = extendMatch(tokens, i, matchStart, anchorLength);

      candidates.push({
        type: "micro-retake",
        previousStart: i,
        currentStart: matchStart,
        anchorLength,
        matchedLength,
      });

      break; // longer anchors are checked first; don't add a redundant shorter one
    }
  }

  return candidates;
}

// For every possible restart position, search *backward* within a small
// local window only - never across the whole transcript.
function findLocalPhraseRetakeCandidates(words, tokens) {
  const candidates = [];
  const anchorLength = NORMAL_MIN_MATCH_LENGTH;

  for (let currentStart = anchorLength; currentStart <= tokens.length - anchorLength; currentStart++) {
    const anchorTokens = tokens.slice(currentStart, currentStart + anchorLength);
    if (anchorTokens.some((token) => token === "")) continue;

    const minPreviousStart = Math.max(0, currentStart - MAX_LOOKBACK_WORDS);
    let previousStart = null;

    for (let candidate = currentStart - anchorLength; candidate >= minPreviousStart; candidate--) {
      if (anchorTokens.every((token, offset) => tokens[candidate + offset] === token)) {
        previousStart = candidate; // nearest previous occurrence wins
        break;
      }
    }

    if (previousStart === null) continue;

    const previousWord = words[previousStart];
    const currentWord = words[currentStart];
    const timeDistance = currentWord.start - previousWord.start;

    if (
      !Number.isFinite(timeDistance) ||
      timeDistance < 0 ||
      timeDistance > MAX_LOOKBACK_SECONDS
    ) {
      continue;
    }

    const matchedLength = extendMatch(tokens, previousStart, currentStart, anchorLength);

    candidates.push({
      type: "repeated-start",
      previousStart,
      currentStart,
      anchorLength,
      matchedLength,
    });
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Conservative "did the later take actually succeed?" heuristics
// ---------------------------------------------------------------------------

function isFollowedByAnotherRestart(candidate, allCandidates) {
  return allCandidates.some((other) => {
    if (other === candidate) return false;
    return (
      other.previousStart >= candidate.currentStart &&
      other.previousStart <= candidate.currentStart + FOLLOW_UP_RESTART_WINDOW_WORDS
    );
  });
}

// Punctuation alone is not trusted: Deepgram sometimes punctuates an aborted
// take as if it were a complete sentence. A short gap before a substantial
// restart is treated as stronger evidence than punctuation.
function earlierTakeLooksAborted(words, candidate) {
  const { previousStart, currentStart, anchorLength, matchedLength } = candidate;

  const hasCompletedSentence = containsSentenceEnd(words, previousStart, currentStart - 1);
  if (!hasCompletedSentence) return true;

  const gapBeforeRestart = pauseBefore(words, currentStart);
  const restartIsSubstantial = matchedLength > anchorLength;

  return (
    Number.isFinite(gapBeforeRestart) &&
    gapBeforeRestart <= ABORT_AFTER_COMPLETE_SENTENCE_WINDOW_SECONDS &&
    restartIsSubstantial
  );
}

function laterTakeLooksComplete(words, candidate, allCandidates) {
  if (isFollowedByAnotherRestart(candidate, allCandidates)) return false;
  const attemptEnd = getAttemptBoundaryEnd(words, candidate.currentStart, words.length - 1);
  return endsSentence(words[attemptEnd]);
}

function laterTakeContinuesFurther(words, candidate) {
  const attemptEnd = getAttemptBoundaryEnd(words, candidate.currentStart, words.length - 1);
  return attemptEnd > candidate.currentStart + candidate.matchedLength - 1;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function computeProximityScore(timeDistance, wordDistance, maxSeconds, maxWords) {
  const timeScore = clamp01(1 - timeDistance / maxSeconds);
  const wordScore = clamp01(1 - wordDistance / maxWords);
  return (timeScore + wordScore) / 2;
}

function scoreMicroCandidate(candidate, words) {
  const timeDistance = words[candidate.currentStart].start - words[candidate.previousStart].start;
  const wordDistance = candidate.currentStart - candidate.previousStart;
  const { maxWords: maxDistanceWords, maxSeconds: maxGapSeconds } =
    microDistanceLimitsFor(candidate.anchorLength);
  const proximityScore = computeProximityScore(
    timeDistance,
    wordDistance,
    maxGapSeconds,
    maxDistanceWords
  );

  // Immediate adjacency of an identical short phrase is already very strong
  // evidence on its own; matched length and proximity only fine-tune it.
  let score = 0.55;
  score += proximityScore * 0.3;
  score += Math.min(candidate.matchedLength * 0.05, 0.15);
  if (timeDistance > maxGapSeconds) score -= 0.4;

  return {
    confidence: clamp01(score),
    evidence: {
      matchedLength: candidate.matchedLength,
      timeDistance,
      wordDistance,
      earlierTakeLooksAborted: true,
      laterTakeLooksComplete: null,
      laterTakeContinuesFurther: null,
      contentWordCount: null,
    },
  };
}

function scorePhraseCandidate(candidate, words, tokens, allCandidates) {
  const timeDistance = words[candidate.currentStart].start - words[candidate.previousStart].start;
  const wordDistance = candidate.currentStart - candidate.previousStart;
  const proximityScore = computeProximityScore(
    timeDistance,
    wordDistance,
    MAX_LOOKBACK_SECONDS,
    MAX_LOOKBACK_WORDS
  );

  const anchorTokens = tokens.slice(candidate.previousStart, candidate.previousStart + candidate.anchorLength);
  const contentWordCount = countContentWords(anchorTokens);
  const containsOnlyCommonWords = contentWordCount === 0;

  const aborted = earlierTakeLooksAborted(words, candidate);
  const complete = laterTakeLooksComplete(words, candidate, allCandidates);
  const continuesFurther = laterTakeContinuesFurther(words, candidate);
  const looksIncomplete = !complete && !continuesFurther;

  let score = 0;
  score += Math.min(candidate.matchedLength * 0.08, 0.4);
  score += proximityScore * 0.25;

  if (complete) score += 0.15;
  if (continuesFurther) score += 0.15;
  if (aborted) score += 0.15;

  if (containsOnlyCommonWords) score -= 0.25;
  if (timeDistance > 8) score -= 0.2;
  if (!aborted) score -= 0.3;
  if (looksIncomplete) score -= 0.25;

  return {
    confidence: clamp01(score),
    evidence: {
      matchedLength: candidate.matchedLength,
      timeDistance,
      wordDistance,
      earlierTakeLooksAborted: aborted,
      laterTakeLooksComplete: complete,
      laterTakeContinuesFurther: continuesFurther,
      contentWordCount,
    },
  };
}

function scoreCandidate(candidate, words, tokens, allCandidates) {
  const { confidence, evidence } =
    candidate.type === "micro-retake"
      ? scoreMicroCandidate(candidate, words)
      : scorePhraseCandidate(candidate, words, tokens, allCandidates);

  return { ...candidate, confidence, evidence };
}

function confidenceThresholdFor(candidate) {
  return candidate.type === "micro-retake" ? MICRO_MIN_CONFIDENCE : MIN_CONFIDENCE;
}

// ---------------------------------------------------------------------------
// Deduplication - collapse overlapping/competing candidates for the same
// underlying restart into a single, best one.
// ---------------------------------------------------------------------------

function deleteRangesOverlap(a, b) {
  const aStart = a.previousStart;
  const aEnd = a.currentStart - 1;
  const bStart = b.previousStart;
  const bEnd = b.currentStart - 1;
  return aStart <= bEnd && bStart <= aEnd;
}

function compareCandidates(a, b) {
  if (b.confidence !== a.confidence) return b.confidence - a.confidence;
  if (b.matchedLength !== a.matchedLength) return b.matchedLength - a.matchedLength;
  if (a.evidence.timeDistance !== b.evidence.timeDistance) {
    return a.evidence.timeDistance - b.evidence.timeDistance;
  }
  if (a.evidence.wordDistance !== b.evidence.wordDistance) {
    return a.evidence.wordDistance - b.evidence.wordDistance;
  }
  return (b.currentStart - b.previousStart) - (a.currentStart - a.previousStart);
}

function resolveDuplicateCandidates(candidates, debugSink) {
  const sorted = [...candidates].sort(compareCandidates);
  const accepted = [];

  for (const candidate of sorted) {
    const conflict = accepted.find(
      (existing) =>
        existing.currentStart === candidate.currentStart ||
        deleteRangesOverlap(existing, candidate)
    );

    if (conflict) {
      debugSink?.push({ candidate, reason: "duplicate-of-higher-score-candidate" });
      continue;
    }

    accepted.push(candidate);
  }

  return accepted;
}

// ---------------------------------------------------------------------------
// Chaining - "A restarts into B, B restarts into C" becomes a single
// delete-A-through-B, keep-C candidate instead of two disjoint edits.
// ---------------------------------------------------------------------------

function mergeRetakeChains(candidates) {
  const byDeleteStart = new Map(candidates.map((candidate) => [candidate.previousStart, candidate]));
  const consumed = new Set();
  const merged = [];

  const sortedByStart = [...candidates].sort((a, b) => a.previousStart - b.previousStart);

  for (const candidate of sortedByStart) {
    if (consumed.has(candidate)) continue;

    const chain = [candidate];
    consumed.add(candidate);
    let cursor = candidate;

    let next = byDeleteStart.get(cursor.currentStart);
    while (next && !consumed.has(next) && next !== cursor) {
      chain.push(next);
      consumed.add(next);
      cursor = next;
      next = byDeleteStart.get(cursor.currentStart);
    }

    const first = chain[0];
    const last = chain[chain.length - 1];

    merged.push({
      ...first,
      currentStart: last.currentStart,
      matchedLength: Math.max(...chain.map((link) => link.matchedLength)),
      confidence: Math.max(...chain.map((link) => link.confidence)),
      evidence: { ...first.evidence, chainedAttempts: chain.length },
    });
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Building the frontend-facing retake object
// ---------------------------------------------------------------------------

function buildRetake(candidate, words) {
  const startWordIndex = candidate.previousStart;
  const endWordIndex = candidate.currentStart - 1;

  const startWord = words[startWordIndex];
  const endWord = words[endWordIndex];

  if (!startWord || !endWord || endWordIndex < startWordIndex) return null;

  const start = startWord.start;
  const end = endWord.end;

  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;

  const text = words
    .slice(startWordIndex, endWordIndex + 1)
    .map((word) => word.punctuated_word ?? word.word)
    .join(" ");

  return {
    id: `retake-${startWordIndex}-${endWordIndex}`,
    startWordIndex,
    endWordIndex,
    start,
    end,
    text,
    type: candidate.type,
    confidence: candidate.confidence,
    keepFromWordIndex: candidate.currentStart,
    anchorLength: candidate.anchorLength,
    evidence: candidate.evidence,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Detects passages the speaker likely re-recorded, without ever touching the
// audio file. Pass `{ debug: true }` during development to also get back
// every rejected candidate with its confidence and rejection reason.
export function findRetakesFromWords(words, { debug = false } = {}) {
  if (!Array.isArray(words) || words.length < 2) {
    return debug ? { retakes: [], rejected: [] } : [];
  }

  const tokens = words.map(normalizeToken);
  const rejected = debug ? [] : null;

  const rawCandidates = [
    ...findMicroRetakeCandidates(words, tokens),
    ...findLocalPhraseRetakeCandidates(words, tokens),
  ];

  const scoredCandidates = rawCandidates.map((candidate) =>
    scoreCandidate(candidate, words, tokens, rawCandidates)
  );

  const acceptedByConfidence = scoredCandidates.filter((candidate) => {
    const passes = candidate.confidence >= confidenceThresholdFor(candidate);
    if (!passes) {
      rejected?.push({ candidate, reason: "confidence-below-threshold" });
    }
    return passes;
  });

  const deduplicated = resolveDuplicateCandidates(acceptedByConfidence, rejected);
  const chained = mergeRetakeChains(deduplicated);

  const retakes = chained
    .map((candidate) => buildRetake(candidate, words))
    .filter(Boolean)
    .sort((a, b) => a.startWordIndex - b.startWordIndex);

  return debug ? { retakes, rejected } : retakes;
}
