# DOS TSR Programming Reference Guide

Compiled from Art of Assembly (Randall Hyde, Ch. 18), Ralf Brown's Interrupt List,
Wikipedia, Stack Overflow, and various DOS programming references.
Target: 8086-compatible TSR in NASM assembly, .COM format.

---

## Table of Contents

1. [Going Resident: INT 27h vs INT 21h/31h](#1-going-resident-int-27h-vs-int-21h31h)
2. [.COM TSR Memory Layout](#2-com-tsr-memory-layout)
3. [Memory Calculation for Resident Portion](#3-memory-calculation-for-resident-portion)
4. [Interrupt Handler Rules](#4-interrupt-handler-rules)
5. [Hooking Interrupts: Chain vs Replace](#5-hooking-interrupts-chain-vs-replace)
6. [The DOS Reentrancy Problem](#6-the-dos-reentrancy-problem)
7. [The InDOS Flag (INT 21h/34h)](#7-the-indos-flag-int-21h34h)
8. [INT 28h: The DOS Idle Interrupt](#8-int-28h-the-dos-idle-interrupt)
9. [Critical Error Handler Considerations](#9-critical-error-handler-considerations)
10. [Safely Doing File I/O from a TSR](#10-safely-doing-file-io-from-a-tsr)
11. [Hooking INT 1Ch (Timer Tick)](#11-hooking-int-1ch-timer-tick)
12. [Hooking INT 9h (Keyboard)](#12-hooking-int-9h-keyboard)
13. [The Multiplex Interrupt (INT 2Fh)](#13-the-multiplex-interrupt-int-2fh)
14. [TSR Removal / Unloading](#14-tsr-removal--unloading)
15. [Complete Checklist for a File-I/O TSR](#15-complete-checklist-for-a-file-io-tsr)

---

## 1. Going Resident: INT 27h vs INT 21h/31h

### INT 27h -- Terminate But Stay Resident (the old way)

- **Inputs:** CS = PSP segment, DX = offset of last byte to keep + 1
- **Limitation:** Can only keep up to 64 KB resident (DX is a 16-bit offset
  from the PSP segment)
- Does NOT close open file handles
- Does NOT return an exit code
- Available since DOS 1.0
- Rarely used in practice; exists mainly for historical reasons

```nasm
; INT 27h example (.COM file)
; DX = offset past last resident byte, relative to CS (= PSP in .COM)
mov  dx, resident_end     ; label at end of resident code
int  27h
```

### INT 21h/31h -- Keep Process (the correct way)

- **Inputs:** AH = 31h, AL = exit code (usually 0), DX = resident size in
  **paragraphs** (16-byte units)
- No 64 KB limit (DX is in paragraphs, so max ~1 MB)
- Returns an exit code to the parent process / ERRORLEVEL
- Does NOT close open file handles (same as INT 27h)
- Available since DOS 2.0
- **This is what you should use.**

```nasm
; INT 21h/31h example (.COM file)
; Calculate paragraphs: (resident_end - PSP_start + 15) / 16
; In a .COM file, CS = DS = ES = SS = PSP segment
mov  ax, resident_end     ; offset of end of resident portion
add  ax, 15               ; round up to next paragraph
shr  ax, 4                ; convert bytes to paragraphs
mov  dx, ax
mov  ax, 3100h            ; AH=31h, AL=00h (exit code 0)
int  21h
```

### Key Difference Summary

| Feature            | INT 27h          | INT 21h/31h        |
|--------------------|------------------|---------------------|
| Max resident size  | 64 KB            | ~1 MB (paragraphs) |
| Size unit          | Bytes (offset)   | Paragraphs (16 B)  |
| Exit code          | No               | Yes (AL)            |
| DOS version        | 1.0+             | 2.0+                |
| Usage              | Obsolete         | Preferred           |

---

## 2. .COM TSR Memory Layout

A .COM file is loaded at offset 100h within its segment. The first 100h bytes
are the PSP (Program Segment Prefix). The key insight for TSR design: **put all
resident code and data BEFORE the transient (init) code.**

```
Offset 0000h  +---------------------------+
              |  PSP (256 bytes)           |  <- DOS creates this
Offset 0100h  +---------------------------+
              |  Resident code & data      |  <- Stays in memory
              |  (interrupt handlers,      |
              |   variables, buffers)      |
              +---------------------------+
              |  resident_end label here   |  <- Boundary marker
              +---------------------------+
              |  Transient / init code     |  <- Freed after going TSR
              |  (installs hooks, prints   |
              |   banner, calls INT 21/31) |
              +---------------------------+
```

**Important:** The program entry point (at 100h) must jump over the resident
section to reach the init code:

```nasm
org 100h

start:
    jmp  init            ; Skip over resident portion

; === RESIDENT SECTION (stays in memory) ===

old_int1c:  dd 0         ; Saved old INT 1Ch vector
counter:    dw 0         ; Example variable
; ... interrupt handlers here ...

resident_end:            ; Label marking end of resident portion

; === TRANSIENT SECTION (freed after going TSR) ===

init:
    ; Install interrupt hooks
    ; Calculate resident size
    ; Go TSR via INT 21h/31h
```

---

## 3. Memory Calculation for Resident Portion

For a .COM file using INT 21h/31h, DX must contain the number of paragraphs
to keep resident, measured from the **start of the PSP** (not from 100h).

```nasm
; resident_end is a label at the end of resident code/data
mov  ax, resident_end    ; Offset from start of segment
add  ax, 15              ; Round up: (offset + 15)
shr  ax, 4               ;   / 16 = paragraphs from PSP start
mov  dx, ax              ; DX = paragraphs to keep
mov  ax, 3100h
int  21h
```

If `resident_end` = 0300h (768 bytes from PSP start):

- (0300h + 0Fh) = 030Fh
- 030Fh >> 4 = 030h = 48 paragraphs = 768 bytes

The PSP itself (100h = 256 bytes = 16 paragraphs) is automatically included
because `resident_end` is measured from offset 0, not offset 100h.

### Freeing the Environment Block

A .COM TSR should free its environment block to save memory (~160-1024 bytes):

```nasm
; The environment segment is stored at PSP offset 2Ch
mov  es, [002Ch]         ; ES = environment segment
mov  ah, 49h             ; DOS: Free Memory Block
int  21h
```

Do this during init, before going resident.

---

## 4. Interrupt Handler Rules

### What the CPU does on interrupt

1. Pushes FLAGS, CS, IP onto the stack (in that order)
2. Clears IF (interrupts disabled) and TF (trap flag)
3. Jumps to the handler address from the IVT

### What your handler MUST do

1. **Save ALL registers you modify.** The interrupted program does not expect
   any register to change. Use PUSH/POP or PUSHA/POPA (186+). For 8086
   compatibility, push each register individually.

2. **End with IRET** (if not chaining). IRET pops IP, CS, FLAGS -- restoring
   the interrupted program's state including the interrupt flag.

3. **Keep it short.** Hardware interrupt handlers should do minimal work.
   Set a flag and let a polling loop or timer do the heavy lifting.

4. **Use CS: prefix for data access.** DS, ES, SS are unknown -- they belong
   to whatever program was interrupted. Either use CS-relative addressing or
   load your own DS:

   ```nasm
   my_handler:
       push ds
       push ax
       push cs
       pop  ds            ; DS = CS = our segment
       ; ... now we can access our data normally ...
       pop  ax
       pop  ds
       iret
   ```

5. **Send EOI for hardware interrupts.** For IRQ 0-7 (INT 08h-0Fh):

   ```nasm
   mov  al, 20h
   out  20h, al          ; Send EOI to PIC
   ```

   If you chain to the old handler, it typically sends the EOI for you.
   Do NOT send EOI twice.

6. **CLI/STI considerations:**
   - The CPU clears IF on entry. You are already in a "CLI" state.
   - Use `STI` if your handler takes a long time and you want to allow
     higher-priority interrupts to nest.
   - Use `CLI` before modifying shared data structures.
   - IRET restores FLAGS including the original IF state.

### What your handler must NOT do

- **Do NOT call DOS (INT 21h) from a hardware interrupt handler** without
  checking the InDOS flag first. DOS is not reentrant. See section 6.
- **Do NOT assume DS, ES, or SS values.** They belong to the interrupted code.
- **Do NOT use the interrupted program's stack excessively.** The stack may
  have very little space. If you need significant stack space, switch to your
  own stack (see section 10).

---

## 5. Hooking Interrupts: Chain vs Replace

### Getting the old vector (INT 21h/35h)

```nasm
mov  ah, 35h
mov  al, 1Ch             ; Interrupt number to query
int  21h
; ES:BX = current handler address
mov  [old_int1c], bx     ; Save offset
mov  [old_int1c+2], es   ; Save segment
```

### Setting the new vector (INT 21h/25h)

```nasm
mov  ah, 25h
mov  al, 1Ch             ; Interrupt number to set
mov  dx, my_int1c        ; DS:DX = new handler (DS=CS in .COM)
int  21h
```

### Alternative: Direct IVT manipulation

The IVT lives at 0000:0000. Each entry is 4 bytes (offset:segment).
INT n is at address n*4.

```nasm
cli                      ; Disable interrupts during modification!
xor  ax, ax
mov  es, ax              ; ES = 0000 (IVT segment)
mov  bx, [es:1Ch*4]      ; Old offset
mov  [old_int1c], bx
mov  bx, [es:1Ch*4+2]    ; Old segment
mov  [old_int1c+2], bx
mov  [es:1Ch*4], word my_handler
mov  [es:1Ch*4+2], cs
sti
```

Using INT 21h/25h and 35h is generally safer and more portable.

### Chaining: pass-through to old handler

```nasm
my_int1c:
    push ax               ; Save what we use
    ; ... do our work ...
    pop  ax
    jmp  far [cs:old_int1c]   ; Chain to original handler
                              ; (the old handler does IRET)
```

**JMP FAR vs CALL FAR + IRET:**

- `jmp far` is simpler; the old handler's IRET returns directly to the
  interrupted program.
- `pushf` + `call far` lets you regain control after the old handler returns:

```nasm
my_int1c:
    pushf                    ; Simulate INT (push flags)
    call far [cs:old_int1c]  ; Call old handler (it does IRET)
    ; Control returns here after old handler
    ; ... do our post-processing ...
    iret
```

### Replacing: handle entirely yourself

```nasm
my_int1c:
    push ax
    ; ... do all work ourselves ...
    mov  al, 20h
    out  20h, al          ; Send EOI (if hardware interrupt)
    pop  ax
    iret                  ; Return to interrupted program
```

**Caution:** Replacing without chaining breaks other TSRs and system
functionality that depend on the same interrupt.

---

## 6. The DOS Reentrancy Problem

**This is the single most important issue for TSRs that need to call DOS.**

### The Problem

DOS is **not reentrant**. It uses a single set of internal stacks and global
data structures. If a hardware interrupt fires while DOS is executing an
INT 21h call, and your interrupt handler also calls INT 21h, DOS's internal
state is corrupted. This typically causes a system crash or data loss.

### Why it matters for our TSR

Our TSR hooks the timer interrupt and needs to do file I/O (which requires
INT 21h calls). The timer interrupt fires ~18.2 times per second. There is a
significant probability that it will fire while DOS is already busy.

### The solution: InDOS flag + deferred execution

The pattern used by all serious TSRs:

1. In the interrupt handler, set a "want to do work" flag
2. Check the InDOS flag
3. If DOS is idle (InDOS == 0 AND CritErr == 0), do the work now
4. If DOS is busy, defer: the timer handler will retry next tick
5. Also hook INT 28h (idle interrupt) for an additional opportunity

---

## 7. The InDOS Flag (INT 21h/34h)

### Getting the InDOS flag address

```nasm
; Call this once during init, save the pointer
mov  ah, 34h
int  21h
; ES:BX = address of the one-byte InDOS flag
mov  [indos_ptr], bx
mov  [indos_ptr+2], es
```

### The InDOS flag behavior

- DOS increments InDOS on entry to any INT 21h function
- DOS decrements InDOS on exit from any INT 21h function
- When InDOS == 0, no INT 21h call is in progress; safe to call DOS
- When InDOS >= 1, DOS is busy; do NOT call INT 21h

### The Critical Error flag

There is a second flag you must also check: the **critical error flag**
(also called CritErr flag).

- **DOS 3.1+:** The critical error flag is at the byte **immediately before**
  the InDOS flag (i.e., ES:BX-1 after INT 21h/34h)
- **DOS 2.x:** The critical error flag is immediately **after** InDOS

During a critical error (Abort/Retry/Fail), DOS decrements InDOS but sets
the CritErr flag. So InDOS may read as 0 even though DOS is in an error
handler. You MUST check both.

```nasm
; Check if DOS is safe to call
; Assumes indos_ptr was set up during init
check_dos_safe:
    push es
    push bx
    les  bx, [cs:indos_ptr]
    mov  al, [es:bx]       ; InDOS flag
    or   al, [es:bx-1]     ; OR with CritErr flag (DOS 3.1+)
    pop  bx
    pop  es
    ; AL = 0 means safe, nonzero means busy
    ret
```

### Getting CritErr address explicitly (DOS 5.0+)

```nasm
mov  ax, 5D06h             ; Undocumented: Get CritErr flag address
int  21h
; DS:SI = address of critical error flag
```

For maximum compatibility (DOS 3.1+), just use `[ES:BX-1]` relative to the
InDOS pointer.

---

## 8. INT 28h: The DOS Idle Interrupt

### What it is

When DOS is waiting for keyboard input (e.g., at the command prompt, or during
any character input function 01h-0Ch), it executes INT 28h in a tight loop.
The default handler is just an IRET.

### Why it matters

At the moment INT 28h fires, InDOS is typically set to 1 (because DOS is
inside a character input function). BUT -- it is safe to call INT 21h
functions **with function numbers > 0Ch** during INT 28h.

This gives your TSR an additional window to do file I/O: if the timer tick
fires and InDOS is 1 (not higher), check if we're in an INT 28h context.
Many TSRs hook INT 28h as a secondary activation point.

### Rules for INT 28h handlers

- You MAY call INT 21h functions 0Dh-FFh (file I/O, memory, etc.)
- You must NOT call INT 21h functions 00h-0Ch (character I/O) -- these are
  what DOS is already executing
- Under DOS 2.x, you must set the critical error flag before calling
  functions 50h/51h
- If InDOS > 1, DOS is truly busy (nested call); do not call DOS at all
- Always chain to the old INT 28h handler

```nasm
my_int28:
    pushf
    call far [cs:old_int28]  ; Chain first

    cmp  byte [cs:need_io], 0
    je   .done

    ; Check: InDOS must be exactly 1 (the character input call)
    les  bx, [cs:indos_ptr]
    cmp  byte [es:bx], 1
    ja   .done               ; If > 1, truly busy
    cmp  byte [es:bx-1], 0   ; CritErr must be 0
    jne  .done

    call do_deferred_io      ; Safe to do file I/O now

.done:
    iret
```

---

## 9. Critical Error Handler Considerations

### The problem

If your TSR calls DOS and a critical error occurs (e.g., disk not ready),
DOS invokes INT 24h -- the critical error handler. By default, this handler
prompts "Abort, Retry, Fail?" which requires character I/O. This can corrupt
the interrupted application's state.

### The solution

Before doing any DOS file I/O from your TSR, **install your own INT 24h
handler** that simply returns "Fail" (or "Ignore") without prompting:

```nasm
; Minimal critical error handler: return "Fail"
my_int24:
    mov  al, 3              ; 3 = Fail (DOS 3.1+)
    iret                    ; 0 = Ignore, 1 = Retry, 2 = Abort, 3 = Fail
```

Install this before DOS calls and restore the original after:

```nasm
do_deferred_io:
    ; Save old INT 24h
    mov  ax, 3524h
    int  21h
    mov  [cs:old_int24], bx
    mov  [cs:old_int24+2], es

    ; Install our error handler
    mov  ax, 2524h
    mov  dx, my_int24
    push cs
    pop  ds
    int  21h

    ; ... do file I/O here ...

    ; Restore old INT 24h
    push ds
    lds  dx, [cs:old_int24]
    mov  ax, 2524h
    int  21h
    pop  ds
    ret
```

---

## 10. Safely Doing File I/O from a TSR

This is the critical recipe. A TSR that needs to do file I/O (open, read,
write, close files via INT 21h) from a hardware interrupt (like INT 1Ch
timer) must follow ALL of these steps.

### The Deferred I/O Pattern

```
Timer tick fires (INT 1Ch or INT 08h)
    |
    v
Set "need_io" flag if it's time to do work
    |
    v
Check InDOS flag AND CritErr flag
    |
    +-- Both zero? --> Do the I/O now (call do_safe_io)
    |
    +-- Not zero?  --> Return, try again next tick
                       (Also try from INT 28h handler)
```

### Full Procedure: do_safe_io

Before calling any INT 21h function from TSR context:

```nasm
do_safe_io:
    ; 1. Save the interrupted program's stack
    mov  [cs:save_ss], ss
    mov  [cs:save_sp], sp
    ; Switch to our own stack
    cli
    mov  ss, [cs:our_ss]
    mov  sp, [cs:our_sp]
    sti

    ; 2. Save the interrupted program's PSP
    mov  ah, 51h            ; Get current PSP
    int  21h                ; BX = current PSP segment
    mov  [cs:save_psp], bx

    ; 3. Set our PSP
    mov  bx, [cs:our_psp]  ; Our PSP (= CS in .COM file)
    mov  ah, 50h            ; Set PSP
    int  21h

    ; 4. Save the interrupted program's DTA
    mov  ah, 2Fh            ; Get DTA address
    int  21h                ; ES:BX = current DTA
    mov  [cs:save_dta], bx
    mov  [cs:save_dta+2], es

    ; 5. Set our DTA (or use default at PSP:0080h)
    push cs
    pop  ds
    mov  dx, our_dta
    mov  ah, 1Ah            ; Set DTA
    int  21h

    ; 6. Save extended error info (DOS 3.0+)
    ; This is complex -- uses INT 21h/59h to get and 5D0Ah to restore
    ; Omitted for brevity; critical for production TSRs

    ; 7. Install our critical error handler (INT 24h)
    mov  ax, 3524h
    int  21h
    mov  [cs:save_int24], bx
    mov  [cs:save_int24+2], es
    mov  ax, 2524h
    mov  dx, my_int24
    push cs
    pop  ds
    int  21h

    ; ==========================================
    ; 8. NOW it is safe to do file I/O
    ; ==========================================

    ; Example: open file, write data, close file
    ; ... your file I/O code here ...

    ; ==========================================
    ; 9. Restore everything in reverse order
    ; ==========================================

    ; Restore INT 24h
    push ds
    lds  dx, [cs:save_int24]
    mov  ax, 2524h
    int  21h
    pop  ds

    ; Restore extended error info (if saved)

    ; Restore DTA
    push ds
    lds  dx, [cs:save_dta]
    mov  ah, 1Ah
    int  21h
    pop  ds

    ; Restore PSP
    mov  bx, [cs:save_psp]
    mov  ah, 50h
    int  21h

    ; Restore stack
    cli
    mov  ss, [cs:save_ss]
    mov  sp, [cs:save_sp]
    sti

    ; Clear the "need_io" flag
    mov  byte [cs:need_io], 0

    ret
```

### Summary of what must be saved/restored

| Item                  | Save with        | Restore with     |
|-----------------------|------------------|------------------|
| SS:SP (app stack)     | MOV to variables | MOV from vars    |
| PSP                   | INT 21h/51h      | INT 21h/50h      |
| DTA                   | INT 21h/2Fh      | INT 21h/1Ah      |
| Extended Error Info   | INT 21h/59h      | INT 21h/5D0Ah    |
| Critical Error (24h)  | INT 21h/3524h    | INT 21h/2524h    |
| All registers         | PUSH             | POP              |

---

## 11. Hooking INT 1Ch (Timer Tick)

### INT 08h vs INT 1Ch

- **INT 08h** is the hardware timer interrupt (IRQ 0). It fires ~18.2 times
  per second. The BIOS handler for INT 08h updates the time-of-day counter,
  handles floppy motor timeout, and then calls **INT 1Ch** as a user hook.

- **INT 1Ch** is a software interrupt called by the INT 08h handler. The
  default INT 1Ch handler is just IRET. This is the **intended hook point
  for TSRs**.

### Why hook INT 1Ch, not INT 08h

- INT 1Ch fires after the BIOS has finished its timer housekeeping
- EOI has already been sent by the INT 08h handler
- You do not need to worry about time-of-day counter or motor timeout
- It is the "official" user timer hook

### Pattern for INT 1Ch handler

```nasm
my_int1c:
    push ax
    push ds
    push cs
    pop  ds

    ; Decrement a counter, do work every N ticks
    dec  word [tick_count]
    jnz  .chain
    mov  word [tick_count], 18  ; Reset (~1 second)

    ; Set flag for deferred I/O
    mov  byte [need_io], 1

    ; Check if DOS is safe right now
    call check_dos_safe         ; Returns AL=0 if safe
    or   al, al
    jnz  .chain                 ; Not safe, defer

    call do_safe_io             ; Safe! Do it now

.chain:
    pop  ds
    pop  ax
    jmp  far [cs:old_int1c]    ; Chain to previous handler
```

### Timing

- 18.2 ticks/second = ~55 ms per tick
- For 1-second intervals: count 18 ticks (actually 18.2, so drift ~1%)
- For 1-minute intervals: count 1092 ticks

---

## 12. Hooking INT 9h (Keyboard)

INT 9h is the hardware keyboard interrupt (IRQ 1). It fires on every
keypress and key release.

### Typical pattern

```nasm
my_int9:
    push ax
    push es

    in   al, 60h              ; Read scan code from keyboard controller
    mov  [cs:last_scan], al   ; Save it

    ; Check for hotkey (e.g., both Shift keys)
    mov  ax, 40h
    mov  es, ax
    mov  al, [es:17h]         ; BIOS keyboard flags
    and  al, 03h              ; Mask to shift keys
    cmp  al, 03h              ; Both shifts pressed?
    jne  .not_hotkey

    ; Hotkey detected! Set activation flag
    mov  byte [cs:activate], 1

    ; Acknowledge the key: reset keyboard controller
    in   al, 61h
    mov  ah, al
    or   al, 80h
    out  61h, al              ; Set bit 7 (acknowledge)
    mov  al, ah
    out  61h, al              ; Clear bit 7

    ; Send EOI
    mov  al, 20h
    out  20h, al

    pop  es
    pop  ax
    iret                      ; Consume the keystroke

.not_hotkey:
    pop  es
    pop  ax
    jmp  far [cs:old_int9]    ; Chain: let BIOS process normally
```

### Important notes

- Always read port 60h to get the scan code
- Bit 7 of scan code = 1 means key release, 0 means key press
- If you consume the key (don't chain), you must send EOI yourself
- If you chain, the old handler sends EOI
- The keyboard controller acknowledge (port 61h toggle) is needed on
  PC/XT; AT-class machines generally don't require it but it's harmless

---

## 13. The Multiplex Interrupt (INT 2Fh)

INT 2Fh is the standard way for TSRs to:

- Detect if they're already loaded (prevent double-loading)
- Communicate with their resident portion
- Allow other programs to interact with them

### Convention

- AH = your TSR's ID number (C0h-FFh for user programs)
- AL = function number (00h = "are you there?")
- Return AL = FFh if installed

### Installation check

```nasm
; During init: scan for a free ID
mov  cx, 0C0h            ; Start at C0h
.scan:
    mov  ah, cl
    xor  al, al           ; Function 0: installation check
    int  2Fh
    cmp  al, 0FFh
    jne  .found_free       ; Not installed = this ID is available
    inc  cl
    cmp  cl, 0FFh
    jbe  .scan
    ; Error: no free ID
    jmp  .abort

.found_free:
    mov  [our_id], cl
```

### Resident INT 2Fh handler

```nasm
my_int2f:
    cmp  ah, [cs:our_id]
    jne  .chain

    ; It's for us
    cmp  al, 0             ; Function 0: "Are you there?"
    jne  .other_func

    mov  al, 0FFh          ; "Yes, I'm here"
    ; Optionally: ES:DI -> identification string
    iret

.other_func:
    ; Handle other subfunctions...
    iret

.chain:
    jmp  far [cs:old_int2f]
```

---

## 14. TSR Removal / Unloading

### Why it's hard

Interrupt chains are singly linked. If TSR_A hooks INT 1Ch, then TSR_B
hooks INT 1Ch (chaining through TSR_A), removing TSR_A breaks the chain.

### Safe removal steps

1. Verify our vectors are still at the head of each chain (no one hooked
   after us)
2. Restore all original interrupt vectors
3. Free our environment block (INT 21h/49h on the env segment)
4. Free our memory block (INT 21h/49h on our PSP segment)

```nasm
; Check if safe to remove: are our handlers still the current ones?
mov  ax, 351Ch
int  21h                  ; ES:BX = current INT 1Ch vector
cmp  bx, my_int1c
jne  .cant_remove
mov  ax, es
mov  bx, cs
cmp  ax, bx
jne  .cant_remove
; ... check all other hooked vectors similarly ...
```

---

## 15. Complete Checklist for a File-I/O TSR

This is the master checklist for our project: a TSR that periodically does
file I/O from a timer interrupt.

### Resident data needed

- [ ] Saved old vectors: INT 1Ch, INT 28h, INT 2Fh, (INT 24h for temp use)
- [ ] InDOS flag pointer (far pointer, 4 bytes)
- [ ] `need_io` flag (1 byte)
- [ ] Tick counter for timing intervals
- [ ] Private stack (128-256 bytes is usually enough)
- [ ] Saved SS:SP for interrupted program's stack
- [ ] Saved PSP, DTA, INT 24h for restore during I/O
- [ ] Our PSP segment (= CS in .COM file)
- [ ] File I/O buffer
- [ ] Our DTA area (if needed; 128 bytes)
- [ ] Multiplex interrupt ID

### Init sequence (transient code)

1. Check if already installed (INT 2Fh)
2. Get InDOS flag address (INT 21h/34h), save pointer
3. Free environment block (INT 21h/49h)
4. Hook INT 1Ch (timer tick)
5. Hook INT 28h (DOS idle)
6. Hook INT 2Fh (multiplex)
7. Calculate resident size in paragraphs
8. Go resident (INT 21h/31h)

### INT 1Ch handler (timer tick)

1. Save registers
2. Decrement tick counter; if not zero, chain and return
3. Reset tick counter
4. Set `need_io` flag
5. Check InDOS + CritErr flags
6. If both zero: call do_safe_io
7. Chain to old INT 1Ch

### INT 28h handler (DOS idle)

1. Chain to old INT 28h first
2. Check `need_io` flag
3. If set: check InDOS (must be <= 1), check CritErr (must be 0)
4. If safe: call do_safe_io
5. IRET

### do_safe_io procedure

1. Switch to private stack
2. Save current PSP (INT 21h/51h)
3. Set our PSP (INT 21h/50h)
4. Save current DTA (INT 21h/2Fh)
5. Set our DTA (INT 21h/1Ah)
6. Save and replace INT 24h (critical error handler)
7. **Do the actual file I/O**
8. Restore INT 24h
9. Restore DTA
10. Restore PSP
11. Switch back to interrupted program's stack
12. Clear `need_io` flag

### BIOS reentrancy (optional but recommended)

If your file I/O triggers disk access, INT 13h (BIOS disk) may already be
active. Wrap INT 13h with an "in use" counter:

```nasm
my_int13:
    inc  byte [cs:in_int13]
    pushf
    call far [cs:old_int13]
    dec  byte [cs:in_int13]
    retf 2                    ; Return with caller's flags
```

Check `in_int13` alongside InDOS before doing I/O. Similarly for INT 10h
(video) if you do screen output.

---

## Sources

- Randall Hyde, "The Art of Assembly Language Programming," Chapter 18: Resident Programs
  - <https://www.phatcode.net/res/223/files/html/Chapter_18/>
  - <https://www.plantation-productions.com/Webster/www.artofasm.com/DOS/ch18/>
- Ralf Brown's Interrupt List (RBIL)
  - INT 21h/31h, INT 21h/34h, INT 27h, INT 28h
  - <https://fd.lod.bz/rbil/>
- Wikipedia: Terminate-and-stay-resident program
  - <https://en.wikipedia.org/wiki/Terminate-and-stay-resident_program>
- Stack Overflow: INT 9h keyboard hooking examples
  - <https://stackoverflow.com/questions/12882342/override-default-int-9h>
- HelpPC Reference: INT 21h/31h, INT 27h
  - <https://www.stanislavs.org/helppc/>
