/**
 * Small host client for the patched DOSBox-X localhost control server.
 *
 * The debugger runs on DOSBox-X's emulator thread. This client only handles
 * transport and the length-framed, non-resuming batch format; callers remain
 * responsible for pausing the guest and interpreting debugger responses.
 */

'use strict';

const net = require('net');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 10199;
const DEFAULT_TIMEOUT = 5000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_TIMEOUT = 300000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

function checkedCommand(command) {
  if (typeof command !== 'string' ||
      !/^[\x20-\x7e]{1,4096}$/.test(command)) {
    throw new Error('DOSBox-X commands must contain 1-4096 printable ASCII characters');
  }
  return command;
}

function encodeDebugBatch(commands) {
  if (!Array.isArray(commands) || commands.length < 1 || commands.length > 8) {
    throw new Error('A debugger batch must contain 1-8 commands');
  }
  const frames = commands.map((command, index) => {
    checkedCommand(command);
    if (Buffer.byteLength(command, 'ascii') > 512) {
      throw new Error(`Debugger batch command ${index} exceeds 512 bytes`);
    }
    const verb = command.trimStart().split(/\s+/, 1)[0].toUpperCase();
    if (['BATCH', 'CONTINUE', 'NEXT', 'RUN', 'PAUSE', 'WAIT', 'STATUS',
      'MUTATE'].includes(verb)) {
      throw new Error(`Debugger batch command ${index} uses forbidden verb ${verb}`);
    }
    return `${Buffer.byteLength(command, 'ascii')}:${command}`;
  });
  return `DEBUG BATCH ${commands.length} ${frames.join('')}`;
}

class DosboxControl {
  constructor(options = {}) {
    this.host = options.host ?? DEFAULT_HOST;
    const environmentPort = process.env.DOSBOX_CONTROL_PORT === undefined ?
      DEFAULT_PORT : Number(process.env.DOSBOX_CONTROL_PORT);
    this.port = options.port ?? environmentPort;
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (typeof this.host !== 'string' || this.host.length === 0) {
      throw new Error('DOSBox-X control host must be a nonempty string');
    }
    if (!Number.isInteger(this.port) || this.port < 1 || this.port > 65535) {
      throw new Error('DOSBox-X control port must be an integer from 1 through 65535');
    }
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 1 || this.timeout > MAX_TIMEOUT) {
      throw new Error(`DOSBox-X control timeout must be an integer from 1 through ${MAX_TIMEOUT}`);
    }
    if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1 ||
        this.maxResponseBytes > MAX_RESPONSE_BYTES) {
      throw new Error(`DOSBox-X maximum response size must be an integer from 1 through ${MAX_RESPONSE_BYTES}`);
    }
  }

  send(command, options = {}) {
    checkedCommand(command);
    const timeout = options.timeout ?? this.timeout;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT) {
      throw new Error(`DOSBox-X control timeout must be an integer from 1 through ${MAX_TIMEOUT}`);
    }
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      let response = '';
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        callback(value);
      };
      socket.setEncoding('utf8');
      socket.setTimeout(timeout);
      socket.on('connect', () => socket.end(`${command}\n`));
      socket.on('data', chunk => {
        response += chunk;
        if (Buffer.byteLength(response, 'utf8') > this.maxResponseBytes) {
          socket.destroy();
          finish(reject, new Error(
            `DOSBox-X control response exceeds ${this.maxResponseBytes} bytes`));
        }
      });
      socket.on('end', () => {
        if (!response.endsWith('\n')) {
          finish(reject, new Error('DOSBox-X control response ended before its terminal newline'));
          return;
        }
        let body = response.slice(0, -1);
        if (body.endsWith('\r')) body = body.slice(0, -1);
        finish(resolve, body.trimEnd());
      });
      socket.on('timeout', () => {
        socket.destroy();
        finish(reject, new Error(`DOSBox-X control command timed out after ${timeout}ms`));
      });
      socket.on('error', error => finish(reject, error));
    });
  }

  ping() { return this.send('PING'); }
  status() { return this.send('STATUS'); }
  identity() { return this.send('IDENTITY'); }
  minimize() { return this.send('MINIMIZE'); }
  debug(command, options) { return this.send(`DEBUG ${checkedCommand(command)}`, options); }
  debugBatch(commands, options) { return this.send(encodeDebugBatch(commands), options); }
}

module.exports = { DosboxControl, encodeDebugBatch };
