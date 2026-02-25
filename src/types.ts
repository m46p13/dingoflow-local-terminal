export type FormatMode = 'literal' | 'clean' | 'rewrite';
export type AsrBackend = 'faster-whisper' | 'parakeet-mlx' | 'parakeet-native' | 'whisper-native';
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
}

export interface DictationResult {
  rawTranscript: string;
  formattedText: string;
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
  parakeetStreamContextLeft: number;
  parakeetStreamContextRight: number;
  parakeetStreamDepth: number;
  enforceOffline: boolean;
}
