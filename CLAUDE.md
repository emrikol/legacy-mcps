# Legacy MCPs — Claude Project Context

## What this is

Two remote control agents for legacy operating systems, communicating via file-based IPC:

- **dos-mcp/** — 8086 DOS TSR (Terminate and Stay Resident) written in NASM assembly
- **win-mcp/** — Win16 application written in C (Open Watcom), targeting Windows 3.x

Both agents poll a magic directory for command files, execute OS-level operations, and write responses back. They share the same protocol but operate independently — the DOS TSR handles real-mode DOS, the Win16 app handles protected-mode Windows APIs.

A host-side scripting library (`lib/win-auto.js`) provides a Playwright-style async API for driving the Win16 agent from Node.js.

---

## Key files

| File | Purpose |
|---|---|
| `dos-mcp/src/dosmcp.asm` | DOS TSR source (8086 assembly) |
| `dos-mcp/src/DOSMCP.COM` | Compiled DOS TSR binary |
| `win-mcp/src/winmcp.c` | Win16 MCP source (C, ~2000 lines) |
| `win-mcp/src/WINMCP.EXE` | Compiled Win16 NE executable |
| `win-mcp/src/WINMCHK.DLL` | Hook DLL for journal record/playback |
| `lib/win-auto.js` | Node.js scripting library (Playwright-style API) |
| `share/` | IPC directory — magic files live in `share/_MAGIC_/` |
| `tools/` | Build tools (Watcom, DOSBox-X, emu2) |

---

## Building

### Win16 MCP

```bash
cd win-mcp/src && make        # Compile WINMCP.EXE
cd win-mcp && make testwin    # Build + boot Win3.1 + run 75 tests
```

### DOS MCP

```bash
cd dos-mcp && make            # Assemble DOSMCP.COM
cd dos-mcp && make test       # TSR mode test via emu2 (headless)
cd dos-mcp && make testgui    # TSR mode test via DOSBox-X (needs display)
```

---

## IPC Protocol

Both agents use the same protocol:

1. Host writes command to `__WIN__.TX` (or `__MCP__.TX`)
2. Agent polls, reads command, deletes TX file
3. Agent executes command via OS APIs
4. Agent writes response to `__WIN__.RX` (or `__MCP__.RX`)
5. Host reads response, deletes RX file

Status: `__WIN__.ST` / `__MCP__.ST` = `READY` when initialized.

Response format: `OK <result>` or `ERR <code> [details]`

---

## Tools

All in `tools/`:

| Tool | What | Notes |
|---|---|---|
| `watcom/` | Open Watcom 2.0 | Cross-compiles Win16 from macOS ARM64 |
| `dosbox-x` | DOSBox-X | Patched: ARM64 GL fix + TCP control server |
| `dosbox-x-src/` | DOSBox-X source | GPL v2, patches in-tree + `mcp-patches.diff` |
| `emu2` | emu2 DOS emulator | Patched for TSR support (headless testing) |
| `emu2-src/` | emu2 source + patches | GPL v2, `mcp-patches.diff` against `dmsc/emu2@4948d1e` |
| `win31-hdd/` | Minimal Win3.1 install | Used by DOSBox-X for `make testwin` |

---

## Gotchas

- **`make testwin` needs a display** — DOSBox-X boots a GUI window.
- **`make test` (dos-mcp) is headless** — uses emu2, no display needed.
- **`make testgui` (dos-mcp) needs 180s timeout** — DOSBox-X is slower than emu2 for 153 tests.
- **emu2 patches are critical** — the stock emu2 binary cannot run TSR mode. Use the patched binary in `tools/emu2`.
- **DOSBox-X control server** — enabled via `DOSBOX_CONTROL_PORT=10199` env var. See PATCHES.md.
- **Port 139 requires sudo** if testing with the SMB share connected.
