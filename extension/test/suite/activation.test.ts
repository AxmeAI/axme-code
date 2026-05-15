/**
 * Activation smoke tests — run inside the VS Code extension host on
 * every platform's CI runner via @vscode/test-electron.
 *
 * Goals:
 *   - Extension activates without throwing on this platform.
 *   - All commands declared in package.json are registered.
 *   - Walkthrough is contributed.
 *   - View container "axme" is contributed.
 *
 * We do NOT test Cursor-specific behavior (cursor.mcp.registerServer,
 * Cursor's chat API). The runner is upstream VS Code; Cursor APIs are
 * absent there. Our extension's ide-detect.ts returns "vscode" and the
 * activation bails out early with a friendly message — that's a valid
 * code path we want to confirm doesn't crash.
 */

import * as assert from "node:assert/strict";
import * as vscode from "vscode";

const EXT_ID = "AxmeAI.axme-code";

// Commands declared in package.json "contributes.commands". Kept in sync
// manually — if you add a new command in package.json, add it here too.
const DECLARED_COMMANDS = [
  "axme.setup",
  "axme.openDashboard",
  "axme.reindex",
  "axme.showStatus",
  "axme.showStatusText",
  "axme.reauthAuditor",
  "axme.reset",
  "axme.selfTest",
  "axme.auditKb",
  "axme.showStats",
  "axme.cleanup",
  "axme.showLastHandoff",
  "axme.showWorklog",
  "axme.showAuditLog",
  "axme.showTestPlan",
  "axme.showDeployStaging",
  "axme.showDeployProd",
  "axme.showFilesChanged",
  "axme.enableSemanticSearch",
  "axme.disableSemanticSearch",
];

describe("AXME Code extension — activation suite", () => {
  it("is installed", () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `Extension ${EXT_ID} not found in extensions registry`);
  });

  it("activates without throwing", async function () {
    this.timeout(15_000);
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext);
    if (!ext.isActive) await ext.activate();
    assert.equal(ext.isActive, true);
  });

  it("registers all declared commands", async () => {
    const all = await vscode.commands.getCommands(true);
    const missing = DECLARED_COMMANDS.filter((c) => !all.includes(c));
    assert.deepEqual(missing, [], `Missing commands: ${missing.join(", ")}`);
  });

  it("contributes the axme view container", () => {
    // No public API to enumerate viewsContainers, but we can verify the
    // workbench command that opens it exists.
    return vscode.commands.getCommands(true).then((all) => {
      assert.ok(
        all.includes("workbench.view.extension.axme"),
        "Activity Bar container 'axme' not contributed",
      );
    });
  });
});
