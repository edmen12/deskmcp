# DeskMCP consolidation — 2026-10-25

**Scope:** consolidate historical DeskMCP experiments into the existing `C:\Users\User\Desktop\DeskMCP` Git repository and its local `main`; retire redundant Git worktrees, not the installed application.

## Verified code and safety gates

- Exact local development baseline: `main@102148aedbf119b255a259d7f19809719d7d715d` before this report.
- Fresh unified build and quick regression: `npm run test:fast` **342 / 342 PASS**.
- Windows native builds: `DeskMCP.AgentDesktopHost.csproj` and `DeskMCP.ControlPanel.csproj` **PASS, 0 warning / 0 error**.
- Reproducible native stage: clean local source needed explicit .NET project restore. `scripts/stage-real-d2-native-candidate.mjs` now restores packages before build/publish, makes a **self-contained single-file ProcessHost**, validates an actual hidden Job-hosted CLI smoke, and runs **5/5 native negative-security tests**. The resulting package is test-only and has `releaseApproved=false`.
- Real local Windows Win+Tab Desktop2 E2E from unified main: `test-area/desktop2-real-acceptance/runs/native-owned-mcp-job-2026-10-25T03-51-01-130Z/result.json` reports `pass=true`, real HTTP owner-token MCP, independent OS foreground observer, owned Job process lineage, Edit/TextChanged 1, Button/Click 1, ListBox `TopIndex=20`, replay denied, `desktopBefore=1` and `desktopAfter=1`, `appFocusEvents=[]`, owned children and observer exited, MCP client/server closed. This proves the **owned WinForms fixture only**, not general third-party Chrome/WPF/WinUI/Electron production compatibility. The HUD lease was explicitly stopped and Desktop2 returned `Free`.

## Merges, decisions and preserved history

1. The current-base real-D2 staged implementation was fast-forwarded from `feat/real-d2-currentbase-integration-20261024` into `main`. Existing real VDA native observer, read-only inventory, strict owned-input bridge, owner-only MCP gate and tests were retained. The normal production `/mcp` cannot expose the experimental mutation tool by environment flags alone.
2. Ego Lite `review/ego-lite-session-gate-20261022` merged as `a4f2b19`. Five file conflicts were resolved **in favor of the newer main security boundaries** for Win32 Desktop Object action dispatch, post-dispatch audit uncertainty and HTTP owner route; browser cross-tool human handoff protections were preserved. WPF top-level HUD opacity is held stable across desktop moves; signed artifact downloads must drain before granting human takeover.
3. Chrome/no-focus experiment `6fe8d92` was selectively absorbed as `77b718f`: CDP no-focus helper, third-party test scripts, evidence and documentation. **Do not enable** the legacy visible Chrome launcher: real Desktop 1 foreground/focus and third-party safety are not completely verified. The branch is archived, not falsely treated as release-ready.
4. Previous old-base real-D2 candidate `8c7d87a` contains native exploratory code (`BackgroundWindowInput.cs`, hidden Chrome/Winver probes, `desktop2-clipboard.ts`, `desktop2-handoff.ts` etc.) not wholesale copied into main because it could revert stronger modern safety checks. Its history is retained by `consolidation/final-legacy-owned-20261025`.
5. The previously detached 0.9.5 release edits were committed on the historical archive branch before removal, and preserved by `consolidation/final-release-detached-20261025`. Other final-head tags are `consolidation/final-currentbase-20261025`, `consolidation/final-native-20261025`, `consolidation/final-ego-20261025` and `consolidation/final-release-cu-20261025`.

**Workspace cleanup:** all old DeskMCP Git worktrees, including release 0.9.5 snapshots, ComputerUse-Core, Ego Lite and two real-D2 staging trees were removed. `git worktree list` reports only `C:\Users\User\Desktop\DeskMCP` at `main`; 7 obsolete local branch names were deleted only after verifying that each exact tip is reachable from main or a named consolidation tag.

Legacy physical test logs are retained privately in ignored local zip archives:

- `test-area/desktop2-real-acceptance/runs/consolidated-legacy-evidence/real-d2-currentbase.zip`: 92 text/JSON records; SHA256 `b94942d6d5caaa110ecf572807876a0a90e4da11c48f2b73fb923dfa5553bd97`.
- `test-area/desktop2-real-acceptance/runs/consolidated-legacy-evidence/d2-native-acceptance.zip`: 190 records; SHA256 `ef6ea438245112acefa8725d9879ae411f92dd432052195027f40d4bb61a0f94`.
- Large old derived build binaries and duplicate native Stage files intentionally were **not copied**. Current unified Stage is reproducible from source. Deleted old worktrees are not proof of deletion of historical Git commits; the archived Git tags retain them.

## Remaining RED blockers, not part of consolidation acceptance

- Bearer authorization must still bind exact trusted HUD lease, allocation generation, desktop GUID and owned Job identity; cross-client separation and expiry/disconnect/crash/HUD Exit cleanup ordering need full state-machine implementation and acceptance.
- Long-duration soak, cross-desktop/foreground focus proof, Windows Job OS membership query, third-party WPF/WinUI/Electron/Chrome application tests, signed install/upgrade/rollback verification remain outstanding.
- The installed production DeskMCP binary remains `c2ad782290a7bad780764d34aa79add54863f944`; no install, update, gateway restart or Desktop 1 takeover occurred during consolidation.
- The older **non-Git** `DeskMCP-Prepared-Upgrade-20261020` contains a rollback snapshot and installer; this is a protected release artifact, *not* a duplicate source worktree. Evaluate its retention independently of Git cleanup before erasure.

**Important:** local commits and archival tags are not automatically evidence that `origin/main` was pushed or that any CI/GitHub Pages deployment passed. Treat remote synchronization and any automatic website publication as a separate observed event.
