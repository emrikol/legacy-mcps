# DOS EXEC Function Reference (INT 21h AH=4Bh)

Comprehensive guide to the trickiest system call in DOS. Getting this wrong will crash
DOS, corrupt memory, or fail silently. Every detail matters.

Sources: Ralf Brown's Interrupt List, HelpPC, VOGONS forums, Art of Assembly (Hyde),
UMBC CMSC211 lecture notes, Microsoft MASM documentation.

---

## 1. Function Overview

**INT 21h AH=4Bh** -- EXEC: Load and/or Execute Program (DOS 2.0+)

### Subfunctions (AL register)

| AL | Name | Description |
|----|------|-------------|
| 00h | Load and Execute | Standard child process execution |
| 01h | Load, Don't Execute | For debuggers; returns SS:SP and CS:IP in param block |
| 03h | Load Overlay | Loads code into caller-allocated memory (no PSP created) |
| 04h | Background Execute | European MS-DOS 4.0 only; do not use |

### Register Inputs

```
AH = 4Bh
AL = subfunction (00h, 01h, 03h)
DS:DX = pointer to ASCIZ filename (MUST include extension, e.g., "PROG.EXE", 0)
ES:BX = pointer to parameter block (structure depends on AL)
```

### Register Outputs

**On success (CF=0):**

- BX and DX are destroyed
- For AL=01h: offsets 0Eh-15h in param block filled with SS:SP and CS:IP

**On failure (CF=1):**

- AX = error code

### Error Codes

| AX | Meaning |
|----|---------|
| 01h | Invalid function (bad AL value) |
| 02h | File not found |
| 05h | Access denied |
| 08h | Insufficient memory (most common failure!) |
| 0Ah | Bad environment block |
| 0Bh | Bad format (corrupt EXE header) |

---

## 2. Parameter Block Layout

### AL=00h -- Load and Execute

```
Offset  Size   Description
------  ----   -----------
00h     WORD   Segment of environment block for child
               (0000h = inherit parent's environment)
02h     DWORD  Pointer to command tail (far ptr, offset:segment)
06h     DWORD  Pointer to first FCB (copied to child PSP+5Ch)
0Ah     DWORD  Pointer to second FCB (copied to child PSP+6Ch)
```

Total size: 14 bytes (0Eh)

### AL=01h -- Load, Don't Execute

Same as AL=00h, plus:

```
Offset  Size   Description
------  ----   -----------
0Eh     DWORD  [OUTPUT] Child's initial SS:SP (filled by DOS)
12h     DWORD  [OUTPUT] Child's entry point CS:IP (filled by DOS)
```

Total size: 22 bytes (16h)

### AL=03h -- Load Overlay

```
Offset  Size   Description
------  ----   -----------
00h     WORD   Segment at which to load the overlay
02h     WORD   Relocation factor for .EXE overlays
```

Total size: 4 bytes

---

## 3. Command Tail Format

The command tail is what appears at PSP:0080h in the child process. It has a very
specific format:

```
Byte 0:       Length byte (count of characters AFTER this byte, NOT counting the CR)
Bytes 1..N:   The command-line arguments
Byte N+1:     0Dh (carriage return) -- REQUIRED terminator
```

### Rules

- The length byte counts everything from byte 1 through the last character
  BEFORE the CR. Maximum value is 126 (7Eh).
- The string should start with a space (20h) for COMMAND.COM compatibility.
  COMMAND.COM always puts a leading space before the first argument.
- The CR (0Dh) terminator is mandatory but is NOT counted in the length byte.
- Some sources say a NUL (00h) follows the CR; not strictly required but harmless.

### Examples

Execute `PROG.EXE /V /F`:

```nasm
cmd_tail    db  6, ' /V /F', 0Dh    ; length=6: ' /V /F'
```

Execute with no arguments:

```nasm
cmd_tail    db  0, 0Dh              ; length=0, just the CR
```

Execute `COMMAND.COM /C DIR`:

```nasm
cmd_tail    db  7, ' /C DIR', 0Dh   ; length=7: ' /C DIR'
```

---

## 4. FCB Handling

The parameter block requires two FCB (File Control Block) pointers. These are
copied into the child's PSP at offsets 5Ch and 6Ch respectively.

### What are they for?

