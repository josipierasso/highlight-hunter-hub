import type { ClipCandidate, ClipCategory, TranscriptSegment } from "./clip-engine";

export type ScreenplayScene = {
  index: number;
  heading: string;
  text: string;
  start?: number;
  end?: number;
  categoryHint?: ClipCategory;
};

export type ParsedScreenplay = {
  text: string;
  scenes: ScreenplayScene[];
};

const SCENE_HEADING =
  /^(?:\.(?=[A-ZÀ-Ü])|(?:INT|EXT|EST|INT\/EXT|INT\.\/EXT|I\/E)[.\s/]|CENA\s+\d+|SCENE\s+\d+|FADE IN|FADE OUT)/i;

const CLOCK = /(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)/;

const HINTS: Array<[RegExp, ClipCategory]> = [
  [/\b(luta|fight|boxe|soco|combate|duelo|briga|punch|round|knock)/i, "luta"],
  [/\b(tiro|explos|persegui|chase|tiroteio|corrida|ataque|fuga|acao|ação)/i, "acao"],
  [/\b(beijo|kiss|amor|te amo|romance|abrac|abraç|casal|paix)/i, "romantico"],
  [/\b(climax|clímax|revela|plot twist|virada|desfecho)/i, "climax"],
  [/\b(riso|piada|comedia|comédia|engraç|funny)/i, "comedia"],
  [/\b(suspense|perigo|ameaca|ameaça|sombra|silencio tenso)/i, "suspense"],
  [/\b(choro|luto|drama|perda|adeus)/i, "drama"],
  [/\b(discuss|briga verbal|discussao|discussão|argument)/i, "discussao"],
];

export function parseClock(value: string): number | null {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[.,](\d{1,3}))?$/);
  if (!match) return null;
  const hoursOrMin = Number(match[1]);
  const minutesOrSec = Number(match[2]);
  if (match[3] != null) {
    return hoursOrMin * 3600 + minutesOrSec * 60 + Number(match[3]);
  }
  return hoursOrMin * 60 + minutesOrSec;
}

function tokenize(text: string) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2);
}

export function hintSceneCategory(text: string): ClipCategory | undefined {
  for (const [pattern, category] of HINTS) {
    if (pattern.test(text)) return category;
  }
  return undefined;
}

function readTimes(line: string): { start?: number; end?: number; rest: string } {
  const stamps = [...line.matchAll(new RegExp(CLOCK.source, "g"))].map((item) => item[0]);
  if (!stamps.length) return { rest: line };
  const start = parseClock(stamps[0] ?? "");
  const end = stamps[1] ? parseClock(stamps[1]) : null;
  const rest = line
    .replace(CLOCK, "")
    .replace(CLOCK, "")
    .replace(/^[\s[\]\-–—]+/, "")
    .trim();
  const times: { start?: number; end?: number; rest: string } = { rest };
  if (start !== null) times.start = start;
  if (end !== null) times.end = end;
  return times;
}

function flushScene(
  scenes: ScreenplayScene[],
  heading: string,
  lines: string[],
  start?: number,
  end?: number,
) {
  const text = lines.join("\n").trim();
  if (!heading.trim() && !text) return;
  const blob = `${heading}\n${text}`;
  const scene: ScreenplayScene = {
    index: scenes.length,
    heading: heading.trim() || `Cena ${scenes.length + 1}`,
    text,
  };
  if (start != null) scene.start = start;
  if (end != null && start != null && end > start) scene.end = end;
  const hint = hintSceneCategory(blob);
  if (hint) scene.categoryHint = hint;
  scenes.push(scene);
}

export function parseScreenplay(raw: string): ParsedScreenplay {
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (!text) return { text: "", scenes: [] };

  const lines = text.split("\n");
  const scenes: ScreenplayScene[] = [];
  let heading = "";
  let start: number | undefined;
  let end: number | undefined;
  let body: string[] = [];
  let sawHeading = false;

  const close = () => {
    flushScene(scenes, heading, body, start, end);
    heading = "";
    start = undefined;
    end = undefined;
    body = [];
  };

  for (const original of lines) {
    const line = original.trim();
    if (!line) {
      if (body.length) body.push("");
      continue;
    }
    const timed = readTimes(line);
    const headingLine = SCENE_HEADING.test(line);
    if (headingLine || (timed.start != null && line.length < 80)) {
      close();
      sawHeading = true;
      start = timed.start;
      end = timed.end;
      heading = headingLine ? timed.rest || line : timed.rest || line;
      continue;
    }
    body.push(original);
  }
  close();

  if (!sawHeading && scenes.length <= 1) {
    const blocks = text
      .split(/\n{2,}/)
      .map((block) => block.trim())
      .filter(Boolean);
    if (blocks.length > 1) {
      const fromBlocks: ScreenplayScene[] = [];
      for (const block of blocks) {
        const first = block.split("\n")[0] ?? "";
        const timed = readTimes(first);
        flushScene(
          fromBlocks,
          timed.rest || `Cena ${fromBlocks.length + 1}`,
          [timed.rest === first ? block : block.split("\n").slice(1).join("\n")],
          timed.start,
          timed.end,
        );
      }
      return { text, scenes: fromBlocks };
    }
  }

  return { text, scenes };
}

export async function readScreenplayFile(file: File): Promise<string> {
  if (file.size > 2 * 1024 * 1024) {
    throw new Error("Roteiro grande demais. Use um TXT de até 2 MB.");
  }
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf") || name.endsWith(".doc") || name.endsWith(".docx")) {
    throw new Error("Envie o roteiro em TXT, Fountain ou Markdown.");
  }
  return file.text();
}

