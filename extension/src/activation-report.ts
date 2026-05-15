/**
 * Activation status report — tracks success/failure of each step during
 * `activate()` so we can surface a clear summary at the end.
 *
 * Without this, a half-broken install (e.g. hooks failed to write, auditor
 * auth never persisted) leaves the user with no visible signal that
 * something is wrong — they only find out hours later when an action that
 * should have been blocked goes through, or when audit doesn't run.
 *
 * The report is rendered as:
 *   - one-line summary toast when everything succeeded:
 *       "AXME Code ready: ✓ MCP  ✓ Hooks  ✓ Auth (claude)  ✓ KB (33 dec, 6 mems)"
 *   - notification with [Show output] button when ANY step failed:
 *       "AXME Code: partial install — Hooks ✗ (see output)"
 *
 * Each step records (kind, ok, detail). The summary is built when
 * activation completes.
 */

import * as vscode from "vscode";
import { show as showOutput } from "./log.js";

export type StepKind = "mcp" | "hooks" | "auth" | "setup" | "binary";

interface Step {
  kind: StepKind;
  ok: boolean;
  detail: string;
}

const LABELS: Record<StepKind, string> = {
  binary: "Binary",
  mcp: "MCP",
  hooks: "Hooks",
  auth: "Auth",
  setup: "KB",
};

export class ActivationReport {
  private readonly steps: Step[] = [];

  record(kind: StepKind, ok: boolean, detail: string): void {
    this.steps.push({ kind, ok, detail });
  }

  /** Render success/failure summary as a single line. */
  summary(): string {
    return this.steps
      .map((s) => `${s.ok ? "✓" : "✗"} ${LABELS[s.kind]}${s.detail ? ` (${s.detail})` : ""}`)
      .join("  ");
  }

  hasFailure(): boolean {
    return this.steps.some((s) => !s.ok);
  }

  failedSteps(): Step[] {
    return this.steps.filter((s) => !s.ok);
  }

  /**
   * Show the result to the user. Non-modal in both branches. Success path
   * is dismissed automatically after VS Code's notification timeout; failure
   * path has a "Show output" button so the user can inspect the AXME Code
   * channel for the actual error.
   */
  async present(): Promise<void> {
    const text = this.summary();
    if (!this.hasFailure()) {
      // Success — short info notification.
      void vscode.window.showInformationMessage(`AXME Code ready: ${text}`);
      return;
    }
    const failedNames = this.failedSteps().map((s) => LABELS[s.kind]).join(", ");
    const choice = await vscode.window.showWarningMessage(
      `AXME Code: partial install — ${failedNames} ${this.failedSteps().length === 1 ? "failed" : "failed"}. ${text}`,
      "Show output",
      "Dismiss",
    );
    if (choice === "Show output") showOutput();
  }
}
