# Undocumented 8086/8088 Instructions

Reference extracted from Ken Shirriff's blog post:
<https://www.righto.com/2023/07/undocumented-8086-instructions.html>

These instructions exist due to the 8086's lack of transistor budget for undefined-instruction traps. When opcode bit patterns partially matched the Group Decode ROM, the decoder routed execution through whatever microcode matched, creating unintended aliases and behaviors.

---

## Compatibility Key

| Symbol | Meaning |
|--------|---------|
| 8086 | Works on 8086/8088 |
| 186+ | Trapped (#UD) starting with 80186 |
| 286+ | Trapped (#UD) starting with 80286 |
| ALL | Works on all x86 processors including modern |

---

## Single-Byte Opcodes

### `0F` -- POP CS

| | |
|---|---|
| **Does** | Pops a value from the stack into the CS register |
| **Compat** | 8086 only. Trapped on 186+. |
| **Useful?** | No. Changes CS without updating IP and without flushing the prefetch queue, so execution jumps to unpredictable locations. |

The "Ping Pong" boot sector virus exploited this for high-memory relocation, relying on the fact that identical code at different CS:IP combinations still executes the same bytes. On 186+ this opcode became the two-byte opcode escape prefix.

---

### `60`-`6F` -- Conditional Jump Aliases

| | |
|---|---|
| **Does** | Each opcode mirrors its `70`-`7F` counterpart (e.g. `60` = JO, `61` = JNO, ..., `6F` = JG) |
| **Compat** | 8086 only. Trapped on 186+. |
| **Useful?** | No. Exact duplicates of documented instructions. |

The Group Decode ROM pattern `011?????` matches both `6x` and `7x` ranges.

---

### `C0` -- RET imm16 (alias of `C2`)

| | |
|---|---|
| **Does** | Near return, then adds immediate word to SP. Identical to `C2`. |
| **Compat** | 8086 only. Trapped on 186+ (repurposed for shift-by-immediate). |
| **Useful?** | No. Use `C2` instead. |

---

### `C1` -- RET (alias of `C3`)

| | |
|---|---|
| **Does** | Near return. Identical to `C3`. |
| **Compat** | 8086 only. Trapped on 186+ (repurposed for shift-by-immediate). |
| **Useful?** | No. Use `C3` instead. |

---

### `C8` -- RETF imm16 (alias of `CA`)

| | |
|---|---|
| **Does** | Far return, then adds immediate word to SP. Identical to `CA`. |
| **Compat** | 8086 only. Trapped on 186+ (repurposed for ENTER). |
| **Useful?** | No. Use `CA` instead. |

---

### `C9` -- RETF (alias of `CB`)

| | |
|---|---|
| **Does** | Far return. Identical to `CB`. |
| **Compat** | 8086 only. Trapped on 186+ (repurposed for LEAVE). |
| **Useful?** | No. Use `CB` instead. |

---

### `D6` -- SALC (Set AL from Carry)

| | |
|---|---|
| **Does** | Sets AL to `0xFF` if CF=1, or `0x00` if CF=0. Sign-extends the carry flag into AL. |
| **Compat** | **ALL x86 processors.** Intel finally documented it in 2017. |
| **Useful?** | **Yes.** Genuinely useful for converting a carry condition into a byte mask. Single byte, no flags affected. |

Intel likely included this as a **copyright trap** -- if a competitor's chip executed SALC, it proved they copied Intel's microcode. This was relevant during the NEC v. Intel lawsuit (1984-1989). NEC's V20/V30 did NOT implement SALC, helping prove independent microcode development.

---

### `F1` -- LOCK prefix (alias of `F0`)

| | |
|---|---|
| **Does** | Acts as a LOCK prefix, identical to `F0`. |
| **Compat** | Works on 8086 and later (not trapped). On 286+ it raises INT 1 (ICEBP/single-step trap). |
| **Useful?** | No. Use `F0` instead. |

---

## Two-Byte (ModR/M) Opcodes

### `D0/6`, `D1/6`, `D2/6`, `D3/6` -- SETMO (Set Minus One)

| | |
|---|---|
| **Does** | Returns `0xFF` (byte) or `0xFFFF` (word). Occupies the `/6` slot in the shift/rotate group. |
| **Compat** | 8086 only. Behavior varies on clones and later CPUs. |
| **Useful?** | No. A curiosity -- there are simpler ways to load all-ones. |

The ALU's SETMO operation activates when the reg field is `110`, a bit pattern that doesn't correspond to any documented shift.

---

### `D0/7`, `D1/7`, `D2/7`, `D3/7` -- SETMOC (Set Minus One with Carry)

Mentioned alongside SETMO as the `/7` slot. Similar behavior but also sets the carry flag.

---

### `F6/1`, `F7/1` -- TEST rm, imm (alias of `F6/0`, `F7/0`)

| | |
|---|---|
| **Does** | TEST with immediate operand. Identical to the `/0` encoding. |
| **Compat** | 8086. Later CPUs may also support this alias. |
| **Useful?** | No. Use the documented `/0` encoding. |

---

### `FE/2` through `FE/6` -- Byte-Width CALL/JMP/PUSH

These are the `FF` group instructions (CALL, CALL FAR, JMP, JMP FAR, PUSH) executed through the `FE` opcode, which forces byte-width operations on what should be word-width data.

| Opcode | Equivalent | Problem |
|--------|-----------|---------|
| `FE/2` | CALL rm | Reads destination as byte, writes return address as byte |
| `FE/3` | CALL FAR rm | Reads CS:IP as bytes, pushes return as bytes |
| `FE/4` | JMP rm | Reads jump target as byte |
| `FE/5` | JMP FAR rm | Reads CS:IP as bytes |
| `FE/6` | PUSH rm | Pushes byte but decrements SP by 2, corrupting stack |

**Compat:** 8086 only. All produce corrupted/unusable results.
**Useful?** No. They all corrupt addresses or stack state. Crash-inducing.

---

### `82` -- Immediate Group (alias of `80`)

| | |
|---|---|
| **Does** | 8-bit arithmetic/logic with 8-bit immediate, identical to `80`. |
| **Compat** | Inconsistently documented by Intel across manual revisions. Modern CPUs support it. |
| **Useful?** | No. Redundant with `80`. |

---

### `8C` and `8E` with reg fields 4-7 -- Segment Register Aliases

| | |
|---|---|
| **Does** | The hardware ignores bit 5 of the reg field, so seg registers 4-7 alias to 0-3 (ES/CS/SS/DS). |
| **Compat** | 8086 only. Later CPUs with FS/GS use these fields for real segment registers. |
| **Useful?** | No. |

---

## Variable-Immediate Opcodes

### `D4 xx` -- AAM with arbitrary base (documented as `D4 0A`)

| | |
|---|---|
| **Does** | Divides AL by `xx`, quotient in AH, remainder in AL. Standard AAM uses `0A` (divide by 10 for BCD). |
| **Compat** | ALL x86 processors. |
| **Useful?** | **Yes.** General-purpose byte division into quotient/remainder. `D4 00` causes a divide-by-zero exception. |

The divisor comes from the instruction stream because the 8086 microcode has no mechanism to generate arbitrary constants internally.

---

### `D5 xx` -- AAD with arbitrary base (documented as `D5 0A`)

| | |
|---|---|
| **Does** | Computes `AH * xx + AL`, stores result in AL, clears AH. Standard AAD uses `0A` (multiply by 10 for BCD). |
| **Compat** | ALL x86 processors. |
| **Useful?** | **Yes.** General-purpose `AH*base+AL` computation in two bytes. Useful for base conversion. |

---

## Hidden Internal Register Exposure

These instructions expose internal 8086 registers (IND, OPR, tmpB) that are normally invisible to the programmer. They occur when ModR/M specifies a register operand where the instruction expects memory.

### LEA with register source

| | |
|---|---|
| **Does** | Returns the contents of the IND (Indirect) register -- the address computed by the previous memory operation. |
| **Compat** | 8086 only. Later CPUs define LEA with register source differently. |
| **Useful?** | Curiosity / CPU detection only. |

### LDS / LES with register source

| | |
|---|---|
| **Does** | Reads the OPR (Operand) internal register into the destination. Segment register gets garbage from memory at IND+2. |
| **Compat** | 8086 only. |
| **Useful?** | No. Corrupts segment registers. |

### JMP FAR with register source (via `FF /5`)

| | |
|---|---|
| **Does** | Uses tmpB (ALU temporary) as new IP, reads new CS from address IND+2. |
| **Compat** | 8086 only. |
| **Useful?** | No. Highly unreliable. |

---

## Prefix Side Effects

### REP + IMUL / IDIV

| | |
|---|---|
| **Does** | REP sets internal flag F1, which multiply/divide microcode reuses for sign tracking. Result: the product or quotient is negated. |
| **Compat** | 8086. Behavior on later CPUs uncertain. |
| **Useful?** | No. Accidentally negates results. |

### REP + RET

| | |
|---|---|
| **Does** | Nothing extra. RET ignores the F1 flag that REP sets. |
| **Compat** | ALL. AMD later recommended `REP RET` to work around a branch prediction issue. |
| **Useful?** | Harmless no-op prefix. |

### REPNZ + MOVS / STOS

| | |
|---|---|
| **Does** | REPNZ and REPZ behave identically for MOVS/STOS because these instructions never check the zero-flag condition. Only CMPS/SCAS distinguish REP from REPNZ. |
| **Compat** | ALL. |
| **Useful?** | No. REPNZ is meaningless here; use REP. |

---

## Summary: What's Actually Useful

| Instruction | Opcode | Why |
|-------------|--------|-----|
| **SALC** | `D6` | One-byte carry-to-byte conversion. Works everywhere. |
| **AAM base** | `D4 xx` | Cheap byte divmod by any constant. Works everywhere. |
| **AAD base** | `D5 xx` | Cheap `AH*base+AL`. Works everywhere. |

Everything else is either a redundant alias (trapped on 186+), produces corrupted results, or exposes internal state that's only interesting for CPU identification.

---

## Emulator Support

Shirriff's analysis was done via transistor-level simulation of the 8086, not physical hardware. Emulator support for these instructions varies:

- **86Box** (the emulator this project uses): likely supports the commonly-known ones (SALC, AAM/AAD with arbitrary base) but may not emulate the more obscure internal-register-exposure behaviors.
- **DOSBox:** Supports SALC and AAM/AAD variants. Unlikely to emulate FE-group byte-width corruptions or internal register leaks.
- **PCem:** Similar to 86Box in coverage.
- **Hardware-accurate simulators** (e.g., Perfect6502-style): would reproduce all behaviors by definition.

For TSR development targeting 8086 compatibility, only SALC, AAM, and AAD with non-10 bases are worth considering. The rest are unreliable, non-portable, or both.
