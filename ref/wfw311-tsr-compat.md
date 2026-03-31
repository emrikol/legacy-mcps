# TSR Behavior Under Windows for Workgroups 3.11 (386 Enhanced Mode)

Research compiled 2026-03-12. Based on Microsoft KB articles, Windows 3.1 DDK
documentation, and community technical references.

---

## 1. Architecture Overview

WFW 3.11 **only** runs in 386 Enhanced Mode. There is no Standard or Real mode
option.

In 386 Enhanced Mode, the Virtual Machine Manager (VMM) — part of WIN386.EXE —
uses the 80386's Virtual 8086 (V86) mode to create multiple virtual machines:

- **System VM** — hosts the Windows GUI, all Windows applications, and any DOS
  TSRs/device drivers that were loaded before Windows started (via CONFIG.SYS
  and AUTOEXEC.BAT).
- **DOS VMs** — one per DOS box opened from within Windows. Each runs in its own
  V86 task, preemptively scheduled by the VMM.

Inside the System VM, Windows applications are cooperatively scheduled (the
normal Windows 3.1 message loop model). The System VM itself is preemptively
scheduled against DOS VMs.

---

## 2. Where Does a Pre-Windows TSR Live?

A TSR loaded in AUTOEXEC.BAT before `WIN.COM` is launched becomes part of the
**System VM**. It does not automatically appear in DOS VMs opened later.

### Global vs. Local (Instance Data)

By default, Windows treats all DOS memory (including TSR code and data) as
**global** — shared across all VMs. This is a compatibility measure: old
single-tasking drivers assume there is only one copy of hardware state.

However, certain memory ranges can be declared as **instance data**, meaning
each VM gets its own private copy of those bytes. The VMM snapshots instance
data when creating a new VM and maintains separate copies thereafter.

Instance data is declared in two ways:

1. **By VxDs** at initialization time (e.g., WINA20.386 instances the A20 line
   state).
2. **By TSRs** that respond to the INT 2Fh/1605h "Windows Initialization
   Notification" broadcast. A TSR can register instance data ranges so that each
   new DOS VM gets its own copy of the TSR's state variables.

If a TSR does **not** register instance data, its data segment is shared
(global) across all VMs. This means the System VM's TSR and any DOS VMs all see
the same memory — which can cause corruption if the TSR is not reentrant.

### The LocalTSRs Setting

```ini
[NonWindowsApp]
LocalTSRs=<comma-separated list of TSR names>
```

- Default: `DOSedit, ced`
- When a TSR name appears in this list, Windows copies the entire TSR into each
  new DOS VM.
- **Warning from Microsoft:** "Many TSRs will not run properly if they are added
  to this list." Only TSRs that maintain purely local state (no hardware access,
  no shared files) are candidates.

**For our use case:** We should NOT add our TSR to LocalTSRs. We want exactly
one instance running in the System VM, polling a network share. Copying it into
DOS VMs would create multiple pollers fighting over the same files.

---

## 3. Timer Interrupt Virtualization (INT 08h / INT 1Ch)

### How It Works

The **Virtual Timer Device (VTD)** VxD virtualizes the 8253/8254 timer chip.
INT 08h (hardware timer, IRQ 0) fires approximately 18.2 times per second.
INT 1Ch is a software interrupt chained from INT 08h — the BIOS calls it on
every tick as a "user timer tick" hook.

In 386 Enhanced Mode:

- The VTD intercepts the real hardware timer interrupt.
- It **reflects** (simulates) INT 08h and INT 1Ch into each VM according to
  scheduling rules.
- The active (foreground) VM gets timer ticks at full rate.
- Background and idle VMs get reduced or no timer ticks, depending on settings.

### Idle VM Timer Behavior

By default, if a VM is idle (no pending work), Windows will **not** deliver
timer interrupts to it. This is controlled by:

```ini
[386Enh]
IdleVMWakeUpTime=<seconds>
```

- Default: **8**
- Forces timer interrupts into idle VMs after the specified number of seconds.
- Value is rounded down to the nearest power of 2 (1, 2, 4, 8, 16, 32, 64).

**Critical for our TSR:** If our TSR runs in the System VM and hooks INT 1Ch
for periodic polling, it will receive timer ticks as long as the System VM is
active — which it almost always is when Windows is running (Windows GUI lives
in the System VM). However, if all Windows apps are idle and the user is working
in a full-screen DOS box, the System VM may go idle and timer ticks could be
delayed up to `IdleVMWakeUpTime` seconds.

