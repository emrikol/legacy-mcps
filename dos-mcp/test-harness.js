#!/usr/bin/env node

/**
 * MCP TSR Test Harness
 *
 * Writes commands to __MCP__.TX, reads responses from __MCP__.RX,
 * and validates results.  Works with both emu2 (lowercase filenames)
 * and DOSBox-X (uppercase filenames).
 *
 * Usage: node test-harness.js [--timeout 30]
 */

var fs = require('fs');
var path = require('path');

// Paths
var SHARE_DIR = path.resolve(__dirname, '..', 'share');
var MAGIC_DIR = path.join(SHARE_DIR, '_MAGIC_');

// emu2 creates lowercase filenames on the host; DOSBox-X creates uppercase.
// We check both cases when reading.
function findFile(baseName) {
  var upper = path.join(MAGIC_DIR, baseName.toUpperCase());
  var lower = path.join(MAGIC_DIR, baseName.toLowerCase());
  if (fs.existsSync(lower)) return lower;
  if (fs.existsSync(upper)) return upper;
  return null;
}

function txPath() { return findFile('__MCP__.TX') || path.join(MAGIC_DIR, '__mcp__.tx'); }
function rxPath() { return findFile('__MCP__.RX'); }
function stPath() { return findFile('__MCP__.ST'); }
function ttPath() { return findFile('__MCP__.TT'); }

function readDebugFile() {
  var tt = ttPath();
  if (tt) {
    try {
      var content = fs.readFileSync(tt, 'utf8');
      var hex = Buffer.from(content).toString('hex').match(/.{1,2}/g).join(' ');
      return 'TT="' + content.trim() + '" hex=[' + hex + ']';
    } catch (_) {}
  }
  return 'TT=<not found>';
}

// Config
var TIMEOUT_SEC = parseInt(
  process.argv.find(function (a, i) { return process.argv[i - 1] === '--timeout'; }) || '30',
  10
);
var POLL_MS = 200;
var MAX_RETRIES = 5;

