# CommitCraft – Requirements

## Problem
Developers write vague commit messages ("fix", "wip", "changes") and skip PR descriptions
because writing them is tedious. This makes Git history hard to read, slows code review,
and makes changelogs painful to produce.

## Users
Software engineers who use VS Code and Git daily.

## Solution
A VS Code extension that reads the developer's staged Git changes and uses an AI model
to draft a clear commit message or PR description, which the developer reviews and edits
before using. The developer always stays in control: nothing is committed automatically.

## Core user journeys (must have)
1. Generate commit message
   - User stages changes, clicks the CommitCraft button in the Source Control panel
     (or runs "CommitCraft: Generate Commit Message" from the Command Palette).
   - The extension reads the staged diff, redacts secrets, sends it to the AI,
     and fills the commit message box with the result.
2. Generate PR description
   - User runs "CommitCraft: Generate PR Description".
   - The extension compares the current branch with the base branch (default: main),
     generates a description with sections Summary, Changes, Testing, Risks,
     and opens it in a new Markdown editor tab.
3. Set API key
   - User runs "CommitCraft: Set API Key". The key is stored in VS Code SecretStorage.
   - If no key exists when generating, the user is prompted to set one.

## Settings
- commitcraft.style: "conventional" (default) | "plain"
- commitcraft.maxSubjectLength: number, default 72
- commitcraft.baseBranch: string, default "main"
- commitcraft.model: string, default model name for the provider

## Edge cases that must be handled with clear messages
- No workspace folder or no Git repository open
- No staged changes
- Very large diff (over a size limit): truncate per file and tell the user
- Binary files and lock files (package-lock.json etc.): skip their content, list names only
- Missing or invalid API key
- Network error, timeout, rate limit (HTTP 429), provider error
- Empty or malformed AI response
- Multiple repositories open: use the one for the active file, else ask

## Security and privacy requirements
- API key stored only in SecretStorage, never in settings, code, or logs
- Secrets in the diff (API keys, tokens, passwords, private keys, .env values)
  are masked before anything is sent to the AI
- .env and similar files are never sent
- No telemetry; nothing stored except the API key
- README states that code diffs are sent to the configured AI provider

## Non-functional
- Generation should feel fast: show a progress notification, cancellable
- Core logic (diff parsing, redaction, prompt building, response cleanup) is pure
  TypeScript with no VS Code dependency, so it is unit testable
- Works on Windows, macOS and Linux

## Out of scope (production roadmap, mention in demo)
- Publishing to the VS Code Marketplace
- Creating PRs directly on GitHub/GitLab
- Multiple AI providers in the UI (the code has a provider interface, only one implemented)
- Team-shared commit conventions
