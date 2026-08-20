/**
 * win-auto.js — Windows 3.x Automation Library
 *
 * A Playwright-inspired async API for automating Windows 3.x applications
 * running inside DOSBox-X via the WIN-MCP agent.
 *
 * Usage:
 *   const { WinAuto } = require('./win-auto');
 *   const win = new WinAuto({ magicDir: '../share/_MAGIC_' });
 *   await win.waitForReady();
 *   const notepad = await win.exec('NOTEPAD.EXE');
 *   await notepad.type('Hello World');
 *
 * @module win-auto
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { compareBmp } = require('./win-compare');
const { DosboxControl } = require('./dosbox-control');

// ============================================================
// Helpers
// ============================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function findFile(dir, baseName) {
  const upper = path.join(dir, baseName.toUpperCase());
  const lower = path.join(dir, baseName.toLowerCase());
  if (fs.existsSync(lower)) return lower;
  if (fs.existsSync(upper)) return upper;
  return null;
}

// ============================================================
// WinAuto — main automation controller
// ============================================================

class WinAuto {
  /**
   * @param {object} opts
   * @param {string} opts.magicDir - Path to _MAGIC_ directory for file IPC
   * @param {number} [opts.pollMs=150] - Polling interval in ms
   * @param {number} [opts.timeout=10000] - Default command timeout in ms
   */
  constructor(opts = {}) {
    this.magicDir = opts.magicDir || path.resolve(__dirname, '..', 'share', '_MAGIC_');
    this.pollMs = opts.pollMs || 150;
    this.timeout = opts.timeout || 10000;
    this._channelPoisoned = false;

    if (!fs.existsSync(this.magicDir)) {
      fs.mkdirSync(this.magicDir, { recursive: true });
    }
  }

  // ----------------------------------------------------------
  // Low-level IPC
  // ----------------------------------------------------------

  /** Send a raw command string and return the raw response. */
  async send(command, timeout) {
    if (this._channelPoisoned) {
      throw new Error('WIN-MCP channel is poisoned after a timed-out command; destroy the disposable session before sending another command');
    }
    timeout = timeout || this.timeout;

    // Clean up any stale RX
    this._deleteRx();

    // Atomic write: temp file → rename to TX
    const txFile = path.join(this.magicDir, '__win__.tx');
    const tmpFile = path.join(this.magicDir, '__win__.tw');
    fs.writeFileSync(tmpFile, command + '\r\n');
    fs.renameSync(tmpFile, txFile);

    // Poll for response
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const rx = findFile(this.magicDir, '__WIN__.RX');
      if (rx) {
        try {
          let content = fs.readFileSync(rx, 'utf8').trim();
          if (content.length > 0) {
            try { fs.unlinkSync(rx); } catch (_) {}
            // Handle long response overflow
            if (content === 'OK @LR') {
              const lr = findFile(this.magicDir, '__WIN__.LR');
              if (lr) {
                try {
                  content = fs.readFileSync(lr, 'utf8').trim();
                  fs.unlinkSync(lr);
                } catch (_) {}
              }
            }
            return content;
          }
        } catch (_) {}
      }
      await sleep(this.pollMs);
    }
    /* A timed-out command may still publish its response later. Reusing this
     * single FIFO could consume that stale response as the result of the next
     * command, so fail closed for the remainder of the process/session. */
    this._channelPoisoned = true;
    throw new Error(`Timeout after ${timeout}ms waiting for response to: ${command}; WIN-MCP channel is now poisoned`);
  }

  /** Send a command and assert it returns OK. Returns the part after "OK ". */
  async ok(command, timeout) {
    const resp = await this.send(command, timeout);
    if (!resp.startsWith('OK')) {
      throw new Error(`Command failed: ${command}\nResponse: ${resp}`);
    }
    return resp.slice(3); // strip "OK " prefix
  }

  _deleteRx() {
    for (const name of ['__WIN__.RX', '__win__.rx']) {
      try { fs.unlinkSync(path.join(this.magicDir, name)); } catch (_) {}
    }
  }

  // ----------------------------------------------------------
  // Lifecycle
  // ----------------------------------------------------------

  /** Wait for WIN-MCP to signal READY, then verify with a PING. */
  async waitForReady(timeout) {
    timeout = timeout === undefined ? 30000 : timeout;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60000) {
      throw new Error('WIN-MCP readiness timeout must be a safe integer from 1 through 60000ms');
    }
    const start = Date.now();
    let markerObserved = false;
    while (Date.now() - start < timeout) {
      const st = findFile(this.magicDir, '__WIN__.ST');
      if (st) {
        markerObserved = true;
        let content;
        try {
          content = fs.readFileSync(st, 'utf8').trim();
        } catch (cause) {
          throw new Error('WIN-MCP readiness marker could not be read', { cause });
        }
        if (content !== 'READY') {
          throw new Error(`WIN-MCP readiness marker is malformed: ${JSON.stringify(content)}`);
        }
        let pong;
        try {
          /* send() poisons the FIFO after a timeout. Never retry on this
           * instance: a late RX belongs to this first PING. */
          const remaining = timeout - (Date.now() - start);
          if (remaining < 1) {
            throw new Error('WIN-MCP READY marker was not responsive before the readiness deadline');
          }
          pong = await this.send('META PING', Math.min(5000, remaining));
        } catch (cause) {
          throw new Error(`WIN-MCP READY marker PING failed: ${cause.message}`, { cause });
        }
        if (pong !== 'OK PONG') {
          throw new Error(`WIN-MCP READY marker PING returned malformed response: ${JSON.stringify(pong)}`);
        }
        return this;
      }
      await sleep(this.pollMs);
    }
    if (!markerObserved) {
      throw new Error(`WIN-MCP readiness marker did not appear within ${timeout}ms`);
    }
    throw new Error('WIN-MCP readiness failed without a classified marker state');
  }

  /** Ping the agent. */
  async ping() {
    const resp = await this.ok('META PING');
    return resp === 'PONG';
  }

  /** Get version string. */
  async version() {
    return this.ok('META VERSION');
  }

  /** Shut down WIN-MCP cleanly. */
  async quit() {
    return this.send('META QUIT');
  }

  // ----------------------------------------------------------
  // Program launching
  // ----------------------------------------------------------

  /**
   * Launch a program and return a Window handle.
   * Waits for a window with the given title to appear.
   *
   * @param {string} program - Program to launch (e.g., 'NOTEPAD.EXE')
   * @param {object} [opts]
   * @param {string} [opts.waitFor] - Window title substring to wait for
   * @param {number} [opts.timeout=10000] - How long to wait for window
   * @returns {Promise<Window>}
   */
  async exec(program, opts = {}) {
    await this.ok(`EXEC ${program}`);

    if (opts.waitFor !== undefined) {
      const title = opts.waitFor === true ? program.replace(/\.EXE$/i, '') : opts.waitFor;
      return this.waitForWindow(title, opts.timeout);
    }

    // Default: wait for a window matching the program name (without .EXE)
    const title = program.replace(/\.EXE$/i, '');
    return this.waitForWindow(title, opts.timeout);
  }

  // ----------------------------------------------------------
  // Window finding and waiting
  // ----------------------------------------------------------

  /**
   * Find a window by class name. Returns a Window or null.
   * @param {string} className - Window class name (e.g., 'Notepad')
   * @returns {Promise<Window|null>}
   */
  async findWindow(className) {
    const resp = await this.send(`WINDOW FIND ${className}`);
    if (resp.startsWith('ERR')) return null;
    const hwnd = resp.slice(3).trim();
    return new Window(this, hwnd);
  }

  /**
   * Wait for a window with a title substring to appear.
   * @param {string} title - Title substring to match
   * @param {number} [timeout=10000]
   * @returns {Promise<Window>}
   */
  async waitForWindow(title, timeout) {
    timeout = timeout || this.timeout;
    const hwnd = await this.ok(`WAIT WINDOW ${title} ${timeout}`, timeout + 2000);
    return new Window(this, hwnd.trim());
  }

  /**
   * Wait for a window to be destroyed.
   * @param {string|Window} target - hwnd string or Window instance
   * @param {number} [timeout=10000]
   */
  async waitForClose(target, timeout) {
    timeout = timeout || this.timeout;
    const hwnd = target instanceof Window ? target.hwnd : target;
    await this.ok(`WAIT GONE ${hwnd} ${timeout}`, timeout + 2000);
  }

  /**
   * List all top-level windows.
   * @returns {Promise<Array<{hwnd: string, className: string, title: string}>>}
   */
  async listWindows() {
    const resp = await this.ok('WINDOW LIST');
    if (!resp.trim()) return [];
    return resp.trim().split(' ').map(entry => {
      const [hwnd, className, ...titleParts] = entry.split(':');
      return { hwnd, className, title: titleParts.join(':') };
    });
  }

  // ----------------------------------------------------------
  // Screen capture
  // ----------------------------------------------------------

  /**
   * Capture a screenshot.
   * @param {string|Window} [target] - 'desktop', 'active', or a Window
   * @returns {Promise<string>} Path to BMP file
   */
  async capture(target, timeout) {
    let cmd = 'GDI CAPTURE';
    if (target === 'active') cmd = 'GDI CAPTURE ACTIVE';
    else if (target instanceof Window) cmd = `GDI CAPTURE ${target.hwnd}`;
    else if (target && target !== 'desktop') cmd = `GDI CAPTURE ${target}`;
    /* Win16 capture converts the bitmap through one emulated GetPixel call per
     * pixel. Large windows can legitimately exceed the general IPC timeout. */
    return this.ok(cmd, timeout || 60000);
  }

  /**
   * Capture a screenshot and compare against a reference BMP.
   * @param {string} referencePath - Path to reference BMP file
   * @param {object} [opts]
   * @param {string|Window} [opts.target] - What to capture (default: desktop)
   * @param {number} [opts.threshold=0.95] - Similarity threshold (0.0 to 1.0)
   * @param {number} [opts.pixelTolerance=0] - Per-channel tolerance (0-255)
   * @returns {Promise<{match: boolean, similarity: number, ...}>}
   */
  async compareScreenshot(referencePath, opts = {}) {
    await this.capture(opts.target);
    await sleep(300);
    const bmpPath = findFile(this.magicDir, '__WIN__.BMP');
    if (!bmpPath) throw new Error('Screenshot not found after capture');
    return compareBmp(referencePath, bmpPath, {
      threshold: opts.threshold,
      pixelTolerance: opts.pixelTolerance,
    });
  }

  /** Get screen resolution and color depth. */
  async screen() {
    const resp = await this.ok('GDI SCREEN');
    const m = resp.match(/W=(\d+) H=(\d+) BPP=(\d+)/);
    return m ? { width: +m[1], height: +m[2], bpp: +m[3] } : null;
  }

  // ----------------------------------------------------------
  // Clipboard
  // ----------------------------------------------------------

  async getClipboard() {
    return this.ok('CLIP GET');
  }

  async setClipboard(text) {
    await this.ok(`CLIP SET ${text}`);
  }

  // ----------------------------------------------------------
  // Task management
  // ----------------------------------------------------------

  /**
   * List running tasks.
   * @returns {Promise<Array<{htask: string, module: string}>>}
   */
  async listTasks() {
    const resp = await this.ok('TASK LIST');
    if (!resp.trim()) return [];
    return resp.trim().split(' ').map(entry => {
      const [htask, module] = entry.split(':');
      return { htask, module };
    });
  }

  async killTask(htask) {
    await this.ok(`TASK KILL ${htask}`);
  }

  // ----------------------------------------------------------
  // DDE
  // ----------------------------------------------------------

  async ddeConnect(service, topic) {
    const hconv = await this.ok(`DDE CONNECT ${service} ${topic}`);
    return hconv.trim();
  }

  async ddeExec(command) {
    await this.ok(`DDE EXEC ${command}`);
  }

  async ddeClose() {
    await this.ok('DDE CLOSE');
  }

  // ----------------------------------------------------------
  // Modal dialog recovery
  // ----------------------------------------------------------

  /** Dismiss the foreground modal dialog by sending IDCANCEL. */
  async abort() {
    return this.send('ABORT');
  }

  // ----------------------------------------------------------
  // Recording / Playback (requires WINMCHK.DLL)
  // ----------------------------------------------------------

  /** Start recording input events via WH_JOURNALRECORD. */
  async recordStart() {
    await this.ok('RECORD START');
  }

  /** Stop recording. Returns number of events captured. */
  async recordStop() {
    const resp = await this.ok('RECORD STOP');
    return +resp.trim();
  }

  /** Save recorded events to a binary file. */
  async recordSave(filePath) {
    const resp = await this.ok(`RECORD SAVE ${filePath}`);
    return +resp.trim();
  }

  /** Play back events from a file. Speed: 100=normal, 50=half, 200=double. */
  async play(filePath, speed) {
    speed = speed || 100;
    const resp = await this.ok(`PLAY ${filePath} ${speed}`);
    return +resp.trim();
  }

  /** Stop playback. */
  async playStop() {
    await this.ok('PLAY STOP');
  }

  /** Get playback status: 'IDLE', 'RECORDING', or 'PLAYING n/total'. */
  async playStatus() {
    return this.ok('PLAY STATUS');
  }

  // ----------------------------------------------------------
  // Mouse (screen-level, not window-targeted)
  // ----------------------------------------------------------

  async mouseMove(x, y) {
    await this.ok(`MOUSE MOVE ${x} ${y}`);
  }

  async mouseGetPos() {
    const resp = await this.ok('MOUSE GETPOS');
    const [x, y] = resp.trim().split(' ').map(Number);
    return { x, y };
  }

  // ----------------------------------------------------------
  // DOSBox-X Control Server (host-side emulator control)
  // ----------------------------------------------------------

  /**
   * Send a command to the DOSBox-X control server via TCP.
   * Requires DOSBox-X started with DOSBOX_CONTROL_PORT env var.
   *
   * @param {string} command - e.g., 'PING', 'SCREEN', 'SCREENSHOT'
   * @param {object} [opts]
   * @param {number} [opts.port=10199] - Control server port
   * @param {string} [opts.host='127.0.0.1'] - Control server host
   * @param {number} [opts.timeout=5000] - TCP timeout in ms
   * @returns {Promise<string>} Response from DOSBox-X
   */
  async dosboxCommand(command, opts = {}) {
    return new DosboxControl(opts).send(command, opts);
  }

  /** Ping the DOSBox-X control server. */
  async dosboxPing(opts) {
    const resp = await this.dosboxCommand('PING', opts);
    return resp.includes('PONG');
  }

  /** Read the DOSBox-X text-mode screen buffer (80x25). */
  async dosboxScreen(opts) {
    return this.dosboxCommand('SCREEN', opts);
  }

  /** Take a DOSBox-X screenshot (saved as PNG in capture dir). */
  async dosboxScreenshot(opts) {
    return this.dosboxCommand('SCREENSHOT', opts);
  }

  /** Type text into DOSBox-X via keyboard simulation. */
  async dosboxType(text, opts) {
    return this.dosboxCommand(`TYPE ${text}`, opts);
  }

  /** Send a special key to DOSBox-X (ENTER, ESC, F1-F12, etc.). */
  async dosboxKey(key, opts) {
    return this.dosboxCommand(`KEY ${key}`, opts);
  }

  /** Get DOSBox-X status. */
  async dosboxStatus(opts) {
    return this.dosboxCommand('STATUS', opts);
  }

  /** Read the source-derived DOSBox-X build and debugger capability identity. */
  async dosboxIdentity(opts) {
    return this.dosboxCommand('IDENTITY', opts);
  }

  /** Minimize the DOSBox-X host window. */
  async dosboxMinimize(opts) {
    return this.dosboxCommand('MINIMIZE', opts);
  }

  /** Execute one remote debugger command on the emulator thread. */
  async dosboxDebug(command, opts) {
    return new DosboxControl(opts).debug(command, opts);
  }

  /** Execute 1-8 non-resuming debugger commands as one stopped-CPU batch. */
  async dosboxDebugBatch(commands, opts) {
    return new DosboxControl(opts).debugBatch(commands, opts);
  }
}

