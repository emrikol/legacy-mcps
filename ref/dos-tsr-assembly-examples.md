# DOS TSR (Terminate and Stay Resident) Programming Reference

Compiled from multiple sources: Randall Hyde's "Art of Assembly Language" (Chapter 18),
Wikipedia, StackOverflow Q&A, and real GitHub repositories with working TSR code.

---

## Table of Contents

1. [What is a TSR?](#1-what-is-a-tsr)
2. [Two Ways to Go Resident: INT 27h vs INT 21h/31h](#2-two-ways-to-go-resident)
3. [Key DOS Functions for TSR Programming](#3-key-dos-functions)
4. [Memory Layout and Size Calculation](#4-memory-layout-and-size-calculation)
5. [Passive vs Active TSRs](#5-passive-vs-active-tsrs)
6. [Complete Example: Minimal NASM TSR (.COM)](#6-minimal-nasm-tsr)
7. [Complete Example: Keyboard Hook TSR (capsmap)](#7-keyboard-hook-tsr)
8. [Complete Example: TSR with File I/O (shot.asm)](#8-tsr-with-file-io)
9. [Interrupt Hooking Techniques](#9-interrupt-hooking)
10. [Register Preservation in ISRs](#10-register-preservation)
11. [The InDOS Flag and Reentrancy](#11-indos-flag)
12. [INT 28h Idle Interrupt](#12-int-28h)
13. [PSP and Environment Block](#13-psp-and-environment)
14. [The Multiplex Interrupt: INT 2Fh](#14-multiplex-interrupt)
15. [AMIS: Alternate Multiplex Interrupt Specification](#15-amis)
16. [Unloading a TSR](#16-unloading)
17. [DTA, PSP Switching, and Extended Error Preservation](#17-dta-psp-switching)
18. [BIOS Reentrancy Wrappers](#18-bios-reentrancy)
19. [Stack Switching](#19-stack-switching)
20. [GitHub Repos with Working TSR Code](#20-github-repos)
21. [Common Pitfalls](#21-common-pitfalls)
22. [References and Further Reading](#22-references)

---

## 1. What is a TSR?

A Terminate-and-Stay-Resident program runs under DOS, uses a system call to
return control to DOS as though it has finished, but remains in computer memory
so it can be reactivated later. This partially overcomes DOS's limitation of
executing only one program at a time.

TSRs work by:

1. Installing one or more interrupt handlers that point into the resident code
2. Calling a DOS function to terminate but keep a specified amount of memory resident
3. The installed interrupt handlers are invoked later by hardware events (keyboard,
   timer) or software interrupts, reactivating the TSR code

---

## 2. Two Ways to Go Resident

### INT 27h - Terminate But Stay Resident (original, limited)

```asm
; DX = address of first byte BEYOND the resident portion
; CS = segment of PSP (automatic for .COM files)
mov dx, resident_end    ; offset of end of resident code
int 27h                 ; terminate and stay resident
```

Limitations:

- Can only keep up to 64 KB resident (since DX is a 16-bit offset)
- Cannot return an exit code
- The segment (CS) must be the PSP segment

### INT 21h, AH=31h - Keep Process (preferred, DOS 2.0+)

```asm
; AH = 31h
; AL = exit/return code (typically 0)
; DX = number of paragraphs (16-byte blocks) to keep resident
mov ax, 3100h           ; AH=31h (TSR), AL=00h (exit code)
mov dx, paragraphs      ; size in paragraphs to keep
int 21h                 ; terminate and stay resident
```

Advantages over INT 27h:

- No 64 KB limit (DX is in paragraphs, so up to 1 MB theoretically)
- Can return an exit code in AL
- More "modern" (DOS 2.0+)

---

## 3. Key DOS Functions for TSR Programming

### INT 21h, AH=25h - Set Interrupt Vector

```asm
; AL = interrupt number
; DS:DX = new interrupt handler address
mov ax, 2509h           ; set INT 09h (keyboard)
mov dx, my_handler      ; DS:DX -> handler (DS=CS for .COM files)
int 21h
```

### INT 21h, AH=35h - Get Interrupt Vector

```asm
; AL = interrupt number
; Returns: ES:BX = current handler address
mov ax, 3509h           ; get INT 09h vector
int 21h
; ES:BX now points to the current INT 9 handler
mov [old_int9_off], bx
mov [old_int9_seg], es
```

### INT 21h, AH=62h - Get PSP Address

```asm
mov ah, 62h
int 21h
; BX = segment address of current PSP
```

### INT 21h, AH=49h - Free Memory Block

```asm
; ES = segment of block to free
mov ah, 49h
int 21h
```

### INT 21h, AH=34h - Get InDOS Flag Address

```asm
mov ah, 34h
int 21h
; ES:BX -> InDOS flag (byte)
```

### INT 21h, AH=50h/51h - Set/Get PSP

```asm
; Set PSP: BX = segment of new PSP
mov ah, 50h
mov bx, my_psp_segment
int 21h

; Get PSP: returns BX = segment of current PSP
mov ah, 51h
int 21h
```

---

## 4. Memory Layout and Size Calculation

### .COM File Memory Layout

```
+------------------+ <- CS:0000 = PSP start
| PSP (256 bytes)  |
+------------------+ <- CS:0100 (org 100h)
| Program code     |
|   (resident      |
|    portion)      |
+------------------+ <- resident_end label
| Transient code   |
| (init/install)   |
+------------------+
```

### Calculating Resident Size for .COM Files

**Method 1: Using INT 27h (simple)**

```asm
; Place a label at the end of resident code
resident_end:
    ; ... transient init code follows ...
init:
    ; ... install interrupts ...
    mov dx, resident_end    ; DX = offset past resident code
    int 27h                 ; CS is already the PSP segment for .COM
```

**Method 2: Using INT 21h/31h (paragraphs)**

```asm
resident_end:
init:
    ; ... install interrupts ...
    mov dx, resident_end    ; offset of end
    shr dx, 4               ; convert bytes to paragraphs (divide by 16)
    inc dx                  ; round up (IMPORTANT: always round up!)
    ; Add PSP size: 10h paragraphs = 256 bytes
    ; For .COM files, the offset already includes PSP since org 100h
    ; but we need to account for the PSP segment itself
    add dx, 10h             ; add 16 paragraphs for the PSP (256 bytes)
    mov ax, 3100h
    int 21h
```

**Note on .COM vs .EXE:** For .COM files, the PSP is at offset 0, and the
program starts at offset 100h. The offset `resident_end` already includes
the 100h bytes, but since INT 21h/31h wants paragraphs relative to the PSP
segment start, you need to add the PSP size (10h paragraphs).

Some examples skip adding 10h if they calculate the offset from the PSP
segment directly. The key is: DX must contain the TOTAL number of paragraphs
from the start of the PSP to the end of resident code.

### Calculating Resident Size for .EXE Files

From Art of Assembly (Randall Hyde):

```asm
; For .EXE files with separate segments:
ResidentSeg     segment para public 'resident'
    ; ... resident code and data ...
ResidentSeg     ends

EndResident     segment para public 'EndRes'
    ; empty segment marking end of resident area
EndResident     ends

; In the init code:
    mov ah, 62h             ; get PSP segment
    int 21h                 ; BX = PSP segment
    mov dx, EndResident     ; get EndResident segment address
    sub dx, bx              ; subtract PSP = size in paragraphs
    mov ax, 3100h
    int 21h
```

### Important: Structure Your Code Correctly

Place resident code FIRST, transient (init) code LAST. The init code runs
once during installation and does not need to stay in memory.

```asm
org 100h

    jmp init            ; jump over resident code to init

; === RESIDENT PORTION (stays in memory) ===
old_int9_off dw 0
old_int9_seg dw 0

my_handler:
    ; ... interrupt handler code ...
    iret

resident_end:           ; <-- this label marks the boundary

; === TRANSIENT PORTION (freed after init) ===
init:
    ; save old vector, install new one, go resident
    mov ax, 3509h
    int 21h
    mov [old_int9_off], bx
    mov [old_int9_seg], es

    mov ax, 2509h
    mov dx, my_handler
    int 21h

    mov dx, resident_end
    int 27h             ; or use INT 21h/31h
```

---

## 5. Passive vs Active TSRs

### Passive TSRs

Activate in response to an explicit software interrupt call from an application.
They function as trap handlers, providing callable libraries or extending
existing DOS/BIOS functionality.

Examples:

- Mouse driver (mouse.com) - extends INT 33h
- Intercepting printer output via INT 17h
- Extending BIOS video services via INT 10h
- Creating new interrupt vectors for custom services

### Active TSRs

Respond to hardware interrupts or piggyback on hardware interrupt handlers.
They activate automatically without the foreground program's knowledge.

Examples:

- Keyboard hotkey handlers (INT 9)
- Timer-based periodic tasks (INT 8 or INT 1Ch)
- Pop-up utilities like Borland Sidekick

A TSR can have BOTH active and passive components. If any routine is active,
the entire program qualifies as an active TSR.

---

## 6. Minimal NASM TSR (.COM) - Complete Working Example

Source: adapted from github.com/marmolak/dos-tsr

```asm
; minimal-tsr.asm - Minimal DOS TSR example for NASM
; Hooks INT 00h (divide by zero) to print a message
; Build: nasm -f bin -o minimal.com minimal-tsr.asm

BITS 16
org 100h

    jmp setup                   ; jump over resident part

; === RESIDENT PORTION ===
mystring: db 'Hello from TSR!', 13, 10, '$'

tsr_handler:
    push ds
    push dx
    push ax
    push cs
    pop ds                      ; DS = CS (our data is in code segment)
    mov ah, 09h                 ; DOS print string
    mov dx, mystring
    int 21h
    pop ax
    pop dx
    pop ds
    iret                        ; return from interrupt

resident_end:

; === TRANSIENT PORTION (init code, not kept resident) ===
setup:
    ; Install our handler on a free interrupt (using INT 60h, a user interrupt)
    mov ax, 2560h               ; set INT 60h vector
    mov dx, tsr_handler         ; DS:DX -> our handler (DS=CS for .COM)
    int 21h

    ; Print install message
    mov ah, 09h
    mov dx, install_msg
    int 21h

    ; Go resident using INT 21h/31h
    mov ax, 3100h               ; AH=31h, AL=00h
    mov dx, (resident_end - $$) ; size from start of file
    shr dx, 4                   ; convert to paragraphs
    add dx, 11h                 ; +1 for rounding, +10h for PSP
    int 21h

install_msg: db 'TSR installed.', 13, 10, '$'
```

---

## 7. Keyboard Hook TSR - Complete Working Example (capsmap)

Source: github.com/jtsiomb/capsmap (public domain, by John Tsiombikas)
This is a real, working NASM TSR that remaps Caps Lock to Ctrl.

```asm
; capsmap.asm - DOS caps lock remapper
; Author: John Tsiombikas <nuclear@member.fsf.org>
; Public domain. Build with: nasm -o capsmap.com -f bin capsmap.asm

; Configuration: Map caps lock to left Ctrl
%define MAP_MODKEY
KBF0_BIT equ 04h       ; BIOS keyboard flag byte 0, bit for left Ctrl
KBF1_BIT equ 01h       ; BIOS keyboard flag byte 1, bit for left Ctrl

    org 100h
    bits 16

    jmp init            ; jump over resident part to init code

KB_INTR equ 09h
KB_PORT equ 60h
PIC1_CMD_PORT equ 20h
OCW2_EOI equ 20h

KBFLAGS0 equ 17h       ; offset in BIOS data area (seg 40h)
KBFLAGS1 equ 18h

SCAN_CAPS_PRESS equ 03ah
SCAN_CAPS_RELEASE equ 0bah

; === RESIDENT PORTION: Keyboard interrupt handler ===
kbintr:
    push ax
    in al, KB_PORT              ; read scancode from keyboard port
    cmp al, SCAN_CAPS_PRESS
    jz .caps_press
    cmp al, SCAN_CAPS_RELEASE
    jz .caps_release
    ; not caps lock - chain to original handler
    pop ax
    push word [cs:orig_seg]     ; push far return address
    push word [cs:orig_off]
    retf                        ; "return" to original handler

.caps_press:
    ; Set ctrl flags in BIOS data area
    mov ax, es
    push word 40h
    pop es
    or byte [es:KBFLAGS0], KBF0_BIT
    or byte [es:KBFLAGS1], KBF1_BIT
    mov es, ax
    jmp .end

.caps_release:
    ; Clear ctrl flags in BIOS data area
    mov ax, es
    push word 40h
    pop es
    and byte [es:KBFLAGS0], ~KBF0_BIT
    and byte [es:KBFLAGS1], ~KBF1_BIT
    mov es, ax

.end:
    mov al, OCW2_EOI            ; send End-of-Interrupt to PIC
    out PIC1_CMD_PORT, al
    pop ax
    iret                        ; return from interrupt

; Storage for original interrupt vector (in resident portion!)
orig_seg dw 0
orig_off dw 0
resident_end:

; === TRANSIENT PORTION: Installation code ===
init:
    ; Print install message
    mov ax, 0900h
    mov dx, msg
    int 21h

    ; Save original INT 9 handler
    mov ax, 3509h               ; get interrupt vector 09h
    int 21h                     ; returns ES:BX
    mov [orig_seg], es
    mov [orig_off], bx

    ; Install our handler
    mov ax, 2509h               ; set interrupt vector 09h
    mov dx, kbintr              ; DS:DX -> our handler
    int 21h

    mov ax, 0900h
    mov dx, msg_done
    int 21h

    ; Terminate and stay resident using INT 27h
    mov dx, resident_end        ; DX = first byte past resident code
    int 27h                     ; CS = PSP for .COM files

msg db 'Installing capslock remapper... $'
msg_done db 'done.',13,10,'$'
```

Key observations from this real-world example:

- Uses `cs:` prefix to access data from within the ISR (since DS is unknown)
- Chains to original handler via push/retf trick (faster than far jmp)
- Sends EOI to PIC when handling the interrupt itself
- Stores original vector in the RESIDENT portion (before resident_end)
- Uses INT 27h for simplicity (code is well under 64 KB)

---

## 8. TSR with File I/O - Complete Working Example (shot.asm)

Source: github.com/uzimonkey/shot (saves text screenshots to a file)
This is a real TSR that demonstrates the hardest TSR problem: doing file I/O
from an interrupt handler while respecting the InDOS flag.

```asm
; shot.asm - TSR text screenshot saver
; Hooks keyboard (INT 9) and timer (INT 8) interrupts
; When F10 is pressed:
;   - If DOS is idle: saves screen directly to C:\screen.ans
;   - If DOS is busy: copies screen to buffer, saves on next timer tick
;     when DOS becomes idle

.model tiny
.stack
.386

KBD_PORT    EQU 060h
F10_SCAN    EQU 044h

.code
.startup
    jmp install

; === RESIDENT DATA ===
old_keyboard    DD ?            ; saved original INT 9 handler
old_timer       DD ?            ; saved original INT 8 handler
buffer_waiting  DB 0            ; flag: buffer has data to save
buffer          DB 80*50*2 DUP(?)  ; screen buffer (80x50 chars * 2 bytes)
filename        DB "C:\screen.ans",0
indos_seg       DW ?            ; segment of InDOS flag
indos_offs      DW ?            ; offset of InDOS flag

; === save: write screen data (DS:DX) to file ===
save PROC
    push ds
    push dx

    ; Create/truncate and open file
    push cs
    pop ds
    mov ah, 03Ch                ; create/truncate file
    xor cx, cx                  ; no special attributes
    mov dx, OFFSET filename
    int 21h                     ; returns file handle in AX

    pop dx
    pop ds

    ; Write screen data to file
    mov bx, ax                  ; file handle
    mov ax, 04000h              ; write to file handle
    mov cx, 80*25*2             ; 4000 bytes
    int 21h

    ; Close file
    mov ah, 03Eh
    int 21h

    ret
save ENDP

; === KEYBOARD INTERRUPT HANDLER (INT 9) ===
keyboard PROC FAR
    pusha                       ; save ALL registers

    in al, KBD_PORT             ; read scancode
    cmp al, F10_SCAN            ; is it F10?
    jne done

    ; Check InDOS flag
    mov es, cs:indos_seg
    mov bx, cs:indos_offs
    cmp BYTE PTR es:[bx], 0    ; is DOS busy?
    jnz capture                 ; yes -> buffer it for later

    ; DOS is idle - save directly from video memory
    mov dx, 0B800h              ; text mode video memory segment
    mov ds, dx
    xor dx, dx                  ; offset 0
    call save
    jmp done

capture:
    ; DOS is busy - copy screen to our buffer for later
    mov ax, 0B800h
    mov ds, ax
    xor si, si                  ; source: video memory
    mov ax, cs
    mov es, ax
    mov di, OFFSET buffer       ; dest: our buffer

    mov cx, 80*25               ; 2000 character cells
@@: lodsw                       ; load word from DS:SI
    stosw                       ; store word to ES:DI
    loop @b

    inc cs:buffer_waiting       ; signal: data waiting

done:
    pushf
    call cs:old_keyboard        ; chain to original handler
    sti
    popa
    iret
keyboard ENDP

; === TIMER INTERRUPT HANDLER (INT 8) ===
timer PROC
    pusha

    ; Check if we have buffered data waiting
    cmp cs:buffer_waiting, 0
    je done

    ; Check if DOS is idle now
    mov es, cs:indos_seg
    mov bx, cs:indos_offs
    cmp BYTE PTR es:[bx], 0
    jnz done                    ; still busy, try again next tick

    ; DOS is idle - save the buffered data
    mov dx, cs
    mov ds, dx
    mov dx, OFFSET buffer
    call save
    dec cs:buffer_waiting       ; clear the flag

done:
    pushf
    call cs:old_timer           ; chain to original timer
    popa
    iret
timer ENDP

; === TRANSIENT: INSTALLATION CODE ===
install PROC
    ; Get InDOS flag address (CRITICAL for file I/O TSRs)
    mov ah, 034h
    int 21h
    mov indos_seg, es
    mov indos_offs, bx

    ; Save and replace keyboard interrupt (INT 9)
    mov ax, 3509h
    int 21h
    mov WORD PTR old_keyboard[0], bx
    mov WORD PTR old_keyboard[2], es
    mov ax, 2509h
    mov dx, OFFSET keyboard
    int 21h

    ; Save and replace timer interrupt (INT 8)
    mov ax, 3508h
    int 21h
    mov WORD PTR old_timer[0], bx
    mov WORD PTR old_timer[2], es
    mov ax, 2508h
    mov dx, OFFSET timer
    int 21h

    ; Calculate resident size and go TSR
    mov dx, OFFSET install      ; everything before install stays
    shr dx, 4                   ; convert to paragraphs
    inc dx                      ; round up
    mov ax, 3100h
    int 21h
install ENDP
```

### Key Lessons from shot.asm

1. **InDOS flag is essential for file I/O**: You MUST check it before calling
   any DOS file functions from an interrupt handler
2. **Deferred execution pattern**: If DOS is busy when the hotkey is pressed,
   buffer the data and use the timer interrupt to retry when DOS becomes idle
3. **Two interrupt hooks**: Keyboard for detecting the hotkey, Timer for
   deferred processing
4. **Chain to original handlers**: Always call the original handler to maintain
   system stability

---

## 9. Interrupt Hooking Techniques

### Method 1: Using DOS Functions (recommended)

```asm
; Save old vector
mov ax, 3509h               ; get INT 09h
int 21h                     ; ES:BX = old handler
mov [old_seg], es
mov [old_off], bx

; Install new vector
mov ax, 2509h               ; set INT 09h
mov dx, my_handler          ; DS:DX = new handler
int 21h
```

### Method 2: Direct IVT Manipulation

```asm
cli                         ; MUST disable interrupts during IVT changes!
xor ax, ax
mov es, ax                  ; ES = 0000 (IVT base)

; Save old vector (INT 9 = entry 9, each entry is 4 bytes)
mov ax, [es:9*4]            ; offset
mov [old_int9_off], ax
mov ax, [es:9*4+2]          ; segment
mov [old_int9_seg], ax

; Install new vector
mov word [es:9*4], my_handler       ; new offset
mov word [es:9*4+2], cs             ; new segment
sti                         ; re-enable interrupts
```

### Chaining to the Original Handler

**Method A: JMP FAR (most common)**

```asm
my_handler:
    ; ... do our work ...
    jmp far [cs:old_vector]     ; chain to original (it will IRET)
```

**Method B: CALL FAR + IRET (when you need to do work after)**

```asm
my_handler:
    pushf                       ; simulate INT (push flags)
    call far [cs:old_vector]    ; call original handler
    ; ... do work after original handler returns ...
    iret
```

**Method C: PUSH + RETF (capsmap style)**

```asm
my_handler:
    push word [cs:old_seg]
    push word [cs:old_off]
    retf                        ; "returns" to original handler
```

---

## 10. Register Preservation in ISRs

### Rule: Save and restore EVERY register you modify

For hardware interrupt handlers (INT 8, INT 9, etc.), you MUST preserve
all registers because you're interrupting unknown code:

```asm
my_isr:
    push ax
    push bx
    push cx
    push dx
    push si
    push di
    push ds
    push es
    push bp

    ; ... handler code ...
    ; Set DS to our segment if needed:
    push cs
    pop ds

    ; ... do work ...

    pop bp
    pop es
    pop ds
    pop di
    pop si
    pop dx
    pop cx
    pop bx
    pop ax
    iret
```

Or use PUSHA/POPA (286+):

```asm
my_isr:
    pusha                   ; push AX,CX,DX,BX,SP,BP,SI,DI
    push ds
    push es

    push cs
    pop ds                  ; DS = CS

    ; ... do work ...

    pop es
    pop ds
    popa
    iret
```

### Accessing Data in the ISR

Since DS is unknown when your ISR is called, you have two options:

**Option 1: CS override prefix (simple, good for few variables)**

```asm
inc word [cs:counter]       ; access data via CS segment
```

**Option 2: Load DS from CS (better for many variables)**

```asm
push ds
push cs
pop ds                      ; DS = CS
; now you can access all your variables normally
mov ax, [counter]
pop ds
```

### Flags Register

The `iret` instruction automatically restores FLAGS from the stack.
If you chain to another handler with `jmp far`, that handler's `iret` will
restore the original flags. If you use `call far`, you need `pushf` first.

---

## 11. The InDOS Flag and Reentrancy

DOS is NOT reentrant. If your TSR calls a DOS function while DOS is already
processing a request from the foreground program, the system will hang or crash.

### Getting the InDOS Flag Address

```asm
; Call this during INIT (before going resident)
mov ah, 34h
int 21h
; ES:BX -> InDOS flag (1 byte)
; Save these for use in your ISR:
mov [indos_seg], es
mov [indos_off], bx
```

### Checking Before Making DOS Calls

```asm
; In your ISR, before calling any INT 21h function:
    push es
    mov es, [cs:indos_seg]
    mov bx, [cs:indos_off]
    cmp byte [es:bx], 0        ; is DOS busy?
    pop es
    jnz dos_is_busy            ; if non-zero, DOS is active - DON'T CALL IT

    ; Also check the critical error flag (one byte before InDOS in DOS 3.1+)
    ; Both must be zero for safety
```

### The Critical Error Flag

In DOS 3.1+, the critical error flag is located at one byte before the
InDOS flag. Both must be zero before making DOS calls:

```asm
    mov es, [cs:indos_seg]
    mov bx, [cs:indos_off]
    cmp byte [es:bx-1], 0      ; critical error flag
    jnz not_safe
    cmp byte [es:bx], 0        ; InDOS flag
    jnz not_safe
    ; SAFE to call DOS
```

---

## 12. INT 28h - DOS Idle Interrupt

When DOS is waiting for keyboard input (functions 01h-0Ch), it continuously
executes INT 28h in a loop. By hooking INT 28h, a TSR can detect when DOS
is in an idle polling state.

During INT 28h, DOS functions with numbers GREATER THAN 0Ch are safe to call
(file I/O, memory management, etc.).

```asm
; Hook INT 28h during init
old_int28 dd 0

my_int28:
    pushf
    call far [cs:old_int28]     ; chain first

    ; Check if we have pending work
    cmp byte [cs:work_pending], 0
    je .done

    ; We're in INT 28h, so DOS is idle-waiting
    ; Functions > 0Ch are safe to call
    ; ... do file I/O here ...

.done:
    iret
```

---

## 13. PSP and Environment Block

### The PSP (Program Segment Prefix)

The PSP is a 256-byte (100h) header that DOS creates before every program.
For .COM files, it starts at CS:0000 (the program code starts at CS:0100).

Key PSP fields for TSR programming:

| Offset | Size | Description |
|--------|------|-------------|
| 00h    | 2    | INT 20h instruction (CD 20) |
| 02h    | 2    | Segment of first byte beyond allocated memory |
| 2Ch    | 2    | Segment of environment block |
| 80h    | 1    | Length of command tail |
| 81h    | 127  | Command tail (command line arguments) |

### Freeing the Environment Block

The environment block contains copies of all environment variables at the
time the program was loaded. TSRs should free it to save memory:

```asm
; During init, before going resident:
    mov ah, 62h             ; get current PSP segment
    int 21h                 ; BX = PSP segment
    mov es, bx
    mov es, [es:2Ch]        ; ES = environment segment
    mov ah, 49h             ; free memory block
    int 21h                 ; free the environment block
```

This can save 100-1000+ bytes depending on environment size.

### Storing the PSP Segment

Save your PSP segment during init for later use (unloading, etc.):

```asm
; In resident data area:
my_psp dw 0

; During init:
    mov ah, 62h
    int 21h
    mov [my_psp], bx        ; save PSP segment for later
```

---

## 14. The Multiplex Interrupt: INT 2Fh

INT 2Fh is the standard mechanism for TSRs to communicate with applications
and with each other. Each TSR claims a unique function number in AH.

### Convention

- AH = TSR identifier (00h-FFh)
- AL = function code
- Function 00h = "Are you there?" (installation check)

### Implementing a Multiplex Handler

```asm
; Resident data
my_id db 0              ; assigned during init

; Resident handler
my_int2f:
    cmp ah, [cs:my_id]
    je .handle
    jmp far [cs:old_int2f]  ; not ours, chain to next

.handle:
    cmp al, 0               ; installation check?
    je .install_check
    ; ... handle other functions ...
    iret

.install_check:
    mov al, 0FFh            ; "yes, I'm installed"
    ; Optionally return identification string:
    mov di, signature
    mov dx, cs              ; DX:DI -> signature string
    iret

signature db 'MYTSR',0
```

### Finding a Free Multiplex ID (during init)

```asm
    xor cl, cl              ; start with ID 0
.scan_loop:
    mov ah, cl
    mov al, 0               ; installation check
    int 2Fh
    cmp al, 0               ; 0 = not installed
    je .found_free
    inc cl
    jnz .scan_loop
    ; Error: no free IDs!
    jmp .error

.found_free:
    mov [my_id], cl         ; save our assigned ID
```

---

## 15. AMIS: Alternate Multiplex Interrupt Specification

Proposed by Ralf D. Brown as an improvement over INT 2Fh for TSR cooperation.
Uses INT 2Dh instead of INT 2Fh.

AMIS provides standardized functions:

- 00h: Installation check (returns vendor/product signature)
- 01h: Get private entry point
- 02h: Uninstall
- 03h: Request pop-up
- 04h: Determine chained interrupts
- 05h: Get hotkeys
- 06h: Get device driver information

Each TSR identifies itself with an 8-byte vendor string and 8-byte product string.

AMIS never gained widespread adoption but is well-documented. The specification
and AMISLIB (a library for writing AMIS-compliant TSRs) are available in
archived form.

See: github.com/drivelling-spinel/123123 for a working NASM example using AMIS.

---

## 16. Unloading a TSR

Unloading is one of the hardest TSR problems. The interrupt chain is a singly
linked list, and your TSR might not be at the head.

### Safe Unloading Conditions

Before unloading, verify that ALL interrupt vectors you hooked still point
to YOUR handlers. If another TSR has hooked the same interrupts after you,
removing yourself would break the chain.

```asm
unload:
    ; Check if we're still at the head of INT 9 chain
    mov ax, 3509h
    int 21h
    cmp bx, my_keyboard_handler
    jne .cant_unload
    mov ax, es
    mov bx, cs
    cmp ax, bx
    jne .cant_unload

    ; Safe to unload - restore original vectors
    push ds
    lds dx, [cs:old_int9]       ; DS:DX = original handler
    mov ax, 2509h
    int 21h
    pop ds

    ; Free environment block
    mov es, [cs:my_psp]
    mov es, [es:2Ch]
    mov ah, 49h
    int 21h

    ; Free TSR memory
    mov es, [cs:my_psp]
    mov ah, 49h
    int 21h

    ret

.cant_unload:
    ; Another TSR is chained after us - unsafe to remove
    ; Print error message and abort
```

### The LIFO Rule

TSRs must be removed in the REVERSE ORDER they were installed (Last In,
First Out). Many users accept this limitation rather than implementing
complex chain-unwinding logic.

### Practical Advice

For simple TSRs, don't bother with unloading. Just reboot. For TSRs that
need to be unloadable, use INT 2Fh to provide an unload function, and
always check the interrupt chain before removing.

---

## 17. DTA, PSP Switching, and Extended Error Preservation

When a TSR makes DOS calls, it must protect the foreground application's state.

### DTA (Disk Transfer Area) Preservation

```asm
; Save current DTA
    mov ah, 2Fh
    int 21h                 ; ES:BX = current DTA
    push es
    push bx

    ; Set our own DTA
    push cs
    pop ds
    mov dx, my_dta
    mov ah, 1Ah
    int 21h

    ; ... do file operations ...

    ; Restore original DTA
    pop dx                  ; was BX
    pop ds                  ; was ES
    mov ah, 1Ah
    int 21h

; In resident data:
my_dta db 128 dup(0)        ; our private DTA
```

### PSP Switching

DOS tracks the "current PSP" and uses it for file handle tables, etc.
When your TSR makes DOS calls, switch to your own PSP first:

```asm
    ; Save foreground PSP
    mov ah, 51h             ; get current PSP
    int 21h
    push bx                 ; save it

    ; Set our PSP
    mov bx, [cs:my_psp]
    mov ah, 50h
    int 21h

    ; ... do DOS calls ...

    ; Restore foreground PSP
    pop bx
    mov ah, 50h
    int 21h
```

### Extended Error Information

```asm
    ; Save extended error info (11 words)
    mov ah, 59h
    xor bx, bx
    int 21h
    ; Save AX, BX, CX, DX, SI, DI, DS, ES (plus class, action, locus)
    ; into an 11-word buffer

    ; ... do TSR DOS calls ...

    ; Restore with function 5D0Ah
    push cs
    pop ds
    mov si, saved_error_info
    mov ax, 5D0Ah
    int 21h
```

---

## 18. BIOS Reentrancy Wrappers

BIOS routines (INT 10h for video, INT 13h for disk, INT 16h for keyboard)
are also non-reentrant but provide no "InBIOS" flag. Create your own:

```asm
; Wrapper for INT 10h (video BIOS)
int10_busy db 0

my_int10:
    inc byte [cs:int10_busy]    ; mark BIOS as busy
    pushf
    call far [cs:old_int10]     ; call original INT 10h
    dec byte [cs:int10_busy]    ; mark BIOS as free
    iret

; In your popup/active code, check before using video BIOS:
    cmp byte [cs:int10_busy], 0
    jnz video_busy              ; can't use video right now
```

---

## 19. Stack Switching

Hardware ISRs run on whatever stack the interrupted program was using. If your
TSR needs significant stack space, switch to a private stack:

```asm
; Resident data
tsr_stack times 512 db 0        ; 512-byte private stack
tsr_stack_top:
saved_ss dw 0
saved_sp dw 0

my_handler:
    ; Save current stack
    mov [cs:saved_ss], ss
    mov [cs:saved_sp], sp

    ; Switch to our stack
    cli
    mov ss, cs                  ; or: push cs / pop ss
    mov sp, tsr_stack_top
    sti

    ; ... do work (can use lots of stack now) ...

    ; Restore original stack
    cli
    mov ss, [cs:saved_ss]
    mov sp, [cs:saved_sp]
    sti

    iret
```

---

## 20. GitHub Repositories with Working TSR Code

### Keyboard/Input TSRs

| Repo | Language | Description |
|------|----------|-------------|
| [jtsiomb/capsmap](https://github.com/jtsiomb/capsmap) | NASM | Remaps Caps Lock to Ctrl/Alt/Shift. Clean, simple, well-commented. **Best starter example.** |
| [drivelling-spinel/123123](https://github.com/drivelling-spinel/123123) | NASM | Keyboard manipulation tool using AMIS specification. Complex but well-structured. |
| [chris-e-green/shftlock](https://github.com/chris-e-green/shftlock) | ASM | Makes keyboard behave like a typewriter (shift lock). |
| [sivann/dos928](https://github.com/sivann/dos928) | ASM | TSR keyboard driver for ISO-8859-7 Greek input. |

### File I/O TSRs

| Repo | Language | Description |
|------|----------|-------------|
| [uzimonkey/shot](https://github.com/uzimonkey/shot) | TASM | Saves text screenshots to file. Demonstrates InDOS flag + deferred file I/O. **Best file I/O example.** |

### Network/Disk TSRs

| Repo | Language | Description |
|------|----------|-------------|
| [michaelortmann/ethflop](https://github.com/michaelortmann/ethflop) | NASM | Emulates a floppy drive over Ethernet. Hooks INT 13h. Full network + disk I/O from a TSR. Advanced. |
| [MobyGamer/softhddi](https://github.com/MobyGamer/softhddi) | ASM | Simulates hard disk activity LEDs and sounds. |

### Video/Display TSRs

| Repo | Language | Description |
|------|----------|-------------|
| [dmitrygerasimuk/msdos-solarized-theme](https://github.com/dmitrygerasimuk/msdos-solarized-theme) | ASM | Resident Solarized color theme for DOS. |
| [grey-olli/mda-russification](https://github.com/grey-olli/mda-russification) | ASM | Russian character display for MDA monitors. |
| [jakethompson1/fixsm712](https://github.com/jakethompson1/fixsm712) | ASM | Fixes video mode outputs of SM712 graphics chip. |

### Emulation/Compatibility TSRs

| Repo | Language | Description |
|------|----------|-------------|
| [volkertb/temu-vsb](https://github.com/volkertb/temu-vsb) | ASM | Tandy Emulator and Virtual Sound Blaster TSRs. |
| [cr1901/FIXBASIC](https://github.com/cr1901/FIXBASIC) | ASM | Fixes QBASIC crashes on non-IBM clones. |
| [PluMGMK/rayman-tpls-tsr](https://github.com/PluMGMK/rayman-tpls-tsr) | ASM | Per-level soundtrack for Rayman as a native DOS TSR. |

### Misc

| Repo | Language | Description |
|------|----------|-------------|
| [nhatpq304/Dos_TSR](https://github.com/nhatpq304/Dos_TSR) | ASM | Shows time and mouse position. |
| [osfree-project/fastopen](https://github.com/osfree-project/fastopen) | ASM | FASTOPEN DOS TSR (file access cache). |

---

## 21. Common Pitfalls

### 1. Forgetting to Save/Restore Registers

Every register your ISR touches MUST be saved and restored. The interrupted
program has no idea you just ran. Even FLAGS must be preserved (IRET handles
this, but be careful with CLC/STC/CLI/STI).

### 2. Wrong Resident Size Calculation

If you keep too little memory, your code gets overwritten. Too much wastes
RAM. Always round UP when converting bytes to paragraphs. Don't forget the
PSP (10h paragraphs = 256 bytes).

### 3. Calling DOS from a Hardware ISR Without Checking InDOS

This is the #1 cause of TSR crashes. NEVER call INT 21h from a hardware
interrupt handler without first checking the InDOS flag.

### 4. Not Chaining to the Original Handler

If you hook INT 9 (keyboard) and don't chain to the original handler,
the keyboard stops working for everyone else. Always chain unless you're
deliberately consuming the interrupt.

### 5. Storing Data Past resident_end

Variables used by the ISR MUST be in the resident portion. If you put them
after the `resident_end` label, they'll be in freed memory.

### 6. Using DS Without Setting It

When your ISR is called, DS points to whatever the interrupted program was
using. You must set DS=CS (or use cs: overrides) to access your data.

### 7. Not Disabling Interrupts When Modifying IVT

If you directly modify the interrupt vector table (segment 0000), you MUST
use CLI/STI around the modification. Otherwise, an interrupt could fire
between writing the offset and segment, jumping to an invalid address.

### 8. Using INT 27h for Large TSRs

INT 27h can only keep up to 64 KB. Use INT 21h/31h for larger programs.

### 9. Assuming SS:SP is Valid

Hardware interrupts can occur at any time. The interrupted program's stack
might be nearly full. For TSRs that need significant stack space, switch
to a private stack.

### 10. TSR Loads Multiple Times

Without an installation check (via INT 2Fh), running your TSR twice installs
two copies. Each hooks the same interrupts, wasting memory and potentially
causing double-processing bugs.

---

## 22. References and Further Reading

### Books and Tutorials

- **"The Art of Assembly Language Programming" by Randall Hyde** - Chapter 18
  covers TSR programming in depth. Freely available online:
  <https://www.plantation-productions.com/Webster/www.artofasm.com/DOS/ch18/>
  - CH18-1: Memory management, INT 21h/31h, size calculation
  - CH18-2: Passive vs active TSRs, keyboard/timer hooking examples
  - CH18-3: InDOS flag, reentrancy, INT 28h, safe popup techniques
  - CH18-4: INT 2Fh multiplex, installation checks, unloading

- **Ralf Brown's Interrupt List** - The definitive reference for all DOS/BIOS
  interrupts. Essential for TSR programming.
  <https://www.ctyme.com/intr/int.htm>
  - INT 21h/25h: Set Interrupt Vector
  - INT 21h/31h: Terminate and Stay Resident
  - INT 21h/34h: Get InDOS Flag Address
  - INT 21h/35h: Get Interrupt Vector

- **Wikipedia: Terminate-and-stay-resident program**
  <https://en.wikipedia.org/wiki/Terminate-and-stay-resident_program>

### Specifications

- **AMIS (Alternate Multiplex Interrupt Specification) v3.5** by Ralf D. Brown
  - Standardized TSR cooperation via INT 2Dh
  - Vendor/product identification strings
  - Standardized install/uninstall/hotkey management

- **IBM Interrupt Sharing Protocol**
  - Original hardware interrupt sharing specification
  - AMIS is modeled on this for software interrupts

### StackOverflow Questions (search `[tsr] [dos]`)

- "Help Writing TSR Program(s) in NASM Assembly for DOS" (9 votes, 2 answers)
- "Assembly on DOS (TASM), creating TSR with a new handler on int 21h" (1 vote, 3 answers)
- "How to remove TSR program from memory" (multiple questions by user Bozic)
- "DOS TSR program using int 27h" (MASM, keyboard repeat rate example)
- "My TSR program freezes when executed a second time" (common installation check issue)

### Key Interrupts Reference

| Interrupt | Purpose | TSR Usage |
|-----------|---------|-----------|
| INT 08h   | Timer tick (18.2 Hz) | Periodic tasks, deferred processing |
| INT 09h   | Keyboard hardware | Hotkey detection, key remapping |
| INT 10h   | Video BIOS | Popup display (check reentrancy!) |
| INT 13h   | Disk BIOS | Disk emulation (ethflop) |
| INT 16h   | Keyboard BIOS | Key interception (passive) |
| INT 1Ch   | User timer hook | Simpler timer hook (called from INT 08h) |
| INT 21h   | DOS services | File I/O (check InDOS first!) |
| INT 27h   | TSR terminate | Going resident (old method) |
| INT 28h   | DOS idle | Safe DOS call opportunity |
| INT 2Dh   | AMIS multiplex | TSR cooperation |
| INT 2Fh   | Multiplex | TSR communication/install check |

---

## Quick Reference: Minimal TSR Template (NASM, .COM)

```asm
; template-tsr.asm - Minimal TSR template for NASM
; Build: nasm -f bin -o template.com template-tsr.asm
;
; This template hooks INT 1Ch (user timer tick, ~18.2 times/sec)
; and provides an INT 2Fh installation check.

bits 16
org 100h

    jmp init

; ===================== RESIDENT PORTION =====================

TSR_ID equ 0E0h                ; multiplex ID (pick unused value)

old_int1c dd 0                  ; saved INT 1Ch vector
old_int2f dd 0                  ; saved INT 2Fh vector
my_psp    dw 0                  ; our PSP segment
signature db 'MYTSRV1',0        ; identification string

; --- Timer tick handler (called ~18.2 times per second) ---
timer_handler:
    pushf
    call far [cs:old_int1c]     ; chain to original FIRST

    ; Save registers we'll use
    push ax
    push ds

    push cs
    pop ds                      ; DS = CS

    ; === YOUR PERIODIC CODE HERE ===
    ; Example: increment a counter
    inc word [counter]

    pop ds
    pop ax
    iret

counter dw 0

; --- Multiplex handler (INT 2Fh) ---
mux_handler:
    cmp ah, TSR_ID
    je .ours
    jmp far [cs:old_int2f]      ; not ours, chain

.ours:
    cmp al, 0                   ; installation check?
    je .check
    ; Add more subfunctions here (al=1 for unload, etc.)
    xor al, al                  ; unknown function
    iret

.check:
    mov al, 0FFh                ; "I'm installed"
    mov di, signature
    push cs
    pop es                      ; ES:DI -> signature
    iret

resident_end:

; ===================== TRANSIENT PORTION =====================

init:
    ; Check if already installed
    mov ah, TSR_ID
    mov al, 0
    int 2Fh
    cmp al, 0FFh
    je .already_installed

    ; Save PSP
    mov ah, 62h
    int 21h
    mov [my_psp], bx

    ; Free environment block to save memory
    mov es, [2Ch]               ; environment segment from PSP
    mov ah, 49h
    int 21h

    ; Hook INT 1Ch (user timer)
    mov ax, 351Ch
    int 21h
    mov word [old_int1c], bx
    mov word [old_int1c+2], es
    mov ax, 251Ch
    mov dx, timer_handler
    int 21h

    ; Hook INT 2Fh (multiplex)
    mov ax, 352Fh
    int 21h
    mov word [old_int2f], bx
    mov word [old_int2f+2], es
    mov ax, 252Fh
    mov dx, mux_handler
    int 21h

    ; Print success message
    mov ah, 09h
    mov dx, msg_ok
    int 21h

    ; Go resident
    mov dx, resident_end
    shr dx, 4
    add dx, 11h                 ; round up + PSP
    mov ax, 3100h
    int 21h

.already_installed:
    mov ah, 09h
    mov dx, msg_dup
    int 21h
    mov ax, 4C01h               ; exit with error code 1
    int 21h

msg_ok  db 'TSR installed successfully.',13,10,'$'
msg_dup db 'TSR is already installed!',13,10,'$'
```

This template includes:

- Proper code layout (resident first, transient last)
- INT 2Fh installation check (prevents duplicate loading)
- Environment block freeing (saves memory)
- Timer hook with register preservation
- Correct resident size calculation
- Chaining to original handlers
