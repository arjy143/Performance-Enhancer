import * as vscode from 'vscode';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { type SidecarClient } from '../sidecar/client';
import type {
  ProfileMetadata,
  LineHotness,
  FunctionHotness,
  ImportProfileResult,
} from '../sidecar/protocol';
import { logger } from '../util/logger';

export class ProfileManager implements vscode.Disposable {
  private _activeProfileId: string | undefined;
  private _profiles: ProfileMetadata[] = [];

  // line hotness cache: "profileId:file:line:event" → LineHotness
  private _hotnessCache = new Map<string, LineHotness>();

  private readonly _onProfileChanged = new vscode.EventEmitter<string | undefined>();
  readonly onProfileChanged = this._onProfileChanged.event;

  constructor(private readonly _client: SidecarClient) {}

  get activeProfileId(): string | undefined { return this._activeProfileId; }
  get profiles(): readonly ProfileMetadata[] { return this._profiles; }
  get hasActiveProfile(): boolean { return this._activeProfileId !== undefined; }

  async importProfile(filePath: string, label?: string): Promise<ImportProfileResult> {
    const result = await this._client.request<ImportProfileResult>('importProfile', {
      file: filePath,
      label: label ?? filePath.split('/').pop() ?? 'profile',
    });
    await this.refreshProfiles();
    this.setActiveProfile(result.profileId);
    logger.info(`Profile imported: ${result.profileId} (${result.totalSamples} samples)`);
    return result;
  }

  async deleteProfile(profileId: string): Promise<void> {
    await this._client.request<{ ok: boolean }>('deleteProfile', { profileId });
    if (this._activeProfileId === profileId) {
      this._activeProfileId = undefined;
    }
    this._hotnessCache.clear();
    await this.refreshProfiles();
    this._onProfileChanged.fire(this._activeProfileId);
  }

  setActiveProfile(profileId: string | undefined): void {
    this._activeProfileId = profileId;
    this._hotnessCache.clear();
    this._onProfileChanged.fire(profileId);
    logger.info(`Active profile: ${profileId ?? '(none)'}`);
  }

  async refreshProfiles(): Promise<void> {
    try {
      this._profiles = await this._client.request<ProfileMetadata[]>('listProfiles');
    } catch (err) {
      logger.warn('profileManager: listProfiles failed', err);
    }
  }

  async getLineHotness(
    file: string,
    line: number,
    event = 'cycles',
  ): Promise<LineHotness | null> {
    if (!this._activeProfileId) return null;
    const key = `${this._activeProfileId}:${file}:${line}:${event}`;
    if (this._hotnessCache.has(key)) return this._hotnessCache.get(key)!;

    try {
      const result = await this._client.request<LineHotness | null>('getLineHotness', {
        profileId: this._activeProfileId,
        file,
        line,
        event,
      });
      if (result) this._hotnessCache.set(key, result);
      return result;
    } catch {
      return null;
    }
  }

  async getFileHotness(file: string, event = 'cycles'): Promise<LineHotness[]> {
    if (!this._activeProfileId) return [];
    try {
      return await this._client.request<LineHotness[]>('getFileHotness', {
        profileId: this._activeProfileId,
        file,
        event,
      });
    } catch {
      return [];
    }
  }

  async getTopFunctions(n = 10, event = 'cycles'): Promise<FunctionHotness[]> {
    if (!this._activeProfileId) return [];
    try {
      return await this._client.request<FunctionHotness[]>('getTopFunctions', {
        profileId: this._activeProfileId,
        n,
        event,
      });
    } catch {
      return [];
    }
  }

  // ── Staleness detection ────────────────────────────────────────────────

  // Call after a document save. If the saved file was part of the active
  // profile's snapshot, computes its current hash and warns if it changed.
  async checkStaleness(uri: vscode.Uri): Promise<void> {
    if (!this._activeProfileId) return;
    const file = uri.fsPath;
    try {
      const hashes = await this._client.request<Record<string, string>>(
        'getSourceHashes', { profileId: this._activeProfileId },
      );
      if (!(file in hashes)) return;
      const current = hashFile(file);
      if (current && current !== hashes[file]) {
        const choice = await vscode.window.showInformationMessage(
          `Perf Lens: source file "${file.split('/').pop()}" has changed since this profile was recorded. Hotness data may be stale.`,
          'Re-profile', 'Show Profile Panel', 'Dismiss',
        );
        if (choice === 'Re-profile') {
          await vscode.commands.executeCommand('perfLens.recordProfile');
        } else if (choice === 'Show Profile Panel') {
          await vscode.commands.executeCommand('perfLens.showProfilePanel');
        }
      }
    } catch {
      // Silently ignore — staleness check is best-effort
    }
  }

  // Store current file hashes for the active profile (call after import).
  async snapshotSourceHashes(files: string[]): Promise<void> {
    if (!this._activeProfileId) return;
    const hashes: Record<string, string> = {};
    for (const f of files) {
      const h = hashFile(f);
      if (h) hashes[f] = h;
    }
    try {
      await this._client.request<unknown>('storeSourceHashes', {
        profileId: this._activeProfileId,
        hashes,
      });
    } catch { /* best-effort */ }
  }

  dispose(): void {
    this._onProfileChanged.dispose();
  }
}

function hashFile(filePath: string): string | null {
  try {
    const data = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(data).digest('hex');
  } catch {
    return null;
  }
}
