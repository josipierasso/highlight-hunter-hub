import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AUDIO_WINDOW_SECONDS,
  buildCutClipArgs,
  mediaExtension,
  planAudioWindows,
} from "./video-engine.ts";

describe("planAudioWindows", () => {
  it("returns no windows without a finite duration", () => {
    assert.deepEqual(planAudioWindows(undefined, 360), []);
    assert.deepEqual(planAudioWindows(NaN, 360), []);
    assert.deepEqual(planAudioWindows(Infinity, 360), []);
    assert.deepEqual(planAudioWindows(0, 360), []);
  });

  it("keeps a short file in a single window", () => {
    assert.deepEqual(planAudioWindows(50, 360), [{ start: 0, duration: 50 }]);
  });

  it("splits a 108-minute film into 6-minute windows", () => {
    const duration = 108 * 60;
    const windows = planAudioWindows(duration, AUDIO_WINDOW_SECONDS);
    assert.equal(windows.length, 18);
    assert.deepEqual(windows[0], { start: 0, duration: 360 });
    assert.deepEqual(windows.at(-1), { start: 17 * 360, duration: 108 * 60 - 17 * 360 });
    const covered = windows.reduce((sum, window) => sum + window.duration, 0);
    assert.equal(covered, duration);
  });
});

describe("mediaExtension", () => {
  it("prefers the file name over a generic type", () => {
    assert.equal(mediaExtension({ name: "filme.mkv", type: "video/mp4" }), "mkv");
    assert.equal(mediaExtension({ name: "gravação", type: "video/webm" }), "webm");
  });
});

describe("buildCutClipArgs", () => {
  it("stream-copies when there is no overlay", () => {
    const args = buildCutClipArgs({
      inputPath: "/in/src.mp4",
      output: "clip.mp4",
      start: 12,
      duration: 30,
    });
    assert.deepEqual(args.slice(0, 6), ["-ss", "12.00", "-i", "/in/src.mp4", "-t", "30.00"]);
    assert.ok(args.includes("copy"));
    assert.ok(!args.includes("-filter_complex"));
  });

  it("loops overlay images and burns watermark plus captions", () => {
    const args = buildCutClipArgs({
      inputPath: "/in/src.mp4",
      output: "clip.mp4",
      start: 8,
      duration: 50,
      watermarkFile: "wm.png",
      captions: [{ file: "cap_0.png", start: 1.2, end: 4.8 }],
    });
    const joined = args.join(" ");
    assert.ok(joined.includes("-ss 8.00 -t 50.00 -i /in/src.mp4"));
    assert.ok(joined.includes("-loop 1 -t 50.00 -i wm.png"));
    assert.ok(joined.includes("-loop 1 -t 50.00 -i cap_0.png"));
    assert.ok(joined.includes("-filter_complex"));
    assert.ok(joined.includes("overlay=W-w-24:24"));
    assert.ok(joined.includes("between(t,1.20,4.80)"));
    assert.ok(joined.includes("libx264"));
  });
});
