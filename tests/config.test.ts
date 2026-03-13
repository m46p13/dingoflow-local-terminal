import { afterEach, describe, expect, it } from 'vitest';
import { resolveConfig, validateConfig } from '../src/config';

const clearEnv = (): void => {
  delete process.env.DINGOFLOW_ENFORCE_OFFLINE;
  delete process.env.DINGOFLOW_RECORDER_BACKEND;
  delete process.env.DINGOFLOW_NATIVE_AUDIO_BIN;
  delete process.env.DINGOFLOW_NATIVE_TEXT_INJECT_BIN;
  delete process.env.DINGOFLOW_NATIVE_ASR_BIN;
  delete process.env.DINGOFLOW_NATIVE_PARAKEET_BIN;
  delete process.env.DINGOFLOW_NATIVE_ASR_THREADS;
  delete process.env.DINGOFLOW_ASR_TRANSPORT;
  delete process.env.DINGOFLOW_LATENCY_PRESET;
  delete process.env.DINGOFLOW_FORMATTER_MAX_TOKENS;
  delete process.env.DINGOFLOW_PASTE_DELAY_MS;
  delete process.env.DINGOFLOW_INJECTION_RETRY_COUNT;
  delete process.env.DINGOFLOW_INJECTION_RETRY_DELAY_MS;
  delete process.env.DINGOFLOW_SPOKEN_FORMATTING_COMMANDS;
  delete process.env.DINGOFLOW_HOTKEY;
  delete process.env.DINGOFLOW_PYTHON_BIN;
  delete process.env.DINGOFLOW_CLOUD_ASR_URL;
  delete process.env.DINGOFLOW_CLOUD_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.DINGOFLOW_OPENAI_TRANSCRIBE_MODEL;
  delete process.env.DINGOFLOW_OPENAI_CLEANUP_MODEL;
  delete process.env.DINGOFLOW_CLOUD_SERVER_PORT;
  delete process.env.DINGOFLOW_CLOUD_SERVER_ASR_BACKEND;
  delete process.env.DINGOFLOW_CLOUD_SERVER_ASR_MODEL_PATH;
  delete process.env.DINGOFLOW_ASR_BACKEND;
  delete process.env.DINGOFLOW_ASR_SCRIPT;
  delete process.env.DINGOFLOW_ASR_MODEL_PATH;
  delete process.env.DINGOFLOW_STREAM_CHUNK_MS;
  delete process.env.DINGOFLOW_ASR_WINDOW_MIN_MS;
  delete process.env.DINGOFLOW_ASR_WINDOW_NORMAL_MS;
  delete process.env.DINGOFLOW_ASR_WINDOW_BACKLOG_MS;
  delete process.env.DINGOFLOW_ASR_WINDOW_MAX_MS;
  delete process.env.DINGOFLOW_ASR_WINDOW_ADAPTIVE;
  delete process.env.DINGOFLOW_PARAKEET_FINAL_PASS;
  delete process.env.DINGOFLOW_SILENCE_GATE_DBFS;
  delete process.env.DINGOFLOW_SPEECH_HANGOVER_MS;
  delete process.env.DINGOFLOW_SPEECH_ONSET_MS;
  delete process.env.DINGOFLOW_SPEECH_PREROLL_MS;
  delete process.env.DINGOFLOW_SPEECH_NOISE_MARGIN_DB;
  delete process.env.DINGOFLOW_NATIVE_VAD_ENABLED;
  delete process.env.DINGOFLOW_NATIVE_VAD_MODE;
  delete process.env.DINGOFLOW_NATIVE_VAD_FRAME_MS;
  delete process.env.DINGOFLOW_PARAKEET_CTX_LEFT;
  delete process.env.DINGOFLOW_PARAKEET_CTX_RIGHT;
  delete process.env.DINGOFLOW_PARAKEET_STREAM_DEPTH;
};

afterEach(() => {
  clearEnv();
});

