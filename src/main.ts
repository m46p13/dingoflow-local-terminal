import path from 'node:path';
import fs from 'node:fs';
import { app, clipboard, dialog } from 'electron';
import { resolveConfig, validateConfig } from './config';
import { runStartupChecks } from './bootstrap/startupChecks';
import { DingoFlowApp } from './core/DingoFlowApp';
import { StructuredLogger } from './logging/StructuredLogger';
import { AppConfig } from './types';
import { FasterWhisperClient } from './services/asr/FasterWhisperClient';
import { AudioRecorder } from './services/capture/AudioRecorder';
import { FfmpegRecorder } from './services/capture/FfmpegRecorder';
import { RustNativeRecorder } from './services/capture/RustNativeRecorder';
import { MlxFormatterClient } from './services/formatter/MlxFormatterClient';
import { PushToTalkHotkey } from './services/hotkey/PushToTalkHotkey';
import { TextInjector } from './services/inject/TextInjector';
import { TrayController } from './ui/TrayController';

let trayController: TrayController | undefined;
let hotkeyHandler: PushToTalkHotkey | undefined;
let orchestrator: DingoFlowApp | undefined;
let logger: StructuredLogger | undefined;

const createRecorder = (config: AppConfig, appLogger: StructuredLogger): AudioRecorder => {
  if (config.recorderBackend === 'ffmpeg') {
    appLogger.info('Recorder backend selected', { backend: 'ffmpeg' });
    return new FfmpegRecorder(config.ffmpegInputDevice, appLogger);
  }

  if (config.recorderBackend === 'native-rust') {
    appLogger.info('Recorder backend selected', {
      backend: 'native-rust',
      binaryPath: config.nativeAudioBin
    });
    return new RustNativeRecorder(config.nativeAudioBin, appLogger);
  }

  if (fs.existsSync(config.nativeAudioBin)) {
    appLogger.info('Recorder backend selected (auto)', {
      backend: 'native-rust',
      binaryPath: config.nativeAudioBin
    });
    return new RustNativeRecorder(config.nativeAudioBin, appLogger);
  }

  appLogger.warn('Native recorder binary not found; falling back to ffmpeg capture', {
    binaryPath: config.nativeAudioBin
  });
  return new FfmpegRecorder(config.ffmpegInputDevice, appLogger);
};

const bootstrap = async (): Promise<void> => {
  const config = resolveConfig();
  const configErrors = validateConfig(config);

  if (configErrors.length > 0) {
    throw new Error(`Invalid DingoFlow configuration:\n- ${configErrors.join('\n- ')}`);
  }

  if (config.enforceOffline) {
    process.env.HF_HUB_OFFLINE = '1';
    process.env.TRANSFORMERS_OFFLINE = '1';
  }

  logger = await StructuredLogger.create(path.join(app.getPath('userData'), 'logs'));
  logger.info('DingoFlow bootstrap started', {
    logPath: logger.getLogPath(),
    enforceOffline: config.enforceOffline
  });

  orchestrator = new DingoFlowApp(
    {
      recorder: createRecorder(config, logger),
      asr: new FasterWhisperClient(config, logger),
      formatter: new MlxFormatterClient(config, logger),
      injector: new TextInjector({
        clipboard,
        nativeBinaryPath: config.nativeTextInjectBin,
        pasteDelayMs: config.pasteDelayMs,
        retryCount: config.injectionRetryCount,
        retryDelayMs: config.injectionRetryDelayMs,
        logger
      })
    },
    logger,
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
      parakeetStreamContextLeft: config.parakeetStreamContextLeft,
      parakeetStreamContextRight: config.parakeetStreamContextRight,
      parakeetStreamDepth: config.parakeetStreamDepth
    }
  );

  trayController = new TrayController(orchestrator, config.hotkey);

  hotkeyHandler = new PushToTalkHotkey(
    config.hotkey,
    {
      onPress: async () => {
        await orchestrator?.handlePushToTalkPressed();
      },
      onRelease: async () => {
        await orchestrator?.handlePushToTalkReleased();
      }
    },
    logger
  );

  try {
    await runStartupChecks(config, logger);
    await orchestrator.warmupWorkers();
    await hotkeyHandler.start();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    orchestrator.setError(detail);
    logger.error('Startup checks failed', { detail });
  }

  app.on('will-quit', () => {
    hotkeyHandler?.stop();
    trayController?.destroy();
    void orchestrator?.shutdown();
  });
};

app.whenReady().then(async () => {
  if (process.platform === 'darwin') {
    app.dock?.hide();
  }

  try {
    await bootstrap();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger?.error('Fatal bootstrap failure', { detail });

    dialog.showErrorBox(
      'DingoFlow startup error',
      `${detail}\n\nCheck your .env settings for python/model paths and retry.`
    );

    app.quit();
  }
});
