@ECHO OFF
REM MCP Test Batch — run inside DOSBox
REM Loads MCP.COM pointing at Z: drive, then waits.
REM The host-side test harness drives the actual tests via file I/O.
REM DOSBox will exit when the test harness kills it or autoexec reaches EXIT.

ECHO MCP Test Environment
ECHO Loading MCP.COM...

REM MCP.COM is already loaded by dosbox-test.conf autoexec
REM Just keep DOS alive so the TSR can poll
REM Loop for ~60 seconds (DOSBox will be killed by harness before this)

REM Simple busy-wait using CHOICE (if available) or just loop
:WAIT
REM Check if a sentinel file exists to signal "tests done"
IF EXIST Z:\_MAGIC_\__DONE__ GOTO DONE
REM Pause briefly — CHOICE /T:Y,2 waits 2 seconds on DOS 6+
REM For DOSBox compatibility, just use a tight loop with a counter
GOTO WAIT

:DONE
ECHO Tests complete.
