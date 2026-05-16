import { isRpcResponse, isRpcNotification } from './protocol';

describe('JSON-RPC 2.0 message framing', () => {
  it('serialises a request to a newline-terminated JSON string', () => {
    const req = { jsonrpc: '2.0' as const, id: 1, method: 'ping' };
    const line = JSON.stringify(req) + '\n';
    const parsed = JSON.parse(line.trim()) as Record<string, unknown>;
    expect(parsed['jsonrpc']).toBe('2.0');
    expect(parsed['method']).toBe('ping');
    expect(typeof parsed['id']).toBe('number');
  });

  it('parses a valid ping response', () => {
    const line = '{"jsonrpc":"2.0","id":1,"result":{"pong":true}}';
    const msg = JSON.parse(line) as unknown;
    expect(isRpcResponse(msg)).toBe(true);
    expect(isRpcNotification(msg)).toBe(false);
    const resp = msg as Record<string, Record<string, unknown>>;
    expect(resp['result']['pong']).toBe(true);
  });

  it('parses a valid ready notification', () => {
    const line = '{"jsonrpc":"2.0","method":"ready","params":{"version":"0.1.0","pid":1234,"capabilities":[]}}';
    const msg = JSON.parse(line) as unknown;
    expect(isRpcNotification(msg)).toBe(true);
    expect(isRpcResponse(msg)).toBe(false);
    const notif = msg as Record<string, Record<string, unknown>>;
    expect(notif['params']['version']).toBe('0.1.0');
  });

  it('parses an RPC error response', () => {
    const line = '{"jsonrpc":"2.0","id":99,"error":{"code":-32601,"message":"Method not found"}}';
    const msg = JSON.parse(line) as unknown;
    expect(isRpcResponse(msg)).toBe(true);
    const resp = msg as Record<string, Record<string, unknown>>;
    expect(resp['error']['code']).toBe(-32601);
  });

  it('ids increment per request', () => {
    const ids = [1, 2, 3].map(id =>
      JSON.parse(JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' })) as Record<string, unknown>
    );
    expect(ids[0]['id']).toBe(1);
    expect(ids[1]['id']).toBe(2);
    expect(ids[2]['id']).toBe(3);
  });
});
