# DOSBox-X Debugger Client

`lib/dosbox-debugger.js` is the generic, serialized host client for the patched
DOSBox-X control server. The MCP/debugger protocol does not require a CLI;
`bin/dosbox-debugger.js` is an optional thin argument adapter for shell and CI
use. It has no game-specific paths or defaults. Every
session acquires the `dosbox-debugger` advisory host lease and verifies the
live `IDENTITY` response against `patches/dosbox-x/manifest.json` before
sending a debugger command.

```bash
node bin/dosbox-debugger.js status
node bin/dosbox-debugger.js registers
node bin/dosbox-debugger.js step 1
node bin/dosbox-debugger.js run-until 1234:00005678
node bin/dosbox-debugger.js batch ./commands.json
```

Use `--host`, `--port`, `--timeout`, `--max-response-bytes`, and
`--lease-dir` to override the bounded transport and lease settings. Batch files
are JSON arrays containing 1–8 non-resuming debugger commands. Decimal length
frames make embedded spaces unambiguous; nested batches, mutation, and
control-flow verbs are rejected.

The server can retain an ordinary debugger request for up to 30 seconds.
`DebuggerSession` therefore uses a host timeout of at least 35 seconds and
stops its same-session queue after any transport rejection. `WAIT N` uses at
least `N+5000ms` and is capped at 295 seconds so host settlement remains within
the 300-second transport ceiling. A transport failure still makes the command's
effect uncertain; replace or reset the disposable emulator before treating a
later observation as pristine evidence.

Before every checked debugger command, the client durably creates
`.dosbox-debugger-host-command.inflight` with the exact content
`uncertain-debugger-command-v1\n`. It removes the marker only after a settled,
well-formed response. Transport failure, malformed response,
`ERR PAUSE_TIMEOUT`, `ERR COMMAND_TIMEOUT`, or `ERR BUSY` retains it and blocks
later checked sessions. After externally resetting or replacing the disposable
emulator, clear that host state explicitly:

```bash
node bin/dosbox-debugger.js reset --confirm-emulator-reset
```

The confirmation does not reset the emulator and cannot make manipulated
evidence pristine; it only records that the caller performed that external
recovery before clearing the retained marker under the same host lease.

## Library API

```js
const { withDebuggerSession } = require('./lib/dosbox-debugger');

await withDebuggerSession({}, async debuggerSession => {
  console.log(await debuggerSession.status());
  console.log(await debuggerSession.registers());
});
```

`DebuggerSession` also exposes `restoreCheckpoint(name)`,
`verifyDeterminism()`, `replayInput()`, `step(count)`, `runUntil(address)`,
`determinismStatus()`, and `inputStatus()` for higher-level replay tools.
The CLI additionally covers selector and memory inspection, disassembly,
stack, snapshot, checkpoint, input, determinism, coverage, stop, file-I/O, and
API-trace command families. `raw` remains available for new non-mutation
grammar; it rejects nested batches and mutation.

## Unsafe mutation

Mutation requires both a printable audit reason and the final confirmation
token. The intent record is appended and synced before the command is sent.
Success is reported only when the emulator response contains matching `AFTER`
and `READBACK` values; success or failure is then appended and synced.

```bash
node bin/dosbox-debugger.js mutate register AX 2A \
  --reason 'reproduce register-dependent fault' \
  --confirm-manipulated-oracle
```

The default audit is `share/_MAGIC_/dosbox-debugger-mutations.jsonl`; override
it with `--audit-log` or `DOSBOX_DEBUG_AUDIT_LOG`. A successfully mutated emulator is permanently
manipulated evidence for that session. The loopback endpoint and host lease are
not authentication, so do not forward the port and do not use an untrusted
shared directory. `DosboxControl.debug()` is deliberately a raw transport and
the socket accepts commands from any local process; neither can enforce this
audited path. These safeguards apply to cooperating callers of
`DebuggerSession` and its optional CLI.

Run the source-only test without launching an emulator:

```bash
node scripts/test-dosbox-debugger.js
```

## Reverse-step helper

`bin/dosbox-reverse.js step CHECKPOINT COUNT` is an optional thin adapter over
this session API. It restores a named checkpoint, arms determinism and input
replay, and advances in `STEP` chunks of at most 10,000 until the exact earlier
instruction sequence is reached. It requires final `MODE=VERIFY`, `FAILED=0`,
`ACTIVE=1`, and `SKIPPED=0` receipts.

It accepts the same `--host`, `--port`, `--timeout`, `--max-response-bytes`,
`--lease-dir`, `--lease-timeout`, and `--poll-ms` session options before
`step`; no VM or checkpoint path is hard-coded.

This is checkpoint restoration plus verified forward replay, not native reverse
execution. Reverse-continue is intentionally absent because `RUN UNTIL` has no
maximum-sequence ceiling and could stop at a later occurrence of an address.
