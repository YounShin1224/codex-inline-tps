# Privacy and security

## Native sidebar plugin

The separate `plugins/codex-tps` implementation uses a local stdio MCP server and an MCP Apps thread entrypoint. It does not connect to Electron's debugger, inject DOM into Codex, open an HTTP listener, change model/proxy configuration, or make external API requests. The UI and dependencies are bundled; its CSP declares no external connection or resource domains.

Only UUIDs and an optional model ID are accepted for metrics reads, never paths. Session discovery stays under `CODEX_HOME` (or `~/.codex`) sessions and archived_sessions, does not follow directory/file symlinks, and returns only IDs and modification timestamps. The parser transiently reads local JSONL but retains only numeric metadata and identifiers; conversation bodies, titles, credentials and tool arguments are not sent to the panel. The native entrypoint never substitutes the latest active chat for an unbound panel. Selection stays in each panel instance, and stale in-flight replies are ignored after a selection changes.

Automatic refresh uses app-only read tools, not model sampling or model-context updates. Closing or pausing the panel stops polling. Treat this as a local desktop plugin: do not expose its server through a remote bridge or publish user session files. The source package requires a build; the prepared distribution contains runtime dependencies and their notices.

The following debugger and control-endpoint notes apply to the independent input-box implementation.

## Data access

The helper reads the selected local chat's uncompressed Codex JSONL session file. The parser receives each JSON record in memory, but retains only thread/model identifiers, token counts, timing intervals and tool-call IDs. It does not save conversation text, drafts, tool arguments or authentication files.

The injected component reads the window's route and model-picker labels, then adds its own status row. Its host binding accepts only thread IDs, model labels and mount status. It does not send editor contents to the helper.

## Network and local controls

There are no external API, analytics, telemetry or update requests. The HTTP and WebSocket connections are directed to the local Electron debugging endpoint on `127.0.0.1`; WebSocket endpoints outside loopback are refused. The component does not change Codex's model provider or proxy configuration. Normal Codex traffic is handled by Codex itself.

The control named pipe requires a randomly generated local secret before returning status, diagnostics or accepting a stop command. The secret is stored in `.runtime/control-token` and is excluded from Git. On Windows it inherits the parent directory's access controls; store the checkout in a directory accessible only to trusted users.

Electron's debugger can inspect and control the app's renderer. It is a sensitive local interface even though it listens on loopback. Other software running with access to the same machine may be able to reach that interface. Use this component only on a trusted machine. Stopping the helper removes the status row but does not close Electron's debugging port; exit Codex and reopen through its original launcher to close the port.

## Files excluded from publication

The Git allowlist includes reviewed source, synthetic tests and documentation only. `.runtime/`, connection metadata, logs, local control secrets, `.env` files, databases and generated screenshots are not published. Tests use synthetic chat IDs and counters, not exported conversations.

Local diagnostics may include model/thread identifiers and operating-system error paths. Keep them private or redact them before attaching to an issue. Do not upload `.codex/auth.json`, session logs, debugging endpoint files or control secrets.

## Reporting

For a security concern, open an issue with a redacted description of the problem. Do not attach live credentials, private conversations or an active local debugging URL. This is an independent experimental project, not an official OpenAI extension.
