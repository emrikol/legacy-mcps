# 8086 Instruction Set Reference for DOS TSR Development

Quick reference for the original 8086/8088 instruction set (81 instructions).
Focused on what matters for writing a real-mode DOS TSR in assembly.

Sources: Wikipedia "List of x86 instructions", HelpPC 8086 reference.

---

## Registers

```
General purpose (16-bit, with 8-bit halves):
  AX (AH:AL)  - Accumulator. Implicit in MUL, DIV, IN, OUT, string ops, etc.
  BX (BH:BL)  - Base register. Used in addressing modes [BX], [BX+SI], etc.
  CX (CH:CL)  - Count register. Implicit in LOOP, REP, shifts by CL.
  DX (DH:DL)  - Data register. Implicit in MUL (32-bit result DX:AX), DIV, IN/OUT.

Index registers (16-bit only):
  SI  - Source Index. Used by string ops (LODS, MOVS, CMPS) with DS:.
  DI  - Destination Index. Used by string ops (STOS, MOVS, SCAS) with ES:.

Pointer registers (16-bit only):
  SP  - Stack Pointer. Points to top of stack (SS:SP).
  BP  - Base Pointer. Used for stack frame addressing (SS:BP).

Segment registers:
  CS  - Code Segment (cannot MOV to CS directly)
  DS  - Data Segment (default for most memory access)
  ES  - Extra Segment (used by string destination, LES)
  SS  - Stack Segment (used with SP, BP)

Special:
  IP  - Instruction Pointer (not directly accessible)
  FLAGS - Status/control flags register
```

### FLAGS register bits (8086)

```
Bit  Flag  Name              Set by arithmetic?
 0   CF    Carry Flag        Yes
 2   PF    Parity Flag       Yes (low 8 bits)
 4   AF    Auxiliary Carry    Yes (BCD ops)
 6   ZF    Zero Flag         Yes
 7   SF    Sign Flag         Yes
 8   TF    Trap Flag         No (debug single-step)
 9   IF    Interrupt Flag    No (CLI/STI only)
10   DF    Direction Flag    No (CLD/STD only)
11   OF    Overflow Flag     Yes
```

---

## String Operations

All string instructions operate on bytes (B suffix) or words (W suffix).
They auto-increment or auto-decrement the index registers based on the Direction Flag.

| Instruction | Operation | Registers Used | Segment |
|-------------|-----------|----------------|---------|
| `LODSB` | AL = [DS:SI]; SI += 1 | AL, SI | DS |
| `LODSW` | AX = [DS:SI]; SI += 2 | AX, SI | DS |
| `STOSB` | [ES:DI] = AL; DI += 1 | AL, DI | ES |
| `STOSW` | [ES:DI] = AX; DI += 2 | AX, DI | ES |
| `MOVSB` | [ES:DI] = [DS:SI]; SI += 1; DI += 1 | SI, DI | DS, ES |
| `MOVSW` | [ES:DI] = [DS:SI]; SI += 2; DI += 2 | SI, DI | DS, ES |
| `CMPSB` | Compare [DS:SI] with [ES:DI]; SI += 1; DI += 1 | SI, DI | DS, ES |
| `CMPSW` | Compare [DS:SI] with [ES:DI]; SI += 2; DI += 2 | SI, DI | DS, ES |
| `SCASB` | Compare AL with [ES:DI]; DI += 1 | AL, DI | ES |
| `SCASW` | Compare AX with [ES:DI]; DI += 2 | AX, DI | ES |

Notes:

- When DF=0 (CLD), index registers increment (forward scan).
- When DF=1 (STD), index registers decrement (backward scan).
- CMPSB/CMPSW and SCASB/SCASW set FLAGS (CF, ZF, SF, OF, AF, PF) based on the comparison.
- LODSB/STOSB/MOVSB do NOT affect flags.
- DS: can be overridden with a segment prefix on source; ES: for destination cannot be overridden.

### Direction Flag Control

