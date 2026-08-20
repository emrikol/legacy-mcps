/**
 * Advisory cross-process ownership for one legacy MCP command channel.
 *
 * A lease serializes cooperating host clients. It is not authentication:
 * another local process with access to the shared directory can ignore or
 * alter the lease state.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function checkedDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const status = fs.lstatSync(directory);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error(`Host-command lease path is not a real directory: ${directory}`);
  }
  return fs.realpathSync(directory);
}

function checkedStateFile(file) {
  const status = fs.lstatSync(file);
  if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) {
    throw new Error(`Host-command lease state is not a regular single-link file: ${file}`);
  }
  if (typeof process.getuid === 'function' && status.uid !== process.getuid()) {
    throw new Error(`Host-command lease state has a foreign owner: ${file}`);
  }
  const token = fs.readFileSync(file, 'utf8').trim();
  const match = token.match(/^([1-9][0-9]{0,15}):([0-9a-f]{32})$/);
  if (!match) throw new Error(`Host-command lease state is malformed: ${file}`);
  return { token, pid: Number(match[1]) };
}

function unlinkExact(file, expectedToken) {
  const current = checkedStateFile(file);
  if (current.token !== expectedToken) {
    throw new Error(`Host-command lease ownership changed: ${file}`);
  }
  fs.unlinkSync(file);
}

class HostCommandLease {
  constructor(options = {}) {
    const directory = options.directory;
    const name = options.name ?? 'mcp';
    this.timeout = options.timeout ?? 30000;
    this.pollMs = options.pollMs ?? 25;
    this._isProcessAlive = options.isProcessAlive ?? processIsAlive;
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
      throw new Error('Host-command lease directory must be an absolute path');
    }
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) {
      throw new Error('Host-command lease name must be a lowercase identifier');
    }
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 1 || this.timeout > 300000 ||
        !Number.isSafeInteger(this.pollMs) || this.pollMs < 1 || this.pollMs > 1000) {
      throw new Error('Host-command lease timing bounds are invalid');
    }
    this.directory = checkedDirectory(directory);
    this.queueDirectory = path.join(this.directory, `.${name}-host-command-queue`);
    this.lockPath = path.join(this.directory, `.${name}-host-command.lock`);
    this.token = `${process.pid}:${crypto.randomBytes(16).toString('hex')}`;
    this.ticketPath = undefined;
    this.owned = false;
  }

  _removeStale(file) {
    let state;
    try {
      state = checkedStateFile(file);
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    if (this._isProcessAlive(state.pid)) return false;
    unlinkExact(file, state.token);
    return true;
  }

  _settleStaleState() {
    for (const name of fs.readdirSync(this.queueDirectory).sort()) {
      if (!/^[0-9]{13}-[1-9][0-9]{0,15}-[0-9a-f]{32}$/.test(name)) {
        throw new Error(`Unexpected host-command lease queue member: ${name}`);
      }
      this._removeStale(path.join(this.queueDirectory, name));
    }
    this._removeStale(this.lockPath);
  }

  async acquire() {
    if (this.owned || this.ticketPath) throw new Error('Host-command lease is already active');
    checkedDirectory(this.queueDirectory);
    const name = `${String(Date.now()).padStart(13, '0')}-${process.pid}-${this.token.split(':')[1]}`;
    this.ticketPath = path.join(this.queueDirectory, name);
    fs.writeFileSync(this.ticketPath, `${this.token}\n`, { flag: 'wx', mode: 0o600 });
    const started = Date.now();
    try {
      while (Date.now() - started < this.timeout) {
        this._settleStaleState();
        const members = fs.readdirSync(this.queueDirectory).sort();
        if (members[0] === path.basename(this.ticketPath)) {
          try {
            fs.writeFileSync(this.lockPath, `${this.token}\n`, { flag: 'wx', mode: 0o600 });
            unlinkExact(this.ticketPath, this.token);
            this.ticketPath = undefined;
            this.owned = true;
            return this;
          } catch (error) {
            if (error.code !== 'EEXIST') throw error;
          }
        }
        await sleep(this.pollMs);
      }
      throw new Error(`Timed out after ${this.timeout}ms waiting for host-command ownership`);
    } catch (error) {
      if (this.ticketPath) {
        try { unlinkExact(this.ticketPath, this.token); } catch (cleanupError) {
          error.leaseCleanupError = cleanupError.message;
        }
        this.ticketPath = undefined;
      }
      throw error;
    }
  }

  release() {
    if (!this.owned) return;
    unlinkExact(this.lockPath, this.token);
    this.owned = false;
  }
}

async function withHostCommandLease(options, callback) {
  if (typeof callback !== 'function') throw new Error('Host-command lease callback is required');
  const lease = await new HostCommandLease(options).acquire();
  let primary;
  try {
    return await callback(lease);
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    try { lease.release(); } catch (error) {
      if (primary) primary.leaseCleanupError = error.message;
      else throw error;
    }
  }
}

module.exports = { HostCommandLease, withHostCommandLease };
