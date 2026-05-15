/**
 * Headless extension-host test entry point.
 *
 * Spawns VS Code (or any compatible electron build) in CI-friendly mode,
 * loads our extension from disk, and runs the activation smoke suite in
 * extension/test/suite/. The runner picks the right vscode-test binary
 * per platform automatically — runs on ubuntu / macos / windows alike.
 *
 * Cursor itself is closed-source and has no headless test mode, so this
 * suite uses upstream VS Code as the host. The contract: anything that
 * works on stock vscode.* APIs (commands, contributions, views, walk-
 * throughs) works in our suite. Cursor-specific APIs (vscode.cursor.mcp.*)
 * are NOT exercised here — they are gated by IDE detection in our
 * extension code and the relevant code path is skipped under VS Code,
 * which is exactly what we test for.
 */

import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  try {
    // extensionDevelopmentPath must be the directory containing the
    // extension's package.json. After TS compile our entry point lives
    // at out-test/runTest.js — so one `..` goes from out-test/ up to
    // extension/, which is where the package.json sits.
    const extensionDevelopmentPath = path.resolve(__dirname, "..");
    // Compiled test entrypoint — picks up our suite/* files.
    const extensionTestsPath = path.resolve(__dirname, "suite", "index");

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      // Pin to a VS Code version that's stable with this
      // @vscode/test-electron release. The "stable" channel currently
      // resolves to 1.120 whose launcher's argument parsing rejects
      // every flag vscode-test-electron passes — pinning to 1.96 (our
      // declared engines minimum) bypasses that regression and runs
      // the same version users actually have.
      version: "1.96.0",
    });
  } catch (err) {
    console.error("Failed to run extension tests:", err);
    process.exit(1);
  }
}

void main();
