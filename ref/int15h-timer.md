# BIOS Timer & Delay Interrupts Reference

Reference for delay/timing on IBM PC compatibles, with focus on 8086/XT compatibility.

---

## INT 15h AH=86h -- Elapsed Time Wait

**Compatibility: AT and PS/2 only. Does NOT work on 8086/XT.**

On PC/PCjr, returns AH=80h with CF set. On XT, returns AH=86h with CF set.
This function is not available on the machine class we care about (8086/XT).

| Register | Direction | Value |
|----------|-----------|-------|
| AH       | in        | 86h   |
| CX       | in        | High word of microsecond delay |
| DX       | in        | Low word of microsecond delay  |
| CF       | out       | Clear = success, Set = error or wait already in progress |

- Resolution is 976 microseconds (not single-microsecond precision)
- Documented as "not designed for user application usage"
- Blocks the caller for the specified duration

**Verdict: Cannot use this for 8086/XT targets. Use alternatives below.**

---

## Alternatives for Delay/Wait on 8086/XT

### Option 1: Read BIOS Tick Count (0040:006C)

The BIOS maintains a 32-bit tick counter at `0040:006C` (segment 40h, offset 6Ch).
It increments ~18.206 times per second (~54.925 ms per tick), driven by the 8253 PIT
via IRQ 0 (INT 08h).

```asm
; Wait for approximately N ticks (~55ms each)
; Input: CX = number of ticks to wait
wait_ticks:
    push    es
    push    bx
    mov     ax, 0040h
    mov     es, ax
    mov     bx, es:[006Ch]     ; read current tick count (low word)
    add     bx, cx             ; target = current + delay
.loop:
    mov     ax, es:[006Ch]
    cmp     ax, bx
    jb      .loop              ; unsigned compare; simple version ignoring wraparound
    pop     bx
    pop     es
    ret
```

**Notes:**

- At midnight, the counter resets to 0 and the overflow flag at `0040:0070` is set
- Full 32-bit count: ~1,573,040 ticks/day (18.206 * 86400)
- Works on ALL IBM PC compatibles (PC, XT, AT, PS/2)
- Must have interrupts enabled (STI) for the counter to increment

### Option 2: INT 1Ah AH=00h -- Read System Clock Counter

Reads the same tick count as Option 1, but through a BIOS call.

| Register | Direction | Value |
|----------|-----------|-------|
| AH       | in        | 00h   |
| CX       | out       | High word of tick count |
| DX       | out       | Low word of tick count  |
| AL       | out       | Midnight flag (1 = 24 hours passed since last read) |

```asm
; Wait for approximately N ticks using INT 1Ah
; Input: CX = number of ticks to wait
wait_int1a:
    push    dx
    push    cx
    mov     ah, 00h
    int     1Ah                ; CX:DX = current tick count
    add     dx, cx             ; simple: add delay to low word
    mov     bx, dx             ; BX = target low word
    pop     cx
.loop:
    mov     ah, 00h
    int     1Ah
    cmp     dx, bx
    jb      .loop
    pop     dx
    ret
```

**Notes:**

- Reading clears the midnight flag (AL), so only one caller sees it
- CX:DX is zero at midnight
- Convert seconds to ticks: `seconds * 18.206` (or approximate as `seconds * 18 + seconds / 5`)
- Works on ALL IBM PC compatibles

### Option 3: INT 1Ah AH=01h -- Set System Clock Counter

| Register | Direction | Value |
|----------|-----------|-------|
| AH       | in        | 01h   |
| CX       | in        | High word of tick count |
| DX       | in        | Low word of tick count  |

- Sets CX:DX to number of seconds past midnight * ~18.206
- Returns nothing
- Rarely needed for delay purposes, but documented for completeness

### Option 4: Busy-Wait Delay Loop

For very short delays (sub-tick), a calibrated loop is the only 8086 option.
Not portable across CPU speeds -- only use when approximate timing is acceptable.

```asm
; Crude delay -- iteration count depends on CPU speed
; For 4.77 MHz 8086, ~1000 iterations ~ 1ms (very approximate)
delay_loop:
    mov     cx, 1000
.spin:
    loop    .spin
    ret
```

---

## INT 1Ch -- User Timer Tick

**Compatibility: ALL IBM PC compatibles (PC, XT, AT, PS/2)**

| Detail    | Value |
|-----------|-------|
| Frequency | ~18.206 Hz (called by INT 08h on every PIT tick) |
| Default handler | Single IRET (does nothing) |
| Typical use | TSR popups, animated graphics, event polling |

### How INT 08h and INT 1Ch Relate

1. PIT channel 0 fires IRQ 0 ~18.2 times/second
2. IRQ 0 invokes INT 08h (the system timer handler)
3. INT 08h updates the tick count at `0040:006C`, manages the motor shutoff counter at `0040:0040`, and sets the midnight overflow flag at `0040:0070`
4. INT 08h then calls INT 1Ch as a user hook
5. Default BIOS INT 1Ch handler is just IRET

### Hooking INT 1Ch for a TSR

INT 1Ch is the **preferred** hook point for TSRs. Hooking INT 08h directly is riskier
because you must send the EOI to the PIC and manage the system tick logic yourself.