| Instruction | Operation |
|-------------|-----------|
| `CLD` | Clear Direction Flag (DF=0, forward) |
| `STD` | Set Direction Flag (DF=1, backward) |

### REP Prefixes

| Prefix | Use with | Behavior |
|--------|----------|----------|
| `REP` | MOVSB/MOVSW, STOSB/STOSW, LODSB/LODSW | Repeat CX times; decrement CX each iteration; stop when CX=0 |
| `REPZ` / `REPE` | CMPSB/CMPSW, SCASB/SCASW | Repeat while ZF=1 and CX != 0 |
| `REPNZ` / `REPNE` | CMPSB/CMPSW, SCASB/SCASW | Repeat while ZF=0 and CX != 0 |

Common patterns:

```nasm
; Copy CX bytes from DS:SI to ES:DI
cld
rep movsb

; Fill CX bytes at ES:DI with AL
cld
rep stosb

; Find byte AL in string at ES:DI, length CX
cld
repne scasb         ; DI points past the match when found, ZF=1 if found

; Compare two strings of length CX
cld
repe cmpsb          ; Stops at first difference, ZF=0 if different
```

---

## Data Movement

| Instruction | Operation | Flags affected |
|-------------|-----------|----------------|
| `MOV dst, src` | dst = src | None |
| `XCHG dst, src` | Swap dst and src | None |
| `LEA reg, mem` | reg = effective address of mem (no memory access) | None |
| `LDS reg, mem` | reg = [mem], DS = [mem+2] (load far pointer) | None |
| `LES reg, mem` | reg = [mem], ES = [mem+2] (load far pointer) | None |
| `XLAT` / `XLATB` | AL = [BX + AL] (table lookup, DS:BX is table base) | None |
| `CBW` | Sign-extend AL into AX (AH = 0 or FFh) | None |
| `CWD` | Sign-extend AX into DX:AX (DX = 0 or FFFFh) | None |
| `LAHF` | AH = low byte of FLAGS (SF, ZF, AF, PF, CF) | None |
| `SAHF` | Low byte of FLAGS = AH | SF, ZF, AF, PF, CF |

### Segment register moves

```nasm
mov ax, ds          ; Read segment register - OK
mov ds, ax          ; Write segment register - OK
mov es, ax          ; Write segment register - OK
mov ss, ax          ; Write SS - interrupts disabled for next instruction
; mov cs, ax        ; ILLEGAL - cannot MOV to CS (use far JMP/RET instead)
push ds             ; OK
pop ds              ; OK
push cs             ; OK on 8086
; pop cs            ; DO NOT USE - opcode 0Fh, unreliable, repurposed on 286+
```

**Gotcha:** After `MOV SS, reg`, the CPU automatically disables interrupts for the next instruction so you can set SP without risk. Always follow `MOV SS` with `MOV SP` immediately.

---

## Arithmetic

