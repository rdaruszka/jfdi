# The Harness Abstraction

Agents run as headless subprocesses of a coding-agent CLI. Everything
provider-specific — flags, JSON stream formats, session resumption, hook
injection — lives behind one interface, so pipeline logic never touches it.
This is a hard invariant, and it is what makes "add a provider" a contained,
mechanical task.

Source: [src/harness/types.ts](../../src/harness/types.ts) (the interface),
[claude.ts](../../src/harness/claude.ts), [codex.ts](../../src/harness/codex.ts)
(the implementations), and [index.ts](../../src/harness/index.ts) (selection).
The test-only `FakeHarness` lives in
[src/test-helpers.ts](../../src/test-helpers.ts), which production builds exclude.

## The interface

```ts
interface Harness {
  spawn(prompt: string, options: SpawnOptions): HarnessSession;
  spawnInteractive(prompt: string, options: InteractiveSpawnOptions): Promise<number>;
}

interface SpawnOptions {
  cwd: string;                 // the ticket's worktree
  logPath?: string;            // raw provider output appended here (jfdi logs)
  continueSessionId?: string;  // continue an earlier session (see below)
}

interface HarnessSession {
  events: AsyncIterable<HarnessEvent>;  // live progress stream
  done: Promise<HarnessResult>;         // never rejects; failures are ok: false
  kill(): void;                         // SIGTERM, then SIGKILL after 5s
}

type HarnessEvent =
  | { type: "text";    text: string }
  | { type: "tool";    name: string; detail?: string }
  | { type: "result";  ok: boolean; text: string; failure?: HarnessFailure };

interface HarnessResult {
  ok: boolean; text: string;
  sessionId?: string;
  failure?: HarnessFailure;   // set only when the provider failed, not the agent
}

type HarnessFailure =
  | { kind: "usage-limit"; resetsAtMs: number | null; detail: string }
  | { kind: "needs-human";  detail: string }   // login, key, billing
  | { kind: "outage";       detail: string };  // 5xx, network, capacity
```

Contracts worth knowing:

- **`done` never rejects.** Session failures are data (`ok: false` with the
  failure text), not exceptions — a dead subprocess must not take down the
  coordinator.
