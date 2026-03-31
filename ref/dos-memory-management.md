# DOS Memory Management for TSR Programming and EXEC

Reference covering memory shrinking (INT 21h/4Ah), EXEC prerequisites (INT 21h/4Bh),
resident size calculation (INT 21h/31h), and related topics.

---

## 1. .COM File Memory Layout

When DOS loads a .COM file, the memory layout within the single segment is:

```
Offset 0000h  +-----------------------+
              |  PSP (256 bytes)      |  Program Segment Prefix
Offset 0100h  +-----------------------+
              |  Program code + data  |  .COM file loaded here
              |  ...                  |
Offset ????h  +-----------------------+
              |  Uninitialized data   |  BSS / scratch buffers
              |  ...                  |
              +-----------------------+
              |  Stack (grows down)   |  SP starts at FFFEh (or top of available memory)
Offset FFFFh  +-----------------------+
```

Key facts:

- The PSP is **256 bytes (100h)** and occupies offsets 0000h-00FFh.
- Program code begins at CS:0100h. IP is set to 0100h on entry.
- CS = DS = ES = SS = the PSP segment on entry.
- SP is set to FFFEh (top of segment) or the top of available memory, whichever is lower.
- **DOS allocates ALL available conventional memory** to the .COM file, not just 64K.
  The MCB for the program covers everything from the PSP to the end of free memory.

### PSP Key Fields

| Offset | Size | Description |
|--------|------|-------------|
| 00h | 2 | INT 20h instruction (CD 20) |
| 02h | 2 | Top of memory, segment form |
| 0Ah | 4 | INT 22h (terminate) address |
| 0Eh | 4 | INT 23h (Ctrl-Break) address |
| 12h | 4 | INT 24h (critical error) address |
| 16h | 2 | Parent process PSP segment |
| 2Ch | 2 | **Segment of environment block** |
| 50h | 3 | INT 21h retf dispatcher |
| 5Ch | 16 | Default FCB #1 |
| 6Ch | 16 | Default FCB #2 |
| 80h | 1 | Command tail length |
| 81h | 127 | Command tail string |

---

## 2. Memory Control Blocks (MCBs)

Every allocated memory block is preceded by a 16-byte MCB (one paragraph):

| Offset | Size | Description |
|--------|------|-------------|
| 00h | 1 | 'M' (4Dh) = chain continues; 'Z' (5Ah) = last block |
| 01h | 2 | Owner PSP segment (0 = free, 8 = DOS-owned) |
| 03h | 2 | Size of block in paragraphs (excluding MCB itself) |
| 08h | 8 | Program name, null-terminated (DOS 4.0+) |

The MCB sits at `segment - 1` relative to the allocated block. So if your PSP is at
segment 1234h, the MCB is at 1233h:0000.

The MCB chain starts at a fixed location obtainable via INT 21h/52h (Get List of Lists),
offset -2 from the returned pointer.

---

## 3. Shrinking Memory with INT 21h/4Ah (SETBLOCK)

### Why It's Needed

DOS gives a .COM file ALL of conventional memory. You must shrink your allocation before:

- Calling EXEC (INT 21h/4Bh) to run a child process
- Calling INT 21h/48h to allocate additional memory blocks
- Going resident (to avoid wasting memory)

### Calling Convention

```asm
; INT 21h / AH=4Ah - Resize Memory Block (SETBLOCK)
; Input:
;   AH = 4Ah
;   ES = segment of the block to resize (the PSP segment)
;   BX = new size in paragraphs
; Output:
;   CF = 0: success
;   CF = 1: AX = error code
;           BX = max paragraphs available (if error 8)
;
; Error codes:
;   7 = MCB chain destroyed
;   8 = insufficient memory (BX = max available)
;   9 = invalid block address
```

### For .COM Files

On entry, ES already points to the PSP, so you don't need to set it. Just calculate BX:

```asm
; Method 1: Simple - use a label at end of program
mov     bx, offset end_of_program
add     bx, 0Fh          ; round up to next paragraph
shr     bx, 4            ; convert bytes to paragraphs
add     bx, 10h          ; add 10h paragraphs for the PSP
mov     ah, 4Ah
int     21h

; Method 2: With explicit stack
; If you relocate the stack, include it in the calculation:
;   BX = (end_of_program + stack_size + 0Fh) >> 4 + 10h
```

The `+10h` for the PSP is critical. The offset of `end_of_program` is relative to
CS:0000 (the PSP base), but offset 0000h-00FFh IS the PSP. Since offset 0100h is
where code starts, and the label `end_of_program` is an offset from CS:0000, the
PSP is already included in the offset. The `+10h` accounts for the fact that BX is
in paragraphs from ES (which is the PSP segment), so you're effectively saying:
"keep from the PSP through end_of_program."

