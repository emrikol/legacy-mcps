# WIN-MCP: Windows 3.11 Model Context Protocol Helper

> **Note:** This is the original design document written before implementation. The actual implementation diverged significantly — many planned commands were not built, and many commands not in this doc were added. For the current, accurate command reference, see **[win-mcp/README.md](win-mcp/README.md)**. For the scripting API, see **[SCRIPTING.md](SCRIPTING.md)**.

## Overview

A **Win16 companion application** that runs inside Windows for Workgroups 3.11
alongside the DOS MCP TSR. It provides direct access to the Windows API for
UI automation, task management, and inter-process communication that the
DOS TSR cannot reach from real mode.

WIN-MCP is a **separate, independent program** — not routed through the DOS
TSR. It uses its own file-based IPC channel in the same magic directory
structure, polled by the same AI agent.

---

## Architecture

```
AI Agent (host)
  |
  |-- __MCP__.TX / __MCP__.RX  -->  DOS TSR (mcp.com)   [real-mode DOS]
  |
  |-- __WIN__.TX / __WIN__.RX  -->  Win16 App (winmcp.exe) [protected-mode Windows]
  |
  v
Shared magic directory on SMB share or local drive
```

### Key design decisions

- **Separate IPC files:** `__WIN__.TX` and `__WIN__.RX` (not `__MCP__.*`).
  No coordination or handoff with the DOS TSR needed. Both can run
  simultaneously without conflict.

- **Independent polling:** WIN-MCP uses a Windows timer (SetTimer) to poll
  its TX file, completely independent of the DOS TSR's timer-tick polling.
  Poll interval ~100ms (configurable).

- **No DLL required:** WIN-MCP is a standalone .EXE. It can optionally
  install system-wide hooks (WH_JOURNALRECORD/PLAYBACK) which require a
  DLL for the hook procedure, but core functionality works without one.

- **Graceful degradation:** If Windows isn't running, WIN-MCP doesn't exist.
  The AI agent detects this by checking whether `__WIN__.RX` appears after
  sending a PING. The DOS TSR continues to work independently.

---

## IPC Protocol

Same protocol as DOS MCP:

1. Agent writes command to `__WIN__.TX` (atomic rename from temp file)
2. WIN-MCP detects TX file, reads command, deletes TX
3. WIN-MCP executes command
4. WIN-MCP writes response to `__WIN__.RX`
5. Agent reads RX, deletes it
6. Long responses overflow to `__WIN__.LR`

Status file `__WIN__.ST` indicates READY state.

Command/response format: plain text, `OK ...` or `ERR ...` responses,
identical conventions to DOS MCP.

---

## Command Families

### WIN META — basic lifecycle

| Command | Response | Description |
|---------|----------|-------------|
| `WIN META PING` | `OK PONG` | Liveness check |
| `WIN META VERSION` | `OK WINMCP/0.1 ...` | Version + capability list |
| `WIN META STATUS` | `OK CMDS=n ...` | Runtime status |
| `WIN META QUIT` | `OK` | Clean shutdown |

### WIN WINDOW — window enumeration and control

| Command | Response | Description |
|---------|----------|-------------|
| `WIN WINDOW LIST` | `OK hwnd1:class:title, ...` | EnumWindows — list all top-level windows |
| `WIN WINDOW CHILDREN <hwnd>` | `OK hwnd1:class:title, ...` | EnumChildWindows |
| `WIN WINDOW FIND <class> <title>` | `OK <hwnd>` or `ERR NOT_FOUND` | FindWindow |
| `WIN WINDOW TITLE <hwnd>` | `OK <title_text>` | GetWindowText |
| `WIN WINDOW CLASS <hwnd>` | `OK <class_name>` | GetClassName |
| `WIN WINDOW RECT <hwnd>` | `OK x y w h` | GetWindowRect |
| `WIN WINDOW MOVE <hwnd> <x> <y> <w> <h>` | `OK` | MoveWindow |
| `WIN WINDOW SHOW <hwnd> <cmd>` | `OK` | ShowWindow (SW_SHOW/HIDE/MINIMIZE/MAXIMIZE) |
| `WIN WINDOW FOCUS <hwnd>` | `OK` | SetFocus + BringWindowToTop |
| `WIN WINDOW CLOSE <hwnd>` | `OK` | PostMessage WM_CLOSE |
| `WIN WINDOW STYLE <hwnd>` | `OK <style_hex>` | GetWindowLong(GWL_STYLE) |

