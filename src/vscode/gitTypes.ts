// The small part of the built-in `vscode.git` extension API (version 1) that CommitCraft uses.
// Declared structurally, without importing 'vscode', so the logic that talks to it can be unit tested
// with plain fakes. The real API objects satisfy these interfaces.

export interface GitBranch {
  /** Undefined when HEAD is detached. */
  readonly name?: string;
  /** Undefined on a repository with no commits yet. */
  readonly commit?: string;
}

export interface GitRepository {
  readonly rootUri: { readonly fsPath: string };
  readonly inputBox: { value: string };
  readonly state: { readonly HEAD?: GitBranch };
}

export interface GitApi {
  readonly state: 'uninitialized' | 'initialized';
  readonly repositories: GitRepository[];
  readonly git: { readonly path: string };
  readonly onDidChangeState: (listener: (state: 'uninitialized' | 'initialized') => unknown) => { dispose(): unknown };
}

export interface GitExtensionExports {
  readonly enabled: boolean;
  getAPI(version: 1): GitApi;
}

/**
 * Runs `git <args>` in a repository's root and resolves with stdout. When git exits non-zero it rejects with
 * an Error that carries `exitCode` (and a short `stderrSummary`); a cancelled run rejects with a CommitCraftError.
 */
export type RunGit = (args: readonly string[]) => Promise<string>;

/** The extra fields `createRunGit` puts on the Error it rejects with. */
export interface GitCommandFailure {
  exitCode?: number | string | null;
  stderrSummary?: string;
}