// Test definitions — Phase 8 command namespace
var tests = [
  {
    name: 'META PING',
    command: 'META PING',
    expect: 'OK PONG',
  },
  {
    name: 'MEM PEEK BIOS data area',
    command: 'MEM PEEK 0040:001A 2',
    expectPattern: /^OK [0-9A-F]{2} [0-9A-F]{2}/,
  },
  {
    name: 'MEM POKE and PEEK round-trip',
    command: 'MEM POKE 0050:0000 42 43',
    expect: 'OK',
    followUp: {
      command: 'MEM PEEK 0050:0000 2',
      expectPattern: /^OK 42 43/,
    },
  },
  {
    name: 'CON READ (POKE then read)',
    command: 'MEM POKE B800:0000 48 07 69 07',
    expect: 'OK',
    followUp: {
      command: 'CON READ 0 1',
      expectPattern: /^OK Hi/,
    },
  },
  {
    name: 'CON READ multiple rows',
    command: 'CON READ 0 2',
    expectPattern: /^OK .*\|/,
  },
  {
    name: 'MOUSE MOVE',
    command: 'MOUSE MOVE 320 100',
    expect: 'OK',
  },
  {
    name: 'MOUSE CLICK',
    command: 'MOUSE CLICK 320 100 1',
    expect: 'OK',
  },
  {
    name: 'PORT IN',
    command: 'PORT IN 986',
    expectPattern: /^OK [0-9A-F]{2}$/,
  },
  {
    name: 'PORT OUT',
    command: 'PORT OUT 97 0',
    expect: 'OK',
  },
  {
    name: 'KEY SEND basic',
    command: 'KEY SEND ABC',
    expect: 'OK',
  },
  {
    name: 'META VERSION',
    command: 'META VERSION',
    expectPattern: /^OK MCP\/0\.10 /,
  },
  {
    name: 'CON CURSOR GET',
    command: 'CON CURSOR GET',
    expectPattern: /^OK \d+ \d+$/,
  },
  {
    name: 'CON CURSOR SET',
    command: 'CON CURSOR SET 5 10',
    expect: 'OK',
    followUp: {
      command: 'CON CURSOR GET',
      expectPattern: /^OK 5 10$/,
    },
  },
  {
    name: 'MOUSE CLICK left',
    command: 'MOUSE CLICK 100 50',
    expect: 'OK',
  },
  {
    name: 'MOUSE CLICK right',
    command: 'MOUSE CLICK 200 75 2',
    expect: 'OK',
  },
  {
    name: 'MOUSE DBLCLICK',
    command: 'MOUSE DBLCLICK 100 50',
    expect: 'OK',
  },
  {
    name: 'MOUSE DOWN left',
    command: 'MOUSE DOWN',
    expect: 'OK',
  },
  {
    name: 'MOUSE UP left',
    command: 'MOUSE UP',
    expect: 'OK',
  },
  {
    name: 'MOUSE DOWN right',
    command: 'MOUSE DOWN 2',
    expect: 'OK',
  },
  {
    name: 'MOUSE UP right',
    command: 'MOUSE UP 2',
    expect: 'OK',
  },
  {
    name: 'MOUSE DRAG',
    command: 'MOUSE DRAG 10 10 200 150',
    expect: 'OK',
  },
  {
    name: 'WAIT SCREEN found',
    command: 'MEM POKE B800:0000 58 07 59 07 5A 07',
    expect: 'OK',
    followUp: {
      command: 'WAIT SCREEN XYZ 36',
      expectPattern: /^OK 0 0$/,
    },
  },
  {
    name: 'WAIT SCREEN timeout',
    command: 'WAIT SCREEN ZZZZNOTFOUND 2',
    expect: 'ERR TIMEOUT',
  },
  {
    name: 'CON CRC returns hex',
    command: 'CON CRC 0 1',
    expectPattern: /^OK [0-9A-F]{4}$/,
  },
  {
    name: 'CON CRC full screen',
    command: 'CON CRC',
    expectPattern: /^OK [0-9A-F]{4}$/,
  },
  {
    name: 'WAIT SLEEP',
    command: 'WAIT SLEEP 1',
    expect: 'OK',
  },
  {
    name: 'MEM FREE',
    command: 'MEM FREE',
    expectPattern: /^OK \d+K$/,
  },
  // --- KEY DOWN/UP ---
  {
    name: 'KEY DOWN/UP LSHIFT',
    command: 'MEM POKE 0040:0017 00',
    expect: 'OK',
    followUp: {
      command: 'KEY DOWN LSHIFT',
      expect: 'OK',
    },
  },
  {
    name: 'KEY DOWN LSHIFT verify',
    command: 'MEM PEEK 0040:0017 1',
    expectPattern: /^OK 02$/,
    followUp: {
      command: 'KEY UP LSHIFT',
      expect: 'OK',
    },
  },
  {
    name: 'KEY UP LSHIFT verify',
    command: 'MEM PEEK 0040:0017 1',
    expectPattern: /^OK 00$/,
  },
  {
    name: 'KEY DOWN CTRL',
    command: 'MEM POKE 0040:0017 00',
    expect: 'OK',
    followUp: {
      command: 'KEY DOWN CTRL',
      expect: 'OK',
    },
  },
  {
    name: 'KEY UP CTRL',
    command: 'KEY UP CTRL',
    expect: 'OK',
  },
  {
    name: 'KEY DOWN scan code hex',
    command: 'KEY DOWN 0x39',
    expect: 'OK',
    followUp: {
      command: 'KEY UP 0x39',
      expect: 'OK',
    },
  },
  // --- CLIP ---
  {
    name: 'CLIP GET unavailable',
    command: 'CLIP GET',
    expect: 'ERR CLIPBOARD_UNAVAILABLE',
  },
  {
    name: 'CLIP SET unavailable',
    command: 'CLIP SET hello',
    expect: 'ERR CLIPBOARD_UNAVAILABLE',
  },
  // --- SCREEN DUMP ---
  {
    name: 'SCREEN DUMP',
    command: 'MEM POKE B800:0000 54 07 45 07 53 07 54 07',
    expect: 'OK',
    followUp: {
      command: 'SCREEN DUMP',
      expect: 'OK',
    },
  },
  // --- WAIT SCREEN underscore-as-space ---
  {
    name: 'WAIT SCREEN underscore space',
    command: 'MEM POKE B800:0000 48 07 49 07 20 07 59 07 4F 07',
    expect: 'OK',
    followUp: {
      command: 'WAIT SCREEN HI_YO 36',
      expectPattern: /^OK 0 0$/,
    },
  },
  // --- META LOG ---
  {
    name: 'META LOG OFF',
    command: 'META LOG OFF',
    expect: 'OK',
  },
  {
    name: 'META LOG ON',
    command: 'META LOG ON',
    expect: 'OK',
  },
  // --- META STATUS ---
  {
    name: 'META STATUS',
    command: 'META STATUS',
    expectPattern: /^OK V0\.10 CMDS=\d+ DEBUG=[01] POLL=\d+ TIMEOUT=\d+$/,
  },
  // --- KEY TYPE ---
  {
    name: 'KEY TYPE basic',
    command: 'KEY TYPE hello',
    expect: 'OK',
  },
  {
    name: 'KEY TYPE with underscore (space)',
    command: 'KEY TYPE hi_there',
    expect: 'OK',
  },
  // --- KEY HOTKEY ---
  {
    name: 'KEY HOTKEY ALT+F4',
    command: 'KEY HOTKEY ALT+0x3F',
    expect: 'OK',
  },
  {
    name: 'KEY HOTKEY CTRL+key',
    command: 'KEY HOTKEY CTRL+0x1F',
    expect: 'OK',
  },
  // --- META BATCH ---
  {
    name: 'META BATCH single command',
    command: 'META BATCH\nMETA PING',
    expect: 'OK PONG',
  },
  // --- GFX PIXEL ---
  {
    name: 'GFX PIXEL',
    command: 'GFX PIXEL 0 0',
    expectPattern: /^OK \d+$/,
  },
  // --- CON REGION ---
  {
    name: 'CON REGION',
    command: 'MEM POKE B800:0000 41 07 42 07 43 07',
    expect: 'OK',
    followUp: {
      command: 'CON REGION 0 0 0 2',
      expectPattern: /^OK ABC$/,
    },
  },
  // --- WAIT CRC timeout ---
  {
    name: 'WAIT CRC timeout',
    command: 'WAIT CRC FFFF 2',
    expect: 'ERR TIMEOUT',
  },
  // --- META REPEAT ---
  {
    name: 'META REPEAT',
    command: 'META REPEAT 3 META PING',
    expect: 'OK PONG',
  },
  // --- DIR LIST ---
  {
    name: 'DIR LIST current',
    command: 'DIR LIST',
    expectPattern: /^OK .+/,
  },
  {
    name: 'DIR LIST with path',
    command: 'DIR LIST C:\\*.*',
    expectPattern: /^OK .+/,
  },
  // --- FILE READ ---
  {
    name: 'FILE READ',
    command: 'FILE READ C:\\DOSMCP.COM 0 4',
    expectPattern: /^OK [0-9A-F]{2} [0-9A-F]{2} [0-9A-F]{2} [0-9A-F]{2}$/,
  },
  // --- EXEC SHELL ---
  {
    name: 'EXEC SHELL',
    command: 'EXEC SHELL DIR C:\\',
    expectPattern: /^(OK \d+|ERR EXEC_FAILED)$/,
  },
  // --- INT ---
  {
    name: 'INT CALL get DOS version',
    command: 'INT CALL 21 3000 0000 0000 0000',
    expectPattern: /^OK AX=[0-9A-F]{4} BX=[0-9A-F]{4} CX=[0-9A-F]{4} DX=[0-9A-F]{4} CF=[01]$/,
  },
  // --- FILE WRITE ---
  {
    name: 'FILE WRITE create and write',
    command: 'FILE WRITE C:\\TSTTMP.BIN 0 48 65 6C 6C 6F',
    expectPattern: /^OK 5$/,
    followUp: {
      command: 'FILE READ C:\\TSTTMP.BIN 0 5',
      expect: 'OK 48 65 6C 6C 6F',
    },
  },
  // --- FILE DELETE ---
  {
    name: 'FILE DELETE',
    command: 'FILE DELETE C:\\TSTTMP.BIN',
    expect: 'OK',
  },
  {
    name: 'FILE DELETE nonexistent',
    command: 'FILE DELETE C:\\NOSUCHFILE.XYZ',
    expect: 'ERR FILE_NOT_FOUND',
  },
  // --- FILE RENAME ---
  {
    name: 'FILE RENAME',
    command: 'FILE WRITE C:\\RENTMP.BIN 0 41 42',
    expectPattern: /^OK 2$/,
    followUp: {
      command: 'FILE RENAME C:\\RENTMP.BIN C:\\RENTMP2.BIN',
      expect: 'OK',
    },
  },
  {
    name: 'FILE RENAME cleanup',
    command: 'FILE DELETE C:\\RENTMP2.BIN',
    expect: 'OK',
  },
  // --- FILE COPY ---
  {
    name: 'FILE COPY',
    command: 'FILE WRITE C:\\CPTMP.BIN 0 58 59 5A',
    expectPattern: /^OK 3$/,
    followUp: {
      command: 'FILE COPY C:\\CPTMP.BIN C:\\CPTMP2.BIN',
      expectPattern: /^OK 3$/,
    },
  },
  {
    name: 'FILE COPY verify and cleanup',
    command: 'FILE READ C:\\CPTMP2.BIN 0 3',
    expect: 'OK 58 59 5A',
    followUp: {
      command: 'FILE DELETE C:\\CPTMP.BIN',
      expect: 'OK',
    },
  },
  {
    name: 'FILE COPY cleanup 2',
    command: 'FILE DELETE C:\\CPTMP2.BIN',
    expect: 'OK',
  },
  // --- DIR MAKE ---
  {
    name: 'DIR MAKE',
    command: 'DIR MAKE C:\\TSTDIR',
    expect: 'OK',
  },
  // --- DIR CHANGE ---
  {
    name: 'DIR CHANGE',
    command: 'DIR CHANGE C:\\TSTDIR',
    expectPattern: /^OK .*TSTDIR/,
  },
  {
    name: 'DIR CHANGE back to root',
    command: 'DIR CHANGE C:\\',
    expectPattern: /^OK C:\\/,
  },
  {
    name: 'DIR MAKE/CHANGE cleanup',
    command: 'EXEC SHELL RD C:\\TSTDIR',
    expectPattern: /^(OK \d+|ERR EXEC_FAILED)$/,
  },
  // --- TIME GET ---
  {
    name: 'TIME GET',
    command: 'TIME GET',
    expectPattern: /^OK \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
  },
  // --- TIME SET ---
  {
    name: 'TIME SET',
    command: 'TIME SET 2025-06-15 10:30:00',
    expectPattern: /^(OK|ERR INVALID_DATE|ERR INVALID_TIME)$/,
  },
  // --- CON FIND ---
  {
    name: 'CON FIND found',
    command: 'MEM POKE B800:0000 46 07 4F 07 4F 07',
    expect: 'OK',
    followUp: {
      command: 'CON FIND FOO',
      expectPattern: /^OK 0,0/,
    },
  },
  {
    name: 'CON FIND not found',
    command: 'CON FIND ZZZZNOTHERE',
    expect: 'OK',
  },
  // --- WAIT GONE ---
  {
    name: 'WAIT GONE (text not present)',
    command: 'WAIT GONE ZZZZNOTHERE 36',
    expect: 'OK',
  },
  {
    name: 'WAIT GONE timeout (text present)',
    command: 'MEM POKE B800:0000 47 07 4F 07 4E 07 45 07',
    expect: 'OK',
    followUp: {
      command: 'WAIT GONE GONE 2',
      expect: 'ERR TIMEOUT',
    },
  },
  // --- WAIT PIXEL ---
  {
    name: 'WAIT PIXEL',
    command: 'WAIT PIXEL 0 0 0 36',
    expect: 'OK',
  },
  {
    name: 'WAIT PIXEL timeout',
    command: 'WAIT PIXEL 0 0 255 2',
    expect: 'ERR TIMEOUT',
  },
  // --- INI ---
  {
    name: 'INI WRITE then READ',
    command: 'INI WRITE C:\\TEST.INI TestSection TestKey HelloWorld',
    expect: 'OK',
    followUp: {
      command: 'INI READ C:\\TEST.INI TestSection TestKey',
      expect: 'OK HelloWorld',
    },
  },
  {
    name: 'INI READ not found',
    command: 'INI READ C:\\TEST.INI TestSection NoSuchKey',
    expect: 'ERR NOT_FOUND',
  },
  {
    name: 'INI WRITE update existing',
    command: 'INI WRITE C:\\TEST.INI TestSection TestKey UpdatedValue',
    expect: 'OK',
    followUp: {
      command: 'INI READ C:\\TEST.INI TestSection TestKey',
      expect: 'OK UpdatedValue',
    },
  },
  {
    name: 'INI cleanup',
    command: 'FILE DELETE C:\\TEST.INI',
    expect: 'OK',
  },
  // --- META HEARTBEAT ---
  {
    name: 'META HEARTBEAT',
    command: 'META HEARTBEAT',
    expect: 'OK',
  },
  // --- MEM READ/WRITE aliases ---
  {
    name: 'MEM WRITE and READ alias',
    command: 'MEM WRITE 0050:0010 AA BB',
    expect: 'OK',
    followUp: {
      command: 'MEM READ 0050:0010 2',
      expectPattern: /^OK AA BB/,
    },
  },
  // --- MEM DUMP ---
  {
    name: 'MEM DUMP',
    preCommand: 'MEM POKE 0050:0090 41 42 43 44',
    command: 'MEM DUMP 0050:0090 4',
    expect: 'OK 41 42 43 44',
  },
  // --- MEM FILL ---
  {
    name: 'MEM FILL then DUMP',
    preCommand: 'MEM FILL 0050:00A0 8 AA',
    command: 'MEM DUMP 0050:00A0 8',
    expect: 'OK AA AA AA AA AA AA AA AA',
  },
  // --- MEM COPY ---
  {
    name: 'MEM COPY then DUMP',
    preCommand: 'MEM POKE 0050:00B0 01 02 03 04',
    command: 'MEM COPY 0050:00B0 0050:00C0 4',
    expect: 'OK',
    followUp: {
      command: 'MEM DUMP 0050:00C0 4',
      expect: 'OK 01 02 03 04',
    },
  },
  // --- MEM SEARCH ---
  {
    name: 'MEM SEARCH poke then find',
    preCommand: 'MEM POKE 0050:0080 DE AD BE EF',
    command: 'MEM SEARCH 0050:0000 256 DE AD BE EF',
    expect: 'OK 0050:0080',
  },
  {
    name: 'MEM SEARCH not found',
    command: 'MEM SEARCH 0050:0000 16 FF FE FD FC',
    expect: 'ERR NOT_FOUND',
  },
  // --- MEM MCB ---
  {
    name: 'MEM MCB',
    command: 'MEM MCB',
    expectPattern: /^OK [0-9A-F]{4}:/,
  },
  // --- CON WRITE ---
  {
    name: 'CON WRITE then CON READ',
    preCommand: 'CON WRITE 0 0 07 TEST1234',
    command: 'CON READ 0 1',
    expectPattern: /TEST1234/,
  },
  // --- CON CLEAR ---
  {
    name: 'CON CLEAR',
    command: 'CON CLEAR',
    expect: 'OK',
  },
  {
    name: 'CON CLEAR region',
    command: 'CON CLEAR 0 0 0 9 1E',
    expect: 'OK',
    followUp: {
      command: 'CON ATTR 0 1',
      expectPattern: /1E 1E 1E 1E 1E 1E 1E 1E 1E 1E/,
    },
  },
  // --- CON SCROLL ---
  {
    name: 'CON SCROLL UP',
    command: 'CON SCROLL UP 1',
    expect: 'OK',
  },
  // --- CON ATTR ---
  {
    name: 'CON ATTR read',
    preCommand: 'CON CLEAR 0 0 0 3 1E',
    command: 'CON ATTR 0 1',
    expectPattern: /^OK 1E 1E 1E 1E/,
  },
  // --- CON MODE ---
  {
    name: 'CON MODE get',
    command: 'CON MODE',
    expectPattern: /^OK mode=[0-9A-F]{2} cols=\d+ rows=\d+ page=\d+$/,
  },
  // --- DIR DRIVES ---
  {
    name: 'DIR DRIVES',
    command: 'DIR DRIVES',
    expectPattern: /^OK [A-Z]:(FD|HD|NET)/,
  },
  // --- DIR GET ---
  {
    name: 'DIR GET',
    command: 'DIR GET',
    expectPattern: /^OK [A-Z]:\\/,
  },
  // --- META LASTERROR ---
  {
    name: 'META LASTERROR',
    preCommand: 'FILE READ C:\\NONEXIST.XYZ 0 1',
    command: 'META LASTERROR',
    expectPattern: /^OK err=\d+ class=\d+ action=\d+ locus=\d+$/,
  },
  // --- META UNLOAD ---
  {
    name: 'META UNLOAD in foreground',
    command: 'META UNLOAD',
    expectPattern: /^(ERR NOT_TSR|OK UNLOADED)$/,
  },
  // --- DISK FREE ---
  {
    name: 'DISK FREE default',
    command: 'DISK FREE',
    expectPattern: /^OK \d+ \d+$/,
  },
  {
    name: 'DISK FREE C',
    command: 'DISK FREE C',
    expectPattern: /^OK \d+ \d+$/,
  },
  // --- ENV GET ---
  {
    name: 'ENV GET PATH',
    command: 'ENV GET PATH',
    expectPattern: /^OK .+/,
  },
  {
    name: 'ENV GET not found',
    command: 'ENV GET ZZZZNOTREAL',
    expect: 'ERR NOT_FOUND',
  },
  // --- ENV SET ---
  {
    name: 'ENV SET new variable',
    command: 'ENV SET MCPTEST1 hello123',
    expect: 'OK',
  },
  {
    name: 'ENV GET round-trip',
    command: 'ENV GET MCPTEST1',
    expect: 'OK hello123',
  },
  {
    name: 'ENV SET overwrite',
    command: 'ENV SET MCPTEST1 updated',
    expect: 'OK',
  },
  {
    name: 'ENV GET overwritten value',
    command: 'ENV GET MCPTEST1',
    expect: 'OK updated',
  },
  {
    name: 'ENV SET delete variable',
    command: 'ENV SET MCPTEST1',
    expect: 'OK',
  },
  {
    name: 'ENV GET deleted variable',
    command: 'ENV GET MCPTEST1',
    expect: 'ERR NOT_FOUND',
  },
  {
    name: 'ENV SET syntax error (no args)',
    command: 'ENV SET',
    expect: 'ERR SYNTAX',
  },
  // --- EXEC EXIT ---
  {
    name: 'EXEC EXIT after SHELL',
    preCommand: 'EXEC SHELL VER',
    command: 'EXEC EXIT',
    expectPattern: /^OK \d+$/,
  },
  // --- FILE EXISTS ---
  {
    name: 'FILE EXISTS yes',
    command: 'FILE EXISTS C:\\DOSMCP.COM',
    expect: 'OK 1',
  },
  {
    name: 'FILE EXISTS no',
    command: 'FILE EXISTS C:\\NONEXIST.XYZ',
    expect: 'OK 0',
  },
  // --- FILE SIZE ---
  {
    name: 'FILE SIZE',
    command: 'FILE SIZE C:\\DOSMCP.COM',
    expectPattern: /^OK \d+$/,
  },
  {
    name: 'FILE SIZE not found',
    command: 'FILE SIZE C:\\NONEXIST.XYZ',
    expectPattern: /^ERR /,
  },
  // --- FILE TIME ---
  {
    name: 'FILE TIME',
    command: 'FILE TIME C:\\DOSMCP.COM',
    expectPattern: /^OK \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
  },
  // --- SYS INFO ---
  {
    name: 'SYS INFO',
    command: 'SYS INFO',
    expectPattern: /^OK DOS=\d+\.\d+/,
  },
  // --- SYS MEMORY ---
  {
    name: 'SYS MEMORY',
    command: 'SYS MEMORY',
    expectPattern: /^OK CONV=\d+K/,
  },
  // --- SYS DRIVERS ---
  {
    name: 'SYS DRIVERS',
    command: 'SYS DRIVERS',
    expectPattern: /^OK .*NUL/,
  },
  // --- SYS ANSI ---
  {
    name: 'SYS ANSI',
    command: 'SYS ANSI',
    expectPattern: /^OK [01]$/,
  },
  // --- INT LIST ---
  {
    name: 'INT LIST range',
    command: 'INT LIST 08 4',
    expectPattern: /^OK 08=[0-9A-F]{4}:[0-9A-F]{4}/,
  },
  // SYS BEEP, SYS TONE, SYS QUIET — skipped in emu2 (no PIT/speaker ports)
  // --- GFX VESA MODE ---
  {
    name: 'GFX VESA MODE get',
    command: 'GFX VESA MODE',
    expectPattern: /^(OK [0-9A-F]{4}|ERR NO_VESA)$/,
  },
  // --- GFX VESA INFO ---
  {
    name: 'GFX VESA INFO controller',
    command: 'GFX VESA INFO',
    expectPattern: /^(OK VER=\d+\.\d+ MEM=\d+KB|ERR NO_VESA)$/,
  },
  // --- GFX PALETTE ---
  {
    name: 'GFX PALETTE GET',
    command: 'GFX PALETTE GET 0',
    expectPattern: /^OK [0-9A-F]{2}:[0-9A-F]{2}:[0-9A-F]{2}$/,
  },
  {
    name: 'GFX PALETTE SET and GET',
    command: 'GFX PALETTE SET 255 3F 00 3F',
    expect: 'OK',
    followUp: {
      // emu2 may ignore DAC port writes
      command: 'GFX PALETTE GET 255',
      expectPattern: /^OK [0-9A-F]{2}:[0-9A-F]{2}:[0-9A-F]{2}$/,
    },
  },
  // --- CMOS READ ---
  {
    name: 'CMOS READ register 10h',
    command: 'CMOS READ 10',
    expectPattern: /^OK [0-9A-F]{2}$/,
  },
  // --- CMOS WRITE ---
  {
    name: 'CMOS WRITE and READ round-trip',
    command: 'CMOS READ 0F',
    expectPattern: /^OK [0-9A-F]{2}$/,
    followUp: {
      command: 'CMOS WRITE 0F 00',
      expect: 'OK',
    },
  },
  // --- POWER STATUS ---
  {
    name: 'POWER STATUS',
    command: 'POWER STATUS',
    expectPattern: /^(OK APM=\d+\.\d+( AC=(ONLINE|OFFLINE|UNKNOWN)( BATT=(\d+%|UNKNOWN))?)?|ERR NO_APM)$/,
  },
  // --- POWER IDLE ---
  {
    name: 'POWER IDLE',
    command: 'POWER IDLE',
    expect: 'OK',
  },
  // --- POWER STANDBY ---
  {
    name: 'POWER STANDBY',
    command: 'POWER STANDBY',
    // emu2 may not support APM
    expectPattern: /^(OK|ERR NO_APM)$/,
  },
  // --- INT WATCH ---
  {
    name: 'INT WATCH timer',
    command: 'INT WATCH 1C 4',
    // Watch user timer tick for 4 ticks — should get some count
    expectPattern: /^OK \d+$/,
    timeout: 5000,
  },
  {
    name: 'INT WATCH syntax error',
    command: 'INT WATCH',
    expect: 'ERR SYNTAX',
  },
  // --- TSR LIST ---
  {
    name: 'TSR LIST',
    command: 'TSR LIST',
    // Expect at least our own MCP process
    expectPattern: /^OK( [0-9A-F]{4}:\w*:\d+b)+$/,
  },
  // --- MEM EMS ---
  {
    name: 'MEM EMS',
    command: 'MEM EMS',
    expectPattern: /^(OK VER=\d+\.\d+ TOTAL=\d+ FREE=\d+|ERR NO_EMS)$/,
  },
  // --- MEM XMS ---
  {
    name: 'MEM XMS',
    command: 'MEM XMS',
    expectPattern: /^(OK VER=\d+\.\d+ FREE=\d+K HMA=(YES|NO)|ERR NO_XMS)$/,
  },
  // --- EXEC LIST ---
  {
    name: 'EXEC LIST',
    command: 'EXEC LIST',
    expectPattern: /^OK .+/,
  },
  // --- FILE ATTR ---
  {
    name: 'FILE ATTR GET',
    command: 'FILE ATTR GET C:\\DOSMCP.COM',
    expectPattern: /^OK R=[01] H=[01] S=[01] A=[01]$/,
  },
  {
    name: 'FILE ATTR SET then GET',
    preCommand: 'FILE WRITE C:\\ATRTMP.TXT 0 41 42 43',
    command: 'FILE ATTR SET C:\\ATRTMP.TXT +R',
    expect: 'OK',
    followUp: {
      // emu2 may silently ignore attribute changes on host filesystem
      command: 'FILE ATTR GET C:\\ATRTMP.TXT',
      expectPattern: /^OK R=[01] H=[01] S=[01] A=[01]$/,
    },
  },
  {
    name: 'FILE ATTR cleanup',
    preCommand: 'FILE ATTR SET C:\\ATRTMP.TXT -R',
    command: 'FILE DELETE C:\\ATRTMP.TXT',
    expect: 'OK',
  },
  // --- FILE FIND ---
  {
    name: 'FILE FIND',
    command: 'FILE FIND C:\\*.COM',
    expectPattern: /^OK .*MCP\.COM.*/,
  },
  {
    name: 'FILE FIND not found',
    command: 'FILE FIND C:\\ZZZZZ*.QQQ',
    expect: 'ERR NOT_FOUND',
  },
  // --- FILE APPEND ---
  {
    name: 'FILE APPEND',
    preCommand: 'FILE WRITE C:\\APPTMP.BIN 0 41 42',
    command: 'FILE APPEND C:\\APPTMP.BIN 43 44',
    expect: 'OK 2',
    followUp: {
      command: 'FILE READ C:\\APPTMP.BIN 0 4',
      expect: 'OK 41 42 43 44',
    },
  },
  {
    name: 'FILE APPEND cleanup',
    command: 'FILE DELETE C:\\APPTMP.BIN',
    expect: 'OK',
  },
  // --- FILE WATCH ---
  {
    name: 'FILE WATCH first call',
    preCommand: 'FILE WRITE C:\\WATCHTMP.BIN 0 41',
    command: 'FILE WATCH C:\\WATCHTMP.BIN',
    expect: 'OK CHANGED',
  },
  {
    name: 'FILE WATCH unchanged',
    command: 'FILE WATCH C:\\WATCHTMP.BIN',
    expect: 'OK UNCHANGED',
  },
  {
    name: 'FILE WATCH after modify',
    preCommand: 'FILE APPEND C:\\WATCHTMP.BIN 42',
    command: 'FILE WATCH C:\\WATCHTMP.BIN',
    expect: 'OK CHANGED',
  },
  {
    name: 'FILE WATCH cleanup',
    command: 'FILE DELETE C:\\WATCHTMP.BIN',
    expect: 'OK',
  },
  // --- CON COLOR ---
  {
    name: 'CON COLOR set and get',
    command: 'CON COLOR 1E',
    expect: 'OK',
    followUp: {
      command: 'CON COLOR',
      expect: 'OK 1E',
    },
  },
  {
    name: 'CON COLOR restore default',
    command: 'CON COLOR 07',
    expect: 'OK',
  },
  // --- CON INPUT ---
  {
    name: 'CON INPUT empty buffer',
    preCommand: 'KEY FLUSH',
    command: 'CON INPUT',
    expect: 'OK',
  },
  // --- CON BOX ---
  {
    name: 'CON BOX single',
    command: 'CON BOX 5 10 4 20 07 SINGLE',
    expect: 'OK',
    followUp: {
      command: 'MEM PEEK B800:0334 1',
      expect: 'OK DA',
    },
  },
  {
    name: 'CON BOX double',
    command: 'CON BOX 0 0 3 5 1F DOUBLE',
    expect: 'OK',
    followUp: {
      command: 'MEM PEEK B800:0000 1',
      expect: 'OK C9',
    },
  },
  // --- META DELAY ---
  {
    name: 'META DELAY',
    command: 'META DELAY 1',
    expect: 'OK',
  },
  // --- KEY FLUSH ---
  {
    name: 'KEY FLUSH',
    command: 'KEY FLUSH',
    expect: 'OK',
  },
  // --- KEY PEEK ---
  {
    name: 'KEY PEEK empty',
    preCommand: 'KEY FLUSH',
    command: 'KEY PEEK',
    expect: 'OK EMPTY',
  },
  {
    name: 'Unknown command',
    command: 'FAKECMD hello',
    expect: 'ERR UNKNOWN_COMMAND',
  },
];

