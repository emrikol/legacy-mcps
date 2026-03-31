# DOS TSR Reentrancy: Safely Calling INT 21h from Interrupt Context

## The Problem

DOS is **not reentrant**. If your TSR hooks INT 1Ch (timer tick) and calls INT 21h
while DOS is already processing an INT 21h call from the foreground application,
you will corrupt DOS internal data structures and crash the system. This document
covers every mechanism needed to safely perform file I/O from a TSR.

---

## 1. The InDOS Flag

The InDOS flag is a single byte in DOS kernel memory. It is incremented on entry
to INT 21h and decremented on exit. A non-zero value means DOS is currently
executing a service call.

### Getting its address (do this once at init time)

```asm
mov ah, 34h
int 21h
; ES:BX -> InDOS flag (1 byte)
mov word ptr [InDOS_Ptr],   bx
mov word ptr [InDOS_Ptr+2], es
```

Store this far pointer. Your interrupt handler will read from it later.

### Checking it

```asm
les bx, [InDOS_Ptr]
cmp byte ptr es:[bx], 0
jne dos_is_busy
```

**InDOS = 0** means DOS is idle and it is (potentially) safe to call INT 21h.
**InDOS != 0** means DOS is busy. Do NOT call INT 21h (with one exception: see
INT 28h below).

---

## 2. The Critical Error Flag (ErrorMode)

Checking InDOS alone is **not sufficient**. When DOS enters the INT 24h critical
error handler, it clears the InDOS flag -- but DOS is still not safe to call.
You must also check the Critical Error Flag (also called the ErrorMode flag).

### Location relative to InDOS

| DOS Version   | ErrorMode Location          |
|---------------|-----------------------------|
| DOS 2.x       | `ES:[BX+1]` (byte after InDOS) |
| DOS 3.0       | `ES:[BX-1AAh]` (far away!)  |
| COMPAQ DOS 3.0| `ES:[BX-1AAh]`              |
| DOS 3.1+      | `ES:[BX-1]` (byte before InDOS) |
| DOS 4.0+      | `ES:[BX-1]` (byte before InDOS) |

For DOS 3.1 and later (which is what matters for WFW 3.11), the ErrorMode byte
is at **InDOS_Ptr - 1**.

### The safe-to-call test

```asm
les  bx, [InDOS_Ptr]
cmp  byte ptr es:[bx], 0       ; InDOS flag
jne  dos_busy
cmp  byte ptr es:[bx-1], 0     ; Critical error flag (DOS 3.1+)
jne  dos_busy
; --- DOS is safe to call ---
```

**Both must be zero** before you call any INT 21h function from a TSR.

