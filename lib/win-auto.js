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
const { verifyRuntimeIdentity } = require('./guest-tool-identity');
const { McpMailbox } = require('./mcp-mailbox');

const UNSAFE_WRITE_TOKEN = Symbol('WINMCP audited unsafe write');

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

function checkedTarget(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9!_.-]{1,64}$/.test(value)) {
    throw new Error('WINMCP target must be a bounded module name or handle');
  }
  return value;
}

function checkedProcedure(value) {
  if (typeof value !== 'string' || !/^(?:#[1-9][0-9]{0,4}|[A-Za-z_][A-Za-z0-9_]{0,63})$/.test(value)) {
    throw new Error('WINMCP procedure must be a bounded name or #ordinal');
  }
  return value;
}

function checkedAddress(value) {
  if (typeof value !== 'string' || !/^[0-9A-Fa-f]{4}:[0-9A-Fa-f]{8}$/.test(value) ||
      value.slice(0, 4) === '0000') {
    throw new Error('WINMCP address must be a nonzero selector and eight-digit offset');
  }
  return value.toUpperCase();
}

// ============================================================
// WinAuto — main automation controller
// ============================================================

class WinAuto {
  #mailbox;
  #manipulated = false;
  #pendingOperations = new Set();
  #sessionRevoked = false;

  /**
   * @param {object} opts
   * @param {string} opts.magicDir - Path to _MAGIC_ directory for file IPC
   * @param {number} [opts.pollMs=150] - Polling interval in ms
   * @param {number} [opts.timeout=10000] - Default command timeout in ms
   */
  constructor(opts = {}) {
    this.magicDir = path.resolve(opts.magicDir ?? path.resolve(__dirname, '..', 'share', '_MAGIC_'));
    this.pollMs = opts.pollMs ?? 150;
    this.timeout = opts.timeout ?? 10000;
    if (!fs.existsSync(this.magicDir)) {
      fs.mkdirSync(this.magicDir, { recursive: true });
    }
    this.#mailbox = opts.mailbox ?? new McpMailbox({ directory: this.magicDir, stem: '__WIN__',
      pollMs: this.pollMs, timeout: this.timeout, maxCommandBytes: 511,
      maxResponseBytes: opts.maxResponseBytes ?? 1024 * 1024 });
  }

  get manipulated() { return this.#manipulated; }

  // ----------------------------------------------------------
  // Low-level IPC
  // ----------------------------------------------------------

  /** Send a raw command string and return the raw response. */
  async send(command, timeout) {
    return this._dispatch(command, timeout);
  }

  async _dispatch(command, timeout, authority) {
    if (this.#sessionRevoked) throw new Error('WINMCP session client has been revoked');
    if (typeof command !== 'string') throw new Error('WINMCP command must be a string');
    if (authority !== UNSAFE_WRITE_TOKEN && /^MEMORY WRITE UNSAFE(?: |$)/i.test(command)) {
      throw new Error('Use writeMemoryUnsafe() for audited unsafe memory writes');
    }
    const operation = Promise.resolve().then(() =>
      this.#mailbox.send(command, timeout ?? this.timeout));
    const tracked = operation.then(
      () => Object.freeze({ status: 'fulfilled' }),
      error => Object.freeze({ status: 'rejected', error }),
    );
    this.#pendingOperations.add(tracked);
    return operation;
  }

  /** Prevent this client from starting more commands after its lease ends. */
  revoke() {
    this.#sessionRevoked = true;
  }

  /** Wait for every command already dispatched through this client. */
  async drainOperations() {
    let failure;
    do {
      const pending = [...this.#pendingOperations];
      const outcomes = await Promise.all(pending);
      for (const operation of pending) this.#pendingOperations.delete(operation);
      failure ??= outcomes.find(outcome => outcome.status === 'rejected');
      /* Let continuations of a completed command enqueue their next command
       * before deciding that the client is quiescent. */
      await Promise.resolve();
    } while (this.#pendingOperations.size !== 0);
    if (failure) throw failure.error;
  }

  /** Send a command and assert it returns OK. Returns the part after "OK ". */
  async ok(command, timeout) {
    const resp = await this.send(command, timeout);
    if (resp !== 'OK' && !resp.startsWith('OK ')) {
      throw new Error(`Command failed: ${command}\nResponse: ${resp}`);
    }
    return resp === 'OK' ? '' : resp.slice(3);
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

  /** Verify the live agent against this checkout's source contract. */
  async identity(additionalFeatures = []) {
    return verifyRuntimeIdentity(await this.send('META IDENTITY'), 'WINMCP', additionalFeatures);
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
    if (resp === 'ERR NOT_FOUND') return null;
    if (!resp.startsWith('OK ')) {
      throw new Error(`Malformed WINDOW FIND response: ${resp}`);
    }
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

  async taskInfo(target) { return this.ok(`TASK INFO ${checkedTarget(target)}`); }
  async taskCsip(target) { return this.ok(`TASK CSIP ${checkedTarget(target)}`); }
  async taskStack(target) { return this.ok(`TASK STACK ${checkedTarget(target)}`); }

  async moduleInfo(name) { return this.ok(`MODULE INFO ${checkedTarget(name)}`); }

  async moduleProc(name, procedure) {
    return this.ok(`MODULE PROC ${checkedTarget(name)} ${checkedProcedure(procedure)}`);
  }

  async moduleSegments(name, options = {}) {
    name = checkedTarget(name);
    const pageSize = options.pageSize ?? 12;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 32) {
      throw new Error('Module segment page size must be an integer from 1 through 32');
    }
    const segments = [];
    const seenPages = new Set();
    const seenSegments = new Set();
    let pageCount = 0;
    let start = 1;
    while (start !== 0) {
      pageCount++;
      if (pageCount > 255) throw new Error('MODULE SEGMENTS exceeded its page bound');
      if (seenPages.has(start)) throw new Error('MODULE SEGMENTS pagination did not advance');
      seenPages.add(start);
      const response = await this.ok(`MODULE SEGMENTS ${name} ${start} ${pageSize}`);
      const headerMatch = response.match(/^MODULE=([A-Za-z0-9!_.-]{1,64}) START=(\d+)(?: |$)/);
      if (!headerMatch || headerMatch[1].toUpperCase() !== name.toUpperCase() ||
          Number(headerMatch[2]) !== start) {
        throw new Error(`Malformed MODULE SEGMENTS header: ${response}`);
      }
      const nextMatch = response.match(/(?:^| )NEXT=(\d+)$/);
      if (!nextMatch) throw new Error(`Malformed MODULE SEGMENTS response: ${response}`);
      const headerLength = headerMatch[0].endsWith(' ') ? headerMatch[0].length - 1 :
        headerMatch[0].length;
      const body = response.slice(headerLength, nextMatch.index).trim();
      const pattern = /(?:^| )SEG=(\d+) SEL=([0-9A-F]{4}) HANDLE=([0-9A-F]{4}) TYPE=(\d+) DATA=(\d+) BASE=([0-9A-F]{8}) SIZE=([0-9A-F]{8}) FLAGS=([0-9A-F]{4}) LOCKS=(\d+)/g;
      let cursor = 0;
      let pageMembers = 0;
      let previousSegment = start - 1;
      let match;
      while ((match = pattern.exec(body)) !== null) {
        if (body.slice(cursor, match.index).trim()) {
          throw new Error(`Malformed MODULE SEGMENTS member: ${body.slice(cursor)}`);
        }
        const segment = Number(match[1]);
        if (!Number.isSafeInteger(segment) || segment < 1 || segment > 255 ||
            ++pageMembers > pageSize) throw new Error('MODULE SEGMENTS member is out of range');
        if (segment <= previousSegment || seenSegments.has(segment)) {
          throw new Error('MODULE SEGMENTS members must be unique and forward-moving');
        }
        seenSegments.add(segment);
        previousSegment = segment;
        segments.push(Object.freeze({ segment, selector: match[2],
          handle: match[3], type: Number(match[4]), data: Number(match[5]),
          linearBase: match[6], size: parseInt(match[7], 16), flags: match[8],
          locks: Number(match[9]) }));
        cursor = pattern.lastIndex;
      }
      if (body.slice(cursor).trim()) throw new Error(`Malformed MODULE SEGMENTS tail: ${body}`);
      const next = Number(nextMatch[1]);
      if (!Number.isSafeInteger(next) || next < 0 || next > 255) {
        throw new Error('MODULE SEGMENTS NEXT is out of range');
      }
      if (next !== 0 && next <= Math.max(start, previousSegment)) {
        throw new Error('MODULE SEGMENTS pagination did not advance');
      }
      start = next;
    }
    return Object.freeze(segments);
  }

  async readMemory(address, length = 16) {
    address = checkedAddress(address);
    if (!Number.isSafeInteger(length) || length < 1 || length > 512) {
      throw new Error('Memory read length must be an integer from 1 through 512');
    }
    const response = await this.ok(`MEMORY READ ${address} ${length}`);
    const match = response.match(/^([0-9A-F]{4}):([0-9A-F]{8}) N=(\d+)((?: [0-9A-F]{2})+)$/);
    if (!match || `${match[1]}:${match[2]}` !== address.toUpperCase() ||
        Number(match[3]) !== length) {
      throw new Error(`Malformed MEMORY READ response: ${response}`);
    }
    const bytes = Buffer.from(match[4].trim().split(' ').map(value => parseInt(value, 16)));
    if (bytes.length !== length) throw new Error('MEMORY READ byte count does not match its receipt');
    return Object.freeze({ selector: match[1], offset: match[2], bytes });
  }

  async writeMemoryUnsafe(address, bytes, options = {}) {
    address = checkedAddress(address);
    if (options.confirmUnsafe !== true) {
      throw new Error('Unsafe memory writes require confirmUnsafe: true');
    }
    if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
      throw new Error('Unsafe memory write bytes must be a Buffer or Uint8Array');
    }
    bytes = Buffer.from(bytes);
    if (bytes.length < 1 || bytes.length > 64) {
      throw new Error('Unsafe memory writes require 1-64 bytes');
    }
    const hex = [...bytes].map(value => value.toString(16).padStart(2, '0').toUpperCase());
    /* A valid write command can leave state changed even when verification or
     * audit persistence later fails. Mark the session before dispatch. */
    this.#manipulated = true;
    const command = `MEMORY WRITE UNSAFE ${address} ${hex.join(' ')}`;
    const rawResponse = await this._dispatch(command, undefined, UNSAFE_WRITE_TOKEN);
    if (rawResponse !== 'OK' && !rawResponse.startsWith('OK ')) {
      throw new Error(`Command failed: ${command}\nResponse: ${rawResponse}`);
    }
    const response = rawResponse === 'OK' ? '' : rawResponse.slice(3);
    const match = response.match(/^MUTATED=1 ([0-9A-F]{4}:[0-9A-F]{8}) N=(\d+) BEFORE=([0-9A-F]+) AFTER=([0-9A-F]+)$/);
    if (!match || match[1] !== address.toUpperCase() || Number(match[2]) !== bytes.length ||
        match[3].length !== bytes.length * 2 || match[4] !== bytes.toString('hex').toUpperCase()) {
      throw new Error(`Malformed MEMORY WRITE receipt: ${response}`);
    }
    return Object.freeze({ address: match[1], before: Buffer.from(match[3], 'hex'),
      after: Buffer.from(match[4], 'hex') });
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

  async waitForPlayback(options = {}) {
    const timeout = options.timeout ?? 20000;
    const pollMs = options.pollMs ?? 100;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300000 ||
        !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 1000) {
      throw new Error('Playback wait bounds are invalid');
    }
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const status = await this.playStatus();
      if (status === 'IDLE') return;
      if (!/^PLAYING \d+\/\d+$/.test(status)) {
        throw new Error(`Malformed playback status: ${status}`);
      }
      await sleep(pollMs);
    }
    throw new Error(`Playback did not finish within ${timeout}ms`);
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
    if (typeof command === 'string' && /^\s*DEBUG(?:\s|$)/i.test(command)) {
      throw new Error('Use dosboxDebug() or dosboxDebugBatch() for leased debugger access');
    }
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
    if (typeof command === 'string' && /^\s*(?:MUTATE|BATCH)(?:\s|$)/i.test(command)) {
      throw new Error('Use the audited debugger mutation or framed batch API');
    }
    const { withDebuggerSession } = require('./dosbox-debugger');
    const sessionOptions = { leaseDirectory: this.magicDir, ...(opts ?? {}) };
    return withDebuggerSession(sessionOptions, session => session.command(command, opts));
  }

  /** Execute 1-8 non-resuming debugger commands as one stopped-CPU batch. */
  async dosboxDebugBatch(commands, opts) {
    const { withDebuggerSession } = require('./dosbox-debugger');
    const sessionOptions = { leaseDirectory: this.magicDir, ...(opts ?? {}) };
    return withDebuggerSession(sessionOptions, session => session.batch(commands, opts));
  }
}

// ============================================================
// Window — handle to a specific window
// ============================================================

class Window {
  #auto;

  /**
   * @param {WinAuto} auto - Parent automation controller
   * @param {string} hwnd - Window handle (4-digit hex)
   */
  constructor(auto, hwnd) {
    if (!auto || typeof hwnd !== 'string' || !/^[0-9A-Fa-f]{4}$/.test(hwnd) ||
        hwnd === '0000') throw new Error('Window requires a nonzero four-digit handle');
    this.#auto = auto;
    this.hwnd = hwnd.toUpperCase();
  }

  /** Re-fetch this window's title. */
  async title() {
    return this.#auto.ok(`WINDOW TITLE ${this.hwnd}`);
  }

  /** Get window rectangle {x, y, width, height}. */
  async rect() {
    const resp = await this.#auto.ok(`WINDOW RECT ${this.hwnd}`);
    const [x, y, w, h] = resp.trim().split(' ').map(Number);
    return { x, y, width: w, height: h };
  }

  /** Check if window is visible. */
  async isVisible() {
    const resp = await this.#auto.ok(`WINDOW VISIBLE ${this.hwnd}`);
    return resp.trim() === 'TRUE';
  }

  /** Check if window is enabled. */
  async isEnabled() {
    const resp = await this.#auto.ok(`WINDOW ENABLED ${this.hwnd}`);
    return resp.trim() === 'TRUE';
  }

  /** Move and resize the window. */
  async move(x, y, width, height) {
    await this.#auto.ok(`WINDOW MOVE ${this.hwnd} ${x} ${y} ${width} ${height}`);
    return this;
  }

  /** Show, hide, minimize, maximize, or restore. */
  async show(cmd) {
    await this.#auto.ok(`WINDOW SHOW ${this.hwnd} ${cmd}`);
    return this;
  }

  async hide() { return this.show('HIDE'); }
  async minimize() { return this.show('MIN'); }
  async maximize() { return this.show('MAX'); }
  async restore() { return this.show('RESTORE'); }

  /** Bring to front and set input focus. */
  async focus() {
    await this.#auto.ok(`FOCUS ${this.hwnd}`);
    return this;
  }

  /** Close the window (sends WM_CLOSE). */
  async close() {
    await this.#auto.ok(`WINDOW CLOSE ${this.hwnd}`);
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
    const hwnd = await this.#auto.ok(`CONTROL FIND ${this.hwnd} ${className} ${text}`);
    return new Window(this.#auto, hwnd.trim());
  }

  /** Resolve one unique direct child by numeric control ID without reading text. */
  async locatorById(id) {
    if (!Number.isSafeInteger(id) || id < 1 || id > 32767) {
      throw new Error('Control ID must be an integer from 1 through 32767');
    }
    const hwnd = await this.#auto.ok(`CONTROL FINDID ${this.hwnd} ${id}`);
    return new Window(this.#auto, hwnd.trim());
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
    await this.#auto.ok(`TYPE ${this.hwnd} ${text}`);
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
    await this.#auto.ok(`SENDKEYS ${this.hwnd} ${keys}`);
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
    await this.#auto.ok(`MOUSE CLICK ${this.hwnd} ${x} ${y}`);
    return this;
  }

  async doubleClick(x, y) {
    await this.#auto.ok(`MOUSE DBLCLICK ${this.hwnd} ${x} ${y}`);
    return this;
  }

  async rightClick(x, y) {
    await this.#auto.ok(`MOUSE RCLICK ${this.hwnd} ${x} ${y}`);
    return this;
  }

  async drag(x1, y1, x2, y2) {
    await this.#auto.ok(`MOUSE DRAG ${this.hwnd} ${x1} ${y1} ${x2} ${y2}`);
    return this;
  }

  // ----------------------------------------------------------
  // Scroll
  // ----------------------------------------------------------

  async scrollUp(n) { await this.#auto.ok(`SCROLL ${this.hwnd} UP ${n || 1}`); return this; }
  async scrollDown(n) { await this.#auto.ok(`SCROLL ${this.hwnd} DOWN ${n || 1}`); return this; }
  async scrollLeft(n) { await this.#auto.ok(`SCROLL ${this.hwnd} LEFT ${n || 1}`); return this; }
  async scrollRight(n) { await this.#auto.ok(`SCROLL ${this.hwnd} RIGHT ${n || 1}`); return this; }

  // ----------------------------------------------------------
  // Dialog controls
  // ----------------------------------------------------------

  /**
   * Click a dialog button by control ID.
   * @param {number} id - Control ID
   */
  async clickButton(id) {
    await this.#auto.ok(`CLICK ${this.hwnd} ${id}`);
    return this;
  }

  /**
   * Send a menu command by ID.
   * @param {number} id - Menu item ID
   */
  async menuCommand(id) {
    await this.#auto.ok(`MENU ${this.hwnd} ${id}`);
    return this;
  }

  /**
   * Get text of a dialog control.
   * @param {number} id - Control ID
   * @returns {Promise<string>}
   */
  async getText(id) {
    return this.#auto.ok(`DIALOG GET ${this.hwnd} ${id}`);
  }

  /**
   * Set text of a dialog control.
   * @param {number} id - Control ID
   * @param {string} text
   */
  async setText(id, text) {
    await this.#auto.ok(`DIALOG SET ${this.hwnd} ${id} ${text}`);
    return this;
  }

  /**
   * List all child controls.
   * @returns {Promise<Array<{id: number, className: string, text: string}>>}
   */
  async listControls() {
    const resp = await this.#auto.ok(`DIALOG LIST ${this.hwnd}`);
    if (!resp.trim()) return [];
    return resp.trim().split(' ').map(entry => {
      const [id, className, ...textParts] = entry.split(':');
      return { id: +id, className, text: textParts.join(':') };
    });
  }

  // ----------------------------------------------------------
  // Checkbox / Radio
  // ----------------------------------------------------------

  async check(id) { await this.#auto.ok(`CHECK ${this.hwnd} ${id}`); return this; }
  async uncheck(id) { await this.#auto.ok(`UNCHECK ${this.hwnd} ${id}`); return this; }

  // ----------------------------------------------------------
  // Listbox / Combobox
  // ----------------------------------------------------------

  /**
   * Select an item in a listbox by text.
   * @param {string} text
   * @returns {Promise<number>} Selected index
   */
  async listSelect(text) {
    const resp = await this.#auto.ok(`LIST SELECT ${this.hwnd} ${text}`);
    return +resp.trim();
  }

  /**
   * Select an item in a combobox by text.
   * @param {string} text
   * @returns {Promise<number>} Selected index
   */
  async comboSelect(text) {
    const resp = await this.#auto.ok(`COMBO SELECT ${this.hwnd} ${text}`);
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
    const resp = await this.#auto.ok(`EXPECT ${this.hwnd} ${id} ${expected}`);
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
    timeout = timeout || this.#auto.timeout;
    const resp = await this.#auto.ok(
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
    return this.#auto.ok(`GDI CAPTURE ${this.hwnd}`, timeout || 60000);
  }

  // ----------------------------------------------------------
  // Wait for this window to close
  // ----------------------------------------------------------

  async waitForClose(timeout) {
    return this.#auto.waitForClose(this.hwnd, timeout);
  }
}

// ============================================================
// Exports
// ============================================================

/* Public lifecycle helpers live behind this primary entry point. Lazy loading
 * keeps win-session free to construct WinAuto without a module-init cycle. */
function withWinAutoSession(options, callback) {
  return require('./win-session').withWinAutoSession(options, callback);
}

function resetWinAutoSession(options) {
  return require('./win-session').resetWinAutoSession(options);
}

module.exports = { resetWinAutoSession, WinAuto, Window, withWinAutoSession };
