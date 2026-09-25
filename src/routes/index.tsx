import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Clapperboard,
  Download,
  FileText,
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
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Toaster } from "@/components/ui/sonner";
import {
  CATEGORY_LABEL,
  finalizeClips,
  formatBytes,
  formatClock,
  generateClipCandidates,
  groupClipsByCategory,
  isFiniteDuration,
  MAX_VIDEO_SECONDS,
  mergeCandidatePools,
  mergeChunkTranscripts,
  normalizeCategory,
  sampleTranscript,
  selectCandidatesForAnalysis,
  type Clip,
  type TranscriptionResult,
} from "@/lib/clip-engine";
import {
  alignScreenplayToTranscript,
  candidatesFromScreenplay,
  extractScreenplayFromTranscript,
  guessFilmTitle,
  parseScreenplay,
  readScreenplayFile,
  summarizeScreenplay,
  type ScreenplayScene,
} from "@/lib/screenplay";
import { cutClip, extractAudioChunks, extractFrames, getVideoDuration } from "@/lib/video-engine";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "ClipForge — cortes inteligentes sem nuvem" },
      {
        name: "description",
        content:
          "Envie um filme de até 2 horas. A IA monta o roteiro a partir da fala e separa ação, luta e romance para baixar.",
      },
      { property: "og:title", content: "ClipForge — cortes inteligentes sem nuvem" },
      {
        property: "og:description",
        content:
          "Transcrição, roteiro extraído da fala e cortes de 15 a 90 segundos por categoria, direto no navegador.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

type Stage = "idle" | "audio" | "transcribing" | "frames" | "analyzing" | "done";

const CHUNK_SECONDS = 90;
const MAX_FRAMES = 30;
const ALL_CATEGORIES = "todas";

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
  const [scriptName, setScriptName] = useState("");
  const [scriptText, setScriptText] = useState("");
  const [scriptScenes, setScriptScenes] = useState<ScreenplayScene[]>([]);
  const [filmTitle, setFilmTitle] = useState("");
  const [extractedScenes, setExtractedScenes] = useState<ScreenplayScene[]>([]);
  const [categoryFilter, setCategoryFilter] = useState<string>(ALL_CATEGORIES);
  const [batching, setBatching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const scriptRef = useRef<HTMLInputElement>(null);

  const busy = stage !== "idle" && stage !== "done";
  const grouped = useMemo(() => groupClipsByCategory(clips), [clips]);
  const visibleClips = useMemo(() => {
    if (categoryFilter === ALL_CATEGORIES) return clips;
    return clips.filter((clip) => clip.category === categoryFilter);
  }, [clips, categoryFilter]);

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
    setCategoryFilter(ALL_CATEGORIES);
    setExtractedScenes([]);
    setFilmTitle((current) => current.trim() || guessFilmTitle(picked.name));
    setStatusText("Calculando duração...");
    try {
      const dur = await getVideoDuration(picked);
      if (!isFiniteDuration(dur)) {
        throw new Error("Duração inválida.");
      }
      if (dur > MAX_VIDEO_SECONDS + 30) {
        throw new Error("Este arquivo passa de 2 horas.");
      }
      setDuration(dur);
      setTargetCount(Math.max(6, Math.min(24, Math.round(dur / 240) + 4)));
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
      const message =
        error instanceof Error && error.message.includes("2 horas")
          ? "Este vídeo passa de 2 horas. Envie um arquivo de até 02:00:00."
          : "Não conseguimos ler a duração deste vídeo. Use MP4, MOV ou WEBM.";
      toast.error(message);
    }
  }, []);

  const pickScript = useCallback(async (picked: File) => {
    try {
      const raw = await readScreenplayFile(picked);
      const parsed = parseScreenplay(raw);
      setScriptName(picked.name);
      setScriptText(raw);
      setScriptScenes(parsed.scenes);
      toast.success(
        parsed.scenes.length
          ? `${parsed.scenes.length} cenas lidas no roteiro.`
          : "Roteiro carregado.",
      );
    } catch (error) {
      setScriptName("");
      setScriptText("");
      setScriptScenes([]);
      toast.error(error instanceof Error ? error.message : "Não foi possível ler o roteiro.");
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
      if (duration > MAX_VIDEO_SECONDS + 30) {
        throw new AnalysisError("idle", "Este vídeo passa de 2 horas.");
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
      const fromSpeechScenes = extractScreenplayFromTranscript(segments, duration);
      setExtractedScenes(fromSpeechScenes.scenes);
      const sourceScenes = scriptScenes.length ? scriptScenes : fromSpeechScenes.scenes;
      const alignedScenes = alignScreenplayToTranscript(sourceScenes, segments, duration);
      const fromSpeech = generateClipCandidates(segments, duration);
      const fromScript = candidatesFromScreenplay(alignedScenes, duration);
      const pool = mergeCandidatePools(fromScript, fromSpeech);
      const candidates = selectCandidatesForAnalysis(pool, targetCount);
      console.info("[clip-engine]", {
        stage: "candidates",
        duration,
        chunks: chunks.length,
        segments: segments.length,
        scenes: alignedScenes.length,
        extracted: fromSpeechScenes.scenes.length,
        attachedScript: scriptScenes.length,
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
      setStatusText(
        scriptScenes.length
          ? "Lendo o roteiro anexado e separando as cenas..."
          : "Montando o roteiro a partir da fala e separando as cenas...",
      );
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          duration,
          targetCount,
          filmTitle: filmTitle.trim(),
          segments: sampleTranscript(segments, 400),
          candidates: candidates.map((candidate) => ({
            start: candidate.start,
            end: candidate.end,
            text: candidate.text,
            ...(candidate.source ? { source: candidate.source } : {}),
            ...(candidate.heading ? { heading: candidate.heading } : {}),
            ...(candidate.categoryHint ? { categoryHint: candidate.categoryHint } : {}),
          })),
          frames,
          screenplay:
            summarizeScreenplay(alignedScenes) ||
            scriptText.slice(0, 18000) ||
            fromSpeechScenes.text.slice(0, 18000),
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
      setCategoryFilter(ALL_CATEGORIES);
      setStage("done");
      toast.success(`${valid.length} cortes prontos, agrupados por cena.`);
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
  }, [duration, file, filmTitle, scriptScenes, scriptText, targetCount]);

  const saveBlob = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  const fileNameFor = (clip: Clip, vertical: boolean) => {
    const slug = clip.title.replace(/[^\p{L}\p{N} -]/gu, "").slice(0, 50) || "corte";
    const cat = CATEGORY_LABEL[normalizeCategory(clip.category)];
    return `${cat}-${slug}${vertical ? "-9x16" : ""}.mp4`;
  };

  const download = useCallback(
    async (clip: Clip, index: number, vertical: boolean) => {
      if (!file) return;
      setRendering(index);
      setRenderProgress(0);
      try {
        const blob = await cutClip(file, clip.start, clip.end, vertical, (r) =>
          setRenderProgress(Math.round(r * 100)),
        );
        saveBlob(blob, fileNameFor(clip, vertical));
      } catch {
        toast.error("Não foi possível gerar esse corte.");
      } finally {
        setRendering(null);
      }
    },
    [file],
  );

  const downloadVisible = useCallback(
    async (vertical: boolean) => {
      if (!file || !visibleClips.length) return;
      setBatching(true);
      try {
        for (let i = 0; i < visibleClips.length; i++) {
          const clip = visibleClips[i];
          if (!clip) continue;
          setRendering(i);
          setRenderProgress(0);
          const blob = await cutClip(file, clip.start, clip.end, vertical, (r) =>
            setRenderProgress(Math.round(r * 100)),
          );
          saveBlob(blob, fileNameFor(clip, vertical));
        }
        toast.success(`${visibleClips.length} cortes baixados.`);
      } catch {
        toast.error("A geração em lote parou em um dos cortes.");
      } finally {
        setBatching(false);
        setRendering(null);
      }
    },
    [file, visibleClips],
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
            Envie um filme de até 2 horas. A IA transcreve a fala, monta o roteiro a partir dela e
            separa ação, luta, romance, clímax e outros momentos. O título do filme é só contexto —
            nenhum roteiro é baixado da internet. Nada é salvo em servidor.
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
              <span className="font-display text-lg">Escolher filme de até 2 horas</span>
              <span className="text-sm text-muted-foreground">
                MP4, MOV ou WEBM · o roteiro sai da fala; TXT anexado continua opcional
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
                    setCategoryFilter(ALL_CATEGORIES);
                    setExtractedScenes([]);
                  }}
                >
                  <X className="size-4" /> Trocar
                </Button>
              </div>

              <div className="grid gap-2">
                <label className="text-sm text-muted-foreground" htmlFor="film-title">
                  Título do filme (contexto, sem busca na internet)
                </label>
                <Input
                  id="film-title"
                  value={filmTitle}
                  disabled={busy}
                  maxLength={120}
                  placeholder="Ex.: Cidade de Deus"
                  onChange={(event) => setFilmTitle(event.target.value)}
                />
              </div>

              <div className="rounded-2xl border border-dashed border-border p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span className="grid size-10 place-items-center rounded-xl bg-secondary text-primary">
                      <FileText className="size-4" />
                    </span>
                    <div>
                      <p className="text-sm font-medium">
                        {scriptName
                          ? scriptName
                          : extractedScenes.length
                            ? `Roteiro extraído da fala · ${extractedScenes.length} cenas`
                            : "Roteiro extraído da fala (TXT anexado é opcional)"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {scriptScenes.length
                          ? `${scriptScenes.length} cenas anexadas · o título só classifica, não baixa roteiro`
                          : "O roteiro é montado com a transcrição deste vídeo"}
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    {scriptName ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          setScriptName("");
                          setScriptText("");
                          setScriptScenes([]);
                        }}
                      >
                        <X className="size-4" /> Remover
                      </Button>
                    ) : null}
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => scriptRef.current?.click()}
                    >
                      {scriptName ? "Trocar TXT" : "Anexar TXT"}
                    </Button>
                  </div>
                </div>
              </div>

              <div className="grid gap-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Quantidade de cortes desejada</span>
                  <span className="font-medium text-primary">{targetCount}</span>
                </div>
                <Slider
                  value={[targetCount]}
                  min={4}
                  max={30}
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
                {busy ? "Analisando..." : "Ler cenas e separar os cortes"}
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
          <input
            ref={scriptRef}
            type="file"
            accept=".txt,.fountain,.md,text/plain"
            hidden
            onChange={(e) => {
              const picked = e.target.files?.[0];
              if (picked) void pickScript(picked);
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
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Clapperboard className="size-5 text-primary" />
                <h2 className="font-display text-xl">Cenas separadas</h2>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={batching || rendering !== null || !visibleClips.length}
                  onClick={() => void downloadVisible(false)}
                >
                  {batching ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Download className="size-4" />
                  )}
                  Baixar visíveis
                </Button>
                <Button
                  size="sm"
                  disabled={batching || rendering !== null || !visibleClips.length}
                  onClick={() => void downloadVisible(true)}
                >
                  Baixar visíveis 9:16
                </Button>
              </div>
            </div>
            <Tabs value={categoryFilter} onValueChange={setCategoryFilter}>
              <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1">
                <TabsTrigger value={ALL_CATEGORIES}>Todas ({clips.length})</TabsTrigger>
                {grouped.map((group) => (
                  <TabsTrigger key={group.category} value={group.category}>
                    {CATEGORY_LABEL[group.category]} ({group.clips.length})
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            {visibleClips.map((clip, index) => (
              <article
                key={`${clip.start}-${clip.category}-${index}`}
                className="rounded-2xl border border-border bg-card/70 p-5 transition-colors hover:border-primary/40"
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="max-w-2xl">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge className="bg-primary/15 text-primary hover:bg-primary/20">
                        {CATEGORY_LABEL[normalizeCategory(clip.category)]}
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
                      disabled={rendering !== null || batching}
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
                      disabled={rendering !== null || batching}
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