PRINT.COM (the DOS background print spooler, Microsoft's own TSR) uses exactly
this technique: `cmp WORD PTR [SI-1], 0` to test both flags with a single
word comparison, since they are adjacent bytes.

---

## 3. INT 28h -- The DOS Idle Interrupt

When DOS is waiting for console input (functions 01h-0Ch), it enters an internal
busy-wait loop and calls `INT 28h` repeatedly. This is the "DOS Idle" interrupt.

### What makes INT 28h special

Even though InDOS = 1 during this time, DOS is in a **safe state for high-numbered
functions**. Specifically:

- **INT 21h functions 0Dh and above** are safe to call from an INT 28h handler.
- **INT 21h functions 01h-0Ch** are NOT safe (these are the console I/O functions
  that DOS is currently executing).
- Function 00h (terminate) is never safe.

This means **all file I/O functions are safe during INT 28h** (open, read, write,
close, seek, find, etc. are all above 0Ch).

### Hook INT 28h for deferred file I/O

```asm
MyInt28:
    pushf
    call dword ptr [OldInt28]   ; chain to previous handler first
    cmp  byte ptr [NeedIO], 0
    je   .done28
    ; We have deferred work. INT 28h means DOS is idle enough for file I/O.
    call DoFileIO
.done28:
    iret
```

---

## 4. INT 1Ch Timer Tick -- The Deferred Processing Pattern

INT 1Ch fires ~18.2 times/second from hardware. You CANNOT call INT 21h directly
from here because you have no idea what the foreground app (or DOS itself) is doing.

### The correct pattern

1. **In your INT 1Ch handler**: Set a flag (`NeedIO = 1`). That's it. Do NOT call
   INT 21h. Do NOT do file I/O. Chain to the old handler and return.

2. **Also hook INT 28h**: When INT 28h fires and `NeedIO` is set, check InDOS/CritErr.
   If both are zero (or if InDOS=1 but you only need functions > 0Ch), do the I/O.

3. **Also hook INT 08h (or keep using INT 1Ch)**: On each tick, if `NeedIO` is set,
   check InDOS and CritErr. If both are zero, do the I/O. This handles the case
   where the foreground app is doing CPU work (not calling DOS) and INT 28h never
   fires.

```asm
MyInt1C:
    pushf
    call dword ptr [OldInt1C]   ; chain first

    cmp  byte ptr [Busy], 0     ; prevent reentry into our own code
    jne  .skip

    dec  word ptr [TickCount]
    jnz  .skip
    mov  word ptr [TickCount], POLL_INTERVAL
    mov  byte ptr [NeedIO], 1   ; request deferred I/O

    ; Try to do it now if DOS is free
    les  bx, [InDOS_Ptr]
    cmp  byte ptr es:[bx], 0
    jne  .skip
    cmp  byte ptr es:[bx-1], 0
    jne  .skip

    mov  byte ptr [Busy], 1
    call DoFileIO
    mov  byte ptr [Busy], 0

.skip:
    iret
```

---

## 5. What INT 21h Functions Are Safe?

### Always safe (no InDOS check needed)

- **INT 21h/25h** -- Set Interrupt Vector
- **INT 21h/35h** -- Get Interrupt Vector
- **INT 21h/34h** -- Get InDOS Flag Address

These functions do not use any DOS internal data structures.

### Safe when InDOS = 0 and CritErr = 0

ALL INT 21h functions, including file I/O:

- 0Dh-0Fh: Disk reset, drive selection
- 3Ch: Create file
- 3Dh: Open file
- 3Eh: Close file
- 3Fh: Read file
- 40h: Write file
- 42h: Seek (lseek)
- 4Eh/4Fh: Find first/next
- 41h: Delete file
- 43h: Get/set file attributes
- 56h: Rename file
- 57h: Get/set file date/time
- And all others

### Safe during INT 28h (InDOS may be 1)

- All functions with AH > 0Ch (this includes all file I/O)
- Functions 01h-0Ch are NOT safe during INT 28h

### Never safe from a TSR interrupt handler without proper InDOS checking

- Functions 01h-0Ch (console I/O) -- these are what DOS may be executing
- Function 00h (terminate program)
- Functions 31h, 4Ch (terminate/TSR) -- use JMP FAR to old handler instead

---

## 6. DTA (Disk Transfer Area) -- Must Save and Restore

The DTA is used by find-first/find-next (4Eh/4Fh) and FCB-based I/O. The
foreground app's DTA will be corrupted if your TSR uses these functions without
saving/restoring it.

### Save the app's DTA

```asm
mov  ah, 2Fh            ; Get DTA address
int  21h                 ; Returns ES:BX = current DTA
mov  word ptr [SaveDTA],   bx
mov  word ptr [SaveDTA+2], es
```

### Set TSR's own DTA

```asm
push ds
mov  dx, offset MyDTA    ; or PSP:0080h
mov  ah, 1Ah             ; Set DTA
int  21h
pop  ds
```

### Restore the app's DTA before returning

```asm
push ds
lds  dx, [SaveDTA]
mov  ah, 1Ah
int  21h
pop  ds
```

**You need this even if you only use handle-based file I/O (3Ch-42h)** -- some
DOS versions update the DTA internally for any file operation. Always save/restore
it to be safe.

---

## 7. PSP (Program Segment Prefix) -- Must Switch

DOS maintains a "current PSP" pointer internally. If your TSR calls INT 21h
without switching the PSP, DOS will use the foreground app's PSP. This means:

- File handles will be looked up in the wrong JFT (Job File Table)
- Critical error and Ctrl-Break handlers from the app's PSP will fire instead
  of yours
- The wrong process gets blamed for any errors

### Save app's PSP and switch to TSR's

```asm
mov  ah, 51h             ; Get current PSP
int  21h                 ; Returns BX = current PSP segment
mov  [AppPSP], bx        ; Save it

mov  bx, [MyPSP]         ; TSR's PSP (saved during init)
mov  ah, 50h             ; Set current PSP
int  21h
```

### Restore app's PSP before returning

```asm
mov  bx, [AppPSP]
mov  ah, 50h
int  21h
```

### Getting your own PSP at init time

```asm
mov  ah, 51h
int  21h
mov  [MyPSP], bx
```

**Note:** Functions 50h/51h are "always safe" in DOS 3.1+ because they do not
use the DOS internal stack. Under DOS 2.x, use the undocumented function 62h
instead of 51h.

---

## 8. Stack Switching -- Strongly Recommended

When your interrupt handler fires, you are running on whatever stack the
interrupted code was using. This could be:

- The foreground app's stack (maybe only 128 bytes free)
- DOS's internal stack (definitely must not use)
- Another TSR's stack

If your TSR does file I/O, it needs significant stack space (DOS file operations
can use 1-2KB internally). **You must switch to your own stack.**

### Stack switching pattern

```asm
; --- Save interrupted stack (interrupts should be OFF) ---
    cli
    mov  word ptr cs:[SaveSS], ss
    mov  word ptr cs:[SaveSP], sp

; --- Switch to TSR's private stack ---
    mov  ss, cs:[MyStackSeg]       ; or use mov ss,ax after loading ax
    mov  sp, offset MyStackTop     ; top of reserved stack area
    sti                            ; safe to re-enable now

; --- Do TSR work here ---
    call DoFileIO

; --- Restore interrupted stack ---
    cli
    mov  ss, word ptr cs:[SaveSS]
    mov  sp, word ptr cs:[SaveSP]
    sti
```

### Stack size

Allocate at least **512 bytes** (256 words) for the TSR stack. If doing nested
DOS calls or recursive operations, allocate more (1024+ bytes).

```asm
MyStack     dw 256 dup (0)     ; 512 bytes
MyStackTop  equ $              ; SP points here initially
```

**Critical:** The `mov ss` and `mov sp` instructions must be adjacent with
interrupts disabled. The CPU automatically disables interrupts for one
instruction after `mov ss`, so the `mov sp` that follows is atomic with it.

---

## 9. INT 24h Critical Error Handler -- Must Install Your Own

If a critical error occurs during your TSR's file I/O (e.g., disk not ready),
DOS calls INT 24h. Without your own handler:

- The foreground app's critical error handler runs (from its PSP)
- It may display "Abort, Retry, Fail?" and wait for user input
- If the user selects "Abort", the FOREGROUND APP terminates, not your TSR
- Your TSR is left in a corrupt state

### Install a minimal critical error handler

```asm
MyInt24:
    mov  al, 3              ; Action code 3 = FAIL the call (DOS 3.1+)
    iret                    ; Return to DOS; the INT 21h call will return
                            ; with carry set and error code
```

### Save/restore INT 24h around your DOS calls

```asm
; Save old INT 24h
    mov  ax, 3524h
    int  21h
    mov  word ptr [OldInt24],   bx
    mov  word ptr [OldInt24+2], es

; Install our handler
    mov  ax, 2524h
    mov  dx, offset MyInt24
    int  21h

; ... do file I/O ...

; Restore old INT 24h
    push ds
    lds  dx, [OldInt24]
    mov  ax, 2524h
    int  21h
    pop  ds
```

Alternatively, if you switched the PSP (section 7), and your TSR's PSP has your
INT 24h handler address at PSP:0012h, DOS will automatically use it. But explicit
vector save/restore is more reliable.

---

## 10. Extended Error Information -- Should Save and Restore

If the foreground app just had a DOS error and hasn't called INT 21h/59h yet,
your TSR's DOS calls will overwrite the extended error info. The app will then
get YOUR error info instead of its own.

### Save extended error info

```asm
ExtErr  struc
eeAX    dw ?
eeBX    dw ?
eeCX    dw ?
eeDX    dw ?
eeSI    dw ?
eeDI    dw ?
eeDS    dw ?
eeES    dw ?
eeRsv   dw 3 dup (0)       ; reserved, set to 0
ExtErr  ends

SavedErr ExtErr <>

; Save:
    push ds
    mov  ah, 59h
    xor  bx, bx             ; BX must be 0
    int  21h
    mov  cs:[SavedErr.eeDS], ds
    pop  ds
    mov  [SavedErr.eeAX], ax
    mov  [SavedErr.eeBX], bx
    mov  [SavedErr.eeCX], cx
    mov  [SavedErr.eeDX], dx
    mov  [SavedErr.eeSI], si
    mov  [SavedErr.eeDI], di
    mov  [SavedErr.eeES], es
```

### Restore extended error info

```asm
    push ds
    mov  si, offset SavedErr
    ; DS:SI -> structure (if data is in current DS)
    mov  ax, 5D0Ah           ; Set Extended Error
    int  21h
    pop  ds
```

---

## 11. INT 13h and INT 16h -- Additional BIOS Reentrancy Guards

DOS file I/O calls INT 13h (BIOS disk) internally. The BIOS disk routines are
also not reentrant. If the foreground app is in the middle of a BIOS disk call
when your timer tick fires, and you try to do file I/O, you'll corrupt the BIOS
disk state.

### Hook INT 13h with a reentrancy counter

```asm
InInt13  db 0

MyInt13:
    inc  byte ptr cs:[InInt13]
    pushf
    call dword ptr cs:[OldInt13]
    dec  byte ptr cs:[InInt13]
    retf 2                   ; preserve flags from original handler
```

Similarly for INT 16h (BIOS keyboard), since DOS calls it during console I/O.

### Check these flags alongside InDOS

```asm
    cmp  byte ptr [InInt13], 0
    jne  dos_busy
    cmp  byte ptr [InInt16], 0
    jne  dos_busy
    ; ... then check InDOS and CritErr ...
```

---

## 12. Complete Checklist: Calling INT 21h From a TSR

Here is the full sequence, in order, that your TSR must perform to safely do
file I/O from an interrupt context (INT 1Ch timer or INT 28h idle):

### Before calling INT 21h

1. **Check reentrancy guard** -- is your own TSR already active? (`Busy` flag)
2. **Check InInt13** -- is BIOS disk I/O in progress?
3. **Check InInt16** -- is BIOS keyboard I/O in progress?
4. **Check InDOS flag** -- is DOS executing an INT 21h call?
5. **Check CritErr flag** -- is DOS in a critical error state?
6. If ANY of the above are non-zero, defer (set `NeedIO` flag, try again later)
7. **Set Busy flag** to prevent reentry
8. **Switch stack** -- save SS:SP, load TSR's private stack
9. **Save registers** -- push all registers you'll use
10. **Save/switch PSP** -- INT 21h/51h to get app's PSP, INT 21h/50h to set TSR's
11. **Save/set DTA** -- INT 21h/2Fh to get app's DTA, INT 21h/1Ah to set TSR's
12. **Save extended error info** -- INT 21h/59h
13. **Install INT 24h handler** -- save old vector, set your own (returns FAIL)
14. **Enable interrupts** (STI) -- DOS needs interrupts enabled for disk I/O
15. **Do your file I/O** -- open, read, write, close, etc.

### After calling INT 21h

1. **Restore INT 24h** -- put back the old critical error handler
2. **Restore extended error info** -- INT 21h/5D0Ah
3. **Restore DTA** -- INT 21h/1Ah with saved address
4. **Restore PSP** -- INT 21h/50h with saved app PSP
5. **Restore registers** -- pop all saved registers
6. **Restore stack** -- CLI, restore SS:SP, STI
7. **Clear Busy flag**
8. **Clear NeedIO flag**
9. **IRET** (or chain to old handler)

---

## 13. Summary: Architecture for Timer-Driven File I/O

```
INT 1Ch (timer tick, ~18.2/sec)
    |
    +-- Chain to old handler
    +-- Decrement poll counter
    +-- If counter expired:
    |     Set NeedIO = 1
    |     Reset counter
    +-- If NeedIO == 1 AND Busy == 0:
    |     Check InInt13, InInt16, InDOS, CritErr
    |     If all zero:
    |       Set Busy = 1
    |       Switch stack
    |       Save PSP, DTA, ExtErr
    |       Install INT 24h
    |       === Do file I/O ===
    |       Restore INT 24h
    |       Restore ExtErr, DTA, PSP
    |       Restore stack
    |       Set Busy = 0, NeedIO = 0
    +-- IRET

INT 28h (DOS idle -- fires when DOS is waiting for keyboard)
    |
    +-- Chain to old handler
    +-- If NeedIO == 1 AND Busy == 0:
    |     (InDOS may be 1, but that's OK for functions > 0Ch)
    |     Check InInt13, CritErr
    |     If OK:
    |       Same save/restore sequence as above
    |       === Do file I/O ===
    +-- IRET

INT 13h wrapper (reentrancy guard)
    |
    +-- Increment InInt13
    +-- Call original INT 13h
    +-- Decrement InInt13
    +-- RETF 2 (preserve flags)

INT 16h wrapper (reentrancy guard)
    |
    +-- Increment InInt16
    +-- Call original INT 16h
    +-- Decrement InInt16
    +-- RETF 2 (preserve flags)
```

---

## 14. Common Mistakes

1. **Calling INT 21h directly from INT 1Ch** without checking InDOS. This is the
   #1 cause of random crashes in TSRs.

2. **Checking InDOS but not CritErr.** The system looks idle but DOS is in the
   critical error handler. Your call corrupts the error handler's state.

3. **Not switching the PSP.** Your file handles are looked up in the wrong JFT.
   Open/read/write silently operate on the wrong files or fail.

4. **Not saving the DTA.** Find-first/find-next in the foreground app returns
   garbage after your TSR runs.

5. **Not installing INT 24h.** A critical error during your TSR's I/O aborts the
   foreground app instead of failing gracefully.

6. **Running on the app's stack.** The app may have only 128 bytes free. DOS file
   I/O can use 1-2KB. Stack overflow corrupts memory silently.

7. **Forgetting the INT 13h/16h guards.** Even when InDOS = 0, the foreground app
   may be in the middle of a raw BIOS disk read. Your file I/O re-enters INT 13h
   and corrupts the disk controller state.

8. **Not preventing self-reentry.** Your timer tick fires while you're already
   doing I/O from a previous tick. Two copies of your code run simultaneously
   on the same data structures.

---

## Sources

- [Art of Assembly Ch.18 Part 3 -- Reentrancy Problems with DOS](https://www.phatcode.net/res/223/files/html/Chapter_18/CH18-3.html)
- [Art of Assembly Ch.18 Part 4 -- PSP, DTA, Extended Error, Stack](https://www.phatcode.net/res/223/files/html/Chapter_18/CH18-4.html)
- [Art of Assembly Ch.18 Part 5 -- Complete TSR Example](https://www.plantation-productions.com/Webster/www.artofasm.com/DOS/ch18/CH18-5.html)
- [fysnet.net -- Terminate and Stay Resident Programming](https://www.fysnet.net/tsrdemo.htm)
- [OS/2 Museum -- InDOS Is Not Enough](https://www.os2museum.com/wp/learn-something-old-every-day-part-xiii-indos-is-not-enough/)
- [INT 21h/34h -- Get Address to DOS Critical Flag](http://oldlinux.org/Linux.old/docs/interrupts/int-html0/inte2zsg.htm)
- [INT 28h -- DOS Idle Interrupt](http://www.techhelpmanual.com/567-int_28h__dos_idle.html)
- [INT 24h -- Critical Error Handler](http://www.techhelpmanual.com/564-int_24h__critical_error_handler.html)
- [INT 1Ch -- User Timer Interrupt](http://www.techhelpmanual.com/254-int_1ch__user_timer_interrupt.html)
- [iifx.dev -- From Timer Tick to DOS Core](https://iifx.dev/en/articles/460063545/from-timer-tick-to-dos-core-why-int-21h-hooking-is-different-and-how-to-fix-it)
- [Wikipedia -- Terminate-and-stay-resident program](https://en.wikipedia.org/wiki/Terminate-and-stay-resident_program)
- [fysnet.net -- INT 24h Error Handler](http://www.fysnet.net/int24h.htm)
