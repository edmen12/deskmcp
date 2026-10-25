# DeskMCP — retired 22 completed Alpha AI evaluation sessions

Date: 2026-10-23, Asia/Kuala_Lumpur.
Scope: completed legacy Alpha AI evaluation ProcessHost sessions launched on 2026-10-20 under `C:\Users\User\Desktop\model_v2\AQP_Lab`.
Purpose: free process capacity without age-based termination or touching unfinished, unrelated or live-service sessions.

## Exact verified cleanup

Each target was validated BEFORE termination using the original encoded ProcessHost command, host PID and creation timestamp, its specific report directory and run ID, final status fields and job/case counts, and its exact sole owned Node child. The one-time script had two modes; dry-run returned READY=22, SKIPPED=0. In apply mode it rechecked original PID, image, creation time and Node child immediately before terminating that verified process tree.

| Group | Original ProcessHost PIDs | Verified cleared |
|---|---|---:|
| Delivery benchmark | 18132 | 1 |
| Alpha Script Delivery | 14444, 12576, 31944, 32676, 16480, 27580, 18724, 30412 | 8 |
| Frontier finished runs | 32564, 27380, 11524 | 3 |
| Tool Judgment | 35168, 28988, 36528, 36108 | 4 |
| Action Judgment | 35372, 31380, 34728, 42212, 9960, 25748 | 6 |
| **Total** | | **22** |

Every targeted tree reported `taskkill /PID <verified host PID> /T /F` exit=0 and subsequent Host absence. Audit log has exactly 22 `CLOSE=...|exit=0|gone=True` records and zero skipped. It is kept at `runtime/retire-completed-evals-20261023.log` (locally ignored by git). The one-time hardcoded-PID script was removed after verifying the audit, preventing accidental reuse or PID-recycling risk.

**Not touched:** Frontier Host PID 29228 with report `incomplete=true` and `error=TOTAL_TOKEN_BUDGET_REACHED`; staging frontend (port 3339 was still listening); Supabase migrations; Desktop runner; two `rg` sessions; unrelated recent work.

Immediately after cleanup, `DeskMCP.ProcessHost.exe` count was 8 **including the inspection command's own host**, leaving about 7 preexisting sessions. A later independent check confirmed all 22 original host PIDs absent; all five evaluation report-category counts unchanged (1 Delivery; 8 Alpha Script; 4 Frontier; 14 Tool Judgment; 9 Action Judgment).

## Root cause and future protection

Alpha AI's evaluation scripts previously completed report artifacts yet left Node/Codex process trees running. The new application-level cleanup was committed independently in AQP Lab as `0fc66627`, with a real two-level Windows process-tree test (9/9 PASS). Newly started benchmarks now close their owned client on success/failure; old processes required this separate verified one-time retirement.

DeskMCP candidate `f8aecfe` includes `desktop_process_capacity` and process-registry terminal-state hardening (Fast 181/181 and Browser 87/87), **not yet installed in production**. The existing 32-session limit remains unchanged; capacity was reclaimed by retiring verified complete runs, not by increasing the quota or killing arbitrary long sessions.

Safety boundaries: no official DeskMCP restart/install, no production `main` merge, no test reports deleted, no unfinished Frontier interruption. The unrelated WPF Coordinator worktree modifications remain untouched.
