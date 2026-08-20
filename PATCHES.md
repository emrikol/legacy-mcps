# Patched emulators

Legacy MCPs uses small, reviewable patch sets for emu2 and DOSBox-X. The
patches are the corresponding source for the modified GPL programs; the
repository does not redistribute an emulator binary.

## emu2

- Upstream: [dmsc/emu2](https://github.com/dmsc/emu2)
- Base: [`4948d1e`](https://github.com/dmsc/emu2/commit/4948d1e)
- Patch: [`patches/emu2-mcp.diff`](patches/emu2-mcp.diff)

The emu2 patch adds the DOS and BIOS behavior needed by the resident DOS MCP:
timer interrupts and `INT 1Ch` chaining, the InDOS flag, terminate-and-stay-
resident handling, DOS-idle dispatch, immediate host-visible file writes, a
basic `INT 33h` mouse driver, and operation without a controlling terminal.
It also fixes truncation when DOS creates an existing file.

```bash
git clone https://github.com/dmsc/emu2.git tools/emu2-src
git -C tools/emu2-src checkout 4948d1e
git -C tools/emu2-src apply ../../patches/emu2-mcp.diff
make -C tools/emu2-src
cp tools/emu2-src/emu2 tools/emu2
```

## DOSBox-X

- Upstream: [joncampbell123/dosbox-x](https://github.com/joncampbell123/dosbox-x)
- Base: [`6139ebb37ff52591017c0d511b6696be4029c853`](https://github.com/joncampbell123/dosbox-x/commit/6139ebb37ff52591017c0d511b6696be4029c853)
- Series: [`patches/dosbox-x/series/`](patches/dosbox-x/series/)
- Manifest: [`patches/dosbox-x/manifest.json`](patches/dosbox-x/manifest.json)
- Source contract: [`patches/dosbox-x/source-contract.json`](patches/dosbox-x/source-contract.json)

DOSMCP and WINMCP use the separate checked contract in
[`scripts/guest-tool-source-contract.json`](scripts/guest-tool-source-contract.json).
Run `node scripts/update-guest-tool-identities.js --check` to reject stale
guest-agent identity headers before publishing their binaries.

The ordered 19-patch series adds:

1. Correct PNG color conversion for macOS SDL screenshots.
2. Modifier-aware `KEY` input and a main-thread `CLICK` implementation.
3. A loopback TCP control server with status, capture, text-screen, keyboard,
   mouse, minimize, identity, and shutdown commands.
4. A remote protected-mode debugger: pause/run control, registers, selectors,
   memory, disassembly, stack inspection, stepping, finish, breakpoints,
   interrupt/exception filters, watchpoints, and atomic stopped-CPU batches.
5. Explicitly unsafe, audited register and memory mutation.
6. Bounded DOS file-service observation, Win16 API tracing, code coverage,
   stopped-render snapshots, checkpoints, selected-memory hashes, instruction-
   sequenced input, and replay-dependency recording/verification.
7. Deferred logical NE API probes, including image-bound matching across
   selector reloads.

The debugger code requires a DOSBox-X build with `C_DEBUG` and
`C_HEAVY_DEBUG`. Select DOSBox-X's heavy-debug configuration for the platform
being built; a non-debug build retains the basic control server but rejects
debugger operations.

### Apply and build

The helper clones the exact public base and applies every mail patch in order:

```bash
scripts/apply-dosbox-x-patches.sh tools/dosbox-x-src
```

Before fetching source, it verifies the manifest schema, ordered inventory,
patch SHA-256 values, and declared base. After applying, it verifies the final
Git tree and source-contract identity. The checks can also be run separately:

```bash
node scripts/verify-dosbox-x-patches.js
node scripts/verify-dosbox-x-patches.js --source-root tools/dosbox-x-src
```

You can perform the same operation manually:

```bash
git clone https://github.com/joncampbell123/dosbox-x.git tools/dosbox-x-src
git -C tools/dosbox-x-src checkout 6139ebb37ff52591017c0d511b6696be4029c853
git -C tools/dosbox-x-src am "$PWD"/patches/dosbox-x/series/*.patch
```

On macOS, run the patched `build-macos` script from that source tree. For an
Autotools build, run `./autogen.sh`, configure SDL2 plus the heavy debugger,
and build normally. Exact switches vary with DOSBox-X's platform toolchain;
confirm that `IDENTITY` advertises `DEBUG_PROTOCOL=1` before relying on remote
debug commands.

### Reproducible identity

`IDENTITY` returns a `BUILD` value derived from the exact patched files listed
in the source contract. Refresh the generated header after changing any
contract member, or verify that it is already current:

```bash
node scripts/update-dosbox-x-identity.js tools/dosbox-x-src
node scripts/update-dosbox-x-identity.js --check tools/dosbox-x-src
node scripts/verify-dosbox-identity.js --port 10199
```

The build ID proves equality of the declared source set. It does not by itself
prove compiler flags, linked libraries, runtime configuration, guest media, or
deterministic execution.

### Control protocol and security boundary

Set `DOSBOX_CONTROL_PORT` before launching the patched emulator. If the
variable is unset, the server is disabled. The server binds to `127.0.0.1` and
serves one request per connection:

```bash
DOSBOX_CONTROL_PORT=10199 tools/dosbox-x -conf guest.conf
printf 'IDENTITY\n' | nc -w 5 127.0.0.1 10199
printf 'DEBUG STATUS\n' | nc -w 5 127.0.0.1 10199
```

Loopback is a host boundary, not an authentication boundary. There is no
authentication or authorization: any local process that can reach the port can
read guest state, control input and execution, capture screens, and request
unsafe mutation. Use an isolated host/session, do not expose the port through a
proxy or forwarded socket, and treat a session as manipulated after a
successful `DEBUG MUTATE`.

The control server is intentionally single-request and sequential. Use
`DEBUG BATCH` for a coherent set of read-only stopped-CPU observations. Render
snapshots are bounded and require a stopped CPU, but they are not a transaction
with unrelated guest or device state. Deterministic replay is conditional: it
requires matching checkpoints, input sequence, recorded clocks, DOS reads,
interrupts, NMI activity, build identity, and runtime configuration. A green
replay-dependency check is evidence for those recorded inputs only, not a claim
that all emulator behavior is deterministic.

See [SCRIPTING.md](SCRIPTING.md) for the Node.js client and debugger examples.
