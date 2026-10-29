// A controllable fake of the slice of the VS Code API that src/vscode/* uses.
// vitest.config.ts aliases the 'vscode' module to this file, so the thin layer can be unit tested
// without launching VS Code. The real API is exercised by the integration suite.
import { vi } from 'vitest';

export class Uri {
  readonly scheme: string;
  constructor(
    readonly fsPath: string,
    scheme = 'file',
  ) {
    this.scheme = scheme;
  }
  static file(path: string): Uri {
    return new Uri(path);
  }
}

export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 } as const;

/** A cancellation token the test can fire. */
export class FakeToken {
  private listeners: Array<() => void> = [];
  cancelled = false;
  onCancellationRequested = (listener: () => void): { dispose(): void } => {
    this.listeners.push(listener);
    return { dispose: () => undefined };
  };
  cancel(): void {
    this.cancelled = true;
    this.listeners.forEach((listener) => listener());
  }
}

export interface MockState {
  settings: Record<string, unknown>;
  workspaceFolders: Array<{ uri: Uri }> | undefined;
  activeEditorUri: Uri | undefined;
  /** Set by a test to receive the token of the next progress notification (to cancel it). */
  onProgressStart: ((token: FakeToken) => void) | undefined;
  commandHandlers: Map<string, (...args: unknown[]) => unknown>;
  extension: { isActive: boolean; exports: unknown; activate: () => Promise<unknown> } | undefined;
}

export const mockState: MockState = {
  settings: {},
  workspaceFolders: [{ uri: Uri.file('/work/app') }],
  activeEditorUri: undefined,
  onProgressStart: undefined,
  commandHandlers: new Map(),
  extension: undefined,
};

export const channel = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  show: vi.fn(),
  dispose: vi.fn(),
};

export const progressReports: string[] = [];

export const window = {
  showInformationMessage: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  showWarningMessage: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  showErrorMessage: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  showInputBox: vi.fn<(...args: unknown[]) => Promise<string | undefined>>(),
  showQuickPick: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  showTextDocument: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  setStatusBarMessage: vi.fn(),
  createOutputChannel: vi.fn(() => channel),
  withProgress: vi.fn(
    async (_options: unknown, task: (progress: { report: (v: { message?: string }) => void }, token: FakeToken) => Promise<unknown>) => {
      const token = new FakeToken();
      mockState.onProgressStart?.(token);
      return task({ report: (value) => progressReports.push(value.message ?? '') }, token);
    },
  ),
  get activeTextEditor(): { document: { uri: Uri } } | undefined {
    return mockState.activeEditorUri ? { document: { uri: mockState.activeEditorUri } } : undefined;
  },
};

export const workspace = {
  get workspaceFolders(): Array<{ uri: Uri }> | undefined {
    return mockState.workspaceFolders;
  },
  getConfiguration: vi.fn(() => ({ get: (key: string): unknown => mockState.settings[key] })),
  openTextDocument: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
};

export const commands = {
  registerCommand: vi.fn((id: string, handler: (...args: unknown[]) => unknown) => {
    mockState.commandHandlers.set(id, handler);
    return { dispose: () => mockState.commandHandlers.delete(id) };
  }),
  executeCommand: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
};

export const extensions = {
  getExtension: vi.fn(() => mockState.extension),
};

/** Restores every mock to a clean default. Call in `beforeEach`. */
export function resetVscodeMock(): void {
  for (const fn of [
    window.showInformationMessage,
    window.showWarningMessage,
    window.showErrorMessage,
    window.showInputBox,
    window.showQuickPick,
    window.showTextDocument,
    window.setStatusBarMessage,
    commands.executeCommand,
    workspace.openTextDocument,
    channel.info,
    channel.warn,
    channel.error,
    channel.show,
    channel.dispose,
  ]) {
    fn.mockReset();
  }
  // Keep the implementations of these, but forget earlier calls.
  window.withProgress.mockClear();
  window.createOutputChannel.mockClear();
  workspace.getConfiguration.mockClear();
  commands.registerCommand.mockClear();
  extensions.getExtension.mockClear();
  window.showInformationMessage.mockResolvedValue(undefined);
  window.showWarningMessage.mockResolvedValue(undefined);
  window.showErrorMessage.mockResolvedValue(undefined);
  window.showInputBox.mockResolvedValue(undefined);
  window.showQuickPick.mockResolvedValue(undefined);
  window.showTextDocument.mockResolvedValue(undefined);
  commands.executeCommand.mockResolvedValue(undefined);
  workspace.openTextDocument.mockImplementation((options) => Promise.resolve(options));
  mockState.settings = {};
  mockState.workspaceFolders = [{ uri: Uri.file('/work/app') }];
  mockState.activeEditorUri = undefined;
  mockState.onProgressStart = undefined;
  mockState.commandHandlers.clear();
  mockState.extension = undefined;
  progressReports.length = 0;
}
