import path from 'node:path';
import { AppConfig, AsrBackend, AsrTransport, LatencyPreset, RecorderBackend } from './types';

const parseIntOrDefault = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const parseBoolOrDefault = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) {
    return fallback;
  }

  return value.toLowerCase() === 'true';
};

const resolveAsrBackend = (value: string | undefined): AsrBackend => {
  if (value === 'whisper-native') {
    return 'whisper-native';
  }

  if (value === 'faster-whisper') {
    return 'faster-whisper';
  }

  if (value === 'parakeet-native') {
    return 'parakeet-native';
  }

  if (value === 'parakeet-mlx') {
    return 'parakeet-mlx';
  }

  return 'parakeet-native';
};

const resolveRecorderBackend = (value: string | undefined): RecorderBackend => {
  if (value === 'ffmpeg' || value === 'native-rust' || value === 'auto') {
    return value;
  }

  return 'auto';
};

const resolveAsrTransport = (value: string | undefined): AsrTransport => {
  if (value === 'jsonl') {
    return 'jsonl';
  }

  return 'framed';
};

const resolveLatencyPreset = (value: string | undefined): LatencyPreset => {
  if (value === 'ultra' || value === 'quality' || value === 'balanced') {
    return value;
  }

  return 'balanced';
};

interface LatencyPresetDefaults {
  liveStreamChunkMs: number;
  minAsrWindowMs: number;
  normalAsrWindowMs: number;
  backlogAsrWindowMs: number;
  maxAsrWindowMs: number;
  adaptiveAsrWindow: boolean;
}

const getLatencyPresetDefaults = (
  preset: LatencyPreset,
  isAppleSilicon: boolean
): LatencyPresetDefaults => {
  if (!isAppleSilicon) {
    if (preset === 'ultra') {
      return {
        liveStreamChunkMs: 90,
        minAsrWindowMs: 70,
        normalAsrWindowMs: 140,
        backlogAsrWindowMs: 320,
        maxAsrWindowMs: 640,
        adaptiveAsrWindow: true
      };
    }

    if (preset === 'quality') {
      return {
        liveStreamChunkMs: 160,
        minAsrWindowMs: 130,
        normalAsrWindowMs: 260,
        backlogAsrWindowMs: 520,
        maxAsrWindowMs: 900,
        adaptiveAsrWindow: true
      };
    }

    return {
      liveStreamChunkMs: 120,
      minAsrWindowMs: 90,
      normalAsrWindowMs: 180,
      backlogAsrWindowMs: 360,
      maxAsrWindowMs: 640,
      adaptiveAsrWindow: true
    };
  }

  if (preset === 'ultra') {
    return {
      liveStreamChunkMs: 60,
      minAsrWindowMs: 50,
      normalAsrWindowMs: 90,
      backlogAsrWindowMs: 220,
      maxAsrWindowMs: 420,
      adaptiveAsrWindow: true
    };
  }

  if (preset === 'quality') {
    return {
      liveStreamChunkMs: 120,
      minAsrWindowMs: 100,
      normalAsrWindowMs: 200,
      backlogAsrWindowMs: 420,
      maxAsrWindowMs: 760,
      adaptiveAsrWindow: true
    };
  }

  return {
    liveStreamChunkMs: 90,
    minAsrWindowMs: 70,
    normalAsrWindowMs: 140,
    backlogAsrWindowMs: 300,
    maxAsrWindowMs: 520,
    adaptiveAsrWindow: true
  };
};

