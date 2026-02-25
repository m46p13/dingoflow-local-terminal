import { EventEmitter } from 'node:events';
import { StructuredLogger } from '../logging/StructuredLogger';
import { LatencyTracker } from '../perf/LatencyTracker';
import { SpokenFormattingProcessor } from '../services/commands/SpokenFormattingProcessor';
import { AsrBackend, AsrResult, DictationResult, FormatMode, AppState } from '../types';
import { AudioRecorder } from '../services/capture/AudioRecorder';

const AUDIO_SAMPLE_RATE = 16000;

export interface DingoFlowLatencyOptions {
  asrBackend: AsrBackend;
  spokenFormattingCommands: boolean;
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
}

const DEFAULT_LATENCY_OPTIONS: DingoFlowLatencyOptions = {
  asrBackend: 'parakeet-native',
  spokenFormattingCommands: true,
  liveStreamChunkMs: 120,
  minAsrWindowMs: 90,
  normalAsrWindowMs: 180,
  backlogAsrWindowMs: 360,
  maxAsrWindowMs: 640,
  adaptiveAsrWindow: true,
  parakeetFinalPass: false,
  silenceGateDbfs: -52,
  speechHangoverMs: 420,
  parakeetStreamContextLeft: 64,
  parakeetStreamContextRight: 8,
  parakeetStreamDepth: 1
};

interface WarmableService {
  warmup?: () => Promise<void>;
  shutdown?: () => Promise<void>;
}

interface AsrStreamStartOptions {
  contextLeft?: number;
  contextRight?: number;
  depth?: number;
}

interface AsrService extends WarmableService {
  transcribe: (audioInput: string | Buffer, sampleRate?: number) => Promise<AsrResult>;
  startStream?: (sampleRate?: number, options?: AsrStreamStartOptions) => Promise<void>;
  pushStream?: (audioChunk: Buffer, sampleRate?: number) => Promise<AsrResult>;
  flushStream?: () => Promise<AsrResult>;
  stopStream?: () => Promise<void>;
}

interface FormatterService extends WarmableService {
  format: (mode: FormatMode, transcript: string) => Promise<string>;
}

interface InjectorService {
  inject: (text: string) => Promise<void>;
  replaceRecentText?: (existingText: string, replacementText: string) => Promise<void>;
}

export interface DingoFlowDependencies {
  recorder: AudioRecorder;
  asr: AsrService;
  formatter: FormatterService;
  injector: InjectorService;
}

interface QueuedAudioChunk {
  data: Buffer;
  offset: number;
  enqueuedAtMs: number;
}

interface PendingAudioSlice {
  data: Buffer;
  oldestEnqueuedAtMs: number;
}

export declare interface DingoFlowApp {
  on(event: 'stateChanged', listener: (state: AppState) => void): this;
  on(event: 'modeChanged', listener: (mode: FormatMode) => void): this;
  on(event: 'dictationCompleted', listener: (result: DictationResult) => void): this;
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

export class DingoFlowApp extends EventEmitter {
  private state: AppState = { stage: 'idle' };
  private mode: FormatMode = 'clean';
  private stopInProgress = false;
  private recordingActive = false;
  private acceptingAudio = false;
  private asrRequestCount = 0;
  private rawTranscriptParts: string[] = [];
  private liveInjectedText = '';
  private sessionAudioChunks: Buffer[] = [];
  private pendingAudioQueue: QueuedAudioChunk[] = [];
  private pendingAudioBytes = 0;
  private asrLoopActive = false;
  private asrLoopPromise: Promise<void> | undefined;
  private readonly latencyTracker = new LatencyTracker();
  private readonly spokenFormattingProcessor = new SpokenFormattingProcessor();

  // Runtime latency tuning state.
  private dynamicNormalAsrWindowMs: number;
  private ewmaAsrRtf = 1.0;
  private ewmaAsrMs = 0;
  private speechHangoverUntilMs = 0;