**Recommendation:** Set `IdleVMWakeUpTime=1` in SYSTEM.INI to ensure the System
VM's TSR gets timer ticks within 1 second even when idle.

### TrapTimerPorts

```ini
[386Enh]
TrapTimerPorts=<Boolean>
```

- Default: Yes (Windows 3.0 was No)
- Controls whether Windows traps read/write operations to the 8253 timer I/O
  ports (40h-43h).
- If our TSR only hooks INT 1Ch and does not reprogram the timer chip directly,
  this setting is irrelevant. Leave it at the default.

### TimerCriticalSection

```ini
[386Enh]
TimerCriticalSection=<milliseconds>
```

- Default: 0 (disabled)
- When nonzero, creates a critical section around timer interrupt processing,
  preventing other VMs from running during that window.
- Originally added for Novell NetWare to avoid deadlocks in LAN IRQ
  virtualization code.
- **Side effect:** Can prevent INT 1Ch hooks in DOS VMs from executing properly.
- **Recommendation:** Leave at 0 unless network deadlocks occur.

---

## 4. INT 21h File I/O from a TSR

### Can a System VM TSR Do File I/O?

Yes. A TSR in the System VM can call INT 21h for file operations. However,
there are critical constraints:

#### Reentrancy and the InDOS Flag

DOS is **not reentrant**. The InDOS flag (a byte in DOS kernel space) indicates
when DOS is already processing an INT 21h call. A TSR triggered by INT 1Ch must
check the InDOS flag before issuing any INT 21h call. If InDOS is nonzero, the
TSR must defer its work to the next tick.

This is standard TSR programming practice and is not specific to Windows.

#### InDOSPolling

```ini
[386Enh]
InDOSPolling=<Boolean>
```

- Default: No
- When enabled, prevents Windows from switching away from a VM while the InDOS
  flag is set.
- **If our TSR does file I/O on INT 1Ch**, enabling this may improve
  reliability by preventing a VM switch mid-syscall. However, it degrades
  multitasking performance.
- **Recommendation:** Try without it first. Enable only if we see file
  corruption or hangs.

### Network Drive Access (SMB Share)

WFW 3.11 uses a layered network file system:

1. **IFSHLP.SYS** — loaded in CONFIG.SYS, provides the Installable File System
   (IFS) helper for 386 Enhanced mode.
2. **VREDIR.386** — the Virtual Redirector VxD, handles SMB/CIFS network file
   access.
3. **IFS Manager** — routes INT 21h file calls to either the local FAT driver
   or VREDIR based on the drive letter.

When our TSR calls INT 21h to open/read/write a file on a mapped network drive
(e.g., `F:\COMMANDS\cmd.txt`), the call path is:

```
TSR → INT 21h → IFS Manager → VREDIR.386 → network stack → SMB server
```

This should work from the System VM because:

- The network redirector is loaded and active in the System VM.
- The drive mapping (NET USE) is established in the System VM's context.
- VREDIR.386 handles the actual network I/O at ring 0, so it is not subject to
  the same reentrancy issues as the real-mode DOS kernel.

**However, there are caveats:**

1. **The TSR must still respect the InDOS flag.** Even though VREDIR handles the
   network part, the INT 21h entry point goes through the DOS kernel first.

2. **Network I/O is slow.** An INT 1Ch handler has roughly 55ms before the next
   tick. Network file operations can easily exceed this. The TSR should use a
   tick counter to poll infrequently (e.g., every 18 ticks = ~1 second) rather
   than every tick.

3. **NoWaitNetIO:**

   ```ini
   [386Enh]
   NoWaitNetIO=<Boolean>
   ```

   - Default: Yes (for WFW 3.11)
   - Converts synchronous NetBIOS commands to asynchronous.
   - May improve behavior when the TSR's network I/O blocks.

4. **32-bit file access (VFAT/VCACHE):** WFW 3.11 can optionally enable 32-bit
   file access, which bypasses the real-mode DOS kernel for local disk I/O by
   trapping INT 21h at the VxD level. This should not interfere with network
   file access through VREDIR, but it means some INT 21h calls never reach the
   real-mode DOS code at all.

---

## 5. INT 28h (DOS Idle)

```ini
[386Enh]
INT28Critical=<Boolean>
```

