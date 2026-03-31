#!/usr/bin/env node

/**
 * Notepad Demo
 *
 * Opens Notepad inside Windows 3.1, types a message, reads it back via the
 * clipboard, captures a screenshot, and closes the window.
 *
 * This is a minimal win-auto.js example showing the basics:
 * - Waiting for the agent to be ready
 * - Launching a program and getting a window handle
 * - Typing text into a control
 * - Reading content via the clipboard
 * - Taking a screenshot
 * - Closing the window
 *
 * Prerequisites:
 *   - DOSBox-X running Windows 3.1 with WINMCP.EXE active
 *
 * Usage:
 *   node examples/notepad.js [--magic-dir <path>]
 */

'use strict';

const { WinAuto } = require('../lib/win-auto');
const path = require('path');

const magicIdx = process.argv.indexOf('--magic-dir');
const magicDir = magicIdx >= 0
  ? process.argv[magicIdx + 1]
  : path.resolve(__dirname, '..', 'share', '_MAGIC_');

async function main() {
  const win = new WinAuto({ magicDir, timeout: 10000 });

  console.log('Connecting to WIN-MCP...');
  await win.waitForReady();
  console.log('Connected.\n');

  // Launch Notepad and wait for its window
  console.log('Launching Notepad...');
  const notepad = await win.exec('NOTEPAD.EXE');
  console.log(`Window: hwnd=${notepad.hwnd}\n`);

  // Type a message into the edit area
  const message = 'Hello from win-auto.js!';
  console.log(`Typing: "${message}"`);
  await notepad.type(message);

  // Select all and copy to clipboard, then read it back
  await notepad.selectAll();
  await notepad.copy();
  const clip = await win.getClipboard();
  console.log('Clipboard:', clip.replace(/^OK /, ''));

  // Capture a screenshot of the active window
  console.log('\nCapturing screenshot...');
  await win.capture(notepad.hwnd);
  console.log('Saved to win-mcp/capture/');

  // Close Notepad — dismiss the "Save changes?" dialog without saving
  console.log('\nClosing Notepad...');
  await notepad.close();
  await win.ok(`ABORT`);   // dismiss "Save changes?" dialog

  console.log('Done.');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
