import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { StructuredLogger } from '../../logging/StructuredLogger';

interface WorkerResponse {
  id?: string;
  ok?: boolean;
  result?: unknown;
  error?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeoutHandle: NodeJS.Timeout;
}

export interface PersistentFramedWorkerOptions {
  name: string;
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  logger?: StructuredLogger;
}

const FRAME_HEADER_BYTES = 8; // uint32 jsonLen + uint32 binaryLen
const RESPONSE_HEADER_BYTES = 4; // uint32 jsonLen
const MAX_RESPONSE_JSON_BYTES = 8 * 1024 * 1024;

export class PersistentFramedWorker {
  private child: ChildProcessWithoutNullStreams | undefined;
  private startPromise: Promise<void> | undefined;
  private stopping = false;
  private nextRequestId = 0;
  private stderrBuffer = '';
  private stdoutBuffer = Buffer.alloc(0);
  private pending = new Map<string, PendingRequest>();
  private stdinWriteQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly options: PersistentFramedWorkerOptions) {}

  public async start(): Promise<void> {
    if (this.child) {
      return;
    }

    if (this.startPromise) {
      await this.startPromise;
      return;
    }

    this.startPromise = this.spawnWorker();

    try {
      await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  public async request<TResponse>(
    payload: Record<string, unknown>,
    timeoutMs: number,
    binaryData?: Buffer
  ): Promise<TResponse> {
    await this.start();

    const current = this.child;
    if (!current) {
      throw new Error(`${this.options.name} worker is not running`);
    }

    const requestId = `${Date.now()}-${++this.nextRequestId}`;
    const jsonPayload = JSON.stringify({ ...payload, id: requestId });
    const jsonBytes = Buffer.from(jsonPayload, 'utf8');
    const audioBytes = binaryData && binaryData.length > 0 ? binaryData : Buffer.alloc(0);
    const header = Buffer.allocUnsafe(FRAME_HEADER_BYTES);
    header.writeUInt32LE(jsonBytes.length, 0);
    header.writeUInt32LE(audioBytes.length, 4);

    return new Promise<TResponse>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`${this.options.name} worker request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(requestId, {
        resolve: (value: unknown) => {
          resolve(value as TResponse);
        },
        reject,
        timeoutHandle
      });

      this.stdinWriteQueue = this.stdinWriteQueue
        .then(
          () =>
            new Promise<void>((writeResolve, writeReject) => {
              current.stdin.write(header, (error) => {
                if (error) {
                  writeReject(error);
                  return;
                }

                current.stdin.write(jsonBytes, (jsonError) => {
                  if (jsonError) {
                    writeReject(jsonError);
                    return;
                  }

                  if (audioBytes.length === 0) {
                    writeResolve();
                    return;
                  }

                  current.stdin.write(audioBytes, (audioError) => {
                    if (audioError) {
                      writeReject(audioError);
                      return;
                    }

                    writeResolve();
                  });
                });
              });
            })
        )
        .catch((error) => {
          const pending = this.pending.get(requestId);
          if (!pending) {
            return;
          }

          clearTimeout(pending.timeoutHandle);
          this.pending.delete(requestId);
          pending.reject(error);
        });
    });
  }

  public async stop(): Promise<void> {
    this.stopping = true;

    const current = this.child;
    if (!current) {
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;

      const finish = (): void => {
        if (settled) {
          return;
        }

        settled = true;
        resolve();
      };

      current.once('close', () => {
        finish();
      });

      setTimeout(() => {
        if (!settled) {
          current.kill('SIGKILL');
          finish();
        }
      }, 1500);

      current.kill('SIGTERM');
    });

    this.child = undefined;
  }

  private async spawnWorker(): Promise<void> {
    this.stopping = false;

    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.options.command, this.options.args, {
        env: this.options.env,
        stdio: 'pipe'
      });

      const onError = (error: Error): void => {
        this.child = undefined;
        reject(error);
      };

      child.once('error', onError);
      child.once('spawn', () => {
        child.off('error', onError);

        this.child = child;
        this.stdoutBuffer = Buffer.alloc(0);
        this.stderrBuffer = '';
        this.stdinWriteQueue = Promise.resolve();

        child.stdout.on('data', (chunk) => {
          this.handleStdoutChunk(Buffer.from(chunk));
        });

        child.stderr.on('data', (chunk) => {
          const text = chunk.toString();
          this.stderrBuffer = this.tailString(`${this.stderrBuffer}${text}`, 4000);
          this.options.logger?.warn(`${this.options.name} worker stderr`, {
            detail: text.trim()
          });
        });

        child.on('close', (code, signal) => {
          if (this.stopping) {
            this.options.logger?.info(`${this.options.name} worker stopped`, {
              code,
              signal
            });
          } else {
            this.options.logger?.warn(`${this.options.name} worker exited`, {
              code,
              signal,
              stderr: this.stderrBuffer.trim()
            });
          }

          this.child = undefined;
          this.rejectAllPending(
            new Error(`${this.options.name} worker exited (code=${code}, signal=${signal ?? 'none'})`)
          );
        });

        this.options.logger?.info(`${this.options.name} worker started`, {
          command: this.options.command
        });

        resolve();
      });
    });
  }

  private handleStdoutChunk(chunk: Buffer): void {
    const safeChunk = Buffer.from(chunk);
    this.stdoutBuffer =
      this.stdoutBuffer.length === 0
        ? safeChunk
        : Buffer.concat([this.stdoutBuffer, safeChunk]);

    while (this.stdoutBuffer.length >= RESPONSE_HEADER_BYTES) {
      const jsonLength = this.stdoutBuffer.readUInt32LE(0);
      if (jsonLength <= 0 || jsonLength > MAX_RESPONSE_JSON_BYTES) {
        this.options.logger?.warn(`${this.options.name} framed worker produced invalid response length`, {
          jsonLength
        });
        this.stdoutBuffer = Buffer.alloc(0);
        return;
      }

      const frameBytes = RESPONSE_HEADER_BYTES + jsonLength;
      if (this.stdoutBuffer.length < frameBytes) {
        return;
      }

      const responseJson = this.stdoutBuffer.subarray(RESPONSE_HEADER_BYTES, frameBytes).toString('utf8');
      this.stdoutBuffer = Buffer.from(this.stdoutBuffer.subarray(frameBytes));

      let parsed: WorkerResponse;
      try {
        parsed = JSON.parse(responseJson) as WorkerResponse;
      } catch {
        this.options.logger?.debug(`${this.options.name} worker emitted invalid framed JSON`, {
          responseJson
        });
        continue;
      }

      const responseId = parsed.id;
      if (!responseId) {
        this.options.logger?.debug(`${this.options.name} worker response missing id`, {
          responseJson
        });
        continue;
      }

      const pending = this.pending.get(responseId);
      if (!pending) {
        this.options.logger?.debug(`${this.options.name} worker response for unknown request`, {
          responseId
        });
        continue;
      }

      clearTimeout(pending.timeoutHandle);
      this.pending.delete(responseId);

      if (parsed.ok === false) {
        pending.reject(new Error(parsed.error ?? `${this.options.name} worker request failed`));
        continue;
      }

      pending.resolve(parsed.result);
    }
  }

  private rejectAllPending(error: Error): void {
    const entries = Array.from(this.pending.values());
    this.pending.clear();

    for (const entry of entries) {
      clearTimeout(entry.timeoutHandle);
      entry.reject(error);
    }
  }

  private tailString(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
      return value;
    }

    return value.slice(value.length - maxLength);
  }
}
