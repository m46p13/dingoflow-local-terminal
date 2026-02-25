import fs from 'node:fs';
import { StructuredLogger } from '../../logging/StructuredLogger';
import { CommandResult, runCommand } from '../process/runCommand';

interface ClipboardAdapter {
  readText: () => string;
  writeText: (text: string) => void;
}

type CommandRunner = (
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdin?: string;
    timeoutMs?: number;
  }
) => Promise<CommandResult>;

interface TextInjectorOptions {
  nativeBinaryPath?: string;
  pasteDelayMs: number;
  retryCount: number;
  retryDelayMs: number;
  clipboard: ClipboardAdapter;
  commandRunner?: CommandRunner;
  logger?: StructuredLogger;
}

const sleep = async (ms: number): Promise<void> => {
  if (ms <= 0) {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, ms));
};

const osascriptArgsForAccessibilityInsert = (text: string): string[] => [
  '-e',
  'on run argv',
  '-e',
  'set targetText to item 1 of argv',
  '-e',
  'tell application "System Events"',
  '-e',
  'tell (first application process whose frontmost is true)',
  '-e',
  'set focusedElement to value of attribute "AXFocusedUIElement"',
  '-e',
  'set value of attribute "AXSelectedText" of focusedElement to targetText',
  '-e',
  'end tell',
  '-e',
  'end tell',
  '-e',
  'end run',
  '--',
  text
];

const osascriptArgsForDirectInput = (text: string): string[] => [
  '-e',
  'on run argv',
  '-e',
  'set targetText to item 1 of argv',
  '-e',
  'tell application "System Events"',
  '-e',
  'keystroke targetText',
  '-e',
  'end tell',
  '-e',
  'end run',
  '--',
  text
];

const DIRECT_INPUT_MAX_LENGTH = 280;

export class TextInjector {
  private readonly nativeBinaryPath?: string;
  private readonly pasteDelayMs: number;
  private readonly retryCount: number;
  private readonly retryDelayMs: number;
  private readonly clipboard: ClipboardAdapter;
  private readonly commandRunner: CommandRunner;
  private readonly logger?: StructuredLogger;

  public constructor(options: TextInjectorOptions) {
    if (options.nativeBinaryPath && fs.existsSync(options.nativeBinaryPath)) {
      this.nativeBinaryPath = options.nativeBinaryPath;
    } else if (options.nativeBinaryPath) {
      options.logger?.warn('Native text injector binary not found; osascript fallback chain will be used', {
        binaryPath: options.nativeBinaryPath
      });
    }
    this.pasteDelayMs = options.pasteDelayMs;
    this.retryCount = options.retryCount;
    this.retryDelayMs = options.retryDelayMs;
    this.clipboard = options.clipboard;
    this.commandRunner = options.commandRunner ?? runCommand;
    this.logger = options.logger;
  }

  public async inject(text: string): Promise<void> {
    const finalText = text;
    if (finalText.length === 0) {
      return;
    }

    const failures: string[] = [];
    const allowDirectTyping = finalText.length <= DIRECT_INPUT_MAX_LENGTH;

    for (let attempt = 1; attempt <= this.retryCount; attempt += 1) {
      if (this.nativeBinaryPath) {
        try {
          await this.injectViaNativeInsert(finalText);
          this.logger?.info('Text injection succeeded via native AX binary', {
            attempt,
            length: finalText.length
          });
          return;
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          failures.push(`native attempt ${attempt}: ${detail}`);
          this.logger?.warn('Native text insertion failed; trying osascript fallback chain', {
            attempt,
            detail
          });
        }
      }

      try {
        await this.injectViaAccessibilityInsert(finalText);
        this.logger?.info('Text injection succeeded via accessibility selected-text insertion', {
          attempt,
          length: finalText.length
        });
        return;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        failures.push(`accessibility attempt ${attempt}: ${detail}`);
        this.logger?.warn('Accessibility text insertion failed; trying fallback', {
          attempt,
          detail
        });
      }

      if (allowDirectTyping) {
        try {
          await this.injectViaDirectInput(finalText);
          this.logger?.info('Text injection succeeded via direct accessibility keystroke', {
            attempt,
            length: finalText.length
          });
          return;
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          failures.push(`direct attempt ${attempt}: ${detail}`);
          this.logger?.warn('Direct text injection failed; falling back to clipboard paste', {
            attempt,
            detail
          });
        }
      } else {
        this.logger?.debug('Skipping direct keystroke injection for long text', {
          attempt,
          length: finalText.length,
          limit: DIRECT_INPUT_MAX_LENGTH
        });
      }

      try {
        await this.injectViaClipboardPaste(finalText);
        this.logger?.info('Text injection succeeded via clipboard fallback', {
          attempt,
          length: finalText.length
        });
        return;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        failures.push(`clipboard attempt ${attempt}: ${detail}`);
        this.logger?.warn('Clipboard text injection failed', {
          attempt,
          detail
        });
      }

      await sleep(this.retryDelayMs);
    }

    throw new Error(
      `Text injection failed after ${this.retryCount} retries. ${failures.slice(-4).join(' | ')}`
    );
  }

