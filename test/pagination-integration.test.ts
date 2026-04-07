import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { paginateSections } from "../src/utils/pagination.js";
import { getOracleSections } from "../src/storage/oracle.js";
import { getDecisionSections } from "../src/storage/decisions.js";
import { getMemorySections } from "../src/storage/memory.js";
import { getFullContextSections } from "../src/tools/context.js";

const WORKSPACE = "/home/georgeb/axme-workspace";
const AXME_CODE = "/home/georgeb/axme-workspace/axme-code";
const CONTROL_PLANE = "/home/georgeb/axme-workspace/axme-control-plane";

describe("pagination integration with real data", () => {
  it("workspace oracle paginates correctly", () => {
    const sections = getOracleSections(WORKSPACE);
    assert.ok(sections.length > 0, "should have oracle sections");
    const totalChars = sections.reduce((s, sec) => s + sec.length, 0);
    console.log(`  workspace oracle: ${sections.length} sections, ${totalChars} chars`);

    const p1 = paginateSections(sections, 1, "axme_oracle", {});
    console.log(`  page 1/${p1.totalPages}: ${p1.text.length} chars`);
    if (p1.totalPages > 1) {
      assert.ok(p1.text.includes("page: 2"), "should have next-page instruction");
      const p2 = paginateSections(sections, 2, "axme_oracle", {});
      console.log(`  page 2/${p2.totalPages}: ${p2.text.length} chars`);
    }
  });

  it("axme-code decisions paginates correctly (largest: 114KB)", () => {
    const sections = getDecisionSections(AXME_CODE);
    assert.ok(sections.length > 0, "should have decisions");
    const totalChars = sections.reduce((s, sec) => s + sec.length, 0);
    console.log(`  axme-code decisions: ${sections.length} items, ${totalChars} chars`);

    // Walk all pages
    let page = 1;
    let allContent = "";
    while (true) {
      const result = paginateSections(sections, page, "axme_decisions", { project_path: AXME_CODE });
      console.log(`  page ${result.page}/${result.totalPages}: ${result.text.length} chars`);
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

  it("workspace context paginates correctly", () => {
    const sections = getFullContextSections(WORKSPACE);
    const totalChars = sections.reduce((s, sec) => s + sec.length, 0);
    console.log(`  workspace context: ${sections.length} sections, ${totalChars} chars`);

    const p1 = paginateSections(sections, 1, "axme_context", { workspace_path: WORKSPACE });
    console.log(`  page 1/${p1.totalPages}: ${p1.text.length} chars`);
    // First page should always have storage root header
    assert.ok(p1.text.includes("AXME Storage Root"), "first page must include storage root");
    // First page should always have safety rules
    assert.ok(p1.text.includes("Safety Rules") || p1.text.includes("Safety"), "first page should include safety");
  });

  it("control-plane oracle paginates correctly", () => {
    const sections = getOracleSections(CONTROL_PLANE);
    const totalChars = sections.reduce((s, sec) => s + sec.length, 0);
    console.log(`  control-plane oracle: ${sections.length} sections, ${totalChars} chars`);

    const p1 = paginateSections(sections, 1, "axme_oracle", { project_path: CONTROL_PLANE });
    console.log(`  page 1/${p1.totalPages}: ${p1.text.length} chars`);
    assert.ok(p1.text.length <= 30_000, `page 1 too large: ${p1.text.length}`);
  });

  it("no data loss across pages", () => {
    const sections = getDecisionSections(WORKSPACE);
    const totalChars = sections.reduce((s, sec) => s + sec.length, 0);
    console.log(`  workspace decisions: ${sections.length} items, ${totalChars} chars`);

    // Collect all pages
    let page = 1;
    const pageTexts: string[] = [];
    while (true) {
      const result = paginateSections(sections, page, "axme_decisions", {});
      pageTexts.push(result.text);
      if (result.page >= result.totalPages) break;
      page++;
    }
    console.log(`  ${pageTexts.length} total pages`);

    // Every section should appear in exactly one page
    for (const sec of sections) {
      const found = pageTexts.filter(pt => pt.includes(sec));
      assert.equal(found.length, 1, `section should appear in exactly 1 page: ${sec.slice(0, 60)}`);
    }
  });
});