// ============================================================
// Window — handle to a specific window
// ============================================================

class Window {
  /**
   * @param {WinAuto} auto - Parent automation controller
   * @param {string} hwnd - Window handle (4-digit hex)
   */
  constructor(auto, hwnd) {
    this.auto = auto;
    this.hwnd = hwnd;
  }

  /** Re-fetch this window's title. */
  async title() {
    return this.auto.ok(`WINDOW TITLE ${this.hwnd}`);
  }

  /** Get window rectangle {x, y, width, height}. */
  async rect() {
    const resp = await this.auto.ok(`WINDOW RECT ${this.hwnd}`);
    const [x, y, w, h] = resp.trim().split(' ').map(Number);
    return { x, y, width: w, height: h };
  }

  /** Check if window is visible. */
  async isVisible() {
    const resp = await this.auto.ok(`WINDOW VISIBLE ${this.hwnd}`);
    return resp.trim() === 'TRUE';
  }

  /** Check if window is enabled. */
  async isEnabled() {
    const resp = await this.auto.ok(`WINDOW ENABLED ${this.hwnd}`);
    return resp.trim() === 'TRUE';
  }

  /** Move and resize the window. */
  async move(x, y, width, height) {
    await this.auto.ok(`WINDOW MOVE ${this.hwnd} ${x} ${y} ${width} ${height}`);
    return this;
  }

