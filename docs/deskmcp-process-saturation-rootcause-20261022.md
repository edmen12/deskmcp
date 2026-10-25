# DeskMCP 32-session saturation: actual Windows process inventory and upstream cause
2026-10-22 MYT. Candidate workspace: review/ego-lite-session-gate-20261022. Read-only production investigation, no process termination.

## Confirmed inventory / provenance
Windows process tree inspection found around 29 longstanding DeskMCP.ProcessHost sessions in C:\Users\User\Desktop\model_v2, plus newly created diagnostic sessions (live number fluctuates). Original 29 breakdown:
Alpha AI delivery benchmark: Host PID 18132 (1).
Alpha Script delivery: Host PIDs 14444,12576,31944,32676,16480,27580,18724,30412 (8).
Alpha AI frontier: Host PIDs 29228,32564,27380,11524 (4).
Alpha AI tool judgment: Host PIDs 35168,28988,36528,36108 (4).
Alpha AI action judgment: Host PIDs 35372,31380,34728,42212,9960,25748 (6).
These total 23 Alpha AI Benchmark/Judgment processes.
One Supabase migration: Host PID 20024.
Two rg one-shot searches: Host PID 38312 (Decision API) and PID 37188 (Website).
AQP Staging frontend on port 3339: Host PID 31008.
AQP staging desktop: Host PID 42020.
Another preview or website launcher was observed, with one instance exiting during investigation. Counts change with new work; do not infer this inventory is constant.

## Task progress: stronger than duration/CPU heuristics
ProcessHost -> PowerShell -> node.exe/rg.exe process trees still existed. Every Alpha AI node.exe examined was accompanied by its own child codex.exe and further descendant codex.exe, i.e. the Codex app-server lifetime is directly relevant.
3-second CPU delta was 0 for 29 task processes, and all sampled rg.exe remained single-thread waiting with Executive reason. CPU inactivity does NOT establish process death; nor did thread inspection prove Windows process suspension.
Report cross-check under AQP_Lab/lab/workflow_store/alpha_ai_evals:
- alpha_script_delivery: 8/8 files, incomplete=false (last written 2026-10-20 10:46:59 MYT).
- frontier_ab: 4 files, three incomplete=false, ONE incomplete=true (last written 2026-10-20 11:30:46 MYT).
- tool_judgment_20: 14 reports, incomplete=false (some later runs not part of original four); original four created on 2026-10-20 11:43–11:47 MYT have persisted complete files.
- action_judgment: 9 reports, complete=true; original six corresponding to 2026-10-20 12:06–12:13 MYT persisted complete.
- delivery_benchmark: one final report written 2026-10-20 09:24:32 MYT; lacks a uniform incomplete flag, so treat as report-output-complete rather than schema-proven complete.
Thus 22 of 23 original Alpha AI tasks have terminal-completion-report evidence, while one Frontier run is explicitly incomplete. Those processes were still alive around 2026-10-22 18:45 MYT.

## Actual root-cause evidence (not generic timeout)
DeskMCP's process-host/Program.cs uses WaitForMultipleObjects(childProcessHandle, parentHandle) with INFINITE and a KILL_ON_JOB_CLOSE Windows job. It correctly holds the session while its root command is STILL alive, even after an app's report.json says complete. Session age isn't the core issue.
Four evaluation scripts construct a CodexAppServerEvalClient and do not guarantee await client.close() in finally:
- run-alpha-ai-delivery-benchmark.mts
- run-alpha-script-delivery-benchmark.mts
- run-alpha-ai-frontier-benchmark.mts
- run-alpha-ai-action-judgment.mts
The tool judgment script DOES call client.close() in finally, yet four original tool-judgment Nodes also persisted; therefore missing finally alone is not the whole explanation.
CodexAppServerEvalClient.start() spawns codex.exe app-server --stdio and subscribes to readline/stdout; close() ends stdin, waits up to 1500 ms and child.kill()s only the direct child, without verified Windows process-tree teardown or explicit readline closure. Real process trees have codex -> codex grandchildren. The precise single blocking handle was not determined, but application-level Codex cleanup is demonstrably incomplete.
Both rg one-shot searches remain running after >1 day even though they should naturally terminate. They had a single thread waiting with Executive reason and no CPU delta in the brief observation. Whether an I/O pipe, filesystem operation or other external dependency is the blocker remains UNVERIFIED. Do not claim a precise rg cause.

## Candidate DeskMCP correction
- src/process-session-registry.ts gained a read-only capacityStatus() aggregate, with active, starting, free, completed retained and age BUCKETS. These are diagnostics, never auto-expiration/kill triggers.
- reconcileActivePids now treats inactive status as terminal so a stale backend listing or PID reuse cannot revive a finished capability.
- src/process-tools.ts adds desktop_process_capacity, a read-only tool that reports in-memory Gateway capacity without spawning a ProcessHost, even if the process limit is full. It exposes no raw PIDs, borrowed session capabilities, command strings or secrets. Does NOT claim whether tasks are healthy.
- tests/runtime-state.test.ts validates capacity and that 48h-old sessions remain active unless explicitly marked complete.
- Candidate typecheck PASS; Fast tests 181/181 PASS; Browser tests 87/87 PASS (including capacity tool handoff quarantine). Production has NOT been upgraded; the new tool is not in the installed Gateway yet.

## Follow-up technical changes, NOT YET APPLIED to AQP Lab
1. Add try/finally await client.close() to every model evaluation script, including all error branches; ensure close releases ALL subprocess pipe handles and Windows descendant processes, with explicit post-close verification.
2. Add benchmark run/owner/phase, progress checkpoint and report-based done markers. Do not infer inactivity from CPU=0 or age.
3. Capture rg process wait chain/IO handles and bound fileset before declaring why the searches hang; add a safe bounded search/pipeline teardown where appropriate.
4. After verifying completed artifacts and process ownership, request explicit operator approval before ending preexisting work; DO NOT blindly kill old jobs or increase quota to hide leaks.

Security: Investigative commands were read-only, no processes were terminated, no production install/restart or main merge/push. This candidate cannot retroactively release installed Gateway sessions.