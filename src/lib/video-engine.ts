/**
 * Browser-only media engine. Nothing leaves the device except short audio
 * chunks and small preview frames used for the AI study of the video.
 */
import type { FFmpeg } from "@ffmpeg/ffmpeg";

const CORE_BASE = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd";

let ffmpegPromise: Promise<FFmpeg> | null = null;

export async function getFFmpeg(onLog?: (line: string) => void): Promise<FFmpeg> {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
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
    })();
  }
  return ffmpegPromise;
}

export type AudioChunk = { start: number; end: number; blob: Blob };

/** Splits the video's audio into small mono mp3 chunks for transcription. */
export async function extractAudioChunks(
  file: File,
  chunkSeconds: number,
  onProgress?: (ratio: number) => void,
): Promise<AudioChunk[]> {
  const ffmpeg = await getFFmpeg();
  const { fetchFile } = await import("@ffmpeg/util");
  const input = `src_${Date.now()}`;
  await ffmpeg.writeFile(input, await fetchFile(file));

  const handler = ({ progress }: { progress: number }) => onProgress?.(Math.min(1, progress));
  ffmpeg.on("progress", handler);
  await ffmpeg.exec([
    "-i",
    input,
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
    "chunk%03d.mp3",
  ]);
  ffmpeg.off("progress", handler);

  const chunks: AudioChunk[] = [];
  for (let i = 0; i < 400; i++) {
    const name = `chunk${String(i).padStart(3, "0")}.mp3`;
    try {
      const data = (await ffmpeg.readFile(name)) as Uint8Array;
      if (!data.length) break;
      chunks.push({
        start: i * chunkSeconds,
        end: (i + 1) * chunkSeconds,
        blob: new Blob([data.slice() as unknown as BlobPart], { type: "audio/mpeg" }),
      });
      await ffmpeg.deleteFile(name);
    } catch {
      break;
    }
  }
  await ffmpeg.deleteFile(input);
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
  video.preload = "auto";

  await new Promise<void>((resolve, reject) => {
    video.onloadeddata = () => resolve();
    video.onerror = () => reject(new Error("Não foi possível ler o vídeo."));
  });

  const ratio = video.videoHeight / video.videoWidth || 0.5625;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = Math.round(width * ratio);
  const ctx = canvas.getContext("2d")!;
  const frames: Array<{ time: number; dataUrl: string }> = [];

  for (const time of times) {
    await new Promise<void>((resolve) => {
      const onSeeked = () => {
        video.removeEventListener("seeked", onSeeked);
        resolve();
      };
      video.addEventListener("seeked", onSeeked);
      video.currentTime = Math.min(time, Math.max(0, video.duration - 0.1));
    });
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    frames.push({ time, dataUrl: canvas.toDataURL("image/jpeg", 0.6) });
  }

  URL.revokeObjectURL(url);
  return frames;
}

export async function getVideoDuration(file: File): Promise<number> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.src = url;
  try {
    return await new Promise<number>((resolve, reject) => {
      video.onloadedmetadata = () => resolve(video.duration);
      video.onerror = () => reject(new Error("Formato de vídeo não suportado."));
    });
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
  const { fetchFile } = await import("@ffmpeg/util");
  const input = `cut_${Date.now()}`;
  const output = `clip_${Date.now()}.mp4`;
  await ffmpeg.writeFile(input, await fetchFile(file));

  const handler = ({ progress }: { progress: number }) => onProgress?.(Math.min(1, progress));
  ffmpeg.on("progress", handler);

  const args = ["-ss", start.toFixed(2), "-i", input, "-t", (end - start).toFixed(2)];
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

  await ffmpeg.exec(args);
  ffmpeg.off("progress", handler);

  const data = (await ffmpeg.readFile(output)) as Uint8Array;
  await ffmpeg.deleteFile(input);
  await ffmpeg.deleteFile(output);
  return new Blob([data.slice() as unknown as BlobPart], { type: "video/mp4" });
}