describe('resolveConfig', () => {
  it('resolves defaults with offline enabled', () => {
    const config = resolveConfig();

    expect(config.enforceOffline).toBe(true);
    expect(config.asrBackend).toBe('parakeet-native');
    expect(config.recorderBackend).toBe('auto');
    expect(config.asrTransport).toBe('framed');
    expect(config.latencyPreset).toBe('balanced');
    expect(config.hotkey).toBe('CommandOrControl+Shift+Space');
    expect(config.injectionRetryCount).toBe(2);
    expect(config.injectionRetryDelayMs).toBe(120);
    expect(config.spokenFormattingCommands).toBe(true);
    expect(config.nativeTextInjectBin).toContain('native/text_injector/bin/dingoflow-text-injector');
    expect(config.nativeAsrBin).toContain('native/asr_worker/target/release/dingoflow-asr-worker');
    expect(config.nativeParakeetBin).toContain(
      'native/parakeet_worker/target/release/dingoflow-parakeet-worker'
    );
    expect(config.nativeAsrThreads).toBe(4);
    expect(config.liveStreamChunkMs).toBeGreaterThanOrEqual(20);
    expect(config.minAsrWindowMs).toBeLessThanOrEqual(config.normalAsrWindowMs);
    expect(config.normalAsrWindowMs).toBeLessThanOrEqual(config.backlogAsrWindowMs);
    expect(config.backlogAsrWindowMs).toBeLessThanOrEqual(config.maxAsrWindowMs);
    expect(config.parakeetFinalPass).toBe(false);
    expect(config.silenceGateDbfs).toBe(-52);
    expect(config.speechHangoverMs).toBe(420);
    expect(config.speechOnsetMs).toBe(140);
    expect(config.speechPrerollMs).toBe(180);
    expect(config.speechNoiseFloorMarginDb).toBe(12);
    expect(config.nativeVadEnabled).toBe(true);
    expect(config.nativeVadMode).toBe('very-aggressive');
    expect(config.nativeVadFrameMs).toBe(20);
  });

  it('switches ASR defaults when parakeet backend is selected', () => {
    process.env.DINGOFLOW_ASR_BACKEND = 'parakeet-mlx';
    const config = resolveConfig();

    expect(config.asrBackend).toBe('parakeet-mlx');
    expect(config.asrScriptPath).toContain('python/parakeet_runner.py');
    expect(config.asrModelPath).toContain('models/parakeet-tdt-0.6b-v3');
  });

  it('switches ASR defaults when whisper-native backend is selected', () => {
    process.env.DINGOFLOW_ASR_BACKEND = 'whisper-native';
    const config = resolveConfig();

    expect(config.asrBackend).toBe('whisper-native');
    expect(config.asrModelPath).toContain('models/ggml-base.en.bin');
  });

  it('switches ASR defaults when parakeet-native backend is selected', () => {
    process.env.DINGOFLOW_ASR_BACKEND = 'parakeet-native';
    const config = resolveConfig();

    expect(config.asrBackend).toBe('parakeet-native');
    expect(config.asrModelPath).toContain('models/parakeet-tdt-0.6b-v3-onnx');
  });

  it('supports cloud backend config', () => {
    process.env.DINGOFLOW_ASR_BACKEND = 'cloud';
    process.env.OPENAI_API_KEY = 'test-key';
    const config = resolveConfig();

    expect(config.asrBackend).toBe('cloud');
    expect(config.cloudAsrUrl).toBe('ws://127.0.0.1:8787');
    expect(config.cloudServerAsrBackend).toBe('parakeet-native');
    expect(config.openaiTranscribeModel).toBe('gpt-4o-transcribe');
    expect(config.openaiCleanupModel).toBe('gpt-5-mini');
  });

  it('parses explicit offline override', () => {
    process.env.DINGOFLOW_ENFORCE_OFFLINE = 'false';
    const config = resolveConfig();

    expect(config.enforceOffline).toBe(false);
  });

  it('parses spoken formatting command toggle', () => {
    process.env.DINGOFLOW_SPOKEN_FORMATTING_COMMANDS = 'false';
    const config = resolveConfig();
    expect(config.spokenFormattingCommands).toBe(false);
  });

  it('applies ultra latency preset defaults', () => {
    process.env.DINGOFLOW_LATENCY_PRESET = 'ultra';
    const config = resolveConfig();

    expect(config.latencyPreset).toBe('ultra');
    expect(config.liveStreamChunkMs).toBeLessThanOrEqual(90);
    expect(config.normalAsrWindowMs).toBeLessThanOrEqual(140);
    expect(config.parakeetFinalPass).toBe(false);
  });

  it('enables parakeet final pass by default for quality preset', () => {
    process.env.DINGOFLOW_LATENCY_PRESET = 'quality';
    const config = resolveConfig();
    expect(config.parakeetFinalPass).toBe(true);
  });

  it('allows explicit parakeet final pass override', () => {
    process.env.DINGOFLOW_LATENCY_PRESET = 'quality';
    process.env.DINGOFLOW_PARAKEET_FINAL_PASS = 'false';
    const config = resolveConfig();
    expect(config.parakeetFinalPass).toBe(false);
  });
});