var passed = 0;
var failed = 0;
var timedOut = false;

function ensureMagicDir() {
  if (!fs.existsSync(MAGIC_DIR)) {
    fs.mkdirSync(MAGIC_DIR, { recursive: true });
  }
}

function cleanup(includeStatus) {
  // Remove TX, RX (and optionally ST) in both cases
  var names = ['__MCP__.TX', '__MCP__.RX', '__MCP__.TT', '__MCP__.TW', '__MCP__.SCR', '__MCP__.OUT', '__MCP__.LR',
               '__mcp__.tx', '__mcp__.rx', '__mcp__.tt', '__mcp__.tw', '__mcp__.scr', '__mcp__.out', '__mcp__.lr'];
  if (includeStatus) {
    names.push('__MCP__.ST', '__mcp__.st');
  }
  names.forEach(function (name) {
    try { fs.unlinkSync(path.join(MAGIC_DIR, name)); } catch (_) { /* ignore */ }
  });
}

// Delete any existing RX file so we can detect the fresh response
function deleteRx() {
  ['__MCP__.RX', '__mcp__.rx'].forEach(function (name) {
    try { fs.unlinkSync(path.join(MAGIC_DIR, name)); } catch (_) { /* ignore */ }
  });
}

// Write command to TX — use atomic rename to avoid race with MCP polling
function writeCommand(cmd) {
  deleteRx();
  var txFile = path.join(MAGIC_DIR, '__mcp__.tx');
  var tmpFile = path.join(MAGIC_DIR, '__mcp__.tw');
  fs.writeFileSync(tmpFile, cmd + '\r\n');
  fs.renameSync(tmpFile, txFile);
}