  public constructor(
    private readonly deps: DingoFlowDependencies,
    private readonly logger?: StructuredLogger,
    private readonly options: DingoFlowLatencyOptions = DEFAULT_LATENCY_OPTIONS
  ) {
    super();
    this.dynamicNormalAsrWindowMs = options.normalAsrWindowMs;
  }

  public getState(): AppState {
    return this.state;
  }

  public getMode(): FormatMode {
    return this.mode;
  }

  public setMode(mode: FormatMode): void {
    this.mode = mode;
    this.emit('modeChanged', mode);
    this.logger?.info('Format mode changed', { mode });
  }

  public async warmupWorkers(): Promise<void> {
    this.setState({ stage: 'transcribing', detail: 'Warming ASR worker' });
    await this.deps.asr.warmup?.();

    this.setState({ stage: 'formatting', detail: 'Warming formatter worker' });
    await this.deps.formatter.warmup?.();

    this.setState({ stage: 'idle' });
    this.logger?.info('Workers warmed and ready');
  }

  public async handlePushToTalkPressed(): Promise<void> {
    if (this.state.stage === 'recording') {
      return;
    }

    if (this.state.stage !== 'idle' && this.state.stage !== 'error') {
      return;
    }

    try {
      await this.startRecording();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.setState({ stage: 'error', detail });
      this.logger?.error('Failed to start recording', { detail });
    }
  }

  public async handlePushToTalkReleased(): Promise<void> {
    if (this.state.stage !== 'recording' || this.stopInProgress) {
      return;
    }

    this.stopInProgress = true;

    try {
      await this.stopAndProcess();
    } finally {
      this.stopInProgress = false;
    }
  }

  public async runPipelineTest(): Promise<void> {
    if (this.state.stage !== 'idle' && this.state.stage !== 'error') {
      return;
    }

    const testTranscript = 'this is a dingoflow test pipeline run';

    try {
      this.setState({ stage: 'formatting', detail: 'Running pipeline test' });
      const formattedText = await this.deps.formatter.format(this.mode, testTranscript);

      this.setState({ stage: 'injecting', detail: 'Injecting test output' });
      await this.deps.injector.inject(formattedText || testTranscript);

      this.emit('dictationCompleted', {
        rawTranscript: testTranscript,
        formattedText: formattedText || testTranscript
      });

      this.setState({ stage: 'idle', detail: 'Pipeline test complete' });
      this.logger?.info('Pipeline test completed');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.setState({ stage: 'error', detail });
      this.logger?.error('Pipeline test failed', { detail });
    }
  }

  public setError(detail: string): void {
    this.setState({ stage: 'error', detail });
  }

  public clearError(): void {
    if (this.state.stage === 'error') {
      this.setState({ stage: 'idle' });
    }
  }

  public async shutdown(): Promise<void> {
    this.acceptingAudio = false;
    this.recordingActive = false;
    await this.deps.recorder.stop().catch(() => undefined);
    await this.waitForAsrDrain();
    await this.deps.asr.shutdown?.().catch(() => undefined);
    await this.deps.formatter.shutdown?.().catch(() => undefined);
    this.sessionAudioChunks = [];
  }