Legacy compatibility. DOS 1.x programs used FCBs for file access. The two FCBs
correspond to the first two filename arguments on the command line, parsed by
DOS function 29h (Parse Filename).

### Can you pass dummy/zero FCBs?

**Yes.** Most programs ignore these entirely. You have several options:

**Option A -- Point to zeroed memory:**

```nasm
dummy_fcb   db  16 dup(0)          ; 16 bytes of zeros is sufficient
; Set both FCB pointers in param block to dummy_fcb
```

**Option B -- Point to valid but empty FCBs:**

```nasm
fcb1        db  0                   ; drive 0 = default
            db  '           '       ; 11 spaces (8.3 filename)
            db  25 dup(0)           ; rest zeroed
```

**Option C -- Use -1 (0FFFFh) offset (seen in some examples):**
Some code sets the FCB pointer offsets to 0FFFFh. This works on MS-DOS but
may cause issues on DR-DOS. Prefer Option A.

### If you want proper FCBs

Use INT 21h AH=29h (Parse Filename) to parse the command tail into FCBs:

```nasm
mov  ah, 29h
mov  al, 01h          ; skip leading separators
mov  si, offset cmd_args    ; DS:SI = string to parse
mov  di, offset fcb1        ; ES:DI = target FCB
int  21h
; Repeat for fcb2 (SI now points past first parsed name)
```

---

## 5. CRITICAL: Register Destruction

### DOS 2.x: ALL registers destroyed, including SS:SP

This is the single most dangerous aspect of EXEC. After INT 21h/4Bh returns:

- **ALL general registers** (AX, BX, CX, DX, SI, DI, BP) are destroyed
- **ALL segment registers** (DS, ES, SS) are destroyed
- **SP is destroyed**
- Only **CS:IP** is preserved (so execution continues at the right place)

### DOS 3.0+: Most registers preserved, but NOT guaranteed

Microsoft documentation says DOS 3.0+ preserves registers except BX and DX.
**Do not rely on this.** Many DOS clones and versions have bugs. Always save
and restore SS:SP yourself.

### The SS:SP problem

When EXEC returns, your stack is gone. You cannot PUSH/POP, you cannot call
subroutines, you cannot do anything that touches the stack until SS:SP is
restored. The restoration code MUST:

1. Be stored in CS-relative variables (not on the stack, not in DS-relative data)
2. Execute without any stack operations between the INT 21h return and the restore

---

## 6. Saving and Restoring SS:SP

### The pattern (MANDATORY for correctness)

```nasm
; These variables MUST be in the code segment, accessible via CS:
; (In a .COM file, CS=DS=SS so this is automatic. In .EXE, use a
; separate segment or put them in the code segment explicitly.)

stk_seg     dw  0       ; saved SS -- MUST be CS-accessible
stk_ptr     dw  0       ; saved SP -- MUST be CS-accessible

exec_child:
    ; ... set up DS:DX and ES:BX ...

    mov  cs:[stk_seg], ss       ; save stack segment
    mov  cs:[stk_ptr], sp       ; save stack pointer

    mov  ax, 4B00h
    int  21h                    ; EXEC -- destroys everything

    ; Immediately restore stack. NO instructions that use the stack
    ; can appear between the INT 21h and these two MOVs.
    cli                         ; disable interrupts during SS:SP restore
    mov  ss, cs:[stk_seg]       ; restore stack segment
    mov  sp, cs:[stk_ptr]       ; restore stack pointer
    sti                         ; re-enable interrupts

    ; Now the stack is back. Save flags and restore other segments.
    pushf                       ; save carry flag from EXEC
    push cs
    pop  ds                     ; restore DS (for .COM; adjust for .EXE)

    popf                        ; get CF back
    jc   exec_failed            ; CF=1 means error, AX=error code
```

### Why CLI/STI?

Between setting SS and SP, a hardware interrupt could fire and push data onto
a half-configured stack (correct SS but wrong SP, or vice versa). The CLI
prevents this. Note: On 286+, setting SS automatically inhibits interrupts for
one instruction, so the `mov sp` immediately after `mov ss` is safe even
without CLI. But CLI/STI is defensive and works on 8086 too.

### Why CS-relative?

After EXEC returns, DS is destroyed. If your save variables are in the data
segment, you can't read them because DS is garbage. CS is the only segment
register that survives, so the variables must be reachable via CS.

