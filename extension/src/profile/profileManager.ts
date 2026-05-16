import * as vscode from 'vscode';
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

  dispose(): void {
    this._onProfileChanged.dispose();
  }
}
