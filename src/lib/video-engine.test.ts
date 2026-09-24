import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AUDIO_WINDOW_SECONDS, mediaExtension, planAudioWindows } from "./video-engine.ts";

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
