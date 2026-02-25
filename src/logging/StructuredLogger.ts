import fs from 'node:fs/promises';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  [key: string]: unknown;
}

interface LogEntry extends LogContext {
  ts: string;
  level: LogLevel;
  message: string;
}

export class StructuredLogger {
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(private readonly filePath: string) {}

  public static async create(logDir: string): Promise<StructuredLogger> {
    await fs.mkdir(logDir, { recursive: true });

    const datePrefix = new Date().toISOString().slice(0, 10);
    const filePath = path.join(logDir, `dingoflow-${datePrefix}.log`);

    return new StructuredLogger(filePath);
  }

  public getLogPath(): string {
    return this.filePath;
  }

  public debug(message: string, context: LogContext = {}): void {
    this.write('debug', message, context);
  }

  public info(message: string, context: LogContext = {}): void {
    this.write('info', message, context);
  }

  public warn(message: string, context: LogContext = {}): void {
    this.write('warn', message, context);
  }

  public error(message: string, context: LogContext = {}): void {
    this.write('error', message, context);
  }

  private write(level: LogLevel, message: string, context: LogContext): void {
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      message,
      ...context
    };

    const line = `${JSON.stringify(entry)}\n`;

    this.writeQueue = this.writeQueue
      .then(async () => {
        await fs.appendFile(this.filePath, line, 'utf8');
      })
      .catch((error) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`[DingoFlow] Failed to write log file: ${detail}`);
      });

    if (level === 'error') {
      console.error(`[DingoFlow] ${message}`, context);
      return;
    }

    if (level === 'warn') {
      console.warn(`[DingoFlow] ${message}`, context);
      return;
    }

    console.log(`[DingoFlow] ${message}`, context);
  }
}