| Instruction | Operation | Flags |
|-------------|-----------|-------|
| `ADD dst, src` | dst = dst + src | OF, SF, ZF, AF, PF, CF |
| `ADC dst, src` | dst = dst + src + CF | OF, SF, ZF, AF, PF, CF |
| `SUB dst, src` | dst = dst - src | OF, SF, ZF, AF, PF, CF |
| `SBB dst, src` | dst = dst - src - CF | OF, SF, ZF, AF, PF, CF |
| `INC dst` | dst = dst + 1 | OF, SF, ZF, AF, PF (NOT CF!) |
| `DEC dst` | dst = dst - 1 | OF, SF, ZF, AF, PF (NOT CF!) |
| `NEG dst` | dst = 0 - dst (two's complement) | OF, SF, ZF, AF, PF, CF |
| `CMP dst, src` | Compute dst - src, set flags, discard result | OF, SF, ZF, AF, PF, CF |
| `TEST dst, src` | Compute dst AND src, set flags, discard result | SF, ZF, PF (CF=0, OF=0) |

**Gotcha: INC/DEC do NOT affect CF.** This is by design so you can use INC/DEC as loop counters without disturbing CF from a multi-precision ADC/SBB chain.

### Multiply

| Instruction | Operation | Flags |
|-------------|-----------|-------|
| `MUL r/m8` | AX = AL * r/m8 (unsigned) | CF, OF (ZF, SF, PF undefined) |
| `MUL r/m16` | DX:AX = AX * r/m16 (unsigned) | CF, OF |
| `IMUL r/m8` | AX = AL * r/m8 (signed) | CF, OF |
| `IMUL r/m16` | DX:AX = AX * r/m16 (signed) | CF, OF |

**Gotcha:** MUL/IMUL always use AL or AX as an implicit operand and always produce a double-width result. There is no 2-operand or 3-operand form on 8086 (those were added in 80186).

### Divide

| Instruction | Operation | Flags |
|-------------|-----------|-------|
| `DIV r/m8` | AL = AX / r/m8, AH = AX mod r/m8 (unsigned) | All undefined |
| `DIV r/m16` | AX = DX:AX / r/m16, DX = DX:AX mod r/m16 (unsigned) | All undefined |
| `IDIV r/m8` | AL = AX / r/m8, AH = AX mod r/m8 (signed) | All undefined |
| `IDIV r/m16` | AX = DX:AX / r/m16, DX = DX:AX mod r/m16 (signed) | All undefined |

**Gotcha:** If the quotient overflows the destination register (AL for byte, AX for word), the CPU generates a divide error exception (INT 0). This happens easily: `MOV AX, 0100h / DIV byte_value_of_1` => quotient 256 overflows AL. Always ensure DX (or AH) is properly set before dividing. Use `XOR DX, DX` before unsigned DIV word, or `CWD` before signed IDIV word.

---

## Shifts and Rotates

On 8086, shifts/rotates accept only two forms: by 1 or by CL.

| Instruction | Operation | Flags |
|-------------|-----------|-------|
| `SHL dst, 1` | Shift left by 1 (multiply by 2) | CF, OF, SF, ZF, PF |
| `SHL dst, CL` | Shift left by CL bits | CF, OF*, SF, ZF, PF |
| `SHR dst, 1` | Logical shift right by 1 (unsigned divide by 2) | CF, OF, SF, ZF, PF |
| `SHR dst, CL` | Logical shift right by CL bits | CF, OF*, SF, ZF, PF |
| `SAR dst, 1` | Arithmetic shift right by 1 (signed divide by 2, preserves sign) | CF, OF, SF, ZF, PF |
| `SAR dst, CL` | Arithmetic shift right by CL bits | CF, OF*, SF, ZF, PF |
| `ROL dst, 1` | Rotate left by 1 | CF, OF |
| `ROL dst, CL` | Rotate left by CL | CF, OF* |
| `ROR dst, 1` | Rotate right by 1 | CF, OF |
| `ROR dst, CL` | Rotate right by CL | CF, OF* |
| `RCL dst, 1` | Rotate left through carry by 1 | CF, OF |
| `RCL dst, CL` | Rotate left through carry by CL | CF, OF* |
| `RCR dst, 1` | Rotate right through carry by 1 | CF, OF |
| `RCR dst, CL` | Rotate right through carry by CL | CF, OF* |

*OF is only defined for single-bit shifts/rotates.

**Gotcha: `SHL dst, 5` is NOT valid on 8086!** You must use `MOV CL, 5` then `SHL dst, CL`, or chain `SHL dst, 1` five times. Immediate shift counts > 1 were added with the 80186.

---

## Logic

| Instruction | Operation | Flags |
|-------------|-----------|-------|
| `AND dst, src` | dst = dst AND src | SF, ZF, PF (CF=0, OF=0) |
| `OR dst, src` | dst = dst OR src | SF, ZF, PF (CF=0, OF=0) |
| `XOR dst, src` | dst = dst XOR src | SF, ZF, PF (CF=0, OF=0) |
| `NOT dst` | dst = bitwise NOT dst (one's complement) | None! |
| `TEST dst, src` | AND without storing result, just sets flags | SF, ZF, PF (CF=0, OF=0) |

Common patterns:

```nasm
xor ax, ax          ; Zero AX (smaller/faster than MOV AX, 0)
test al, al         ; Check if AL is zero without modifying it
or al, al           ; Same effect as TEST AL, AL (also clears CF)
and al, 0Fh         ; Mask to low nibble
```

---

## Control Flow

### Unconditional

| Instruction | Operation |
|-------------|-----------|
| `JMP short label` | IP = IP + signed 8-bit offset (-128 to +127) |
| `JMP near label` | IP = IP + signed 16-bit offset |
| `JMP far seg:off` | CS:IP = seg:off |
| `JMP r/m16` | IP = r/m16 (indirect near jump) |
| `JMP FAR [mem]` | CS:IP = dword at [mem] (indirect far jump) |
| `CALL near label` | Push IP, then JMP near |
| `CALL far seg:off` | Push CS, push IP, then JMP far |
| `CALL r/m16` | Push IP, then IP = r/m16 (indirect near call) |
| `RET` | Pop IP (near return) |
| `RET imm16` | Pop IP, then SP += imm16 (clean up stack args) |
| `RETF` | Pop IP, pop CS (far return) |
| `RETF imm16` | Pop IP, pop CS, then SP += imm16 |

### Software Interrupts

| Instruction | Operation |
|-------------|-----------|
| `INT imm8` | Push FLAGS, clear IF and TF, push CS, push IP, then jump to IVT[imm8*4] |
| `INTO` | If OF=1, execute INT 4 |
| `IRET` | Pop IP, pop CS, pop FLAGS (return from interrupt) |

**Important for TSRs:** INT pushes FLAGS and clears IF (disables interrupts). IRET restores FLAGS including IF. When chaining to old interrupt handlers, use a simulated INT: `PUSHF / CALL FAR [old_handler]` so the old handler's IRET pops the FLAGS you pushed.

### Conditional Jumps

All conditional jumps are SHORT only on 8086 (signed 8-bit offset, -128 to +127 range). For longer jumps, invert the condition and jump over an unconditional JMP.

**Unsigned comparisons (after CMP of unsigned values):**

| Instruction | Aliases | Condition | Meaning |
|-------------|---------|-----------|---------|
| `JA` | `JNBE` | CF=0 and ZF=0 | Jump if Above |
| `JAE` | `JNB`, `JNC` | CF=0 | Jump if Above or Equal |
| `JB` | `JNAE`, `JC` | CF=1 | Jump if Below (Carry) |
| `JBE` | `JNA` | CF=1 or ZF=1 | Jump if Below or Equal |

**Signed comparisons (after CMP of signed values):**

| Instruction | Aliases | Condition | Meaning |
|-------------|---------|-----------|---------|
| `JG` | `JNLE` | ZF=0 and SF=OF | Jump if Greater |
| `JGE` | `JNL` | SF=OF | Jump if Greater or Equal |
| `JL` | `JNGE` | SF != OF | Jump if Less |
| `JLE` | `JNG` | ZF=1 or SF != OF | Jump if Less or Equal |

**Equality/flag-based:**

| Instruction | Aliases | Condition | Meaning |
|-------------|---------|-----------|---------|
| `JE` | `JZ` | ZF=1 | Jump if Equal / Zero |
| `JNE` | `JNZ` | ZF=0 | Jump if Not Equal / Not Zero |
| `JO` | | OF=1 | Jump if Overflow |
| `JNO` | | OF=0 | Jump if No Overflow |
| `JS` | | SF=1 | Jump if Sign (negative) |
| `JNS` | | SF=0 | Jump if No Sign (positive/zero) |
| `JP` | `JPE` | PF=1 | Jump if Parity Even |
| `JNP` | `JPO` | PF=0 | Jump if Parity Odd |
| `JCXZ` | | CX=0 | Jump if CX is Zero (no flags tested) |

### Loops

| Instruction | Operation |
|-------------|-----------|
| `LOOP label` | CX = CX - 1; if CX != 0, jump to label |
| `LOOPZ label` / `LOOPE` | CX = CX - 1; if CX != 0 and ZF=1, jump |
| `LOOPNZ label` / `LOOPNE` | CX = CX - 1; if CX != 0 and ZF=0, jump |

**Note:** LOOP decrements CX first, then tests. If CX starts at 0, it wraps to FFFFh and loops 65535 more times. Guard with `JCXZ skip` before the loop.

**Note:** LOOP does NOT set any flags (the CX decrement is flagless).

---

## Stack Operations

| Instruction | Operation | Flags |
|-------------|-----------|-------|
| `PUSH r/m16` | SP -= 2; [SS:SP] = operand | None |
| `PUSH seg` | SP -= 2; [SS:SP] = segment register | None |
| `POP r/m16` | operand = [SS:SP]; SP += 2 | None |
| `POP seg` | segment register = [SS:SP]; SP += 2 | None |
| `PUSHF` | SP -= 2; [SS:SP] = FLAGS | None |
| `POPF` | FLAGS = [SS:SP]; SP += 2 | All flags |

**Gotcha:** On 8086, `PUSH SP` pushes the value of SP *after* the decrement (SP-2). This was changed on 286+ to push the value *before* the decrement. Don't rely on `PUSH SP` behavior.

**Gotcha:** `PUSH imm` does NOT exist on 8086. It was added in 80186. Use `MOV AX, imm` / `PUSH AX` instead.

---

## Interrupt Control

| Instruction | Operation |
|-------------|-----------|
| `CLI` | Clear IF (disable maskable interrupts) |
| `STI` | Set IF (enable maskable interrupts) |

**TSR note:** Keep CLI sections as short as possible. Disable interrupts when modifying the IVT (interrupt vector table) or shared data structures, then STI immediately after.

---

## I/O Instructions

| Instruction | Operation |
|-------------|-----------|
| `IN AL, imm8` | Read byte from I/O port imm8 |
| `IN AX, imm8` | Read word from I/O port imm8 |
| `IN AL, DX` | Read byte from I/O port in DX |
| `IN AX, DX` | Read word from I/O port in DX |
| `OUT imm8, AL` | Write byte to I/O port imm8 |
| `OUT imm8, AX` | Write word to I/O port imm8 |
| `OUT DX, AL` | Write byte to I/O port in DX |
| `OUT DX, AX` | Write word to I/O port in DX |

---

## Miscellaneous

| Instruction | Operation |
|-------------|-----------|
| `NOP` | No operation (actually `XCHG AX, AX`) |
| `HLT` | Halt CPU until interrupt |
| `WAIT` | Wait for FPU (TEST pin) |
| `LOCK` | Prefix: assert bus LOCK for next instruction |
| `ESC opcode, src` | FPU instruction escape |
| `INT 3` | Breakpoint (single-byte opcode CCh) |

---

## What is NOT Available on 8086

These instructions were added in later processors. Do NOT use them if targeting 8086 real mode on an original PC/XT.

### Added in 80186

| Instruction | What it does | 8086 workaround |
|-------------|-------------|-----------------|
| `PUSHA` | Push AX, CX, DX, BX, SP, BP, SI, DI | Push each register individually |
| `POPA` | Pop DI, SI, BP, (skip SP), BX, DX, CX, AX | Pop each register individually |
| `PUSH imm` | Push immediate value | `MOV AX, imm` / `PUSH AX` |
| `IMUL reg, r/m, imm` | 3-operand multiply | Use `MUL` or manual shift/add |
| `SHL r/m, imm8` | Shift by immediate > 1 | `MOV CL, imm` / `SHL r/m, CL` |
| `SHR r/m, imm8` | Shift by immediate > 1 | `MOV CL, imm` / `SHR r/m, CL` |
| `SAR r/m, imm8` | Shift by immediate > 1 | Same as above |
| `ROL/ROR/RCL/RCR r/m, imm8` | Rotate by immediate > 1 | Same as above |
| `ENTER imm16, imm8` | Create stack frame | `PUSH BP` / `MOV BP, SP` / `SUB SP, imm` |
| `LEAVE` | Destroy stack frame | `MOV SP, BP` / `POP BP` |
| `BOUND reg, mem` | Check array bounds | Manual CMP/JB/JA |
| `INSB/INSW` | Input from port to string | `IN` + `STOSB` |
| `OUTSB/OUTSW` | Output string to port | `LODSB` + `OUT` |

### Added in 80286

| Instruction | Purpose |
|-------------|---------|
| Protected mode instructions | `LGDT`, `SGDT`, `LIDT`, `SIDT`, `LLDT`, `SLDT`, `LTR`, `STR`, `LMSW`, `SMSW`, `LAR`, `LSL`, `ARPL`, `VERR`, `VERW`, `CLTS` |

### Added in 80386

| Instruction | Purpose |
|-------------|---------|
| 32-bit operands | `EAX`, `EBX`, etc., `MOVZX`, `MOVSX` |
| New segments | `FS`, `GS` |
| Bit operations | `BT`, `BTS`, `BTR`, `BTC`, `BSF`, `BSR` |
| Set-on-condition | `SETcc` instructions |
| `SHLD`, `SHRD` | Double-precision shifts |
| `CWDE`, `CDQ` | 32-bit sign extension |
| `JECXZ` | Jump if ECX = 0 |

---

## Common TSR Patterns — Quick Reference

### Hooking an interrupt

```nasm
; Save old handler
mov ax, 3521h           ; DOS: Get interrupt vector 21h
int 21h                 ; Returns ES:BX = old handler
mov [old_int21_off], bx
mov [old_int21_seg], es

; Install new handler
mov ax, 2521h           ; DOS: Set interrupt vector 21h
lea dx, [new_int21]     ; DS:DX = new handler
int 21h
```

### Interrupt handler skeleton

```nasm
new_int21:
    pushf                   ; Save flags
    cmp ah, 09h             ; Is this our function?
    je .handle_it
    popf                    ; Restore flags
    jmp far [cs:old_int21]  ; Chain to old handler (CS override needed!)

.handle_it:
    popf
    ; ... do work ...
    ; Save/restore ALL registers you use
    push ax
    push bx
    push ds
    ; ... work ...
    pop ds
    pop bx
    pop ax
    iret                    ; Return from interrupt
```

### Terminate and Stay Resident

```nasm
; Calculate paragraphs to keep resident
; (end_of_resident - PSP) / 16, rounded up
mov dx, (end_of_resident - start + 15 + 100h) >> 4
mov ax, 3100h           ; DOS: TSR, return code 0
int 21h
```

### CS: override for data in code segment

In a TSR interrupt handler, DS may point anywhere (it belongs to the interrupted program). Access your own data with CS: prefix:

```nasm
mov al, [cs:my_data]    ; Read from code segment
mov [cs:my_data], al    ; Write to code segment
```

---

## Addressing Modes (8086)

Only these base+index combinations are valid:

```
[BX]          [BP]          [SI]          [DI]
[BX+SI]       [BP+SI]
[BX+DI]       [BP+DI]
[BX+disp]     [BP+disp]     [SI+disp]     [DI+disp]
[BX+SI+disp]  [BP+SI+disp]
[BX+DI+disp]  [BP+DI+disp]
[disp]        (direct address)
```

Default segments: DS for all except BP-based (which defaults to SS).

**There is no `[AX]`, `[CX]`, `[DX]`, `[SP]`, or any three-register combination.** These require 386+ with SIB byte addressing.
