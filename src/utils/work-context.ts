/**
 * WorkContext resolution - determines workspace + project scope.
 *
 * Simple model: no walk-up, no auto-detection.
 * - Workspace = only if cwd contains a workspace manifest
 * - Single project = fallback
 */

import { resolve } from "node:path";
import { detectWorkspace } from "./workspace-detector.js";
import type { WorkContext } from "../types.js";

/**
 * Resolve WorkContext from cwd.
 * No walk-up. Scope = where you launched.
 */
export function resolveWorkContext(cwd: string): WorkContext {
  const absPath = resolve(cwd);
  const ws = detectWorkspace(absPath);

  if (ws.type !== "single") {
    return { workspacePath: absPath, projectPath: absPath, workspace: ws };
  }

  return { workspacePath: null, projectPath: absPath, workspace: null };
}
