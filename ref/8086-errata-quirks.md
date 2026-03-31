# 8086/8088 Errata, Silicon Bugs, and Programming Quirks

A practical reference for DOS TSR development. Focuses on things that can
actually bite you. Organized by category, most dangerous first.

---

## 1. MOV SS / POP SS Interrupt Inhibit

**The quirk:** After `MOV SS,xx` or `POP SS`, the CPU suppresses all maskable
interrupts (INTR), NMI, debug exceptions, and single-step traps until the
*next* instruction completes. This gives you an atomic two-instruction window
to set both SS and SP.

**Why it exists:** Without this, an interrupt arriving between `MOV SS,AX` and
`MOV SP,new_sp` would push the return address using the new SS but the old SP
-- corrupting random memory.

**The silicon bug (early 8086 only):** Chips marked "INTEL '78" did NOT have
this inhibit. Intel fixed it by patching the die itself (visible under a
microscope as anomalous gates in the Group Decode ROM). The fix delays
interrupt acknowledgment for one instruction after any segment register load
(not just SS). Later steppings and all 8088s have the fix.

**Practical rule:** Always pair them:

```asm
    CLI                 ; belt and suspenders for ancient CPUs
    MOV SS, AX
    MOV SP, new_sp      ; interrupts are inhibited for this one
    STI
```

The CLI/STI wrapper is technically redundant on fixed silicon, but costs
almost nothing and protects against pre-fix 8086 chips.

**TSR relevance: HIGH.** If your TSR switches stacks (and most do), get this
wrong and you get random memory corruption that only manifests under load.

Sources:

