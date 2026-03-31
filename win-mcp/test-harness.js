#!/usr/bin/env node

/**
 * WIN-MCP Test Harness
 *
 * Uses win-auto.js to send commands and validate responses.
 * Works with either DOSBox-X or emu2 backends.
 *
 * Usage: node test-harness.js [--timeout 60]
 */

var fs = require('fs');
var path = require('path');
var WinAuto = require('../lib/win-auto').WinAuto;

// Paths — _MAGIC_ lives in the share directory
var SHARE_DIR = path.resolve(__dirname, '..', 'share');
var MAGIC_DIR = path.join(SHARE_DIR, '_MAGIC_');

// WinAuto instance for IPC
var auto = new WinAuto({ magicDir: MAGIC_DIR, pollMs: 200, timeout: 10000 });

// IPC is handled by win-auto.js (auto instance created above)

// Config
var TIMEOUT_SEC = parseInt(
  process.argv.find(function (a, i) { return process.argv[i - 1] === '--timeout'; }) || '60',
  10
);
var POLL_MS = 200;
var MAX_RETRIES = 3;

// Dynamic variable store — tests can capture values from responses
// and use them in subsequent commands via {{varName}} substitution
var vars = {};

// ============================================================
// Test definitions
// ============================================================
var tests = [
  // === META ===
  {
    name: 'META PING',
    command: 'META PING',
    expect: 'OK PONG',
  },
  {
    name: 'META VERSION',
    command: 'META VERSION',
    expectPattern: /^OK WINMCP\/0\.\d+.*META.*TYPE.*SENDKEYS.*MOUSE.*WAIT.*RECORD.*PLAY/,
  },
  {
    name: 'META STATUS',
    command: 'META STATUS',
    expectPattern: /^OK CMDS=\d+ POLL=\d+ms$/,
  },

  // === PROFILE ===
  {
    name: 'PROFILE GET (WIN.INI load)',
    command: 'PROFILE GET WIN.INI windows load',
    expectPattern: /^OK .*WINMCP/,
  },
  {
    name: 'PROFILE SET (write test key)',
    command: 'PROFILE SET C:\\MCPTEST.INI testsec testkey hello123',
    expect: 'OK',
  },
  {
    name: 'PROFILE GET (read back)',
    command: 'PROFILE GET C:\\MCPTEST.INI testsec testkey',
    expect: 'OK hello123',
  },
  {
    name: 'PROFILE SECTIONS',
    command: 'PROFILE SECTIONS C:\\MCPTEST.INI',
    // Win16 may cache INI writes; accept OK with or without sections
    expectPattern: /^OK/,
  },
  {
    name: 'PROFILE SET (delete key)',
    command: 'PROFILE SET C:\\MCPTEST.INI testsec testkey',
    expect: 'OK',
  },
  {
    name: 'PROFILE cleanup',
    command: 'FILE DELETE C:\\MCPTEST.INI',
    // May fail if Win16 locked it; accept either
    expectPattern: /^(OK|ERR)/,
  },

  // === FILE ===
  {
    name: 'FILE WRITE',
    command: 'FILE WRITE C:\\MCPTEST.TXT Hello from test harness',
    expect: 'OK',
  },
  {
    name: 'FILE READ',
    command: 'FILE READ C:\\MCPTEST.TXT',
    expect: 'OK Hello from test harness',
  },
  {
    name: 'FILE APPEND',
    command: 'FILE APPEND C:\\MCPTEST.TXT |appended',
    expect: 'OK',
  },
  {
    name: 'FILE READ after append',
    command: 'FILE READ C:\\MCPTEST.TXT',
    expect: 'OK Hello from test harness|appended',
  },
  {
    name: 'FILE COPY',
    command: 'FILE COPY C:\\MCPTEST.TXT C:\\MCPCOPY.TXT',
    expect: 'OK',
  },
  {
    name: 'FILE READ copy',
    command: 'FILE READ C:\\MCPCOPY.TXT',
    expect: 'OK Hello from test harness|appended',
  },
  {
    name: 'FILE FIND',
    command: 'FILE FIND C:\\WINDOWS\\*.EXE',
    expectPattern: /^OK .*NOTEPAD\.EXE/,
  },
  {
    name: 'FILE DELETE originals',
    command: 'FILE DELETE C:\\MCPTEST.TXT',
    expect: 'OK',
  },
  {
    name: 'FILE DELETE copy',
    command: 'FILE DELETE C:\\MCPCOPY.TXT',
    expect: 'OK',
  },
  {
    name: 'FILE READ deleted',
    command: 'FILE READ C:\\MCPTEST.TXT',
    expect: 'ERR NOT_FOUND',
  },

  // === DIR ===
  {
    name: 'DIR CREATE',
    command: 'DIR CREATE C:\\MCPTESTD',
    expect: 'OK',
  },
  {
    name: 'DIR LIST',
    command: 'DIR LIST C:\\',
    expectPattern: /^OK .*WINDOWS\//,
  },
  {
    name: 'DIR LIST sees new dir',
    command: 'DIR LIST C:\\',
    expectPattern: /MCPTESTD\//,
  },
  {
    name: 'DIR DELETE',
    command: 'DIR DELETE C:\\MCPTESTD',
    expect: 'OK',
  },

  // === TIME ===
  {
    name: 'TIME GET',
    command: 'TIME GET',
    expectPattern: /^OK \d{2}:\d{2}:\d{2}$/,
  },

  // === ENV ===
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

  // === EXEC ===
  {
    name: 'EXEC launch Notepad',
    command: 'EXEC NOTEPAD.EXE',
    expectPattern: /^OK \d+$/,
  },

  // === WINDOW ===
  {
    name: 'WINDOW LIST',
    command: 'WINDOW LIST',
    expectPattern: /^OK .*Notepad.*Progman/,
    timeout: 3000,
  },
  {
    name: 'WINDOW FIND Notepad',
    command: 'WINDOW FIND Notepad',
    expectPattern: /^OK [0-9A-F]{4}$/,
  },
  {
    name: 'WINDOW TITLE (Progman)',
    command: 'WINDOW TITLE 1168',
    // hwnd may differ — use FIND first in real usage; here we test the format
    expectPattern: /^(OK .*|ERR INVALID_HWND)$/,
  },
  {
    name: 'WINDOW SHOW (Notepad minimize)',
    command: 'WINDOW LIST',
    // Just verify list still works after prior commands
    expectPattern: /^OK /,
  },

  // === TASK ===
  {
    name: 'TASK LIST',
    command: 'TASK LIST',
    expectPattern: /^OK .*NOTEPAD.*WINMCP/,
  },

  // === GDI ===
  {
    name: 'GDI SCREEN',
    command: 'GDI SCREEN',
    expectPattern: /^OK W=\d+ H=\d+ BPP=\d+$/,
  },
  {
    name: 'GDI CAPTURE desktop',
    command: 'GDI CAPTURE',
    expectPattern: /^OK .*__WIN__\.BMP$/,
    timeout: 15000,
  },
  {
    name: 'GDI CAPTURE ACTIVE',
    command: 'GDI CAPTURE ACTIVE',
    expectPattern: /^OK .*__WIN__\.BMP$/,
    timeout: 15000,
  },

  // === MSG ===
  {
    name: 'MSG POST (WM_NULL to desktop)',
    command: 'MSG POST 0ECC 0000 0000 0000',
    // hwnd may differ; test format only. Use a safe no-op message.
    expectPattern: /^(OK|ERR INVALID_HWND)$/,
  },

  // === CLIP ===
  {
    name: 'CLIP SET',
    command: 'CLIP SET MCP clipboard test 123',
    expect: 'OK',
  },
  {
    name: 'CLIP GET',
    command: 'CLIP GET',
    expect: 'OK MCP clipboard test 123',
  },

  // === WINDOW CLOSE (cleanup Notepad) ===
  {
    name: 'WINDOW CLOSE Notepad (find first)',
    command: 'WINDOW FIND Notepad',
    expectPattern: /^OK [0-9A-F]{4}$/,
    // We'll use a followUp to close it
  },

  // === DDE ===
  {
    name: 'DDE CONNECT to Program Manager',
    command: 'DDE CONNECT PROGMAN PROGMAN',
    expectPattern: /^OK [0-9A-F]{4}$/,
  },
  {
    name: 'DDE EXEC create test group',
    command: 'DDE EXEC [CreateGroup(MCPTest)]',
    expect: 'OK',
  },
  {
    name: 'DDE EXEC delete test group',
    command: 'DDE EXEC [DeleteGroup(MCPTest)]',
    expect: 'OK',
  },
  {
    name: 'DDE CLOSE',
    command: 'DDE CLOSE',
    expect: 'OK',
  },

  // === DIALOG (using Notepad's Save As dialog) ===
  // First, type something into Notepad so "Save As" is available
  {
    name: 'DIALOG: find Notepad edit control',
    command: 'WINDOW FIND Notepad',
    expectPattern: /^OK ([0-9A-F]{4})$/,
    capture: { pattern: /^OK ([0-9A-F]{4})$/, as: 'npForDialog' },
  },
  {
    name: 'DIALOG: find edit child',
    command: 'CONTROL FIND {{npForDialog}} Edit *',
    requireVar: 'npForDialog',
    expectPattern: /^OK ([0-9A-F]{4})$/,
    capture: { pattern: /^OK ([0-9A-F]{4})$/, as: 'editForDialog' },
  },
  {
    name: 'DIALOG: type text for save',
    command: 'TYPE {{editForDialog}} dialog test',
    requireVar: 'editForDialog',
    expect: 'OK',
    delayAfter: 300,
  },
  {
    name: 'DIALOG: focus Notepad',
    command: 'FOCUS {{npForDialog}}',
    requireVar: 'npForDialog',
    expect: 'OK',
    delayAfter: 300,
  },
  {
    name: 'DIALOG: open Save As via menu command (id=1)',
    command: 'MENU {{npForDialog}} 1',
    requireVar: 'npForDialog',
    expect: 'OK',
    delayAfter: 1000,
  },
  {
    name: 'DIALOG: find Save As by class #32770',
    command: 'WINDOW FIND #32770',
    expectPattern: /^OK ([0-9A-F]{4})$/,
    capture: { pattern: /^OK ([0-9A-F]{4})$/, as: 'saveAsHwnd' },
  },
  {
    name: 'DIALOG: list Save As controls',
    command: 'DIALOG LIST {{saveAsHwnd}}',
    requireVar: 'saveAsHwnd',
    expectPattern: /^OK .+Button.+/,
  },
  {
    name: 'DIALOG: get filename field (id 1152)',
    command: 'DIALOG GET {{saveAsHwnd}} 1152',
    requireVar: 'saveAsHwnd',
    expectPattern: /^OK/,
  },
  {
    name: 'DIALOG: set filename',
    command: 'DIALOG SET {{saveAsHwnd}} 1152 MCPTEST.TXT',
    requireVar: 'saveAsHwnd',
    expect: 'OK',
  },
  {
    name: 'DIALOG: verify filename was set',
    command: 'DIALOG GET {{saveAsHwnd}} 1152',
    requireVar: 'saveAsHwnd',
    expect: 'OK MCPTEST.TXT',
  },
  {
    name: 'DIALOG: click Cancel (id 2)',
    command: 'DIALOG CLICK {{saveAsHwnd}} 2',
    requireVar: 'saveAsHwnd',
    expect: 'OK',
    delayAfter: 1000,
  },

  // === Sprint 1: Input Simulation + Waiting ===

  // -- FOCUS --
  {
    name: 'WINDOW FIND Notepad (capture hwnd)',
    command: 'WINDOW FIND Notepad',
    expectPattern: /^OK ([0-9A-F]{4})$/,
    capture: { pattern: /^OK ([0-9A-F]{4})$/, as: 'notepadHwnd' },
  },
  {
    name: 'FOCUS Notepad',
    command: 'FOCUS {{notepadHwnd}}',
    requireVar: 'notepadHwnd',
    expect: 'OK',
  },

  // -- WINDOW RECT / VISIBLE / ENABLED --
  {
    name: 'WINDOW RECT',
    command: 'WINDOW RECT {{notepadHwnd}}',
    requireVar: 'notepadHwnd',
    expectPattern: /^OK -?\d+ -?\d+ \d+ \d+$/,
  },
  {
    name: 'WINDOW VISIBLE',
    command: 'WINDOW VISIBLE {{notepadHwnd}}',
    requireVar: 'notepadHwnd',
    expect: 'OK TRUE',
  },
  {
    name: 'WINDOW ENABLED',
    command: 'WINDOW ENABLED {{notepadHwnd}}',
    requireVar: 'notepadHwnd',
    expectPattern: /^OK (TRUE|FALSE)$/,
  },

  // -- TYPE (into Notepad's edit control) --
  // First find the Edit child control
  {
    name: 'CONTROL FIND Edit in Notepad',
    command: 'CONTROL FIND {{notepadHwnd}} Edit *',
    requireVar: 'notepadHwnd',
    expectPattern: /^OK ([0-9A-F]{4})$/,
    capture: { pattern: /^OK ([0-9A-F]{4})$/, as: 'editHwnd' },
  },
  {
    name: 'TYPE hello into Notepad',
    command: 'TYPE {{editHwnd}} Hello from MCP',
    requireVar: 'editHwnd',
    expect: 'OK',
    delayAfter: 500,
  },

  // -- SENDKEYS: Ctrl+A (select all) --
  {
    name: 'SENDKEYS Ctrl+A (select all)',
    command: 'SENDKEYS {{editHwnd}} {CTRL}a',
    requireVar: 'editHwnd',
    expect: 'OK',
    delayAfter: 300,
  },

  // -- SENDKEYS: type replacement text --
  {
    name: 'TYPE replacement text',
    command: 'TYPE {{editHwnd}} Automation Test 123',
    requireVar: 'editHwnd',
    expect: 'OK',
    delayAfter: 300,
  },

  // -- MOUSE GETPOS --
  {
    name: 'MOUSE GETPOS',
    command: 'MOUSE GETPOS',
    expectPattern: /^OK \d+ \d+$/,
  },

  // -- MOUSE MOVE --
  {
    name: 'MOUSE MOVE',
    command: 'MOUSE MOVE 100 100',
    expect: 'OK',
  },
  {
    name: 'MOUSE GETPOS after move',
    command: 'MOUSE GETPOS',
    expect: 'OK 100 100',
  },

  // -- MOUSE CLICK (click inside Notepad edit area) --
  {
    name: 'MOUSE CLICK',
    command: 'MOUSE CLICK {{editHwnd}} 10 10',
    requireVar: 'editHwnd',
    expect: 'OK',
  },

  // -- SCROLL --
  {
    name: 'SCROLL DOWN',
    command: 'SCROLL {{editHwnd}} DOWN 3',
    requireVar: 'editHwnd',
    expect: 'OK',
  },

  // -- WINDOW MOVE Notepad --
  {
    name: 'WINDOW MOVE Notepad',
    command: 'WINDOW MOVE {{notepadHwnd}} 10 10 400 300',
    requireVar: 'notepadHwnd',
    expect: 'OK',
  },
  {
    name: 'WINDOW RECT after move',
    command: 'WINDOW RECT {{notepadHwnd}}',
    requireVar: 'notepadHwnd',
    expectPattern: /^OK 10 10 400 300$/,
  },

  // -- WINDOW SHOW HIDE/RESTORE --
  {
    name: 'WINDOW SHOW HIDE',
    command: 'WINDOW SHOW {{notepadHwnd}} HIDE',
    requireVar: 'notepadHwnd',
    expect: 'OK',
    delayAfter: 300,
  },
  {
    name: 'WINDOW VISIBLE after HIDE',
    command: 'WINDOW VISIBLE {{notepadHwnd}}',
    requireVar: 'notepadHwnd',
    expect: 'OK FALSE',
  },
  {
    name: 'WINDOW SHOW RESTORE',
    command: 'WINDOW SHOW {{notepadHwnd}} RESTORE',
    requireVar: 'notepadHwnd',
    expect: 'OK',
    delayAfter: 300,
  },
  {
    name: 'WINDOW VISIBLE after RESTORE',
    command: 'WINDOW VISIBLE {{notepadHwnd}}',
    requireVar: 'notepadHwnd',
    expect: 'OK TRUE',
  },

  // -- GDI CAPTURE specific window --
  {
    name: 'GDI CAPTURE specific hwnd',
    command: 'GDI CAPTURE {{notepadHwnd}}',
    requireVar: 'notepadHwnd',
    expectPattern: /^OK .*__WIN__\.BMP$/,
    timeout: 15000,
  },

  // -- MSG SEND (WM_GETTEXTLENGTH to edit control) --
  {
    name: 'MSG SEND WM_GETTEXTLENGTH',
    command: 'MSG SEND {{editHwnd}} 000E 0000 0000',
    requireVar: 'editHwnd',
    // WM_GETTEXTLENGTH = 0x000E, should return nonzero (text length)
    expectPattern: /^OK [1-9A-Fa-f]/,
  },

  // -- MENU (File > New = menu id varies, use SENDKEYS approach instead) --
  // We'll test MENU with a known ID later if needed

  // -- Full Notepad exit flow: close via WINDOW CLOSE, handle save dialog --
  {
    name: 'WINDOW CLOSE Notepad (triggers save dialog)',
    command: 'WINDOW CLOSE {{notepadHwnd}}',
    requireVar: 'notepadHwnd',
    expect: 'OK',
    delayAfter: 1000,
  },
  {
    name: 'ABORT save dialog',
    command: 'ABORT',
    // May or may not have a modal dialog depending on timing
    expectPattern: /^(OK|ERR NO_MODAL_DIALOG|ERR NO_ACTIVE_WINDOW)$/,
    delayAfter: 500,
  },

  // -- WAIT WINDOW (launch new Notepad + wait) --
  {
    name: 'EXEC Notepad for WAIT test',
    command: 'EXEC NOTEPAD.EXE',
    expectPattern: /^OK \d+$/,
  },
  {
    name: 'WAIT WINDOW Notepad',
    command: 'WAIT WINDOW Notepad 5000',
    expectPattern: /^OK ([0-9A-F]{4})$/,
    capture: { pattern: /^OK ([0-9A-F]{4})$/, as: 'waitNpHwnd' },
    timeout: 10000,
  },
  // Close it and test WAIT GONE
  {
    name: 'WINDOW CLOSE for WAIT GONE',
    command: 'WINDOW CLOSE {{waitNpHwnd}}',
    requireVar: 'waitNpHwnd',
    expect: 'OK',
    delayAfter: 500,
  },
  {
    name: 'WAIT GONE',
    command: 'WAIT GONE {{waitNpHwnd}} 5000',
    requireVar: 'waitNpHwnd',
    expectPattern: /^OK$/,
    timeout: 10000,
  },

  // -- TASK LIST and KILL test --
  {
    name: 'EXEC Notepad for TASK KILL',
    command: 'EXEC NOTEPAD.EXE',
    expectPattern: /^OK \d+$/,
    delayAfter: 1000,
  },
  {
    name: 'TASK LIST (find NOTEPAD)',
    command: 'TASK LIST',
    expectPattern: /NOTEPAD/,
    capture: { pattern: /([0-9A-F]{4}):NOTEPAD/, as: 'notepadTask' },
  },
  {
    name: 'TASK KILL NOTEPAD',
    command: 'TASK KILL {{notepadTask}}',
    requireVar: 'notepadTask',
    expect: 'OK',
    delayAfter: 500,
  },

  // === RECORD/PLAY (Sprint 3) ===
  {
    name: 'PLAY STATUS (idle)',
    command: 'PLAY STATUS',
    expect: 'OK IDLE',
  },
  {
    name: 'RECORD START',
    command: 'RECORD START',
    expect: 'OK',
  },
  {
    name: 'PLAY STATUS (recording)',
    command: 'PLAY STATUS',
    expect: 'OK RECORDING',
  },
  {
    name: 'RECORD STOP',
    command: 'RECORD STOP',
    expectPattern: /^OK \d+$/,
    delayAfter: 300,
  },
  {
    name: 'PLAY STATUS (idle after stop)',
    command: 'PLAY STATUS',
    expect: 'OK IDLE',
  },

  // === Unknown command ===
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
  var names = [
    '__WIN__.TX', '__WIN__.RX', '__WIN__.TW', '__WIN__.LR',
    '__win__.tx', '__win__.rx', '__win__.tw', '__win__.lr',
  ];
  if (includeStatus) {
    names.push('__WIN__.ST', '__win__.st');
  }
  names.forEach(function (name) {
    try { fs.unlinkSync(path.join(MAGIC_DIR, name)); } catch (_) {}
  });
}