Actually, let's be precise:

```
BX = (offset end_of_program + 15) / 16
```

This works because `offset end_of_program` is already measured from the start of
the PSP (CS:0000 = ES:0000 for .COM files). You divide by 16 to convert to
paragraphs and round up. The PSP's 256 bytes (= 10h paragraphs) are automatically
included in this offset since code starts at 0100h.

### For .EXE Files

ES does NOT initially point to the PSP in .EXE files (it does, actually -- DS and ES
both point to PSP on entry for .EXE too). The calculation is more complex because
code, data, and stack may be in different segments:

```asm
; Typical .EXE shrink pattern:
mov     bx, ss
mov     ax, es            ; ES = PSP
sub     bx, ax            ; paragraphs from PSP to stack segment
add     bx, stack_size_paragraphs
inc     bx                ; safety margin
mov     ah, 4Ah
int     21h
```

---

## 4. EXEC Function (INT 21h/4Bh)

### Prerequisites

You **MUST** shrink memory first (INT 21h/4Ah). If you don't, EXEC returns:

- CF = 1, AX = 8 (insufficient memory)

This is the single most common mistake when trying to use EXEC from a .COM file.

### The Correct Sequence

```asm
; 1. Shrink memory to what we actually need (+ space for our stack)
    mov     bx, (offset end_of_resident + stack_size + 15) / 16
    mov     ah, 4Ah
    int     21h
    jc      error_shrink

; 2. Set up the EXEC parameter block
    ; ... fill in the EPB structure ...

; 3. Save SS:SP (EXEC destroys them in DOS 2.x)
    mov     [save_ss], ss
    mov     [save_sp], sp

; 4. Call EXEC
    mov     ah, 4Bh
    mov     al, 0           ; 0 = load and execute
    lea     dx, program_path  ; DS:DX = ASCIIZ program name
    lea     bx, exec_param_block  ; ES:BX = parameter block
    int     21h

; 5. Restore SS:SP
    cli
    mov     ss, cs:[save_ss]
    mov     sp, cs:[save_sp]
    sti

; 6. Check result
    jc      exec_failed     ; AX = error code
```

### EXEC Parameter Block (EPB)

```
Offset  Size  Description
  00h    2    Segment of environment to copy (0 = inherit parent's)
  02h    4    Pointer to command tail (CS-relative for .COM)
  06h    4    Pointer to first FCB (can point to dummy)
  0Ah    4    Pointer to second FCB (can point to dummy)
```

### Important EXEC Caveats

- All registers except CS:IP are **undefined** after EXEC returns (DOS 2.x).
  DOS 3.0+ preserves most registers, but always save/restore SS:SP to be safe.
- The child program gets its own PSP; your PSP is preserved.
- You need enough free memory for the child program AND its own PSP + MCB.

---

## 5. Going Resident: INT 21h/31h (Keep Process)

### Calling Convention

```asm
; INT 21h / AH=31h - Terminate and Stay Resident
; Input:
;   AH = 31h
;   AL = return code (exit status)
;   DX = number of paragraphs to keep resident
; Output:
;   Does not return. Memory from PSP through (PSP + DX*16 - 1) stays allocated.
;   Everything beyond that is freed.
```

### Calculating DX (Resident Size in Paragraphs)

For a .COM file, the calculation is:

```asm
; Place a label at the end of the resident portion of your code/data:
resident_end:

; Installation code goes AFTER this label (it won't be kept)

; Calculate paragraphs:
    mov     dx, offset resident_end
    add     dx, 0Fh           ; round up
    shr     dx, 4             ; convert to paragraphs
    ; No need to add 10h -- the offset is from CS:0000 which IS the PSP
    mov     ax, 3100h         ; AH=31h, AL=00h (exit code 0)
    int     21h
```

The offset `resident_end` is measured from CS:0000 (= the PSP base), so the 256-byte
PSP is already accounted for. The formula is simply:

```
DX = (offset resident_end + 15) / 16
```

This keeps memory from the PSP through the end of your resident code/data.

### Where Is "End of Program" for .COM with BSS?

If your TSR has uninitialized data (BSS) after the code:

```asm
; --- Resident code ---
handler:
    ...
    iret

; --- Resident data ---
my_buffer   db  128 dup (?)    ; BSS - not in the .COM file but needed at runtime

resident_end:                   ; <<< label goes AFTER all resident BSS

; --- Installation code (discarded after going resident) ---
install:
    ...
```

The key insight: `resident_end` must come after ALL memory your resident code will
use, including uninitialized buffers. If you put the label before the BSS area, your
resident code will scribble on memory that DOS has freed and given to other programs.

