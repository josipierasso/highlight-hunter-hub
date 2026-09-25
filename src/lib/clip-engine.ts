export type TranscriptSegment = {
  start: number;
  end: number;
  text: string;
};

export type TranscriptWord = {
  start: number;
  end: number;
  word: string;
};

export type TranscriptionResult = {
  text: string;
  segments: TranscriptSegment[];
  words: TranscriptWord[];
};

export const CLIP_CATEGORIES = [
  "acao",
  "luta",
  "romantico",
  "climax",
  "comedia",
  "drama",
  "suspense",
  "discussao",
  "estudo",
  "apresentacao",
  "outro",
] as const;

export type ClipCategory = (typeof CLIP_CATEGORIES)[number];

export const CATEGORY_LABEL: Record<ClipCategory, string> = {
  acao: "Ação",
  luta: "Luta",
  romantico: "Romântico",
  climax: "Clímax",
  comedia: "Comédia",
  drama: "Drama",
  suspense: "Suspense",
  discussao: "Discussão",
  estudo: "Estudo",
  apresentacao: "Apresentação",
  outro: "Outro",
};

export const CATEGORY_ALIASES: Record<string, ClipCategory> = {
  acao: "acao",
  ação: "acao",
  action: "acao",
  luta: "luta",
  fight: "luta",
  combate: "luta",
  romantico: "romantico",
  romântico: "romantico",
  romance: "romantico",
  romantic: "romantico",
  climax: "climax",
  clímax: "climax",
  comedia: "comedia",
  comédia: "comedia",
  comedy: "comedia",
  drama: "drama",
  suspense: "suspense",
  discussao: "discussao",
  discussão: "discussao",
  estudo: "estudo",
  apresentacao: "apresentacao",
  apresentação: "apresentacao",
  outro: "outro",
};

export function normalizeCategory(value: string | undefined): ClipCategory {
  if (!value) return "outro";
  const key = value.trim().toLowerCase();
  if (CATEGORY_ALIASES[key]) return CATEGORY_ALIASES[key];
  return CLIP_CATEGORIES.includes(key as ClipCategory) ? (key as ClipCategory) : "outro";
}

export type ClipCandidate = {
  start: number;
  end: number;
  text: string;
  speechSeconds: number;
  source?: "speech" | "screenplay";
  categoryHint?: ClipCategory;
  heading?: string;
};

export type ClipScores = {
  hook: number;
  curiosity: number;
  clarity: number;
  emotion: number;
  standalone: number;
};

export type Clip = {
  title: string;
  start: number;
  end: number;
  category: ClipCategory;
  reason: string;
  hook: string;
  score: number;
  scores?: ClipScores;
  heading?: string;
};

export const MIN_CLIP_SECONDS = 15;
export const MAX_CLIP_SECONDS = 90;
export const MAX_CANDIDATES_FOR_LLM = 36;
export const MAX_VIDEO_SECONDS = 2 * 60 * 60;
export const MAX_RESULT_CLIPS = 40;