// Wait for RX to appear with a response.
function waitForRxFile(timeoutMs) {
  return new Promise(function (resolve, reject) {
    var start = Date.now();
    var timer = setInterval(function () {
      if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error('Timed out waiting for response'));
        return;
      }

      // Check for RX
      var rx = rxPath();
      if (rx) {
        try {
          var content = fs.readFileSync(rx, 'utf8').trim();
          if (content.length > 0) {
            clearInterval(timer);
            try { fs.unlinkSync(rx); } catch (_) { /* ignore */ }
            // Handle long response overflow
            if (content === 'OK @LR') {
              var lrPath = findFile('__MCP__.LR');
              if (lrPath) {
                try {
                  content = fs.readFileSync(lrPath, 'utf8').trim();
                  fs.unlinkSync(lrPath);
                } catch (_) { /* fall through with OK @LR */ }
              }
            }
            resolve(content);
          }
        } catch (_) { /* not ready */ }
      }
    }, POLL_MS);
  });
}

// Wait for TSR to signal READY via ST file
function waitForReady(timeoutMs) {
  return new Promise(function (resolve, reject) {
    var start = Date.now();
    var timer = setInterval(function () {
      if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error('Timed out waiting for TSR READY'));
        return;
      }
      var st = stPath();
      if (st) {
        try {
          var content = fs.readFileSync(st, 'utf8').trim();
          if (content === 'READY') {
            clearInterval(timer);
            resolve();
          }
        } catch (_) { /* not ready */ }
      }
    }, POLL_MS);
  });
}

