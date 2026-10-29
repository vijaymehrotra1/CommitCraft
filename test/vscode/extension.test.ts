import { beforeEach, describe, expect, it, vi } from 'vitest';
import { activate, deactivate } from '../../src/extension';
import { createLogger } from '../../src/vscode/logger';
import { channel, mockState, resetVscodeMock, window } from '../mocks/vscode';

beforeEach(() => {
  resetVscodeMock();
});

describe('activate', () => {
  it('registers the three commands and the logger, and nothing else', () => {
    const subscriptions: Array<{ dispose(): unknown }> = [];
    activate({ subscriptions, secrets: { get: vi.fn(), store: vi.fn() } } as never);
    expect([...mockState.commandHandlers.keys()].sort()).toEqual([
      'commitcraft.generateCommitMessage',
      'commitcraft.generatePrDescription',
      'commitcraft.setApiKey',
    ]);
    expect(subscriptions).toHaveLength(4); // logger + 3 commands
    expect(window.createOutputChannel).toHaveBeenCalledWith('CommitCraft', { log: true });
  });

  it('does no work at activation: no prompts, no network, no git', () => {
    activate({ subscriptions: [], secrets: { get: vi.fn(), store: vi.fn() } } as never);
    expect(window.showInformationMessage).not.toHaveBeenCalled();
    expect(window.showErrorMessage).not.toHaveBeenCalled();
    expect(window.withProgress).not.toHaveBeenCalled();
  });

  it('disposing the subscriptions removes the commands and the output channel', () => {
    const subscriptions: Array<{ dispose(): unknown }> = [];
    activate({ subscriptions, secrets: { get: vi.fn(), store: vi.fn() } } as never);
    subscriptions.forEach((s) => s.dispose());
    expect(mockState.commandHandlers.size).toBe(0);
    expect(channel.dispose).toHaveBeenCalled();
  });
});

describe('deactivate', () => {
  it('does nothing and does not throw', () => {
    expect(() => deactivate()).not.toThrow();
  });
});

describe('createLogger', () => {
  it('writes through to a log output channel at the matching level', () => {
    const logger = createLogger();
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(channel.info).toHaveBeenCalledWith('i');
    expect(channel.warn).toHaveBeenCalledWith('w');
    expect(channel.error).toHaveBeenCalledWith('e');
  });

  it('show() reveals the channel without stealing focus, and dispose() releases it', () => {
    const logger = createLogger();
    logger.show();
    logger.dispose();
    expect(channel.show).toHaveBeenCalledWith(true);
    expect(channel.dispose).toHaveBeenCalledTimes(1);
  });
});
