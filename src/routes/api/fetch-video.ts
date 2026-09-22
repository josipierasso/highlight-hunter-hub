import { createFileRoute } from "@tanstack/react-router";

const MAX_BYTES = 400 * 1024 * 1024;

const BLOCKED_HOSTS = [
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "metadata.google.internal",
  "169.254.169.254",
];

const PLATFORM_HOSTS = [
  "youtube.com",
  "youtu.be",
  "m.youtube.com",
  "music.youtube.com",
  "tiktok.com",
  "instagram.com",
  "facebook.com",
  "twitch.tv",
  "x.com",
  "twitter.com",
  "kick.com",
];

function isPrivate(hostname: string) {
  if (BLOCKED_HOSTS.includes(hostname)) return true;
  if (hostname.endsWith(".local") || hostname.endsWith(".internal")) return true;
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname);
}

export const Route = createFileRoute("/api/fetch-video")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const target = new URL(request.url).searchParams.get("url");
        if (!target) {
          return Response.json({ error: "Informe o link do vídeo." }, { status: 400 });
        }

        let parsed: URL;
        try {
          parsed = new URL(target);
        } catch {
          return Response.json({ error: "Esse link não é válido." }, { status: 400 });
        }

        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
          return Response.json({ error: "Use um link http ou https." }, { status: 400 });
        }
        if (isPrivate(parsed.hostname)) {
          return Response.json({ error: "Esse endereço não é permitido." }, { status: 400 });
        }

        const host = parsed.hostname.replace(/^www\./, "");
        if (PLATFORM_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
          return Response.json(
            {
              error:
                "Links de YouTube e redes sociais são protegidos e não podem ser baixados por aqui. Baixe o vídeo com um app de download e envie o arquivo, ou cole o link direto de um arquivo .mp4 (Drive público, Dropbox, servidor próprio).",
            },
            { status: 422 },
          );
        }

        const upstream = await fetch(parsed.toString(), {
          headers: { Accept: "video/*,*/*" },
          redirect: "follow",
        }).catch(() => null);

        if (!upstream || !upstream.ok || !upstream.body) {
          return Response.json(
            { error: "Não conseguimos abrir esse link. Ele precisa ser público e direto." },
            { status: 502 },
          );
        }

        const type = upstream.headers.get("content-type") ?? "";
        if (!type.startsWith("video/") && !type.includes("octet-stream")) {
          return Response.json(
            { error: "O link não aponta para um arquivo de vídeo." },
            { status: 415 },
          );
        }

        const length = Number(upstream.headers.get("content-length") ?? 0);
        if (length > MAX_BYTES) {
          return Response.json(
            { error: "Esse vídeo passa de 400 MB. Use um arquivo menor." },
            { status: 413 },
          );
        }

        return new Response(upstream.body, {
          headers: {
            "Content-Type": type.startsWith("video/") ? type : "video/mp4",
            ...(length ? { "Content-Length": String(length) } : {}),
            "Cache-Control": "no-store",
          },
        });
      },
    },
  },
});
