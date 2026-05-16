import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import type { SidecarClient } from '../sidecar/client';
import type { ProfileManager } from '../profile/profileManager';
import type { Finding, OptRemark, ProfileMetadata, FunctionHotness } from '../sidecar/protocol';
import { buildSarifLog } from '../sarif/exporter';

export interface BundleManifest {
  version: string;
  bundledAt: string;           // ISO-8601
  tool: string;
  workspaceRoot: string;
  system: SystemInfo;
  summary: BundleSummary;
}

export interface SystemInfo {
  platform: string;
  arch: string;
  nodeVersion: string;
  osRelease: string;
}

export interface BundleSummary {
  findingCount: number;
  remarkCount: number;
  affectedFiles: string[];
  activeProfileId: string | undefined;
  topFunctions: Array<{ function: string; pct: number }>;
}

export interface DiagnosticBundle {
  manifest: BundleManifest;
  findings: Finding[];
  remarks: OptRemark[];
  sarif: string;
  profiles: readonly ProfileMetadata[];
  topFunctions: FunctionHotness[];
}

export async function collectBundle(
  sidecar: SidecarClient,
  profileManager: ProfileManager,
  workspaceRoot: string,
  toolVersion = '0.6.0',
): Promise<DiagnosticBundle> {
  // --- Findings ---
  const findings: Finding[] = [];
  let affectedFiles: string[] = [];
  try {
    affectedFiles = await sidecar.request<string[]>('getAffectedFiles');
  } catch { /* empty workspace */ }
  for (const file of affectedFiles) {
    const ff = await sidecar.request<Finding[]>('getFindings', { file });
    findings.push(...ff);
  }

  // --- Remarks ---
  const remarks: OptRemark[] = [];
  try {
    const remarked = await sidecar.request<{ files: string[] }>('getRemarkedFiles');
    for (const file of remarked.files) {
      const rr = await sidecar.request<OptRemark[]>('getRemarks', { file });
      remarks.push(...rr);
    }
  } catch { /* remarks optional */ }

  // --- Profile data ---
  const profiles = profileManager.profiles;
  let topFunctions: FunctionHotness[] = [];
  if (profileManager.hasActiveProfile) {
    try {
      topFunctions = await profileManager.getTopFunctions(20);
    } catch { /* ignore */ }
  }

  const sarif = buildSarifLog(findings, remarks, { workspaceRoot, toolVersion });

  const manifest: BundleManifest = {
    version: toolVersion,
    bundledAt: new Date().toISOString(),
    tool: 'Perf Lens',
    workspaceRoot,
    system: {
      platform:    os.platform(),
      arch:        os.arch(),
      nodeVersion: process.version,
      osRelease:   os.release(),
    },
    summary: {
      findingCount:    findings.length,
      remarkCount:     remarks.length,
      affectedFiles,
      activeProfileId: profileManager.activeProfileId,
      topFunctions:    topFunctions.slice(0, 5).map(f => ({
        function: f.function,
        pct:      Math.round(f.fraction * 1000) / 10,
      })),
    },
  };

  return { manifest, findings, remarks, sarif, profiles, topFunctions };
}

// Write the bundle to a single JSON file.
// Returns the path written to.
export function writeBundleJson(bundle: DiagnosticBundle, outPath: string): void {
  const content = JSON.stringify(bundle, null, 2);
  fs.writeFileSync(outPath, content, 'utf8');
}

// Returns a hex digest of the bundle contents for integrity verification.
export function bundleChecksum(bundle: DiagnosticBundle): string {
  const content = JSON.stringify(bundle);
  return crypto.createHash('sha256').update(content).digest('hex');
}

// Derive a default filename for the bundle.
export function defaultBundleFilename(workspaceRoot: string): string {
  const projectName = path.basename(workspaceRoot) || 'project';
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `perf-lens-bundle-${projectName}-${ts}.json`;
}
