/**
 * Browser-only media engine. Nothing leaves the device except short audio
 * chunks and small preview frames used for the AI study of the video.
 */
import type { FFmpeg } from "@ffmpeg/ffmpeg";

const CORE_BASE = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm";
const WORKERFS = "WORKERFS" as Parameters<FFmpeg["mount"]>[0];
const MEMFS_COPY_LIMIT = 80 * 1024 * 1024;

export const AUDIO_WINDOW_SECONDS = 360;

let ffmpegPromise: Promise<FFmpeg> | null = null;

export async function getFFmpeg(onLog?: (line: string) => void): Promise<FFmpeg> {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      try {
        const [{ FFmpeg: FFmpegClass }, { toBlobURL }] = await Promise.all([
          import("@ffmpeg/ffmpeg"),
          import("@ffmpeg/util"),
        ]);
        const ffmpeg = new FFmpegClass();
        ffmpeg.on("log", ({ message }) => onLog?.(message));
        await ffmpeg.load({
          coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
          wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
        });
        return ffmpeg;
      } catch (error) {
        ffmpegPromise = null;
        throw error;
      }
    })();
  }
  return ffmpegPromise;
}

export type AudioChunk = { start: number; end: number; blob: Blob };

export function mediaExtension(file: { name: string; type: string }) {
  const fromName = file.name.split(".").pop()?.toLowerCase();
  if (fromName && /^[a-z0-9]{2,5}$/.test(fromName)) return fromName;
  const type = file.type.toLowerCase();
  if (type.includes("webm")) return "webm";
  if (type.includes("quicktime") || type.includes("mov")) return "mov";
  if (type.includes("ogg")) return "ogg";
  if (type.includes("mpeg") || type.includes("mp4")) return "mp4";
  return "mp4";
}

export function planAudioWindows(
  durationSeconds: number | undefined,
  windowSeconds: number,
): Array<{ start: number; duration: number }> {
  const size = Math.max(1, windowSeconds);
  if (!durationSeconds || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return [];
  }
  const windows: Array<{ start: number; duration: number }> = [];
  for (let start = 0; start < durationSeconds; start += size) {
    windows.push({ start, duration: Math.min(size, durationSeconds - start) });
  }
  return windows;
}

type MountedInput = { path: string; close: () => Promise<void> };

async function openInput(ffmpeg: FFmpeg, file: File): Promise<MountedInput> {
  const id = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const mountPoint = `/in_${id}`;
  const name = `src.${mediaExtension(file)}`;
  await ffmpeg.createDir(mountPoint);
  try {
    const mounted = await ffmpeg.mount(WORKERFS, { blobs: [{ name, data: file }] }, mountPoint);
    if (mounted) {
      return {
        path: `${mountPoint}/${name}`,
        close: async () => {
          await ffmpeg.unmount(mountPoint).catch(() => undefined);
          await ffmpeg.deleteDir(mountPoint).catch(() => undefined);
        },
      };
    }
  } catch {
    await ffmpeg.unmount(mountPoint).catch(() => undefined);
  }
  await ffmpeg.deleteDir(mountPoint).catch(() => undefined);

  if (file.size > MEMFS_COPY_LIMIT) {
    throw new Error("FFmpeg não conseguiu montar este vídeo sem copiá-lo para a memória.");
  }

  const memName = `mem_${id}.${mediaExtension(file)}`;
  const { fetchFile } = await import("@ffmpeg/util");
  await ffmpeg.writeFile(memName, await fetchFile(file));
  return {
    path: memName,
    close: async () => {
      await ffmpeg.deleteFile(memName).catch(() => undefined);
    },
  };
}

async function readSegmentFiles(
  ffmpeg: FFmpeg,
  prefix: string,
  windowStart: number,
  chunkSeconds: number,
): Promise<AudioChunk[]> {
  const chunks: AudioChunk[] = [];
  for (let i = 0; i < 80; i++) {
    const name = `${prefix}_${String(i).padStart(3, "0")}.mp3`;
    try {
      const data = (await ffmpeg.readFile(name)) as Uint8Array;
      if (!data.length) break;
      chunks.push({
        start: windowStart + i * chunkSeconds,
        end: windowStart + (i + 1) * chunkSeconds,
        blob: new Blob([data.slice() as unknown as BlobPart], { type: "audio/mpeg" }),
      });
      await ffmpeg.deleteFile(name);
    } catch {
      break;
    }
  }
  return chunks;
}