  private async startRecording(): Promise<void> {
    this.recordingActive = true;
    this.acceptingAudio = true;
    this.asrRequestCount = 0;
    this.rawTranscriptParts = [];
    this.liveInjectedText = '';
    this.sessionAudioChunks = [];
    this.pendingAudioQueue = [];
    this.pendingAudioBytes = 0;
    this.asrLoopActive = false;
    this.asrLoopPromise = undefined;
    this.dynamicNormalAsrWindowMs = this.options.normalAsrWindowMs;
    this.ewmaAsrRtf = 1.0;
    this.ewmaAsrMs = this.options.normalAsrWindowMs;
    this.speechHangoverUntilMs = 0;
    this.latencyTracker.reset();

    try {
      await this.deps.recorder.startStreaming({
        chunkDurationMs: this.options.liveStreamChunkMs,
        onChunk: (chunk) => {
          if (!this.acceptingAudio || chunk.length === 0) {
            return;
          }

          this.enqueueAudioChunk(chunk);
        }
      });

      await this.deps.asr.startStream?.(AUDIO_SAMPLE_RATE, {
        contextLeft: this.options.parakeetStreamContextLeft,
        contextRight: this.options.parakeetStreamContextRight,
        depth: this.options.parakeetStreamDepth
      });
    } catch (error) {
      this.acceptingAudio = false;
      this.recordingActive = false;
      await this.deps.recorder.stop().catch(() => undefined);
      this.pendingAudioQueue = [];
      this.pendingAudioBytes = 0;
      throw error;
    }

    this.setState({ stage: 'recording', detail: 'Live dictation (adaptive streaming)' });
    this.logger?.info('Recording started (adaptive streaming mode)', {
      asrBackend: this.options.asrBackend,
      streamChunkMs: this.options.liveStreamChunkMs,
      sampleRate: AUDIO_SAMPLE_RATE,
      adaptiveAsrWindow: this.options.adaptiveAsrWindow,
      minAsrWindowMs: this.options.minAsrWindowMs,
      normalAsrWindowMs: this.options.normalAsrWindowMs,
      backlogAsrWindowMs: this.options.backlogAsrWindowMs,
      maxAsrWindowMs: this.options.maxAsrWindowMs,
      parakeetCtxLeft: this.options.parakeetStreamContextLeft,
      parakeetCtxRight: this.options.parakeetStreamContextRight,
      parakeetDepth: this.options.parakeetStreamDepth
    });
  }

