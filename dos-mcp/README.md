# DOS MCP — DOS Remote Control TSR

An 8086 DOS TSR (Terminate and Stay Resident) that hooks the timer interrupt and exposes DOS/BIOS APIs via file-based IPC. Runs headlessly in emu2 or under DOSBox-X.

## Overview

DOSMCP.COM is a ~27KB .COM binary written in NASM assembly that:

1. Installs an INT 08h (timer) hook that fires ~2 times/second
2. On each tick, checks the InDOS flag for safe DOS reentrancy
3. Polls `_MAGIC_\__MCP__.TX` for commands
4. Dispatches commands to DOS/BIOS interrupt handlers
5. Writes responses to `_MAGIC_\__MCP__.RX`

In TSR mode (`/T` flag), it returns to DOS after installation — other programs can run while it polls in the background. In foreground mode (no flag), it busy-loops for maximum responsiveness.

## Building

```bash
make                  # Assemble DOSMCP.COM (requires nasm)
make test             # Build + run 153 tests in emu2 (headless, TSR mode)
make testgui          # Build + run tests in DOSBox-X (needs display, TSR mode)
```

## Running

```
C:\> DOSMCP.COM Z:        # Foreground mode (blocks DOS prompt)
C:\> DOSMCP.COM Z: /T     # TSR mode (installs and returns to DOS)
```

The argument specifies the drive letter where `_MAGIC_/` lives.

## Command Reference

All commands are plain text written to `__MCP__.TX`. Responses appear in `__MCP__.RX`.

Parameters in `<angle brackets>` are required. Parameters in `[square brackets]` are optional. Hex values are written without prefix (e.g., `0040` not `0x0040`). Version: MCP/0.10.

---

### META — Lifecycle and Diagnostics

| Command | Response | Description |
|---|---|---|
| `META PING` | `OK PONG` | Liveness check |
| `META VERSION` | `OK MCP/0.10 META,MEM,...` | Version and capability list |
| `META STATUS` | `OK V0.10 CMDS=42 DEBUG=0 POLL=9 TIMEOUT=36` | Runtime stats |
| `META HEARTBEAT` | `OK` | Reset watchdog timer |
| `META LOG ON` | `OK` | Enable debug logging |
| `META LOG OFF` | `OK` | Disable debug logging |
| `META LASTERROR` | `OK err=0 class=0 action=0 locus=0` | Last DOS extended error |
| `META UNLOAD` | `OK UNLOADED` or `ERR NOT_TSR` | Remove TSR from memory |
| `META DELAY <ms>` | `OK` | Busy-wait delay |
| `META BATCH\n<cmd>` | (result of cmd) | Execute command from next line |
| `META REPEAT <n> <cmd>` | (result of last) | Repeat a command n times |

---

### MEM — Memory Access

Read, write, search, and inspect arbitrary memory via segment:offset addressing.

| Command | Response | Description |
|---|---|---|
| `MEM PEEK <seg>:<off> [count]` | `OK 4D 5A` | Read bytes (hex) |
| `MEM POKE <seg>:<off> <bytes...>` | `OK` | Write bytes |
| `MEM READ <seg>:<off> [count]` | `OK AA BB` | Alias for PEEK |
| `MEM WRITE <seg>:<off> <bytes...>` | `OK` | Alias for POKE |
| `MEM DUMP <seg>:<off> <count>` | `OK 41 42 43 44` | Read bytes (same as PEEK) |
| `MEM FILL <seg>:<off> <count> <byte>` | `OK` | Fill memory with a byte |
| `MEM COPY <src_seg>:<src_off> <dst_seg>:<dst_off> <count>` | `OK` | Copy memory block |
| `MEM SEARCH <seg>:<off> <len> <bytes...>` | `OK 0050:0080` or `ERR NOT_FOUND` | Search for byte pattern |
| `MEM FREE` | `OK 580K` | Largest free conventional memory block |
| `MEM MCB` | `OK 072F:COMMAND:2480b ...` | Walk Memory Control Blocks |
| `MEM EMS` | `OK VER=4.0 TOTAL=256 FREE=240` or `ERR NO_EMS` | EMS memory status |
| `MEM XMS` | `OK VER=3.0 FREE=8192K HMA=YES` or `ERR NO_XMS` | XMS memory status |

**Example — read BIOS keyboard flags and timer tick:**

```
→ MEM PEEK 0040:0017
← OK 00
→ MEM PEEK 0040:006C 4
← OK A3 1F 00 00
→ MEM SEARCH 0050:0000 256 DE AD BE EF
← OK 0050:0080
```

