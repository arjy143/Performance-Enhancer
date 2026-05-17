import * as vscode from 'vscode';
import * as path from 'path';
import { initLogger, logger } from './util/logger';
import { registerCommands } from './ui/commands';
import { PerfLensStatusBar } from './ui/statusBar';
import { SidecarClient } from './sidecar/client';
import { SidecarLifecycle } from './sidecar/lifecycle';
import { detectBuildSystem } from './build/detect';
import { loadProjectConfig } from './config/projectConfig';
import type { PingResult } from './sidecar/protocol';
import { RemarksDiagnosticProvider } from './diagnostics/provider';
import { RemarksHoverProvider } from './diagnostics/hover';
import { FindingsDiagnosticProvider, FindingsHoverProvider } from './diagnostics/findingsProvider';
import { RemarksTreeDataProvider } from './panels/remarksPanel';
import { OptRecordsWatcher } from './build/watcher';
import { LLMManager, readSnippet } from './llm/manager';
import { ExplanationPanel } from './panels/explanationPanel';
import { AsmDiffPanel } from './panels/asmDiffPanel';
import { CacheLinePanel } from './panels/cacheLinePanel';
import { LoopAnalyserPanel } from './panels/loopAnalyserPanel';
import { PerfLensCodeActionProvider } from './fixProvider/codeActionProvider';
import { buildPatch } from './fixProvider/patchTemplates';
import { verifyPatch } from './fixProvider/verifier';
import { ProfileManager } from './profile/profileManager';
import { GutterHeatmapProvider } from './profile/hotnessProvider';
import { ProfilePanel } from './panels/profilePanel';
import { RecordProfilePanel } from './panels/recordProfilePanel';
import { ProfileComparePanel } from './panels/profileComparePanel';
import { buildSarifLog } from './sarif/exporter';
import { collectBundle, writeBundleJson, bundleChecksum, defaultBundleFilename } from './diagnostics/bundle';
import type { ProviderConfig } from './llm/types';
import type { OptRemark, Finding, AsmDiff, CompileResult } from './sidecar/protocol';

let _lifecycle: SidecarLifecycle | undefined;

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const channel = vscode.window.createOutputChannel('Perf Lens');
  ctx.subscriptions.push(channel);
  initLogger(channel, 'info');

  logger.info('Perf Lens activating…');

  registerCommands(ctx);
  const statusBar = new PerfLensStatusBar(ctx);
  ctx.subscriptions.push(statusBar);

  void _initialiseAsync(ctx, statusBar);
}