  private async stopAndProcess(): Promise<void> {
    try {
      this.recordingActive = false;
      await this.deps.recorder.stop();
      this.acceptingAudio = false;

      this.setState({ stage: 'transcribing', detail: 'Draining audio queue' });
      await this.waitForAsrDrain();
      await this.processStreamFlush();

      let rawTranscript = this.rawTranscriptParts
        .join('')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();

      if (
        this.options.asrBackend === 'parakeet-native' &&
        this.options.parakeetFinalPass &&
        this.sessionAudioChunks.length > 0
      ) {
        this.setState({ stage: 'transcribing', detail: 'Final native Parakeet pass' });
        const fullAudio = Buffer.concat(this.sessionAudioChunks);
        const finalPass = await this.deps.asr
          .transcribe(fullAudio, AUDIO_SAMPLE_RATE)
          .catch((error: unknown) => {
            const detail = error instanceof Error ? error.message : String(error);
            this.logger?.warn('Final native Parakeet pass failed; using live transcript', { detail });
            return undefined;
          });

        const finalRawTranscript = finalPass?.text.trim();
        if (finalRawTranscript) {
          if (finalRawTranscript !== rawTranscript && this.deps.injector.replaceRecentText) {
            this.setState({ stage: 'injecting', detail: 'Applying final ASR correction' });
            await this.deps.injector.replaceRecentText(this.liveInjectedText.trimEnd(), finalRawTranscript);
            this.liveInjectedText = `${finalRawTranscript} `;
          }

          rawTranscript = finalRawTranscript;
        }
      }

      if (!rawTranscript) {
        this.setState({ stage: 'idle', detail: 'No speech detected' });
        return;
      }

      this.setState({ stage: 'formatting', detail: 'Final formatting pass' });
      const formattedText = await this.deps.formatter
        .format(this.mode, rawTranscript)
        .catch((error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error);
          this.logger?.warn('Final formatter pass failed; using live transcript', { detail });
          return rawTranscript;
        });

      const finalText = formattedText.trim() || rawTranscript;

      if (finalText !== rawTranscript && this.deps.injector.replaceRecentText) {
        this.setState({ stage: 'injecting', detail: 'Applying formatted correction' });
        await this.deps.injector.replaceRecentText(this.liveInjectedText.trimEnd(), finalText);
      }

      this.emit('dictationCompleted', {
        rawTranscript,
        formattedText: finalText
      });

      this.setState({ stage: 'idle' });
      this.logger?.info('Dictation completed (adaptive streaming mode)', {
        transcriptLength: rawTranscript.length,
        outputLength: finalText.length,
        asrRequests: this.asrRequestCount,
        avgAsrMs: Math.round(this.ewmaAsrMs),
        avgAsrRtf: Number(this.ewmaAsrRtf.toFixed(3)),
        latencySummary: this.latencyTracker.summarize()
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.setState({ stage: 'error', detail });
      this.logger?.error('Pipeline failed', { detail });
    } finally {
      await this.deps.asr.stopStream?.().catch(() => undefined);
      this.acceptingAudio = false;
      this.recordingActive = false;
      this.asrRequestCount = 0;
      this.rawTranscriptParts = [];
      this.liveInjectedText = '';
      this.pendingAudioQueue = [];
      this.pendingAudioBytes = 0;
      this.sessionAudioChunks = [];
      this.asrLoopActive = false;
      this.asrLoopPromise = undefined;
      this.latencyTracker.reset();
    }
  }

  private enqueueAudioChunk(chunk: Buffer): void {
    this.sessionAudioChunks.push(Buffer.from(chunk));
    this.pendingAudioQueue.push({
      data: Buffer.from(chunk),
      offset: 0,
      enqueuedAtMs: Date.now()
    });
    this.pendingAudioBytes += chunk.length;

    this.ensureAsrLoop();
  }

  private ensureAsrLoop(): void {
    if (this.asrLoopActive) {
      return;
    }

    this.asrLoopActive = true;
    this.asrLoopPromise = this.runAsrLoop();
  }

  private async runAsrLoop(): Promise<void> {
    try {
      while (true) {
        const next = this.takeNextAudioSlice(!this.recordingActive);
        if (!next) {
          break;
        }

        const requestId = ++this.asrRequestCount;
        await this.processAudioSlice(next, requestId);
      }
    } finally {
      this.asrLoopActive = false;
      this.asrLoopPromise = undefined;

      // Guard against races where audio arrived while loop was finishing.
      if (this.shouldContinueLoop()) {
        this.ensureAsrLoop();
      }
    }
  }

  private shouldContinueLoop(): boolean {
    if (this.pendingAudioBytes === 0) {
      return false;
    }

    if (!this.recordingActive) {
      return true;
    }

    return this.pendingAudioBytes >= this.msToBytes(this.options.minAsrWindowMs);
  }

  private takeNextAudioSlice(forceFlush: boolean): PendingAudioSlice | undefined {
    const pending = this.pendingAudioBytes;
    if (pending === 0) {
      return undefined;
    }

    const minBytes = this.msToBytes(this.options.minAsrWindowMs);
    if (!forceFlush && pending < minBytes) {
      return undefined;
    }

    const pendingMs = this.bytesToMs(pending);
    let targetMs = this.options.adaptiveAsrWindow
      ? this.dynamicNormalAsrWindowMs
      : this.options.normalAsrWindowMs;

    if (pendingMs >= this.options.backlogAsrWindowMs * 2) {
      targetMs = this.options.maxAsrWindowMs;
    } else if (pendingMs >= this.options.backlogAsrWindowMs) {
      targetMs = Math.max(targetMs, this.options.backlogAsrWindowMs);
    }

    targetMs = clamp(targetMs, this.options.minAsrWindowMs, this.options.maxAsrWindowMs);

    const takeBytes = forceFlush ? pending : Math.min(pending, this.msToBytes(targetMs));
    if (takeBytes <= 0) {
      return undefined;
    }

    return this.readPendingAudioSlice(takeBytes);
  }

  private async waitForAsrDrain(): Promise<void> {
    if (this.pendingAudioBytes > 0) {
      this.ensureAsrLoop();
    }

    while (this.asrLoopPromise) {
      await this.asrLoopPromise;
      if (this.pendingAudioBytes > 0) {
        this.ensureAsrLoop();
      }
    }
  }

  private async processAudioSlice(audioSlice: PendingAudioSlice, requestId: number): Promise<void> {
    const queueDelayMs = Math.max(0, Date.now() - audioSlice.oldestEnqueuedAtMs);
    const audioMs = this.bytesToMs(audioSlice.data.length);
    const audioLevelDbfs = this.estimateDbfs(audioSlice.data);
    const nowMs = Date.now();
    const hasSpeechEnergy = audioLevelDbfs >= this.options.silenceGateDbfs;
    if (hasSpeechEnergy) {
      this.speechHangoverUntilMs = nowMs + this.options.speechHangoverMs;
    } else if (nowMs > this.speechHangoverUntilMs) {
      this.logger?.debug('Skipping low-energy audio slice', {
        requestId,
        audioMs: Math.round(audioMs),
        audioLevelDbfs: Number(audioLevelDbfs.toFixed(1)),
        silenceGateDbfs: this.options.silenceGateDbfs
      });
      return;
    }

    const asrStartedAt = Date.now();

    const asrResult = await (this.deps.asr.pushStream
      ? this.deps.asr.pushStream(audioSlice.data, AUDIO_SAMPLE_RATE)
      : this.deps.asr.transcribe(audioSlice.data, AUDIO_SAMPLE_RATE)
    ).catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger?.debug('ASR audio slice failed', { requestId, detail });
      return undefined;
    });

