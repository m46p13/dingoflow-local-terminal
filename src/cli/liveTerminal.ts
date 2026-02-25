import readline from 'node:readline';
import { resolveConfig, validateConfig } from '../config';
import { DingoFlowApp } from '../core/DingoFlowApp';
import { RustNativeRecorder } from '../services/capture/RustNativeRecorder';
import { FasterWhisperClient } from '../services/asr/FasterWhisperClient';
import { FormatMode } from '../types';

class TerminalInjector {
  private liveText = '';

  public async inject(text: string): Promise<void> {
    this.liveText += text;
    process.stdout.write(text);
  }

  public async replaceRecentText(existingText: string, replacementText: string): Promise<void> {
    if (existingText && this.liveText.endsWith(existingText)) {
      this.liveText = `${this.liveText.slice(0, this.liveText.length - existingText.length)}${replacementText}`;
    } else {
      this.liveText = replacementText;
    }

    process.stdout.write(`\n[corrected] ${replacementText}\n`);
  }
}

const isMode = (value: string): value is FormatMode =>
  value === 'literal' || value === 'clean' || value === 'rewrite';

const printHelp = (): void => {
  process.stdout.write('\n');
  process.stdout.write('Commands:\n');
  process.stdout.write('  <enter>             Start/stop dictation\n');
  process.stdout.write('  /mode literal       Set formatter mode\n');
  process.stdout.write('  /mode clean         Set formatter mode\n');
  process.stdout.write('  /mode rewrite       Set formatter mode\n');
  process.stdout.write('  /status             Print current state\n');
  process.stdout.write('  /quit               Exit\n');
  process.stdout.write('\n');
};

const main = async (): Promise<void> => {
  // Terminal test defaults. Users can override with env vars.
  process.env.DINGOFLOW_ASR_BACKEND = process.env.DINGOFLOW_ASR_BACKEND ?? 'parakeet-native';
  process.env.DINGOFLOW_RECORDER_BACKEND = process.env.DINGOFLOW_RECORDER_BACKEND ?? 'native-rust';
  process.env.DINGOFLOW_ASR_TRANSPORT = process.env.DINGOFLOW_ASR_TRANSPORT ?? 'framed';
  process.env.DINGOFLOW_PARAKEET_FINAL_PASS = process.env.DINGOFLOW_PARAKEET_FINAL_PASS ?? 'false';
  process.env.DINGOFLOW_SPOKEN_FORMATTING_COMMANDS =
    process.env.DINGOFLOW_SPOKEN_FORMATTING_COMMANDS ?? 'true';

  const config = resolveConfig();
  const errors = validateConfig(config);
  if (errors.length > 0) {
    throw new Error(`Invalid configuration:\n- ${errors.join('\n- ')}`);
  }

  const app = new DingoFlowApp(
    {
      recorder: new RustNativeRecorder(config.nativeAudioBin),
      asr: new FasterWhisperClient(config),
      formatter: {
        warmup: async () => undefined,
        shutdown: async () => undefined,
        format: async (_mode, transcript) => transcript
      },
      injector: new TerminalInjector()
    },
    undefined,
    {
      asrBackend: config.asrBackend,
      spokenFormattingCommands: config.spokenFormattingCommands,
      liveStreamChunkMs: config.liveStreamChunkMs,
      minAsrWindowMs: config.minAsrWindowMs,
      normalAsrWindowMs: config.normalAsrWindowMs,
      backlogAsrWindowMs: config.backlogAsrWindowMs,
      maxAsrWindowMs: config.maxAsrWindowMs,
      adaptiveAsrWindow: config.adaptiveAsrWindow,
      parakeetFinalPass: config.parakeetFinalPass,
      silenceGateDbfs: config.silenceGateDbfs,
      speechHangoverMs: config.speechHangoverMs,
      parakeetStreamContextLeft: config.parakeetStreamContextLeft,
      parakeetStreamContextRight: config.parakeetStreamContextRight,
      parakeetStreamDepth: config.parakeetStreamDepth
    }
  );

  let recording = false;
  let shuttingDown = false;
  let commandChain = Promise.resolve();

  const queue = (fn: () => Promise<void>): void => {
    commandChain = commandChain
      .then(fn)
      .catch((error) => {
        const detail = error instanceof Error ? error.message : String(error);
        process.stderr.write(`\n[error] ${detail}\n`);
      });
  };

  app.on('stateChanged', (state) => {
    if (state.stage === 'error' && state.detail) {
      process.stderr.write(`\n[state:error] ${state.detail}\n`);
      return;
    }

    if (state.stage === 'recording') {
      process.stdout.write('\n[listening]\n');
      return;
    }

    if (state.stage === 'idle') {
      process.stdout.write('\n[idle]\n');
    }
  });

  app.on('dictationCompleted', (result) => {
    process.stdout.write('\n\n--- dictation completed ---\n');
    process.stdout.write(`raw: ${result.rawTranscript}\n`);
    process.stdout.write(`final: ${result.formattedText}\n`);
    process.stdout.write('---------------------------\n\n');
  });

  process.stdout.write('Warming up ASR worker...\n');
  await app.warmupWorkers();
  process.stdout.write('Ready.\n');
  process.stdout.write(`Backend: ${config.asrBackend}\n`);
  process.stdout.write(`Model: ${config.asrModelPath}\n`);
  process.stdout.write(`Recorder: ${config.nativeAudioBin}\n`);
  printHelp();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true
  });

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    if (recording) {
      await app.handlePushToTalkReleased();
      recording = false;
    }
    await app.shutdown();
    rl.close();
    process.stdout.write('\nBye.\n');
    process.exit(0);
  };

  process.on('SIGINT', () => {
    queue(shutdown);
  });

  rl.on('line', (line) => {
    const input = line.trim();

    if (input === '/quit') {
      queue(shutdown);
      return;
    }

    if (input === '/status') {
      const state = app.getState();
      process.stdout.write(`[status] stage=${state.stage}${state.detail ? ` detail=${state.detail}` : ''}\n`);
      return;
    }

    if (input.startsWith('/mode ')) {
      const mode = input.slice('/mode '.length).trim();
      if (!isMode(mode)) {
        process.stdout.write('Invalid mode. Use: literal | clean | rewrite\n');
        return;
      }
      app.setMode(mode);
      process.stdout.write(`[mode] ${mode}\n`);
      return;
    }

    if (input.length > 0 && input !== '/help') {
      process.stdout.write('Unknown command. Use /help, /status, /mode, or /quit.\n');
      return;
    }

    if (input === '/help') {
      printHelp();
      return;
    }

    queue(async () => {
      if (!recording) {
        process.stdout.write('\n[start]\n');
        await app.handlePushToTalkPressed();
        recording = true;
      } else {
        process.stdout.write('\n[stop]\n');
        await app.handlePushToTalkReleased();
        recording = false;
      }
    });
  });
};

main().catch((error) => {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${detail}\n`);
  process.exit(1);
});