async function _initialiseAsync(
  ctx: vscode.ExtensionContext,
  statusBar: PerfLensStatusBar,
): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    logger.warn('No workspace folder — Perf Lens inactive.');
    statusBar.setError('no workspace');
    return;
  }

  const config = loadProjectConfig(workspaceRoot);
  logger.info(`Project: ${config?.project?.name ?? '(unnamed)'}`);

  await detectBuildSystem(workspaceRoot);
  _warnIfNoCompileCommands(workspaceRoot);

  _lifecycle = new SidecarLifecycle(ctx, workspaceRoot);
  ctx.subscriptions.push(_lifecycle);

  let client: SidecarClient | undefined;
  try {
    client = await _lifecycle.start();
    const pong = await client.request<PingResult>('ping');
    logger.info(`Sidecar ping OK — pong=${String(pong.pong)}`);
  } catch (err) {
    const msg = (err as Error).message;
    logger.error(`Sidecar unavailable: ${msg}`);
    statusBar.setNoSidecar();
    return;
  }
  if (!client) return;
  const sidecar = client;

  // Phase 2: compiler remarks providers
  const diagnostics = new RemarksDiagnosticProvider(sidecar);
  ctx.subscriptions.push(diagnostics);

  const hoverProvider = new RemarksHoverProvider(sidecar);
  ctx.subscriptions.push(
    vscode.languages.registerHoverProvider(
      [{ language: 'cpp' }, { language: 'c' }],
      hoverProvider,
    ),
  );

  const treeProvider = new RemarksTreeDataProvider(sidecar);
  ctx.subscriptions.push(
    vscode.window.registerTreeDataProvider('perfLens.remarks', treeProvider),
    treeProvider,
  );

  const watcher = new OptRecordsWatcher(sidecar, diagnostics, treeProvider);
  ctx.subscriptions.push(watcher);

  // Phase 3: static analysis findings
  const findingsProvider = new FindingsDiagnosticProvider(sidecar, workspaceRoot);
  ctx.subscriptions.push(findingsProvider);

  const findingsHover = new FindingsHoverProvider(findingsProvider);
  ctx.subscriptions.push(
    vscode.languages.registerHoverProvider(
      [{ language: 'cpp' }, { language: 'c' }],
      findingsHover,
    ),
    findingsHover,
  );

  // Phase 6: profile integration
  const profileManager = new ProfileManager(sidecar);
  ctx.subscriptions.push(profileManager);
  await profileManager.refreshProfiles();

  findingsProvider.setProfileManager(profileManager);

  const hotnessProvider = new GutterHeatmapProvider(profileManager);
  ctx.subscriptions.push(hotnessProvider);

  // Staleness check on save
  ctx.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(doc => {
      if (doc.languageId === 'cpp' || doc.languageId === 'c') {
        void profileManager.checkStaleness(doc.uri);
      }
    }),
  );

  // Phase 4: LLM layer
  const llm = new LLMManager(ctx.globalStorageUri);
  ctx.subscriptions.push(llm);
  _initLLMProviders(llm);

  // Probe provider health asynchronously — don't block activation.
  if (llm.hasProviders) {
    void llm.probeAll().then(() => {
      if (!llm.hasHealthyProvider) {
        void vscode.window.showWarningMessage(
          'Perf Lens: No LLM provider is reachable. AI explain and translate features are disabled.',
          'Configure provider',
        ).then(choice => {
          if (choice === 'Configure provider') {
            void vscode.commands.executeCommand(
              'workbench.action.openSettings', 'perfLens.llm',
            );
          }
        });
      }
    });
  }

  // Commands
  ctx.subscriptions.push(
    vscode.commands.registerCommand('perfLens.analyseFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showWarningMessage('Perf Lens: open a C/C++ file first.');
        return;
      }
      const file = editor.document.uri.fsPath;
      statusBar.setStarting();
      try {
        const result = await sidecar.request<{ count: number; buildId: string }>(
          'analyseFile', { file },
        );
        await findingsProvider.refreshFile(editor.document.uri);
        statusBar.setReady(result.count);
        if (result.count === 0) {
          void vscode.window.showInformationMessage('Perf Lens: no findings in this file.');
        }
      } catch (err) {
        const msg = (err as Error).message;
        logger.error(`Analyse file failed: ${msg}`);
        if (msg.includes('compile_commands.json')) {
          const choice = await vscode.window.showErrorMessage(
            'Perf Lens: compile_commands.json not found. ' +
            'Configure your build system to generate it (CMake: -DCMAKE_EXPORT_COMPILE_COMMANDS=ON).',
            'Open Settings',
          );
          if (choice === 'Open Settings') {
            void vscode.commands.executeCommand('workbench.action.openSettings', 'perfLens');
          }
        } else {
          void vscode.window.showErrorMessage(`Perf Lens: analysis failed — ${msg}`);
        }
        statusBar.setReady();
      }
    }),

    vscode.commands.registerCommand('perfLens.showPerfPanel', () => {
      ProfilePanel.show(ctx, profileManager);
    }),

    vscode.commands.registerCommand('perfLens.regenerateRemarks', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showWarningMessage('Open a C/C++ file first.');
        return;
      }
      const file = editor.document.uri.fsPath;
      statusBar.setStarting();
      try {
        const result = await sidecar.request<{ remarksFile: string; count: number }>(
          'recompileWithRemarks', { file },
        );
        logger.info(`Remarks regenerated: ${result.count} remarks from ${result.remarksFile}`);
        await diagnostics.refreshFile(editor.document.uri);
        treeProvider.refresh();
        statusBar.setReady(result.count);
      } catch (err) {
        const msg = (err as Error).message;
        logger.error(`Regenerate failed: ${msg}`);
        void vscode.window.showErrorMessage(`Perf Lens: ${msg}`);
        statusBar.setReady();
      }
    }),

    vscode.commands.registerCommand('perfLens.translateRemark', async (remark: OptRemark) => {
      if (!llm.hasProviders) {
        void vscode.window.showInformationMessage(
          'Perf Lens: configure an LLM provider in settings to use AI translation.',
        );
        return;
      }
      const panel = ExplanationPanel.show(ctx, `Translate: ${remark.pass}/${remark.name}`);
      const ctrl  = new AbortController();
      const snippet = readSnippet(remark.file, remark.line);
      const result  = await llm.translateRemark(remark, snippet, ctrl.signal);
      if (result.type === 'silent_degrade') {
        panel.showDegrade(result.reason ?? 'No provider available.');
      } else if (result.stream) {
        await panel.streamResult(result.stream, ctrl.signal);
      }
    }),

    vscode.commands.registerCommand('perfLens.explainFinding', async (finding: Finding) => {
      if (!llm.hasProviders) {
        void vscode.window.showInformationMessage(
          'Perf Lens: configure an LLM provider in settings to use AI explanations.',
        );
        return;
      }
      const panel = ExplanationPanel.show(ctx, `Explain: ${finding.title}`);
      const ctrl  = new AbortController();
      const snippet = readSnippet(finding.file, finding.line);
      const result  = await llm.explainFinding(finding, snippet, ctrl.signal);
      if (result.type === 'silent_degrade') {
        panel.showDegrade(result.reason ?? 'No provider available.');
      } else if (result.stream) {
        await panel.streamResult(result.stream, ctrl.signal);
      }
    }),

    vscode.commands.registerCommand('perfLens.clearLLMCache', () => {
      llm.clearCache();
      void vscode.window.showInformationMessage('Perf Lens: LLM cache cleared.');
    }),

    // Phase 5: code actions
    vscode.languages.registerCodeActionsProvider(
      [{ language: 'cpp' }, { language: 'c' }],
      new PerfLensCodeActionProvider(sidecar),
      { providedCodeActionKinds: PerfLensCodeActionProvider.providedCodeActionKinds },
    ),

    vscode.commands.registerCommand('perfLens.applyFix', async (finding: Finding) => {
      const patch = buildPatch(finding);
      if (!patch) {
        void vscode.window.showWarningMessage('Perf Lens: No fix template for this rule.');
        return;
      }
      // For comment-only patches, no verification is meaningful — apply directly.
      if (patch.isComment || patch.verificationPredicate === 'none') {
        await vscode.workspace.applyEdit(patch.edit);
        void vscode.window.showInformationMessage(`Perf Lens: Applied — ${patch.description}`);
        return;
      }
      // Run verification before applying; show asm diff and ask user to confirm.
      statusBar.setStarting();
      const ctrl   = new AbortController();
      const result = await verifyPatch(finding, patch, sidecar, ctrl.signal);
      statusBar.setReady();
      if (!result) {
        void vscode.window.showErrorMessage('Perf Lens: Verification failed — could not compile. Fix not applied.');
        return;
      }
      const panel = AsmDiffPanel.show(ctx);
      panel.render(patch.description, result.before, result.after, result.diff, result.verified);
      if (result.verified) {
        const choice = await vscode.window.showInformationMessage(
          `Perf Lens: Fix verified — ${result.reason}. Apply it?`,
          'Apply Fix', 'Dismiss',
        );
        if (choice === 'Apply Fix') await vscode.workspace.applyEdit(patch.edit);
      } else {
        void vscode.window.showWarningMessage(
          `Perf Lens: Fix not verified — ${result.reason}. Not applied.`,
        );
      }
    }),

    vscode.commands.registerCommand('perfLens.verifyFix', async (finding: Finding) => {
      const patch = buildPatch(finding);
      if (!patch) {
        void vscode.window.showWarningMessage('Perf Lens: No fix template for this rule.');
        return;
      }
      statusBar.setStarting();
      const ctrl   = new AbortController();
      const result = await verifyPatch(finding, patch, sidecar, ctrl.signal);
      statusBar.setReady();
      if (!result) {
        void vscode.window.showErrorMessage('Perf Lens: Verification failed — could not compile.');
        return;
      }
      const panel = AsmDiffPanel.show(ctx);
      panel.render(patch.description, result.before, result.after, result.diff, result.verified);
      if (result.verified) {
        const choice = await vscode.window.showInformationMessage(
          `Perf Lens: Fix verified — ${result.reason}`,
          'Apply Fix', 'Dismiss',
        );
        if (choice === 'Apply Fix') {
          await vscode.workspace.applyEdit(patch.edit);
        }
      } else {
        void vscode.window.showWarningMessage(`Perf Lens: Fix not verified — ${result.reason}`);
      }
    }),

    vscode.commands.registerCommand('perfLens.showCacheLineLayout', (finding: Finding) => {
      const panel = CacheLinePanel.show(ctx);
      panel.render(finding);
    }),

    // Phase 6 commands
    vscode.commands.registerCommand('perfLens.showProfilePanel', () => {
      ProfilePanel.show(ctx, profileManager);
    }),

    vscode.commands.registerCommand('perfLens.recordProfile', () => {
      RecordProfilePanel.show(ctx, profileManager);
    }),

    vscode.commands.registerCommand('perfLens.compareProfiles', () => {
      ProfileComparePanel.show(ctx, profileManager);
    }),

    vscode.commands.registerCommand('perfLens.synthesiseHotness', async () => {
      if (!llm.hasProviders) {
        void vscode.window.showInformationMessage(
          'Perf Lens: configure an LLM provider in settings to use AI synthesis.',
        );
        return;
      }
      if (!profileManager.hasActiveProfile) {
        void vscode.window.showWarningMessage('Perf Lens: load a profile first.');
        return;
      }
      const topFunctions = await profileManager.getTopFunctions(8);
      if (topFunctions.length === 0) {
        void vscode.window.showWarningMessage('Perf Lens: no hotness data in active profile.');
        return;
      }
      const activeProfile = profileManager.profiles.find(
        p => p.id === profileManager.activeProfileId,
      );
      const ctrl = new AbortController();
      const panel = ExplanationPanel.show(ctx, 'Perf Lens: Performance Synthesis');
      const result = await llm.synthesiseTopFindings({
        topFunctions: topFunctions.map(f => ({
          function: f.function,
          pct: f.fraction * 100,
          eventType: f.eventType,
        })),
        profileLabel:   activeProfile?.label ?? 'profile',
        totalSamples:   activeProfile?.totalSamples ?? 0,
        activeFindings: [],
        cpuModel:       activeProfile?.cpuModel,
      }, ctrl.signal);
      if (result.type === 'silent_degrade') {
        panel.showDegrade(result.reason ?? 'No provider available.');
      } else if (result.stream) {
        await panel.streamResult(result.stream, ctrl.signal);
      }
    }),

    vscode.commands.registerCommand('perfLens.importProfile', async () => {
      const uris = await vscode.window.showOpenDialog({
        title: 'Select profile file (perf.data, .pb.gz, .pprof)',
        filters: { 'Profile files': ['data', 'pb', 'gz', 'pprof'], 'All files': ['*'] },
        canSelectMany: false,
      });
      if (!uris || uris.length === 0) return;
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Perf Lens: importing profile…' },
          () => profileManager.importProfile(uris[0].fsPath),
        );
        void vscode.window.showInformationMessage('Perf Lens: profile imported.');
      } catch (err) {
        void vscode.window.showErrorMessage(`Perf Lens: import failed — ${(err as Error).message}`);
      }
    }),

    vscode.commands.registerCommand('perfLens.exportSarif', async () => {
      const saveUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(
          (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '') + '/perf-lens.sarif',
        ),
        filters: { 'SARIF files': ['sarif', 'json'] },
        title: 'Export Perf Lens findings as SARIF 2.1.0',
      });
      if (!saveUri) return;

      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

      try {
        // Gather findings for all affected files
        const findings: Finding[] = [];
        let affectedFiles: string[] = [];
        try {
          affectedFiles = await sidecar.request<string[]>('getAnalysedFiles');
        } catch { /* no findings yet */ }

        for (const file of affectedFiles) {
          const fileFindings = await sidecar.request<Finding[]>('getFindings', { file });
          findings.push(...fileFindings);
        }

        // Gather remarks similarly (best-effort)
        const remarks: OptRemark[] = [];
        try {
          const remarkedFiles = await sidecar.request<string[]>('getRemarkedFiles');
          for (const file of remarkedFiles) {
            const fileRemarks = await sidecar.request<OptRemark[]>('getRemarks', { file });
            remarks.push(...fileRemarks);
          }
        } catch { /* remarks optional */ }

        const sarif = buildSarifLog(findings, remarks, {
          workspaceRoot,
          includeRemarks: true,
          toolVersion: '1.0.0',
        });

        const fs = await import('fs');
        fs.writeFileSync(saveUri.fsPath, sarif, 'utf8');
        void vscode.window.showInformationMessage(
          `Perf Lens: exported ${findings.length} findings to ${saveUri.fsPath}`,
        );
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Perf Lens: SARIF export failed — ${(err as Error).message}`,
        );
      }
    }),

    vscode.commands.registerCommand('perfLens.diagnosticBundle', async () => {
      const defaultName = defaultBundleFilename(workspaceRoot);
      const saveUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(workspaceRoot, defaultName)),
        filters: { 'JSON files': ['json'] },
        title: 'Save Perf Lens Diagnostic Bundle',
      });
      if (!saveUri) return;

      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Perf Lens: collecting diagnostics…', cancellable: false },
          async () => {
            const bundle = await collectBundle(sidecar, profileManager, workspaceRoot);
            writeBundleJson(bundle, saveUri.fsPath);
            const checksum = bundleChecksum(bundle);
            void vscode.window.showInformationMessage(
              `Perf Lens: bundle saved (${bundle.manifest.summary.findingCount} findings, sha256: ${checksum.slice(0, 8)}…)`,
            );
          },
        );
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Perf Lens: bundle export failed — ${(err as Error).message}`,
        );
      }
    }),

    vscode.commands.registerCommand('perfLens.configureLLM', () => {
      void vscode.commands.executeCommand('workbench.action.openSettings', 'perfLens.llm');
    }),

    vscode.commands.registerCommand('perfLens.profileDiffJson', async () => {
      const profiles = profileManager.profiles;
      if (profiles.length < 2) {
        void vscode.window.showWarningMessage('Perf Lens: at least two profiles are needed for a diff.');
        return;
      }
      const items = profiles.map(p => ({ label: p.label, id: p.id }));
      const before = await vscode.window.showQuickPick(items, { title: 'Baseline profile (before)' });
      if (!before) return;
      const after = await vscode.window.showQuickPick(
        items.filter(i => i.id !== before.id),
        { title: 'Candidate profile (after)' },
      );
      if (!after) return;

      const saveUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(
          path.join(workspaceRoot, `perf-diff-${Date.now()}.json`),
        ),
        filters: { 'JSON files': ['json'] },
        title: 'Save Profile Diff JSON',
      });
      if (!saveUri) return;

      const prevActive = profileManager.activeProfileId;
      profileManager.setActiveProfile(before.id);
      const beforeFns = await profileManager.getTopFunctions(100);
      profileManager.setActiveProfile(after.id);
      const afterFns  = await profileManager.getTopFunctions(100);
      profileManager.setActiveProfile(prevActive);

      const beforeMap = new Map(beforeFns.map(f => [f.function, f.fraction]));
      const afterMap  = new Map(afterFns.map(f => [f.function, f.fraction]));
      const allFns    = new Set([...beforeMap.keys(), ...afterMap.keys()]);

      const REGRESSION_THRESHOLD = 0.02;
      const rows = [...allFns].map(fn => {
        const b = beforeMap.get(fn) ?? 0;
        const a = afterMap.get(fn)  ?? 0;
        return {
          function:     fn,
          beforePct:    +(b * 100).toFixed(2),
          afterPct:     +(a * 100).toFixed(2),
          deltaPct:     +((a - b) * 100).toFixed(2),
          isRegression: (a - b) > REGRESSION_THRESHOLD,
          isImprovement: (b - a) > REGRESSION_THRESHOLD,
        };
      }).sort((x, y) => Math.abs(y.deltaPct) - Math.abs(x.deltaPct));

      const report = {
        schema:    'perf-lens/profile-diff/v1',
        baseline:  { id: before.id, label: before.label },
        candidate: { id: after.id,  label: after.label },
        summary: {
          regressions:  rows.filter(r => r.isRegression).length,
          improvements: rows.filter(r => r.isImprovement).length,
        },
        rows,
      };

      const fs2 = await import('fs');
      fs2.writeFileSync(saveUri.fsPath, JSON.stringify(report, null, 2), 'utf8');
      void vscode.window.showInformationMessage(
        `Perf Lens: diff saved — ${report.summary.regressions} regressions, ` +
        `${report.summary.improvements} improvements.`,
      );
    }),

    vscode.commands.registerCommand('perfLens.openLoopAnalyser', async (finding: Finding) => {
      const panel = LoopAnalyserPanel.show(ctx);
      const ctrl  = new AbortController();
      let remarks: OptRemark[] = [];
      try {
        remarks = await sidecar.request<OptRemark[]>('getRemarks', { file: finding.file, line: finding.line });
      } catch { /* ignore */ }
      await panel.loadForFinding(finding, remarks, sidecar, ctrl.signal);
    }),
  );

  // Seed diagnostics for the currently open file
  if (vscode.window.activeTextEditor) {
    const doc = vscode.window.activeTextEditor.document;
    if (doc.languageId === 'cpp' || doc.languageId === 'c') {
      void diagnostics.refreshFile(doc.uri);
      void findingsProvider.refreshFile(doc.uri);
    }
  }

  statusBar.setReady();
  logger.info('Perf Lens 1.0.0 ready.');
}

