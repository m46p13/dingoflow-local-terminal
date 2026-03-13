import WebSocket from 'ws';
import { StructuredLogger } from '../../logging/StructuredLogger';
import { AppConfig, AsrResult } from '../../types';

interface PendingRequest {
  resolve: (result: AsrResult) => void;
  reject: (error?: unknown) => void;
  timeout: NodeJS.Timeout;
}

interface CloudEnvelope {
  id: string;
  type: string;
  result?: AsrResult;
  error?: string;
}

export class CloudAsrClient {
  private socket: WebSocket | undefined;
  private connectPromise: Promise<void> | undefined;
  private nextId = 0;
  private pending = new Map<string, PendingRequest>();

  public constructor(
    private readonly config: AppConfig,
    private readonly logger?: StructuredLogger
  ) {}

  public async warmup(): Promise<void> {
    await this.ensureConnected();
    await this.request('warmup', {}, 10000);
  }

  public async transcribe(audioInput: string | Buffer, sampleRate = 16000): Promise<AsrResult> {
    const audio = typeof audioInput === 'string' ? '' : audioInput.toString('base64');
    return this.request(
      'transcribe',
      {
        audioBase64: audio,
        sampleRate
      },
      120000
    );
  }

  public async startStream(sampleRate = 16000): Promise<void> {
    await this.ensureConnected();
    await this.request(
      'stream_reset',
      {
        sampleRate
      },
      10000
    );
  }

  public async pushStream(audioChunk: Buffer, sampleRate = 16000): Promise<AsrResult> {
    return this.request(
      'stream_push',
      {
        audioBase64: audioChunk.toString('base64'),
        sampleRate
      },
      30000
    );
  }

  public async flushStream(): Promise<AsrResult> {
    return this.request('stream_flush', {}, 120000);
  }

  public async stopStream(): Promise<void> {
    await this.request('stream_close', {}, 10000).catch(() => undefined);
  }

  public async shutdown(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    if (!socket) {
      return;
    }
    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      socket.close();
    });
  }

  private async ensureConnected(): Promise<void> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.config.cloudAsrUrl, {
        headers: this.config.cloudApiKey ? { authorization: `Bearer ${this.config.cloudApiKey}` } : undefined
      });

      socket.once('open', () => {
        this.socket = socket;
        this.logger?.info('Cloud ASR socket connected', {
          url: this.config.cloudAsrUrl
        });
        resolve();
      });

      socket.once('error', (error) => {
        reject(error);
      });

      socket.on('message', (raw) => {
        this.handleMessage(raw.toString());
      });

      socket.on('close', () => {
        this.socket = undefined;
        const error = new Error('Cloud ASR socket closed');
        for (const [id, pending] of this.pending.entries()) {
          clearTimeout(pending.timeout);
          pending.reject(error);
          this.pending.delete(id);
        }
      });
    }).finally(() => {
      this.connectPromise = undefined;
    });

    return this.connectPromise;
  }

  private request(type: string, payload: Record<string, unknown>, timeoutMs: number): Promise<AsrResult> {
    return this.ensureConnected().then(
      () =>
        new Promise<AsrResult>((resolve, reject) => {
          const socket = this.socket;
          if (!socket || socket.readyState !== WebSocket.OPEN) {
            reject(new Error('Cloud ASR socket is not connected'));
            return;
          }

          const id = `${Date.now()}-${++this.nextId}`;
          const timeout = setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`Cloud ASR request timed out after ${timeoutMs}ms (${type})`));
          }, timeoutMs);

          this.pending.set(id, { resolve, reject, timeout });
          socket.send(JSON.stringify({ id, type, ...payload }), (error) => {
            if (!error) {
              return;
            }
            clearTimeout(timeout);
            this.pending.delete(id);
            reject(error);
          });
        })
    );
  }

  private handleMessage(raw: string): void {
    let message: CloudEnvelope;
    try {
      message = JSON.parse(raw) as CloudEnvelope;
    } catch {
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(message.id);

    if (message.error) {
      pending.reject(new Error(message.error));
      return;
    }

    pending.resolve(message.result ?? { text: '' });
  }
}
