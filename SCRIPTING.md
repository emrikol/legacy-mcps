# Scripting with win-auto.js

A Node.js library for automating Windows 3.x applications running inside DOSBox-X. Inspired by [Playwright](https://playwright.dev/) — async/await API, auto-waiting, fluent method chaining.

## Quick Start

```js
const { WinAuto } = require('./lib/win-auto');

const win = new WinAuto({ magicDir: './share/_MAGIC_' });
await win.waitForReady();

// Launch Notepad, type text, select all, copy to clipboard
const notepad = await win.exec('NOTEPAD.EXE');
const edit = await notepad.locator('Edit');
await edit.type('Hello from 2026!');
await edit.selectAll();
await edit.copy();

// Verify clipboard
const text = await win.getClipboard();
console.log(text); // "Hello from 2026!"

// Screenshot and close
await win.capture(notepad);
await notepad.close();
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

## API Reference

### WinAuto (Controller)

#### Lifecycle

| Method | Returns | Description |
|---|---|---|
| `waitForReady(timeout?)` | `this` | Wait for WIN-MCP to initialize |
| `ping()` | `boolean` | Liveness check |
| `version()` | `string` | Get version string |
| `quit()` | `string` | Shut down WIN-MCP |

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

Control the DOSBox-X emulator itself (not the guest OS) via TCP. Requires DOSBox-X started with `DOSBOX_CONTROL_PORT=10199`:

```js
// Ping the emulator
const alive = await win.dosboxPing();

// Read the DOS text screen (80x25 buffer)
const screen = await win.dosboxScreen();
console.log(screen); // lines of text

// Type into DOS (before Windows boots, or in DOS prompt)
await win.dosboxType('DIR C:\\');
await win.dosboxKey('ENTER');

// Take a DOSBox-X screenshot (PNG, saved to capture dir)
await win.dosboxScreenshot();

// Get emulator status
const status = await win.dosboxStatus();
```

This is useful for:

- Automating the DOS boot sequence before Windows starts
- Reading text-mode screens (e.g., BIOS, DOS prompts)
- Typing DOS commands that happen before WIN-MCP loads
- Taking screenshots when Windows isn't running

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

- Atomic file writes (temp file + rename)
- Case-insensitive file lookup (DOSBox-X vs emu2)
- Long response overflow (`OK @LR` → read `__WIN__.LR`)
- Timeout and error handling
- Parsing structured responses into JS objects