  /** Show, hide, minimize, maximize, or restore. */
  async show(cmd) {
    await this.auto.ok(`WINDOW SHOW ${this.hwnd} ${cmd}`);
    return this;
  }

  async hide() { return this.show('HIDE'); }
  async minimize() { return this.show('MIN'); }
  async maximize() { return this.show('MAX'); }
  async restore() { return this.show('RESTORE'); }

  /** Bring to front and set input focus. */
  async focus() {
    await this.auto.ok(`FOCUS ${this.hwnd}`);
    return this;
  }

  /** Close the window (sends WM_CLOSE). */
  async close() {
    await this.auto.ok(`WINDOW CLOSE ${this.hwnd}`);
  }

  // ----------------------------------------------------------
  // Child window locator (Playwright-style)
  // ----------------------------------------------------------

  /**
   * Find a child control by class and/or text.
   * Use '*' as wildcard for either parameter.
   *
   * @param {string} className - Child window class (e.g., 'Edit', 'Button', '*')
   * @param {string} [text='*'] - Text to match (substring, case-insensitive)
   * @returns {Promise<Window>}
   */
  async locator(className, text) {
    text = text || '*';
    const hwnd = await this.auto.ok(`CONTROL FIND ${this.hwnd} ${className} ${text}`);
    return new Window(this.auto, hwnd.trim());
  }

