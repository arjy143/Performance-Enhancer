import * as vscode from 'vscode';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

const LEVEL_RANK: Record<LogLevel, number> = {
  error: 0,
  warn:  1,
  info:  2,
  debug: 3,
  trace: 4,
};

let _channel: vscode.OutputChannel | undefined;
let _minLevel: LogLevel = 'info';

export function initLogger(channel: vscode.OutputChannel, minLevel: LogLevel = 'info'): void {
  _channel = channel;
  _minLevel = minLevel;
}

function log(level: LogLevel, message: string, ...args: unknown[]): void {
  if (!_channel) return;
  if (LEVEL_RANK[level] > LEVEL_RANK[_minLevel]) return;

  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}]`;
  const extra = args.length > 0 ? ' ' + args.map(a => JSON.stringify(a)).join(' ') : '';
  _channel.appendLine(`${prefix} ${message}${extra}`);
}

export const logger = {
  error: (msg: string, ...args: unknown[]): void => log('error', msg, ...args),
  warn:  (msg: string, ...args: unknown[]): void => log('warn',  msg, ...args),
  info:  (msg: string, ...args: unknown[]): void => log('info',  msg, ...args),
  debug: (msg: string, ...args: unknown[]): void => log('debug', msg, ...args),
  trace: (msg: string, ...args: unknown[]): void => log('trace', msg, ...args),
};
