import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paginateSections } from "../src/utils/pagination.js";
import { getOracleSections } from "../src/storage/oracle.js";
import { getDecisionSections } from "../src/storage/decisions.js";
import { getFullContextSections } from "../src/tools/context.js";

const TEST_ROOT = "/tmp/axme-pagination-integration-test";
const PROJECT = join(TEST_ROOT, "project");

function setupProject() {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  const axme = join(PROJECT, ".axme-code");
  mkdirSync(join(axme, "oracle"), { recursive: true });
  mkdirSync(join(axme, "decisions"), { recursive: true });
  mkdirSync(join(axme, "memory", "feedback"), { recursive: true });
  mkdirSync(join(axme, "memory", "patterns"), { recursive: true });
  mkdirSync(join(axme, "safety"), { recursive: true });
  mkdirSync(join(axme, "sessions"), { recursive: true });

  writeFileSync(join(axme, "oracle", "stack.md"), "# Stack\n\nNode.js 20, TypeScript 5.9, ESM modules.\n\nesbuild for bundling.\n");
  writeFileSync(join(axme, "oracle", "structure.md"), "# Structure\n\nsrc/ — main source\ntest/ — tests\ndist/ — build output\n");
  writeFileSync(join(axme, "oracle", "patterns.md"), "# Patterns\n\nCamelCase functions, PascalCase types.\n");
  writeFileSync(join(axme, "oracle", "glossary.md"), "# Glossary\n\nMCP = Model Context Protocol\nOracle = Project knowledge base\n");
  writeFileSync(join(axme, "config.yaml"), "model: claude-sonnet-4-6\npresets:\n  - essential-safety\n");
  writeFileSync(join(axme, "safety", "rules.yaml"), `git:\n  protectedBranches: [main]\n  allowDirectPushToMain: false\n  allowForcePush: false\nbash:\n  deniedPrefixes:\n    - "rm -rf /"\n  allowedPrefixes: []\nfilesystem:\n  deniedPaths: []\n  readOnlyPaths: []\n`);

  // Create enough decisions for pagination (>30KB total)
  writeFileSync(join(axme, "decisions", "index.md"), "# Decisions\n");
  for (let i = 1; i <= 30; i++) {
    const id = `D-${String(i).padStart(3, "0")}`;
    const slug = `test-decision-${i}`;
    const body = `This is decision ${i}. `.repeat(50); // ~1KB each
    writeFileSync(join(axme, "decisions", `${id}-${slug}.md`), `---\nid: ${id}\nslug: ${slug}\ntitle: Test decision ${i}\nenforce: required\nstatus: active\ndate: "2026-04-01"\nsource: manual\n---\n${body}\n`);
  }
}

beforeEach(() => setupProject());
afterEach(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

describe("pagination integration with real data", () => {
  it("oracle paginates correctly", () => {
    const sections = getOracleSections(PROJECT);
    assert.ok(sections.length > 0, "should have oracle sections");

    const p1 = paginateSections(sections, 1, "axme_oracle", {});
    assert.ok(p1.text.length > 0, "page 1 should have content");
  });

  it("decisions paginate correctly with many items", () => {
    const sections = getDecisionSections(PROJECT);
    assert.ok(sections.length >= 30, "should have 30+ decisions");

    // Walk all pages
    let page = 1;
    let allContent = "";
    while (true) {
      const result = paginateSections(sections, page, "axme_decisions", { project_path: PROJECT });
      assert.ok(result.text.length <= 30_000, `page ${page} too large: ${result.text.length}`);
      allContent += result.text;
      if (result.page >= result.totalPages) break;
      page++;
    }
    // All decisions should be present across pages
    for (const sec of sections) {
      const snippet = sec.slice(0, 50);
      assert.ok(allContent.includes(snippet), `missing: ${snippet}`);
    }
  });

  it("context includes safety in first page", () => {
    const sections = getFullContextSections(PROJECT);
    assert.ok(sections.length > 0);

    const p1 = paginateSections(sections, 1, "axme_context", {});
    assert.ok(p1.text.includes("AXME Storage Root"), "first page must include storage root");
    assert.ok(
      p1.text.includes("Safety") || p1.text.includes("Protected branches") || p1.text.includes("Load Full Knowledge Base"),
      "first page should include safety or KB load instruction"
    );
  });

  it("no data loss across pages", () => {
    const sections = getDecisionSections(PROJECT);
    assert.ok(sections.length > 0);

    let page = 1;
    const pageTexts: string[] = [];
    while (true) {
      const result = paginateSections(sections, page, "axme_decisions", {});
      pageTexts.push(result.text);
      if (result.page >= result.totalPages) break;
      page++;
    }

    for (const sec of sections) {
      const found = pageTexts.filter(pt => pt.includes(sec));
      assert.equal(found.length, 1, `section should appear in exactly 1 page: ${sec.slice(0, 60)}`);
    }
  });
});