export const resolveConfig = (): AppConfig => {
  const rootDir = path.resolve(__dirname, '..');
  const isAppleSilicon = process.platform === 'darwin' && process.arch === 'arm64';
  const recorderBackend = resolveRecorderBackend(process.env.DINGOFLOW_RECORDER_BACKEND);
  const asrBackend = resolveAsrBackend(process.env.DINGOFLOW_ASR_BACKEND);
  const asrTransport = resolveAsrTransport(process.env.DINGOFLOW_ASR_TRANSPORT);
  const latencyPreset = resolveLatencyPreset(process.env.DINGOFLOW_LATENCY_PRESET);
  const latencyDefaults = getLatencyPresetDefaults(latencyPreset, isAppleSilicon);
  const defaultParakeetFinalPass = latencyPreset === 'quality';
  const defaultAsrScript =
    asrBackend === 'parakeet-mlx'
      ? path.join(rootDir, 'python', 'parakeet_runner.py')
      : path.join(rootDir, 'python', 'asr_runner.py');
  const defaultAsrModelPath =
    asrBackend === 'parakeet-mlx'
      ? path.join(rootDir, 'models', 'parakeet-tdt-0.6b-v3')
      : asrBackend === 'parakeet-native'
        ? path.join(rootDir, 'models', 'parakeet-tdt-0.6b-v3-onnx')
      : asrBackend === 'whisper-native'
        ? path.join(rootDir, 'models', 'ggml-base.en.bin')
        : path.join(rootDir, 'models', 'faster-whisper-small.en');

  return {
    hotkey: process.env.DINGOFLOW_HOTKEY ?? 'CommandOrControl+Shift+Space',
    recorderBackend,
    nativeAudioBin:
      process.env.DINGOFLOW_NATIVE_AUDIO_BIN ??
      path.join(rootDir, 'native', 'audio_loop', 'target', 'release', 'dingoflow-audio-loop'),
    nativeTextInjectBin:
      process.env.DINGOFLOW_NATIVE_TEXT_INJECT_BIN ??
      path.join(rootDir, 'native', 'text_injector', 'bin', 'dingoflow-text-injector'),
    nativeAsrBin:
      process.env.DINGOFLOW_NATIVE_ASR_BIN ??
      path.join(rootDir, 'native', 'asr_worker', 'target', 'release', 'dingoflow-asr-worker'),
    nativeParakeetBin:
      process.env.DINGOFLOW_NATIVE_PARAKEET_BIN ??
      path.join(
        rootDir,
        'native',
        'parakeet_worker',
        'target',
        'release',
        'dingoflow-parakeet-worker'
      ),
    nativeAsrThreads: parseIntOrDefault(process.env.DINGOFLOW_NATIVE_ASR_THREADS, 4),
    ffmpegInputDevice: process.env.DINGOFLOW_FFMPEG_INPUT ?? ':0',
    pythonBin: process.env.DINGOFLOW_PYTHON_BIN ?? 'python3',
    asrBackend,
    asrTransport,
    asrScriptPath: process.env.DINGOFLOW_ASR_SCRIPT ?? defaultAsrScript,
    formatterScriptPath:
      process.env.DINGOFLOW_FORMATTER_SCRIPT ??
      path.join(rootDir, 'python', 'format_runner.py'),
    asrModelPath: process.env.DINGOFLOW_ASR_MODEL_PATH ?? defaultAsrModelPath,
    asrDevice: process.env.DINGOFLOW_ASR_DEVICE ?? 'cpu',
    asrComputeType: process.env.DINGOFLOW_ASR_COMPUTE_TYPE ?? 'int8',
    formatterModelPath:
      process.env.DINGOFLOW_FORMATTER_MODEL_PATH ??
      path.join(rootDir, 'models', 'qwen2.5-0.5b-instruct-mlx-4bit'),
    formatterMaxTokens: parseIntOrDefault(process.env.DINGOFLOW_FORMATTER_MAX_TOKENS, 240),
    pasteDelayMs: parseIntOrDefault(process.env.DINGOFLOW_PASTE_DELAY_MS, 80),
    injectionRetryCount: parseIntOrDefault(process.env.DINGOFLOW_INJECTION_RETRY_COUNT, 2),
    injectionRetryDelayMs: parseIntOrDefault(process.env.DINGOFLOW_INJECTION_RETRY_DELAY_MS, 120),
    spokenFormattingCommands: parseBoolOrDefault(
      process.env.DINGOFLOW_SPOKEN_FORMATTING_COMMANDS,
      true
    ),
    latencyPreset,
    liveStreamChunkMs: parseIntOrDefault(
      process.env.DINGOFLOW_STREAM_CHUNK_MS,
      latencyDefaults.liveStreamChunkMs
    ),
    minAsrWindowMs: parseIntOrDefault(
      process.env.DINGOFLOW_ASR_WINDOW_MIN_MS,
      latencyDefaults.minAsrWindowMs
    ),
    normalAsrWindowMs: parseIntOrDefault(
      process.env.DINGOFLOW_ASR_WINDOW_NORMAL_MS,
      latencyDefaults.normalAsrWindowMs
    ),
    backlogAsrWindowMs: parseIntOrDefault(
      process.env.DINGOFLOW_ASR_WINDOW_BACKLOG_MS,
      latencyDefaults.backlogAsrWindowMs
    ),
    maxAsrWindowMs: parseIntOrDefault(
      process.env.DINGOFLOW_ASR_WINDOW_MAX_MS,
      latencyDefaults.maxAsrWindowMs
    ),
    adaptiveAsrWindow: parseBoolOrDefault(
      process.env.DINGOFLOW_ASR_WINDOW_ADAPTIVE,
      latencyDefaults.adaptiveAsrWindow
    ),
    parakeetFinalPass: parseBoolOrDefault(
      process.env.DINGOFLOW_PARAKEET_FINAL_PASS,
      defaultParakeetFinalPass
    ),
    parakeetStreamContextLeft: parseIntOrDefault(process.env.DINGOFLOW_PARAKEET_CTX_LEFT, 64),
    parakeetStreamContextRight: parseIntOrDefault(process.env.DINGOFLOW_PARAKEET_CTX_RIGHT, 8),
    parakeetStreamDepth: parseIntOrDefault(process.env.DINGOFLOW_PARAKEET_STREAM_DEPTH, 1),
    enforceOffline: parseBoolOrDefault(process.env.DINGOFLOW_ENFORCE_OFFLINE, true)
  };
};

