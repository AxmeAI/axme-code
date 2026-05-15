/**
 * Mocha-compatible test loader for the activation suite.
 *
 * @vscode/test-electron expects a single `run()` entry that wires up a
 * Mocha instance, registers test files, and resolves when they finish.
 * We keep the suite tiny — only assertions that prove the extension
 * activates cleanly on the host platform and registers everything its
 * package.json claims.
 */

import Mocha from "mocha";
import { glob } from "glob";
import * as path from "node:path";

export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: "bdd", color: true, timeout: 20_000 });
  const testsRoot = path.resolve(__dirname);

  const files = await glob("**/*.test.js", { cwd: testsRoot });
  for (const f of files) mocha.addFile(path.resolve(testsRoot, f));

  await new Promise<void>((resolve, reject) => {
    try {
      mocha.run((failures) => {
        if (failures > 0) reject(new Error(`${failures} test(s) failed`));
        else resolve();
      });
    } catch (err) {
      reject(err as Error);
    }
  });
}
