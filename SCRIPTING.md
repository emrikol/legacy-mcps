# Scripting with win-auto.js

A Node.js library for automating Windows 3.x applications running inside DOSBox-X. Inspired by [Playwright](https://playwright.dev/) — async/await API, auto-waiting, fluent method chaining.

## Quick Start

```js
const { withWinAutoSession } = require('./lib/win-auto');

await withWinAutoSession({ magicDir: './share/_MAGIC_' }, async win => {
  // Launch Notepad, type text, select all, copy to clipboard
  const notepad = await win.exec('NOTEPAD.EXE');
  const edit = await notepad.locator('Edit');
  await edit.type('Hello from 2026!');
  await edit.selectAll();
  await edit.copy();

  // Verify clipboard
  const text = await win.getClipboard();
  console.log(text);

  await win.capture(notepad);
  await notepad.close();
});
```

## Setup

```bash
# Prerequisites: DOSBox-X running Windows 3.1 with WINMCP.EXE active
# The share/_MAGIC_ directory must be accessible to both host and guest

const { WinAuto } = require('../lib/win-auto');

const win = new WinAuto({
  magicDir: '../share/_MAGIC_',  // Path to IPC directory
  pollMs: 150,                    // Polling interval (default 150ms)
  timeout: 10000,                 // Default command timeout (default 10s)
});

await win.waitForReady();  // Blocks until WINMCP.EXE signals READY
```

For multi-command automation, prefer `withWinAutoSession`. It holds one
advisory cross-process lease, waits for the exact `READY` marker, verifies
`META IDENTITY` against this checkout's source contract, and releases the
lease after the callback. The lease serializes only clients that honor it; it
is not authentication and it does not make several guest commands atomic.

## Optional host CLI adapter

The MCP and `WinAuto` library do not require a CLI. `bin/winmcp.js` is a thin
argument parser for interactive debugging, shell scripts, and CI; it exposes
the same controller without application-specific defaults and contains no
second automation implementation:

```bash
node bin/winmcp.js status
node bin/winmcp.js windows
node bin/winmcp.js exec --wait-for Calculator -- CALC.EXE
node bin/winmcp.js exec --no-wait -- NOTEPAD.EXE README.TXT
node bin/winmcp.js task info PROGMAN
node bin/winmcp.js module segments KERNEL
node bin/winmcp.js memory read 1234:00000000 16
node bin/winmcp.js window locator-id 1234 100
node bin/winmcp.js sequence examples/win-sequences/health-check.json
```

`exec` requires exactly one explicit launch policy:

```text
exec --no-wait -- PROGRAM [ARG...]
exec --wait-for TITLE -- PROGRAM [ARG...]
```

The CLI joins the individual program tokens with spaces, validates the
resulting bounded printable command, and sends it directly to WINMCP. It does
not use a host shell. `--wait-for` waits for a window whose title contains
`TITLE`; `--no-wait` returns after the guest accepts the launch request.

Use `memory write-unsafe ... --confirm-unsafe-memory-write` only in a
disposable session. A write attempt sets the in-process `manipulated` state
before dispatch because verification or audit failure may still leave changed
guest state. The guest appends its own verified audit receipt on success. The
generic CLI rejects this command through its raw-send and sequence routes.
Regardless of the command result, the guest session is permanently manipulated
for evidence purposes. Clearing an uncertain-command marker does not make that
session pristine again.

Sequence files are JSON arrays of 1–256 literal printable command strings,
each at most 511 ASCII bytes, matching WINMCP's command buffer. Commands run
serially under one host lease and fail on the first `ERR` by default.
`--continue-on-error` changes only host
iteration. A sequence is not a guest transaction: Windows may run between
mailbox commands.

The equally optional `bin/dosmcp.js` uses the same bounded transport and
source-identity preflight:

```bash
node bin/dosmcp.js identity
node bin/dosmcp.js send -- SYS INFO
```

DOSMCP commands are limited to 255 printable ASCII bytes, matching the guest's
command buffer.

The mailbox has no authentication. These clients deliberately expose all
debugger-readable data, including password-styled control text. The advisory
lease serializes cooperating host clients only.

Before publishing a request, the transport writes
`.winmcp-host-command.inflight` or `.dosmcp-host-command.inflight` with the
versioned content `uncertain-command-v1\n`. It removes the marker only after it
has consumed and cleaned up the matching response. A timeout or interrupted
client therefore makes later processes fail closed instead of assigning a late
response to a new command.

After externally replacing or resetting the disposable guest, clear the
retained marker with the corresponding explicit operation:

```bash
node bin/winmcp.js reset --confirm-guest-reset
node bin/dosmcp.js reset --confirm-guest-reset
```

The command does not reset the guest. It holds the same advisory lease and
refuses to clear the marker while a response or unconsumed request remains.
Library callers can perform the DOS operation with
`resetDosMcpMailbox({confirmGuestReset: true})`.

## API Reference

### WinAuto (Controller)

#### Lifecycle

| Method | Returns | Description |
|---|---|---|
| `waitForReady(timeout?)` | `this` | Wait for WIN-MCP to initialize |
| `ping()` | `boolean` | Liveness check |
| `version()` | `string` | Get version string |
| `identity(features?)` | `object` | Verify the live source identity and capabilities |
| `quit()` | `string` | Shut down WIN-MCP |

#### Task, module, and memory inspection

`taskInfo`, `taskCsip`, `taskStack`, `moduleInfo`, and `moduleProc` return the
guest's bounded inspection payload. `moduleSegments` returns validated
structured records, and `readMemory` returns a validated address-joined
`Buffer`. `writeMemoryUnsafe` requires
`{confirmUnsafe: true}` and verifies the guest's before/after receipt.

`Window.locator(className, text)` may inspect class and text.
`Window.locatorById(id)` performs the separate direct-ID lookup without
reading control text and fails on missing or ambiguous IDs.

#### Launching Programs

```js
// Launch and wait for window (title matched by substring)
const notepad = await win.exec('NOTEPAD.EXE');

// Launch with explicit window title to wait for
const calc = await win.exec('CALC.EXE', { waitFor: 'Calculator' });

// Custom timeout
const app = await win.exec('SLOW.EXE', { timeout: 30000 });
```

#### Finding Windows

```js
// Find by class name (returns Window or null)
const notepad = await win.findWindow('Notepad');

// Wait for window with title substring (throws on timeout)
const dialog = await win.waitForWindow('Save As', 5000);

// Wait for a window to close
await win.waitForClose(dialog);

// List all top-level windows
const windows = await win.listWindows();
// → [{ hwnd: '0A3C', className: 'Notepad', title: 'Notepad - [Untitled]' }, ...]
```

#### Screenshots

```js
const bmpPath = await win.capture();          // Full desktop
const bmpPath = await win.capture('active');  // Active window
const bmpPath = await win.capture(notepad);   // Specific window
```

#### Screen Info

```js
const screen = await win.screen();
// → { width: 640, height: 480, bpp: 8 }
```

#### Clipboard

```js
await win.setClipboard('Hello');
const text = await win.getClipboard();  // → "Hello"
```

#### Tasks

```js
const tasks = await win.listTasks();
// → [{ htask: '0F47', module: 'NOTEPAD' }, ...]

await win.killTask('0F47');
```

#### DDE (Dynamic Data Exchange)

```js
await win.ddeConnect('PROGMAN', 'PROGMAN');
await win.ddeExec('[CreateGroup(My Tools)]');
await win.ddeExec('[AddItem(NOTEPAD.EXE, Notepad)]');
await win.ddeClose();
```

#### Modal Dialog Recovery

```js
// Dismiss any foreground modal dialog (sends IDCANCEL)
await win.abort();
```

#### Mouse (Screen Coordinates)

```js
await win.mouseMove(320, 240);
const pos = await win.mouseGetPos();  // → { x: 320, y: 240 }
```

#### Low-Level Commands

```js
// Send any raw command
const response = await win.send('MSG SEND 0A3C 000E 0000 0000');
// → "OK D"

// Send and assert OK (throws on ERR)
const result = await win.ok('WINDOW RECT 0A3C');
// → "10 10 400 300"
```

---

### Window (Handle)

Every method that finds or creates a window returns a `Window` instance. All methods return `this` for chaining where it makes sense.

#### Properties

| Property | Type | Description |
|---|---|---|
| `hwnd` | `string` | Window handle (4-digit hex) |
| `auto` | `WinAuto` | Parent controller |

#### Window Info

```js
const title = await notepad.title();     // → "Notepad - [Untitled]"
const rect = await notepad.rect();       // → { x: 10, y: 10, width: 400, height: 300 }
const vis = await notepad.isVisible();   // → true
const en = await notepad.isEnabled();    // → true
```

#### Window Control

```js
await notepad.move(10, 10, 400, 300);
await notepad.focus();
await notepad.minimize();
await notepad.maximize();
await notepad.restore();
await notepad.hide();
await notepad.close();
await notepad.waitForClose(5000);
```

#### Child Control Locator

Playwright-style locator for finding child controls:

```js
// Find by class name
const edit = await notepad.locator('Edit');

// Find by class + text
const okBtn = await dialog.locator('Button', 'OK');

// Wildcard — any class, text containing "Cancel"
const cancel = await dialog.locator('*', 'Cancel');
```

#### Text Input

```js
await edit.type('Hello World');              // WM_CHAR per character
await edit.type('Line 1\\nLine 2');          // \\n = Enter
await edit.sendKeys('{CTRL}a');              // Select all
await edit.sendKeys('{ALT}{F4}');            // Alt+F4
await edit.sendKeys('{SHIFT}{HOME}');        // Shift+Home

// Convenience methods
await edit.selectAll();
await edit.copy();
await edit.paste();
await edit.cut();
await edit.undo();
```

#### Mouse (Client Coordinates)

```js
await notepad.click(100, 50);
await notepad.doubleClick(100, 50);
await notepad.rightClick(100, 50);
await notepad.drag(10, 10, 200, 150);       // Left-drag
```

#### Scrolling

```js
await edit.scrollDown(5);
await edit.scrollUp(3);
await edit.scrollLeft(1);
await edit.scrollRight(1);
```

#### Dialog Controls

```js
// List all controls in a dialog
const controls = await dialog.listControls();
// → [{ id: 1, className: 'Button', text: 'OK' },
//    { id: 2, className: 'Button', text: 'Cancel' }, ...]

// Get/set control text
const filename = await dialog.getText(0x0480);
await dialog.setText(0x0480, 'test.txt');

// Click a button by ID
await dialog.clickButton(1);       // OK button

// Send a menu command by ID
await notepad.menuCommand(0x0001); // File > New
```

#### Checkboxes

```js
await dialog.check(101);    // Check a checkbox
await dialog.uncheck(101);  // Uncheck it
```

#### List/Combo Selection

```js
// Select in a listbox by text
const index = await listbox.listSelect('Item Name');

// Select in a combobox by text
const index = await combo.comboSelect('Option 2');
```

#### Assertions

```js
// Immediate check (throws if mismatch)
await dialog.expect(0x0480, 'test.txt');

// Wait for text to match (polls with timeout)
await dialog.waitForText(0x0480, 'Loading complete', 15000);
```

#### Screenshots

```js
const bmpPath = await notepad.capture();
```

---

## Complete Examples

### Notepad Automation

```js
const { WinAuto } = require('../lib/win-auto');

async function main() {
  const win = new WinAuto({ magicDir: '../share/_MAGIC_' });
  await win.waitForReady();

  // Launch Notepad
  const notepad = await win.exec('NOTEPAD.EXE');
  const edit = await notepad.locator('Edit');

  // Type, select all, replace
  await edit.type('First draft');
  await edit.selectAll();
  await edit.type('Final version: Hello from win-auto.js!');

  // Screenshot
  await win.capture(notepad);

  // Close — handle "Save?" dialog
  await notepad.close();
  await new Promise(r => setTimeout(r, 500));
  await win.abort();                          // Dismiss save dialog
  await win.waitForClose(notepad, 5000);      // Verify it's gone
}

main().catch(console.error);
```

### Program Manager Group via DDE

```js
const { WinAuto } = require('../lib/win-auto');

async function main() {
  const win = new WinAuto({ magicDir: '../share/_MAGIC_' });
  await win.waitForReady();

  // Create a Program Manager group with items
  await win.ddeConnect('PROGMAN', 'PROGMAN');
  await win.ddeExec('[CreateGroup(Automation Tools)]');
  await win.ddeExec('[AddItem(NOTEPAD.EXE, Notepad)]');
  await win.ddeExec('[AddItem(CALC.EXE, Calculator)]');
  await win.ddeExec('[AddItem(WINMINE.EXE, Minesweeper)]');
  await win.ddeClose();

  // Screenshot the result
  await win.capture();
}

main().catch(console.error);
```

### Minesweeper

See [examples/minesweeper.js](examples/minesweeper.js) for a complete demo that launches Minesweeper, starts a Beginner game, clicks the four corners, and takes screenshots.

---

## Recording & Playback

Record and replay input events via WINMCHK.DLL (WH_JOURNALRECORD/WH_JOURNALPLAYBACK hooks):

```js
// Record user actions
await win.recordStart();
// ... user performs actions for a few seconds ...
const count = await win.recordStop();
console.log(`Recorded ${count} events`);
await win.recordSave('S:\\MACRO.EVT');

// Play them back at normal speed
await win.play('S:\\MACRO.EVT', 100);

// Check status
const status = await win.playStatus(); // 'IDLE', 'RECORDING', 'PLAYING 10/42'

// Play at double speed
await win.play('S:\\MACRO.EVT', 200);

// Cancel playback
await win.playStop();
```

## Screenshot Comparison

Compare screenshots against reference images for visual regression testing:

```js
const { compareBmp } = require('./lib/win-compare');

// Capture and compare in one call
const result = await win.compareScreenshot('reference.bmp', {
  target: notepad,         // capture specific window
  threshold: 0.95,          // 95% similarity required
  pixelTolerance: 5,        // allow ±5 per RGB channel
});
console.log(result.similarity);  // 0.0 to 1.0
console.log(result.match);       // true/false

// Or compare two BMP files directly
const result2 = compareBmp('before.bmp', 'after.bmp', {
  threshold: 0.99,
  pixelTolerance: 0,
});
```

## DOSBox-X Control Server

Control the emulator itself, independently of the guest mailbox. Start a
patched DOSBox-X with `DOSBOX_CONTROL_PORT` set; leaving it unset disables the
server.

```js
const { DosboxControl } = require('./lib/dosbox-control');
const control = new DosboxControl({ port: 10199, timeout: 5000 });

console.log(await control.identity());
console.log(await control.status());
console.log(await control.ping());
```

`DosboxControl` opens one TCP connection per command and returns the complete
text response. Its API is:

| Method | Description |
|---|---|
| `send(command, options?)` | Send one printable-ASCII control command |
| `ping()` / `status()` / `identity()` | Query liveness, emulator state, or the source-derived build/capability identity |
| `minimize()` | Ask the emulator main thread to minimize its host window |
| `debug(command, options?)` | Run one command on the emulator debugger thread |
| `debugBatch(commands, options?)` | Run 1–8 allowed non-resuming commands as one stopped-CPU scheduling unit |

The same transport is exposed on a `WinAuto` instance as `dosboxCommand`,
`dosboxPing`, `dosboxScreen`, `dosboxScreenshot`, `dosboxType`, `dosboxKey`,
`dosboxStatus`, `dosboxIdentity`, `dosboxMinimize`, `dosboxDebug`, and
`dosboxDebugBatch`:

```js
const alive = await win.dosboxPing();
const identity = await win.dosboxIdentity();
const screen = await win.dosboxScreen();

await win.dosboxType('DIR C:\\');
await win.dosboxKey('ENTER');
await win.dosboxScreenshot();
```

On `WinAuto`, `dosboxCommand()` rejects raw `DEBUG` requests.
`dosboxDebug()` and `dosboxDebugBatch()` run through an identity-checked,
serialized `DebuggerSession`; they reject mutation and nested batch escape
routes. Use the explicitly confirmed and durably audited mutation API in
[DOSBOX-DEBUGGER.md](DOSBOX-DEBUGGER.md) when changing emulator state. The
lower-level `DosboxControl` class and the unauthenticated TCP socket are raw,
privileged interfaces; these safeguards serialize cooperating clients rather
than enforcing a security boundary against another local process.

The checked session serializes same-session commands and stops its queue after
a transport rejection. Its host timeout is never shorter than the server's
30-second debugger ceiling plus five seconds; `WAIT N` requires `N+5000ms` and
accepts at most 295 seconds. A broken TCP exchange still leaves the command's
effect uncertain. The checked client retains
`.dosbox-debugger-host-command.inflight` across transport failure, malformed
responses, `ERR PAUSE_TIMEOUT`, `ERR COMMAND_TIMEOUT`, and `ERR BUSY`, blocking
later checked sessions. After externally resetting or replacing the disposable
emulator, use `node bin/dosbox-debugger.js reset --confirm-emulator-reset` to
clear only that retained host marker. The command does not reset the emulator
or restore pristine evidence.

### Remote debugger

Pause before collecting related state and always arrange to continue in a
`finally` block when the guest should resume:

```js
await control.debug('PAUSE');
try {
  const snapshot = await control.debugBatch([
    'REGISTERS',
    'STACK 8',
    'DISASM',
  ]);
  console.log(snapshot);
} finally {
  await control.debug('CONTINUE');
}
```

Batch framing uses decimal byte lengths rather than separators, so command
responses cannot make the request ambiguous. A batch accepts 1–8 commands of
at most 512 printable ASCII bytes each. Resuming or nested commands such as
`BATCH`, `PAUSE`, `STATUS`, `RUN`, `NEXT`, `WAIT`, and `CONTINUE` are rejected.
A batch is atomic only as a scheduling unit: earlier breakpoint, tracing, or
CPU-state changes are not rolled back when a later command fails.

Debugger command groups advertised by `IDENTITY` include:

- State: `STATUS`, `PAUSE`, `REGISTERS`, `SELECTOR`, `MEMORY`, `DISASM`,
  `STACK`, `SNAPSHOT`, `HASH`.
- Execution: `STEP`, `NEXT`, `FINISH`, `RUN`, `WAIT`, `CONTINUE`.
- Stops: `BREAK`, `WATCH`, `INTERRUPT`, and `EXCEPTION`, including bounded
  filters and one-shot stops.
- Observation: `FILEIO`, `APITRACE`, and `COVERAGE`, each with bounded buffers,
  status, drain, stop, and clear operations.
- Replay support: `CHECKPOINT`, instruction-sequenced `INPUT`, and
  `DETERMINISM` recording/verification.
- Mutation: `MUTATE REGISTER` and `MUTATE MEMORY`, which require the literal
  confirmation token reported by the command's usage error.

The exact grammar is returned fail-closed in `ERR USAGE` responses and evolves
with the capability identity. Check `IDENTITY` before depending on a command.
See [examples/dosbox-debugger.js](examples/dosbox-debugger.js) for a complete
read-only snapshot.

### Deterministic reverse-step

The optional reverse adapter restores a named checkpoint, arms recorded
determinism and input replay, and steps forward under the same debugger lease
to the exact earlier instruction sequence:

```bash
node bin/dosbox-reverse.js step CHECKPOINT COUNT
```

Place optional `--host`, `--port`, `--timeout`, `--max-response-bytes`,
`--lease-dir`, `--lease-timeout`, and `--poll-ms` settings before `step`.

Each `STEP` request is capped at 10,000 instructions and a workflow is capped
at 10,000 requests. Completion requires exact sequence receipts,
`MODE=VERIFY`, `FAILED=0`, `ACTIVE=1`, and `SKIPPED=0`. The operation is
reverse-step only. It is not native backward execution, and there is no
reverse-continue because `RUN UNTIL` cannot enforce a maximum sequence before
an address is reached again.

The library entry is `runReverse()` from `lib/dosbox-reverse.js`; pass it the
facade supplied by `withDebuggerSession()` so one lease spans restore, replay,
stepping, and validation.

### Receipt-backed Win16 memory snapshots

`lib/win-memory-snapshot.js` captures declared module ranges through the main
`lib/win-auto.js` session API. It resolves the current segment selectors,
splits reads into at most 512 bytes, records exact commands/responses and task
state before and after, hashes each range, and can decode explicitly declared
integer, byte, or ASCII fields.

```bash
node bin/winmcp-snapshot.js capture examples/win-memory-snapshot.json before.json
node bin/winmcp-snapshot.js capture examples/win-memory-snapshot.json after.json
node bin/winmcp-snapshot.js diff before.json after.json changes.json
```

Outputs use the `legacy-mcps.win16-memory-snapshot/v1` and
`legacy-mcps.win16-memory-diff/v1` schemas and are durably published without
replacing an existing path. If a check fails after the destination link becomes
visible, the API reports `publicationDisposition=retained-uncertain` and leaves
that path in place; it will not risk unlinking a path that another process could
have replaced. Inspect or remove that retained output explicitly before retrying.
Snapshot evidence always declares `atomic:false`: the host lease
prevents cooperating clients from interleaving mailbox commands, but Windows
and the inspected application may run between reads. Matching task receipts
do not prove that selectors or application state stayed unchanged.

### Evidence and safety limits

The endpoint binds to `127.0.0.1`, but it is deliberately unauthenticated. Any
local process able to reach the port can inspect guest memory, control guest
execution and input, capture screens, shut down the emulator, or invoke unsafe
mutation. Never forward or proxy the socket. Use an isolated host/session when
other local processes are not trusted.

Read-only inspection does not intentionally change guest bytes, while stop,
trace, replay, and coverage commands do change debugger state. `MUTATE` changes
CPU or memory state. After a mutation attempt, regard the entire emulator
session as manipulated evidence even if verification fails or later bytes
happen to match their earlier values. `SNAPSHOT` requires a stopped CPU and captures a
bounded rendered image, but is not an atomic snapshot of every device. Replay
verification checks recorded clocks, DOS reads/offsets, IRQs, NMIs, checkpoint,
and sequenced input; it does not establish universal emulator determinism.

Typical uses include:

- Automating the DOS boot sequence before Windows starts
- Reading text-mode screens (e.g., BIOS, DOS prompts)
- Typing DOS commands that happen before WIN-MCP loads
- Inspecting protected-mode selectors, memory, call stacks, and stop causes
- Capturing bounded file, API, coverage, and replay evidence

## Architecture

win-auto.js is a thin wrapper over WIN-MCP's file-based IPC:

```
Your script                win-auto.js              WIN-MCP (inside Win3.1)
──────────                 ───────────              ──────────────────────
await notepad.type(...)  → writes __WIN__.TX       → polls, reads TX
                           polls __WIN__.RX        ← executes, writes RX
                         ← returns parsed result
```

There is no persistent connection — each command is a write/read cycle. The library handles:

- Synced private writes with checked atomic-rename TX publication under the advisory lease
- Case-insensitive file lookup (DOSBox-X vs emu2)
- Long response overflow (`OK @LR` → read `__WIN__.LR`)
- Timeout and error handling
- Parsing structured responses into JS objects
