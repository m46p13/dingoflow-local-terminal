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

export interface PersistentJsonWorkerOptions {
  name: string;
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  logger?: StructuredLogger;
}

export class PersistentJsonWorker {
  private child: ChildProcessWithoutNullStreams | undefined;
  private startPromise: Promise<void> | undefined;
  private stopping = false;
  private nextRequestId = 0;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private pending = new Map<string, PendingRequest>();

  public constructor(private readonly options: PersistentJsonWorkerOptions) {}

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

    if (binaryData && binaryData.length > 0) {
      throw new Error(`${this.options.name} worker does not support binary request payloads`);
    }

    const requestId = `${Date.now()}-${++this.nextRequestId}`;

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

      const serialized = JSON.stringify({ ...payload, id: requestId });
      current.stdin.write(`${serialized}\n`, (error) => {
        if (!error) {
          return;
        }

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
        this.stdoutBuffer = '';
        this.stderrBuffer = '';

        child.stdout.on('data', (chunk) => {
          this.handleStdoutChunk(chunk.toString());
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

  private handleStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;

    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf('\n');
      if (newlineIndex === -1) {
        break;
      }

      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);

      if (!line) {
        continue;
      }

      let parsed: WorkerResponse;

      try {
        parsed = JSON.parse(line) as WorkerResponse;
      } catch {
        this.options.logger?.debug(`${this.options.name} worker emitted non-JSON line`, {
          line
        });
        continue;
      }

      const responseId = parsed.id;
      if (!responseId) {
        this.options.logger?.debug(`${this.options.name} worker response missing id`, {
          line
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

  private tailString(text: string, limit: number): string {
    if (text.length <= limit) {
      return text;
    }

    return text.slice(text.length - limit);
  }
}
