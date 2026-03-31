; WIN-MCP Stub — minimal DOS .COM that emulates Win16 MCP IPC
; Used to validate the DOSBox-X test harness before we have a
; real Win16 app. Polls __WIN__.TX, dispatches commands, writes
; responses to __WIN__.RX.
;
; Build: nasm -f bin -o WINSTUB.COM stub.asm
; Run:   WINSTUB.COM Z:
;        (Z: is the drive containing _MAGIC_ directory)

        CPU     8086
        org     100h

start:
        ; Parse command line for drive letter
        mov     si, 81h                 ; PSP command tail
        call    skip_spaces_s
        cmp     byte [si], 0Dh
        je      .use_default
        ; Read drive letter
        mov     al, [si]
        ; Uppercase
        cmp     al, 'a'
        jb      .store_drive
        cmp     al, 'z'
        ja      .store_drive
        sub     al, 20h
.store_drive:
        mov     [magic_drive], al
        jmp     .drive_done
.use_default:
        mov     byte [magic_drive], 'C'
.drive_done:

        ; Build file paths with drive letter
        mov     al, [magic_drive]
        mov     [tx_path], al
        mov     [rx_path], al
        mov     [st_path], al
        mov     [tw_path], al

        ; Write READY to __WIN__.ST
        call    write_ready

        ; Main poll loop
main_loop:
        ; Check for Ctrl-C / keypress
        mov     ah, 0Bh
        int     21h
        cmp     al, 0FFh
        je      .check_key
        jmp     .poll
.check_key:
        mov     ah, 08h
        int     21h
        cmp     al, 03h                 ; Ctrl-C
        je      exit_prog

.poll:
        ; Try to open __WIN__.TX
        mov     dx, tx_path
        mov     ax, 3D00h               ; open read-only
        int     21h
        jc      .no_tx                  ; file doesn't exist

        ; File exists — read command
        mov     bx, ax                  ; file handle
        mov     dx, cmd_buf
        mov     cx, 255
        mov     ah, 3Fh
        int     21h
        push    ax                      ; save bytes read
        mov     ah, 3Eh                 ; close file
        int     21h

        ; Delete TX file
        mov     dx, tx_path
        mov     ah, 41h
        int     21h

        ; Null-terminate and strip CR/LF from command
        pop     cx                      ; bytes read
        mov     si, cmd_buf
        add     si, cx
.strip_trail:
        cmp     si, cmd_buf
        je      .stripped
        dec     si
        cmp     byte [si], 0Dh
        je      .zero_it
        cmp     byte [si], 0Ah
        je      .zero_it
        cmp     byte [si], ' '
        je      .zero_it
        inc     si
        jmp     .stripped
.zero_it:
        mov     byte [si], 0
        jmp     .strip_trail
.stripped:
        mov     byte [si], 0

        ; Dispatch command
        call    dispatch

.no_tx:
        ; Small delay — INT 15h/AX=8600h or just loop
        ; Use INT 21h/2Ch to busy-wait ~100ms by checking timer
        mov     ah, 2Ch
        int     21h
        mov     [wait_start], dl        ; hundredths
.wait_loop:
        mov     ah, 2Ch
        int     21h
        sub     dl, [wait_start]
        cmp     dl, 10                  ; ~100ms
        jb      .wait_loop

        jmp     main_loop

exit_prog:
        ; Delete ST file
        mov     dx, st_path
        mov     ah, 41h
        int     21h
        mov     ax, 4C00h
        int     21h

; ============================================================
; Write READY to __WIN__.ST
; ============================================================
write_ready:
        mov     dx, st_path
        mov     cx, 0                   ; normal attributes
        mov     ah, 3Ch                 ; create file
        int     21h
        jc      .wr_ret
        mov     bx, ax
        mov     dx, str_ready
        mov     cx, 5                   ; "READY"
        mov     ah, 40h
        int     21h
        mov     ah, 3Eh
        int     21h
.wr_ret:
        ret

; ============================================================
; Write response string (DS:SI, len CX) to __WIN__.RX
; Uses atomic write via __WIN__.TW then rename
; ============================================================
write_rx:
        ; Create temp file __WIN__.TW
        push    cx
        push    si
        mov     dx, tw_path
        mov     cx, 0
        mov     ah, 3Ch
        int     21h
        pop     si
        pop     cx
        jc      .wrx_ret
        mov     bx, ax
        mov     dx, si
        mov     ah, 40h
        int     21h
        mov     ah, 3Eh
        int     21h

        ; Delete existing RX if present
        mov     dx, rx_path
        mov     ah, 41h
        int     21h                     ; ignore error

        ; Rename TW -> RX
        mov     dx, tw_path
        mov     di, rx_path
        mov     ah, 56h
        int     21h
.wrx_ret:
        ret

