# Release Checklist

**Read this end-to-end before starting any release-prep PR.** It exists because the same items keep getting missed across releases — example versions in error messages, the test count in the README badge, hidden version references in workflow files, the lockfile drift after a manual `package.json` edit. Treat every item as required unless explicitly noted otherwise.

The instructions assume you are an agent working with axme-code conventions: D-047 (feature branch naming), D-117 (no amend on pushed branches), D-023 (humans merge PRs), D-024 (humans tag releases), D-110/D-113 (`#!axme` gate suffix on every git commit/push).

---

## 0. Pre-flight — before opening the release-prep PR

- [ ] Read this file end-to-end. No skimming.
- [ ] Confirm `git status` is clean and current branch is up-to-date with `origin/main`.
- [ ] Re-run `npm test` on a fresh build. **Record the exact pass count** — you will need it for the README badge below.
- [ ] List the PRs that will ship in this release (`git log --oneline <last-tag>..main`). Group them by Added / Fixed / Changed / Removed for the CHANGELOG.

## 1. Pick the version

- [ ] **Decide the bump** (major / minor / patch / skip-version) and capture the rationale in one sentence — that sentence becomes the first paragraph of the CHANGELOG entry.
- [ ] Per D-046 we are SemVer 0.x.y during alpha — breaking changes are allowed in minor bumps. You can also skip versions (we did 0.2.9 → 0.5.0); record the reason if so.

## 2. Create the branch

- [ ] Branch from a fresh `main`: `git checkout main && git pull --ff-only && git checkout -b release/v<X.Y.Z>-<YYYYMMDD>`.

## 3. Bump every version reference (the bit that keeps getting missed)

These are the **six** places that hold a literal `X.Y.Z` string. Update **all of them** before continuing:

- [ ] `package.json` — `"version"` field
- [ ] `.claude-plugin/plugin.json` — `"version"` field
- [ ] `templates/plugin-README.md` — `version-X.Y.Z-blue` shields.io badge URL
- [ ] `README.md` — `tests-NNN%20passing` shields.io badge (use the **exact** pass count from step 0)
- [ ] `install.ps1` — the example version in the `throw 'Could not determine version. ... e.g. install.ps1 vX.Y.Z'` line
- [ ] `package-lock.json` — sync via `npm install --package-lock-only` (do NOT hand-edit; npm has to recompute the dependency closure)

After bumping, run two greps and confirm they both return **only** expected matches:

```bash
# 1. Should return zero hits in source/config (CHANGELOG history hits are fine)
grep -rn "<old-version>" --include="*.json" --include="*.ts" --include="*.mjs" \
   --include="*.yml" --include="*.yaml" --include="*.sh" --include="*.ps1" \
   | grep -v "node_modules\|dist/\|CHANGELOG\|.axme-code\|/.git/"

# 2. Should return six matches (the six places above) all = <new-version>
grep -rn "<new-version>" --include="*.json" --include="*.ts" --include="*.md" \
   --include="*.ps1" | grep -v "node_modules\|dist/\|.axme-code\|/.git/"
```

If grep #1 turns up *any* hit you don't recognise, stop and fix it. There has been a stale version literal hiding in some non-obvious file every release.

## 4. CHANGELOG entry

- [ ] Add a `## [X.Y.Z] - YYYY-MM-DD` section at the **top** of `CHANGELOG.md` (newest first).
- [ ] One-paragraph summary tying together the release theme — what the user gains, why it shipped now, any combined-release rationale (e.g. "skips 0.3.0 / 0.4.0 because we batched Windows + B-005").
- [ ] Sub-sections in order: `### Added`, `### Fixed`, `### Changed`, `### Removed`, `### Known requirement` (if any). Skip empty sections.
- [ ] **Cross-reference every PR** that ships in this release inline (`(#NNN)`). Reviewers should be able to map a CHANGELOG bullet back to a PR without `git log`-archaeology.
- [ ] If the release introduces a non-obvious user-side requirement (e.g. VC++ Redistributable on Windows, a new env var, a manual config flip), surface it under `### Known requirement` with the install URL or command so it's discoverable from the changelog alone.

## 5. Verify the build will actually ship

- [ ] `npx tsc --noEmit` — clean.
- [ ] `npm run build` — clean.
- [ ] `npm test` — every test passes; pass count matches the README badge.
- [ ] Inspect `dist/plugin/.claude-plugin/plugin.json` — confirm it shows the new version (esbuild reads from package.json at build time via `__VERSION__`).
- [ ] `node dist/axme-code.js --version` — confirm it prints the new version.
- [ ] Sanity-check the release workflow trigger: `.github/workflows/release-binary.yml` should fire on `push.tags: ['v*']`. Confirm the matrix still has all 6 platforms (linux-x64, linux-arm64, darwin-x64, darwin-arm64, windows-x64, windows-arm64).

## 6. Open the release-prep PR