---

### PORT — I/O Port Access

| Command | Response | Description |
|---|---|---|
| `PORT IN <port>` | `OK FB` | Read byte from I/O port (hex) |
| `PORT OUT <port> <byte>` | `OK` | Write byte to I/O port |

---

### CON — Console / Text Mode Screen

| Command | Response | Description |
|---|---|---|
| `CON READ <row> [count]` | `OK Hello World` | Read text from screen row(s) |
| `CON WRITE <row> <col> <attr> <text>` | `OK` | Write text to screen at position |
| `CON CURSOR GET` | `OK 5 10` | Get cursor position (row col) |
| `CON CURSOR SET <row> <col>` | `OK` | Set cursor position |
| `CON COLOR [attr]` | `OK 07` (get) or `OK` (set) | Get/set text attribute |
| `CON MODE` | `OK mode=03 cols=80 rows=25 page=0` | Get video mode and dimensions |
| `CON ATTR <row> <count>` | `OK 07 07 07 1E 1E` | Read attribute bytes from screen |
| `CON REGION <r1> <c1> <r2> <c2>` | `OK ABC` | Read rectangular text region |
| `CON CLEAR [r1 c1 r2 c2 attr]` | `OK` | Clear screen (full or region with attr) |
| `CON SCROLL UP <lines>` | `OK` | Scroll text up |
| `CON INPUT` | `OK <text>` or `OK` (empty) | Read keyboard buffer |
| `CON FIND <text>` | `OK 0,0` or `OK` (not found) | Search screen for text |
| `CON BOX <r1> <c1> <r2> <c2> <attr> <SINGLE\|DOUBLE>` | `OK` | Draw box with border chars |
| `CON CRC [row count]` | `OK A3F1` | CRC-16 of screen content (change detection) |

**Example — write text, read it back, draw a box:**

```
→ CON WRITE 0 0 07 TEST1234
← OK
→ CON READ 0 1
← OK TEST1234
→ CON BOX 5 10 4 20 07 SINGLE
← OK
```

---

### GFX — Graphics Mode

| Command | Response | Description |
|---|---|---|
| `GFX PIXEL <x> <y>` | `OK 4` | Read pixel color via INT 10h |
| `GFX PALETTE GET <index>` | `OK 3F:00:3F` | Read DAC register (R:G:B) |
| `GFX PALETTE SET <index> <R> <G> <B>` | `OK` | Write DAC register |
| `GFX VESA MODE` | `OK 0103` or `ERR NO_VESA` | Current VESA mode |
| `GFX VESA INFO` | `OK VER=2.0 MEM=4096KB` or `ERR NO_VESA` | VESA controller info |

---

### SCREEN — Screen Capture

| Command | Response | Description |
|---|---|---|
| `SCREEN DUMP` | `OK` | Dump text screen to `__MCP__.SCR` file |

---

### MOUSE — INT 33h Mouse Driver

| Command | Response | Description |
|---|---|---|
| `MOUSE MOVE <x> <y>` | `OK` | Set cursor position |
| `MOUSE CLICK [x y] [button]` | `OK` | Click at position (1=left, 2=right) |
| `MOUSE DBLCLICK [x y]` | `OK` | Double-click |
| `MOUSE DOWN [button]` | `OK` | Press button (hold) |
| `MOUSE UP [button]` | `OK` | Release button |
| `MOUSE DRAG <x1> <y1> <x2> <y2>` | `OK` | Drag from (x1,y1) to (x2,y2) |

---

### KEY — Keyboard

| Command | Response | Description |
|---|---|---|
| `KEY SEND <chars>` | `OK` | Stuff characters into BIOS keyboard buffer |
| `KEY TYPE <text>` | `OK` | Type text (underscore = space) |
| `KEY HOTKEY <mod>+<scancode>` | `OK` | Press modifier+key combo (ALT, CTRL, SHIFT) |
| `KEY DOWN <key>` | `OK` | Press key (hold). Key names: LSHIFT, CTRL, etc. or hex scan code |
| `KEY UP <key>` | `OK` | Release key |
| `KEY FLUSH` | `OK` | Clear keyboard buffer |
| `KEY PEEK` | `OK <scan> <ascii>` or `OK EMPTY` | Check buffer without removing |

**Example — type text, verify shift key modifies BIOS flags:**

```
→ KEY TYPE hello
← OK
→ KEY DOWN LSHIFT
← OK
→ MEM PEEK 0040:0017 1
← OK 02                    # Bit 1 = Left Shift active
→ KEY UP LSHIFT
← OK
→ KEY HOTKEY ALT+0x3F
← OK                       # Alt+F5
```

