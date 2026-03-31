# DOS INT 21h File I/O and Program Control Reference

Source: [HelpPC](https://stanislavs.org/helppc/int_21.html)

---

## Function Summary

| AH | Function | Category |
|----|----------|----------|
| 09h | Print string | Output |
| 39h | Create subdirectory (MKDIR) | Directory |
| 3Ch | Create file using handle | File I/O |
| 3Dh | Open file using handle | File I/O |
| 3Eh | Close file using handle | File I/O |
| 3Fh | Read file or device | File I/O |
| 40h | Write file or device | File I/O |
| 41h | Delete file | File I/O |
| 4Bh | EXEC — load and execute program | Program |
| 4Ch | Terminate with return code | Program |

---

## INT 21h, AH=09h — Print String

Outputs a character string to STDOUT.

### Registers

| Direction | Register | Value |
|-----------|----------|-------|
| In | AH | 09h |
| In | DS:DX | Pointer to string terminated by `$` |
| Out | — | Nothing returned |

### Notes

- String must be terminated with a `$` character (the `$` is not printed).
- Backspace is handled as non-destructive (cursor moves back but character is not erased).
- If Ctrl-Break is detected during output, INT 23h is invoked.

---

## INT 21h, AH=39h — Create Subdirectory (MKDIR)

Creates the specified subdirectory.

### Registers

| Direction | Register | Value |
|-----------|----------|-------|
| In | AH | 39h |
| In | DS:DX | Pointer to ASCIIZ path name |
| Out | CF | 0 = success, 1 = error |
| Out | AX | Error code if CF=1 |

### Error Conditions

- Directory already exists.
- A path component cannot be found.
- Parent directory is full.
- Disk is write-protected.

---

## INT 21h, AH=3Ch — Create File Using Handle

Creates a new file or truncates an existing one to zero length and opens it.

### Registers

| Direction | Register | Value |
|-----------|----------|-------|
| In | AH | 3Ch |
| In | CX | File attribute (see below) |
| In | DS:DX | Pointer to ASCIIZ path name |
| Out | CF | 0 = success, 1 = error |
| Out | AX | File handle (CF=0) or error code (CF=1) |

### File Attributes (CX)

| Bit | Meaning |
|-----|---------|
| 0 | Read-only |
| 1 | Hidden |
| 2 | System |
| 5 | Archive |

Use CX=0 for a normal file.

### Notes

- If the file already exists, it is **truncated to zero bytes** on opening.
- To create without truncating an existing file, use function 5Bh instead.

---

## INT 21h, AH=3Dh — Open File Using Handle

Opens an existing file and returns a handle.

### Registers

| Direction | Register | Value |
|-----------|----------|-------|
| In | AH | 3Dh |
| In | AL | Access mode (see below) |
| In | DS:DX | Pointer to ASCIIZ file name |
| Out | CF | 0 = success, 1 = error |
| Out | AX | File handle (CF=0) or error code (CF=1) |

### Access Mode (AL)

```
Bits 1-0  Access mode
           00 = read only
           01 = write only
           02 = read/write
Bit  3    Reserved (0)
Bits 6-4  Sharing mode (DOS 3.1+)
           000 = compatibility mode
           001 = deny all (exclusive)
           010 = deny write
           011 = deny read
           100 = deny none
Bit  7    Inheritance
           0 = inheritable by child processes
           1 = private to current process
```

### Notes

- Opens normal, hidden, and system files.
- File pointer is placed at the beginning of the file.
- Sharing modes require DOS 3.1+ and SHARE.EXE loaded.

---

## INT 21h, AH=3Eh — Close File Using Handle

Closes a previously opened file handle.

### Registers

| Direction | Register | Value |
|-----------|----------|-------|
| In | AH | 3Eh |
| In | BX | File handle |
| Out | CF | 0 = success, 1 = error |
| Out | AX | Error code if CF=1 |

### Notes

- If the file was opened for writing, the directory entry is updated with the current file size, date, and time stamp.
- The handle is freed and may be reused by subsequent open/create calls.

---

## INT 21h, AH=3Fh — Read File or Device

Reads bytes from a file or device into a buffer.

### Registers

| Direction | Register | Value |
|-----------|----------|-------|
| In | AH | 3Fh |
| In | BX | File handle |
| In | CX | Number of bytes to read |
| In | DS:DX | Pointer to read buffer |
| Out | CF | 0 = success, 1 = error |
| Out | AX | Bytes actually read (CF=0) or error code (CF=1) |

### Notes

- If AX < CX on return, a partial read occurred (typically end-of-file).
- If AX = 0, the file pointer was already at or past end-of-file.
- For device handles (e.g., STDIN = 0), reads up to CX bytes or until CR is encountered.

---

## INT 21h, AH=40h — Write File or Device

Writes bytes from a buffer to a file or device.

### Registers

| Direction | Register | Value |
|-----------|----------|-------|
| In | AH | 40h |
| In | BX | File handle |
| In | CX | Number of bytes to write |
| In | DS:DX | Pointer to write buffer |
| Out | CF | 0 = success, 1 = error |
| Out | AX | Bytes actually written (CF=0) or error code (CF=1) |

### Notes

- If AX != CX on return, a partial write occurred (usually disk full).
- **Truncation trick:** calling with CX=0 truncates (or extends) the file to the current file pointer position.
- Standard handles: STDOUT=1, STDERR=2.

---

## INT 21h, AH=41h — Delete File (Unlink)

Deletes a file from the directory.

### Registers

| Direction | Register | Value |
|-----------|----------|-------|
| In | AH | 41h |
| In | DS:DX | Pointer to ASCIIZ file name |
| Out | CF | 0 = success, 1 = error |
| Out | AX | Error code if CF=1 |

### Notes

- Marks the first byte of the directory entry with E5h and frees the FAT chain.
- Officially does not support wildcards, but **several DOS versions actually do accept wildcards** — behavior is inconsistent across versions.
- Cannot delete read-only files without first clearing the read-only attribute (INT 21h/43h).

---

## INT 21h, AH=4Bh — EXEC (Load and Execute Program)

Loads and optionally executes a program.

### Registers

| Direction | Register | Value |
|-----------|----------|-------|
| In | AH | 4Bh |
| In | AL | Sub-function (see below) |
| In | DS:DX | Pointer to ASCIIZ program file name |
| In | ES:BX | Pointer to parameter block |
| Out | CF | 0 = success, 1 = error |
| Out | AX | Error code if CF=1 |

### Sub-functions (AL)

| AL | Action |
|----|--------|
| 00h | Load and execute |
| 01h | Load only (undocumented) |
| 03h | Load overlay |

### Parameter Block (AL=00h, Load and Execute)

| Offset | Size | Contents |
|--------|------|----------|
| 00h | WORD | Segment of environment block (0 = inherit parent's) |
| 02h | DWORD | Pointer to command-line tail (length byte + string + CR) |
| 06h | DWORD | Pointer to first FCB (copied to PSP:5Ch) |
| 0Ah | DWORD | Pointer to second FCB (copied to PSP:6Ch) |

### Parameter Block (AL=03h, Load Overlay)

| Offset | Size | Contents |
|--------|------|----------|
| 00h | WORD | Segment to load overlay at |
| 02h | WORD | Relocation factor |

### Notes

- **All registers except CS:IP are destroyed** on return — save SS:SP before calling.
- The child process return code is retrievable via INT 21h/4Dh.
- The calling program must have enough free memory; use INT 21h/4Ah to shrink its own memory block first.
- Sub-function 04h exists but returns an error on DOS 4.x+.

---

## INT 21h, AH=4Ch — Terminate with Return Code

Terminates the current process and returns control to the parent (usually COMMAND.COM).

### Registers

| Direction | Register | Value |
|-----------|----------|-------|
| In | AH | 4Ch |
| In | AL | Return code (0 = success by convention) |
| Out | — | Does not return to caller |

### Notes

- This is the **standard method** for program termination in DOS 2.0+.
- Restores the terminate (INT 22h), Ctrl-Break (INT 23h), and critical error (INT 24h) vectors from the PSP.
- Flushes all file buffers and frees the program's memory.
- Does **not** close files opened via FCBs (handle-based files are closed).
- The return code can be read by the parent via INT 21h/4Dh or tested in batch files with `ERRORLEVEL`.
- For DOS 1.x, use INT 20h or INT 21h/00h instead.

---

## Common DOS Error Codes

These are returned in AX when the carry flag is set.

| Code | Meaning |
|------|---------|
| 01h | Invalid function number |
| 02h | File not found |
| 03h | Path not found |
| 04h | Too many open files (no handles available) |
| 05h | Access denied |
| 06h | Invalid handle |
| 08h | Insufficient memory |
| 0Fh | Invalid drive |
| 12h | No more files |

---

## Standard File Handles

Pre-opened by DOS at program start:

| Handle | Device |
|--------|--------|
| 0 | STDIN |
| 1 | STDOUT |
| 2 | STDERR |
| 3 | STDAUX (COM1) |
| 4 | STDPRN (LPT1) |

---

## Typical File I/O Sequence

```nasm
; 1. Create or open file
mov  ah, 3Ch          ; Create file
xor  cx, cx           ; Normal attribute
lea  dx, filename     ; DS:DX -> ASCIIZ name
int  21h
jc   error
mov  [handle], ax     ; Save handle

; 2. Write to file
mov  ah, 40h          ; Write
mov  bx, [handle]
mov  cx, count        ; Byte count
lea  dx, buffer       ; DS:DX -> data
int  21h
jc   error

; 3. Close file
mov  ah, 3Eh
mov  bx, [handle]
int  21h

; 4. Exit
mov  ax, 4C00h        ; Terminate, return code 0
int  21h
```