    const asrElapsedMs = Date.now() - asrStartedAt;
    this.updateAdaptiveWindow(audioMs, asrElapsedMs, this.bytesToMs(this.pendingAudioBytes));

    if (!asrResult) {
      return;
    }

    const rawChunk = asrResult.text.trim();
    if (!rawChunk) {
      return;
    }

    const commandResult = this.options.spokenFormattingCommands
      ? this.spokenFormattingProcessor.transform(rawChunk)
      : { text: rawChunk, appliedCommands: 0 };
    if (!commandResult.text) {
      return;
    }

    const normalizedChunk = this.normalizeLiveChunkOutput(commandResult.text);
    if (!normalizedChunk) {
      return;
    }

    const dedupedChunk = this.dedupeChunkAgainstLiveTranscript(normalizedChunk);
    if (!dedupedChunk) {
      return;
    }

    this.rawTranscriptParts.push(dedupedChunk);
    this.liveInjectedText += dedupedChunk;

    const injectStartedAt = Date.now();
    await this.deps.injector.inject(dedupedChunk);
    const injectElapsedMs = Date.now() - injectStartedAt;
    const endToEndMs = Math.max(0, Date.now() - audioSlice.oldestEnqueuedAtMs);
    this.latencyTracker.push({
      queueMs: queueDelayMs,
      audioMs,
      asrMs: asrElapsedMs,
      injectMs: injectElapsedMs,
      endToEndMs
    });

    this.logger?.info('Live slice injected', {
      requestId,
      rawLength: rawChunk.length,
      commandLength: commandResult.text.length,
      spokenCommandsApplied: commandResult.appliedCommands,
      outputLength: dedupedChunk.length,
      asrElapsedMs,
      injectElapsedMs,
      audioMs,
      queueDelayMs,
      endToEndMs,
      pendingMs: Math.round(this.bytesToMs(this.pendingAudioBytes)),
      normalWindowMs: this.dynamicNormalAsrWindowMs
    });
  }