- [ ] Commit with `release: v<X.Y.Z> — <one-line theme>` and `#!axme pr=none repo=<owner/repo>` suffix.
- [ ] Push the branch (regular push to a new branch — never force-push a branch with an open PR per D-117).
- [ ] Open the PR. Body must include: the CHANGELOG-paragraph summary, the file-by-file bump list, what's verified locally, and the **post-merge tag command for the user** (because per D-024 the agent never tags).
- [ ] Wait for the 3-OS CI matrix to go green. Do **not** ask for merge approval before that.

## 7. After CI is green — get human approval

- [ ] Surface the green-CI status to the user with the PR URL.
- [ ] Wait for the user to merge — D-023 forbids the agent merging PRs.
- [ ] Once merged, hand the user the **exact** tag commands (do NOT run them — D-024):
  ```bash
  git checkout main && git pull --ff-only
  git tag v<X.Y.Z>
  git push --tags
  ```

## 8. Watch `release-binary.yml`

The workflow has 4 chained jobs (`build → release → publish-npm → sync-plugin-repo`). Watch each:

- [ ] **build** — 6 jobs, one per matrix target. Each produces `axme-code-<platform>` (~2.4 MB self-contained Node bundle).
- [ ] **release** — `softprops/action-gh-release@v2` creates the GitHub Release for `vX.Y.Z` with `generate_release_notes: true`. Confirm the page shows 6 attached assets.
- [ ] **publish-npm** — `npm publish --access public` with `NODE_AUTH_TOKEN` from `secrets.NPM_TOKEN`. Confirm `@axme/code@X.Y.Z` is live on npmjs.org.
- [ ] **sync-plugin-repo** — clones `AxmeAI/axme-code-plugin`, wipes everything except `.git`/`.gitignore`, copies `dist/plugin/*` (and `.mcp.json` + `.claude-plugin/`), strips sourcemaps + `node_modules`, commits with `sync: v<X.Y.Z> from axme-code`. Confirm the plugin repo's latest commit is from `github-actions` and `plugin.json` shows the new version.

If any job fails, stop and triage **before** announcing the release. A half-published release (binaries up but npm publish failed, or npm up but plugin repo not synced) confuses every install path the next time someone runs `install.sh`/`install.ps1` or `claude plugin install`.

## 9. Smoke-test the published release on a fresh dir

- [ ] `mkdir /tmp/axme-release-smoke-$$ && cd /tmp/axme-release-smoke-$$ && git init -q && touch package.json README.md`
- [ ] On Linux/macOS: `curl -fsSL https://raw.githubusercontent.com/AxmeAI/axme-code/main/install.sh | bash` — confirm it downloads `vX.Y.Z`, places `~/.local/bin/axme-code`, and `axme-code --version` prints `X.Y.Z`.
- [ ] On Windows (Azure VM, deallocate when done): `irm https://raw.githubusercontent.com/AxmeAI/axme-code/main/install.ps1 | iex` — confirm it downloads `vX.Y.Z`, places `%LOCALAPPDATA%\Programs\axme-code\axme-code.js` + `.cmd` shim, and version prints correctly.
- [ ] Plugin install path: `claude plugin install axme-code@claude-community` — confirm the new version is what gets pulled (the marketplace caches; may need to wait 5-10 min for Anthropic's index to refresh).

## 10. Announcement & cleanup

- [ ] Run `axme_social_bot.py` once if appropriate. Verify stdout shows `LinkedIn link-comment posted: ...` (was silent 404 before the URN percent-encoding fix).
- [ ] Close any deferred backlog items that this release resolved.
- [ ] Delete the merged release branch locally and on origin (the branch is finished; the tag is the immutable reference now).
- [ ] Deallocate any Azure VMs you started for E2E (`az vm deallocate -g axme-test -n axme-win11` and check `az vm list -d --query "[?powerState!='VM deallocated'].{name:name}"`).

---

## Common things that have gone wrong before

- **Forgot to bump the lockfile** (v0.2.9 release-prep, PR #111). `package.json` was 0.2.9 but `package-lock.json` stayed on 0.2.8 because manual edits don't re-run npm. Always finish version bumps with `npm install --package-lock-only`.
- **Forgot to update an example version in an error string** (`install.ps1`, this v0.5.0 release-prep). Cosmetic but visible to every user who hits the error path. Grep for the old version with no source-file filter and audit each hit.
- **Released without verifying the npm publish step had a token** (early v0.2.7 attempts). `secrets.NPM_TOKEN` must be configured in repo settings; check `npm whoami` on the publish runner if a publish silently no-ops.
- **Released without verifying plugin repo synced** — always open `https://github.com/AxmeAI/axme-code-plugin` after the workflow finishes and confirm the latest commit is `sync: vX.Y.Z from axme-code` from `github-actions`. Workflows have failed silently on the sync step before due to the `PLUGIN_REPO_TOKEN` not having `contents: write` on the target repo.
- **Skipped CHANGELOG entry until after the tag** (one early version). Once a tag is pushed, the CHANGELOG is hard to update without confusing users; D-128 makes it a required step before bumping `package.json`.

When you finish a release, write any new "things that went wrong" to this section so the next agent sees them.
