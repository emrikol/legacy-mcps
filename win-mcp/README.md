# Win16 MCP — Windows 3.x Remote Control Agent

A Win16 application that runs inside Windows 3.x and exposes the Windows API via file-based IPC. Think Playwright/Puppeteer, but for Windows 3.1.

![Windows 3.1 desktop captured via GDI CAPTURE](capture/cap_desktop.png)

## Overview

WINMCP.EXE is a hidden Win16 application (~20KB NE executable) that:

1. Creates an invisible window with a 200ms timer
2. Polls `_MAGIC_\__WIN__.TX` for commands
3. Dispatches commands to Windows API handlers
4. Writes responses to `_MAGIC_\__WIN__.RX`

It runs alongside the DOS TSR without conflict — each has its own IPC channel.

## Building

```bash
cd src && make              # Compile with Open Watcom → WINMCP.EXE
cd src && make deploy       # Copy to share/ and win31-hdd/
make testwin                # Build + boot Windows 3.1 + run 75 tests
```

### Requirements

- Open Watcom 2.0 (`tools/watcom/`) — cross-compiles Win16 from macOS ARM64
- DOSBox-X (`tools/dosbox-x`) — boots Windows 3.1 for testing
- Node.js — runs the test harness
- nasm — assembles the DOS stub (WINSTUB.COM)

## Auto-start

Add to `WIN.INI` under `[windows]`:

```ini
load=S:\WINMCP.EXE S:
```

The command-line argument specifies the drive letter where `_MAGIC_/` lives.

## Command Reference

All commands are plain text written to `__WIN__.TX`. Responses appear in `__WIN__.RX`.

Parameters in `<angle brackets>` are required. Parameters in `[square brackets]` are optional. `<hwnd>` values are 4-digit hex (e.g., `0A3C`). `<id>` values are decimal control IDs.

---

### META — Lifecycle

| Command | Response | Description |
|---|---|---|
| `META PING` | `OK PONG` | Liveness check |
| `META VERSION` | `OK WINMCP/0.3 META,PROFILE,...` | Version and capability list |
| `META STATUS` | `OK CMDS=42 POLL=200ms` | Command count and poll interval |
| `META QUIT` | `OK` | Clean shutdown |

---

### PROFILE — INI File Access

Uses the Windows INI caching system. Safer than direct file editing while Windows is running.

| Command | Response | Description |
|---|---|---|
| `PROFILE GET <file> <section> <key>` | `OK <value>` | GetPrivateProfileString |
| `PROFILE SET <file> <section> <key> <value>` | `OK` | WritePrivateProfileString |
| `PROFILE SECTIONS <file>` | `OK sec1 sec2 sec3` | List all section names |

**Example:**

```
→ PROFILE GET WIN.INI windows load
← OK WINMCP.EXE
→ PROFILE SET C:\TEST.INI app setting hello
← OK
→ PROFILE GET C:\TEST.INI app setting
← OK hello
```

---

### FILE — File Operations

| Command | Response | Description |
|---|---|---|
| `FILE READ <path> [maxbytes]` | `OK <contents>` | Read file contents |
| `FILE WRITE <path> <data>` | `OK` | Create/overwrite file |
| `FILE APPEND <path> <data>` | `OK` | Append to file |
| `FILE DELETE <path>` | `OK` | Delete file |
| `FILE COPY <src> <dst>` | `OK` | Copy file |
| `FILE FIND <pattern>` | `OK FILE1.TXT FILE2.EXE` | Wildcard file search |

**Example:**

```
→ FILE WRITE C:\TEST.TXT Hello World
← OK
→ FILE READ C:\TEST.TXT
← OK Hello World
→ FILE FIND C:\WINDOWS\*.EXE
← OK NOTEPAD.EXE WRITE.EXE CALC.EXE ...
```

---

### DIR — Directory Operations

| Command | Response | Description |
|---|---|---|
| `DIR CREATE <path>` | `OK` | Create directory |
| `DIR DELETE <path>` | `OK` | Remove empty directory |
| `DIR LIST <path>` | `OK ./ ../ SUBDIR/ FILE.TXT` | List files (dirs have trailing `/`) |

---

### TIME — System Time

| Command | Response | Description |
|---|---|---|
| `TIME GET` | `OK 14:30:45` | Current time (HH:MM:SS via DOS INT 21h/2Ch) |

---

### ENV — Environment Variables

| Command | Response | Description |
|---|---|---|
| `ENV GET <name>` | `OK <value>` | Read from DOS environment block |

**Example:**

```
→ ENV GET PATH
← OK C:\WINDOWS;C:\DOS
```

---

### EXEC — Launch Programs

| Command | Response | Description |
|---|---|---|
| `EXEC <command>` | `OK <instance>` | WinExec, returns module instance handle |