describe('validateConfig', () => {
  it('returns no errors for defaults', () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const config = resolveConfig();
    expect(validateConfig(config)).toEqual([]);
  });

  it('requires openai api key for cloud backend', () => {
    process.env.DINGOFLOW_ASR_BACKEND = 'cloud';
    const config = resolveConfig();
    const errors = validateConfig(config);
    expect(errors).toContain('OPENAI_API_KEY must not be empty when DINGOFLOW_ASR_BACKEND=cloud.');
  });

  it('flags invalid numeric ranges and missing fields', () => {
    process.env.DINGOFLOW_ASR_BACKEND = 'faster-whisper';
    process.env.DINGOFLOW_FORMATTER_MAX_TOKENS = '12';
    process.env.DINGOFLOW_PASTE_DELAY_MS = '-1';
    process.env.DINGOFLOW_INJECTION_RETRY_COUNT = '0';
    process.env.DINGOFLOW_INJECTION_RETRY_DELAY_MS = '7000';
    process.env.DINGOFLOW_HOTKEY = '   ';
    process.env.DINGOFLOW_NATIVE_AUDIO_BIN = '   ';
    process.env.DINGOFLOW_NATIVE_TEXT_INJECT_BIN = '   ';
    process.env.DINGOFLOW_NATIVE_ASR_BIN = '   ';
    process.env.DINGOFLOW_NATIVE_PARAKEET_BIN = '   ';
    process.env.DINGOFLOW_NATIVE_ASR_THREADS = '0';
    process.env.DINGOFLOW_PYTHON_BIN = '   ';
    process.env.DINGOFLOW_STREAM_CHUNK_MS = '10';
    process.env.DINGOFLOW_ASR_WINDOW_MIN_MS = '300';
    process.env.DINGOFLOW_ASR_WINDOW_NORMAL_MS = '200';
    process.env.DINGOFLOW_ASR_WINDOW_BACKLOG_MS = '100';
    process.env.DINGOFLOW_ASR_WINDOW_MAX_MS = '50';
    process.env.DINGOFLOW_PARAKEET_CTX_LEFT = '2';
    process.env.DINGOFLOW_PARAKEET_CTX_RIGHT = '0';
    process.env.DINGOFLOW_PARAKEET_STREAM_DEPTH = '0';
    process.env.DINGOFLOW_SILENCE_GATE_DBFS = '-5';
    process.env.DINGOFLOW_SPEECH_HANGOVER_MS = '20';
    process.env.DINGOFLOW_SPEECH_ONSET_MS = '20';
    process.env.DINGOFLOW_SPEECH_PREROLL_MS = '2001';
    process.env.DINGOFLOW_SPEECH_NOISE_MARGIN_DB = '2';
    process.env.DINGOFLOW_NATIVE_VAD_FRAME_MS = '25';

    const config = resolveConfig();
    const errors = validateConfig({
      ...config,
      nativeVadMode: 'bad-mode' as typeof config.nativeVadMode
    });

    expect(errors).toContain('DINGOFLOW_FORMATTER_MAX_TOKENS must be between 32 and 8192.');
    expect(errors).toContain('DINGOFLOW_PASTE_DELAY_MS must be between 0 and 2000 milliseconds.');
    expect(errors).toContain('DINGOFLOW_INJECTION_RETRY_COUNT must be between 1 and 8.');
    expect(errors).toContain('DINGOFLOW_INJECTION_RETRY_DELAY_MS must be between 0 and 5000 milliseconds.');
    expect(errors).toContain('DINGOFLOW_HOTKEY must not be empty.');
    expect(errors).toContain('DINGOFLOW_NATIVE_AUDIO_BIN must not be empty.');
    expect(errors).toContain('DINGOFLOW_NATIVE_TEXT_INJECT_BIN must not be empty.');
    expect(errors).toContain('DINGOFLOW_NATIVE_ASR_BIN must not be empty.');
    expect(errors).toContain('DINGOFLOW_NATIVE_PARAKEET_BIN must not be empty.');
    expect(errors).toContain('DINGOFLOW_NATIVE_ASR_THREADS must be between 1 and 64.');
    expect(errors).toContain('DINGOFLOW_PYTHON_BIN must not be empty.');
    expect(errors).toContain('DINGOFLOW_STREAM_CHUNK_MS must be between 20 and 600 milliseconds.');
    expect(errors).toContain(
      'ASR window settings must satisfy: MIN <= NORMAL <= BACKLOG <= MAX. Check DINGOFLOW_ASR_WINDOW_*_MS values.'
    );
    expect(errors).toContain('DINGOFLOW_PARAKEET_CTX_LEFT must be between 8 and 1024.');
    expect(errors).toContain('DINGOFLOW_PARAKEET_CTX_RIGHT must be between 1 and 256.');
    expect(errors).toContain('DINGOFLOW_PARAKEET_STREAM_DEPTH must be between 1 and 32.');
    expect(errors).toContain('DINGOFLOW_SILENCE_GATE_DBFS must be between -90 and -10.');
    expect(errors).toContain('DINGOFLOW_SPEECH_HANGOVER_MS must be between 80 and 2000 milliseconds.');
    expect(errors).toContain('DINGOFLOW_SPEECH_ONSET_MS must be between 40 and 1000 milliseconds.');
    expect(errors).toContain('DINGOFLOW_SPEECH_PREROLL_MS must be between 0 and 1000 milliseconds.');
    expect(errors).toContain('DINGOFLOW_SPEECH_NOISE_MARGIN_DB must be between 3 and 30.');
    expect(errors).toContain(
      'DINGOFLOW_NATIVE_VAD_MODE must be one of: quality, low-bitrate, aggressive, very-aggressive.'
    );
    expect(errors).toContain('DINGOFLOW_NATIVE_VAD_FRAME_MS must be one of: 10, 20, 30.');
  });

  it('flags unsupported ASR backend values', () => {
    const config = resolveConfig();
    const invalidConfig = { ...config, asrBackend: 'bad-backend' as typeof config.asrBackend };
    const errors = validateConfig(invalidConfig);
    expect(errors).toContain(
      'DINGOFLOW_ASR_BACKEND must be one of: faster-whisper, parakeet-mlx, parakeet-native, whisper-native, cloud.'
    );
  });

  it('flags unsupported recorder/asr transport/preset values', () => {
    const config = resolveConfig();
    const invalidConfig = {
      ...config,
      recorderBackend: 'bad-recorder' as typeof config.recorderBackend,
      asrTransport: 'bad-transport' as typeof config.asrTransport,
      latencyPreset: 'bad-preset' as typeof config.latencyPreset
    };
    const errors = validateConfig(invalidConfig);
    expect(errors).toContain('DINGOFLOW_RECORDER_BACKEND must be one of: auto, ffmpeg, native-rust.');
    expect(errors).toContain('DINGOFLOW_ASR_TRANSPORT must be one of: jsonl, framed.');
    expect(errors).toContain('DINGOFLOW_LATENCY_PRESET must be one of: ultra, balanced, quality.');
  });

  it('requires framed transport for whisper-native backend', () => {
    process.env.DINGOFLOW_ASR_BACKEND = 'whisper-native';
    process.env.DINGOFLOW_ASR_TRANSPORT = 'jsonl';
    const config = resolveConfig();
    const errors = validateConfig(config);
    expect(errors).toContain(
      'DINGOFLOW_ASR_TRANSPORT must be framed when DINGOFLOW_ASR_BACKEND=whisper-native.'
    );
  });

  it('requires framed transport for parakeet-native backend', () => {
    process.env.DINGOFLOW_ASR_BACKEND = 'parakeet-native';
    process.env.DINGOFLOW_ASR_TRANSPORT = 'jsonl';
    const config = resolveConfig();
    const errors = validateConfig(config);
    expect(errors).toContain(
      'DINGOFLOW_ASR_TRANSPORT must be framed when DINGOFLOW_ASR_BACKEND=parakeet-native.'
    );
  });
});