```asm
; --- Installation (at startup) ---
    mov     ax, 351Ch           ; DOS: get interrupt vector 1Ch
    int     21h
    mov     [old_1c_off], bx   ; save old handler offset
    mov     [old_1c_seg], es   ; save old handler segment

    mov     ax, 251Ch           ; DOS: set interrupt vector 1Ch
    mov     dx, new_1c_handler
    push    ds
    push    cs
    pop     ds                  ; DS:DX -> our handler
    int     21h
    pop     ds

; --- Our INT 1Ch handler ---
new_1c_handler:
    push    ax
    push    ds
    ; ... do quick work here (decrement counter, set flag, etc.)
    ; IMPORTANT: keep it SHORT -- we're inside an interrupt
    pop     ds
    pop     ax

    ; Chain to the old handler (REQUIRED)
    jmp     far [cs:old_1c_off] ; far jump to old handler

; --- Data (in code segment for TSR access) ---
old_1c_off  dw  0
old_1c_seg  dw  0
```

### Rules for INT 1Ch Handlers

1. **Keep it fast.** You have ~55ms until the next tick. Long processing will miss ticks.
2. **Save and restore all registers** you use. The interrupted code expects them unchanged.
3. **Chain to the old vector.** Other TSRs or the BIOS may have hooked it before you.
   Use `JMP FAR` (not `CALL` + `IRET`) to chain -- this preserves the flags and stack frame.
4. **Do not call DOS (INT 21h)** from inside the handler. DOS is not reentrant.
   Instead, set a flag and check it in your main loop.
5. **Do not call BIOS disk/video** services unless you check the InDOS flag first.
6. **Interrupts are disabled** on entry (IF=0 from the hardware interrupt). If your handler
   takes a while, consider an STI at the start, but be aware of reentrancy.
7. **Segment registers:** Only CS is reliable on entry. Load DS from CS if you need
   to access your TSR's data segment.

### Using INT 1Ch as a Periodic Timer in a TSR

Common pattern: decrement a counter each tick, trigger action when it reaches zero.

```asm
tick_counter  dw  182          ; ~10 seconds (182 ticks / 18.2 Hz)
action_flag   db  0

new_1c_handler:
    push    ax
    push    ds
    push    cs
    pop     ds                  ; DS = CS (our data is in code segment)

    dec     word [tick_counter]
    jnz     .done
    mov     word [tick_counter], 182   ; reset for next 10-second interval
    mov     byte [action_flag], 1      ; signal main loop

.done:
    pop     ds
    pop     ax
    jmp     far [cs:old_1c_off]
```

---

## INT 08h -- IRQ 0 System Timer (for reference)

**Compatibility: ALL IBM PC compatibles**

| Detail    | Value |
|-----------|-------|
| Source    | 8253 PIT Channel 0, IRQ 0 |
| Frequency | ~18.206 Hz (~54.925 ms per tick) |
| Duration  | Handler takes ~100 microseconds |

### What INT 08h does each tick

1. Increments the 32-bit daily timer counter at `0040:006C`
2. Manages the 24-hour overflow flag at `0040:0070` (set when counter wraps past midnight)
3. Manages the day counter at `0040:0067` (AT and later only)
4. Decrements the diskette motor shutoff counter at `0040:0040`; when it reaches 0, turns off the diskette motor
5. Calls INT 1Ch (user timer tick hook)

**Important:** The overflow flag at `0040:0070` is a toggle, not a counter. If multiple
midnights pass without a DOS call reading it, days are lost. This is a known DOS limitation.

---

## Quick Reference: Timing Constants

| Quantity | Value |
|----------|-------|
| PIT frequency | 1,193,182 Hz (base clock) |
| Default divisor | 65,536 |
| Tick rate | 1,193,182 / 65,536 = ~18.2065 Hz |
| Tick period | ~54.925 ms |
| Ticks per second | ~18.2 |
| Ticks per minute | ~1,092 |
| Ticks per hour | ~65,543 |
| Ticks per day | ~1,573,040 |
| Midnight tick count | 0x001800B0 (1,573,040 decimal) |

### Converting Time to Ticks

```
ticks = seconds * 18.2065
ticks ~ seconds * 18 + seconds / 5    (integer approximation, ~0.03% error)
ticks ~ seconds * 91 / 5              (exact integer math for small values)
```

---

## Summary: What to Use on 8086/XT

| Need | Method |
|------|--------|
| Delay 1+ seconds | Read tick count at `0040:006C` or via INT 1Ah AH=00, poll until target reached |
| Periodic action in TSR | Hook INT 1Ch, decrement counter each tick, set flag at zero |
| Sub-tick delay (<55ms) | Busy-wait loop (not portable across CPU speeds) |
| Delay on AT+ only | INT 15h AH=86h (not available on 8086/XT) |

**For our TSR targeting WFW 3.11 on 86Box:** The emulated machine has an AT-class BIOS,
so INT 15h AH=86h would technically work. However, hooking INT 1Ch is the more standard
and portable approach for a TSR, and avoids blocking the CPU during the delay.
