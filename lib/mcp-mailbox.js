/** Bounded file-mailbox transport shared by DOSMCP and WINMCP host clients. */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function fileIdentity(status) {
  return `${status.dev}:${status.ino}:${status.size}:${status.mtimeMs}:${status.ctimeMs}`;
}

function sameFileObject(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

class McpMailbox {
  constructor(options = {}) {
    this.directory = options.directory;
    this.stem = options.stem;
    this.pollMs = options.pollMs ?? 25;
    this.timeout = options.timeout ?? 10000;
    this.maxCommandBytes = options.maxCommandBytes ?? 512;
    this.maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
    this.replaceEmptyRequest = options.replaceEmptyRequest ?? false;
    this.poisoned = false;
    this.commandQueue = Promise.resolve();
    if (typeof this.directory !== 'string' || !path.isAbsolute(this.directory) ||
        !/^__[A-Z]{3,8}__$/.test(this.stem || '')) {
      throw new Error('MCP mailbox requires an absolute directory and uppercase __NAME__ stem');
    }
    for (const [name, value, minimum, maximum] of [
      ['poll interval', this.pollMs, 1, 1000], ['timeout', this.timeout, 1, 300000],
      ['command bound', this.maxCommandBytes, 1, 4096],
      ['response bound', this.maxResponseBytes, 1, 16 * 1024 * 1024],
    ]) {
      if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new Error(`MCP mailbox ${name} is invalid`);
      }
    }
    const status = fs.lstatSync(this.directory);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new Error('MCP mailbox directory must be a real directory');
    }
    this.directory = fs.realpathSync(this.directory);
    const markerBase = this.stem === '__MCP__' ? 'dosmcp' :
      (this.stem === '__WIN__' ? 'winmcp' : this.stem.slice(2, -2).toLowerCase());
    this.inflightPath = path.join(this.directory, `.${markerBase}-host-command.inflight`);
  }

  _matching(extension) {
    const expected = `${this.stem}.${extension}`.toLowerCase();
    return fs.readdirSync(this.directory).filter(name => name.toLowerCase() === expected);
  }

  _unique(extension, required = false) {
    const matches = this._matching(extension);
    if (matches.length > 1) throw new Error(`Ambiguous MCP mailbox ${extension} files`);
    if (matches.length === 0) {
      if (required) throw new Error(`MCP mailbox ${extension} file is missing`);
      return undefined;
    }
    const file = path.join(this.directory, matches[0]);
    const status = fs.lstatSync(file);
    if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) {
      throw new Error(`MCP mailbox ${extension} is not a regular single-link file`);
    }
    return file;
  }

  _readStable(file) {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
      throw new Error('MCP mailbox response is not a regular single-link file');
    }
    if (before.size > this.maxResponseBytes) throw new Error('MCP mailbox response is too large');
    const bytes = fs.readFileSync(file);
    const after = fs.lstatSync(file);
    if (fileIdentity(before) !== fileIdentity(after) || bytes.length !== before.size) {
      throw new Error('MCP mailbox response changed while being read');
    }
    return bytes;
  }

  _unlinkStable(file) {
    const before = fs.lstatSync(file);
    const current = this._unique(path.extname(file).slice(1), true);
    const after = fs.lstatSync(current);
    if (current !== file || fileIdentity(before) !== fileIdentity(after)) {
      throw new Error('MCP mailbox response changed before cleanup');
    }
    fs.unlinkSync(file);
  }

  _syncDirectory() {
    const descriptor = fs.openSync(this.directory, 'r');
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  }

  _checkedMarker(required = false) {
    let status;
    try { status = fs.lstatSync(this.inflightPath); } catch (error) {
      if (error.code === 'ENOENT' && !required) return undefined;
      throw error;
    }
    if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) {
      throw new Error('MCP inflight marker is not a regular single-link file');
    }
    if (typeof process.getuid === 'function' && status.uid !== process.getuid()) {
      throw new Error('MCP inflight marker has a foreign owner');
    }
    const value = fs.readFileSync(this.inflightPath, 'ascii');
    const after = fs.lstatSync(this.inflightPath);
    if (fileIdentity(status) !== fileIdentity(after)) {
      throw new Error('MCP inflight marker changed while being read');
    }
    if (value !== 'uncertain-command-v1\n') throw new Error('MCP inflight marker is malformed');
    return status;
  }

  _createMarker() {
    const descriptor = fs.openSync(this.inflightPath, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, 'uncertain-command-v1\n', 'ascii');
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    this._syncDirectory();
  }

  _removeMarker() {
    const before = this._checkedMarker(true);
    const after = fs.lstatSync(this.inflightPath);
    if (fileIdentity(before) !== fileIdentity(after)) {
      throw new Error('MCP inflight marker changed before cleanup');
    }
    fs.unlinkSync(this.inflightPath);
    this._syncDirectory();
  }

  _prepareRequest() {
    const request = this._unique('TX');
    if (!request) return;
    if (!this.replaceEmptyRequest) throw new Error('MCP mailbox already has a request');
    const before = fs.lstatSync(request);
    if (before.size !== 0) throw new Error('MCP mailbox already has an unconsumed request');
    this._unlinkStable(request);
    this._syncDirectory();
  }

  resetUncertain(options = {}) {
    if (options.confirmGuestReset !== true) {
      throw new Error('MCP mailbox reset requires confirmGuestReset=true after guest reset');
    }
    if (this._unique('RX') || this._unique('LR')) {
      throw new Error('MCP mailbox reset refused while a response is pending');
    }
    const request = this._unique('TX');
    if (request) {
      const status = fs.lstatSync(request);
      if (status.size !== 0) {
        throw new Error('MCP mailbox reset refused while a request is unconsumed');
      }
      this._unlinkStable(request);
      this._syncDirectory();
    }
    if (this._checkedMarker()) this._removeMarker();
    this.poisoned = false;
  }

  send(command, timeout = this.timeout) {
    const operation = this.commandQueue.then(() => this._send(command, timeout));
    this.commandQueue = operation.catch(() => undefined);
    return operation;
  }

  async _send(command, timeout) {
    if (this.poisoned || this._checkedMarker()) {
      this.poisoned = true;
      throw new Error('MCP mailbox is retained as uncertain; reset the guest and explicitly confirm reset');
    }
    if (typeof command !== 'string' || !/^[\x20-\x7e]+$/.test(command) ||
        Buffer.byteLength(command, 'ascii') > this.maxCommandBytes) {
      throw new Error(`MCP command must contain 1-${this.maxCommandBytes} printable ASCII bytes`);
    }
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300000) {
      throw new Error('MCP command timeout is invalid');
    }
    let marked = false;
    const nonce = crypto.randomBytes(16).toString('hex');
    const temporary = path.join(this.directory, `.${this.stem.slice(2, -2).toLowerCase()}-${nonce}.tmp`);
    const request = path.join(this.directory, `${this.stem.toLowerCase()}.tx`);
    try {
      this._prepareRequest();
      if (this._unique('RX') || this._unique('LR')) {
        throw new Error('MCP mailbox has a retained response');
      }
      this._createMarker();
      marked = true;
      const descriptor = fs.openSync(temporary, 'wx', 0o600);
      const commandBytes = Buffer.from(`${command}\r\n`, 'ascii');
      try {
        fs.writeFileSync(descriptor, commandBytes);
        fs.fsyncSync(descriptor);
      } finally { fs.closeSync(descriptor); }
      const temporaryStatus = fs.lstatSync(temporary);
      if (!temporaryStatus.isFile() || temporaryStatus.isSymbolicLink() ||
          temporaryStatus.nlink !== 1 || temporaryStatus.size !== commandBytes.length ||
          !fs.readFileSync(temporary).equals(commandBytes)) {
        throw new Error('MCP temporary request failed its publication check');
      }
      fs.renameSync(temporary, request);
      try {
        const requestStatus = fs.lstatSync(request);
        if (!requestStatus.isFile() || requestStatus.isSymbolicLink() ||
            requestStatus.nlink !== 1 || requestStatus.dev !== temporaryStatus.dev ||
            requestStatus.ino !== temporaryStatus.ino) {
          throw new Error('MCP request identity changed during publication');
        }
        if (requestStatus.size !== 0) {
          const publishedBytes = fs.readFileSync(request);
          const afterRead = fs.lstatSync(request);
          if (!sameFileObject(requestStatus, afterRead) || !publishedBytes.equals(commandBytes)) {
            throw new Error('MCP request content changed during publication');
          }
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      this._syncDirectory();
      const started = Date.now();
      while (Date.now() - started < timeout) {
        const responseFile = this._unique('RX');
        if (responseFile) {
          let bytes = this._readStable(responseFile);
          let response = bytes.toString('utf8').replace(/[\r\n]+$/, '');
          if (response === 'OK @LR') {
            const longFile = this._unique('LR', true);
            bytes = this._readStable(longFile);
            this._unlinkStable(longFile);
            response = bytes.toString('utf8').replace(/[\r\n]+$/, '');
          }
          this._unlinkStable(responseFile);
          this._removeMarker();
          marked = false;
          return response;
        }
        await sleep(this.pollMs);
      }
      throw new Error(`MCP command timed out after ${timeout}ms`);
    } catch (error) {
      if (marked) this.poisoned = true;
      throw error;
    } finally {
      try { fs.unlinkSync(temporary); } catch (error) {
        if (error.code !== 'ENOENT') this.poisoned = true;
      }
    }
  }
}

module.exports = { McpMailbox };
