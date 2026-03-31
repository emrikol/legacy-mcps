# BIOS Keyboard Buffer -- Technical Reference

Compiled from web research, 2026-03-12.

---

## 1. Buffer Location and Structure

The BIOS keyboard type-ahead buffer lives in the BIOS Data Area (BDA), segment 0040h:

| Address    | Size     | Purpose                                              |
|------------|----------|------------------------------------------------------|
| 0040:0017  | 1 byte   | Keyboard shift-flag byte 0 (Shift/Ctrl/Alt/Lock)     |
| 0040:0018  | 1 byte   | Keyboard shift-flag byte 1 (left-side modifiers)     |
| 0040:0019  | 1 byte   | Alt-numpad accumulator (for Alt+numpad entry)        |
| 0040:001A  | 1 word   | **Head pointer** -- offset from 0040:0000             |
| 0040:001C  | 1 word   | **Tail pointer** -- offset from 0040:0000             |
| 0040:001E  | 32 bytes | **Keyboard buffer** (circular queue, 16 word slots)   |
| 0040:0080  | 1 word   | Buffer start offset (default 001Eh) -- AT BIOS 10/27/82+ |
| 0040:0082  | 1 word   | Buffer end offset (default 003Eh) -- AT BIOS 10/27/82+   |
| 0040:0096  | 1 byte   | Keyboard mode/type (enhanced keyboard flags)         |
| 0040:0097  | 1 byte   | Keyboard LED flags                                   |

Each buffer entry is a **word (2 bytes)**: the low byte is the ASCII character code, the high byte is the scan code. For special keys with no ASCII equivalent, the ASCII byte is 00h (or E0h for extended keys on enhanced keyboards).

The default buffer spans offsets 001Eh through 003Dh inclusive (32 bytes = 16 word slots).

---

## 2. How Many Keystrokes Can It Hold? (15, not 16)

**The buffer holds a maximum of 15 keystrokes**, not 16.

This is because the circular buffer uses the condition `head == tail` to mean "empty." If all 16 slots were filled, `head == tail` would also be true, making it impossible to distinguish "full" from "empty." Therefore one slot is always left unused as a sentinel.

The full-detection algorithm is:

```
next_tail = tail + 2
if next_tail >= buffer_end:
    next_tail = buffer_start       ; wrap around
if next_tail == head:
    buffer is FULL -- reject keystroke
else:
    store word at [tail]
    tail = next_tail
```

When the tail pointer, after incrementing and wrapping, would equal the head pointer, the buffer is full. The key is discarded.

---

## 3. Circular Buffer Mechanics

### Reading a key (INT 16h AH=00h or AH=10h)

1. Wait until `head != tail` (buffer not empty).
2. Read the word at `[0040:head]`.
3. Advance head by 2.
4. If head >= buffer_end (003Eh by default), wrap head to buffer_start (001Eh).
5. Return scan code in AH, ASCII in AL.

### Peeking at a key (INT 16h AH=01h or AH=11h)

1. If `head == tail`, set ZF=1 (no key), return.
2. Otherwise, read word at `[0040:head]`, return in AX. ZF=0.
3. Head pointer is NOT advanced (non-destructive peek).

### Storing a key (INT 9h handler / INT 16h AH=05h)

1. Compute `next_tail = tail + 2`.
2. If `next_tail >= buffer_end`, set `next_tail = buffer_start` (wrap).
3. If `next_tail == head`, the buffer is full -- reject the keystroke.
4. Otherwise, store the word at `[0040:tail]`, then set `tail = next_tail`.

### Pointer values

Head and tail are stored as **offsets from segment 0040h**, not as indices. They range from 001Eh to 003Ch (even values only, stepping by 2). The buffer_end value (003Eh default) is one past the last valid slot.

---

## 4. What Happens When the Buffer Is Full?

### Via INT 9h (hardware keyboard interrupt)

When INT 9h fires (a physical key press) and the buffer is full:

- The keystroke is **silently discarded** (not stored).
- The BIOS **beeps** via the PC speaker to notify the user.
- The beep takes significant CPU time (~100% CPU during the beep duration), which can freeze the application momentarily.
- If a key is stuck down (typematic repeat), the repeated beeping can effectively lock up the system.

### Via INT 16h AH=05h (programmatic key stuffing)

When you call AH=05h and the buffer is full:

- The keystroke is **not stored**.
- **AL = 01h** is returned (failure; 00h = success).
- Many BIOSes also set CF=1 on failure, CF=0 on success.
- **No beep** is generated -- the caller is expected to handle the error.
- AH is destroyed by many BIOSes (do not rely on its value after the call).

### Via direct memory write (bypassing BIOS)

If you manually write to the buffer and advance the tail pointer without checking:

- You will **silently overwrite unread data** -- the BIOS does not protect against this.
- The head pointer will still point at the old position, so the reader will see corrupted data.
- There is **no beep, no error, no protection** -- you must implement your own bounds checking.

---

## 5. INT 16h AH=05h -- Stuffing Keys Into the Buffer

### Interface

```
Input:
    AH = 05h
    CH = BIOS scan code
    CL = ASCII character

Output:
    AL = 00h  success (keystroke stored)
    AL = 01h  failure (buffer full)
    CF = 0    success (on many BIOSes)
    CF = 1    failure (on many BIOSes)
    AH = destroyed (unreliable)
```

### Key facts

- The scan code in CH does **not** have to correspond to the ASCII code in CL. You can inject arbitrary scan/ASCII combinations.
- Available on: IBM PC AT BIOS dated 11/15/85+, PC XT BIOS dated 01/10/86+, PS/2, and virtually all clones.
- **Not available** on the original IBM PC (08/16/82) or early XT (11/08/82) BIOSes.
- Under DESQview, certain keystroke combinations trigger window management instead of being buffered.