  private estimateDbfs(audio: Buffer): number {
    if (audio.length < 2) {
      return -120;
    }

    let sumSquares = 0;
    let sampleCount = 0;
    for (let index = 0; index + 1 < audio.length; index += 2) {
      const sample = audio.readInt16LE(index) / 32768;
      sumSquares += sample * sample;
      sampleCount += 1;
    }

    if (sampleCount === 0) {
      return -120;
    }

    const rms = Math.sqrt(sumSquares / sampleCount);
    if (rms <= 0) {
      return -120;
    }

    return 20 * Math.log10(rms);
  }

  private updateAdaptiveWindow(audioMs: number, asrElapsedMs: number, pendingMs: number): void {
    const alpha = 0.18;
    const rtf = asrElapsedMs / Math.max(audioMs, 1);
    this.ewmaAsrRtf = this.ewmaAsrRtf * (1 - alpha) + rtf * alpha;
    this.ewmaAsrMs = this.ewmaAsrMs * (1 - alpha) + asrElapsedMs * alpha;

    if (!this.options.adaptiveAsrWindow) {
      return;
    }

    let next = this.dynamicNormalAsrWindowMs;

    if (pendingMs >= this.options.backlogAsrWindowMs || this.ewmaAsrRtf > 1.0) {
      next += 24;
    } else if (pendingMs <= this.options.minAsrWindowMs && this.ewmaAsrRtf < 0.68) {
      next -= 10;
    } else if (pendingMs <= this.options.normalAsrWindowMs / 2 && this.ewmaAsrRtf < 0.8) {
      next -= 4;
    }

    const clamped = clamp(next, this.options.minAsrWindowMs, this.options.maxAsrWindowMs);
    if (clamped !== this.dynamicNormalAsrWindowMs) {
      this.dynamicNormalAsrWindowMs = clamped;
      this.logger?.debug('Adaptive ASR window updated', {
        normalWindowMs: clamped,
        pendingMs: Math.round(pendingMs),
        ewmaAsrRtf: Number(this.ewmaAsrRtf.toFixed(3)),
        ewmaAsrMs: Math.round(this.ewmaAsrMs)
      });
    }
  }

