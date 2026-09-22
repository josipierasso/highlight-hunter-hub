import { createFileRoute } from "@tanstack/react-router";

const GATEWAY = "https://ai.gateway.lovable.dev/v1";
const MODEL = "openai/gpt-4o-mini-transcribe";
const MAX_BYTES = 24 * 1024 * 1024;

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

        const form = new FormData();
        form.append("model", MODEL);
        form.append("response_format", "json");
        form.append("stream", "true");
        form.append("file", file, file.name || "chunk.mp3");

        const res = await fetch(`${GATEWAY}/audio/transcriptions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}` },
          body: form,
        });

        if (!res.ok || !res.body) {
          const detail = await res.text().catch(() => "");
          return Response.json(
            { error: detail || "Falha ao transcrever o áudio." },
            { status: res.status || 502 },
          );
        }

        const raw = await res.text();
        let text = "";
        for (const line of raw.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const evt = JSON.parse(payload) as { delta?: string; text?: string; type?: string };
            if (typeof evt.delta === "string") text += evt.delta;
            else if (evt.type?.endsWith("done") && typeof evt.text === "string") text = evt.text;
            else if (!evt.type && typeof evt.text === "string") text = evt.text;
          } catch {
            // ignore malformed keep-alive lines
          }
        }

        if (!text.trim()) {
          try {
            const parsed = JSON.parse(raw) as { text?: string };
            if (parsed.text) text = parsed.text;
          } catch {
            // no-op
          }
        }

        return Response.json({ text: text.trim() });
      },
    },
  },
});
