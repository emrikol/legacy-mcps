# Undocumented 8086 Opcodes -- OS/2 Museum Reference

Source: <https://www.os2museum.com/wp/undocumented-8086-opcodes-part-i/>
Author: Raul Gutierrez Sanz (guest post on OS/2 Museum blog)
Parts II and III do not exist (404 as of 2026-03-12); the series appears to be a single post subtitled "Part I: Holes In the Opcode Map."

---

## Motivation and Scope

The goal is to enable modern 8086 implementations (emulators, FPGA cores,
hypervisors) to achieve greater compatibility by documenting behaviors that
were never officially published in full detail.

Applies to: **8086 and 8088 only.**
Does NOT apply to 80186/80286 or later (those CPUs repurpose many of these
opcode slots for new instructions and raise #UD for truly undefined ones).
Does NOT apply to NEC V20/V30 (different internal decode logic).
Behavior is assumed consistent across Intel and second-source vendors
(AMD, Harris, Siemens).

Design principle: the 8086 has no concept of an invalid opcode. Every byte
decodes to *something*. Undocumented opcodes receive a default decode path
that sometimes produces useful aliases, sometimes not.

---

## Testing Methodology

- Real hardware: **Amstrad 5086** with a Siemens-manufactured 8086 CPU.
- Hundreds of test conditions per instruction using debuggers and assemblers
  running directly on the target machine.
- Challenge: undocumented internal registers are invisible to debuggers, so
  side effects must be inferred from observable register, flag, and memory
  changes.

---

## Undocumented Opcodes

### 0Fh -- POP CS

Pops the top of stack into CS. Obvious from the pattern of segment POP
instructions (07h=POP ES, 17h=POP SS, 1Fh=POP DS) but essentially useless
because the next instruction fetch uses the new CS:IP, making controlled
use nearly impossible. Mentioned in some third-party references.

Removed on 80286+ (0Fh becomes the two-byte opcode escape prefix).

---

### 60h-6Fh -- Conditional Jump Aliases

Duplicate the 70h-7Fh conditional jumps:

| Undocumented | Equivalent | Mnemonic |
|---|---|---|
| 60h | 70h | JO |
| 61h | 71h | JNO |
| 62h | 72h | JB / JC |
| 63h | 73h | JNB / JNC |
| 64h | 74h | JZ / JE |
| 65h | 75h | JNZ / JNE |
| 66h | 76h | JBE |
| 67h | 77h | JNBE / JA |
| 68h | 78h | JS |
| 69h | 79h | JNS |
| 6Ah | 7Ah | JP / JPE |
| 6Bh | 7Bh | JNP / JPO |
| 6Ch | 7Ch | JL |
| 6Dh | 7Dh | JNL / JGE |
| 6Eh | 7Eh | JLE |
| 6Fh | 7Fh | JNLE / JG |

The CPU ignores bit 4 during conditional-jump decoding, so 6xh and 7xh
produce identical results.

Removed on 80186+ (60h-6Fh are reassigned to PUSHA, POPA, BOUND, ARPL,
segment override prefixes, PUSH imm, IMUL imm, INS, OUTS).

---

### C0h -- RET imm16 (alias)

Equivalent to C2h (near return, add imm16 to SP after popping IP).

---

### C1h -- RET (alias)

Equivalent to C3h (near return).

---

### C8h -- RETF imm16 (alias)

Equivalent to CAh (far return, add imm16 to SP after popping IP and CS).

---

### C9h -- RETF (alias)

Equivalent to CBh (far return).

On 80186+ these four slots are reassigned to ENTER and LEAVE.

---

### D0/D1 with reg field 110b -- SETMO

Opcode bytes D0h (byte operand) or D1h (word operand), with the ModR/M
reg field = 110b (the same slot that later became SAL/SHL's alias).

**Operation:** Sets the destination operand to FFh (byte) or FFFFh (word).
The result is independent of the operand's prior value and independent of
any flags.

**Flags after execution:**

| Flag | Value |
|---|---|
| CF | 0 (NC) |
| PF | 1 (PE) |
| AF | 0 (NA) |
| ZF | 0 (NZ) |
| SF | 1 (NG) |
| OF | 0 (NV) |

Effectively equivalent to `OR dest, 0FFh` (or `OR dest, 0FFFFh` for word)
in terms of result and flags, but encoded as a single-operand shift-class
instruction.

Not the same as SALC (D6h): SETMO writes to any r/m operand, always
produces FFh/FFFFh regardless of CF, and modifies flags.

---

### D2/D3 with reg field 110b -- SETMOC

Opcode bytes D2h (byte operand) or D3h (word operand), with ModR/M
reg field = 110b. This is the CL-count variant of the shift group.

**Operation:** If CL != 0, behaves like SETMO (sets destination to
FFh/FFFFh and sets flags identically). If CL = 0, no operation.

**Timing:** With CL=255 the instruction takes approximately 1031 cycles
(about 216 microseconds on an 8088 at 4.77 MHz). This creates significant
interrupt latency, though DRAM refresh (which uses DMA, not CPU interrupts)
is unaffected.

---

### D6h -- SALC (Set AL from Carry)

**Operation:** If CF=1, sets AL to FFh. If CF=0, sets AL to 00h.

**Flags:** None modified.

**Destination:** Always AL (not configurable via ModR/M).

This is the best-known undocumented 8086 opcode. It exists on all x86 CPUs
through at least modern Intel processors. Intel finally documented it
officially in the October 2017 edition of the Software Developer's Manual.

Useful as a branchless way to convert CF into a mask byte.

---

### F1h -- LOCK prefix (alias)

Equivalent to F0h (LOCK prefix). Technically a prefix, not a standalone
instruction.

On 80286+ F1h is repurposed (INT1 / ICEBP on some CPUs, or #UD on others).

---

## Compatibility Summary

| Opcode(s) | 8086/8088 | 80186 | 80286+ | Notes |
|---|---|---|---|---|
| 0Fh POP CS | Yes | No | No | Becomes 2-byte escape |
| 60-6Fh Jcc aliases | Yes | No | No | Reassigned to new instructions |
| C0/C1/C8/C9 RET aliases | Yes | No | No | Become ENTER/LEAVE |
| D0-D3 /6 SETMO/SETMOC | Yes | ? | No | Slot used by documented SAL |
| D6h SALC | Yes | Yes | Yes* | All x86 CPUs; documented 2017 |
| F1h LOCK alias | Yes | Varies | Varies | Becomes INT1/ICEBP or #UD |

\* SALC is not available in 64-bit long mode.

---

## References (from original article)

- Intel, *MCS-86 Assembly Language Reference Guide*, October 1978 (9800749-1)
- Intel, *8086 16-BIT HMOS MICROPROCESSOR* data sheet (231455-005)
- Shanley & Anderson, *ISA System Architecture*, MindShare Inc.
