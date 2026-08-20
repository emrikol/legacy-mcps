/** Argument parsing and execution for the generic WinAuto host CLI. */

'use strict';

const path = require('path');
const { resetWinAutoSession, Window, withWinAutoSession } = require('./win-auto');
const { loadSequence, runSequence } = require('./win-sequence');

function numeric(value, name, minimum, maximum) {
  if (!/^[0-9]+$/.test(value || '')) throw new Error(`${name} must be an integer`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new Error(`${name} must be from ${minimum} through ${maximum}`);
  }
  return result;
}

function printable(value, name, maximum = 511) {
  if (typeof value !== 'string' || !/^[\x20-\x7e]+$/.test(value) ||
      Buffer.byteLength(value, 'ascii') > maximum) {
    throw new Error(`${name} must be bounded printable ASCII`);
  }
  return value;
}

function address(value) {
  if (!/^[0-9A-Fa-f]{4}:[0-9A-Fa-f]{8}$/.test(value || '') ||
      value.slice(0, 4) === '0000') throw new Error('memory address is invalid');
}

function target(value, name = 'target') {
  if (!/^[A-Za-z0-9!_.-]{1,64}$/.test(value || '')) throw new Error(`${name} is invalid`);
}

function parseArguments(argv) {
  const options = { json: false, continueOnError: false };
  let index = 0;
  while (index < argv.length && argv[index].startsWith('--')) {
    const option = argv[index++];
    if (option === '--magic-dir') {
      if (!argv[index]) throw new Error('--magic-dir requires a path');
      options.magicDir = path.resolve(argv[index++]);
    } else if (option === '--timeout') options.timeout = numeric(argv[index++], 'timeout', 1, 300000);
    else if (option === '--ready-timeout') options.readyTimeout =
      numeric(argv[index++], 'ready timeout', 1, 60000);
    else if (option === '--lease-timeout') options.leaseTimeout =
      numeric(argv[index++], 'lease timeout', 1, 300000);
    else if (option === '--json') options.json = true;
    else if (option === '--continue-on-error') options.continueOnError = true;
    else throw new Error(`Unknown option: ${option}`);
  }
  const command = argv[index++];
  const args = argv.slice(index);
  if (!command) throw new Error('A WinAuto command is required');
  if (command === 'reset') {
    if (args.length !== 1 || args[0] !== '--confirm-guest-reset') {
      throw new Error('reset requires --confirm-guest-reset after replacing the guest session');
    }
  } else if (command === 'status' || command === 'windows') {
    if (args.length) throw new Error(`${command} takes no arguments`);
  } else if (command === 'send') {
    if (args[0] !== '--' || args.length < 2) throw new Error('send requires -- COMMAND');
    const raw = printable(args.slice(1).join(' '), 'raw command');
    if (/^MEMORY WRITE UNSAFE(?: |$)/i.test(raw)) {
      throw new Error('Use memory write-unsafe with the explicit confirmation option');
    }
  } else if (command === 'sequence') {
    if (args.length !== 1) throw new Error('sequence requires one JSON file');
  } else if (command === 'exec') {
    const wait = args[0] === '--wait-for';
    const noWait = args[0] === '--no-wait';
    const separator = wait ? 2 : 1;
    if ((!wait && !noWait) || (wait && args.length < 4) ||
        (noWait && args.length < 3) || args[separator] !== '--') {
      throw new Error('exec requires --wait-for TITLE -- PROGRAM or --no-wait -- PROGRAM');
    }
    if (wait) printable(args[1], 'window title', 255);
    const program = printable(args.slice(separator + 1).join(' '), 'program command', 506);
    printable(`EXEC ${program}`, 'EXEC command');
    if (wait) printable(`WAIT WINDOW ${args[1]} 10000`, 'WAIT WINDOW command');
  } else if (command === 'task') {
    if (args.length !== 2 || !['info', 'csip', 'stack'].includes(args[0])) {
      throw new Error('task requires info|csip|stack and one target');
    }
    target(args[1], 'task target');
  } else if (command === 'module') {
    if (!['info', 'segments', 'proc'].includes(args[0]) ||
        (args[0] === 'proc' ? args.length !== 3 : args.length !== 2)) {
      throw new Error('module requires info|segments NAME or proc NAME PROCEDURE');
    }
    target(args[1], 'module name');
    if (args[0] === 'proc' && !/^(?:#[1-9][0-9]{0,4}|[A-Za-z_][A-Za-z0-9_]{0,63})$/.test(args[2])) {
      throw new Error('module procedure is invalid');
    }
  } else if (command === 'memory') {
    if (args[0] === 'read') {
      if (args.length < 2 || args.length > 3) throw new Error('memory read requires ADDRESS [COUNT]');
      address(args[1]);
      if (args[2] !== undefined) numeric(args[2], 'memory read count', 1, 512);
    } else if (args[0] === 'write-unsafe') {
      if (args.length < 4 || args.at(-1) !== '--confirm-unsafe-memory-write') {
        throw new Error('memory write-unsafe requires ADDRESS HEX... --confirm-unsafe-memory-write');
      }
      address(args[1]);
      if (args.slice(2, -1).length > 64 || args.slice(2, -1).some(byte => !/^[0-9A-Fa-f]{2}$/.test(byte))) {
        throw new Error('memory write-unsafe requires 1-64 two-digit hex bytes');
      }
    } else throw new Error('memory requires read or write-unsafe');
  } else if (command === 'capture') {
    if (args.length > 1) throw new Error('capture accepts at most one target');
    if (args[0] !== undefined && !['desktop', 'active'].includes(args[0]) &&
        !/^[0-9A-Fa-f]{4}$/.test(args[0])) throw new Error('capture target is invalid');
  } else if (command === 'record') {
    if (args[0] === 'start' && args.length === 1) {}
    else if (args[0] === 'stop' && args.length === 2) {}
    else throw new Error('record requires start or stop GUEST-PATH');
    if (args[1] !== undefined) printable(args[1], 'record path', 255);
  } else if (command === 'play') {
    if (['status', 'stop'].includes(args[0])) {
      if (args.length !== 1) throw new Error(`play ${args[0]} takes no arguments`);
    } else {
      if (args.length < 1 || args.length > 2) {
        throw new Error('play requires status|stop or GUEST-PATH [SPEED]');
      }
      printable(args[0], 'playback path', 255);
      if (args[1] !== undefined) numeric(args[1], 'playback speed', 1, 1000);
    }
  } else if (command === 'window') {
    const operation = args[0];
    const arities = { title: 2, controls: 2, 'locator-id': 3, locator: 4,
      'get-text': 3, 'set-text': 4, type: 3, 'click-button': 3, expect: 4,
      'wait-for-text': 5 };
    if (!Object.hasOwn(arities, operation) || args.length !== arities[operation]) {
      throw new Error('window operation or argument count is invalid');
    }
    if (!/^[0-9A-Fa-f]{4}$/.test(args[1]) || args[1] === '0000') {
      throw new Error('window handle is invalid');
    }
    if (['locator-id', 'get-text', 'set-text', 'click-button', 'expect',
      'wait-for-text'].includes(operation)) numeric(args[2], 'control ID', 1, 32767);
    if (operation === 'wait-for-text') numeric(args[4], 'wait timeout', 1, 300000);
    for (const value of args.slice(2)) printable(value, 'window argument');
  } else throw new Error(`Unknown WinAuto command: ${command}`);
  return Object.freeze({ options: Object.freeze(options), command, args: Object.freeze(args) });
}

function emit(output, value, json) {
  const rendered = json || typeof value !== 'string' ? JSON.stringify(value) : value;
  output.write(`${rendered}\n`);
}

async function execute(win, request, output) {
  const { command, args } = request;
  if (command === 'status') return { identity: win.runtimeIdentity ?? await win.identity(),
    playback: await win.playStatus() };
  if (command === 'windows') return win.listWindows();
  if (command === 'send') return win.send(args.slice(1).join(' '));
  if (command === 'sequence') {
    return runSequence(win, request.sequence, {
      requireOk: !request.options.continueOnError,
      onResult: result => emit(output, result, true),
    });
  }
  if (command === 'exec') {
    const wait = args[0] === '--wait-for';
    const separator = wait ? 2 : 1;
    const program = args.slice(separator + 1).join(' ');
    if (!wait) return { instance: await win.ok(`EXEC ${program}`) };
    return { hwnd: (await win.exec(program, { waitFor: args[1] })).hwnd };
  }
  if (command === 'task') return win[`task${args[0][0].toUpperCase()}${args[0].slice(1)}`](args[1]);
  if (command === 'module') {
    if (args[0] === 'info') return win.moduleInfo(args[1]);
    if (args[0] === 'segments') return win.moduleSegments(args[1]);
    return win.moduleProc(args[1], args[2]);
  }
  if (command === 'memory') {
    if (args[0] === 'read') {
      const result = await win.readMemory(args[1], args[2] === undefined ? 16 : Number(args[2]));
      return { selector: result.selector, offset: result.offset, hex: result.bytes.toString('hex') };
    }
    const bytes = Buffer.from(args.slice(2, -1).map(value => parseInt(value, 16)));
    const result = await win.writeMemoryUnsafe(args[1], bytes, { confirmUnsafe: true });
    return { manipulated: true, address: result.address, before: result.before.toString('hex'),
      after: result.after.toString('hex') };
  }
  if (command === 'capture') return win.capture(args[0] ?? 'desktop');
  if (command === 'record') {
    if (args[0] === 'start') { await win.recordStart(); return 'OK'; }
    const recorded = await win.recordStop();
    const saved = await win.recordSave(args[1]);
    if (saved !== recorded) throw new Error('Recorded and saved event counts differ');
    return { events: saved, path: args[1] };
  }
  if (command === 'play') {
    if (args[0] === 'status') return win.playStatus();
    if (args[0] === 'stop') { await win.playStop(); return 'OK'; }
    return { events: await win.play(args[0], args[1] === undefined ? 100 : Number(args[1])) };
  }
  const operation = args[0];
  const window = new Window(win, args[1]);
  if (operation === 'title') return window.title();
  if (operation === 'controls') return window.listControls();
  if (operation === 'locator-id') return { hwnd: (await window.locatorById(Number(args[2]))).hwnd };
  if (operation === 'locator') return { hwnd: (await window.locator(args[2], args[3])).hwnd };
  if (operation === 'get-text') return window.getText(Number(args[2]));
  if (operation === 'set-text') { await window.setText(Number(args[2]), args[3]); return 'OK'; }
  if (operation === 'type') { await window.type(args[2]); return 'OK'; }
  if (operation === 'click-button') { await window.clickButton(Number(args[2])); return 'OK'; }
  if (operation === 'expect') return window.expect(Number(args[2]), args[3]);
  await window.waitForText(Number(args[2]), args[3], Number(args[4]));
  return 'OK';
}

async function runCli(argv = process.argv.slice(2), dependencies = {}) {
  let request = parseArguments(argv);
  if (request.command === 'sequence') {
    request = Object.freeze({ ...request, sequence: loadSequence(path.resolve(request.args[0])) });
  }
  const output = dependencies.output ?? process.stdout;
  if (request.command === 'reset') {
    const resetSession = dependencies.resetSession ?? resetWinAutoSession;
    await resetSession({ ...request.options, confirmGuestReset: true });
    emit(output, 'OK RESET', request.options.json);
    return 'OK RESET';
  }
  const withSession = dependencies.withSession ?? withWinAutoSession;
  return withSession(request.options, async win => {
    const result = await execute(win, request, output);
    if (request.command !== 'sequence') emit(output, result, request.options.json);
    return result;
  });
}

module.exports = { execute, parseArguments, runCli };