---

### WAIT — Wait for Conditions

| Command | Response | Description |
|---|---|---|
| `WAIT SCREEN <text> <ticks>` | `OK <row> <col>` or `ERR TIMEOUT` | Wait for text to appear on screen |
| `WAIT GONE <text> <ticks>` | `OK` or `ERR TIMEOUT` | Wait for text to disappear |
| `WAIT SLEEP <ticks>` | `OK` | Delay (18.2 ticks/second) |
| `WAIT PIXEL <x> <y> <color> <ticks>` | `OK` or `ERR TIMEOUT` | Wait for pixel to match color |
| `WAIT CRC <expected> <ticks>` | `OK` or `ERR TIMEOUT` | Wait for screen CRC to match |

---

### FILE — File Operations

| Command | Response | Description |
|---|---|---|
| `FILE READ <path> <off> <len>` | `OK 48 65 6C 6C 6F` | Read bytes from file (hex) |
| `FILE WRITE <path> <off> <bytes...>` | `OK 5` | Create/write file, returns bytes written |
| `FILE APPEND <path> <bytes...>` | `OK 2` | Append bytes, returns count |
| `FILE DELETE <path>` | `OK` or `ERR FILE_NOT_FOUND` | Delete file |
| `FILE RENAME <old> <new>` | `OK` | Rename file |
| `FILE COPY <src> <dst>` | `OK 1024` | Copy file, returns bytes copied |
| `FILE EXISTS <path>` | `OK 1` or `OK 0` | Check existence |
| `FILE SIZE <path>` | `OK 27287` | Get file size in bytes |
| `FILE TIME <path>` | `OK 2026-03-14 02:30:45` | Get modification timestamp |
| `FILE FIND <pattern>` | `OK DOSMCP.COM CONFIG.SYS ...` or `ERR NOT_FOUND` | Wildcard search |
| `FILE ATTR GET <path>` | `OK R=0 H=0 S=0 A=1` | Get attributes (Read-only, Hidden, System, Archive) |
| `FILE ATTR SET <path> <+/-flags>` | `OK` | Set attributes (e.g., `+R`, `-A`) |
| `FILE WATCH <path>` | `OK CHANGED` or `OK UNCHANGED` | Change detection (compares size+time) |

**Example:**

```
→ FILE WRITE C:\TEST.TXT 0 48 65 6C 6C 6F
← OK 5
→ FILE EXISTS C:\TEST.TXT
← OK 1
→ FILE SIZE C:\TEST.TXT
← OK 5
→ FILE READ C:\TEST.TXT 0 4
← OK 48 65 6C 6C
→ FILE ATTR GET C:\TEST.TXT
← OK R=0 H=0 S=0 A=1
→ FILE DELETE C:\TEST.TXT
← OK
```

---

### DIR — Directory Operations

