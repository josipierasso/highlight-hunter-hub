import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  cheapCandidateScore,
  computeOverallScore,
  dedupeByOverlap,
  finalizeClips,
  generateClipCandidates,
  intervalIoU,
  mergeChunkTranscripts,
  MIN_CLIP_SECONDS,
  MAX_CLIP_SECONDS,
  normalizeTranscription,
  offsetTranscript,
  overlapRatio,
  parseTranscriptionPayload,
  selectCandidatesForAnalysis,
  snapClipToCandidates,
  startsOnSegmentBoundary,
  wordsToSegments,
  type Clip,
  type TranscriptSegment,
} from "./clip-engine.ts";

const speech = (start: number, end: number, text: string): TranscriptSegment => ({
  start,
  end,
  text,
});

describe("timestamp offset", () => {
  it("adds the chunk start to relative segment times", () => {
    const offset = offsetTranscript(
      [
        speech(12.4, 17.8, "essa é a parte mais importante"),
        speech(20, 24.2, "presta atenção nisso"),
      ],
      90,
    );
    assert.deepEqual(offset, [
      speech(102.4, 107.8, "essa é a parte mais importante"),
      speech(110, 114.2, "presta atenção nisso"),
    ]);
  });

  it("does not keep the 90s window when speech is shorter", () => {
    const segments = normalizeTranscription(
      {
        text: "essa é a parte mais importante",
        segments: [speech(72.4, 77.8, "essa é a parte mais importante")],
        words: [],
      },
      0,
      90,
    );
    assert.equal(segments.length, 1);
    assert.equal(segments[0]?.start, 72.4);
    assert.equal(segments[0]?.end, 77.8);
  });

  it("merges multiple chunks using each chunk offset", () => {
    const merged = mergeChunkTranscripts(
      [
        {
          start: 0,
          end: 90,
          payload: {
            text: "abertura",
            segments: [speech(5, 12, "vamos começar")],
            words: [],
          },
        },
        {
          start: 90,
          end: 180,
          payload: {
            text: "climax",
            segments: [speech(12.4, 17.8, "essa é a parte mais importante")],
            words: [],
          },
        },
      ],
      200,
    );
    assert.equal(merged[0]?.start, 5);
    assert.equal(merged[1]?.start, 102.4);
    assert.equal(merged[1]?.end, 107.8);
  });
});

describe("transcription payload", () => {
  it("reads verbose_json segments", () => {
    const parsed = parseTranscriptionPayload(
      JSON.stringify({
        text: "olá mundo",
        segments: [{ start: 1.2, end: 2.8, text: "olá mundo" }],
      }),
    );
    assert.equal(parsed.text, "olá mundo");
    assert.equal(parsed.segments[0]?.start, 1.2);
    assert.equal(parsed.segments[0]?.end, 2.8);
  });

  it("reads word-level timestamps from verbose json", () => {
    const parsed = parseTranscriptionPayload(
      JSON.stringify({
        text: "essa é a parte",
        words: [
          { start: 1, end: 1.2, word: "essa" },
          { start: 1.2, end: 1.35, word: "é" },
          { start: 1.35, end: 1.5, word: "a" },
          { start: 1.5, end: 2.1, word: "parte" },
        ],
      }),
    );
    assert.equal(parsed.words.length, 4);
    const segments = wordsToSegments(parsed.words);
    assert.equal(segments[0]?.start, 1);
    assert.equal(segments[0]?.end, 2.1);
  });

  it("reads words nested inside segments", () => {
    const parsed = parseTranscriptionPayload(
      JSON.stringify({
        text: "fala agora",
        segments: [
          {
            start: 4,
            end: 6,
            text: "fala agora",
            words: [
              { word: "fala", start: 4, end: 4.4 },
              { word: "agora", start: 4.5, end: 6 },
            ],
          },
        ],
      }),
    );
    assert.equal(parsed.words.length, 2);
    assert.equal(parsed.words[0]?.start, 4);
  });

  it("parses streamed text deltas without inventing a 90s span", () => {
    const parsed = parseTranscriptionPayload(
      ['data: {"delta":"olá "}', 'data: {"delta":"mundo"}', "data: [DONE]"].join("\n"),
    );
    assert.equal(parsed.text, "olá mundo");
    assert.equal(parsed.segments.length, 0);
  });

  it("falls back to the chunk window only when there are no timestamps", () => {
    const segments = normalizeTranscription(
      { text: "fala sem tempo", segments: [], words: [] },
      90,
      180,
    );
    assert.equal(segments[0]?.start, 90);
    assert.equal(segments[0]?.end, 180);
  });
});