function _warnIfNoCompileCommands(workspaceRoot: string): void {
  const { existsSync } = require('fs') as typeof import('fs');
  const candidates = [
    path.join(workspaceRoot, 'compile_commands.json'),
    path.join(workspaceRoot, 'build', 'compile_commands.json'),
    path.join(workspaceRoot, 'build', 'Release', 'compile_commands.json'),
    path.join(workspaceRoot, 'build', 'Debug', 'compile_commands.json'),
  ];
  if (candidates.some(existsSync)) return;

  void vscode.window.showWarningMessage(
    'Perf Lens: compile_commands.json not found. Static analysis and compiler remarks require it.',
    'CMake instructions',
    'Dismiss',
  ).then(choice => {
    if (choice === 'CMake instructions') {
      void vscode.window.showInformationMessage(
        'Add -DCMAKE_EXPORT_COMPILE_COMMANDS=ON to your CMake configure step, ' +
        'then re-run cmake. For other build systems use "bear -- <build-command>".',
      );
    }
  });
}

function _initLLMProviders(llm: LLMManager): void {
  const cfg = vscode.workspace.getConfiguration('perfLens');

  // Auto-detect Ollama if perfLens.llm.primary starts with 'ollama:'
  const primary = cfg.get<string>('llm.primary', '');
  if (primary.startsWith('ollama:')) {
    const model = primary.slice('ollama:'.length);
    llm.addProvider({ id: 'ollama-primary', type: 'ollama', model });
  }

  // Explicit providers list from settings.
  const providers = cfg.get<ProviderConfig[]>('llm.providers', []);
  for (const p of providers) llm.addProvider(p);

  // Always try to auto-detect Ollama as fallback if no providers yet.
  if (!llm.hasProviders) {
    llm.addProvider({
      id: 'ollama-auto',
      type: 'ollama',
      model: 'qwen2.5-coder:7b',
    });
  }
}

export function deactivate(): void {
  _lifecycle?.dispose();
}
