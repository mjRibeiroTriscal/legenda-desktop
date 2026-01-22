export type LanguageCode = "pt" | "en" | "es" | "fr" | "de" | "it";
export type SubtitleFormat = "srt" | "ass";
export type ModelId = "tiny" | "base" | "small" | "medium";

export type PickAudioResponse =
    | { ok: true; file: { path: string; name: string } }
    | { ok: false; canceled: true };

export type ChooseOutputPathRequest = {
    suggestedBaseName: string;
    format: SubtitleFormat;
};

export type ChooseOutputPathResponse =
    | { ok: true; path: string }
    | { ok: false; canceled: true };

export type ModelInfoDTO = {
    id: ModelId;
    displayName: string;
    sizeMB: number;
    installed: boolean;
};

export type ListModelsResponse = { ok: true; items: ModelInfoDTO[] };

export type DownloadModelRequest = { modelId: ModelId };
export type DownloadModelResponse = { ok: true };

export type RemoveModelRequest = { modelId: ModelId };
export type RemoveModelResponse = { ok: true };

export type StartJobRequest = {
    audioPath: string;
    language: LanguageCode;
    modelId: ModelId;
    format: SubtitleFormat;
    outputPath: string;
    granularity?: GranularityPreset;
};

export type StartJobResponse = { ok: true; jobId: string };

export type CancelJobRequest = { jobId: string };
export type CancelJobResponse = { ok: true };

export type SegmentPreviewDTO = {
    index: number;
    startMs: number;
    endMs: number;
    text: string;
};

export type GeneratedFileDTO = {
    id: string;
    path: string;
    fileName: string;
    format: SubtitleFormat;
    language: LanguageCode;
    modelId: ModelId;
    createdAtISO: string;
    exists: boolean;
};

export type ListGeneratedFilesResponse = { ok: true; items: GeneratedFileDTO[] };

export type RenameGeneratedFileRequest = { id: string; newBaseName: string };
export type RenameGeneratedFileResponse = { ok: true; item: GeneratedFileDTO };

export type DeleteGeneratedFileRequest = { id: string };
export type DeleteGeneratedFileResponse = { ok: true };

export type OpenGeneratedFileRequest = { id: string };
export type OpenGeneratedFileResponse = { ok: true };

export type ShowInFolderRequest = { id: string };
export type ShowInFolderResponse = { ok: true };

export type GetFileUrlRequestDTO = { absPath: string; };

export type GetFileUrlResponseDTO =
    | { ok: true; url: string }
    | { ok: false; message?: string };

export type GranularityPreset = "LOW" | "MEDIUM" | "HIGH" | "ULTRA";

export type SubtitleCueDTO = {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
};

export type SubtitlePreviewDTO = {
  cues: SubtitleCueDTO[];
};
