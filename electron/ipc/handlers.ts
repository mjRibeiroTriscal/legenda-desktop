import { app, dialog, ipcMain, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// import { pathToFileURL } from "node:url";

import type { GetFileUrlRequestDTO, GetFileUrlResponseDTO } from "../../shared/ipc/dtos";
import { IPC } from "./channels";
import { emitGeneratedChanged, emitJobDone, emitJobError, emitJobProgress } from "./events";

import type {
    ChooseOutputPathRequest,
    DeleteGeneratedFileRequest,
    DownloadModelRequest,
    ListGeneratedFilesResponse,
    ListModelsResponse,
    OpenGeneratedFileRequest,
    PickAudioResponse,
    RenameGeneratedFileRequest,
    ShowInFolderRequest,
    StartJobRequest
} from "../../shared/ipc/dtos";
import type { AppErrorDTO } from "../../shared/ipc/errors";

import { GeneratedFilesStore } from "../store/generatedFilesStore";
import { sanitizeBaseName } from "../utils/sanitizeFileName";
import { convertSrtFileToAss } from "../utils/srtToAss";
import { parseSrt } from "../utils/srtParse";

import { WhisperRunner } from "../infra/whisper/WhisperRunner";
import type { WhisperLanguage, WhisperModel } from "../infra/whisper/types";

export function registerHandlers(mainWindowGetter: () => Electron.BrowserWindow) {
    const store = new GeneratedFilesStore(app.getPath("userData"));
    const runners = new Map<string, WhisperRunner>();

    ipcMain.handle(IPC.PICK_AUDIO, async (): Promise<PickAudioResponse> => {
        const win = mainWindowGetter();
        const res = await dialog.showOpenDialog(win, {
            properties: ["openFile"],
            filters: [{ name: "Áudio", extensions: ["mp3", "wav", "m4a", "flac", "ogg", "aac"] }]
        });
        if (res.canceled || res.filePaths.length === 0) return { ok: false, canceled: true };
        const p = res.filePaths[0];
        return { ok: true, file: { path: p, name: path.basename(p) } };
    });

    ipcMain.handle(IPC.CHOOSE_OUTPUT, async (_e, req: ChooseOutputPathRequest) => {
        const win = mainWindowGetter();
        const ext = req.format === "ass" ? "ass" : "srt";

        const res = await dialog.showSaveDialog(win, {
            defaultPath: `${req.suggestedBaseName}.${ext}`,
            filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
        });

        if (res.canceled || !res.filePath) return { ok: false, canceled: true };
        return { ok: true, path: res.filePath };
    });

    // MODELOS (mock por enquanto)
    ipcMain.handle(IPC.LIST_MODELS, async (): Promise<ListModelsResponse> => {
        return {
            ok: true,
            items: [
                { id: "tiny", displayName: "Tiny (muito rápido)", sizeMB: 75, installed: false },
                { id: "base", displayName: "Base (rápido)", sizeMB: 142, installed: false },
                { id: "small", displayName: "Small (recomendado)", sizeMB: 466, installed: false },
                { id: "medium", displayName: "Medium (pesado)", sizeMB: 1530, installed: false }
            ]
        };
    });

    ipcMain.handle(IPC.DOWNLOAD_MODEL, async (_e, _req: DownloadModelRequest) => {
        // mock: no próximo passo faremos download real + cache + progress
        return { ok: true };
    });

    ipcMain.handle(IPC.REMOVE_MODEL, async (_e, _req: DownloadModelRequest) => {
        return { ok: true };
    });

    // HISTÓRICO
    ipcMain.handle(IPC.GENERATED_LIST, async (): Promise<ListGeneratedFilesResponse> => {
        const items = store.list().map((x) => ({ ...x, exists: fs.existsSync(x.path) }));
        return { ok: true, items };
    });

    ipcMain.handle(IPC.GENERATED_RENAME, async (_e, req: RenameGeneratedFileRequest) => {
        const items = store.list();
        const found = items.find((x) => x.id === req.id);
        if (!found) throw makeErr("FILE_NOT_FOUND", "Arquivo não encontrado no histórico.");

        if (!fs.existsSync(found.path)) throw makeErr("FILE_NOT_FOUND", "Arquivo não existe mais no disco.");

        const base = sanitizeBaseName(req.newBaseName);
        if (!base) throw makeErr("VALIDATION_ERROR", "Nome inválido.");

        const dir = path.dirname(found.path);
        const ext = path.extname(found.path);
        const newPath = path.join(dir, `${base}${ext}`);

        // se existir, auto-sufixo para reduzir fricção
        const finalPath = resolveNonCollidingPath(newPath);

        try {
            fs.renameSync(found.path, finalPath);
        } catch (e: any) {
            throw makeErr("FILE_RENAME_FAILED", "Não foi possível renomear o arquivo.", e?.message);
        }

        const updated = {
            ...found,
            path: finalPath,
            fileName: path.basename(finalPath),
            exists: true
        };

        store.update(req.id, () => updated);
        emitGeneratedChanged(mainWindowGetter(), { reason: "RENAMED" });

        return { ok: true, item: updated };
    });

    ipcMain.handle(IPC.GENERATED_DELETE, async (_e, req: DeleteGeneratedFileRequest) => {
        const items = store.list();
        const found = items.find((x) => x.id === req.id);
        if (!found) throw makeErr("FILE_NOT_FOUND", "Arquivo não encontrado no histórico.");

        try {
            if (fs.existsSync(found.path)) fs.unlinkSync(found.path);
        } catch (e: any) {
            throw makeErr("FILE_DELETE_FAILED", "Não foi possível apagar o arquivo.", e?.message);
        }

        store.remove(req.id);
        emitGeneratedChanged(mainWindowGetter(), { reason: "DELETED" });

        return { ok: true };
    });

    ipcMain.handle(IPC.GENERATED_OPEN, async (_e, req: OpenGeneratedFileRequest) => {
        const found = store.list().find((x) => x.id === req.id);
        if (!found) throw makeErr("FILE_NOT_FOUND", "Arquivo não encontrado no histórico.");
        if (!fs.existsSync(found.path)) throw makeErr("FILE_NOT_FOUND", "Arquivo não existe mais no disco.");

        await shell.openPath(found.path);
        return { ok: true };
    });

    ipcMain.handle(IPC.GENERATED_SHOW_IN_FOLDER, async (_e, req: ShowInFolderRequest) => {
        const found = store.list().find((x) => x.id === req.id);
        if (!found) throw makeErr("FILE_NOT_FOUND", "Arquivo não encontrado no histórico.");

        shell.showItemInFolder(found.path);
        return { ok: true };
    });

    ipcMain.handle(IPC.JOB_START, async (_e, req: StartJobRequest) => {
        const win = mainWindowGetter();
        const jobId = crypto.randomUUID();

        // validações essenciais
        if (!req.audioPath) throw makeErr("AUDIO_NOT_SELECTED", "Selecione um áudio.", undefined, "PICK_AUDIO");
        if (!req.outputPath) throw makeErr("OUTPUT_PATH_REQUIRED", "Escolha onde salvar antes de gerar.", undefined, "CHOOSE_OUTPUT");

        // ✅ SRT real via whisper.cpp
        emitJobProgress(win, { jobId, step: "PREPARING", message: "Validando arquivos e modelo..." });

        const runner = new WhisperRunner();
        runners.set(jobId, runner);

        try {
            emitJobProgress(win, { jobId, step: "TRANSCRIBING", message: "Transcrevendo áudio (whisper)..." });

            const language = (req.language || "pt") as WhisperLanguage;
            const model = (req.modelId || "small") as WhisperModel;

            const res = await runner.run(
                {
                    audioPath: req.audioPath,
                    language,
                    model,
                    granularity: req.granularity ?? "MEDIUM",
                },
                // log do whisper (opcional): você pode mapear pra UI depois
                (_line) => { /* no MVP: ignore ou faça throttle se quiser mostrar */ }
            );

            if (req.format === "srt") {
                fs.copyFileSync(res.srtPath, req.outputPath);
            } else {
                // gerar ass em temp e copiar pro output final
                const tmpAss = res.srtPath.replace(/\.srt$/i, ".ass");
                convertSrtFileToAss(res.srtPath, tmpAss);
                fs.copyFileSync(tmpAss, req.outputPath);
            }

            emitJobProgress(win, { jobId, step: "CONVERTING", message: "Preparando legenda..." });
            await sleep(50);

            emitJobProgress(win, { jobId, step: "SAVING", message: "Salvando arquivo..." });

            const itemId = crypto.randomUUID();
            const created = {
                id: itemId,
                path: req.outputPath,
                fileName: path.basename(req.outputPath),
                format: req.format,
                language: req.language,
                modelId: req.modelId,
                createdAtISO: new Date().toISOString(),
                exists: true
            };

            store.add(created);
            emitGeneratedChanged(win, { reason: "CREATED" });

            const preview = parseSrt(fs.readFileSync(res.srtPath, "utf-8"));

            emitJobDone(win, {
                jobId,
                generated: { id: created.id, path: created.path, fileName: created.fileName },
                preview
            });

            emitJobProgress(win, { jobId, step: "DONE", message: "Concluído." });

            return { ok: true, jobId };
        } catch (e: any) {
            emitJobError(win, { jobId, error: makeErr("WHISPER_FAILED", "Falha ao transcrever com Whisper.", e?.message) });
            throw e;
        } finally {
            runners.delete(jobId);
        }
    });

    ipcMain.handle(IPC.JOB_CANCEL, async (_e, { jobId }: { jobId: string }) => {
        const r = runners.get(jobId);
        if (r) {
            r.cancel();
            runners.delete(jobId);
        }
        return { ok: true };
    });

    ipcMain.handle(
        IPC.GET_FILE_URL,
        async (_e, { absPath }: GetFileUrlRequestDTO): Promise<GetFileUrlResponseDTO> => {
            try {
                if (!absPath || typeof absPath !== "string") {
                    return { ok: false, message: "Caminho inválido." };
                }

                // Segurança básica: precisa existir e ser arquivo
                if (!fs.existsSync(absPath)) {
                    return { ok: false, message: "Arquivo não encontrado." };
                }

                const st = fs.statSync(absPath);
                if (!st.isFile()) {
                    return { ok: false, message: "O caminho não é um arquivo." };
                }

                // (Opcional) validação por extensão para áudio
                const ext = path.extname(absPath).toLowerCase();
                const allowed = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"]);
                if (!allowed.has(ext)) {
                    return { ok: false, message: "Formato de áudio não suportado." };
                }

                const encoded = Buffer.from(absPath, "utf8").toString("base64url");
                return { ok: true, url: `appfile://audio?path=${encoded}` };
            } catch (err: any) {
                return { ok: false, message: err?.message || "Falha ao gerar URL." };
            }
        }
    );
}

function makeErr(code: any, message: string, details?: string, actionHint?: AppErrorDTO["actionHint"]) {
    const err: AppErrorDTO = { code, message, details, actionHint };
    const e = new Error(message) as any;
    e.appError = err;
    return e;
}

function resolveNonCollidingPath(p: string) {
    if (!fs.existsSync(p)) return p;
    const dir = path.dirname(p);
    const ext = path.extname(p);
    const base = path.basename(p, ext);

    for (let i = 1; i < 1000; i++) {
        const candidate = path.join(dir, `${base} (${i})${ext}`);
        if (!fs.existsSync(candidate)) return candidate;
    }
    return p;
}

function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}