describe("candidates", () => {
  const story: TranscriptSegment[] = [
    speech(0, 4, "hoje eu vou mostrar uma ideia curta demais"),
    speech(10, 16, "essa é a virada que ninguém esperava no combate"),
    speech(16.2, 24, "o público explode e o lutador responde na hora"),
    speech(24.4, 33, "ele explica o golpe e fecha com a sentença final agora"),
    speech(40, 48, "vamos estudar o motivo pelo qual essa troca mudou o jogo todo"),
    speech(48.2, 58, "fica claro o erro tático e a consequência imediata disso"),
    speech(70, 78, "na palestra ele revela o número que comprova a tese inteira"),
    speech(78.4, 88, "e termina com o chamado para agir ainda nesta semana"),
    speech(120, 122, "ok"),
  ];

  it("keeps candidates between 15s and 90s", () => {
    const candidates = generateClipCandidates(story, 200);
    assert.ok(candidates.length > 0);
    for (const candidate of candidates) {
      const duration = candidate.end - candidate.start;
      assert.ok(duration >= MIN_CLIP_SECONDS - 0.01);
      assert.ok(duration <= MAX_CLIP_SECONDS + 0.01);
    }
  });

  it("starts candidates on sentence boundaries, not mid-phrase", () => {
    const candidates = generateClipCandidates(story, 200);
    for (const candidate of candidates) {
      assert.equal(startsOnSegmentBoundary(candidate, story), true);
    }
  });

  it("drops near-silent or too-short speech", () => {
    const candidates = generateClipCandidates(
      [speech(0, 1.2, "uh"), speech(20, 21, "ah"), speech(40, 41, "ok")],
      60,
    );
    assert.equal(candidates.length, 0);
  });

  it("allows overlapping candidates before ranking", () => {
    const candidates = generateClipCandidates(story, 200);
    const overlap = candidates.some((a, i) =>
      candidates.some((b, j) => i < j && overlapRatio(a, b) > 0.2),
    );
    assert.equal(overlap, true);
  });

  it("builds candidates larger than a single segment", () => {
    const candidates = generateClipCandidates(story, 200);
    assert.ok(candidates.some((candidate) => candidate.end - candidate.start > 20));
  });

  it("handles a short video without inventing 90s windows", () => {
    const candidates = generateClipCandidates(
      [speech(0.4, 3.1, "isso muda tudo agora"), speech(3.2, 6.5, "guarde esse número")],
      8,
    );
    assert.ok(candidates.length >= 1);
    assert.ok(candidates[0] && candidates[0].end <= 8);
    assert.ok(candidates[0] && candidates[0].end - candidates[0].start < 90);
  });

  it("covers speech that crosses two 90s chunks", () => {
    const merged = mergeChunkTranscripts(
      [
        {
          start: 0,
          end: 90,
          payload: {
            text: "antes",
            segments: [speech(80, 89, "o gancho começa aqui neste instante decisivo")],
            words: [],
          },
        },
        {
          start: 90,
          end: 180,
          payload: {
            text: "depois",
            segments: [speech(0, 12, "e o payoff fecha a ideia com a prova final")],
            words: [],
          },
        },
      ],
      180,
    );
    const candidates = generateClipCandidates(merged, 180);
    assert.ok(candidates.some((candidate) => candidate.start <= 80 && candidate.end >= 102));
  });
});

describe("dedupe and score", () => {
  it("removes near-duplicate windows", () => {
    const kept = dedupeByOverlap(
      [
        { start: 10, end: 45, score: 80 },
        { start: 15, end: 48, score: 70 },
        { start: 90, end: 130, score: 60 },
      ],
      0.55,
    );
    assert.equal(kept.length, 2);
    assert.equal(kept[0]?.start, 10);
    assert.equal(kept[1]?.start, 90);
  });

  it("caps overall score when standalone is weak", () => {
    const highEmotion = computeOverallScore({
      hook: 90,
      curiosity: 90,
      clarity: 80,
      emotion: 95,
      standalone: 20,
    });
    assert.ok(highEmotion <= 60);
  });

  it("keeps a high score when the clip is standalone", () => {
    const score = computeOverallScore({
      hook: 90,
      curiosity: 80,
      clarity: 80,
      emotion: 70,
      standalone: 90,
    });
    assert.ok(score > 80);
  });

  it("cheap filter prefers denser speech in the sweet duration", () => {
    const dense = cheapCandidateScore({
      start: 0,
      end: 30,
      text: "essa revelação muda a luta e explica o clímax com prova clara agora",
      speechSeconds: 28,
    });
    const sparse = cheapCandidateScore({
      start: 0,
      end: 80,
      text: "então né tipo assim vamos ver",
      speechSeconds: 20,
    });
    assert.ok(dense > sparse);
  });

  it("limits how many candidates go to the LLM", () => {
    const many = Array.from({ length: 80 }, (_, i) => ({
      start: i * 20,
      end: i * 20 + 30,
      text: "esse trecho tem fala suficiente para virar um corte de short viral agora",
      speechSeconds: 28,
    }));
    const selected = selectCandidatesForAnalysis(many, 8, 24);
    assert.ok(selected.length <= 24);
  });

  it("snaps LLM times back onto a real candidate", () => {
    const snapped = snapClipToCandidates({ start: 11, end: 44 }, [
      { start: 10, end: 45 },
      { start: 90, end: 130 },
    ]);
    assert.equal(snapped.start, 11);
    assert.equal(snapped.end, 44);
  });

  it("finalizes clips with scores, bounds and dedupe", () => {
    const clips: Clip[] = [
      {
        title: "Virada",
        start: 10,
        end: 45,
        category: "climax",
        reason: "payoff completo",
        hook: "essa é a virada",
        score: 90,
        scores: { hook: 90, curiosity: 80, clarity: 80, emotion: 85, standalone: 90 },
      },
      {
        title: "Virada quase igual",
        start: 15,
        end: 48,
        category: "climax",
        reason: "mesmo momento",
        hook: "essa é a virada",
        score: 70,
        scores: { hook: 70, curiosity: 70, clarity: 70, emotion: 70, standalone: 70 },
      },
    ];
    const result = finalizeClips(
      clips,
      [
        { start: 10, end: 45, text: "virada", speechSeconds: 30 },
        { start: 15, end: 48, text: "virada 2", speechSeconds: 30 },
      ],
      200,
      8,
    );
    assert.equal(result.length, 1);
    assert.equal(result[0]?.start, 10);
    assert.ok(result[0]?.scores);
    assert.ok((result[0]?.score ?? 0) > 80);
  });

  it("measures overlap of 10-45 vs 15-48 as a duplicate", () => {
    assert.ok(overlapRatio({ start: 10, end: 45 }, { start: 15, end: 48 }) > 0.7);
    assert.ok(intervalIoU({ start: 10, end: 45 }, { start: 15, end: 48 }) > 0.6);
  });
});
