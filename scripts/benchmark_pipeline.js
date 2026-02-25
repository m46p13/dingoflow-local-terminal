#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const parseArgs = (argv) => {
  const args = {
    audio: path.join(process.cwd(), 'tmp', 'jfk_16k.pcm'),
    chunkMs: 90,
    releaseTailMs: 200
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--audio' && i + 1 < argv.length) {
      args.audio = path.resolve(argv[i + 1]);
      i += 1;
      continue;
    }

    if (token === '--chunk-ms' && i + 1 < argv.length) {
      args.chunkMs = Number.parseInt(argv[i + 1], 10);
      i += 1;
      continue;
    }

    if (token === '--release-tail-ms' && i + 1 < argv.length) {
      args.releaseTailMs = Number.parseInt(argv[i + 1], 10);
      i += 1;
      continue;
    }
  }

  return args;
};

const percentile = (values, p) => {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[idx];
};

class ReplayRecorder {
  constructor(audioPcmBuffer) {
    this.audio = audioPcmBuffer;
    this.timer = undefined;
    this.onChunk = undefined;
    this.offset = 0;
    this.chunkBytes = 0;
    this.active = false;
  }

  isRecording() {
    return this.active;
  }

  async startStreaming(options) {
    if (this.active) {
      throw new Error('replay recorder already active');
    }

    this.offset = 0;
    this.onChunk = options.onChunk;
    this.chunkBytes = Math.max(
      1,
      Math.floor((SAMPLE_RATE * BYTES_PER_SAMPLE * options.chunkDurationMs) / 1000)
    );
    this.active = true;

    this.timer = setInterval(() => {
      if (!this.active || !this.onChunk) {
        return;
      }

      if (this.offset >= this.audio.length) {
        clearInterval(this.timer);
        this.timer = undefined;
        return;
      }

      const end = Math.min(this.audio.length, this.offset + this.chunkBytes);
      const chunk = this.audio.subarray(this.offset, end);
      this.offset = end;
      this.onChunk(Buffer.from(chunk));
    }, options.chunkDurationMs);
  }

  async stop() {
    this.active = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

class BenchmarkInjector {
  constructor() {
    this.injectCalls = [];
    this.replaceCalls = [];
    this.firstInjectAt = undefined;
    this.currentText = '';
  }

  async inject(text) {
    const now = Date.now();
    if (this.firstInjectAt === undefined) {
      this.firstInjectAt = now;
    }
    this.injectCalls.push({ at: now, length: text.length, text });
    this.currentText += text;
  }

  async replaceRecentText(existingText, replacementText) {
    const now = Date.now();
    this.replaceCalls.push({
      at: now,
      existingLength: existingText.length,
      replacementLength: replacementText.length
    });

    if (this.currentText.endsWith(existingText)) {
      this.currentText =
        this.currentText.slice(0, this.currentText.length - existingText.length) + replacementText;
      return;
    }

    this.currentText = replacementText;
  }
}

const run = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!Number.isFinite(args.chunkMs) || args.chunkMs < 20 || args.chunkMs > 600) {
    throw new Error('--chunk-ms must be between 20 and 600');
  }

  if (!fs.existsSync(args.audio)) {
    throw new Error(`audio file not found: ${args.audio}`);
  }

  const distRoot = path.join(process.cwd(), 'dist');
  if (!fs.existsSync(distRoot)) {
    throw new Error('dist output not found. Run `npm run build` first.');
  }

  const { resolveConfig } = require(path.join(distRoot, 'config.js'));
  const { DingoFlowApp } = require(path.join(distRoot, 'core', 'DingoFlowApp.js'));
  const { FasterWhisperClient } = require(path.join(distRoot, 'services', 'asr', 'FasterWhisperClient.js'));

  process.env.DINGOFLOW_ASR_BACKEND = process.env.DINGOFLOW_ASR_BACKEND || 'parakeet-native';
  process.env.DINGOFLOW_ASR_TRANSPORT = 'framed';
  process.env.DINGOFLOW_STREAM_CHUNK_MS = String(args.chunkMs);

  const pcm = fs.readFileSync(args.audio);
  const audioMs = (pcm.length / (SAMPLE_RATE * BYTES_PER_SAMPLE)) * 1000;
  const recorder = new ReplayRecorder(pcm);
  const baseAsr = new FasterWhisperClient(resolveConfig());
  const injector = new BenchmarkInjector();
  const asrSamples = [];
  let finalPassMs = 0;

