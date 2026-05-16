import type { SidecarClient } from '../sidecar/client';
import { ProfileManager } from './profileManager';
import type { ProfileMetadata, LineHotness, FunctionHotness } from '../sidecar/protocol';

function makeClient(overrides: Record<string, unknown> = {}): SidecarClient {
  return {
    request: jest.fn(async (method: string) => {
      if (method in overrides) return overrides[method];
      return null;
    }),
  } as unknown as SidecarClient;
}

describe('ProfileManager', () => {
  it('importProfile calls sidecar and sets active profile', async () => {
    const client = makeClient({
      importProfile: { profileId: 'abc123', totalSamples: 5000 },
      listProfiles:  [] as ProfileMetadata[],
    });
    const mgr = new ProfileManager(client);
    const result = await mgr.importProfile('/tmp/perf.data', 'bench');

    expect(result.profileId).toBe('abc123');
    expect(result.totalSamples).toBe(5000);
    expect(mgr.activeProfileId).toBe('abc123');
    expect(mgr.hasActiveProfile).toBe(true);
  });

  it('deleteProfile clears active profile when it matches', async () => {
    const client = makeClient({
      importProfile: { profileId: 'p1', totalSamples: 100 },
      deleteProfile: { ok: true },
      listProfiles:  [] as ProfileMetadata[],
    });
    const mgr = new ProfileManager(client);
    await mgr.importProfile('/tmp/x.data');
    await mgr.deleteProfile('p1');
    expect(mgr.activeProfileId).toBeUndefined();
    expect(mgr.hasActiveProfile).toBe(false);
  });

  it('setActiveProfile fires onProfileChanged', () => {
    const client = makeClient();
    const mgr = new ProfileManager(client);
    const events: (string | undefined)[] = [];
    mgr.onProfileChanged(id => events.push(id));
    mgr.setActiveProfile('xyz');
    expect(events).toEqual(['xyz']);
  });

  it('getLineHotness returns null when no active profile', async () => {
    const client = makeClient();
    const mgr = new ProfileManager(client);
    const h = await mgr.getLineHotness('/a.cpp', 42);
    expect(h).toBeNull();
  });

  it('getLineHotness caches results', async () => {
    const hotness: LineHotness = {
      file: '/a.cpp', line: 42, eventType: 'cycles',
      selfCount: 100, totalCount: 1000, fraction: 0.1,
    };
    const requestFn = jest.fn(async (method: string) => {
      if (method === 'importProfile') return { profileId: 'p1', totalSamples: 1000 };
      if (method === 'listProfiles')  return [];
      if (method === 'getLineHotness') return hotness;
      return null;
    });
    const client = { request: requestFn } as unknown as SidecarClient;
    const mgr = new ProfileManager(client);
    await mgr.importProfile('/tmp/x');

    await mgr.getLineHotness('/a.cpp', 42);
    await mgr.getLineHotness('/a.cpp', 42);

    const hotnessCalls = requestFn.mock.calls.filter(c => c[0] === 'getLineHotness');
    expect(hotnessCalls).toHaveLength(1);   // second call served from cache
  });

  it('getTopFunctions returns empty array with no profile', async () => {
    const client = makeClient();
    const mgr = new ProfileManager(client);
    const fns = await mgr.getTopFunctions(5);
    expect(fns).toEqual([]);
  });

  it('getTopFunctions calls sidecar with active profile', async () => {
    const fns: FunctionHotness[] = [
      { function: 'integrate', eventType: 'cycles', selfCount: 500, totalCount: 1000, fraction: 0.5 },
    ];
    const client = makeClient({
      importProfile:    { profileId: 'p1', totalSamples: 1000 },
      listProfiles:     [] as ProfileMetadata[],
      getTopFunctions:  fns,
    });
    const mgr = new ProfileManager(client);
    await mgr.importProfile('/tmp/x');
    const result = await mgr.getTopFunctions(10);
    expect(result).toEqual(fns);
  });
});
