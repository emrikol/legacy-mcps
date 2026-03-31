#!/usr/bin/env node

/**
 * Minesweeper Automation Demo
 *
 * Launches Minesweeper inside Windows 3.1 (running in DOSBox-X),
 * starts a new Beginner game, clicks the four corners, and exits.
 *
 * This demonstrates win-auto.js doing real GUI automation:
 * - Launching a program and waiting for its window
 * - Restoring a minimized window
 * - Sending menu commands
 * - Clicking at specific grid coordinates
 * - Taking screenshots between actions
 * - Closing the application
 *
 * Prerequisites:
 *   - DOSBox-X running Windows 3.1 with WINMCP.EXE active
 *   - Minesweeper (WINMINE.EXE) installed in C:\WINDOWS
 *
 * Usage:
 *   node examples/minesweeper.js [--magic-dir <path>]
 */

'use strict';

const { WinAuto } = require('../lib/win-auto');
const path = require('path');

const magicIdx = process.argv.indexOf('--magic-dir');
const magicDir = magicIdx >= 0
  ? process.argv[magicIdx + 1]
  : path.resolve(__dirname, '..', 'share', '_MAGIC_');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const win = new WinAuto({ magicDir, timeout: 10000 });

  console.log('Connecting to WIN-MCP...');
  await win.waitForReady();
  console.log('Connected.\n');

  // -- Launch Minesweeper --
  console.log('Launching Minesweeper...');
  await win.ok('EXEC WINMINE.EXE');
  await sleep(1000);

  // Find the window — it may launch minimized, so restore it
  const ms = await win.waitForWindow('Minesweeper', 5000);
  await ms.restore();
  await sleep(500);
  await ms.focus();
  await sleep(500);

  // Position the window so it's fully visible
  const rect = await ms.rect();
  await ms.move(100, 50, rect.width, rect.height);
  await sleep(500);
  console.log(`  Window: hwnd=${ms.hwnd}, ${rect.width}x${rect.height}\n`);

  // -- Start a new Beginner game --
  // Menu IDs for Windows 3.1 Minesweeper:
  //   521 = Beginner, 522 = Intermediate, 523 = Expert, 510 = New Game
  console.log('Starting Beginner game...');
  await ms.menuCommand(521);   // Game > Beginner
  await sleep(500);
  await ms.menuCommand(510);   // Game > New
  await sleep(500);

  // Screenshot the fresh board
  await win.capture(ms);
  console.log('  Fresh board captured.\n');

  // -- Click the four corners --
  // Beginner board: 8x8 grid, 10 mines
  // Grid position in client coordinates:
  //   Left edge:  ~13px from window left
  //   Top edge:   ~55px from client top (below menu + counter/smiley)
  //   Cell size:  16x16 pixels
  const gridLeft = 13;
  const gridTop = 55;
  const cellSize = 16;

  const corners = [
    { name: 'top-left',     col: 0, row: 0 },
    { name: 'top-right',    col: 7, row: 0 },
    { name: 'bottom-left',  col: 0, row: 7 },
    { name: 'bottom-right', col: 7, row: 7 },
  ];

  console.log('Clicking corners...');
  for (const corner of corners) {
    const x = gridLeft + corner.col * cellSize + 8;  // center of cell
    const y = gridTop + corner.row * cellSize + 8;
    console.log(`  ${corner.name} → cell(${corner.col},${corner.row}) at client(${x}, ${y})`);
    await ms.click(x, y);
    await sleep(500);
  }

  // Screenshot the result
  console.log('');
  await win.capture(ms);
  console.log('  Result captured.\n');

  // -- Close Minesweeper --
  console.log('Closing Minesweeper...');
  await ms.close();
  await sleep(500);
  // Dismiss any "best time" dialog if it appears
  try { await win.abort(); } catch (_) {}
  await sleep(500);

  console.log('Done!');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
