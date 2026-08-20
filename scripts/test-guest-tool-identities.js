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
const winMakefile = fs.readFileSync(path.join(repoRoot, 'win-mcp/src/Makefile'), 'utf8');
assert.match(winMakefile, /\$\(DLL_OBJ\): \$\(DLL_SRC\) Makefile/);
assert.match(winMakefile, /\$\(DLL_OUT\): \$\(DLL_OBJ\) Makefile/);
console.log('Guest-tool identity contract tests passed');
