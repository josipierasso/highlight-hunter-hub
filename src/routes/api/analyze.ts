import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const GATEWAY = "https://ai.gateway.lovable.dev/v1/responses";
const MODEL = "openai/gpt-6-astra";

const BodySchema = z.object({
  duration: z
    .number()
    .finite()
    .positive()
    .max(2 * 60 * 60 + 30),
  targetCount: z.number().min(1).max(40).default(8),
  segments: z
    .array(z.object({ start: z.number(), end: z.number(), text: z.string() }))
    .max(800)
    .default([]),
  candidates: z
    .array(
      z.object({
        start: z.number(),
        end: z.number(),
        text: z.string(),
        source: z.enum(["speech", "screenplay"]).optional(),
        heading: z.string().optional(),
        categoryHint: z.string().optional(),
      }),
    )
    .max(60)
    .default([]),
  frames: z.array(z.object({ time: z.number(), dataUrl: z.string() })).max(40),
  screenplay: z.string().max(40000).optional().default(""),
  filmTitle: z.string().max(120).optional().default(""),
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
            enum: [
              "acao",
              "luta",
              "romantico",
              "climax",
              "comedia",
              "drama",
              "suspense",
              "discussao",
              "estudo",
              "apresentacao",
              "outro",
            ],
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
        const transcript = body.segments
          .map((segment) => formatWindow(segment.start, segment.end, segment.text))
          .join("\n");
        const candidateBlock = (body.candidates.length ? body.candidates : body.segments)
          .map((candidate, index) => {
            const extra = [
              "source" in candidate && candidate.source ? `origem=${candidate.source}` : "",
              "heading" in candidate && candidate.heading ? `cena=${candidate.heading}` : "",
              "categoryHint" in candidate && candidate.categoryHint
                ? `sugestao=${candidate.categoryHint}`
                : "",
            ]
              .filter(Boolean)
              .join(" · ");
            return `${index + 1}. ${formatWindow(candidate.start, candidate.end, candidate.text)}${
              extra ? ` (${extra})` : ""
            }`;
          })
          .join("\n");

        const content: Array<Record<string, unknown>> = [
          {
            type: "input_text",
            text: [
              `Duração total do vídeo: ${body.duration.toFixed(0)} segundos.`,
              `Quantidade desejada de clipes: ${body.targetCount}.`,
              `Título informado pelo usuário (só contexto, não busque roteiro externo): ${
                body.filmTitle?.trim() || "(não informado)"
              }.`,
              "",
              "Roteiro / cenas extraídas da fala ou anexadas pelo usuário:",
              body.screenplay?.trim() || "(sem roteiro enviado)",
              "",
              "Transcrição com timestamps reais da fala:",
              transcript || "(sem fala detectada — use o roteiro e os quadros)",
              "",
              "Candidatos já recortados. Escolha somente entre eles.",
              "Copie start e end do candidato. Não invente novos tempos.",
              "Se o candidato tiver heading ou source=screenplay, preserve a cena.",
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
          "Você é um editor de filme e shorts. Estude roteiro, fala e quadros para separar cenas.",
          "Categorias permitidas: acao, luta, romantico, climax, comedia, drama, suspense,",
          "discussao, estudo, apresentacao, outro. Classifique cada corte com a categoria certa.",
          "Ação = perseguição, explosão, tiroteio. Luta = combate corpo a corpo.",
          "Romântico = beijo, declaração, intimidade. Clímax = virada ou revelação.",
          "Se houver roteiro extraído da fala ou anexado, alinhe o título à cena.",
          "O título do filme é só contexto. Não invente diálogos de roteiros publicados.",
          "Cada corte precisa ser standalone: gancho no começo e fechamento no fim.",
          "Trecho que exige contexto anterior deve receber standalone baixo.",
          "Avalie scores 0-100: hook, curiosity, clarity, emotion, standalone.",
          "Regras: use start/end exatamente de um candidato; 15 a 90 segundos;",
          "sem duplicatas quase iguais; prefira 15-60s; descarte enrolação e silêncio.",
          "Distribua categorias quando o material permitir. Títulos em português do Brasil.",
          "'hook' é a primeira frase falada ou a didascália da cena.",
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