const SENTENCE_END = /[.!?…]+["'”’)]*$/;
const MAX_SENTENCE_SECONDS = 14;
const WORD_GAP_SPLIT = 0.7;
const SCENE_GAP_SECONDS = 2.8;
const MIN_SPEECH_SECONDS = 8;
const MIN_WORDS = 12;
const LIGHT_DEDUP_IOU = 0.85;
const RESULT_OVERLAP = 0.55;

export function isFiniteDuration(value: number) {
  return Number.isFinite(value) && value > 0;
}

export function formatClock(seconds: number) {
  if (!isFiniteDuration(seconds) && seconds !== 0) return "—";
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  if (h > 0) {
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  }
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function roundTime(value: number) {
  return Math.round(value * 100) / 100;
}

function wordCount(text: string) {
  return text
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0).length;
}

function isUsableSegment(segment: TranscriptSegment) {
  const text = segment.text.trim();
  return text.length > 0 && segment.end > segment.start;
}

export function offsetTranscript<T extends { start: number; end: number }>(
  items: T[],
  chunkStart: number,
): T[] {
  return items.map((item) => ({
    ...item,
    start: roundTime(item.start + chunkStart),
    end: roundTime(item.end + chunkStart),
  }));
}

export function clampTranscript<T extends { start: number; end: number }>(
  items: T[],
  rangeStart: number,
  rangeEnd: number,
): T[] {
  const endLimit = Math.max(rangeStart, rangeEnd);
  return items
    .map((item) => ({
      ...item,
      start: roundTime(clamp(item.start, rangeStart, endLimit)),
      end: roundTime(clamp(item.end, rangeStart, endLimit)),
    }))
    .filter((item) => item.end > item.start);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readWords(value: unknown): TranscriptWord[] {
  if (!Array.isArray(value)) return [];
  const words: TranscriptWord[] = [];
  for (const item of value) {
    const rec = asRecord(item);
    if (!rec) continue;
    const start = asNumber(rec["start"]);
    const end = asNumber(rec["end"]);
    const word = asString(rec["word"]) ?? asString(rec["text"]);
    if (start === null || end === null || !word?.trim() || end < start) continue;
    words.push({ start, end, word: word.trim() });
  }
  return words;
}

function readSegments(value: unknown): {
  segments: TranscriptSegment[];
  words: TranscriptWord[];
} {
  if (!Array.isArray(value)) return { segments: [], words: [] };
  const segments: TranscriptSegment[] = [];
  const words: TranscriptWord[] = [];
  for (const item of value) {
    const rec = asRecord(item);
    if (!rec) continue;
    const start = asNumber(rec["start"]);
    const end = asNumber(rec["end"]);
    const text = asString(rec["text"]) ?? "";
    if (start === null || end === null || end < start) continue;
    segments.push({ start, end, text: text.trim() });
    words.push(...readWords(rec["words"]));
  }
  return { segments, words };
}

function mergeFromObject(target: TranscriptionResult, raw: Record<string, unknown>) {
  const text = asString(raw["text"]);
  if (text) {
    if (asString(raw["type"])?.endsWith("delta") || typeof raw["delta"] === "string") {
      target.text += text;
    } else {
      target.text = text;
    }
  }
  const delta = asString(raw["delta"]);
  if (delta && !text) target.text += delta;

  const parsed = readSegments(raw["segments"]);
  if (parsed.segments.length) target.segments = parsed.segments;
  if (parsed.words.length && !target.words.length) target.words = parsed.words;

  const words = readWords(raw["words"]);
  if (words.length) target.words = words;

  const response = asRecord(raw["response"]);
  if (response) mergeFromObject(target, response);
}

export function parseTranscriptionPayload(raw: string): TranscriptionResult {
  const result: TranscriptionResult = { text: "", segments: [], words: [] };
  const trimmed = raw.trim();
  if (!trimmed) return result;

  try {
    const parsed: unknown = JSON.parse(trimmed);
    const rec = asRecord(parsed);
    if (rec) mergeFromObject(result, rec);
    if (result.text || result.segments.length || result.words.length) {
      if (!result.text)
        result.text = result.segments
          .map((segment) => segment.text)
          .join(" ")
          .trim();
      return result;
    }
  } catch {
    // SSE / mixed payloads below
  }

  for (const line of trimmed.split("\n")) {
    const row = line.trim();
    if (!row.startsWith("data:")) continue;
    const payload = row.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed: unknown = JSON.parse(payload);
      const rec = asRecord(parsed);
      if (rec) mergeFromObject(result, rec);
    } catch {
      // ignore keep-alive
    }
  }

  if (!result.text)
    result.text = result.segments
      .map((segment) => segment.text)
      .join(" ")
      .trim();
  return result;
}

export function wordsToSegments(words: TranscriptWord[]): TranscriptSegment[] {
  const ordered = [...words]
    .filter((word) => word.word.trim() && word.end > word.start)
    .sort((a, b) => a.start - b.start);
  if (!ordered.length) return [];

  const segments: TranscriptSegment[] = [];
  let bucket: TranscriptWord[] = [];

  const flush = () => {
    const first = bucket[0];
    const last = bucket[bucket.length - 1];
    if (!first || !last) {
      bucket = [];
      return;
    }
    const text = bucket
      .map((item) => item.word)
      .join(" ")
      .replace(/\s+([,.!?;:…])/g, "$1")
      .trim();
    if (text) {
      segments.push({ start: first.start, end: last.end, text });
    }
    bucket = [];
  };

  for (let i = 0; i < ordered.length; i++) {
    const word = ordered[i];
    if (!word) continue;
    const prev = bucket[bucket.length - 1];
    if (prev && word.start - prev.end >= WORD_GAP_SPLIT) flush();
    bucket.push(word);
    const first = bucket[0];
    const span = first ? word.end - first.start : 0;
    if (SENTENCE_END.test(word.word) || span >= MAX_SENTENCE_SECONDS) flush();
  }
  flush();
  return segments;
}

export function normalizeTranscription(
  payload: TranscriptionResult,
  chunkStart: number,
  chunkEnd: number,
): TranscriptSegment[] {
  const fromWords = payload.words?.length ? wordsToSegments(payload.words) : [];
  const source = fromWords.length ? fromWords : (payload.segments ?? []);
  const offset = offsetTranscript(source, chunkStart);
  const clamped = clampTranscript(offset, chunkStart, chunkEnd).filter(isUsableSegment);
  if (clamped.length) return clamped;

  const text = payload.text.trim();
  if (!text) return [];
  return [
    {
      start: roundTime(chunkStart),
      end: roundTime(Math.max(chunkStart + 0.5, chunkEnd)),
      text,
    },
  ];
}

export function mergeChunkTranscripts(
  chunks: Array<{ start: number; end: number; payload: TranscriptionResult }>,
  duration: number,
): TranscriptSegment[] {
  const merged: TranscriptSegment[] = [];
  for (const chunk of chunks) {
    const end = Math.min(chunk.end, duration || chunk.end);
    merged.push(...normalizeTranscription(chunk.payload, chunk.start, end));
  }
  return merged.sort((a, b) => a.start - b.start);
}

export function sampleTranscript(segments: TranscriptSegment[], max = 400): TranscriptSegment[] {
  if (segments.length <= max) return segments;
  const picked: TranscriptSegment[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < max; i++) {
    const idx = Math.round((i / Math.max(1, max - 1)) * (segments.length - 1));
    if (seen.has(idx)) continue;
    seen.add(idx);
    const item = segments[idx];
    if (item) picked.push(item);
  }
  return picked;
}

function overlapSeconds(a: { start: number; end: number }, b: { start: number; end: number }) {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

export function intervalIoU(a: { start: number; end: number }, b: { start: number; end: number }) {
  const overlap = overlapSeconds(a, b);
  const union = a.end - a.start + (b.end - b.start) - overlap;
  return union <= 0 ? 0 : overlap / union;
}

export function overlapRatio(a: { start: number; end: number }, b: { start: number; end: number }) {
  const overlap = overlapSeconds(a, b);
  const shortest = Math.min(a.end - a.start, b.end - b.start);
  return shortest <= 0 ? 0 : overlap / shortest;
}

function speechDensity(candidate: ClipCandidate) {
  const duration = candidate.end - candidate.start;
  return duration <= 0 ? 0 : candidate.speechSeconds / duration;
}

export function cheapCandidateScore(candidate: ClipCandidate) {
  const duration = candidate.end - candidate.start;
  const sweet =
    duration >= 20 && duration <= 45 ? 1 : duration >= 15 && duration <= 60 ? 0.75 : 0.45;
  const density = speechDensity(candidate);
  const words = Math.min(wordCount(candidate.text), 90);
  const punch =
    /[!?]|por que|porque|nunca|sempre|absurdo|incrív|olha só|atenção|espera|mentir|verdade|beijo|luta|soco|tiro|te amo/i.test(
      candidate.text,
    )
      ? 1
      : 0;
  const scriptBoost = candidate.source === "screenplay" ? 8 : 0;
  return sweet * 40 + density * 30 + (words / 90) * 20 + punch * 10 + scriptBoost;
}

export function generateClipCandidates(
  segments: TranscriptSegment[],
  duration: number,
  options?: { minSeconds?: number; maxSeconds?: number },
): ClipCandidate[] {
  const minSeconds = options?.minSeconds ?? MIN_CLIP_SECONDS;
  const maxSeconds = options?.maxSeconds ?? MAX_CLIP_SECONDS;
  const usable = segments.filter(isUsableSegment).sort((a, b) => a.start - b.start);
  if (!usable.length) return [];

  const first = usable[0];
  const last = usable[usable.length - 1];
  if (!first || !last) return [];

  const allowShort = duration > 0 && duration < minSeconds;

  const candidates: ClipCandidate[] = [];
  const seen = new Set<string>();

  const pushCandidate = (from: number, to: number) => {
    const window = usable.slice(from, to + 1);
    const startSeg = window[0];
    const endSeg = window[window.length - 1];
    if (!startSeg || !endSeg) return;
    const start = startSeg.start;
    const end = endSeg.end;
    const dur = end - start;
    const text = window
      .map((segment) => segment.text.trim())
      .join(" ")
      .trim();
    const speechSeconds = window.reduce((sum, segment) => sum + (segment.end - segment.start), 0);
    const words = wordCount(text);
    const tooShort = allowShort ? dur < 3 : dur < minSeconds;
    if (tooShort || dur > maxSeconds) return;
    if (!allowShort && (speechSeconds < MIN_SPEECH_SECONDS || words < MIN_WORDS)) return;
    if (allowShort && words < 3) return;
    if (speechDensity({ start, end, text, speechSeconds }) < (allowShort ? 0.25 : 0.4)) return;
    const key = `${start.toFixed(2)}:${end.toFixed(2)}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({
      start: roundTime(start),
      end: roundTime(Math.min(end, duration || end)),
      text,
      speechSeconds: roundTime(speechSeconds),
      source: "speech",
    });
  };

  for (let i = 0; i < usable.length; i++) {
    for (let j = i; j < usable.length; j++) {
      const prev = j > i ? usable[j - 1] : undefined;
      const current = usable[j];
      if (prev && current && current.start - prev.end > SCENE_GAP_SECONDS) break;
      const startSeg = usable[i];
      if (!startSeg || !current) break;
      if (current.end - startSeg.start > maxSeconds) break;
      pushCandidate(i, j);
    }
  }

  if (!candidates.length && allowShort) {
    pushCandidate(0, usable.length - 1);
  }

  return candidates.sort((a, b) => a.start - b.start);
}

export function selectCandidatesForAnalysis(
  candidates: ClipCandidate[],
  targetCount: number,
  limit = MAX_CANDIDATES_FOR_LLM,
): ClipCandidate[] {
  const ranked = [...candidates].sort((a, b) => cheapCandidateScore(b) - cheapCandidateScore(a));
  const unique = dedupeByOverlap(ranked, LIGHT_DEDUP_IOU);
  const cap = Math.min(limit, Math.max(16, targetCount * 3));
  const groups = new Map<string, ClipCandidate[]>();
  for (const item of unique) {
    const bucket = item.categoryHint ?? item.source ?? "speech";
    const list = groups.get(bucket) ?? [];
    list.push(item);
    groups.set(bucket, list);
  }
  const diversified: ClipCandidate[] = [];
  const seen = new Set<string>();
  let added = true;
  while (diversified.length < cap && added) {
    added = false;
    for (const list of groups.values()) {
      const next = list.find((item) => !seen.has(`${item.start}:${item.end}`));
      if (!next) continue;
      seen.add(`${next.start}:${next.end}`);
      diversified.push(next);
      added = true;
      if (diversified.length >= cap) break;
    }
  }
  return diversified.sort((a, b) => a.start - b.start);
}

export function dedupeByOverlap<T extends { start: number; end: number; score?: number }>(
  items: T[],
  threshold = RESULT_OVERLAP,
): T[] {
  const ordered = [...items].sort((a, b) => {
    const scoreDelta = (b.score ?? 0) - (a.score ?? 0);
    if (scoreDelta !== 0) return scoreDelta;
    return a.start - b.start;
  });
  const kept: T[] = [];
  for (const item of ordered) {
    const duplicate = kept.some(
      (other) => overlapRatio(item, other) >= threshold || intervalIoU(item, other) >= threshold,
    );
    if (!duplicate) kept.push(item);
  }
  return kept;
}

export function computeOverallScore(scores: ClipScores) {
  const hook = clamp(scores.hook, 0, 100);
  const curiosity = clamp(scores.curiosity, 0, 100);
  const clarity = clamp(scores.clarity, 0, 100);
  const emotion = clamp(scores.emotion, 0, 100);
  const standalone = clamp(scores.standalone, 0, 100);
  let overall = hook * 0.25 + curiosity * 0.2 + clarity * 0.15 + emotion * 0.15 + standalone * 0.25;
  if (standalone < 50) overall = Math.min(overall, 60);
  return roundTime(overall);
}

export function normalizeScores(scores: Partial<ClipScores> | undefined, fallback = 0): ClipScores {
  return {
    hook: clamp(scores?.hook ?? fallback, 0, 100),
    curiosity: clamp(scores?.curiosity ?? fallback, 0, 100),
    clarity: clamp(scores?.clarity ?? fallback, 0, 100),
    emotion: clamp(scores?.emotion ?? fallback, 0, 100),
    standalone: clamp(scores?.standalone ?? fallback, 0, 100),
  };
}

export function snapClipToCandidates(
  clip: { start: number; end: number },
  candidates: Array<{ start: number; end: number }>,
): { start: number; end: number } {
  if (!candidates.length) return { start: clip.start, end: clip.end };
  let best = candidates[0];
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    const overlap = overlapSeconds(clip, candidate);
    const startDelta = Math.abs(clip.start - candidate.start);
    const endDelta = Math.abs(clip.end - candidate.end);
    const score = overlap * 2 - startDelta - endDelta;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  if (!best) return { start: clip.start, end: clip.end };

  const inside =
    clip.start >= best.start - 1 &&
    clip.end <= best.end + 1 &&
    clip.end - clip.start >= MIN_CLIP_SECONDS - 1;
  if (inside) {
    return {
      start: roundTime(Math.max(best.start, clip.start)),
      end: roundTime(Math.min(best.end, clip.end)),
    };
  }
  return { start: best.start, end: best.end };
}

export function finalizeClips(
  clips: Clip[],
  candidates: ClipCandidate[],
  duration: number,
  targetCount: number,
): Clip[] {
  const prepared: Clip[] = [];
  for (const clip of clips) {
    const snapped = snapClipToCandidates(clip, candidates);
    const start = roundTime(clamp(snapped.start, 0, duration || snapped.end));
    const end = roundTime(clamp(snapped.end, start, duration || snapped.end));
    const length = end - start;
    const minLen = duration > 0 && duration < MIN_CLIP_SECONDS ? 3 : MIN_CLIP_SECONDS - 0.5;
    if (length < minLen || length > MAX_CLIP_SECONDS + 0.5) continue;
    const scores = normalizeScores(clip.scores, clip.score);
    const score = clip.scores ? computeOverallScore(scores) : clamp(clip.score, 0, 100);
    prepared.push({
      ...clip,
      start,
      end,
      score,
      scores,
      category: normalizeCategory(clip.category),
      title: clip.title.trim() || "Corte",
      hook: clip.hook.trim(),
      reason: clip.reason.trim(),
    });
  }

  const cap = Math.min(MAX_RESULT_CLIPS, Math.max(1, targetCount));
  return dedupeByOverlap(prepared, RESULT_OVERLAP)
    .sort((a, b) => b.score - a.score)
    .slice(0, cap);
}

export function groupClipsByCategory(
  clips: Clip[],
): Array<{ category: ClipCategory; clips: Clip[] }> {
  const buckets = new Map<ClipCategory, Clip[]>();
  for (const clip of clips) {
    const category = normalizeCategory(clip.category);
    const list = buckets.get(category) ?? [];
    list.push(clip);
    buckets.set(category, list);
  }
  return CLIP_CATEGORIES.filter((category) => buckets.has(category)).map((category) => ({
    category,
    clips: buckets.get(category) ?? [],
  }));
}

export function mergeCandidatePools(...pools: ClipCandidate[][]): ClipCandidate[] {
  const merged: ClipCandidate[] = [];
  const seen = new Set<string>();
  for (const pool of pools) {
    for (const candidate of pool) {
      const key = `${candidate.start.toFixed(2)}:${candidate.end.toFixed(2)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(candidate);
    }
  }
  return merged.sort((a, b) => a.start - b.start);
}

export function startsOnSegmentBoundary(
  clip: { start: number },
  segments: TranscriptSegment[],
  tolerance = 0.05,
) {
  return segments.some((segment) => Math.abs(segment.start - clip.start) <= tolerance);
}
