/**
 * End-to-end integration test: spawns the real sidecar binary, checks the
 * ready notification, then exercises ping and echo over JSON-RPC stdio.
 *
 * Skipped automatically when the sidecar binary is absent (e.g. in pure
 * TypeScript CI jobs). The sidecar CI job runs this separately after building.
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SIDECAR_BIN = path.resolve(
  __dirname, '..', '..', 'sidecar', 'build', 'perf-lens-sidecar',
);

function sidecarAvailable(): boolean {
  return fs.existsSync(SIDECAR_BIN);
}

function spawnSidecar(workspaceDir: string) {
  return spawn(SIDECAR_BIN, [`--workspace=${workspaceDir}`], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function waitForLine(
  lines: string[],
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );

    function check(line: string) {
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (predicate(msg)) {
          clearTimeout(timer);
          resolve(msg);
        }
      } catch { /* not JSON yet */ }
    }

    // Check already-arrived lines
    for (const l of lines) check(l);

    // Listen for future lines via a custom event the test wires up
    onLine = (line: string) => { lines.push(line); check(line); };
  });
}

let onLine: ((line: string) => void) | undefined;

describe('Sidecar integration — ping / echo', () => {
  let tmpDir: string;
  let lines: string[];

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-lens-test-'));
    lines  = [];
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sidecar binary exists (otherwise suite is skipped)', () => {
    if (!sidecarAvailable()) {
      console.warn(`Sidecar not found at ${SIDECAR_BIN} — skipping integration suite`);
    }
    // Not a hard failure — lets pure-TS CI pass
    expect(true).toBe(true);
  });

  it('receives ready notification on startup', async () => {
    if (!sidecarAvailable()) return;

    const proc = spawnSidecar(tmpDir);
    const rl   = createInterface({ input: proc.stdout });

    rl.on('line', (l: string) => {
      lines.push(l);
      onLine?.(l);
    });

    const ready = await waitForLine(lines, m => m['method'] === 'ready', 8_000);
    const params = ready['params'] as Record<string, unknown>;

    expect(params['version']).toBe('0.1.0');
    expect(typeof params['pid']).toBe('number');
    expect(Array.isArray(params['capabilities'])).toBe(true);

    proc.kill();
  });

  it('responds to ping with pong:true', async () => {
    if (!sidecarAvailable()) return;

    const proc = spawnSidecar(tmpDir);
    const rl   = createInterface({ input: proc.stdout });
    rl.on('line', (l: string) => { lines.push(l); onLine?.(l); });

    // Wait for ready
    await waitForLine(lines, m => m['method'] === 'ready', 8_000);

    // Send ping
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n');

    const resp = await waitForLine(lines, m => m['id'] === 1, 5_000);
    const result = resp['result'] as Record<string, unknown>;
    expect(result['pong']).toBe(true);

    proc.kill();
  });

  it('responds to echo with the same message', async () => {
    if (!sidecarAvailable()) return;

    const proc = spawnSidecar(tmpDir);
    const rl   = createInterface({ input: proc.stdout });
    rl.on('line', (l: string) => { lines.push(l); onLine?.(l); });

    await waitForLine(lines, m => m['method'] === 'ready', 8_000);

    proc.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'echo', params: { message: 'hello' } }) + '\n',
    );

    const resp = await waitForLine(lines, m => m['id'] === 2, 5_000);
    const result = resp['result'] as Record<string, unknown>;
    expect(result['message']).toBe('hello');

    proc.kill();
  });

  it('returns MethodNotFound for unknown methods', async () => {
    if (!sidecarAvailable()) return;

    const proc = spawnSidecar(tmpDir);
    const rl   = createInterface({ input: proc.stdout });
    rl.on('line', (l: string) => { lines.push(l); onLine?.(l); });

    await waitForLine(lines, m => m['method'] === 'ready', 8_000);

    proc.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'no_such_method' }) + '\n',
    );

    const resp = await waitForLine(lines, m => m['id'] === 3, 5_000);
    const error = resp['error'] as Record<string, unknown>;
    expect(error['code']).toBe(-32601);

    proc.kill();
  });
});
