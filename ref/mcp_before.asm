; MCP.COM — Model Context Protocol agent for DOS
; Phase 2: Dual-mode — foreground loop OR TSR (Terminate and Stay Resident)

; Usage: MCP.COM Z:       (foreground mode — polls in tight loop)
; MCP.COM Z: /T    (TSR mode — installs timer hook, returns to DOS)

; Polls Z:\_MAGIC_\__MCP__.TX for commands, writes results to __MCP__.RX,
; updates status in __MCP__.ST.

; Assemble: nasm -f bin -o MCP.COM mcp.asm
; Target:   8086 compatible, raw .COM binary

; Reference: tsr/ref/ — dos-tsr-reentrancy.md, dos-tsr-guide.md,
; dos-tsr-assembly-examples.md, 8086-errata-quirks.md

        CPU 8086                       ; Reject any 186+ instructions
        org 0x100                      ; .COM files load at CS:0100h

        section .text

; ============================================================
; Jump to init code (which is after the resident portion)
; ============================================================
        jmp init

; ============================================================
; RESIDENT CODE — everything from here to resident_end stays
; in memory when running as a TSR.
; ============================================================

; ============================================================
; INT 08h handler — Timer tick (heart of the TSR)

; Fires ~18.2 times per second. Chains to old handler first,
; then (every N ticks) checks InDOS and dispatches commands.

; Ref: dos-tsr-guide.md §4-§11, dos-tsr-reentrancy.md
; ============================================================
int08_handler:
; Chain to original INT 08h handler first (call, not jmp)
        pushf
        call far [cs:old_int08]

; Debounce: only work every TICK_INTERVAL ticks (~2 polls/sec)
        dec byte [cs:tick_count]
        jnz .iret

; Reset tick counter
        mov byte [cs:tick_count], TICK_INTERVAL

; Check reentrancy: our busy flag
        cmp byte [cs:tsr_busy], 0
        jne .iret

; Check InDOS flag — if non-zero, DOS is busy, can't call INT 21h
        push ds
        push bx
        lds bx, [cs:indos_ptr]
        cmp byte [bx], 0               ; InDOS flag
        jnz .defer
        cmp byte [bx-1], 0             ; Critical Error flag (InDOS-1)
        jnz .defer
        pop bx
        pop ds

; Safe to do work — set busy flag
        mov byte [cs:tsr_busy], 1

; Save current stack and switch to our private stack
; Ref: 8086-errata-quirks.md §1 — MOV SS inhibits interrupts for 1 insn
        mov [cs:save_ss_tsr], ss
        mov [cs:save_sp_tsr], sp
        cli
        push cs
        pop ss
        mov sp, tsr_stack_top
        sti

; Save caller's PSP and DTA, install ours
        push ds
        push es

; Get caller's PSP
        mov ah, 0x51
        int 0x21
        mov [cs:save_psp], bx

; Set our PSP
        mov bx, [cs:our_psp]
        mov ah, 0x50
        int 0x21

; Get caller's DTA
        mov ah, 0x2F
        int 0x21
        mov [cs:save_dta_off], bx
        mov [cs:save_dta_seg], es

