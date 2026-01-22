import React, { useEffect, useMemo, useState } from "react";
import type { GeneratedFileDTO, GranularityPreset, LanguageCode, ModelId, SubtitleFormat } from "../shared/ipc/dtos";
import type { SegmentPreviewDTO } from "../shared/ipc/dtos";

import "./App.css";

function baseNameFromFile(name: string) {
    const i = name.lastIndexOf(".");
    return i > 0 ? name.slice(0, i) : name;
}

function sanitizeBaseName(input: string) {
    const trimmed = input.trim();
    const cleaned = trimmed.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "");
    return cleaned.replace(/\s+/g, " ").trim();
}

type StepKey = "IDLE" | "PREPARING" | "TRANSCRIBING" | "CONVERTING" | "SAVING" | "DONE" | "ERROR";

const STEPS: { key: StepKey; label: string }[] = [
    { key: "PREPARING", label: "Preparando" },
    { key: "TRANSCRIBING", label: "Transcrevendo" },
    { key: "CONVERTING", label: "Convertendo" },
    { key: "SAVING", label: "Salvando" },
    { key: "DONE", label: "Concluído" }
];

export default function App() {
    // Anti-tela-branca: se preload falhar, não explode o app
    if (!window.api) {
        return (
            <div style={styles.page}>
                <h1 style={{ margin: "4px 0 14px" }}>Legenda (MVP)</h1>
                <div style={styles.card}>
                    <h2 style={styles.h2}>Inicializando integração…</h2>
                    <p style={{ marginTop: 8, color: "#555", lineHeight: 1.4 }}>
                        O preload/IPC não carregou. Isso normalmente acontece quando o preload falha em runtime.
                    </p>
                    <p style={{ marginTop: 8, color: "#555", lineHeight: 1.4 }}>
                        Abra o DevTools (Ctrl+Shift+I) e verifique erros de preload.
                    </p>
                </div>
            </div>
        );
    }

    const [audio, setAudio] = useState<{ path: string; name: string } | null>(null);

    const [language, setLanguage] = useState<LanguageCode>("pt");
    const [modelId, setModelId] = useState<ModelId>("small");
    const [format, setFormat] = useState<SubtitleFormat>("srt");

    const [outputPath, setOutputPath] = useState<string>("");
    const [busy, setBusy] = useState(false);

    const [step, setStep] = useState<StepKey>("IDLE");
    const [message, setMessage] = useState<string>("");

    const [preview, setPreview] = useState<SegmentPreviewDTO[]>([]);
    const [generated, setGenerated] = useState<GeneratedFileDTO[]>([]);
    const [selectedId, setSelectedId] = useState<string>("");

    const [menuOpenForId, setMenuOpenForId] = useState<string>("");

    const [granularity, setGranularity] = useState<GranularityPreset>("MEDIUM");

    const [hoveredCueIndex, setHoveredCueIndex] = useState<number | null>(null);

    const [previewMeta, setPreviewMeta] = useState<{ granularity: GranularityPreset } | null>(null);


    async function copyToClipboard(text: string) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            // fallback simples
            try {
                const ta = document.createElement("textarea");
                ta.value = text;
                ta.style.position = "fixed";
                ta.style.left = "-9999px";
                ta.style.top = "-9999px";
                document.body.appendChild(ta);
                ta.focus();
                ta.select();
                const ok = document.execCommand("copy");
                document.body.removeChild(ta);
                return ok;
            } catch {
                return false;
            }
        }
    }

    function buildPreviewBlockText(cues: typeof preview) {
        // Formato simples e útil para colar em editor/chat:
        // mm:ss --> mm:ss
        // texto
        return cues
            .map((c) => `${formatMs(c.startMs)} --> ${formatMs(c.endMs)}\n${c.text}`)
            .join("\n\n");
    }

    function CopyIcon({ size = 16 }: { size?: number }) {
        return (
            <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
                <path
                    d="M16 1H6a2 2 0 0 0-2 2v12h2V3h10V1zm3 4H10a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H10V7h9v14z"
                    fill="currentColor"
                />
            </svg>
        );
    }

    const MENU_W = 200;
    const MENU_PAD = 10;

    const [menu, setMenu] = useState<{
        id: string;
        anchor: DOMRect; // posição do botão na tela
    } | null>(null);

    const [audioUrl, setAudioUrl] = useState<string>("");

    useEffect(() => {
        function onDocClick() {
            if (menuOpenForId) setMenuOpenForId("");
        }
        window.addEventListener("click", onDocClick);
        return () => window.removeEventListener("click", onDocClick);
    }, [menuOpenForId]);

    // Busca na lista
    const [query, setQuery] = useState("");
    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return generated;
        return generated.filter((g) => g.fileName.toLowerCase().includes(q));
    }, [generated, query]);

    // Modal renomear
    const [renameOpen, setRenameOpen] = useState(false);
    const [renameValue, setRenameValue] = useState("");

    const selected = useMemo(() => generated.find((g) => g.id === selectedId) || null, [generated, selectedId]);

    const canChooseOutput = !!audio && !busy;
    const canGenerate = !!audio && !!outputPath && !busy;

    const disabledReason = useMemo(() => {
        if (busy) return "Processando...";
        if (!audio) return "Selecione um áudio";
        if (!outputPath) return "Escolha onde salvar";
        return "";
    }, [busy, audio, outputPath]);

    async function refreshGenerated(selectId?: string) {
        const res = await window.api.listGeneratedFiles();
        if (res.ok) {
            setGenerated(res.items);
            if (selectId) setSelectedId(selectId);
            else if (res.items.length > 0 && !selectedId) setSelectedId(res.items[0].id);
        }
    }

    useEffect(() => {
        refreshGenerated();

        const off1 = window.api.onJobProgress((e) => {
            setStep((e.step as StepKey) ?? "IDLE");
            setMessage(e.message || "");
            setPreviewMeta({ granularity });
        });

        const off2 = window.api.onJobDone((e) => {
            setBusy(false);
            setStep("DONE");
            setMessage("Concluído.");
            setPreview(e.preview);
            refreshGenerated(e.generated.id);
        });

        const off3 = window.api.onJobError((e) => {
            setBusy(false);
            setStep("ERROR");
            setMessage(e.error.message || "Erro.");
        });

        const off4 = window.api.onGeneratedChanged(() => refreshGenerated());

        return () => {
            off1();
            off2();
            off3();
            off4();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (!menu) return;

        const close = () => setMenu(null);

        const onMouseDown = (e: MouseEvent) => {
            // clique fora fecha; clique dentro do menu não (vamos parar no container)
            close();
        };

        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") close();
        };

        const onResize = () => close();
        const onScroll = () => close();

        window.addEventListener("mousedown", onMouseDown);
        window.addEventListener("keydown", onKeyDown);
        window.addEventListener("resize", onResize);
        window.addEventListener("scroll", onScroll, true); // true = captura scroll em qualquer container

        return () => {
            window.removeEventListener("mousedown", onMouseDown);
            window.removeEventListener("keydown", onKeyDown);
            window.removeEventListener("resize", onResize);
            window.removeEventListener("scroll", onScroll, true);
        };
    }, [menu]);

    function clamp(n: number, min: number, max: number) {
        return Math.max(min, Math.min(max, n));
    }

    async function pickAudio() {
        const res = await window.api.pickAudio();
        if (!res.ok) return;
        setAudio(res.file);
        setOutputPath("");
        setPreview([]);
        setStep("IDLE");
        setMessage(`Selecionado: ${res.file.name}`);

        const u = await window.api.getFileUrl(res.file.path);
        if (u.ok) setAudioUrl(u.url);
        else setAudioUrl("");
    }

    async function chooseOutput() {
        if (!audio) return;
        const suggestedBaseName = baseNameFromFile(audio.name);
        const res = await window.api.chooseOutputPath({ suggestedBaseName, format });
        if (!res.ok) return;
        setOutputPath(res.path);
    }

    async function start() {
        if (!audio) return;

        // UX: se o usuário clicar gerar sem outputPath, abre o dialog ao invés de só desabilitar
        if (!outputPath) {
            await chooseOutput();
            return;
        }

        setBusy(true);
        setPreview([]);
        setStep("PREPARING");
        setMessage("Iniciando...");

        await window.api.startJob({
            audioPath: audio.path,
            outputPath,
            language,
            modelId,
            format,
            granularity
        });
    }

    // Ações por item
    async function openFile(id: string) {
        await window.api.openGeneratedFile({ id });
    }
    async function showInFolder(id: string) {
        await window.api.showInFolder({ id });
    }

    function openRenameModal(id: string) {
        const item = generated.find((g) => g.id === id);
        if (!item) return;
        setRenameValue(baseNameFromFile(item.fileName));
        setSelectedId(id);
        setRenameOpen(true);
    }

    const renameValidation = useMemo(() => {
        const v = sanitizeBaseName(renameValue);
        if (!v) return { ok: false, msg: "Informe um nome." };
        if (v.length > 120) return { ok: false, msg: "Nome muito longo." };
        return { ok: true, msg: "" };
    }, [renameValue]);

    async function confirmRename() {
        if (!selected) return;
        const v = sanitizeBaseName(renameValue);
        if (!v) return;

        try {
            const res = await window.api.renameGeneratedFile({ id: selected.id, newBaseName: v });
            if (res.ok) {
                setRenameOpen(false);
                await refreshGenerated(res.item.id);
            }
        } catch (e: any) {
            alert(e?.message || String(e));
        }
    }

    async function deleteItem(id: string) {
        const item = generated.find((g) => g.id === id);
        if (!item) return;

        const ok = confirm(`Apagar do disco?\n\n${item.fileName}\n\nEssa ação não pode ser desfeita.`);
        if (!ok) return;

        try {
            await window.api.deleteGeneratedFile({ id });
            if (selectedId === id) setSelectedId("");
            await refreshGenerated();
        } catch (e: any) {
            alert(e?.message || String(e));
        }
    }

    async function removeFromHistoryOnly(id: string) {
        // Atalho: se o arquivo não existe, a ação mais útil é remover do histórico.
        // Reaproveitando deleteGeneratedFile (já remove do store) — ele tenta unlink se existir.
        await window.api.deleteGeneratedFile({ id });
        if (selectedId === id) setSelectedId("");
        await refreshGenerated();
    }

    const stepIndex = useMemo(() => {
        const idx = STEPS.findIndex((s) => s.key === step);
        return idx;
    }, [step]);

    function flowColors(state: "idle" | "current" | "done" | "error") {
        // tons pastéis
        if (state === "idle") return { bg: "#f6f6f6", border: "#e6e6e6", text: "#777", line: "#e8e8e8" };
        if (state === "current") return { bg: "#eeeeee", border: "#d6d6d6", text: "#444", line: "#d6d6d6" };
        if (state === "done") return { bg: "#e9f6ee", border: "#bfe6cc", text: "#2f6b3f", line: "#bfe6cc" };
        return { bg: "#fdecec", border: "#f2b8b8", text: "#8a1f1f", line: "#f2b8b8" };
    }

    // Mapeia step atual para índice do fluxo
    const flowIndex = useMemo(() => {
        if (step === "IDLE") return -1;
        const idx = STEPS.findIndex((s) => s.key === step);
        return idx;
    }, [step]);

    function formatMs(ms: number) {
        const s = Math.floor(ms / 1000);
        const m = Math.floor(s / 60);
        const r = s % 60;
        return `${m}:${String(r).padStart(2, "0")}`;
    }

    const GRANULARITY_INFO: Record<GranularityPreset, { title: string; desc: string }> = {
        LOW: { title: "Baixa (mais denso)", desc: "Menos quebras. Blocos maiores, leitura mais contínua." },
        MEDIUM: { title: "Média (equilibrado)", desc: "Equilíbrio entre legibilidade e ritmo. Bom padrão geral." },
        HIGH: { title: "Alta (mais fragmentado)", desc: "Mais quebras. Melhor para fala rápida e cortes." },
        ULTRA: { title: "Altíssima (bem picado)", desc: "Muito fragmentado. Ideal para estilo Shorts/TikTok." },
    };

    function countWords(t: string) {
        const s = t.trim();
        if (!s) return 0;
        return s.split(/\s+/).filter(Boolean).length;
    }

    const previewStats = useMemo(() => {
        if (!preview.length) return null;

        const maxEndMs = Math.max(...preview.map((c) => c.endMs));
        const durationSec = Math.max(0.1, maxEndMs / 1000);

        const charsPerCue = preview.map((c) => c.text.replace(/\s+/g, " ").trim().length);
        const wordsPerCue = preview.map((c) => countWords(c.text));

        const totalChars = charsPerCue.reduce((a, b) => a + b, 0);
        const totalWords = wordsPerCue.reduce((a, b) => a + b, 0);

        const avgCharsPerCue = totalChars / preview.length;
        const avgWordsPerCue = totalWords / preview.length;

        const maxCharsPerCue = Math.max(...charsPerCue);
        const maxWordsPerCue = Math.max(...wordsPerCue);

        const cps = totalChars / durationSec;

        const veryShortCount = charsPerCue.filter((n) => n > 0 && n < 8).length;
        const veryShortRate = veryShortCount / preview.length;

        return {
            cues: preview.length,
            durationSec,
            totalChars,
            totalWords,
            cps,
            avgCharsPerCue,
            avgWordsPerCue,
            maxCharsPerCue,
            maxWordsPerCue,
            veryShortRate,
        };
    }, [preview]);

    const densityAlerts = useMemo(() => {
        if (!previewStats) return [];
        const a: { level: "warn" | "danger"; text: string }[] = [];

        if (previewStats.cps > 22) a.push({ level: "danger", text: `CPS muito alto (${previewStats.cps.toFixed(1)}). Legendas podem ficar rápidas demais.` });
        else if (previewStats.cps > 18) a.push({ level: "warn", text: `CPS alto (${previewStats.cps.toFixed(1)}). Considere granularidade maior ou revisão manual.` });

        if (previewStats.maxCharsPerCue > 100) a.push({ level: "warn", text: `Há blocos muito longos (máx. ${previewStats.maxCharsPerCue} chars).` });

        if (previewStats.veryShortRate > 0.35) a.push({ level: "warn", text: `Muitos blocos muito curtos (${Math.round(previewStats.veryShortRate * 100)}%). Pode ficar “picado”.` });

        return a;
    }, [previewStats]);

    const isPreviewStale = useMemo(() => {
        if (!preview.length) return false;
        if (!previewMeta) return false;
        return previewMeta.granularity !== granularity;
    }, [preview.length, previewMeta, granularity]);

    return (
        <div style={styles.page}>
            <h1 style={{ margin: "4px 0 14px" }}>Legenda (MVP)</h1>

            <div style={styles.grid2}>
                {/* Configuração */}
                <div style={styles.card}>
                    <h2 style={styles.h2}>Configuração</h2>

                    <section style={styles.section}>
                        <div style={styles.label}>Arquivo de áudio</div>
                        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                            <button onClick={pickAudio} disabled={busy}>
                                Selecionar áudio
                            </button>
                            <div style={{ color: "#444" }}>{audio ? audio.name : "Nenhum arquivo selecionado"}</div>
                        </div>
                        {audio && audioUrl && (
                            <div style={{ marginTop: 10 }}>
                                <audio controls src={audioUrl} style={{ width: "100%" }} />
                            </div>
                        )}
                    </section>

                    <section style={styles.section}>
                        <div style={styles.label}>Opções</div>
                        <div style={styles.gridOptions}>
                            <div>
                                <div style={styles.mini}>Idioma</div>
                                <select value={language} onChange={(e) => setLanguage(e.target.value as any)} disabled={busy}>
                                    <option value="pt">PT-BR</option>
                                    <option value="en">EN</option>
                                    <option value="es">ES</option>
                                    <option value="fr">FR</option>
                                    <option value="de">DE</option>
                                    <option value="it">IT</option>
                                </select>
                            </div>

                            <div>
                                <div style={styles.mini}>Modelo</div>
                                <select value={modelId} onChange={(e) => setModelId(e.target.value as any)} disabled={busy}>
                                    <option value="tiny">tiny</option>
                                    <option value="base">base</option>
                                    <option value="small">small (default)</option>
                                    <option value="medium">medium</option>
                                </select>
                            </div>

                            <div>
                                <div style={styles.mini}>Formato</div>
                                <div style={{ display: "flex", gap: 8 }}>
                                    <button onClick={() => setFormat("srt")} disabled={busy} style={format === "srt" ? styles.pillOn : styles.pillOff}>
                                        SRT
                                    </button>
                                    <button onClick={() => setFormat("ass")} disabled={busy} style={format === "ass" ? styles.pillOn : styles.pillOff}>
                                        ASS (básico)
                                    </button>
                                </div>
                            </div>

                            {audio && audioUrl && (
                                <div>
                                    {/* <label className="text-sm opacity-80">Granularidade</label> */}
                                    <div style={styles.mini}>Granularidade</div>
                                    <select
                                        value={granularity}
                                        onChange={(e) => setGranularity(e.target.value as GranularityPreset)}
                                        className="w-full rounded-lg border px-3 py-2"
                                        disabled={busy}
                                    >
                                        <option value="LOW">Baixa (mais denso)</option>
                                        <option value="MEDIUM">Média (recomendado)</option>
                                        <option value="HIGH">Alta</option>
                                        <option value="ULTRA">Altíssima (mais picado)</option>
                                    </select>

                                    <div style={{ marginTop: 8, fontSize: 12, color: "#666", lineHeight: 1.35 }}>
                                        <b>{GRANULARITY_INFO[granularity].title}:</b> {GRANULARITY_INFO[granularity].desc}
                                    </div>

                                    {/* {preview.length > 0 && isPreviewStale && (
                                        <div style={{ marginTop: 8, fontSize: 12, color: "#8a1f1f" }}>
                                            A prévia atual foi gerada com <b>{previewMeta?.granularity}</b>. Gere novamente para refletir <b>{granularity}</b>.
                                        </div>
                                    )} */}
                                </div>
                            )}

                            <div>
                                <div style={styles.mini}>Salvar como</div>
                                <button onClick={chooseOutput} disabled={!canChooseOutput}>
                                    Escolher onde salvar…
                                </button>
                                <div style={{ fontSize: 12, color: "#666", marginTop: 6 }}>{outputPath ? outputPath : "Nenhum local escolhido ainda."}</div>
                            </div>
                        </div>
                    </section>

                    <section style={styles.section}>
                        <button
                            onClick={start}
                            disabled={!audio || busy} // UX: permite clique mesmo sem outputPath (abre dialog)
                            style={styles.primaryBtn}
                            title={disabledReason}
                        >
                            {busy ? "Gerando..." : "Gerar legenda"}
                        </button>

                        {!canGenerate && (
                            <div style={{ marginTop: 8, fontSize: 12, color: "#777" }}>
                                {busy ? "Processando..." : audio ? "Ao clicar, você escolherá onde salvar se ainda não escolheu." : "Selecione um áudio para continuar."}
                            </div>
                        )}
                    </section>
                </div>

                {/* Execução */}
                <div style={styles.card}>
                    <h2 style={styles.h2}>Execução</h2>

                    <section style={styles.section}>
                        <div style={styles.label}>Progresso</div>

                        {/* Stepper */}
                        <div style={styles.flowWrap}>
                            <div style={styles.flowRow}>
                                {STEPS.map((s, i) => {
                                    const isIdle = flowIndex === -1 && step !== "ERROR";
                                    const isDone = flowIndex >= 0 && i < flowIndex && step !== "ERROR";
                                    const isCurrent = flowIndex >= 0 && i === flowIndex && step !== "ERROR";
                                    const isFinalDone = step === "DONE" && i === STEPS.length - 1;
                                    const isError = step === "ERROR" && i === Math.max(flowIndex, 0); // destaca onde estava

                                    const state: "idle" | "current" | "done" | "error" =
                                        isError ? "error" : isFinalDone || isDone ? "done" : isCurrent ? "current" : "idle";

                                    const c = flowColors(state);

                                    return (
                                        <React.Fragment key={s.key}>
                                            <div style={{ ...styles.flowNode, background: c.bg, borderColor: c.border, color: c.text }}>
                                                {s.label}
                                            </div>

                                            {i < STEPS.length - 1 && (
                                                <div style={{ ...styles.flowLine, background: c.line }} />
                                            )}
                                        </React.Fragment>
                                    );
                                })}
                            </div>

                            <div style={styles.flowHint}>
                                {step === "IDLE"
                                    ? "Aguardando execução."
                                    : step === "ERROR"
                                        ? "Ocorreu um erro. Verifique e tente novamente."
                                        : busy
                                            ? "Processando…"
                                            : step === "DONE"
                                                ? "Concluído com sucesso."
                                                : ""}
                            </div>

                            {busy && (
                                <div style={{ marginTop: 10, height: 8, background: "#f1f1f1", borderRadius: 999, overflow: "hidden" }}>
                                    <div style={styles.indeterminateBar} />
                                </div>
                            )}
                        </div>
                    </section>

                    <section style={styles.section}>
                        <div style={styles.label}>Prévia</div>
                        {preview.length === 0 ? (
                            <div style={{ color: "#777", fontSize: 13 }}>A prévia aparece ao concluir.</div>
                        ) : (
                            <div style={styles.previewWrap}>
                                {/* Copiar bloco (sempre visível) */}
                                <button
                                    type="button"
                                    title="Copiar bloco"
                                    style={styles.copyBlockBtn}
                                    onClick={async () => {
                                        const text = buildPreviewBlockText(preview);
                                        const ok = await copyToClipboard(text);
                                        if (!ok) alert("Não foi possível copiar para a área de transferência.");
                                    }}
                                >
                                    <CopyIcon />
                                </button>

                                {previewStats && (
                                    <div style={{ marginBottom: 10, fontSize: 12, color: "#555", lineHeight: 1.35 }}>
                                        <div>
                                            <b>Métricas:</b> {previewStats.cues} blocos • {Math.round(previewStats.durationSec)}s • CPS {previewStats.cps.toFixed(1)} •
                                            Média {previewStats.avgCharsPerCue.toFixed(0)} chars/bloco
                                        </div>

                                        {densityAlerts.length > 0 && (
                                            <div style={{ marginTop: 6 }}>
                                                {densityAlerts.map((x, i) => (
                                                    <div key={i} style={{ color: x.level === "danger" ? "#8a1f1f" : "#7a5a00" }}>
                                                        • {x.text}
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                )}

                                {/* Lista */}
                                <div style={styles.previewList}>
                                    {preview.map((p) => {
                                        const hovered = hoveredCueIndex === p.index;

                                        return (
                                            <div
                                                key={p.index}
                                                style={styles.previewRow}
                                                onMouseEnter={() => setHoveredCueIndex(p.index)}
                                                onMouseLeave={() => setHoveredCueIndex(null)}
                                            >
                                                <div style={styles.previewRowHeader}>
                                                    <span style={styles.previewTime}>
                                                        {formatMs(p.startMs)} → {formatMs(p.endMs)}
                                                    </span>

                                                    {/* Copiar linha (só no hover) */}
                                                    <button
                                                        type="button"
                                                        title="Copiar texto"
                                                        onClick={async () => {
                                                            const ok = await copyToClipboard(p.text);
                                                            if (!ok) alert("Não foi possível copiar para a área de transferência.");
                                                        }}
                                                        style={{
                                                            ...styles.copyLineBtn,
                                                            opacity: hovered ? 1 : 0,
                                                            pointerEvents: hovered ? "auto" : "none",
                                                        }}
                                                    >
                                                        <CopyIcon size={15} />
                                                    </button>
                                                </div>

                                                <div style={styles.previewText}>
                                                    {/* preserva quebras */}
                                                    {p.text.split("\n").map((line, i) => (
                                                        <React.Fragment key={i}>
                                                            {line}
                                                            {i < p.text.split("\n").length - 1 ? <br /> : null}
                                                        </React.Fragment>
                                                    ))}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>

                            // <div style={{ margin: "8px 0 0 18px", maxHeight: "250px", overflowY: "scroll" }}>
                            //     {preview.map((p) => (
                            //         <div key={p.index}>
                            //             <span style={{ fontWeight: '600', fontStyle: 'italic', fontSize: 'small' }}>
                            //                 {formatMs(p.startMs)} → {formatMs(p.endMs)}
                            //             </span>
                            //             <p style={{ marginTop: "0px" }}>{p.text}</p>
                            //         </div>
                            //     ))}
                            // </div>
                        )}
                    </section>
                </div>
            </div>

            {/* Arquivos gerados */}
            <div style={{ ...styles.card, marginTop: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                    <h2 style={styles.h2}>Arquivos gerados</h2>

                    <input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Buscar por nome…"
                        style={{
                            padding: "8px 10px",
                            borderRadius: 10,
                            border: "1px solid #ddd",
                            width: 280
                        }}
                    />
                </div>

                {generated.length === 0 ? (
                    <div style={{ marginTop: 10, color: "#777", fontSize: 13 }}>
                        Ainda não há arquivos gerados. Selecione um áudio e gere sua primeira legenda.
                    </div>
                ) : filtered.length === 0 ? (
                    <div style={{ marginTop: 10, color: "#777", fontSize: 13 }}>
                        Nenhum resultado para “{query}”.
                    </div>
                ) : (
                    <div style={{ display: "grid", gridTemplateColumns: "420px 1fr", gap: 12, marginTop: 12 }}>
                        {/* Lista */}
                        <div style={{ borderRight: "1px solid #eee", paddingRight: 12, maxHeight: 320, overflow: "auto" }}>
                            {filtered.map((g) => (
                                <div
                                    key={g.id}
                                    style={{
                                        padding: 10,
                                        borderRadius: 12,
                                        border: g.id === selectedId ? "1px solid #bbb" : "1px solid #eee",
                                        marginBottom: 8,
                                        background: g.exists ? "#fff" : "#fff7f7"
                                    }}
                                >
                                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                                        <div
                                            onClick={() => setSelectedId(g.id)}
                                            style={{ cursor: "pointer", flex: 1 }}
                                            title={g.path}
                                        >
                                            <div style={{ fontWeight: 800, fontSize: 13 }}>{g.fileName}</div>
                                            <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>
                                                {new Date(g.createdAtISO).toLocaleString()} • {g.language} • {g.modelId} • {g.format.toUpperCase()}
                                            </div>
                                            {!g.exists && <div style={{ fontSize: 12, color: "#b00020", marginTop: 4 }}>Arquivo não encontrado</div>}
                                        </div>

                                        {/* Ações rápidas */}
                                        <div style={styles.menuWrap} onClick={(e) => e.stopPropagation()}>
                                            <button
                                                style={styles.menuBtn}
                                                title="Opções"
                                                onClick={(e) => {
                                                    e.stopPropagation();

                                                    const r = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();

                                                    setMenu((prev) => {
                                                        // toggle
                                                        if (prev?.id === g.id) return null;
                                                        return { id: g.id, anchor: r };
                                                    });
                                                }}
                                            >
                                                ⋯
                                            </button>

                                            {menuOpenForId === g.id && (
                                                <div style={styles.menu}>
                                                    <button
                                                        style={g.exists ? styles.menuItem : styles.menuItemDisabled}
                                                        disabled={!g.exists}
                                                        onClick={() => openFile(g.id)}
                                                    >
                                                        Abrir
                                                    </button>

                                                    <button style={styles.menuItem} onClick={() => showInFolder(g.id)}>
                                                        Mostrar na pasta
                                                    </button>

                                                    <button
                                                        style={g.exists ? styles.menuItem : styles.menuItemDisabled}
                                                        disabled={!g.exists}
                                                        onClick={() => openRenameModal(g.id)}
                                                    >
                                                        Renomear
                                                    </button>

                                                    <div style={styles.menuDivider} />

                                                    <button
                                                        style={styles.menuItem}
                                                        onClick={() => (g.exists ? deleteItem(g.id) : removeFromHistoryOnly(g.id))}
                                                    >
                                                        {g.exists ? "Apagar do disco" : "Remover do histórico"}
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>

                        {/* Detalhe */}
                        <div>
                            {!selected ? (
                                <div style={{ color: "#777", fontSize: 13 }}>Selecione um item para ver detalhes.</div>
                            ) : (
                                <div style={{ fontSize: 13 }}>
                                    <div>
                                        <b>Nome:</b> {selected.fileName}
                                    </div>
                                    <div style={{ marginTop: 8 }}>
                                        <b>Caminho:</b> {selected.path}
                                    </div>
                                    <div style={{ marginTop: 8 }}>
                                        <b>Idioma:</b> {selected.language} • <b>Modelo:</b> {selected.modelId} • <b>Formato:</b> {selected.format.toUpperCase()}
                                    </div>

                                    {!selected.exists && (
                                        <div style={{ marginTop: 10, padding: 10, borderRadius: 12, border: "1px solid #f1c2c2", background: "#fff7f7" }}>
                                            <div style={{ fontWeight: 800, color: "#b00020" }}>Arquivo não encontrado</div>
                                            <div style={{ marginTop: 6, color: "#555" }}>
                                                Ele pode ter sido movido ou apagado fora do app. Você pode remover este item do histórico.
                                            </div>
                                            <div style={{ marginTop: 10 }}>
                                                <button onClick={() => removeFromHistoryOnly(selected.id)}>Remover do histórico</button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>

            {/* Generated File - Menu Options */}
            {menu && (
                <div
                    style={styles.menuFixed}
                    // clique no backdrop fecha
                    onMouseDown={() => setMenu(null)}
                >
                    {(() => {
                        const g = generated.find((x) => x.id === menu.id);
                        if (!g) return null;

                        const vw = window.innerWidth;
                        const vh = window.innerHeight;

                        // tenta abrir abaixo e alinhado à direita do botão
                        let left = menu.anchor.right - MENU_W;
                        let top = menu.anchor.bottom + 8;

                        // clamp horizontal (nunca sai da tela)
                        left = clamp(left, MENU_PAD, vw - MENU_W - MENU_PAD);

                        // se não couber embaixo, abre acima
                        const MENU_H_EST = 210; // estimativa segura; se quiser, calculamos via ref depois
                        if (top + MENU_H_EST > vh - MENU_PAD) {
                            top = menu.anchor.top - MENU_H_EST - 8;
                        }
                        top = clamp(top, MENU_PAD, vh - MENU_H_EST - MENU_PAD);

                        return (
                            <div
                                style={{ ...styles.menuPanel, top, left, width: MENU_W }}
                                // impede fechar ao clicar dentro
                                onMouseDown={(e) => e.stopPropagation()}
                            >
                                <button
                                    style={g.exists ? styles.menuItem : styles.menuItemDisabled}
                                    disabled={!g.exists}
                                    onClick={() => {
                                        setMenu(null);
                                        openFile(g.id);
                                    }}
                                >
                                    Abrir
                                </button>

                                <button
                                    style={styles.menuItem}
                                    onClick={() => {
                                        setMenu(null);
                                        showInFolder(g.id);
                                    }}
                                >
                                    Mostrar na pasta
                                </button>

                                <button
                                    style={g.exists ? styles.menuItem : styles.menuItemDisabled}
                                    disabled={!g.exists}
                                    onClick={() => {
                                        setMenu(null);
                                        openRenameModal(g.id);
                                    }}
                                >
                                    Renomear
                                </button>

                                <div style={styles.menuDivider} />

                                <button
                                    style={styles.menuItem}
                                    onClick={() => {
                                        setMenu(null);
                                        g.exists ? deleteItem(g.id) : removeFromHistoryOnly(g.id);
                                    }}
                                >
                                    {g.exists ? "Apagar do disco" : "Remover do histórico"}
                                </button>
                            </div>
                        );
                    })()}
                </div>
            )}

            {/* Modal Renomear */}
            {renameOpen && selected && (
                <div style={styles.modalBackdrop} onMouseDown={() => setRenameOpen(false)}>
                    <div style={styles.modal} onMouseDown={(e) => e.stopPropagation()}>
                        <h3 style={{ margin: 0 }}>Renomear arquivo</h3>
                        <div style={{ marginTop: 10, color: "#555", fontSize: 13 }}>
                            Nome atual: <b>{selected.fileName}</b>
                        </div>

                        <div style={{ marginTop: 12 }}>
                            <div style={styles.mini}>Novo nome (sem extensão)</div>
                            <input
                                value={renameValue}
                                onChange={(e) => setRenameValue(e.target.value)}
                                style={styles.input}
                                autoFocus
                            />

                            <div style={{ marginTop: 8, fontSize: 12, color: renameValidation.ok ? "#666" : "#b00020" }}>
                                {renameValidation.ok
                                    ? `Resultado: ${sanitizeBaseName(renameValue)}.${selected.format}`
                                    : renameValidation.msg}
                            </div>
                        </div>

                        <div style={{ marginTop: 14, display: "flex", justifyContent: "flex-end", gap: 8 }}>
                            <button onClick={() => setRenameOpen(false)}>Cancelar</button>
                            <button onClick={confirmRename} disabled={!renameValidation.ok}>
                                Renomear
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

const styles: Record<string, React.CSSProperties> = {
    page: {
        fontFamily: "system-ui, Arial",
        padding: 18,
        maxWidth: 1200,
        margin: "0 auto"
    },
    grid2: {
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 14
    },
    card: {
        border: "1px solid #e6e6e6",
        borderRadius: 14,
        padding: 14,
        background: "#fff"
    },
    h2: { margin: 0, fontSize: 16 },
    section: { marginTop: 12 },
    label: { fontWeight: 800, marginBottom: 6 },
    mini: { fontSize: 12, color: "#666", marginBottom: 6 },
    gridOptions: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 },
    pillOn: {
        padding: "7px 10px",
        borderRadius: 999,
        border: "1px solid #bbb",
        background: "#f2f2f2",
        cursor: "pointer"
    },
    pillOff: {
        padding: "7px 10px",
        borderRadius: 999,
        border: "1px solid #eee",
        background: "#fff",
        cursor: "pointer"
    },
    primaryBtn: {
        width: "100%",
        padding: "10px 12px",
        borderRadius: 10,
        border: "1px solid #ddd",
        cursor: "pointer"
    },
    indeterminateBar: {
        width: "35%",
        height: "100%",
        background: "#d9d9d9",
        borderRadius: 999,
        animation: "move 1.1s infinite ease-in-out"
    },
    modalBackdrop: {
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.25)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16
    },
    modal: {
        width: 520,
        maxWidth: "100%",
        background: "#fff",
        borderRadius: 14,
        border: "1px solid #e6e6e6",
        padding: 14
    },
    input: {
        width: "100%",
        padding: "10px 12px",
        borderRadius: 10,
        border: "1px solid #ddd"
    },
    menuBtn: {
        width: 34,
        height: 34,
        borderRadius: 10,
        border: "1px solid #e6e6e6",
        background: "#fff",
        cursor: "pointer",
        display: "grid",
        placeItems: "center",
        fontSize: 18,
        lineHeight: 1
    },
    menuWrap: { position: "relative" },
    menu: {
        position: "absolute",
        top: 38,
        right: 0,
        width: 180,
        background: "#fff",
        border: "1px solid #e6e6e6",
        borderRadius: 12,
        padding: 6,
        boxShadow: "0 12px 30px rgba(0,0,0,0.08)",
        zIndex: 50
    },
    menuItem: {
        width: "100%",
        textAlign: "left",
        padding: "8px 10px",
        borderRadius: 10,
        border: "none",
        background: "transparent",
        cursor: "pointer",
        fontSize: 13
    },
    menuItemDisabled: {
        width: "100%",
        textAlign: "left",
        padding: "8px 10px",
        borderRadius: 10,
        border: "none",
        background: "transparent",
        cursor: "not-allowed",
        fontSize: 13,
        color: "#aaa"
    },
    menuDivider: { height: 1, background: "#eee", margin: "6px 6px" },
    menuFixed: {
        position: "fixed",
        inset: 0,
        zIndex: 9999
    },
    menuPanel: {
        position: "fixed",
        background: "#fff",
        border: "1px solid #e6e6e6",
        borderRadius: 12,
        padding: 6,
        boxShadow: "0 12px 30px rgba(0,0,0,0.08)"
    },
    flowWrap: { marginTop: 8 },
    flowRow: {
        display: "flex",
        alignItems: "center",
        gap: 5,
        flexWrap: "nowrap",
        overflowX: "auto",
        overflowY: "hidden",
        paddingBottom: 6,
        WebkitOverflowScrolling: "touch"
    },
    flowNode: {
        padding: "8px",
        borderRadius: 999,
        border: "1px solid #e6e6e6",
        fontSize: 12,
        fontWeight: 700,
        userSelect: "none",
        whiteSpace: "nowrap",
        flex: "0 0 auto"
    },
    flowLine: {
        height: 2,
        width: 26,
        borderRadius: 999,
        background: "#e8e8e8",
        flex: "0 0 auto"
    },
    flowHint: { marginTop: 8, fontSize: 12, color: "#777" },
    previewWrap: {
        position: "relative",
        border: "1px solid #eee",
        borderRadius: 12,
        padding: "4px 12px 12px 12px",
        background: "#fff",
        maxHeight: 290,
        overflow: "auto",
    },

    copyBlockBtn: {
        position: "sticky", // fica “no topo” durante scroll do preview
        top: 0,
        float: "right", // garante canto superior direito dentro do wrap
        zIndex: 5,
        width: 28,
        height: 28,
        borderRadius: 10,
        border: "1px solid #e6e6e655",
        background: "#fff",
        cursor: "pointer",
        display: "grid",
        placeItems: "center",
        color: "#444",
    },

    previewList: {
        marginTop: 34,
    },

    previewRow: {
        position: "relative",
        padding: "10px 10px",
        borderRadius: 10,
        border: "1px solid #f0f0f0EE",
        marginBottom: 10,
        background: "#fff",
    },

    previewRowHeader: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
    },

    previewTime: {
        fontSize: 12,
        color: "#666",
        fontStyle: "italic",
        fontWeight: 800,
    },

    copyLineBtn: {
        width: 30,
        height: 30,
        borderRadius: 10,
        border: "1px solid #e6e6e655",
        background: "#fff",
        cursor: "pointer",
        display: "grid",
        placeItems: "center",
        color: "#444",
        transition: "opacity 120ms ease",
    },

    previewText: {
        marginTop: 0,
        fontSize: 13,
        color: "#222",
        lineHeight: 1,
        whiteSpace: "normal",
    },
};