In a .COM file this is automatic (CS=DS=ES=SS all point to the PSP segment).
In a .EXE file, either:

- Put the variables in the code segment with `_TEXT segment`
- Or use `org` tricks in a separate segment that CS can reach

---

## 7. Memory Management: The .COM File Problem

### Why EXEC fails with "insufficient memory" (error 08h)

When DOS loads a .COM file, it allocates ALL available conventional memory to
that program (because .COM files have no header specifying memory needs).
The program's memory block extends from the PSP to the top of conventional RAM.

When you call EXEC, DOS needs to allocate memory for the child process. But
there is none -- the parent owns it all. Result: error 08h.

### The fix: INT 21h AH=4Ah (Resize Memory Block)

Before calling EXEC, shrink the parent's memory allocation to only what it
actually uses:

```nasm
; For a .COM file:
; ES = PSP segment (set by DOS at program start; also at CS-10h sometimes)
; BX = paragraphs to keep

    mov  ah, 4Ah
    mov  bx, program_size_paragraphs  ; how many 16-byte paragraphs to keep
    int  21h
    jc   shrink_failed
```

### Calculating the size for a .COM file

```nasm
; Method: use a label at the end of all code+data
; The offset of that label, rounded up to paragraph boundary, is the size

    mov  bx, offset end_of_program
    add  bx, 15            ; round up
    shr  bx, 1             ; divide by 16 to get paragraphs
    shr  bx, 1
    shr  bx, 1
    shr  bx, 1
    add  bx, 11h           ; +10h for PSP, +1h safety margin
    mov  ah, 4Ah
    int  21h

; ... later in the file ...
end_of_program:
```

### For .EXE files

EXE files specify MINALLOC and MAXALLOC in their header. If MAXALLOC is FFFFh
(the default from many linkers), the EXE gets all memory too. Fix options:

- **Link-time:** Use `/CPARMAXALLOC:1` (MS LINK) or equivalent
- **Post-build:** Use `EXEMOD` or `EXEHDR` to patch the header
- **Runtime:** Same INT 21h/4Ah technique, but calculate size from segments:

  ```nasm
  mov  bx, ss
  add  bx, (stack_size + 15) / 16
  sub  bx, es              ; ES = PSP segment
  mov  ah, 4Ah
  int  21h
  ```

---

## 8. Complete Working Example (.COM file)

```nasm
; EXEC.COM -- Execute a child program and return its exit code
; Assemble: nasm -f bin -o exec.com exec.asm
;      or:  tasm exec.asm  /  tlink /t exec.obj

        org  100h

start:
    ; ---- Step 1: Shrink memory to what we actually need ----
    mov  sp, stack_top          ; set up a known stack location
    mov  bx, offset end_of_resident
    add  bx, 15
    mov  cl, 4
    shr  bx, cl                ; BX = paragraphs of code+data
    add  bx, 11h               ; +10h for PSP + 1 safety
    mov  ah, 4Ah               ; Resize memory block
    int  21h
    jc   err_shrink

    ; ---- Step 2: Set up parameter block ----
    mov  word [param_blk+0], 0          ; inherit parent environment
    mov  word [param_blk+2], cmd_tail   ; offset of command tail
    mov  word [param_blk+4], cs         ; segment of command tail
    mov  word [param_blk+6], fcb1       ; offset of FCB1
    mov  word [param_blk+8], cs         ; segment of FCB1
    mov  word [param_blk+0Ah], fcb2     ; offset of FCB2
    mov  word [param_blk+0Ch], cs       ; segment of FCB2

    ; ---- Step 3: Save SS:SP and call EXEC ----
    mov  [cs:save_ss], ss
    mov  [cs:save_sp], sp

    mov  dx, child_name         ; DS:DX = ASCIZ program name
    mov  bx, param_blk          ; ES:BX = parameter block
    push cs
    pop  es                     ; ES = CS (for .COM, already true)
    mov  ax, 4B00h              ; Load and execute
    int  21h

    ; ---- Step 4: Restore SS:SP immediately ----
    cli
    mov  ss, [cs:save_ss]
    mov  sp, [cs:save_sp]
    sti

    ; ---- Step 5: Restore DS, check for error ----
    push cs
    pop  ds
    jc   err_exec               ; CF=1 means EXEC failed

    ; ---- Step 6: Get child's return code ----
    mov  ah, 4Dh                ; Get return code
    int  21h
    ; AL = return code, AH = termination type
    ;   AH=0: normal, AH=1: Ctrl+C, AH=2: critical error, AH=3: TSR

    ; ---- Exit with child's return code ----
    mov  ah, 4Ch
    int  21h

err_shrink:
    mov  dx, msg_shrink
    jmp  short err_print
err_exec:
    mov  dx, msg_exec
err_print:
    mov  ah, 09h
    int  21h
    mov  ax, 4C01h
    int  21h

; ---- Data (in code segment for .COM) ----

child_name  db  'C:\COMMAND.COM', 0      ; ASCIZ -- must include extension!

cmd_tail    db  7, ' /C DIR', 0Dh        ; length, space+args, CR

fcb1        db  0                         ; drive = default
            db  '           '             ; 11 spaces (blank filename)
            db  25 dup(0)                 ; rest of FCB zeroed

fcb2        db  0
            db  '           '
            db  25 dup(0)

param_blk   dw  0                        ; environment segment
            dd  0                        ; command tail ptr  (filled at runtime)
            dd  0                        ; FCB1 ptr          (filled at runtime)
            dd  0                        ; FCB2 ptr          (filled at runtime)

save_ss     dw  0
save_sp     dw  0

msg_shrink  db  'Memory shrink failed$'
msg_exec    db  'EXEC failed$'

; ---- Stack area ----
            db  256 dup(0)              ; 256-byte stack
stack_top:

end_of_resident:
```

