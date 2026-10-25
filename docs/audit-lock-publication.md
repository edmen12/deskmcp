# Audit lock publication and recovery

The audit writer uses the shared PID directory lock before every append and
rotation. An invalid owner document blocks tool execution rather than allowing
unaudited work. HTTP health and tool discovery alone do not validate this path.

## Windows publication

The Node owner and release/reclaim transition documents are written into unique
sibling `.init-<pid>-<token>` directories before publication. Windows directory
rename publishes the complete directory and refuses to replace an existing
destination, including an empty directory. This matches the Control Panel's
existing C# publication protocol and keeps schema version 1 interoperable.

Termination before publication may leave an unused prepared sibling, but does
not occupy the canonical lock or transition. Termination after publication
leaves a valid PID owner, which the existing stale-owner protocol can inspect.
An already-published abandoned transition still fails closed; this change does
not weaken that safety boundary. Leftover prepared siblings from an abrupt
termination are not automatically deleted while other writers are active.

POSIX keeps exclusive `mkdir` publication because ordinary POSIX directory
rename can replace an empty destination owned by an initializing older writer.
The Windows crash-window fix must not be claimed as a POSIX fix.

## Existing invalid lock

Do not treat missing or malformed ownership as a dead-PID lease. Coordinate
writers, stop the owning Gateway through its local control channel using the
same Windows privilege level, and confirm the old process has exited. Verify
the exact invalid directory identity and absence of a transition again, then
archive it outside the canonical lock path. Preserve existing audit logs.
Allow the established supervisor to restart the Gateway without replacing its
profile, configuration, credentials, or installed package.

Verify a real read-only MCP call, paired start/finish records with the same
request ID, normal lock release, and tunnel readiness. Keep operational recovery
separate from deployment of a newly built publication fix.
