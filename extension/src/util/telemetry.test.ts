import { TelemetryReporter } from './telemetry';
import type * as vscode from 'vscode';

function makeCtx(): vscode.ExtensionContext {
  return {
    globalState: {
      get: jest.fn(),
      update: jest.fn(),
    },
  } as unknown as vscode.ExtensionContext;
}

describe('TelemetryReporter', () => {
  it('can be constructed without throwing', () => {
    expect(() => new TelemetryReporter(makeCtx())).not.toThrow();
  });

  it('record() is a no-op when telemetry is off (default)', () => {
    const reporter = new TelemetryReporter(makeCtx());
    // Should not throw, network call never happens
    expect(() => reporter.record({ name: 'activation' })).not.toThrow();
    expect(() => reporter.record({ name: 'analyse_file', properties: { ruleCount: 3 } })).not.toThrow();
    expect(() => reporter.record({ name: 'fix_applied', properties: { ruleId: 'x', verified: true } })).not.toThrow();
  });

  it('refresh() does not throw', () => {
    const reporter = new TelemetryReporter(makeCtx());
    expect(() => reporter.refresh()).not.toThrow();
  });

  it('dispose() does not throw', () => {
    const reporter = new TelemetryReporter(makeCtx());
    expect(() => reporter.dispose()).not.toThrow();
  });
});
