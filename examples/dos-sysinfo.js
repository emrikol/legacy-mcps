#!/usr/bin/env node

/**
 * DOS MCP — System Info Demo
 *
 * Connects to a running DOSMCP.COM TSR and queries system information:
 * version, free memory, running TSRs, and current directory.
 *
 * This uses the source-identity-verified, serialized DOSMCP host client.
 *
 * Prerequisites:
 *   DOSMCP.COM must be running in TSR mode (DOSMCP.COM Z: /T) with
 *   Z: mapped to the share/ directory.
 *
 * Usage:
 *   node examples/dos-sysinfo.js [--magic-dir <path>]
 */

'use strict';

const path = require('path');
const { withDosMcpClient } = require('../lib/dos-mcp');

const magicIdx = process.argv.indexOf('--magic-dir');
const MAGIC_DIR = magicIdx >= 0
  ? path.resolve(process.argv[magicIdx + 1])
  : path.resolve(__dirname, '..', 'share', '_MAGIC_');

async function main() {
  await withDosMcpClient({ magicDir: MAGIC_DIR }, async client => {
    const version = await client.send('META VERSION');
    console.log('Version:', version.replace(/^OK /, ''));

    const sysInfo = await client.send('SYS INFO');
    console.log('\nSystem info:');
    for (const line of sysInfo.replace(/^OK /, '').split(' ')) {
      console.log(' ', line);
    }

    const memFree = await client.send('MEM FREE');
    console.log('\nConventional memory free:', memFree.replace(/^OK /, ''), 'bytes');

    const tsrs = await client.send('TSR LIST');
    console.log('\nResident programs:');
    for (const line of tsrs.replace(/^OK\n?/, '').split('\n')) {
      if (line.trim()) console.log(' ', line.trim());
    }

    const cwd = await client.send('DIR GET');
    console.log('\nCurrent directory:', cwd.replace(/^OK /, ''));
  });
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
