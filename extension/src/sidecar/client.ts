import { EventEmitter } from 'events';
import { createInterface } from 'readline';
import type { ChildProcess } from 'child_process';
import { isRpcResponse, isRpcNotification, type RpcNotification } from './protocol';
import { logger } from '../util/logger';

type PendingRequest = {
  resolve: (result: unknown) => void;
  reject:  (err: Error) => void;
};

export class SidecarClient extends EventEmitter {
  private readonly _pending = new Map<number, PendingRequest>();
  private _nextId = 1;
  private _ready = false;

  constructor(private readonly _proc: ChildProcess) {
    super();
    this._wire();
  }

  private _wire(): void {
    const rl = createInterface({ input: this._proc.stdout! });

    rl.on('line', (line: string) => {
      if (!line.trim()) return;
      let msg: unknown;
      try {
        msg = JSON.parse(line) as unknown;
      } catch {
        logger.warn('sidecar: unparseable line', line);
        return;
      }

      if (isRpcResponse(msg)) {
        const pending = this._pending.get(msg.id as number);
        if (!pending) {
          logger.warn('sidecar: no pending request for id', msg.id);
          return;
        }
        this._pending.delete(msg.id as number);
        if (msg.error) {
          pending.reject(new Error(`RPC error ${msg.error.code}: ${msg.error.message}`));
        } else {
          pending.resolve(msg.result);
        }
      } else if (isRpcNotification(msg)) {
        this._handleNotification(msg);
      } else {
        logger.warn('sidecar: unexpected message shape');
      }
    });

    this._proc.stderr!.on('data', (chunk: Buffer) => {
      logger.debug('sidecar:', chunk.toString().trimEnd());
    });
  }

  private _handleNotification(msg: RpcNotification): void {
    this.emit('notification', msg);
    this.emit(`notification:${msg.method}`, msg.params);
  }

  request<T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
    const id = this._nextId++;
    const envelope = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }

      this._pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });

      signal?.addEventListener('abort', () => {
        this._pending.delete(id);
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });

      this._proc.stdin!.write(envelope + '\n', (err) => {
        if (err) {
          this._pending.delete(id);
          reject(err);
        }
      });
    });
  }

  notify(method: string, params?: unknown): void {
    const envelope = JSON.stringify({ jsonrpc: '2.0', method, params });
    this._proc.stdin!.write(envelope + '\n');
  }

  get isReady(): boolean { return this._ready; }
  markReady(): void      { this._ready = true; }
}