**Example:**

```
→ EXEC NOTEPAD.EXE
← OK 4528
→ EXEC NOTEPAD.EXE C:\README.TXT
← OK 4544
```

---

### WINDOW — Window Management

| Command | Response | Description |
|---|---|---|
| `WINDOW LIST` | `OK 0A3C:Notepad:Notepad - [Untitled] ...` | All top-level windows (hwnd:class:title) |
| `WINDOW FIND <class> <title>` | `OK 0A3C` | FindWindow (class or title can be empty) |
| `WINDOW TITLE <hwnd>` | `OK Notepad - [Untitled]` | GetWindowText |
| `WINDOW CLOSE <hwnd>` | `OK` | PostMessage WM_CLOSE |
| `WINDOW MOVE <hwnd> <x> <y> <w> <h>` | `OK` | MoveWindow |
| `WINDOW SHOW <hwnd> <cmd>` | `OK` | ShowWindow (HIDE/MIN/MAX/RESTORE/SHOW) |
| `WINDOW RECT <hwnd>` | `OK 10 10 400 300` | GetWindowRect (x y w h) |
| `WINDOW VISIBLE <hwnd>` | `OK TRUE` | IsWindowVisible |
| `WINDOW ENABLED <hwnd>` | `OK TRUE` | IsWindowEnabled |

**Example — find and move Notepad:**

```
→ WINDOW FIND Notepad
← OK 0A3C
→ WINDOW MOVE 0A3C 10 10 400 300
← OK
→ WINDOW RECT 0A3C
← OK 10 10 400 300
```

---

### TASK — Task Management (ToolHelp API)

| Command | Response | Description |
|---|---|---|
| `TASK LIST` | `OK 0F47:NOTEPAD 0E8B:WINMCP ...` | All running tasks (htask:module) |
| `TASK KILL <htask>` | `OK` | TerminateApp |

---

### GDI — Graphics

| Command | Response | Description |
|---|---|---|
| `GDI SCREEN` | `OK W=640 H=480 BPP=8` | Screen resolution and color depth |
| `GDI CAPTURE` | `OK S:\...\__WIN__.BMP` | Full desktop screenshot (24-bit BMP) |
| `GDI CAPTURE ACTIVE` | `OK S:\...\__WIN__.BMP` | Active window screenshot |
| `GDI CAPTURE <hwnd>` | `OK S:\...\__WIN__.BMP` | Specific window screenshot |

Screenshots are saved as 24-bit BMP files using GetPixel (universally compatible with any display driver).

![Desktop capture](capture/cap_desktop.png)
![Active window capture](capture/cap_active.png)

---

### MSG — Message Passing

| Command | Response | Description |
|---|---|---|
| `MSG SEND <hwnd> <msg> <wp> <lp>` | `OK <result>` | SendMessage (synchronous, returns result) |
| `MSG POST <hwnd> <msg> <wp> <lp>` | `OK` | PostMessage (asynchronous) |

All parameters are hex. Common messages:

| Message | Hex | Use |
|---|---|---|
| WM_CLOSE | 0010 | Close window |
| WM_COMMAND | 0111 | Menu/button action |
| WM_CHAR | 0102 | Character input |
| WM_GETTEXTLENGTH | 000E | Get text length |

**Example — get text length of an edit control:**

```
→ MSG SEND 0B14 000E 0000 0000
← OK 12
```

---

### CLIP — Clipboard

| Command | Response | Description |
|---|---|---|
| `CLIP SET <text>` | `OK` | Copy text to clipboard |
| `CLIP GET` | `OK <text>` | Read text from clipboard |

---

### DIALOG — Dialog Box Interaction

| Command | Response | Description |
|---|---|---|
| `DIALOG LIST <hwnd>` | `OK 1:Button:OK 2:Button:Cancel ...` | List controls (id:class:text) |
| `DIALOG GET <hwnd> <id>` | `OK <text>` | GetDlgItemText |
| `DIALOG SET <hwnd> <id> <text>` | `OK` | SetDlgItemText |
| `DIALOG CLICK <hwnd> <id>` | `OK` | Click button via BM_CLICK |

---

### DDE — Dynamic Data Exchange

| Command | Response | Description |
|---|---|---|
| `DDE CONNECT <service> <topic>` | `OK <conv_id>` | Connect to DDE server |
| `DDE EXEC <command>` | `OK` | Execute DDE command |
| `DDE CLOSE` | `OK` | Disconnect |

**Example — create a Program Manager group:**

```
→ DDE CONNECT PROGMAN PROGMAN
← OK 0A1C
→ DDE EXEC [CreateGroup(MCP Tools)]
← OK
→ DDE EXEC [DeleteGroup(MCP Tools)]
← OK
→ DDE CLOSE
← OK
```

