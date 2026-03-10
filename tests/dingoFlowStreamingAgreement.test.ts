import { describe, expect, it } from 'vitest';
import { DingoFlowApp } from '../src/core/DingoFlowApp';
import { AudioRecorder, RealtimeStreamOptions } from '../src/services/capture/AudioRecorder';
import { AsrResult, DictationResult, LivePreviewState } from '../src/types';

class FakeRecorder implements AudioRecorder {
  private recording = false;
  private options: RealtimeStreamOptions | undefined;

  public isRecording(): boolean {
    return this.recording;
  }

  public async startStreaming(options: RealtimeStreamOptions): Promise<void> {
    this.recording = true;
    this.options = options;
  }

  public async stop(): Promise<void> {
    this.recording = false;
  }

  public emit(chunk: Buffer): void {
    this.options?.onChunk(chunk);
  }
}

class FakeAsrService {
  private pushIndex = 0;

  public constructor(
    private readonly pushResults: AsrResult[],
    private readonly flushResult: AsrResult
  ) {}

  public async warmup(): Promise<void> {}

  public async transcribe(): Promise<AsrResult> {
    return { text: '' };
  }

  public async startStream(): Promise<void> {}

  public async pushStream(): Promise<AsrResult> {
    const result = this.pushResults[this.pushIndex] ?? { text: '' };
    this.pushIndex += 1;
    return result;
  }

  public async flushStream(): Promise<AsrResult> {
    return this.flushResult;
  }

  public async stopStream(): Promise<void> {}

  public async shutdown(): Promise<void> {}
}

class FakeInjector {
  public readonly injected: string[] = [];

  public async inject(text: string): Promise<void> {
    this.injected.push(text);
  }

  public async replaceRecentText(): Promise<void> {}
}

const flushAsync = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
};

const makeSpeechChunk = (): Buffer => {
  const samples = 1920;
  const chunk = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    chunk.writeInt16LE(12000, index * 2);
  }
  return chunk;
};

describe('DingoFlowApp streaming agreement', () => {
  it('commits only the stable prefix of successive previews and flushes the tail', async () => {
    const recorder = new FakeRecorder();
    const injector = new FakeInjector();
    const asr = new FakeAsrService(
      [
        { text: '', previewText: 'hello' },
        { text: '', previewText: 'hello world' },
        { text: '', previewText: 'hello world again' },
        { text: '', previewText: 'hello world again' }
      ],
      { text: '', previewText: 'hello world again' }
    );
    const previews: LivePreviewState[] = [];
    const results: DictationResult[] = [];

    const app = new DingoFlowApp(
      {
        recorder,
        asr,
        formatter: {
          warmup: async () => undefined,
          shutdown: async () => undefined,
          format: async (_mode, transcript) => transcript
        },
        injector
      },
      undefined,
      {
        asrBackend: 'parakeet-native',
        spokenFormattingCommands: false,
        liveStreamChunkMs: 120,
        minAsrWindowMs: 60,
        normalAsrWindowMs: 120,
        backlogAsrWindowMs: 240,
        maxAsrWindowMs: 480,
        adaptiveAsrWindow: false,
        parakeetFinalPass: false,
        silenceGateDbfs: -60,
        speechHangoverMs: 240,
        speechOnsetMs: 40,
        speechPrerollMs: 0,
        speechNoiseFloorMarginDb: 6,
        parakeetStreamContextLeft: 64,
        parakeetStreamContextRight: 8,
        parakeetStreamDepth: 1
      }
    );

    app.on('livePreviewChanged', (preview) => {
      previews.push(preview);
    });
    app.on('dictationCompleted', (result) => {
      results.push(result);
    });

    await app.handlePushToTalkPressed();

    recorder.emit(makeSpeechChunk());
    await flushAsync();
    recorder.emit(makeSpeechChunk());
    await flushAsync();
    recorder.emit(makeSpeechChunk());
    await flushAsync();
    recorder.emit(makeSpeechChunk());
    await flushAsync();

    await app.handlePushToTalkReleased();

    expect(injector.injected).toEqual(['hello ', 'world ', 'again ']);
    expect(previews.map((preview) => preview.previewText)).toContain('hello world again');
    expect(results).toEqual([
      {
        rawTranscript: 'hello world again',
        formattedText: 'hello world again'
      }
    ]);
  });
});