  const asr = {
    warmup: () => baseAsr.warmup(),
    shutdown: () => baseAsr.shutdown(),
    startStream: (...params) => baseAsr.startStream(...params),
    stopStream: (...params) => baseAsr.stopStream(...params),
    flushStream: (...params) => baseAsr.flushStream(...params),
    async pushStream(audioChunk, sampleRate = SAMPLE_RATE) {
      const t0 = Date.now();
      const result = await baseAsr.pushStream(audioChunk, sampleRate);
      const elapsed = Date.now() - t0;
      const chunkMs = (audioChunk.length / (SAMPLE_RATE * BYTES_PER_SAMPLE)) * 1000;
      asrSamples.push({ elapsed, chunkMs });
      return result;
    },
    async transcribe(audioInput, sampleRate = SAMPLE_RATE) {
      const t0 = Date.now();
      const result = await baseAsr.transcribe(audioInput, sampleRate);
      finalPassMs = Date.now() - t0;
      return result;
    }
  };

  const formatter = {
    warmup: async () => undefined,
    shutdown: async () => undefined,
    format: async (_mode, transcript) => transcript
  };

  const options = resolveConfig();
  const app = new DingoFlowApp(
    {
      recorder,
      asr,
      formatter,
      injector
    },
    undefined,
    {
      asrBackend: options.asrBackend,
      spokenFormattingCommands: options.spokenFormattingCommands,
      liveStreamChunkMs: args.chunkMs,
      minAsrWindowMs: options.minAsrWindowMs,
      normalAsrWindowMs: options.normalAsrWindowMs,
      backlogAsrWindowMs: options.backlogAsrWindowMs,
      maxAsrWindowMs: options.maxAsrWindowMs,
      adaptiveAsrWindow: options.adaptiveAsrWindow,
      parakeetFinalPass: options.parakeetFinalPass,
      parakeetStreamContextLeft: options.parakeetStreamContextLeft,
      parakeetStreamContextRight: options.parakeetStreamContextRight,
      parakeetStreamDepth: options.parakeetStreamDepth
    }
  );

  let stateError = undefined;
  app.on('stateChanged', (state) => {
    if (state.stage === 'error') {
      stateError = state.detail || 'unknown error';
    }
  });

  const donePromise = new Promise((resolve) => {
    app.once('dictationCompleted', (result) => resolve(result));
  });

  await app.warmupWorkers();
  const pressAt = Date.now();
  await app.handlePushToTalkPressed();
  await sleep(audioMs + args.releaseTailMs);
  const releaseAt = Date.now();
  await app.handlePushToTalkReleased();

  const result = await donePromise;
  const completedAt = Date.now();
  await app.shutdown();

  if (stateError) {
    throw new Error(stateError);
  }

  const asrMsValues = asrSamples.map((sample) => sample.elapsed);
  const asrRtfValues = asrSamples.map((sample) =>
    sample.chunkMs > 0 ? sample.elapsed / sample.chunkMs : 0
  );

  const summary = {
    backend: options.asrBackend,
    parakeetFinalPass: options.parakeetFinalPass,
    audioFile: args.audio,
    audioMs: Math.round(audioMs),
    chunkMs: args.chunkMs,
    pushCalls: asrSamples.length,
    asrMs: {
      avg: Math.round(asrMsValues.reduce((sum, value) => sum + value, 0) / Math.max(1, asrMsValues.length)),
      p50: Math.round(percentile(asrMsValues, 0.5)),
      p95: Math.round(percentile(asrMsValues, 0.95)),
      max: Math.round(percentile(asrMsValues, 1))
    },
    asrRtf: {
      avg: Number(
        (
          asrRtfValues.reduce((sum, value) => sum + value, 0) / Math.max(1, asrRtfValues.length)
        ).toFixed(3)
      ),
      p50: Number(percentile(asrRtfValues, 0.5).toFixed(3)),
      p95: Number(percentile(asrRtfValues, 0.95).toFixed(3)),
      max: Number(percentile(asrRtfValues, 1).toFixed(3))
    },
    firstTextMs: injector.firstInjectAt === undefined ? null : injector.firstInjectAt - pressAt,
    stopToFinalMs: completedAt - releaseAt,
    totalSessionMs: completedAt - pressAt,
    injectCalls: injector.injectCalls.length,
    replaceCalls: injector.replaceCalls.length,
    finalPassMs,
    rawTranscriptLength: result.rawTranscript.length,
    formattedLength: result.formattedText.length
  };

  console.log(JSON.stringify(summary, null, 2));
};

run().catch((error) => {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(detail);
  process.exit(1);
});