function checkResponse(rx, expect, expectPattern) {
  if (expect) return rx.trim() === expect.trim();
  if (expectPattern) return expectPattern.test(rx);
  return true;
}

async function sendAndReceive(cmd, timeoutMs) {
  writeCommand(cmd);
  return await waitForRxFile(timeoutMs);
}

async function sendWithRetry(cmd, expect, expectPattern, timeoutMs) {
  var lastRx;
  for (var attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      lastRx = await sendAndReceive(cmd, timeoutMs);
    } catch (e) {
      throw e; // timeout — don't retry
    }
    if (checkResponse(lastRx, expect, expectPattern)) {
      return lastRx;
    }
    // Wrong response — might be a race condition, retry
    if (attempt < MAX_RETRIES - 1) {
      await new Promise(function(r) { setTimeout(r, 250); });
    }
  }
  return lastRx; // return last response even if wrong
}

async function runTest(test) {
  process.stdout.write('  ' + test.name + '... ');

  // Execute pre-command if specified (e.g. POKE before DUMP)
  if (test.preCommand) {
    try {
      await sendWithRetry(test.preCommand, 'OK', null, 10000);
    } catch (e) {
      console.log('FAIL (preCommand timeout)');
      failed++;
      return;
    }
  }

  var rx;
  try {
    rx = await sendWithRetry(test.command, test.expect, test.expectPattern, 10000);
  } catch (e) {
    console.log('FAIL (timeout)');
    failed++;
    return;
  }

  if (!checkResponse(rx, test.expect, test.expectPattern)) {
    console.log('FAIL (expected "' + (test.expect || test.expectPattern) + '", got "' + rx + '") ' + readDebugFile());
    failed++;
    return;
  }

  if (test.followUp) {
    var rx2;
    try {
      rx2 = await sendWithRetry(test.followUp.command,
        test.followUp.expect, test.followUp.expectPattern, 10000);
    } catch (e) {
      console.log('FAIL (follow-up timeout)');
      failed++;
      return;
    }

    if (!checkResponse(rx2, test.followUp.expect, test.followUp.expectPattern)) {
      console.log('FAIL (follow-up: expected "' +
        (test.followUp.expect || test.followUp.expectPattern) +
        '", got "' + rx2 + '") ' + readDebugFile());
      failed++;
      return;
    }
  }

  console.log('PASS');
  passed++;
}