; ============================================================
; Dispatch command in cmd_buf
; ============================================================
dispatch:
        ; Compare prefix "WIN META " (9 chars)
        mov     si, cmd_buf
        mov     di, str_win_meta
        mov     cx, 9
        call    str_ncmp_upper
        jne     .not_meta

        ; Sub-dispatch meta commands
        mov     si, cmd_buf
        add     si, 9
        ; PING
        mov     di, str_ping
        mov     cx, 4
        call    str_ncmp_upper
        jne     .not_ping
        ; Respond OK PONG
        mov     si, resp_pong
        mov     cx, resp_pong_len
        call    write_rx
        ret
.not_ping:
        ; VERSION
        mov     di, str_version
        mov     cx, 7
        call    str_ncmp_upper
        jne     .not_version
        mov     si, resp_version
        mov     cx, resp_version_len
        call    write_rx
        ret
.not_version:
        ; STATUS
        mov     di, str_status
        mov     cx, 6
        call    str_ncmp_upper
        jne     .not_status
        mov     si, resp_status
        mov     cx, resp_status_len
        call    write_rx
        ret
.not_status:
        ; QUIT
        mov     di, str_quit
        mov     cx, 4
        call    str_ncmp_upper
        jne     .meta_unknown
        ; Write OK, then exit
        mov     si, resp_ok
        mov     cx, 2
        call    write_rx
        jmp     exit_prog
.meta_unknown:
        jmp     .unknown

.not_meta:
        ; Check bare "META " (5 chars) — also accept without WIN prefix
        mov     si, cmd_buf
        mov     di, str_meta_bare
        mov     cx, 5
        call    str_ncmp_upper
        jne     .unknown

        mov     si, cmd_buf
        add     si, 5
        mov     di, str_ping
        mov     cx, 4
        call    str_ncmp_upper
        jne     .bare_not_ping
        mov     si, resp_pong
        mov     cx, resp_pong_len
        call    write_rx
        ret
.bare_not_ping:
        mov     di, str_version
        mov     cx, 7
        call    str_ncmp_upper
        jne     .bare_not_version
        mov     si, resp_version
        mov     cx, resp_version_len
        call    write_rx
        ret
.bare_not_version:
        mov     di, str_status
        mov     cx, 6
        call    str_ncmp_upper
        jne     .bare_not_status
        mov     si, resp_status
        mov     cx, resp_status_len
        call    write_rx
        ret
.bare_not_status:
        mov     di, str_quit
        mov     cx, 4
        call    str_ncmp_upper
        jne     .unknown
        mov     si, resp_ok
        mov     cx, 2
        call    write_rx
        jmp     exit_prog

.unknown:
        mov     si, resp_unknown
        mov     cx, resp_unknown_len
        call    write_rx
        ret

; ============================================================
; str_ncmp_upper — compare [SI] vs [DI] for CX bytes, case-insensitive
; Sets ZF if equal
; ============================================================
str_ncmp_upper:
        push    si
        push    di
        push    cx
.cmp_loop:
        mov     al, [si]
        mov     ah, [di]
        ; uppercase AL
        cmp     al, 'a'
        jb      .c1
        cmp     al, 'z'
        ja      .c1
        sub     al, 20h
.c1:
        ; uppercase AH
        cmp     ah, 'a'
        jb      .c2
        cmp     ah, 'z'
        ja      .c2
        sub     ah, 20h
.c2:
        cmp     al, ah
        jne     .cmp_ne
        inc     si
        inc     di
        dec     cx
        jnz     .cmp_loop
        ; equal
        pop     cx
        pop     di
        pop     si
        xor     ax, ax                  ; ZF=1
        ret
.cmp_ne:
        pop     cx
        pop     di
        pop     si
        or      ax, 1                   ; ZF=0
        ret

; ============================================================
; skip_spaces_s — advance SI past spaces
; ============================================================
skip_spaces_s:
        cmp     byte [si], ' '
        jne     .done
        inc     si
        jmp     skip_spaces_s
.done:
        ret

; ============================================================
; Data
; ============================================================

magic_drive:    db  'Z'

; File paths — drive letter is first byte, patched at startup
tx_path:        db  'Z:\_MAGIC_\__WIN__.TX', 0
rx_path:        db  'Z:\_MAGIC_\__WIN__.RX', 0
st_path:        db  'Z:\_MAGIC_\__WIN__.ST', 0
tw_path:        db  'Z:\_MAGIC_\__WIN__.TW', 0

; Command strings
str_win_meta:   db  'WIN META '
str_meta_bare:  db  'META '
str_ping:       db  'PING'
str_version:    db  'VERSION'
str_status:     db  'STATUS'
str_quit:       db  'QUIT'

; Response strings
resp_pong:      db  'OK PONG'
resp_pong_len   equ $ - resp_pong

resp_version:   db  'OK WINMCP/0.1-STUB META'
resp_version_len equ $ - resp_version

resp_status:    db  'OK CMDS=0 STUB=YES'
resp_status_len equ $ - resp_status

resp_ok:        db  'OK'

resp_unknown:   db  'ERR UNKNOWN_COMMAND'
resp_unknown_len equ $ - resp_unknown

str_ready:      db  'READY'

wait_start:     db  0

; ============================================================
; BSS — command buffer
; ============================================================
section .bss
cmd_buf:        resb 256