---

### TYPE — Text Input

Sends WM_CHAR messages to type text into a control. SetFocus is called first.

| Command | Response | Description |
|---|---|---|
| `TYPE <hwnd> <text>` | `OK` | Type text with escape sequences |

Escape sequences: `\n` (Enter), `\t` (Tab), `\e` (Escape), `\\` (backslash).

**Example:**

```
→ TYPE 0B14 Hello World\nSecond line
← OK
```

---

### SENDKEYS — Keyboard Simulation

Sends WM_KEYDOWN/WM_KEYUP with proper scan codes and lParam encoding. Modifiers are sticky until the next key is pressed.

| Command | Response | Description |
|---|---|---|
| `SENDKEYS <hwnd> <keys>` | `OK` | Send key sequence |

**Key tokens:** `{ALT}`, `{CTRL}`, `{SHIFT}`, `{ENTER}`, `{TAB}`, `{ESC}`, `{BACKSPACE}`, `{DELETE}`, `{INSERT}`, `{HOME}`, `{END}`, `{PGUP}`, `{PGDN}`, `{UP}`, `{DOWN}`, `{LEFT}`, `{RIGHT}`, `{SPACE}`, `{F1}`-`{F12}`

Plain characters are sent as WM_CHAR. Modified characters use WM_KEYDOWN/WM_KEYUP with VK codes. Alt combinations use WM_SYSKEYDOWN/WM_SYSKEYUP.

**Examples:**

```
→ SENDKEYS 0B14 {CTRL}a          # Select all
→ SENDKEYS 0B14 {CTRL}c          # Copy
→ SENDKEYS 0B14 {ALT}{F4}        # Alt+F4
→ SENDKEYS 0B14 {SHIFT}{HOME}    # Shift+Home (select to start)
```

---

### MOUSE — Mouse Simulation

| Command | Response | Description |
|---|---|---|
| `MOUSE MOVE <x> <y>` | `OK` | SetCursorPos (screen coordinates) |
| `MOUSE CLICK <hwnd> <x> <y>` | `OK` | Left click at client coordinates |
| `MOUSE DBLCLICK <hwnd> <x> <y>` | `OK` | Double-click |
| `MOUSE RCLICK <hwnd> <x> <y>` | `OK` | Right-click |
| `MOUSE DRAG <hwnd> <x1> <y1> <x2> <y2>` | `OK` | Left-drag with 8-step interpolation |
| `MOUSE RDRAG <hwnd> <x1> <y1> <x2> <y2>` | `OK` | Right-drag |
| `MOUSE GETPOS` | `OK 320 240` | Current cursor position |

Drag operations use SetCapture/ReleaseCapture and interpolate 8 intermediate MOUSEMOVE events.

---

### CLICK — Button Click

| Command | Response | Description |
|---|---|---|
| `CLICK <hwnd> <id>` | `OK` | GetDlgItem + SendMessage WM_COMMAND BN_CLICKED |

---

### MENU — Menu Command

| Command | Response | Description |
|---|---|---|
| `MENU <hwnd> <id>` | `OK` | Sends WM_INITMENU then WM_COMMAND |

---

### FOCUS — Window Focus

| Command | Response | Description |
|---|---|---|
| `FOCUS <hwnd>` | `OK` | SetFocus + BringWindowToTop |

---

### SCROLL — Scroll Control

| Command | Response | Description |
|---|---|---|
| `SCROLL <hwnd> <dir> <n>` | `OK` | Send n scroll messages |

Directions: `UP`, `DOWN`, `PGUP`, `PGDN` (WM_VSCROLL), `LEFT`, `RIGHT` (WM_HSCROLL).

---

### CONTROL — Child Window Locator

Playwright-style locator that finds child windows by class and/or text.

| Command | Response | Description |
|---|---|---|
| `CONTROL FIND <hwnd> <class> <text>` | `OK <child_hwnd>` | Find first matching child |

Use `*` as wildcard for class or text.

**Example — find the Edit control in Notepad:**

```
→ WINDOW FIND Notepad
← OK 0A3C
→ CONTROL FIND 0A3C Edit *
← OK 0B14
```

---

### LIST / COMBO — Selection Controls

| Command | Response | Description |
|---|---|---|
| `LIST SELECT <hwnd> <text>` | `OK <index>` | LB_SELECTSTRING |
| `COMBO SELECT <hwnd> <text>` | `OK <index>` | CB_SELECTSTRING |

---

### CHECK / UNCHECK — Checkbox Controls

| Command | Response | Description |
|---|---|---|
| `CHECK <hwnd> <id>` | `OK` | BM_SETCHECK BST_CHECKED |
| `UNCHECK <hwnd> <id>` | `OK` | BM_SETCHECK BST_UNCHECKED |

