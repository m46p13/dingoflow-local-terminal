import { StructuredLogger } from '../../logging/StructuredLogger';
import { AsrResult, AppConfig } from '../../types';
import { PersistentFramedWorker } from '../process/PersistentFramedWorker';
import { PersistentJsonWorker } from '../process/PersistentJsonWorker';

interface StreamStartOptions {
  contextLeft?: number;
  contextRight?: number;
  depth?: number;
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

export class FasterWhisperClient {
  private readonly worker:
    | PersistentJsonWorker
    | PersistentFramedWorker;
  private readonly supportsStatefulStreaming: boolean;
  private readonly useFramedTransport: boolean;
  private readonly useWhisperNativeBackend: boolean;
  private readonly useParakeetNativeBackend: boolean;

  public constructor(
    private readonly config: AppConfig,
    private readonly logger?: StructuredLogger
  ) {
    this.useWhisperNativeBackend = this.config.asrBackend === 'whisper-native';
    this.useParakeetNativeBackend = this.config.asrBackend === 'parakeet-native';
    this.useFramedTransport =
      this.useWhisperNativeBackend || this.useParakeetNativeBackend || this.config.asrTransport === 'framed';
    const parakeetNativeMinAudioMs = Math.max(this.config.minAsrWindowMs, 140);
    const parakeetNativeDecodeIntervalMs = Math.max(this.config.minAsrWindowMs, 90);
    const parakeetNativeMaxWindowMs = clamp(this.config.maxAsrWindowMs * 8, 2400, 8000);
    const parakeetNativeLeftContextMs = clamp(this.config.normalAsrWindowMs * 3, 500, 1600);
    const parakeetNativeStabilityHoldMs = clamp(
      Math.floor(this.config.minAsrWindowMs * 1.2),
      90,
      220
    );

    if (this.useWhisperNativeBackend) {
      this.worker = new PersistentFramedWorker({
        name: 'asr-native',
        command: this.config.nativeAsrBin,
        args: [
          '--model',
          this.config.asrModelPath,
          '--threads',
          String(this.config.nativeAsrThreads),
          '--serve'
        ],
        logger: this.logger
      });
    } else if (this.useParakeetNativeBackend) {
      this.worker = new PersistentFramedWorker({
        name: 'parakeet-native',
        command: this.config.nativeParakeetBin,
        args: [
          '--model',
          this.config.asrModelPath,
          '--threads',
          String(this.config.nativeAsrThreads),
          '--stream-min-audio-ms',
          String(parakeetNativeMinAudioMs),
          '--stream-decode-interval-ms',
          String(parakeetNativeDecodeIntervalMs),
          '--stream-max-window-ms',
          String(parakeetNativeMaxWindowMs),
          '--stream-left-context-ms',
          String(parakeetNativeLeftContextMs),
          '--stream-stability-hold-ms',
          String(parakeetNativeStabilityHoldMs),
          '--serve'
        ],
        logger: this.logger
      });
    } else {
      const baseArgs = [this.config.asrScriptPath, '--serve', '--model', this.config.asrModelPath];
      const backendArgs =
        this.config.asrBackend === 'parakeet-mlx'
          ? []
          : ['--device', this.config.asrDevice, '--compute-type', this.config.asrComputeType];
      const transportArgs = this.useFramedTransport ? ['--framed-io'] : [];

      this.worker = this.useFramedTransport
        ? new PersistentFramedWorker({
            name: 'asr',
            command: this.config.pythonBin,
            args: [...baseArgs, ...backendArgs, ...transportArgs],
            env: this.makeOfflineEnv(),
            logger: this.logger
          })
        : new PersistentJsonWorker({
            name: 'asr',
            command: this.config.pythonBin,
            args: [...baseArgs, ...backendArgs],
            env: this.makeOfflineEnv(),
            logger: this.logger
          });
    }

    this.supportsStatefulStreaming =
      this.config.asrBackend === 'parakeet-mlx' || this.config.asrBackend === 'parakeet-native';
  }

  public async warmup(): Promise<void> {
    await this.worker.start();
    await this.worker.request({ action: 'warmup' }, 20000);
  }

  public async transcribe(audioInput: string | Buffer, sampleRate = 16000): Promise<AsrResult> {
    const response =
      typeof audioInput === 'string'
        ? await this.worker.request<AsrResult>(
            {
              action: 'transcribe',
              audio: audioInput
            },
            120000
          )
        : await this.worker.request<AsrResult>(
            this.useFramedTransport
              ? {
                  action: 'transcribe',
                  sampleRate
                }
              : {
                  action: 'transcribe',
                  audioBase64: audioInput.toString('base64'),
                  sampleRate
                },
            120000,
            this.useFramedTransport ? audioInput : undefined
          );

    if (!response.text) {
      return { ...response, text: '' };
    }

    return response;
  }

  public async startStream(sampleRate = 16000, options: StreamStartOptions = {}): Promise<void> {
    if (!this.supportsStatefulStreaming) {
      return;
    }

    await this.worker.start();
    await this.worker.request(
      {
        action: 'stream_reset',
        sampleRate,
        contextLeft: options.contextLeft,
        contextRight: options.contextRight,
        depth: options.depth
      },
      20000
    );
  }

  public async pushStream(audioChunk: Buffer, sampleRate = 16000): Promise<AsrResult> {
    if (!this.supportsStatefulStreaming) {
      return this.transcribe(audioChunk, sampleRate);
    }

    const response = await this.worker.request<AsrResult>(
      this.useFramedTransport
        ? {
            action: 'stream_push',
            sampleRate
          }
        : {
            action: 'stream_push',
            audioBase64: audioChunk.toString('base64'),
            sampleRate
          },
      120000,
      this.useFramedTransport ? audioChunk : undefined
    );

    return response.text ? response : { ...response, text: '' };
  }

  public async flushStream(): Promise<AsrResult> {
    if (!this.supportsStatefulStreaming) {
      return { text: '' };
    }

    const response = await this.worker.request<AsrResult>(
      {
        action: 'stream_flush'
      },
      60000
    );

    return response.text ? response : { ...response, text: '' };
  }

  public async stopStream(): Promise<void> {
    if (!this.supportsStatefulStreaming) {
      return;
    }

    await this.worker
      .request(
        {
          action: 'stream_close'
        },
        10000
      )
      .catch(() => undefined);
  }

  public async shutdown(): Promise<void> {
    await this.worker.stop();
  }

  private makeOfflineEnv(): NodeJS.ProcessEnv {
    if (!this.config.enforceOffline) {
      return { ...process.env };
    }

    return {
      ...process.env,
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1'
    };
  }
}
