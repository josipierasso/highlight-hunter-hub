import { createFileRoute } from "@tanstack/react-router";

import { parseTranscriptionPayload, type TranscriptionResult } from "@/lib/clip-engine";

const GATEWAY = "https://ai.gateway.lovable.dev/v1";
const MODEL = "openai/gpt-4o-mini-transcribe";
const MAX_BYTES = 24 * 1024 * 1024;

async function requestTranscription(
  key: string,
  file: File,
  format: "verbose_json" | "json",
): Promise<{ ok: boolean; status: number; body: string }> {
  const form = new FormData();
  form.append("model", MODEL);
  form.append("response_format", format);
  form.append("file", file, file.name || "chunk.mp3");

  const res = await fetch(`${GATEWAY}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });

  const body = await res.text().catch(() => "");
  return { ok: res.ok, status: res.status, body };
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
        const file = incoming.get("file");
        if (!(file instanceof File) || file.size === 0 || file.size > MAX_BYTES) {
          return Response.json({ error: "Trecho de áudio inválido." }, { status: 400 });
        }

        const verbose = await requestTranscription(key, file, "verbose_json");
        let parsed = parseTranscriptionPayload(verbose.body);

        if (!verbose.ok) {
          const plain = await requestTranscription(key, file, "json");
          if (!plain.ok) {
            return Response.json(
              { error: plain.body || verbose.body || "Falha ao transcrever o áudio." },
              { status: plain.status || verbose.status || 502 },
            );
          }
          parsed = parseTranscriptionPayload(plain.body);
        }

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