---

## 9. Using COMMAND.COM /C

To run a batch file or internal DOS command (DIR, COPY, TYPE, etc.), you cannot
EXEC the command directly. You must EXEC `COMMAND.COM` with `/C <command>` as
the command tail:

```nasm
child_name  db  'C:\COMMAND.COM', 0       ; or get path from COMSPEC env var

; To run "DIR /W":
cmd_tail    db  9, ' /C DIR /W', 0Dh
```

### Finding COMMAND.COM

Don't hardcode `C:\COMMAND.COM`. Instead, search the environment block for the
`COMSPEC=` variable:

```nasm
; ES = environment segment (from PSP at offset 2Ch, or from param block)
; Scan for 'COMSPEC=' string, then use the path that follows
```

The COMSPEC variable contains the full path to COMMAND.COM, e.g.,
`COMSPEC=C:\DOS\COMMAND.COM`.

---

## 10. Getting the Return Code (INT 21h AH=4Dh)

After EXEC returns successfully, retrieve the child's exit status:

```nasm
    mov  ah, 4Dh
    int  21h
    ; AL = exit code (what the child passed to INT 21h/4Ch)
    ; AH = termination method:
    ;   00h = normal (INT 21h/4Ch)
    ;   01h = Ctrl+C / Ctrl+Break
    ;   02h = Critical error abort
    ;   03h = Terminate and stay resident (INT 21h/31h)
```

**WARNING:** The return code is cleared after reading. You can only call 4Dh
once per child process termination. A second call returns zero.

---

## 11. Interrupt Vector Management

Well-behaved parent programs save and restore these interrupt vectors around
the EXEC call:

| Vector | Purpose | Why save it |
|--------|---------|-------------|
| INT 1Bh | Ctrl+Break handler | Child may install its own |
| INT 23h | Ctrl+C handler | Child may install its own |
| INT 24h | Critical error handler | Child may install its own |

```nasm
    ; Save vectors before EXEC
    mov  ax, 3523h          ; Get INT 23h vector
    int  21h
    mov  [old_23h_off], bx
    mov  [old_23h_seg], es

    ; ... do EXEC ...

    ; Restore vectors after EXEC
    mov  ax, 2523h          ; Set INT 23h vector
    lds  dx, [old_23h]
    int  21h
```

---

## 12. Known Bugs and Pitfalls

### Bug: DOS 2.x destroys SS:SP

Already covered above. Always save/restore SS:SP regardless of DOS version.

### Bug: Subfunction 01h corrupts caller's stack top

In some MS-DOS versions (including 5.00), if the loaded module terminates with
INT 21h/4Ch, the top word of the caller's stack may be corrupted.

### Bug: Subfunction 03h loads too many bytes

Load Overlay can load up to 512 extra bytes if the file has trailing data after
the overlay content.

### Bug: DOS 2.00 assumes DS = PSP

