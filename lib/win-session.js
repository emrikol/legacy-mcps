/** One leased, identity-checked Playwright-like WinAuto session. */

'use strict';

const path = require('path');
const { HostCommandLease } = require('./host-command-lease');
const { McpMailbox } = require('./mcp-mailbox');
const { WinAuto, Window } = require('./win-auto');

function trackOperation(operation, operations, wrap) {
  const exposed = Promise.resolve(operation).then(wrap);
  const outcome = exposed.then(
    () => Object.freeze({ status: 'fulfilled' }),
    error => Object.freeze({ status: 'rejected', error }),
  );
  operations.add(outcome);
  return exposed;
}

function leasedWindow(window, operations, isRevoked) {
  return new Proxy(window, {
    get(target, property, receiver) {
      if (property === 'auto') throw new Error('WINMCP leased Window does not expose its transport');
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args) => {
        if (isRevoked()) return Promise.reject(new Error('WINMCP session client has been revoked'));
        const operation = Reflect.apply(value, target, args);
        if (!operation || typeof operation.then !== 'function') return operation;
        return trackOperation(operation, operations,
          result => result instanceof Window ? leasedWindow(result, operations, isRevoked) : result);
      };
    },
  });
}

function leasedClient(win, operations) {
  let revoked = false;
  const client = new Proxy(win, {
    get(target, property, receiver) {
      if (property === 'mailbox' || property === 'pendingOperations' ||
          property === 'sessionRevoked' || property === 'revoke' ||
          property === 'drainOperations' ||
          (typeof property === 'string' && property.startsWith('_'))) {
        throw new Error(`WINMCP session client does not expose ${String(property)}`);
      }
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args) => {
        if (revoked) {
          return Promise.reject(new Error('WINMCP session client has been revoked'));
        }
        const operation = Reflect.apply(value, target, args);
        if (!operation || typeof operation.then !== 'function') return operation;
        return trackOperation(operation, operations,
          result => result instanceof Window ? leasedWindow(result, operations, () => revoked) : result);
      };
    },
  });
  return Object.freeze({ client, revoke: () => { revoked = true; } });
}

async function withWinAutoSession(options = {}, callback) {
  if (typeof callback !== 'function') throw new Error('WinAuto session callback is required');
  const magicDir = path.resolve(options.magicDir ??
    path.join(__dirname, '..', 'share', '_MAGIC_'));
  const lease = await new HostCommandLease({ directory: magicDir, name: 'winmcp',
    timeout: options.leaseTimeout ?? 30000, pollMs: options.pollMs ?? 25 }).acquire();
  let win;
  let primary;
  let result;
  let leaseClient;
  const callbackOperations = new Set();
  try {
    win = new WinAuto({ magicDir, timeout: options.timeout ?? 10000,
      pollMs: options.pollMs ?? 25, maxResponseBytes: options.maxResponseBytes });
    await win.waitForReady(options.readyTimeout ?? 30000);
    win.runtimeIdentity = await win.identity(options.requiredFeatures ?? []);
    leaseClient = leasedClient(win, callbackOperations);
    result = await callback(leaseClient.client);
  } catch (error) {
    primary = error;
  }
  if (win) {
    leaseClient?.revoke();
    try {
      const outcomes = await Promise.all([...callbackOperations]);
      callbackOperations.clear();
      const callbackFailure = outcomes.find(outcome => outcome.status === 'rejected');
      let drainFailure = callbackFailure?.error;
      win.revoke();
      try {
        await win.drainOperations();
      } catch (error) {
        drainFailure ??= error;
      }
      if (drainFailure) throw drainFailure;
    } catch (error) {
      if (primary) primary.sessionDrainError = error.message;
      else primary = error;
    }
    win.revoke();
  }
  try { lease.release(); } catch (error) {
    if (primary) primary.leaseCleanupError = error.message;
    else primary = error;
  }
  if (primary) throw primary;
  return result;
}

async function resetWinAutoSession(options = {}) {
  const magicDir = path.resolve(options.magicDir ??
    path.join(__dirname, '..', 'share', '_MAGIC_'));
  const pollMs = options.pollMs ?? 25;
  const lease = await new HostCommandLease({ directory: magicDir, name: 'winmcp',
    timeout: options.leaseTimeout ?? 30000, pollMs }).acquire();
  let primary;
  try {
    const mailbox = new McpMailbox({ directory: magicDir, stem: '__WIN__',
      pollMs, maxCommandBytes: 511,
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

module.exports = { resetWinAutoSession, withWinAutoSession };