- [Ken Shirriff: A bug fix in the 8086, revealed in the die's silicon](https://www.righto.com/2022/11/a-bug-fix-in-8086-microprocessor.html)
- [Ken Shirriff: Reverse-engineering the interrupt circuitry in the 8086](http://www.righto.com/2023/02/8086-interrupt.html)

---

## 2. REP + Segment Override Prefix Bug

**The bug:** If a repeated string instruction uses both a REP prefix and a
segment override prefix (e.g., `REP MOVSB ES:` or `CS: REP MOVSW`), and an
interrupt fires mid-execution, the CPU restarts the instruction from IP-1 --
which only covers ONE prefix byte. The other prefix is silently dropped.

**Result:** After the interrupt returns, the string operation continues with
the wrong segment, copying from/to the wrong memory. Data corruption.

**This was never fixed on any 8086 or 8088.**

**Workaround options:**

1. **Best:** Do not use segment override prefixes with REP string
   instructions at all. Restructure your code to use DS:SI / ES:DI as
   intended.

2. **If you must:** Wrap in CLI/STI to prevent interrupts during the REP:

   ```asm
       CLI
       REP MOVSW           ; no segment override needed for DS:SI->ES:DI
       STI
   ```

3. **If you must use an override:** Some sources suggest ensuring the segment
   override is the *last* prefix byte (closest to the opcode). But this is
   fragile -- you cannot control assembler prefix ordering reliably.

**TSR relevance: HIGH.** TSRs that copy data between segments using REP MOVS
with overrides risk silent data corruption whenever a timer tick or keyboard
interrupt fires.

Sources:

- [VOGONS: REP + String instructions behavior](https://www.vogons.org/viewtopic.php?p=1118405)
- [Intel 386 Manual: Differences From 8086](https://pdos.csail.mit.edu/6.828/2008/readings/i386/s14_07.htm)

---

## 3. DIV / IDIV Overflow Exception (INT 0)

**What triggers it:** Dividing by zero OR when the quotient does not fit in
the destination register. Both trigger INT 0.

**Return address quirk (8086/8088 specific):** The CS:IP pushed on the stack
points to the instruction AFTER the DIV/IDIV. This means you CANNOT retry the
division from the exception handler -- the return address skipped past it.

On 80286+, the return address points to the faulting DIV itself, allowing
retry. This is a breaking behavioral change.

**Register state:** Registers are unmodified (they hold pre-DIV values).

**Practical consequences for TSRs:**

- If you install an INT 0 handler, you cannot portably determine the faulting
  instruction's address. On 8086 it is *before* the stacked IP, on 286+ it
  *is* the stacked IP.
- Validate divisors before dividing. Checking for zero is not enough -- check
  that the quotient will fit. For `DIV BL` (AX / BL -> AL), ensure AH < BL.

Sources:

- [Art of ASM: Divide Error Exception](https://www.plantation-productions.com/Webster/www.artofasm.com/DOS/ch17/CH17-2.html)
- [Intel 386 Manual: Differences From 8086](https://pdos.csail.mit.edu/6.828/2008/readings/i386/s14_07.htm)

---

## 4. PUSH SP Behavior

**The bug:** On 8086, 8088, and 80186, `PUSH SP` pushes the *decremented*
value of SP (the value SP has after being decremented by 2). On 80286+, it
pushes the *original* value of SP (before decrement).

```
8086:  PUSH SP  -->  [SS:SP] = SP - 2   (value AFTER decrement)
286+:  PUSH SP  -->  [SS:SP] = SP       (value BEFORE decrement)
```

**Detection use:** This difference is the classic way to distinguish 8086
from 286:

```asm
    MOV  AX, SP
    PUSH SP
    POP  BX
    CMP  AX, BX
    JNE  is_8086      ; AX != BX means PUSH SP pushed decremented value
    ; else 286 or later
```

**TSR relevance: LOW** unless you need CPU detection. Just avoid `PUSH SP` if
you need portable code.

Sources:

- [Robert Collins: CPUID Algorithm Wars](https://www.rcollins.org/ddj/Nov96/Nov96.html)
- [Intel 386 Manual: Differences From 8086](https://pdos.csail.mit.edu/6.828/2008/readings/i386/s14_07.htm)

---

## 5. Prefetch Queue and Self-Modifying Code

**Architecture:** The 8086 has a 6-byte prefetch queue. The 8088 has a 4-byte
queue. The CPU does NOT check whether prefetched bytes have been modified in
memory. It executes stale bytes from the queue.

**Practical impact:** If your code modifies an instruction that is within the
next 4-6 bytes, the old (unmodified) instruction executes. The modification
only takes effect once the queue is flushed (by a jump, call, or other
control transfer).

**Safe self-modifying code pattern:**

```asm
    MOV  BYTE [patch_target], new_opcode
    JMP  SHORT $+2          ; flush prefetch queue
patch_target:
    NOP                      ; this will now be new_opcode
```

**Queue size detection trick:**

```asm
; Write a different instruction N bytes ahead.
; If CPU has already prefetched past that point, old code runs.
; 8086 (6-byte queue) vs 8088 (4-byte queue) will behave differently.
```

**TSR relevance: MEDIUM.** Some TSRs use self-modifying code for patching
interrupt vectors or toggling behavior at runtime. Always flush the queue
with a JMP after modification.

Sources:

- [Wikipedia: Prefetch input queue](https://en.wikipedia.org/wiki/Prefetch_input_queue)
- [Ken Shirriff: Inside the 8086 processor's instruction prefetch circuitry](http://www.righto.com/2023/01/inside-8086-processors-instruction.html)

---

## 6. Interrupt Stack Frame and Flag State

**What gets pushed on INT (hardware or software):**

```
SP-2:  FLAGS   (full 16-bit flags register)
SP-4:  CS      (code segment of interrupted code)
SP-6:  IP      (instruction pointer of interrupted/next instruction)
```

SP is decremented by 6 total. IRET pops these in reverse order.

**Flag modifications during interrupt entry:**

- IF (Interrupt Flag) is CLEARED -- further maskable interrupts are blocked
- TF (Trap Flag) is CLEARED -- single-step trapping stops

The flags word pushed on the stack contains the ORIGINAL flag values (before
IF and TF are cleared), so IRET will restore them.

**Gotcha:** If your ISR needs interrupts re-enabled (e.g., a slow TSR handler
that must allow timer ticks), you must explicitly `STI` inside the handler.
But be careful -- re-entrant interrupts require a separate stack or careful
stack depth management.

**Flag bits 12-15 on 8086:** The 8086 stores bits 12-15 of FLAGS as all 1s.
On 286+, bit 15 is always 0 and bits 12-14 reflect IOPL/NT. This can be used
for CPU detection:

```asm
    PUSHF
    POP  AX
    AND  AX, 0FFFh
    PUSH AX
    POPF
    PUSHF
    POP  AX
    AND  AX, 0F000h
    CMP  AX, 0F000h
    JE   is_8086          ; bits 12-15 stuck high = 8086/8088
```

Sources:

- [Ken Shirriff: Reverse-engineering the interrupt circuitry in the 8086](http://www.righto.com/2023/02/8086-interrupt.html)

---

## 7. Flag Behavior Gotchas

### INC/DEC do NOT affect the Carry Flag

`INC` and `DEC` modify ZF, SF, OF, PF, and AF -- but NOT CF. This is by
design (inherited from the 8008) to allow loop counter updates without
disturbing carry-dependent multi-precision arithmetic.

**Gotcha:** `INC CX` / `JC somewhere` does NOT work to detect overflow. Use
`ADD CX, 1` if you need CF updated, or test with `JZ` (ZF is set when
incrementing from FFFFh to 0000h, indicating wraparound).

### MUL/IMUL: Most flags are UNDEFINED

After MUL/IMUL, only CF and OF are defined (set if the upper half of the
result is non-zero). SF, ZF, AF, and PF are **undefined** -- they may contain
arbitrary values and differ between CPU steppings.

**Never test ZF after MUL.** Use `TEST AX, AX` or `OR AX, AX` instead.

### DIV/IDIV: ALL flags are UNDEFINED

After DIV/IDIV, all arithmetic flags (CF, OF, SF, ZF, AF, PF) are undefined.

### Shift/Rotate counts on 8086 are not masked

On 8086/8088, shift and rotate instructions use the full CL value (0-255).
On 80286+, the count is masked to the low 5 bits (0-31). A `SHL AX, CL` with
CL=33 shifts by 33 on 8086, but by 1 on 286+.

**TSR relevance:** Moderate. The INC/DEC CF gotcha is extremely common in
beginner bugs. The shift masking difference matters for portable code.

Sources:

- [Ken Shirriff: Silicon reverse-engineering: the 8086 flag circuitry](http://www.righto.com/2023/02/silicon-reverse-engineering-intel-8086.html)
- [FLAGS register - Wikipedia](https://en.wikipedia.org/wiki/FLAGS_register)

---

## 8. REP Prefix with CX=0

**Behavior:** When CX is 0 at the start of a REP-prefixed string instruction,
the instruction executes **zero times** and falls through to the next
instruction. CX remains 0. No memory is accessed.

This is well-defined and consistent across all x86 CPUs. It is NOT a bug.

**Practical note:** This means you do not need to guard REP MOVSB/STOSB with
a `JCXZ` check. CX=0 is safe. However, `LOOP` is different -- `LOOP`
decrements CX first, so `LOOP` with CX=0 will loop 65535 times (wrapping
FFFFh). Always use `JCXZ` before `LOOP` if CX might be 0.

---

## 9. LOCK Prefix Behavior

**8086 behavior:** The LOCK prefix (F0h) asserts the LOCK# pin for the
duration of the next instruction, preventing other bus masters (DMA
controllers, other CPUs in multiprocessor systems) from accessing the bus.

**On 8086/8088:** LOCK can prefix ANY instruction. There are no restrictions.

**On 80286+:** LOCK is restricted to specific read-modify-write instructions
(XCHG, ADD, ADC, SUB, SBB, INC, DEC, AND, OR, XOR, NOT, NEG, BTS, BTR, BTC)
with a memory destination. Using LOCK with other instructions causes an
Undefined Opcode exception (#UD / INT 6).

**TSR relevance: LOW** for single-processor PC/XT/AT systems. Relevant if
your TSR might run in multi-processor or DMA-heavy environments, or if you
need to atomically update a flag byte shared between main code and an ISR:

```asm
    LOCK OR BYTE [tsr_active], 1   ; atomic set
```

Sources:

- [LOCK - Assert LOCK# Signal Prefix](https://www.felixcloutier.com/x86/lock)

---

## 10. Segment Wrapping (Offset Wraparound)

**8086/8088 behavior:** When a memory access crosses offset FFFFh within a
segment, the address wraps to 0000h within the same segment. For example,
reading a word from offset FFFFh reads bytes at FFFFh and 0000h (not 10000h).

**On 80286+ in real mode:** This may raise an exception instead of wrapping
(exception 13 for data, exception 12 for stack).

**The A20 gate:** Similarly, on 8086/8088, physical addresses above FFFFFh
(1MB) wrap to 00000h. The 286+ does not wrap by default, which is why the A20
gate exists -- to force wrapping for compatibility with 8086 programs that
rely on it (notably, parts of DOS and some BIOS code).

**TSR relevance: LOW** unless doing tricks at segment boundaries.

---

## 11. Stack Pointer Wrapping

**8086/8088 behavior:** SP is a 16-bit register within the SS segment. If SP
is 0000h and you PUSH, SP wraps to FFFEh. If SP is FFFEh and you POP, SP
wraps to 0000h. There is no stack overflow/underflow exception.

The CPU does NOT check for stack exhaustion. It silently wraps and
overwrites whatever memory is at the top/bottom of the 64KB stack segment.

**TSR relevance: MEDIUM.** TSR private stacks are typically small (128-512
bytes). Deep call chains or recursive ISRs can overflow the stack silently.
Consider putting a canary value at the bottom of your stack and checking it
periodically.

---

## 12. Undocumented Instructions

### POP CS (Opcode 0Fh)

On 8086/8088, opcode 0Fh performs `POP CS`. It pops a value from the stack
into CS and continues execution at the current IP in the new code segment.
The prefetch queue is NOT flushed, which causes erratic behavior.

On 80186+, opcode 0Fh is the two-byte opcode escape prefix (used for 286+
instructions). Executing `POP CS` on a 186+ triggers an illegal opcode
exception.

**Never use this.** It was famously used by the Ping Pong boot sector virus,
but it is not reliable or portable.

### SALC (Opcode D6h)

Sets AL to FFh if CF=1, or 00h if CF=0. Equivalent to `SBB AL, AL` but does
not modify flags. Present on all x86 CPUs (Intel did not document it until
2017). Possibly a deliberate copyright trap.

**Safe to use** on 8086-class hardware, but undocumented status means some
emulators may not implement it.

### AAM imm8 / AAD imm8

Documented forms are `AAM` (D4 0A) and `AAD` (D5 0A) with an implicit base
of 10. The second byte is actually an operand -- any value 00-FF works:

- `AAM N`: divides AL by N, quotient in AH, remainder in AL
- `AAD N`: computes AL + (AH * N), stores in AL, zeros AH

`AAM 0` triggers a divide-by-zero exception (INT 0).

These are useful for arbitrary base conversions and cheap 8-bit division.

### Duplicate Opcodes

Several opcode slots are undocumented aliases:

- 60-6Fh: aliases for 70-7Fh (conditional jumps)
- C0/C1h: aliases for C2/C3h (RET)
- C8/C9h: aliases for CA/CBh (RETF)
- F1h: alias for F0h (LOCK)

Sources:

- [Ken Shirriff: Undocumented 8086 instructions, explained by the microcode](http://www.righto.com/2023/07/undocumented-8086-instructions.html)
- [OS/2 Museum: Undocumented 8086 Opcodes](https://www.os2museum.com/wp/undocumented-8086-opcodes-part-i/)

---

## 13. 8086 vs 8088 Differences

| Feature | 8086 | 8088 |
|---|---|---|
| Data bus width | 16-bit | 8-bit |
| Prefetch queue | 6 bytes | 4 bytes |
| Bus cycle | 2 bytes per 4 clocks | 1 byte per 4 clocks |
| Queue fetch unit | 16-bit (word) | 8-bit (byte) |
| Pin count difference | AD0-AD15 multiplexed | AD0-AD7 multiplexed |

**Practical impact for emulators:**

- Self-modifying code behaves differently due to queue size difference
- Instruction timing differs significantly (8088 is bottlenecked by its
  8-bit bus; fast instruction sequences drain the queue more quickly)
- The queue size difference is the ONLY reliable way to distinguish 8086
  from 8088 in software (via self-modifying code that lands inside the
  queue of one but not the other)

**For TSR development:** Generally irrelevant -- the instructions behave
identically. Only matters for cycle-exact timing or self-modifying code
tricks.

---

## 14. INTO (Interrupt on Overflow)

`INTO` (opcode CEh) checks OF. If OF=0, it is a NOP (no pipeline flush). If
OF=1, it triggers INT 4. The return address pushed on the stack points to the
instruction AFTER `INTO`.

Useful for checking signed arithmetic overflow cheaply. Rarely used in
practice because most programs don't install an INT 4 handler.

---

## 15. IDIV Edge Case: Most Negative Quotient

On 8086/8088, `IDIV` cannot produce the most negative number as a quotient
(e.g., -128 for byte IDIV, -32768 for word IDIV). Attempting to do so
triggers INT 0 (divide error).

On 80386+, this case is handled correctly and produces the expected negative
quotient.

---

## Quick Reference: What to Watch For in TSR Code

| Risk | Severity | Rule |
|---|---|---|
| Stack switching | CRITICAL | Always CLI; MOV SS; MOV SP; STI |
| REP + segment override | CRITICAL | Never combine them, or wrap in CLI/STI |
| DIV without validation | HIGH | Always check divisor AND quotient range |
| INC/DEC + JC | HIGH | INC/DEC do not touch CF; use ADD/SUB 1 |
| Flags after MUL/DIV | MEDIUM | All flags except CF/OF are undefined after MUL; ALL flags undefined after DIV |
| Self-modifying code | MEDIUM | JMP SHORT $+2 to flush prefetch queue |
| PUSH SP portability | LOW | Avoid if targeting both 8086 and 286+ |
| Stack overflow | MEDIUM | No hardware detection; use canary values |
| POP CS (0Fh) | LOW | Never use; not portable past 8086 |
| Shift count masking | LOW | CL used directly on 8086; masked to 5 bits on 286+ |