### Minimum Resident Size

- DOS 2.x: minimum 11h paragraphs (272 bytes -- enough for PSP + a bit)
- DOS 3.0+: minimum 06h paragraphs (96 bytes)

In practice, you always need at least 11h (the full PSP + 16 bytes).

---

## 6. Freeing the Environment Block

The environment block is a separate memory allocation that contains the environment
strings (PATH=, COMSPEC=, etc.). For a TSR, this memory is wasted -- the resident code
doesn't need it.

### How to Free It

```asm
; The environment segment is at PSP:002Ch
    mov     es, cs:[002Ch]    ; ES = environment segment
    mov     ah, 49h           ; Free memory block
    int     21h
    jc      .env_free_failed  ; shouldn't fail, but check anyway

    ; Optional: zero out the pointer so we know it's freed
    mov     word cs:[002Ch], 0
```

### When to Free It

Free the environment **before** calling INT 21h/31h, during your installation routine.
The environment block is typically 160-512 bytes, which is meaningful for a TSR.

### Savings

The environment block is at least one paragraph (16 bytes) plus the MCB overhead
(another 16 bytes), but typically 160-512 bytes. For a TSR that aims to be small,
this is worth recovering.

---

## 7. INT 27h vs INT 21h/31h

| Feature | INT 27h (DOS 1.0+) | INT 21h/31h (DOS 2.0+) |
|---------|--------------------|-----------------------|
| Max resident size | 64 KB (limited by DX being offset within segment) | 64 KB * 65536 paragraphs = unlimited (practical) |
| Size parameter | DX = byte offset of last byte + 1, from PSP | DX = paragraphs to keep |
| Exit code | None | AL = exit code |
| Files | NOT closed on exit | Closed on exit |
| Availability | DOS 1.0+ | DOS 2.0+ |

### INT 27h Calling Convention

```asm
; INT 27h - Terminate and Stay Resident (old method)
; Input:
;   DX = offset of last resident byte + 1 (relative to PSP segment)
;   CS = PSP segment
; Limitation: DX is a 16-bit offset, so max 64 KB from PSP.
```

### Recommendation

