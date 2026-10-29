/** Every failure CommitCraft can show to the user has exactly one of these codes. */
export type CommitCraftErrorCode =
  // Environment
  | 'NO_WORKSPACE'
  | 'NO_REPOSITORY'
  | 'GIT_EXTENSION_UNAVAILABLE'
  | 'GIT_ERROR'
  | 'INVALID_SETTING'
  // Nothing to do
  | 'NO_STAGED_CHANGES'
  | 'NO_BRANCH_CHANGES'
  | 'DETACHED_HEAD'
  | 'ON_BASE_BRANCH'
  | 'BASE_BRANCH_NOT_FOUND'
  // API key
  | 'INVALID_API_KEY'
  | 'SECRET_STORAGE_ERROR'
  // Provider
  | 'RATE_LIMITED'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'MODEL_NOT_FOUND'
  | 'PROVIDER_REFUSED'
  | 'PROVIDER_ERROR'
  // Response
  | 'EMPTY_RESPONSE'
  | 'MALFORMED_RESPONSE'
  // User
  | 'CANCELLED';

/**
 * An error whose `message` is safe and useful to show to the user: it says what happened and what
 * to do next. Never put diff content, prompts or API keys in a message.
 */
export class CommitCraftError extends Error {
  readonly code: CommitCraftErrorCode;

  constructor(code: CommitCraftErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CommitCraftError';
    this.code = code;
  }
}

export function isCommitCraftError(value: unknown): value is CommitCraftError {
  return value instanceof CommitCraftError;
}
