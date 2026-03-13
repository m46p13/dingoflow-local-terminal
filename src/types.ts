export type FormatMode = 'literal' | 'clean' | 'rewrite';
export type AsrBackend = 'faster-whisper' | 'parakeet-mlx' | 'parakeet-native' | 'whisper-native' | 'cloud';
export type RecorderBackend = 'auto' | 'ffmpeg' | 'native-rust';
export type AsrTransport = 'jsonl' | 'framed';
export type LatencyPreset = 'ultra' | 'balanced' | 'quality';

export type PipelineStage =
  | 'idle'
  | 'recording'
  | 'transcribing'
  | 'formatting'
  | 'injecting'
  | 'error';

export interface AppState {
  stage: PipelineStage;
  detail?: string;
}

export interface AsrResult {
  text: string;
  language?: string;
  durationSeconds?: number;
  previewText?: string;
  committedText?: string;
}

export interface DictationResult {
  rawTranscript: string;
  formattedText: string;
}

export interface LivePreviewState {
  previewText: string;
  committedText: string;
}

export interface AppConfig {
  hotkey: string;
  recorderBackend: RecorderBackend;
  nativeAudioBin: string;
  nativeTextInjectBin: string;
  nativeAsrBin: string;
  nativeParakeetBin: string;
  nativeAsrThreads: number;
  ffmpegInputDevice: string;
  pythonBin: string;
  cloudAsrUrl: string;
  cloudApiKey: string;
  openaiApiKey: string;
  openaiTranscribeModel: string;
  openaiCleanupModel: string;
  cloudServerPort: number;
  cloudServerAsrBackend: Exclude<AsrBackend, 'cloud'>;
  cloudServerAsrModelPath: string;
  asrBackend: AsrBackend;
  asrTransport: AsrTransport;
  asrScriptPath: string;
  formatterScriptPath: string;
  asrModelPath: string;
  asrDevice: string;
  asrComputeType: string;
  formatterModelPath: string;
  formatterMaxTokens: number;
  pasteDelayMs: number;
  injectionRetryCount: number;
  injectionRetryDelayMs: number;
  spokenFormattingCommands: boolean;
  latencyPreset: LatencyPreset;
  liveStreamChunkMs: number;
  minAsrWindowMs: number;
  normalAsrWindowMs: number;
  backlogAsrWindowMs: number;
  maxAsrWindowMs: number;
  adaptiveAsrWindow: boolean;
  parakeetFinalPass: boolean;
  silenceGateDbfs: number;
  speechHangoverMs: number;
  speechOnsetMs: number;
  speechPrerollMs: number;
  speechNoiseFloorMarginDb: number;
  nativeVadEnabled: boolean;
  nativeVadMode: 'quality' | 'low-bitrate' | 'aggressive' | 'very-aggressive';
  nativeVadFrameMs: number;
  parakeetStreamContextLeft: number;
  parakeetStreamContextRight: number;
  parakeetStreamDepth: number;
  enforceOffline: boolean;
}
