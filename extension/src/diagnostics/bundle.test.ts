import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { collectBundle, writeBundleJson, bundleChecksum, defaultBundleFilename } from './bundle';
import type { Finding, OptRemark, FunctionHotness, ProfileMetadata } from '../sidecar/protocol';
import { FindingCategory, ConfidenceLevel, RemarkCategory } from '../sidecar/protocol';

// ---------------------------------------------------------------------------
// Minimal mocks
// ---------------------------------------------------------------------------

function makeFinding(file = '/ws/main.cpp'): Finding {
  return {
    ruleId: 'perf-lens.hotpath.vector-no-reserve',
    title: 'test', message: 'test', file, line: 1, column: 1,
    category: FindingCategory.HotPath, confidence: ConfidenceLevel.Medium, buildId: '',
  };
}

function makeRemark(file = '/ws/main.cpp'): OptRemark {
  return {
    type: 1, pass: 'loop-vectorize', name: 'not vectorized',
    file, line: 1, column: 1, function: 'f', message: 'aliasing',
    category: RemarkCategory.Vectorisation, isStale: false, buildId: '',
  };
}

function mockSidecar(findings: Finding[], remarks: OptRemark[]): import('../sidecar/client').SidecarClient {
  return {
    request: jest.fn(async (method: string) => {
      if (method === 'getAnalysedFiles')  return ['/ws/main.cpp'];
      if (method === 'getFindings')       return findings;
      if (method === 'getRemarkedFiles')  return ['/ws/main.cpp'];
      if (method === 'getRemarks')        return remarks;
      return [];
    }),
  } as unknown as import('../sidecar/client').SidecarClient;
}

function mockProfileManager(
  profiles: ProfileMetadata[] = [],
  topFunctions: FunctionHotness[] = [],
  activeProfileId: string | undefined = undefined,
): import('../profile/profileManager').ProfileManager {
  return {
    profiles,
    activeProfileId,
    hasActiveProfile: !!activeProfileId,
    getTopFunctions: jest.fn(async () => topFunctions),
  } as unknown as import('../profile/profileManager').ProfileManager;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('collectBundle', () => {
  it('collects findings and remarks into the bundle', async () => {
    const sidecar = mockSidecar([makeFinding()], [makeRemark()]);
    const pm = mockProfileManager();
    const bundle = await collectBundle(sidecar, pm, '/ws');
    expect(bundle.findings).toHaveLength(1);
    expect(bundle.remarks).toHaveLength(1);
    expect(bundle.manifest.summary.findingCount).toBe(1);
    expect(bundle.manifest.summary.remarkCount).toBe(1);
  });

  it('includes a valid SARIF string in the bundle', async () => {
    const sidecar = mockSidecar([makeFinding()], []);
    const pm = mockProfileManager();
    const bundle = await collectBundle(sidecar, pm, '/ws');
    const sarif = JSON.parse(bundle.sarif);
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0].results).toHaveLength(1);
  });

  it('populates system info from os module', async () => {
    const sidecar = mockSidecar([], []);
    const pm = mockProfileManager();
    const bundle = await collectBundle(sidecar, pm, '/ws');
    expect(bundle.manifest.system.platform).toBe(os.platform());
    expect(bundle.manifest.system.arch).toBe(os.arch());
  });

  it('sets workspaceRoot in manifest', async () => {
    const sidecar = mockSidecar([], []);
    const pm = mockProfileManager();
    const bundle = await collectBundle(sidecar, pm, '/my/project');
    expect(bundle.manifest.workspaceRoot).toBe('/my/project');
  });

  it('includes top functions when a profile is active', async () => {
    const fn: FunctionHotness = {
      function: 'compute', eventType: 'cycles', selfCount: 100, totalCount: 1000, fraction: 0.1,
    };
    const sidecar = mockSidecar([], []);
    const pm = mockProfileManager([], [fn], 'pid-1');
    const bundle = await collectBundle(sidecar, pm, '/ws');
    expect(bundle.topFunctions).toHaveLength(1);
    expect(bundle.manifest.summary.topFunctions[0].function).toBe('compute');
    expect(bundle.manifest.summary.topFunctions[0].pct).toBe(10);
  });

  it('handles sidecar failures gracefully — returns empty bundle', async () => {
    const sidecar = {
      request: jest.fn().mockRejectedValue(new Error('sidecar down')),
    } as unknown as import('../sidecar/client').SidecarClient;
    const pm = mockProfileManager();
    const bundle = await collectBundle(sidecar, pm, '/ws');
    expect(bundle.findings).toHaveLength(0);
    expect(bundle.remarks).toHaveLength(0);
  });
});

describe('writeBundleJson', () => {
  it('writes valid JSON to disk and reads back', async () => {
    const sidecar = mockSidecar([makeFinding()], []);
    const pm = mockProfileManager();
    const bundle = await collectBundle(sidecar, pm, '/ws');
    const tmpPath = path.join(os.tmpdir(), `pl-bundle-test-${Date.now()}.json`);
    try {
      writeBundleJson(bundle, tmpPath);
      const read = JSON.parse(fs.readFileSync(tmpPath, 'utf8'));
      expect(read.manifest.tool).toBe('Perf Lens');
      expect(read.findings).toHaveLength(1);
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });
});

describe('bundleChecksum', () => {
  it('returns a 64-char hex string', async () => {
    const sidecar = mockSidecar([], []);
    const pm = mockProfileManager();
    const bundle = await collectBundle(sidecar, pm, '/ws');
    const checksum = bundleChecksum(bundle);
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces the same checksum for identical bundles', async () => {
    const sidecar = mockSidecar([], []);
    const pm = mockProfileManager();
    const b1 = await collectBundle(sidecar, pm, '/ws');
    const b2 = await collectBundle(sidecar, pm, '/ws');
    // Timestamps will differ — compare fields that are deterministic
    b1.manifest.bundledAt = 'X';
    b2.manifest.bundledAt = 'X';
    expect(bundleChecksum(b1)).toBe(bundleChecksum(b2));
  });
});

describe('defaultBundleFilename', () => {
  it('includes the project name', () => {
    const name = defaultBundleFilename('/home/user/my-project');
    expect(name).toContain('my-project');
    expect(name).toMatch(/\.json$/);
  });

  it('falls back to "project" when path is empty', () => {
    const name = defaultBundleFilename('');
    expect(name).toContain('project');
  });
});
