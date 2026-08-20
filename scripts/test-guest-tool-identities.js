#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { checkedContract, renderedIdentity, sourceDigest, verifyTrackedBinaries } =
  require('./update-guest-tool-identities');

function verifyAuditRollbackSource(source) {
  assert.match(source,
    /static BOOL restore_memory\(WORD selector, DWORD offset,[\s\S]*MemoryWrite\(selector, offset, original, byteCount\);[\s\S]*MemoryRead\(selector, offset, restore_verify_buf, byteCount\);[\s\S]*_fmemcmp\(original, restore_verify_buf, byteCount\) == 0;/);
  assert.equal((source.match(
    /restored = restore_memory\(selector, offset, before_write_buf, byteCount\);/g) || []).length, 2);
  assert.match(source,
    /if \(!append_file\(mw_path, tmp_buf, lstrlen\(tmp_buf\)\)\) \{[\s\S]*restored = restore_memory\(selector, offset, before_write_buf, byteCount\);[\s\S]*ERR AUDIT_FAILED RESTORED=%s[\s\S]*restored \? \(LPSTR\)"TRUE" : \(LPSTR\)"FALSE"/);
}

function bodyBetween(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start + startMarker.length);
  assert(start >= 0 && end > start, `missing ordered source boundary ${startMarker}`);
  return text.slice(start, end);
}

function ordered(text, ...markers) {
  let cursor = -1;
  for (const marker of markers) {
    const next = text.indexOf(marker, cursor + 1);
    assert(next > cursor, `missing or reordered source marker ${marker}`);
    cursor = next;
  }
}

function verifyControlInspectionSource(source) {
  const listCallback = bodyBetween(source, 'static BOOL FAR PASCAL EnumDlgProc',
    'static void cmd_dialog');
  ordered(listCallback, 'if (!GetClassName', 'dl_inspection_failed = TRUE',
    'GetWindowText', 'dl_truncated = TRUE');

  const dialog = bodyBetween(source, 'static void cmd_dialog',
    'static HDDEDATA FAR PASCAL DdeCallback');
  const list = bodyBetween(dialog, 'prefix(arg, "LIST ")', 'prefix(arg, "GET ")');
  ordered(list, 'dl_inspection_failed = FALSE', 'dl_truncated = FALSE',
    'EnumChildWindows', 'ERR CONTROL_INSPECTION', 'ERR RESPONSE_TOO_LONG');
  assert.match(list,
    /if \(dl_inspection_failed\) \{[\s\S]*ERR CONTROL_INSPECTION[\s\S]*if \(dl_truncated\) \{[\s\S]*ERR RESPONSE_TOO_LONG/);
  const get = bodyBetween(dialog, 'prefix(arg, "GET ")', 'prefix(arg, "SET ")');
  ordered(get, 'GetDlgItem(hwnd, id)', 'ERR NOT_FOUND', 'GetWindowText(ctrl');
  assert.match(get, /if \(!ctrl\) \{ write_response\("ERR NOT_FOUND"\); return; \}/);
  assert.doesNotMatch(get, /GetDlgItemText/);

  const controlFind = bodyBetween(source, 'static BOOL FAR PASCAL EnumCtrlFindProc',
    'static BOOL parse_control_findid');
  ordered(controlFind, 'if (!GetClassName', 'cf_inspection_failed = TRUE',
    'if (cf_class[0]', 'if (cf_text[0])', 'GetWindowText(hwnd');
  const control = bodyBetween(source, 'static void cmd_control',
    '/* ============================================================ */\n/* LIST SELECT');
  const find = bodyBetween(control, '} else if (prefix(arg, "FIND "))',
    '} else {');
  ordered(find, 'cf_inspection_failed = FALSE', 'EnumChildWindows',
    'if (cf_inspection_failed)', 'ERR CONTROL_INSPECTION', 'else if (cf_found)');

  for (const [start, end, copy] of [
    ['static void cmd_waitfor', 'static void cmd_expect', 'next_word(p, text'],
    ['static void cmd_expect', 'static BOOL load_hook_dll', 'lstrcpyn(text, p'],
  ]) {
    const command = bodyBetween(source, start, end);
    ordered(command, 'GetDlgItem(hwnd, id)', 'ERR NOT_FOUND', copy,
      'GetWindowText(ctrl');
    assert.match(command, /if \(!ctrl\) \{ write_response\("ERR NOT_FOUND"\); return; \}/);
    assert.doesNotMatch(command, /GetDlgItemText/);
    if (start === 'static void cmd_waitfor') {
      ordered(command, 'start = GetTickCount()', 'do {', 'GetWindowText(ctrl',
        '} while (GetTickCount() - start < timeout_ms)');
      const pollingLoop = bodyBetween(command, 'do {',
        '} while (GetTickCount() - start < timeout_ms)');
      ordered(pollingLoop, 'GetDlgItem(hwnd, id)',
        'if (!ctrl) { write_response("ERR NOT_FOUND"); return; }',
        'GetWindowText(ctrl');
    }
  }
}

const contract = checkedContract();
const repoRoot = path.resolve(__dirname, '..');
assert.deepEqual(Object.keys(contract.tools), ['DOSMCP', 'WINMCP']);
for (const [name, tool] of Object.entries(contract.tools)) {
  const digest = sourceDigest(tool.paths);
  assert.match(digest, /^[0-9a-f]{64}$/);
  const expected = renderedIdentity(name, tool.macro, digest);
  assert.match(expected, new RegExp(tool.macro));
  assert.equal(fs.readFileSync(path.join(repoRoot, tool.output), 'utf8'), expected);
  const staleDigest = `${digest[0] === '0' ? '1' : '0'}${digest.slice(1)}`;
  const staleOutput = renderedIdentity(name, tool.macro, staleDigest);
  assert.notEqual(staleOutput, expected);
  assert.notEqual(fs.readFileSync(path.join(repoRoot, tool.output), 'utf8'), staleOutput);
  assert.throws(() => verifyTrackedBinaries(name, tool, staleDigest), /current build identity/);
  verifyTrackedBinaries(name, tool, digest);
}
const winSource = fs.readFileSync(path.join(repoRoot, 'win-mcp/src/winmcp.c'), 'utf8');
verifyAuditRollbackSource(winSource);
verifyControlInspectionSource(winSource);
for (const mutant of [
  winSource.replace(
    'restored = restore_memory(selector, offset, before_write_buf, byteCount);',
    'restored = TRUE;'),
  winSource.replace('bytesVerified = MemoryRead(selector, offset, restore_verify_buf, byteCount);',
    'bytesVerified = byteCount;'),
  winSource.replace('_fmemcmp(original, restore_verify_buf, byteCount) == 0', 'TRUE'),
]) {
  assert.throws(() => verifyAuditRollbackSource(mutant));
}
for (const mutant of [
  winSource.replace('if (!GetClassName(hwnd, cls, sizeof(cls))) {',
    'if (FALSE) {'),
  winSource.replace('dl_truncated = TRUE;', 'dl_truncated = FALSE;'),
  winSource.replace('ctrl = GetDlgItem(hwnd, id);', 'ctrl = NULL;'),
  winSource.replace('cf_inspection_failed = TRUE;', 'cf_inspection_failed = FALSE;'),
  winSource.replace('cf_inspection_failed = FALSE;', 'cf_inspection_failed = TRUE;'),
  winSource.replace('GetWindowText(ctrl, actual, sizeof(actual));',
    'GetDlgItemText(hwnd, id, actual, sizeof(actual));'),
  winSource.replace('if (dl_inspection_failed) {', 'if (FALSE) {'),
  winSource.replace('if (dl_truncated) {', 'if (FALSE) {'),
  winSource.replaceAll('if (!ctrl) { write_response("ERR NOT_FOUND"); return; }',
    'if (FALSE) { write_response("ERR NOT_FOUND"); return; }'),
  winSource.replace('do {\n        ctrl = GetDlgItem(hwnd, id);',
    'while (GetTickCount() - start < timeout_ms) {\n        ctrl = GetDlgItem(hwnd, id);'),
  winSource.replace(
    'do {\n        ctrl = GetDlgItem(hwnd, id);\n' +
      '        if (!ctrl) { write_response("ERR NOT_FOUND"); return; }\n' +
      '        GetWindowText(ctrl, actual, sizeof(actual));',
    'do {\n        GetWindowText(ctrl, actual, sizeof(actual));'),
]) {
  assert.throws(() => verifyControlInspectionSource(mutant));
}
const winMakefile = fs.readFileSync(path.join(repoRoot, 'win-mcp/src/Makefile'), 'utf8');
assert.match(winMakefile, /\$\(DLL_OBJ\): \$\(DLL_SRC\) Makefile/);
assert.match(winMakefile, /\$\(DLL_OUT\): \$\(DLL_OBJ\) Makefile/);
console.log('Guest-tool identity contract tests passed');
