/** Commit message format, from the `commitcraft.style` setting. */
export type CommitStyle = 'conventional' | 'plain';

/** Which AI vendor receives the diff, from the `commitcraft.provider` setting. */
export type ProviderName = 'anthropic' | 'gemini';

/** The settings the core logic cares about, already validated (see settings.ts). */
export interface CommitCraftSettings {
  provider: ProviderName;
  style: CommitStyle;
  maxSubjectLength: number;
  baseBranch: string;
  /** Never empty: an empty `commitcraft.model` setting resolves to the provider's default. */
  model: string;
}

/** A prompt split into the standing instructions and the per-request content. */
export interface BuiltPrompt {
  system: string;
  user: string;
}

export interface GenerateOptions {
  /** The user's API key. Passed in by the caller; providers never read it from anywhere else. */
  apiKey: string;
  model: string;
  /** Upper bound on generated tokens (including any model reasoning). */
  maxTokens: number;
  signal?: AbortSignal;
  /** Per-attempt request timeout in milliseconds. */
  timeoutMs?: number;
}

/** The single seam between CommitCraft and an AI vendor. Implementations throw CommitCraftError. */
export interface AiProvider {
  generate(prompt: BuiltPrompt, options: GenerateOptions): Promise<string>;
}
