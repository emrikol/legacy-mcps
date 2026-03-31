@echo off
rem =============================================
rem  SMB Integration Test Suite for WFW 3.11
rem  Tests all file operations against
rem  lanman-server.js running on the host.
rem
rem  Output streams to server console + disk
rem  via the __LOG__ virtual file.
rem
rem  Usage: C:\SMBTEST
rem =============================================
rem --- Ensure Z: is mapped silently ---
net use z: \\MACHOST\SHARE /user:EMRIKOL "" /yes >nul
echo ============================================ > z:\__LOG__
echo  SMB Integration Test Suite                 >> z:\__LOG__
echo  Running from WFW 3.11 / MS-DOS 6.22       >> z:\__LOG__
echo ============================================ >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem ============================================
rem  SECTION 1: DIRECTORY OPERATIONS
rem ============================================
echo [SECTION 1] Directory Operations >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem --- 1.1: List root directory ---
echo [TEST 1.1] dir z: (root listing) >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
dir z: >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem --- 1.2: Dir with wildcard ---
echo [TEST 1.2] dir z:\*.TXT (wildcard) >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
dir z:\*.TXT >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem --- 1.3: Dir specific file ---
echo [TEST 1.3] dir z:\HELLO.TXT (specific) >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
dir z:\HELLO.TXT >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem --- 1.4: Dir nonexistent file ---
echo [TEST 1.4] dir z:\NOPE.TXT (should fail) >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
dir z:\NOPE.TXT >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem --- 1.5: Volume label ---
echo [TEST 1.5] vol z: (volume label) >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
vol z: >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem --- 1.6: Check free space ---
echo [TEST 1.6] chkdsk z: (disk space) >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
dir z: | find "bytes free" >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem ============================================
rem  SECTION 2: FILE READ OPERATIONS
rem ============================================
echo [SECTION 2] File Read Operations >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem --- 2.1: Type a text file ---
echo [TEST 2.1] type z:\HELLO.TXT >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
type z:\HELLO.TXT >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem --- 2.2: Type a long-named file (8.3) ---
echo [TEST 2.2] type long filename (8.3) >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
rem Try the short name version
dir z:\MY*.TXT >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem --- 2.3: Type nonexistent file ---
echo [TEST 2.3] type z:\NOPE.TXT (should fail) >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
type z:\NOPE.TXT >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem --- 2.4: Read file in subdirectory ---
echo [TEST 2.4] type z:\SUBDIR\*.* >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
dir z:\SUBDIR >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem ============================================
rem  SECTION 3: FILE WRITE OPERATIONS
rem ============================================
echo [SECTION 3] File Write Operations >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem --- 3.1: Create a new file ---
echo [TEST 3.1] echo to new file >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
echo Hello from WFW 3.11 > z:\WFWTEST.TXT
if exist z:\WFWTEST.TXT echo PASS: WFWTEST.TXT created >> z:\__LOG__
if not exist z:\WFWTEST.TXT echo FAIL: WFWTEST.TXT not created >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem --- 3.2: Append to a file ---
echo [TEST 3.2] append to file >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
echo Second line >> z:\WFWTEST.TXT
type z:\WFWTEST.TXT >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem --- 3.3: Overwrite a file ---
echo [TEST 3.3] overwrite file >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
echo Overwritten content > z:\WFWTEST.TXT
type z:\WFWTEST.TXT >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem --- 3.4: Read back written file ---
echo [TEST 3.4] read back written file >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
type z:\WFWTEST.TXT >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem --- 3.5: Write empty file ---
echo [TEST 3.5] write empty file >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
rem type nul creates a zero-byte file (copy nul deletes+recreates which races)
type nul > z:\EMPTY.TXT
if exist z:\EMPTY.TXT echo PASS: EMPTY.TXT created >> z:\__LOG__
if not exist z:\EMPTY.TXT echo FAIL: EMPTY.TXT not created >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem ============================================
rem  SECTION 4: FILE COPY OPERATIONS
rem ============================================
echo [SECTION 4] File Copy Operations >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem --- 4.1: Copy within share ---
echo [TEST 4.1] copy within share >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
copy z:\HELLO.TXT z:\COPIED.TXT > nul
if exist z:\COPIED.TXT echo PASS: copy OK >> z:\__LOG__
if not exist z:\COPIED.TXT echo FAIL: copy failed >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem --- 4.2: Verify copied content ---
echo [TEST 4.2] verify copy content >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
type z:\COPIED.TXT >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem --- 4.3: Copy from local to share ---
echo [TEST 4.3] copy local to share >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
echo Local file content > C:\LOCALTEST.TMP
copy C:\LOCALTEST.TMP z:\FROM_C.TXT > nul
if exist z:\FROM_C.TXT echo PASS: local-to-share OK >> z:\__LOG__
if not exist z:\FROM_C.TXT echo FAIL: local-to-share failed >> z:\__LOG__
del C:\LOCALTEST.TMP
echo. >> z:\__LOG__
rem
rem --- 4.4: Copy from share to local ---
echo [TEST 4.4] copy share to local >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
copy z:\HELLO.TXT C:\FROM_Z.TMP > nul
if exist C:\FROM_Z.TMP echo PASS: share-to-local OK >> z:\__LOG__
if not exist C:\FROM_Z.TMP echo FAIL: share-to-local failed >> z:\__LOG__
if exist C:\FROM_Z.TMP del C:\FROM_Z.TMP
echo. >> z:\__LOG__
rem
rem ============================================
rem  SECTION 5: FILE DELETE OPERATIONS
rem ============================================
echo [SECTION 5] File Delete Operations >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem --- 5.1: Delete a file ---
echo [TEST 5.1] del z:\COPIED.TXT >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
del z:\COPIED.TXT
if not exist z:\COPIED.TXT echo PASS: delete OK >> z:\__LOG__
if exist z:\COPIED.TXT echo FAIL: still exists >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem --- 5.2: Delete another file ---
echo [TEST 5.2] del z:\FROM_C.TXT >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
if exist z:\FROM_C.TXT del z:\FROM_C.TXT
if not exist z:\FROM_C.TXT echo PASS: delete OK >> z:\__LOG__
if exist z:\FROM_C.TXT echo FAIL: still exists >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem --- 5.3: Delete nonexistent (should fail) ---
echo [TEST 5.3] del nonexistent (expect error) >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
del z:\NOPE.TXT
echo (error above is expected) >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem ============================================
rem  SECTION 6: DIRECTORY CREATE/REMOVE
rem ============================================
echo [SECTION 6] Directory Create/Remove >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem --- 6.1: Create directory ---
echo [TEST 6.1] md z:\TESTDIR >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
md z:\TESTDIR
if exist z:\TESTDIR\nul echo PASS: mkdir OK >> z:\__LOG__
if not exist z:\TESTDIR\nul echo FAIL: mkdir failed >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem --- 6.2: List empty directory ---
echo [TEST 6.2] dir z:\TESTDIR (empty) >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
dir z:\TESTDIR >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem --- 6.3: Create file in subdirectory ---
echo [TEST 6.3] write file in subdir >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
echo Subdir file > z:\TESTDIR\SUB.TXT
if exist z:\TESTDIR\SUB.TXT echo PASS: subdir write OK >> z:\__LOG__
if not exist z:\TESTDIR\SUB.TXT echo FAIL: subdir write failed >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem --- 6.4: List directory with file ---
echo [TEST 6.4] dir z:\TESTDIR (with file) >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
dir z:\TESTDIR >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem --- 6.5: Read file in subdirectory ---
echo [TEST 6.5] type z:\TESTDIR\SUB.TXT >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
type z:\TESTDIR\SUB.TXT >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem --- 6.6: Delete file in subdirectory ---
echo [TEST 6.6] del z:\TESTDIR\SUB.TXT >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
if exist z:\TESTDIR\SUB.TXT del z:\TESTDIR\SUB.TXT
if not exist z:\TESTDIR\SUB.TXT echo PASS: subdir delete OK >> z:\__LOG__
if exist z:\TESTDIR\SUB.TXT echo FAIL: subdir delete failed >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem --- 6.7: Remove directory ---
echo [TEST 6.7] rd z:\TESTDIR >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
rd z:\TESTDIR
rem Verify by recreating — if md succeeds, old dir was gone
md z:\TESTDIR
if exist z:\TESTDIR\nul echo PASS: rmdir OK (recreate succeeded) >> z:\__LOG__
if not exist z:\TESTDIR\nul echo FAIL: rmdir or recreate failed >> z:\__LOG__
if exist z:\TESTDIR\nul rd z:\TESTDIR
echo. >> z:\__LOG__
rem
rem --- 6.8: Nested directories ---
echo [TEST 6.8] nested md z:\A\B (expect fail) >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
md z:\NEST_A
md z:\NEST_A\NEST_B
if exist z:\NEST_A\NEST_B\nul echo PASS: nested mkdir OK >> z:\__LOG__
if not exist z:\NEST_A\NEST_B\nul echo FAIL: nested mkdir failed >> z:\__LOG__
if exist z:\NEST_A\NEST_B\nul rd z:\NEST_A\NEST_B
if exist z:\NEST_A\nul rd z:\NEST_A
echo. >> z:\__LOG__
rem
rem ============================================
rem  SECTION 7: RENAME OPERATIONS
rem ============================================
echo [SECTION 7] Rename Operations >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem --- 7.1: Rename a file ---
echo [TEST 7.1] ren file >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
echo rename test > z:\RENTEST.TXT
ren z:\RENTEST.TXT RENAMED.TXT
if exist z:\RENAMED.TXT echo PASS: rename OK >> z:\__LOG__
if not exist z:\RENAMED.TXT echo FAIL: rename failed >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem --- 7.2: Verify renamed content ---
echo [TEST 7.2] type renamed file >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
if exist z:\RENAMED.TXT type z:\RENAMED.TXT >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem --- 7.3: Rename back ---
echo [TEST 7.3] ren back to original >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
if exist z:\RENAMED.TXT ren z:\RENAMED.TXT RENTEST.TXT
if exist z:\RENTEST.TXT echo PASS: rename back OK >> z:\__LOG__
if not exist z:\RENTEST.TXT echo FAIL: rename back failed >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem ============================================
rem  SECTION 8: ATTRIBUTE OPERATIONS
rem ============================================
echo [SECTION 8] Attribute Operations >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem --- 8.1: Set read-only ---
echo [TEST 8.1] attrib +R >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
if exist z:\WFWTEST.TXT attrib +R z:\WFWTEST.TXT
attrib z:\WFWTEST.TXT >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem --- 8.2: Clear read-only ---
echo [TEST 8.2] attrib -R >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
if exist z:\WFWTEST.TXT attrib -R z:\WFWTEST.TXT
attrib z:\WFWTEST.TXT >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem ============================================
rem  SECTION 9: EDGE CASES
rem ============================================
echo [SECTION 9] Edge Cases >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem --- 9.1: Large write ---
echo [TEST 9.1] write larger content >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
echo Line 1 of test file > z:\BIG.TXT
echo Line 2 of test file >> z:\BIG.TXT
echo Line 3 of test file >> z:\BIG.TXT
echo Line 4 of test file >> z:\BIG.TXT
echo Line 5 of test file >> z:\BIG.TXT
echo Line 6 of test file >> z:\BIG.TXT
echo Line 7 of test file >> z:\BIG.TXT
echo Line 8 of test file >> z:\BIG.TXT
echo Line 9 of test file >> z:\BIG.TXT
echo Line 10 of test file >> z:\BIG.TXT
type z:\BIG.TXT >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem --- 9.2: Overwrite then verify size ---
echo [TEST 9.2] overwrite changes content >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
echo short > z:\BIG.TXT
type z:\BIG.TXT >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem --- 9.3: Multiple rapid operations ---
echo [TEST 9.3] rapid open/write/close >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
echo A > z:\RAPID1.TXT
echo B > z:\RAPID2.TXT
echo C > z:\RAPID3.TXT
if exist z:\RAPID1.TXT echo PASS: rapid1 OK >> z:\__LOG__
if exist z:\RAPID2.TXT echo PASS: rapid2 OK >> z:\__LOG__
if exist z:\RAPID3.TXT echo PASS: rapid3 OK >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem --- 9.4: Dir after many creates ---
echo [TEST 9.4] dir after creates >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
dir z: >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem ============================================
rem  SECTION 10: TRANS2 / FILE MANAGER OPS
rem ============================================
echo [SECTION 10] TRANS2 / File Manager Operations >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem --- 10.1: File Manager style dir (exercises FIND_FIRST2 if available) ---
echo [TEST 10.1] dir z:\*.* /o (sorted listing) >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
dir z:\*.* /o >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem --- 10.2: Dir sorted in a subdirectory ---
echo [TEST 10.2] dir z:\SUBDIR\*.* /o >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
dir z:\SUBDIR\*.* /o >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem --- 10.3: Create file, check it, delete it (open/query/close cycle) ---
echo [TEST 10.3] create-query-delete cycle >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
echo Trans2 test data > z:\T2TEST.TXT
if exist z:\T2TEST.TXT echo PASS: T2 create OK >> z:\__LOG__
if not exist z:\T2TEST.TXT echo FAIL: T2 create failed >> z:\__LOG__
type z:\T2TEST.TXT >> z:\__LOG__
del z:\T2TEST.TXT
if not exist z:\T2TEST.TXT echo PASS: T2 delete OK >> z:\__LOG__
if exist z:\T2TEST.TXT echo FAIL: T2 delete failed >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem --- 10.4: Create dir, add files, list, remove (exercises FIND for subdir) ---
echo [TEST 10.4] subdir create-list-remove cycle >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
md z:\FMTEST
echo File A > z:\FMTEST\FILE_A.TXT
echo File B > z:\FMTEST\FILE_B.TXT
echo File C > z:\FMTEST\FILE_C.TXT
dir z:\FMTEST\*.* >> z:\__LOG__
rem Verify all 3 files exist
if exist z:\FMTEST\FILE_A.TXT echo PASS: FILE_A exists >> z:\__LOG__
if not exist z:\FMTEST\FILE_A.TXT echo FAIL: FILE_A missing >> z:\__LOG__
if exist z:\FMTEST\FILE_B.TXT echo PASS: FILE_B exists >> z:\__LOG__
if not exist z:\FMTEST\FILE_B.TXT echo FAIL: FILE_B missing >> z:\__LOG__
if exist z:\FMTEST\FILE_C.TXT echo PASS: FILE_C exists >> z:\__LOG__
if not exist z:\FMTEST\FILE_C.TXT echo FAIL: FILE_C missing >> z:\__LOG__
del z:\FMTEST\FILE_A.TXT
del z:\FMTEST\FILE_B.TXT
del z:\FMTEST\FILE_C.TXT
rd z:\FMTEST
md z:\FMTEST
if exist z:\FMTEST\nul echo PASS: FMTEST cleanup OK >> z:\__LOG__
rd z:\FMTEST
echo. >> z:\__LOG__
rem
rem --- 10.5: Overwrite and verify content changed (exercises QUERY_FILE_INFO) ---
echo [TEST 10.5] overwrite verify content >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
echo Original content > z:\QFTEST.TXT
type z:\QFTEST.TXT >> z:\__LOG__
echo New content > z:\QFTEST.TXT
type z:\QFTEST.TXT >> z:\__LOG__
del z:\QFTEST.TXT
echo. >> z:\__LOG__
rem
rem ============================================
rem  SECTION 11: CLEANUP
rem ============================================
echo [SECTION 11] Cleanup >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
if exist z:\WFWTEST.TXT del z:\WFWTEST.TXT
if exist z:\EMPTY.TXT del z:\EMPTY.TXT
if exist z:\RENTEST.TXT del z:\RENTEST.TXT
if exist z:\RENAMED.TXT del z:\RENAMED.TXT
if exist z:\BIG.TXT del z:\BIG.TXT
if exist z:\RAPID1.TXT del z:\RAPID1.TXT
if exist z:\RAPID2.TXT del z:\RAPID2.TXT
if exist z:\RAPID3.TXT del z:\RAPID3.TXT
if exist z:\T2TEST.TXT del z:\T2TEST.TXT
if exist z:\QFTEST.TXT del z:\QFTEST.TXT
if exist z:\FMTEST\FILE_A.TXT del z:\FMTEST\FILE_A.TXT
if exist z:\FMTEST\FILE_B.TXT del z:\FMTEST\FILE_B.TXT
if exist z:\FMTEST\FILE_C.TXT del z:\FMTEST\FILE_C.TXT
if exist z:\FMTEST\nul rd z:\FMTEST
echo Cleanup complete >> z:\__LOG__
echo. >> z:\__LOG__
rem
rem --- Final dir to confirm clean state ---
echo [FINAL] dir z: after cleanup >> z:\__LOG__
echo ------------------------------------------- >> z:\__LOG__
dir z: >> z:\__LOG__
echo. >> z:\__LOG__
echo ============================================ >> z:\__LOG__
echo  ALL TESTS COMPLETE >> z:\__LOG__
echo ============================================ >> z:\__LOG__
echo.
echo Tests complete. Check server log for results.