  // ----------------------------------------------------------
  // Text input
  // ----------------------------------------------------------

  /**
   * Type text into this window via WM_CHAR.
   * Supports escape sequences: \n (Enter), \t (Tab), \e (Escape).
   *
   * @param {string} text
   */
  async type(text) {
    await this.auto.ok(`TYPE ${this.hwnd} ${text}`);
    return this;
  }

  /**
   * Send key sequence with modifiers.
   * Tokens: {CTRL}, {ALT}, {SHIFT}, {ENTER}, {TAB}, {ESC},
   *         {F1}-{F12}, {UP}, {DOWN}, {LEFT}, {RIGHT},
   *         {BACKSPACE}, {DELETE}, {HOME}, {END}, {PGUP}, {PGDN}
   *
   * @param {string} keys - e.g., '{CTRL}a', '{ALT}{F4}'
   */
  async sendKeys(keys) {
    await this.auto.ok(`SENDKEYS ${this.hwnd} ${keys}`);
    return this;
  }

  /** Select all text (Ctrl+A). */
  async selectAll() { return this.sendKeys('{CTRL}a'); }

  /** Copy selection (Ctrl+C). */
  async copy() { return this.sendKeys('{CTRL}c'); }

  /** Paste from clipboard (Ctrl+V). */
  async paste() { return this.sendKeys('{CTRL}v'); }

