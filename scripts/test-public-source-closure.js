#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const publicInventory = [
  'CLAUDE.md', 'README.md', 'SCRIPTING.md', 'PATCHES.md',
  'bin', 'lib', 'examples', 'scripts', 'patches',
  'dos-mcp', 'win-mcp', 'smb-share',
];

const listed = execFileSync('git', [
  'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...publicInventory,
], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const files = [...new Set(listed.split('\0').filter(Boolean))].sort();
if (!files.length) throw new Error('Public source inventory is empty');

/* Keep the forbidden private names out of this gate's own tracked bytes too. */
const forbidden = [
  ['product name', new RegExp('(^|[^A-Za-z0-9])' + 'sta' + 'rs!?' + '(?=$|[^A-Za-z0-9])', 'i')],
  ['private build variable', new RegExp('ST' + 'ARS_DOSMCP_BUILD_ID')],
  ['private bridge name', new RegExp('legacy-' + 'sta' + 'rs', 'i')],
  ['private project directory', new RegExp('sta' + 'rs-re', 'i')],
  ['private macOS home path', new RegExp('/' + 'Users/(?!Shared(?:/|$))[^/\\s]+(?:/|$)', 'i')],
  ['private session path', new RegExp('claude-' + 'sessions', 'i')],
  ['private command wrapper', new RegExp('(^|[^A-Za-z0-9])' + 'r' + 'tk' + '(?=$|[^A-Za-z0-9])')],
];

const failures = [];
for (const relative of files) {
  const absolute = path.join(root, relative);
  const status = fs.lstatSync(absolute);
  if (!status.isFile()) {
    failures.push(`${relative}: public inventory member is not a regular file`);
    continue;
  }
  const content = fs.readFileSync(absolute).toString('latin1');
  for (const [label, pattern] of forbidden) {
    const match = pattern.exec(content);
    if (match) failures.push(`${relative}: byte ${match.index}: forbidden ${label}`);
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`Public source closure verified (${files.length} files)`);
