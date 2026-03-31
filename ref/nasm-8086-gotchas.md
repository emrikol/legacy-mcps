# NASM Gotchas and Best Practices for 8086 DOS .COM Files

Reference compiled 2026-03-12 from NASM documentation, forums, and community sources.

---

## 1. CPU 8086 Directive

**Yes, it exists and works.** Place `CPU 8086` at the top of your source file.

```nasm
CPU 8086
org 100h
```

- NASM will **error** on any instruction not available on the original 8086.
- By default (no CPU directive), **all instructions from all CPU generations are accepted**. This means NASM will silently assemble 186/286/386+ instructions into your .COM file if you forget the directive.
- The directive is **case-insensitive** (`cpu 8086` works too).
- Available levels: `8086`, `186`, `286`, `386`, `486`, `586`/`PENTIUM`, `686`/`PPRO`/`P2`, `P3`/`KATMAI`, `P4`/`WILLAMETTE`, `PRESCOTT`, `X64`, `IA64`.

**Recommendation:** Always use `CPU 8086` when targeting real 8086/8088 hardware. It is the single most important safety net.

Sources:

- [NASM Directives - CPU](https://www.nasm.us/xdoc/2.14rc2/html/nasmdoc6.html)
- [Yasm CPU Directive Reference](https://www.tortall.net/projects/yasm/manual/html/nasm-directive-cpu.html)

---

## 2. Instructions That Look 8086 But Are Not

The following are **80186+ instructions** that NASM will happily assemble unless `CPU 8086` is set:

| Instruction | Introduced | Notes |
|---|---|---|
| `push imm8` / `push imm16` | 80186 | **Very common mistake.** Use `mov ax, imm` then `push ax` on 8086. |
| `imul reg, r/m, imm` | 80186 | Three-operand multiply. |
| `shl reg, imm8` (imm != 1) | 80186 | On 8086, only `shl reg, 1` and `shl reg, cl` exist. |
| `shr reg, imm8` (imm != 1) | 80186 | Same restriction as SHL. |
| `enter` / `leave` | 80186 | Stack frame setup/teardown. |
| `pusha` / `popa` | 80186 | Push/pop all general registers. |
| `bound` | 80186 | Array bounds check. |
| `ins` / `outs` | 80186 | String I/O (port I/O with REP). |
| `push cs/ds/es/ss` | 8086 OK | These are fine on 8086. |
| `pop cs` | 8086 only | Opcode `0Fh` became a prefix on 80186+. NASM warns via `obsolete-removed`. |

**The #1 trap:** `push 5` compiles to a valid 80186 opcode. On a real 8086 it will be interpreted as a completely different instruction. With `CPU 8086`, NASM rejects it at assembly time.

Sources:

- [80186 Instruction Set](https://www.eeeguide.com/instruction-set-of-80186/)
- [Intel 80186 - Wikipedia](https://en.wikipedia.org/wiki/Intel_80186)
- [NASM Appendix A - Instruction Reference](https://www.nasm.us/doc/nasmaa.html)

---

## 3. ORG 100h and .COM File Layout

```nasm
CPU 8086
org 100h

section .text
    ; code starts here, this is the entry point
    ; ...

section .data
    msg db 'Hello$'

section .bss
    buf resb 128
```

### How ORG works

- `org 100h` tells NASM that the code will be loaded at offset 100h in the segment. It does **not** emit 256 bytes of padding -- it just adjusts label addresses.
- The first 100h bytes at load time are the **PSP** (Program Segment Prefix), placed there by DOS. Your file starts at offset 100h.
- `org` can only appear **once** per source file in `-f bin` mode.
- `org` does **not** generate a jump or entry point. Execution begins at the very first byte of the file. If your `.data` section comes first in the file, you will execute your data as code.

### Gotchas

- **Entry point is byte 0 of the output file.** If you declare data before code, NASM (in bin format) may place data first. Always ensure `.text` comes first, or use `section .text start=0` explicitly.
- **All segments are the same.** In a .COM file, CS=DS=ES=SS. NASM's `-f bin` does not emit relocation info. All label offsets are relative to the ORG value.
- **ORG does not mean "skip to".** Unlike MASM, NASM's `org` is purely a base-address declaration. You cannot use multiple ORG directives to jump around.

Sources:

- [NASM bin Format - ORG](https://www.nasm.us/doc/nasm09.html)
- [NASM Chapter 7 - bin Output](https://userpages.cs.umbc.edu/chang/cs313.f04/nasmdoc/html/nasmdoc7.html)
- [Yasm bin Format Reference](https://www.tortall.net/projects/yasm/manual/html/objfmt-bin.html)

---

## 4. The -f bin Output Format

```bash
nasm -f bin -o myprog.com myprog.asm
```

### Key characteristics

- **Pure binary output.** No headers, no metadata, no relocations. Just raw machine code bytes.
- **Starts in 16-bit mode.** No need for `BITS 16` (though adding it doesn't hurt for clarity).
- **No default extension.** NASM strips the `.asm` extension but does not add `.com`. Always use `-o` to name the output.
- **Built-in linker.** The bin format acts as its own linker -- sections are resolved and laid out in the output file directly.

### Section ordering

In `-f bin`, sections are emitted in the following default order:

1. `.text` (progbits, code)
2. `.data` (progbits, initialized data)
3. `.bss` (nobits, uninitialized)

You can override this with `start=`, `follows=`, `vfollows=`, and `align=` attributes on section declarations.

Sources:

- [NASM Chapter 8 - bin Format](https://www.nasm.us/doc/nasm09.html)

---

## 5. Section .bss in bin Format

**BSS does NOT pad the binary.** This is correct and by design.

- `.bss` is flagged as `nobits` by default. Labels in `.bss` resolve to addresses just past the end of the last progbits section in the file.
- The output file contains **no bytes** for BSS-declared storage.
- At runtime, the memory beyond the file is whatever was there before -- **it is NOT zeroed by DOS.**

### Gotchas

- **Do not assume BSS is zero.** Unlike modern OSes, DOS does not zero memory before loading a .COM file. If you need zeroed buffers, initialize them explicitly at startup:

  ```nasm
  ; Zero out BSS area at startup
  mov di, bss_start
  mov cx, bss_end - bss_start
  xor al, al
  rep stosb
  ```

- **RESB in .text or .data sections WILL emit zero bytes** into the binary (it acts like `times N db 0`). Only in a `nobits` section does RESB avoid emitting data.
- **Ordering matters.** If you accidentally put `.bss` between `.text` and `.data`, NASM may pad the binary to maintain address continuity. Always put `.bss` last.

Sources:

- [NASM bin Format - Sections](https://www.nasm.us/doc/nasm09.html)
- [CatWolf - RESB in bin format](https://catwolf.org/qs?id=f3e65452-f778-4ce6-aad4-148f8b6c0d7e&x=y)

---

## 6. .COM File Maximum Size

- **Hard limit: 65,280 bytes (FF00h)**, which is 64 KiB minus 256 bytes.
- The 256-byte gap is the PSP (Program Segment Prefix) at offset 0000h-00FFh.
- **Practical limit is smaller** because you also need stack space. DOS sets SP to FFFEh (top of the 64K segment) and the stack grows downward. A .COM file that fills all 65,280 bytes leaves zero stack space.
- **Rule of thumb:** Keep .COM files well under 60 KiB to leave room for the stack (at least 256 bytes, more if you use recursion or deep call chains).
- Code + initialized data + BSS + stack must all fit within a single 64 KiB segment.

### Memory layout at load time

```
0000h +-----------+
      | PSP       | 256 bytes (set up by DOS)
0100h +-----------+
      | .COM file | Your code + data (loaded from disk)
      | contents  |
      +-----------+
      | BSS area  | Uninitialized (beyond end of file)
      +-----------+
      |           |
      | free      |
      |           |
      +-----------+
      | stack     | Grows downward from SP (starts near FFFEh)
FFFEh +-----------+
```

Sources:

- [COM file - Wikipedia](https://en.wikipedia.org/wiki/COM_file)
- [DOS .COM file review](https://www.joenord.com/dos-com-file-review/)

---

## 7. Segment Register Gotchas

### In a .COM file, all segment registers are equal

DOS loads a .COM file with `CS = DS = ES = SS = <PSP segment>`. You must maintain this invariant for most DOS calls.

### NASM segment overrides

- Syntax: `[es:di]`, not `es:[di]` (the latter is MASM syntax and wrong in NASM).
- BP-based memory references (`[bp]`, `[bp+si]`, etc.) default to SS, not DS. This is CPU behavior, not a NASM issue. In a .COM file SS=DS so it doesn't matter, but be aware if you ever change SS.
- String instructions `lodsb`/`lodsw` use DS:SI; `stosb`/`stosw` and `scasb`/`scasw` use ES:DI. The ES:DI default **cannot be overridden** -- this is hardwired in the CPU.
- `cmpsb`/`cmpsw` use DS:SI and ES:DI. The DS:SI source can be overridden (`[es:si]` etc.) but ES:DI cannot.

### NASM does not add implicit segment override prefixes

NASM only emits a segment override prefix byte when you explicitly write one (e.g., `[es:bx]`). It will not silently add overrides. This is the correct behavior but can surprise people coming from other assemblers that have "ASSUME"-like directives.

Sources:

- [NASM Segment Overrides Discussion](https://comp.lang.asm.x86.narkive.com/29N3ivZe/using-nasm-and-segment-overrides)
- [NASM Appendix A](https://www.nasm.us/doc/nasmaa.html)

---

## 8. Additional Gotchas and Tips

### NASM vs MASM differences that bite

| Topic | NASM | MASM |
|---|---|---|
| Memory references | `[bx]` required (brackets mandatory) | `bx` can mean `[bx]` in context |
| Segment overrides | `[es:bx]` | `es:[bx]` |
| ORG behavior | Sets base address once | Can reposition output pointer |
| OFFSET keyword | Not used; labels are already offsets | `offset label` needed |
| Size specifiers | `byte`, `word`, `dword` (no PTR) | `byte ptr`, `word ptr` |

### Useful NASM flags for .COM development

```bash
# Assemble with warnings enabled
nasm -f bin -Wall -o prog.com prog.asm

# Generate a listing file (invaluable for debugging)
nasm -f bin -l prog.lst -o prog.com prog.asm

# Generate a map file showing section layout
# (add to source: [map all prog.map])
```

### The listing file trick

Always generate a `.lst` listing file during development. It shows:

- The exact bytes NASM emits for each instruction
- The resolved addresses of all labels
- Any macro expansions

This is the fastest way to verify that NASM is emitting 8086-compatible opcodes and that your addresses are correct.

### Template for a minimal 8086 .COM file

```nasm
CPU 8086
org 100h

section .text
start:
    ; --- your code here ---

    ; exit to DOS
    mov ah, 4Ch
    int 21h

section .data
    ; initialized data here

section .bss
    ; uninitialized data here (does not increase file size)
```

Sources:

- [NASM Manual - Chapter 2](https://nasm.us/xdoc/2.15rc5/html/nasmdoc2.html)
- [NASM Forum - 8086 Support](https://forum.nasm.us/index.php?topic=425.0)
- [NASM Forum - Sections Discussion](https://forum.nasm.us/index.php?topic=3879.0)
