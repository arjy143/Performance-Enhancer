import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { SidecarClient } from './client';
import { type ReadyParams } from './protocol';
import { logger } from '../util/logger';

const MAX_RESTARTS      = 3;
const RESTART_WINDOW_MS = 5 * 60 * 1000;
const READY_TIMEOUT_MS  = 10_000;

export class SidecarLifecycle implements vscode.Disposable {
  private _proc:    ChildProcess | undefined;
  private _client:  SidecarClient | undefined;
  private _restarts = 0;
  private _windowStart = Date.now();
  private _disposed = false;

  constructor(
    private readonly _ctx: vscode.ExtensionContext,
    private readonly _workspacePath: string,
  ) {}

  async start(): Promise<SidecarClient> {
    const bin = this._resolveBinary();
    logger.info(`Spawning sidecar: ${bin}`);

    const proc = spawn(bin, [`--workspace=${this._workspacePath}`], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const client = new SidecarClient(proc);
    this._proc   = proc;
    this._client = client;

    await this._awaitReady(client, proc);

    proc.on('exit', (code, signal) => {
      logger.warn(`Sidecar exited — code=${String(code)} signal=${String(signal)}`);
      if (!this._disposed) void this._maybeRestart();
    });

    return client;
  }

  private _awaitReady(client: SidecarClient, proc: ChildProcess): Promise<void> {
    return new Promise((resolve, reject) => {
      proc.on('error', (err: Error) => reject(err));

      const timer = setTimeout(
        () => reject(new Error('Sidecar did not send ready within 10 s')),
        READY_TIMEOUT_MS,
      );

      client.once('notification:ready', (params: ReadyParams) => {
        clearTimeout(timer);
        client.markReady();
        logger.info(`Sidecar ready — pid=${params.pid} version=${params.version}`);
        resolve();
      });
    });
  }

  private _resolveBinary(): string {
    // Development: binary built by CMake alongside the extension
    const devPath = path.resolve(
      this._ctx.extensionPath, '..', 'sidecar', 'build', 'perf-lens-sidecar',
    );
    if (fs.existsSync(devPath)) return devPath;

    // Production: bundled under resources/bin/
    const prodPath = path.join(
      this._ctx.extensionPath, 'resources', 'bin', 'perf-lens-sidecar',
    );
    if (fs.existsSync(prodPath)) return prodPath;

    throw new Error(
      'perf-lens-sidecar binary not found. ' +
      'Run `cmake --build sidecar/build` to build the sidecar.',
    );
  }

  private async _maybeRestart(): Promise<void> {
    const now = Date.now();
    if (now - this._windowStart > RESTART_WINDOW_MS) {
      this._restarts = 0;
      this._windowStart = now;
    }

    this._restarts++;
    if (this._restarts > MAX_RESTARTS) {
      logger.error(`Sidecar crashed ${MAX_RESTARTS} times in 5 minutes — giving up.`);
      void vscode.window.showErrorMessage(
        'Perf Lens: The analysis sidecar crashed repeatedly. ' +
        'Check the "Perf Lens" output channel for details.',
      );
      return;
    }

    const delayMs = 1000 * this._restarts;
    logger.warn(`Restarting sidecar in ${delayMs} ms (attempt ${this._restarts}/${MAX_RESTARTS})…`);
    await new Promise(r => setTimeout(r, delayMs));

    try {
      await this.start();
      logger.info('Sidecar restarted successfully.');
    } catch (err) {
      logger.error('Sidecar restart failed:', (err as Error).message);
    }
  }

  get client(): SidecarClient | undefined { return this._client; }

  dispose(): void {
    this._disposed = true;
    this._proc?.kill();
    this._proc   = undefined;
    this._client = undefined;
  }
}