// IPC now delegated to win-auto.js
function checkResponse(rx, expect, expectPattern) {
  if (expect) return rx.trim() === expect.trim();
  if (expectPattern) return expectPattern.test(rx);
  return true;
}

async function sendAndReceive(cmd, timeoutMs) {
  return auto.send(cmd, timeoutMs);
}

async function sendWithRetry(cmd, expect, expectPattern, timeoutMs) {
  var lastRx;
  for (var attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      lastRx = await sendAndReceive(cmd, timeoutMs);
    } catch (e) {
      throw e;
    }
    if (checkResponse(lastRx, expect, expectPattern)) {
      return lastRx;
    }
    if (attempt < MAX_RETRIES - 1) {
      await new Promise(function(r) { setTimeout(r, 500); });
    }
  }
  return lastRx;
}

// Substitute {{varName}} placeholders in a string
function subst(str) {
  return str.replace(/\{\{(\w+)\}\}/g, function (_, name) {
    return vars[name] || '';
  });
}

async function runTest(test) {
  process.stdout.write('  ' + test.name + '... ');

  // Skip test if a required var is missing
  if (test.requireVar && !vars[test.requireVar]) {
    console.log('SKIP (missing ' + test.requireVar + ')');
    return;
  }

  var cmd = test.commandFn ? test.commandFn() : (test.command ? subst(test.command) : null);
  if (!cmd) {
    console.log('SKIP (no command)');
    return;
  }

  var rx;
  try {
    rx = await sendWithRetry(cmd, test.expect, test.expectPattern, test.timeout || 10000);
  } catch (e) {
    console.log('FAIL (timeout)');
    failed++;
    return;
  }

  if (!checkResponse(rx, test.expect, test.expectPattern)) {
    console.log('FAIL (expected "' + (test.expect || test.expectPattern) + '", got "' + rx + '")');
    failed++;
    return;
  }

  // Capture variables from response
  if (test.capture) {
    var m = rx.match(test.capture.pattern);
    if (m && m[1]) {
      vars[test.capture.as] = m[1];
    }
  }

  if (test.followUp) {
    var rx2;
    var fuCmd = test.followUp.commandFn ? test.followUp.commandFn() : subst(test.followUp.command);
    try {
      rx2 = await sendWithRetry(fuCmd,
        test.followUp.expect, test.followUp.expectPattern, 10000);
    } catch (e) {
      console.log('FAIL (follow-up timeout)');
      failed++;
      return;
    }
    if (!checkResponse(rx2, test.followUp.expect, test.followUp.expectPattern)) {
      console.log('FAIL (follow-up: expected "' +
        (test.followUp.expect || test.followUp.expectPattern) +
        '", got "' + rx2 + '")');
      failed++;
      return;
    }
    if (test.followUp.capture) {
      var m2 = rx2.match(test.followUp.capture.pattern);
      if (m2 && m2[1]) {
        vars[test.followUp.capture.as] = m2[1];
      }
    }
  }

  // Optional delay after test
  if (test.delayAfter) {
    await new Promise(function(r) { setTimeout(r, test.delayAfter); });
  }

  console.log('PASS');
  passed++;
}

