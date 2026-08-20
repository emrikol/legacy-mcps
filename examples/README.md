# Host automation examples

These examples require a running disposable DOS or Windows 3.x guest with the
matching MCP binary and a host-visible `share/_MAGIC_` directory. Windows 3.x
and application media are not included.

- `notepad.js` and `minesweeper.js` use the Playwright-like `WinAuto` API under
  one advisory host lease. The session helper waits for readiness and verifies
  the guest's reported source identity before the example callback runs.
- `dos-sysinfo.js` demonstrates source-identity-verified, serialized DOSMCP
  inspection. Identity verification checks compatibility; it does not
  authenticate the guest or share.
- `dosbox-debugger.js` demonstrates a stopped-CPU debugger batch.
- `win-memory-snapshot.json` is an illustrative, generic NOTEPAD segment-range
  manifest for `bin/winmcp-snapshot.js`; loaded segment layouts are runtime
  facts, so treat captures as diagnostic and non-atomic.
- `win-sequences/health-check.json` is a bounded literal WINMCP sequence for
  `bin/winmcp.js sequence`.

The mailbox and loopback debugger interfaces are privileged and
unauthenticated. Use isolated guests and do not expose the DOSBox-X TCP port.
If a host command becomes uncertain, replace or reset the disposable guest
before using the corresponding CLI's explicit `reset --confirm-guest-reset`
operation. That operation clears retained host state; it does not reset the
guest or restore pristine evidence after a mutation.