  /** Cut selection (Ctrl+X). */
  async cut() { return this.sendKeys('{CTRL}x'); }

  /** Undo (Ctrl+Z). */
  async undo() { return this.sendKeys('{CTRL}z'); }

  // ----------------------------------------------------------
  // Mouse actions (client coordinates)
  // ----------------------------------------------------------

  /**
   * Click at client coordinates.
   * @param {number} x
   * @param {number} y
   */
  async click(x, y) {
    await this.auto.ok(`MOUSE CLICK ${this.hwnd} ${x} ${y}`);
    return this;
  }

  async doubleClick(x, y) {
    await this.auto.ok(`MOUSE DBLCLICK ${this.hwnd} ${x} ${y}`);
    return this;
  }

  async rightClick(x, y) {
    await this.auto.ok(`MOUSE RCLICK ${this.hwnd} ${x} ${y}`);
    return this;
  }

  async drag(x1, y1, x2, y2) {
    await this.auto.ok(`MOUSE DRAG ${this.hwnd} ${x1} ${y1} ${x2} ${y2}`);
    return this;
  }

  // ----------------------------------------------------------
  // Scroll
  // ----------------------------------------------------------

  async scrollUp(n) { await this.auto.ok(`SCROLL ${this.hwnd} UP ${n || 1}`); return this; }
  async scrollDown(n) { await this.auto.ok(`SCROLL ${this.hwnd} DOWN ${n || 1}`); return this; }
  async scrollLeft(n) { await this.auto.ok(`SCROLL ${this.hwnd} LEFT ${n || 1}`); return this; }
  async scrollRight(n) { await this.auto.ok(`SCROLL ${this.hwnd} RIGHT ${n || 1}`); return this; }

