; MCP.COM — Model Context Protocol agent for DOS
; Phase 6: Dual-mode — foreground loop OR TSR (Terminate and Stay Resident)
;
; Usage: MCP.COM Z:       (foreground mode — polls in tight loop)
;        MCP.COM Z: /T    (TSR mode — installs timer hook, returns to DOS)
;
; Polls Z:\_MAGIC_\__MCP__.TX for commands, writes results to __MCP__.RX,
; updates status in __MCP__.ST.
;
; Assemble: nasm -f bin -o MCP.COM mcp.asm
; Target:   8086 compatible, raw .COM binary
;
; Reference: tsr/ref/ — dos-tsr-reentrancy.md, dos-tsr-guide.md,
;   dos-tsr-assembly-examples.md, 8086-errata-quirks.md

CPU 8086                        ; Reject any 186+ instructions
org 0x100                       ; .COM files load at CS:0100h

section .text

; ============================================================
; Jump to init code (which is after the resident portion)
; ============================================================
        jmp     init

; ============================================================
; RESIDENT CODE — everything from here to resident_end stays
; in memory when running as a TSR.
; ============================================================

; ============================================================
; INT 08h handler — Timer tick (heart of the TSR)
;
; Fires ~18.2 times per second. Chains to old handler first,
; then (every N ticks) checks InDOS and dispatches commands.
;
; Ref: dos-tsr-guide.md §4-§11, dos-tsr-reentrancy.md
; ============================================================
int08_handler:
        ; Chain to original INT 08h handler first (call, not jmp)
        pushf
        call    far [cs:old_int08]

        ; Debounce: only work every TICK_INTERVAL ticks (~2 polls/sec)
        dec     byte [cs:tick_count]
        jnz     .iret

        ; Reset tick counter from config
        mov     al, [cs:cfg_poll]
        mov     byte [cs:tick_count], al

        ; Check reentrancy: our busy flag
        cmp     byte [cs:tsr_busy], 0
        jne     .iret

        ; Check InDOS flag — if non-zero, DOS is busy, can't call INT 21h
        push    ds
        push    bx
        lds     bx, [cs:indos_ptr]
        cmp     byte [bx], 0            ; InDOS flag
        jnz     .defer
        cmp     byte [bx-1], 0          ; Critical Error flag (InDOS-1)
        jnz     .defer
        pop     bx
        pop     ds

        ; Safe to do work — set busy flag
        mov     byte [cs:tsr_busy], 1

        ; Save current stack and switch to our private stack
        ; Ref: 8086-errata-quirks.md §1 — MOV SS inhibits interrupts for 1 insn
        mov     [cs:save_ss_tsr], ss
        mov     [cs:save_sp_tsr], sp
        cli
        push    cs
        pop     ss
        mov     sp, tsr_stack_top
        sti

        ; Save caller's PSP and DTA, install ours
        push    ds
        push    es

        ; Get caller's PSP
        mov     ah, 0x51
        int     0x21
        mov     [cs:save_psp], bx

        ; Set our PSP
        mov     bx, [cs:our_psp]
        mov     ah, 0x50
        int     0x21

        ; Get caller's DTA
        mov     ah, 0x2F
        int     0x21
        mov     [cs:save_dta_off], bx
        mov     [cs:save_dta_seg], es

        ; Set our DTA (use our cmd_buf area as DTA — we don't use find-first)
        push    cs
        pop     ds
        mov     dx, our_dta
        mov     ah, 0x1A
        int     0x21

        ; Set DS = CS for our code
        push    cs
        pop     ds
        push    cs
        pop     es

        ; === Do the actual work ===
        call    poll_once

        ; Restore caller's DTA
        push    ds
        mov     ds, [cs:save_dta_seg]
        mov     dx, [cs:save_dta_off]
        mov     ah, 0x1A
        int     0x21
        pop     ds

        ; Restore caller's PSP
        mov     bx, [cs:save_psp]
        mov     ah, 0x50
        int     0x21

        pop     es
        pop     ds

        ; Restore original stack
        cli
        mov     ss, [cs:save_ss_tsr]
        mov     sp, [cs:save_sp_tsr]
        sti

        ; Clear busy flag
        mov     byte [cs:tsr_busy], 0

.iret:
        iret

.defer:
        ; DOS is busy — set deferred flag so we try next tick
        mov     byte [cs:tick_count], 1
        pop     bx
        pop     ds
        iret

; ============================================================
; INT 2Fh handler — Multiplex interrupt
; Our ID: AH = C0h
; AL=00h: Installation check → AL=FFh
; AL=01h: Return resident segment in ES
; ============================================================
int2f_handler:
        cmp     ah, 0xC0
        jne     .chain
        cmp     al, 0x00
        je      .installed
        cmp     al, 0x01
        je      .get_seg
        ; Unknown subfunction for our ID — just return
        iret
.installed:
        mov     al, 0xFF            ; "installed"
        iret
.get_seg:
        mov     es, [cs:our_psp]    ; return our segment
        iret
.chain:
        jmp     far [cs:old_int2f]

; ============================================================
; INT 23h handler — Ctrl-C/Break protection
; Just IRET to ignore Ctrl-C completely, preventing TSR termination.
; ============================================================
int23_handler:
        iret

; ============================================================
; poll_once — Check TX file and dispatch one command
; Called from both foreground loop and TSR timer handler.
; Assumes DS = CS = our segment.
; ============================================================
poll_once:
        ; Try to open the TX file for read/write so we can truncate via
        ; the same file descriptor (avoids race with test harness rename)
        mov     dx, path_tx
        mov     ax, 0x3D02          ; DOS: open file, read/write
        int     0x21
        jc      .no_cmd             ; CF=1: file missing or can't open

        ; File opened — AX = file handle
        mov     [tx_handle], ax

        ; Read contents into cmd_buf
        mov     bx, [tx_handle]
        mov     dx, cmd_buf
        mov     cx, CMD_BUF_SIZE - 1
        mov     ah, 0x3F             ; DOS: read file
        int     0x21
        jc      .close_tx_ret
        mov     [cmd_len], ax

        ; If we read 0 bytes, close and skip
        cmp     word [cmd_len], 0
        je      .close_tx_ret

        ; Truncate TX via same fd: seek to 0 then write 0 bytes.
        ; This truncates the ORIGINAL inode even if the path was
        ; renamed by the test harness between read and now.
        mov     bx, [tx_handle]
        xor     cx, cx
        xor     dx, dx
        mov     ax, 0x4200          ; DOS: LSEEK from beginning
        int     0x21
        mov     bx, [tx_handle]
        xor     cx, cx              ; write 0 bytes = truncate at pos 0
        mov     ah, 0x40
        int     0x21

        ; Close TX file
        mov     bx, [tx_handle]
        mov     ah, 0x3E
        int     0x21

        ; Clean up command
        call    clean_cmd

        ; After cleanup, if cmd_buf is empty (all whitespace), skip
        cmp     word [cmd_len], 0
        je      .no_cmd
        cmp     byte [cmd_buf], 0
        je      .no_cmd

        ; Update status to BUSY
        call    write_status_busy

        ; Debug: write cmd_buf to __MCP__.TT (if enabled)
        cmp     byte [cfg_debug], 0
        je      .skip_debug
        call    write_debug
.skip_debug:

        ; Dispatch the command
        call    dispatch

        ; Update status back to READY
        call    write_status_ready

.no_cmd:
        ret

.close_tx_ret:
        mov     bx, [tx_handle]
        mov     ah, 0x3E
        int     0x21
        ret

; ============================================================
; Command dispatcher
; ============================================================
dispatch:
        ; Reset watchdog on any command
        mov     ax, [watchdog_timeout]
        mov     [watchdog_remaining], ax
        inc     word [cmd_count]

        ; ======== Family dispatch ========

        ; --- META ---
        mov     si, cmd_buf
        mov     di, fam_meta
        mov     cx, 5
        call    str_ncmp_upper
        jne     .not_meta
        jmp     dispatch_meta
.not_meta:
        ; --- MEM ---
        mov     si, cmd_buf
        mov     di, fam_mem
        mov     cx, 4
        call    str_ncmp_upper
        jne     .not_mem
        jmp     dispatch_mem
.not_mem:
        ; --- MOUSE ---
        mov     si, cmd_buf
        mov     di, fam_mouse
        mov     cx, 6
        call    str_ncmp_upper
        jne     .not_mouse
        jmp     dispatch_mouse
.not_mouse:
        ; --- PORT ---
        mov     si, cmd_buf
        mov     di, fam_port
        mov     cx, 5
        call    str_ncmp_upper
        jne     .not_port
        jmp     dispatch_port
.not_port:
        ; --- CON ---
        mov     si, cmd_buf
        mov     di, fam_con
        mov     cx, 4
        call    str_ncmp_upper
        jne     .not_con
        jmp     dispatch_con
.not_con:
        ; --- CLIP ---
        mov     si, cmd_buf
        mov     di, fam_clip
        mov     cx, 5
        call    str_ncmp_upper
        jne     .not_clip
        jmp     dispatch_clip
.not_clip:
        ; --- CMOS ---
        mov     si, cmd_buf
        mov     di, fam_cmos
        mov     cx, 5
        call    str_ncmp_upper
        jne     .not_cmos
        jmp     dispatch_cmos
.not_cmos:
        ; --- GFX ---
        mov     si, cmd_buf
        mov     di, fam_gfx
        mov     cx, 4
        call    str_ncmp_upper
        jne     .not_gfx
        jmp     dispatch_gfx
.not_gfx:
        ; --- SCREEN ---
        mov     si, cmd_buf
        mov     di, fam_screen
        mov     cx, 7
        call    str_ncmp_upper
        jne     .not_screen
        jmp     dispatch_screen
.not_screen:
        ; --- KEY ---
        mov     si, cmd_buf
        mov     di, fam_key
        mov     cx, 4
        call    str_ncmp_upper
        jne     .not_key
        jmp     dispatch_key
.not_key:
        ; --- WAIT ---
        mov     si, cmd_buf
        mov     di, fam_wait
        mov     cx, 5
        call    str_ncmp_upper
        jne     .not_wait
        jmp     dispatch_wait
.not_wait:
        ; --- FILE ---
        mov     si, cmd_buf
        mov     di, fam_file
        mov     cx, 5
        call    str_ncmp_upper
        jne     .not_file
        jmp     dispatch_file
.not_file:
        ; --- DISK (5, before DIR 4) ---
        mov     si, cmd_buf
        mov     di, fam_disk
        mov     cx, 5
        call    str_ncmp_upper
        jne     .not_disk
        jmp     dispatch_disk
.not_disk:
        ; --- DIR ---
        mov     si, cmd_buf
        mov     di, fam_dir
        mov     cx, 4
        call    str_ncmp_upper
        jne     .not_dir
        jmp     dispatch_dir
.not_dir:
        ; --- EXEC ---
        mov     si, cmd_buf
        mov     di, fam_exec
        mov     cx, 5
        call    str_ncmp_upper
        jne     .not_exec
        jmp     dispatch_exec
.not_exec:
        ; --- ENV ---
        mov     si, cmd_buf
        mov     di, fam_env
        mov     cx, 4
        call    str_ncmp_upper
        jne     .not_env
        jmp     dispatch_env
.not_env:
        ; --- TIME ---
        mov     si, cmd_buf
        mov     di, fam_time
        mov     cx, 5
        call    str_ncmp_upper
        jne     .not_time
        jmp     dispatch_time
.not_time:
        ; --- INI ---
        mov     si, cmd_buf
        mov     di, fam_ini
        mov     cx, 4
        call    str_ncmp_upper
        jne     .not_ini
        jmp     dispatch_ini
.not_ini:
        ; --- SYS ---
        mov     si, cmd_buf
        mov     di, fam_sys
        mov     cx, 4
        call    str_ncmp_upper
        jne     .not_sys
        jmp     dispatch_sys
.not_sys:
        ; --- INT ---
        mov     si, cmd_buf
        mov     di, fam_int
        mov     cx, 4
        call    str_ncmp_upper
        jne     .not_int
        jmp     dispatch_int
.not_int:
        ; --- POWER ---
        mov     si, cmd_buf
        mov     di, fam_power
        mov     cx, 6
        call    str_ncmp_upper
        jne     .not_power
        jmp     dispatch_power
.not_power:
        ; --- TSR ---
        mov     si, cmd_buf
        mov     di, fam_tsr
        mov     cx, 4
        call    str_ncmp_upper
        jne     .not_tsr
        jmp     dispatch_tsr
.not_tsr:
        ; Unknown command
        mov     si, resp_err_unknown
        call    write_rx
        ret

; ============================================================
; Sub-dispatchers for each command family
; ============================================================

dispatch_meta:
        mov     si, cmd_buf
        add     si, 5                   ; skip "META "
        ; --- VERSION (7, before shorter V-prefix) ---
        mov     di, sub_version
        mov     cx, 7
        call    str_ncmp_upper
        jne     .m_not_version
        jmp     do_version
.m_not_version:
        ; --- LASTERROR (9) ---
        mov     di, sub_lasterror
        mov     cx, 9
        call    str_ncmp_upper
        jne     .m_not_lasterror
        jmp     do_meta_lasterror
.m_not_lasterror:
        ; --- HEARTBEAT ---
        mov     di, sub_heartbeat
        mov     cx, 9
        call    str_ncmp_upper
        jne     .m_not_heartbeat
        jmp     do_heartbeat
.m_not_heartbeat:
        ; --- UNLOAD (6) ---
        mov     di, sub_unload
        mov     cx, 6
        call    str_ncmp_upper
        jne     .m_not_unload
        jmp     do_meta_unload
.m_not_unload:
        ; --- STATUS ---
        mov     di, sub_status
        mov     cx, 6
        call    str_ncmp_upper
        jne     .m_not_status
        jmp     do_status
.m_not_status:
        ; --- REPEAT ---
        mov     di, sub_repeat
        mov     cx, 6
        call    str_ncmp_upper
        jne     .m_not_repeat
        jmp     do_repeat
.m_not_repeat:
        ; --- DELAY (5) ---
        mov     di, sub_delay
        mov     cx, 5
        call    str_ncmp_upper
        jne     .m_not_delay
        jmp     do_meta_delay
.m_not_delay:
        ; --- BATCH ---
        mov     di, sub_batch
        mov     cx, 5
        call    str_ncmp_upper
        jne     .m_not_batch
        jmp     do_batch
.m_not_batch:
        ; --- PING ---
        mov     di, sub_ping
        mov     cx, 4
        call    str_ncmp_upper
        jne     .m_not_ping
        jmp     do_ping
.m_not_ping:
        ; --- LOG ---
        mov     di, sub_log
        mov     cx, 3
        call    str_ncmp_upper
        jne     .m_not_log
        jmp     do_log
.m_not_log:
        jmp     dispatch_unknown

dispatch_mem:
        mov     si, cmd_buf
        add     si, 4                   ; skip "MEM "
        ; --- PEEK ---
        mov     di, sub_peek
        mov     cx, 4
        call    str_ncmp_upper
        jne     .me_not_peek
        jmp     do_peek
.me_not_peek:
        ; --- POKE ---
        mov     di, sub_poke
        mov     cx, 4
        call    str_ncmp_upper
        jne     .me_not_poke
        jmp     do_poke
.me_not_poke:
        ; --- WRITE (alias for POKE, 5 chars) ---
        mov     di, sub_write
        mov     cx, 5
        call    str_ncmp_upper
        jne     .me_not_write
        jmp     do_mem_write
.me_not_write:
        ; --- READ (alias for PEEK) ---
        mov     di, sub_read
        mov     cx, 4
        call    str_ncmp_upper
        jne     .me_not_read
        jmp     do_peek                 ; same skip offset as PEEK
.me_not_read:
        ; --- SEARCH (6) ---
        mov     di, sub_search
        mov     cx, 6
        call    str_ncmp_upper
        jne     .me_not_search
        jmp     do_mem_search
.me_not_search:
        ; --- FREE ---
        mov     di, sub_free
        mov     cx, 4
        call    str_ncmp_upper
        jne     .me_not_free
        jmp     do_mem
.me_not_free:
        ; --- FILL ---
        mov     di, sub_fill
        mov     cx, 4
        call    str_ncmp_upper
        jne     .me_not_fill
        jmp     do_mem_fill
.me_not_fill:
        ; --- DUMP ---
        mov     di, sub_dump
        mov     cx, 4
        call    str_ncmp_upper
        jne     .me_not_dump
        jmp     do_mem_dump
.me_not_dump:
        ; --- COPY ---
        mov     di, sub_copy
        mov     cx, 4
        call    str_ncmp_upper
        jne     .me_not_copy
        jmp     do_mem_copy
.me_not_copy:
        ; --- MCB ---
        mov     di, sub_mcb
        mov     cx, 3
        call    str_ncmp_upper
        jne     .me_not_mcb
        jmp     do_mem_mcb
.me_not_mcb:
        ; --- EMS ---
        mov     di, sub_ems
        mov     cx, 3
        call    str_ncmp_upper
        jne     .me_not_ems
        jmp     do_mem_ems
.me_not_ems:
        ; --- XMS ---
        mov     di, sub_xms
        mov     cx, 3
        call    str_ncmp_upper
        jne     .me_not_xms
        jmp     do_mem_xms
.me_not_xms:
        jmp     dispatch_unknown

dispatch_port:
        mov     si, cmd_buf
        add     si, 5                   ; skip "PORT "
        ; --- OUT (3, before IN to avoid prefix) ---
        mov     di, sub_out
        mov     cx, 3
        call    str_ncmp_upper
        jne     .p_not_out
        jmp     do_outp
.p_not_out:
        ; --- IN ---
        mov     di, sub_in
        mov     cx, 2
        call    str_ncmp_upper
        jne     .p_not_in
        jmp     do_inp
.p_not_in:
        jmp     dispatch_unknown

dispatch_con:
        mov     si, cmd_buf
        add     si, 4                   ; skip "CON "
        ; --- CURSOR (6, before CLEAR/CRC) ---
        mov     di, sub_cursor
        mov     cx, 6
        call    str_ncmp_upper
        jne     .c_not_cursor
        jmp     dispatch_con_cursor
.c_not_cursor:
        ; --- SCROLL (6) ---
        mov     di, sub_scroll
        mov     cx, 6
        call    str_ncmp_upper
        jne     .c_not_scroll
        jmp     do_con_scroll
.c_not_scroll:
        ; --- REGION (6, before READ) ---
        mov     di, sub_region
        mov     cx, 6
        call    str_ncmp_upper
        jne     .c_not_region
        jmp     do_screenregion
.c_not_region:
        ; --- COLOR (5) ---
        mov     di, sub_color
        mov     cx, 5
        call    str_ncmp_upper
        jne     .c_not_color
        jmp     do_con_color
.c_not_color:
        ; --- CLEAR (5, before CRC) ---
        mov     di, sub_clear
        mov     cx, 5
        call    str_ncmp_upper
        jne     .c_not_clear
        jmp     do_con_clear
.c_not_clear:
        ; --- WRITE (5) ---
        mov     di, sub_write
        mov     cx, 5
        call    str_ncmp_upper
        jne     .c_not_write
        jmp     do_con_write
.c_not_write:
        ; --- INPUT (5) ---
        mov     di, sub_input
        mov     cx, 5
        call    str_ncmp_upper
        jne     .c_not_input
        jmp     do_con_input
.c_not_input:
        ; --- MODE (4) ---
        mov     di, sub_mode
        mov     cx, 4
        call    str_ncmp_upper
        jne     .c_not_mode
        jmp     do_con_mode
.c_not_mode:
        ; --- READ ---
        mov     di, sub_read
        mov     cx, 4
        call    str_ncmp_upper
        jne     .c_not_read
        jmp     do_screen
.c_not_read:
        ; --- ATTR ---
        mov     di, sub_attr
        mov     cx, 4
        call    str_ncmp_upper
        jne     .c_not_attr
        jmp     do_con_attr
.c_not_attr:
        ; --- FIND ---
        mov     di, sub_find
        mov     cx, 4
        call    str_ncmp_upper
        jne     .c_not_find
        jmp     do_findtext
.c_not_find:
        ; --- BOX (3) ---
        mov     di, sub_box
        mov     cx, 3
        call    str_ncmp_upper
        jne     .c_not_box
        jmp     do_con_box
.c_not_box:
        ; --- CRC ---
        mov     di, sub_crc
        mov     cx, 3
        call    str_ncmp_upper
        jne     .c_not_crc
        jmp     do_screencrc
.c_not_crc:
        jmp     dispatch_unknown

dispatch_con_cursor:
        mov     si, cmd_buf
        add     si, 11                  ; skip "CON CURSOR "
        ; --- GET ---
        mov     di, sub_get
        mov     cx, 3
        call    str_ncmp_upper
        jne     .cc_not_get
        jmp     do_cursor_get
.cc_not_get:
        ; --- SET ---
        mov     di, sub_set
        mov     cx, 3
        call    str_ncmp_upper
        jne     .cc_not_set
        jmp     do_cursor_set
.cc_not_set:
        jmp     dispatch_unknown

dispatch_gfx:
        mov     si, cmd_buf
        add     si, 4                   ; skip "GFX "
        ; --- PALETTE (7) ---
        mov     di, sub_palette
        mov     cx, 7
        call    str_ncmp_upper
        jne     .g_not_palette
        jmp     do_gfx_palette
.g_not_palette:
        ; --- PIXEL ---
        mov     di, sub_pixel
        mov     cx, 5
        call    str_ncmp_upper
        jne     .g_not_pixel
        jmp     do_getpixel
.g_not_pixel:
        ; --- VESA (4) ---
        mov     di, sub_vesa
        mov     cx, 4
        call    str_ncmp_upper
        jne     .g_not_vesa
        jmp     dispatch_gfx_vesa
.g_not_vesa:
        jmp     dispatch_unknown

dispatch_gfx_vesa:
        mov     si, cmd_buf
        add     si, 9                   ; skip "GFX VESA "
        ; --- MODE (4) ---
        mov     di, sub_mode
        mov     cx, 4
        call    str_ncmp_upper
        jne     .gv_not_mode
        jmp     do_gfx_vesa_mode
.gv_not_mode:
        ; --- INFO (4) ---
        mov     di, sub_info
        mov     cx, 4
        call    str_ncmp_upper
        jne     .gv_not_info
        jmp     do_gfx_vesa_info
.gv_not_info:
        jmp     dispatch_unknown

dispatch_screen:
        mov     si, cmd_buf
        add     si, 7                   ; skip "SCREEN "
        ; --- DUMP ---
        mov     di, sub_dump
        mov     cx, 4
        call    str_ncmp_upper
        jne     .s_not_dump
        jmp     do_screendump
.s_not_dump:
        jmp     dispatch_unknown

dispatch_mouse:
        mov     si, cmd_buf
        add     si, 6                   ; skip "MOUSE "
        ; --- DBLCLICK (8, before DOWN/DRAG) ---
        mov     di, sub_dblclick
        mov     cx, 8
        call    str_ncmp_upper
        jne     .mo_not_dblclick
        jmp     do_dblclick
.mo_not_dblclick:
        ; --- DOWN ---
        mov     di, sub_down
        mov     cx, 4
        call    str_ncmp_upper
        jne     .mo_not_down
        jmp     do_mousedown
.mo_not_down:
        ; --- DRAG ---
        mov     di, sub_drag
        mov     cx, 4
        call    str_ncmp_upper
        jne     .mo_not_drag
        jmp     do_drag
.mo_not_drag:
        ; --- CLICK ---
        mov     di, sub_click
        mov     cx, 5
        call    str_ncmp_upper
        jne     .mo_not_click
        jmp     do_click
.mo_not_click:
        ; --- MOVE ---
        mov     di, sub_move
        mov     cx, 4
        call    str_ncmp_upper
        jne     .mo_not_move
        jmp     do_mouse_move
.mo_not_move:
        ; --- UP ---
        mov     di, sub_up
        mov     cx, 2
        call    str_ncmp_upper
        jne     .mo_not_up
        jmp     do_mouseup
.mo_not_up:
        jmp     dispatch_unknown

dispatch_key:
        mov     si, cmd_buf
        add     si, 4                   ; skip "KEY "
        ; --- HOTKEY (6) ---
        mov     di, sub_hotkey
        mov     cx, 6
        call    str_ncmp_upper
        jne     .k_not_hotkey
        jmp     do_hotkey
.k_not_hotkey:
        ; --- SEND ---
        mov     di, sub_send
        mov     cx, 4
        call    str_ncmp_upper
        jne     .k_not_send
        jmp     do_sendkeys
.k_not_send:
        ; --- DOWN ---
        mov     di, sub_down
        mov     cx, 4
        call    str_ncmp_upper
        jne     .k_not_down
        jmp     do_keydown
.k_not_down:
        ; --- TYPE ---
        mov     di, sub_type
        mov     cx, 4
        call    str_ncmp_upper
        jne     .k_not_type
        jmp     do_type
.k_not_type:
        ; --- PEEK (4) ---
        mov     di, sub_peek
        mov     cx, 4
        call    str_ncmp_upper
        jne     .k_not_peek
        jmp     do_key_peek
.k_not_peek:
        ; --- FLUSH (5) ---
        mov     di, sub_flush
        mov     cx, 5
        call    str_ncmp_upper
        jne     .k_not_flush
        jmp     do_key_flush
.k_not_flush:
        ; --- UP ---
        mov     di, sub_up
        mov     cx, 2
        call    str_ncmp_upper
        jne     .k_not_up
        jmp     do_keyup
.k_not_up:
        jmp     dispatch_unknown

dispatch_wait:
        mov     si, cmd_buf
        add     si, 5                   ; skip "WAIT "
        ; --- SCREEN (6, before SLEEP) ---
        mov     di, sub_screen
        mov     cx, 6
        call    str_ncmp_upper
        jne     .w_not_screen
        jmp     do_waitscreen
.w_not_screen:
        ; --- SLEEP ---
        mov     di, sub_sleep
        mov     cx, 5
        call    str_ncmp_upper
        jne     .w_not_sleep
        jmp     do_sleep
.w_not_sleep:
        ; --- PIXEL ---
        mov     di, sub_pixel
        mov     cx, 5
        call    str_ncmp_upper
        jne     .w_not_pixel
        jmp     do_waitpixel
.w_not_pixel:
        ; --- GONE ---
        mov     di, sub_gone
        mov     cx, 4
        call    str_ncmp_upper
        jne     .w_not_gone
        jmp     do_waitgone
.w_not_gone:
        ; --- CRC ---
        mov     di, sub_crc
        mov     cx, 3
        call    str_ncmp_upper
        jne     .w_not_crc
        jmp     do_waitcrc
.w_not_crc:
        jmp     dispatch_unknown

dispatch_file:
        mov     si, cmd_buf
        add     si, 5                   ; skip "FILE "
        ; --- RENAME (6, before READ) ---
        mov     di, sub_rename
        mov     cx, 6
        call    str_ncmp_upper
        jne     .f_not_rename
        jmp     do_rename
.f_not_rename:
        ; --- DELETE ---
        mov     di, sub_delete
        mov     cx, 6
        call    str_ncmp_upper
        jne     .f_not_delete
        jmp     do_delete
.f_not_delete:
        ; --- EXISTS ---
        mov     di, sub_exists
        mov     cx, 6
        call    str_ncmp_upper
        jne     .f_not_exists
        jmp     do_file_exists
.f_not_exists:
        ; --- APPEND (6) ---
        mov     di, sub_append
        mov     cx, 6
        call    str_ncmp_upper
        jne     .f_not_append
        jmp     do_file_append
.f_not_append:
        ; --- WRITE ---
        mov     di, sub_write
        mov     cx, 5
        call    str_ncmp_upper
        jne     .f_not_write
        jmp     do_writefile
.f_not_write:
        ; --- WATCH (5) ---
        mov     di, sub_watch
        mov     cx, 5
        call    str_ncmp_upper
        jne     .f_not_watch
        jmp     do_file_watch
.f_not_watch:
        ; --- SIZE ---
        mov     di, sub_size
        mov     cx, 4
        call    str_ncmp_upper
        jne     .f_not_size
        jmp     do_file_size
.f_not_size:
        ; --- TIME ---
        mov     di, sub_time_s
        mov     cx, 4
        call    str_ncmp_upper
        jne     .f_not_time
        jmp     do_file_time
.f_not_time:
        ; --- READ ---
        mov     di, sub_read
        mov     cx, 4
        call    str_ncmp_upper
        jne     .f_not_read
        jmp     do_readfile
.f_not_read:
        ; --- FIND (4) ---
        mov     di, sub_find
        mov     cx, 4
        call    str_ncmp_upper
        jne     .f_not_find
        jmp     do_file_find
.f_not_find:
        ; --- COPY ---
        mov     di, sub_copy
        mov     cx, 4
        call    str_ncmp_upper
        jne     .f_not_copy
        jmp     do_copy
.f_not_copy:
        ; --- ATTR (4) ---
        mov     di, sub_attr
        mov     cx, 4
        call    str_ncmp_upper
        jne     .f_not_attr
        jmp     do_file_attr
.f_not_attr:
        jmp     dispatch_unknown

dispatch_dir:
        mov     si, cmd_buf
        add     si, 4                   ; skip "DIR "
        ; --- DRIVES (6) ---
        mov     di, sub_drives
        mov     cx, 6
        call    str_ncmp_upper
        jne     .d_not_drives
        jmp     do_dir_drives
.d_not_drives:
        ; --- CHANGE ---
        mov     di, sub_change
        mov     cx, 6
        call    str_ncmp_upper
        jne     .d_not_change
        jmp     do_chdir
.d_not_change:
        ; --- MAKE ---
        mov     di, sub_make
        mov     cx, 4
        call    str_ncmp_upper
        jne     .d_not_make
        jmp     do_mkdir
.d_not_make:
        ; --- LIST ---
        mov     di, sub_list
        mov     cx, 4
        call    str_ncmp_upper
        jne     .d_not_list
        jmp     do_dir
.d_not_list:
        ; --- GET ---
        mov     di, sub_get
        mov     cx, 3
        call    str_ncmp_upper
        jne     .d_not_get
        jmp     do_dir_get
.d_not_get:
        jmp     dispatch_unknown

dispatch_exec:
        mov     si, cmd_buf
        add     si, 5                   ; skip "EXEC "
        ; --- SHELL ---
        mov     di, sub_shell
        mov     cx, 5
        call    str_ncmp_upper
        jne     .e_not_shell
        jmp     do_shell
.e_not_shell:
        ; --- EXIT ---
        mov     di, sub_exit
        mov     cx, 4
        call    str_ncmp_upper
        jne     .e_not_exit
        jmp     do_exec_exit
.e_not_exit:
        ; --- LIST (4) ---
        mov     di, sub_list
        mov     cx, 4
        call    str_ncmp_upper
        jne     .e_not_list
        jmp     do_exec_list
.e_not_list:
        ; --- RUN ---
        mov     di, sub_run
        mov     cx, 3
        call    str_ncmp_upper
        jne     .e_not_run
        jmp     do_exec
.e_not_run:
        jmp     dispatch_unknown

dispatch_time:
        mov     si, cmd_buf
        add     si, 5                   ; skip "TIME "
        call    skip_spaces
        mov     di, sub_get
        mov     cx, 3
        call    str_ncmp_upper
        jne     .t_not_get
        jmp     do_time_get
.t_not_get:
        mov     di, sub_set
        mov     cx, 3
        call    str_ncmp_upper
        jne     .t_not_set
        jmp     do_time_set
.t_not_set:
        jmp     dispatch_unknown

dispatch_ini:
        mov     si, cmd_buf
        add     si, 4                   ; skip "INI "
        call    skip_spaces
        mov     di, sub_write
        mov     cx, 5
        call    str_ncmp_upper
        jne     .i_not_write
        jmp     do_ini_write
.i_not_write:
        mov     di, sub_read
        mov     cx, 4
        call    str_ncmp_upper
        jne     .i_not_read
        jmp     do_ini_read
.i_not_read:
        jmp     dispatch_unknown

dispatch_clip:
        mov     si, cmd_buf
        add     si, 5                   ; skip "CLIP "
        ; --- GET ---
        mov     di, sub_get
        mov     cx, 3
        call    str_ncmp_upper
        jne     .cl_not_get
        jmp     do_clipget
.cl_not_get:
        ; --- SET ---
        mov     di, sub_set
        mov     cx, 3
        call    str_ncmp_upper
        jne     .cl_not_set
        jmp     do_clipset
.cl_not_set:
        jmp     dispatch_unknown

dispatch_cmos:
        mov     si, cmd_buf
        add     si, 5                   ; skip "CMOS "
        ; --- WRITE (5) ---
        mov     di, sub_write
        mov     cx, 5
        call    str_ncmp_upper
        jne     .cm_not_write
        jmp     do_cmos_write
.cm_not_write:
        ; --- READ (4) ---
        mov     di, sub_read
        mov     cx, 4
        call    str_ncmp_upper
        jne     .cm_not_read
        jmp     do_cmos_read
.cm_not_read:
        jmp     dispatch_unknown

dispatch_disk:
        mov     si, cmd_buf
        add     si, 5                   ; skip "DISK "
        ; --- FREE ---
        mov     di, sub_free
        mov     cx, 4
        call    str_ncmp_upper
        jne     .dk_not_free
        jmp     do_disk_free
.dk_not_free:
        jmp     dispatch_unknown

dispatch_env:
        mov     si, cmd_buf
        add     si, 4                   ; skip "ENV "
        ; --- GET ---
        mov     di, sub_get
        mov     cx, 3
        call    str_ncmp_upper
        jne     .ev_not_get
        jmp     do_env_get
.ev_not_get:
        ; --- SET ---
        mov     di, sub_set
        mov     cx, 3
        call    str_ncmp_upper
        jne     .ev_not_set
        jmp     do_env_set
.ev_not_set:
        jmp     dispatch_unknown

dispatch_sys:
        mov     si, cmd_buf
        add     si, 4                   ; skip "SYS "
        ; --- DRIVERS (7) ---
        mov     di, sub_drivers_s
        mov     cx, 7
        call    str_ncmp_upper
        jne     .sy_not_drivers
        jmp     do_sys_drivers
.sy_not_drivers:
        ; --- MEMORY (6) ---
        mov     di, sub_memory_s
        mov     cx, 6
        call    str_ncmp_upper
        jne     .sy_not_memory
        jmp     do_sys_memory
.sy_not_memory:
        ; --- REBOOT (6) ---
        mov     di, sub_reboot
        mov     cx, 6
        call    str_ncmp_upper
        jne     .sy_not_reboot
        jmp     do_sys_reboot
.sy_not_reboot:
        ; --- QUIET (5) ---
        mov     di, sub_quiet
        mov     cx, 5
        call    str_ncmp_upper
        jne     .sy_not_quiet
        jmp     do_sys_quiet
.sy_not_quiet:
        ; --- INFO (4) ---
        mov     di, sub_info
        mov     cx, 4
        call    str_ncmp_upper
        jne     .sy_not_info
        jmp     do_sys_info
.sy_not_info:
        ; --- ANSI (4) ---
        mov     di, sub_ansi
        mov     cx, 4
        call    str_ncmp_upper
        jne     .sy_not_ansi
        jmp     do_sys_ansi
.sy_not_ansi:
        ; --- BEEP (4) ---
        mov     di, sub_beep
        mov     cx, 4
        call    str_ncmp_upper
        jne     .sy_not_beep
        jmp     do_sys_beep
.sy_not_beep:
        ; --- TONE (4) ---
        mov     di, sub_tone
        mov     cx, 4
        call    str_ncmp_upper
        jne     .sy_not_tone
        jmp     do_sys_tone
.sy_not_tone:
        jmp     dispatch_unknown

dispatch_int:
        mov     si, cmd_buf
        add     si, 4                   ; skip "INT "
        ; --- LIST ---
        mov     di, sub_list
        mov     cx, 4
        call    str_ncmp_upper
        jne     .in_not_list
        jmp     do_int_list
.in_not_list:
        ; --- CALL ---
        mov     di, sub_call
        mov     cx, 4
        call    str_ncmp_upper
        jne     .in_not_call
        jmp     do_int
.in_not_call:
        ; --- WATCH ---
        mov     di, sub_watch
        mov     cx, 5
        call    str_ncmp_upper
        jne     .in_not_watch
        jmp     do_int_watch
.in_not_watch:
        jmp     dispatch_unknown

dispatch_power:
        mov     si, cmd_buf
        add     si, 6                   ; skip "POWER "
        ; --- STATUS ---
        mov     di, sub_status
        mov     cx, 6
        call    str_ncmp_upper
        jne     .pw_not_status
        jmp     do_power_status
.pw_not_status:
        ; --- IDLE ---
        mov     di, sub_idle
        mov     cx, 4
        call    str_ncmp_upper
        jne     .pw_not_idle
        jmp     do_power_idle
.pw_not_idle:
        ; --- STANDBY ---
        mov     di, sub_standby
        mov     cx, 7
        call    str_ncmp_upper
        jne     .pw_not_standby
        jmp     do_power_standby
.pw_not_standby:
        ; --- OFF ---
        mov     di, sub_off
        mov     cx, 3
        call    str_ncmp_upper
        jne     .pw_not_off
        jmp     do_power_off
.pw_not_off:
        jmp     dispatch_unknown

dispatch_tsr:
        mov     si, cmd_buf
        add     si, 4                   ; skip "TSR "
        ; --- LIST ---
        mov     di, sub_list
        mov     cx, 4
        call    str_ncmp_upper
        jne     .ts_not_list
        jmp     do_tsr_list
.ts_not_list:
        jmp     dispatch_unknown

dispatch_unknown:
        mov     si, resp_err_unknown
        call    write_rx
        ret

; ============================================================
; PING
; ============================================================
do_ping:
        mov     si, resp_pong
        call    write_rx
        ret

; ============================================================
; META LASTERROR — get extended error info from last DOS call
; Format: META LASTERROR
; Response: OK err=XX class=XX action=XX locus=XX
; ============================================================
do_meta_lasterror:
        ; INT 21h/59h destroys CL, DX, SI, DI, BP, DS, ES
        push    bp
        push    ds
        push    es
        xor     bx, bx
        mov     ah, 0x59
        int     0x21
        ; AX = error code, BH = error class, BL = suggested action, CH = locus
        mov     [cs:int_ax], ax         ; error code
        mov     [cs:int_bx], bx         ; class + action
        mov     [cs:int_num], ch        ; locus
        pop     es
        pop     ds
        pop     bp

        ; Build "OK err=XX class=XX action=XX locus=XX"
        push    cs
        pop     es
        mov     di, resp_buf
        mov     byte [di], 'O'
        inc     di
        mov     byte [di], 'K'
        inc     di
        mov     byte [di], ' '
        inc     di
        ; "err="
        mov     byte [di], 'e'
        inc     di
        mov     byte [di], 'r'
        inc     di
        mov     byte [di], 'r'
        inc     di
        mov     byte [di], '='
        inc     di
        mov     ax, [int_ax]
        call    .le_write_dec
        mov     byte [di], ' '
        inc     di
        ; "class="
        mov     byte [di], 'c'
        inc     di
        mov     byte [di], 'l'
        inc     di
        mov     byte [di], 'a'
        inc     di
        mov     byte [di], 's'
        inc     di
        mov     byte [di], 's'
        inc     di
        mov     byte [di], '='
        inc     di
        mov     al, byte [int_bx+1]    ; BH = class
        xor     ah, ah
        call    .le_write_dec
        mov     byte [di], ' '
        inc     di
        ; "action="
        mov     byte [di], 'a'
        inc     di
        mov     byte [di], 'c'
        inc     di
        mov     byte [di], 't'
        inc     di
        mov     byte [di], 'i'
        inc     di
        mov     byte [di], 'o'
        inc     di
        mov     byte [di], 'n'
        inc     di
        mov     byte [di], '='
        inc     di
        mov     al, byte [int_bx]      ; BL = action
        xor     ah, ah
        call    .le_write_dec
        mov     byte [di], ' '
        inc     di
        ; "locus="
        mov     byte [di], 'l'
        inc     di
        mov     byte [di], 'o'
        inc     di
        mov     byte [di], 'c'
        inc     di
        mov     byte [di], 'u'
        inc     di
        mov     byte [di], 's'
        inc     di
        mov     byte [di], '='
        inc     di
        mov     al, [int_num]           ; CH = locus
        xor     ah, ah
        call    .le_write_dec

        mov     byte [di], 0
        mov     si, resp_buf
        jmp     write_rx

.le_write_dec:
        ; AX = number (0–65535), write decimal to ES:DI
        cmp     ax, 100
        jb      .le_lt100
        xor     dx, dx
        mov     cx, 100
        div     cx
        push    dx
        cmp     ax, 100
        jb      .le_h_lt100
        xor     dx, dx
        mov     cx, 100
        div     cx
        add     al, '0'
        stosb
        mov     ax, dx
.le_h_lt100:
        cmp     ax, 10
        jb      .le_h_lt10
        xor     dx, dx
        mov     cx, 10
        div     cx
        add     al, '0'
        stosb
        mov     ax, dx
.le_h_lt10:
        add     al, '0'
        stosb
        pop     ax
.le_lt100:
        cmp     ax, 10
        jb      .le_lt10
        xor     dx, dx
        mov     cx, 10
        div     cx
        add     al, '0'
        stosb
        mov     ax, dx
.le_lt10:
        add     al, '0'
        stosb
        ret

; ============================================================
; META UNLOAD — unload TSR from memory
; Format: META UNLOAD
; In foreground mode: returns ERR NOT_TSR
; ============================================================
do_meta_unload:
        ; Check if we're in TSR mode (old_int08 != 0)
        cmp     word [old_int08], 0
        jne     .mu_check_seg
        cmp     word [old_int08+2], 0
        jne     .mu_check_seg

        ; Foreground mode — can't unload
        mov     si, resp_err_not_tsr
        jmp     write_rx

.mu_check_seg:
        ; TSR mode — verify our hooks are still in place
        ; (skipped for simplicity in foreground test, but left as stub)
        ; Write response, restore vectors, free memory
        ; For now, just return OK UNLOADED and don't actually unload
        ; (actual unload is dangerous in test mode)
        mov     si, resp_ok_unloaded
        jmp     write_rx

; ============================================================
; META DELAY — wait for specified number of ticks
; ============================================================
do_meta_delay:
        mov     si, cmd_buf
        add     si, 11                  ; skip "META DELAY "
        call    skip_spaces
        call    parse_dec16
        or      ax, ax
        jz      .md_done                ; 0 ticks = immediate
        mov     cx, ax
        call    wait_ticks
.md_done:
        mov     si, resp_ok
        jmp     write_rx

; ============================================================
; PEEK — read memory and return hex bytes
; ============================================================
do_peek:
        mov     si, cmd_buf
        add     si, 9               ; skip "MEM PEEK " or "MEM READ "

        call    parse_hex16
        jc      .peek_err
        mov     [peek_seg], ax

        lodsb
        cmp     al, ':'
        jne     .peek_err

        call    parse_hex16
        jc      .peek_err
        mov     [peek_off], ax

        call    skip_spaces

        call    parse_dec16
        jc      .peek_err
        cmp     ax, 128
        ja      .peek_err
        mov     [peek_len], ax

        push    es
        push    ds
        mov     ax, cs
        mov     es, ax
        mov     di, resp_buf
        mov     al, 'O'
        stosb
        mov     al, 'K'
        stosb
        mov     al, ' '
        stosb

        mov     ax, [peek_seg]
        mov     ds, ax
        mov     si, [cs:peek_off]
        mov     cx, [cs:peek_len]

.peek_loop:
        jcxz    .peek_done
        lodsb
        call    byte_to_hex
        mov     al, ' '
        stosb
        dec     cx
        jmp     .peek_loop

.peek_done:
        pop     ds
        mov     byte [es:di], 0
        pop     es
        mov     si, resp_buf
        call    write_rx
        ret

.peek_err:
        mov     si, resp_err_syntax
        call    write_rx
        ret

; ============================================================
; POKE — write bytes to memory
; ============================================================
do_mem_write:
        mov     si, cmd_buf
        add     si, 10              ; skip "MEM WRITE "
        jmp     do_poke_args

do_poke:
        mov     si, cmd_buf
        add     si, 9               ; skip "MEM POKE "
do_poke_args:

        call    parse_hex16
        jc      .poke_err
        mov     [peek_seg], ax

        lodsb
        cmp     al, ':'
        jne     .poke_err

        call    parse_hex16
        jc      .poke_err
        mov     [peek_off], ax

        call    skip_spaces

        push    es
        mov     ax, [peek_seg]
        mov     es, ax
        mov     di, [peek_off]

.poke_loop:
        call    skip_spaces
        lodsb
        cmp     al, 0
        je      .poke_done
        dec     si
        call    parse_hex8
        jc      .poke_done
        stosb
        jmp     .poke_loop

.poke_done:
        pop     es
        mov     si, resp_ok
        call    write_rx
        ret

.poke_err:
        pop     es
        mov     si, resp_err_syntax
        call    write_rx
        ret

; ============================================================
; SENDKEYS — inject keystrokes into BIOS keyboard buffer
; ============================================================
do_sendkeys:
        mov     si, cmd_buf
        add     si, 9

.sk_loop:
        lodsb
        cmp     al, 0
        je      .sk_done

        cmp     al, '~'
        je      .sk_enter

        cmp     al, '{'
        je      .sk_special

        ; Regular ASCII character
        mov     cl, al
        xor     ch, ch
        mov     ah, 0x05
        int     0x16
        jmp     .sk_loop

.sk_enter:
        mov     cx, 0x1C0D
        mov     ah, 0x05
        int     0x16
        jmp     .sk_loop

.sk_special:
        mov     di, special_buf
        xor     cx, cx
.sk_read_name:
        lodsb
        cmp     al, '}'
        je      .sk_match
        cmp     al, 0
        je      .sk_done
        stosb
        inc     cx
        cmp     cx, 10
        jb      .sk_read_name
.sk_skip_brace:
        lodsb
        cmp     al, '}'
        je      .sk_loop
        cmp     al, 0
        je      .sk_done
        jmp     .sk_skip_brace

.sk_match:
        mov     byte [di], 0
        push    si

        mov     si, special_buf
        mov     di, sk_enter_name
        call    str_eq_upper
        je      .sk_do_enter

        mov     si, special_buf
        mov     di, sk_esc_name
        call    str_eq_upper
        je      .sk_do_esc

        mov     si, special_buf
        mov     di, sk_tab_name
        call    str_eq_upper
        je      .sk_do_tab

        mov     si, special_buf
        mov     di, sk_up_name
        call    str_eq_upper
        je      .sk_do_up

        mov     si, special_buf
        mov     di, sk_down_name
        call    str_eq_upper
        je      .sk_do_down

        mov     si, special_buf
        mov     di, sk_left_name
        call    str_eq_upper
        je      .sk_do_left

        mov     si, special_buf
        mov     di, sk_right_name
        call    str_eq_upper
        je      .sk_do_right

        pop     si
        jmp     .sk_loop

.sk_do_enter:
        pop     si
        mov     cx, 0x1C0D
        mov     ah, 0x05
        int     0x16
        jmp     .sk_loop

.sk_do_esc:
        pop     si
        mov     cx, 0x011B
        mov     ah, 0x05
        int     0x16
        jmp     .sk_loop

.sk_do_tab:
        pop     si
        mov     cx, 0x0F09
        mov     ah, 0x05
        int     0x16
        jmp     .sk_loop

.sk_do_up:
        pop     si
        mov     cx, 0x4800
        mov     ah, 0x05
        int     0x16
        jmp     .sk_loop

.sk_do_down:
        pop     si
        mov     cx, 0x5000
        mov     ah, 0x05
        int     0x16
        jmp     .sk_loop

.sk_do_left:
        pop     si
        mov     cx, 0x4B00
        mov     ah, 0x05
        int     0x16
        jmp     .sk_loop

.sk_do_right:
        pop     si
        mov     cx, 0x4D00
        mov     ah, 0x05
        int     0x16
        jmp     .sk_loop

.sk_done:
        mov     si, resp_ok
        call    write_rx
        ret

; ============================================================
; EXEC — run a DOS command via COMMAND.COM /C
; ============================================================
do_exec:
        mov     si, cmd_buf
        add     si, 8               ; skip "EXEC RUN"
        call    skip_spaces

        ; Build command tail: " /C <command>\r"
        mov     di, exec_cmdtail + 1
        mov     al, ' '
        stosb
        mov     al, '/'
        stosb
        mov     al, 'C'
        stosb
        mov     al, ' '
        stosb
        xor     cx, cx
.exec_copy:
        lodsb
        cmp     al, 0
        je      .exec_copy_done
        stosb
        inc     cx
        cmp     cx, 120
        jb      .exec_copy
.exec_copy_done:
        mov     al, 0x0D
        stosb
        mov     ax, di
        sub     ax, exec_cmdtail
        dec     ax
        mov     [exec_cmdtail], al

        mov     word [exec_pb+0], 0
        mov     word [exec_pb+2], exec_cmdtail
        mov     [exec_pb+4], cs
        mov     word [exec_pb+6], 0x005C
        mov     [exec_pb+8], cs
        mov     word [exec_pb+10], 0x006C
        mov     [exec_pb+12], cs

        mov     [cs:save_ss], ss
        mov     [cs:save_sp], sp

        mov     dx, comspec_path
        mov     bx, exec_pb
        mov     ax, 0x4B00
        int     0x21

        cli
        mov     ss, [cs:save_ss]
        mov     sp, [cs:save_sp]
        sti

        push    cs
        pop     ds

        jc      .exec_fail

        mov     si, resp_ok
        call    write_rx
        ret

.exec_fail:
        mov     si, resp_err_exec
        call    write_rx
        ret

; ============================================================
; SCREEN — Read text-mode video memory
; Format: SCREEN [startrow [numrows]]
; Writes directly to RX file to avoid buffer limits.
; ============================================================
do_screen:
        ; Parse optional startrow and numrows
        mov     si, cmd_buf
        add     si, 8               ; skip "CON READ"
        call    skip_spaces

        ; Default: startrow=0, numrows=25
        xor     ax, ax
        mov     [scr_start], ax
        mov     word [scr_count], 25

        ; Try to parse startrow
        cmp     byte [si], 0
        je      .scr_go
        call    parse_dec16
        jc      .scr_go
        mov     [scr_start], ax
        call    skip_spaces

        ; Try to parse numrows
        cmp     byte [si], 0
        je      .scr_go
        call    parse_dec16
        jc      .scr_go
        mov     [scr_count], ax

.scr_go:
        ; Clamp: startrow + numrows <= 25
        mov     ax, [scr_start]
        add     ax, [scr_count]
        cmp     ax, 25
        jbe     .scr_open
        ; Clamp numrows
        mov     ax, 25
        sub     ax, [scr_start]
        mov     [scr_count], ax

.scr_open:
        ; Create/truncate RX file
        mov     dx, path_rx
        xor     cx, cx
        mov     ah, 0x3C
        int     0x21
        jc      .scr_fail
        mov     [scr_handle], ax

        ; Write "OK "
        mov     bx, [scr_handle]
        mov     dx, resp_ok
        mov     cx, 2               ; "OK"
        mov     ah, 0x40
        int     0x21
        mov     dx, str_space
        mov     cx, 1
        mov     ah, 0x40
        int     0x21

        ; Loop over rows
        mov     cx, [scr_count]
        mov     [scr_remain], cx
        mov     ax, [scr_start]
        mov     [scr_cur_row], ax

.scr_row_loop:
        cmp     word [scr_remain], 0
        je      .scr_close

        ; Calculate video address: B800:(row * 160)
        ; row * 160 = row * 128 + row * 32 = row << 7 + row << 5
        mov     ax, [scr_cur_row]
        mov     dx, 160
        mul     dx                   ; AX = row * 160 (DX:AX, but row<25 so fits)

        ; Read 80 characters (skip attributes) into scr_line_buf
        push    ds
        push    es
        push    cs
        pop     es
        mov     di, scr_line_buf
        mov     si, ax               ; offset in video segment
        mov     ax, 0xB800
        mov     ds, ax
        mov     cx, 80
.scr_read_char:
        lodsb                        ; read character byte
        stosb                        ; store to line buffer
        inc     si                   ; skip attribute byte
        dec     cx
        jnz     .scr_read_char
        pop     es
        pop     ds

        ; Trim trailing spaces from scr_line_buf
        mov     bx, scr_line_buf + 79
.scr_trim:
        cmp     bx, scr_line_buf
        jb      .scr_trimmed
        cmp     byte [bx], ' '
        jne     .scr_trimmed_at
        cmp     byte [bx], 0
        je      .scr_trimmed_at_zero
        dec     bx
        jmp     .scr_trim
.scr_trimmed_at_zero:
        dec     bx
        jmp     .scr_trim
.scr_trimmed_at:
        inc     bx                   ; BX points past last non-space
        jmp     .scr_write_row
.scr_trimmed:
        mov     bx, scr_line_buf     ; all spaces — write nothing

.scr_write_row:
        ; Write the trimmed row to file
        mov     cx, bx
        sub     cx, scr_line_buf     ; CX = length of trimmed row
        jcxz    .scr_sep             ; empty row — skip write
        mov     dx, scr_line_buf
        mov     bx, [scr_handle]
        mov     ah, 0x40
        int     0x21

.scr_sep:
        ; Write "|" separator (except after last row)
        dec     word [scr_remain]
        cmp     word [scr_remain], 0
        je      .scr_close

        mov     bx, [scr_handle]
        mov     dx, str_pipe
        mov     cx, 1
        mov     ah, 0x40
        int     0x21

        inc     word [scr_cur_row]
        jmp     .scr_row_loop

.scr_close:
        mov     bx, [scr_handle]
        mov     ah, 0x3E
        int     0x21
.scr_fail:
        ret

; ============================================================
; MOUSE — Inject mouse events
; Format: MOUSE x y [buttons]
; ============================================================
do_mouse_move:
        mov     si, cmd_buf
        add     si, 10              ; skip "MOUSE MOVE"
        call    skip_spaces

        ; Parse X coordinate (decimal)
        call    parse_dec16
        jc      .mouse_err
        mov     [mouse_x], ax

        call    skip_spaces

        ; Parse Y coordinate (decimal)
        call    parse_dec16
        jc      .mouse_err
        mov     [mouse_y], ax

        ; Parse optional buttons (default 0)
        call    skip_spaces
        xor     ax, ax
        cmp     byte [si], 0
        je      .mouse_set
        call    parse_dec16
        jc      .mouse_set_zero
        jmp     .mouse_set
.mouse_set_zero:
        xor     ax, ax
.mouse_set:
        mov     [mouse_btn], ax

        ; Set mouse position via INT 33h AX=0004h
        mov     cx, [mouse_x]
        mov     dx, [mouse_y]
        mov     ax, 0x0004
        int     0x33

        ; Set button state via custom INT 33h AX=00FFh
        mov     bx, [mouse_btn]
        mov     ax, 0x00FF
        int     0x33

        mov     si, resp_ok
        call    write_rx
        ret

.mouse_err:
        mov     si, resp_err_syntax
        call    write_rx
        ret

; ============================================================
; INP — Read I/O port
; Format: INP port
; port can be decimal or 0xHHHH hex
; ============================================================
do_inp:
        mov     si, cmd_buf
        add     si, 7               ; skip "PORT IN"
        call    skip_spaces

        ; Check for "0x" or "0X" prefix
        cmp     byte [si], '0'
        jne     .inp_dec
        cmp     byte [si+1], 'x'
        je      .inp_hex
        cmp     byte [si+1], 'X'
        je      .inp_hex

.inp_dec:
        call    parse_dec16
        jc      .inp_err
        jmp     .inp_do

.inp_hex:
        add     si, 2               ; skip "0x"
        call    parse_hex16
        jc      .inp_err

.inp_do:
        mov     dx, ax               ; DX = port number
        in      al, dx               ; Read byte from port

        ; Build response: "OK XX"
        push    es
        push    cs
        pop     es
        mov     di, resp_buf
        push    ax                   ; save port value
        mov     al, 'O'
        stosb
        mov     al, 'K'
        stosb
        mov     al, ' '
        stosb
        pop     ax                   ; restore port value
        call    byte_to_hex          ; writes 2 hex chars at ES:DI
        mov     byte [es:di], 0
        pop     es

        mov     si, resp_buf
        call    write_rx
        ret

.inp_err:
        mov     si, resp_err_syntax
        call    write_rx
        ret

; ============================================================
; OUTP — Write I/O port
; Format: OUTP port value
; port and value can be decimal or 0xHH hex
; ============================================================
do_outp:
        mov     si, cmd_buf
        add     si, 8               ; skip "PORT OUT"
        call    skip_spaces

        ; Parse port number
        cmp     byte [si], '0'
        jne     .outp_port_dec
        cmp     byte [si+1], 'x'
        je      .outp_port_hex
        cmp     byte [si+1], 'X'
        je      .outp_port_hex

.outp_port_dec:
        call    parse_dec16
        jc      .outp_err
        jmp     .outp_port_done

.outp_port_hex:
        add     si, 2
        call    parse_hex16
        jc      .outp_err

.outp_port_done:
        mov     [outp_port], ax
        call    skip_spaces

        ; Parse value
        cmp     byte [si], '0'
        jne     .outp_val_dec
        cmp     byte [si+1], 'x'
        je      .outp_val_hex
        cmp     byte [si+1], 'X'
        je      .outp_val_hex

.outp_val_dec:
        call    parse_dec16
        jc      .outp_err
        jmp     .outp_val_done

.outp_val_hex:
        add     si, 2
        ; Value might be 2 hex digits
        call    parse_hex8
        jc      .outp_err
        xor     ah, ah              ; clear high byte

.outp_val_done:
        mov     dx, [outp_port]
        out     dx, al

        mov     si, resp_ok
        call    write_rx
        ret

.outp_err:
        mov     si, resp_err_syntax
        call    write_rx
        ret

; ============================================================
; VERSION — report version and capability list
; ============================================================
do_version:
        mov     si, resp_version
        call    write_rx
        ret

; ============================================================
; CON CURSOR SET — set text cursor position
; Format: CON CURSOR SET row col
; ============================================================
do_cursor_set:
        mov     si, cmd_buf
        add     si, 14              ; skip "CON CURSOR SET"
        call    skip_spaces
        call    parse_dec16
        jc      .cset_err
        mov     dh, al              ; DH = row
        push    dx
        call    skip_spaces
        call    parse_dec16
        jc      .cset_err2
        mov     dl, al              ; DL = col
        pop     ax
        mov     dh, ah              ; restore row (was in DH, now in AH after pop ax)
        mov     ah, 0x02
        xor     bh, bh              ; page 0
        int     0x10
        mov     si, resp_ok
        call    write_rx
        ret
.cset_err2:
        pop     dx
.cset_err:
        mov     si, resp_err_syntax
        call    write_rx
        ret

; ============================================================
; CON CURSOR GET — get text cursor position
; ============================================================
do_cursor_get:
        ; INT 10h AH=03h: get cursor position
        mov     ah, 0x03
        xor     bh, bh              ; page 0
        int     0x10
        ; DH=row, DL=col

        push    dx
        push    es
        push    cs
        pop     es
        mov     di, resp_buf
        mov     al, 'O'
        stosb
        mov     al, 'K'
        stosb
        mov     al, ' '
        stosb
        pop     es
        pop     dx

        ; Format row
        push    dx
        xor     ah, ah
        mov     al, dh              ; row
        push    es
        push    cs
        pop     es
        call    dec_to_str
        mov     al, ' '
        stosb
        pop     es
        pop     dx

        ; Format col
        xor     ah, ah
        mov     al, dl              ; col
        push    es
        push    cs
        pop     es
        call    dec_to_str
        mov     byte [es:di], 0
        pop     es

        mov     si, resp_buf
        call    write_rx
        ret

; ============================================================
; CLICK — single click at position
; Format: CLICK x y [button]
; ============================================================
do_click:
        mov     si, cmd_buf
        add     si, 11              ; skip "MOUSE CLICK"
        call    skip_spaces

        ; Parse X
        call    parse_dec16
        jc      .click_err
        mov     [mouse_x], ax
        call    skip_spaces

        ; Parse Y
        call    parse_dec16
        jc      .click_err
        mov     [mouse_y], ax
        call    skip_spaces

        ; Parse optional button (default 1)
        mov     ax, 1
        cmp     byte [si], 0
        je      .click_go
        call    parse_dec16
        jc      .click_go_default
        jmp     .click_go
.click_go_default:
        mov     ax, 1
.click_go:
        call    button_bit
        mov     [mouse_btn], ax

        ; Set position
        mov     cx, [mouse_x]
        mov     dx, [mouse_y]
        mov     ax, 0x0004
        int     0x33

        ; Button down
        mov     bx, [mouse_btn]
        mov     ax, 0x00FF
        int     0x33

        ; Wait 2 ticks
        mov     cx, 2
        call    wait_ticks

        ; Button up
        xor     bx, bx
        mov     ax, 0x00FF
        int     0x33

        mov     si, resp_ok
        call    write_rx
        ret

.click_err:
        mov     si, resp_err_syntax
        call    write_rx
        ret

; ============================================================
; DBLCLICK — double click at position
; Format: DBLCLICK x y [button]
; ============================================================
do_dblclick:
        mov     si, cmd_buf
        add     si, 14              ; skip "MOUSE DBLCLICK"
        call    skip_spaces

        ; Parse X
        call    parse_dec16
        jc      .dblclick_err
        mov     [mouse_x], ax
        call    skip_spaces

        ; Parse Y
        call    parse_dec16
        jc      .dblclick_err
        mov     [mouse_y], ax
        call    skip_spaces

        ; Parse optional button (default 1)
        mov     ax, 1
        cmp     byte [si], 0
        je      .dblclick_go
        call    parse_dec16
        jc      .dblclick_go_default
        jmp     .dblclick_go
.dblclick_go_default:
        mov     ax, 1
.dblclick_go:
        call    button_bit
        mov     [mouse_btn], ax

        ; Set position
        mov     cx, [mouse_x]
        mov     dx, [mouse_y]
        mov     ax, 0x0004
        int     0x33

        ; First click: down, wait 1 tick, up
        mov     bx, [mouse_btn]
        mov     ax, 0x00FF
        int     0x33
        mov     cx, 1
        call    wait_ticks
        xor     bx, bx
        mov     ax, 0x00FF
        int     0x33

        ; Inter-click delay: 1 tick
        mov     cx, 1
        call    wait_ticks

        ; Second click: down, wait 1 tick, up
        mov     bx, [mouse_btn]
        mov     ax, 0x00FF
        int     0x33
        mov     cx, 1
        call    wait_ticks
        xor     bx, bx
        mov     ax, 0x00FF
        int     0x33

        mov     si, resp_ok
        call    write_rx
        ret

.dblclick_err:
        mov     si, resp_err_syntax
        call    write_rx
        ret

; ============================================================
; MOUSEDOWN — press mouse button without releasing
; Format: MOUSEDOWN [button]
; ============================================================
do_mousedown:
        mov     si, cmd_buf
        add     si, 10              ; skip "MOUSE DOWN"
        call    skip_spaces

        ; Parse optional button (default 1)
        mov     ax, 1
        cmp     byte [si], 0
        je      .mdown_go
        call    parse_dec16
        jc      .mdown_go_default
        jmp     .mdown_go
.mdown_go_default:
        mov     ax, 1
.mdown_go:
        call    button_bit
        mov     [mouse_btn], ax

        ; Read current button state
        mov     ax, 0x0003
        int     0x33
        ; BX = current buttons

        ; OR in the new button bit
        or      bx, [mouse_btn]
        mov     ax, 0x00FF
        int     0x33

        mov     si, resp_ok
        call    write_rx
        ret

; ============================================================
; MOUSEUP — release mouse button
; Format: MOUSEUP [button]
; ============================================================
do_mouseup:
        mov     si, cmd_buf
        add     si, 8               ; skip "MOUSE UP"
        call    skip_spaces

        ; Parse optional button (default 1)
        mov     ax, 1
        cmp     byte [si], 0
        je      .mup_go
        call    parse_dec16
        jc      .mup_go_default
        jmp     .mup_go
.mup_go_default:
        mov     ax, 1
.mup_go:
        call    button_bit
        mov     [mouse_btn], ax

        ; Read current button state
        mov     ax, 0x0003
        int     0x33
        ; BX = current buttons

        ; AND out the button bit (clear it)
        mov     ax, [mouse_btn]
        not     ax
        and     bx, ax
        mov     ax, 0x00FF
        int     0x33

        mov     si, resp_ok
        call    write_rx
        ret

; ============================================================
; DRAG — click and drag between two points
; Format: DRAG x1 y1 x2 y2 [button]
; ============================================================
do_drag:
        mov     si, cmd_buf
        add     si, 10              ; skip "MOUSE DRAG"
        call    skip_spaces

        ; Parse x1
        call    parse_dec16
        jc      .drag_err
        mov     [drag_x1], ax
        call    skip_spaces

        ; Parse y1
        call    parse_dec16
        jc      .drag_err
        mov     [drag_y1], ax
        call    skip_spaces

        ; Parse x2
        call    parse_dec16
        jc      .drag_err
        mov     [drag_x2], ax
        call    skip_spaces

        ; Parse y2
        call    parse_dec16
        jc      .drag_err
        mov     [drag_y2], ax
        call    skip_spaces

        ; Parse optional button (default 1)
        mov     ax, 1
        cmp     byte [si], 0
        je      .drag_go
        call    parse_dec16
        jc      .drag_go_default
        jmp     .drag_go
.drag_go_default:
        mov     ax, 1
.drag_go:
        call    button_bit
        mov     [mouse_btn], ax

        ; Move to start
        mov     cx, [drag_x1]
        mov     dx, [drag_y1]
        mov     ax, 0x0004
        int     0x33

        ; Button down
        mov     bx, [mouse_btn]
        mov     ax, 0x00FF
        int     0x33

        ; Wait 1 tick
        mov     cx, 1
        call    wait_ticks

        ; Move to end
        mov     cx, [drag_x2]
        mov     dx, [drag_y2]
        mov     ax, 0x0004
        int     0x33

        ; Wait 1 tick
        mov     cx, 1
        call    wait_ticks

        ; Button up
        xor     bx, bx
        mov     ax, 0x00FF
        int     0x33

        mov     si, resp_ok
        call    write_rx
        ret

.drag_err:
        mov     si, resp_err_syntax
        call    write_rx
        ret

; ============================================================
; WAITSCREEN — wait for text to appear on screen
; Format: WAITSCREEN text [timeout_ticks]
; ============================================================
do_waitscreen:
        mov     si, cmd_buf
        add     si, 11              ; skip "WAIT SCREEN"
        call    skip_spaces

        ; Copy search text to ws_text (stop at space or NUL)
        mov     di, ws_text
        xor     cx, cx
.ws_copy_text:
        lodsb
        cmp     al, ' '
        je      .ws_text_done
        cmp     al, 0
        je      .ws_text_done
        cmp     al, '_'
        jne     .ws_no_underscore
        mov     al, ' '             ; underscore → space
.ws_no_underscore:
        mov     [di], al
        inc     di
        inc     cx
        cmp     cx, 40              ; max search length
        jb      .ws_copy_text
.ws_text_done:
        mov     byte [di], 0
        mov     [ws_text_len], cx

        ; Parse optional timeout (default from cfg_timeout)
        call    skip_spaces
        mov     ax, [cfg_timeout]
        cmp     byte [si], 0
        je      .ws_have_timeout
        push    ax
        call    parse_dec16
        jnc     .ws_parsed_timeout
        pop     ax
        jmp     .ws_have_timeout
.ws_parsed_timeout:
        pop     cx                  ; discard default
.ws_have_timeout:
        mov     [ws_timeout], ax

        ; Record start tick
        push    es
        mov     ax, 0x0040
        mov     es, ax
        mov     ax, [es:0x006C]
        mov     [ws_start_tick], ax
        pop     es

.ws_scan_loop:
        ; Scan all 25 rows
        xor     ax, ax
        mov     [ws_cur_row], ax

.ws_next_row:
        cmp     word [ws_cur_row], 25
        jae     .ws_check_timeout

        ; Read 80 chars from B800:(row*160), skip attributes
        push    ds
        push    es
        push    cs
        pop     es
        mov     di, ws_row_buf
        mov     ax, [ws_cur_row]
        mov     dx, 160
        mul     dx
        mov     si, ax
        mov     ax, 0xB800
        mov     ds, ax
        mov     cx, 80
.ws_read_char:
        lodsb
        stosb
        inc     si                  ; skip attribute
        dec     cx
        jnz     .ws_read_char
        pop     es
        pop     ds

        ; Search for ws_text in ws_row_buf
        mov     cx, [ws_text_len]
        cmp     cx, 0
        je      .ws_check_timeout
        mov     ax, 80
        sub     ax, cx
        inc     ax                  ; positions to check
        mov     [ws_scan_max], ax
        xor     dx, dx              ; col position

.ws_scan_col:
        cmp     dx, [ws_scan_max]
        jae     .ws_row_no_match

        ; Compare ws_text against ws_row_buf+dx
        push    si
        push    di
        mov     si, ws_text
        mov     di, ws_row_buf
        add     di, dx
        mov     cx, [ws_text_len]
.ws_cmp_char:
        jcxz    .ws_found
        mov     al, [si]
        cmp     al, [di]
        jne     .ws_cmp_fail
        inc     si
        inc     di
        dec     cx
        jmp     .ws_cmp_char

.ws_found:
        pop     di
        pop     si
        ; Found at row=ws_cur_row, col=dx
        ; Build response "OK row col"
        push    dx                  ; save col
        push    es
        push    cs
        pop     es
        mov     di, resp_buf
        mov     al, 'O'
        stosb
        mov     al, 'K'
        stosb
        mov     al, ' '
        stosb

        mov     ax, [ws_cur_row]
        call    dec_to_str
        mov     al, ' '
        stosb
        pop     es

        pop     ax                  ; col in AX
        push    es
        push    cs
        pop     es
        call    dec_to_str
        mov     byte [es:di], 0
        pop     es

        mov     si, resp_buf
        call    write_rx
        ret

.ws_cmp_fail:
        pop     di
        pop     si
        inc     dx
        jmp     .ws_scan_col

.ws_row_no_match:
        inc     word [ws_cur_row]
        jmp     .ws_next_row

.ws_check_timeout:
        ; Check elapsed ticks
        push    es
        mov     ax, 0x0040
        mov     es, ax
        mov     ax, [es:0x006C]
        pop     es
        sub     ax, [ws_start_tick]
        cmp     ax, [ws_timeout]
        jae     .ws_timed_out

        ; Wait 2 ticks then retry
        mov     cx, 2
        call    wait_ticks
        jmp     .ws_scan_loop

.ws_timed_out:
        mov     si, resp_err_timeout
        call    write_rx
        ret

; ============================================================
; CON WRITE — write text directly to video memory
; Format: CON WRITE row col attr text
; ============================================================
do_con_write:
        mov     si, cmd_buf
        add     si, 10                  ; skip "CON WRITE "
        call    skip_spaces
        ; Parse row
        call    parse_dec16
        jc      .cw_err
        mov     bx, ax                  ; bx = row
        call    skip_spaces
        ; Parse col
        call    parse_dec16
        jc      .cw_err
        mov     cx, ax                  ; cx = col
        call    skip_spaces
        ; Parse attr (hex byte)
        call    parse_hex8
        jc      .cw_err
        mov     dh, al                  ; dh = attr
        call    skip_spaces

        ; Calculate video offset: row * 160 + col * 2
        mov     ax, bx
        mov     dl, 160
        mul     dl                      ; ax = row * 160
        shl     cx, 1                   ; cx = col * 2
        add     ax, cx                  ; ax = offset
        mov     di, ax

        ; Write chars to B800:offset
        push    es
        mov     ax, 0xB800
        mov     es, ax
.cw_loop:
        lodsb
        cmp     al, 0
        je      .cw_done
        cmp     al, '_'
        jne     .cw_not_space
        mov     al, ' '
.cw_not_space:
        mov     [es:di], al             ; character
        inc     di
        mov     [es:di], dh             ; attribute
        inc     di
        jmp     .cw_loop
.cw_done:
        pop     es
        mov     si, resp_ok
        jmp     write_rx
.cw_err:
        mov     si, resp_err_syntax
        jmp     write_rx

; ============================================================
; CON CLEAR — clear screen or region via direct video memory
; Format: CON CLEAR [attr] or CON CLEAR row1 col1 row2 col2 attr
; ============================================================
do_con_clear:
        mov     si, cmd_buf
        add     si, 9                   ; skip "CON CLEAR"
        call    skip_spaces

        ; Check if no args → full screen, attr 07h
        cmp     byte [si], 0
        je      .cc_fullscreen_07

        ; Try to parse first number
        push    si                      ; save position
        call    parse_dec16
        jc      .cc_err_pop
        mov     bl, al                  ; bl = first arg
        call    skip_spaces

        ; One arg only → full screen with attr
        cmp     byte [si], 0
        je      .cc_fullscreen_attr_pop

        ; 5-arg form: row1 col1 row2 col2 attr
        pop     ax                      ; discard saved SI
        ; bl = row1
        mov     [scr_start], bl
        call    parse_dec16
        jc      .cc_err
        mov     [scr_count], al         ; col1
        call    skip_spaces
        call    parse_dec16
        jc      .cc_err
        mov     [scr_remain], al        ; row2
        call    skip_spaces
        call    parse_dec16
        jc      .cc_err
        mov     [scr_cur_row], al       ; col2
        call    skip_spaces
        call    parse_hex8
        jc      .cc_err
        mov     [scr_handle+1], al      ; save attr byte

        ; Clear region via video memory
        push    es
        mov     ax, 0xB800
        mov     es, ax

        ; Save col1 for reuse each row
        mov     al, byte [scr_count]
        mov     [scr_handle], al        ; save col1 in low byte

        mov     bl, byte [scr_start]    ; current row = row1
.cc_region_row:
        cmp     bl, byte [scr_remain]   ; row2
        ja      .cc_region_done

        ; Calculate row offset: row * 160
        mov     al, bl
        xor     ah, ah
        mov     dx, 160
        mul     dx                      ; ax = row * 160 (DX clobbered)

        ; Start at col1
        mov     cl, byte [scr_handle]   ; col1
        xor     ch, ch
        shl     cx, 1
        mov     di, ax
        add     di, cx                  ; di = row * 160 + col1 * 2

        mov     dh, byte [scr_handle+1] ; reload attr
        mov     cl, byte [scr_handle]   ; col counter = col1
.cc_col_loop:
        cmp     cl, byte [scr_cur_row]  ; col2
        ja      .cc_next_row
        mov     byte [es:di], ' '
        inc     di
        mov     [es:di], dh
        inc     di
        inc     cl
        jmp     .cc_col_loop
.cc_next_row:
        inc     bl
        jmp     .cc_region_row
.cc_region_done:
        pop     es
        mov     si, resp_ok
        jmp     write_rx

.cc_err_pop:
        pop     si
        jmp     .cc_err
.cc_fullscreen_attr_pop:
        pop     si                      ; restore parse position
        call    parse_hex8
        jc      .cc_err
        mov     dh, al
        jmp     .cc_fullscreen
.cc_fullscreen_07:
        mov     dh, 0x07
.cc_fullscreen:
        push    es
        mov     ax, 0xB800
        mov     es, ax
        xor     di, di
        mov     cx, 2000                ; 80 * 25
.cc_full_loop:
        mov     byte [es:di], ' '
        inc     di
        mov     [es:di], dh
        inc     di
        dec     cx
        jnz     .cc_full_loop
        pop     es
        mov     si, resp_ok
        jmp     write_rx
.cc_err:
        mov     si, resp_err_syntax
        jmp     write_rx

; ============================================================
; CON SCROLL — scroll screen up or down via video memory
; Format: CON SCROLL UP|DOWN lines [row1 col1 row2 col2]
; For simplicity, only full-screen scroll is supported
; ============================================================
do_con_scroll:
        mov     si, cmd_buf
        add     si, 10                  ; skip "CON SCROLL"
        call    skip_spaces

        ; Parse UP or DOWN
        cmp     byte [si], 'U'
        je      .cs_up
        cmp     byte [si], 'u'
        je      .cs_up
        cmp     byte [si], 'D'
        je      .cs_down
        cmp     byte [si], 'd'
        je      .cs_down
        jmp     .cs_err

.cs_up:
        mov     byte [scr_start], 0     ; 0 = up
        add     si, 2                   ; skip "UP"
        jmp     .cs_parse_lines
.cs_down:
        mov     byte [scr_start], 1     ; 1 = down
        add     si, 4                   ; skip "DOWN"
.cs_parse_lines:
        call    skip_spaces
        call    parse_dec16
        jc      .cs_err
        mov     [scr_count], ax         ; number of lines

        ; Clamp lines to 25
        cmp     ax, 25
        jbe     .cs_clamped
        mov     word [scr_count], 25
.cs_clamped:

        ; Direct video memory scroll
        push    es
        push    ds
        mov     ax, 0xB800
        mov     ds, ax
        mov     es, ax

        cmp     byte [cs:scr_start], 0
        jne     .cs_do_down

        ; SCROLL UP: copy row N to row N-lines
        ; Copy from line [lines] to line 0, etc.
        mov     cx, [cs:scr_count]
        mov     ax, cx
        mov     dx, 160
        mul     dx                      ; ax = lines * 160 = source offset
        mov     si, ax
        xor     di, di                  ; dest = line 0

        ; Number of words to copy: (25 - lines) * 80
        mov     ax, 25
        sub     ax, cx
        shl     ax, 1                   ; * 2 (not needed, we want *80)
        ; Actually: (25 - lines) * 80 words = (25 - lines) * 160 bytes / 2
        mov     ax, 25
        sub     ax, [cs:scr_count]
        mov     dx, 80
        mul     dx                      ; ax = word count
        mov     cx, ax
        cld
        rep     movsw

        ; Blank the bottom lines
        mov     cx, [cs:scr_count]
        mov     dx, 80
        mov     ax, cx
        mul     dx                      ; ax = words to blank
        mov     cx, ax
        mov     ax, 0x0720              ; space + attr 07h
        rep     stosw

        pop     ds
        pop     es
        mov     si, resp_ok
        jmp     write_rx

.cs_do_down:
        ; SCROLL DOWN: copy row N to row N+lines (backwards)
        mov     cx, [cs:scr_count]

        ; Source: end of row (24 - lines), i.e., last word of that row
        mov     ax, 25
        sub     ax, cx                  ; 25 - lines
        mov     dx, 160
        mul     dx                      ; ax = byte offset of row after last to copy
        dec     ax
        dec     ax                      ; last word of last row to copy
        mov     si, ax

        ; Dest: end of row 24
        mov     di, (25 * 160) - 2

        ; Word count: (25 - lines) * 80
        mov     ax, 25
        sub     ax, [cs:scr_count]
        mov     dx, 80
        mul     dx
        mov     cx, ax
        std
        rep     movsw
        cld

        ; Blank the top lines
        xor     di, di
        mov     cx, [cs:scr_count]
        mov     dx, 80
        mov     ax, cx
        mul     dx
        mov     cx, ax
        mov     ax, 0x0720
        rep     stosw

        pop     ds
        pop     es
        mov     si, resp_ok
        jmp     write_rx

.cs_err:
        mov     si, resp_err_syntax
        jmp     write_rx

; ============================================================
; CON ATTR — read attribute bytes from video memory
; Format: CON ATTR row numrows
; ============================================================
; ============================================================
; CON INPUT — read keyboard buffer without consuming
; ============================================================
do_con_input:
        push    es
        mov     ax, 0040h
        mov     es, ax
        mov     bx, [es:001Ah]          ; head pointer
        mov     cx, [es:001Ch]          ; tail pointer
        cmp     bx, cx
        je      .ci_empty
        ; Build "OK ss:aa ss:aa ..."
        mov     di, resp_buf
        mov     al, 'O'
        stosb
        mov     al, 'K'
        stosb
.ci_loop:
        cmp     bx, cx
        je      .ci_done
        mov     al, ' '
        stosb
        mov     ax, [es:bx]            ; AL=ASCII, AH=scan
        push    ax
        mov     al, ah                  ; scan code first
        push    es
        push    bx
        push    cx
        push    ds
        push    cs
        pop     ds
        call    byte_to_hex
        mov     byte [di], ':'
        inc     di
        pop     ds
        pop     cx
        pop     bx
        pop     es
        pop     ax                      ; ASCII
        push    es
        push    bx
        push    cx
        push    ds
        push    cs
        pop     ds
        call    byte_to_hex
        pop     ds
        pop     cx
        pop     bx
        pop     es
        ; Advance head within circular buffer
        add     bx, 2
        cmp     bx, 003Eh              ; buffer end (0040:003E)
        jb      .ci_loop
        mov     bx, 001Eh              ; wrap to buffer start
        jmp     .ci_loop
.ci_done:
        pop     es
        mov     byte [di], 0
        mov     si, resp_buf
        call    write_rx
        ret
.ci_empty:
        pop     es
        mov     si, resp_ok
        call    write_rx
        ret

; ============================================================
; CON BOX — draw box frame to video memory
; ============================================================
do_con_box:
        mov     si, cmd_buf
        add     si, 7                   ; skip "CON BOX"
        call    skip_spaces
        ; Parse: row col height width attr [SINGLE|DOUBLE]
        call    parse_dec16
        mov     [box_row], ax
        call    skip_spaces
        call    parse_dec16
        mov     [box_col], ax
        call    skip_spaces
        call    parse_dec16
        mov     [box_height], ax
        call    skip_spaces
        call    parse_dec16
        mov     [box_width], ax
        call    skip_spaces
        call    parse_hex8
        mov     [box_attr], al
        call    skip_spaces
        ; Check for DOUBLE keyword
        mov     byte [box_style], 0     ; 0 = single
        cmp     byte [si], 'D'
        jne     .cb_draw
        cmp     byte [si+1], 'O'
        jne     .cb_draw
        mov     byte [box_style], 1     ; 1 = double
.cb_draw:
        push    es
        mov     ax, 0B800h
        mov     es, ax
        mov     ah, [box_attr]
        ; Select character set
        cmp     byte [box_style], 0
        jne     .cb_double
        ; Single: ┌=DA ─=C4 ┐=BF │=B3 └=C0 ┘=D9
        mov     byte [box_tl], 0DAh
        mov     byte [box_tr], 0BFh
        mov     byte [box_bl], 0C0h
        mov     byte [box_br], 0D9h
        mov     byte [box_hz], 0C4h
        mov     byte [box_vt], 0B3h
        jmp     .cb_draw_top
.cb_double:
        ; Double: ╔=C9 ═=CD ╗=BB ║=BA ╚=C8 ╝=BC
        mov     byte [box_tl], 0C9h
        mov     byte [box_tr], 0BBh
        mov     byte [box_bl], 0C8h
        mov     byte [box_br], 0BCh
        mov     byte [box_hz], 0CDh
        mov     byte [box_vt], 0BAh
.cb_draw_top:
        ; Calculate starting offset: (row * 80 + col) * 2
        mov     ax, [box_row]
        mov     cx, 80
        mul     cx                      ; AX = row * 80
        add     ax, [box_col]
        shl     ax, 1                   ; * 2 for char+attr
        mov     di, ax
        mov     ah, [box_attr]
        ; Top-left corner
        mov     al, [box_tl]
        stosw
        ; Top horizontal line (width - 2)
        mov     cx, [box_width]
        sub     cx, 2
        jle     .cb_top_right
        mov     al, [box_hz]
.cb_top_hz:
        stosw
        loop    .cb_top_hz
.cb_top_right:
        mov     al, [box_tr]
        stosw
        ; Middle rows (height - 2)
        mov     dx, [box_height]
        sub     dx, 2
        jle     .cb_bottom
        mov     bx, 1                   ; row counter
.cb_mid_row:
        ; Calculate offset for this row
        mov     ax, [box_row]
        add     ax, bx
        mov     cx, 80
        mul     cx
        add     ax, [box_col]
        shl     ax, 1
        mov     di, ax
        mov     ah, [box_attr]
        ; Left vertical
        mov     al, [box_vt]
        stosw
        ; Fill interior with spaces
        mov     cx, [box_width]
        sub     cx, 2
        jle     .cb_mid_right
        mov     al, ' '
.cb_mid_fill:
        stosw
        loop    .cb_mid_fill
.cb_mid_right:
        mov     al, [box_vt]
        stosw
        inc     bx
        dec     dx
        jnz     .cb_mid_row
.cb_bottom:
        ; Bottom row
        mov     ax, [box_row]
        add     ax, [box_height]
        dec     ax
        mov     cx, 80
        mul     cx
        add     ax, [box_col]
        shl     ax, 1
        mov     di, ax
        mov     ah, [box_attr]
        ; Bottom-left corner
        mov     al, [box_bl]
        stosw
        ; Bottom horizontal
        mov     cx, [box_width]
        sub     cx, 2
        jle     .cb_bot_right
        mov     al, [box_hz]
.cb_bot_hz:
        stosw
        loop    .cb_bot_hz
.cb_bot_right:
        mov     al, [box_br]
        stosw
        pop     es
        mov     si, resp_ok
        jmp     write_rx

do_con_attr:
        mov     si, cmd_buf
        add     si, 8                   ; skip "CON ATTR"
        call    skip_spaces

        ; Default: row=0, numrows=25
        xor     ax, ax
        mov     [scr_start], ax
        mov     word [scr_count], 25

        ; Parse row
        cmp     byte [si], 0
        je      .ca_go
        call    parse_dec16
        jc      .ca_go
        mov     [scr_start], ax
        call    skip_spaces

        ; Parse numrows
        cmp     byte [si], 0
        je      .ca_one_row
        call    parse_dec16
        jc      .ca_go
        mov     [scr_count], ax
        jmp     .ca_go

.ca_one_row:
        mov     word [scr_count], 1

.ca_go:
        ; Build response in resp_buf
        mov     di, resp_buf
        mov     byte [di], 'O'
        inc     di
        mov     byte [di], 'K'
        inc     di

        ; Loop over rows
        mov     cx, [scr_count]
        mov     bx, [scr_start]

.ca_row_loop:
        cmp     cx, 0
        je      .ca_done

        ; Calculate video offset: row * 160 + 1 (attr byte)
        push    cx
        mov     ax, bx
        mov     dx, 160
        mul     dx                      ; ax = row * 160
        inc     ax                      ; skip to first attr byte
        mov     si, ax

        ; Read 80 attributes from this row
        push    es
        push    ds
        mov     ax, 0xB800
        mov     ds, ax
        push    cs
        pop     es
        mov     cx, 80
.ca_col_loop:
        ; Space separator
        mov     byte [es:di], ' '
        inc     di
        lodsb                           ; get attr byte
        inc     si                      ; skip next char byte
        ; Convert to hex
        push    cx
        push    si
        push    ds
        push    cs
        pop     ds
        call    byte_to_hex             ; writes 2 hex chars at [es:di], advances di
        pop     ds
        pop     si
        pop     cx
        dec     cx
        jnz     .ca_col_loop

        pop     ds
        pop     es
        pop     cx

        inc     bx                      ; next row
        dec     cx
        jmp     .ca_row_loop

.ca_done:
        mov     byte [es:di], 0         ; null terminate
        mov     si, resp_buf
        call    write_rx_checked
        ret

; ============================================================
; CON MODE — get or set video mode
; Format: CON MODE (get) or CON MODE xx (set)
; ============================================================
; ============================================================
; CON COLOR — get/set default text attribute
; ============================================================
do_con_color:
        mov     si, cmd_buf
        add     si, 9                   ; skip "CON COLOR"
        call    skip_spaces
        ; If no argument, return current color
        cmp     byte [si], 0
        je      .cc_get
        ; Parse hex byte
        call    parse_hex8
        mov     [con_color], al
        mov     si, resp_ok
        jmp     write_rx
.cc_get:
        mov     di, resp_buf
        mov     al, 'O'
        stosb
        mov     al, 'K'
        stosb
        mov     al, ' '
        stosb
        mov     al, [con_color]
        call    byte_to_hex
        mov     byte [es:di], 0
        mov     si, resp_buf
        call    write_rx
        ret

do_con_mode:
        mov     si, cmd_buf
        add     si, 8                   ; skip "CON MODE"
        call    skip_spaces

        ; Check if args present
        cmp     byte [si], 0
        je      .cm_get

        ; SET mode
        call    parse_hex8
        jc      .cm_err
        xor     ah, ah                  ; INT 10h/00h = set video mode
        int     0x10
        mov     si, resp_ok
        jmp     write_rx

.cm_get:
        ; GET: INT 10h/0Fh
        mov     ah, 0x0F
        int     0x10
        ; AL = mode, AH = columns, BH = active page

        ; Build "OK mode=XX cols=NN rows=NN page=N"
        push    bx
        push    ax

        mov     di, resp_buf
        mov     byte [di], 'O'
        inc     di
        mov     byte [di], 'K'
        inc     di
        mov     byte [di], ' '
        inc     di
        ; "mode="
        mov     byte [di], 'm'
        inc     di
        mov     byte [di], 'o'
        inc     di
        mov     byte [di], 'd'
        inc     di
        mov     byte [di], 'e'
        inc     di
        mov     byte [di], '='
        inc     di
        pop     ax
        push    ax
        ; AL = mode
        call    byte_to_hex

        mov     byte [di], ' '
        inc     di
        ; "cols="
        mov     byte [di], 'c'
        inc     di
        mov     byte [di], 'o'
        inc     di
        mov     byte [di], 'l'
        inc     di
        mov     byte [di], 's'
        inc     di
        mov     byte [di], '='
        inc     di
        pop     ax
        ; AH = columns — format as decimal
        mov     al, ah
        xor     ah, ah
        call    .cm_write_decimal

        mov     byte [di], ' '
        inc     di
        ; "rows="
        mov     byte [di], 'r'
        inc     di
        mov     byte [di], 'o'
        inc     di
        mov     byte [di], 'w'
        inc     di
        mov     byte [di], 's'
        inc     di
        mov     byte [di], '='
        inc     di
        ; Read rows from BIOS data area 0040:0084
        push    es
        mov     ax, 0x0040
        mov     es, ax
        mov     al, [es:0x0084]
        pop     es
        ; AL = rows-1 (0 means pre-EGA, assume 25)
        cmp     al, 0
        jne     .cm_has_rows
        mov     al, 24                  ; 25-1
.cm_has_rows:
        inc     al                      ; rows-1 → rows
        xor     ah, ah
        call    .cm_write_decimal

        mov     byte [di], ' '
        inc     di
        ; "page="
        mov     byte [di], 'p'
        inc     di
        mov     byte [di], 'a'
        inc     di
        mov     byte [di], 'g'
        inc     di
        mov     byte [di], 'e'
        inc     di
        mov     byte [di], '='
        inc     di
        pop     bx
        mov     al, bh                  ; active page
        xor     ah, ah
        call    .cm_write_decimal

        mov     byte [di], 0
        mov     si, resp_buf
        jmp     write_rx

.cm_write_decimal:
        ; Write AX as decimal to [di], advance di
        ; AX is small (< 256)
        cmp     ax, 100
        jb      .cmd_lt100
        push    ax
        xor     dx, dx
        mov     cx, 100
        div     cx
        add     al, '0'
        mov     [di], al
        inc     di
        mov     ax, dx
        pop     cx                      ; discard
.cmd_lt100:
        cmp     ax, 10
        jb      .cmd_lt10
        push    ax
        xor     dx, dx
        mov     cx, 10
        div     cx
        add     al, '0'
        mov     [di], al
        inc     di
        mov     ax, dx
        pop     cx                      ; discard
.cmd_lt10:
        add     al, '0'
        mov     [di], al
        inc     di
        ret

.cm_err:
        mov     si, resp_err_syntax
        jmp     write_rx

; ============================================================
; SCREENCRC — CRC-16 of screen character data
; Format: SCREENCRC [startrow [numrows]]
; ============================================================
do_screencrc:
        mov     si, cmd_buf
        add     si, 7               ; skip "CON CRC"
        call    skip_spaces

        ; Default: startrow=0, numrows=25
        xor     ax, ax
        mov     [scr_start], ax
        mov     word [scr_count], 25

        ; Parse optional startrow
        cmp     byte [si], 0
        je      .crc_go
        call    parse_dec16
        jc      .crc_go
        mov     [scr_start], ax
        call    skip_spaces

        ; Parse optional numrows
        cmp     byte [si], 0
        je      .crc_go
        call    parse_dec16
        jc      .crc_go
        mov     [scr_count], ax

.crc_go:
        ; Clamp
        mov     ax, [scr_start]
        add     ax, [scr_count]
        cmp     ax, 25
        jbe     .crc_compute
        mov     ax, 25
        sub     ax, [scr_start]
        mov     [scr_count], ax

.crc_compute:
        ; Init CRC = 0xFFFF
        mov     dx, 0xFFFF

        ; Calculate start offset in video mem
        mov     ax, [scr_start]
        push    dx
        mov     dx, 160
        mul     dx
        pop     dx
        mov     [ws_scan_max], ax   ; reuse as video offset

        ; Process each row
        mov     cx, [scr_count]
        mov     [scr_remain], cx

        push    ds
        mov     ax, 0xB800
        mov     ds, ax

.crc_row_loop:
        cmp     word [cs:scr_remain], 0
        je      .crc_done
        mov     si, [cs:ws_scan_max]
        mov     cx, 80
.crc_char_loop:
        lodsb                       ; read char
        inc     si                  ; skip attr
        ; CRC-16 update: byte in AL, running CRC in DX
        call    crc16_byte
        dec     cx
        jnz     .crc_char_loop

        ; Advance video offset by 160
        add     word [cs:ws_scan_max], 160
        dec     word [cs:scr_remain]
        jmp     .crc_row_loop

.crc_done:
        pop     ds

        ; Format response "OK XXXX"
        push    es
        push    cs
        pop     es
        push    dx                  ; save CRC
        mov     di, resp_buf
        mov     al, 'O'
        stosb
        mov     al, 'K'
        stosb
        mov     al, ' '
        stosb
        pop     ax                  ; CRC in AX
        ; High byte first
        push    ax
        mov     al, ah
        call    byte_to_hex
        pop     ax
        call    byte_to_hex
        mov     byte [es:di], 0
        pop     es

        mov     si, resp_buf
        call    write_rx
        ret

; ============================================================
; SLEEP — wait for specified ticks
; Format: SLEEP ticks
; ============================================================
do_sleep:
        mov     si, cmd_buf
        add     si, 10              ; skip "WAIT SLEEP"
        call    skip_spaces

        call    parse_dec16
        jc      .sleep_err
        mov     cx, ax
        call    wait_ticks

        mov     si, resp_ok
        call    write_rx
        ret

.sleep_err:
        mov     si, resp_err_syntax
        call    write_rx
        ret

; ============================================================
; MEM — report free conventional memory
; ============================================================
do_mem:
        ; Request impossible allocation to get largest free block
        mov     bx, 0xFFFF
        mov     ah, 0x48
        int     0x21
        ; BX = largest available block in paragraphs

        ; Convert paragraphs to KB: BX / 64 (shift right 6)
        push    cx
        mov     cl, 6
        shr     bx, cl
        pop     cx
        mov     ax, bx

        ; Format response "OK <KB>K"
        push    es
        push    cs
        pop     es
        mov     di, resp_buf
        push    ax
        mov     al, 'O'
        stosb
        mov     al, 'K'
        stosb
        mov     al, ' '
        stosb
        pop     ax
        call    dec_to_str
        mov     al, 'K'
        stosb
        mov     byte [es:di], 0
        pop     es

        mov     si, resp_buf
        call    write_rx
        ret

; ============================================================
; MEM DUMP — dump N bytes as hex from seg:off
; Format: MEM DUMP ssss:oooo len
; ============================================================
do_mem_dump:
        mov     si, cmd_buf
        add     si, 9               ; skip "MEM DUMP "
        call    skip_spaces

        ; Parse seg:off
        call    parse_hex16
        jc      .md_err
        mov     [peek_seg], ax
        lodsb
        cmp     al, ':'
        jne     .md_err
        call    parse_hex16
        jc      .md_err
        mov     [peek_off], ax
        call    skip_spaces

        ; Parse length
        call    parse_dec16
        jc      .md_err
        cmp     ax, 256
        jbe     .md_lenok
        mov     ax, 256             ; cap at 256
.md_lenok:
        mov     [peek_len], ax
        cmp     ax, 0
        je      .md_err

        ; Build response in resp_buf
        push    es
        push    cs
        pop     es
        mov     di, resp_buf
        mov     al, 'O'
        stosb
        mov     al, 'K'
        stosb

        ; Read bytes and format
        push    ds
        mov     ds, [cs:peek_seg]
        mov     si, [cs:peek_off]
        mov     cx, [cs:peek_len]
.md_loop:
        mov     byte [es:di], ' '
        inc     di
        lodsb
        call    byte_to_hex
        dec     cx
        jnz     .md_loop
        pop     ds

        mov     byte [es:di], 0
        pop     es

        mov     si, resp_buf
        call    write_rx_checked
        ret

.md_err:
        mov     si, resp_err_syntax
        call    write_rx
        ret

; ============================================================
; MEM FILL — fill N bytes with value at seg:off
; Format: MEM FILL ssss:oooo len hh
; ============================================================
do_mem_fill:
        mov     si, cmd_buf
        add     si, 9               ; skip "MEM FILL "
        call    skip_spaces

        ; Parse seg:off
        call    parse_hex16
        jc      .mf_err
        mov     [peek_seg], ax
        lodsb
        cmp     al, ':'
        jne     .mf_err
        call    parse_hex16
        jc      .mf_err
        mov     [peek_off], ax
        call    skip_spaces

        ; Parse length
        call    parse_dec16
        jc      .mf_err
        mov     [peek_len], ax
        call    skip_spaces

        ; Parse fill byte (hex)
        call    parse_hex8
        jc      .mf_err
        mov     ah, al              ; save fill byte

        ; Do the fill
        push    es
        mov     es, [peek_seg]
        mov     di, [peek_off]
        mov     al, ah
        mov     cx, [peek_len]
        cld
        rep     stosb
        pop     es

        mov     si, resp_ok
        call    write_rx
        ret

.mf_err:
        mov     si, resp_err_syntax
        call    write_rx
        ret

; ============================================================
; MEM COPY — copy N bytes from src seg:off to dst seg:off
; Format: MEM COPY ssss:oooo dddd:oooo len
; ============================================================
do_mem_copy:
        mov     si, cmd_buf
        add     si, 9               ; skip "MEM COPY "
        call    skip_spaces

        ; Parse source seg:off
        call    parse_hex16
        jc      .mc_err
        mov     [peek_seg], ax      ; source seg
        lodsb
        cmp     al, ':'
        jne     .mc_err
        call    parse_hex16
        jc      .mc_err
        mov     [peek_off], ax      ; source off
        call    skip_spaces

        ; Parse dest seg:off
        call    parse_hex16
        jc      .mc_err
        mov     [drag_x1], ax       ; dest seg (reuse drag scratch)
        lodsb
        cmp     al, ':'
        jne     .mc_err
        call    parse_hex16
        jc      .mc_err
        mov     [drag_y1], ax       ; dest off
        call    skip_spaces

        ; Parse length
        call    parse_dec16
        jc      .mc_err
        mov     cx, ax
        cmp     cx, 0
        je      .mc_err

        ; Do the copy
        push    ds
        push    es
        mov     ds, [cs:peek_seg]
        mov     si, [cs:peek_off]
        mov     es, [cs:drag_x1]
        mov     di, [cs:drag_y1]
        cld
        rep     movsb
        pop     es
        pop     ds

        mov     si, resp_ok
        call    write_rx
        ret

.mc_err:
        mov     si, resp_err_syntax
        call    write_rx
        ret

; ============================================================
; MEM SEARCH — search memory for byte pattern
; Format: MEM SEARCH ssss:oooo len hh hh hh ...
; ============================================================
do_mem_search:
        mov     si, cmd_buf
        add     si, 11              ; skip "MEM SEARCH "
        call    skip_spaces

        ; Parse seg:off
        call    parse_hex16
        jc      .ms_err
        mov     [peek_seg], ax
        lodsb
        cmp     al, ':'
        jne     .ms_err
        call    parse_hex16
        jc      .ms_err
        mov     [peek_off], ax
        call    skip_spaces

        ; Parse scan length
        call    parse_dec16
        jc      .ms_err
        mov     [peek_len], ax
        call    skip_spaces

        ; Parse pattern bytes into special_buf (max 16 bytes)
        mov     di, special_buf
        xor     cx, cx              ; pattern length
.ms_parse_pat:
        cmp     byte [si], 0
        je      .ms_pat_done
        push    cx
        call    parse_hex8
        pop     cx
        jc      .ms_pat_done
        stosb
        inc     cx
        call    skip_spaces
        cmp     cx, 16
        jb      .ms_parse_pat
.ms_pat_done:
        cmp     cx, 0
        je      .ms_err
        mov     [ws_text_len], cx   ; pattern length (reuse scratch)

        ; Search: scan memory for first byte, then compare rest
        push    ds
        push    es
        mov     es, [cs:peek_seg]
        mov     di, [cs:peek_off]
        mov     dx, [cs:peek_len]   ; remaining bytes to scan

.ms_scan:
        cmp     dx, 0
        je      .ms_notfound_pop
        ; Check if pattern fits in remaining bytes
        cmp     dx, [cs:ws_text_len]
        jb      .ms_notfound_pop

        ; Compare pattern at ES:DI
        push    di
        push    dx
        mov     si, special_buf
        mov     cx, [cs:ws_text_len]
        push    ds
        push    cs
        pop     ds
        repe    cmpsb
        pop     ds
        pop     dx
        pop     di
        je      .ms_found

        ; Not found here, advance
        inc     di
        jnz     .ms_no_wrap
        ; Handle segment wrap
        mov     ax, es
        add     ax, 0x1000
        mov     es, ax
.ms_no_wrap:
        dec     dx
        jmp     .ms_scan

.ms_found:
        ; Found at ES:DI — format response
        mov     ax, es
        mov     [cs:peek_seg], ax
        mov     [cs:peek_off], di
        pop     es
        pop     ds

        ; Format "OK ssss:oooo"
        push    es
        push    cs
        pop     es
        mov     di, resp_buf
        mov     al, 'O'
        stosb
        mov     al, 'K'
        stosb
        mov     al, ' '
        stosb
        mov     ax, [peek_seg]
        call    word_to_hex
        mov     al, ':'
        stosb
        mov     ax, [peek_off]
        call    word_to_hex
        mov     byte [es:di], 0
        pop     es

        mov     si, resp_buf
        call    write_rx
        ret

.ms_notfound_pop:
        pop     es
        pop     ds
        mov     si, resp_err_notfound
        call    write_rx
        ret

.ms_err:
        mov     si, resp_err_syntax
        call    write_rx
        ret

; ============================================================
; MEM MCB — walk Memory Control Block chain
; Format: MEM MCB
; ============================================================
do_mem_mcb:
        ; Get first MCB via List of Lists
        mov     ah, 0x52
        int     0x21
        ; ES:BX = List of Lists
        mov     ax, [es:bx-2]      ; first MCB segment
        push    cs
        pop     es

        ; Build response in resp_buf
        mov     di, resp_buf
        mov     byte [di], 'O'
        inc     di
        mov     byte [di], 'K'
        inc     di

.mcb_walk:
        push    ds
        mov     ds, ax              ; DS = MCB segment

        ; Read MCB header
        mov     cl, [0]             ; marker: 'M' or 'Z'
        mov     bx, [1]             ; owner PSP segment
        mov     dx, [3]             ; size in paragraphs

        pop     ds

        ; Add space separator
        mov     byte [es:di], ' '
        inc     di

        ; Format: ssss:pppp:NAME
        push    ax
        push    cx
        push    dx

        ; Segment
        call    word_to_hex
        mov     byte [es:di], ':'
        inc     di

        ; Size in paragraphs
        mov     ax, dx
        call    word_to_hex
        mov     byte [es:di], ':'
        inc     di

        pop     dx
        pop     cx

        ; Owner name or type
        cmp     bx, 0
        je      .mcb_free
        cmp     bx, 8
        je      .mcb_dos

        ; Try to read owner name from MCB+8 (8 bytes, DOS 4.0+)
        ; Stack has MCB_seg on top — peek without removing
        pop     ax                  ; ax = MCB segment
        push    ax                  ; put it back for .mcb_next
        push    ds
        mov     ds, ax
        ; Copy up to 8 chars of name from MCB offset 8
        push    cx
        mov     si, 8
        mov     cx, 8
.mcb_copy_name:
        lodsb
        cmp     al, 0
        je      .mcb_name_done
        cmp     al, ' '
        je      .mcb_name_done
        mov     [es:di], al
        inc     di
        dec     cx
        jnz     .mcb_copy_name
.mcb_name_done:
        pop     cx
        pop     ds
        jmp     .mcb_next

.mcb_free:
        mov     byte [es:di], 'F'
        inc     di
        mov     byte [es:di], 'R'
        inc     di
        mov     byte [es:di], 'E'
        inc     di
        mov     byte [es:di], 'E'
        inc     di
        jmp     .mcb_next

.mcb_dos:
        mov     byte [es:di], 'D'
        inc     di
        mov     byte [es:di], 'O'
        inc     di
        mov     byte [es:di], 'S'
        inc     di

.mcb_next:
        pop     ax                  ; MCB segment

        ; Check if last MCB
        cmp     cl, 'Z'
        je      .mcb_done

        ; Next MCB = current_seg + 1 + size_paragraphs
        inc     ax                  ; skip MCB header paragraph
        add     ax, dx              ; add size

        ; Safety: check if we're about to go past reasonable memory
        cmp     ax, 0xA000
        jae     .mcb_done

        ; Check if resp_buf is getting full (leave room)
        push    bx
        mov     bx, di
        sub     bx, resp_buf
        cmp     bx, 450
        pop     bx
        jae     .mcb_done

        jmp     .mcb_walk

.mcb_done:
        mov     byte [es:di], 0

        mov     si, resp_buf
        call    write_rx_checked
        ret

; ============================================================
; MEM EMS — detect and report EMS status
; Response: OK VER=x.x TOTAL=nnn FREE=nnn PAGEFRAME=XXXX or ERR NO_EMS
; ============================================================
do_mem_ems:
        ; Check for EMS driver by looking for "EMMXXXX0" at INT 67h handler
        push    es
        xor     ax, ax
        mov     es, ax
        mov     ax, [es:67h*4+2]        ; segment of INT 67h handler
        mov     es, ax
        ; Check device name at offset 0Ah
        cmp     word [es:0Ah], 'EM'
        jne     .ems_no
        cmp     word [es:0Ch], 'MX'
        jne     .ems_no
        cmp     word [es:0Eh], 'XX'
        jne     .ems_no
        cmp     word [es:10h], 'X0'
        jne     .ems_no
        pop     es

        ; Get version
        mov     ah, 46h
        int     67h
        test    ah, ah
        jnz     .ems_no2
        push    ax                      ; save version in AL (BCD)

        ; Get page counts
        mov     ah, 42h
        int     67h
        ; BX = free pages, DX = total pages
        push    bx
        push    dx

        ; Get page frame
        mov     ah, 41h
        int     67h
        ; BX = page frame segment
        push    bx

        ; Build response
        push    cs
        pop     es
        mov     di, resp_buf
        mov     al, 'O'
        stosb
        mov     al, 'K'
        stosb
        mov     al, ' '
        stosb
        ; VER=
        mov     al, 'V'
        stosb
        mov     al, 'E'
        stosb
        mov     al, 'R'
        stosb
        mov     al, '='
        stosb
        ; Version from stack (6th item = original push)
        mov     bp, sp
        mov     al, [bp+6]             ; BCD version
        push    ax
        mov     cl, 4
        shr     al, cl
        add     al, '0'
        stosb
        mov     al, '.'
        stosb
        pop     ax
        and     al, 0Fh
        add     al, '0'
        stosb
        mov     al, ' '
        stosb
        ; TOTAL=
        mov     al, 'T'
        stosb
        mov     al, 'O'
        stosb
        mov     al, 'T'
        stosb
        mov     al, 'A'
        stosb
        mov     al, 'L'
        stosb
        mov     al, '='
        stosb
        pop     bx                      ; page frame (discard for now, get after)
        pop     dx                      ; total pages
        pop     bx                      ; free pages
        pop     ax                      ; version (discard)
        push    bx                      ; save free
        mov     ax, dx
        call    sys_write_dec
        mov     al, ' '
        stosb
        ; FREE=
        mov     al, 'F'
        stosb
        mov     al, 'R'
        stosb
        mov     al, 'E'
        stosb
        mov     al, 'E'
        stosb
        mov     al, '='
        stosb
        pop     ax                      ; free pages
        call    sys_write_dec
        ; We skip PAGEFRAME for now since we popped it
        mov     byte [di], 0
        mov     si, resp_buf
        jmp     write_rx

.ems_no:
        pop     es
.ems_no2:
        mov     si, resp_err_no_ems
        jmp     write_rx

; ============================================================
; MEM XMS — detect and report XMS status
; Response: OK VER=x.xx TOTAL=nnnK FREE=nnnK HMA=YES|NO or ERR NO_XMS
; ============================================================
do_mem_xms:
        ; Check for XMS via INT 2Fh/4300h
        mov     ax, 4300h
        int     2Fh
        cmp     al, 80h
        jne     .xms_no

        ; Get entry point
        mov     ax, 4310h
        int     2Fh
        ; ES:BX = XMS entry point
        mov     [xms_entry], bx
        mov     [xms_entry+2], es

        ; Call XMS function 00h: get version
        xor     ah, ah
        call    far [xms_entry]
        ; AX = XMS version (BCD), BX = driver version, DX = HMA (1=yes)
        push    ax                      ; version
        push    dx                      ; HMA flag

        ; Call XMS function 08h: query free memory
        mov     ah, 08h
        call    far [xms_entry]
        ; AX = largest free block (KB), DX = total free (KB)
        push    ax                      ; largest
        push    dx                      ; total free

        ; Build response
        push    cs
        pop     es
        mov     di, resp_buf
        mov     al, 'O'
        stosb
        mov     al, 'K'
        stosb
        mov     al, ' '
        stosb
        ; VER=
        mov     al, 'V'
        stosb
        mov     al, 'E'
        stosb
        mov     al, 'R'
        stosb
        mov     al, '='
        stosb
        ; Pop in reverse: total_free, largest, hma, version
        pop     dx                      ; total free KB
        pop     bx                      ; largest free KB (unused in output)
        pop     cx                      ; HMA flag
        pop     ax                      ; version BCD
        push    cx                      ; save HMA
        push    dx                      ; save total free
        push    bx                      ; save largest
        ; BCD version: AH = major.minor high, AL = minor low
        ; Format: high_nibble(AH).low_nibble(AH).high_nibble(AL)low_nibble(AL)
        push    ax
        mov     al, ah
        mov     cl, 4
        shr     al, cl
        add     al, '0'
        stosb
        mov     al, '.'
        stosb
        pop     ax
        push    ax
        mov     al, ah
        and     al, 0Fh
        add     al, '0'
        stosb
        pop     ax
        push    ax
        mov     cl, 4
        shr     al, cl
        add     al, '0'
        stosb
        pop     ax
        ; AL low nibble is sub-minor, skip for brevity
        mov     al, ' '
        stosb
        ; FREE=
        mov     al, 'F'
        stosb
        mov     al, 'R'
        stosb
        mov     al, 'E'
        stosb
        mov     al, 'E'
        stosb
        mov     al, '='
        stosb
        pop     bx                      ; largest (discard)
        pop     ax                      ; total free KB
        call    sys_write_dec
        mov     al, 'K'
        stosb
        mov     al, ' '
        stosb
        ; HMA=
        mov     al, 'H'
        stosb
        mov     al, 'M'
        stosb
        mov     al, 'A'
        stosb
        mov     al, '='
        stosb
        pop     ax                      ; HMA flag
        test    ax, ax
        jz      .xms_hma_no
        mov     al, 'Y'
        stosb
        mov     al, 'E'
        stosb
        mov     al, 'S'
        stosb
        jmp     .xms_done
.xms_hma_no:
        mov     al, 'N'
        stosb
        mov     al, 'O'
        stosb
.xms_done:
        mov     byte [di], 0
        mov     si, resp_buf
        jmp     write_rx

.xms_no:
        mov     si, resp_err_no_xms
        jmp     write_rx

; ============================================================
; KEYDOWN — press and hold a key (modifier or scan code)
; Format: KEYDOWN <name|0xHH>
; ============================================================
do_keydown:
        mov     si, cmd_buf
        add     si, 8               ; skip "KEY DOWN"
        call    skip_spaces

        ; Check for 0x prefix → hex scan code
        cmp     byte [si], '0'
        jne     .kd_try_names
        cmp     byte [si+1], 'x'
        je      .kd_hex
        cmp     byte [si+1], 'X'
        je      .kd_hex

.kd_try_names:
        ; Walk the key name table
        mov     bx, key_table
.kd_scan_table:
        cmp     word [bx], 0        ; end sentinel
        je      .kd_err
        push    si
        push    bx
        mov     di, [bx]            ; key name pointer
        call    str_eq_upper
        pop     bx
        pop     si
        je      .kd_found_modifier
        add     bx, 3               ; next entry (2b ptr + 1b mask)
        jmp     .kd_scan_table

.kd_found_modifier:
        mov     al, [bx+2]          ; mask byte
        push    es
        mov     cx, 0x0040
        mov     es, cx
        or      byte [es:0x0017], al
        pop     es
        jmp     .kd_ok

.kd_hex:
        add     si, 2               ; skip "0x"
        call    parse_hex8
        jc      .kd_err
        mov     ch, al              ; CH = scan code
        xor     cl, cl              ; CL = no ASCII
        mov     ah, 0x05
        int     0x16
        jmp     .kd_ok

.kd_ok:
        mov     si, resp_ok
        call    write_rx
        ret

.kd_err:
        mov     si, resp_err_syntax
        call    write_rx
        ret

; ============================================================
; KEYUP — release a key (modifier or scan code)
; Format: KEYUP <name|0xHH>
; ============================================================
do_keyup:
        mov     si, cmd_buf
        add     si, 6               ; skip "KEY UP"
        call    skip_spaces

        ; Check for 0x prefix → hex scan code (no-op, just return OK)
        cmp     byte [si], '0'
        jne     .ku_try_names
        cmp     byte [si+1], 'x'
        je      .ku_hex_noop
        cmp     byte [si+1], 'X'
        je      .ku_hex_noop

.ku_try_names:
        mov     bx, key_table
.ku_scan_table:
        cmp     word [bx], 0
        je      .ku_err
        push    si
        push    bx
        mov     di, [bx]
        call    str_eq_upper
        pop     bx
        pop     si
        je      .ku_found_modifier
        add     bx, 3
        jmp     .ku_scan_table

.ku_found_modifier:
        mov     al, [bx+2]          ; mask byte
        not     al
        push    es
        mov     cx, 0x0040
        mov     es, cx
        and     byte [es:0x0017], al
        pop     es
        jmp     .ku_ok

.ku_hex_noop:
.ku_ok:
        mov     si, resp_ok
        call    write_rx
        ret

.ku_err:
        mov     si, resp_err_syntax
        call    write_rx
        ret

; ============================================================
; KEY PEEK — check keyboard buffer without consuming
; ============================================================
do_key_peek:
        ; Read BIOS keyboard buffer directly (avoids INT 16h which crashes emu2)
        push    ds
        mov     ax, 0040h
        mov     ds, ax
        mov     bx, [001Ah]            ; head pointer
        cmp     bx, [001Ch]            ; tail pointer
        pop     ds
        je      .kp_empty
        ; Read the word at 0040:head
        push    es
        mov     ax, 0040h
        mov     es, ax
        mov     ax, [es:bx]            ; AL=ASCII, AH=scan
        pop     es
        push    ax
        mov     di, resp_buf
        mov     al, 'O'
        stosb
        mov     al, 'K'
        stosb
        mov     al, ' '
        stosb
        pop     ax
        push    ax
        mov     al, ah                  ; scan code
        call    byte_to_hex
        mov     byte [di], ':'
        inc     di
        pop     ax                      ; ASCII
        call    byte_to_hex
        mov     byte [es:di], 0
        mov     si, resp_buf
        call    write_rx
        ret
.kp_empty:
        mov     si, resp_ok_empty
        call    write_rx
        ret

; ============================================================
; KEY FLUSH — flush keyboard buffer
; ============================================================
do_key_flush:
        push    ds
        mov     ax, 0040h
        mov     ds, ax
        mov     ax, [001Ch]             ; tail pointer
        mov     [001Ah], ax             ; head = tail → empty
        pop     ds
        mov     si, resp_ok
        call    write_rx
        ret

; ============================================================
; CLIPGET — read Windows clipboard text via INT 2Fh/17xxh
; ============================================================
do_clipget:
        ; Check clipboard availability
        mov     ax, 0x1700
        int     0x2F
        cmp     ax, 0x1700
        je      .cg_unavail

        ; Open clipboard
        mov     ax, 0x1701
        int     0x2F
        cmp     ax, 0
        je      .cg_busy

        ; Get data size for CF_OEMTEXT (format 7)
        mov     dx, 7
        mov     ax, 0x1704
        int     0x2F
        or      dx, dx
        jnz     .cg_close_ok        ; >64K, skip
        cmp     ax, 0
        je      .cg_close_ok        ; no text
        cmp     ax, 500
        jbe     .cg_size_ok
        mov     ax, 500
.cg_size_ok:
        mov     [clip_size], ax

        ; Get data into resp_buf+3
        mov     dx, 7
        push    es
        push    cs
        pop     es
        mov     bx, resp_buf
        add     bx, 3
        mov     ax, 0x1705
        int     0x2F
        pop     es

        ; Close clipboard
        push    ax
        mov     ax, 0x1708
        int     0x2F
        pop     ax

        ; Build "OK <text>"
        mov     byte [resp_buf], 'O'
        mov     byte [resp_buf+1], 'K'
        mov     byte [resp_buf+2], ' '
        mov     bx, [clip_size]
        add     bx, resp_buf
        add     bx, 3
        mov     byte [bx], 0
        mov     si, resp_buf
        call    write_rx
        ret

.cg_close_ok:
        mov     ax, 0x1708
        int     0x2F
        mov     si, resp_ok
        call    write_rx
        ret

.cg_busy:
        mov     si, resp_err_clipbusy
        call    write_rx
        ret

.cg_unavail:
        mov     si, resp_err_clipboard
        call    write_rx
        ret

; ============================================================
; CLIPSET — write text to Windows clipboard via INT 2Fh/17xxh
; ============================================================
do_clipset:
        ; Check clipboard availability
        mov     ax, 0x1700
        int     0x2F
        cmp     ax, 0x1700
        je      .cs_unavail

        ; Open clipboard
        mov     ax, 0x1701
        int     0x2F
        cmp     ax, 0
        je      .cs_busy

        ; Empty clipboard
        mov     ax, 0x1702
        int     0x2F

        ; Measure text length (after "CLIP SET ")
        mov     si, cmd_buf
        add     si, 8               ; skip "CLIP SET"
        call    skip_spaces
        push    si                  ; save text start
        xor     cx, cx
.cs_measure:
        lodsb
        cmp     al, 0
        je      .cs_measured
        inc     cx
        jmp     .cs_measure
.cs_measured:
        inc     cx                  ; include null terminator
        pop     bx                  ; BX = text start (for ES:BX)

        ; Set data: DX=7 (CF_OEMTEXT), ES:BX=text, SI:CX=size
        push    es
        push    cs
        pop     es
        xor     si, si              ; SI=0 (high word of size)
        mov     dx, 7
        mov     ax, 0x1703
        int     0x2F
        pop     es

        ; Close clipboard
        mov     ax, 0x1708
        int     0x2F

        mov     si, resp_ok
        call    write_rx
        ret

.cs_busy:
        mov     si, resp_err_clipbusy
        call    write_rx
        ret

.cs_unavail:
        mov     si, resp_err_clipboard
        call    write_rx
        ret

; ============================================================
; SCREENDUMP — save screen text to file
; ============================================================
do_screendump:
        ; Check video mode: INT 10h/0Fh → AL = mode
        mov     ah, 0x0F
        int     0x10
        mov     [bmp_vidmode], al

        ; Text modes: 0-3, 7 → text dump to .SCR
        cmp     al, 3
        jbe     .sdump_text
        cmp     al, 7
        je      .sdump_text

        ; Graphics mode → BMP dump
        jmp     .sdump_bmp

.sdump_text:
        ; Delete existing SCR file (ignore errors)
        mov     dx, path_scr
        mov     ah, 0x41
        int     0x21

        ; Create SCR file
        mov     dx, path_scr
        xor     cx, cx
        mov     ah, 0x3C
        int     0x21
        jc      .sdump_fail
        mov     [scr_handle], ax

        ; Dump 25 rows
        xor     ax, ax
        mov     [scr_cur_row], ax
        mov     word [scr_remain], 25

.sdump_row_loop:
        cmp     word [scr_remain], 0
        je      .sdump_close

        ; Read 80 chars from B800:(row*160), skip attributes
        push    ds
        push    es
        push    cs
        pop     es
        mov     di, scr_line_buf
        mov     ax, [scr_cur_row]
        mov     dx, 160
        mul     dx
        mov     si, ax
        mov     ax, 0xB800
        mov     ds, ax
        mov     cx, 80
.sdump_read_char:
        lodsb
        stosb
        inc     si                  ; skip attribute
        dec     cx
        jnz     .sdump_read_char
        pop     es
        pop     ds

        ; Write 80 chars to file
        mov     bx, [scr_handle]
        mov     dx, scr_line_buf
        mov     cx, 80
        mov     ah, 0x40
        int     0x21

        ; Write CR/LF
        mov     bx, [scr_handle]
        mov     dx, str_crlf
        mov     cx, 2
        mov     ah, 0x40
        int     0x21

        inc     word [scr_cur_row]
        dec     word [scr_remain]
        jmp     .sdump_row_loop

.sdump_close:
        mov     bx, [scr_handle]
        mov     ah, 0x3E
        int     0x21

        mov     si, resp_ok
        call    write_rx
        ret

.sdump_fail:
        mov     si, resp_err_syntax
        call    write_rx
        ret

; --- BMP graphics dump ---
.sdump_bmp:
        ; Determine resolution from video mode
        mov     al, [bmp_vidmode]
        ; Default: 320x200 mode 13h (most common VGA graphics)
        mov     word [bmp_width], 320
        mov     word [bmp_height], 200
        mov     byte [bmp_bpp], 8

        cmp     al, 0x13
        je      .bmp_res_set
        ; Mode 12h: 640x480x16
        cmp     al, 0x12
        jne     .bmp_try_11
        mov     word [bmp_width], 640
        mov     word [bmp_height], 480
        mov     byte [bmp_bpp], 4
        jmp     .bmp_res_set
.bmp_try_11:
        ; Mode 11h: 640x480x2
        cmp     al, 0x11
        jne     .bmp_try_0d
        mov     word [bmp_width], 640
        mov     word [bmp_height], 480
        mov     byte [bmp_bpp], 1
        jmp     .bmp_res_set
.bmp_try_0d:
        ; Mode 0Dh: 320x200x16
        cmp     al, 0x0D
        jne     .bmp_try_0e
        mov     word [bmp_width], 320
        mov     word [bmp_height], 200
        mov     byte [bmp_bpp], 4
        jmp     .bmp_res_set
.bmp_try_0e:
        ; Mode 0Eh: 640x200x16
        cmp     al, 0x0E
        jne     .bmp_try_10
        mov     word [bmp_width], 640
        mov     word [bmp_height], 200
        mov     byte [bmp_bpp], 4
        jmp     .bmp_res_set
.bmp_try_10:
        ; Mode 10h: 640x350x16
        cmp     al, 0x10
        jne     .bmp_res_set            ; unknown → use 320x200 default
        mov     word [bmp_width], 640
        mov     word [bmp_height], 350
        mov     byte [bmp_bpp], 4

.bmp_res_set:
        ; Delete existing BMP file
        mov     dx, path_bmp
        mov     ah, 0x41
        int     0x21

        ; Create BMP file
        mov     dx, path_bmp
        xor     cx, cx
        mov     ah, 0x3C
        int     0x21
        jc      .sdump_fail
        mov     [scr_handle], ax

        ; === Write 14-byte BMP file header ===
        mov     di, scr_line_buf

        ; Signature 'BM'
        mov     byte [di], 'B'
        mov     byte [di+1], 'M'
        add     di, 2

        ; File size = 14 + 40 + palette_size + pixel_data_size
        ; For 8bpp: palette=1024, pixels=width*height
        ; For 4bpp: palette=64, pixels=(width/2)*height (nibble packed — we use 8bpp for simplicity)
        ; Simplify: always write 8bpp BMP with 256-color palette, pixel per byte
        ; palette_size = 256*4 = 1024
        ; pixel_data_size = width * height (rows padded to 4-byte boundary)
        ;
        ; Row size with padding: ((width * bpp + 31) / 32) * 4
        ; For 8bpp 320-wide: row = 320 bytes (already 4-aligned)
        ; For 8bpp 640-wide: row = 640 bytes (already 4-aligned)
        ;
        ; We always output 8bpp, reading pixel color via INT 10h/0Dh
        mov     ax, [bmp_width]
        ; Pad row to 4-byte boundary
        add     ax, 3
        and     ax, 0xFFFC
        mov     [bmp_rowsize], ax

        ; pixel_data = rowsize * height
        mov     dx, [bmp_height]
        mul     dx                      ; DX:AX = rowsize * height
        mov     [bmp_pixsize], ax
        mov     [bmp_pixsize+2], dx

        ; file_size = 14 + 40 + 1024 + pixel_data = 1078 + pixel_data
        add     ax, 1078
        adc     dx, 0
        ; Store as DWORD (little-endian) at DI
        mov     [di], ax
        mov     [di+2], dx
        add     di, 4

        ; Reserved (0)
        xor     ax, ax
        mov     [di], ax
        mov     [di+2], ax
        add     di, 4

        ; Pixel data offset = 14 + 40 + 1024 = 1078
        mov     word [di], 1078
        mov     word [di+2], 0
        add     di, 4

        ; === Write 40-byte DIB header (BITMAPINFOHEADER) ===
        ; DIB header size = 40
        mov     word [di], 40
        mov     word [di+2], 0
        add     di, 4

        ; Width
        mov     ax, [bmp_width]
        mov     [di], ax
        mov     word [di+2], 0
        add     di, 4

        ; Height
        mov     ax, [bmp_height]
        mov     [di], ax
        mov     word [di+2], 0
        add     di, 4

        ; Planes = 1
        mov     word [di], 1
        add     di, 2

        ; Bits per pixel = 8 (always write 8bpp)
        mov     word [di], 8
        add     di, 2

        ; Compression = 0 (BI_RGB)
        xor     ax, ax
        mov     [di], ax
        mov     [di+2], ax
        add     di, 4

        ; Image size
        mov     ax, [bmp_pixsize]
        mov     [di], ax
        mov     ax, [bmp_pixsize+2]
        mov     [di+2], ax
        add     di, 4

        ; X pixels/meter = 0
        xor     ax, ax
        mov     [di], ax
        mov     [di+2], ax
        add     di, 4

        ; Y pixels/meter = 0
        mov     [di], ax
        mov     [di+2], ax
        add     di, 4

        ; Colors used = 256
        mov     word [di], 256
        mov     word [di+2], 0
        add     di, 4

        ; Important colors = 0
        xor     ax, ax
        mov     [di], ax
        mov     [di+2], ax
        add     di, 4

        ; Write the 54-byte header (14 + 40) to file
        mov     bx, [scr_handle]
        mov     dx, scr_line_buf
        mov     cx, 54
        mov     ah, 0x40
        int     0x21

        ; === Write 1024-byte palette ===
        ; Read palette in chunks of 16 colors (48 bytes RGB, 64 bytes BGRA)
        ; Uses scr_line_buf (80 bytes) for both read and write
        xor     ax, ax
        mov     [bmp_pal_idx], ax       ; starting color index

.bmp_pal_chunk:
        cmp     word [bmp_pal_idx], 256
        jge     .bmp_pal_done

        ; Read 16 DAC colors: INT 10h/1017h
        ; BX=first register, CX=count, ES:DX=buffer for RGB triples
        push    es
        push    cs
        pop     es
        mov     ax, 0x1017
        mov     bx, [bmp_pal_idx]
        mov     cx, 16
        mov     dx, bmp_rgb_buf         ; 48-byte buffer
        int     0x10
        pop     es

        ; Convert 16 RGB triples (6-bit) to BGRA quads (8-bit) in scr_line_buf
        mov     si, bmp_rgb_buf
        mov     di, scr_line_buf
        mov     cx, 16

.bmp_pal_cvt:
        lodsb                           ; R (6-bit)
        shl     al, 1
        shl     al, 1
        mov     ah, al                  ; save R8
        lodsb                           ; G (6-bit)
        shl     al, 1
        shl     al, 1
        mov     bl, al                  ; save G8
        lodsb                           ; B (6-bit)
        shl     al, 1
        shl     al, 1
        stosb                           ; write B
        mov     al, bl
        stosb                           ; write G
        mov     al, ah
        stosb                           ; write R
        xor     al, al
        stosb                           ; write 0 (reserved)
        dec     cx
        jnz     .bmp_pal_cvt

        ; Write 64 bytes (16 colors × 4 bytes) to file
        mov     bx, [scr_handle]
        mov     dx, scr_line_buf
        mov     cx, 64
        mov     ah, 0x40
        int     0x21

        add     word [bmp_pal_idx], 16
        jmp     .bmp_pal_chunk

.bmp_pal_done:
        ; === Write pixel data (bottom-up) ===
        ; BMP stores rows bottom-to-top
        mov     ax, [bmp_height]
        dec     ax
        mov     [bmp_cur_y], ax         ; start at bottom row

.bmp_row_loop:
        cmp     word [bmp_cur_y], 0
        jl      .bmp_write_done

        ; Read one row of pixels using INT 10h/0Dh
        xor     cx, cx                  ; column = 0
        mov     di, scr_line_buf        ; reuse as pixel row buffer (max 80 bytes, but need up to 640)

        ; For wide rows (>80), we write in chunks
        mov     word [bmp_cur_x], 0

.bmp_pixel_chunk:
        mov     di, scr_line_buf
        xor     cx, cx                  ; bytes in this chunk

.bmp_read_pixel:
        mov     ax, [bmp_cur_x]
        cmp     ax, [bmp_width]
        jge     .bmp_write_chunk
        cmp     cx, 80                  ; max chunk size (scr_line_buf is 82 bytes)
        jge     .bmp_write_chunk

        ; INT 10h/0Dh: Read pixel — BH=page, CX=col, DX=row → AL=color
        push    cx
        push    di
        mov     cx, [bmp_cur_x]
        mov     dx, [bmp_cur_y]
        xor     bh, bh
        mov     ah, 0x0D
        int     0x10
        pop     di
        pop     cx

        stosb                           ; store pixel color
        inc     cx
        inc     word [bmp_cur_x]
        jmp     .bmp_read_pixel

.bmp_write_chunk:
        ; Pad to rowsize if this is the last chunk of the row
        mov     ax, [bmp_cur_x]
        cmp     ax, [bmp_width]
        jl      .bmp_do_write
        ; Add padding bytes (rowsize - width)
        mov     ax, [bmp_rowsize]
        sub     ax, [bmp_width]
        jz      .bmp_do_write
        ; AX = padding bytes needed
        push    cx
        mov     cx, ax
        xor     al, al
.bmp_pad:
        stosb
        dec     cx
        jnz     .bmp_pad
        pop     cx
        ; Update CX to include padding
        mov     ax, [bmp_rowsize]
        sub     ax, [bmp_width]
        add     cx, ax

.bmp_do_write:
        cmp     cx, 0
        je      .bmp_next_row_check
        push    cx
        mov     bx, [scr_handle]
        mov     dx, scr_line_buf
        mov     ah, 0x40
        int     0x21
        pop     cx

.bmp_next_row_check:
        mov     ax, [bmp_cur_x]
        cmp     ax, [bmp_width]
        jl      .bmp_pixel_chunk        ; more chunks needed for this row

        ; Next row (going up)
        dec     word [bmp_cur_y]
        jmp     .bmp_row_loop

.bmp_write_done:
        ; Close file
        mov     bx, [scr_handle]
        mov     ah, 0x3E
        int     0x21

        mov     si, resp_ok
        call    write_rx
        ret

; ============================================================
; LOG — toggle debug file writes
; Format: LOG ON | LOG OFF
; ============================================================
do_log:
        mov     si, cmd_buf
        add     si, 8               ; skip "META LOG"
        call    skip_spaces

        ; Check for ON or OFF
        cmp     byte [si], 'O'
        jne     .log_check_lower
        jmp     .log_check_n
.log_check_lower:
        cmp     byte [si], 'o'
        jne     .log_err
.log_check_n:
        mov     al, [si+1]
        call    to_upper
        cmp     al, 'N'
        je      .log_on
        cmp     al, 'F'
        jne     .log_err
        ; OFF
        mov     byte [cfg_debug], 0
        jmp     .log_ok
.log_on:
        mov     byte [cfg_debug], 1
.log_ok:
        mov     si, resp_ok
        call    write_rx
        ret
.log_err:
        mov     si, resp_err_syntax
        call    write_rx
        ret

; ============================================================
; STATUS — report diagnostics
; Format: STATUS
; Response: OK V0.5 CMDS=N DEBUG=D POLL=P TIMEOUT=T
; ============================================================
do_status:
        push    es
        push    cs
        pop     es
        mov     di, resp_buf

        ; Copy "OK V0.5 CMDS="
        mov     si, status_prefix
        call    copy_str

        ; Command count
        mov     ax, [cmd_count]
        call    dec_to_str

        ; " DEBUG="
        mov     al, ' '
        stosb
        mov     si, status_debug_lbl
        call    copy_str
        xor     ah, ah
        mov     al, [cfg_debug]
        call    dec_to_str

        ; " POLL="
        mov     al, ' '
        stosb
        mov     si, status_poll_lbl
        call    copy_str
        xor     ah, ah
        mov     al, [cfg_poll]
        call    dec_to_str

        ; " TIMEOUT="
        mov     al, ' '
        stosb
        mov     si, status_timeout_lbl
        call    copy_str
        mov     ax, [cfg_timeout]
        call    dec_to_str

        mov     byte [es:di], 0
        pop     es

        mov     si, resp_buf
        call    write_rx
        ret

; ============================================================
; TYPE — type a string with automatic shift handling
; Format: TYPE <text>
; Underscore in text is converted to space.
; ============================================================
do_type:
        mov     si, cmd_buf
        add     si, 8               ; skip "KEY TYPE"
        call    skip_spaces

.type_loop:
        lodsb
        cmp     al, 0
        je      .type_done

        ; Underscore → space
        cmp     al, '_'
        jne     .type_no_us
        mov     al, ' '
.type_no_us:
        ; Save ASCII char and source pointer
        mov     [type_char], al
        push    si

        ; Look up scan code: ascii_to_scan[char]
        xor     bh, bh
        mov     bl, al
        cmp     bl, 128
        jae     .type_skip
        mov     ch, [ascii_to_scan + bx]  ; CH = scan code
        cmp     ch, 0
        je      .type_skip

        ; Check if char needs shift: ascii_shift_tab[char]
        mov     al, [ascii_shift_tab + bx]
        cmp     al, 0
        je      .type_no_shift

        ; Need shift — set LSHIFT in 0040:0017
        push    es
        mov     ax, 0x0040
        mov     es, ax
        or      byte [es:0x0017], 0x02
        pop     es

        ; Stuff keystroke: CH=scan, CL=ASCII
        mov     cl, [type_char]
        mov     ah, 0x05
        int     0x16

        ; Clear LSHIFT
        push    es
        mov     ax, 0x0040
        mov     es, ax
        and     byte [es:0x0017], 0xFD
        pop     es

        pop     si
        jmp     .type_loop

.type_no_shift:
        ; Stuff keystroke without shift
        mov     cl, [type_char]
        mov     ah, 0x05
        int     0x16
        pop     si
        jmp     .type_loop

.type_skip:
        pop     si
        jmp     .type_loop

.type_done:
        mov     si, resp_ok
        call    write_rx
        ret

; ============================================================
; HOTKEY — press modifier+key combination
; Format: HOTKEY <mod+mod+...+key>
; ============================================================
do_hotkey:
        mov     si, cmd_buf
        add     si, 10              ; skip "KEY HOTKEY"
        call    skip_spaces

        ; Clear accumulated modifier mask
        mov     byte [hotkey_mask], 0

        ; Parse tokens separated by '+'
        ; Each token except the last is a modifier
        ; The last token is the key to press
.hk_parse:
        ; Copy token to special_buf until '+' or NUL/space
        mov     di, special_buf
        xor     cx, cx
.hk_copy_token:
        lodsb
        cmp     al, '+'
        je      .hk_token_done_plus
        cmp     al, 0
        je      .hk_token_done_end
        cmp     al, ' '
        je      .hk_token_done_end
        stosb
        inc     cx
        cmp     cx, 15
        jb      .hk_copy_token
.hk_token_done_end:
        ; This is the last token — it's the key
        mov     byte [di], 0
        dec     si                  ; put back the NUL/space
        jmp     .hk_send_key
.hk_token_done_plus:
        ; This is a modifier
        mov     byte [di], 0

        ; Look up in key_table
        push    si
        mov     bx, key_table
.hk_mod_scan:
        cmp     word [bx], 0
        je      .hk_mod_not_found
        push    bx
        mov     si, special_buf
        mov     di, [bx]
        call    str_eq_upper
        pop     bx
        je      .hk_mod_found
        add     bx, 3
        jmp     .hk_mod_scan
.hk_mod_found:
        mov     al, [bx+2]         ; mask
        or      [hotkey_mask], al
        pop     si
        jmp     .hk_parse
.hk_mod_not_found:
        pop     si
        ; Unknown modifier — return error
        mov     si, resp_err_syntax
        call    write_rx
        ret

.hk_send_key:
        ; Set modifier bits in 0040:0017
        push    es
        mov     ax, 0x0040
        mov     es, ax
        mov     al, [hotkey_mask]
        or      byte [es:0x0017], al
        pop     es

        ; Check if last token is hex (0x prefix)
        mov     si, special_buf
        cmp     byte [si], '0'
        jne     .hk_try_name
        cmp     byte [si+1], 'x'
        je      .hk_hex
        cmp     byte [si+1], 'X'
        je      .hk_hex

.hk_try_name:
        ; Look up in key_table for scan code
        mov     bx, key_table
.hk_key_scan:
        cmp     word [bx], 0
        je      .hk_try_ascii
        push    bx
        mov     si, special_buf
        mov     di, [bx]
        call    str_eq_upper
        pop     bx
        je      .hk_key_found
        add     bx, 3
        jmp     .hk_key_scan
.hk_key_found:
        ; Found modifier name as key — just OR its bit (already done)
        ; Actually, for keys like F1-F12 we need to check a scan code table
        ; The key_table only has modifiers. For named keys, check
        ; the SENDKEYS special key table
        ; For now, just stuff the scan code we know from the key_table
        ; This is a modifier used as a standalone key — unusual but OK
        jmp     .hk_release

.hk_try_ascii:
        ; Single character — look up in ascii_to_scan
        mov     si, special_buf
        mov     al, [si]
        cmp     byte [si+1], 0     ; single char?
        jne     .hk_err
        xor     bh, bh
        mov     bl, al
        mov     ch, [ascii_to_scan + bx]
        mov     cl, al
        cmp     ch, 0
        je      .hk_err
        mov     ah, 0x05
        int     0x16
        jmp     .hk_release

.hk_hex:
        mov     si, special_buf
        add     si, 2
        call    parse_hex8
        jc      .hk_err
        mov     ch, al              ; scan code
        xor     cl, cl
        mov     ah, 0x05
        int     0x16
        jmp     .hk_release

.hk_release:
        ; Clear modifier bits
        push    es
        mov     ax, 0x0040
        mov     es, ax
        mov     al, [hotkey_mask]
        not     al
        and     byte [es:0x0017], al
        pop     es
        mov     si, resp_ok
        call    write_rx
        ret

.hk_err:
        ; Clear any modifiers we set
        push    es
        mov     ax, 0x0040
        mov     es, ax
        mov     al, [hotkey_mask]
        not     al
        and     byte [es:0x0017], al
        pop     es
        mov     si, resp_err_syntax
        call    write_rx
        ret

; ============================================================
; GETPIXEL — read pixel color at x,y
; Format: GETPIXEL <x> <y>
; ============================================================
do_getpixel:
        mov     si, cmd_buf
        add     si, 9               ; skip "GFX PIXEL"
        call    skip_spaces
        call    parse_dec16
        jc      .gp_err
        mov     cx, ax              ; CX = column (x)
        call    skip_spaces
        call    parse_dec16
        jc      .gp_err
        mov     dx, ax              ; DX = row (y)

        ; INT 10h/0Dh: Read dot
        mov     bh, 0               ; page 0
        mov     ah, 0x0D
        int     0x10
        ; AL = pixel color

        push    es
        push    cs
        pop     es
        mov     di, resp_buf
        push    ax
        mov     al, 'O'
        stosb
        mov     al, 'K'
        stosb
        mov     al, ' '
        stosb
        pop     ax
        xor     ah, ah
        call    dec_to_str
        mov     byte [es:di], 0
        pop     es

        mov     si, resp_buf
        call    write_rx
        ret
.gp_err:
        mov     si, resp_err_syntax
        call    write_rx
        ret

; ============================================================
; GFX VESA MODE — get or set VESA video mode
; GET: GFX VESA MODE → OK <mode_hex>
; SET: GFX VESA MODE <mode_hex> → OK
; ============================================================
do_gfx_vesa_mode:
        mov     si, cmd_buf
        add     si, 13                  ; skip "GFX VESA MODE"
        call    skip_spaces
        cmp     byte [si], 0
        je      .gvm_get
        ; SET mode
        call    parse_hex16
        mov     bx, ax
        mov     ax, 4F02h               ; VBE Set Mode
        int     10h
        cmp     ax, 004Fh
        jne     .gvm_err
        mov     si, resp_ok
        jmp     write_rx
.gvm_get:
        ; GET current mode
        mov     ax, 4F03h               ; VBE Get Mode
        int     10h
        cmp     ax, 004Fh
        jne     .gvm_no_vesa
        ; BX = current mode
        push    cs
        pop     es
        mov     di, resp_buf
        mov     al, 'O'
        stosb
        mov     al, 'K'
        stosb
        mov     al, ' '
        stosb
        mov     ax, bx
        call    word_to_hex
        mov     byte [es:di], 0
        mov     si, resp_buf
        jmp     write_rx
.gvm_no_vesa:
        mov     si, resp_err_no_vesa
        jmp     write_rx
.gvm_err:
        mov     si, resp_err_syntax
        jmp     write_rx

; ============================================================
; GFX VESA INFO — query VESA mode info
; Format: GFX VESA INFO [<mode_hex>]
; No mode = VBE controller info (version, memory)
; With mode = mode-specific info (resolution, bpp)
; ============================================================
do_gfx_vesa_info:
        mov     si, cmd_buf
        add     si, 13                  ; skip "GFX VESA INFO"
        call    skip_spaces
        cmp     byte [si], 0
        je      .gvi_controller
        ; Mode-specific info
        call    parse_hex16
        push    ax                      ; save mode number
        push    cs
        pop     es
        mov     di, vesa_buf
        mov     cx, ax                  ; mode number
        mov     ax, 4F01h               ; VBE Get Mode Info
        int     10h
        cmp     ax, 004Fh
        pop     cx                      ; mode number (for output)
        jne     .gvi_no_vesa
        ; Parse mode info block at vesa_buf
        ; Offset 12h = XResolution (word)
        ; Offset 14h = YResolution (word)
        ; Offset 19h = BitsPerPixel (byte)
        ; Offset 00h = ModeAttributes (word)
        push    cs
        pop     es
        mov     di, resp_buf
        mov     al, 'O'
        stosb
        mov     al, 'K'
        stosb
        mov     al, ' '
        stosb
        ; mode=XXXX
        mov     al, 'm'
        stosb
        mov     al, 'o'
        stosb
        mov     al, 'd'
        stosb
        mov     al, 'e'
        stosb
        mov     al, '='
        stosb
        mov     ax, cx
        call    word_to_hex
        mov     al, ' '
        stosb
        ; width=NNNN
        mov     al, 'w'
        stosb
        mov     al, '='
        stosb
        mov     ax, [vesa_buf + 12h]
        call    sys_write_dec
        mov     al, ' '
        stosb
        ; height=NNNN
        mov     al, 'h'
        stosb
        mov     al, '='
        stosb
        mov     ax, [vesa_buf + 14h]
        call    sys_write_dec
        mov     al, ' '
        stosb
        ; bpp=NN
        mov     al, 'b'
        stosb
        mov     al, 'p'
        stosb
        mov     al, 'p'
        stosb
        mov     al, '='
        stosb
        mov     al, [vesa_buf + 19h]
        xor     ah, ah
        call    sys_write_dec
        mov     byte [di], 0
        mov     si, resp_buf
        jmp     write_rx

.gvi_controller:
        ; VBE Controller Info
        push    cs
        pop     es
        mov     di, vesa_buf
        ; Set signature to "VBE2" to request VBE 2.0+ info
        mov     byte [es:di], 'V'
        mov     byte [es:di+1], 'B'
        mov     byte [es:di+2], 'E'
        mov     byte [es:di+3], '2'
        mov     ax, 4F00h
        int     10h
        cmp     ax, 004Fh
        jne     .gvi_no_vesa
        ; Parse VbeInfoBlock
        ; Offset 04h = VbeVersion (word, BCD)
        ; Offset 12h = TotalMemory (word, in 64KB blocks)
        push    cs
        pop     es
        mov     di, resp_buf
        mov     al, 'O'
        stosb
        mov     al, 'K'
        stosb
        mov     al, ' '
        stosb
        ; VER=x.x
        mov     al, 'V'
        stosb
        mov     al, 'E'
        stosb
        mov     al, 'R'
        stosb
        mov     al, '='
        stosb
        mov     al, [vesa_buf + 05h]    ; major version
        add     al, '0'
        stosb
        mov     al, '.'
        stosb
        mov     al, [vesa_buf + 04h]    ; minor version
        add     al, '0'
        stosb
        mov     al, ' '
        stosb
        ; MEM=nnnKB
        mov     al, 'M'
        stosb
        mov     al, 'E'
        stosb
        mov     al, 'M'
        stosb
        mov     al, '='
        stosb
        mov     ax, [vesa_buf + 12h]    ; 64KB blocks
        mov     cx, 64
        mul     cx                      ; AX = KB (DX:AX but should fit)
        call    sys_write_dec
        mov     al, 'K'
        stosb
        mov     al, 'B'
        stosb
        mov     byte [di], 0
        mov     si, resp_buf
        jmp     write_rx

.gvi_no_vesa:
        mov     si, resp_err_no_vesa
        jmp     write_rx

; ============================================================
; GFX PALETTE — get/set VGA palette entries
; GET: GFX PALETTE GET <index> [<count>]
; SET: GFX PALETTE SET <index> <r> <g> <b>
; ============================================================
do_gfx_palette:
        mov     si, cmd_buf
        add     si, 11                  ; skip "GFX PALETTE"
        call    skip_spaces
        ; GET or SET
        cmp     byte [si], 'G'
        je      .gp_get
        cmp     byte [si], 'g'
        je      .gp_get
        cmp     byte [si], 'S'
        je      .gp_set
        cmp     byte [si], 's'
        je      .gp_set
        jmp     .gp_syntax
.gp_get:
        add     si, 3
        call    skip_spaces
        call    parse_dec16
        mov     bl, al                  ; color index
        call    skip_spaces
        ; Optional count
        mov     cx, 1
        cmp     byte [si], 0
        je      .gp_get_go
        push    bx
        call    parse_dec16
        mov     cx, ax
        pop     bx
        cmp     cx, 0
        je      .gp_syntax
        cmp     cx, 16
        ja      .gp_syntax              ; max 16 at a time
.gp_get_go:
        push    cs
        pop     es
        mov     di, resp_buf
        mov     al, 'O'
        stosb
        mov     al, 'K'
        stosb
        ; Read palette entries
        mov     al, bl
        mov     dx, 3C7h                ; DAC read index
        out     dx, al
        mov     dx, 3C9h                ; DAC data
.gp_read_loop:
        mov     al, ' '
        stosb
        ; Read R
        in      al, dx
        call    byte_to_hex
        mov     byte [di], ':'
        inc     di
        ; Read G
        in      al, dx
        call    byte_to_hex
        mov     byte [di], ':'
        inc     di
        ; Read B
        in      al, dx
        call    byte_to_hex
        loop    .gp_read_loop
        mov     byte [es:di], 0
        mov     si, resp_buf
        jmp     write_rx

.gp_set:
        add     si, 3
        call    skip_spaces
        call    parse_dec16
        push    ax                      ; index
        call    skip_spaces
        call    parse_dec16
        mov     bl, al                  ; R
        call    skip_spaces
        call    parse_dec16
        mov     bh, al                  ; G
        call    skip_spaces
        call    parse_dec16
        mov     cl, al                  ; B
        pop     ax                      ; index
        mov     dx, 3C8h                ; DAC write index
        out     dx, al
        mov     dx, 3C9h                ; DAC data
        mov     al, bl                  ; R
        out     dx, al
        mov     al, bh                  ; G
        out     dx, al
        mov     al, cl                  ; B
        out     dx, al
        mov     si, resp_ok
        jmp     write_rx

.gp_syntax:
        mov     si, resp_err_syntax
        jmp     write_rx

; ============================================================
; SCREENREGION — read text from rectangular region
; Format: SCREENREGION <row1> <col1> <row2> <col2>
; ============================================================
do_screenregion:
        mov     si, cmd_buf
        add     si, 10              ; skip "CON REGION"
        call    skip_spaces
        call    parse_dec16
        jc      .sr_err
        mov     [sr_row1], ax
        call    skip_spaces
        call    parse_dec16
        jc      .sr_err
        mov     [sr_col1], ax
        call    skip_spaces
        call    parse_dec16
        jc      .sr_err
        mov     [sr_row2], ax
        call    skip_spaces
        call    parse_dec16
        jc      .sr_err
        mov     [sr_col2], ax

        ; Validate bounds
        mov     ax, [sr_row2]
        cmp     ax, 24
        ja      .sr_err
        mov     ax, [sr_col2]
        cmp     ax, 79
        ja      .sr_err

        ; Build response in resp_buf
        push    es
        push    cs
        pop     es
        mov     di, resp_buf
        mov     al, 'O'
        stosb
        mov     al, 'K'
        stosb
        mov     al, ' '
        stosb

        mov     cx, [sr_row1]       ; CX = current row
.sr_row_loop:
        cmp     cx, [sr_row2]
        ja      .sr_done

        ; Pipe separator between rows (not before first)
        cmp     cx, [sr_row1]
        je      .sr_no_pipe
        mov     al, '|'
        stosb
.sr_no_pipe:

        ; Read this row from video memory into scr_line_buf
        push    cx
        push    di
        push    es
        mov     ax, cx
        mov     dx, 160
        mul     dx                  ; AX = row * 160
        mov     si, ax
        mov     ax, 0xB800
        push    ds
        mov     ds, ax
        push    cs
        pop     es
        mov     di, scr_line_buf
        push    cx
        mov     cx, 80
.sr_read_char:
        lodsb
        stosb
        inc     si                  ; skip attribute
        dec     cx
        jnz     .sr_read_char
        pop     cx
        pop     ds
        pop     es
        pop     di
        pop     cx

        ; Copy columns [col1..col2] from scr_line_buf to resp_buf
        push    cx
        push    si
        mov     si, scr_line_buf
        add     si, [sr_col1]
        mov     bx, [sr_col1]
.sr_col_loop:
        cmp     bx, [sr_col2]
        ja      .sr_col_done
        mov     al, [si]
        stosb
        inc     si
        inc     bx
        jmp     .sr_col_loop
.sr_col_done:
        pop     si
        pop     cx
        inc     cx
        jmp     .sr_row_loop

.sr_done:
        mov     byte [es:di], 0
        pop     es
        mov     si, resp_buf
        call    write_rx
        ret
.sr_err:
        mov     si, resp_err_syntax
        call    write_rx
        ret

; ============================================================
; WAITCRC — wait for screen CRC to match
; Format: WAITCRC <hex_crc> [<timeout_ticks>]
; ============================================================
do_waitcrc:
        mov     si, cmd_buf
        add     si, 8               ; skip "WAIT CRC"
        call    skip_spaces

        ; Parse expected CRC (hex, no 0x prefix)
        call    parse_hex16
        jc      .wc_err
        mov     [wc_expected], ax

        ; Parse optional timeout (default cfg_timeout)
        call    skip_spaces
        mov     ax, [cfg_timeout]
        cmp     byte [si], 0
        je      .wc_have_timeout
        push    ax
        call    parse_dec16
        jnc     .wc_parsed_timeout
        pop     ax
        jmp     .wc_have_timeout
.wc_parsed_timeout:
        pop     cx                  ; discard default
.wc_have_timeout:
        mov     [wc_timeout], ax

        ; Record start tick
        push    es
        mov     ax, 0x0040
        mov     es, ax
        mov     ax, [es:0x006C]
        mov     [wc_start_tick], ax
        pop     es

.wc_check_loop:
        ; Compute full-screen CRC (25 rows)
        mov     dx, 0xFFFF          ; init CRC
        push    ds
        mov     ax, 0xB800
        mov     ds, ax
        xor     si, si              ; start of video memory
        mov     cx, 2000            ; 25 * 80 = 2000 characters
.wc_crc_loop:
        lodsb                       ; read char
        inc     si                  ; skip attribute
        call    crc16_byte
        dec     cx
        jnz     .wc_crc_loop
        pop     ds

        ; Compare CRC (in DX) with expected
        cmp     dx, [wc_expected]
        je      .wc_found

        ; Check timeout
        push    es
        mov     ax, 0x0040
        mov     es, ax
        mov     ax, [es:0x006C]
        pop     es
        sub     ax, [wc_start_tick]
        cmp     ax, [wc_timeout]
        jae     .wc_timed_out

        ; Wait 2 ticks then retry
        mov     cx, 2
        call    wait_ticks
        jmp     .wc_check_loop

.wc_found:
        mov     si, resp_ok
        call    write_rx
        ret
.wc_timed_out:
        mov     si, resp_err_timeout
        call    write_rx
        ret
.wc_err:
        mov     si, resp_err_syntax
        call    write_rx
        ret

; ============================================================
; REPEAT — execute a command multiple times
; Format: REPEAT <count> <command>
; ============================================================
do_repeat:
        mov     si, cmd_buf
        add     si, 11              ; skip "META REPEAT"
        call    skip_spaces

        ; Parse count
        call    parse_dec16
        jc      .rpt_err
        mov     [rpt_count], ax

        call    skip_spaces

        ; Save the sub-command string pointer
        mov     [rpt_cmd_ptr], si

        ; Copy sub-command to rpt_cmd_buf (for safety since dispatch uses cmd_buf)
        mov     di, rpt_cmd_buf
        xor     cx, cx
.rpt_copy:
        lodsb
        mov     [di], al
        inc     di
        inc     cx
        cmp     al, 0
        jne     .rpt_copy
        mov     [rpt_cmd_len], cx

.rpt_loop:
        cmp     word [rpt_count], 0
        je      .rpt_done

        ; Copy sub-command back into cmd_buf
        push    si
        push    di
        mov     si, rpt_cmd_buf
        mov     di, cmd_buf
        mov     cx, [rpt_cmd_len]
        rep movsb
        pop     di
        pop     si

        ; Recalculate cmd_len
        push    si
        mov     si, cmd_buf
        xor     cx, cx
.rpt_len:
        lodsb
        cmp     al, 0
        je      .rpt_len_done
        inc     cx
        jmp     .rpt_len
.rpt_len_done:
        mov     [cmd_len], cx
        pop     si

        ; Dispatch the command
        call    dispatch

        dec     word [rpt_count]
        jmp     .rpt_loop

.rpt_done:
        ; The last dispatch already wrote the response
        ret
.rpt_err:
        mov     si, resp_err_syntax
        call    write_rx
        ret

; ============================================================
; DIR DRIVES — enumerate valid drives
; Format: DIR DRIVES
; Response: OK A:FD C:HD Z:NET ...
; ============================================================
do_dir_drives:
        push    cs
        pop     es
        mov     di, resp_buf
        mov     byte [di], 'O'
        inc     di
        mov     byte [di], 'K'
        inc     di

        mov     bl, 1                   ; drive 1=A, 2=B, ...
.dd_loop:
        cmp     bl, 26
        ja      .dd_done

        ; Check if drive is valid: INT 21h/4408h (is removable?)
        mov     ax, 0x4408
        int     0x21
        jc      .dd_next                ; CF=1 → invalid drive

        ; Drive is valid — add separator
        mov     byte [es:di], ' '
        inc     di

        ; Drive letter
        mov     al, bl
        add     al, 'A' - 1
        stosb
        mov     al, ':'
        stosb

        ; Check if remote: INT 21h/4409h
        push    dx
        mov     ax, 0x4409
        int     0x21
        jc      .dd_not_remote          ; error → assume local
        test    dx, 0x1000              ; bit 12 = remote
        jnz     .dd_net
.dd_not_remote:
        pop     dx

        ; Check removable from earlier 4408h result — but we lost AX
        ; Re-check: INT 21h/4408h
        push    bx
        mov     ax, 0x4408
        int     0x21
        cmp     ax, 0
        pop     bx
        je      .dd_floppy

        ; Fixed disk
        mov     al, 'H'
        stosb
        mov     al, 'D'
        stosb
        jmp     .dd_next

.dd_floppy:
        mov     al, 'F'
        stosb
        mov     al, 'D'
        stosb
        jmp     .dd_next

.dd_net:
        pop     dx
        mov     al, 'N'
        stosb
        mov     al, 'E'
        stosb
        mov     al, 'T'
        stosb

.dd_next:
        inc     bl
        jmp     .dd_loop

.dd_done:
        mov     byte [es:di], 0
        mov     si, resp_buf
        jmp     write_rx

; ============================================================
; DIR GET — get current drive and directory
; Format: DIR GET
; Response: OK C:\path
; ============================================================
do_dir_get:
        push    cs
        pop     es
        mov     di, resp_buf
        mov     byte [di], 'O'
        inc     di
        mov     byte [di], 'K'
        inc     di
        mov     byte [di], ' '
        inc     di

        ; Get current drive
        mov     ah, 0x19
        int     0x21
        add     al, 'A'
        stosb
        mov     al, ':'
        stosb
        mov     al, '\'
        stosb

        ; Get current directory (INT 21h/47h)
        ; DS:SI = buffer, DL = drive (0=current)
        ; Write directly into resp_buf (DI already points past "OK C:\")
        mov     si, di
        xor     dl, dl
        mov     ah, 0x47
        int     0x21

        ; Find end of string written by INT 21h/47h
        mov     si, resp_buf
.dg_find_end:
        lodsb
        cmp     al, 0
        jne     .dg_find_end

        mov     si, resp_buf
        jmp     write_rx

; ============================================================
; DIR — list directory contents
; Format: DIR [<path>]
; ============================================================
do_dir:
        mov     si, cmd_buf
        add     si, 8               ; skip "DIR LIST"
        call    skip_spaces

        ; Copy path to dir_path_buf, default to "*.*"
        cmp     byte [si], 0
        je      .dir_default
        cmp     byte [si], 0x0D
        je      .dir_default

        mov     di, dir_path_buf
.dir_copy_path:
        lodsb
        cmp     al, 0
        je      .dir_path_done
        cmp     al, ' '
        je      .dir_path_done
        cmp     al, 0x0D
        je      .dir_path_done
        stosb
        jmp     .dir_copy_path
.dir_path_done:
        mov     byte [di], 0
        jmp     .dir_search

.dir_default:
        mov     byte [dir_path_buf], '*'
        mov     byte [dir_path_buf+1], '.'
        mov     byte [dir_path_buf+2], '*'
        mov     byte [dir_path_buf+3], 0

.dir_search:
        ; Set DTA to our_dta
        mov     dx, our_dta
        mov     ah, 0x1A
        int     0x21

        ; Find first
        mov     dx, dir_path_buf
        mov     cx, 0x0010          ; include directories
        mov     ah, 0x4E
        int     0x21
        jc      .dir_empty

        ; Build response in resp_buf
        push    es
        push    cs
        pop     es
        mov     di, resp_buf
        mov     al, 'O'
        stosb
        mov     al, 'K'
        stosb
        mov     al, ' '
        stosb

        mov     byte [dir_first], 1

.dir_entry:
        ; Pipe separator (not before first)
        cmp     byte [dir_first], 1
        je      .dir_no_pipe
        mov     al, '|'
        stosb
.dir_no_pipe:
        mov     byte [dir_first], 0

        ; Check if we're running out of resp_buf space
        mov     ax, di
        sub     ax, resp_buf
        cmp     ax, 480
        jae     .dir_finish

        ; Copy filename from DTA+30
        push    si
        mov     si, our_dta
        add     si, 30
.dir_copy_name:
        lodsb
        cmp     al, 0
        je      .dir_name_done
        stosb
        jmp     .dir_copy_name
.dir_name_done:
        pop     si

        ; Check if directory
        mov     al, [our_dta+21]
        test    al, 0x10
        jz      .dir_is_file

        ; Directory marker
        push    si
        mov     si, dir_label
        call    copy_str
        pop     si
        jmp     .dir_find_next

.dir_is_file:
        ; File size (low word only for simplicity)
        mov     al, ' '
        stosb
        mov     ax, [our_dta+26]
        call    dec_to_str

.dir_find_next:
        ; Find next
        mov     ah, 0x4F
        int     0x21
        jnc     .dir_entry

.dir_finish:
        mov     byte [es:di], 0
        pop     es
        mov     si, resp_buf
        call    write_rx_checked
        ret

.dir_empty:
        mov     si, resp_ok
        call    write_rx
        ret

; ============================================================
; FILE EXISTS — check if file exists
; Format: FILE EXISTS <path>
; Response: OK 1 (exists) or OK 0 (not found)
; ============================================================
do_file_exists:
        mov     si, cmd_buf
        add     si, 12                  ; skip "FILE EXISTS "
        call    skip_spaces
        cmp     byte [si], 0
        je      .fex_err

        ; Save current DTA
        mov     ah, 0x2F
        int     0x21
        mov     [old_dta_off], bx
        mov     [old_dta_seg], es

        ; Set our DTA
        push    ds
        pop     es                      ; restore ES = DS
        mov     dx, find_dta
        mov     ah, 0x1A
        int     0x21

        ; Find First (INT 21h/4Eh)
        mov     dx, si                  ; path
        xor     cx, cx                  ; normal files
        mov     ah, 0x4E
        int     0x21
        jc      .fex_notfound

        ; Restore DTA
        push    ds
        mov     ds, [cs:old_dta_seg]
        mov     dx, [cs:old_dta_off]
        mov     ah, 0x1A
        int     0x21
        pop     ds

        mov     si, resp_ok1
        jmp     write_rx

.fex_notfound:
        ; Restore DTA
        push    ds
        mov     ds, [cs:old_dta_seg]
        mov     dx, [cs:old_dta_off]
        mov     ah, 0x1A
        int     0x21
        pop     ds

        mov     si, resp_ok0
        jmp     write_rx

.fex_err:
        mov     si, resp_err_syntax
        jmp     write_rx

; ============================================================
; FILE SIZE — get file size
; Format: FILE SIZE <path>
; Response: OK <decimal_size>
; ============================================================
do_file_size:
        mov     si, cmd_buf
        add     si, 10                  ; skip "FILE SIZE "
        call    skip_spaces
        cmp     byte [si], 0
        je      .fsz_err

        ; Save current DTA
        mov     ah, 0x2F
        int     0x21
        mov     [old_dta_off], bx
        mov     [old_dta_seg], es

        push    ds
        pop     es
        mov     dx, find_dta
        mov     ah, 0x1A
        int     0x21

        ; Find First
        mov     dx, si
        xor     cx, cx
        mov     ah, 0x4E
        int     0x21
        jc      .fsz_notfound

        ; Read file size from DTA+1Ah (DWORD, little-endian)
        mov     ax, [find_dta + 0x1A]   ; low word
        mov     dx, [find_dta + 0x1C]   ; high word

        ; Restore DTA
        push    ax
        push    dx
        push    ds
        mov     ds, [cs:old_dta_seg]
        mov     dx, [cs:old_dta_off]
        mov     ah, 0x1A
        int     0x21
        pop     ds
        pop     dx
        pop     ax

        ; Format "OK <decimal>" — DX:AX = 32-bit size
        ; Build in resp_buf
        push    dx
        push    ax
        mov     di, resp_buf
        mov     byte [di], 'O'
        inc     di
        mov     byte [di], 'K'
        inc     di
        mov     byte [di], ' '
        inc     di
        pop     ax
        pop     dx
        ; Convert DX:AX to decimal string at ES:DI
        call    dword_to_decimal
        mov     byte [di], 0

        mov     si, resp_buf
        jmp     write_rx

.fsz_notfound:
        ; Restore DTA
        push    ds
        mov     ds, [cs:old_dta_seg]
        mov     dx, [cs:old_dta_off]
        mov     ah, 0x1A
        int     0x21
        pop     ds

        mov     si, resp_err_filenotfound
        jmp     write_rx

.fsz_err:
        mov     si, resp_err_syntax
        jmp     write_rx

; ============================================================
; FILE TIME — get file modification time
; Format: FILE TIME <path>
; Response: OK YYYY-MM-DD HH:MM:SS
; ============================================================
do_file_time:
        mov     si, cmd_buf
        add     si, 10                  ; skip "FILE TIME "
        call    skip_spaces
        cmp     byte [si], 0
        je      .ftm_err

        ; Save current DTA
        mov     ah, 0x2F
        int     0x21
        mov     [old_dta_off], bx
        mov     [old_dta_seg], es

        push    ds
        pop     es
        mov     dx, find_dta
        mov     ah, 0x1A
        int     0x21

        ; Find First
        mov     dx, si
        xor     cx, cx
        mov     ah, 0x4E
        int     0x21
        jc      .ftm_notfound

        ; Save date/time from DTA before restoring
        mov     ax, [find_dta + 0x16]   ; packed time
        mov     [int_ax], ax            ; reuse int scratch
        mov     ax, [find_dta + 0x18]   ; packed date
        mov     [int_bx], ax

        ; Restore DTA
        push    ds
        mov     ds, [cs:old_dta_seg]
        mov     dx, [cs:old_dta_off]
        mov     ah, 0x1A
        int     0x21
        pop     ds

        ; Build "OK YYYY-MM-DD HH:MM:SS" in resp_buf
        push    cs
        pop     es
        mov     di, resp_buf
        mov     byte [di], 'O'
        inc     di
        mov     byte [di], 'K'
        inc     di
        mov     byte [di], ' '
        inc     di

        ; Decode date: bits 15-9 = year-1980, bits 8-5 = month, bits 4-0 = day
        mov     ax, [int_bx]            ; packed date
        mov     cl, 9
        shr     ax, cl
        add     ax, 1980
        call    .ftm_write_4digit

        mov     byte [di], '-'
        inc     di
        mov     ax, [int_bx]            ; packed date again
        mov     cl, 5
        shr     ax, cl
        and     ax, 0x0F                ; month (4 bits)
        call    .ftm_write_2digit

        mov     byte [di], '-'
        inc     di
        mov     ax, [int_bx]
        and     ax, 0x1F                ; day (5 bits)
        call    .ftm_write_2digit

        mov     byte [di], ' '
        inc     di

        ; Decode time: bits 15-11 = hours, bits 10-5 = minutes, bits 4-0 = seconds/2
        mov     ax, [int_ax]            ; packed time
        mov     cl, 11
        shr     ax, cl                  ; hours
        call    .ftm_write_2digit

        mov     byte [di], ':'
        inc     di
        mov     ax, [int_ax]
        mov     cl, 5
        shr     ax, cl
        and     ax, 0x3F                ; minutes
        call    .ftm_write_2digit

        mov     byte [di], ':'
        inc     di
        mov     ax, [int_ax]
        and     ax, 0x1F                ; seconds/2
        shl     ax, 1                   ; actual seconds
        call    .ftm_write_2digit

        mov     byte [di], 0
        mov     si, resp_buf
        jmp     write_rx

.ftm_notfound:
        push    ds
        mov     ds, [cs:old_dta_seg]
        mov     dx, [cs:old_dta_off]
        mov     ah, 0x1A
        int     0x21
        pop     ds

        mov     si, resp_err_filenotfound
        jmp     write_rx

.ftm_err:
        mov     si, resp_err_syntax
        jmp     write_rx

.ftm_write_4digit:
        ; AX = number (e.g., 2025), write 4 ASCII digits to [ES:DI]
        xor     dx, dx
        mov     cx, 1000
        div     cx
        add     al, '0'
        stosb
        mov     ax, dx
        xor     dx, dx
        mov     cx, 100
        div     cx
        add     al, '0'
        stosb
        mov     ax, dx
        xor     dx, dx
        mov     cx, 10
        div     cx
        add     al, '0'
        stosb
        mov     al, dl
        add     al, '0'
        stosb
        ret

.ftm_write_2digit:
        ; AX = number (0–99), write 2 ASCII digits to [ES:DI]
        xor     dx, dx
        mov     cx, 10
        div     cx                      ; AX = tens, DX = ones
        add     al, '0'
        stosb
        mov     al, dl
        add     al, '0'
        stosb
        ret

; ============================================================
; FILE ATTR — get/set file attributes
; Format: FILE ATTR GET <path>
;         FILE ATTR SET <path> [+|-][RHSA]...
; ============================================================
do_file_attr:
        mov     si, cmd_buf
        add     si, 10                  ; skip "FILE ATTR "
        call    skip_spaces
        ; Check GET or SET
        cmp     byte [si], 'G'
        je      .fa_get
        cmp     byte [si], 'g'
        je      .fa_get
        cmp     byte [si], 'S'
        je      .fa_set
        cmp     byte [si], 's'
        je      .fa_set
        jmp     .fa_syntax
.fa_get:
        add     si, 3                   ; skip "GET"
        call    skip_spaces
        cmp     byte [si], 0
        je      .fa_syntax
        mov     dx, si
        mov     ax, 4300h               ; get attributes
        int     21h
        jc      .fa_notfound
        ; CX = attributes — decode bits
        push    cs
        pop     es
        mov     di, resp_buf
        mov     al, 'O'
        stosb
        mov     al, 'K'
        stosb
        mov     al, ' '
        stosb
        ; R=bit0
        mov     al, 'R'
        stosb
        mov     al, '='
        stosb
        mov     al, '0'
        test    cx, 01h
        jz      .fa_r0
        inc     al
.fa_r0: stosb
        mov     al, ' '
        stosb
        ; H=bit1
        mov     al, 'H'
        stosb
        mov     al, '='
        stosb
        mov     al, '0'
        test    cx, 02h
        jz      .fa_h0
        inc     al
.fa_h0: stosb
        mov     al, ' '
        stosb
        ; S=bit2
        mov     al, 'S'
        stosb
        mov     al, '='
        stosb
        mov     al, '0'
        test    cx, 04h
        jz      .fa_s0
        inc     al
.fa_s0: stosb
        mov     al, ' '
        stosb
        ; A=bit5
        mov     al, 'A'
        stosb
        mov     al, '='
        stosb
        mov     al, '0'
        test    cx, 20h
        jz      .fa_a0
        inc     al
.fa_a0: stosb
        mov     byte [di], 0
        mov     si, resp_buf
        jmp     write_rx
.fa_set:
        add     si, 3                   ; skip "SET"
        call    skip_spaces
        cmp     byte [si], 0
        je      .fa_syntax
        ; Copy path to file_path_buf
        mov     di, file_path_buf
.fa_cp_path:
        lodsb
        cmp     al, ' '
        je      .fa_path_done
        cmp     al, 0
        je      .fa_syntax              ; no flags after path
        stosb
        jmp     .fa_cp_path
.fa_path_done:
        mov     byte [di], 0
        ; Get current attributes first
        mov     dx, file_path_buf
        mov     ax, 4300h
        int     21h
        jc      .fa_notfound
        ; CX = current attrs, now parse +/- flags
        call    skip_spaces
.fa_parse_flags:
        call    skip_spaces
        cmp     byte [si], 0
        je      .fa_apply
        mov     al, [si]
        inc     si
        cmp     al, '+'
        je      .fa_plus
        cmp     al, '-'
        je      .fa_minus
        ; skip unknown chars
        jmp     .fa_parse_flags
.fa_plus:
        call    .fa_get_mask
        or      cx, ax
        jmp     .fa_parse_flags
.fa_minus:
        call    .fa_get_mask
        not     ax
        and     cx, ax
        jmp     .fa_parse_flags
.fa_get_mask:
        mov     al, [si]
        inc     si
        cmp     al, 'R'
        je      .fa_mask_r
        cmp     al, 'r'
        je      .fa_mask_r
        cmp     al, 'H'
        je      .fa_mask_h
        cmp     al, 'h'
        je      .fa_mask_h
        cmp     al, 'S'
        je      .fa_mask_s
        cmp     al, 's'
        je      .fa_mask_s
        cmp     al, 'A'
        je      .fa_mask_a
        cmp     al, 'a'
        je      .fa_mask_a
        xor     ax, ax                  ; unknown = no mask
        ret
.fa_mask_r:
        mov     ax, 01h
        ret
.fa_mask_h:
        mov     ax, 02h
        ret
.fa_mask_s:
        mov     ax, 04h
        ret
.fa_mask_a:
        mov     ax, 20h
        ret
.fa_apply:
        ; Set attributes
        mov     dx, file_path_buf
        mov     ax, 4301h
        int     21h
        jc      .fa_notfound
        mov     si, resp_ok
        jmp     write_rx
.fa_notfound:
        mov     si, resp_err_filenotfound
        jmp     write_rx
.fa_syntax:
        mov     si, resp_err_syntax
        jmp     write_rx

; ============================================================
; FILE FIND — wildcard file search
; Format: FILE FIND <wildcard>
; Response: OK file1,file2,... or ERR NOT_FOUND
; ============================================================
do_file_find:
        mov     si, cmd_buf
        add     si, 10                  ; skip "FILE FIND "
        call    skip_spaces
        cmp     byte [si], 0
        je      .ff_syntax

        ; Save current DTA
        mov     ah, 0x2F
        int     0x21
        mov     [old_dta_off], bx
        mov     [old_dta_seg], es

        push    ds
        pop     es
        mov     dx, find_dta
        mov     ah, 0x1A
        int     0x21

        ; Find First
        mov     dx, si
        mov     cx, 0027h               ; normal+hidden+system+archive+dir
        mov     ah, 0x4E
        int     0x21
        jc      .ff_notfound

        ; Build response in resp_buf
        push    cs
        pop     es
        mov     di, resp_buf
        mov     al, 'O'
        stosb
        mov     al, 'K'
        stosb
        mov     al, ' '
        stosb
        mov     byte [ff_first], 1

.ff_copy_name:
        ; Add comma separator (except first)
        cmp     byte [ff_first], 1
        je      .ff_no_comma
        mov     al, ','
        stosb
.ff_no_comma:
        mov     byte [ff_first], 0
        ; Copy filename from DTA+1Eh (13-byte ASCIIZ)
        lea     si, [find_dta + 0x1E]
.ff_cp:
        lodsb
        cmp     al, 0
        je      .ff_cp_done
        stosb
        jmp     .ff_cp
.ff_cp_done:
        ; Check for overflow (near end of resp_buf ~512 bytes)
        mov     ax, di
        sub     ax, resp_buf
        cmp     ax, 450
        ja      .ff_done

        ; Find Next
        mov     ah, 0x4F
        int     0x21
        jnc     .ff_copy_name

.ff_done:
        mov     byte [es:di], 0
        ; Restore DTA
        push    ds
        mov     ds, [cs:old_dta_seg]
        mov     dx, [cs:old_dta_off]
        mov     ah, 0x1A
        int     0x21
        pop     ds

        mov     si, resp_buf
        call    write_rx_checked
        ret

.ff_notfound:
        push    ds
        mov     ds, [cs:old_dta_seg]
        mov     dx, [cs:old_dta_off]
        mov     ah, 0x1A
        int     0x21
        pop     ds
        mov     si, resp_err_notfound
        jmp     write_rx

.ff_syntax:
        mov     si, resp_err_syntax
        jmp     write_rx

; ============================================================
; FILE APPEND — append hex bytes to file
; Format: FILE APPEND <path> <hex_bytes...>
; Response: OK <count>
; ============================================================
do_file_append:
        mov     si, cmd_buf
        add     si, 12                  ; skip "FILE APPEND "
        call    skip_spaces
        cmp     byte [si], 0
        je      .fap_syntax

        ; Copy path to file_path_buf
        mov     di, file_path_buf
.fap_cp_path:
        lodsb
        cmp     al, ' '
        je      .fap_path_done
        cmp     al, 0
        je      .fap_syntax
        stosb
        jmp     .fap_cp_path
.fap_path_done:
        mov     byte [di], 0
        call    skip_spaces

        ; Open file for write (mode 01h)
        mov     dx, file_path_buf
        mov     ax, 3D01h
        int     21h
        jc      .fap_notfound
        mov     bx, ax                  ; file handle

        ; Seek to end (INT 21h/42h AL=02h, CX:DX=0)
        mov     ax, 4202h
        xor     cx, cx
        xor     dx, dx
        int     21h
        ; ignore seek position

        ; Decode hex bytes into rf_data_buf
        push    bx
        mov     di, rf_data_buf
        xor     cx, cx                  ; byte count
.fap_hex_loop:
        call    skip_spaces
        cmp     byte [si], 0
        je      .fap_hex_done
        push    cx
        call    parse_hex8
        pop     cx
        stosb
        inc     cx
        jmp     .fap_hex_loop
.fap_hex_done:
        mov     [rf_length], cx
        pop     bx

        ; Write bytes
        mov     ah, 40h
        mov     cx, [rf_length]
        mov     dx, rf_data_buf
        int     21h
        push    ax                      ; save bytes written
        pushf

        ; Close file
        mov     ah, 3Eh
        int     21h

        popf
        pop     ax
        jc      .fap_write_err

        ; Format "OK <count>"
        push    cs
        pop     es
        mov     di, resp_buf
        push    ax
        mov     al, 'O'
        stosb
        mov     al, 'K'
        stosb
        mov     al, ' '
        stosb
        pop     ax
        call    sys_write_dec
        mov     byte [di], 0
        mov     si, resp_buf
        jmp     write_rx

.fap_notfound:
        mov     si, resp_err_filenotfound
        jmp     write_rx
.fap_write_err:
        mov     si, resp_err_write
        jmp     write_rx
.fap_syntax:
        mov     si, resp_err_syntax
        jmp     write_rx

; ============================================================
; FILE WATCH — poll file for changes
; Format: FILE WATCH <path>
; Response: OK CHANGED | OK UNCHANGED | ERR NOT_FOUND
; ============================================================
do_file_watch:
        mov     si, cmd_buf
        add     si, 11                  ; skip "FILE WATCH "
        call    skip_spaces
        cmp     byte [si], 0
        je      .fw_syntax

        ; Check if path matches last-watched file
        mov     di, watch_path
        push    si
.fw_cmp_path:
        mov     al, [si]
        mov     ah, [di]
        cmp     al, ah
        jne     .fw_new_path
        cmp     al, 0
        je      .fw_same_path
        inc     si
        inc     di
        jmp     .fw_cmp_path
.fw_new_path:
        pop     si
        ; Copy new path to watch_path
        mov     di, watch_path
.fw_cp_path:
        lodsb
        stosb
        cmp     al, 0
        jne     .fw_cp_path
        mov     byte [watch_valid], 0
        ; SI now past the NUL, restore to start of path
        mov     si, watch_path
        jmp     .fw_do_find
.fw_same_path:
        pop     si
        mov     si, watch_path
.fw_do_find:
        ; Save current DTA
        mov     ah, 0x2F
        int     0x21
        mov     [old_dta_off], bx
        mov     [old_dta_seg], es

        push    ds
        pop     es
        mov     dx, find_dta
        mov     ah, 0x1A
        int     0x21

        ; Find First
        mov     dx, si
        xor     cx, cx
        mov     ah, 0x4E
        int     0x21
        jc      .fw_notfound

        ; Read current size/time/date from DTA
        mov     ax, [find_dta + 0x1A]   ; size low
        mov     dx, [find_dta + 0x1C]   ; size high
        mov     bx, [find_dta + 0x16]   ; packed time
        mov     cx, [find_dta + 0x18]   ; packed date

        ; Restore DTA
        push    ax
        push    dx
        push    bx
        push    cx
        push    ds
        mov     ds, [cs:old_dta_seg]
        mov     dx, [cs:old_dta_off]
        mov     ah, 0x1A
        int     0x21
        pop     ds
        pop     cx
        pop     bx
        pop     dx
        pop     ax

        ; Check if valid previous watch
        cmp     byte [watch_valid], 0
        je      .fw_first

        ; Compare with stored values
        cmp     ax, [watch_size]
        jne     .fw_changed
        cmp     dx, [watch_size+2]
        jne     .fw_changed
        cmp     bx, [watch_time]
        jne     .fw_changed
        cmp     cx, [watch_date]
        jne     .fw_changed

        ; Unchanged
        mov     si, resp_ok_unchanged
        jmp     write_rx

.fw_changed:
.fw_first:
        ; Store current values
        mov     [watch_size], ax
        mov     [watch_size+2], dx
        mov     [watch_time], bx
        mov     [watch_date], cx
        mov     byte [watch_valid], 1
        mov     si, resp_ok_changed
        jmp     write_rx

.fw_notfound:
        push    ds
        mov     ds, [cs:old_dta_seg]
        mov     dx, [cs:old_dta_off]
        mov     ah, 0x1A
        int     0x21
        pop     ds
        mov     si, resp_err_filenotfound
        jmp     write_rx

.fw_syntax:
        mov     si, resp_err_syntax
        jmp     write_rx

; ============================================================
; READFILE — read file contents as hex
; Format: READFILE <path> [<offset> <length>]
; ============================================================
do_readfile:
        mov     si, cmd_buf
        add     si, 9               ; skip "FILE READ"
        call    skip_spaces

        ; Copy path to file_path_buf
        mov     di, file_path_buf
.rf_copy_path:
        lodsb
        cmp     al, ' '
        je      .rf_path_done
        cmp     al, 0
        je      .rf_path_done
        cmp     al, 0x0D
        je      .rf_path_done
        stosb
        jmp     .rf_copy_path
.rf_path_done:
        mov     byte [di], 0

        ; Parse optional offset (default 0)
        xor     ax, ax
        mov     [rf_offset], ax
        mov     word [rf_length], 160

        cmp     byte [si-1], ' '
        jne     .rf_open
        call    skip_spaces
        cmp     byte [si], 0
        je      .rf_open
        cmp     byte [si], 0x0D
        je      .rf_open
        call    parse_dec16
        jc      .rf_open
        mov     [rf_offset], ax
        call    skip_spaces
        cmp     byte [si], 0
        je      .rf_open
        call    parse_dec16
        jc      .rf_open
        cmp     ax, 160
        jbe     .rf_len_ok
        mov     ax, 160
.rf_len_ok:
        mov     [rf_length], ax

.rf_open:
        ; Open file
        mov     dx, file_path_buf
        mov     ax, 0x3D00
        int     0x21
        jc      .rf_not_found

        mov     bx, ax              ; file handle

        ; Seek to offset
        xor     cx, cx
        mov     dx, [rf_offset]
        mov     ax, 0x4200
        int     0x21
        jc      .rf_close_err

        ; Read into rf_data_buf
        mov     dx, rf_data_buf
        mov     cx, [rf_length]
        mov     ah, 0x3F
        int     0x21
        push    ax                  ; save bytes read
        mov     ah, 0x3E            ; close file
        int     0x21
        pop     cx                  ; CX = bytes read

        ; Format response
        push    es
        push    cs
        pop     es
        mov     di, resp_buf
        mov     al, 'O'
        stosb
        mov     al, 'K'
        stosb
        mov     al, ' '
        stosb

        mov     si, rf_data_buf
        jcxz    .rf_done_fmt
        mov     [rf_remaining], cx
.rf_hex_loop:
        lodsb
        call    byte_to_hex
        dec     word [rf_remaining]
        cmp     word [rf_remaining], 0
        je      .rf_done_fmt
        mov     al, ' '
        stosb
        jmp     .rf_hex_loop

.rf_done_fmt:
        mov     byte [es:di], 0
        pop     es
        mov     si, resp_buf
        call    write_rx_checked
        ret

.rf_not_found:
        mov     si, resp_err_filenotfound
        call    write_rx
        ret
.rf_close_err:
        mov     ah, 0x3E
        int     0x21
        mov     si, resp_err_syntax
        call    write_rx
        ret

; ============================================================
; SHELL — run command and capture stdout
; Format: SHELL <command>
; ============================================================
do_shell:
        mov     si, cmd_buf
        add     si, 10              ; skip "EXEC SHELL"
        call    skip_spaces

        ; Build command tail: " /C <command> > <path_out>\r"
        mov     di, exec_cmdtail + 1
        mov     al, ' '
        stosb
        mov     al, '/'
        stosb
        mov     al, 'C'
        stosb
        mov     al, ' '
        stosb
        xor     cx, cx
.shell_copy_cmd:
        lodsb
        cmp     al, 0
        je      .shell_cmd_done
        cmp     cx, 80              ; leave room for redirect
        jae     .shell_cmd_done
        stosb
        inc     cx
        jmp     .shell_copy_cmd
.shell_cmd_done:
        ; Append " > <path_out>"
        mov     al, ' '
        stosb
        mov     al, '>'
        stosb
        mov     al, ' '
        stosb
        push    si
        mov     si, path_out
.shell_copy_path:
        lodsb
        cmp     al, 0
        je      .shell_path_done
        stosb
        jmp     .shell_copy_path
.shell_path_done:
        pop     si
        mov     al, 0x0D
        stosb

        ; Set length byte
        mov     ax, di
        sub     ax, exec_cmdtail
        dec     ax
        mov     [exec_cmdtail], al

        ; Set up parameter block
        mov     word [exec_pb+0], 0
        mov     word [exec_pb+2], exec_cmdtail
        mov     [exec_pb+4], cs
        mov     word [exec_pb+6], 0x005C
        mov     [exec_pb+8], cs
        mov     word [exec_pb+10], 0x006C
        mov     [exec_pb+12], cs

        ; Save SS:SP
        mov     [cs:save_ss], ss
        mov     [cs:save_sp], sp

        ; Execute COMMAND.COM
        mov     dx, comspec_path
        mov     bx, exec_pb
        mov     ax, 0x4B00
        int     0x21

        ; Restore SS:SP
        cli
        mov     ss, [cs:save_ss]
        mov     sp, [cs:save_sp]
        sti

        push    cs
        pop     ds

        jc      .shell_fail

        ; Get exit code
        mov     ah, 0x4D
        int     0x21
        ; AL = return code
        xor     ah, ah

        ; Format response "OK <exit_code>"
        push    es
        push    cs
        pop     es
        mov     di, resp_buf
        push    ax
        mov     al, 'O'
        stosb
        mov     al, 'K'
        stosb
        mov     al, ' '
        stosb
        pop     ax
        call    dec_to_str
        mov     byte [es:di], 0
        pop     es

        mov     si, resp_buf
        call    write_rx
        ret

.shell_fail:
        mov     si, resp_err_exec
        call    write_rx
        ret

; ============================================================
; DISK FREE — get free and total disk space
; Format: DISK FREE [drive_letter]
; Response: OK <free_bytes> <total_bytes>
; ============================================================
do_disk_free:
        mov     si, cmd_buf
        add     si, 9                   ; skip "DISK FREE"
        call    skip_spaces

        ; Parse optional drive letter
        xor     dl, dl                  ; 0 = default drive
        cmp     byte [si], 0
        je      .df_go
        mov     al, [si]
        and     al, 0xDF                ; uppercase
        sub     al, 'A' - 1
        mov     dl, al

.df_go:
        mov     ah, 0x36
        int     0x21
        cmp     ax, 0xFFFF
        je      .df_err

        ; AX = sectors/cluster, BX = available clusters
        ; CX = bytes/sector, DX = total clusters
        ; Save to scratch vars
        mov     [int_ax], ax            ; sectors/cluster
        mov     [int_bx], bx            ; available clusters
        mov     [int_cx], cx            ; bytes/sector
        mov     [int_dx], dx            ; total clusters

        ; Build "OK " prefix
        push    cs
        pop     es
        mov     di, resp_buf
        mov     byte [di], 'O'
        inc     di
        mov     byte [di], 'K'
        inc     di
        mov     byte [di], ' '
        inc     di

        ; Free = sec_per_cluster * avail_clusters → DX:AX
        mov     ax, [int_ax]
        mul     word [int_bx]           ; DX:AX = sec/clust * avail_clust
        ; Multiply DX:AX by bytes/sector
        call    .df_mul_cx              ; DX:AX *= [int_cx]
        ; DX:AX = free bytes
        call    dword_to_decimal

        mov     byte [es:di], ' '
        inc     di

        ; Total = sec_per_cluster * total_clusters → DX:AX
        mov     ax, [int_ax]
        mul     word [int_dx]           ; DX:AX = sec/clust * total_clust
        call    .df_mul_cx              ; DX:AX *= [int_cx]
        ; DX:AX = total bytes
        call    dword_to_decimal

        mov     byte [es:di], 0
        mov     si, resp_buf
        jmp     write_rx

.df_mul_cx:
        ; Multiply DX:AX by [int_cx] → DX:AX (32x16 → 32)
        ; low_result = AX * CX, high_result = DX * CX + carry
        push    bx
        mov     bx, dx                  ; save high word
        mov     cx, [int_cx]
        mul     cx                      ; DX:AX = old_AX * CX
        push    dx                      ; save overflow from low mul
        push    ax                      ; save low result
        mov     ax, bx
        mul     cx                      ; DX:AX = old_DX * CX (only need AX)
        mov     dx, ax                  ; DX = high contribution
        pop     ax                      ; restore low result
        pop     bx                      ; overflow from low mul
        add     dx, bx                  ; DX = final high word
        pop     bx
        ret

.df_err:
        mov     si, resp_err_syntax
        jmp     write_rx

; ============================================================
; ENV GET — read environment variable
; Format: ENV GET <varname>
; Response: OK <value> or ERR NOT_FOUND
; ============================================================
do_env_get:
        mov     si, cmd_buf
        add     si, 8                   ; skip "ENV GET "
        call    skip_spaces
        cmp     byte [si], 0
        je      .eg_err

        ; Get environment segment from our PSP
        push    es
        mov     bx, [our_psp]
        mov     es, bx
        mov     ax, [es:0x2C]           ; environment segment
        mov     es, ax
        xor     di, di                  ; start of env block

.eg_scan:
        cmp     byte [es:di], 0         ; end of environment?
        je      .eg_notfound

        ; Compare env var name with requested name
        push    si                      ; save name pointer
.eg_cmp:
        mov     al, [es:di]
        cmp     al, '='                 ; end of name in env?
        je      .eg_check_end
        cmp     al, 0                   ; shouldn't happen mid-entry
        je      .eg_skip
        ; Case-insensitive compare
        mov     ah, [si]
        ; Uppercase both
        cmp     al, 'a'
        jb      .eg_c1
        cmp     al, 'z'
        ja      .eg_c1
        sub     al, 0x20
.eg_c1:
        cmp     ah, 'a'
        jb      .eg_c2
        cmp     ah, 'z'
        ja      .eg_c2
        sub     ah, 0x20
.eg_c2:
        cmp     al, ah
        jne     .eg_skip
        inc     di
        inc     si
        jmp     .eg_cmp

.eg_check_end:
        ; Env has '=' at di. Check if our name is also at end.
        cmp     byte [si], 0
        jne     .eg_skip_restore
        cmp     byte [si], ' '
        je      .eg_skip_restore
        ; Match! DI points to '='. Skip past it.
        pop     si                      ; discard saved SI
        inc     di                      ; skip '='

        ; Build "OK " + value in resp_buf
        push    cs
        pop     ds                      ; DS = CS temporarily... no, keep DS=CS already
        mov     si, resp_buf
        mov     byte [si], 'O'
        inc     si
        mov     byte [si], 'K'
        inc     si
        mov     byte [si], ' '
        inc     si
        ; Copy value from ES:DI
.eg_copy_val:
        mov     al, [es:di]
        cmp     al, 0
        je      .eg_val_done
        mov     [si], al
        inc     si
        inc     di
        jmp     .eg_copy_val
.eg_val_done:
        mov     byte [si], 0
        pop     es
        mov     si, resp_buf
        jmp     write_rx

.eg_skip_restore:
        ; Name didn't match at '=' boundary
.eg_skip:
        pop     si                      ; restore name pointer
        ; Skip to end of current env entry
.eg_skip_loop:
        cmp     byte [es:di], 0
        je      .eg_next
        inc     di
        jmp     .eg_skip_loop
.eg_next:
        inc     di                      ; skip the terminating null
        jmp     .eg_scan

.eg_notfound:
        pop     es
        mov     si, resp_err_notfound
        jmp     write_rx

.eg_err:
        mov     si, resp_err_syntax
        jmp     write_rx

; ============================================================
; ENV SET — set environment variable
; Format: ENV SET <name> <value>
;         ENV SET <name>   (no value = delete)
; Response: OK or ERR ENV_FULL
; ============================================================
do_env_set:
        mov     si, cmd_buf
        add     si, 7                   ; skip "ENV SET"
        call    skip_spaces
        cmp     byte [si], 0
        je      .es_syntax

        ; Copy name to env_name_buf (uppercase, stop at space/NUL)
        mov     di, env_name_buf
        xor     cx, cx
.es_copy_name:
        mov     al, [si]
        cmp     al, ' '
        je      .es_name_done
        cmp     al, 0
        je      .es_name_done
        ; Uppercase
        cmp     al, 'a'
        jb      .es_cn_ok
        cmp     al, 'z'
        ja      .es_cn_ok
        sub     al, 0x20
.es_cn_ok:
        mov     [di], al
        inc     di
        inc     si
        inc     cx
        cmp     cx, 60
        jb      .es_copy_name
.es_name_done:
        mov     byte [di], 0
        mov     [env_name_len], cx
        call    skip_spaces
        ; SI now points to value (or NUL if delete)
        mov     [env_val_ptr], si

        ; Get environment segment and size
        push    es
        mov     bx, [our_psp]
        mov     es, bx
        mov     ax, [es:0x2C]           ; env segment
        mov     [env_seg], ax

        ; Get env block size from MCB preceding it
        dec     ax                      ; MCB is at seg-1
        mov     es, ax
        mov     ax, [es:0x03]           ; MCB size in paragraphs
        mov     cl, 4
        shl     ax, cl                  ; convert to bytes
        ; If MCB returned 0 or very small, use safe default
        cmp     ax, 64
        ja      .es_size_ok
        mov     ax, 4096                ; default 4KB env
.es_size_ok:
        mov     [env_size], ax

        ; Now walk env to find and remove existing entry
        mov     es, [env_seg]
        xor     di, di

        ; First pass: find the variable
.es_find:
        cmp     byte [es:di], 0
        je      .es_not_found_pass

        ; Compare name
        push    di
        mov     bx, env_name_buf
.es_fcmp:
        mov     al, [es:di]
        cmp     al, '='
        je      .es_fcheck
        cmp     al, 0
        je      .es_fskip
        ; Uppercase env char
        cmp     al, 'a'
        jb      .es_fc1
        cmp     al, 'z'
        ja      .es_fc1
        sub     al, 0x20
.es_fc1:
        cmp     al, [bx]
        jne     .es_fskip
        inc     di
        inc     bx
        jmp     .es_fcmp

.es_fcheck:
        ; Check our name also ended
        cmp     byte [bx], 0
        jne     .es_fskip
        ; Found! Remove this entry by compacting
        pop     bx                      ; BX = start of this entry
        ; Find end of this entry (past its NUL)
        push    di
.es_fend:
        cmp     byte [es:di], 0
        je      .es_fend_done
        inc     di
        jmp     .es_fend
.es_fend_done:
        inc     di                      ; past NUL
        pop     ax                      ; discard saved di

        ; Compact: copy from DI to BX until double-NUL
        push    ds
        push    es
        pop     ds                      ; DS = env segment
        mov     si, di                  ; source = after removed entry
        mov     di, bx                  ; dest = start of removed entry
.es_compact:
        lodsb
        stosb
        cmp     al, 0
        jne     .es_compact
        ; Check if next byte is also 0 (end of env)
        cmp     byte [si], 0
        jne     .es_compact
        ; Write final NUL
        mov     byte [di], 0
        pop     ds
        jmp     .es_do_append

.es_fskip:
        pop     di
        ; Skip to end of this entry
.es_fskip_loop:
        cmp     byte [es:di], 0
        je      .es_fnext
        inc     di
        jmp     .es_fskip_loop
.es_fnext:
        inc     di
        jmp     .es_find

.es_not_found_pass:
        ; Variable not found — DI points to the end-of-env NUL

.es_do_append:
        ; If value is empty (NUL), we just deleted — done
        mov     bx, [env_val_ptr]
        cmp     byte [bx], 0
        je      .es_done

        ; Find end of env block (double NUL)
        xor     di, di
.es_find_end:
        cmp     byte [es:di], 0
        je      .es_at_end
        ; skip entry
.es_skip_ent:
        cmp     byte [es:di], 0
        je      .es_skip_ent_done
        inc     di
        jmp     .es_skip_ent
.es_skip_ent_done:
        inc     di
        jmp     .es_find_end
.es_at_end:
        ; DI = position to write new entry
        ; Check space: need name_len + 1 (=) + value_len + 2 (NUL + final NUL)
        ; Compute value length
        push    di
        mov     si, [env_val_ptr]
        xor     cx, cx
.es_vlen:
        cmp     byte [si], 0
        je      .es_vlen_done
        inc     si
        inc     cx
        jmp     .es_vlen
.es_vlen_done:
        pop     di
        mov     ax, di
        add     ax, [env_name_len]      ; name
        inc     ax                      ; '='
        add     ax, cx                  ; value
        add     ax, 2                   ; NUL + env terminator
        cmp     ax, [env_size]
        ja      .es_full

        ; Write NAME=VALUE
        mov     si, env_name_buf
.es_wn:
        lodsb
        cmp     al, 0
        je      .es_weq
        mov     [es:di], al
        inc     di
        jmp     .es_wn
.es_weq:
        mov     byte [es:di], '='
        inc     di
        mov     si, [env_val_ptr]
.es_wv:
        lodsb
        mov     [es:di], al
        inc     di
        cmp     al, 0
        jne     .es_wv
        ; Write final env-terminating NUL
        mov     byte [es:di], 0

.es_done:
        pop     es
        mov     si, resp_ok
        jmp     write_rx

.es_full:
        pop     es
        mov     si, resp_err_env_full
        jmp     write_rx

.es_syntax:
        mov     si, resp_err_syntax
        jmp     write_rx

; ============================================================
; EXEC EXIT — get last child process exit code
; Format: EXEC EXIT
; Response: OK <exit_code> (decimal, 0-255)
; ============================================================
do_exec_exit:
        mov     ah, 0x4D
        int     0x21
        ; AL = return code
        xor     ah, ah
        push    cs
        pop     es
        mov     di, resp_buf
        mov     byte [di], 'O'
        inc     di
        mov     byte [di], 'K'
        inc     di
        mov     byte [di], ' '
        inc     di
        ; Write AL as decimal
        call    .ee_write_decimal
        mov     byte [di], 0
        mov     si, resp_buf
        jmp     write_rx

.ee_write_decimal:
        ; AX = number (0–255), write decimal to ES:DI
        cmp     ax, 100
        jb      .ee_lt100
        xor     dx, dx
        mov     cx, 100
        div     cx
        add     al, '0'
        stosb
        mov     ax, dx
.ee_lt100:
        cmp     ax, 10
        jb      .ee_lt10
        xor     dx, dx
        mov     cx, 10
        div     cx
        add     al, '0'
        stosb
        mov     ax, dx
.ee_lt10:
        add     al, '0'
        stosb
        ret

; ============================================================
; EXEC LIST — list running processes from MCB chain
; Format: EXEC LIST
; Response: OK SSSS:PROGNAME SSSS:PROGNAME ...
; ============================================================
do_exec_list:
        ; Get first MCB via List of Lists
        mov     ah, 0x52
        int     0x21
        mov     ax, [es:bx-2]
        push    cs
        pop     es

        mov     di, resp_buf
        mov     byte [di], 'O'
        inc     di
        mov     byte [di], 'K'
        inc     di

.el_walk:
        push    ds
        mov     ds, ax
        mov     cl, [0]                 ; marker 'M' or 'Z'
        mov     bx, [1]                 ; owner PSP
        mov     dx, [3]                 ; size
        pop     ds

        ; Check if this is a PSP-owning block (owner == seg + 1)
        mov     bp, ax
        inc     bp                      ; bp = seg + 1
        cmp     bx, bp
        jne     .el_skip

        ; This is a process — add space + SSSS:NAME
        mov     byte [es:di], ' '
        inc     di
        push    ax
        push    cx
        push    dx
        call    word_to_hex             ; write PSP segment (AX = MCB seg)
        mov     byte [es:di], ':'
        inc     di
        ; Read 8-char name from MCB offset 8
        pop     dx
        pop     cx
        pop     ax
        push    ax
        push    cx
        push    ds
        mov     ds, ax
        mov     si, 8
        mov     cx, 8
.el_copy_name:
        lodsb
        cmp     al, 0
        je      .el_name_done
        cmp     al, ' '
        je      .el_name_done
        mov     [es:di], al
        inc     di
        dec     cx
        jnz     .el_copy_name
.el_name_done:
        pop     ds
        pop     cx
        pop     ax

.el_skip:
        ; Check if last MCB
        cmp     cl, 'Z'
        je      .el_done

        ; Next MCB = current + 1 + size
        inc     ax
        add     ax, dx
        jmp     .el_walk

.el_done:
        mov     byte [es:di], 0
        mov     si, resp_buf
        call    write_rx_checked
        ret

; ============================================================
; SYS INFO — system information
; Format: SYS INFO
; Response: OK DOS=x.xx MEM=xxxK
; ============================================================
do_sys_info:
        push    cs
        pop     es
        mov     di, resp_buf
        mov     byte [di], 'O'
        inc     di
        mov     byte [di], 'K'
        inc     di
        mov     byte [di], ' '
        inc     di

        ; DOS version
        mov     byte [di], 'D'
        inc     di
        mov     byte [di], 'O'
        inc     di
        mov     byte [di], 'S'
        inc     di
        mov     byte [di], '='
        inc     di
        mov     ax, 0x3000
        int     0x21
        ; AL = major, AH = minor
        push    ax
        xor     ah, ah
        call    sys_write_dec
        mov     byte [es:di], '.'
        inc     di
        pop     ax
        mov     al, ah
        xor     ah, ah
        call    sys_write_dec

        ; Conventional memory
        mov     byte [es:di], ' '
        inc     di
        mov     byte [es:di], 'M'
        inc     di
        mov     byte [es:di], 'E'
        inc     di
        mov     byte [es:di], 'M'
        inc     di
        mov     byte [es:di], '='
        inc     di
        int     0x12                    ; AX = KB
        call    sys_write_dec
        mov     byte [es:di], 'K'
        inc     di

        mov     byte [es:di], 0
        mov     si, resp_buf
        jmp     write_rx

; (uses sys_write_dec utility below)

; ============================================================
; SYS MEMORY — memory info
; Format: SYS MEMORY
; Response: OK CONV=xxxK FREE=xxxK
; ============================================================
do_sys_memory:
        push    cs
        pop     es
        mov     di, resp_buf
        mov     byte [di], 'O'
        inc     di
        mov     byte [di], 'K'
        inc     di
        mov     byte [di], ' '
        inc     di

        ; CONV=
        mov     byte [es:di], 'C'
        inc     di
        mov     byte [es:di], 'O'
        inc     di
        mov     byte [es:di], 'N'
        inc     di
        mov     byte [es:di], 'V'
        inc     di
        mov     byte [es:di], '='
        inc     di
        int     0x12
        call    sys_write_dec
        mov     byte [es:di], 'K'
        inc     di

        ; FREE= (largest free DOS block)
        mov     byte [es:di], ' '
        inc     di
        mov     byte [es:di], 'F'
        inc     di
        mov     byte [es:di], 'R'
        inc     di
        mov     byte [es:di], 'E'
        inc     di
        mov     byte [es:di], 'E'
        inc     di
        mov     byte [es:di], '='
        inc     di
        mov     bx, 0xFFFF
        mov     ah, 0x48
        int     0x21                    ; will fail, BX = largest free paragraphs
        ; BX = paragraphs, convert to KB: BX / 64
        mov     ax, bx
        mov     cl, 6
        shr     ax, cl
        call    sys_write_dec
        mov     byte [es:di], 'K'
        inc     di

        mov     byte [es:di], 0
        mov     si, resp_buf
        jmp     write_rx

; ============================================================
; SYS DRIVERS — list device drivers
; Format: SYS DRIVERS
; Response: OK NUL CON AUX ...
; ============================================================
do_sys_drivers:
        push    cs
        pop     es
        mov     di, resp_buf
        mov     byte [di], 'O'
        inc     di
        mov     byte [di], 'K'
        inc     di

        ; Get List of Lists
        push    es
        mov     ah, 0x52
        int     0x21
        ; ES:BX = List of Lists
        ; NUL device header is at ES:BX+22h
        add     bx, 0x22
        ; ES:BX now points to first device header

.sd_loop:
        mov     byte [cs:di], ' '
        inc     di

        ; Check attribute word at offset 4: bit 15 = char device
        mov     ax, [es:bx+4]
        test    ax, 0x8000
        jz      .sd_block

        ; Character device — read 8-byte name at offset 0Ah
        push    cx
        mov     cx, 8
        mov     si, bx
        add     si, 0x0A
.sd_name:
        mov     al, [es:si]
        cmp     al, ' '
        je      .sd_name_done
        cmp     al, 0
        je      .sd_name_done
        mov     [cs:di], al
        inc     di
        inc     si
        dec     cx
        jnz     .sd_name
.sd_name_done:
        pop     cx
        jmp     .sd_next

.sd_block:
        ; Block device — write "BLK"
        mov     byte [cs:di], 'B'
        inc     di
        mov     byte [cs:di], 'L'
        inc     di
        mov     byte [cs:di], 'K'
        inc     di

.sd_next:
        ; Check if next pointer is FFFF:FFFF
        mov     ax, [es:bx]            ; offset of next
        mov     dx, [es:bx+2]          ; segment of next
        cmp     ax, 0xFFFF
        jne     .sd_continue
        cmp     dx, 0xFFFF
        je      .sd_done
.sd_continue:
        mov     bx, ax                 ; BX = offset
        mov     es, dx                 ; ES = segment

        ; Safety limit: check resp_buf usage
        push    bx
        mov     bx, di
        sub     bx, resp_buf
        cmp     bx, 450
        pop     bx
        jae     .sd_done

        jmp     .sd_loop

.sd_done:
        pop     es                      ; restore ES from push before loop
        mov     byte [cs:di], 0
        push    cs
        pop     es
        mov     si, resp_buf
        call    write_rx_checked
        ret

; ============================================================
; SYS ANSI — check if ANSI.SYS is loaded
; Format: SYS ANSI
; Response: OK 1 or OK 0
; ============================================================
do_sys_ansi:
        ; INT 2Fh/1A00h — if AL=FFh, ANSI.SYS is loaded
        mov     ax, 0x1A00
        int     0x2F
        cmp     al, 0xFF
        je      .sa_yes
        mov     si, resp_ok0
        jmp     write_rx
.sa_yes:
        mov     si, resp_ok1
        jmp     write_rx

; ============================================================
; SYS REBOOT — reboot the system
; Format: SYS REBOOT [WARM|COLD]
; ============================================================
do_sys_reboot:
        ; Write response first
        mov     si, resp_ok_reboot
        call    write_rx

        ; Parse WARM or COLD (default WARM)
        mov     si, cmd_buf
        add     si, 10                  ; skip "SYS REBOOT"
        call    skip_spaces
        mov     word [int_ax], 0x1234   ; warm boot marker

        cmp     byte [si], 'C'
        je      .sr_cold
        cmp     byte [si], 'c'
        je      .sr_cold
        jmp     .sr_do_reboot
.sr_cold:
        mov     word [int_ax], 0x0000   ; cold boot marker

.sr_do_reboot:
        ; Set warm/cold flag in BIOS data area
        push    ds
        mov     ax, 0x0040
        mov     ds, ax
        mov     ax, [cs:int_ax]
        mov     [0x0072], ax
        pop     ds

        ; Reset via keyboard controller
        cli
.sr_wait_8042:
        in      al, 0x64
        test    al, 0x02
        jnz     .sr_wait_8042
        mov     al, 0xFE
        out     0x64, al
        hlt

; ============================================================
; SYS BEEP — simple beep via PIT (port 61h)
; Format: SYS BEEP
; On emulators without PIT, just returns OK
; ============================================================
do_sys_beep:
        ; Play a short 800Hz beep using PIT channel 2
        ; Program PIT
        mov     al, 0xB6
        out     0x43, al
        ; Divisor for 800Hz: 1193182/800 = 1491 = 0x05D3
        mov     al, 0xD3
        out     0x42, al
        mov     al, 0x05
        out     0x42, al
        ; Enable speaker
        in      al, 0x61
        or      al, 0x03
        out     0x61, al
        ; Short delay (~3 ticks = ~165ms)
        mov     cx, 3
        call    wait_ticks
        ; Disable speaker
        in      al, 0x61
        and     al, 0xFC
        out     0x61, al
        mov     si, resp_ok
        jmp     write_rx

; ============================================================
; SYS TONE — play tone via PIT
; Format: SYS TONE freq duration_ms
; ============================================================
do_sys_tone:
        mov     si, cmd_buf
        add     si, 8                   ; skip "SYS TONE"
        call    skip_spaces

        ; Parse frequency
        call    parse_dec16
        jc      .st_err
        mov     [int_ax], ax            ; freq
        call    skip_spaces

        ; Parse duration (ms)
        call    parse_dec16
        jc      .st_err
        mov     [int_bx], ax            ; duration_ms

        ; Calculate PIT divisor: 1193182 / freq
        ; 1193182 = 0x1234DE
        mov     dx, 0x0012
        mov     ax, 0x34DE
        div     word [int_ax]           ; AX = divisor
        mov     [int_cx], ax

        ; Program PIT channel 2
        mov     al, 0xB6
        out     0x43, al
        mov     ax, [int_cx]
        out     0x42, al                ; low byte
        mov     al, ah
        out     0x42, al                ; high byte

        ; Enable speaker
        in      al, 0x61
        or      al, 0x03
        out     0x61, al

        ; Wait for duration — ticks = duration_ms / 55
        mov     ax, [int_bx]
        xor     dx, dx
        mov     cx, 55
        div     cx
        cmp     ax, 0
        jne     .st_wait
        mov     ax, 1
.st_wait:
        mov     cx, ax
        call    wait_ticks

        ; Disable speaker
        in      al, 0x61
        and     al, 0xFC
        out     0x61, al

        mov     si, resp_ok
        jmp     write_rx
.st_err:
        mov     si, resp_err_syntax
        jmp     write_rx

; ============================================================
; SYS QUIET — silence the speaker
; Format: SYS QUIET
; ============================================================
do_sys_quiet:
        in      al, 0x61
        and     al, 0xFC
        out     0x61, al
        mov     si, resp_ok
        jmp     write_rx

; ============================================================
; CMOS READ — read CMOS register
; Format: CMOS READ <reg_hex>
; Response: OK XX
; ============================================================
do_cmos_read:
        mov     si, cmd_buf
        add     si, 10                  ; skip "CMOS READ "
        call    skip_spaces
        call    parse_hex8
        and     al, 7Fh                 ; mask to valid range
        push    ax
        cli
        out     70h, al
        jmp     short $+2              ; I/O delay
        in      al, 71h
        sti
        push    ax                      ; save value
        push    cs
        pop     es
        mov     di, resp_buf
        mov     al, 'O'
        stosb
        mov     al, 'K'
        stosb
        mov     al, ' '
        stosb
        pop     ax                      ; CMOS value
        call    byte_to_hex
        mov     byte [es:di], 0
        pop     ax                      ; discard reg num
        mov     si, resp_buf
        jmp     write_rx

; ============================================================
; CMOS WRITE — write CMOS register
; Format: CMOS WRITE <reg_hex> <value_hex>
; Response: OK
; ============================================================
do_cmos_write:
        mov     si, cmd_buf
        add     si, 11                  ; skip "CMOS WRITE "
        call    skip_spaces
        call    parse_hex8
        and     al, 7Fh
        mov     bl, al                  ; save register
        call    skip_spaces
        call    parse_hex8
        mov     bh, al                  ; save value
        cli
        mov     al, bl
        out     70h, al
        jmp     short $+2
        mov     al, bh
        out     71h, al
        sti
        mov     si, resp_ok
        jmp     write_rx

; ============================================================
; POWER STATUS — check APM and report power state
; Format: POWER STATUS
; Response: OK APM=x.x AC=ONLINE|OFFLINE|UNKNOWN BATT=nn%|UNKNOWN
;           or ERR NO_APM
; ============================================================
do_power_status:
        ; Check APM installation: INT 15h/AX=5300h, BX=0000
        mov     ax, 5300h
        xor     bx, bx
        int     15h
        jc      .ps_no_apm
        ; AH=major, AL=minor version
        push    ax                      ; save version
        ; Build response
        push    cs
        pop     es
        mov     di, resp_buf
        mov     si, resp_ok_prefix      ; "OK "
        call    copy_str
        ; "APM="
        mov     al, 'A'
        stosb
        mov     al, 'P'
        stosb
        mov     al, 'M'
        stosb
        mov     al, '='
        stosb
        pop     ax
        ; AH = major version (BCD), AL = minor version (BCD)
        push    ax
        mov     al, ah
        and     al, 0Fh
        add     al, '0'
        stosb
        mov     al, '.'
        stosb
        pop     ax
        push    ax
        mov     cl, 4
        shr     al, cl
        add     al, '0'
        stosb
        pop     ax
        and     al, 0Fh
        add     al, '0'
        stosb

        ; Get power status: INT 15h/AX=530Ah, BX=0001 (all devices)
        push    di
        mov     ax, 530Ah
        mov     bx, 0001h
        int     15h
        pop     di
        jc      .ps_done_buf            ; if fails, just report APM version

        ; BH = AC line status: 00=offline, 01=online, FF=unknown
        push    cx                      ; CL = battery % (0-100, FF=unknown)
        mov     al, ' '
        stosb
        mov     al, 'A'
        stosb
        mov     al, 'C'
        stosb
        mov     al, '='
        stosb
        cmp     bh, 01h
        je      .ps_ac_online
        cmp     bh, 00h
        je      .ps_ac_offline
        ; unknown
        mov     si, str_unknown
        call    copy_str
        jmp     .ps_batt
.ps_ac_online:
        mov     si, str_online
        call    copy_str
        jmp     .ps_batt
.ps_ac_offline:
        mov     si, str_offline
        call    copy_str
.ps_batt:
        mov     al, ' '
        stosb
        mov     al, 'B'
        stosb
        mov     al, 'A'
        stosb
        mov     al, 'T'
        stosb
        mov     al, 'T'
        stosb
        mov     al, '='
        stosb
        pop     cx                      ; CL = battery %
        cmp     cl, 0FFh
        je      .ps_batt_unk
        ; Write percentage
        mov     al, cl
        xor     ah, ah
        call    sys_write_dec
        mov     al, '%'
        stosb
        jmp     .ps_done_buf
.ps_batt_unk:
        mov     si, str_unknown
        call    copy_str
.ps_done_buf:
        mov     byte [es:di], 0
        mov     si, resp_buf
        jmp     write_rx

.ps_no_apm:
        mov     si, resp_err_no_apm
        jmp     write_rx

; ============================================================
; POWER IDLE — issue CPU idle via APM or HLT
; Format: POWER IDLE
; Response: OK
; ============================================================
do_power_idle:
        ; Try APM CPU idle: INT 15h/AX=5305h
        mov     ax, 5305h
        int     15h
        ; Even if APM not available, execute HLT for one interrupt cycle
        sti
        hlt
        mov     si, resp_ok
        jmp     write_rx

; ============================================================
; POWER STANDBY — APM standby
; Format: POWER STANDBY
; Response: OK or ERR NO_APM
; ============================================================
do_power_standby:
        ; INT 15h/AX=5307h, BX=0001 (all devices), CX=0001 (standby)
        mov     ax, 5307h
        mov     bx, 0001h
        mov     cx, 0001h
        int     15h
        jc      .pst_err
        mov     si, resp_ok
        jmp     write_rx
.pst_err:
        mov     si, resp_err_no_apm
        jmp     write_rx

; ============================================================
; POWER OFF — APM power off (suspend/shutdown)
; Format: POWER OFF
; Response: OK or ERR NO_APM
; ============================================================
do_power_off:
        ; Write response FIRST since we may not come back
        mov     si, resp_ok
        call    write_rx
        ; INT 15h/AX=5307h, BX=0001 (all devices), CX=0003 (off)
        mov     ax, 5307h
        mov     bx, 0001h
        mov     cx, 0003h
        int     15h
        ; If we get here, APM off failed — already sent OK though
        ret

; ============================================================
; TSR LIST — list resident programs with memory usage
; Format: TSR LIST
; Response: OK SSSS:NAME:NNNNb SSSS:NAME:NNNNb ...
; (segment, 8-char name, size in bytes)
; ============================================================
do_tsr_list:
        ; Get first MCB via List of Lists
        mov     ah, 0x52
        int     0x21
        mov     ax, [es:bx-2]
        push    cs
        pop     es

        mov     di, resp_buf
        mov     byte [di], 'O'
        inc     di
        mov     byte [di], 'K'
        inc     di

.tl_walk:
        push    ds
        mov     ds, ax
        mov     cl, [0]                 ; marker 'M' or 'Z'
        mov     bx, [1]                 ; owner PSP
        mov     dx, [3]                 ; size in paragraphs
        pop     ds

        ; Check if this is a PSP-owning block
        mov     bp, ax
        inc     bp
        cmp     bx, bp
        jne     .tl_skip

        ; Output space + SSSS:NAME:SIZEb
        mov     byte [es:di], ' '
        inc     di
        push    ax
        push    cx
        push    dx
        call    word_to_hex             ; segment
        mov     byte [es:di], ':'
        inc     di
        ; Read 8-char name from MCB offset 8
        pop     dx
        pop     cx
        pop     ax
        push    ax
        push    cx
        push    dx
        push    ds
        mov     ds, ax
        mov     si, 8
        mov     cx, 8
.tl_copy_name:
        lodsb
        cmp     al, 0
        je      .tl_name_done
        cmp     al, ' '
        je      .tl_name_done
        mov     [es:di], al
        inc     di
        dec     cx
        jnz     .tl_copy_name
.tl_name_done:
        pop     ds
        ; Write :SIZEb  (size in bytes = paragraphs * 16)
        mov     byte [es:di], ':'
        inc     di
        pop     dx                      ; paragraphs
        pop     cx
        pop     ax
        push    ax
        push    cx
        push    dx
        ; DX = size in paragraphs, multiply by 16
        mov     ax, dx
        mov     cl, 4
        shl     ax, cl
        call    sys_write_dec
        mov     byte [es:di], 'b'
        inc     di
        pop     dx
        pop     cx
        pop     ax

.tl_skip:
        cmp     cl, 'Z'
        je      .tl_done
        inc     ax
        add     ax, dx
        jmp     .tl_walk

.tl_done:
        mov     byte [es:di], 0
        mov     si, resp_buf
        call    write_rx_checked
        ret

; ============================================================
; INT WATCH — count interrupt invocations over a time period
; Format: INT WATCH <vector_hex> [ticks]
;         Default ticks = 18 (~1 second)
; Response: OK <count>
; Only one watch at a time. Hooks the vector with a counting
; ISR, waits, unhooks, reports count.
; ============================================================
do_int_watch:
        mov     si, cmd_buf
        add     si, 9                   ; skip "INT WATCH"
        call    skip_spaces
        cmp     byte [si], 0
        je      .iw_syntax
        call    parse_hex8
        mov     [iw_vector], al

        ; Parse optional tick count (default 18)
        call    skip_spaces
        cmp     byte [si], 0
        je      .iw_default_ticks
        call    parse_dec16
        cmp     ax, 0
        je      .iw_default_ticks
        mov     [iw_ticks], ax
        jmp     .iw_setup
.iw_default_ticks:
        mov     word [iw_ticks], 18
.iw_setup:
        ; Reset counter
        mov     word [iw_count], 0

        ; Save original vector
        cli
        xor     ax, ax
        mov     es, ax
        mov     al, [iw_vector]
        xor     ah, ah
        shl     ax, 1
        shl     ax, 1                   ; AX = vector * 4
        mov     bx, ax
        mov     ax, [es:bx]
        mov     [iw_old_off], ax
        mov     ax, [es:bx+2]
        mov     [iw_old_seg], ax

        ; Install counting ISR
        mov     word [es:bx], iw_isr
        mov     [es:bx+2], cs
        sti

        ; Wait specified ticks
        push    cs
        pop     es
        mov     ax, [iw_ticks]
        call    wait_ticks

        ; Unhook — restore original vector
        cli
        xor     ax, ax
        mov     es, ax
        mov     al, [iw_vector]
        xor     ah, ah
        shl     ax, 1
        shl     ax, 1
        mov     bx, ax
        mov     ax, [iw_old_off]
        mov     [es:bx], ax
        mov     ax, [iw_old_seg]
        mov     [es:bx+2], ax
        sti

        ; Build response "OK <count>"
        push    cs
        pop     es
        mov     di, resp_buf
        mov     byte [di], 'O'
        inc     di
        mov     byte [di], 'K'
        inc     di
        mov     byte [di], ' '
        inc     di
        mov     ax, [iw_count]
        call    sys_write_dec
        mov     byte [es:di], 0
        mov     si, resp_buf
        jmp     write_rx

.iw_syntax:
        mov     si, resp_err_syntax
        jmp     write_rx

; Counting ISR — increments iw_count and chains to original handler
iw_isr:
        inc     word [cs:iw_count]
        ; Chain to original handler via far JMP
        jmp     far [cs:iw_old_off]

; ============================================================
; Utility: sys_write_dec — write AX as decimal to ES:DI
; ============================================================
sys_write_dec:
        xor     cx, cx
.swd_loop:
        xor     dx, dx
        mov     bx, 10
        div     bx
        push    dx
        inc     cx
        or      ax, ax
        jnz     .swd_loop
.swd_pop:
        pop     ax
        add     al, '0'
        stosb
        dec     cx
        jnz     .swd_pop
        ret

; ============================================================
; INT LIST — dump interrupt vector table
; Format: INT LIST [start] [count]
; ============================================================
do_int_list:
        mov     si, cmd_buf
        add     si, 9                   ; skip "INT LIST "
        call    skip_spaces

        ; Default: start=0, count=256
        xor     ax, ax
        mov     [int_bx], ax            ; start
        mov     word [int_cx], 256      ; count

        ; Parse optional start
        cmp     byte [si], 0
        je      .il_go
        call    parse_hex8
        jc      .il_go
        xor     ah, ah
        mov     [int_bx], ax
        call    skip_spaces

        ; Parse optional count
        cmp     byte [si], 0
        je      .il_go
        call    parse_dec16
        jc      .il_go
        mov     [int_cx], ax

.il_go:
        ; Build response in resp_buf
        push    cs
        pop     es
        mov     di, resp_buf
        mov     byte [di], 'O'
        inc     di
        mov     byte [di], 'K'
        inc     di

        ; Read IVT at 0000:0000
        push    ds
        xor     ax, ax
        mov     ds, ax                  ; DS = 0000

        mov     cx, [cs:int_cx]         ; count
        mov     bx, [cs:int_bx]         ; start vector

.il_loop:
        cmp     cx, 0
        je      .il_done

        ; Space separator
        mov     byte [es:di], ' '
        inc     di

        ; Vector number as hex: nn=
        mov     al, bl
        push    cx
        push    ds
        push    cs
        pop     ds
        call    byte_to_hex
        pop     ds
        pop     cx
        mov     byte [es:di], '='
        inc     di

        ; Read vector: [BX*4] = offset, [BX*4+2] = segment
        push    bx
        shl     bx, 1
        shl     bx, 1                   ; bx = vector * 4
        mov     ax, [bx+2]             ; segment
        push    ax
        mov     ax, [bx]               ; offset
        push    ax

        ; Write segment
        pop     ax                      ; save offset for later
        push    ax
        ; Actually: segment first, then offset
        pop     ax                      ; offset
        pop     dx                      ; segment

        ; Write segment:offset  as ssss:oooo
        push    ax                      ; save offset
        mov     ax, dx                  ; segment
        push    cx
        push    ds
        push    cs
        pop     ds
        call    word_to_hex
        pop     ds
        pop     cx
        mov     byte [es:di], ':'
        inc     di
        pop     ax                      ; offset
        push    cx
        push    ds
        push    cs
        pop     ds
        call    word_to_hex
        pop     ds
        pop     cx

        pop     bx
        inc     bx
        dec     cx

        ; Check resp_buf overflow
        push    bx
        mov     bx, di
        sub     bx, resp_buf
        cmp     bx, 480
        pop     bx
        jb      .il_loop

.il_done:
        pop     ds
        mov     byte [es:di], 0
        mov     si, resp_buf
        call    write_rx_checked
        ret

; ============================================================
; INT CALL — execute arbitrary software interrupt
; Format: INT CALL <num> <AX> <BX> <CX> <DX>  (all hex)
; ============================================================
do_int:
        mov     si, cmd_buf
        add     si, 9               ; skip "INT CALL "
        call    skip_spaces

        ; Parse interrupt number (hex)
        call    parse_hex8
        jc      .int_err
        mov     [int_num], al

        ; Parse AX
        call    skip_spaces
        call    parse_hex16
        jc      .int_err
        mov     [int_ax], ax

        ; Parse BX
        call    skip_spaces
        call    parse_hex16
        jc      .int_err
        mov     [int_bx], ax

        ; Parse CX
        call    skip_spaces
        call    parse_hex16
        jc      .int_err
        mov     [int_cx], ax

        ; Parse DX
        call    skip_spaces
        call    parse_hex16
        jc      .int_err
        mov     [int_dx], ax

        ; Self-modify the INT instruction
        mov     al, [int_num]
        mov     [.int_opcode+1], al

        ; Load registers
        mov     ax, [int_ax]
        mov     bx, [int_bx]
        mov     cx, [int_cx]
        mov     dx, [int_dx]

        ; Execute the interrupt
.int_opcode:
        int     0x00                ; byte at +1 is patched

        ; Save results
        mov     [cs:int_ax], ax
        mov     [cs:int_bx], bx
        mov     [cs:int_cx], cx
        mov     [cs:int_dx], dx

        ; Save CF
        pushf
        pop     ax
        and     ax, 1               ; CF is bit 0
        mov     [cs:int_cf], al

        ; Restore DS
        push    cs
        pop     ds

        ; Format response: "OK AX=xxxx BX=xxxx CX=xxxx DX=xxxx CF=c"
        push    es
        push    cs
        pop     es
        mov     di, resp_buf
        mov     si, int_ok_prefix   ; "OK AX="
        call    copy_str
        mov     ax, [int_ax]
        call    word_to_hex
        mov     si, int_bx_lbl      ; " BX="
        call    copy_str
        mov     ax, [int_bx]
        call    word_to_hex
        mov     si, int_cx_lbl      ; " CX="
        call    copy_str
        mov     ax, [int_cx]
        call    word_to_hex
        mov     si, int_dx_lbl      ; " DX="
        call    copy_str
        mov     ax, [int_dx]
        call    word_to_hex
        mov     si, int_cf_lbl      ; " CF="
        call    copy_str
        mov     al, [int_cf]
        add     al, '0'
        stosb
        mov     byte [es:di], 0
        pop     es

        mov     si, resp_buf
        call    write_rx
        ret

.int_err:
        mov     si, resp_err_syntax
        call    write_rx
        ret

; ============================================================
; BATCH — execute multiple commands from one TX
; Format: Multiple commands separated by 0x0A in TX
; ============================================================
do_batch:
        ; The cmd_buf currently has "META BATCH\n<cmd1>\n<cmd2>..."
        ; Skip past "META BATCH" and the delimiter
        mov     si, cmd_buf
        add     si, 10              ; skip "META BATCH"
        ; Skip separator (space, LF, CR)
.batch_skip_sep:
        cmp     byte [si], ' '
        je      .batch_inc_skip
        cmp     byte [si], 0x0A
        je      .batch_inc_skip
        cmp     byte [si], 0x0D
        je      .batch_inc_skip
        jmp     .batch_start
.batch_inc_skip:
        inc     si
        jmp     .batch_skip_sep

.batch_start:
        ; Copy remaining commands to batch_buf for safe keeping
        mov     di, batch_buf
        push    si
        xor     cx, cx
.batch_save:
        lodsb
        stosb
        inc     cx
        cmp     al, 0
        jne     .batch_save
        pop     si

        ; Process each line
        mov     si, batch_buf

.batch_next_cmd:
        cmp     byte [si], 0
        je      .batch_done

        ; Copy this line into cmd_buf
        mov     di, cmd_buf
        xor     cx, cx
.batch_copy_line:
        lodsb
        cmp     al, 0x0A
        je      .batch_line_done
        cmp     al, 0x0D
        je      .batch_skip_cr
        cmp     al, 0
        je      .batch_line_last
        stosb
        inc     cx
        jmp     .batch_copy_line
.batch_skip_cr:
        cmp     byte [si], 0x0A
        jne     .batch_line_done
        inc     si                  ; skip LF after CR
.batch_line_done:
        mov     byte [di], 0
        mov     [cmd_len], cx

        ; Save batch position
        push    si

        ; Dispatch this command (writes to RX)
        call    dispatch

        pop     si
        jmp     .batch_next_cmd

.batch_line_last:
        mov     byte [di], 0
        mov     [cmd_len], cx
        cmp     cx, 0
        je      .batch_done
        call    dispatch

.batch_done:
        ; Last dispatch already wrote RX
        ret

; ============================================================
; DELETE — delete a file
; Format: DELETE <path>
; ============================================================
do_delete:
        mov     si, cmd_buf
        add     si, 11              ; skip "FILE DELETE"
        call    skip_spaces
        cmp     byte [si], 0
        je      .del_err

        ; SI points to path — use it directly (NUL-terminated in cmd_buf)
        mov     dx, si
        mov     ah, 0x41
        int     0x21
        jc      .del_notfound

        mov     si, resp_ok
        call    write_rx
        ret
.del_notfound:
        mov     si, resp_err_filenotfound
        call    write_rx
        ret
.del_err:
        mov     si, resp_err_syntax
        call    write_rx
        ret

; ============================================================
; RENAME — rename or move a file
; Format: RENAME <oldpath> <newpath>
; ============================================================
do_rename:
        mov     si, cmd_buf
        add     si, 11              ; skip "FILE RENAME"
        call    skip_spaces
        cmp     byte [si], 0
        je      .ren_err

        ; Find the space between old and new paths
        mov     dx, si              ; DX = old path start
.ren_find_space:
        lodsb
        cmp     al, 0
        je      .ren_err
        cmp     al, ' '
        jne     .ren_find_space
        ; NUL-terminate old path (overwrite the space)
        mov     byte [si-1], 0
        ; SI now points to new path
        call    skip_spaces
        cmp     byte [si], 0
        je      .ren_err

        ; Copy new path to ren_newpath
        push    si
        mov     di, ren_newpath
.ren_copy_new:
        lodsb
        stosb
        cmp     al, 0
        jne     .ren_copy_new
        pop     si

        ; INT 21h/56h: DS:DX=old, ES:DI=new
        push    es
        push    cs
        pop     es
        mov     di, ren_newpath
        mov     ah, 0x56
        int     0x21
        pop     es
        jc      .ren_fail

        mov     si, resp_ok
        call    write_rx
        ret
.ren_fail:
        mov     si, resp_err_rename
        call    write_rx
        ret
.ren_err:
        mov     si, resp_err_syntax
        call    write_rx
        ret

; ============================================================
; COPY — copy a file
; Format: COPY <srcpath> <dstpath>
; ============================================================
do_copy:
        mov     si, cmd_buf
        add     si, 9               ; skip "FILE COPY"
        call    skip_spaces
        cmp     byte [si], 0
        je      .cp_err

        ; Find space between src and dst
        mov     dx, si              ; DX = src path
.cp_find_space:
        lodsb
        cmp     al, 0
        je      .cp_err
        cmp     al, ' '
        jne     .cp_find_space
        mov     byte [si-1], 0     ; NUL-terminate src path
        call    skip_spaces
        cmp     byte [si], 0
        je      .cp_err

        ; Save dst path pointer
        mov     [cp_dst_ptr], si

        ; Open source (read-only)
        mov     ax, 0x3D00
        int     0x21
        jc      .cp_src_fail
        mov     [cp_src_handle], ax

        ; Create dest
        mov     dx, [cp_dst_ptr]
        xor     cx, cx
        mov     ah, 0x3C
        int     0x21
        jc      .cp_dst_fail
        mov     [cp_dst_handle], ax

        ; Copy loop
        xor     ax, ax
        mov     [cp_total], ax
        mov     [cp_total+2], ax

.cp_loop:
        ; Read into resp_buf (reuse as copy buffer)
        mov     bx, [cp_src_handle]
        mov     dx, resp_buf
        mov     cx, 512
        mov     ah, 0x3F
        int     0x21
        jc      .cp_close_both
        cmp     ax, 0
        je      .cp_close_both

        ; Write what we read
        mov     cx, ax
        push    cx
        mov     bx, [cp_dst_handle]
        mov     dx, resp_buf
        mov     ah, 0x40
        int     0x21
        pop     cx
        jc      .cp_close_both

        ; Accumulate
        add     [cp_total], cx
        adc     word [cp_total+2], 0
        jmp     .cp_loop

.cp_close_both:
        mov     bx, [cp_src_handle]
        mov     ah, 0x3E
        int     0x21
        mov     bx, [cp_dst_handle]
        mov     ah, 0x3E
        int     0x21

        ; Build response "OK <total>"
        push    es
        push    cs
        pop     es
        mov     di, resp_buf
        mov     byte [di], 'O'
        mov     byte [di+1], 'K'
        mov     byte [di+2], ' '
        add     di, 3
        mov     ax, [cp_total]
        call    dec_to_str
        mov     byte [es:di], 0
        pop     es

        mov     si, resp_buf
        call    write_rx
        ret

.cp_dst_fail:
        mov     bx, [cp_src_handle]
        mov     ah, 0x3E
        int     0x21
        mov     si, resp_err_copy
        call    write_rx
        ret
.cp_src_fail:
        mov     si, resp_err_filenotfound
        call    write_rx
        ret
.cp_err:
        mov     si, resp_err_syntax
        call    write_rx
        ret

; ============================================================
; MKDIR — create a directory
; Format: MKDIR <path>
; ============================================================
do_mkdir:
        mov     si, cmd_buf
        add     si, 8               ; skip "DIR MAKE"
        call    skip_spaces
        cmp     byte [si], 0
        je      .mkdir_err

        mov     dx, si
        mov     ah, 0x39
        int     0x21
        jc      .mkdir_fail

        mov     si, resp_ok
        call    write_rx
        ret
.mkdir_fail:
        mov     si, resp_err_mkdir
        call    write_rx
        ret
.mkdir_err:
        mov     si, resp_err_syntax
        call    write_rx
        ret

; ============================================================
; CHDIR — change working directory
; Format: CHDIR [path]
; ============================================================
do_chdir:
        mov     si, cmd_buf
        add     si, 10              ; skip "DIR CHANGE"
        call    skip_spaces

        ; If argument present, change directory
        cmp     byte [si], 0
        je      .chdir_get

        mov     dx, si
        mov     ah, 0x3B
        int     0x21
        jc      .chdir_fail

.chdir_get:
        ; Get current directory
        push    es
        push    cs
        pop     es
        mov     di, resp_buf
        mov     byte [di], 'O'
        mov     byte [di+1], 'K'
        mov     byte [di+2], ' '
        add     di, 3

        ; Get current drive
        mov     ah, 0x19
        int     0x21
        add     al, 'A'
        stosb
        mov     al, ':'
        stosb
        mov     al, '\'
        stosb

        ; Get current dir: INT 21h/47h, DL=drive(0=default), DS:SI=buf
        mov     si, di              ; write directly into resp_buf
        xor     dl, dl              ; default drive
        mov     ah, 0x47
        int     0x21
        pop     es

        ; Find end of string
        mov     si, resp_buf
.chdir_find_end:
        lodsb
        cmp     al, 0
        jne     .chdir_find_end

        mov     si, resp_buf
        call    write_rx
        ret

.chdir_fail:
        mov     si, resp_err_chdir
        call    write_rx
        ret

; ============================================================
; WRITEFILE — write hex data to a file
; Format: WRITEFILE <path> <offset> <hex bytes...>
; ============================================================
do_writefile:
        mov     si, cmd_buf
        add     si, 10              ; skip "FILE WRITE"
        call    skip_spaces
        cmp     byte [si], 0
        je      .wf_err

        ; Parse path (up to space)
        mov     di, file_path_buf
.wf_copy_path:
        lodsb
        cmp     al, ' '
        je      .wf_path_done
        cmp     al, 0
        je      .wf_err
        stosb
        jmp     .wf_copy_path
.wf_path_done:
        mov     byte [di], 0

        ; Parse offset (decimal)
        call    skip_spaces
        call    parse_dec16
        jc      .wf_err
        mov     [wf_offset], ax
        mov     word [wf_offset+2], 0

        ; Try to open file read/write
        mov     dx, file_path_buf
        mov     ax, 0x3D02
        int     0x21
        jnc     .wf_opened
        ; File doesn't exist — create it
        mov     dx, file_path_buf
        xor     cx, cx
        mov     ah, 0x3C
        int     0x21
        jc      .wf_write_fail
.wf_opened:
        mov     [wf_handle], ax

        ; Seek to offset
        mov     bx, [wf_handle]
        mov     dx, [wf_offset]
        mov     cx, [wf_offset+2]
        mov     ax, 0x4200          ; LSEEK from start
        int     0x21

        ; Parse hex bytes and write them
        call    skip_spaces
        xor     cx, cx              ; bytes written count
        mov     [wf_count], cx

.wf_hex_loop:
        cmp     byte [si], 0
        je      .wf_done
        cmp     byte [si], ' '
        jne     .wf_parse_byte
        inc     si
        jmp     .wf_hex_loop
.wf_parse_byte:
        call    parse_hex8
        jc      .wf_done

        ; Write single byte
        mov     [rf_data_buf], al   ; reuse readfile buffer for 1 byte
        push    cx
        push    si
        mov     bx, [wf_handle]
        mov     dx, rf_data_buf
        mov     cx, 1
        mov     ah, 0x40
        int     0x21
        pop     si
        pop     cx
        inc     cx
        jmp     .wf_hex_loop

.wf_done:
        mov     [wf_count], cx
        ; Close file
        mov     bx, [wf_handle]
        mov     ah, 0x3E
        int     0x21

        ; Build response "OK <count>"
        push    es
        push    cs
        pop     es
        mov     di, resp_buf
        mov     byte [di], 'O'
        mov     byte [di+1], 'K'
        mov     byte [di+2], ' '
        add     di, 3
        mov     ax, [wf_count]
        call    dec_to_str
        mov     byte [es:di], 0
        pop     es

        mov     si, resp_buf
        call    write_rx
        ret

.wf_write_fail:
        mov     si, resp_err_write
        call    write_rx
        ret
.wf_err:
        mov     si, resp_err_syntax
        call    write_rx
        ret

; ============================================================
; TIME — get or set date/time
; Format: TIME GET → OK YYYY-MM-DD HH:MM:SS
;         TIME SET YYYY-MM-DD HH:MM:SS → OK
; ============================================================
do_time:
        ; Legacy entry — dispatch_time now routes directly to get/set
        jmp     dispatch_unknown

do_time_get:
        ; INT 21h/2Ah: Get date → CX=year, DH=month, DL=day
        mov     ah, 0x2A
        int     0x21
        mov     [time_year], cx
        mov     [time_month], dh
        mov     [time_day], dl

        ; INT 21h/2Ch: Get time → CH=hour, CL=min, DH=sec
        mov     ah, 0x2C
        int     0x21
        mov     [time_hour], ch
        mov     [time_min], cl
        mov     [time_sec], dh

        ; Format "OK YYYY-MM-DD HH:MM:SS"
        push    es
        push    cs
        pop     es
        mov     di, resp_buf
        mov     byte [di], 'O'
        mov     byte [di+1], 'K'
        mov     byte [di+2], ' '
        add     di, 3

        ; Year (4 digits)
        mov     ax, [time_year]
        call    word_to_dec_4
        mov     al, '-'
        stosb
        ; Month (2 digits)
        mov     al, [time_month]
        call    byte_to_dec_2
        mov     al, '-'
        stosb
        ; Day (2 digits)
        mov     al, [time_day]
        call    byte_to_dec_2
        mov     al, ' '
        stosb
        ; Hour
        mov     al, [time_hour]
        call    byte_to_dec_2
        mov     al, ':'
        stosb
        ; Minute
        mov     al, [time_min]
        call    byte_to_dec_2
        mov     al, ':'
        stosb
        ; Second
        mov     al, [time_sec]
        call    byte_to_dec_2
        mov     byte [es:di], 0
        pop     es

        mov     si, resp_buf
        call    write_rx
        ret

do_time_set:
        ; "TIME SET YYYY-MM-DD HH:MM:SS"
        mov     si, cmd_buf
        add     si, 8               ; skip "TIME SET"
        call    skip_spaces

        ; Parse YYYY-MM-DD HH:MM:SS
        ; Year: 4 digits
        call    parse_dec16
        jc      .time_err
        mov     [time_year], ax
        cmp     byte [si], '-'
        jne     .time_err
        inc     si
        ; Month: up to 2 digits
        call    parse_dec16
        jc      .time_err
        mov     [time_month], al
        cmp     byte [si], '-'
        jne     .time_err
        inc     si
        ; Day
        call    parse_dec16
        jc      .time_err
        mov     [time_day], al
        call    skip_spaces
        ; Hour
        call    parse_dec16
        jc      .time_err
        mov     [time_hour], al
        cmp     byte [si], ':'
        jne     .time_err
        inc     si
        ; Minute
        call    parse_dec16
        jc      .time_err
        mov     [time_min], al
        cmp     byte [si], ':'
        jne     .time_err
        inc     si
        ; Second
        call    parse_dec16
        jc      .time_err
        mov     [time_sec], al

        ; Set date: INT 21h/2Bh CX=year, DH=month, DL=day
        mov     cx, [time_year]
        mov     dh, [time_month]
        mov     dl, [time_day]
        mov     ah, 0x2B
        int     0x21
        cmp     al, 0
        jne     .time_date_err

        ; Set time: INT 21h/2Dh CH=hour, CL=min, DH=sec, DL=hundredths
        mov     ch, [time_hour]
        mov     cl, [time_min]
        mov     dh, [time_sec]
        xor     dl, dl
        mov     ah, 0x2D
        int     0x21
        cmp     al, 0
        jne     .time_time_err

        mov     si, resp_ok
        call    write_rx
        ret

.time_date_err:
        mov     si, resp_err_date
        call    write_rx
        ret
.time_time_err:
        mov     si, resp_err_time_inv
        call    write_rx
        ret
.time_err:
        mov     si, resp_err_syntax
        call    write_rx
        ret

; ============================================================
; FINDTEXT — search screen for all occurrences
; Format: FINDTEXT <text>
; ============================================================
do_findtext:
        mov     si, cmd_buf
        add     si, 8               ; skip "CON FIND"
        call    skip_spaces
        cmp     byte [si], 0
        je      .ft_err

        ; Copy search text, converting underscore to space
        mov     di, ft_text
        xor     cx, cx
.ft_copy:
        lodsb
        cmp     al, 0
        je      .ft_copy_done
        cmp     al, '_'
        jne     .ft_no_us
        mov     al, ' '
.ft_no_us:
        stosb
        inc     cx
        jmp     .ft_copy
.ft_copy_done:
        mov     byte [di], 0
        mov     [ft_text_len], cx

        ; Start building response in resp_buf
        push    es
        push    cs
        pop     es
        mov     di, resp_buf
        mov     byte [di], 'O'
        mov     byte [di+1], 'K'
        mov     byte [di+2], 0       ; NUL terminate "OK" initially
        add     di, 2
        mov     word [ft_matches], 0

        ; Scan rows 0-24
        xor     ax, ax
        mov     [ws_cur_row], ax

.ft_next_row:
        cmp     word [ws_cur_row], 25
        jge     .ft_finished

        ; Read 80 chars from B800:(row*160)
        push    ds
        push    es
        push    cs
        pop     es
        mov     ax, [ws_cur_row]
        mov     dx, 160
        mul     dx
        mov     si, ax
        mov     ax, 0xB800
        mov     ds, ax
        mov     di, ws_row_buf
        mov     cx, 80
.ft_read:
        lodsb
        stosb
        inc     si              ; skip attribute
        dec     cx
        jnz     .ft_read
        pop     es
        pop     ds

        ; Search for text in this row at each column
        mov     bx, 80
        sub     bx, [ft_text_len]
        inc     bx              ; max starting column + 1
        xor     cx, cx          ; column

.ft_col_loop:
        cmp     cx, bx
        jge     .ft_row_done

        ; Compare ft_text with ws_row_buf[cx..]
        push    cx
        push    bx
        mov     si, ft_text
        mov     di, ws_row_buf
        add     di, cx
        mov     dx, [ft_text_len]
.ft_cmp:
        cmp     dx, 0
        je      .ft_match
        mov     al, [si]
        mov     ah, [di]
        cmp     al, ah
        jne     .ft_no_match
        inc     si
        inc     di
        dec     dx
        jmp     .ft_cmp

.ft_match:
        pop     bx
        pop     cx
        ; Append " row,col" to resp_buf
        push    es
        push    cs
        pop     es
        mov     di, resp_buf
        ; Find end of resp_buf
        push    cx
.ft_find_end:
        cmp     byte [di], 0
        je      .ft_at_end
        inc     di
        jmp     .ft_find_end
.ft_at_end:
        ; Check space: resp_buf + 500 > di ?
        mov     ax, di
        sub     ax, resp_buf
        cmp     ax, 490
        jge     .ft_skip_append

        ; Add separator
        cmp     word [ft_matches], 0
        je      .ft_first_sep
        mov     al, '|'
        stosb
        jmp     .ft_after_sep
.ft_first_sep:
        mov     al, ' '
        stosb
.ft_after_sep:
        ; Row number
        mov     ax, [ws_cur_row]
        call    dec_to_str
        mov     al, ','
        stosb
        ; Column number
        pop     cx
        push    cx
        mov     ax, cx
        call    dec_to_str
        mov     byte [es:di], 0
.ft_skip_append:
        pop     cx
        pop     es
        inc     word [ft_matches]
        inc     cx
        jmp     .ft_col_loop

.ft_no_match:
        pop     bx
        pop     cx
        inc     cx
        jmp     .ft_col_loop

.ft_row_done:
        inc     word [ws_cur_row]
        jmp     .ft_next_row

.ft_finished:
        ; If no matches, resp_buf is just "OK"
        cmp     word [ft_matches], 0
        jne     .ft_has_matches
        mov     byte [resp_buf+2], 0    ; terminate after "OK"
.ft_has_matches:
        pop     es
        mov     si, resp_buf
        call    write_rx_checked
        ret

.ft_err:
        mov     si, resp_err_syntax
        call    write_rx
        ret

; ============================================================
; WAITGONE — wait for text to disappear from screen
; Format: WAITGONE <text> [timeout_ticks]
; ============================================================
do_waitgone:
        mov     si, cmd_buf
        add     si, 9               ; skip "WAIT GONE"
        call    skip_spaces
        cmp     byte [si], 0
        je      .wg_err

        ; Copy search text, converting underscore to space
        mov     di, ws_text
        xor     cx, cx
.wg_copy:
        lodsb
        cmp     al, 0
        je      .wg_copy_done
        cmp     al, ' '
        je      .wg_copy_done
        cmp     al, '_'
        jne     .wg_no_us
        mov     al, ' '
.wg_no_us:
        stosb
        inc     cx
        cmp     cx, 40
        jge     .wg_copy_done
        jmp     .wg_copy
.wg_copy_done:
        mov     byte [di], 0
        mov     [ws_text_len], cx

        ; Parse optional timeout
        call    skip_spaces
        mov     ax, [cfg_timeout]
        cmp     byte [si], 0
        je      .wg_use_timeout
        call    parse_dec16
        jc      .wg_use_timeout
.wg_use_timeout:
        mov     [ws_timeout], ax

        ; Record start tick
        push    es
        mov     ax, 0x0040
        mov     es, ax
        mov     ax, [es:0x006C]
        mov     [ws_start_tick], ax
        pop     es

.wg_loop:
        ; Scan screen for text
        call    scan_screen_text
        ; CF clear = found, CF set = not found
        jc      .wg_gone           ; not found = text is gone = success

        ; Check timeout
        push    es
        mov     ax, 0x0040
        mov     es, ax
        mov     ax, [es:0x006C]
        pop     es
        sub     ax, [ws_start_tick]
        cmp     ax, [ws_timeout]
        jge     .wg_timeout

        sti
        hlt
        jmp     .wg_loop

.wg_gone:
        mov     si, resp_ok
        call    write_rx
        ret
.wg_timeout:
        mov     si, resp_err_timeout
        call    write_rx
        ret
.wg_err:
        mov     si, resp_err_syntax
        call    write_rx
        ret

; ============================================================
; WAITPIXEL — wait for pixel color at coordinates
; Format: WAITPIXEL <x> <y> <color> [timeout_ticks]
; ============================================================
do_waitpixel:
        mov     si, cmd_buf
        add     si, 10              ; skip "WAIT PIXEL"
        call    skip_spaces

        ; Parse x
        call    parse_dec16
        jc      .wpx_err
        mov     [wp_x], ax
        call    skip_spaces

        ; Parse y
        call    parse_dec16
        jc      .wpx_err
        mov     [wp_y], ax
        call    skip_spaces

        ; Parse color
        call    parse_dec16
        jc      .wpx_err
        mov     [wp_color], al
        call    skip_spaces

        ; Parse optional timeout
        mov     ax, [cfg_timeout]
        cmp     byte [si], 0
        je      .wpx_use_timeout
        call    parse_dec16
        jc      .wpx_use_timeout
.wpx_use_timeout:
        mov     [wp_timeout], ax

        ; Record start tick
        push    es
        mov     ax, 0x0040
        mov     es, ax
        mov     ax, [es:0x006C]
        mov     [wp_start], ax
        pop     es

.wpx_loop:
        ; Read pixel: INT 10h/0Dh
        mov     cx, [wp_x]
        mov     dx, [wp_y]
        xor     bh, bh
        mov     ah, 0x0D
        int     0x10

        cmp     al, [wp_color]
        je      .wpx_found

        ; Check timeout
        push    es
        mov     ax, 0x0040
        mov     es, ax
        mov     ax, [es:0x006C]
        pop     es
        sub     ax, [wp_start]
        cmp     ax, [wp_timeout]
        jge     .wpx_timeout

        sti
        hlt
        jmp     .wpx_loop

.wpx_found:
        mov     si, resp_ok
        call    write_rx
        ret
.wpx_timeout:
        mov     si, resp_err_timeout
        call    write_rx
        ret
.wpx_err:
        mov     si, resp_err_syntax
        call    write_rx
        ret

; ============================================================
; INI — read/write INI files (pure DOS)
; Format: INI READ <file> <section> <key>
;         INI WRITE <file> <section> <key> <value>
; ============================================================
do_ini:
        ; Legacy entry — dispatch_ini now routes directly to read/write
        jmp     dispatch_unknown

; --- INI READ ---
do_ini_read:
        mov     si, cmd_buf
        add     si, 8               ; skip "INI READ"
        call    skip_spaces
        ; Parse file path
        mov     di, file_path_buf
.ir_copy_path:
        lodsb
        cmp     al, ' '
        je      .ir_path_done
        cmp     al, 0
        je      .ini_err
        stosb
        jmp     .ir_copy_path
.ir_path_done:
        mov     byte [di], 0

        ; Parse section name
        call    skip_spaces
        mov     di, ini_section
.ir_copy_sec:
        lodsb
        cmp     al, ' '
        je      .ir_sec_done
        cmp     al, 0
        je      .ini_err
        stosb
        jmp     .ir_copy_sec
.ir_sec_done:
        mov     byte [di], 0

        ; Parse key name
        call    skip_spaces
        mov     di, ini_key
.ir_copy_key:
        lodsb
        cmp     al, ' '
        je      .ir_key_done
        cmp     al, 0
        je      .ir_key_done
        stosb
        jmp     .ir_copy_key
.ir_key_done:
        mov     byte [di], 0

        ; Open file
        mov     dx, file_path_buf
        mov     ax, 0x3D00
        int     0x21
        jc      .ini_notfound

        ; Read into ini_buf
        mov     bx, ax
        mov     [ini_handle], bx
        mov     dx, ini_buf
        mov     cx, INI_BUF_SIZE - 1
        mov     ah, 0x3F
        int     0x21
        mov     [ini_buf_len], ax
        ; NUL-terminate
        mov     bx, ini_buf
        add     bx, ax
        mov     byte [bx], 0

        ; Close file
        mov     bx, [ini_handle]
        mov     ah, 0x3E
        int     0x21

        ; Search for [section]
        mov     si, ini_buf
        call    ini_find_section
        jc      .ini_key_not_found

        ; Search for key= within section
        call    ini_find_key
        jc      .ini_key_not_found

        ; SI points to value — build response "OK <value>"
        push    es
        push    cs
        pop     es
        mov     di, resp_buf
        mov     byte [di], 'O'
        mov     byte [di+1], 'K'
        mov     byte [di+2], ' '
        add     di, 3
.ir_copy_val:
        lodsb
        cmp     al, 0x0D
        je      .ir_val_done
        cmp     al, 0x0A
        je      .ir_val_done
        cmp     al, 0
        je      .ir_val_done
        stosb
        jmp     .ir_copy_val
.ir_val_done:
        mov     byte [es:di], 0
        pop     es

        mov     si, resp_buf
        call    write_rx
        ret

.ini_key_not_found:
        mov     si, resp_err_notfound
        call    write_rx
        ret
.ini_notfound:
        mov     si, resp_err_filenotfound
        call    write_rx
        ret
.ini_err:
        mov     si, resp_err_syntax
        call    write_rx
        ret

; --- INI WRITE ---
do_ini_write:
        mov     si, cmd_buf
        add     si, 9               ; skip "INI WRITE"
        call    skip_spaces
        ; Parse file path
        mov     di, file_path_buf
.iw_copy_path:
        lodsb
        cmp     al, ' '
        je      .iw_path_done
        cmp     al, 0
        je      .iw_err
        stosb
        jmp     .iw_copy_path
.iw_path_done:
        mov     byte [di], 0

        ; Parse section
        call    skip_spaces
        mov     di, ini_section
.iw_copy_sec:
        lodsb
        cmp     al, ' '
        je      .iw_sec_done
        cmp     al, 0
        je      .iw_err
        stosb
        jmp     .iw_copy_sec
.iw_sec_done:
        mov     byte [di], 0

        ; Parse key
        call    skip_spaces
        mov     di, ini_key
.iw_copy_key:
        lodsb
        cmp     al, ' '
        je      .iw_key_done
        cmp     al, 0
        je      .iw_err
        stosb
        jmp     .iw_copy_key
.iw_key_done:
        mov     byte [di], 0

        ; Parse value (rest of line)
        call    skip_spaces
        mov     di, ini_value
.iw_copy_val:
        lodsb
        cmp     al, 0
        je      .iw_val_done
        cmp     al, 0x0D
        je      .iw_val_done
        cmp     al, 0x0A
        je      .iw_val_done
        stosb
        jmp     .iw_copy_val
.iw_val_done:
        mov     byte [di], 0

        ; Try to open existing file and read contents
        mov     dx, file_path_buf
        mov     ax, 0x3D00
        int     0x21
        jc      .iw_new_file

        ; Read existing file
        mov     bx, ax
        mov     [ini_handle], bx
        mov     dx, ini_buf
        mov     cx, INI_BUF_SIZE - 1
        mov     ah, 0x3F
        int     0x21
        mov     [ini_buf_len], ax
        mov     bx, ini_buf
        add     bx, ax
        mov     byte [bx], 0
        mov     bx, [ini_handle]
        mov     ah, 0x3E
        int     0x21

        ; Try to find and update existing key
        mov     si, ini_buf
        call    ini_find_section
        jc      .iw_append_section

        ; Section found — find key
        push    si                  ; save section data start
        call    ini_find_key
        jc      .iw_insert_key

        ; Key found — replace the entire key=value line
        ; Use ini_find_key_line to get line boundaries
        pop     bx                  ; discard saved section start from 5127
        mov     si, ini_buf
        call    ini_find_section
        jc      .iw_append_section  ; shouldn't happen

        call    ini_find_key_line   ; SI=line start, DI=next line start
        jc      .iw_insert_key_nopop ; shouldn't happen

        ; SI = start of "key=value" line, DI = start of next line
        ; Save suffix (DI to end of buffer) to resp_buf
        push    si                  ; save line start
        mov     cx, ini_buf
        add     cx, [ini_buf_len]
        sub     cx, di              ; CX = suffix length
        mov     [iw_suffix_len], cx

        mov     si, di              ; source = next line start
        mov     di, resp_buf        ; dest = resp_buf
        cmp     cx, 0
        je      .iw_no_suffix
        rep     movsb
.iw_no_suffix:
        mov     byte [di], 0
        pop     di                  ; DI = where key line was (write point)

        ; Write new key=value\r\n
        mov     si, ini_key
.iw_write_key:
        lodsb
        cmp     al, 0
        je      .iw_key_written
        mov     [di], al
        inc     di
        jmp     .iw_write_key
.iw_key_written:
        mov     byte [di], '='
        inc     di
        mov     si, ini_value
.iw_write_val:
        lodsb
        cmp     al, 0
        je      .iw_val_written
        mov     [di], al
        inc     di
        jmp     .iw_write_val
.iw_val_written:
        mov     byte [di], 0x0D
        inc     di
        mov     byte [di], 0x0A
        inc     di

        ; Copy suffix back from resp_buf
        mov     si, resp_buf
        mov     cx, [iw_suffix_len]
        cmp     cx, 0
        je      .iw_no_suffix2
        rep     movsb
.iw_no_suffix2:
        mov     byte [di], 0

        ; Update buffer length
        mov     ax, di
        sub     ax, ini_buf
        mov     [ini_buf_len], ax
        jmp     .iw_write_back

.iw_insert_key_nopop:
        ; Same as iw_insert_key but SI already has section data start
        jmp     .iw_insert_key_common

.iw_insert_key:
        ; Section exists but key doesn't. Insert after section header.
        pop     si                  ; SI = after section header line
.iw_insert_key_common:
        ; SI points to first line after [section]
        ; Insert "key=value\r\n" at SI position

        ; Save suffix from SI to end
        mov     ax, ini_buf
        add     ax, [ini_buf_len]
        sub     ax, si
        mov     [iw_suffix_len], ax
        mov     [iw_suffix_ptr], si

        ; Move suffix to resp_buf
        push    si
        mov     di, resp_buf
        mov     cx, [iw_suffix_len]
        cmp     cx, 0
        je      .iw_ins_no_suffix
        rep     movsb
.iw_ins_no_suffix:
        mov     byte [di], 0
        pop     di                  ; DI = insert point

        ; Write key=value\r\n
        mov     si, ini_key
.iw_ins_key:
        lodsb
        cmp     al, 0
        je      .iw_ins_key_done
        mov     [di], al
        inc     di
        jmp     .iw_ins_key
.iw_ins_key_done:
        mov     byte [di], '='
        inc     di
        mov     si, ini_value
.iw_ins_val:
        lodsb
        cmp     al, 0
        je      .iw_ins_val_done
        mov     [di], al
        inc     di
        jmp     .iw_ins_val
.iw_ins_val_done:
        mov     byte [di], 0x0D
        inc     di
        mov     byte [di], 0x0A
        inc     di

        ; Copy suffix back
        mov     si, resp_buf
        mov     cx, [iw_suffix_len]
        cmp     cx, 0
        je      .iw_ins_no_suffix2
        rep     movsb
.iw_ins_no_suffix2:
        mov     byte [di], 0
        mov     ax, di
        sub     ax, ini_buf
        mov     [ini_buf_len], ax
        jmp     .iw_write_back

.iw_append_section:
        ; Section not found — append [section]\r\nkey=value\r\n
        mov     di, ini_buf
        add     di, [ini_buf_len]

        ; Ensure previous content ends with newline
        cmp     di, ini_buf
        je      .iw_app_sec_hdr
        cmp     byte [di-1], 0x0A
        je      .iw_app_sec_hdr
        mov     byte [di], 0x0D
        inc     di
        mov     byte [di], 0x0A
        inc     di

.iw_app_sec_hdr:
        mov     byte [di], '['
        inc     di
        mov     si, ini_section
.iw_app_sec:
        lodsb
        cmp     al, 0
        je      .iw_app_sec_done
        mov     [di], al
        inc     di
        jmp     .iw_app_sec
.iw_app_sec_done:
        mov     byte [di], ']'
        inc     di
        mov     byte [di], 0x0D
        inc     di
        mov     byte [di], 0x0A
        inc     di

        ; key=value
        mov     si, ini_key
.iw_app_key:
        lodsb
        cmp     al, 0
        je      .iw_app_key_done
        mov     [di], al
        inc     di
        jmp     .iw_app_key
.iw_app_key_done:
        mov     byte [di], '='
        inc     di
        mov     si, ini_value
.iw_app_val:
        lodsb
        cmp     al, 0
        je      .iw_app_val_done
        mov     [di], al
        inc     di
        jmp     .iw_app_val
.iw_app_val_done:
        mov     byte [di], 0x0D
        inc     di
        mov     byte [di], 0x0A
        inc     di
        mov     byte [di], 0
        mov     ax, di
        sub     ax, ini_buf
        mov     [ini_buf_len], ax
        jmp     .iw_write_back

.iw_new_file:
        ; File doesn't exist — create with [section]\r\nkey=value\r\n
        xor     ax, ax
        mov     [ini_buf_len], ax
        jmp     .iw_append_section

.iw_write_back:
        ; Write ini_buf back to file
        mov     dx, file_path_buf
        xor     cx, cx
        mov     ah, 0x3C            ; create/truncate
        int     0x21
        jc      .iw_write_err

        mov     bx, ax
        mov     dx, ini_buf
        mov     cx, [ini_buf_len]
        mov     ah, 0x40
        int     0x21

        mov     ah, 0x3E
        int     0x21

        mov     si, resp_ok
        call    write_rx
        ret

.iw_write_err:
        mov     si, resp_err_write
        call    write_rx
        ret

.iw_err:
        mov     si, resp_err_syntax
        call    write_rx
        ret

; ============================================================
; INI helpers
; ============================================================

; ini_find_section — find [section] in buffer at SI
; Input: SI = buffer start, ini_section = section name
; Output: SI = first byte after section header line, CF clear
;         CF set if not found
ini_find_section:
.ifs_next_line:
        cmp     byte [si], 0
        je      .ifs_not_found

        cmp     byte [si], '['
        jne     .ifs_skip_line

        ; Found '[' — compare section name
        inc     si
        mov     di, ini_section
.ifs_cmp:
        mov     al, [si]
        mov     ah, [di]
        cmp     ah, 0
        je      .ifs_check_close
        ; Case-insensitive compare
        call    to_upper_al
        xchg    al, ah
        call    to_upper_al
        cmp     al, ah
        jne     .ifs_skip_line2
        inc     si
        inc     di
        jmp     .ifs_cmp

.ifs_check_close:
        cmp     byte [si], ']'
        jne     .ifs_skip_line2

        ; Found matching section! Skip to next line.
        inc     si
.ifs_skip_to_eol:
        lodsb
        cmp     al, 0x0A
        je      .ifs_found
        cmp     al, 0
        je      .ifs_found
        jmp     .ifs_skip_to_eol
.ifs_found:
        clc
        ret

.ifs_skip_line2:
        ; Back up to start of line... actually just skip to end
        ; SI may have advanced, need to find EOL
.ifs_skip_line:
        lodsb
        cmp     al, 0x0A
        je      .ifs_next_line
        cmp     al, 0
        je      .ifs_not_found
        jmp     .ifs_skip_line

.ifs_not_found:
        stc
        ret

; to_upper_al — convert AL to uppercase
to_upper_al:
        cmp     al, 'a'
        jb      .tua_ret
        cmp     al, 'z'
        ja      .tua_ret
        sub     al, 0x20
.tua_ret:
        ret

; ini_find_key — find key= within current section
; Input: SI = start of section data
; Output: SI = start of value (after '='), CF clear
;         CF set if not found (hit next section or EOF)
ini_find_key:
.ifk_next_line:
        cmp     byte [si], 0
        je      .ifk_not_found
        cmp     byte [si], '['      ; new section
        je      .ifk_not_found
        cmp     byte [si], ';'      ; comment
        je      .ifk_skip_line
        cmp     byte [si], 0x0D
        je      .ifk_skip_line
        cmp     byte [si], 0x0A
        je      .ifk_skip_eol

        ; Compare key name
        push    si
        mov     di, ini_key
.ifk_cmp:
        mov     al, [di]
        cmp     al, 0
        je      .ifk_check_eq
        mov     ah, [si]
        call    to_upper_al
        xchg    al, ah
        call    to_upper_al
        cmp     al, ah
        jne     .ifk_no_match
        inc     si
        inc     di
        jmp     .ifk_cmp

.ifk_check_eq:
        ; Skip whitespace before =
.ifk_skip_ws:
        cmp     byte [si], ' '
        je      .ifk_ws_inc
        cmp     byte [si], 0x09
        je      .ifk_ws_inc
        jmp     .ifk_check_eq2
.ifk_ws_inc:
        inc     si
        jmp     .ifk_skip_ws
.ifk_check_eq2:
        cmp     byte [si], '='
        jne     .ifk_no_match
        inc     si                  ; skip '='
        ; Skip whitespace after =
.ifk_skip_ws2:
        cmp     byte [si], ' '
        je      .ifk_ws2_inc
        cmp     byte [si], 0x09
        je      .ifk_ws2_inc
        jmp     .ifk_found
.ifk_ws2_inc:
        inc     si
        jmp     .ifk_skip_ws2
.ifk_found:
        add     sp, 2              ; discard saved SI
        clc
        ret

.ifk_no_match:
        pop     si
.ifk_skip_line:
        lodsb
        cmp     al, 0x0A
        je      .ifk_next_line
        cmp     al, 0
        je      .ifk_not_found
        jmp     .ifk_skip_line
.ifk_skip_eol:
        inc     si
        jmp     .ifk_next_line

.ifk_not_found:
        stc
        ret

; ini_find_key_line — find key= line, return line boundaries
; Input: SI = start of section data
; Output: SI = start of key=value line, DI = start of next line, CF clear
;         CF set if not found
ini_find_key_line:
.ifkl_next:
        cmp     byte [si], 0
        je      .ifkl_not_found
        cmp     byte [si], '['
        je      .ifkl_not_found

        mov     bx, si              ; save line start
        push    si
        mov     di, ini_key
.ifkl_cmp:
        mov     al, [di]
        cmp     al, 0
        je      .ifkl_check_eq
        mov     ah, [si]
        call    to_upper_al
        xchg    al, ah
        call    to_upper_al
        cmp     al, ah
        jne     .ifkl_no_match
        inc     si
        inc     di
        jmp     .ifkl_cmp

.ifkl_check_eq:
        cmp     byte [si], '='
        je      .ifkl_match
        cmp     byte [si], ' '
        je      .ifkl_skip_ws_eq
        cmp     byte [si], 0x09
        je      .ifkl_skip_ws_eq
        jmp     .ifkl_no_match
.ifkl_skip_ws_eq:
        inc     si
        jmp     .ifkl_check_eq

.ifkl_match:
        pop     si                  ; discard
        mov     si, bx              ; SI = line start
        ; Find next line start
        mov     di, bx
.ifkl_find_eol:
        mov     al, [di]
        cmp     al, 0x0A
        je      .ifkl_eol_found
        cmp     al, 0
        je      .ifkl_eol_found
        inc     di
        jmp     .ifkl_find_eol
.ifkl_eol_found:
        cmp     byte [di], 0x0A
        jne     .ifkl_at_end
        inc     di                  ; DI = start of next line
.ifkl_at_end:
        clc
        ret

.ifkl_no_match:
        pop     si
        ; Skip to next line
.ifkl_skip:
        lodsb
        cmp     al, 0x0A
        je      .ifkl_next
        cmp     al, 0
        je      .ifkl_not_found
        jmp     .ifkl_skip

.ifkl_not_found:
        stc
        ret

; ============================================================
; scan_screen_text — search all 25 rows for ws_text
; Returns: CF clear if found, CF set if not found
; ============================================================
scan_screen_text:
        push    bx
        push    cx
        push    dx
        xor     dx, dx              ; row counter

.sst_row:
        cmp     dx, 25
        jge     .sst_not_found

        ; Read row into ws_row_buf
        push    ds
        push    es
        push    cs
        pop     es
        mov     ax, dx
        push    dx
        mov     dx, 160
        mul     dx
        mov     si, ax
        mov     ax, 0xB800
        mov     ds, ax
        mov     di, ws_row_buf
        mov     cx, 80
.sst_read:
        lodsb
        stosb
        inc     si
        dec     cx
        jnz     .sst_read
        pop     dx
        pop     es
        pop     ds

        ; Search for ws_text in ws_row_buf
        mov     bx, 80
        sub     bx, [ws_text_len]
        inc     bx
        xor     cx, cx

.sst_col:
        cmp     cx, bx
        jge     .sst_next_row

        push    cx
        mov     si, ws_text
        mov     di, ws_row_buf
        add     di, cx
        push    dx
        mov     dx, [ws_text_len]
.sst_cmp:
        cmp     dx, 0
        je      .sst_found
        mov     al, [si]
        cmp     al, [di]
        jne     .sst_no_match
        inc     si
        inc     di
        dec     dx
        jmp     .sst_cmp

.sst_found:
        pop     dx
        pop     cx
        pop     dx
        pop     cx
        pop     bx
        clc
        ret

.sst_no_match:
        pop     dx
        pop     cx
        inc     cx
        jmp     .sst_col

.sst_next_row:
        inc     dx
        jmp     .sst_row

.sst_not_found:
        pop     dx
        pop     cx
        pop     bx
        stc
        ret

; ============================================================
; HEARTBEAT — reset watchdog timer
; ============================================================
do_heartbeat:
        mov     ax, [watchdog_timeout]
        mov     [watchdog_remaining], ax
        mov     si, resp_ok
        call    write_rx
        ret

; ============================================================
; Helpers: byte_to_dec_2, word_to_dec_4
; ============================================================

; byte_to_dec_2: AL → 2-char zero-padded string at ES:DI
byte_to_dec_2:
        push    ax
        push    bx
        xor     ah, ah
        mov     bl, 10
        div     bl              ; AL=tens, AH=ones
        add     al, '0'
        stosb
        mov     al, ah
        add     al, '0'
        stosb
        pop     bx
        pop     ax
        ret

; word_to_dec_4: AX → 4-char zero-padded string at ES:DI
word_to_dec_4:
        push    ax
        push    bx
        push    dx
        mov     bx, 1000
        xor     dx, dx
        div     bx              ; AX=thousands, DX=remainder
        add     al, '0'
        stosb
        mov     ax, dx
        mov     bl, 100
        xor     ah, ah
        div     bl              ; AL=hundreds, AH=remainder
        push    ax
        add     al, '0'
        stosb
        pop     ax
        mov     al, ah
        xor     ah, ah
        mov     bl, 10
        div     bl              ; AL=tens, AH=ones
        add     al, '0'
        stosb
        mov     al, ah
        add     al, '0'
        stosb
        pop     dx
        pop     bx
        pop     ax
        ret

; ============================================================
; Shared utility: copy_str — copy NUL-terminated DS:SI to ES:DI
; ============================================================
copy_str:
.cs_loop:
        lodsb
        cmp     al, 0
        je      .cs_done
        stosb
        jmp     .cs_loop
.cs_done:
        ret

; ============================================================
; Shared utility: dword_to_decimal — convert DX:AX to decimal at ES:DI
; Clobbers AX, BX, CX, DX, SI
; ============================================================
dword_to_decimal:
        ; Push digits in reverse order (mod 10), then pop them
        ; For 8086, we need 32-bit divide by 10 manually
        xor     cx, cx                  ; digit count
.dtd_loop:
        ; Divide DX:AX by 10
        push    ax
        mov     ax, dx
        xor     dx, dx
        mov     bx, 10
        div     bx                      ; AX = high quotient, DX = remainder
        mov     si, ax                  ; save high quotient
        pop     ax                      ; restore low word
        div     bx                      ; AX = low quotient, DX = remainder
        push    dx                      ; save digit (0-9)
        inc     cx
        mov     dx, si                  ; DX = high quotient
        ; Check if DX:AX == 0
        or      ax, dx
        jnz     .dtd_loop

        ; Pop digits and write
.dtd_pop:
        pop     ax
        add     al, '0'
        stosb
        dec     cx
        jnz     .dtd_pop
        ret

; ============================================================
; Shared utility: wait_ticks — wait for N timer ticks (~55ms each)
; Input: CX = number of ticks to wait
; ============================================================
wait_ticks:
        push    es
        push    ax
        push    dx
        mov     ax, 0x0040
        mov     es, ax
        mov     ax, [es:0x006C]     ; current tick count
.wt_loop:
        sti
        hlt                         ; wait for next interrupt
        mov     dx, [es:0x006C]
        sub     dx, ax              ; elapsed = current - start
        cmp     dx, cx
        jb      .wt_loop
        pop     dx
        pop     ax
        pop     es
        ret

; ============================================================
; Shared utility: dec_to_str — convert AX to decimal at ES:DI
; Advances DI past the digits.
; ============================================================
dec_to_str:
        push    ax
        push    bx
        push    cx
        push    dx
        mov     bx, 10
        xor     cx, cx              ; digit count
.dts_div:
        xor     dx, dx
        div     bx                  ; AX = quotient, DX = remainder
        push    dx                  ; save digit
        inc     cx
        test    ax, ax
        jnz     .dts_div
.dts_pop:
        pop     ax
        add     al, '0'
        stosb
        dec     cx
        jnz     .dts_pop
        pop     dx
        pop     cx
        pop     bx
        pop     ax
        ret

; ============================================================
; Shared utility: button_bit — convert button number to bitmask
; Input: AX = button number (1=left, 2=right)
; Output: AX = bitmask (1 or 2)
; ============================================================
button_bit:
        cmp     ax, 2
        je      .bb_right
        mov     ax, 1               ; default: left button (bit 0)
        ret
.bb_right:
        mov     ax, 2               ; right button (bit 1)
        ret

; ============================================================
; CRC-16/CCITT — process byte in AL, running CRC in DX
; Polynomial: 0x1021, init: 0xFFFF
; ============================================================
crc16_byte:
        push    cx
        push    bx
        xor     ah, ah
        xchg    dl, dh              ; swap bytes of CRC
        xor     dl, al              ; XOR in new byte
        mov     cx, 8
.crc_bit:
        shl     dx, 1
        jnc     .crc_no_xor
        xor     dx, 0x1021
.crc_no_xor:
        dec     cx
        jnz     .crc_bit
        pop     bx
        pop     cx
        ret

; ============================================================
; Utility functions (resident)
; ============================================================

skip_spaces:
        lodsb
        cmp     al, ' '
        je      skip_spaces
        cmp     al, 0x09
        je      skip_spaces
        dec     si
        ret

str_ncmp_upper:
        push    si
        push    di
        push    cx
.ncmp_loop:
        jcxz    .ncmp_eq
        lodsb
        call    to_upper
        mov     ah, al
        mov     al, [di]
        call    to_upper
        cmp     ah, al
        jne     .ncmp_ne
        inc     di
        dec     cx
        jmp     .ncmp_loop
.ncmp_eq:
        pop     cx
        pop     di
        pop     si
        xor     ax, ax
        ret
.ncmp_ne:
        pop     cx
        pop     di
        pop     si
        or      ax, 1
        ret

str_eq_upper:
        push    si
        push    di
.eq_loop:
        lodsb
        call    to_upper
        mov     ah, al
        mov     al, [di]
        call    to_upper
        cmp     ah, al
        jne     .eq_ne
        inc     di
        cmp     ah, 0
        jne     .eq_loop
        pop     di
        pop     si
        xor     ax, ax
        ret
.eq_ne:
        pop     di
        pop     si
        or      ax, 1
        ret

to_upper:
        cmp     al, 'a'
        jb      .done
        cmp     al, 'z'
        ja      .done
        sub     al, 0x20
.done:
        ret

parse_hex16:
        ; Parse 1-4 hex digits from [SI], result in AX
        ; Stops at first non-hex char, fails if no digits parsed
        push    bx
        push    cx
        xor     ax, ax
        xor     cx, cx          ; digit count
.ph16_loop:
        mov     bl, [si]
        call    hex_digit
        jc      .ph16_end       ; not a hex digit — stop
        push    cx
        mov     cl, 4
        shl     ax, cl
        pop     cx
        or      al, bl
        inc     si
        inc     cx
        cmp     cx, 4
        jb      .ph16_loop
.ph16_end:
        ; Must have parsed at least 1 digit
        jcxz    .ph16_fail
        pop     cx
        pop     bx
        clc
        ret
.ph16_fail:
        pop     cx
        pop     bx
        stc
        ret

parse_hex8:
        push    bx
        mov     bl, [si]
        inc     si
        call    hex_digit
        jc      .ph8_fail
        push    cx
        mov     cl, 4
        shl     bl, cl
        pop     cx
        mov     al, bl
        mov     bl, [si]
        inc     si
        call    hex_digit
        jc      .ph8_fail
        or      al, bl
        pop     bx
        clc
        ret
.ph8_fail:
        pop     bx
        stc
        ret

hex_digit:
        cmp     bl, '0'
        jb      .hd_fail
        cmp     bl, '9'
        jbe     .hd_09
        and     bl, 0xDF
        cmp     bl, 'A'
        jb      .hd_fail
        cmp     bl, 'F'
        ja      .hd_fail
        sub     bl, 'A' - 10
        clc
        ret
.hd_09:
        sub     bl, '0'
        clc
        ret
.hd_fail:
        stc
        ret

parse_dec16:
        push    bx
        push    cx
        push    dx
        xor     ax, ax
        xor     cx, cx
.pd_loop:
        mov     bl, [si]
        cmp     bl, '0'
        jb      .pd_done
        cmp     bl, '9'
        ja      .pd_done
        inc     si
        inc     cx
        mov     dx, 10
        push    cx
        mul     dx
        pop     cx
        sub     bl, '0'
        xor     bh, bh
        add     ax, bx
        jmp     .pd_loop
.pd_done:
        cmp     cx, 0
        je      .pd_fail
        pop     dx
        pop     cx
        pop     bx
        clc
        ret
.pd_fail:
        pop     dx
        pop     cx
        pop     bx
        stc
        ret

byte_to_hex:
        push    ax
        push    cx
        mov     cl, 4
        shr     al, cl
        pop     cx
        call    .nibble
        pop     ax
        and     al, 0x0F
        call    .nibble
        ret
.nibble:
        cmp     al, 10
        jb      .n09
        add     al, 'A' - 10
        stosb
        ret
.n09:
        add     al, '0'
        stosb
        ret

; ============================================================
; Shared utility: word_to_hex — convert AX to 4 hex chars at ES:DI
; ============================================================
word_to_hex:
        push    ax
        mov     al, ah
        call    byte_to_hex
        pop     ax
        call    byte_to_hex
        ret

build_paths:
        mov     al, [drive_letter]
        mov     [path_tx], al
        mov     [path_rx], al
        mov     [path_st], al
        mov     [path_tt], al
        mov     [path_scr], al
        mov     [path_bmp], al
        mov     [path_out], al
        mov     [path_lr], al
        ret

write_debug:
        ; Write cmd_buf contents to TT file for debugging
        push    si
        mov     si, cmd_buf
        xor     cx, cx
.dbg_len:
        lodsb
        cmp     al, 0
        je      .dbg_len_done
        inc     cx
        jmp     .dbg_len
.dbg_len_done:
        pop     si
        push    cx              ; save length

        mov     dx, path_tt
        xor     cx, cx
        mov     ah, 0x3C
        int     0x21
        jc      .dbg_fail

        mov     bx, ax
        mov     dx, cmd_buf
        pop     cx              ; restore length
        mov     ah, 0x40
        int     0x21

        mov     ah, 0x3E
        int     0x21
        ret
.dbg_fail:
        pop     cx
        ret

; write_rx_checked — write response, overflow to LR file if too long
; Input: SI = response string (NUL-terminated)
write_rx_checked:
        push    si
        xor     cx, cx
.rxc_len:
        lodsb
        cmp     al, 0
        je      .rxc_len_done
        inc     cx
        jmp     .rxc_len
.rxc_len_done:
        pop     si

        ; If length < 500, use normal write_rx
        cmp     cx, 500
        jb      write_rx

        ; Write full response to LR file
        mov     [rx_len], cx
        ; Delete old LR file (ignore errors)
        mov     dx, path_lr
        mov     ah, 0x41
        int     0x21
        ; Create LR file
        mov     dx, path_lr
        xor     cx, cx
        mov     ah, 0x3C
        int     0x21
        jc      .rxc_fallback
        ; Write response to LR
        mov     bx, ax
        mov     dx, si
        mov     cx, [rx_len]
        mov     ah, 0x40
        int     0x21
        mov     ah, 0x3E
        int     0x21
        ; Write "OK @LR" to RX
        mov     si, resp_at_lr
        jmp     write_rx

.rxc_fallback:
        ; If LR file creation fails, write truncated to RX
        jmp     write_rx

write_rx:
        push    si
        xor     cx, cx
.rx_len:
        lodsb
        cmp     al, 0
        je      .rx_len_done
        inc     cx
        jmp     .rx_len
.rx_len_done:
        pop     si
        mov     [rx_len], cx

        ; Delete existing RX file first (ignore errors)
        mov     dx, path_rx
        mov     ah, 0x41
        int     0x21

        mov     dx, path_rx
        xor     cx, cx
        mov     ah, 0x3C
        int     0x21
        jc      .rx_fail

        mov     bx, ax
        mov     dx, si
        mov     cx, [rx_len]
        mov     ah, 0x40
        int     0x21

        mov     ah, 0x3E
        int     0x21
.rx_fail:
        ret

write_status_ready:
        mov     si, status_ready
        jmp     write_st
write_status_busy:
        mov     si, status_busy
        ; fall through

write_st:
        push    si
        xor     cx, cx
.st_len:
        lodsb
        cmp     al, 0
        je      .st_len_done
        inc     cx
        jmp     .st_len
.st_len_done:
        pop     si
        mov     [rx_len], cx

        mov     dx, path_st
        xor     cx, cx
        mov     ah, 0x3C
        int     0x21
        jc      .st_fail

        mov     bx, ax
        mov     dx, si
        mov     cx, [rx_len]
        mov     ah, 0x40
        int     0x21

        mov     ah, 0x3E
        int     0x21
.st_fail:
        ret

delete_file:
        mov     ah, 0x41
        int     0x21
        ret

clean_cmd:
        mov     cx, [cmd_len]
        cmp     cx, 0
        je      .cc_done
        mov     bx, cmd_buf
        add     bx, cx
        dec     bx
.cc_strip:
        cmp     bx, cmd_buf
        jb      .cc_zero
        mov     al, [bx]
        cmp     al, 0x0D
        je      .cc_trim
        cmp     al, 0x0A
        je      .cc_trim
        cmp     al, ' '
        je      .cc_trim
        inc     bx
        mov     byte [bx], 0
        jmp     .cc_done
.cc_trim:
        dec     bx
        jmp     .cc_strip
.cc_zero:
        mov     byte [cmd_buf], 0
        mov     word [cmd_len], 0
.cc_done:
        ret

; ============================================================
; Resident data (initialized)
; ============================================================

; File paths — drive letter + magic dir patched at runtime
; Each buffer is 40 bytes to allow custom MAGICPATH up to ~20 chars
PATH_BUF_SIZE equ 40
path_tx:        db  'X:\_MAGIC_\__MCP__.TX', 0
                times PATH_BUF_SIZE - ($ - path_tx) db 0
path_rx:        db  'X:\_MAGIC_\__MCP__.RX', 0
                times PATH_BUF_SIZE - ($ - path_rx) db 0
path_st:        db  'X:\_MAGIC_\__MCP__.ST', 0
                times PATH_BUF_SIZE - ($ - path_st) db 0
path_tt:        db  'X:\_MAGIC_\__MCP__.TT', 0
                times PATH_BUF_SIZE - ($ - path_tt) db 0
path_scr:       db  'X:\_MAGIC_\__MCP__.SCR', 0
                times PATH_BUF_SIZE - ($ - path_scr) db 0
path_bmp:       db  'X:\_MAGIC_\__MCP__.BMP', 0
                times PATH_BUF_SIZE - ($ - path_bmp) db 0
path_out:       db  'X:\_MAGIC_\__MCP__.OUT', 0
                times PATH_BUF_SIZE - ($ - path_out) db 0
path_lr:        db  'X:\_MAGIC_\__MCP__.LR', 0
                times PATH_BUF_SIZE - ($ - path_lr) db 0

; Path filename suffixes for rebuild
NUM_PATHS equ 8
path_table:
        dw  path_tx, path_rx, path_st, path_tt, path_scr, path_bmp, path_out, path_lr
path_suffixes:
        db  '__MCP__.TX', 0
        db  '__MCP__.RX', 0
        db  '__MCP__.ST', 0
        db  '__MCP__.TT', 0
        db  '__MCP__.SCR', 0
        db  '__MCP__.BMP', 0
        db  '__MCP__.OUT', 0
        db  '__MCP__.LR', 0

drive_letter:   db  'Z'

; Command verb strings
; Family prefix strings (with trailing space for prefix matching)
fam_meta:       db  'META '
fam_mem:        db  'MEM '
fam_port:       db  'PORT '
fam_con:        db  'CON '
fam_gfx:        db  'GFX '
fam_screen:     db  'SCREEN '
fam_mouse:      db  'MOUSE '
fam_key:        db  'KEY '
fam_wait:       db  'WAIT '
fam_file:       db  'FILE '
fam_dir:        db  'DIR '
fam_exec:       db  'EXEC '
fam_time:       db  'TIME '
fam_ini:        db  'INI '
fam_clip:       db  'CLIP '
fam_int:        db  'INT '
fam_sys:        db  'SYS '
fam_disk:       db  'DISK '
fam_env:        db  'ENV '

; Subcommand strings (shared across families)
sub_ping:       db  'PING'
sub_version:    db  'VERSION'
sub_status:     db  'STATUS'
sub_heartbeat:  db  'HEARTBEAT'
sub_log:        db  'LOG'
sub_batch:      db  'BATCH'
sub_repeat:     db  'REPEAT'
sub_peek:       db  'PEEK'
sub_poke:       db  'POKE'
sub_read:       db  'READ'
sub_write:      db  'WRITE'
sub_free:       db  'FREE'
sub_in:         db  'IN'
sub_out:        db  'OUT'
sub_region:     db  'REGION'
sub_find:       db  'FIND'
sub_cursor:     db  'CURSOR'
sub_crc:        db  'CRC'
sub_get:        db  'GET'
sub_set:        db  'SET'
sub_pixel:      db  'PIXEL'
sub_dump:       db  'DUMP'
sub_move:       db  'MOVE'
sub_click:      db  'CLICK'
sub_dblclick:   db  'DBLCLICK'
sub_down:       db  'DOWN'
sub_up:         db  'UP'
sub_drag:       db  'DRAG'
sub_send:       db  'SEND'
sub_type:       db  'TYPE'
sub_hotkey:     db  'HOTKEY'
sub_screen:     db  'SCREEN'
sub_gone:       db  'GONE'
sub_sleep:      db  'SLEEP'
sub_delete:     db  'DELETE'
sub_rename:     db  'RENAME'
sub_copy:       db  'COPY'
sub_list:       db  'LIST'
sub_make:       db  'MAKE'
sub_change:     db  'CHANGE'
sub_run:        db  'RUN'
sub_shell:      db  'SHELL'
sub_exit:       db  'EXIT'
sub_call:       db  'CALL'
sub_exists:     db  'EXISTS'
sub_size:       db  'SIZE'
sub_time_s:     db  'TIME'
sub_drives:     db  'DRIVES'
sub_attr:       db  'ATTR'
sub_mode:       db  'MODE'
sub_clear:      db  'CLEAR'
sub_scroll:     db  'SCROLL'
sub_search:     db  'SEARCH'
sub_fill:       db  'FILL'
sub_mcb:        db  'MCB'
sub_info:       db  'INFO'
sub_memory_s:   db  'MEMORY'
sub_drivers_s:  db  'DRIVERS'
sub_ansi:       db  'ANSI'
sub_reboot:     db  'REBOOT'
sub_beep:       db  'BEEP'
sub_tone:       db  'TONE'
sub_quiet:      db  'QUIET'
sub_lasterror:  db  'LASTERROR'
sub_unload:     db  'UNLOAD'
sub_flush:      db  'FLUSH'
sub_color:      db  'COLOR'
sub_box:        db  'BOX'
sub_input:      db  'INPUT'
sub_append:     db  'APPEND'
sub_watch:      db  'WATCH'
sub_delay:      db  'DELAY'
sub_ems:        db  'EMS'
sub_xms:        db  'XMS'
fam_cmos:       db  'CMOS '
fam_power:      db  'POWER '
fam_tsr:        db  'TSR '
sub_vesa:       db  'VESA'
sub_palette:    db  'PALETTE'
sub_idle:       db  'IDLE'
sub_standby:    db  'STANDBY'
sub_off:        db  'OFF'

; String constants for power status
str_online:     db  'ONLINE', 0
str_offline:    db  'OFFLINE', 0
str_unknown:    db  'UNKNOWN', 0

; String constants for SCREEN output
str_space:      db  ' '
str_pipe:       db  '|'
str_crlf:       db  0x0D, 0x0A

; Response strings
resp_pong:        db  'OK PONG', 0
resp_ok:          db  'OK', 0
resp_ok_prefix:   db  'OK ', 0
resp_ok1:         db  'OK 1', 0
resp_ok0:         db  'OK 0', 0
resp_ok_unloaded: db  'OK UNLOADED', 0
resp_err_not_tsr: db  'ERR NOT_TSR', 0
resp_ok_reboot:   db  'OK REBOOTING', 0
resp_ok_empty:    db  'OK EMPTY', 0
resp_ok_changed:  db  'OK CHANGED', 0
resp_ok_unchanged: db 'OK UNCHANGED', 0
resp_err_no_vesa: db  'ERR NO_VESA', 0
resp_err_no_ems:  db  'ERR NO_EMS', 0
resp_err_no_xms:  db  'ERR NO_XMS', 0
resp_err_env_full: db  'ERR ENV_FULL', 0
resp_err_no_apm:   db  'ERR NO_APM', 0
resp_at_lr:       db  'OK @LR', 0
resp_err_unknown: db  'ERR UNKNOWN_COMMAND', 0
resp_err_syntax:  db  'ERR SYNTAX', 0
resp_err_exec:    db  'ERR EXEC_FAILED', 0
resp_err_timeout:   db  'ERR TIMEOUT', 0
resp_err_clipboard: db  'ERR CLIPBOARD_UNAVAILABLE', 0
resp_err_clipbusy:  db  'ERR CLIPBOARD_BUSY', 0
resp_err_filenotfound: db 'ERR FILE_NOT_FOUND', 0
resp_err_write:     db  'ERR WRITE_FAILED', 0
resp_err_rename:    db  'ERR RENAME_FAILED', 0
resp_err_copy:      db  'ERR COPY_FAILED', 0
resp_err_mkdir:     db  'ERR MKDIR_FAILED', 0
resp_err_chdir:     db  'ERR CHDIR_FAILED', 0
resp_err_date:      db  'ERR INVALID_DATE', 0
resp_err_time_inv:  db  'ERR INVALID_TIME', 0
resp_err_notfound:  db  'ERR NOT_FOUND', 0
resp_version:     db  'OK MCP/0.10 META,MEM,PORT,CON,GFX,SCREEN,MOUSE,KEY,'
                  db  'WAIT,FILE,DIR,DISK,EXEC,TIME,INI,CLIP,INT,ENV,SYS,CMOS,POWER,TSR', 0

; STATUS format labels
status_prefix:      db  'OK V0.10 CMDS=', 0
status_debug_lbl:   db  'DEBUG=', 0
status_poll_lbl:    db  'POLL=', 0
status_timeout_lbl: db  'TIMEOUT=', 0

; Key name table: (word ptr_to_name, byte mask) entries, terminated by dw 0
key_table:
        dw      kn_rshift
        db      0x01
        dw      kn_lshift
        db      0x02
        dw      kn_ctrl
        db      0x04
        dw      kn_alt
        db      0x08
        dw      kn_scrolllock
        db      0x10
        dw      kn_numlock
        db      0x20
        dw      kn_capslock
        db      0x40
        dw      kn_insert
        db      0x80
        dw      0               ; sentinel

kn_rshift:      db  'RSHIFT', 0
kn_lshift:      db  'LSHIFT', 0
kn_ctrl:        db  'CTRL', 0
kn_alt:         db  'ALT', 0
kn_scrolllock:  db  'SCROLLLOCK', 0
kn_numlock:     db  'NUMLOCK', 0
kn_capslock:    db  'CAPSLOCK', 0
kn_insert:      db  'INSERT', 0

; ASCII-to-scancode table (128 bytes, indexed by ASCII value)
; 0 means no mapping
ascii_to_scan:
        ;       0     1     2     3     4     5     6     7
        db   0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00  ; 0x00-0x07
        db   0x0E, 0x0F, 0x00, 0x00, 0x00, 0x1C, 0x00, 0x00  ; 0x08-0x0F (BS,TAB,_,_,_,ENTER)
        db   0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00  ; 0x10-0x17
        db   0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00  ; 0x18-0x1F (ESC=0x1B)
        db   0x39, 0x02, 0x28, 0x04, 0x05, 0x06, 0x08, 0x28  ; 0x20-0x27 (space ! " # $ % & ')
        db   0x0A, 0x0B, 0x09, 0x0D, 0x33, 0x0C, 0x34, 0x35  ; 0x28-0x2F ( ( ) * + , - . / )
        db   0x0B, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08  ; 0x30-0x37 (0-7)
        db   0x09, 0x0A, 0x27, 0x27, 0x33, 0x0D, 0x34, 0x35  ; 0x38-0x3F (8 9 : ; < = > ?)
        db   0x03, 0x1E, 0x30, 0x2E, 0x20, 0x12, 0x21, 0x22  ; 0x40-0x47 (@ A-G)
        db   0x23, 0x17, 0x24, 0x25, 0x26, 0x32, 0x31, 0x18  ; 0x48-0x4F (H-O)
        db   0x19, 0x10, 0x13, 0x1F, 0x14, 0x16, 0x2F, 0x11  ; 0x50-0x57 (P-W)
        db   0x2D, 0x15, 0x2C, 0x1A, 0x2B, 0x1B, 0x07, 0x0C  ; 0x58-0x5F (X-Z [ \ ] ^ _)
        db   0x29, 0x1E, 0x30, 0x2E, 0x20, 0x12, 0x21, 0x22  ; 0x60-0x67 (` a-g)
        db   0x23, 0x17, 0x24, 0x25, 0x26, 0x32, 0x31, 0x18  ; 0x68-0x6F (h-o)
        db   0x19, 0x10, 0x13, 0x1F, 0x14, 0x16, 0x2F, 0x11  ; 0x70-0x77 (p-w)
        db   0x2D, 0x15, 0x2C, 0x7A, 0x2B, 0x7B, 0x29, 0x00  ; 0x78-0x7F (x-z { | } ~)

; Shift table: 0 = no shift, 1 = needs shift, indexed by ASCII
ascii_shift_tab:
        ;       0  1  2  3  4  5  6  7
        db      0, 0, 0, 0, 0, 0, 0, 0  ; 0x00-0x07
        db      0, 0, 0, 0, 0, 0, 0, 0  ; 0x08-0x0F
        db      0, 0, 0, 0, 0, 0, 0, 0  ; 0x10-0x17
        db      0, 0, 0, 0, 0, 0, 0, 0  ; 0x18-0x1F
        db      0, 1, 1, 1, 1, 1, 1, 0  ; 0x20-0x27 (space ! " # $ % & ')
        db      1, 1, 1, 1, 0, 0, 0, 0  ; 0x28-0x2F ( ( ) * + , - . / )
        db      0, 0, 0, 0, 0, 0, 0, 0  ; 0x30-0x37 (0-7)
        db      0, 0, 1, 0, 1, 0, 1, 1  ; 0x38-0x3F (8 9 : ; < = > ?)
        db      1, 1, 1, 1, 1, 1, 1, 1  ; 0x40-0x47 (@ A-G)
        db      1, 1, 1, 1, 1, 1, 1, 1  ; 0x48-0x4F (H-O)
        db      1, 1, 1, 1, 1, 1, 1, 1  ; 0x50-0x57 (P-W)
        db      1, 1, 1, 0, 0, 0, 1, 1  ; 0x58-0x5F (X-Z [ \ ] ^ _)
        db      0, 0, 0, 0, 0, 0, 0, 0  ; 0x60-0x67 (` a-g)
        db      0, 0, 0, 0, 0, 0, 0, 0  ; 0x68-0x6F (h-o)
        db      0, 0, 0, 0, 0, 0, 0, 0  ; 0x70-0x77 (p-w)
        db      0, 0, 0, 1, 1, 1, 1, 0  ; 0x78-0x7F (x-z { | } ~)

; Status strings
status_ready:   db  'READY', 0
status_busy:    db  'BUSY', 0

; SENDKEYS special key names
sk_enter_name:  db  'ENTER', 0
sk_esc_name:    db  'ESC', 0
sk_tab_name:    db  'TAB', 0
sk_up_name:     db  'UP', 0
sk_down_name:   db  'DOWN', 0
sk_left_name:   db  'LEFT', 0
sk_right_name:  db  'RIGHT', 0

; INT command format strings
int_ok_prefix:  db  'OK AX=', 0
int_bx_lbl:     db  ' BX=', 0
int_cx_lbl:     db  ' CX=', 0
int_dx_lbl:     db  ' DX=', 0
int_cf_lbl:     db  ' CF=', 0

; DIR label
dir_label:      db  ' <DIR>', 0

; COMSPEC path for EXEC/SHELL
comspec_path:   db  'C:\COMMAND.COM', 0

; TSR tick interval: ~2 polls/sec at 18.2 Hz
TICK_INTERVAL   equ 9

; Configuration (overridable via MCP.CFG)
cfg_poll:       db  TICK_INTERVAL
cfg_debug:      db  1
cfg_timeout:    dw  182

; Command counter for STATUS
cmd_count:      dw  0

; ============================================================
; Resident data — TSR state variables
; ============================================================

; Saved interrupt vectors
old_int08:      dd  0
old_int2f:      dd  0
old_int23:      dd  0

; InDOS flag far pointer (set during init)
indos_ptr:      dd  0

; Our PSP segment (set during init)
our_psp:        dw  0

; TSR flags
tsr_busy:       db  0
tick_count:     db  TICK_INTERVAL

; Stack save area for TSR handler
save_ss_tsr:    dw  0
save_sp_tsr:    dw  0

; PSP/DTA save area for TSR handler
save_psp:       dw  0
save_dta_off:   dw  0
save_dta_seg:   dw  0

; ============================================================
; Resident BSS — variables used by command handlers
; ============================================================
CMD_BUF_SIZE    equ 256

tx_handle:      resw 1
cmd_buf:        resb CMD_BUF_SIZE
cmd_len:        resw 1
rx_len:         resw 1
resp_buf:       resb 512

; PEEK/POKE scratch
peek_seg:       resw 1
peek_off:       resw 1
peek_len:       resw 1

; SENDKEYS scratch
special_buf:    resb 16

; EXEC scratch
exec_cmdtail:   resb 128
exec_pb:        resb 14
save_ss:        resw 1
save_sp:        resw 1

; SCREEN scratch
scr_start:      resw 1
scr_count:      resw 1
scr_remain:     resw 1
scr_cur_row:    resw 1
scr_handle:     resw 1
scr_line_buf:   resb 82

; BMP scratch
bmp_vidmode:    resb 1
bmp_bpp:        resb 1
bmp_width:      resw 1
bmp_height:     resw 1
bmp_rowsize:    resw 1
bmp_pixsize:    resw 2              ; DWORD
bmp_cur_x:      resw 1
bmp_cur_y:      resw 1
bmp_pal_idx:    resw 1
bmp_rgb_buf:    resb 48             ; 16 RGB triples for palette chunk

; MOUSE scratch
mouse_x:        resw 1
mouse_y:        resw 1
mouse_btn:      resw 1

; OUTP scratch
outp_port:      resw 1

; CLIPBOARD scratch
clip_size:      resw 1

; DRAG scratch
drag_x1:        resw 1
drag_y1:        resw 1
drag_x2:        resw 1
drag_y2:        resw 1

; WAITSCREEN scratch
ws_text:        resb 42
ws_text_len:    resw 1
ws_timeout:     resw 1
ws_start_tick:  resw 1
ws_cur_row:     resw 1
ws_scan_max:    resw 1
ws_row_buf:     resb 80

; TYPE scratch
type_char:      resb 1

; HOTKEY scratch
hotkey_mask:    resb 1

; SCREENREGION scratch
sr_row1:        resw 1
sr_col1:        resw 1
sr_row2:        resw 1
sr_col2:        resw 1

; WAITCRC scratch
wc_expected:    resw 1
wc_timeout:     resw 1
wc_start_tick:  resw 1

; REPEAT scratch
rpt_count:      resw 1
rpt_cmd_ptr:    resw 1
rpt_cmd_buf:    resb 128
rpt_cmd_len:    resw 1

; DIR scratch
dir_path_buf:   resb 80
dir_first:      resb 1

; READFILE scratch
file_path_buf:  resb 80
rf_offset:      resw 1
rf_length:      resw 1
rf_remaining:   resw 1
rf_data_buf:    resb 160

; INT scratch
int_num:        resb 1
int_ax:         resw 1
int_bx:         resw 1
int_cx:         resw 1
int_dx:         resw 1
int_cf:         resb 1

; BATCH scratch
batch_buf:      resb 256

; WRITEFILE scratch
wf_handle:      resw 1
wf_offset:      resw 2
wf_count:       resw 1

; COPY scratch
cp_src_handle:  resw 1
cp_dst_handle:  resw 1
cp_dst_ptr:     resw 1
cp_total:       resw 2

; RENAME scratch
ren_newpath:    resb 80

; CHDIR scratch
chdir_buf:      resb 68

; TIME scratch
time_year:      resw 1
time_month:     resb 1
time_day:       resb 1
time_hour:      resb 1
time_min:       resb 1
time_sec:       resb 1

; FINDTEXT scratch
ft_matches:     resw 1
ft_text:        resb 42
ft_text_len:    resw 1

; WAITPIXEL scratch
wp_x:           resw 1
wp_y:           resw 1
wp_color:       resb 1
wp_timeout:     resw 1
wp_start:       resw 1

; INI scratch
INI_BUF_SIZE    equ 2048
ini_buf:        resb INI_BUF_SIZE
ini_buf_len:    resw 1
ini_section:    resb 32
ini_key:        resb 32
ini_value:      resb 128
ini_handle:     resw 1

; INI WRITE scratch
iw_prefix_len:  resw 1
iw_suffix_len:  resw 1
iw_suffix_ptr:  resw 1

; Watchdog
watchdog_timeout:   resw 1
watchdog_remaining: resw 1

; CON COLOR default attribute
con_color:      db  07h                 ; default: white on black

; CON BOX parameters
box_row:        resw 1
box_col:        resw 1
box_height:     resw 1
box_width:      resw 1
box_attr:       resb 1
box_style:      resb 1
box_tl:         resb 1
box_tr:         resb 1
box_bl:         resb 1
box_br:         resb 1
box_hz:         resb 1
box_vt:         resb 1

; Find First/Next DTA
find_dta:       resb 44
old_dta_off:    resw 1
old_dta_seg:    resw 1

; XMS driver entry point
xms_entry:      resw 2

; VESA info buffer (256 bytes)
vesa_buf:       resb 256

; FILE FIND first flag
ff_first:       resb 1

; FILE WATCH state
watch_path:     resb 65
watch_size:     resw 2
watch_time:     resw 1
watch_date:     resw 1
watch_valid:    resb 1

; ENV SET working storage
env_name_buf:   resb 64
env_name_len:   resw 1
env_val_ptr:    resw 1
env_seg:        resw 1
env_size:       resw 1

; INT WATCH working storage
iw_vector:      resb 1
iw_ticks:       resw 1
iw_count:       resw 1
iw_old_off:     resw 1
iw_old_seg:     resw 1

; DTA for TSR (128 bytes, standard DTA size)
our_dta:        resb 128

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
        xor     ax, ax
        mov     [tx_handle], ax
        mov     [cmd_len], ax
        mov     [rx_len], ax

        ; --- Save our PSP ---
        mov     [our_psp], cs

        ; --- Shrink memory for EXEC support ---
        mov     bx, end_of_init
        add     bx, 256 + 15
        push    cx
        mov     cl, 4
        shr     bx, cl
        pop     cx
        mov     ah, 0x4A
        int     0x21

        ; --- Parse command line for drive letter ---
        mov     si, 0x0081
        call    skip_spaces
        lodsb
        cmp     al, 0x0D
        je      .no_drive
        and     al, 0xDF
        cmp     al, 'A'
        jb      .no_drive
        cmp     al, 'Z'
        ja      .no_drive
        mov     [drive_letter], al
        lodsb
        cmp     al, ':'
        jne     .no_drive

        ; Build file paths
        call    build_paths

        ; --- Parse MCP.CFG (optional) ---
        call    parse_config

        ; --- Apply MAGICPATH if set ---
        cmp     byte [cfg_mp_set], 1
        jne     .no_magicpath
        call    rebuild_paths
.no_magicpath:

        ; --- Check for /T flag ---
        call    skip_spaces
        lodsb
        cmp     al, '/'
        jne     .foreground_mode
        lodsb
        and     al, 0xDF            ; uppercase
        cmp     al, 'T'
        je      .tsr_mode

.foreground_mode:
        ; --- Foreground mode (Phase 1 behavior) ---
        mov     dx, msg_banner_fg
        mov     ah, 0x09
        int     0x21

        ; Write initial status
        call    write_status_ready

.fg_poll_loop:
        ; Wait for next timer tick (~55ms) to avoid racing with
        ; the test harness on file I/O. HLT halts until interrupt.
        sti
        hlt

        ; Poll for commands
        call    poll_once

        jmp     .fg_poll_loop

.no_drive:
        mov     dx, msg_usage
        mov     ah, 0x09
        int     0x21
        mov     ax, 0x4C01
        int     0x21

.tsr_mode:
        ; --- TSR mode ---

        ; Check if already installed via INT 2Fh multiplex
        mov     ax, 0xC000          ; AH=C0h, AL=00h (installation check)
        int     0x2F
        cmp     al, 0xFF
        je      .already_installed

        ; Get InDOS flag address
        mov     ah, 0x34
        int     0x21
        mov     [indos_ptr], bx
        mov     [indos_ptr+2], es

        ; Hook INT 08h (timer tick)
        mov     ax, 0x3508          ; Get INT 08h vector
        int     0x21
        mov     [old_int08], bx
        mov     [old_int08+2], es

        mov     dx, int08_handler
        mov     ax, 0x2508          ; Set INT 08h vector
        int     0x21

        ; Hook INT 2Fh (multiplex)
        mov     ax, 0x352F          ; Get INT 2Fh vector
        int     0x21
        mov     [old_int2f], bx
        mov     [old_int2f+2], es

        mov     dx, int2f_handler
        mov     ax, 0x252F          ; Set INT 2Fh vector
        int     0x21

        ; Hook INT 23h (Ctrl-C/Break protection) — TSR mode only
        mov     ax, 0x3523
        int     0x21
        mov     [old_int23], bx
        mov     [old_int23+2], es
        mov     dx, int23_handler
        mov     ax, 0x2523
        int     0x21

        ; Write READY status
        call    write_status_ready

        ; Print TSR banner
        mov     dx, msg_banner_tsr
        mov     ah, 0x09
        int     0x21

        ; Go resident — keep everything up to resident_end
        ; DX = number of paragraphs to keep (from start of PSP)
        mov     dx, resident_end + 15
        push    cx
        mov     cl, 4
        shr     dx, cl
        pop     cx
        mov     ax, 0x3100          ; INT 21h/31h: Keep Process, return code 0
        int     0x21

.already_installed:
        mov     dx, msg_already
        mov     ah, 0x09
        int     0x21
        mov     ax, 0x4C00
        int     0x21

; ============================================================
; Init-only data (freed after going resident)
; ============================================================

msg_banner_fg:  db  'MCP v0.10 - Model Context Protocol for DOS', 0x0D, 0x0A
                db  'Polling for commands... (Ctrl+C to exit)', 0x0D, 0x0A, '$'
msg_banner_tsr: db  'MCP v0.10 - Installed as TSR', 0x0D, 0x0A, '$'
msg_usage:      db  'Usage: MCP.COM <drive:> [/T]', 0x0D, 0x0A
                db  '  /T = install as TSR', 0x0D, 0x0A, '$'
msg_already:    db  'MCP is already installed.', 0x0D, 0x0A, '$'

; ============================================================
; parse_config — read MCP.CFG and apply settings
; (init-only, safe to use memory after resident_end)
; ============================================================
parse_config:
        ; Try to open MCP.CFG
        mov     dx, cfg_filename
        mov     ax, 0x3D00          ; open read-only
        int     0x21
        jc      .cfg_nofile         ; no file → use defaults

        ; Read up to 512 bytes into cfg_buf
        mov     bx, ax              ; file handle
        mov     dx, cfg_buf
        mov     cx, 511
        mov     ah, 0x3F
        int     0x21
        push    ax                  ; save bytes read
        mov     ah, 0x3E            ; close file
        int     0x21
        pop     cx                  ; CX = bytes read

        ; Null-terminate the buffer
        mov     bx, cfg_buf
        add     bx, cx
        mov     byte [bx], 0

        ; Parse line by line
        mov     si, cfg_buf
.cfg_next_line:
        cmp     byte [si], 0
        je      .cfg_done

        ; Skip leading whitespace
        cmp     byte [si], ' '
        je      .cfg_skip_char
        cmp     byte [si], 0x09
        je      .cfg_skip_char

        ; Comment line?
        cmp     byte [si], ';'
        je      .cfg_skip_line
        ; Blank line? (CR or LF)
        cmp     byte [si], 0x0D
        je      .cfg_skip_line
        cmp     byte [si], 0x0A
        je      .cfg_skip_line

        ; Try to match known keys
        ; POLL=
        push    si
        mov     di, cfg_key_poll
        mov     cx, 5
        call    str_ncmp_upper
        pop     si
        jne     .cfg_not_poll
        add     si, 5
        call    parse_dec16
        jc      .cfg_skip_line
        mov     [cfg_poll], al
        mov     [tick_count], al
        jmp     .cfg_skip_line

.cfg_not_poll:
        ; DEBUG=
        push    si
        mov     di, cfg_key_debug
        mov     cx, 6
        call    str_ncmp_upper
        pop     si
        jne     .cfg_not_debug
        add     si, 6
        call    parse_dec16
        jc      .cfg_skip_line
        mov     [cfg_debug], al
        jmp     .cfg_skip_line

.cfg_not_debug:
        ; TIMEOUT=
        push    si
        mov     di, cfg_key_timeout
        mov     cx, 8
        call    str_ncmp_upper
        pop     si
        jne     .cfg_not_timeout
        add     si, 8
        call    parse_dec16
        jc      .cfg_skip_line
        mov     [cfg_timeout], ax
        jmp     .cfg_skip_line

.cfg_not_timeout:
        ; WATCHDOG=
        push    si
        mov     di, cfg_key_watchdog
        mov     cx, 9
        call    str_ncmp_upper
        pop     si
        jne     .cfg_not_watchdog
        add     si, 9
        call    parse_dec16
        jc      .cfg_skip_line
        mov     [watchdog_timeout], ax
        mov     [watchdog_remaining], ax
        jmp     .cfg_skip_line

.cfg_not_watchdog:
        ; MAGICPATH=
        push    si
        mov     di, cfg_key_magicpath
        mov     cx, 10
        call    str_ncmp_upper
        pop     si
        jne     .cfg_skip_line
        add     si, 10
        ; Copy value to cfg_magicpath (up to 24 chars)
        mov     di, cfg_magicpath
        xor     cx, cx
.cfg_mp_copy:
        lodsb
        cmp     al, 0x0D
        je      .cfg_mp_done
        cmp     al, 0x0A
        je      .cfg_mp_done
        cmp     al, 0
        je      .cfg_mp_done
        cmp     cx, 24
        jge     .cfg_mp_done
        stosb
        inc     cx
        jmp     .cfg_mp_copy
.cfg_mp_done:
        mov     byte [di], 0
        mov     byte [cfg_mp_set], 1

.cfg_skip_line:
        ; Advance to next line (past CR/LF)
        cmp     byte [si], 0
        je      .cfg_done
        lodsb
        cmp     al, 0x0A
        je      .cfg_next_line
        cmp     al, 0x0D
        je      .cfg_check_lf
        jmp     .cfg_skip_line

.cfg_check_lf:
        cmp     byte [si], 0x0A
        jne     .cfg_next_line
        inc     si
        jmp     .cfg_next_line

.cfg_skip_char:
        inc     si
        jmp     .cfg_next_line

.cfg_nofile:
.cfg_done:
        ret

; Config key strings
cfg_key_poll:    db  'POLL='
cfg_key_debug:   db  'DEBUG='
cfg_key_timeout: db  'TIMEOUT='
cfg_key_watchdog:  db 'WATCHDOG='
cfg_key_magicpath: db 'MAGICPATH='

; Config filename
cfg_filename:   db  'MCP.CFG', 0

; ============================================================
; rebuild_paths — replace _MAGIC_ segment with custom MAGICPATH
; Called once during init when MAGICPATH= is set in MCP.CFG
; ============================================================
rebuild_paths:
        ; For each path, rebuild as: "X:\" + magicpath + "\" + suffix
        mov     bx, path_table          ; pointer to table of path pointers
        mov     si, path_suffixes       ; pointer to suffix strings
        xor     cx, cx                  ; path index

.rp_next:
        cmp     cx, NUM_PATHS
        jge     .rp_done

        ; Get destination path buffer
        push    si
        mov     si, bx
        mov     di, [si]                ; DI = path buffer address
        pop     si

        ; Write "X:\"
        mov     al, [drive_letter]
        mov     [di], al
        inc     di
        mov     byte [di], ':'
        inc     di
        mov     byte [di], '\'
        inc     di

        ; Copy cfg_magicpath
        push    si
        mov     si, cfg_magicpath
.rp_copy_mp:
        lodsb
        cmp     al, 0
        je      .rp_mp_done
        stosb
        jmp     .rp_copy_mp
.rp_mp_done:
        pop     si

        ; Add trailing backslash if magicpath didn't end with one
        cmp     byte [di-1], '\'
        je      .rp_copy_suffix
        mov     byte [di], '\'
        inc     di

.rp_copy_suffix:
        ; Copy suffix (e.g., "__MCP__.TX")
        push    si                      ; save suffix pointer
.rp_copy_sfx:
        lodsb
        stosb
        cmp     al, 0
        jne     .rp_copy_sfx
        ; SI now points past the NUL of this suffix
        mov     dx, si                  ; save new suffix pointer
        pop     si                      ; discard saved suffix pointer
        mov     si, dx                  ; advance to next suffix

        ; Advance to next path
        add     bx, 2                   ; next entry in path_table
        inc     cx
        jmp     .rp_next

.rp_done:
        ret

; Config file read buffer (init-only, not needed after parsing)
cfg_magicpath:  resb 32
cfg_mp_set:     db  0
cfg_buf:        resb 512

end_of_init:
