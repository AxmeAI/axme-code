import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { paginateSections, DEFAULT_PAGE_CHAR_LIMIT } from "../src/utils/pagination.js";

describe("paginateSections", () => {
  it("returns all content in one page when under limit", () => {
    const sections = ["Section A", "Section B", "Section C"];
    const result = paginateSections(sections, 1, "test_tool", {});
    assert.equal(result.page, 1);
    assert.equal(result.totalPages, 1);
    assert.ok(result.text.includes("Section A"));
    assert.ok(result.text.includes("Section C"));
    assert.ok(!result.text.includes("Page"));
  });

  it("splits content into pages when over limit", () => {
    const bigSection = "x".repeat(15_000);
    const sections = [
      "# Header\n" + bigSection,
      "# Middle\n" + bigSection,
      "# Footer\n" + bigSection,
    ];
    const p1 = paginateSections(sections, 1, "my_tool", { project_path: "/test" }, 20_000);
    assert.equal(p1.page, 1);
    assert.ok(p1.totalPages > 1, `expected >1 pages, got ${p1.totalPages}`);
    assert.ok(p1.text.includes("# Header"));
    assert.ok(p1.text.includes("call `my_tool`"));
    assert.ok(p1.text.includes("page: 2"));

    const p2 = paginateSections(sections, 2, "my_tool", { project_path: "/test" }, 20_000);
    assert.equal(p2.page, 2);
    assert.ok(p2.text.includes("# Middle") || p2.text.includes("# Footer"));
  });

  it("clamps page number to valid range", () => {
    const sections = ["A", "B"];
    const result = paginateSections(sections, 99, "t", {});
    assert.equal(result.page, 1); // everything fits in 1 page
    assert.equal(result.totalPages, 1);
  });

  it("clamps page 0 to 1", () => {
    const sections = ["A"];
    const result = paginateSections(sections, 0, "t", {});
    assert.equal(result.page, 1);
  });

  it("last page shows 'all content loaded'", () => {
    const bigSection = "x".repeat(15_000);
    const sections = [bigSection, bigSection];
    const p1 = paginateSections(sections, 1, "t", {}, 16_000);
    assert.ok(p1.totalPages === 2);
    const p2 = paginateSections(sections, 2, "t", {}, 16_000);
    assert.ok(p2.text.includes("all content loaded"));
  });

  it("preserves tool args in pagination instruction", () => {
    const bigSection = "x".repeat(15_000);
    const sections = [bigSection, bigSection, bigSection];
    const result = paginateSections(sections, 1, "axme_oracle", { project_path: "/my/repo" }, 16_000);
    assert.ok(result.text.includes("axme_oracle"));
    assert.ok(result.text.includes("/my/repo"));
  });

  it("single oversized section still gets returned", () => {
    const huge = "x".repeat(50_000);
    const result = paginateSections([huge], 1, "t", {}, 20_000);
    assert.equal(result.totalPages, 1);
    assert.equal(result.page, 1);
    assert.ok(result.text.length >= 50_000);
  });

  it("uses DEFAULT_PAGE_CHAR_LIMIT when no limit specified", () => {
    assert.equal(DEFAULT_PAGE_CHAR_LIMIT, 25_000);
    const small = "test";
    const result = paginateSections([small], 1, "t", {});
    assert.equal(result.totalPages, 1);
  });
});