### WIN MSG — message passing

| Command | Response | Description |
|---------|----------|-------------|
| `WIN MSG SEND <hwnd> <msg> <wp> <lp>` | `OK <result>` | SendMessage (synchronous) |
| `WIN MSG POST <hwnd> <msg> <wp> <lp>` | `OK` | PostMessage (asynchronous) |

Parameters are hex. Common messages:

- `WM_COMMAND` (0111h) — menu/button clicks
- `WM_CHAR` (0102h) — character input
- `WM_KEYDOWN` (0100h) — key press
- `BM_CLICK` (00F5h) — button click

### WIN TASK — task/module management (ToolHelp API)

| Command | Response | Description |
|---------|----------|-------------|
| `WIN TASK LIST` | `OK htask:module:title, ...` | TaskFirst/TaskNext |
| `WIN TASK SWITCH <htask>` | `OK` | Switch to task |
| `WIN TASK KILL <htask>` | `OK` | TerminateApp |
| `WIN TASK INFO <htask>` | `OK module=X inst=X ...` | TaskFindHandle details |
| `WIN MODULE LIST` | `OK hmod:name:path, ...` | ModuleFirst/ModuleNext |
| `WIN MODULE FIND <name>` | `OK <hmodule>` | GetModuleHandle |

### WIN DDE — Dynamic Data Exchange

| Command | Response | Description |
|---------|----------|-------------|
| `WIN DDE CONNECT <service> <topic>` | `OK <conv_id>` | DdeConnect |
| `WIN DDE EXEC <conv_id> <command>` | `OK` | DdeClientTransaction XTYP_EXECUTE |
| `WIN DDE REQUEST <conv_id> <item>` | `OK <data>` | DdeClientTransaction XTYP_REQUEST |
| `WIN DDE POKE <conv_id> <item> <data>` | `OK` | DdeClientTransaction XTYP_POKE |
| `WIN DDE CLOSE <conv_id>` | `OK` | DdeDisconnect |

Common DDE targets:

- **Program Manager:** service=PROGMAN, topic=PROGMAN
  - `[CreateGroup(name)]`, `[AddItem(cmd,name)]`, `[DeleteGroup(name)]`
- **File Manager:** service=WFWFM (if running)
- **Excel/Write/etc.** for data exchange

### WIN DIALOG — dialog box interaction

| Command | Response | Description |
|---------|----------|-------------|
| `WIN DIALOG LIST <hwnd>` | `OK id:class:text, ...` | Enumerate dialog controls |
| `WIN DIALOG GET <hwnd> <id>` | `OK <text>` | GetDlgItemText |
| `WIN DIALOG SET <hwnd> <id> <text>` | `OK` | SetDlgItemText |
| `WIN DIALOG CHECK <hwnd> <id>` | `OK <state>` | IsDlgButtonChecked |
| `WIN DIALOG CLICK <hwnd> <id>` | `OK` | SendMessage BM_CLICK |

### WIN GDI — graphics device info

| Command | Response | Description |
|---------|----------|-------------|
| `WIN GDI SCREEN` | `OK w=X h=X bpp=X dpi=X` | Screen DC capabilities |
| `WIN GDI FONTS` | `OK font1,font2,...` | EnumFonts |
| `WIN GDI CAPTURE <hwnd>` | Saves BMP to magic dir | Window screenshot via BitBlt |

### WIN PROFILE — INI file access (Windows API)

| Command | Response | Description |
|---------|----------|-------------|
| `WIN PROFILE GET <file> <section> <key>` | `OK <value>` | GetPrivateProfileString |
| `WIN PROFILE SET <file> <section> <key> <value>` | `OK` | WritePrivateProfileString |
| `WIN PROFILE SECTIONS <file>` | `OK sec1,sec2,...` | GetPrivateProfileSectionNames |