function waitForEvent(
  target: HTMLMediaElement,
  event: "seeked" | "loadeddata" | "loadedmetadata",
  timeoutMs: number,
) {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout ao aguardar ${event} do vídeo.`));
    }, timeoutMs);
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Não foi possível ler o vídeo."));
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      target.removeEventListener(event, onEvent);
      target.removeEventListener("error", onError);
    };
    target.addEventListener(event, onEvent, { once: true });
    target.addEventListener("error", onError, { once: true });
  });
}

/** Binary-search duration when metadata reports Infinity (WebM/MediaRecorder). */
export async function resolveFiniteDuration(video: HTMLVideoElement): Promise<number> {
  const known = video.duration;
  if (Number.isFinite(known) && known > 0) return known;

  let low = 0;
  let high = 2;
  video.currentTime = 0;
  for (let i = 0; i < 24; i++) {
    try {
      video.currentTime = high;
      await waitForEvent(video, "seeked", 4000);
    } catch {
      break;
    }
    if (video.currentTime + 0.25 < high) {
      high = Math.max(video.currentTime, low + 0.1);
      break;
    }
    low = high;
    high *= 2;
    if (high > 12 * 60 * 60) break;
  }

  for (let i = 0; i < 20; i++) {
    const mid = (low + high) / 2;
    try {
      video.currentTime = mid;
      await waitForEvent(video, "seeked", 4000);
    } catch {
      high = mid;
      continue;
    }
    if (video.currentTime + 0.2 < mid) high = Math.max(video.currentTime, low);
    else low = Math.max(video.currentTime, mid);
    if (high - low < 0.25) break;
  }

  const duration = Math.max(video.currentTime, low);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Não foi possível calcular a duração deste vídeo.");
  }
  return duration;
}

/** Splits the video's audio into small mono mp3 chunks for transcription. */
export async function extractAudioChunks(
  file: File,
  chunkSeconds: number,
  onProgress?: (ratio: number) => void,
  durationSeconds?: number,
): Promise<AudioChunk[]> {
  const ffmpeg = await getFFmpeg();
  const input = await openInput(ffmpeg, file);
  const windows = planAudioWindows(durationSeconds, AUDIO_WINDOW_SECONDS);
  const planned = windows.length > 0 ? windows : [{ start: 0, duration: 0 }];
  const chunks: AudioChunk[] = [];

  try {
    for (let w = 0; w < planned.length; w++) {
      const window = planned[w]!;
      const prefix = `w${String(w).padStart(3, "0")}`;
      const handler = ({ progress }: { progress: number }) => {
        const local = Math.min(1, Math.max(0, progress));
        onProgress?.((w + local) / planned.length);
      };
      ffmpeg.on("progress", handler);
      const args = ["-hide_banner"];
      if (window.start > 0) args.push("-ss", window.start.toFixed(3));
      args.push("-i", input.path);
      if (window.duration > 0) args.push("-t", window.duration.toFixed(3));
      args.push(
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-b:a",
        "48k",
        "-f",
        "segment",
        "-segment_time",
        String(chunkSeconds),
        "-reset_timestamps",
        "1",
        `${prefix}_%03d.mp3`,
      );
      try {
        const code = await ffmpeg.exec(args);
        if (code !== 0) {
          throw new Error("FFmpeg não conseguiu extrair o áudio deste arquivo.");
        }
      } finally {
        ffmpeg.off("progress", handler);
      }
      const part = await readSegmentFiles(ffmpeg, prefix, window.start, chunkSeconds);
      if (!part.length && windows.length === 0) break;
      chunks.push(...part);
      onProgress?.((w + 1) / planned.length);
    }
  } finally {
    await input.close();
  }

  if (!chunks.length) {
    throw new Error("FFmpeg não conseguiu extrair o áudio deste arquivo.");
  }
  return chunks;
}

/** Grabs downscaled JPEG frames with a plain <video> element (fast, no wasm). */
export async function extractFrames(
  file: File,
  times: number[],
  width = 320,
): Promise<Array<{ time: number; dataUrl: string }>> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";

  try {
    await waitForEvent(video, "loadeddata", 15000);
    const duration = await resolveFiniteDuration(video);

    const ratio = video.videoHeight / video.videoWidth || 0.5625;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = Math.round(width * ratio);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Não foi possível capturar os quadros do vídeo.");
    }
    const frames: Array<{ time: number; dataUrl: string }> = [];
    const last = Math.max(0, duration - 0.1);

    for (const time of times) {
      const stamp = Math.min(Math.max(0, time), last);
      if (Math.abs(video.currentTime - stamp) > 0.05) {
        video.currentTime = stamp;
        await waitForEvent(video, "seeked", 8000);
      }
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      frames.push({ time: stamp, dataUrl: canvas.toDataURL("image/jpeg", 0.6) });
    }
    return frames;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function getVideoDuration(file: File): Promise<number> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "metadata";
  video.muted = true;
  video.playsInline = true;
  video.src = url;
  try {
    await waitForEvent(video, "loadedmetadata", 15000);
    return await resolveFiniteDuration(video);
  } catch (error) {
    if (error instanceof Error && error.message.includes("Timeout")) {
      throw new Error("Timeout ao ler a duração do vídeo.");
    }
    if (error instanceof Error && error.message.includes("Não foi possível")) {
      throw new Error("Formato de vídeo não suportado.");
    }
    throw error;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Cuts one clip locally. vertical = center-cropped 9:16 (720x1280). */
export async function cutClip(
  file: File,
  start: number,
  end: number,
  vertical: boolean,
  onProgress?: (ratio: number) => void,
): Promise<Blob> {
  const ffmpeg = await getFFmpeg();
  const input = await openInput(ffmpeg, file);
  const output = `clip_${Date.now()}.mp4`;

  const handler = ({ progress }: { progress: number }) => onProgress?.(Math.min(1, progress));
  ffmpeg.on("progress", handler);

  const args = ["-ss", start.toFixed(2), "-i", input.path, "-t", (end - start).toFixed(2)];
  if (vertical) {
    args.push(
      "-vf",
      "crop='min(iw,ih*9/16)':'min(ih,iw*16/9)',scale=720:1280",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "26",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
    );
  } else {
    args.push("-c", "copy");
  }
  args.push("-movflags", "+faststart", output);

  try {
    const code = await ffmpeg.exec(args);
    ffmpeg.off("progress", handler);
    if (code !== 0) {
      throw new Error("FFmpeg não conseguiu gerar esse corte.");
    }
    const data = (await ffmpeg.readFile(output)) as Uint8Array;
    await ffmpeg.deleteFile(output).catch(() => undefined);
    return new Blob([data.slice() as unknown as BlobPart], { type: "video/mp4" });
  } finally {
    ffmpeg.off("progress", handler);
    await ffmpeg.deleteFile(output).catch(() => undefined);
    await input.close();
  }
}