Always use INT 21h/31h. INT 27h is obsolete and has the 64K limitation.
The only reason to use INT 27h is if you need DOS 1.x compatibility (you don't).

---

## 8. LOADHIGH / LH and Upper Memory

### What LOADHIGH Does

`LOADHIGH` (or `LH`) is a COMMAND.COM built-in (DOS 5.0+) that loads a program into
an Upper Memory Block (UMB) instead of conventional memory. UMBs are in the region
between 640K and 1024K (A0000h-FFFFFh), in gaps between ROM and video memory.

### Prerequisites

```
; CONFIG.SYS:
DEVICE=C:\DOS\HIMEM.SYS        ; XMS driver
DEVICE=C:\DOS\EMM386.EXE NOEMS ; or RAM -- provides UMB access
DOS=HIGH,UMB                   ; link UMBs into DOS memory chain

; AUTOEXEC.BAT:
LH C:\TSR\MYTSR.COM
```

### Does the TSR Need Special Code?

**No.** LOADHIGH is transparent to the TSR. DOS handles the allocation:

1. DOS allocates a UMB for the program
2. Loads it there instead of conventional memory
3. The PSP segment and CS/DS/ES/SS all point into the UMB
4. INT 21h/4Ah and INT 21h/31h work normally -- they just operate on UMB memory

The TSR does not need to know or care whether it was loaded high or low. All the
standard memory management calls work the same way.

### Self-Loading to Upper Memory

Some advanced TSRs load themselves into upper memory without needing LOADHIGH, using
XMS calls (INT 2Fh/4310h) to allocate UMBs directly. This is more complex and
generally unnecessary if the user has `LH` available.

### Caveats

- If the UMB is too small, DOS silently loads the program in conventional memory.
  (DOS 6.0's `LH /L:region` gives more control.)
- LOADHIGH is a COMMAND.COM feature, not available from CONFIG.SYS.
  For CONFIG.SYS drivers, use `DEVICEHIGH=` instead.
- MEMMAKER (DOS 6.0) can automatically optimize LOADHIGH placement.

---

## 9. Practical Patterns

### Pattern A: TSR That Just Hooks an Interrupt

```asm
org     100h

start:
    jmp     install

; --- Resident section ---
old_int:    dd  0

new_handler:
    ; ... your ISR ...
    jmp     far [cs:old_int]

resident_data:
    db  64 dup (?)          ; any resident buffers

resident_end:

; --- Installation (discarded after going resident) ---
install:
    ; Hook the interrupt
    mov     ax, 3521h       ; get old INT 21h vector (example)
    int     21h
    mov     word [old_int], bx
    mov     word [old_int+2], es

    mov     ax, 2521h       ; set new INT 21h vector
    lea     dx, [new_handler]
    int     21h

    ; Free environment
    mov     es, [002Ch]
    mov     ah, 49h
    int     21h

    ; Go resident
    mov     dx, offset resident_end
    add     dx, 0Fh
    shr     dx, 4
    mov     ax, 3100h
    int     21h
```

### Pattern B: Program That Needs to EXEC a Child

```asm
org     100h

start:
    ; Shrink memory first!
    mov     bx, offset program_end
    add     bx, stack_size
    add     bx, 0Fh
    shr     bx, 4
    mov     ah, 4Ah
    int     21h
    jc      no_memory

    ; ... set up EPB, save SS:SP, call 4Bh ...

program_end:
```

### Pattern C: Combined (TSR That Also Execs During Install)

```asm
org     100h

start:
    jmp     install

; --- Resident ---
    ; ... handlers, data ...
resident_end:

; --- Install ---
install:
    ; Shrink to include install code + stack
    mov     bx, offset install_end
    add     bx, 200h         ; 512 bytes for stack
    add     bx, 0Fh
    shr     bx, 4
    mov     ah, 4Ah
    int     21h
    jc      fail

    ; ... do EXEC if needed ...

    ; Now go resident (keeping only the resident portion)
    mov     dx, offset resident_end
    add     dx, 0Fh
    shr     dx, 4
    mov     ax, 3100h
    int     21h

install_end:
```

---

## 10. Quick Reference: Paragraph Math

- 1 paragraph = 16 bytes
- To convert bytes to paragraphs: `(bytes + 15) / 16` or `(bytes + 15) >> 4`
- PSP = 10h paragraphs = 256 bytes
- MCB = 1 paragraph = 16 bytes (sits just before the allocated block)
- The segment address of a block IS its paragraph address

### Common Sizes in Paragraphs

| Item | Bytes | Paragraphs |
|------|-------|------------|
| PSP | 256 | 10h |
| MCB | 16 | 1 |
| Environment (typical) | 160-512 | 0Ah-20h |
| Minimum TSR (DOS 3+) | 96 | 06h |
| 1 KB | 1024 | 40h |
| 64 KB | 65536 | 1000h |

---

## Sources

- [INT 21h Function 4Ah - Assembly Language Help](https://dos-help.soulsphere.org/alang.hlp/x_at_L82ef.html)
- [DOS Memory Management - OS/2 Museum](https://www.os2museum.com/wp/dos-memory-management/)
- [Art of Assembly Ch.13: MS-DOS Memory Management Functions](https://www.plantation-productions.com/Webster/www.artofasm.com/DOS/ch13/CH13-5.html)
- [Art of Assembly Ch.18: Resident Programs](https://www.plantation-productions.com/Webster/www.artofasm.com/DOS/ch18/CH18-1.html)
- [Art of Assembly Ch.18 Part 4: Freeing Environment](https://www.plantation-productions.com/Webster/www.artofasm.com/DOS/ch18/CH18-4.html)
- [Terminate and Stay Resident Programming - fysnet.net](https://www.fysnet.net/tsrdemo.htm)
- [MCB - DOS Memory Control Block Format](https://stanislavs.org/helppc/memory_control_block.html)
- [PSP - DOS Program Segment Prefix Layout](https://stanislavs.org/helppc/program_segment_prefix.html)
- [More Memory for DOS Exec - Dr. Dobb's](https://www.drdobbs.com/parallel/more-memory-for-dos-exec/184408115)
- [DOS Memory Management - VOGONS Wiki](https://www.vogonswiki.com/index.php/DOS_memory_management)
- [LOADHIGH - Wikipedia](https://en.wikipedia.org/wiki/LOADHIGH)
- [Upper Memory Area - Wikipedia](https://en.wikipedia.org/wiki/Upper_memory_area)
- [Terminate-and-stay-resident program - Wikipedia](https://en.wikipedia.org/wiki/Terminate-and-stay-resident_program)
- [INT 21h/31h - Ralf Brown's Interrupt List](http://www.ctyme.com/intr/rb-2723.htm)
- [DOS and .COM Memory Usage - Tek-Tips](https://www.tek-tips.com/threads/dos-and-com-memory-usage.1195190/)
- [How to Use DOS INT 21h + 4Bh - VOGONS](https://www.vogons.org/viewtopic.php?t=87088)
- [DOS Memory Management - Rob van der Woude](https://www.robvanderwoude.com/dosmem.php)
- [Looking at Conventional Memory and MCBs - fysnet.net](http://www.fysnet.net/mcb.htm)