| Command | Response | Description |
|---|---|---|
| `DIR LIST [path]` | `OK DOSMCP.COM AUTOEXEC.BAT ...` | List directory |
| `DIR MAKE <path>` | `OK` | Create directory |
| `DIR CHANGE <path>` | `OK C:\NEWDIR` | Change current directory, returns new path |
| `DIR GET` | `OK C:\` | Get current directory |
| `DIR DRIVES` | `OK A:FD C:HD Z:NET` | List drives with types (FD/HD/NET/CD/RAM) |

---

### DISK — Disk Information

| Command | Response | Description |
|---|---|---|
| `DISK FREE [drive]` | `OK 12345678 524288000` | Free bytes and total bytes |

---

### EXEC — Program Execution

| Command | Response | Description |
|---|---|---|
| `EXEC SHELL <command>` | `OK <exit_code>` | Run via COMMAND.COM /C |
| `EXEC EXIT` | `OK <exit_code>` | Get last exit code |
| `EXEC LIST` | `OK <mcb_chain>` | List running processes (MCB walk) |
| `EXEC RUN <program> [args]` | `OK <exit_code>` | Run program directly |

---

### TIME — Date/Time

| Command | Response | Description |
|---|---|---|
| `TIME GET` | `OK 2026-03-14 02:30:45` | Current date and time |
| `TIME SET <date> <time>` | `OK` | Set date and time (YYYY-MM-DD HH:MM:SS) |

---

### INI — INI File Access

| Command | Response | Description |
|---|---|---|
| `INI READ <file> <section> <key>` | `OK HelloWorld` or `ERR NOT_FOUND` | Read value |
| `INI WRITE <file> <section> <key> <value>` | `OK` | Write value |

---

### CLIP — Clipboard

| Command | Response | Description |
|---|---|---|
| `CLIP GET` | `OK <text>` or `ERR CLIPBOARD_UNAVAILABLE` | Read DOS clipboard (INT 2Fh) |
| `CLIP SET <text>` | `OK` or `ERR CLIPBOARD_UNAVAILABLE` | Write DOS clipboard |

Note: Clipboard requires Windows enhanced mode. Returns `ERR CLIPBOARD_UNAVAILABLE` in plain DOS.

---

### CMOS — CMOS/RTC Registers

| Command | Response | Description |
|---|---|---|
| `CMOS READ <reg>` | `OK 3F` | Read register (port 70h/71h, hex) |
| `CMOS WRITE <reg> <value>` | `OK` | Write register |

---

### ENV — Environment Variables

| Command | Response | Description |
|---|---|---|
| `ENV GET <name>` | `OK C:\WINDOWS;C:\DOS` or `ERR NOT_FOUND` | Read variable |
| `ENV SET <name> [value]` | `OK` | Set variable (omit value to delete) |

**Example:**

```
→ ENV GET PATH
← OK C:\WINDOWS;C:\DOS
→ ENV SET MCPTEST hello123
← OK
→ ENV GET MCPTEST
← OK hello123
→ ENV SET MCPTEST
← OK                       # Deleted
```

---

### SYS — System Information

| Command | Response | Description |
|---|---|---|
| `SYS INFO` | `OK DOS=6.22 CPU=386 ...` | DOS version, CPU type |
| `SYS MEMORY` | `OK CONV=640K FREE=580K ...` | Memory statistics |
| `SYS DRIVERS` | `OK NUL CON AUX PRN ...` | Installed device drivers |
| `SYS ANSI` | `OK 1` or `OK 0` | ANSI.SYS installed? |
| `SYS BEEP` | `OK` | System beep |
| `SYS TONE <freq> <ms>` | `OK` | Play tone via PC speaker |
| `SYS QUIET` | `OK` | Stop sound |
| `SYS REBOOT` | (system reboots) | Warm reboot |

---

### INT — Interrupt Calls

| Command | Response | Description |
|---|---|---|
| `INT CALL <num> <AX> <BX> <CX> <DX>` | `OK AX=0006 BX=0000 CX=0000 DX=0000 CF=0` | Invoke any interrupt |
| `INT LIST <start> <count>` | `OK 08=F000:FEA5 09=F000:E987 ...` | Dump interrupt vector table |
| `INT WATCH <num> <ticks>` | `OK 36` | Count how many times an interrupt fires |

**Example — get DOS version via INT 21h/AH=30h:**

```
→ INT CALL 21 3000 0000 0000 0000
← OK AX=0006 BX=0000 CX=0000 DX=0000 CF=0
```

---

### POWER — Power Management

| Command | Response | Description |
|---|---|---|
| `POWER STATUS` | `OK APM=1.2 AC=ON BAT=100%` or `ERR NO_APM` | APM status |
| `POWER IDLE` | `OK` | CPU idle (HLT) |
| `POWER STANDBY` | `OK` or `ERR NO_APM` | APM standby |
| `POWER OFF` | (system halts) | APM shutdown |

---

### TSR — TSR Status

| Command | Response | Description |
|---|---|---|
| `TSR LIST` | `OK 0F47:MCP:27287b 072F:COMMAND:2480b` | List TSRs with sizes |

---

## Implementation Details

- **Timer hook:** INT 08h fires ~18.2 times/second. The TSR debounces to ~2 polls/second (every 9 ticks).
- **InDOS safety:** Checks the InDOS flag (INT 21h/34h) before every command dispatch. If DOS is busy, the tick is skipped.
- **Stack switching:** The TSR maintains a private 256-byte stack, swapped in/out on each tick to avoid corrupting the interrupted program's stack.
- **PSP/DTA save/restore:** Saves and restores the caller's Program Segment Prefix and Disk Transfer Area before/after command dispatch.
- **INT 2Fh multiplex:** Responds to AH=C0h for installation detection (prevents double-install).
- **Memory layout:** Resident code, data, BSS, and stack are packed first. Initialization code lives past `resident_end` and is discarded after TSR install.
- **8086 compatible:** No 286+ instructions. Runs on any x86 processor.
- **22 command families, 80+ individual commands, 153 passing tests.**
