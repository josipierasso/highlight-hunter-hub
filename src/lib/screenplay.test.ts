import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  alignScreenplayToTranscript,
  candidatesFromScreenplay,
  hintSceneCategory,
  parseClock,
  parseScreenplay,
} from "./screenplay.ts";

describe("parseScreenplay", () => {
  it("reads fountain headings and timed scenes", () => {
    const parsed = parseScreenplay(`
INT. RINGUE - NOITE
Dois lutadores trocam socos. O público explode.

EXT. RUA - DIA 01:12:00
Eles correm entre carros. Tiros ao fundo.

INT. APARTAMENTO - NOITE 01:40:00 01:41:20
Eles se beijam. Ela diz te amo.
`);
    assert.equal(parsed.scenes.length, 3);
    assert.equal(parsed.scenes[0]?.categoryHint, "luta");
    assert.equal(parsed.scenes[1]?.categoryHint, "acao");
    assert.equal(parsed.scenes[2]?.categoryHint, "romantico");
    assert.equal(parsed.scenes[1]?.start, 72 * 60);
    assert.equal(parsed.scenes[2]?.end, 1 * 3600 + 41 * 60 + 20);
  });

  it("falls back to blank-line blocks when there is no heading", () => {
    const parsed = parseScreenplay(`A luta começa no pátio.

Mais tarde o casal se beija na varanda.
`);
    assert.ok(parsed.scenes.length >= 2);
  });
});

describe("screenplay alignment", () => {
  it("maps a timed scene onto clip candidates", () => {
    const parsed = parseScreenplay(`CENA 12 00:10:00 00:10:40
Eles se beijam e ela diz te amo.`);
    const aligned = alignScreenplayToTranscript(
      parsed.scenes,
      [{ start: 590, end: 640, text: "te amo para sempre nesta noite" }],
      800,
    );
    const clips = candidatesFromScreenplay(aligned, 800);
    assert.ok(clips.length >= 1);
    assert.equal(clips[0]?.source, "screenplay");
    assert.equal(clips[0]?.categoryHint, "romantico");
  });

  it("aligns untimed scenes by transcript overlap", () => {
    const parsed = parseScreenplay(`INT. RINGUE
Os lutadores trocam socos no combate decisivo.`);
    const aligned = alignScreenplayToTranscript(
      parsed.scenes,
      [
        { start: 20, end: 32, text: "os lutadores trocam socos no combate decisivo agora" },
        { start: 32, end: 44, text: "o público explode com o nocaute final desta luta" },
      ],
      80,
    );
    assert.equal(aligned[0]?.start, 20);
    assert.ok((aligned[0]?.end ?? 0) >= 32);
  });
});

describe("helpers", () => {
  it("parses clocks and hints", () => {
    assert.equal(parseClock("01:09:37"), 4177);
    assert.equal(hintSceneCategory("tiroteio na rua"), "acao");
    assert.equal(hintSceneCategory("o beijo final"), "romantico");
  });
});