  // ----------------------------------------------------------
  // Dialog controls
  // ----------------------------------------------------------

  /**
   * Click a dialog button by control ID.
   * @param {number} id - Control ID
   */
  async clickButton(id) {
    await this.auto.ok(`CLICK ${this.hwnd} ${id}`);
    return this;
  }

  /**
   * Send a menu command by ID.
   * @param {number} id - Menu item ID
   */
  async menuCommand(id) {
    await this.auto.ok(`MENU ${this.hwnd} ${id}`);
    return this;
  }

  /**
   * Get text of a dialog control.
   * @param {number} id - Control ID
   * @returns {Promise<string>}
   */
  async getText(id) {
    return this.auto.ok(`DIALOG GET ${this.hwnd} ${id}`);
  }

  /**
   * Set text of a dialog control.
   * @param {number} id - Control ID
   * @param {string} text
   */
  async setText(id, text) {
    await this.auto.ok(`DIALOG SET ${this.hwnd} ${id} ${text}`);
    return this;
  }

  /**
   * List all child controls.
   * @returns {Promise<Array<{id: number, className: string, text: string}>>}
   */
  async listControls() {
    const resp = await this.auto.ok(`DIALOG LIST ${this.hwnd}`);
    if (!resp.trim()) return [];
    return resp.trim().split(' ').map(entry => {
      const [id, className, ...textParts] = entry.split(':');
      return { id: +id, className, text: textParts.join(':') };
    });
  }

  // ----------------------------------------------------------
  // Checkbox / Radio
  // ----------------------------------------------------------

  async check(id) { await this.auto.ok(`CHECK ${this.hwnd} ${id}`); return this; }
  async uncheck(id) { await this.auto.ok(`UNCHECK ${this.hwnd} ${id}`); return this; }

  // ----------------------------------------------------------
  // Listbox / Combobox
  // ----------------------------------------------------------

  /**
   * Select an item in a listbox by text.
   * @param {string} text
   * @returns {Promise<number>} Selected index
   */
  async listSelect(text) {
    const resp = await this.auto.ok(`LIST SELECT ${this.hwnd} ${text}`);
    return +resp.trim();
  }

  /**
   * Select an item in a combobox by text.
   * @param {string} text
   * @returns {Promise<number>} Selected index
   */
  async comboSelect(text) {
    const resp = await this.auto.ok(`COMBO SELECT ${this.hwnd} ${text}`);
    return +resp.trim();
  }

  // ----------------------------------------------------------
  // Assertions (Playwright-style expect)
  // ----------------------------------------------------------

  /**
   * Assert that a control's text matches.
   * @param {number} id - Control ID
   * @param {string} expected - Expected text
   * @returns {Promise<boolean>}
   */
  async expect(id, expected) {
    const resp = await this.auto.ok(`EXPECT ${this.hwnd} ${id} ${expected}`);
    if (resp.startsWith('MATCH')) return true;
    const actual = resp.replace('MISMATCH:', '');
    throw new Error(`Expected "${expected}" but got "${actual}" (control ${id} in ${this.hwnd})`);
  }

  /**
   * Wait for a control's text to match.
   * @param {number} id - Control ID
   * @param {string} expected - Expected text
   * @param {number} [timeout=10000]
   */
  async waitForText(id, expected, timeout) {
    timeout = timeout || this.auto.timeout;
    const resp = await this.auto.ok(
      `WAITFOR ${this.hwnd} ${id} ${expected} ${timeout}`,
      timeout + 2000
    );
    if (resp.startsWith('MATCH')) return this;
    const actual = resp.replace('MISMATCH:', '');
    throw new Error(`Timed out waiting for "${expected}", last value: "${actual}"`);
  }

  // ----------------------------------------------------------
  // Screenshot
  // ----------------------------------------------------------

  /** Capture this window to a BMP file. */
  async capture(timeout) {
    return this.auto.ok(`GDI CAPTURE ${this.hwnd}`, timeout || 60000);
  }

  // ----------------------------------------------------------
  // Wait for this window to close
  // ----------------------------------------------------------

  async waitForClose(timeout) {
    return this.auto.waitForClose(this.hwnd, timeout);
  }
}

// ============================================================
// Exports
// ============================================================

module.exports = { WinAuto, Window };
