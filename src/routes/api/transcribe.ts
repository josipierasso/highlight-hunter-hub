import { createFileRoute } from "@tanstack/react-router";

import { parseTranscriptionPayload, type TranscriptionResult } from "@/lib/clip-engine";

const GATEWAY = "https://ai.gateway.lovable.dev/v1";
const MODELS = ["openai/gpt-4o-mini-transcribe", "google/gemini-3.5-transcribe"] as const;
const MAX_BYTES = 14 * 1024 * 1024;

function gatewayHeaders(key: string): HeadersInit {
  return {
    Authorization: `Bearer ${key}`,
    "Lovable-API-Key": key,
    "X-Lovable-AIG-SDK": "fetch",
  };
}

function asAudioFile(value: FormDataEntryValue | null): File | null {
  if (value instanceof File && value.size > 0) return value;
  if (value instanceof Blob && value.size > 0) {
    return new File([value], "chunk.mp3", { type: value.type || "audio/mpeg" });
  }
  return null;
}

function publicError(status: number, body: string) {
  const lower = body.toLowerCase();
  if (status === 401 || status === 403) {
    return "A transcrição não está autorizada. Confira o conector de AI do Lovable.";
  }
  if (status === 429 || lower.includes("rate")) {
    return "A transcrição atingiu o limite. Aguarde um pouco e tente de novo.";
  }
  if (status === 413 || lower.includes("too large") || lower.includes("maximum")) {
    return "Um trecho de áudio ficou grande demais para transcrever.";
  }
  if (
    lower.includes("unsupported") ||
    lower.includes("invalid file") ||
    lower.includes("could not") ||
    lower.includes("format")
  ) {
    return "O áudio extraído não foi aceito. Tente outro MP4.";
  }
  return "Falha ao transcrever o áudio.";
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestTranscription(
  key: string,
  file: File,
  format: "json" | "verbose_json",
  model: string,
): Promise<{ ok: boolean; status: number; body: string }> {
  const form = new FormData();
  form.append("model", model);
  form.append("response_format", format);
  form.append("file", file, file.name || "chunk.mp3");

  const res = await fetch(`${GATEWAY}/audio/transcriptions`, {
    method: "POST",
    headers: gatewayHeaders(key),
    body: form,
  });

  const body = await res.text().catch(() => "");
  return { ok: res.ok, status: res.status, body };
}

async function transcribeAudio(key: string, file: File) {
  let last = { ok: false, status: 502, body: "" };
  for (const model of MODELS) {
    for (const format of ["json", "verbose_json"] as const) {
      for (let attempt = 0; attempt < 3; attempt++) {
        last = await requestTranscription(key, file, format, model);
        console.info("[transcribe]", {
          model,
          format,
          ok: last.ok,
          status: last.status,
          bytes: file.size,
          attempt,
        });
        if (last.ok) return last;
        if (last.status === 401 || last.status === 403) return last;
        if ((last.status === 429 || last.status >= 500) && attempt < 2) {
          await sleep(700 * (attempt + 1));
          continue;
        }
        break;
      }
    }
  }
  return last;
}

function hasTimedSpeech(result: TranscriptionResult) {
  return result.segments.some((segment) => segment.end > segment.start) || result.words.length > 0;
}

export const Route = createFileRoute("/api/transcribe")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const key = process.env["LOVABLE_API_KEY"];
        if (!key) {
          return Response.json({ error: "AI não está configurada." }, { status: 500 });
        }

        const incoming = await request.formData();
        const file = asAudioFile(incoming.get("file"));
        if (!file || file.size > MAX_BYTES) {
          return Response.json({ error: "Trecho de áudio inválido." }, { status: 400 });
        }

        const result = await transcribeAudio(key, file);
        if (!result.ok) {
          return Response.json(
            { error: publicError(result.status, result.body) },
            { status: result.status >= 400 && result.status < 600 ? result.status : 502 },
          );
        }

        const parsed = parseTranscriptionPayload(result.body);
        if (!parsed.text && !hasTimedSpeech(parsed)) {
          return Response.json({ text: "", segments: [], words: [] });
        }

        return Response.json({
          text: parsed.text.trim(),
          segments: parsed.segments,
          words: parsed.words,
        });
      },
    },
  },
});
