#!/usr/bin/env node

'use strict';

const { DosboxControl } = require('../lib/dosbox-control');

async function main() {
  const control = new DosboxControl();
  console.log(await control.identity());
  console.log(await control.debug('PAUSE'));
  try {
    console.log(await control.debugBatch([
      'REGISTERS',
      'STACK 8',
      'DISASM',
    ]));
  } finally {
    console.log(await control.debug('CONTINUE'));
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
