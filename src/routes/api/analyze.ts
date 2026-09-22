import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const GATEWAY = "https://ai.gateway.lovable.dev/v1/responses";
const MODEL = "openai/gpt-6-astra";

const BodySchema = z.object({
  duration: z.number().positive(),
  targetCount: z.number().min(1).max(20).default(8),
  segments: z
    .array(z.object({ start: z.number(), end: z.number(), text: z.string() }))
    .max(400),
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
        required: ["title", "start", "end", "category", "reason", "score", "hook"],
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
        },
      },
    },
  },
} as const;

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
          .map((s) => `[${s.start.toFixed(0)}s-${s.end.toFixed(0)}s] ${s.text}`)
          .join("\n");

        const content: Array<Record<string, unknown>> = [
          {
            type: "input_text",
            text: [
              `Duração total do vídeo: ${body.duration.toFixed(0)} segundos.`,
              `Quantidade desejada de clipes: ${body.targetCount}.`,
              "",
              "Transcrição com marcas de tempo aproximadas:",
              transcript || "(sem fala detectada — use apenas os quadros de imagem)",
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
          "Você é um editor profissional de cortes virais. Antes de escolher, estude o vídeo inteiro:",
          "identifique o assunto, o ritmo, onde a tensão sobe e onde há começo-meio-fim.",
          "Selecione somente momentos autossuficientes: luta/ação, clímax, discussões e brigas de opinião,",
          "explicações completas de estudo e picos de apresentações/palestras.",
          "Regras: cada clipe entre 15 e 60 segundos; comece 1-2s antes do gancho e termine num ponto de fechamento;",
          "não escolha trechos sobrepostos; ordene por potencial (score de 0 a 100);",
          "descarte introduções, enrolação, silêncio e repetição, mesmo que sobrem menos clipes que o pedido.",
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