; Set our DTA (use our cmd_buf area as DTA — we don't use find-first)
        push cs
        pop ds
        mov dx, our_dta
        mov ah, 0x1A
        int 0x21

; Set DS = CS for our code
        push cs
        pop ds
        push cs
        pop es

; === Do the actual work ===
        call poll_once

; Restore caller's DTA
        push ds
        mov ds, [cs:save_dta_seg]
        mov dx, [cs:save_dta_off]
        mov ah, 0x1A
        int 0x21
        pop ds

; Restore caller's PSP
        mov bx, [cs:save_psp]
        mov ah, 0x50
        int 0x21

        pop es
        pop ds

; Restore original stack
        cli
        mov ss, [cs:save_ss_tsr]
        mov sp, [cs:save_sp_tsr]
        sti

; Clear busy flag
        mov byte [cs:tsr_busy], 0

.iret:
        iret

.defer:
; DOS is busy — set deferred flag so we try next tick
        mov byte [cs:tick_count], 1
        pop bx
        pop ds
        iret

; ============================================================
; INT 2Fh handler — Multiplex interrupt
; Our ID: AH = C0h
; AL=00h: Installation check → AL=FFh
; AL=01h: Return resident segment in ES
; ============================================================
int2f_handler:
        cmp ah, 0xC0
        jne .chain
        cmp al, 0x00
        je .installed
        cmp al, 0x01
        je .get_seg
; Unknown subfunction for our ID — just return
        iret
.installed:
        mov al, 0xFF                   ; "installed"
        iret
.get_seg:
        mov es, [cs:our_psp]           ; return our segment
        iret
.chain:
        jmp far [cs:old_int2f]

; ============================================================
; poll_once — Check TX file and dispatch one command
; Called from both foreground loop and TSR timer handler.
; Assumes DS = CS = our segment.
; ============================================================
poll_once:
; Try to open the TX file for read/write so we can truncate via
; the same file descriptor (avoids race with test harness rename)
        mov dx, path_tx
        mov ax, 0x3D02                 ; DOS: open file, read/write
        int 0x21
        jc .no_cmd                     ; CF=1: file missing or can't open

; File opened — AX = file handle
        mov [tx_handle], ax

; Read contents into cmd_buf
        mov bx, [tx_handle]
        mov dx, cmd_buf
        mov cx, CMD_BUF_SIZE - 1
        mov ah, 0x3F                   ; DOS: read file
        int 0x21
        jc .close_tx_ret
        mov [cmd_len], ax

; If we read 0 bytes, close and skip
        cmp word [cmd_len], 0
        je .close_tx_ret

; Truncate TX via same fd: seek to 0 then write 0 bytes.
; This truncates the ORIGINAL inode even if the path was
; renamed by the test harness between read and now.
        mov bx, [tx_handle]
        xor cx, cx
        xor dx, dx
        mov ax, 0x4200                 ; DOS: LSEEK from beginning
        int 0x21
        mov bx, [tx_handle]
        xor cx, cx                     ; write 0 bytes = truncate at pos 0
        mov ah, 0x40
        int 0x21

; Close TX file
        mov bx, [tx_handle]
        mov ah, 0x3E
        int 0x21

; Clean up command
        call clean_cmd

; After cleanup, if cmd_buf is empty (all whitespace), skip
        cmp word [cmd_len], 0
        je .no_cmd
        cmp byte [cmd_buf], 0
        je .no_cmd

; Update status to BUSY
        call write_status_busy

; Debug: write cmd_buf to __MCP__.TT
        call write_debug

; Dispatch the command
        call dispatch

; Update status back to READY
        call write_status_ready

.no_cmd:
        ret

.close_tx_ret:
        mov bx, [tx_handle]
        mov ah, 0x3E
        int 0x21
        ret

; ============================================================
; Command dispatcher
; ============================================================
dispatch:
; --- PING ---
        mov si, cmd_buf
        mov di, cmd_ping
        mov cx, 4
        call str_ncmp_upper
        jne .not_ping
        jmp do_ping
.not_ping:

; --- PEEK ---
        mov si, cmd_buf
        mov di, cmd_peek
        mov cx, 4
        call str_ncmp_upper
        jne .not_peek
        jmp do_peek
.not_peek:

; --- POKE ---
        mov si, cmd_buf
        mov di, cmd_poke
        mov cx, 4
        call str_ncmp_upper
        jne .not_poke
        jmp do_poke
.not_poke:

; --- SENDKEYS ---
        mov si, cmd_buf
        mov di, cmd_sendkeys
        mov cx, 8
        call str_ncmp_upper
        jne .not_sendkeys
        jmp do_sendkeys
.not_sendkeys:

; --- EXEC ---
        mov si, cmd_buf
        mov di, cmd_exec
        mov cx, 4
        call str_ncmp_upper
        jne .not_exec
        jmp do_exec
.not_exec:

; --- SCREEN ---
        mov si, cmd_buf
        mov di, cmd_screen
        mov cx, 6
        call str_ncmp_upper
        jne .not_screen
        jmp do_screen
.not_screen:

; --- MOUSE ---
        mov si, cmd_buf
        mov di, cmd_mouse
        mov cx, 5
        call str_ncmp_upper
        jne .not_mouse
        jmp do_mouse
.not_mouse:

; --- INP ---
        mov si, cmd_buf
        mov di, cmd_inp
        mov cx, 3
        call str_ncmp_upper
        jne .not_inp
        jmp do_inp
.not_inp:

; --- OUTP ---
        mov si, cmd_buf
        mov di, cmd_outp
        mov cx, 4
        call str_ncmp_upper
        jne .not_outp
        jmp do_outp
.not_outp:

; Unknown command
        mov si, resp_err_unknown
        call write_rx
        ret

; ============================================================
; PING
; ============================================================
do_ping:
        mov si, resp_pong
        call write_rx
        ret

; ============================================================
; PEEK — read memory and return hex bytes
; ============================================================
do_peek:
        mov si, cmd_buf
        add si, 5

        call parse_hex16
        jc .peek_err
        mov [peek_seg], ax

        lodsb
        cmp al, ':'
        jne .peek_err

        call parse_hex16
        jc .peek_err
        mov [peek_off], ax

        call skip_spaces

        call parse_dec16
        jc .peek_err
        cmp ax, 128
        ja .peek_err
        mov [peek_len], ax

        push es
        push ds
        mov ax, cs
        mov es, ax
        mov di, resp_buf
        mov al, 'O'
        stosb
        mov al, 'K'
        stosb
        mov al, ' '
        stosb

        mov ax, [peek_seg]
        mov ds, ax
        mov si, [cs:peek_off]
        mov cx, [cs:peek_len]

.peek_loop:
        jcxz .peek_done
        lodsb
        call byte_to_hex
        mov al, ' '
        stosb
        dec cx
        jmp .peek_loop

.peek_done:
        pop ds
        mov byte [es:di], 0
        pop es
        mov si, resp_buf
        call write_rx
        ret

.peek_err:
        mov si, resp_err_syntax
        call write_rx
        ret

; ============================================================
; POKE — write bytes to memory
; ============================================================
do_poke:
        mov si, cmd_buf
        add si, 5

        call parse_hex16
        jc .poke_err
        mov [peek_seg], ax

        lodsb
        cmp al, ':'
        jne .poke_err

        call parse_hex16
        jc .poke_err
        mov [peek_off], ax

        call skip_spaces

        push es
        mov ax, [peek_seg]
        mov es, ax
        mov di, [peek_off]

.poke_loop:
        call skip_spaces
        lodsb
        cmp al, 0
        je .poke_done
        dec si
        call parse_hex8
        jc .poke_done
        stosb
        jmp .poke_loop

.poke_done:
        pop es
        mov si, resp_ok
        call write_rx
        ret

.poke_err:
        pop es
        mov si, resp_err_syntax
        call write_rx
        ret

; ============================================================
; SENDKEYS — inject keystrokes into BIOS keyboard buffer
; ============================================================
do_sendkeys:
        mov si, cmd_buf
        add si, 9

.sk_loop:
        lodsb
        cmp al, 0
        je .sk_done

        cmp al, '~'
        je .sk_enter

        cmp al, '{'
        je .sk_special

; Regular ASCII character
        mov cl, al
        xor ch, ch
        mov ah, 0x05
        int 0x16
        jmp .sk_loop

.sk_enter:
        mov cx, 0x1C0D
        mov ah, 0x05
        int 0x16
        jmp .sk_loop

.sk_special:
        mov di, special_buf
        xor cx, cx
.sk_read_name:
        lodsb
        cmp al, '}'
        je .sk_match
        cmp al, 0
        je .sk_done
        stosb
        inc cx
        cmp cx, 10
        jb .sk_read_name
.sk_skip_brace:
        lodsb
        cmp al, '}'
        je .sk_loop
        cmp al, 0
        je .sk_done
        jmp .sk_skip_brace

.sk_match:
        mov byte [di], 0
        push si

        mov si, special_buf
        mov di, sk_enter_name
        call str_eq_upper
        je .sk_do_enter

        mov si, special_buf
        mov di, sk_esc_name
        call str_eq_upper
        je .sk_do_esc

        mov si, special_buf
        mov di, sk_tab_name
        call str_eq_upper
        je .sk_do_tab

        mov si, special_buf
        mov di, sk_up_name
        call str_eq_upper
        je .sk_do_up

        mov si, special_buf
        mov di, sk_down_name
        call str_eq_upper
        je .sk_do_down

        mov si, special_buf
        mov di, sk_left_name
        call str_eq_upper
        je .sk_do_left

        mov si, special_buf
        mov di, sk_right_name
        call str_eq_upper
        je .sk_do_right

        pop si
        jmp .sk_loop

.sk_do_enter:
        pop si
        mov cx, 0x1C0D
        mov ah, 0x05
        int 0x16
        jmp .sk_loop

.sk_do_esc:
        pop si
        mov cx, 0x011B
        mov ah, 0x05
        int 0x16
        jmp .sk_loop

.sk_do_tab:
        pop si
        mov cx, 0x0F09
        mov ah, 0x05
        int 0x16
        jmp .sk_loop

.sk_do_up:
        pop si
        mov cx, 0x4800
        mov ah, 0x05
        int 0x16
        jmp .sk_loop

.sk_do_down:
        pop si
        mov cx, 0x5000
        mov ah, 0x05
        int 0x16
        jmp .sk_loop

.sk_do_left:
        pop si
        mov cx, 0x4B00
        mov ah, 0x05
        int 0x16
        jmp .sk_loop

.sk_do_right:
        pop si
        mov cx, 0x4D00
        mov ah, 0x05
        int 0x16
        jmp .sk_loop

.sk_done:
        mov si, resp_ok
        call write_rx
        ret

; ============================================================
; EXEC — run a DOS command via COMMAND.COM /C
; ============================================================
do_exec:
        mov si, cmd_buf
        add si, 5

; Build command tail: " /C <command>\r"
        mov di, exec_cmdtail + 1
        mov al, ' '
        stosb
        mov al, '/'
        stosb
        mov al, 'C'
        stosb
        mov al, ' '
        stosb
        xor cx, cx
.exec_copy:
        lodsb
        cmp al, 0
        je .exec_copy_done
        stosb
        inc cx
        cmp cx, 120
        jb .exec_copy
.exec_copy_done:
        mov al, 0x0D
        stosb
        mov ax, di
        sub ax, exec_cmdtail
        dec ax
        mov [exec_cmdtail], al

        mov word [exec_pb+0], 0
        mov word [exec_pb+2], exec_cmdtail
        mov [exec_pb+4], cs
        mov word [exec_pb+6], 0x005C
        mov [exec_pb+8], cs
        mov word [exec_pb+10], 0x006C
        mov [exec_pb+12], cs

        mov [cs:save_ss], ss
        mov [cs:save_sp], sp

        mov dx, comspec_path
        mov bx, exec_pb
        mov ax, 0x4B00
        int 0x21

        cli
        mov ss, [cs:save_ss]
        mov sp, [cs:save_sp]
        sti

        push cs
        pop ds

        jc .exec_fail

        mov si, resp_ok
        call write_rx
        ret

.exec_fail:
        mov si, resp_err_exec
        call write_rx
        ret

; ============================================================
; SCREEN — Read text-mode video memory
; Format: SCREEN [startrow [numrows]]
; Writes directly to RX file to avoid buffer limits.
; ============================================================
do_screen:
; Parse optional startrow and numrows
        mov si, cmd_buf
        add si, 6                      ; skip "SCREEN"
        call skip_spaces

; Default: startrow=0, numrows=25
        xor ax, ax
        mov [scr_start], ax
        mov word [scr_count], 25

; Try to parse startrow
        cmp byte [si], 0
        je .scr_go
        call parse_dec16
        jc .scr_go
        mov [scr_start], ax
        call skip_spaces

; Try to parse numrows
        cmp byte [si], 0
        je .scr_go
        call parse_dec16
        jc .scr_go
        mov [scr_count], ax

.scr_go:
; Clamp: startrow + numrows <= 25
        mov ax, [scr_start]
        add ax, [scr_count]
        cmp ax, 25
        jbe .scr_open
; Clamp numrows
        mov ax, 25
        sub ax, [scr_start]
        mov [scr_count], ax

.scr_open:
; Create/truncate RX file
        mov dx, path_rx
        xor cx, cx
        mov ah, 0x3C
        int 0x21
        jc .scr_fail
        mov [scr_handle], ax

; Write "OK "
        mov bx, [scr_handle]
        mov dx, resp_ok
        mov cx, 2                      ; "OK"
        mov ah, 0x40
        int 0x21
        mov dx, str_space
        mov cx, 1
        mov ah, 0x40
        int 0x21

; Loop over rows
        mov cx, [scr_count]
        mov [scr_remain], cx
        mov ax, [scr_start]
        mov [scr_cur_row], ax

.scr_row_loop:
        cmp word [scr_remain], 0
        je .scr_close

; Calculate video address: B800:(row * 160)
; row * 160 = row * 128 + row * 32 = row << 7 + row << 5
        mov ax, [scr_cur_row]
        mov dx, 160
        mul dx                         ; AX = row * 160 (DX:AX, but row<25 so fits)

; Read 80 characters (skip attributes) into scr_line_buf
        push ds
        push es
        push cs
        pop es
        mov di, scr_line_buf
        mov si, ax                     ; offset in video segment
        mov ax, 0xB800
        mov ds, ax
        mov cx, 80
.scr_read_char:
        lodsb                          ; read character byte
        stosb                          ; store to line buffer
        inc si                         ; skip attribute byte
        dec cx
        jnz .scr_read_char
        pop es
        pop ds

; Trim trailing spaces from scr_line_buf
        mov bx, scr_line_buf + 79
.scr_trim:
        cmp bx, scr_line_buf
        jb .scr_trimmed
        cmp byte [bx], ' '
        jne .scr_trimmed_at
        cmp byte [bx], 0
        je .scr_trimmed_at_zero
        dec bx
        jmp .scr_trim
.scr_trimmed_at_zero:
        dec bx
        jmp .scr_trim
.scr_trimmed_at:
        inc bx                         ; BX points past last non-space
        jmp .scr_write_row
.scr_trimmed:
        mov bx, scr_line_buf           ; all spaces — write nothing

.scr_write_row:
; Write the trimmed row to file
        mov cx, bx
        sub cx, scr_line_buf           ; CX = length of trimmed row
        jcxz .scr_sep                  ; empty row — skip write
        mov dx, scr_line_buf
        mov bx, [scr_handle]
        mov ah, 0x40
        int 0x21

.scr_sep:
; Write "|" separator (except after last row)
        dec word [scr_remain]
        cmp word [scr_remain], 0
        je .scr_close

        mov bx, [scr_handle]
        mov dx, str_pipe
        mov cx, 1
        mov ah, 0x40
        int 0x21

        inc word [scr_cur_row]
        jmp .scr_row_loop

.scr_close:
        mov bx, [scr_handle]
        mov ah, 0x3E
        int 0x21
.scr_fail:
        ret

; ============================================================
; MOUSE — Inject mouse events
; Format: MOUSE x y [buttons]
; ============================================================
do_mouse:
        mov si, cmd_buf
        add si, 5                      ; skip "MOUSE"
        call skip_spaces

; Parse X coordinate (decimal)
        call parse_dec16
        jc .mouse_err
        mov [mouse_x], ax

        call skip_spaces

; Parse Y coordinate (decimal)
        call parse_dec16
        jc .mouse_err
        mov [mouse_y], ax

; Parse optional buttons (default 0)
        call skip_spaces
        xor ax, ax
        cmp byte [si], 0
        je .mouse_set
        call parse_dec16
        jc .mouse_set_zero
        jmp .mouse_set
.mouse_set_zero:
        xor ax, ax
.mouse_set:
        mov [mouse_btn], ax

; Set mouse position via INT 33h AX=0004h
        mov cx, [mouse_x]
        mov dx, [mouse_y]
        mov ax, 0x0004
        int 0x33

; Set button state via custom INT 33h AX=00FFh
        mov bx, [mouse_btn]
        mov ax, 0x00FF
        int 0x33

        mov si, resp_ok
        call write_rx
        ret

.mouse_err:
        mov si, resp_err_syntax
        call write_rx
        ret

; ============================================================
; INP — Read I/O port
; Format: INP port
; port can be decimal or 0xHHHH hex
; ============================================================
do_inp:
        mov si, cmd_buf
        add si, 3                      ; skip "INP"
        call skip_spaces

; Check for "0x" or "0X" prefix
        cmp byte [si], '0'
        jne .inp_dec
        cmp byte [si+1], 'x'
        je .inp_hex
        cmp byte [si+1], 'X'
        je .inp_hex

.inp_dec:
        call parse_dec16
        jc .inp_err
        jmp .inp_do

.inp_hex:
        add si, 2                      ; skip "0x"
        call parse_hex16
        jc .inp_err

.inp_do:
        mov dx, ax                     ; DX = port number
        in al, dx                      ; Read byte from port

; Build response: "OK XX"
        push es
        push cs
        pop es
        mov di, resp_buf
        push ax                        ; save port value
        mov al, 'O'
        stosb
        mov al, 'K'
        stosb
        mov al, ' '
        stosb
        pop ax                         ; restore port value
        call byte_to_hex               ; writes 2 hex chars at ES:DI
        mov byte [es:di], 0
        pop es

        mov si, resp_buf
        call write_rx
        ret

.inp_err:
        mov si, resp_err_syntax
        call write_rx
        ret

; ============================================================
; OUTP — Write I/O port
; Format: OUTP port value
; port and value can be decimal or 0xHH hex
; ============================================================
do_outp:
        mov si, cmd_buf
        add si, 4                      ; skip "OUTP"
        call skip_spaces

; Parse port number
        cmp byte [si], '0'
        jne .outp_port_dec
        cmp byte [si+1], 'x'
        je .outp_port_hex
        cmp byte [si+1], 'X'
        je .outp_port_hex

.outp_port_dec:
        call parse_dec16
        jc .outp_err
        jmp .outp_port_done

.outp_port_hex:
        add si, 2
        call parse_hex16
        jc .outp_err

.outp_port_done:
        mov [outp_port], ax
        call skip_spaces

; Parse value
        cmp byte [si], '0'
        jne .outp_val_dec
        cmp byte [si+1], 'x'
        je .outp_val_hex
        cmp byte [si+1], 'X'
        je .outp_val_hex

.outp_val_dec:
        call parse_dec16
        jc .outp_err
        jmp .outp_val_done

.outp_val_hex:
        add si, 2
; Value might be 2 hex digits
        call parse_hex8
        jc .outp_err
        xor ah, ah                     ; clear high byte

.outp_val_done:
        mov dx, [outp_port]
        out dx, al

        mov si, resp_ok
        call write_rx
        ret

.outp_err:
        mov si, resp_err_syntax
        call write_rx
        ret

; ============================================================
; Utility functions (resident)
; ============================================================

skip_spaces:
        lodsb
        cmp al, ' '
        je skip_spaces
        cmp al, 0x09
        je skip_spaces
        dec si
        ret

str_ncmp_upper:
        push si
        push di
        push cx
.ncmp_loop:
        jcxz .ncmp_eq
        lodsb
        call to_upper
        mov ah, al
        mov al, [di]
        call to_upper
        cmp ah, al
        jne .ncmp_ne
        inc di
        dec cx
        jmp .ncmp_loop
.ncmp_eq:
        pop cx
        pop di
        pop si
        xor ax, ax
        ret
.ncmp_ne:
        pop cx
        pop di
        pop si
        or ax, 1
        ret

str_eq_upper:
        push si
        push di
.eq_loop:
        lodsb
        call to_upper
        mov ah, al
        mov al, [di]
        call to_upper
        cmp ah, al
        jne .eq_ne
        inc di
        cmp ah, 0
        jne .eq_loop
        pop di
        pop si
        xor ax, ax
        ret
.eq_ne:
        pop di
        pop si
        or ax, 1
        ret

to_upper:
        cmp al, 'a'
        jb .done
        cmp al, 'z'
        ja .done
        sub al, 0x20
.done:
        ret

parse_hex16:
; Parse 1-4 hex digits from [SI], result in AX
; Stops at first non-hex char, fails if no digits parsed
        push bx
        push cx
        xor ax, ax
        xor cx, cx                     ; digit count
.ph16_loop:
        mov bl, [si]
        call hex_digit
        jc .ph16_end                   ; not a hex digit — stop
        push cx
        mov cl, 4
        shl ax, cl
        pop cx
        or al, bl
        inc si
        inc cx
        cmp cx, 4
        jb .ph16_loop
.ph16_end:
; Must have parsed at least 1 digit
        jcxz .ph16_fail
        pop cx
        pop bx
        clc
        ret
.ph16_fail:
        pop cx
        pop bx
        stc
        ret

parse_hex8:
        push bx
        mov bl, [si]
        inc si
        call hex_digit
        jc .ph8_fail
        push cx
        mov cl, 4
        shl bl, cl
        pop cx
        mov al, bl
        mov bl, [si]
        inc si
        call hex_digit
        jc .ph8_fail
        or al, bl
        pop bx
        clc
        ret
.ph8_fail:
        pop bx
        stc
        ret

hex_digit:
        cmp bl, '0'
        jb .hd_fail
        cmp bl, '9'
        jbe .hd_09
        and bl, 0xDF
        cmp bl, 'A'
        jb .hd_fail
        cmp bl, 'F'
        ja .hd_fail
        sub bl, 'A' - 10
        clc
        ret
.hd_09:
        sub bl, '0'
        clc
        ret
.hd_fail:
        stc
        ret

parse_dec16:
        push bx
        push cx
        push dx
        xor ax, ax
        xor cx, cx
.pd_loop:
        mov bl, [si]
        cmp bl, '0'
        jb .pd_done
        cmp bl, '9'
        ja .pd_done
        inc si
        inc cx
        mov dx, 10
        push cx
        mul dx
        pop cx
        sub bl, '0'
        xor bh, bh
        add ax, bx
        jmp .pd_loop
.pd_done:
        cmp cx, 0
        je .pd_fail
        pop dx
        pop cx
        pop bx
        clc
        ret
.pd_fail:
        pop dx
        pop cx
        pop bx
        stc
        ret

byte_to_hex:
        push ax
        push cx
        mov cl, 4
        shr al, cl
        pop cx
        call .nibble
        pop ax
        and al, 0x0F
        call .nibble
        ret
.nibble:
        cmp al, 10
        jb .n09
        add al, 'A' - 10
        stosb
        ret
.n09:
        add al, '0'
        stosb
        ret

build_paths:
        mov al, [drive_letter]
        mov [path_tx], al
        mov [path_rx], al
        mov [path_st], al
        mov [path_tt], al
        ret

write_debug:
; Write cmd_buf contents to TT file for debugging
        push si
        mov si, cmd_buf
        xor cx, cx
.dbg_len:
        lodsb
        cmp al, 0
        je .dbg_len_done
        inc cx
        jmp .dbg_len
.dbg_len_done:
        pop si
        push cx                        ; save length

        mov dx, path_tt
        xor cx, cx
        mov ah, 0x3C
        int 0x21
        jc .dbg_fail

        mov bx, ax
        mov dx, cmd_buf
        pop cx                         ; restore length
        mov ah, 0x40
        int 0x21

        mov ah, 0x3E
        int 0x21
        ret
.dbg_fail:
        pop cx
        ret

write_rx:
        push si
        xor cx, cx
.rx_len:
        lodsb
        cmp al, 0
        je .rx_len_done
        inc cx
        jmp .rx_len
.rx_len_done:
        pop si
        mov [rx_len], cx

; Delete existing RX file first (ignore errors)
        mov dx, path_rx
        mov ah, 0x41
        int 0x21

        mov dx, path_rx
        xor cx, cx
        mov ah, 0x3C
        int 0x21
        jc .rx_fail

        mov bx, ax
        mov dx, si
        mov cx, [rx_len]
        mov ah, 0x40
        int 0x21

        mov ah, 0x3E
        int 0x21
.rx_fail:
        ret

write_status_ready:
        mov si, status_ready
        jmp write_st
write_status_busy:
        mov si, status_busy
; fall through

write_st:
        push si
        xor cx, cx
.st_len:
        lodsb
        cmp al, 0
        je .st_len_done
        inc cx
        jmp .st_len
.st_len_done:
        pop si
        mov [rx_len], cx

        mov dx, path_st
        xor cx, cx
        mov ah, 0x3C
        int 0x21
        jc .st_fail

        mov bx, ax
        mov dx, si
        mov cx, [rx_len]
        mov ah, 0x40
        int 0x21

        mov ah, 0x3E
        int 0x21
.st_fail:
        ret

delete_file:
        mov ah, 0x41
        int 0x21
        ret

clean_cmd:
        mov cx, [cmd_len]
        cmp cx, 0
        je .cc_done
        mov bx, cmd_buf
        add bx, cx
        dec bx
.cc_strip:
        cmp bx, cmd_buf
        jb .cc_zero
        mov al, [bx]
        cmp al, 0x0D
        je .cc_trim
        cmp al, 0x0A
        je .cc_trim
        cmp al, ' '
        je .cc_trim
        inc bx
        mov byte [bx], 0
        jmp .cc_done
.cc_trim:
        dec bx
        jmp .cc_strip
.cc_zero:
        mov byte [cmd_buf], 0
        mov word [cmd_len], 0
.cc_done:
        ret

; ============================================================
; Resident data (initialized)
; ============================================================

; File paths — drive letter patched at runtime
path_tx::
        db 'X:\_MAGIC_\__MCP__.TX', 0
path_rx::
        db 'X:\_MAGIC_\__MCP__.RX', 0
path_st::
        db 'X:\_MAGIC_\__MCP__.ST', 0
path_tt::
        db 'X:\_MAGIC_\__MCP__.TT', 0

drive_letter::
        db 'Z'

; Command verb strings
cmd_ping::
        db 'PING'
cmd_peek::
        db 'PEEK'
cmd_poke::
        db 'POKE'
cmd_sendkeys::
        db 'SENDKEYS'
cmd_exec::
        db 'EXEC'
cmd_screen::
        db 'SCREEN'
cmd_mouse::
        db 'MOUSE'
cmd_inp::
        db 'INP'
cmd_outp::
        db 'OUTP'

; String constants for SCREEN output
str_space::
        db ' '
str_pipe::
        db '|'

; Response strings
resp_pong::
        db 'OK PONG', 0
resp_ok::
        db 'OK', 0
resp_err_unknown::
        db 'ERR UNKNOWN_COMMAND', 0
resp_err_syntax::
        db 'ERR SYNTAX', 0
resp_err_exec::
        db 'ERR EXEC_FAILED', 0

; Status strings
status_ready::
        db 'READY', 0
status_busy::
        db 'BUSY', 0

; SENDKEYS special key names
sk_enter_name::
        db 'ENTER', 0
sk_esc_name::
        db 'ESC', 0
sk_tab_name::
        db 'TAB', 0
sk_up_name::
        db 'UP', 0
sk_down_name::
        db 'DOWN', 0
sk_left_name::
        db 'LEFT', 0
sk_right_name::
        db 'RIGHT', 0

; COMSPEC path for EXEC
comspec_path::
        db 'C:\COMMAND.COM', 0

; TSR tick interval: ~2 polls/sec at 18.2 Hz
        TICK_INTERVAL equ 9

; ============================================================
; Resident data — TSR state variables
; ============================================================

; Saved interrupt vectors
old_int08::
        dd 0
old_int2f::
        dd 0

; InDOS flag far pointer (set during init)
indos_ptr::
        dd 0

; Our PSP segment (set during init)
our_psp::
        dw 0

; TSR flags
tsr_busy::
        db 0
tick_count::
        db TICK_INTERVAL

; Stack save area for TSR handler
save_ss_tsr::
        dw 0
save_sp_tsr::
        dw 0

; PSP/DTA save area for TSR handler
save_psp::
        dw 0
save_dta_off::
        dw 0
save_dta_seg::
        dw 0

; ============================================================
; Resident BSS — variables used by command handlers
; ============================================================
        CMD_BUF_SIZE equ 256

tx_handle:
        resw 1
cmd_buf:
        resb CMD_BUF_SIZE
cmd_len:
        resw 1
rx_len:
        resw 1
resp_buf:
        resb 512

; PEEK/POKE scratch
peek_seg:
        resw 1
peek_off:
        resw 1
peek_len:
        resw 1

; SENDKEYS scratch
special_buf:
        resb 16

; EXEC scratch
exec_cmdtail:
        resb 128
exec_pb:
        resb 14
save_ss:
        resw 1
save_sp:
        resw 1

; SCREEN scratch
scr_start:
        resw 1
scr_count:
        resw 1
scr_remain:
        resw 1
scr_cur_row:
        resw 1
scr_handle:
        resw 1
scr_line_buf:
        resb 80

; MOUSE scratch
mouse_x:
        resw 1
mouse_y:
        resw 1
mouse_btn:
        resw 1

; OUTP scratch
outp_port:
        resw 1

; DTA for TSR (128 bytes, standard DTA size)
our_dta:
        resb 128

; ============================================================
; Private stack for TSR handler (256 bytes)
; ============================================================
        resb 256
tsr_stack_top:

; ============================================================
; === resident_end — everything above stays in memory ===
; ============================================================
resident_end:

; ============================================================
; INIT CODE — only runs once, freed after going resident
; ============================================================
init:
; --- Initialize BSS ---
        xor ax, ax
        mov [tx_handle], ax
        mov [cmd_len], ax
        mov [rx_len], ax

; --- Save our PSP ---
        mov [our_psp], cs

; --- Shrink memory for EXEC support ---
        mov bx, end_of_init
        add bx, 256 + 15
        push cx
        mov cl, 4
        shr bx, cl
        pop cx
        mov ah, 0x4A
        int 0x21

; --- Parse command line for drive letter ---
        mov si, 0x0081
        call skip_spaces
        lodsb
        cmp al, 0x0D
        je .no_drive
        and al, 0xDF
        cmp al, 'A'
        jb .no_drive
        cmp al, 'Z'
        ja .no_drive
        mov [drive_letter], al
        lodsb
        cmp al, ':'
        jne .no_drive

; Build file paths
        call build_paths

; --- Check for /T flag ---
        call skip_spaces
        lodsb
        cmp al, '/'
        jne .foreground_mode
        lodsb
        and al, 0xDF                   ; uppercase
        cmp al, 'T'
        je .tsr_mode

.foreground_mode:
; --- Foreground mode (Phase 1 behavior) ---
        mov dx, msg_banner_fg
        mov ah, 0x09
        int 0x21

; Write initial status
        call write_status_ready

.fg_poll_loop:
; Check for Ctrl+C
        mov ah, 0x0B
        int 0x21

; Wait for next timer tick (~55ms) to avoid racing with
; the test harness on file I/O. HLT halts until interrupt.
        sti
        hlt

; Poll for commands
        call poll_once

        jmp .fg_poll_loop

.no_drive:
        mov dx, msg_usage
        mov ah, 0x09
        int 0x21
        mov ax, 0x4C01
        int 0x21

.tsr_mode:
; --- TSR mode ---

; Check if already installed via INT 2Fh multiplex
        mov ax, 0xC000                 ; AH=C0h, AL=00h (installation check)
        int 0x2F
        cmp al, 0xFF
        je .already_installed

; Get InDOS flag address
        mov ah, 0x34
        int 0x21
        mov [indos_ptr], bx
        mov [indos_ptr+2], es

; Hook INT 08h (timer tick)
        mov ax, 0x3508                 ; Get INT 08h vector
        int 0x21
        mov [old_int08], bx
        mov [old_int08+2], es

        mov dx, int08_handler
        mov ax, 0x2508                 ; Set INT 08h vector
        int 0x21

; Hook INT 2Fh (multiplex)
        mov ax, 0x352F                 ; Get INT 2Fh vector
        int 0x21
        mov [old_int2f], bx
        mov [old_int2f+2], es

        mov dx, int2f_handler
        mov ax, 0x252F                 ; Set INT 2Fh vector
        int 0x21

; Write READY status
        call write_status_ready

; Print TSR banner
        mov dx, msg_banner_tsr
        mov ah, 0x09
        int 0x21

; Go resident — keep everything up to resident_end
; DX = number of paragraphs to keep (from start of PSP)
        mov dx, resident_end + 15
        push cx
        mov cl, 4
        shr dx, cl
        pop cx
        mov ax, 0x3100                 ; INT 21h/31h: Keep Process, return code 0
        int 0x21

.already_installed:
        mov dx, msg_already
        mov ah, 0x09
        int 0x21
        mov ax, 0x4C00
        int 0x21

; ============================================================
; Init-only data (freed after going resident)
; ============================================================

msg_banner_fg::
        db 'MCP v0.2 - Model Context Protocol for DOS', 0x0D, 0x0A
        db 'Polling for commands... (Ctrl+C to exit)', 0x0D, 0x0A, '$'
msg_banner_tsr::
        db 'MCP v0.2 - Installed as TSR', 0x0D, 0x0A, '$'
msg_usage::
        db 'Usage: MCP.COM <drive:> [/T]', 0x0D, 0x0A
        db ' /T = install as TSR', 0x0D, 0x0A, '$'
msg_already::
        db 'MCP is already installed.', 0x0D, 0x0A, '$'

end_of_init:
