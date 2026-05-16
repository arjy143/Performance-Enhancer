import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { logger } from '../util/logger';

export interface BuildSystemInfo {
  compileCommandsPath: string;
  buildDir: string;
}

export async function detectBuildSystem(
  workspaceRoot: string,
): Promise<BuildSystemInfo | undefined> {
  const candidates = [
    path.join(workspaceRoot, 'compile_commands.json'),
    path.join(workspaceRoot, 'build', 'compile_commands.json'),
    path.join(workspaceRoot, 'build', 'Release', 'compile_commands.json'),
    path.join(workspaceRoot, 'build', 'Debug', 'compile_commands.json'),
    path.join(workspaceRoot, 'cmake-build-debug', 'compile_commands.json'),
    path.join(workspaceRoot, 'cmake-build-release', 'compile_commands.json'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      logger.info(`Found compile_commands.json at ${candidate}`);
      return { compileCommandsPath: candidate, buildDir: path.dirname(candidate) };
    }
  }

  logger.warn('compile_commands.json not found');
  await _warnMissing(workspaceRoot);
  return undefined;
}

async function _warnMissing(workspaceRoot: string): Promise<void> {
  const hasCmake = fs.existsSync(path.join(workspaceRoot, 'CMakeLists.txt'));
  const message = hasCmake
    ? 'Perf Lens: compile_commands.json not found. ' +
      'Add set(CMAKE_EXPORT_COMPILE_COMMANDS ON) to your CMakeLists.txt and rebuild.'
    : 'Perf Lens: compile_commands.json not found. ' +
      'Generate it with CMake (CMAKE_EXPORT_COMPILE_COMMANDS=ON) or Bear to enable analysis.';

  void vscode.window.showWarningMessage(message);
}