function windowScore(query: string[], words: string[]) {
  if (!query.length || !words.length) return 0;
  const have = new Set(words);
  let hits = 0;
  for (const word of query) if (have.has(word)) hits += 1;
  return hits / query.length;
}

export function alignScreenplayToTranscript(
  scenes: ScreenplayScene[],
  segments: TranscriptSegment[],
  duration: number,
): ScreenplayScene[] {
  if (!scenes.length) return [];
  const usable = segments.filter((segment) => segment.text.trim() && segment.end > segment.start);
  let cursor = 0;

  return scenes.map((scene) => {
    if (scene.start != null && Number.isFinite(scene.start)) {
      const start = Math.max(0, scene.start);
      const end = Math.min(duration || scene.end || start + 30, scene.end ?? start + 30);
      if (end > start) cursor = usable.findIndex((segment) => segment.start >= end);
      if (cursor < 0) cursor = usable.length;
      return { ...scene, start, end };
    }
    const query = tokenize(`${scene.heading} ${scene.text}`).slice(0, 40);
    if (!query.length || !usable.length || cursor >= usable.length) return scene;

    let bestFrom = cursor;
    let bestTo = cursor;
    let best = 0;
    const limit = Math.min(usable.length, cursor + 80);
    for (let i = cursor; i < limit; i++) {
      const bag: string[] = [];
      for (let j = i; j < Math.min(usable.length, i + 18); j++) {
        const current = usable[j];
        if (!current) break;
        bag.push(...tokenize(current.text));
        const score = windowScore(query, bag);
        const span = current.end - (usable[i]?.start ?? current.start);
        if (score > best && span >= 8 && span <= 180) {
          best = score;
          bestFrom = i;
          bestTo = j;
        }
      }
    }
    if (best < 0.18) return scene;
    const first = usable[bestFrom];
    const last = usable[bestTo];
    if (!first || !last) return scene;
    cursor = bestTo + 1;
    return {
      ...scene,
      start: first.start,
      end: Math.min(duration || last.end, last.end),
    };
  });
}

export function candidatesFromScreenplay(
  scenes: ScreenplayScene[],
  duration: number,
): ClipCandidate[] {
  const candidates: ClipCandidate[] = [];
  for (const scene of scenes) {
    if (scene.start == null || scene.end == null) continue;
    const start = Math.max(0, scene.start);
    const end = Math.min(duration || scene.end, scene.end);
    const span = end - start;
    if (span < 8) continue;
    const text = `${scene.heading}. ${scene.text}`.replace(/\s+/g, " ").trim();
    const push = (from: number, to: number) => {
      candidates.push({
        start: Math.round(from * 100) / 100,
        end: Math.round(to * 100) / 100,
        text: text.slice(0, 600),
        speechSeconds: Math.round(Math.min(to - from, span) * 100) / 100,
        source: "screenplay",
        categoryHint: scene.categoryHint ?? "outro",
        heading: scene.heading,
      });
    };
    if (span <= 90) {
      push(start, end);
      continue;
    }
    const window = 45;
    for (let from = start; from < end - 12; from += 30) {
      const to = Math.min(end, from + window);
      if (to - from >= 15) push(from, to);
    }
  }
  return candidates;
}

export function guessFilmTitle(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, "");
  const cleaned = base
    .replace(/[._]+/g, " ")
    .replace(
      /\b(1080p|720p|2160p|4k|bluray|webrip|web-dl|hdtv|x264|x265|hevc|aac|dts|extended|remastered|official|trailer|filme|movie)\b/gi,
      " ",
    )
    .replace(/\(\d{4}\)/g, " ")
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, 80);
}

export function extractScreenplayFromTranscript(
  segments: TranscriptSegment[],
  duration: number,
): ParsedScreenplay {
  const usable = segments
    .filter((segment) => segment.text.trim() && segment.end > segment.start)
    .sort((a, b) => a.start - b.start);
  if (!usable.length) return { text: "", scenes: [] };

  const scenes: ScreenplayScene[] = [];
  let bucket: TranscriptSegment[] = [];
  const flush = () => {
    const first = bucket[0];
    const last = bucket[bucket.length - 1];
    if (!first || !last) {
      bucket = [];
      return;
    }
    const text = bucket
      .map((item) => item.text.trim())
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length < 24) {
      bucket = [];
      return;
    }
    const heading = `Cena ${scenes.length + 1}`;
    const scene: ScreenplayScene = {
      index: scenes.length,
      heading,
      text: text.slice(0, 900),
      start: first.start,
      end: Math.min(duration || last.end, last.end),
    };
    const hint = hintSceneCategory(`${heading} ${text}`);
    if (hint) scene.categoryHint = hint;
    scenes.push(scene);
    bucket = [];
  };

  for (const segment of usable) {
    const prev = bucket[bucket.length - 1];
    const first = bucket[0];
    const gap = prev ? segment.start - prev.end : 0;
    const span = first ? segment.end - first.start : 0;
    if (prev && (gap > 2.8 || span > 90)) flush();
    bucket.push(segment);
  }
  flush();
  return {
    text: scenes.map((scene) => `${scene.heading}\n${scene.text}`).join("\n\n"),
    scenes,
  };
}

export function summarizeScreenplay(scenes: ScreenplayScene[], limit = 18000) {
  const lines = scenes.map((scene) => {
    const clock =
      scene.start != null
        ? `[${scene.start.toFixed(0)}s-${(scene.end ?? scene.start).toFixed(0)}s]`
        : "[sem tempo]";
    const hint = scene.categoryHint ? ` (${scene.categoryHint})` : "";
    return `${clock} ${scene.heading}${hint}\n${scene.text.slice(0, 400)}`;
  });
  let out = "";
  for (const line of lines) {
    if (out.length + line.length + 2 > limit) break;
    out += `${line}\n\n`;
  }
  return out.trim();
}
