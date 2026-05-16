import * as vscode from 'vscode';
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
import { FindingsDiagnosticProvider } from './diagnostics/findingsProvider';
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
  const findingsProvider = new FindingsDiagnosticProvider(sidecar);
  ctx.subscriptions.push(findingsProvider);

  // Phase 6: profile integration
  const profileManager = new ProfileManager(sidecar);
  ctx.subscriptions.push(profileManager);
  await profileManager.refreshProfiles();

  findingsProvider.setProfileManager(profileManager);

  const hotnessProvider = new GutterHeatmapProvider(profileManager);
  ctx.subscriptions.push(hotnessProvider);

  // Phase 4: LLM layer
  const llm = new LLMManager(ctx.globalStorageUri);
  ctx.subscriptions.push(llm);
  _initLLMProviders(llm);

  // Probe provider health asynchronously — don't block activation.
  if (llm.hasProviders) void llm.probeAll();

  // Commands
  ctx.subscriptions.push(
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
      await vscode.workspace.applyEdit(patch.edit);
      void vscode.window.showInformationMessage(`Perf Lens: Applied — ${patch.description}`);
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
  logger.info('Perf Lens ready (Phase 5).');
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
