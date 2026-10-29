// The one shared flow for both commands:
//   raw diff -> parse -> drop sensitive/binary/lock files -> redact -> truncate -> prompt -> provider -> clean response
// Pure apart from the injected provider: no VS Code, so it is unit tested with a fake provider.

import { diffNotices, processDiff, renderDiff, type DiffStats, type ProcessedDiff } from './diff';
import { CommitCraftError } from './errors';
import { buildCommitPrompt, buildPrPrompt } from './prompt';
import { isSensitivePath, redact } from './redact';
import { cleanCommitMessage, cleanPrDescription } from './response';
import type { AiProvider, BuiltPrompt, CommitCraftSettings } from './types';

export const COMMIT_MAX_DIFF_CHARS = 40_000;
export const PR_MAX_DIFF_CHARS = 60_000;
/** Includes model reasoning tokens, so keep it generous even though the answer is short. */
export const COMMIT_MAX_TOKENS = 4_096;
export const PR_MAX_TOKENS = 8_192;
export const REQUEST_TIMEOUT_MS = 60_000;

export type PipelineStage = 'preparing' | 'generating';

export interface PipelineRequest {
  rawDiff: string;
  apiKey: string;
  provider: AiProvider;
  settings: CommitCraftSettings;
  signal?: AbortSignal;
  onStage?: (stage: PipelineStage) => void;
  /** Overrides the diff size limit (tests). */
  maxDiffChars?: number;
}

export interface PrPipelineRequest extends PipelineRequest {
  branchName: string;
  /** Subjects of the commits on the branch, oldest first (the newest ones if there are very many). */
  commitSubjects: readonly string[];
  /** All commits on the branch, when `commitSubjects` was trimmed. */
  totalCommits?: number;
}

export interface PipelineResult {
  text: string;
  /** Plain-language notes for the user: what was not sent in full, masked secrets, adjustments. */
  notices: string[];
  stats: DiffStats;
  /** Number of secrets masked before sending. */
  redactions: number;
}

interface Prepared {
  processed: ProcessedDiff;
  diffText: string;
  redactions: number;
}

export function noStagedChangesError(): CommitCraftError {
  return new CommitCraftError(
    'NO_STAGED_CHANGES',
    'There are no staged changes to describe. Stage the files you want to commit (the + button in Source Control, or git add) and try again.',
  );
}

export function noBranchChangesError(baseBranch: string): CommitCraftError {
  return new CommitCraftError(
    'NO_BRANCH_CHANGES',
    `This branch has no changes compared with ${baseBranch}, so there is nothing to describe. Commit your work on this branch first.`,
  );
}

function cancelled(cause?: unknown): CommitCraftError {
  return new CommitCraftError('CANCELLED', 'Generation was cancelled.', { cause });
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw cancelled();
  }
}

/** Redacts a single-line value (a path, a commit subject). One line cannot leave a key block open. */
function redactLine(value: string, tally: { count: number }): string {
  const result = redact(value);
  tally.count += result.count;
  return result.text;
}

function prepareDiff(rawDiff: string, maxChars: number, onEmpty: () => CommitCraftError): Prepared {
  if (rawDiff.trim() === '') {
    throw onEmpty();
  }
  const tally = { count: 0 };
  const processed = processDiff(rawDiff, {
    maxChars,
    isSensitivePath,
    redactText: (text) => {
      const result = redact(text);
      tally.count += result.count;
      return result.text;
    },
  });
  if (processed.stats.files === 0) {
    throw onEmpty();
  }

  // File names are sent too (overview, skipped list), so they get the same treatment as content.
  const safe: ProcessedDiff = {
    ...processed,
    overview: processed.overview.map((e) => ({ ...e, path: redactLine(e.path, tally), oldPath: redactLine(e.oldPath, tally) })),
    skipped: processed.skipped.map((s) => ({ ...s, path: redactLine(s.path, tally) })),
    omitted: processed.omitted.map((o) => ({ ...o, path: redactLine(o.path, tally) })),
  };
  return { processed: safe, diffText: renderDiff(safe), redactions: tally.count };
}

function collectNotices(prepared: Prepared, extra: readonly string[]): string[] {
  const notices = diffNotices(prepared.processed);
  if (prepared.redactions > 0) {
    notices.push(
      `${prepared.redactions} possible ${prepared.redactions === 1 ? 'secret was' : 'secrets were'} masked before sending.`,
    );
  }
  return [...notices, ...extra];
}

async function callProvider(
  provider: AiProvider,
  prompt: BuiltPrompt,
  request: PipelineRequest,
  maxTokens: number,
): Promise<string> {
  throwIfCancelled(request.signal);
  request.onStage?.('generating');
  try {
    return await provider.generate(prompt, {
      apiKey: request.apiKey,
      model: request.settings.model,
      maxTokens,
      signal: request.signal,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof CommitCraftError) {
      throw error;
    }
    if (request.signal?.aborted) {
      throw cancelled(error);
    }
    throw new CommitCraftError(
      'PROVIDER_ERROR',
      'Something unexpected went wrong while calling the AI provider. Try again.',
      { cause: error },
    );
  }
}

/** Draft a commit message from the staged diff. */
export async function generateCommitMessage(request: PipelineRequest): Promise<PipelineResult> {
  request.onStage?.('preparing');
  const prepared = prepareDiff(request.rawDiff, request.maxDiffChars ?? COMMIT_MAX_DIFF_CHARS, noStagedChangesError);
  const prompt = buildCommitPrompt(prepared.diffText, request.settings);
  const raw = await callProvider(request.provider, prompt, request, COMMIT_MAX_TOKENS);
  const cleaned = cleanCommitMessage(raw, request.settings);
  return {
    text: cleaned.text,
    notices: collectNotices(prepared, cleaned.warnings),
    stats: prepared.processed.stats,
    redactions: prepared.redactions,
  };
}

/** Draft a PR description from the branch diff and commit subjects. */
export async function generatePrDescription(request: PrPipelineRequest): Promise<PipelineResult> {
  request.onStage?.('preparing');
  const prepared = prepareDiff(request.rawDiff, request.maxDiffChars ?? PR_MAX_DIFF_CHARS, () =>
    noBranchChangesError(request.settings.baseBranch),
  );
  const tally = { count: 0 };
  const prompt = buildPrPrompt({
    diffText: prepared.diffText,
    commitSubjects: request.commitSubjects.map((subject) => redactLine(subject, tally)),
    totalCommits: request.totalCommits,
    branchName: redactLine(request.branchName, tally),
    baseBranch: redactLine(request.settings.baseBranch, tally),
  });
  const raw = await callProvider(request.provider, prompt, request, PR_MAX_TOKENS);
  const cleaned = cleanPrDescription(raw);
  const redactions = prepared.redactions + tally.count;
  return {
    text: cleaned.text,
    notices: collectNotices({ ...prepared, redactions }, cleaned.warnings),
    stats: prepared.processed.stats,
    redactions,
  };
}
