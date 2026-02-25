import { Menu, Notification, Tray, nativeImage } from 'electron';
import { DingoFlowApp } from '../core/DingoFlowApp';
import { AppState, FormatMode } from '../types';

const TITLE_BY_STAGE: Record<AppState['stage'], string> = {
  idle: 'DingoFlow',
  recording: 'DingoFlow REC',
  transcribing: 'DingoFlow ASR',
  formatting: 'DingoFlow FMT',
  injecting: 'DingoFlow OUT',
  error: 'DingoFlow ERR'
};

export class TrayController {
  private tray: Tray;

  public constructor(private readonly app: DingoFlowApp, private readonly hotkey: string) {
    const icon = nativeImage.createFromNamedImage('NSStatusAvailable', [18, 18]);
    this.tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
    this.tray.setTitle('DingoFlow');
    this.tray.setToolTip('DingoFlow v1 (offline)');

    this.app.on('stateChanged', (state) => {
      this.refreshMenu(state, this.app.getMode());
      this.updateTitle(state);

      if (state.stage === 'error' && state.detail) {
        this.notify('DingoFlow error', state.detail);
      }
    });

    this.app.on('modeChanged', (mode) => {
      this.refreshMenu(this.app.getState(), mode);
    });

    this.app.on('dictationCompleted', (result) => {
      this.notify('Dictation complete', result.formattedText.slice(0, 100));
    });

    this.refreshMenu(this.app.getState(), this.app.getMode());
  }

  public destroy(): void {
    this.tray.destroy();
  }

  private refreshMenu(state: AppState, mode: FormatMode): void {
    const isRecording = state.stage === 'recording';
    const busy = !['idle', 'recording', 'error'].includes(state.stage);
    const canRunTest = !busy && !isRecording;

    const menu = Menu.buildFromTemplate([
      {
        label: `Status: ${this.describeState(state)}`,
        enabled: false
      },
      {
        label: isRecording ? 'Stop Recording' : 'Start Recording',
        enabled: !busy || isRecording,
        click: () => {
          if (isRecording) {
            void this.app.handlePushToTalkReleased();
            return;
          }

          void this.app.handlePushToTalkPressed();
        }
      },
      {
        label: 'Test Pipeline',
        enabled: canRunTest,
        click: () => {
          void this.app.runPipelineTest();
        }
      },
      {
        label: `Hotkey (hold): ${this.hotkey}`,
        enabled: false
      },
      { type: 'separator' },
      {
        label: 'Mode',
        submenu: [
          {
            label: 'Literal',
            type: 'radio',
            checked: mode === 'literal',
            click: () => this.app.setMode('literal')
          },
          {
            label: 'Clean',
            type: 'radio',
            checked: mode === 'clean',
            click: () => this.app.setMode('clean')
          },
          {
            label: 'Rewrite',
            type: 'radio',
            checked: mode === 'rewrite',
            click: () => this.app.setMode('rewrite')
          }
        ]
      },
      { type: 'separator' },
      {
        label: 'Clear Error',
        enabled: state.stage === 'error',
        click: () => {
          this.app.clearError();
        }
      },
      {
        label: 'Quit',
        role: 'quit'
      }
    ]);

    this.tray.setContextMenu(menu);
  }

  private updateTitle(state: AppState): void {
    this.tray.setTitle(TITLE_BY_STAGE[state.stage]);
  }

  private describeState(state: AppState): string {
    if (state.detail) {
      return `${state.stage} (${state.detail})`;
    }

    return state.stage;
  }

  private notify(title: string, body: string): void {
    if (!Notification.isSupported()) {
      return;
    }

    new Notification({ title, body }).show();
  }
}
