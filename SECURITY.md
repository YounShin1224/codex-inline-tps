# Privacy and security

## Data access

The helper reads the selected local chat's uncompressed Codex JSONL session file. The parser receives each JSON record in memory, but retains only thread/model identifiers, token counts, timing intervals and tool-call IDs. It does not save conversation text, drafts, tool arguments or authentication files.

The injected component reads the window's route and model-picker labels, then adds its own status row. Its host binding accepts only thread IDs, model labels and mount status. It does not send editor contents to the helper.

## Network and local controls

There are no external API, analytics, telemetry or update requests. The HTTP and WebSocket connections are directed to the local Electron debugging endpoint on `127.0.0.1`; WebSocket endpoints outside loopback are refused. The component does not change Codex's model provider or proxy configuration. Normal Codex traffic is handled by Codex itself.

The control endpoint (Windows named pipe, macOS Unix socket) requires a randomly generated local secret before returning status, diagnostics or accepting a stop command. The secret is stored in `.runtime/control-token` and is excluded from Git. On macOS `.runtime/` and the per-user, per-checkout socket directory under `/tmp/codex-inline-tps-<uid>-<hash>/` have mode `0700`, and the secret has mode `0600`. The short socket path avoids Darwin's 104-byte socket-path limit. Only the startup-lock owner removes a stale socket; another live helper is not displaced. On Windows files inherit the parent directory's access controls; store the checkout in a directory accessible only to trusted users.

The macOS launcher validates the application's `com.openai.codex` bundle ID and reads the declared executable name from its Info.plist. It checks exact main-process executable paths, never process-name substrings, and waits for the user to quit normally instead of terminating an active app. It runs the existing executable with loopback debugging arguments without modifying the signed bundle or installing a login item/LaunchAgent. `CODEX_TPS_APP` / `--app` may select a nonstandard installation; the same bundle-ID validation applies.

Electron's debugger can inspect and control the app's renderer. It is a sensitive local interface even though it listens on loopback. Other software running with access to the same machine may be able to reach that interface. Use this component only on a trusted machine. Stopping the helper removes the status row but does not close Electron's debugging port; exit Codex and reopen through its original launcher to close the port.

## Files excluded from publication

The Git allowlist includes reviewed source, synthetic tests and documentation only. `.runtime/`, connection metadata, logs, local control secrets, `.env` files, databases and generated screenshots are not published. Tests use synthetic chat IDs and counters, not exported conversations.

Local diagnostics may include model/thread identifiers and operating-system error paths. Keep them private or redact them before attaching to an issue. Do not upload `.codex/auth.json`, session logs, debugging endpoint files or control secrets.

## Reporting

For a security concern, open an issue with a redacted description of the problem. Do not attach live credentials, private conversations or an active local debugging URL. This is an independent experimental project, not an official OpenAI extension.
