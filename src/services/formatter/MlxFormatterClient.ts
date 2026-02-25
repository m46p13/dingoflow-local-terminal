import { StructuredLogger } from '../../logging/StructuredLogger';
import { AppConfig, FormatMode } from '../../types';
import { buildFormatterPrompt, extractFormattedOutput } from './prompt';
import { PersistentJsonWorker } from '../process/PersistentJsonWorker';

interface FormatterPayload {
  text: string;
}

export class MlxFormatterClient {
  private readonly worker: PersistentJsonWorker;

  public constructor(
    private readonly config: AppConfig,
    private readonly logger?: StructuredLogger
  ) {
    this.worker = new PersistentJsonWorker({
      name: 'formatter',
      command: this.config.pythonBin,
      args: [
        this.config.formatterScriptPath,
        '--serve',
        '--model',
        this.config.formatterModelPath,
        '--max-tokens',
        String(this.config.formatterMaxTokens)
      ],
      env: this.makeOfflineEnv(),
      logger: this.logger
    });
  }

  public async warmup(): Promise<void> {
    await this.worker.start();
    await this.worker.request({ action: 'warmup' }, 25000);
  }

  public async format(mode: FormatMode, transcript: string): Promise<string> {
    if (!transcript.trim()) {
      return '';
    }

    const prompt = buildFormatterPrompt(mode, transcript);

    const payload = await this.worker.request<FormatterPayload>(
      {
        action: 'format',
        mode,
        prompt
      },
      120000
    );

    return extractFormattedOutput(payload.text);
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
