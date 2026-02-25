import fs from 'node:fs';
import { ChildProcess, spawn } from 'node:child_process';
import { StructuredLogger } from '../../logging/StructuredLogger';
import { AudioRecorder, RealtimeStreamOptions } from './AudioRecorder';

const START_TIMEOUT_MS = 3000;
const AUDIO_SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;

const normalizeNativeError = (raw: string): string => {
  const detail = raw.trim();

  if (/permission|not permitted|not authorized/i.test(detail)) {
    return 'Microphone permission denied. Grant microphone access in System Settings > Privacy & Security > Microphone, then restart DingoFlow.';
  }

  if (/no input device|default input device not available/i.test(detail)) {
    return 'No microphone input device available. Connect/enable a microphone and retry.';
  }

  if (detail) {
    return `Native recorder failed: ${detail}`;
  }

  return 'Native recorder failed.';
};

export class RustNativeRecorder implements AudioRecorder {
  private process: ChildProcess | undefined;
  private pendingChunks: Buffer[] = [];
  private pendingChunkOffset = 0;
  private pendingBytes = 0;
  private chunkByteSize = 0;
  private onChunk: ((chunk: Buffer) => void) | undefined;

  public constructor(
    private readonly binaryPath: string,
    private readonly logger?: StructuredLogger
  ) {}

  public isRecording(): boolean {
    return Boolean(this.process);
  }

  public async startStreaming(options: RealtimeStreamOptions): Promise<void> {
    if (this.process) {
      throw new Error('Recorder is already active');
    }

    if (options.chunkDurationMs < 20 || options.chunkDurationMs > 2000) {
      throw new Error('chunkDurationMs must be between 20 and 2000.');
    }

    if (!fs.existsSync(this.binaryPath)) {
      throw new Error(
        `Native recorder binary not found at '${this.binaryPath}'. Run scripts/build_native_audio.sh first.`
      );
    }

    this.onChunk = options.onChunk;
    this.pendingChunks = [];
    this.pendingChunkOffset = 0;
    this.pendingBytes = 0;
    this.chunkByteSize = Math.max(
      1,
      Math.floor((AUDIO_SAMPLE_RATE * BYTES_PER_SAMPLE * options.chunkDurationMs) / 1000)
    );

    const child = spawn(
      this.binaryPath,
      ['--sample-rate', String(AUDIO_SAMPLE_RATE)],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    this.process = child;

    let stderrLog = '';
    let ready = false;

    child.on('close', () => {
      if (this.process === child) {
        this.process = undefined;
      }
    });

    child.stdout.on('data', (chunk) => {
      this.handleAudioData(Buffer.from(chunk));
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderrLog += text;
      if (text.includes('READY')) {
        ready = true;
      }
    });

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeoutHandle = setTimeout(() => {
        if (settled) {
          return;
        }

        settled = true;
        child.kill('SIGKILL');
        reject(new Error(normalizeNativeError(stderrLog)));
      }, START_TIMEOUT_MS);

      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeoutHandle);
        callback();
      };

      child.once('error', (error) => {
        finish(() => reject(error));
      });

      child.once('spawn', () => {
        const pollReady = (): void => {
          if (child.exitCode !== null) {
            finish(() => reject(new Error(normalizeNativeError(stderrLog))));
            return;
          }

          if (ready) {
            finish(resolve);
            return;
          }

          setTimeout(pollReady, 20);
        };

        pollReady();
      });

      child.once('close', (code) => {
        if (!settled) {
          finish(() => reject(new Error(normalizeNativeError(`${stderrLog}\nexit code=${code}`))));
        }
      });
    });

    this.logger?.info('Recorder started (native rust)', {
      binaryPath: this.binaryPath,
      sampleRate: AUDIO_SAMPLE_RATE,
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
        if (code === 0 || code === 130 || code === 255) {
          resolve();
          return;
        }

        reject(new Error(`native recorder exited with code ${code}`));
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

    this.logger?.info('Recorder stopped (native rust)');
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
        this.logger?.warn('Native recorder chunk callback failed', { detail });
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
      this.logger?.warn('Native recorder tail chunk callback failed', { detail });
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
