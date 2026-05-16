import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { logger } from '../util/logger';

export interface ProjectConfig {
  version: 1;
  project?: {
    name?: string;
    language_standard?: 'c++14' | 'c++17' | 'c++20' | 'c++23';
  };
  build?: {
    compile_commands?: string;
    release_variant?: string;
  };
  rules?: {
    enabled?: string[];
    disabled?: string[];
    thresholds?: Record<string, number>;
  };
  suppressions?: Array<{
    file?: string;
    rules?: string[];
    line_marker?: string;
  }>;
  llm?: {
    share_cache?: boolean;
    cache_file?: string;
  };
  profiling?: {
    default_profiler?: 'perf' | 'vtune' | 'instruments' | 'uprof' | 'samply';
    benchmarks?: Array<{
      name: string;
      command: string;
      events?: string[];
    }>;
  };
  hot_paths?: string[];
}

const CONFIG_FILENAME = '.perf-lens.yaml';

function validate(data: unknown): data is ProjectConfig {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (obj['version'] !== 1) {
    logger.warn('.perf-lens.yaml: unsupported version (expected 1)');
    return false;
  }
  return true;
}

export function loadProjectConfig(workspaceRoot: string): ProjectConfig | undefined {
  const configPath = path.join(workspaceRoot, CONFIG_FILENAME);
  if (!fs.existsSync(configPath)) {
    logger.debug('.perf-lens.yaml not found — using defaults');
    return undefined;
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = yaml.load(raw);
    if (!validate(parsed)) {
      logger.warn('.perf-lens.yaml is invalid — using defaults');
      return undefined;
    }
    logger.info(`.perf-lens.yaml loaded from ${configPath}`);
    return parsed;
  } catch (err) {
    logger.error('.perf-lens.yaml parse error:', (err as Error).message);
    return undefined;
  }
}
