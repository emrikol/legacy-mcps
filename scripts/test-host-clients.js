#!/usr/bin/env node

'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
for (const script of [
  'test-public-source-closure.js',
  'test-host-command-lease.js',
  'test-mcp-mailbox.js',
  'test-guest-identity-client.js',
  'test-dos-mcp-client.js',
  'test-dosbox-control.js',
  'test-dosbox-debugger.js',
  'test-dosbox-reverse.js',
  'test-win-auto-api.js',
  'test-win-session.js',
  'test-win-sequence.js',
  'test-win-auto-cli.js',
  'test-win-memory-snapshot.js',
]) {
  execFileSync(process.execPath, [path.join(__dirname, script)], {
    cwd: root, stdio: 'inherit', timeout: 30000,
    env: { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  });
}
console.log('All generic host-client tests passed');