If DS doesn't point to the current program's PSP on entry to the EXEC call
under DOS 2.00, behavior is undefined.

### Pitfall: Filename must include extension

EXEC does not search for extensions. `PROG` will fail; you must specify
`PROG.EXE` or `PROG.COM`.

### Pitfall: File format detection ignores extension

DOS checks the first two bytes for `MZ` or `ZM` (EXE signature). If found,
it's loaded as an EXE. Otherwise, it's treated as a COM file regardless of
the filename extension. A file named `FOO.EXE` with no MZ header will be
loaded as a COM.

### Pitfall: Environment block must be paragraph-aligned

If you pass a custom environment segment, it must point to a valid
paragraph-aligned memory block allocated with INT 21h/48h.

### Pitfall: DR-DOS parameter validation

DR-DOS 6.0 and later reject parameter blocks with invalid pointer values
(like FFFFh offsets for FCBs). MS-DOS is more forgiving.

### Pitfall: Path separators

Both `\` and `/` work as path separators in the filename, but avoid mixing them.

### Pitfall: Program must be .COM or .EXE

You cannot EXEC a .BAT file directly. Use `COMMAND.COM /C BATCH.BAT` instead.

---

## 13. Checklist Before Calling EXEC

1. [ ] Shrink memory with INT 21h/4Ah (essential for .COM; check for .EXE too)
2. [ ] Filename is ASCIZ with extension included
3. [ ] Parameter block is fully populated (environment, cmd tail, FCB1, FCB2)
4. [ ] Command tail has correct format: length byte, leading space, args, 0Dh
5. [ ] SS:SP saved in CS-relative variables
6. [ ] DS:DX points to filename, ES:BX points to parameter block
7. [ ] SS:SP restore code uses CLI/STI or is interrupt-safe
8. [ ] DS restored from CS after EXEC returns
9. [ ] CF checked for error (AX = error code)
10. [ ] INT 21h/4Dh called to get return code (only once -- it clears after read)

---

## 14. Quick Reference: Parameter Block as NASM Structure

```nasm
; For AL=00h (Load and Execute):
struc EXEC_PARM
    .env_seg    resw 1      ; +00h  environment segment (0=inherit)
    .cmd_off    resw 1      ; +02h  command tail offset
    .cmd_seg    resw 1      ; +04h  command tail segment
    .fcb1_off   resw 1      ; +06h  first FCB offset
    .fcb1_seg   resw 1      ; +08h  first FCB segment
    .fcb2_off   resw 1      ; +0Ah  second FCB offset
    .fcb2_seg   resw 1      ; +0Ch  second FCB segment
endstruc
; Total: 14 bytes (0Eh)

; For AL=03h (Load Overlay):
struc OVERLAY_PARM
    .load_seg   resw 1      ; +00h  segment to load at
    .reloc      resw 1      ; +02h  relocation factor
endstruc
; Total: 4 bytes
```

---

## Sources

- [Ralf Brown's Interrupt List -- INT 21/AH=4Bh](https://fd.lod.bz/rbil/interrup/dos_kernel/214b.html)
- [CTYME Interrupt Reference -- INT 21/AH=4Bh](https://ctyme.com/intr/rb-2939.htm)
- [HelpPC -- INT 21,4B](https://stanislavs.org/helppc/int_21-4b.html)
- [VOGONS -- How to use DOS INT 21h+4Bh](https://www.vogons.org/viewtopic.php?t=87088)
- [VOGONS -- Using INT 21h 4Bh from QuickBASIC](https://www.vogons.org/viewtopic.php?t=95064)
- [Art of Assembly, Ch. 13 -- DOS Memory Management](https://www.plantation-productions.com/Webster/www.artofasm.com/DOS/ch13/CH13-5.html)
- [MASM Assembly Language Help -- Function 4Bh](https://dos-help.soulsphere.org/alang.hlp/x_at_L82f2.html)
- [UMBC CMSC211 -- EXEC Example](https://courses.cs.umbc.edu/undergraduate/CMSC211/Fall00/Burt/lectures/Chap17/redirectingStderr.html)
- [osFree Wiki -- INT 21h AH=4Bh](http://www.osfree.org/doku/en:docs:dos:api:int21:4b)
- [Assembly Language Help -- Function 4Dh](https://fragglet.github.io/dos-help-files/alang.hlp/x_at_L82f5.html)
