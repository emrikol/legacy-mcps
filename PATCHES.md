# Patched Tools

Legacy MCPs depends on two patched open-source tools. Both are GPL v2. Source code and diffs are included in `tools/`.

---

## emu2 (DOS Emulator)

**Upstream:** [github.com/dmsc/emu2](https://github.com/dmsc/emu2)
**Base commit:** `4948d1e` (2024)
**License:** GPL v2
**Patch file:** [`patches/emu2-mcp.diff`](patches/emu2-mcp.diff)
**Base commit:** [`4948d1e`](https://github.com/dmsc/emu2/commit/4948d1e)

### What was patched and why

emu2 is a lightweight DOS emulator for running .COM/.EXE programs on modern systems. Stock emu2 cannot run TSR programs because it lacks BIOS timer interrupts, the InDOS flag, and TSR keep-process support. These patches add the minimum viable DOS/BIOS infrastructure for TSR operation.

### Patches by file

#### `src/cpu.c` — HLT instruction + software interrupt API

| Change | Why |
|---|---|
| HLT no longer calls `exit(0)` | TSR idle loops use HLT to wait for the next timer interrupt. Stock emu2 treated HLT as program termination. Now sets `exit_cpu` flag so the main loop can trigger timer IRQs and resume. |
| Added `break` after HLT case | Stock code fell through to the next opcode case after HLT. |
| Added `cpuTriggerInt(int_num)` | Public API for triggering software interrupts from C code. Used by the BIOS timer handler to chain INT 1Ch. |

#### `src/dos.c` — DOS kernel enhancements

| Change | Why |
|---|---|
| **INT 21h/34h** — Get InDOS Flag Address | TSRs must check the InDOS flag before calling DOS functions to avoid reentrancy. Returns ES:BX pointing to a 2-byte region (Critical Error flag + InDOS flag). |
| **INT 21h/31h** — Keep Process (TSR) | The core TSR system call. Resizes the program's memory block to keep only the resident portion, then either returns to the parent process or enters a HLT idle loop (if no parent). Handles the IRET stack frame manipulation for both cases. |
| **InDOS flag management** | Increments InDOS on INT 21h entry, decrements on exit. TSRs poll this to know when DOS is safe to call. |
| **INT 28h** — DOS Idle | Temporarily decrements InDOS during idle so TSRs can safely make DOS calls while the system is idle. |
| **O_TRUNC fix** | INT 21h/3Ch (Create File) now passes `O_TRUNC` so existing files are properly truncated. Stock emu2 left old content in place. |
| **fflush() after writes** | File writes are flushed immediately so the host-side test harness sees changes without delay. Critical for file-based IPC. |
| **INT 33h** — Mouse driver | Full mouse driver implementation (reset, show/hide cursor, get/set position, button state, motion counters, range clamping). Includes custom function 0x00FF for setting button state directly. |

#### `src/main.c` — BIOS timer + interrupt dispatch

| Change | Why |
|---|---|
| **INT 08h** — BIOS timer tick | Increments the tick counter at `0040:006Ch` (standard BIOS data area). Chains to INT 1Ch by manipulating the IRET stack frame — pushes an extra return frame so INT 1Ch's IRET returns to the original caller. This is how TSR timer hooks get called. |
| **INT 33h dispatch** | Routes INT 33h to the new mouse driver. |
| **SA_RESTART for timer signals** | Timer signal handler uses `SA_RESTART` so interrupted syscalls (like file reads) automatically restart instead of failing with EINTR. |

#### `src/video.c` — Headless mode

| Change | Why |
|---|---|
| TTY open failure is non-fatal | Stock emu2 calls `print_error()` (which exits) if `/dev/tty` isn't available. Patched to fall back to headless mode — initializes video state but skips screen output. Enables running in CI/background without a terminal. |
| Null check before screen writes | `check_screen()` and `exit_video()` skip output if `tty_file` is NULL (headless). |

### Building from source

```bash
# Clone upstream and apply patch
git clone https://github.com/dmsc/emu2.git tools/emu2-src
cd tools/emu2-src
git checkout 4948d1e
git apply ../../patches/emu2-mcp.diff

# Build
make

# Install patched binary
cp emu2 ../emu2
cd ../..
```

---

## DOSBox-X (DOS/Windows Emulator)

**Upstream:** [github.com/joncampbell123/dosbox-x](https://github.com/joncampbell123/dosbox-x)
**Base version:** 2026.03.06 (commit [`59915c1`](https://github.com/joncampbell123/dosbox-x/commit/59915c1))
**License:** GPL v2
**Patch file:** [`patches/dosbox-x-mcp.diff`](patches/dosbox-x-mcp.diff)

### What was patched and why

Three categories of patches:

1. **ARM64 OpenGL crash fix** — DOSBox-X's OpenGL rendering crashes on Apple Silicon Macs
2. **Control server** — A TCP server for external automation (screenshots, screen reading, keyboard input)
3. **Screenshot notification** — Hook for the control server to know when a screenshot completes

### Patches by file

#### `src/gui/dosbox_control_server.cpp` — NEW FILE (360 lines)

A TCP server on localhost for external control of DOSBox-X. Accepts text commands over a socket, returns text responses. Enabled via the `DOSBOX_CONTROL_PORT` environment variable (default: disabled).

| Command | Response | Description |
|---|---|---|
| `PING` | `OK PONG` | Liveness check |
| `STATUS` | `OK PROGRAM=NOTEPAD CAPTURE_DIR=...` | Current running program, capture directory |
| `SCREENSHOT [path]` | `OK SCREENSHOT` | Trigger screen capture to PNG, waits up to 5s for completion |
| `SCREEN` | `(rows of text)` | Read VGA text buffer (B800:0000). Reads dimensions from BIOS data area. Returns `ERR GRAPHICS_MODE` in non-text modes. |
| `TYPE <text>` | `OK` | Simulate keyboard input via KEYBOARD_AddKey. Full keymap for a-z, A-Z, 0-9, symbols, shifted symbols. Escape sequences: `\n`=Enter, `\t`=Tab, `\e`=Escape. 20ms key-down delay, 30ms between keys. |
| `KEY <name>` | `OK` | Press/release a special key. Names: ENTER, ESC, TAB, SPACE, UP, DOWN, LEFT, RIGHT, F1-F12, BACKSPACE, DELETE, HOME, END, PGUP, PGDN, INSERT. Single letters (A-Z) go through BIOS buffer. |
| `QUIT` | (process exits) | Immediate `_exit(0)` |

**Architecture:** Runs in a detached background thread. Binds to 127.0.0.1 only (not network-accessible). Uses select() with 1-second timeout for clean shutdown. One connection at a time (sequential request/response).

**Usage from shell:**

```bash
# Start DOSBox-X with control server on port 10199
DOSBOX_CONTROL_PORT=10199 ./dosbox-x -conf myconf.conf

# Send commands via netcat
echo "PING" | nc -w 5 127.0.0.1 10199
echo "SCREEN" | nc -w 5 127.0.0.1 10199
echo "TYPE Hello World\n" | nc -w 5 127.0.0.1 10199
echo "SCREENSHOT /tmp/shot.png" | nc -w 5 127.0.0.1 10199
```

A convenience script `dosbox-ctl.sh` wraps the netcat call.

#### `src/gui/sdlmain.cpp` — Control server init + ARM64 OpenGL fix

| Change | Why |
|---|---|
| ARM64 OpenGL exclusion | `!defined(__arm64__)` added to OpenGL default selection. Prevents GL crashes on Apple Silicon by falling back to surface rendering. Intel Macs still use OpenGL. |
| Control server initialization | Reads `DOSBOX_CONTROL_PORT` env var at startup. If set and > 0, calls `ControlServer_Init(port)` to start the TCP server thread. |

#### `src/gui/Makefile.am` — Build system

Added `dosbox_control_server.cpp` to the source file list.

#### `src/hardware/hardware.cpp` — Screenshot completion notification

Added a callback check after screenshot save: calls `ControlServer_ScreenshotComplete()` if `ControlServer_ScreenshotRequested()` returns true. This lets the SCREENSHOT command block until the capture is actually written to disk.

### Building from source

```bash
# Clone upstream and apply patch
git clone https://github.com/joncampbell123/dosbox-x.git tools/dosbox-x-src
cd tools/dosbox-x-src
git checkout 59915c1
git apply ../../patches/dosbox-x-mcp.diff

# Build (macOS)
./autogen.sh
./configure --enable-sdl2
make -j$(nproc)

# Install patched binary
cp src/dosbox-x ../dosbox-x
cd ../..
```

### Additional vendored patches

The DOSBox-X source tree also contains standard integration patches that are part of the upstream project:

- `patch-integration/SDL-12hg-win32.diff` — SDL 1.2 mouse handling fixes for DirectInput
- `vs/freetype/src/gzip/patches/freetype-zlib.diff` — zlib compatibility shim for FreeType
- `patch-integration/Skipped SVN commits.txt` — Notes on ~80 intentionally skipped DOSBox SVN commits during S3Virge graphics merge