- **A failure the provider caused is classified here, not upstream.** Each
  implementation reads its own provider's stream and message text and reports
  the neutral `HarnessFailure` above; the pipeline then holds and re-runs the
  stage instead of feeding the death back as a round. See
  [Failure classification](#failure-classification).
- **Sessions report a `sessionId`** the pipeline stores to continue the
  conversation in a later round. **Providers forget sessions**; callers must
  treat a failed continuation as "fall back to one fresh spawn with the full
  prompt," and the pipeline does exactly that.
- **Provider stream lines are untrusted.** A line that doesn't parse into a
  known event shape is simply not an event; raw output still lands in the log
  file for `jfdi logs`.
- `spawnInteractive` hands the terminal to the provider (used by `jfdi init`)
  and resolves with its exit code. The prompt is the first user message, so the
  agent acts first by surveying the repository.

## Provider implementations

### Claude Code

Headless spawn:

```
claude -p <prompt> --output-format stream-json --verbose
       --permission-mode <auto|bypassPermissions>
       [--model <model>] [--effort <effort>]  # from the stage's selection
       [--resume <sessionId>]                 # continuation
       [--settings <cwd>/.jfdi/claude-settings.json]   # when the file exists
```

- Parses the `stream-json` line protocol: assistant text and `tool_use` blocks
  become `text`/`tool` events (with the full human-readable detail — file path,
  command, pattern; renderers own any truncation); the `system:init` line and
  the final `result` line carry the session id (a continued session gets a
  *fresh* id — last one wins); the `result` line becomes the `result` event.
- **The settings injection is the provider-specific acceleration**: when
  `.jfdi/claude-settings.json` exists it is passed via `--settings`, wiring a
  PostToolUse hook that formats each edited file
  ([details](../guide/prompts-and-customization.md#the-format-hook)).
- Effort levels: `low`, `medium`, `high`, `xhigh`, `max` (`CLAUDE_EFFORT_LEVELS`).
- Interactive: `claude --permission-mode <auto|bypassPermissions> [--model …]
  [--effort …] <prompt>`.

### Codex

Headless spawn:

```
codex exec --json <permission-args> \
     [--model <model>] [-c model_reasoning_effort=<effort>] <prompt>
codex exec resume --json <permission-args> \
     [--model …] [-c …] <threadId> <prompt>   # continuation; flags precede the positionals
```

- Parses the Codex JSON event protocol: `thread.started` carries the thread id
  (the continuation handle), `agent_message` items become `text` events,
  command/MCP/web-search items become `tool` events, and `turn.failed` becomes
  a failure result. Bare `{"type":"error"}` events are **not** terminal —
  Codex emits them for retries it goes on to survive (`Reconnecting… 2/5: …`)
  with no field to tell those apart from fatal ones.
- Codex emits no terminal success line, so the harness synthesizes the `result`
  event from the last agent message on a clean exit.
- No hook system → no settings injection. The format-hook acceleration is
  simply absent: degraded, not broken.
- Effort has no flag — it is a config override, and Codex validates nothing
  locally: it forwards the value to the API, which answers an unknown one with a
  400 mid-session. `CODEX_EFFORT_LEVELS` (`none`, `minimal`, `low`, `medium`,
  `high`, `xhigh`, `max`) is what turns that into a config error at startup.
- Interactive: `codex <permission-args> [--model …] [-c …] <prompt>`.

Both implementations share the same shape deliberately: line-by-line stdout
parsing mirrored to the log file, a rolling stderr tail for diagnostics when the
result line never arrives, exit code 127 on a missing executable, and the same
kill semantics. They are near-duplicates by design — the duplication keeps each
provider's quirks local instead of leaking into a shared "provider-generic"
layer that wouldn't be.

### Permissions

The instance-wide `permissions.mode` selects one of two unattended policies;
the default is `auto`, while `bypass` is an explicit opt-in:

| JFDI mode | Claude Code (headless) | Claude Code (interactive) | Codex permission args |
|---|---|---|---|
| `auto` | `--permission-mode acceptEdits --allowedTools Bash` | `--permission-mode auto` | `-c sandbox_mode="workspace-write" -c sandbox_workspace_write.network_access=true` |
| `bypass` | `--permission-mode bypassPermissions` | `--permission-mode bypassPermissions` | `--dangerously-bypass-approvals-and-sandbox` |

Claude's own `auto` mode is interactive-only — headless, its classifier has no
human to escalate to and denies every write, worktree included — so the auto
policy maps per spawn form: headless and continued sessions run `acceptEdits`
with the Bash tool allowed, interactive launches keep `auto`.

Codex network access is enabled under `workspace-write` so a headless session
can fetch and resolve packages without weakening the worktree filesystem
boundary. The sandbox is spelled as a `-c sandbox_mode=` override, not the
equivalent `--sandbox` flag, because `codex exec resume` rejects `--sandbox`
while every Codex spawn form accepts `-c`.

Both `auto` policies confine writes to the session's workspace. Anything the
pipeline needs an agent to produce must therefore live inside the worktree —
which is why verdict files are written at the worktree root and collected into
the state directory by the pipeline afterward (see the pipeline guide's
Verdicts section), rather than granted per-provider write exceptions. JFDI deliberately does not use Codex's deprecated `--full-auto`
compatibility path. Interactive launches use the same permission mode as
pipeline sessions. The neutral config value is passed separately from a
stage's harness/model/effort selection, and each harness owns its provider
mapping; pipeline code never sees these flags. A legacy `harnessArgs` config key
is explicitly rejected.

### The fake harness

Tests use `FakeHarness`: a constructor-injected handler plays the agent
in-process, performing real side effects (writing files, dropping verdict
files) and recording every call for assertions on prompts and continuation ids. It is not reachable from config — tests construct it
directly. End-to-end tests that exercise real spawning use stub `claude`/`codex`
scripts on `PATH` instead.

## Failure classification

A session can die because the agent got stuck, or because the provider under it
is down — a usage limit, an expired login, a 5xx. Those need opposite
treatments: the first is feedback for another round, the second must stop the
tool ([Pause and resume](#pause-and-resume-in-one-line)). Neither CLI helps:
both exit `1` for everything, so the class has to be read out of the stream and
the message text.

That reading is **provider-specific and therefore lives in each harness**. The
pipeline only ever sees `HarnessFailure`, and an unclassified failure keeps the
old behavior exactly — it becomes a feedback round.

Both implementations use the same shape: an ordered pattern table, matched
case-insensitively, most specific first, easy to extend. The strings were
verified against Claude Code v2.1.220 and Codex 0.146.0 in Aug 2026 and are
**version-volatile by nature** — when a provider rewords a message, add a row.

| | Claude Code | Codex |
|---|---|---|
| where the fatal text is | the `result` line — an API failure arrives as `subtype: "success"` with `is_error: true`; `subtype: "error_*"` is a *task* failure | `turn.failed`'s `error.message`, or the stderr `Error:` line when no events arrived |
| usage-limit | `You've hit your <session\|weekly\|Opus\|Sonnet> limit`, `usage limit reached` | `You've hit your usage limit`, `out of credits`, `spend cap`, `Quota exceeded` |
| reset time | only as local 12-hour clock prose (`resets 3:45pm`), plus the legacy `…usage limit reached\|<epoch-seconds>` | only as local 12-hour clock prose (`Try again at 3:45 PM.`); `Try again later.` carries none |
| needs-human | `run /login`, `not logged in`, `invalid api key`, `oauth token expired/revoked`, `could not be refreshed`, `authentication`, `Credit balance is too low` | `could not be refreshed`, `status 401`, `codex login`, `no Codex credentials` |
| outage | `api_error_status` 500/529, or `unable to connect`, `connection error`, `ECONN`, `ETIMEDOUT`, `ENOTFOUND`, `timed out`, `overloaded` | `exceeded retry limit`, `stream disconnected`, `Connection failed`, `request timed out`, `Error while reading the server response`, `high demand`, `at capacity`; **also** any session that exits without emitting `thread.started` (the detached-TTY regression, openai/codex#19945) |

Reset times are parsed by [reset-time.ts](../../src/harness/reset-time.ts),
shared because reading a clock out of English is not provider-specific. It
accepts only the observed 12-hour clock form (with a parenthesized timezone
stripped because it cannot be honoured). Everything else yields `null`, and a
`resetsAtMs: null` usage limit waits on the outage backoff instead — a limit
self-expires, so it never demands a human. Reading a time *early* is safe too:
the retry fails, is classified again, and re-pauses on the fresh string.

## Pause and resume, in one line

Classification is the harness's whole share of this. What happens next — the
tool-wide hold, the backoff schedules, the auto-resume, the `R` keypress — is
[the pause controller](../guide/pipeline.md#when-the-provider-goes-down)'s, and
it is provider-neutral.

## Selection

Selection is **per stage**. `config.stages.<stage>` names a harness and,
optionally, a provider-native model and effort
([schema](../guide/configuration.md#stages)); `createSessionHarnesses` in
[src/harness/index.ts](../../src/harness/index.ts) builds one instance per entry
at context construction, and `PipelineContext.harnesses` holds all five. There
is no global harness and no instance-wide harness — the entries routinely
disagree, and the scaffolded default deliberately reviews on a different
provider than it implements on.

Five, not four: the fifth is `commit-message`, the
[scribe](../guide/pipeline.md#commits-and-the-scribe). It is not a stage — no
verdict, no round, no sign-off — but it spawns a session, so it needs a
selection, and `stages` is where selections live. `SessionKind` in
[src/harness/types.ts](../../src/harness/types.ts) is the union that says so.

Constructors take the selection and the separate permission mode
(`new ClaudeHarness({ sessionKind, model, effort }, permissionMode)`), and each
implementation maps both to its own CLI's spelling; `SpawnOptions` is unchanged,
so pipeline logic never sees a model name or permission flag. An absent model or
effort passes no flag at all. `sessionKind` rides along purely as provenance: a
spawn that fails names the `stages` entry that selected the missing binary.

Fixing the harness per stage is also what keeps continuations honest — a session
id is only meaningful to the harness that minted it, and a stage always
re-enters its own. Interactive init is not a stage and selects its harness,
model, and effort directly from command-line flags; only the instance-wide
permission mode comes from config.

Each implementation declares the effort values its CLI accepts in a table beside
the flag mapping it feeds; `EFFORT_LEVELS_BY_HARNESS` gathers them for
`parseConfig`, which rejects an unaccepted `(harness, effort)` pair at load.

## Adding a provider

1. Extend the `HarnessName` union in
   [src/harness/types.ts](../../src/harness/types.ts) (and the validation
   message in `parseSessionConfig`).
2. Implement `Harness` in `src/harness/<name>.ts`: map the provider's headless
   JSON output to `HarnessEvent`s, map `HarnessSelection` to the CLI's model and
   effort flags (and export the effort levels it accepts), report a
   session/thread id for continuation, implement `spawnInteractive`, honor
   `logPath`, never reject `done`.
3. Add the case to `createHarness`, the effort table to
   `EFFORT_LEVELS_BY_HARNESS`, and the export, in `src/harness/index.ts`.
4. Keep provider-specific accelerations inside the new file; their absence in
   other providers must degrade gracefully, and their presence must not leak
   into pipeline logic.
