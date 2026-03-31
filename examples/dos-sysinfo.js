#!/usr/bin/env node

/**
 * DOS MCP — System Info Demo
 *
 * Connects to a running DOSMCP.COM TSR and queries system information:
 * version, free memory, running TSRs, and current directory.
 *
 * This shows the raw file-IPC pattern for DOS MCP. (There is no high-level
 * library for DOS MCP — commands go directly over the IPC channel.)
 *
 * Prerequisites:
 *   DOSMCP.COM must be running in TSR mode (DOSMCP.COM Z: /T) with
 *   Z: mapped to the share/ directory.
 *
 * Usage:
 *   node examples/dos-sysinfo.js [--magic-dir <path>]
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const magicIdx = process.argv.indexOf('--magic-dir');
const MAGIC_DIR = magicIdx >= 0
  ? path.resolve(process.argv[magicIdx + 1])
  : path.resolve(__dirname, '..', 'share', '_MAGIC_');

const POLL_MS  = 150;
const TIMEOUT  = 10000;

function findFile(base) {
  const u = path.join(MAGIC_DIR, base.toUpperCase());
  const l = path.join(MAGIC_DIR, base.toLowerCase());
  if (fs.existsSync(l)) return l;
  if (fs.existsSync(u)) return u;
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function send(command) {
  const tmpPath = path.join(MAGIC_DIR, '__mcp__.tw');
  const txPath  = path.join(MAGIC_DIR, '__mcp__.tx');
  const rxBase  = '__MCP__.RX';

  // Remove any stale RX
  const staleRx = findFile(rxBase);
  if (staleRx) fs.unlinkSync(staleRx);

  // Atomic write
  fs.writeFileSync(tmpPath, command + '\r\n');
  fs.renameSync(tmpPath, txPath);

  // Wait for response
  const deadline = Date.now() + TIMEOUT;
  while (Date.now() < deadline) {
    const rx = findFile(rxBase);
    if (rx) {
      const resp = fs.readFileSync(rx, 'utf8').trim();
      fs.unlinkSync(rx);
      return resp;
    }
    await sleep(POLL_MS);
  }
  throw new Error(`Timeout waiting for response to: ${command}`);
}

async function waitForReady() {
  process.stdout.write('Waiting for DOS MCP...');
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const st = findFile('__MCP__.ST');
    if (st) {
      const content = fs.readFileSync(st, 'utf8').trim();
      if (content === 'READY') {
        process.stdout.write(' ready.\n');
        return;
      }
    }
    await sleep(POLL_MS);
    process.stdout.write('.');
  }
  throw new Error('DOS MCP did not become ready within 30 seconds');
}

async function main() {
  fs.mkdirSync(MAGIC_DIR, { recursive: true });

  await waitForReady();

  const version = await send('META VERSION');
  console.log('Version:', version.replace(/^OK /, ''));

  const sysInfo = await send('SYS INFO');
  console.log('\nSystem info:');
  for (const line of sysInfo.replace(/^OK /, '').split(' ')) {
    console.log(' ', line);
  }

  const memFree = await send('MEM FREE');
  console.log('\nConventional memory free:', memFree.replace(/^OK /, ''), 'bytes');

  const tsrs = await send('TSR LIST');
  console.log('\nResident programs:');
  for (const line of tsrs.replace(/^OK\n?/, '').split('\n')) {
    if (line.trim()) console.log(' ', line.trim());
  }

  const cwd = await send('DIR GET');
  console.log('\nCurrent directory:', cwd.replace(/^OK /, ''));
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
