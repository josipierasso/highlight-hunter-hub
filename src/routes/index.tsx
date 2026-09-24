import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Clapperboard,
  Download,
  Film,
  Loader2,
  ShieldAlert,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { Toaster } from "@/components/ui/sonner";
import {
  finalizeClips,
  formatBytes,
  formatClock,
  generateClipCandidates,
  isFiniteDuration,
  mergeChunkTranscripts,
  selectCandidatesForAnalysis,
  type Clip,
  type TranscriptionResult,
} from "@/lib/clip-engine";
import { cutClip, extractAudioChunks, extractFrames, getVideoDuration } from "@/lib/video-engine";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "ClipForge — cortes inteligentes sem nuvem" },
      {
        name: "description",
        content:
          "Envie um vídeo longo, deixe a IA estudar o conteúdo e baixe os melhores cortes verticais. Nada é salvo em servidor.",
      },
      { property: "og:title", content: "ClipForge — cortes inteligentes sem nuvem" },
      {
        property: "og:description",
        content:
          "Análise de ritmo, clímax, discussões e aulas para gerar cortes de 15 a 60 segundos direto no seu navegador.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

type Stage = "idle" | "audio" | "transcribing" | "frames" | "analyzing" | "done";

const CATEGORY_LABEL: Record<string, string> = {
  luta: "Luta / ação",
  climax: "Clímax",
  discussao: "Discussão",
  estudo: "Estudo",
  apresentacao: "Apresentação",
  outro: "Destaque",
};

const CHUNK_SECONDS = 90;
const MAX_FRAMES = 30;

function formatTime(seconds: number) {
  return formatClock(seconds);
}

class AnalysisError extends Error {
  stage: Stage;
  constructor(stage: Stage, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.stage = stage;
  }
}

function stageLabelForError(stage: Stage) {
  switch (stage) {
    case "audio":
      return "extração de áudio";
    case "transcribing":
      return "transcrição";
    case "frames":
      return "leitura das cenas";
    case "analyzing":
      return "análise dos cortes";
    default:
      return "análise";
  }
}

function logStageFailure(stage: Stage, error: unknown, extra?: Record<string, unknown>) {
  console.error("[clip-engine]", {
    stage,
    error: error instanceof Error ? error.message : String(error),
    cause: error instanceof Error ? error.cause : undefined,
    ...extra,
  });
}

function Index() {
  const [file, setFile] = useState<File | null>(null);
  const [duration, setDuration] = useState(0);
  const [stage, setStage] = useState<Stage>("idle");
  const [statusText, setStatusText] = useState("");
  const [progress, setProgress] = useState(0);
  const [overview, setOverview] = useState("");
  const [clips, setClips] = useState<Clip[]>([]);
  const [targetCount, setTargetCount] = useState(8);
  const [rendering, setRendering] = useState<number | null>(null);
  const [renderProgress, setRenderProgress] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const busy = stage !== "idle" && stage !== "done";

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (clips.length || busy) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [clips.length, busy]);

  const pickFile = useCallback(async (picked: File) => {
    setClips([]);
    setOverview("");
    setStage("idle");
    setProgress(0);
    setDuration(0);
    setFile(picked);
    setStatusText("Calculando duração...");
    try {
      const dur = await getVideoDuration(picked);
      if (!isFiniteDuration(dur)) {
        throw new Error("Duração inválida.");
      }
      setDuration(dur);
      setTargetCount(Math.max(3, Math.min(12, Math.round(dur / 300) + 3)));
      setStatusText("");
    } catch (error) {
      logStageFailure("idle", error, {
        name: picked.name,
        type: picked.type,
        size: picked.size,
      });
      setFile(null);
      setDuration(0);
      setStatusText("");
      toast.error("Não conseguimos ler a duração deste vídeo. Use MP4, MOV ou WEBM.");
    }
  }, []);

  const analyze = useCallback(async () => {
    if (!file) return;
    let current: Stage = "audio";
    try {
      if (!isFiniteDuration(duration)) {
        throw new AnalysisError(
          "idle",
          "A duração deste vídeo ainda não foi calculada. Troque o arquivo e tente de novo.",
        );
      }

      setStage("audio");
      setStatusText("Separando o áudio do vídeo no seu computador...");
      setProgress(0);
      let chunks;
      try {
        chunks = await extractAudioChunks(
          file,
          CHUNK_SECONDS,
          (r) => setProgress(Math.round(r * 100)),
          duration,
        );
      } catch (error) {
        throw new AnalysisError("audio", "Não foi possível extrair o áudio deste vídeo.", error);
      }
      if (!chunks.length) {
        throw new AnalysisError("audio", "Este vídeo não tem áudio legível.");
      }

      current = "transcribing";
      setStage("transcribing");
      setStatusText("Ouvindo o vídeo e escrevendo o que é falado...");
      const transcribed: Array<{ start: number; end: number; payload: TranscriptionResult }> = [];
      const concurrency = 3;
      let done = 0;
      for (let i = 0; i < chunks.length; i += concurrency) {
        const batch = chunks.slice(i, i + concurrency);
        const results = await Promise.all(
          batch.map(async (chunk) => {
            const form = new FormData();
            form.append("file", chunk.blob, "chunk.mp3");
            const res = await fetch("/api/transcribe", { method: "POST", body: form });
            const info = (await res.json().catch(() => ({}))) as Partial<TranscriptionResult> & {
              error?: string;
            };
            if (!res.ok) {
              console.error("[clip-engine]", {
                stage: "transcribing",
                status: res.status,
                error: info.error,
                chunkStart: chunk.start,
                chunkEnd: chunk.end,
                chunkBytes: chunk.blob.size,
              });
              throw new AnalysisError(
                "transcribing",
                info.error || "Falha ao transcrever um trecho.",
              );
            }
            return {
              start: chunk.start,
              end: chunk.end,
              payload: {
                text: info.text ?? "",
                segments: info.segments ?? [],
                words: info.words ?? [],
              },
            };
          }),
        );
        transcribed.push(...results);
        done += batch.length;
        setProgress(Math.round((done / chunks.length) * 100));
      }

      const segments = mergeChunkTranscripts(transcribed, duration);
      const pool = generateClipCandidates(segments, duration);
      const candidates = selectCandidatesForAnalysis(pool, targetCount);
      console.info("[clip-engine]", {
        stage: "candidates",
        duration,
        chunks: chunks.length,
        segments: segments.length,
        pool: pool.length,
        candidates: candidates.length,
      });

      current = "frames";
      setStage("frames");
      setStatusText("Olhando as cenas do vídeo...");
      setProgress(0);
      const count = Math.min(MAX_FRAMES, Math.max(6, Math.round(duration / 60)));
      const times = Array.from({ length: count }, (_, i) =>
        Math.round(((i + 0.5) * duration) / count),
      );
      let frames: Array<{ time: number; dataUrl: string }>;
      try {
        frames = await extractFrames(file, times);
      } catch (error) {
        throw new AnalysisError("frames", "Não foi possível ler as cenas deste vídeo.", error);
      }
      setProgress(100);

      current = "analyzing";
      setStage("analyzing");
      setStatusText("Estudando ritmo, clímax e contexto para escolher os cortes...");
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          duration,
          targetCount,
          segments,
          candidates: candidates.map(({ start, end, text }) => ({ start, end, text })),
          frames,
        }),
      });
      const info = (await res.json().catch(() => ({}))) as {
        error?: string;
        overview?: string;
        clips?: Clip[];
      };
      if (!res.ok) {
        console.error("[clip-engine]", {
          stage: "analyzing",
          status: res.status,
          error: info.error,
          duration,
          candidates: candidates.length,
          frames: frames.length,
        });
        throw new AnalysisError("analyzing", info.error || "A análise falhou.");
      }
      const valid = finalizeClips(info.clips || [], candidates, duration, targetCount);
      setOverview(info.overview || "");
      setClips(valid);
      setStage("done");
      toast.success(`${valid.length} cortes prontos para baixar.`);
    } catch (error) {
      const failed = error instanceof AnalysisError ? error.stage : current;
      logStageFailure(failed, error, {
        duration,
        size: file.size,
        type: file.type,
        name: file.name,
      });
      setStage("idle");
      toast.error("Não foi possível analisar este vídeo.", {
        description: `Etapa: ${stageLabelForError(failed)}`,
      });
    }
  }, [duration, file, targetCount]);

  const download = useCallback(
    async (clip: Clip, index: number, vertical: boolean) => {
      if (!file) return;
      setRendering(index);
      setRenderProgress(0);
      try {
        const blob = await cutClip(file, clip.start, clip.end, vertical, (r) =>
          setRenderProgress(Math.round(r * 100)),
        );
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${clip.title.replace(/[^\p{L}\p{N} -]/gu, "").slice(0, 60) || "corte"}${
          vertical ? "-9x16" : ""
        }.mp4`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      } catch {
        toast.error("Não foi possível gerar esse corte.");
      } finally {
        setRendering(null);
      }
    },
    [file],
  );

  const stageLabel = useMemo(
    () =>
      ({
        idle: "",
        audio: "1 de 4 · áudio",
        transcribing: "2 de 4 · transcrição",
        frames: "3 de 4 · cenas",
        analyzing: "4 de 4 · análise",
        done: "concluído",
      })[stage],
    [stage],
  );

  return (
    <main className="min-h-screen bg-background text-foreground">
      <Toaster />
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_top,_var(--glow),transparent_60%)]" />

      <div className="relative mx-auto max-w-5xl px-5 py-12 md:py-20">
        <header className="flex flex-col gap-4">
          <Badge variant="outline" className="w-fit gap-2 border-primary/40 text-primary">
            <ShieldAlert className="size-3.5" />
            Nada é salvo em servidor
          </Badge>
          <h1 className="font-display text-4xl leading-tight tracking-tight md:text-6xl">
            Corte o que importa
            <span className="block text-primary">antes da sessão acabar</span>
          </h1>
          <p className="max-w-2xl text-muted-foreground">
            A IA estuda seu vídeo inteiro — ritmo, clímax, brigas, explicações e picos de palco — e
            separa os melhores momentos em cortes de 15 a 60 segundos. Tudo é processado no seu
            navegador: se atualizar a página, os cortes desaparecem.
          </p>
        </header>

        <section className="mt-10 rounded-3xl border border-border bg-card/70 p-6 shadow-[var(--shadow-panel)] backdrop-blur md:p-8">
          {!file ? (
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="flex w-full flex-col items-center gap-3 rounded-2xl border border-dashed border-border px-6 py-14 transition-colors hover:border-primary/60 hover:bg-primary/5"
            >
              <Upload className="size-7 text-primary" />
              <span className="font-display text-lg">Escolher vídeo longo</span>
              <span className="text-sm text-muted-foreground">
                MP4, MOV ou WEBM · o arquivo nunca sai do seu dispositivo
              </span>
            </button>
          ) : (
            <div className="flex flex-col gap-6">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <span className="grid size-11 place-items-center rounded-xl bg-primary/15 text-primary">
                    <Film className="size-5" />
                  </span>
                  <div>
                    <p className="font-medium">{file.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {isFiniteDuration(duration)
                        ? `${formatTime(duration)} · ${formatBytes(file.size)}`
                        : `Calculando duração... · ${formatBytes(file.size)}`}
                    </p>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setFile(null);
                    setClips([]);
                    setOverview("");
                  }}
                >
                  <X className="size-4" /> Trocar
                </Button>
              </div>

              <div className="grid gap-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Quantidade de cortes desejada</span>
                  <span className="font-medium text-primary">{targetCount}</span>
                </div>
                <Slider
                  value={[targetCount]}
                  min={3}
                  max={15}
                  step={1}
                  disabled={busy}
                  onValueChange={([v]) => setTargetCount(v ?? targetCount)}
                />
              </div>

              <Button
                size="lg"
                onClick={analyze}
                disabled={busy || !isFiniteDuration(duration)}
                className="w-full md:w-fit"
              >
                {busy ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Sparkles className="size-4" />
                )}
                {busy ? "Analisando..." : "Analisar e separar os melhores cortes"}
              </Button>

              {busy && (
                <div className="grid gap-2 rounded-2xl border border-border bg-background/60 p-4">
                  <div className="flex items-center justify-between text-sm">
                    <span>{statusText}</span>
                    <span className="text-muted-foreground">{stageLabel}</span>
                  </div>
                  <Progress value={stage === "analyzing" ? undefined : progress} />
                  <p className="text-xs text-muted-foreground">
                    Vídeos longos levam alguns minutos. Mantenha esta aba aberta.
                  </p>
                </div>
              )}
            </div>
          )}
          <input
            ref={inputRef}
            type="file"
            accept="video/*"
            hidden
            onChange={(e) => {
              const picked = e.target.files?.[0];
              if (picked) void pickFile(picked);
              e.target.value = "";
            }}
          />
        </section>

        {overview && (
          <section className="mt-8 rounded-3xl border border-border bg-card/50 p-6">
            <h2 className="font-display text-lg">Estudo do vídeo</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{overview}</p>
          </section>
        )}

        {clips.length > 0 && (
          <section className="mt-8 grid gap-4">
            <div className="flex items-center gap-2">
              <Clapperboard className="size-5 text-primary" />
              <h2 className="font-display text-xl">Cortes sugeridos</h2>
            </div>
            {clips.map((clip, index) => (
              <article
                key={`${clip.start}-${index}`}
                className="rounded-2xl border border-border bg-card/70 p-5 transition-colors hover:border-primary/40"
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="max-w-2xl">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge className="bg-primary/15 text-primary hover:bg-primary/20">
                        {CATEGORY_LABEL[clip.category] ?? CATEGORY_LABEL["outro"]}
                      </Badge>
                      <span className="text-sm text-muted-foreground">
                        {formatTime(clip.start)} → {formatTime(clip.end)} ·{" "}
                        {Math.round(clip.end - clip.start)}s
                      </span>
                      <span className="text-sm font-medium text-primary">{clip.score}/100</span>
                    </div>
                    <h3 className="mt-3 font-display text-lg">{clip.title}</h3>
                    {clip.hook && (
                      <p className="mt-1 text-sm italic text-muted-foreground">“{clip.hook}”</p>
                    )}
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                      {clip.reason}
                    </p>
                  </div>
                  <div className="flex flex-col gap-2">
                    <Button
                      onClick={() => void download(clip, index, true)}
                      disabled={rendering !== null}
                    >
                      {rendering === index ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Download className="size-4" />
                      )}
                      {rendering === index ? `${renderProgress}%` : "Baixar 9:16"}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => void download(clip, index, false)}
                      disabled={rendering !== null}
                    >
                      Baixar original
                    </Button>
                  </div>
                </div>
              </article>
            ))}
            <p className="text-center text-xs text-muted-foreground">
              Baixe antes de fechar ou atualizar: os cortes existem somente nesta sessão.
            </p>
          </section>
        )}
      </div>
    </main>
  );
}
