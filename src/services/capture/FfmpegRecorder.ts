import { ChildProcess, spawn } from 'node:child_process';
import { StructuredLogger } from '../../logging/StructuredLogger';
import { AudioRecorder, RealtimeStreamOptions } from './AudioRecorder';

const START_STABILITY_DELAY_MS = 300;
const DEFAULT_SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2; // s16le mono

const normalizeMicError = (raw: string): string => {
  const detail = raw.trim();

  if (/Operation not permitted|not authorized|Permission denied/i.test(detail)) {
    return 'Microphone permission denied. Grant microphone access in System Settings > Privacy & Security > Microphone, then restart DingoFlow.';
  }

  if (/Input\/output error|No such file|device not found|could not find/i.test(detail)) {
    return 'Microphone input device is unavailable. Verify DINGOFLOW_FFMPEG_INPUT and test with scripts/list_audio_devices.sh.';
  }

  if (detail) {
    return `Microphone capture failed: ${detail}`;
  }

  return 'Microphone capture failed. Verify ffmpeg availability and microphone permissions.';
};

export class FfmpegRecorder implements AudioRecorder {
  private process: ChildProcess | undefined;
  private pendingChunks: Buffer[] = [];
  private pendingChunkOffset = 0;
  private pendingBytes = 0;
  private chunkByteSize = 0;
  private onChunk: ((chunk: Buffer) => void) | undefined;

  public constructor(
    private readonly inputDevice: string,
    private readonly logger?: StructuredLogger
  ) {}

  public isRecording(): boolean {
    return Boolean(this.process);
  }

  public async startStreaming(options: RealtimeStreamOptions): Promise<void> {
    if (this.process) {
      throw new Error('Recorder is already active');
    }

    if (options.chunkDurationMs < 40 || options.chunkDurationMs > 2000) {
      throw new Error('chunkDurationMs must be between 40 and 2000.');
    }

    this.onChunk = options.onChunk;
    this.pendingChunks = [];
    this.pendingChunkOffset = 0;
    this.pendingBytes = 0;
    this.chunkByteSize = Math.max(
      1,
      Math.floor((DEFAULT_SAMPLE_RATE * BYTES_PER_SAMPLE * options.chunkDurationMs) / 1000)
    );

    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'avfoundation',
      '-i',
      this.inputDevice,
      '-ac',
      '1',
      '-ar',
      String(DEFAULT_SAMPLE_RATE),
      '-f',
      's16le',
      '-acodec',
      'pcm_s16le',
      'pipe:1'
    ];

    const ffmpeg = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderrLog = '';
    let settled = false;

    ffmpeg.on('close', () => {
      if (this.process === ffmpeg) {
        this.process = undefined;
      }
    });

    ffmpeg.stderr.on('data', (chunk) => {
      stderrLog += chunk.toString();
    });

    ffmpeg.stdout.on('data', (chunk) => {
      this.handleAudioData(Buffer.from(chunk));
    });

    await new Promise<void>((resolve, reject) => {
      ffmpeg.once('error', (error) => {
        if (settled) {
          return;
        }

        settled = true;
        reject(error);
      });

      ffmpeg.once('spawn', () => {
        setTimeout(() => {
          if (settled) {
            return;
          }

          if (ffmpeg.exitCode !== null) {
            settled = true;
            reject(new Error(normalizeMicError(stderrLog)));
            return;
          }

          this.process = ffmpeg;
          settled = true;
          resolve();
        }, START_STABILITY_DELAY_MS);
      });

      ffmpeg.once('close', (code) => {
        if (settled) {
          return;
        }

        settled = true;
        reject(new Error(normalizeMicError(`${stderrLog}\nexit code=${code}`)));
      });
    });

    this.logger?.info('Recorder started (stream mode)', {
      inputDevice: this.inputDevice,
      sampleRate: DEFAULT_SAMPLE_RATE,
      chunkByteSize: this.chunkByteSize
    });
  }

  public async stop(): Promise<void> {
    const current = this.process;
    if (!current) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      current.once('close', (code) => {
        this.process = undefined;
        if (code === 0 || code === 255) {
          resolve();
          return;
        }

        reject(new Error(`ffmpeg exited with code ${code}`));
      });

      current.once('error', (error) => {
        this.process = undefined;
        reject(error);
      });

      current.kill('SIGINT');
    });

    this.flushPendingTailChunk();
    this.pendingChunks = [];
    this.pendingChunkOffset = 0;
    this.pendingBytes = 0;
    this.onChunk = undefined;

    this.logger?.info('Recorder stopped');
  }

  private handleAudioData(chunk: Buffer): void {
    if (!this.onChunk || chunk.length === 0 || this.chunkByteSize <= 0) {
      return;
    }

    this.pendingChunks.push(Buffer.from(chunk));
    this.pendingBytes += chunk.length;

    while (this.pendingBytes >= this.chunkByteSize) {
      const nextChunk = this.readPendingBytes(this.chunkByteSize);
      if (!nextChunk) {
        break;
      }

      try {
        this.onChunk(nextChunk);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.logger?.warn('Recorder chunk callback failed', { detail });
      }
    }
  }

  private flushPendingTailChunk(): void {
    if (!this.onChunk || this.pendingBytes < Math.floor(this.chunkByteSize / 2)) {
      return;
    }

    const tail = this.readPendingBytes(this.pendingBytes);
    if (!tail) {
      return;
    }

    try {
      this.onChunk(tail);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger?.warn('Recorder tail chunk callback failed', { detail });
    }
  }

  private readPendingBytes(byteCount: number): Buffer | undefined {
    if (byteCount <= 0 || byteCount > this.pendingBytes) {
      return undefined;
    }

    const output = Buffer.allocUnsafe(byteCount);
    let writeOffset = 0;

    while (writeOffset < byteCount) {
      const head = this.pendingChunks[0];
      if (!head) {
        break;
      }

      const available = head.length - this.pendingChunkOffset;
      const toCopy = Math.min(available, byteCount - writeOffset);
      head.copy(output, writeOffset, this.pendingChunkOffset, this.pendingChunkOffset + toCopy);

      writeOffset += toCopy;
      this.pendingChunkOffset += toCopy;
      this.pendingBytes -= toCopy;

      if (this.pendingChunkOffset >= head.length) {
        this.pendingChunks.shift();
        this.pendingChunkOffset = 0;
      }
    }

    return writeOffset === byteCount ? output : output.subarray(0, writeOffset);
  }
}