---

### ABORT — Dismiss Modal Dialog

| Command | Response | Description |
|---|---|---|
| `ABORT` | `OK` | Finds foreground modal dialog (#32770 or disabled owner), sends IDCANCEL |

Useful for error recovery when a dialog blocks automation.

---

### WAIT — Wait for Conditions

Commands that poll with an internal message pump, keeping Windows responsive.

| Command | Response | Description |
|---|---|---|
| `WAIT WINDOW <title> [ms]` | `OK <hwnd>` | Wait for window with title substring (default 10s) |
| `WAIT GONE <hwnd> [ms]` | `OK` | Wait for window to be destroyed (default 10s) |

**Example — launch Notepad and wait for it:**

```
→ EXEC NOTEPAD.EXE
← OK 4528
→ WAIT WINDOW Notepad 5000
← OK 0A3C
```

---

### WAITFOR / EXPECT — Control Text Assertions

| Command | Response | Description |
|---|---|---|
| `WAITFOR <hwnd> <id> <text> [ms]` | `OK MATCH` or `OK MISMATCH:<actual>` | Poll until text matches |
| `EXPECT <hwnd> <id> <text>` | `OK MATCH` or `OK MISMATCH:<actual>` | Immediate text check |

---

## Complete Automation Example

Launch Notepad, type text, select all, replace, verify, and close:

```
EXEC NOTEPAD.EXE                          → OK 4528
WAIT WINDOW Notepad 5000                  → OK 0A3C
CONTROL FIND 0A3C Edit *                  → OK 0B14
TYPE 0B14 Hello from automation!          → OK
SENDKEYS 0B14 {CTRL}a                     → OK          # Select all
TYPE 0B14 Replaced text                   → OK
MSG SEND 0B14 000E 0000 0000              → OK D         # WM_GETTEXTLENGTH = 13
WINDOW CLOSE 0A3C                         → OK          # Triggers "Save?" dialog
ABORT                                     → OK          # Dismiss save dialog
WAIT GONE 0A3C 5000                       → OK          # Notepad is gone
```

### RECORD — Journal Recording (requires WINMCHK.DLL)

Records all input events (keyboard + mouse) system-wide via WH_JOURNALRECORD hook.

| Command | Response | Description |
|---|---|---|
| `RECORD START` | `OK` | Install journal record hook, begin capturing |
| `RECORD STOP` | `OK 42` | Unhook, return event count |
| `RECORD SAVE <file>` | `OK 42` | Save event buffer to binary file |

---

### PLAY — Journal Playback (requires WINMCHK.DLL)

Replays recorded input events via WH_JOURNALPLAYBACK hook with speed control.

| Command | Response | Description |
|---|---|---|
| `PLAY <file> [speed]` | `OK 42` | Load events from file, begin playback. Speed: 100=normal, 50=half, 200=double |
| `PLAY STOP` | `OK` | Cancel playback |
| `PLAY STATUS` | `OK IDLE` / `OK RECORDING` / `OK PLAYING 10/42` | Current state |

**Example — record and replay:**

```
→ RECORD START
← OK
(user performs actions for a few seconds)
→ RECORD STOP
← OK 87
→ RECORD SAVE S:\MACRO.EVT
← OK 87
→ PLAY S:\MACRO.EVT 100
← OK 87
→ PLAY STATUS
← OK PLAYING 12/87
```

---

## Implementation Notes

- **WINMCHK.DLL** — 2.4KB hook DLL with shared data segment (`DATA SINGLE`). Stores up to 2048 events (~20KB). The DLL is loaded on demand via `LoadLibrary` when RECORD/PLAY commands are first used.
- **Win16 has no `keybd_event()` or `mouse_event()`** — input simulation uses SendMessage/PostMessage for targeted input. Global input (Alt+Tab, etc.) uses the journal playback hook via WINMCHK.DLL.
- **TYPE uses SendMessage, not PostMessage** — prevents dropped characters under load. SetFocus is called first.
- **SENDKEYS encodes lParam correctly** — scan codes via MapVirtualKey, extended key flag for arrow/nav keys, WM_SYSKEYDOWN for Alt combinations.
- **MOUSE DRAG uses SetCapture** — ensures the target window receives all mouse messages during the drag, even if the cursor leaves its bounds.
- **WAIT commands pump messages** — PeekMessage/DispatchMessage + Yield() loop keeps Windows responsive while waiting. The re-entrancy guard in poll_tx() prevents recursive command dispatch.
- **GDI CAPTURE uses GetPixel** — slower than GetDIBits but works with every display driver. Captures to 24-bit BMP.
- **Long responses** — when a response exceeds ~3900 bytes, it overflows to `__WIN__.LR` and the RX file contains `OK @LR` as a signal.
