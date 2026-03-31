# DOSBox-X vs Real Hardware vs 86Box: Emulation Differences

Reference document for developing a TSR that must work in both DOSBox-X (dev/test)
and 86Box with WFW 3.11 (production VM).

Researched: 2026-03-12

---

## 1. CPU Cycle Accuracy

**DOSBox-X does NOT emulate CPU cycles accurately.** It completes one instruction
per emulated-cycle regardless of the actual instruction complexity. On real hardware,
instruction timing varies by instruction type, addressing mode, and CPU generation.

- `cycles=max` runs at maximum host CPU speed. Setting values too high causes
  sound dropouts and lag. There is no direct correlation between the `cycles=`
  value and any real clock frequency.
- `cycles=auto` attempts to detect whether a program needs max or fixed cycles,
  but can guess wrong.
- REP string instructions execute completely before processing interrupts by
  default. The `interruptible rep string op` setting can change this.

**86Box** interprets every single instruction and simulates authentic behavior of
the original hardware, including its speed. It is designed for low-level accuracy,
especially for 8088/8086 systems.

**Implication for TSR:** Do not rely on instruction-level timing. Use interrupt-
driven timing (INT 1Ch / timer tick) rather than busy-wait loops. A polling loop
that works at `cycles=3000` may behave differently at `cycles=max`.

Sources:

- [CPU settings in DOSBox-X](https://dosbox-x.com/wiki/Guide:CPU-settings-in-DOSBox%E2%80%90X)
- [86Box FAQ](https://86box.readthedocs.io/en/latest/usage/faq.html)

---

## 2. INT 1Ch Timer Tick Timing

The standard DOS timer tick fires at ~18.2 Hz (every ~55 ms), driven by the 8253
PIT counting down from 65536 at 1,193,180 Hz. The PIT triggers IRQ 0 (INT 08h),
which the BIOS handler chains to INT 1Ch as a user-hookable tick.

**DOSBox-X behavior:**

- Timer ticks are synchronized to the host clock at startup but can drift over
  time. Software running inside the emulation can affect drift rate.
- The PIT is emulated but not cycle-accurately tied to instruction execution.
- At `cycles=max`, timer ticks still fire at ~18.2 Hz wall-clock time, but the
  number of instructions executed between ticks varies with host CPU speed.

**86Box behavior:**

- PIT emulation is tied to the emulated CPU clock. Timer ticks are consistent
  with the emulated hardware speed.

**Implication for TSR:** INT 1Ch is safe to use as a periodic polling mechanism
in both emulators. The ~55 ms interval is reliable in both. Do not assume a
fixed number of CPU instructions between ticks.

Sources:

- [Accuracy of DOS clock (VOGONS)](https://www.vogons.org/viewtopic.php?t=45953)
- [DOSBox-X timer.cpp](https://github.com/joncampbell123/dosbox-x/blob/master/src/hardware/timer.cpp)

---

## 3. INT 21h File Operations on Host-Mounted Directories

### What works on DOSBox-X host mounts

Standard INT 21h file operations (create, open, read, write, close, delete, mkdir,
rmdir, find first/next) generally work on mounted host directories. DOSBox-X
translates these to host OS file operations.

### Known issues and differences

1. **No InDOS flag:** DOSBox-X does not implement the InDOS flag (INT 21h/34h).
   TSRs that check InDOS to determine whether it is safe to call DOS will not
   get meaningful results. DOSBox-X's INT 21h handler is implemented in C++,
   not as re-entrant DOS code, so the concept does not directly apply -- but
   the flag is missing, which breaks TSRs that depend on it.

2. **Nested INT 21h calls:** DOSBox-X may internally call INT 21h from within
   another INT 21h handler (e.g., calling AH=2Ah get-date during file operations).
   This does NOT happen on real DOS. A TSR hooking INT 21h may see unexpected
   re-entrant calls. (GitHub issue #5305)

3. **INT 21h AH=2 (print char):** Treats LF (0x0A) as CRLF, moving cursor to
   column 0 and advancing row. Real DOS does not do this. (GitHub issue #5785)

4. **File dates on mounted dirs:** File date/time stamps on host-mounted
   directories come from the host filesystem, not from a FAT table. This is
   generally transparent but edge cases exist.

5. **Disk free space (INT 21h/36h):** Returns synthetic values assuming 16 GB
   total with 256 KiB clusters, not the actual host disk free space.

6. **File locking:** File locking support (INT 21h/5Ch) on mounted directories
   is incomplete / not fully tested. (GitHub issue #2134)

7. **Directory caching:** DOSBox-X caches directory listings. If the host
   filesystem changes externally, the guest may not see updates immediately.
   Use `-nocachedir` mount option to disable.

**Implication for TSR:** Basic file create/open/read/write/close/delete work fine
on host mounts. Avoid relying on InDOS flag. Be aware that hooking INT 21h in
DOSBox-X may see re-entrant calls that would not occur on real DOS or 86Box.

Sources:

- [INT 21h nested calls issue #5305](https://github.com/joncampbell123/dosbox-x/issues/5305)
- [INT 21h AH=2 LF issue #5785](https://github.com/joncampbell123/dosbox-x/issues/5785)
- [File locking issue #2134](https://github.com/joncampbell123/dosbox-x/issues/2134)
- [Disk free space issue #2652](https://github.com/joncampbell123/dosbox-x/issues/2652)

---

## 4. Filename Restrictions on Host-Mounted Directories

### 8.3 filename enforcement

DOSBox-X enforces 8.3 filename format by default on mounted directories. Long
filenames on the host are mapped to auto-generated short names (FILENA~1.EXT).

**Important caveats:**

- The short filenames DOSBox-X generates may NOT match those generated by Windows
  or other tools. Do not assume `LONGFI~1.TXT` will be the same across systems.
- Special characters (umlauts, accented letters, high-ASCII) in filenames are NOT
  supported. Avoid them entirely in both host and guest filenames.
- On macOS/Linux hosts, case sensitivity can cause issues. DOSBox-X performs
  case-insensitive matching, but the host FS may be case-sensitive (Linux).
  macOS HFS+ is case-insensitive by default, so this is not an issue on Mac.

**Implication for TSR:** Use only uppercase 8.3 filenames with standard ASCII
characters (A-Z, 0-9, underscore, hyphen). This ensures compatibility across
DOSBox-X host mounts, 86Box FAT16 disk images, and SMB shares.

Sources:

- [MOUNT - DOSBoxWiki](https://www.dosbox.com/wiki/MOUNT)
- [Filename character set issue #295](https://github.com/joncampbell123/dosbox-x/issues/295)

---

## 5. BIOS Keyboard Buffer (0040:001E) and INT 16h

### Keyboard buffer layout

The BIOS keyboard buffer is a 32-byte circular buffer at 0040:001E (16 two-byte
entries). Head pointer at 0040:001A, tail pointer at 0040:001C. Each entry is a
word: low byte = ASCII code, high byte = scan code.

### INT 16h AH=05h (keyboard buffer stuffing)

**DOSBox-X implements INT 16h AH=05h.** The implementation calls
`BIOS_AddKeyToBuffer(CX)` and returns AL=0 on success, AL=1 if the buffer is
full. This matches the documented BIOS behavior.

The keyboard buffer at 0040:001E is properly emulated with standard head/tail
pointer management.

### INT 16h AH=00h/01h/10h/11h

Standard keyboard read (AH=00h) and peek (AH=01h) functions work correctly.
Extended keyboard functions (AH=10h/11h) are also supported.

**Known DOSBox bug (original, may affect DOSBox-X):** INT 16h AH=11h (extended
keystroke status) had a bug where the returned value differed from real BIOS
behavior for certain key combinations. (SourceForge bug #475)

**Implication for TSR:** INT 16h AH=05h (buffer stuffing) is safe to use in
DOSBox-X for injecting keystrokes. Direct manipulation of the buffer at
0040:001E also works but AH=05h is preferred as it handles the circular buffer
pointers correctly.

Sources:

- [DOSBox-X bios_keyboard.cpp](https://dosbox-x.com/doxygen/html/bios__keyboard_8cpp_source.html)
- [DOSBox INT 16h bug #475](https://sourceforge.net/p/dosbox/bugs/475/)

---

## 6. 86Box Emulation Accuracy Notes

### Strengths

86Box is a low-level hardware emulator focused on accuracy. It emulates the full
hardware stack: CPU, chipset, PIT, PIC, DMA, video cards, network cards, etc.
It is significantly more accurate than DOSBox-X for hardware-level behavior.

- Accurate 8088/8086 instruction timing
- Proper PIT/PIC interrupt handling
- Full hardware emulation (not HLE like DOSBox-X's DOS services)
- Runs actual DOS/Windows, not emulated DOS services

### Known 86Box issues (mostly cosmetic)

- Intel 440BX chipset reports RAM as EDO instead of SDRAM (not implemented)
- AGP detection may report as PCI in some diagnostic tools
- CPU cache reporting may be incorrect in guest diagnostic tools
- These are reporting/detection issues with zero performance impact

### 86Box SLiRP networking limitations

- SLiRP only routes TCP and UDP. No ICMP ping, no NetBEUI, no IPX.
- The emulated machine is behind NAT. Host cannot initiate connections to the VM
  unless port forwarding is configured.
- **Network stability issues:** 86Box has known crashes during network operations,
  especially file downloads and SMB share access. Large file transfers (>100 KB)
  may fail or drop connections.
- FTP uploads to/from the VM may not complete reliably.
- SMB over TCP (port 139 via NBT) works but may be unreliable for sustained
  transfers.

**Implication for TSR:** When the TSR runs in 86Box and accesses files via SMB
share (\\10.0.2.2\SHARE), network instability may cause file operations to fail.
The TSR should handle file I/O errors gracefully and retry. Keep individual file
transfers small. Prefer writing complete files rather than appending incrementally.

Sources:

- [86Box networking docs](https://86box.readthedocs.io/en/v3.5/hardware/network.html)
- [86Box network crashes #141](https://github.com/86Box/86Box/issues/141)
- [86Box SLiRP issues #5235](https://github.com/86Box/86Box/issues/5235)
- [86Box hardware inconsistencies #2806](https://github.com/86Box/86Box/discussions/2806)
- [86Box emulation accuracy article](https://kingofgng.com/eng/2026/01/31/86box-and-dosbox-x-in-search-of-new-levels-of-emulation-accuracy/)

---

## 7. DOSBox-X vs 86Box: Key Differences for TSR Development

| Aspect | DOSBox-X (host mount) | 86Box (FAT16 + SMB) |
|---|---|---|
| DOS services | HLE (C++ emulation) | Real MS-DOS running |
| INT 21h | Emulated, some quirks | Real DOS, fully accurate |
| InDOS flag | Not implemented | Real DOS provides it |
| INT 1Ch timing | ~55 ms wall-clock | ~55 ms emulated clock |
| INT 16h AH=05h | Implemented, works | Real BIOS, works |
| File I/O | Host FS passthrough | FAT16 on disk image or SMB |
| File names | 8.3 enforced, auto-short | Real 8.3 FAT16 names |
| Network | N/A (host mount) | SLiRP, may be unstable |
| Keyboard buffer | Properly emulated | Real BIOS buffer |
| CPU timing | Not cycle-accurate | Cycle-accurate |

---

## 8. Practical Recommendations for the TSR

1. **Use INT 1Ch for periodic polling.** It works reliably in both environments
   at ~18.2 Hz. Do not use busy-wait loops.

2. **Use INT 16h AH=05h for keystroke injection.** Supported in both DOSBox-X
   and real BIOS (86Box). Avoid direct buffer manipulation at 0040:001E unless
   there is a specific reason.

3. **Use standard INT 21h file operations.** Create (AH=3Ch), open (AH=3Dh),
   read (AH=3Fh), write (AH=40h), close (AH=3Eh), delete (AH=41h), mkdir
   (AH=39h) all work on DOSBox-X host mounts. Avoid exotic functions like
   file locking (AH=5Ch) or FCB-based operations.

4. **Handle file I/O errors.** In 86Box with SMB, network glitches can cause
   any file operation to fail. Always check the carry flag after INT 21h calls.

5. **Use strict 8.3 uppercase filenames.** Only A-Z, 0-9, underscore, hyphen.
   No spaces, no special characters.

6. **Do not hook INT 21h if avoidable.** DOSBox-X's nested INT 21h calls can
   cause unexpected re-entrancy. If you must hook INT 21h, be aware that your
   hook may be called from within another INT 21h handler in DOSBox-X but not
   in real DOS / 86Box.

7. **Do not rely on InDOS flag.** DOSBox-X does not implement it. If you need
   to avoid calling DOS from within DOS (e.g., from an INT 1Ch handler), use
   your own flag or defer the work.

8. **Keep SMB file transfers small.** 86Box SLiRP networking has reliability
   issues with larger transfers. Write small files; avoid streaming writes.

9. **Test with fixed cycles first.** Use `cycles=3000` or similar during
   development, then verify with `cycles=max`. Timing-sensitive code may behave
   differently.

10. **Disable directory caching in DOSBox-X** if you need the guest to see
    real-time host filesystem changes: `mount C /path -nocachedir`.
