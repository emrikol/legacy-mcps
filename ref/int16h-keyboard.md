# BIOS INT 16h Keyboard Services Reference

Source: [HelpPC](https://stanislavs.org/helppc/int_16.html) by David Jurgens

---

## Function Summary

| AH | Function | Machine Class |
|----|----------|---------------|
| 00h | Wait for keystroke and read | XT+ (all machines) |
| 01h | Get keystroke status (peek) | XT+ (all machines) |
| 02h | Get shift flags | XT+ (all machines) |
| 03h | Set typematic rate/delay | AT+ |
| 04h | Keyboard click adjustment | AT+ |
| 05h | Keyboard buffer write (stuff) | AT+ with extended BIOS |
| 10h | Wait for keystroke and read (enhanced) | AT/PS2 enhanced keyboard |
| 11h | Get keystroke status (enhanced) | AT/PS2 enhanced keyboard |
| 12h | Get shift status (enhanced) | AT/PS2 enhanced keyboard |

**Note:** IBM BIOS does not restore FLAGS to the pre-interrupt state, allowing information to be returned via the flags register. All registers except AX and FLAGS are preserved.

---

## AH=00h -- Read Key (Wait for Keystroke)

**Machine class:** XT and later (all machines)

### Registers

| Direction | Register | Value |
|-----------|----------|-------|
| Input | AH | 00h |
| Output | AH | Keyboard scan code |
| Output | AL | ASCII character (00h for special/function keys) |

### Description

Halts program execution until a key with a scan code is pressed. This is a **blocking** call. When a key is available in the keyboard buffer, the keystroke is removed from the buffer and returned.

For special keys (function keys, arrows, etc.), AL=00h and the scan code in AH identifies the key. For normal ASCII keys, AL contains the ASCII code and AH contains the scan code.

### Enhanced Variant (AH=10h)

Same behavior but recognizes the extended keys on 101/102-key keyboards (F11, F12, etc.). Use on AT/PS2 with enhanced keyboard BIOS.

---

## AH=01h -- Check Keyboard Status (Peek)

**Machine class:** XT and later (all machines)

### Registers

| Direction | Register | Value |
|-----------|----------|-------|
| Input | AH | 01h |
| Output | ZF | 0 = key available, 1 = no key available |
| Output | AH | Scan code (if key available) |
| Output | AL | ASCII character (if key available) |

### Description

Non-destructive peek at the keyboard buffer. Checks whether a keystroke is waiting **without removing it** from the buffer. The keystroke data remains in the buffer for a subsequent AH=00h call to consume.

### Important Notes

- If ZF=1 (no key), AX may be zero or undefined.
- **Ctrl-Break** places a zero word in the keyboard buffer but does NOT register as a keypress via ZF.
- To consume the key after peeking, call AH=00h.

### Enhanced Variant (AH=11h)

Same behavior but recognizes extended keys. Use on AT/PS2 with enhanced keyboard BIOS.

---

## AH=05h -- Keyboard Buffer Write (Stuff Key)

**Machine class:** AT and PS/2 with extended keyboard support. **NOT available on XT/8086.**

### Registers

| Direction | Register | Value |
|-----------|----------|-------|
| Input | AH | 05h |
| Input | CH | Scan code to stuff |
| Input | CL | ASCII character to stuff |
| Output | AL | 00h = success, 01h = buffer full |

### Description

Stores a keystroke (scan code + ASCII pair) into the BIOS keyboard buffer as if the key had been physically pressed. The stuffed keystroke will be returned by the next AH=00h/01h call.

### Limitations

- **Cannot stuff modifier keys** (Shift, Alt, Ctrl, etc.) -- only normal keystrokes.
- The buffer has a fixed size (typically 16 entries); AL=01h is returned if full.
- **Requires AT-class machine or later.** Will not work on 8086/8088/XT systems.

### Keyboard Buffer Structure

The BIOS keyboard buffer lives in the BIOS Data Area:

| Address | Size | Description |
|---------|------|-------------|
| 0040:001A | WORD | Buffer head pointer (read position) |
| 0040:001C | WORD | Buffer tail pointer (write position) |
| 0040:001E | 32 bytes | Circular buffer (16 WORD entries) |
| 0040:003E | -- | End of default buffer |

Each entry is a WORD: high byte = scan code, low byte = ASCII code. The head pointer indicates the next key to read; the tail pointer indicates where the next key will be written. When head == tail, the buffer is empty.

On AT+ machines with enhanced BIOS, the buffer start/end pointers may be relocated:

| Address | Size | Description |
|---------|------|-------------|
| 0040:0080 | WORD | Buffer start offset (default 001Eh) |
| 0040:0082 | WORD | Buffer end offset (default 003Eh) |

### XT Workaround

On XT-class machines where AH=05h is unavailable, you can stuff keys by directly manipulating the buffer at 0040:001E and updating the tail pointer at 0040:001C. This requires careful handling of the circular buffer wraparound.

---

## Scan Code Quick Reference

Each value below is a 16-bit WORD as returned by INT 16h: high byte = scan code (AH), low byte = ASCII code (AL). Format: `SSAA` where SS=scan code, AA=ASCII.

### Essential Keys

| Key | Normal | Shifted | w/ Ctrl | w/ Alt |
|-----|--------|---------|---------|--------|
| Enter | 1C0D | 1C0D | 1C0A | A600 |
| Escape | 011B | 011B | 011B | 0100 |
| Tab | 0F09 | 0F00 | 9400 | A500 |
| Space | 3920 | 3920 | 3920 | 3920 |
| Backspace | 0E08 | 0E08 | 0E7F | 0E00 |

### Arrow Keys

| Key | Normal | Shifted | w/ Ctrl | w/ Alt |
|-----|--------|---------|---------|--------|
| Up | 4800 | 4838 | 8D00 | 9800 |
| Down | 5000 | 5032 | 9100 | A000 |
| Left | 4B00 | 4B34 | 7300 | 9B00 |
| Right | 4D00 | 4D36 | 7400 | 9D00 |

Note: Arrow keys return AL=00h normally (extended keys). The shifted values show numpad equivalents (with NumLock behavior).

### Navigation Keys

| Key | Normal | Shifted | w/ Ctrl | w/ Alt |
|-----|--------|---------|---------|--------|
| Home | 4700 | 4737 | 7700 | 9700 |
| End | 4F00 | 4F31 | 7500 | 9F00 |
| PgUp | 4900 | 4939 | 8400 | 9900 |
| PgDn | 5100 | 5133 | 7600 | A100 |
| Ins | 5200 | 5230 | 9200 | A200 |
| Del | 5300 | 532E | 9300 | A300 |

### Function Keys

| Key | Normal | Shifted | w/ Ctrl | w/ Alt |
|-----|--------|---------|---------|--------|
| F1 | 3B00 | 5400 | 5E00 | 6800 |
| F2 | 3C00 | 5500 | 5F00 | 6900 |
| F3 | 3D00 | 5600 | 6000 | 6A00 |
| F4 | 3E00 | 5700 | 6100 | 6B00 |
| F5 | 3F00 | 5800 | 6200 | 6C00 |
| F6 | 4000 | 5900 | 6300 | 6D00 |
| F7 | 4100 | 5A00 | 6400 | 6E00 |
| F8 | 4200 | 5B00 | 6500 | 6F00 |
| F9 | 4300 | 5C00 | 6600 | 7000 |
| F10 | 4400 | 5D00 | 6700 | 7100 |
| F11 | 8500 | 8700 | 8900 | 8B00 |
| F12 | 8600 | 8800 | 8A00 | 8C00 |

Note: F11/F12 require enhanced keyboard BIOS (AT/PS2).

### Letter Keys (A-Z)

| Key | Normal | Shifted | w/ Ctrl | w/ Alt |
|-----|--------|---------|---------|--------|
| A | 1E61 | 1E41 | 1E01 | 1E00 |
| B | 3062 | 3042 | 3002 | 3000 |
| C | 2E63 | 2E42 | 2E03 | 2E00 |
| D | 2064 | 2044 | 2004 | 2000 |
| E | 1265 | 1245 | 1205 | 1200 |
| F | 2166 | 2146 | 2106 | 2100 |
| G | 2267 | 2247 | 2207 | 2200 |
| H | 2368 | 2348 | 2308 | 2300 |
| I | 1769 | 1749 | 1709 | 1700 |
| J | 246A | 244A | 240A | 2400 |
| K | 256B | 254B | 250B | 2500 |
| L | 266C | 264C | 260C | 2600 |
| M | 326D | 324D | 320D | 3200 |
| N | 316E | 314E | 310E | 3100 |
| O | 186F | 184F | 180F | 1800 |
| P | 1970 | 1950 | 1910 | 1900 |
| Q | 1071 | 1051 | 1011 | 1000 |
| R | 1372 | 1352 | 1312 | 1300 |
| S | 1F73 | 1F53 | 1F13 | 1F00 |
| T | 1474 | 1454 | 1414 | 1400 |
| U | 1675 | 1655 | 1615 | 1600 |
| V | 2F76 | 2F56 | 2F16 | 2F00 |
| W | 1177 | 1157 | 1117 | 1100 |
| X | 2D78 | 2D58 | 2D18 | 2D00 |
| Y | 1579 | 1559 | 1519 | 1500 |
| Z | 2C7A | 2C5A | 2C1A | 2C00 |

### Number Keys (top row)

| Key | Normal | Shifted | w/ Ctrl | w/ Alt |
|-----|--------|---------|---------|--------|
| 1 ! | 0231 | 0221 | -- | 7800 |
| 2 @ | 0332 | 0340 | 0300 | 7900 |
| 3 # | 0433 | 0423 | -- | 7A00 |
| 4 $ | 0534 | 0524 | -- | 7B00 |
| 5 % | 0635 | 0625 | -- | 7C00 |
| 6 ^ | 0736 | 075E | 071E | 7D00 |
| 7 & | 0837 | 0826 | -- | 7E00 |
| 8 * | 0938 | 092A | -- | 7F00 |
| 9 ( | 0A39 | 0A28 | -- | 8000 |
| 0 ) | 0B30 | 0B29 | -- | 8100 |

### Punctuation & Symbol Keys

| Key | Normal | Shifted | w/ Ctrl | w/ Alt |
|-----|--------|---------|---------|--------|
| - _ | 0C2D | 0C5F | 0C1F | 8200 |
| = + | 0D3D | 0D2B | -- | 8300 |
| [ { | 1A5B | 1A7B | 1A1B | 1A00 |
| ] } | 1B5D | 1B7D | 1B1D | 1B00 |
| ; : | 273B | 273A | -- | 2700 |
| ' " | 2827 | 2822 | -- | -- |
| ` ~ | 2960 | 297E | -- | -- |
| \ | | 2B5C | 2B7C | 2B1C | 2600 |
| , < | 332C | 333C | -- | -- |
| . > | 342E | 343E | -- | -- |
| / ? | 352F | 353F | -- | -- |

### Keypad Keys

| Key | Normal | Shifted | w/ Ctrl | w/ Alt |
|-----|--------|---------|---------|--------|
| Keypad * | 372A | -- | 9600 | 3700 |
| Keypad - | 4A2D | 4A2D | 8E00 | 4A00 |
| Keypad + | 4E2B | 4E2B | -- | 4E00 |
| Keypad / | 352F | 352F | 9500 | A400 |
| Keypad 5 | -- | 4C35 | -- | 8F00 |

### Special Keys

| Key | Normal | w/ Alt |
|-----|--------|--------|
| PrtSc | -- | 7200 |

---

## Scan Code Extraction Cheat Sheet

Given a WORD value `SSAA` returned by INT 16h:

```
Scan code (AH) = high byte = SS
ASCII code (AL) = low byte  = AA

If AL = 00h  -->  extended/special key, identify by scan code in AH
If AL != 00h -->  normal ASCII key, AL is the character
```

### Common Scan Codes (AH values only)

| Scan | Key |
|------|-----|
| 01h | Esc |
| 0Eh | Backspace |
| 0Fh | Tab |
| 1Ch | Enter |
| 39h | Space |
| 3Bh-44h | F1-F10 |
| 47h | Home |
| 48h | Up Arrow |
| 49h | PgUp |
| 4Bh | Left Arrow |
| 4Dh | Right Arrow |
| 4Fh | End |
| 50h | Down Arrow |
| 51h | PgDn |
| 52h | Ins |
| 53h | Del |
| 85h | F11 |
| 86h | F12 |
