// Telemetry stub — off by default, no data is ever collected unless the user
// explicitly opts in via `perfLens.telemetry.enabled = true`.
//
// In the current release this is a pure no-op stub.  The scaffolding exists
// so the call sites are already in place; a future release can swap in a real
// backend without touching the callers.

import type * as vscode from 'vscode';

export type TelemetryEvent =
  | { name: 'activation' }
  | { name: 'analyse_file'; properties?: { ruleCount?: number } }
  | { name: 'profile_import'; properties?: { source?: string } }
  | { name: 'llm_request';   properties?: { provider?: string; cached?: boolean } }
  | { name: 'fix_applied';   properties?: { ruleId?: string; verified?: boolean } }
  | { name: 'sarif_export';  properties?: { findingCount?: number } }
  | { name: 'bundle_export'; properties?: { findingCount?: number } };

export class TelemetryReporter {
  private _enabled: boolean;

  constructor(private readonly _ctx: vscode.ExtensionContext) {
    this._enabled = this._readEnabled();
  }

  /** Fire-and-forget event recording.  Safe to call at any time. */
  record(_event: TelemetryEvent): void {
    if (!this._enabled) return;
    // Stub: no network call.  Future: send to an opt-in endpoint here.
  }

  /** Re-reads the setting — call when the configuration changes. */
  refresh(): void {
    this._enabled = this._readEnabled();
  }

  dispose(): void { /* nothing to tear down */ }

  private _readEnabled(): boolean {
    const cfg = this._ctx.globalState;
    // Read from vscode config.  Requires vscode.workspace to be available.
    // In tests cfg.get returns undefined and we stay off.
    try {
      const vscodeMod = require('vscode') as typeof import('vscode');
      return vscodeMod.workspace
        .getConfiguration('perfLens')
        .get<boolean>('telemetry.enabled', false);
    } catch {
      return false;
    }
  }
}