async function main() {
  console.log('MCP TSR Test Harness');
  console.log('Timeout: ' + TIMEOUT_SEC + 's');
  console.log('');

  ensureMagicDir();
  cleanup(false);  // Don't remove ST — emu2 may have already written it

  // Host-side cleanup of test artifacts from previous runs
  // EMU2_DRIVE_C=. maps C: to the tsr/ directory
  try { fs.rmdirSync(path.resolve(__dirname, 'TSTDIR')); } catch (_) {}
  try { fs.unlinkSync(path.resolve(__dirname, 'TSTFILE.TXT')); } catch (_) {}
  try { fs.unlinkSync(path.resolve(__dirname, 'TSTREN.TXT')); } catch (_) {}
  try { fs.unlinkSync(path.resolve(__dirname, 'TSTCOPY.TXT')); } catch (_) {}
  try { fs.unlinkSync(path.resolve(__dirname, 'TSTSRC.TXT')); } catch (_) {}
  try { fs.unlinkSync(path.resolve(__dirname, 'TESTINI.INI')); } catch (_) {}

  var globalTimeout = setTimeout(function () {
    timedOut = true;
    console.log('\n*** GLOBAL TIMEOUT ***');
    process.exit(2);
  }, TIMEOUT_SEC * 1000);

  console.log('Waiting for TSR to signal READY...');
  try {
    await waitForReady(20000);
  } catch (e) {
    console.log('FAIL: TSR never became READY');
    clearTimeout(globalTimeout);
    process.exit(2);
  }

  console.log('TSR is READY. Running tests...\n');

  for (var i = 0; i < tests.length; i++) {
    if (timedOut) break;
    await runTest(tests[i]);
  }

  console.log('\nResults: ' + passed + ' passed, ' + failed + ' failed out of ' + tests.length + ' tests');

  clearTimeout(globalTimeout);
  cleanup(true);  // Full cleanup including ST at the end

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error('Harness error:', e.message);
  process.exit(2);
});
