import fs from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { StructuredLogger } from '../logging/StructuredLogger';
import { runCommand } from '../services/process/runCommand';
import { AppConfig } from '../types';

const assertPathExists = (absolutePath: string, label: string): void => {
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`${label} not found at '${absolutePath}'. Update your DingoFlow env config.`);
  }
};

const assertAnyPathExists = (absolutePaths: string[], label: string): void => {
  if (absolutePaths.some((item) => fs.existsSync(item))) {
    return;
  }

  const tried = absolutePaths.join(', ');
  throw new Error(`${label} not found. Checked: ${tried}`);
};

export const runStartupChecks = async (
  config: AppConfig,
  logger: StructuredLogger
): Promise<void> => {
  logger.info('Running startup checks');

  const expectedAbsolutePaths = [
    ...(config.asrBackend === 'whisper-native' || config.asrBackend === 'parakeet-native'
      ? []
      : [{ label: 'ASR script', value: config.asrScriptPath }]),
    { label: 'Formatter script', value: config.formatterScriptPath },
    { label: 'ASR model directory', value: config.asrModelPath },
    { label: 'Formatter model directory', value: config.formatterModelPath }
  ];

  for (const entry of expectedAbsolutePaths) {
    const absolute = path.resolve(entry.value);
    assertPathExists(absolute, entry.label);
  }

  if (config.asrBackend === 'whisper-native') {
    const nativeAsrPath = path.resolve(config.nativeAsrBin);
    assertPathExists(nativeAsrPath, 'Native ASR binary');
    fs.accessSync(nativeAsrPath, fsConstants.X_OK);
    await runCommand(nativeAsrPath, ['--healthcheck'], { timeoutMs: 8000 });
  } else if (config.asrBackend === 'parakeet-native') {
    const nativeParakeetPath = path.resolve(config.nativeParakeetBin);
    assertPathExists(nativeParakeetPath, 'Native Parakeet binary');
    fs.accessSync(nativeParakeetPath, fsConstants.X_OK);
    await runCommand(nativeParakeetPath, ['--healthcheck'], { timeoutMs: 8000 });

    const modelDir = path.resolve(config.asrModelPath);
    assertAnyPathExists(
      [path.join(modelDir, 'encoder-model.onnx'), path.join(modelDir, 'encoder.onnx')],
      'Parakeet native encoder model'
    );
    assertAnyPathExists(
      [path.join(modelDir, 'decoder_joint-model.onnx'), path.join(modelDir, 'decoder_joint.onnx')],
      'Parakeet native decoder model'
    );
    assertPathExists(path.join(modelDir, 'vocab.txt'), 'Parakeet native vocab');
  } else {
    if (path.isAbsolute(config.pythonBin) && fs.existsSync(config.pythonBin)) {
      fs.accessSync(config.pythonBin, fsConstants.X_OK);
    }

    await runCommand(config.pythonBin, ['--version'], { timeoutMs: 8000 });

    const asrImportSnippet =
      config.asrBackend === 'parakeet-mlx'
        ? 'import parakeet_mlx, mlx_lm; print("deps-ok")'
        : 'import faster_whisper, mlx_lm; print("deps-ok")';

    await runCommand(
      config.pythonBin,
      ['-c', asrImportSnippet],
      {
        timeoutMs: 20000,
        env: makeOfflineEnv(config.enforceOffline)
      }
    );
  }

  if (config.recorderBackend === 'ffmpeg') {
    await runCommand('ffmpeg', ['-version'], { timeoutMs: 8000 });
  } else if (config.recorderBackend === 'native-rust') {
    const nativeBinaryPath = path.resolve(config.nativeAudioBin);
    assertPathExists(nativeBinaryPath, 'Native audio binary');
    fs.accessSync(nativeBinaryPath, fsConstants.X_OK);
  } else {
    const nativeBinaryPath = path.resolve(config.nativeAudioBin);
    if (fs.existsSync(nativeBinaryPath)) {
      fs.accessSync(nativeBinaryPath, fsConstants.X_OK);
    } else {
      await runCommand('ffmpeg', ['-version'], { timeoutMs: 8000 });
    }
  }

  const nativeInjectPath = path.resolve(config.nativeTextInjectBin);
  if (fs.existsSync(nativeInjectPath)) {
    fs.accessSync(nativeInjectPath, fsConstants.X_OK);
    await runCommand(nativeInjectPath, ['--healthcheck'], { timeoutMs: 8000 });
  } else {
    logger.warn('Native text injector binary not found; osascript fallback remains active', {
      binaryPath: nativeInjectPath
    });
  }

  await runCommand('osascript', ['-e', 'return "ok"'], { timeoutMs: 8000 });

  logger.info('Startup checks completed successfully');
};

const makeOfflineEnv = (enforceOffline: boolean): NodeJS.ProcessEnv => {
  if (!enforceOffline) {
    return { ...process.env };
  }

  return {
    ...process.env,
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1'
  };
};