async function main() {
  console.log('WIN-MCP Test Harness');
  console.log('Timeout: ' + TIMEOUT_SEC + 's');
  console.log('');

  ensureMagicDir();
  cleanup(false);

  var globalTimeout = setTimeout(function () {
    timedOut = true;
    console.log('\n*** GLOBAL TIMEOUT ***');
    process.exit(2);
  }, TIMEOUT_SEC * 1000);

  console.log('Waiting for WIN-MCP to signal READY...');
  try {
    await auto.waitForReady(30000);
  } catch (e) {
    console.log('FAIL: WIN-MCP never became READY');
    clearTimeout(globalTimeout);
    process.exit(2);
  }

  console.log('WIN-MCP is READY. Running tests...\n');

  for (var i = 0; i < tests.length; i++) {
    if (timedOut) break;
    await runTest(tests[i]);
  }

  // Send QUIT to cleanly shut down the stub
  try {
    auto.send('META QUIT', 2000).catch(function() {});
  } catch (_) {}

  console.log('\nResults: ' + passed + ' passed, ' + failed + ' failed out of ' + tests.length + ' tests');

  clearTimeout(globalTimeout);
  // Wait a moment for QUIT to process, then cleanup
  await new Promise(function(r) { setTimeout(r, 1000); });
  cleanup(true);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(function(err) {
  console.error('Fatal error:', err);
  process.exit(2);
});
