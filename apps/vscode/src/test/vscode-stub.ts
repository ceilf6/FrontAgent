// Minimal stand-in for the `vscode` module so vitest can load modules that
// import it. Tests mutate `__test` to control workspace state and inspect
// user-facing notifications.

interface StubWorkspaceFolder {
  uri: { fsPath: string };
  name: string;
  index: number;
}

/** Keys declared `"scope": "machine"` in the extension manifest. */
const MACHINE_SCOPED_KEYS = new Set(['apiKey']);

export const __test = {
  workspaceFolders: undefined as StubWorkspaceFolder[] | undefined,
  /** User Settings scope — what `inspect()` reports as `globalValue`. */
  settings: new Map<string, unknown>(),
  /** Workspace scope (`.code-workspace`), i.e. values a repository can supply. */
  workspaceSettings: new Map<string, unknown>(),
  /** Folder scope (`.vscode/settings.json`) — the path issue #421 reported. */
  workspaceFolderSettings: new Map<string, unknown>(),
  isTrusted: true,
  warnings: [] as string[],
  infos: [] as string[],
  /** Modal answers, keyed by the message text `showWarningMessage` receives. */
  modalResponses: new Map<string, string | undefined>(),
  modalPrompts: [] as Array<{ message: string; detail?: string; items: string[] }>,
  /** FIFO answers for the Configure dialog, plus what it was prefilled with. */
  quickPickResponses: [] as Array<string | undefined>,
  inputBoxResponses: [] as Array<string | undefined>,
  inputBoxPrompts: [] as Array<{ title?: string; value?: string }>,
  /** Every `config.update` call, so tests can assert the target scope. */
  configUpdates: [] as Array<{ key: string; value: unknown; target?: number }>,
  reset(): void {
    this.workspaceFolders = undefined;
    this.settings.clear();
    this.workspaceSettings.clear();
    this.workspaceFolderSettings.clear();
    this.isTrusted = true;
    this.warnings = [];
    this.infos = [];
    this.modalResponses.clear();
    this.modalPrompts = [];
    this.quickPickResponses = [];
    this.inputBoxResponses = [];
    this.inputBoxPrompts = [];
    this.configUpdates = [];
  },
};

export const workspace = {
  get workspaceFolders(): StubWorkspaceFolder[] | undefined {
    return __test.workspaceFolders;
  },
  get isTrusted(): boolean {
    return __test.isTrusted;
  },
  getConfiguration: () => ({
    get: <T>(key: string, defaultValue?: T): T | undefined => {
      // Mirrors VS Code precedence: folder outranks workspace outranks User.
      if (__test.workspaceFolderSettings.has(key)) {
        return __test.workspaceFolderSettings.get(key) as T;
      }
      if (__test.workspaceSettings.has(key)) return __test.workspaceSettings.get(key) as T;
      return __test.settings.has(key) ? (__test.settings.get(key) as T) : defaultValue;
    },
    inspect: <T>(
      key: string,
    ): { globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T } => {
      // VS Code filters `machine`-scoped keys out of the workspace and folder
      // configuration models entirely, so `inspect()` never reports a workspace
      // value for them. Modelling that here keeps tests from going green on a
      // state that cannot exist in a real Extension Host.
      const machineScoped = MACHINE_SCOPED_KEYS.has(key);
      return {
        globalValue: __test.settings.get(key) as T | undefined,
        workspaceValue: machineScoped
          ? undefined
          : (__test.workspaceSettings.get(key) as T | undefined),
        workspaceFolderValue: machineScoped
          ? undefined
          : (__test.workspaceFolderSettings.get(key) as T | undefined),
      };
    },
    update: async (key: string, value: unknown, target?: number): Promise<void> => {
      __test.configUpdates.push({ key, value, target });
    },
  }),
  openTextDocument: async (): Promise<unknown> => ({}),
};

export const window = {
  // Overloaded like the real API: a bare message is a toast, while a message
  // with an options object and action items is a dialog that resolves to the
  // chosen item (or undefined when dismissed).
  showWarningMessage: (
    message: string,
    optionsOrItem?: { modal?: boolean; detail?: string } | string,
    ...rest: string[]
  ): Promise<string | undefined> | undefined => {
    const isOptions = typeof optionsOrItem === 'object' && optionsOrItem !== null;
    if (!isOptions && optionsOrItem === undefined) {
      __test.warnings.push(message);
      return undefined;
    }
    const items = isOptions ? rest : [optionsOrItem as string, ...rest];
    __test.modalPrompts.push({
      message,
      detail: isOptions ? optionsOrItem.detail : undefined,
      items,
    });
    return Promise.resolve(__test.modalResponses.get(message));
  },
  showInformationMessage: (message: string): void => {
    __test.infos.push(message);
  },
  showQuickPick: async (): Promise<string | undefined> => __test.quickPickResponses.shift(),
  showInputBox: async (options?: {
    title?: string;
    value?: string;
  }): Promise<string | undefined> => {
    __test.inputBoxPrompts.push({ title: options?.title, value: options?.value });
    return __test.inputBoxResponses.shift();
  },
  showTextDocument: async (): Promise<void> => {},
};

export const commands = {
  executeCommand: async (): Promise<void> => {},
};

export const Uri = {
  file: (fsPath: string): { fsPath: string } => ({ fsPath }),
};

export const ConfigurationTarget = {
  Global: 1,
  Workspace: 2,
  WorkspaceFolder: 3,
};
