import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir, homedir as realHomedir } from "node:os";
import { join } from "node:path";

import { loadAuditorMode, saveAuditorMode, auditorModePath } from "../src/utils/auditor-mode.js";

/**
 * The auditor-mode helper reads/writes a single-line file at
 * `~/.config/axme-code/auditor-mode`. We swap $HOME for each test to a
 * tmpdir so we don't trample the developer's real config.
 */
describe("auditor-mode", () => {
  let tmpHome: string;
  const realHome = process.env.HOME;
  const realUser = process.env.USERPROFILE;

  before(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "axme-amode-"));
  });
  after(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    if (realHome !== undefined) process.env.HOME = realHome; else delete process.env.HOME;
    if (realUser !== undefined) process.env.USERPROFILE = realUser; else delete process.env.USERPROFILE;
  });
  afterEach(() => {
    // Each test redirects HOME → tmpHome; the helper resolves paths
    // lazily via os.homedir(), which reads HOME on Linux/Mac and
    // USERPROFILE on Windows. We set BOTH to keep the suite portable.
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    try { rmSync(join(tmpHome, ".config"), { recursive: true }); } catch { /* fine */ }
  });

  it("defaults to background when no file exists", () => {
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    assert.equal(existsSync(auditorModePath()), false);
    assert.equal(loadAuditorMode(), "background");
  });

  it("round-trips each valid mode", () => {
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    for (const mode of ["cooperative", "background"] as const) {
      saveAuditorMode(mode);
      assert.equal(loadAuditorMode(), mode);
    }
  });

  it("ignores an unknown / corrupted value and reports background", () => {
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    saveAuditorMode("cooperative");
    // Corrupt the file directly — simulates the user (or a bad upgrade)
    // writing garbage into the config. saveAuditorMode just wrote the
    // parent dir, so writeFileSync here lands safely.
    writeFileSync(auditorModePath(), "totally-invalid\n", "utf-8");
    assert.equal(loadAuditorMode(), "background");
  });

  it("tolerates whitespace and trailing newline", () => {
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    const p = auditorModePath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "  cooperative  \n", "utf-8");
    assert.equal(loadAuditorMode(), "cooperative");
  });
});
