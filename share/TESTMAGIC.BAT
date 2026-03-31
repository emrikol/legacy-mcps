@echo off
rem =============================================
rem  Magic Virtual Files Test Suite
rem  Tests _MAGIC_ directory virtual files
rem =============================================
rem --- Ensure Z: is mapped silently ---
net use z: \\MACHOST\SHARE /user:EMRIKOL "" /yes >nul
echo.
echo ============================================
echo  Magic Virtual Files Test
echo ============================================
echo.
rem
rem --- TIME ---
echo [1] _TIME_.TXT (default format)
echo -------------------------------------------
type z:\_MAGIC_\_TIME_.TXT
echo.
rem
echo [2] _TIME_.TXT (UNIX format)
echo -------------------------------------------
echo UNIX > z:\_MAGIC_\_TIME_.TXT
type z:\_MAGIC_\_TIME_.TXT
echo.
rem
echo [3] _TIME_.TXT (ISO format)
echo -------------------------------------------
echo ISO > z:\_MAGIC_\_TIME_.TXT
type z:\_MAGIC_\_TIME_.TXT
echo.
rem
echo [4] _TIME_.TXT (strftime)
echo -------------------------------------------
echo %%Y-%%m-%%d %%H:%%M:%%S > z:\_MAGIC_\_TIME_.TXT
type z:\_MAGIC_\_TIME_.TXT
echo.
rem
echo [5] _TIME_.TXT (reset to default)
echo -------------------------------------------
echo. > z:\_MAGIC_\_TIME_.TXT
type z:\_MAGIC_\_TIME_.TXT
echo.
rem
rem --- STATS ---
echo [6] _STATS_.TXT
echo -------------------------------------------
type z:\_MAGIC_\_STATS_.TXT
echo.
rem
rem --- CLIP ---
echo [7] _CLIP_.TXT (write to clipboard)
echo -------------------------------------------
echo Hello from WFW 3.11! > z:\_MAGIC_\_CLIP_.TXT
echo Wrote to clipboard. Reading back:
type z:\_MAGIC_\_CLIP_.TXT
echo.
rem
rem --- EXEC ---
echo [8] _EXEC_.TXT (run host command)
echo -------------------------------------------
echo ls -la > z:\_MAGIC_\_EXEC_.TXT
echo Waiting 2 seconds for command...
rem DOS has no sleep, so we use ping for delay
ping -n 3 127.0.0.1 >nul
type z:\_MAGIC_\_EXEC_.TXT
echo.
rem
rem --- WGET ---
echo [9] _WGET_.TXT (fetch URL)
echo -------------------------------------------
echo http://example.com > z:\_MAGIC_\_WGET_.TXT
echo Waiting for fetch...
ping -n 5 127.0.0.1 >nul
type z:\_MAGIC_\_WGET_.TXT
echo.
rem
rem --- RESET ---
echo [10] Reset all magic files
echo -------------------------------------------
echo. > z:\_MAGIC_\_TIME_.TXT
echo. > z:\_MAGIC_\_WGET_.TXT
echo. > z:\_MAGIC_\_EXEC_.TXT
echo Reset complete.
echo.
echo ============================================
echo  All magic tests complete!
echo ============================================
