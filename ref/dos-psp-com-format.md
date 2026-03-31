# DOS Program Segment Prefix (PSP) and .COM File Format Reference

Quick-reference for writing TSRs and .COM programs targeting DOS / WFW 3.11.

Sources: Wikipedia (Program Segment Prefix, COM file), HelpPC 2.10, MS-DOS
Encyclopedia Appendix H (via PCjs), Tech Help!, Ralf Brown Interrupt List,
Art of Assembly Ch. 13, fysnet.net COM startup registers.

---

## 1. Complete PSP Layout (256 bytes, offsets 00h--FFh)

The PSP is a 256-byte (100h) structure DOS builds immediately *before*
loading a program. For .COM files it occupies CS:0000--CS:00FF; program
code begins at CS:0100.

| Offset | Size | Field | Initialized by | Description |
|--------|------|-------|----------------|-------------|
| 00h | 2 | INT 20h opcode | DOS | Machine code `CD 20` -- executing here terminates the program (CP/M compat). |
| 02h | 2 | Top-of-memory | DOS | Segment (paragraph) of first byte beyond memory allocated to this program. |
| 04h | 1 | Reserved | DOS | Always 00h in MS-DOS. (OS/2 uses it as a fake-DOS-version counter.) |
| 05h | 5 | FAR CALL to DOS | DOS | CP/M-style entry: byte 05h = `9A` (FAR CALL opcode). The WORD at 06h doubles as the .COM available-bytes-in-segment value (CP/M compat). The FAR address is crafted so it wraps around to 0000:00C0 (INT 30h vector), reaching the DOS dispatcher. |
| 0Ah | 4 | INT 22h vector | DOS | Saved Terminate Address -- the return address DOS jumps to when this program exits. Restored to the IVT on termination. |
| 0Eh | 4 | INT 23h vector | DOS | Saved Ctrl-Break handler of the *parent* process. Restored on termination. |
| 12h | 4 | INT 24h vector | DOS | Saved Critical Error handler of the *parent*. Restored on termination. |
| 16h | 2 | Parent PSP segment | DOS (2.0+) | Segment address of the parent process's PSP (usually COMMAND.COM). For the root COMMAND.COM, this points to itself. |
| 18h | 20 | Job File Table (JFT) | DOS (2.0+) | Per-process file handle table. Each byte is an index into the system-wide SFT (System File Table). `FFh` = handle not in use. Default 20 entries = handles 0--19. Handles 0--4 are pre-opened: 0=STDIN, 1=STDOUT, 2=STDERR, 3=STDAUX (COM1), 4=STDPRN (LPT1). |
| 2Ch | 2 | Environment segment | DOS (2.0+) | Segment address of the environment block (a sequence of `NAME=value\0` strings terminated by an extra `\0`). Zero means no environment. After the double-NUL terminator, DOS 3.0+ stores a WORD count (usually 0001h) followed by the fully-qualified program pathname (ASCIIZ). |
| 2Eh | 4 | SS:SP on INT 21h | DOS (2.0+) | The caller's SS:SP saved on entry to the last INT 21h call. Internal/undocumented. |
| 32h | 2 | JFT size | DOS (3.0+) | Number of entries in the JFT. Default = 0014h (20). Can be expanded via INT 21h/67h (Set Handle Count) -- DOS will allocate a new table elsewhere and update the pointer at 34h. |
| 34h | 4 | JFT pointer | DOS (3.0+) | FAR pointer to the JFT. Defaults to PSP:0018h. If the JFT is expanded beyond 20 handles, this points to the new location. |
| 38h | 4 | Previous PSP | DOS (3.3+) | FAR pointer to previous PSP. Used by SHARE. Default FFFF:FFFF. |
| 3Ch | 4 | Reserved | -- | Used by DBCS support in some versions; Windows 3.x stores flags here. |
| 40h | 2 | DOS version | DOS (5.0+) | Version number to return for INT 21h/30h. SETVER can alter this per-program. |
| 42h | 14 | Reserved | -- | Windows 3.x PDB (Process Database) chain pointers live here. |
| 50h | 3 | INT 21h / RETF | DOS | Machine code `CD 21 CB` -- a callable entry point: `CALL PSP:0050` invokes DOS and returns. The Unix/CP/M "CALL 5" equivalent for the DOS era. |
| 53h | 2 | Reserved | -- | Unused padding. |
| 55h | 7 | Extended FCB area | -- | Can be used to extend FCB #1 into a full extended FCB (with attribute byte at 5Ch-7 = 55h). Usually zeroed. |
| 5Ch | 16 | Default FCB #1 | DOS | Unopened FCB built from the *first* command-line argument (see Section 4). |
| 6Ch | 20 | Default FCB #2 | DOS | Unopened FCB built from the *second* command-line argument. **Warning:** if FCB #1 is opened (via INT 21h/0Fh), it grows to 37 bytes and overwrites FCB #2. |
| 80h | 1 | Command tail length | DOS | Count of bytes in the command tail (offsets 81h..81h+len-1). Does NOT include the trailing CR. Max value = 7Eh (126). |
| 81h | 127 | Command tail + DTA | DOS | The raw command-line text, terminated by 0Dh (CR). Also serves as the default Disk Transfer Area (DTA) until the program calls INT 21h/1Ah to relocate it. |

**Total: 100h (256) bytes.**

---

## 2. Command Tail Format (PSP:0080h)

When the user types:

```
C:\>MYPROG /S foo.txt bar.dat
```

DOS stores the portion *after* the program name into the PSP:

| Offset | Value | Notes |
|--------|-------|-------|
| 80h | 14h (20) | Length of tail bytes (excludes the CR) |
| 81h | `20` | Space -- the leading space is preserved |
| 82h | `/S foo.txt bar.dat` | Remainder of command line exactly as typed |
| 95h | 0Dh | Carriage Return terminator |

### Rules

- The **program name itself** is NOT in the command tail (but see the environment block, Section 5, for the full path).
- A **leading space** (20h) is always present between the program name and the first argument. It IS counted in the length byte.
- **I/O redirection** (`>file`, `<file`, `|prog`) is stripped by COMMAND.COM before the program sees the tail.
- The **CR at the end** (0Dh) is always present but is NOT counted in the length byte at 80h.
- If no arguments were given, offset 80h = 00h and offset 81h = 0Dh.
- Maximum tail length is **126 characters** (7Eh). For longer lines, DOS 4.0+ programs can check the `%CMDLINE%` environment variable.
- The tail area (80h--FFh) doubles as the **default DTA**. Any FCB-based file I/O (e.g., Find First / Find Next via INT 21h/11h-12h) will overwrite the command tail. Save it early if you need it.

### Parsing the command tail

Standard delimiters recognized by DOS: space (20h), comma (2Ch), semicolon (3Bh), equals (3Dh), tab (09h). The CR (0Dh) terminates.

Typical .COM parsing pattern:

```asm
        mov  si, 81h        ; DS:SI -> first byte of tail (the leading space)
        mov  cl, [80h]      ; CL = length
        xor  ch, ch
.skip:  lodsb                ; AL = next char
        cmp  al, 20h
        je   .skip           ; skip leading spaces
        cmp  al, 0Dh
        je   .done           ; end of tail
        ; AL has first non-space character -- process it
```

---

## 3. INT 20h at PSP:0000h -- .COM Termination

The two bytes `CD 20` at PSP:0000 are a real INT 20h instruction. Three classic termination methods exploit this:

### Method 1: RET from a .COM (DOS 1.0+)

DOS pushes 0000h onto the stack before jumping to CS:0100h. A simple `RET` pops 0000h into IP, executing the INT 20h at PSP:0000. **Requires CS = PSP segment** (always true for .COM files unless CS was modified).

### Method 2: INT 20h directly (DOS 1.0+)

```asm
        int  20h
```

Also requires CS = PSP segment.

### Method 3: INT 21h / AH=4Ch (DOS 2.0+, recommended)

```asm
        mov  ax, 4C00h      ; AL = return code
        int  21h
```

Does NOT require CS = PSP segment. Works for both .COM and .EXE. This is the standard method for DOS 2.0+.

### For .EXE programs (DOS 1.x workaround)

Push DS (= PSP segment) and 0000h at program start, then RETF at the end:

```asm
        push ds
        xor  ax, ax
        push ax
        ; ... program body ...
        retf                 ; pops 0000h:PSP -> executes INT 20h at PSP:0000
```

---

## 4. Default FCBs at PSP:005Ch and PSP:006Ch

### How DOS fills them

At program load time (INT 21h/4Bh EXEC), DOS calls INT 21h/29h (Parse Filename into FCB) twice:

1. **FCB #1 at PSP:5Ch** -- parsed from the first whitespace-delimited token after the program name.
2. **FCB #2 at PSP:6Ch** -- parsed from the second token.

INT 21h/29h is called with AL = 01h (skip leading separators). It recognizes these separators: `: ; . , = + TAB SPACE` and the switch character. It does NOT handle path names (no `\` processing).

### FCB structure (16 bytes, unopened)

| Offset | Size | Field |
|--------|------|-------|
| 00h | 1 | Drive number (0 = default, 1 = A:, 2 = B:, ...) |
| 01h | 8 | Filename, padded with spaces (20h) |
| 09h | 3 | Extension, padded with spaces |
| 0Ch | 2 | Current block number (0 for unopened) |
| 0Eh | 2 | Record size (0 for unopened) |

The remaining bytes of the 36-byte extended FCB area (file size, date, time, etc.) are zero for an unopened FCB.

### Example

Command: `MYPROG A:README.TXT B:OUTPUT.DAT`

FCB #1 at PSP:5Ch:

```
01 52 45 41 44 4D 45 20 20  54 58 54  00 00 00 00
 A  R  E  A  D  M  E  ^^   T  X  T
                      space
```

FCB #2 at PSP:6Ch:

```
02 4F 55 54 50 55 54 20 20  44 41 54  00 00 00 00
 B  O  U  T  P  U  T  ^^   D  A  T
```

### If arguments are not filenames

If the first argument is `/S` or some flag, DOS still tries to parse it. The drive byte will be 0 (default), and the filename field will contain whatever characters were present, space-padded. The result is meaningless but harmless -- the FCB is "unopened" and programs using the handle API (INT 21h/3Dh+) simply ignore it.

### Overlap warning

FCB #1 spans PSP:5Ch--7Fh (36 bytes when opened). FCB #2 starts at PSP:6Ch. Opening FCB #1 (which extends it to 37 bytes) **destroys FCB #2**. Copy FCB #2 first if you need both.

---

## 5. Environment Segment (PSP:002Ch)

The WORD at PSP:2Ch is the segment address of the program's environment block.

### Environment block format

```
COMSPEC=C:\COMMAND.COM\0
PATH=C:\DOS;C:\WINDOWS\0
PROMPT=$p$g\0
\0                          <-- extra NUL terminates the block
\x01\x00                    <-- WORD: number of following strings (DOS 3.0+)
C:\MYPROG.COM\0             <-- fully-qualified program name (ASCIIZ)
```

- Each variable is `NAME=value` followed by a NUL byte (00h).
- The entire block ends with an additional NUL (double-NUL = end of variables).
- After the double-NUL, DOS 3.0+ appends a WORD count (usually 0001h) and the full path of the executing program. This is the only way a .COM file can discover its own filename/path.
- The environment is a *copy* -- modifying it does not affect the parent's environment.
- If PSP:2Ch = 0000h, there is no environment (rare; only for the first COMMAND.COM).

### Scanning the environment

```asm
        mov  es, [2Ch]       ; ES = environment segment
        xor  di, di          ; ES:DI -> start of env block
.next:  mov  al, es:[di]
        or   al, al
        jz   .end_of_env     ; double-NUL = end
        ; ES:DI points to start of "NAME=value"
        ; scan for '=' or compare NAME
        ; ...
        ; advance past this string's NUL terminator
        xor  al, al
        repne scasb
        jmp  .next
.end_of_env:
        inc  di              ; skip the final NUL
        ; ES:DI -> WORD count, then program name
```

---

## 6. File Handle Table / Job File Table (PSP:0018h)

### Default layout (20 bytes at PSP:18h--2Bh)

Each byte is an index into the DOS System File Table (SFT). `FFh` = unused/closed.

| Handle | SFT index | Standard meaning |
|--------|-----------|-----------------|
| 0 | varies | STDIN (CON) |
| 1 | varies | STDOUT (CON) |
| 2 | varies | STDERR (CON) |
| 3 | varies | STDAUX (COM1) |
| 4 | varies | STDPRN (LPT1) |
| 5--19 | FFh | Available for INT 21h/3Dh (Open) |

### Handle table expansion (DOS 3.3+)

The default table allows only 20 open handles. To increase:

```asm
        mov  ah, 67h
        mov  bx, 50          ; request 50 handles
        int  21h
```

DOS allocates a new table, copies the existing 20 entries, updates:

- PSP:32h (JFT size) = new count
- PSP:34h (JFT pointer) = FAR ptr to new table

The old 20-byte area at PSP:18h is no longer used.

### Network file handles

In network-aware DOS (3.1+ with redirector), handle values 80h--FEh in the JFT indicate remote/network files managed by the redirector rather than local SFT entries.

---

## 7. Parent PSP (PSP:0016h)

The WORD at PSP:16h contains the **segment address of the parent process's PSP**.

- For programs launched by COMMAND.COM, this points to COMMAND.COM's PSP.
- For COMMAND.COM itself (the root shell), this field points to its own PSP segment (self-referential).
- A TSR can walk the PSP chain via this field to find COMMAND.COM or verify its own PSP.
- On termination, DOS restores INT 22h/23h/24h vectors from the parent's PSP and returns control to the parent's terminate address.

### Relationship to PSP:38h

PSP:38h (DOS 3.3+, undocumented) is a FAR pointer to the "previous PSP" used by SHARE for file-locking ownership tracking. It is NOT the same as the parent PSP, though they often coincide. Default value: FFFF:FFFF.

---

## 8. .COM File Format and Loading

### File format

A .COM file has **no header**. The file is a raw binary memory image. The first byte of the file is the first instruction (or a JMP to the entry point).

### Maximum size

65,280 bytes (FF00h). This is 64 KiB minus 256 bytes for the PSP. In practice, the available size is slightly smaller because the stack occupies the top of the segment.

### How DOS loads a .COM file

1. DOS allocates the largest available memory block (or the entire free memory).
2. DOS builds the PSP at the base of the block (paragraph-aligned segment, offset 0000h--00FFh).
3. The .COM file image is read into memory starting at offset 0100h in the same segment.
4. DOS parses the command tail into the PSP at 80h--FFh.
5. DOS parses the first two arguments into FCBs at 5Ch and 6Ch.
6. DOS sets all segment registers and the stack, then transfers control to CS:0100h.

### Initial register state

| Register | Value | Notes |
|----------|-------|-------|
| CS | PSP segment | Code segment = PSP segment |
| DS | PSP segment | Data segment = PSP segment |
| ES | PSP segment | Extra segment = PSP segment |
| SS | PSP segment | Stack segment = PSP segment |
| SP | FFFEh (or top of block) | If the allocated block is < 64 KiB, SP = block size. A WORD of 0000h is pushed at [SS:SP] before entry. |
| IP | 0100h | Entry point -- first byte of the .COM image |
| AX | Usually 0000h | AL may reflect drive validity from FCB parsing (FFh = invalid drive in FCB #1 or #2). In practice, 0000h on most DOS versions. |
| BX | 0000h | Typically zero |
| CX | 00FFh | Often FFh, but varies by DOS version; do not rely on it |
| DX | PSP segment | Same as CS in most versions |
| SI | 0100h | Often 0100h; varies by version |
| DI | 0100h | Often 0100h; varies by version |
| BP | 0000h (or 091Ch) | Varies; do not rely on it |
| Flags | Interrupts enabled | IF=1; DF=0 (direction flag clear) |

**The 0000h word on the stack:** DOS pushes a zero word onto the stack before jumping to CS:0100h. This means a bare `RET` instruction will pop IP=0000h, landing on the `INT 20h` at PSP:0000 and cleanly terminating the program.

### What DOS initializes vs. what is garbage

**Initialized by DOS (reliable):**

- PSP:00h--01h (INT 20h instruction)
- PSP:02h--03h (top of memory)
- PSP:05h--09h (FAR CALL to DOS)
- PSP:0Ah--15h (saved INT 22h/23h/24h vectors)
- PSP:16h--17h (parent PSP)
- PSP:18h--2Bh (JFT, with handles 0-4 pre-opened)
- PSP:2Ch--2Dh (environment segment)
- PSP:50h--52h (INT 21h/RETF)
- PSP:5Ch--7Fh (FCBs, from command-line parsing)
- PSP:80h--FFh (command tail + CR)
- All segment registers, SP, IP

**Unreliable / version-dependent:**

- PSP:04h (reserved byte) -- always 00h but undefined purpose
- PSP:2Eh--31h (SS:SP on last INT 21h) -- not meaningful at program start
- PSP:32h--37h (JFT size/pointer) -- only in DOS 3.0+
- PSP:38h--3Bh (previous PSP) -- only in DOS 3.3+, and FFFF:FFFF if unused
- PSP:3Ch--4Fh (reserved) -- contents vary by DOS version and Windows
- PSP:53h--5Bh (reserved/extended FCB area) -- typically zero but not guaranteed
- General-purpose registers other than segment regs and SP (AX, BX, CX, DX, SI, DI, BP) -- commonly zero or 0100h but vary across DOS versions; do not depend on them.

---

## 9. Quick Memory Map for a .COM Program

```
Segment:0000 +------------------+
             | PSP (256 bytes)  |
             |  00h: INT 20h    |
             |  ...             |
             |  5Ch: FCB #1     |
             |  6Ch: FCB #2     |
             |  80h: cmd tail   |
Segment:0100 +------------------+  <-- IP starts here; .COM image loaded here
             |                  |
             | Program code     |
             | and data         |
             |                  |
             +------------------+
             |   (free space)   |
             +------------------+
             |     Stack        |
             |   (grows down)   |
Segment:FFFE +------------------+  <-- SP starts here (0000h pushed = return to PSP:0000)
             | 00 00            |
Segment:FFFF +------------------+
```

---

## 10. Summary of Key INT 21h Functions

| AH | Function | Relevance to PSP |
|----|----------|-------------------|
| 00h | Terminate | Like INT 20h; requires CS = PSP |
| 25h | Set Interrupt Vector | Used by TSRs to hook interrupts |
| 26h | Create New PSP | Obsolete; use 4Bh (EXEC) instead |
| 29h | Parse Filename into FCB | How DOS fills PSP:5Ch and 6Ch |
| 31h | Terminate and Stay Resident | Keeps PSP + N paragraphs resident |
| 34h | Get InDOS Flag | Critical for TSR re-entrancy |
| 35h | Get Interrupt Vector | Read current vector before hooking |
| 4Bh | EXEC (Load and Execute) | Creates child PSP, loads program |
| 4Ch | Terminate with Return Code | Clean exit; no CS requirement |
| 50h | Set Current PSP (undoc) | Switch active PSP (TSR use) |
| 51h | Get Current PSP (undoc) | Returns PSP segment in BX |
| 62h | Get PSP Address | Documented version of 51h (DOS 3.0+) |
| 67h | Set Handle Count | Expand JFT beyond 20 entries |
