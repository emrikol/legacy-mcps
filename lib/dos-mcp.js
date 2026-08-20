/** Serialized, identity-checked host client for the DOSMCP file mailbox. */

'use strict';

const path = require('path');
const { verifyRuntimeIdentity } = require('./guest-tool-identity');
const { HostCommandLease } = require('./host-command-lease');
const { McpMailbox } = require('./mcp-mailbox');

class DosMcpClient {
  #lease;
  #mailbox;
  #pendingOperations = new Set();
  #revoked = false;

  constructor(options = {}) {
    this.magicDir = path.resolve(options.magicDir ??
      path.join(__dirname, '..', 'share', '_MAGIC_'));
    this.timeout = options.timeout ?? 10000;
    this.pollMs = options.pollMs ?? 25;
    this.maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
    this.leaseTimeout = options.leaseTimeout ?? 30000;
    this.runtimeIdentity = undefined;
  }

  async open() {
    if (this.#lease) throw new Error('DOSMCP client session is already open');
    this.#lease = await new HostCommandLease({ directory: this.magicDir, name: 'dosmcp',
      timeout: this.leaseTimeout, pollMs: this.pollMs }).acquire();
    this.#revoked = false;
    this.#pendingOperations.clear();
    try {
      this.#mailbox = new McpMailbox({ directory: this.magicDir, stem: '__MCP__',
        timeout: this.timeout, pollMs: this.pollMs, maxCommandBytes: 255,
        replaceEmptyRequest: true,
        maxResponseBytes: this.maxResponseBytes });
      this.runtimeIdentity = verifyRuntimeIdentity(await this.#mailbox.send('META IDENTITY'),
        'DOSMCP');
      return this;
    } catch (error) {
      try { this.#lease.release(); } catch (cleanupError) {
        error.leaseCleanupError = cleanupError.message;
      }
      this.#lease = undefined;
      this.#mailbox = undefined;
      throw error;
    }
  }

  send(command, timeout) {
    if (this.#revoked) return Promise.reject(new Error('DOSMCP client session has been revoked'));
    if (!this.#lease || !this.#mailbox) {
      return Promise.reject(new Error('DOSMCP client session is not open'));
    }
    if (typeof command !== 'string' || !/^[\x20-\x7e]+$/.test(command) ||
        Buffer.byteLength(command, 'ascii') > 255) {
      return Promise.reject(new Error('MCP command must contain 1-255 printable ASCII bytes'));
    }
    if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300000)) {
      return Promise.reject(new Error('MCP command timeout is invalid'));
    }
    const operation = this.#mailbox.send(command, timeout);
    const outcome = Promise.resolve(operation).then(
      () => Object.freeze({ status: 'fulfilled' }),
      error => Object.freeze({ status: 'rejected', error }),
    );
    this.#pendingOperations.add(outcome);
    return operation;
  }

  async close() {
    if (!this.#lease) return;
    this.#revoked = true;
    let primary;
    const outcomes = await Promise.all([...this.#pendingOperations]);
    this.#pendingOperations.clear();
    const failure = outcomes.find(outcome => outcome.status === 'rejected');
    if (failure) primary = failure.error;
    try { this.#lease.release(); } catch (error) {
      if (primary) primary.leaseCleanupError = error.message;
      else primary = error;
    }
    this.#lease = undefined;
    this.#mailbox = undefined;
    if (primary) throw primary;
  }
}

async function withDosMcpClient(options, callback) {
  if (typeof callback !== 'function') throw new Error('DOSMCP client callback is required');
  const client = await new DosMcpClient(options).open();
  let primary;
  try {
    return await callback(client);
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    try { await client.close(); } catch (error) {
      if (primary) primary.leaseCleanupError = error.message;
      else throw error;
    }
  }
}

async function resetDosMcpMailbox(options = {}) {
  const magicDir = path.resolve(options.magicDir ??
    path.join(__dirname, '..', 'share', '_MAGIC_'));
  const pollMs = options.pollMs ?? 25;
  const lease = await new HostCommandLease({ directory: magicDir, name: 'dosmcp',
    timeout: options.leaseTimeout ?? 30000, pollMs }).acquire();
  let primary;
  try {
    const mailbox = new McpMailbox({ directory: magicDir, stem: '__MCP__',
      pollMs, maxCommandBytes: 255, replaceEmptyRequest: true,
      maxResponseBytes: options.maxResponseBytes ?? 1024 * 1024 });
    mailbox.resetUncertain({ confirmGuestReset: options.confirmGuestReset });
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

module.exports = { DosMcpClient, resetDosMcpMailbox, withDosMcpClient };
