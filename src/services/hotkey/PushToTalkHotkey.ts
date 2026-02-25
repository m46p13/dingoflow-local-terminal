import {
  GlobalKeyboardListener,
  IGlobalKey,
  IGlobalKeyDownMap,
  IGlobalKeyEvent,
  IGlobalKeyListener
} from 'node-global-key-listener';
import { StructuredLogger } from '../../logging/StructuredLogger';

interface ParsedHotkey {
  source: string;
  triggerKey: IGlobalKey;
  requiredModifierGroups: IGlobalKey[][];
}

interface PushToTalkCallbacks {
  onPress: () => Promise<void> | void;
  onRelease: () => Promise<void> | void;
}

const MODIFIER_ALIASES: Record<string, IGlobalKey[]> = {
  command: ['LEFT META', 'RIGHT META'],
  cmd: ['LEFT META', 'RIGHT META'],
  meta: ['LEFT META', 'RIGHT META'],
  control: ['LEFT CTRL', 'RIGHT CTRL'],
  ctrl: ['LEFT CTRL', 'RIGHT CTRL'],
  shift: ['LEFT SHIFT', 'RIGHT SHIFT'],
  alt: ['LEFT ALT', 'RIGHT ALT'],
  option: ['LEFT ALT', 'RIGHT ALT'],
  commandorcontrol: ['LEFT META', 'RIGHT META', 'LEFT CTRL', 'RIGHT CTRL'],
  cmdorctrl: ['LEFT META', 'RIGHT META', 'LEFT CTRL', 'RIGHT CTRL']
};

const SPECIAL_KEY_ALIASES: Record<string, IGlobalKey> = {
  space: 'SPACE',
  enter: 'RETURN',
  return: 'RETURN',
  tab: 'TAB',
  escape: 'ESCAPE',
  esc: 'ESCAPE',
  backspace: 'BACKSPACE',
  delete: 'DELETE'
};

const parseHotkey = (accelerator: string): ParsedHotkey => {
  const tokens = accelerator
    .split('+')
    .map((token) => token.trim())
    .filter(Boolean);

  if (tokens.length < 2) {
    throw new Error(
      `Hotkey must include at least one modifier and one key for push-to-talk: ${accelerator}`
    );
  }

  const modifierGroups: IGlobalKey[][] = [];
  let trigger: IGlobalKey | undefined;

  for (const token of tokens) {
    const normalized = token.toLowerCase();
    const modifierGroup = MODIFIER_ALIASES[normalized];
    if (modifierGroup) {
      modifierGroups.push(modifierGroup);
      continue;
    }

    const special = SPECIAL_KEY_ALIASES[normalized];
    const candidate = special ?? normalizeMainKeyToken(token);

    if (!candidate) {
      throw new Error(`Unsupported hotkey token '${token}' in ${accelerator}`);
    }

    if (trigger) {
      throw new Error(`Hotkey must define exactly one non-modifier key: ${accelerator}`);
    }

    trigger = candidate;
  }

  if (!trigger) {
    throw new Error(`Hotkey missing a trigger key: ${accelerator}`);
  }

  if (modifierGroups.length === 0) {
    throw new Error(`Hotkey must include at least one modifier key: ${accelerator}`);
  }

  return {
    source: accelerator,
    triggerKey: trigger,
    requiredModifierGroups: modifierGroups
  };
};

const normalizeMainKeyToken = (token: string): IGlobalKey | undefined => {
  const trimmed = token.trim();
  if (/^[a-z]$/i.test(trimmed)) {
    return trimmed.toUpperCase() as IGlobalKey;
  }

  if (/^[0-9]$/.test(trimmed)) {
    return trimmed as IGlobalKey;
  }

  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(trimmed)) {
    return trimmed.toUpperCase() as IGlobalKey;
  }

  return undefined;
};

const hasAnyKeyDown = (down: IGlobalKeyDownMap, keys: IGlobalKey[]): boolean =>
  keys.some((key) => down[key]);

export class PushToTalkHotkey {
  private readonly listener = new GlobalKeyboardListener();
  private readonly parsedHotkey: ParsedHotkey;
  private readonly handler: IGlobalKeyListener;
  private listening = false;
  private active = false;

  public constructor(
    accelerator: string,
    private readonly callbacks: PushToTalkCallbacks,
    private readonly logger?: StructuredLogger
  ) {
    this.parsedHotkey = parseHotkey(accelerator);

    this.handler = (event, down) => {
      return this.onKeyEvent(event, down);
    };
  }

  public describeBinding(): string {
    return this.parsedHotkey.source;
  }

  public async start(): Promise<void> {
    if (this.listening) {
      return;
    }

    await this.listener.addListener(this.handler);
    this.listening = true;
    this.logger?.info('Push-to-talk hotkey listener started', {
      hotkey: this.describeBinding()
    });
  }

  public stop(): void {
    if (this.listening) {
      this.listener.removeListener(this.handler);
    }

    this.listener.kill();
    this.listening = false;
    this.active = false;

    this.logger?.info('Push-to-talk hotkey listener stopped');
  }

  private onKeyEvent(event: IGlobalKeyEvent, down: IGlobalKeyDownMap): boolean {
    const keyName = event.name;
    if (!keyName) {
      return false;
    }

    const isTriggerKey = keyName === this.parsedHotkey.triggerKey;
    const modifiersHeld = this.areModifiersHeld(down);
    const comboHeld = modifiersHeld && Boolean(down[this.parsedHotkey.triggerKey]);

    if (event.state === 'DOWN' && isTriggerKey && modifiersHeld) {
      if (!this.active) {
        this.active = true;
        this.invokeSafely(this.callbacks.onPress, 'onPress');
      }

      return true;
    }

    if (this.active && (event.state === 'UP' && isTriggerKey)) {
      this.active = false;
      this.invokeSafely(this.callbacks.onRelease, 'onRelease');
      return true;
    }

    if (this.active && !comboHeld) {
      this.active = false;
      this.invokeSafely(this.callbacks.onRelease, 'onRelease');
      return true;
    }

    return this.active;
  }

  private areModifiersHeld(down: IGlobalKeyDownMap): boolean {
    return this.parsedHotkey.requiredModifierGroups.every((group) => hasAnyKeyDown(down, group));
  }

  private invokeSafely(fn: () => Promise<void> | void, action: 'onPress' | 'onRelease'): void {
    Promise.resolve(fn()).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger?.error(`Push-to-talk ${action} callback failed`, {
        detail
      });
    });
  }
}