const nativeFramedBackends: AsrBackend[] = ['whisper-native', 'parakeet-native'];

export const validateConfig = (config: AppConfig): string[] => {
  const errors: string[] = [];

  if (!['faster-whisper', 'parakeet-mlx', 'parakeet-native', 'whisper-native'].includes(config.asrBackend)) {
    errors.push(
      'DINGOFLOW_ASR_BACKEND must be one of: faster-whisper, parakeet-mlx, parakeet-native, whisper-native.'
    );
  }

  if (!['auto', 'ffmpeg', 'native-rust'].includes(config.recorderBackend)) {
    errors.push('DINGOFLOW_RECORDER_BACKEND must be one of: auto, ffmpeg, native-rust.');
  }

  if (!['jsonl', 'framed'].includes(config.asrTransport)) {
    errors.push('DINGOFLOW_ASR_TRANSPORT must be one of: jsonl, framed.');
  }

  if (!['ultra', 'balanced', 'quality'].includes(config.latencyPreset)) {
    errors.push('DINGOFLOW_LATENCY_PRESET must be one of: ultra, balanced, quality.');
  }

  if (!config.hotkey.trim()) {
    errors.push('DINGOFLOW_HOTKEY must not be empty.');
  }

  if (!config.nativeAudioBin.trim()) {
    errors.push('DINGOFLOW_NATIVE_AUDIO_BIN must not be empty.');
  }

  if (!config.nativeTextInjectBin.trim()) {
    errors.push('DINGOFLOW_NATIVE_TEXT_INJECT_BIN must not be empty.');
  }

  if (!config.nativeAsrBin.trim()) {
    errors.push('DINGOFLOW_NATIVE_ASR_BIN must not be empty.');
  }

  if (!config.nativeParakeetBin.trim()) {
    errors.push('DINGOFLOW_NATIVE_PARAKEET_BIN must not be empty.');
  }

  if (config.nativeAsrThreads < 1 || config.nativeAsrThreads > 64) {
    errors.push('DINGOFLOW_NATIVE_ASR_THREADS must be between 1 and 64.');
  }

  if (config.formatterMaxTokens < 32 || config.formatterMaxTokens > 8192) {
    errors.push('DINGOFLOW_FORMATTER_MAX_TOKENS must be between 32 and 8192.');
  }

  if (config.pasteDelayMs < 0 || config.pasteDelayMs > 2000) {
    errors.push('DINGOFLOW_PASTE_DELAY_MS must be between 0 and 2000 milliseconds.');
  }

  if (config.injectionRetryCount < 1 || config.injectionRetryCount > 8) {
    errors.push('DINGOFLOW_INJECTION_RETRY_COUNT must be between 1 and 8.');
  }

  if (config.injectionRetryDelayMs < 0 || config.injectionRetryDelayMs > 5000) {
    errors.push('DINGOFLOW_INJECTION_RETRY_DELAY_MS must be between 0 and 5000 milliseconds.');
  }

  if (config.liveStreamChunkMs < 20 || config.liveStreamChunkMs > 600) {
    errors.push('DINGOFLOW_STREAM_CHUNK_MS must be between 20 and 600 milliseconds.');
  }

  if (config.minAsrWindowMs < 40 || config.minAsrWindowMs > 1200) {
    errors.push('DINGOFLOW_ASR_WINDOW_MIN_MS must be between 40 and 1200 milliseconds.');
  }

  if (config.normalAsrWindowMs < 60 || config.normalAsrWindowMs > 1500) {
    errors.push('DINGOFLOW_ASR_WINDOW_NORMAL_MS must be between 60 and 1500 milliseconds.');
  }

  if (config.backlogAsrWindowMs < 80 || config.backlogAsrWindowMs > 2500) {
    errors.push('DINGOFLOW_ASR_WINDOW_BACKLOG_MS must be between 80 and 2500 milliseconds.');
  }

  if (config.maxAsrWindowMs < 100 || config.maxAsrWindowMs > 4000) {
    errors.push('DINGOFLOW_ASR_WINDOW_MAX_MS must be between 100 and 4000 milliseconds.');
  }

  if (
    !(
      config.minAsrWindowMs <= config.normalAsrWindowMs &&
      config.normalAsrWindowMs <= config.backlogAsrWindowMs &&
      config.backlogAsrWindowMs <= config.maxAsrWindowMs
    )
  ) {
    errors.push(
      'ASR window settings must satisfy: MIN <= NORMAL <= BACKLOG <= MAX. Check DINGOFLOW_ASR_WINDOW_*_MS values.'
    );
  }

  if (config.parakeetStreamContextLeft < 8 || config.parakeetStreamContextLeft > 1024) {
    errors.push('DINGOFLOW_PARAKEET_CTX_LEFT must be between 8 and 1024.');
  }

  if (config.parakeetStreamContextRight < 1 || config.parakeetStreamContextRight > 256) {
    errors.push('DINGOFLOW_PARAKEET_CTX_RIGHT must be between 1 and 256.');
  }

  if (config.parakeetStreamDepth < 1 || config.parakeetStreamDepth > 32) {
    errors.push('DINGOFLOW_PARAKEET_STREAM_DEPTH must be between 1 and 32.');
  }

  if (['faster-whisper', 'parakeet-mlx'].includes(config.asrBackend) && !config.pythonBin.trim()) {
    errors.push('DINGOFLOW_PYTHON_BIN must not be empty.');
  }

  if (nativeFramedBackends.includes(config.asrBackend) && config.asrTransport !== 'framed') {
    errors.push(
      `DINGOFLOW_ASR_TRANSPORT must be framed when DINGOFLOW_ASR_BACKEND=${config.asrBackend}.`
    );
  }

  return errors;
};