### Checking before stuffing

To check if the buffer has room before calling AH=05h, you can either:

1. Just call AH=05h and check AL on return (simplest).
2. Peek at the head/tail pointers directly:

   ```
   mov  ax, 0040h
   mov  es, ax
   mov  bx, [es:001Ch]    ; tail
   add  bx, 2
   cmp  bx, [es:0082h]    ; buffer end
   jb   .no_wrap
   mov  bx, [es:0080h]    ; buffer start
   .no_wrap:
   cmp  bx, [es:001Ah]    ; head
   je   .buffer_full
   ; buffer has room
   ```

---

## 6. Expanding the Buffer

The standard 15-keystroke capacity can be expanded because AT-class BIOSes (10/27/82+) read the buffer boundaries from 0040:0080 and 0040:0082 rather than using hardcoded addresses.

### EXTBUF technique

- Relocate the buffer to the unused 256-byte area at 0000:0600 (linear address 600h).
- Set 0040:0080 = 0200h (offset of 600h from segment 0040h = 0040:0200).
- Set 0040:0082 = 0300h (end = 0040:0300 = linear 700h, giving 256 bytes = 128 word slots).
- Reset head and tail pointers to the new start offset.
- Result: **127 keystrokes** (128 slots minus 1 sentinel) with **no conventional memory used** (the 600h area is otherwise unused in DOS 2.0+).

### KBDBUF.SYS (MS-DOS 6.x supplemental)

- Device driver that allocates conventional memory for a larger buffer.
- Supports up to **1024 characters** (512 word entries, 511 usable keystrokes).
- Must be loaded within 64KB of the BDA at 0040:0000 (because head/tail are 16-bit offsets from segment 0040h).

### Compatibility caveat

Buffer expansion does **not** work on the earliest PC BIOSes (04/24/1981 and 10/19/1981) which hardcode the buffer boundaries at 001Eh-003Dh and ignore the values at 0040:0080/0082.

---

## 7. Typematic Rate and the Buffer

The keyboard controller has its own typematic repeat mechanism:

- **Original PC keyboard:** Fixed 10 chars/sec repeat rate, 0.5 sec delay.
- **AT and later:** Programmable via INT 16h AH=03h (AL=05h, BH=delay 0-3, BL=rate 0-1Fh) or via direct keyboard controller commands (port 60h, command F3h).

When a key is held down, the keyboard controller sends repeat scan codes at the typematic rate. Each one triggers INT 9h, which attempts to store it in the buffer. Once the buffer fills (after ~15 repeats if nothing is reading), subsequent repeats cause beeps and are discarded.

The keyboard controller itself also has a small internal buffer (typically 16 bytes on AT controllers) that can queue scan codes when the system is slow to service INT 9h, but this is separate from the BIOS type-ahead buffer.

---

## 8. Practical Implications for SENDKEYS

For a TSR that injects keystrokes into the BIOS buffer (e.g., a SENDKEYS command):

### Strategy A: Use INT 16h AH=05h (recommended)

- Stuff one key at a time.
- Check AL return value after each call.
- If AL=01h (full), **wait and retry** -- the target application needs time to consume keys.
- Waiting can be done by hooking INT 08h (timer tick, ~18.2/sec) or INT 1Ch (user timer tick) and retrying on each tick.

### Strategy B: Direct buffer write (faster but riskier)

- Disable interrupts (CLI).
- Read tail from 0040:001C.
- Compute next_tail, check against head at 0040:001A.
- If room, write word at 0040:tail, update tail to next_tail.
- Enable interrupts (STI).
- Must handle the "full" case yourself (wait and retry).

### Buffer capacity concerns for long strings

- With the standard 15-key buffer, injecting a string longer than 15 characters requires pacing.
- You cannot dump the entire string at once -- you must feed keys in batches as the application consumes them.
- A timer-tick-driven approach (inject 1-5 keys per tick, check for room) works well.
- Alternatively, expand the buffer first (EXTBUF technique) to hold up to 127 keys, which covers most command strings without pacing.

### Important: CLI/STI around direct writes

If you modify the buffer directly (not via AH=05h), you **must** bracket the operation with CLI/STI to prevent INT 9h from firing mid-update and corrupting the pointers.

---

## Sources

- [Using the Keyboard Buffer (fysnet.net)](http://www.fysnet.net/kbuffio.htm)
- [Art of Assembly Ch. 20 -- The Keyboard BIOS Interface](https://www.plantation-productions.com/Webster/www.artofasm.com/DOS/ch20/CH20-3.html)
- [BIOS Data Area (HelpPC)](https://stanislavs.org/helppc/bios_data_area.html)
- [INT 9 -- Keyboard Interrupt (HelpPC)](https://stanislavs.org/helppc/int_9.html)
- [EXTBUF -- Extend the BIOS Keyboard Buffer](https://pcdosretro.gitlab.io/extbuf.htm)
- [INT 16H -- Wikipedia](https://en.wikipedia.org/wiki/INT_16H)
- [INT 16h AH=05h (Ralf Brown's Interrupt List)](https://minuszerodegrees.net/websitecopies/Linux.old/docs/interrupts/int-html/rb-1761.htm)
- [ROM BIOS Variables (Tech Help Manual)](http://www.techhelpmanual.com/93-rom_bios_variables.html)
- [FreeDOS Feature Request: Disable buffer-full beep](https://sourceforge.net/p/freedos/feature-requests/46/)
- [MS KB Q60140: Location of Keyboard Buffer Area](https://jeffpar.github.io/kbarchive/kb/060/Q60140/)