  public async replaceRecentText(existingText: string, replacementText: string): Promise<void> {
    const oldText = existingText.trim();
    const newText = replacementText.trim();

    if (!newText) {
      return;
    }

    if (!oldText) {
      await this.inject(newText);
      return;
    }

    const charsToDelete = oldText.length;
    if (this.nativeBinaryPath) {
      try {
        await this.replaceViaNative(oldText.length, newText);
        return;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.logger?.warn('Native replacement failed; falling back to osascript delete+type', {
          detail,
          charsToDelete
        });
      }
    }

    await this.commandRunner('osascript', [
      '-e',
      'on run argv',
      '-e',
      'set deleteCount to (item 1 of argv) as integer',
      '-e',
      'set replacementText to item 2 of argv',
      '-e',
      'tell application "System Events"',
      '-e',
      'repeat deleteCount times',
      '-e',
      'key code 51',
      '-e',
      'end repeat',
      '-e',
      'keystroke replacementText',
      '-e',
      'end tell',
      '-e',
      'end run',
      '--',
      String(charsToDelete),
      newText
    ]);
  }

  private async injectViaAccessibilityInsert(text: string): Promise<void> {
    await this.commandRunner('osascript', osascriptArgsForAccessibilityInsert(text), {
      timeoutMs: 4000
    });
  }

  private async injectViaNativeInsert(text: string): Promise<void> {
    await this.commandRunner(
      this.nativeBinaryPath ?? '',
      ['--mode', 'insert'],
      {
        stdin: text,
        timeoutMs: 2500
      }
    );
  }

  private async replaceViaNative(deleteCount: number, text: string): Promise<void> {
    await this.commandRunner(
      this.nativeBinaryPath ?? '',
      ['--mode', 'replace', '--delete-count', String(deleteCount)],
      {
        stdin: text,
        timeoutMs: 3000
      }
    );
  }

  private async injectViaDirectInput(text: string): Promise<void> {
    await this.commandRunner('osascript', osascriptArgsForDirectInput(text), {
      timeoutMs: 4000
    });
  }

  private async injectViaClipboardPaste(text: string): Promise<void> {
    const previousClipboard = this.clipboard.readText();
    this.clipboard.writeText(text);

    try {
      if (this.pasteDelayMs > 0) {
        await sleep(this.pasteDelayMs);
      }

      await this.commandRunner('osascript', [
        '-e',
        'tell application "System Events" to keystroke "v" using command down'
      ]);

      // Restore clipboard only if it still contains the injected text.
      const currentClipboard = this.clipboard.readText();
      if (currentClipboard === text) {
        this.clipboard.writeText(previousClipboard);
      }
    } catch (error) {
      const currentClipboard = this.clipboard.readText();
      if (currentClipboard === text || !currentClipboard.trim()) {
        this.clipboard.writeText(previousClipboard);
      }

      throw error;
    }
  }
}