Safer than direct file editing while Windows is running — uses Windows'
own INI caching and write-through.

### WIN HOOK — input recording/playback (requires DLL)

| Command | Response | Description |
|---------|----------|-------------|
| `WIN HOOK RECORD START` | `OK` | Install WH_JOURNALRECORD |
| `WIN HOOK RECORD STOP` | `OK <event_count>` | Remove hook, save events to file |
| `WIN HOOK PLAY <file>` | `OK` | Play back via WH_JOURNALPLAYBACK |

This requires a separate DLL (`winmchk.dll`) for the hook procedure,
since system-wide hooks must reside in a DLL.

---

## Implementation Details

### Language and toolchain

Win16 development options (all produce 16-bit NE executables):

| Toolchain | Pros | Cons |
|-----------|------|------|
| **Open Watcom** | Free, still maintained, C/C++ | Some Win16 API quirks |
| **Borland C++ 3.1** | Period-accurate, excellent Win16 support | Abandonware |
| **Microsoft C 7.0 / Visual C++ 1.52** | Official, best SDK compat | Hard to find legally |
| **Digital Mars** | Free, good 16-bit support | Less documentation |

**Recommended:** Open Watcom — free, builds NE executables, cross-compiles
from modern platforms.

### Program structure

```c
// Minimal Win16 app structure
int PASCAL WinMain(HINSTANCE hInst, HINSTANCE hPrev,
                   LPSTR lpCmd, int nShow)
{
    // Parse command line for magic directory path
    // Create hidden window for message pump + timer
    // Write __WIN__.ST = "READY"
    // Enter message loop

    MSG msg;
    while (GetMessage(&msg, NULL, 0, 0)) {
        TranslateMessage(&msg);
        DispatchMessage(&msg);
    }
    return msg.wParam;
}

LRESULT CALLBACK WndProc(HWND hwnd, UINT msg,
                         WPARAM wParam, LPARAM lParam)
{
    switch (msg) {
    case WM_TIMER:
        poll_tx_file();   // Check for __WIN__.TX
        break;
    case WM_DESTROY:
        PostQuitMessage(0);
        break;
    }
    return DefWindowProc(hwnd, msg, wParam, lParam);
}
```

### Polling mechanism

- `SetTimer(hwnd, 1, 100, NULL)` — 100ms timer tick
- On WM_TIMER: check if `__WIN__.TX` exists via `_lopen`/`OpenFile`
- If found: read command, delete TX, dispatch, write RX
- Same atomic-rename pattern as DOS MCP for safety

### Window enumeration

```c
// WIN WINDOW LIST
BOOL CALLBACK EnumWndProc(HWND hwnd, LPARAM lParam)
{
    char class[64], title[128];
    GetClassName(hwnd, class, sizeof(class));
    GetWindowText(hwnd, title, sizeof(title));
    // Append "hwnd:class:title" to response buffer
    return TRUE; // continue enumeration
}

EnumWindows(EnumWndProc, (LPARAM)&response_buf);
```

### ToolHelp task listing

```c
#include <toolhelp.h>

TASKENTRY te;
te.dwSize = sizeof(TASKENTRY);
if (TaskFirst(&te)) {
    do {
        // te.hTask, te.hInst, te.hModule, te.szModule
        // Append to response
    } while (TaskNext(&te));
}
```

### DDE client

```c
#include <ddeml.h>

DWORD idInst = 0;
DdeInitialize(&idInst, DdeCallback, APPCMD_CLIENTONLY, 0);

HSZ hszService = DdeCreateStringHandle(idInst, "PROGMAN", CP_WINANSI);
HSZ hszTopic = DdeCreateStringHandle(idInst, "PROGMAN", CP_WINANSI);
HCONV hConv = DdeConnect(idInst, hszService, hszTopic, NULL);

// Execute: [CreateGroup(MyGroup)]
HDDEDATA hData = DdeCreateDataHandle(idInst, cmd, len, 0,
                                      NULL, CF_TEXT, 0);
DdeClientTransaction((LPBYTE)hData, -1, hConv, NULL, 0,
                      XTYP_EXECUTE, 5000, NULL);

DdeDisconnect(hConv);
DdeUninitialize(idInst);
```

