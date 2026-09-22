import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const GATEWAY = "https://ai.gateway.lovable.dev/v1/responses";
const MODEL = "openai/gpt-6-astra";

const BodySchema = z.object({
  duration: z.number().finite().positive(),
  targetCount: z.number().min(1).max(20).default(8),
  segments: z
    .array(z.object({ start: z.number(), end: z.number(), text: z.string() }))
    .max(400)
    .default([]),
  candidates: z
    .array(z.object({ start: z.number(), end: z.number(), text: z.string() }))
    .max(40)
    .default([]),
  frames: z.array(z.object({ time: z.number(), dataUrl: z.string() })).max(40),
});

const clipSchema = {
  type: "object",
  additionalProperties: false,
  required: ["overview", "clips"],
  properties: {
    overview: { type: "string" },
    clips: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "start", "end", "category", "reason", "score", "hook", "scores"],
        properties: {
          title: { type: "string" },
          start: { type: "number" },
          end: { type: "number" },
          category: {
            type: "string",
            enum: ["luta", "climax", "discussao", "estudo", "apresentacao", "outro"],
          },
          reason: { type: "string" },
          hook: { type: "string" },
          score: { type: "number" },
          scores: {
            type: "object",
            additionalProperties: false,
            required: ["hook", "curiosity", "clarity", "emotion", "standalone"],
            properties: {
              hook: { type: "number" },
              curiosity: { type: "number" },
              clarity: { type: "number" },
              emotion: { type: "number" },
              standalone: { type: "number" },
            },
          },
        },
      },
    },
  },
} as const;

function formatWindow(start: number, end: number, text: string) {
  return `[${start.toFixed(1)}s-${end.toFixed(1)}s] ${text}`;
}

export const Route = createFileRoute("/api/analyze")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const key = process.env["LOVABLE_API_KEY"];
        if (!key) {
          return Response.json({ error: "AI não está configurada." }, { status: 500 });
        }

        const body = BodySchema.parse(await request.json());
        const pools = body.candidates.length ? body.candidates : body.segments;
        const transcript = body.segments
          .map((segment) => formatWindow(segment.start, segment.end, segment.text))
          .join("\n");
        const candidateBlock = pools
          .map(
            (candidate, index) =>
              `${index + 1}. ${formatWindow(candidate.start, candidate.end, candidate.text)}`,
          )
          .join("\n");

        const content: Array<Record<string, unknown>> = [
          {
            type: "input_text",
            text: [
              `Duração total do vídeo: ${body.duration.toFixed(0)} segundos.`,
              `Quantidade desejada de clipes: ${body.targetCount}.`,
              "",
              "Transcrição com timestamps reais da fala:",
              transcript || "(sem fala detectada — use apenas os quadros de imagem)",
              "",
              "Candidatos já recortados em frases. Escolha somente entre eles.",
              "Copie start e end do candidato. Não invente novos tempos.",
              candidateBlock || "(nenhum candidato — devolva lista vazia de clips)",
              "",
              "A seguir, quadros do vídeo com o tempo indicado.",
            ].join("\n"),
          },
        ];

        for (const frame of body.frames) {
          content.push({ type: "input_text", text: `Quadro em ${frame.time.toFixed(0)}s:` });
          content.push({ type: "input_image", image_url: frame.dataUrl });
        }

        const instructions = [
          "Você é um editor profissional de cortes virais. Estude o vídeo e ranqueie os candidatos.",
          "Cada Short precisa ser standalone: quem nunca viu o vídeo inteiro tem de entender o assunto,",
          "sentir um gancho no começo e um fechamento no fim, sem depender de contexto dito muito antes.",
          "Um trecho emocionante que exige contexto anterior deve receber standalone baixo.",
          "Avalie scores 0-100: hook, curiosity, clarity, emotion, standalone.",
          "score geral deve refletir o potencial como Short, penalizando standalone abaixo de 50.",
          "Regras: use start/end exatamente de um candidato; 15 a 90 segundos; sem duplicatas quase iguais;",
          "prefira 15-60s quando houver opção; descarte enrolação, silêncio e repetição;",
          "mesmo que sobrem menos clipes que o pedido.",
          "Escreva títulos e justificativas em português do Brasil. 'hook' é a primeira frase falada do clipe.",
        ].join(" ");

        const res = await fetch(GATEWAY, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Lovable-API-Key": key,
            "X-Lovable-AIG-SDK": "fetch",
          },
          body: JSON.stringify({
            model: MODEL,
            stream: true,
            instructions,
            input: [{ role: "user", content }],
            reasoning: { effort: "medium", summary: "auto" },
            include: ["reasoning.encrypted_content"],
            store: false,
            text: {
              format: {
                type: "json_schema",
                name: "clip_plan",
                strict: true,
                schema: clipSchema,
              },
            },
          }),
        });

        if (!res.ok || !res.body) {
          const detail = await res.text().catch(() => "");
          return Response.json(
            { error: detail || "Falha na análise do vídeo." },
            { status: res.status || 502 },
          );
        }

        const raw = await res.text();
        let out = "";
        for (const line of raw.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const evt = JSON.parse(payload) as {
              type?: string;
              delta?: string;
              response?: { output_text?: string };
            };
            if (evt.type === "response.output_text.delta" && typeof evt.delta === "string") {
              out += evt.delta;
            } else if (evt.type === "response.completed" && evt.response?.output_text) {
              out = evt.response.output_text;
            }
          } catch {
            // ignore
          }
        }

        if (!out.trim()) {
          return Response.json(
            { error: "A análise terminou sem resultado. Tente novamente." },
            { status: 502 },
          );
        }

        try {
          return Response.json(JSON.parse(out));
        } catch {
          return Response.json({ error: "Resposta da análise inválida." }, { status: 502 });
        }
      },
    },
  },
});