- Default: True
- Specifies whether a critical section wraps INT 28h handling.
- INT 28h is the DOS idle interrupt, called by DOS when waiting for keyboard
  input. TSRs traditionally use it as a safe point to do deferred file I/O
  (since DOS is in a known semi-reentrant state during INT 28h).
- Under Windows 3.1 Enhanced Mode, INT 28h **is** delivered to VMs (unlike
  Windows 9x, where it reportedly is not).

**For our TSR:** If we defer file I/O to INT 28h instead of doing it directly
in INT 1Ch, we get a safer execution context. The DOS kernel is in a known
state where INT 21h functions 01h-0Ch are safe to call. For higher functions
(open/read/write/close), we still need the InDOS flag to be <= 1 (not 0 — the
INT 28h call itself sets InDOS to 1).

---

## 6. Keyboard Buffer

### Is It Virtualized Per VM?

Yes. The **Virtual Keyboard Device (VKD)** VxD virtualizes keyboard input.
Each VM has its own virtualized keyboard state. The BIOS keyboard buffer at
0040:001E (the 16-word circular buffer) is treated as **instance data** — each
VM gets its own copy.

This means:

- Keystrokes typed while a DOS VM is in the foreground go to that VM's buffer.
- Keystrokes typed while Windows is in the foreground go to the System VM.
- Our TSR stuffing keystrokes into the BIOS keyboard buffer (INT 16h or direct
  buffer manipulation at 0040:001E) will only affect the **System VM's**
  keyboard buffer.

**Important:** If the user is in a full-screen DOS box, keystrokes stuffed by
our TSR in the System VM will **not** appear there. They will be queued for the
next time a Windows app (or the Program Manager) has focus.

### Relevant Settings

```ini
[386Enh]
KeyBufferDelay=<seconds>
```

- Default: 0.2
- Controls delay when pasting into a VM's keyboard buffer and the buffer is
  full.

---

## 7. Critical SYSTEM.INI Settings Summary

For our TSR (loaded in AUTOEXEC.BAT, polls network share, stuffs keyboard
buffer), these are the recommended settings:

```ini
[386Enh]
; Ensure System VM gets timer ticks even when idle
IdleVMWakeUpTime=1

; Do not put our TSR in the local list — we want one instance in System VM
; (Leave LocalTSRs at default or omit our TSR name)

; Leave timer port trapping at default
TrapTimerPorts=Yes

; Leave TimerCriticalSection disabled unless we see deadlocks
TimerCriticalSection=0

; InDOS polling — enable if we see file I/O issues
; InDOSPolling=Yes

; INT 28h critical section — leave at default
INT28Critical=True

; Async network I/O
NoWaitNetIO=Yes

; Reflect DOS INT 2Ah if our network stack needs it
; ReflectDosInt2A=No

; Unique DOS PSP addresses — may help if network stack identifies
; processes by load address
; UniqueDOSPSP=True
```

---

## 8. Summary: Answers to Key Questions

### Q1: Does WFW 3.11 virtualize INT 1Ch for DOS VMs?

**Yes.** The VTD virtualizes the entire timer chain (INT 08h → INT 1Ch). Each
VM receives its own stream of timer interrupts, with the active VM getting
priority. Idle VMs get ticks based on `IdleVMWakeUpTime`.

### Q2: Does a pre-Windows TSR get real or virtualized timer ticks?

**Virtualized.** Once Windows starts, all V86 mode code (including the System
VM where AUTOEXEC.BAT TSRs live) receives virtualized interrupts from the VTD.
The TSR cannot tell the difference — the interrupt looks identical to a real
tick.

### Q3: Can a pre-Windows TSR access files on a network drive while Windows runs?

**Yes, with caveats.** The TSR must respect the InDOS flag. File I/O on network
drives goes through VREDIR.386, which is active in the System VM. The drive
mapping must be established (NET USE) before or during the Windows session.

### Q4: Known issues with TSR file I/O on network shares under WFW 3.11?

- **Reentrancy:** Must check InDOS before any INT 21h call.
- **Blocking:** Network I/O can block for extended periods; avoid doing it on
  every timer tick.
- **TimerCriticalSection:** If set nonzero (e.g., by Novell NetWare), can
  interfere with INT 1Ch delivery.
- **32-bit file access:** Does not apply to network drives (only local), so no
  conflict.

### Q5: Does each DOS VM get its own copy of the TSR?

**No, by default.** The TSR's memory is global (shared). DOS VMs can see the
TSR's code and data but share the same physical bytes. To get per-VM copies,
either:

- Add the TSR name to `LocalTSRs=` in `[NonWindowsApp]`, or
- Have the TSR register instance data via INT 2Fh/1605h during Windows init.

For our use case, we want one shared instance in the System VM. Do not use
LocalTSRs.

### Q6: Is the keyboard buffer virtualized per VM?

**Yes.** VKD maintains per-VM keyboard state. The BIOS keyboard buffer at
0040:001E is instance data. Stuffing keys in the System VM only affects
Windows apps; a foreground DOS box has its own buffer.

### Q7: SYSTEM.INI settings that affect TSR behavior?

See Section 7 above. The most important ones are:

- `IdleVMWakeUpTime` — controls timer delivery to idle VMs
- `InDOSPolling` — prevents VM switching during DOS calls
- `TimerCriticalSection` — can block timer interrupt delivery
- `INT28Critical` — affects INT 28h idle processing
- `LocalTSRs` — controls per-VM TSR copying
- `NoWaitNetIO` — async network I/O

---

## 9. Practical Implications for Our TSR Design

1. **Load in AUTOEXEC.BAT before WIN.COM.** The TSR lives in the System VM.

2. **Hook INT 1Ch for periodic polling.** Use a tick counter (e.g., poll every
   18-36 ticks = 1-2 seconds). Do not poll every tick.

3. **Check InDOS flag before file I/O.** If InDOS is nonzero, skip this tick
   and try next time. Also check the Critical Error flag.

4. **Consider deferring file I/O to INT 28h.** This gives a safer reentrancy
   context, but only fires when DOS is idle (waiting for keyboard input). May
   not fire frequently enough if the user is active in Windows.

5. **Hybrid approach (recommended):** Use INT 1Ch for timing, but only set a
   "poll needed" flag. Then check during both INT 1Ch (if InDOS==0) and INT 28h
   (always safe for higher DOS functions) to do the actual file I/O.

6. **Keyboard stuffing goes to System VM only.** This is fine if the target
   application is a Windows app. If the user is in a DOS box, they won't see
   the stuffed keys until they switch back.

7. **Set `IdleVMWakeUpTime=1`** to ensure timely polling even when the System
   VM is idle.

8. **Network drive must be mapped** before the TSR tries to access it. Either
   map it in AUTOEXEC.BAT (before WIN) or ensure WFW maps it at login. With
   WFW's built-in networking, persistent connections mapped via File Manager
   are reconnected at Windows startup.

---

## Sources

- [Inside Windows 3 — XtoF's Lair](https://www.xtof.info/inside-windows3.html)
- [Windows 3.1 SYSTEM.INI \[386Enh\] Section A-L — MS KB Q83435](https://jeffpar.github.io/kbarchive/kb/083/Q83435/)
- [Windows 3.1 SYSTEM.INI \[386Enh\] Section — Infania mirror](https://www.infania.net/misc/win31files/83435-6.php)
- [Windows 3.1 SYSTEM.INI \[NonWindowsApp\] — MS KB Q83389](https://jeffpar.github.io/kbarchive/kb/083/Q83389/)
- [ANSIPLUS Technical Notes — Windows Compatibility](http://www.sweger.com/ansiplus/TechNotesWindows.html)
- [The story of WINA20.386 — The Old New Thing](https://devblogs.microsoft.com/oldnewthing/20120206-00/?p=8373)
- [Windows 3.1 INT 2F Services — DOS Help Files](https://dos-help.soulsphere.org/ddag31qh.hlp/winint2fabout.html)
- [386 Enhanced Mode — OS/2 Books](https://komh.github.io/os2books/gg243731/214_L3_386EnhancedMode.html)
- [VxD — Grokipedia](https://grokipedia.com/page/VxD)
- [Terminate-and-stay-resident program — Wikipedia](https://en.wikipedia.org/wiki/Terminate-and-stay-resident_program)
- [TSR Programming — Fysnet](https://www.fysnet.net/tsrdemo.htm)
- [Exploring WFW 3.11 Networking — NCommander](https://casadevall.pro/articles/2020/05/exploring-windows-for-workgroups-3.11-early-90s-networking/)
- [Jumpy PS/2 mouse in Enhanced mode Windows 3.x — OS/2 Museum](http://www.os2museum.com/wp/jumpy-ps2-mouse-in-enhanced-mode-windows-3-x/)
- [VOGONS — How Windows 3.1 runs DOS programs](https://www.vogons.org/viewtopic.php?t=79359)