### Hook DLL (for WIN HOOK RECORD/PLAY)

Separate `winmchk.dll` containing:

```c
// Journal record hook
LRESULT CALLBACK JournalRecordProc(int code, WPARAM wParam,
                                    LPARAM lParam)
{
    if (code == HC_ACTION) {
        EVENTMSG FAR* pEvent = (EVENTMSG FAR*)lParam;
        // Store event: message, paramL, paramH, time
        record_event(pEvent);
    }
    return CallNextHookEx(hHook, code, wParam, lParam);
}

// Installed by EXE:
hHook = SetWindowsHookEx(WH_JOURNALRECORD,
                          JournalRecordProc,
                          hDllInstance, 0);
```

---

## Startup and Integration

### Auto-start with Windows

Add to `WIN.INI` under `[windows]`:

```ini
load=C:\SHARE\WINMCP.EXE Z:
```

Or add to Startup group in Program Manager.

The command-line argument specifies the drive letter where the magic
directory lives (same as DOS MCP).

### Detection by AI agent

1. Agent sends `WIN META PING` to `__WIN__.TX`
2. If `__WIN__.RX` appears with `OK PONG` within timeout → Windows helper is running
3. If timeout → Windows not running or helper not loaded, use DOS TSR only

### Coexistence with DOS TSR

- Both run simultaneously without conflict
- DOS TSR handles: memory, ports, console, files, DOS internals
- WIN-MCP handles: windows, messages, tasks, DDE, GDI
- AI agent decides which to use based on the command family
- `META VERSION` from each reports its own capabilities

---

## File Layout

```
smb-share/
  share/
    WINMCP.EXE        <- Win16 executable
    WINMCHK.DLL       <- Hook DLL (optional, for RECORD/PLAY)
  winmcp/
    winmcp.c           <- Main application source
    winmchk.c          <- Hook DLL source
    winmcp.h           <- Shared headers
    winmcp.def         <- Module definition file
    winmchk.def        <- DLL module definition file
    winmcp.rc          <- Resource script (icon, version info)
    Makefile            <- Open Watcom build
```

---

## Build (Open Watcom example)

```makefile
CC = wcc
LINK = wlink
CFLAGS = -bt=windows -ml -zW -s

winmcp.exe: winmcp.obj
    $(LINK) system windows name winmcp file winmcp.obj

winmcp.obj: winmcp.c
    $(CC) $(CFLAGS) winmcp.c

winmchk.dll: winmchk.obj
    $(LINK) system windows_dll name winmchk file winmchk.obj

winmchk.obj: winmchk.c
    $(CC) $(CFLAGS) -bd winmchk.c
```

---

## Testing

Testing is harder than the DOS TSR since emu2 doesn't run Windows.
Options:

1. **86Box VM** — run full WFW 3.11, start WINMCP.EXE, test via SMB share
2. **Wine** — Win16 support exists but may be incomplete for ToolHelp/DDE
3. **Manual verification** — run in 86Box, send commands via the magic
   directory from the host, verify responses

A test harness similar to `test-harness.js` can be written, but it must
target the `__WIN__.*` files and account for longer response times (Windows
message pump latency).

---

## Future Considerations

- **OLE Automation:** Windows 3.1 has limited OLE 1.0. OLE 2.0 (Win 3.11)
  adds more automation. Could add `WIN OLE` commands if useful.
- **Clipboard integration:** Windows clipboard is richer than the DOS
  INT 2Fh/17xxh interface. `WIN CLIP` could access CF_BITMAP, CF_METAFILE, etc.
- **Print spooler:** Windows Print Manager APIs for queue management.
- **Network:** WfW 3.11 has WinNet APIs (WNetAddConnection, etc.) for
  network drive/printer management.
- **Registry:** Windows 3.1 has a minimal registry (REG.DAT) accessible
  via RegOpenKey/RegQueryValue. Could add `WIN REG` commands.
