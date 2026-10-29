import * as vscode from 'vscode';
import { normalizeSettings } from '../core/settings';
import type { CommitCraftSettings } from '../core/types';

/** Reads and validates the `commitcraft.*` settings. `resource` lets baseBranch differ per repository. */
export function readSettings(resource?: vscode.Uri): CommitCraftSettings {
  const config = vscode.workspace.getConfiguration('commitcraft', resource);
  return normalizeSettings({
    provider: config.get('provider'),
    style: config.get('style'),
    maxSubjectLength: config.get('maxSubjectLength'),
    baseBranch: config.get('baseBranch'),
    model: config.get('model'),
  });
}
