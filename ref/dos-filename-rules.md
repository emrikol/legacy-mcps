# DOS Filename Rules Reference

Comprehensive reference for DOS 8.3 filenames, valid characters, path handling,
and INT 21h behavior. Compiled from Microsoft documentation, OS/2 Museum,
Wikipedia, and various technical references.

---

## 1. 8.3 Format Overview

- **Base name:** 1-8 characters
- **Extension:** 0-3 characters (optional)
- **Separator:** a single period (`.`) between name and extension
- **Total on-disk:** 11 bytes (8 + 3), stored uppercase, space-padded (0x20)
- The period is **not stored** in the directory entry; it is implied

### FAT Directory Entry (bytes 0-10)

```
Offset  Size  Description
0x00    8     Filename (left-justified, padded with 0x20)
0x08    3     Extension (left-justified, padded with 0x20)
0x0B    1     Attribute byte
```

First byte of filename has special meanings:

- `0x00` = entry is free and no entries follow
- `0xE5` = entry has been deleted
- `0x05` = first character is actually 0xE5 (kanji lead byte)
- `0x2E` = dot entry (`.` or `..`)

---

## 2. Valid Characters

### Allowed

| Category | Characters |
|---|---|
| Uppercase letters | `A-Z` |
| Digits | `0-9` |
| Special characters | `! # $ % & ' ( ) - @ ^ _` `` ` `` `{ } ~` |
| High ASCII | Characters 128-255 (code-page dependent) |

**Underscore (`_`) is valid.** Double underscores (`__`) are valid. There is
nothing special about underscores in DOS -- they are ordinary filename
characters.

### Forbidden

| Character | Reason |
|---|---|
| `\` | Path separator |
| `/` | Alternate path separator |
| `:` | Drive letter separator |
| `*` | Wildcard |
| `?` | Wildcard |
| `"` | Reserved |
| `<` | Redirection |
| `>` | Redirection |
| `\|` | Pipe |
| `.` | Only as name/extension separator (one allowed) |
| Space (0x20) | Legal on disk but problematic; many programs reject it |
| Control chars (0x00-0x1F) | Invalid |

### Space Character Nuance

Space (0x20) is technically a valid filename character in the FAT directory
entry. However:

- DOS itself uses spaces as padding in the 8+3 fields
- Trailing spaces are treated as padding, not part of the name
- Most DOS programs and command-line tools cannot handle filenames with spaces
- **Practical rule: do not use spaces**

### Tilde (`~`) Caveat

The tilde is valid in DOS 8.3 names, but Windows 95+ VFAT uses `~` in
auto-generated short names (e.g., `LONGFI~1.TXT`). Avoid `~` in filenames
intended for use across DOS and Windows 95+ systems.

---

## 3. Case Sensitivity

**DOS is case-insensitive and NOT case-preserving.**

- FAT12/FAT16 store all filenames in uppercase
- INT 21h file operations (open, create, find, delete, rename) perform
  case-insensitive matching
- A file created as `readme.txt` is stored as `README.TXT`
- Opening `MyFile.Txt`, `MYFILE.TXT`, or `myfile.txt` all refer to the same file
- The case folding happens in the DOS kernel before the directory is searched

---

## 4. Period / Dot Rules

- **One period** separates base name from extension
- **Leading dot:** `.` and `..` are reserved for directory entries (current and
  parent directory). A regular file cannot start with a dot in strict DOS.
- **Multiple dots:** Not valid in strict 8.3. Only one dot is allowed, and it
  must separate the name from the extension.
- **Trailing dot:** Stripped by DOS. `FILE.` is treated as `FILE` (no extension).
- **No dot:** Valid. A filename with no extension is fine (e.g., `MAKEFILE`).

---

## 5. Path Handling

### Path Separators

INT 21h accepts **both** backslash (`\`) and forward slash (`/`) as path
separators. The following are equivalent when passed to any INT 21h function:

```
C:\MSP\SOURCE\ROSE.PAS
C:/MSP/SOURCE/ROSE.PAS
```

This has been true since DOS 2.0. The backslash is the conventional separator
displayed by DOS commands, but the kernel treats both identically.

### Maximum Path Length

| Limit | Value | Notes |
|---|---|---|
| CDS (Current Directory Structure) | **66 characters** | Internal DOS limit for current directory tracking |
| INT 21h function 47h buffer | **64 bytes** | Path without drive letter and leading `\`, no null terminator |
| Full path with drive + null | **67 bytes** | `D:\` + 63 chars + null |
| MS-DOS 6.0+ PATH variable | 128+ characters | PATH env var was extended, but individual paths still limited |

**Practical maximum for a full file path: 67 bytes** (including `D:\`, path,
filename, and null terminator). This is far shorter than the 260 (MAX_PATH)
limit in Windows.

The CDS limit of 66 bytes is the most restrictive: `D:\` (3 bytes) + up to 63
bytes of path = 66 total. This limits how deep directory nesting can go.

### Drive Letters

- `A:` through `Z:` (case-insensitive)
- Colon separates drive letter from path
- If omitted, the current/default drive is used

---

## 6. Reserved Device Names

These names are reserved by DOS and **must not** be used as filenames. They are
intercepted by the DOS kernel regardless of extension or directory path.

| Device | Purpose |
|---|---|
| `CON` | Console (keyboard input / screen output) |
| `PRN` | Default printer (usually same as LPT1) |
| `AUX` | Auxiliary device (usually same as COM1) |
| `NUL` | Null device (bit bucket) |
| `COM1` - `COM4` | Serial ports |
| `LPT1` - `LPT3` | Parallel printer ports |
| `CLOCK$` | System clock |

Important details:

- `NUL.TXT`, `CON.LOG`, `PRN.DAT` -- the extension is **ignored**. These still
  refer to the device, not a file.
- `C:\MYDIR\NUL` -- the path is **ignored**. This still refers to the NUL device.
- Device names are matched case-insensitively (`con`, `Con`, `CON` are all the
  console).
- Some DOS versions also reserve `COM5`-`COM9` and `LPT4`-`LPT9`.
- `CONIN$` and `CONOUT$` are reserved in some versions (Windows).

---

## 7. File Attribute Bits

Stored at offset 0x0B in the 32-byte directory entry.

| Bit | Hex | Name | Description |
|---|---|---|---|
| 0 | 0x01 | Read-Only | File cannot be written or deleted |
| 1 | 0x02 | Hidden | File is hidden from normal directory listings |
| 2 | 0x04 | System | File is a system file |
| 3 | 0x08 | Volume Label | Entry is the volume label (root directory only) |
| 4 | 0x10 | Directory | Entry is a subdirectory |
| 5 | 0x20 | Archive | File has been modified since last backup |
| 6 | 0x40 | Device | Internal use only; never found on disk |
| 7 | 0x80 | (Unused) | Reserved |

Special combination: `0x0F` (Read-Only + Hidden + System + Volume Label) marks
a VFAT long filename entry. Old DOS ignores these entries.

---

## 8. INT 21h Error Codes (File Operations)

When an INT 21h file function fails, the **carry flag (CF)** is set and the
error code is returned in **AX**.

| AX | Error | Description |
|---|---|---|
| 01h | Invalid function | Function number in AH is not valid |
| 02h | File not found | The specified file does not exist |
| 03h | Path not found | A directory component of the path does not exist |
| 04h | Too many open files | No file handles available |
| 05h | Access denied | File is read-only, or directory, or other permission issue |
| 06h | Invalid handle | The file handle is not open |

### Invalid Filename Behavior

There is **no specific error code** for "invalid filename" in the basic error
codes (01h-12h). When an invalid filename is passed to INT 21h:

- **Some implementations** return error 02h (File not found) or 03h (Path not
  found), as if the file simply does not exist
- **Some implementations** return error 05h (Access denied)
- **Extended error information** (INT 21h function 59h, DOS 3.0+) can provide
  more detail:
  - Extended error code 0x...
  - Error class, suggested action, and locus

**Practical consequence:** You cannot reliably distinguish "invalid filename"
from "file not found" using basic INT 21h error codes alone. A TSR should
validate filenames before passing them to INT 21h.

---

## 9. Answers to Specific Questions

### Are underscores valid in DOS filenames?

**Yes.** Underscores are ordinary valid characters. `__MCP__.TX` is a perfectly
legal DOS 8.3 filename:

- Base name: `__MCP__` (7 characters, within 8-char limit)
- Extension: `TX` (2 characters, within 3-char limit)
- All characters (underscore, letters) are in the valid set

### Are double underscores valid?

**Yes.** There is no restriction on consecutive underscores. `__` at the start,
middle, or end of a filename is fine.

### What characters are explicitly forbidden?

The complete list: `\ / : * ? " < > |` plus all control characters (0x00-0x1F).
Space is technically allowed but practically unusable.

### Is DOS case-sensitive when opening files?

**No.** DOS converts all filenames to uppercase before any operation. Case is
completely ignored.

### Maximum path length for INT 21h file operations?

**67 bytes** for a full path (`D:\` + path + filename + null), constrained by
the 66-byte CDS limit.

### Backslash vs forward slash?

**Both are accepted** by INT 21h since DOS 2.0. They are interchangeable in
paths passed to system calls.

### Can a filename start with a dot? Have multiple dots?

**No** to both in strict DOS 8.3. Leading dots are reserved for `.` and `..`
directory entries. Only one dot is permitted, separating name from extension.

### Device names to avoid?

`CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM4`, `LPT1`-`LPT3` (and sometimes
`COM5`-`COM9`, `LPT4`-`LPT9`, `CLOCK$`). These are matched regardless of
extension or path.

### What does INT 21h return when a filename is invalid vs file not found?

Both typically return error 02h (File not found) or 03h (Path not found). There
is no distinct error code for "invalid filename" in the basic INT 21h error
scheme. Use INT 21h/59h for extended error information.

---

## Sources

- [8.3 filename - Wikipedia](https://en.wikipedia.org/wiki/8.3_filename)
- [MS-FSCC: 8.3 Filename - Microsoft Learn](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fscc/18e63b13-ba43-4f5f-a5b7-11e871b71f14)
- [DOS Days - DOS 8.3 Filenames](https://www.dosdays.co.uk/topics/dos_8_3.php)
- [Naming Files, Paths, and Namespaces - Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file)
- [FAT Filenames (averstak)](https://averstak.tripod.com/fatdox/names.htm)
- [DOS Error Codes - stanislavs.org](https://www.stanislavs.org/helppc/dos_error_codes.html)
- [INT 21h DOS Functions - techhelpmanual.com](http://www.techhelpmanual.com/560-int_21h__dos_functions.html)
- [Why Does Windows Really Use Backslash - OS/2 Museum](https://www.os2museum.com/wp/why-does-windows-really-use-backslash-as-path-separator/)
- [Design of the FAT file system - Wikipedia](https://en.wikipedia.org/wiki/Design_of_the_FAT_file_system)
- [FAT - OSDev Wiki](https://wiki.osdev.org/FAT)
- [Art of Assembly: Chapter 13 - DOS File I/O](https://www.plantation-productions.com/Webster/www.artofasm.com/DOS/ch13/CH13-6.html)