  private async processStreamFlush(): Promise<void> {
    if (this.options.asrBackend === 'parakeet-native') {
      return;
    }

    if (!this.deps.asr.flushStream) {
      return;
    }

    const tailResult = await this.deps.asr.flushStream().catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger?.debug('ASR stream flush failed', { detail });
      return undefined;
    });

    if (!tailResult || !tailResult.text.trim()) {
      return;
    }

    const tailText = tailResult.text.trim();
    const tailCommandResult = this.options.spokenFormattingCommands
      ? this.spokenFormattingProcessor.transform(tailText)
      : { text: tailText, appliedCommands: 0 };
    if (!tailCommandResult.text) {
      return;
    }

    const normalizedTail = this.normalizeLiveChunkOutput(tailCommandResult.text);
    if (!normalizedTail) {
      return;
    }

    this.rawTranscriptParts.push(normalizedTail);
    this.liveInjectedText += normalizedTail;
    await this.deps.injector.inject(normalizedTail);

    this.logger?.info('Live stream flush injected', {
      rawLength: tailText.length,
      commandLength: tailCommandResult.text.length,
      spokenCommandsApplied: tailCommandResult.appliedCommands,
      outputLength: normalizedTail.length
    });
  }

  private normalizeLiveChunkOutput(text: string): string {
    const normalizedEdges = text.replace(/^[ \t]+|[ \t]+$/g, '');
    if (!normalizedEdges) {
      return '';
    }

    if (/[\s\n]$/.test(normalizedEdges)) {
      return normalizedEdges;
    }

    return `${normalizedEdges} `;
  }

  private dedupeChunkAgainstLiveTranscript(nextChunk: string): string {
    if (!nextChunk.trim() || !this.liveInjectedText.trim()) {
      return nextChunk;
    }

    // Preserve explicit spoken formatting structure.
    if (nextChunk.includes('\n') || this.liveInjectedText.includes('\n')) {
      return nextChunk;
    }

    const existingWords = this.liveInjectedText.trim().split(/\s+/);
    const nextWords = nextChunk.trim().split(/\s+/);
    if (existingWords.length === 0 || nextWords.length === 0) {
      return nextChunk;
    }

    const normalizeWord = (word: string): string =>
      word
        .toLowerCase()
        .replace(/^[^a-z0-9']+/g, '')
        .replace(/[^a-z0-9']+$/g, '');
    const existingNormalized = existingWords.map(normalizeWord);
    const nextNormalized = nextWords.map(normalizeWord);

    const overlapLimit = Math.min(existingWords.length, nextWords.length, 20);
    let overlapWords = 0;

    for (let size = overlapLimit; size >= 1; size -= 1) {
      const existingSuffix = existingNormalized.slice(-size).join(' ');
      const nextPrefix = nextNormalized.slice(0, size).join(' ');
      if (existingSuffix === nextPrefix) {
        overlapWords = size;
        break;
      }
    }

    if (overlapWords === 0 && nextWords.length >= 4) {
      const searchTailWords = Math.min(existingWords.length, 28);
      const searchStart = existingWords.length - searchTailWords;
      const maxSize = Math.min(nextWords.length, 16, searchTailWords);

      outer: for (let size = maxSize; size >= 4; size -= 1) {
        const latestStart = Math.max(searchStart, existingWords.length - size - 6);
        const end = existingWords.length - size;
        for (let start = latestStart; start <= end; start += 1) {
          const existingSlice = existingNormalized.slice(start, start + size).join(' ');
          const nextSlice = nextNormalized.slice(0, size).join(' ');
          if (existingSlice === nextSlice) {
            overlapWords = size;
            break outer;
          }
        }
      }
    }

    if (overlapWords === 0) {
      return nextChunk;
    }

    const dedupedWords = nextWords.slice(overlapWords);
    if (dedupedWords.length === 0) {
      return '';
    }

    const needsTrailingWhitespace = /[\s\n]$/.test(nextChunk);
    return `${dedupedWords.join(' ')}${needsTrailingWhitespace ? ' ' : ''}`;
  }

  private msToBytes(ms: number): number {
    return Math.max(1, Math.floor((AUDIO_SAMPLE_RATE * 2 * ms) / 1000));
  }

  private readPendingAudioSlice(byteCount: number): PendingAudioSlice | undefined {
    if (byteCount <= 0 || byteCount > this.pendingAudioBytes) {
      return undefined;
    }

    const output = Buffer.allocUnsafe(byteCount);
    let writeOffset = 0;
    let oldestEnqueuedAtMs = Date.now();

    while (writeOffset < byteCount) {
      const head = this.pendingAudioQueue[0];
      if (!head) {
        break;
      }

      oldestEnqueuedAtMs = Math.min(oldestEnqueuedAtMs, head.enqueuedAtMs);
      const available = head.data.length - head.offset;
      const toCopy = Math.min(available, byteCount - writeOffset);
      head.data.copy(output, writeOffset, head.offset, head.offset + toCopy);

      writeOffset += toCopy;
      head.offset += toCopy;
      this.pendingAudioBytes -= toCopy;

      if (head.offset >= head.data.length) {
        this.pendingAudioQueue.shift();
      }
    }

    return {
      data: writeOffset === byteCount ? output : output.subarray(0, writeOffset),
      oldestEnqueuedAtMs
    };
  }

  private bytesToMs(bytes: number): number {
    return (bytes / (2 * AUDIO_SAMPLE_RATE)) * 1000;
  }

  private setState(next: AppState): void {
    this.state = next;
    this.emit('stateChanged', next);
    this.logger?.info('State changed', {
      stage: next.stage,
      detail: next.detail
    });
  }
}
