'use strict';

/**
 * Minimal LANMAN2.1 SMB server for Windows for Workgroups 3.11.
 *
 * Speaks NetBIOS over TCP (port 139) with the LANMAN2.1 dialect.
 * Designed exclusively for WFW 3.11 — no NT LM 0.12, no Unicode,
 * no NTLMSSP, no NT status codes.
 *
 * Usage: sudo node lanman-server.js [share-path]
 */

const net = require('net');
const fs = require('fs');
const path = require('path');

const PORT = 139;
const SHARE_PATH = path.resolve(process.argv[2] || path.join(__dirname, 'share'));
const SHARE_NAME = 'SHARE';
const SERVER_NAME = 'MACHOST';
const DOMAIN_NAME = 'WORKGROUP';

// ─── DOS Error Codes ───────────────────────────────────────────────
// Format: ErrorClass | (Reserved << 8) | (ErrorCode << 16)
// Written as UInt32LE at header offset 5.
const STATUS_SUCCESS = 0x00000000;
const ERRDOS = 0x01;
const ERRSRV = 0x02;
function dosError(cls, code) {
  return cls | (code << 16);
}

const ERR_BAD_FUNC = dosError(ERRDOS, 1);
const ERR_BAD_FILE = dosError(ERRDOS, 2); // file not found
const ERR_BAD_PATH = dosError(ERRDOS, 3);
const ERR_NO_ACCESS = dosError(ERRDOS, 5);
const ERR_BAD_FORMAT = dosError(ERRDOS, 11);
const ERR_NO_FILES = dosError(ERRDOS, 18); // no more files
const ERR_BAD_SHARE = dosError(ERRDOS, 32); // eslint-disable-line no-unused-vars -- protocol spec
const ERR_FILE_EXISTS = dosError(ERRDOS, 80);
const ERR_DIR_NOT_EMPTY = dosError(ERRDOS, 145); // directory not empty
const ERR_ALREADY_EXISTS = dosError(ERRDOS, 183); // already exists
const ERR_BAD_FID = dosError(ERRDOS, 6); // invalid file handle
// eslint-disable-next-line no-unused-vars -- protocol spec: error codes reserved for future use
const ERR_BAD_PIPE = dosError(ERRDOS, 230);
// eslint-disable-next-line no-unused-vars -- protocol spec
const ERR_MORE_DATA = dosError(ERRDOS, 234);
// eslint-disable-next-line no-unused-vars -- protocol spec
const ERR_NO_SUPPORT = dosError(ERRSRV, 0xffff);
// eslint-disable-next-line no-unused-vars -- protocol spec
const ERR_BAD_PW = dosError(ERRSRV, 2);
// eslint-disable-next-line no-unused-vars -- protocol spec
const ERR_ACCESS = dosError(ERRSRV, 4);
// eslint-disable-next-line no-unused-vars -- protocol spec
const ERR_INV_TID = dosError(ERRSRV, 5);
// eslint-disable-next-line no-unused-vars -- protocol spec
const ERR_BAD_UID = dosError(ERRSRV, 91);

// ─── SMB Constants ─────────────────────────────────────────────────
const SMB_MAGIC = Buffer.from([0xff, 0x53, 0x4d, 0x42]);
const SMB_HEADER_LEN = 32;

// Commands
const CMD_CREATE_DIR = 0x00;
const CMD_DELETE_DIR = 0x01;
const CMD_OPEN = 0x02;
const CMD_CREATE = 0x03;
const CMD_CLOSE = 0x04;
const CMD_FLUSH = 0x05;
const CMD_DELETE = 0x06;
const CMD_RENAME = 0x07;
const CMD_QUERY_INFO = 0x08;
const CMD_SET_INFO = 0x09;
const CMD_READ = 0x0a;
const CMD_WRITE = 0x0b;
const CMD_CHECK_DIR = 0x10;
const CMD_PROCESS_EXIT = 0x11;
const CMD_LOCKING = 0x24;
const CMD_TRANSACTION = 0x25;
const CMD_SET_INFO2 = 0x22;
const CMD_QUERY_INFO2 = 0x23;
const CMD_TRANSACTION2 = 0x32;
const CMD_FIND_CLOSE2 = 0x34;
const CMD_ECHO = 0x2b;
const CMD_OPEN_ANDX = 0x2d;
const CMD_READ_ANDX = 0x2e;
const CMD_WRITE_ANDX = 0x2f;
const CMD_TREE_DISCONNECT = 0x71;
const CMD_NEGOTIATE = 0x72;
const CMD_SESSION_SETUP = 0x73;
const CMD_LOGOFF = 0x74;
const CMD_TREE_CONNECT_ANDX = 0x75;
const CMD_QUERY_INFO_DISK = 0x80;
const CMD_SEARCH = 0x81;

const CMD_NAMES = {
  0x00: 'CREATE_DIR',
  0x01: 'DELETE_DIR',
  0x02: 'OPEN',
  0x03: 'CREATE',
  0x04: 'CLOSE',
  0x05: 'FLUSH',
  0x06: 'DELETE',
  0x07: 'RENAME',
  0x08: 'QUERY_INFO',
  0x09: 'SET_INFO',
  0x0a: 'READ',
  0x0b: 'WRITE',
  0x10: 'CHECK_DIR',
  0x11: 'PROCESS_EXIT',
  0x80: 'QUERY_INFO_DISK',
  0x22: 'SET_INFO2',
  0x23: 'QUERY_INFO2',
  0x24: 'LOCKING',
  0x25: 'TRANSACTION',
  0x2b: 'ECHO',
  0x34: 'FIND_CLOSE2',
  0x2d: 'OPEN_ANDX',
  0x2e: 'READ_ANDX',
  0x2f: 'WRITE_ANDX',
  0x32: 'TRANSACTION2',
  0x71: 'TREE_DISCONNECT',
  0x72: 'NEGOTIATE',
  0x73: 'SESSION_SETUP',
  0x74: 'LOGOFF',
  0x75: 'TREE_CONNECT_ANDX',
  0x81: 'SEARCH',
};

// AndX commands (support chaining)
const ANDX_COMMANDS = new Set([
  CMD_SESSION_SETUP,
  CMD_TREE_CONNECT_ANDX,
  CMD_OPEN_ANDX,
  CMD_READ_ANDX,
  CMD_WRITE_ANDX,
  CMD_LOCKING,
  CMD_LOGOFF,
]);

// TRANS2 subcommands
const TRANS2_FIND_FIRST2 = 0x0001;
const TRANS2_FIND_NEXT2 = 0x0002;
const TRANS2_QUERY_PATH_INFO = 0x0005;
const TRANS2_QUERY_FILE_INFO = 0x0007;
const TRANS2_SET_FILE_INFO = 0x0008;

// FIND_FIRST2 / FIND_NEXT2 info levels
const SMB_INFO_STANDARD = 0x0001;

// File attributes (MS-CIFS 2.2.1.2.3)
// eslint-disable-next-line no-unused-vars -- protocol spec: attribute constants for completeness
const ATTR_READONLY = 0x01;
// eslint-disable-next-line no-unused-vars -- protocol spec
const ATTR_HIDDEN = 0x02;
// eslint-disable-next-line no-unused-vars -- protocol spec
const ATTR_SYSTEM = 0x04;
const ATTR_VOLUME = 0x08;
const ATTR_DIRECTORY = 0x10;
const ATTR_ARCHIVE = 0x20;

// ─── NBT (NetBIOS over TCP) Constants ─────────────────────────────
const NBT_SESSION_REQUEST = 0x81;
const NBT_POSITIVE_RESPONSE = 0x82;
const NBT_SESSION_MESSAGE = 0x00;

// ─── SMB Header / Wire Constants ──────────────────────────────────
const SMB_FLAGS_REPLY = 0x81; // Server response: Reply(0x80) | LockRead(0x01)
const ANDX_NONE = 0xff; // No further AndX commands in chain

// Buffer format types (MS-CIFS 2.2.1.1)
const BUF_FMT_DATA_BLOCK = 0x01; // Data block (count + bytes)
const BUF_FMT_DIALECT = 0x02; // Dialect string in NEGOTIATE
const BUF_FMT_ASCII_PATH = 0x04; // eslint-disable-line no-unused-vars -- protocol spec
const BUF_FMT_VARIABLE = 0x05; // Variable block (count + bytes)

// SEARCH entry layout constants (MS-CIFS 2.2.6.7)
const SEARCH_ENTRY_SIZE = 43; // 21-byte resume key + 22-byte file info
const SEARCH_RESUME_KEY_SIZE = 21;
const SEARCH_FILENAME_SIZE = 13; // 8.3 + null, space for 12 chars + NUL
const SEARCH_ATTR_MASK = 0x1f; // Mask for valid search attribute bits

// Misc wire constants
const MAX_FILE_SIZE_32 = 0xffffffff; // Max size representable in 32-bit field
const MAX_UINT16 = 0xffff; // Max value for 16-bit fields
const FID_FLUSH_ALL = 0xffff; // Special FID meaning "flush all open files"

// RAP (Remote Administration Protocol) API codes
const RAP_NET_SHARE_ENUM = 0;
const RAP_NET_SERVER_GET_INFO = 13;

// ─── Helpers ───────────────────────────────────────────────────────

var SERVER_LOG_PATH = path.join(__dirname, 'server.log');
var serverLogFd = null;

function log(tag, msg) {
  var args = Array.prototype.slice.call(arguments, 1);
  var ts = new Date().toISOString().replace('T', ' ').replace(/Z$/, '');
  args[0] = ts + ' [' + tag + ']  ' + args[0];
  console.log.apply(console, args);
  // Also write to server.log
  if (serverLogFd !== null) {
    try {
      var formatted = require('util').format.apply(null, args) + '\n';
      fs.writeSync(serverLogFd, formatted);
    } catch (e) {}
  }
}

/** Convert JS Date to DOS packed time (2 bytes) */
function dosTime(d) {
  return (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
}

/** Convert JS Date to DOS packed date (2 bytes) */
function dosDate(d) {
  return ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
}

// DOS 8.3 valid characters: A-Z 0-9 ! # $ % & ' ( ) - @ ^ _ ` { } ~
// Forbidden: " * + , . / : ; < = > ? [ \ ] | space, control chars, DEL, lowercase
// Reference: https://en.wikipedia.org/wiki/8.3_filename#Directory_table
var DOS_INVALID = /[^A-Z0-9!#$%&'()\-@^_`{}~]/g;

// DOS reserved device names — cannot be used as filenames
var DOS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/;

/** Check if a filename is already a valid 8.3 name */
function isValid83(name) {
  var upper = name.toUpperCase();
  var dot = upper.indexOf('.');
  var base, ext;
  if (dot === -1) {
    base = upper;
    ext = '';
  } else if (upper.indexOf('.', dot + 1) !== -1) {
    return false; // multiple dots
  } else {
    base = upper.substring(0, dot);
    ext = upper.substring(dot + 1);
  }
  if (base.length < 1 || base.length > 8) return false;
  if (ext.length > 3) return false;
  if (/[^A-Z0-9!#$%&'()\-@^_`{}~]/.test(base) || /[^A-Z0-9!#$%&'()\-@^_`{}~]/.test(ext)) return false;
  if (DOS_RESERVED.test(base)) return false;
  return true;
}

/** Sanitize a string for DOS: uppercase, replace + with _, strip leading dots, remove invalid chars */
function dosClean(s) {
  return s
    .toUpperCase()
    .replace(/\+/g, '_') // Win95 convention: + becomes _
    .replace(/^\.+/, '') // strip leading dots
    .replace(DOS_INVALID, ''); // remove everything else not in the allowlist
}

/** Convert a filename to 8.3 uppercase (simple truncation, no collision handling) */
function to83(name) {
  var dot = name.lastIndexOf('.');
  var base, ext;
  if (dot === -1 || dot === 0) {
    base = dosClean(name).substring(0, 8);
    ext = '';
  } else {
    base = dosClean(name.substring(0, dot)).substring(0, 8);
    ext = dosClean(name.substring(dot + 1)).substring(0, 3);
  }
  return { base: base, ext: ext };
}

/**
 * Generate 8.3 short names for all files in a directory listing.
 * Returns a map: longName → shortName (e.g. "My Long File.txt" → "MYLONG~1.TXT")
 * Files that already fit 8.3 are mapped to themselves (uppercased).
 */
function generateShortNames(fileNames) {
  var result = {};
  var used = {}; // track used short names for collision detection

  // First pass: assign names that are already valid 8.3
  fileNames.forEach(function (name) {
    if (isValid83(name)) {
      var short = name.toUpperCase();
      result[name] = short;
      used[short] = true;
    }
  });

  // Second pass: generate tilde names for the rest
  fileNames.forEach(function (name) {
    if (result[name]) return; // already assigned

    var parts = to83(name);
    var ext = parts.ext;
    var baseClean = parts.base;

    // Try ~1 through ~9999
    for (var n = 1; n <= 9999; n++) {
      var suffix = '~' + n;
      var maxBase = 8 - suffix.length;
      var base = baseClean.substring(0, maxBase) + suffix;
      var short = ext ? base + '.' + ext : base;
      if (!used[short]) {
        result[name] = short;
        used[short] = true;
        return;
      }
    }
    // Fallback (should never happen with <9999 files)
    result[name] = baseClean.substring(0, 6) + '~X.' + ext;
  });

  return result;
}

/** Pad 8.3 name into 11-byte space-padded form */
function pad83(name) {
  var p = to83(name);
  var buf = Buffer.alloc(11, 0x20); // space-fill
  Buffer.from(p.base, 'ascii').copy(buf, 0);
  Buffer.from(p.ext, 'ascii').copy(buf, 8);
  return buf;
}

/** Check if a filename matches a DOS wildcard pattern */
function matchWildcard(pattern, filename) {
  var p = pattern.toUpperCase();
  var f = filename.toUpperCase();
  // Common "match all" patterns
  if (p === '*.*' || p === '*') return true;
  // DOS 8.3 wildcard: ????????.??? means "all files"
  if (/^\?{1,8}\.\?{1,3}$/.test(p)) return true;
  // Convert DOS pattern to regex:
  //   ? matches exactly one char in DOS, but at end of 8.3 component it's optional.
  //   For simplicity, treat ? as "zero or one char" and * as "any chars"
  var re = '';
  for (var i = 0; i < p.length; i++) {
    var c = p[i];
    if (c === '?') {
      re += '.?';
    } else if (c === '*') {
      re += '.*';
    } else if ('.+^${}()|[]\\'.indexOf(c) >= 0) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$').test(f);
}

/**
 * Resolve an SMB path (which may use 8.3 short names) to a real local path.
 * Walks each component of the path, checking for short name matches.
 */
function resolveShortPath(sharePath, smbPath) {
  var parts = smbPath
    .replace(/\\/g, '/')
    .split('/')
    .filter(function (s) {
      return s;
    });
  var current = sharePath;

  for (var i = 0; i < parts.length; i++) {
    var component = parts[i].toUpperCase();
    var resolved = path.join(current, component);

    // Check if it exists directly (case-insensitive on macOS, so this often works)
    try {
      fs.statSync(resolved);
      current = resolved;
      continue;
    } catch (e) {}

    // Not found directly — check if it's a short name that maps to a long name
    var found = false;
    try {
      var dirFiles = fs.readdirSync(current);
      var shortMap = generateShortNames(dirFiles);
      for (var j = 0; j < dirFiles.length; j++) {
        if (shortMap[dirFiles[j]] === component) {
          current = path.join(current, dirFiles[j]);
          found = true;
          break;
        }
      }
    } catch (e) {}

    if (!found) {
      return null; // path component not found
    }
  }

  return current;
}

/** Read a null-terminated ASCII string from buffer */
function readAsciiZ(buf, offset) {
  var end = offset;
  while (end < buf.length && buf[end] !== 0) end++;
  return { str: buf.slice(offset, end).toString('ascii'), next: end + 1 };
}

/** Get DOS file attribute for a stat result */
function getFileAttr(stat) {
  return stat.isDirectory() ? ATTR_DIRECTORY : ATTR_ARCHIVE;
}

/** Cap a file size to the 32-bit maximum */
function capSize(size) {
  return Math.min(size, MAX_FILE_SIZE_32);
}

/** Decode DOS packed date(16-bit) + time(16-bit) into a JS Date */
function decodeDosDateTime(dateWord, timeWord) {
  var year = ((dateWord >> 9) & 0x7f) + 1980;
  var month = ((dateWord >> 5) & 0x0f) - 1; // JS months are 0-based
  var day = dateWord & 0x1f;
  var hours = (timeWord >> 11) & 0x1f;
  var mins = (timeWord >> 5) & 0x3f;
  var secs = (timeWord & 0x1f) * 2; // 2-second resolution
  return new Date(year, month, day, hours, mins, secs);
}

/**
 * Write 22-byte SMB_INFO_STANDARD file info block into a buffer.
 * Used by QUERY_PATH_INFO, QUERY_FILE_INFO, and FIND responses.
 * Layout: CreationDate(2) CreationTime(2) AccessDate(2) AccessTime(2)
 *         WriteDate(2) WriteTime(2) FileSize(4) AllocSize(4) Attrs(2)
 */
function writeInfoStandard(buf, off, stat) {
  var ctime = stat.birthtime || stat.mtime;
  buf.writeUInt16LE(dosDate(ctime), off); // CreationDate
  buf.writeUInt16LE(dosTime(ctime), off + 2); // CreationTime
  buf.writeUInt16LE(dosDate(stat.atime), off + 4); // LastAccessDate
  buf.writeUInt16LE(dosTime(stat.atime), off + 6); // LastAccessTime
  buf.writeUInt16LE(dosDate(stat.mtime), off + 8); // LastWriteDate
  buf.writeUInt16LE(dosTime(stat.mtime), off + 10); // LastWriteTime
  var size = stat.isDirectory() ? 0 : capSize(stat.size);
  buf.writeUInt32LE(size, off + 12); // FileDataSize
  buf.writeUInt32LE(size, off + 16); // FileAllocationSize
  buf.writeUInt16LE(getFileAttr(stat), off + 20); // Attributes
}

/**
 * Resolve an SMB path to a local path, handling root (\\ or empty) as share root.
 * Returns null if path not found.
 */
function resolvePathOrRoot(conn, smbPath) {
  if (smbPath === '' || smbPath === '\\') return conn.sharePath;
  return resolveShortPath(conn.sharePath, smbPath);
}

/**
 * Resolve path for a new file: parent directory must exist, base name is literal.
 * Falls back to joining smbPath directly onto sharePath if no separator.
 */
function resolveNewFilePath(conn, smbPath) {
  var lastSep = smbPath.lastIndexOf('\\');
  if (lastSep >= 0) {
    var parentSmb = smbPath.substring(0, lastSep) || '\\';
    var baseName = smbPath.substring(lastSep + 1);
    var parentLocal = resolvePathOrRoot(conn, parentSmb);
    if (parentLocal) return path.join(parentLocal, baseName);
  }
  return path.join(conn.sharePath, smbPath.replace(/\\/g, path.sep));
}

/**
 * Allocate a virtual file handle and register it in conn.openFiles.
 * Returns the assigned FID.
 */
function openVirtualFile(conn, vtype, fileName) {
  var fid = nextFid++;
  conn.openFiles[fid] = { virtual: true, type: vtype, name: fileName };
  log('magic', 'virtual open: %s → fid=%d', fileName, fid);
  return fid;
}

/** Build a standard AndX result object for the command dispatch chain */
function andxResult(cmd, status, params, data, extraHdr) {
  return {
    cmd: cmd,
    status: status,
    params: params || Buffer.alloc(0),
    data: data || Buffer.alloc(0),
    extraHdr: extraHdr,
  };
}

/** Build an AndX error result */
function andxError(cmd, status) {
  return andxResult(cmd, status, Buffer.alloc(0), Buffer.alloc(0));
}

/**
 * Build a TRANSACTION or TRANSACTION2 response.
 * WordCount=10 (20 bytes of params): standard layout for both commands.
 * The only difference is the command byte in the header.
 */
function buildTransResponse(cmd, transParams, transData, msg) {
  var rParams = Buffer.alloc(20);
  rParams.writeUInt16LE(transParams.length, 0); // TotalParameterCount
  rParams.writeUInt16LE(transData.length, 2); // TotalDataCount
  rParams.writeUInt16LE(0, 4); // Reserved
  rParams.writeUInt16LE(transParams.length, 6); // ParameterCount
  // ParameterOffset: header(32) + WordCount(1) + params(20) + ByteCount(2) = 55
  var paramOff = SMB_HEADER_LEN + 1 + 20 + 2;
  rParams.writeUInt16LE(paramOff, 8); // ParameterOffset
  rParams.writeUInt16LE(0, 10); // ParameterDisplacement
  rParams.writeUInt16LE(transData.length, 12); // DataCount
  var dataOff = paramOff + transParams.length;
  var pad = dataOff % 2 !== 0 ? 1 : 0; // Pad to word boundary
  dataOff += pad;
  rParams.writeUInt16LE(dataOff, 14); // DataOffset
  rParams.writeUInt16LE(0, 16); // DataDisplacement
  rParams[18] = 0; // SetupCount
  rParams[19] = 0; // Reserved

  var dataBuf =
    pad > 0 ? Buffer.concat([transParams, Buffer.alloc(pad), transData]) : Buffer.concat([transParams, transData]);

  return buildResponse(encodeHeader(cmd, STATUS_SUCCESS, msg.hdr), rParams, dataBuf);
}

// ─── Path normalization ────────────────────────────────────────────
// WFW 3.11's redirector includes the share name as a path prefix.
// e.g. dir z: sends "\SHARE", dir z:\*.* sends "\SHARE\*.*".
// The TID already identifies the share, so strip the prefix.
function stripSharePrefix(smbPath) {
  // Match \SHARE or \SHARE\ at the start (case-insensitive)
  var prefix = '\\' + SHARE_NAME;
  var upper = smbPath.toUpperCase();
  if (upper === prefix) {
    return '\\'; // bare \SHARE → root
  }
  if (upper.indexOf(prefix + '\\') === 0) {
    return smbPath.substring(prefix.length); // \SHARE\foo → \foo
  }
  return smbPath;
}

// ─── Virtual Files ────────────────────────────────────────────────
// Magic filenames that the server intercepts. These live in _MAGIC_
// or at the share root (__LOG__). WFW has no HTTP, no TLS — so we
// make files the universal interface.
//
// Pattern: write a command → read the result.
// Write empty/blank → reset to default state.
// Async ops return "BUSY" while processing, with a timeout.

var VIRTUAL_FILES = {
  __LOG__: 'log',
  '_TIME_.TXT': 'time',
  '_CLIP_.TXT': 'clip',
  '_WGET_.TXT': 'wget',
  '_EXEC_.TXT': 'exec',
  '_STATS_.TXT': 'stats',
  '_AI_.TXT': 'ai',
};

// Host-side log file for test results (readable with cat/Read tool)
var TEST_LOG_PATH = path.join(__dirname, 'test-results.log');

// ─── Magic file state (global, persists across connections) ───────
var magicState = {
  time: { format: null }, // null = default format
  clip: {}, // stateless — always live
  wget: { status: 'idle', url: null, result: null, error: null },
  exec: { status: 'idle', cmd: null, result: null, error: null },
  stats: {}, // stateless — always live
  ai: { status: 'idle', prompt: null, result: null, history: [] },
};

var MAGIC_TIMEOUT = 30000; // 30s timeout for async ops
var serverStartTime = Date.now();
var serverStats = { connections: 0, commands: 0, bytesRead: 0, bytesWritten: 0 };

function getVirtualType(smbPath) {
  var parts = smbPath.replace(/\\/g, '/').split('/');
  var base = parts[parts.length - 1].toUpperCase();
  // Check if it's in _MAGIC_ directory or is __LOG__ at root
  if (VIRTUAL_FILES[base]) {
    // Verify it's either __LOG__ (root ok) or inside _MAGIC_
    var upper = smbPath.toUpperCase().replace(/\\/g, '/');
    if (base === '__LOG__') return VIRTUAL_FILES[base];
    if (upper.indexOf('_MAGIC_') >= 0) return VIRTUAL_FILES[base];
    return null; // not in _MAGIC_ dir, not a virtual file
  }
  return null;
}

// ─── strftime implementation ──────────────────────────────────────
function strftime(fmt, d) {
  var days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var daysShort = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  var monthsShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }
  function pad3(n) {
    return n < 10 ? '00' + n : n < 100 ? '0' + n : '' + n;
  }

  var result = '';
  for (var i = 0; i < fmt.length; i++) {
    if (fmt[i] === '%' && i + 1 < fmt.length) {
      var c = fmt[++i];
      switch (c) {
        case 'Y':
          result += d.getFullYear();
          break;
        case 'y':
          result += pad2(d.getFullYear() % 100);
          break;
        case 'm':
          result += pad2(d.getMonth() + 1);
          break;
        case 'd':
          result += pad2(d.getDate());
          break;
        case 'H':
          result += pad2(d.getHours());
          break;
        case 'M':
          result += pad2(d.getMinutes());
          break;
        case 'S':
          result += pad2(d.getSeconds());
          break;
        case 'I':
          var h12 = d.getHours() % 12;
          result += pad2(h12 === 0 ? 12 : h12);
          break;
        case 'p':
          result += d.getHours() < 12 ? 'AM' : 'PM';
          break;
        case 'A':
          result += days[d.getDay()];
          break;
        case 'a':
          result += daysShort[d.getDay()];
          break;
        case 'B':
          result += months[d.getMonth()];
          break;
        case 'b':
          result += monthsShort[d.getMonth()];
          break;
        case 'j': // day of year
          var start = new Date(d.getFullYear(), 0, 0);
          var diff = d - start;
          result += pad3(Math.floor(diff / 86400000));
          break;
        case 'Z': // timezone abbreviation
          var tzStr = d.toTimeString();
          var m = tzStr.match(/\(([^)]+)\)/);
          result += m ? m[1] : '';
          break;
        case 's':
          result += Math.floor(d.getTime() / 1000);
          break; // unix timestamp
        case 'n':
          result += '\n';
          break;
        case 't':
          result += '\t';
          break;
        case '%':
          result += '%';
          break;
        default:
          result += '%' + c;
      }
    } else {
      result += fmt[i];
    }
  }
  return result;
}

// ─── Magic file read handlers ─────────────────────────────────────
// Each returns a string. The framework converts to Buffer for SMB response.

function magicRead(type) {
  var now = new Date();
  switch (type) {
    case 'time':
      var fmt = magicState.time.format;
      if (!fmt) {
        // Default format
        var tz = now.toTimeString().match(/\(([^)]+)\)/);
        var tzName = tz ? tz[1] : '';
        return strftime('%a %Y-%m-%d %H:%M:%S ', now) + tzName + '\r\n';
      }
      return strftime(fmt, now) + '\r\n';

    case 'clip':
      try {
        var result = require('child_process').execSync('pbpaste', {
          encoding: 'ascii',
          timeout: 5000,
          maxBuffer: 32768,
        });
        return result.replace(/\n/g, '\r\n') || '(clipboard empty)\r\n';
      } catch (e) {
        return 'ERROR: Cannot read clipboard\r\n';
      }

    case 'wget':
      if (magicState.wget.status === 'busy') return 'BUSY: Fetching ' + magicState.wget.url + '\r\n';
      if (magicState.wget.error) return 'ERROR: ' + magicState.wget.error + '\r\n';
      if (magicState.wget.result) return magicState.wget.result;
      return 'Write a URL to fetch it.\r\nExample: echo http://example.com > z:\\_MAGIC_\\_WGET_.TXT\r\nThen: type z:\\_MAGIC_\\_WGET_.TXT\r\n';

    case 'exec':
      if (magicState.exec.status === 'busy') return 'BUSY: Running ' + magicState.exec.cmd + '\r\n';
      if (magicState.exec.error) return 'ERROR: ' + magicState.exec.error + '\r\n';
      if (magicState.exec.result) return magicState.exec.result;
      return 'Write a command to execute on host.\r\nExample: echo ls -la > z:\\_MAGIC_\\_EXEC_.TXT\r\nThen: type z:\\_MAGIC_\\_EXEC_.TXT\r\n';

    case 'stats':
      var uptime = Math.floor((Date.now() - serverStartTime) / 1000);
      var h = Math.floor(uptime / 3600);
      var m = Math.floor((uptime % 3600) / 60);
      var s = uptime % 60;
      return (
        'LANMAN2.1 SMB Server Stats\r\n' +
        '─────────────────────────\r\n' +
        'Uptime:       ' +
        h +
        'h ' +
        m +
        'm ' +
        s +
        's\r\n' +
        'Connections:  ' +
        serverStats.connections +
        '\r\n' +
        'Commands:     ' +
        serverStats.commands +
        '\r\n' +
        'Bytes read:   ' +
        serverStats.bytesRead +
        '\r\n' +
        'Bytes written:' +
        serverStats.bytesWritten +
        '\r\n'
      );

    case 'ai':
      if (magicState.ai.status === 'busy') return 'BUSY: Thinking...\r\n';
      if (magicState.ai.error) return 'ERROR: ' + magicState.ai.error + '\r\n';
      if (magicState.ai.result) return magicState.ai.result;
      return 'Write a question to chat with Claude.\r\nExample: echo What is the meaning of life? > z:\\_MAGIC_\\_AI_.TXT\r\nThen: type z:\\_MAGIC_\\_AI_.TXT\r\n';

    default:
      return '';
  }
}

// ─── Magic file write handlers ────────────────────────────────────
// Each takes the written text (trimmed). Empty = reset.

function magicWrite(type, text) {
  var trimmed = text.replace(/\r\n/g, '\n').replace(/\n$/, '').trim();

  // Empty write = reset
  if (trimmed === '' || trimmed === '.') {
    switch (type) {
      case 'time':
        magicState.time.format = null;
        break;
      case 'wget':
        magicState.wget = { status: 'idle', url: null, result: null, error: null };
        break;
      case 'exec':
        magicState.exec = { status: 'idle', cmd: null, result: null, error: null };
        break;
      case 'ai':
        magicState.ai = { status: 'idle', prompt: null, result: null, history: [] };
        break;
    }
    log('magic', '%s: reset', type);
    return;
  }

  switch (type) {
    case 'time':
      // Keywords or strftime format
      var TIME_KEYWORDS = {
        UNIX: '%s',
        UTC: '%Y-%m-%dT%H:%M:%SZ',
        ISO: '%Y-%m-%dT%H:%M:%S',
        DATE: '%Y-%m-%d',
        TIME: '%H:%M:%S',
        DOS: '%m-%d-%y %I:%M%p',
      };
      if (TIME_KEYWORDS[trimmed.toUpperCase()]) {
        magicState.time.format = TIME_KEYWORDS[trimmed.toUpperCase()];
      } else if (trimmed.indexOf('%') >= 0) {
        magicState.time.format = trimmed;
      } else {
        magicState.time.format = null; // unrecognized → default
      }
      log('magic', 'TIME: format set to %s', magicState.time.format || 'default');
      break;

    case 'clip':
      try {
        require('child_process').execSync('pbcopy', {
          input: trimmed,
          encoding: 'ascii',
          timeout: 5000,
        });
        log('magic', 'CLIP: wrote %d bytes to clipboard', trimmed.length);
      } catch (e) {
        log('magic', 'CLIP: write error: %s', e.message);
      }
      break;

    case 'wget':
      var url = trimmed;
      // Ensure URL has protocol
      if (url.indexOf('://') < 0) url = 'http://' + url;
      magicState.wget = { status: 'busy', url: url, result: null, error: null };
      log('magic', 'WGET: fetching %s', url);

      var httpMod = url.indexOf('https:') === 0 ? require('https') : require('http');
      var timer = setTimeout(function () {
        if (magicState.wget.status === 'busy') {
          magicState.wget.status = 'idle';
          magicState.wget.error = 'Timeout after ' + MAGIC_TIMEOUT / 1000 + 's';
          log('magic', 'WGET: timeout');
        }
      }, MAGIC_TIMEOUT);

      httpMod
        .get(url, function (res) {
          var body = '';
          // Follow redirects
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            var redir = res.headers.location;
            log('magic', 'WGET: redirect to %s', redir);
            var redirMod = redir.indexOf('https:') === 0 ? require('https') : require('http');
            redirMod
              .get(redir, function (res2) {
                var body2 = '';
                res2.on('data', function (c) {
                  body2 += c;
                  if (body2.length > 32768) res2.destroy();
                });
                res2.on('end', function () {
                  clearTimeout(timer);
                  magicState.wget.status = 'done';
                  magicState.wget.result = htmlToText(body2);
                  log('magic', 'WGET: done, %d bytes', magicState.wget.result.length);
                });
              })
              .on('error', function (e) {
                clearTimeout(timer);
                magicState.wget.status = 'idle';
                magicState.wget.error = e.message;
              });
            return;
          }
          res.on('data', function (chunk) {
            body += chunk;
            if (body.length > 32768) res.destroy();
          });
          res.on('end', function () {
            clearTimeout(timer);
            magicState.wget.status = 'done';
            magicState.wget.result = htmlToText(body);
            log('magic', 'WGET: done, %d bytes', magicState.wget.result.length);
          });
        })
        .on('error', function (e) {
          clearTimeout(timer);
          magicState.wget.status = 'idle';
          magicState.wget.error = e.message;
          log('magic', 'WGET: error: %s', e.message);
        });
      break;

    case 'exec':
      magicState.exec = { status: 'busy', cmd: trimmed, result: null, error: null };
      log('magic', 'EXEC: running: %s', trimmed);

      var timer2 = setTimeout(function () {
        if (magicState.exec.status === 'busy') {
          magicState.exec.status = 'idle';
          magicState.exec.error = 'Timeout after ' + MAGIC_TIMEOUT / 1000 + 's';
        }
      }, MAGIC_TIMEOUT);

      require('child_process').exec(
        trimmed,
        {
          timeout: MAGIC_TIMEOUT,
          maxBuffer: 32768,
          cwd: SHARE_PATH,
        },
        function (err, stdout, stderr) {
          clearTimeout(timer2);
          if (err && !stdout && !stderr) {
            magicState.exec.status = 'idle';
            magicState.exec.error = err.message;
            log('magic', 'EXEC: error: %s', err.message);
          } else {
            magicState.exec.status = 'done';
            var output = (stdout || '') + (stderr ? '\n[STDERR]\n' + stderr : '');
            magicState.exec.result = output.replace(/\n/g, '\r\n');
            log('magic', 'EXEC: done, %d bytes output', magicState.exec.result.length);
          }
        },
      );
      break;

    case 'ai':
      magicState.ai.status = 'busy';
      magicState.ai.prompt = trimmed;
      magicState.ai.result = null;
      magicState.ai.error = null;
      log('magic', 'AI: prompt: %s', trimmed);

      // Build messages from history + new prompt
      var messages = [];
      for (var i = 0; i < magicState.ai.history.length; i++) {
        messages.push(magicState.ai.history[i]);
      }
      messages.push({ role: 'user', content: trimmed });

      var aiTimer = setTimeout(function () {
        if (magicState.ai.status === 'busy') {
          magicState.ai.status = 'idle';
          magicState.ai.error = 'Timeout after ' + MAGIC_TIMEOUT / 1000 + 's';
        }
      }, MAGIC_TIMEOUT);

      // Call Claude API via Anthropic SDK or raw HTTP
      var apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        clearTimeout(aiTimer);
        magicState.ai.status = 'idle';
        magicState.ai.error = 'ANTHROPIC_API_KEY not set';
        log('magic', 'AI: no API key');
        break;
      }

      var postData = JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system:
          'You are a helpful assistant responding via a DOS terminal on Windows for Workgroups 3.11. Keep responses concise and plain-text friendly. Max ~60 chars per line for readability. No markdown formatting.',
        messages: messages,
      });

      var aiReq = require('https').request(
        {
          hostname: 'api.anthropic.com',
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Length': Buffer.byteLength(postData),
          },
        },
        function (res) {
          var body = '';
          res.on('data', function (c) {
            body += c;
          });
          res.on('end', function () {
            clearTimeout(aiTimer);
            try {
              var json = JSON.parse(body);
              if (json.content && json.content[0] && json.content[0].text) {
                var reply = json.content[0].text;
                magicState.ai.status = 'done';
                magicState.ai.result = reply.replace(/\n/g, '\r\n') + '\r\n';
                // Store in history for multi-turn
                magicState.ai.history.push({ role: 'user', content: trimmed });
                magicState.ai.history.push({ role: 'assistant', content: reply });
                // Cap history at 20 messages
                if (magicState.ai.history.length > 20) {
                  magicState.ai.history = magicState.ai.history.slice(-20);
                }
                log('magic', 'AI: response: %s', reply.substring(0, 100));
              } else if (json.error) {
                magicState.ai.status = 'idle';
                magicState.ai.error = json.error.message || 'API error';
                log('magic', 'AI: API error: %s', magicState.ai.error);
              }
            } catch (e) {
              magicState.ai.status = 'idle';
              magicState.ai.error = 'Parse error';
              log('magic', 'AI: parse error');
            }
          });
        },
      );
      aiReq.on('error', function (e) {
        clearTimeout(aiTimer);
        magicState.ai.status = 'idle';
        magicState.ai.error = e.message;
        log('magic', 'AI: request error: %s', e.message);
      });
      aiReq.write(postData);
      aiReq.end();
      break;
  }
}

// ─── HTML to readable text ────────────────────────────────────────
function htmlToText(html) {
  // Very basic HTML → readable text for DOS
  var text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<title[^>]*>([\s\S]*?)<\/title>/gi, '# $1\n\n')
    .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, '\n## $1\n')
    .replace(/<li[^>]*>/gi, '* ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<p[^>]*>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '') // strip remaining tags
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n') // collapse blank lines
    .trim();
  return text.replace(/\n/g, '\r\n') + '\r\n';
}

// ─── SMB Header ────────────────────────────────────────────────────

function decodeHeader(buf) {
  return {
    command: buf[4],
    status: buf.readUInt32LE(5),
    flags: buf[9],
    flags2: buf.readUInt16LE(10),
    pidHigh: buf.readUInt16LE(12),
    signature: buf.slice(14, 22),
    tid: buf.readUInt16LE(24),
    pid: buf.readUInt16LE(26),
    uid: buf.readUInt16LE(28),
    mid: buf.readUInt16LE(30),
  };
}

function encodeHeader(cmd, status, hdr, extra) {
  var buf = Buffer.alloc(SMB_HEADER_LEN);
  SMB_MAGIC.copy(buf, 0);
  buf[4] = cmd;
  buf.writeUInt32LE(status, 5);
  buf[9] = SMB_FLAGS_REPLY; // Reply(0x80) | LockRead(0x01)
  buf.writeUInt16LE(0, 10); // flags2: 0 (no unicode, no NT status)
  buf.writeUInt16LE(0, 12); // pidHigh
  buf.fill(0, 14, 22); // signature
  buf.fill(0, 22, 24); // reserved
  buf.writeUInt16LE(extra && extra.tid !== undefined ? extra.tid : hdr ? hdr.tid : 0, 24);
  buf.writeUInt16LE(hdr ? hdr.pid : 0, 26);
  buf.writeUInt16LE(extra && extra.uid !== undefined ? extra.uid : hdr ? hdr.uid : 0, 28);
  buf.writeUInt16LE(hdr ? hdr.mid : 0, 30);
  return buf;
}

// ─── Message Assembly ──────────────────────────────────────────────

/** Build an SMB response: header + wordCount + params + byteCount + data */
function buildResponse(headerBuf, params, data) {
  var wordCount = params.length / 2;
  var byteCount = data.length;
  var body = Buffer.alloc(1 + params.length + 2 + data.length);
  var off = 0;
  body[off++] = wordCount;
  params.copy(body, off);
  off += params.length;
  body.writeUInt16LE(byteCount, off);
  off += 2;
  data.copy(body, off);
  var smb = Buffer.concat([headerBuf, body]);
  // Wrap in NBT session message
  var nbt = Buffer.alloc(4);
  nbt.writeUInt32BE(smb.length, 0); // type=0x00 + 24-bit length
  return Buffer.concat([nbt, smb]);
}

/** Build an error response with empty params/data */
function buildErrorResponse(cmd, status, hdr) {
  return buildResponse(encodeHeader(cmd, status, hdr), Buffer.alloc(0), Buffer.alloc(0));
}

// ─── Parse incoming SMB messages (with AndX chaining) ──────────────

function parseMessage(smbBuf) {
  var hdr = decodeHeader(smbBuf);
  var commands = [];
  var off = SMB_HEADER_LEN;

  // Parse first command
  var wordCount = smbBuf[off++];
  var params = smbBuf.slice(off, off + wordCount * 2);
  off += wordCount * 2;
  var byteCount = smbBuf.readUInt16LE(off);
  off += 2;
  var data = smbBuf.slice(off, off + byteCount);

  commands.push({ cmd: hdr.command, params: params, data: data });

  // Follow AndX chain
  if (ANDX_COMMANDS.has(hdr.command) && params.length >= 4) {
    var nextCmd = params[0];
    var andxOff = params.readUInt16LE(2);
    while (nextCmd !== ANDX_NONE && andxOff > 0 && andxOff < smbBuf.length) {
      off = andxOff;
      wordCount = smbBuf[off++];
      params = smbBuf.slice(off, off + wordCount * 2);
      off += wordCount * 2;
      byteCount = smbBuf.readUInt16LE(off);
      off += 2;
      data = smbBuf.slice(off, off + byteCount);

      commands.push({ cmd: nextCmd, params: params, data: data });

      if (ANDX_COMMANDS.has(nextCmd) && params.length >= 4) {
        nextCmd = params[0];
        andxOff = params.readUInt16LE(2);
      } else {
        break;
      }
    }
  }

  return { hdr: hdr, commands: commands, raw: smbBuf };
}

// ─── Connection State ──────────────────────────────────────────────

var nextUid = 1;
var nextTid = 1;
var nextFid = 1;

function createConnection(socket) {
  return {
    socket: socket,
    uid: 0,
    tid: 0,
    authenticated: false,
    treeConnected: false,
    sharePath: null,
    openFiles: {}, // fid -> { path, fd, name }
    searches: {}, // searchId -> { entries, position }
    nextSearchId: 1,
  };
}

// ─── Command Handlers ──────────────────────────────────────────────

function handleNegotiate(msg, conn) {
  // Parse dialects
  var dialects = [];
  var data = msg.commands[0].data;
  var pos = 0;
  while (pos < data.length) {
    if (data[pos] !== BUF_FMT_DIALECT) {
      pos++;
      continue;
    }
    pos++;
    var end = data.indexOf(0x00, pos);
    if (end === -1) break;
    dialects.push(data.slice(pos, end).toString('ascii'));
    pos = end + 1;
  }
  log('smb', 'Dialects: %s', dialects.join(', '));

  // Select best LANMAN dialect (Samba priority order)
  var prefer = ['DOS LM1.2X002', 'LM1.2X002', 'LANMAN2.1', 'DOS LANMAN2.1', 'MICROSOFT NETWORKS 3.0', 'LANMAN1.0'];
  var dialectIdx = -1;
  for (var i = 0; i < prefer.length; i++) {
    var idx = dialects.indexOf(prefer[i]);
    if (idx !== -1) {
      dialectIdx = idx;
      break;
    }
  }
  if (dialectIdx === -1) {
    log('smb', 'No compatible dialect!');
    return buildErrorResponse(CMD_NEGOTIATE, ERR_BAD_FUNC, msg.hdr);
  }
  log('smb', 'Selected dialect %d: "%s"', dialectIdx, dialects[dialectIdx]);

  // Build LANMAN2.1 response: WordCount=13, params=26 bytes
  var params = Buffer.alloc(26);
  var off = 0;
  params.writeUInt16LE(dialectIdx, off);
  off += 2; // DialectIndex
  params.writeUInt16LE(0x0001, off);
  off += 2; // SecurityMode: user-level, plaintext
  params.writeUInt16LE(2048, off);
  off += 2; // MaxBufferSize
  params.writeUInt16LE(2, off);
  off += 2; // MaxMpxCount
  params.writeUInt16LE(1, off);
  off += 2; // MaxNumberVcs
  params.writeUInt16LE(0, off);
  off += 2; // RawMode: disabled
  params.writeUInt32LE(0, off);
  off += 4; // SessionKey
  var now = new Date();
  params.writeUInt16LE(dosTime(now), off);
  off += 2; // ServerTime
  params.writeUInt16LE(dosDate(now), off);
  off += 2; // ServerDate
  params.writeInt16LE(now.getTimezoneOffset(), off);
  off += 2; // ServerTimeZone
  params.writeUInt16LE(0, off);
  off += 2; // EncryptionKeyLength: 0 (plaintext)
  params.writeUInt16LE(0, off); // Reserved

  // Per Samba: LANMAN responses have NO data (no domain name)
  return buildResponse(encodeHeader(CMD_NEGOTIATE, STATUS_SUCCESS, msg.hdr), params, Buffer.alloc(0));
}

function handleSessionSetup(msg, conn) {
  var params = msg.commands[0].params;
  var data = msg.commands[0].data;

  // Parse LANMAN SESSION_SETUP_ANDX: WordCount=10, params=20 bytes
  // Skip andX header (4 bytes)
  var _maxBuf = params.readUInt16LE(4); // eslint-disable-line no-unused-vars -- parsed for protocol documentation
  var _maxMpx = params.readUInt16LE(6); // eslint-disable-line no-unused-vars -- parsed for protocol documentation
  var _vcNum = params.readUInt16LE(8); // eslint-disable-line no-unused-vars -- parsed for protocol documentation
  var _sessKey = params.readUInt32LE(10); // eslint-disable-line no-unused-vars -- parsed for protocol documentation
  var pwLen = params.readUInt16LE(14);
  // bytes 16-19: reserved

  // Parse data: password + accountName\0 + primaryDomain\0 + nativeOS\0 + nativeLanMan\0
  var doff = pwLen; // skip password
  var r = readAsciiZ(data, doff);
  var accountName = r.str;
  doff = r.next;
  r = readAsciiZ(data, doff);
  var primaryDomain = r.str;
  doff = r.next;
  r = readAsciiZ(data, doff);
  var nativeOS = r.str;
  doff = r.next;
  r = readAsciiZ(data, doff);
  var nativeLanMan = r.str;

  log('smb', 'SESSION_SETUP: account=%s domain=%s os=%s lanman=%s', accountName, primaryDomain, nativeOS, nativeLanMan);

  // Accept all logins (guest mode)
  conn.uid = nextUid++;
  conn.authenticated = true;
  conn.accountName = accountName;

  // Build response: WordCount=3 (AndX), params=6 bytes
  var rParams = Buffer.alloc(6);
  rParams[0] = ANDX_NONE; // AndXCommand: no further commands
  rParams[1] = 0x00; // AndXReserved
  rParams.writeUInt16LE(0, 2); // AndXOffset (updated if chaining)
  rParams.writeUInt16LE(0, 4); // Action: 0 (logged in as specified)

  // Data: nativeOS\0 + nativeLanMan\0 + primaryDomain\0 (OEM)
  var rData = Buffer.concat([
    Buffer.from('Unix\0', 'ascii'),
    Buffer.from('LANMAN2.1\0', 'ascii'),
    Buffer.from(DOMAIN_NAME + '\0', 'ascii'),
  ]);

  return andxResult(CMD_SESSION_SETUP, STATUS_SUCCESS, rParams, rData, { uid: conn.uid });
}

function handleTreeConnect(msg, cmdIdx, conn) {
  var params = msg.commands[cmdIdx].params;
  var data = msg.commands[cmdIdx].data;

  // Parse: skip andX header (4 bytes), flags (2), passwordLength (2)
  var pwLen = params.readUInt16LE(6);

  // Data: password + path\0 + service\0 (all OEM/ASCII)
  var doff = pwLen;
  var r = readAsciiZ(data, doff);
  var sharePath = r.str;
  doff = r.next;
  r = readAsciiZ(data, doff);
  var service = r.str;

  log('smb', 'TREE_CONNECT: path=%s service=%s', sharePath, service);

  // Extract share name from \\SERVER\SHARE
  var parts = sharePath.split('\\').filter(function (s) {
    return s;
  });
  var reqShare = parts.length > 0 ? parts[parts.length - 1].toUpperCase() : '';

  if (reqShare !== SHARE_NAME) {
    log('smb', 'Share not found: %s', reqShare);
    return andxError(CMD_TREE_CONNECT_ANDX, ERR_BAD_PATH);
  }

  conn.tid = nextTid++;
  conn.treeConnected = true;
  conn.sharePath = SHARE_PATH;

  // Response params: WordCount=3 (AndX), 6 bytes
  var rParams = Buffer.alloc(6);
  rParams[0] = ANDX_NONE; // AndXCommand: no further commands
  rParams[1] = 0x00; // AndXReserved
  rParams.writeUInt16LE(0, 2); // AndXOffset
  rParams.writeUInt16LE(0x01, 4); // OptionalSupport: SMB_SUPPORT_SEARCH_BITS

  // Data: service\0 + nativeFileSystem\0 (ASCII)
  var rData = Buffer.concat([Buffer.from('A:\0', 'ascii'), Buffer.from('FAT\0', 'ascii')]);

  return andxResult(CMD_TREE_CONNECT_ANDX, STATUS_SUCCESS, rParams, rData, { tid: conn.tid });
}

function handleTreeDisconnect(msg, conn) {
  conn.treeConnected = false;
  conn.tid = 0;
  return buildResponse(encodeHeader(CMD_TREE_DISCONNECT, STATUS_SUCCESS, msg.hdr), Buffer.alloc(0), Buffer.alloc(0));
}

function handleSearch(msg, conn) {
  var params = msg.commands[0].params;
  var data = msg.commands[0].data;

  var maxCount = params.readUInt16LE(0);
  var searchAttrs = params.readUInt16LE(2);

  // Parse data: BufferFormat(0x04) + FileName\0 + BufferFormat(0x05) + ResumeKeyLen(2) + ResumeKey
  var doff = 1; // skip BUF_FMT_ASCII_PATH (0x04)
  var r = readAsciiZ(data, doff);
  var rawPattern = r.str;
  var pattern = stripSharePrefix(rawPattern);
  doff = r.next + 1; // skip BUF_FMT_VARIABLE (0x05)
  var resumeKeyLen = data.readUInt16LE(doff);
  doff += 2;

  log(
    'smb',
    'SEARCH: pattern=%s maxCount=%d attrs=0x%s resumeKeyLen=%d',
    pattern,
    maxCount,
    searchAttrs.toString(16),
    resumeKeyLen,
  );
  if (rawPattern !== pattern) log('smb', 'SEARCH: stripped share prefix: %s → %s', rawPattern, pattern);

  // Separate directory from file pattern
  var lastSlash = pattern.lastIndexOf('\\');
  var dir, mask;
  if (lastSlash >= 0) {
    dir = pattern.substring(0, lastSlash) || '\\';
    mask = pattern.substring(lastSlash + 1);
  } else {
    dir = '\\';
    mask = pattern;
  }

  // Per MS-CIFS: empty FileName → return all files in the directory
  if (mask === '') {
    mask = '*.*';
  }

  // Map SMB path to local filesystem path
  var localDir = path.join(conn.sharePath, dir.replace(/\\/g, path.sep));

  // Handle resume (search next)
  var startIndex = 0;
  if (resumeKeyLen === SEARCH_RESUME_KEY_SIZE) {
    var resumeKey = data.slice(doff, doff + SEARCH_RESUME_KEY_SIZE);
    // resumeKey[12] is the search handle (unused, kept for protocol reference)
    startIndex = resumeKey.readUInt32LE(13) + 1; // continue after last returned entry
  }

  // Volume label search
  if ((searchAttrs & SEARCH_ATTR_MASK) === ATTR_VOLUME) {
    log('smb', 'SEARCH: volume label request');
    var entry = Buffer.alloc(SEARCH_ENTRY_SIZE);
    // Resume key (21 bytes): search attrs + 8.3 name + handle + cookies
    entry[0] = searchAttrs & SEARCH_ATTR_MASK;
    pad83(SHARE_NAME).copy(entry, 1);
    entry[12] = 0; // search handle
    entry.writeUInt32LE(0, 13); // server cookie
    entry.writeUInt32LE(0, 17); // client cookie
    // File info (22 bytes at offset 21)
    entry[21] = ATTR_VOLUME;
    var now = new Date();
    entry.writeUInt16LE(dosTime(now), 22);
    entry.writeUInt16LE(dosDate(now), 24);
    entry.writeUInt32LE(0, 26); // size
    // Filename (13 bytes, null-terminated, at offset 30)
    var volBuf = Buffer.alloc(SEARCH_FILENAME_SIZE, 0);
    Buffer.from(SHARE_NAME, 'ascii').copy(volBuf, 0);
    volBuf.copy(entry, 30);

    var rParams = Buffer.alloc(2);
    rParams.writeUInt16LE(1, 0); // count = 1

    // Data: BufferFormat(0x05) + DataLength(2) + entries
    var rData = Buffer.alloc(3 + SEARCH_ENTRY_SIZE);
    rData[0] = BUF_FMT_VARIABLE;
    rData.writeUInt16LE(SEARCH_ENTRY_SIZE, 1);
    entry.copy(rData, 3);

    return buildResponse(encodeHeader(CMD_SEARCH, STATUS_SUCCESS, msg.hdr), rParams, rData);
  }

  // Directory listing
  var entries = [];
  try {
    // If the pattern points to a specific directory (no wildcards), check if it exists
    // and return it as an entry — WFW does this to verify paths before listing contents
    var hasWildcard = mask.indexOf('*') >= 0 || mask.indexOf('?') >= 0;
    if (!hasWildcard) {
      // Resolve short name → real name via short name map
      var specificPath = null;
      var resolvedShortName = mask.toUpperCase();
      try {
        // First try direct stat (works for exact matches and case-insensitive filesystems)
        var directPath = path.join(localDir, mask);
        fs.statSync(directPath);
        specificPath = directPath;
      } catch (e) {
        // Not found directly — look up in short name map
        try {
          var dirFiles = fs.readdirSync(localDir).filter(function (f) {
            return !f.startsWith('.');
          });
          var shortMap = generateShortNames(dirFiles);
          for (var si = 0; si < dirFiles.length; si++) {
            if (shortMap[dirFiles[si]] === resolvedShortName) {
              specificPath = path.join(localDir, dirFiles[si]);
              break;
            }
          }
        } catch (e2) {}
      }

      if (specificPath) {
        try {
          var specStat = fs.statSync(specificPath);
          var isDir = specStat.isDirectory();
          // Return directory entries only if ATTR_DIRECTORY is in search attrs
          if (isDir && !(searchAttrs & ATTR_DIRECTORY)) {
            /* skip */
          } else {
            var specEntry = Buffer.alloc(SEARCH_ENTRY_SIZE);
            // Resume key (21 bytes)
            specEntry[0] = searchAttrs & SEARCH_ATTR_MASK;
            pad83(resolvedShortName).copy(specEntry, 1);
            specEntry[12] = 1; // search handle
            specEntry.writeUInt32LE(0, 13); // server cookie
            specEntry.writeUInt32LE(0, 17); // client cookie
            // File info (22 bytes at offset 21)
            specEntry[21] = getFileAttr(specStat);
            specEntry.writeUInt16LE(dosTime(specStat.mtime), 22);
            specEntry.writeUInt16LE(dosDate(specStat.mtime), 24);
            specEntry.writeUInt32LE(isDir ? 0 : capSize(specStat.size), 26);
            // Filename (13 bytes at offset 30)
            var specNameBuf = Buffer.alloc(SEARCH_FILENAME_SIZE, 0);
            Buffer.from(resolvedShortName.substring(0, 12), 'ascii').copy(specNameBuf, 0);
            specNameBuf.copy(specEntry, 30);
            entries.push(specEntry);
          }
        } catch (e) {}
      }
    }

    if (hasWildcard) {
      var files = fs.readdirSync(localDir).filter(function (f) {
        return !f.startsWith('.');
      });

      // Generate 8.3 short names with collision handling
      var shortNames = generateShortNames(files);

      var entryIndex = 0;

      for (var i = 0; i < files.length && entries.length < maxCount; i++) {
        var fname = files[i];
        var shortName = shortNames[fname];

        // Match against the short name (what DOS sees)
        if (!matchWildcard(mask, shortName)) continue;

        var fullPath = path.join(localDir, fname);
        var stat;
        try {
          stat = fs.statSync(fullPath);
        } catch (e) {
          continue;
        }

        // Skip directories unless ATTR_DIRECTORY is in search attrs
        if (stat.isDirectory() && !(searchAttrs & ATTR_DIRECTORY)) continue;

        if (entryIndex < startIndex) {
          entryIndex++;
          continue;
        }

        // Build 43-byte SEARCH directory entry
        entry = Buffer.alloc(SEARCH_ENTRY_SIZE);
        // Resume key (21 bytes)
        entry[0] = searchAttrs & SEARCH_ATTR_MASK;
        pad83(mask).copy(entry, 1);
        entry[12] = 1; // search handle
        entry.writeUInt32LE(entryIndex, 13); // server cookie
        entry.writeUInt32LE(0, 17); // client cookie
        // File info (22 bytes at offset 21)
        entry[21] = getFileAttr(stat);
        entry.writeUInt16LE(dosTime(stat.mtime), 22);
        entry.writeUInt16LE(dosDate(stat.mtime), 24);
        entry.writeUInt32LE(capSize(stat.size), 26);
        // Filename (13 bytes at offset 30, 8.3 null-terminated)
        var nameBuf = Buffer.alloc(SEARCH_FILENAME_SIZE, 0);
        Buffer.from(shortName.substring(0, 12), 'ascii').copy(nameBuf, 0);
        nameBuf.copy(entry, 30);

        entries.push(entry);
        entryIndex++;
      }
    } // end if (hasWildcard)
  } catch (e) {
    log('smb', 'SEARCH: readdir error: %s', e.message);
  }

  log('smb', 'SEARCH: returning %d entries (hasWildcard=%s)', entries.length, hasWildcard);

  if (entries.length === 0) {
    // No files found — return ERR_NO_FILES
    // Per Samba: only return error for non-wildcard searches
    return buildErrorResponse(CMD_SEARCH, ERR_NO_FILES, msg.hdr);
  }

  rParams = Buffer.alloc(2);
  rParams.writeUInt16LE(entries.length, 0); // Count

  // Data: BufferFormat(0x05) + DataLength(2) + entries
  var entryData = Buffer.concat(entries);
  rData = Buffer.alloc(3 + entryData.length);
  rData[0] = BUF_FMT_VARIABLE;
  rData.writeUInt16LE(entryData.length, 1);
  entryData.copy(rData, 3);

  return buildResponse(encodeHeader(CMD_SEARCH, STATUS_SUCCESS, msg.hdr), rParams, rData);
}

function handleQueryInfo(msg, conn) {
  var data = msg.commands[0].data;

  // Data: BufferFormat(0x04) + FileName\0
  var r = readAsciiZ(data, 1); // skip BUF_FMT_ASCII_PATH
  var fileName = stripSharePrefix(r.str);

  log('smb', 'QUERY_INFO: %s', fileName);

  // Virtual file handling
  var vtype = getVirtualType(fileName);
  if (vtype) {
    var vSize = vtype !== 'log' ? Buffer.byteLength(magicRead(vtype), 'ascii') : 0;
    // Response: WordCount=10, params=20 bytes
    // Attrs(2) + LastWriteTime(4) + FileSize(4) + Reserved(10)
    var params = Buffer.alloc(20);
    params.writeUInt16LE(ATTR_ARCHIVE, 0);
    params.writeUInt32LE(Math.floor(Date.now() / 1000), 2);
    params.writeUInt32LE(vSize, 6);
    return buildResponse(encodeHeader(CMD_QUERY_INFO, STATUS_SUCCESS, msg.hdr), params, Buffer.alloc(0));
  }

  var localPath = resolvePathOrRoot(conn, fileName);
  if (!localPath) return buildErrorResponse(CMD_QUERY_INFO, ERR_BAD_FILE, msg.hdr);

  var stat;
  try {
    stat = fs.statSync(localPath);
  } catch (e) {
    return buildErrorResponse(CMD_QUERY_INFO, ERR_BAD_FILE, msg.hdr);
  }

  // Response: WordCount=10, params=20 bytes
  // Attrs(2) + LastWriteTime(4) + FileSize(4) + Reserved(10)
  params = Buffer.alloc(20);
  params.writeUInt16LE(getFileAttr(stat), 0);
  params.writeUInt32LE(Math.floor(stat.mtime.getTime() / 1000), 2);
  params.writeUInt32LE(capSize(stat.size), 6);

  return buildResponse(encodeHeader(CMD_QUERY_INFO, STATUS_SUCCESS, msg.hdr), params, Buffer.alloc(0));
}

function handleCheckDir(msg, conn) {
  var data = msg.commands[0].data;
  var r = readAsciiZ(data, 1); // skip BUF_FMT_ASCII_PATH
  var dirName = stripSharePrefix(r.str);

  log('smb', 'CHECK_DIR: %s', dirName);

  var localPath = resolvePathOrRoot(conn, dirName);
  if (!localPath) return buildErrorResponse(CMD_CHECK_DIR, ERR_BAD_PATH, msg.hdr);

  try {
    var stat = fs.statSync(localPath);
    if (!stat.isDirectory()) {
      return buildErrorResponse(CMD_CHECK_DIR, ERR_BAD_PATH, msg.hdr);
    }
  } catch (e) {
    return buildErrorResponse(CMD_CHECK_DIR, ERR_BAD_PATH, msg.hdr);
  }

  return buildResponse(encodeHeader(CMD_CHECK_DIR, STATUS_SUCCESS, msg.hdr), Buffer.alloc(0), Buffer.alloc(0));
}

// ─── SMB_COM_DELETE (0x06) ─────────────────────────────────────────
function handleDelete(msg, conn) {
  var params = msg.commands[0].params;
  var data = msg.commands[0].data;

  var searchAttrs = params.readUInt16LE(0);

  var r = readAsciiZ(data, 1); // skip BUF_FMT_ASCII_PATH
  var fileName = stripSharePrefix(r.str);

  log('smb', 'DELETE: %s attrs=0x%s', fileName, searchAttrs.toString(16));

  var localPath = resolveShortPath(conn.sharePath, fileName);
  if (!localPath) return buildErrorResponse(CMD_DELETE, ERR_BAD_FILE, msg.hdr);

  try {
    var stat = fs.statSync(localPath);
    if (stat.isDirectory()) {
      return buildErrorResponse(CMD_DELETE, ERR_NO_ACCESS, msg.hdr);
    }
    fs.unlinkSync(localPath);
  } catch (e) {
    return buildErrorResponse(CMD_DELETE, ERR_BAD_FILE, msg.hdr);
  }

  return buildResponse(encodeHeader(CMD_DELETE, STATUS_SUCCESS, msg.hdr), Buffer.alloc(0), Buffer.alloc(0));
}

// ─── SMB_COM_RENAME (0x07) ────────────────────────────────────────
function handleRename(msg, conn) {
  var params = msg.commands[0].params;
  var data = msg.commands[0].data;

  var _searchAttrs = params.readUInt16LE(0); // eslint-disable-line no-unused-vars -- parsed SMB field

  var r1 = readAsciiZ(data, 1); // skip BUF_FMT_ASCII_PATH
  var oldName = stripSharePrefix(r1.str);
  var r2 = readAsciiZ(data, r1.next + 1); // skip second BUF_FMT_ASCII_PATH
  var newName = stripSharePrefix(r2.str);

  log('smb', 'RENAME: %s → %s', oldName, newName);

  var oldPath = resolveShortPath(conn.sharePath, oldName);
  if (!oldPath) return buildErrorResponse(CMD_RENAME, ERR_BAD_FILE, msg.hdr);

  var newPath = resolveNewFilePath(conn, newName);
  if (!newPath) return buildErrorResponse(CMD_RENAME, ERR_BAD_PATH, msg.hdr);

  try {
    fs.renameSync(oldPath, newPath);
  } catch (e) {
    return buildErrorResponse(CMD_RENAME, ERR_NO_ACCESS, msg.hdr);
  }

  return buildResponse(encodeHeader(CMD_RENAME, STATUS_SUCCESS, msg.hdr), Buffer.alloc(0), Buffer.alloc(0));
}

// ─── SMB_COM_CREATE_DIRECTORY (0x00) ──────────────────────────────
function handleCreateDir(msg, conn) {
  var data = msg.commands[0].data;
  var r = readAsciiZ(data, 1); // skip BUF_FMT_ASCII_PATH
  var dirName = stripSharePrefix(r.str);

  log('smb', 'CREATE_DIR: %s', dirName);

  var localPath = resolveNewFilePath(conn, dirName);

  try {
    fs.mkdirSync(localPath);
  } catch (e) {
    if (e.code === 'EEXIST') {
      return buildErrorResponse(CMD_CREATE_DIR, ERR_ALREADY_EXISTS, msg.hdr);
    }
    return buildErrorResponse(CMD_CREATE_DIR, ERR_NO_ACCESS, msg.hdr);
  }

  return buildResponse(encodeHeader(CMD_CREATE_DIR, STATUS_SUCCESS, msg.hdr), Buffer.alloc(0), Buffer.alloc(0));
}

// ─── SMB_COM_DELETE_DIRECTORY (0x01) ──────────────────────────────
function handleDeleteDir(msg, conn) {
  var data = msg.commands[0].data;
  var r = readAsciiZ(data, 1); // skip BUF_FMT_ASCII_PATH
  var dirName = stripSharePrefix(r.str);

  log('smb', 'DELETE_DIR: %s', dirName);

  var localPath = resolveShortPath(conn.sharePath, dirName);
  if (!localPath) return buildErrorResponse(CMD_DELETE_DIR, ERR_BAD_PATH, msg.hdr);

  try {
    var stat = fs.statSync(localPath);
    if (!stat.isDirectory()) {
      return buildErrorResponse(CMD_DELETE_DIR, ERR_BAD_PATH, msg.hdr);
    }
    fs.rmdirSync(localPath);
  } catch (e) {
    if (e.code === 'ENOTEMPTY') {
      return buildErrorResponse(CMD_DELETE_DIR, ERR_DIR_NOT_EMPTY, msg.hdr);
    }
    return buildErrorResponse(CMD_DELETE_DIR, ERR_BAD_PATH, msg.hdr);
  }

  return buildResponse(encodeHeader(CMD_DELETE_DIR, STATUS_SUCCESS, msg.hdr), Buffer.alloc(0), Buffer.alloc(0));
}

// ─── SMB_COM_CREATE (0x03) ────────────────────────────────────────
function handleCreate(msg, conn) {
  var params = msg.commands[0].params;
  var data = msg.commands[0].data;

  var fileAttrs = params.readUInt16LE(0);
  var _creationTime = params.readUInt32LE(2); // eslint-disable-line no-unused-vars -- parsed SMB field

  var r = readAsciiZ(data, 1); // skip BUF_FMT_ASCII_PATH
  var fileName = stripSharePrefix(r.str);

  log('smb', 'CREATE: %s attrs=0x%s', fileName, fileAttrs.toString(16));

  // Virtual file handling
  var vtype = getVirtualType(fileName);
  if (vtype) {
    var fid = openVirtualFile(conn, vtype, fileName);
    var rParams = Buffer.alloc(2);
    rParams.writeUInt16LE(fid, 0);
    return buildResponse(encodeHeader(CMD_CREATE, STATUS_SUCCESS, msg.hdr), rParams, Buffer.alloc(0));
  }

  var localPath = resolveNewFilePath(conn, fileName);

  // CREATE always creates or truncates
  var fd;
  try {
    fd = fs.openSync(localPath, 'w+');
  } catch (e) {
    return buildErrorResponse(CMD_CREATE, ERR_NO_ACCESS, msg.hdr);
  }

  fid = nextFid++;
  conn.openFiles[fid] = { path: localPath, fd: fd, name: fileName };

  rParams = Buffer.alloc(2);
  rParams.writeUInt16LE(fid, 0);
  return buildResponse(encodeHeader(CMD_CREATE, STATUS_SUCCESS, msg.hdr), rParams, Buffer.alloc(0));
}

// ─── SMB_COM_FLUSH (0x05) ─────────────────────────────────────────
function handleFlush(msg, conn) {
  var params = msg.commands[0].params;
  var fid = params.readUInt16LE(0);

  log('smb', 'FLUSH: fid=%d', fid);

  if (fid === FID_FLUSH_ALL) {
    // Flush all files for this connection
    var fids = Object.keys(conn.openFiles);
    for (var i = 0; i < fids.length; i++) {
      var file = conn.openFiles[fids[i]];
      if (file && file.fd && !file.virtual) {
        try {
          fs.fsyncSync(file.fd);
        } catch (e) {}
      }
    }
  } else {
    file = conn.openFiles[fid];
    if (!file) return buildErrorResponse(CMD_FLUSH, ERR_BAD_FID, msg.hdr);
    if (file.fd && !file.virtual) {
      try {
        fs.fsyncSync(file.fd);
      } catch (e) {}
    }
  }

  return buildResponse(encodeHeader(CMD_FLUSH, STATUS_SUCCESS, msg.hdr), Buffer.alloc(0), Buffer.alloc(0));
}

// ─── SMB_COM_SET_INFORMATION (0x09) ───────────────────────────────
function handleSetInfo(msg, conn) {
  var params = msg.commands[0].params;
  var data = msg.commands[0].data;

  var fileAttrs = params.readUInt16LE(0);
  var lastWriteTime = params.readUInt32LE(2); // Unix timestamp (seconds)

  var r = readAsciiZ(data, 1); // skip BUF_FMT_ASCII_PATH
  var fileName = stripSharePrefix(r.str);

  log('smb', 'SET_INFO: %s attrs=0x%s mtime=%d', fileName, fileAttrs.toString(16), lastWriteTime);

  var localPath = resolvePathOrRoot(conn, fileName);
  if (!localPath) return buildErrorResponse(CMD_SET_INFO, ERR_BAD_FILE, msg.hdr);

  try {
    // Set last write time if non-zero
    if (lastWriteTime !== 0) {
      var mtime = new Date(lastWriteTime * 1000);
      fs.utimesSync(localPath, mtime, mtime);
    }
    // We don't enforce read-only/hidden/system on the host filesystem,
    // but we accept the command silently for compatibility.
  } catch (e) {
    return buildErrorResponse(CMD_SET_INFO, ERR_NO_ACCESS, msg.hdr);
  }

  return buildResponse(encodeHeader(CMD_SET_INFO, STATUS_SUCCESS, msg.hdr), Buffer.alloc(0), Buffer.alloc(0));
}

// ─── SMB_COM_LOCKING_ANDX (0x24) ──────────────────────────────────
function handleLocking(msg, cmdIdx, conn) {
  var params = msg.commands[cmdIdx].params;

  // Skip AndX header (4 bytes)
  var fid = params.readUInt16LE(4);
  var typeOfLock = params[6];
  var _timeout = params.readUInt32LE(8); // eslint-disable-line no-unused-vars -- parsed SMB field
  var numUnlocks = params.readUInt16LE(12);
  var numLocks = params.readUInt16LE(14);

  log('smb', 'LOCKING: fid=%d type=0x%s locks=%d unlocks=%d', fid, typeOfLock.toString(16), numLocks, numUnlocks);

  var file = conn.openFiles[fid];
  if (!file) return andxError(CMD_LOCKING, ERR_BAD_FID);

  // We don't enforce byte-range locks — just acknowledge the request.
  // WFW 3.11 sends these for file sharing; silently succeeding is fine.
  var rParams = Buffer.alloc(4);
  rParams[0] = ANDX_NONE; // AndXCommand: no further commands
  rParams[1] = 0x00; // AndXReserved
  rParams.writeUInt16LE(0, 2); // AndXOffset
  return andxResult(CMD_LOCKING, STATUS_SUCCESS, rParams, Buffer.alloc(0));
}

// ─── SMB_COM_TRANSACTION (0x25) ───────────────────────────────────
function handleTransaction(msg, conn) {
  var params = msg.commands[0].params;
  var data = msg.commands[0].data;

  var _totalParamCount = params.readUInt16LE(0); // eslint-disable-line no-unused-vars -- parsed SMB field
  var _totalDataCount = params.readUInt16LE(2); // eslint-disable-line no-unused-vars -- parsed SMB field
  var _maxParamCount = params.readUInt16LE(4); // eslint-disable-line no-unused-vars -- parsed SMB field
  var maxDataCount = params.readUInt16LE(6);
  var paramCount = params.readUInt16LE(18);
  var paramOffset = params.readUInt16LE(20);
  var dataCount = params.readUInt16LE(22);
  var dataOffset = params.readUInt16LE(24);
  var setupCount = params[26];

  // Read the transaction name from data (null-terminated string)
  var r = readAsciiZ(data, 0);
  var transName = r.str;

  log(
    'smb',
    'TRANSACTION: name=%s setupCount=%d paramCount=%d dataCount=%d',
    transName,
    setupCount,
    paramCount,
    dataCount,
  );

  // Calculate where Trans_Parameters and Trans_Data are in the raw message
  // paramOffset and dataOffset are relative to the SMB header start
  var rawBuf = msg.raw;
  var transParams = Buffer.alloc(0);
  var transData = Buffer.alloc(0);
  if (paramCount > 0 && paramOffset > 0) {
    transParams = rawBuf.slice(paramOffset, paramOffset + paramCount);
  }
  if (dataCount > 0 && dataOffset > 0) {
    transData = rawBuf.slice(dataOffset, dataOffset + dataCount);
  }

  // Handle RAP (Remote Administration Protocol) on \PIPE\LANMAN
  if (transName === '\\PIPE\\LANMAN') {
    return handleRAP(transParams, transData, maxDataCount, msg, conn);
  }

  // Unknown transaction — return not supported
  log('smb', 'TRANSACTION: unsupported transaction name: %s', transName);
  return buildErrorResponse(CMD_TRANSACTION, ERR_BAD_FUNC, msg.hdr);
}

function handleRAP(rapParams, rapData, maxDataCount, msg, conn) {
  // RAP request: WinAPICode(2) + ParamDesc(asciiZ) + DataDesc(asciiZ) + params...
  if (rapParams.length < 2) {
    return buildErrorResponse(CMD_TRANSACTION, ERR_BAD_FORMAT, msg.hdr);
  }

  var apiCode = rapParams.readUInt16LE(0);
  var r1 = readAsciiZ(rapParams, 2);
  var paramDesc = r1.str;
  var r2 = readAsciiZ(rapParams, r1.next);
  var dataDesc = r2.str;
  var apiParams = rapParams.slice(r2.next);

  log('smb', 'RAP: apiCode=%d paramDesc=%s dataDesc=%s', apiCode, paramDesc, dataDesc);

  if (apiCode === RAP_NET_SERVER_GET_INFO) {
    return handleNetServerGetInfo(apiParams, dataDesc, maxDataCount, msg, conn);
  }

  if (apiCode === RAP_NET_SHARE_ENUM) {
    return handleNetShareEnum(apiParams, dataDesc, maxDataCount, msg, conn);
  }

  // Unknown API — return error in RAP format
  log('smb', 'RAP: unsupported API code %d', apiCode);
  var respParams = Buffer.alloc(6);
  respParams.writeUInt16LE(5, 0); // status: ERROR_ACCESS_DENIED
  respParams.writeUInt16LE(0, 2); // converter
  respParams.writeUInt16LE(0, 4); // entry count
  return buildTransResponse(CMD_TRANSACTION, respParams, Buffer.alloc(0), msg);
}

function handleNetServerGetInfo(apiParams, dataDesc, maxDataCount, msg, conn) {
  // apiParams: InfoLevel(2)  + ReceiveBufferSize(2)
  var infoLevel = apiParams.readUInt16LE(0);

  log('smb', 'NetServerGetInfo: level=%d', infoLevel);

  if (infoLevel === 1) {
    // SERVER_INFO_1 structure: 26 bytes
    // Name (16 bytes, padded) + VersionMajor(1) + VersionMinor(1) +
    // Type(4) + Comment pointer (4)
    var serverInfo = Buffer.alloc(26);
    var nameBytes = Buffer.from(SERVER_NAME, 'ascii');
    nameBytes.copy(serverInfo, 0, 0, Math.min(nameBytes.length, 16));
    serverInfo[16] = 3; // major version
    serverInfo[17] = 51; // minor version (3.51 = WFW era)
    // Server type: workstation(0x1) + server(0x2)
    serverInfo.writeUInt32LE(0x00000003, 18);
    // Comment offset — points past the fixed structure
    serverInfo.writeUInt32LE(26, 22);

    var comment = Buffer.from('LANMAN2.1 SMB Server\0', 'ascii');
    var respData = Buffer.concat([serverInfo, comment]);

    var respParams = Buffer.alloc(6);
    respParams.writeUInt16LE(0, 0); // status: NERR_Success
    respParams.writeUInt16LE(0, 2); // converter
    respParams.writeUInt16LE(0, 4); // available bytes (unused for GetInfo)

    return buildTransResponse(CMD_TRANSACTION, respParams, respData, msg);
  }

  // Unsupported level
  respParams = Buffer.alloc(6);
  respParams.writeUInt16LE(124, 0); // ERROR_INVALID_LEVEL
  respParams.writeUInt16LE(0, 2);
  respParams.writeUInt16LE(0, 4);
  return buildTransResponse(CMD_TRANSACTION, respParams, Buffer.alloc(0), msg);
}

function handleNetShareEnum(apiParams, dataDesc, maxDataCount, msg, conn) {
  // apiParams: InfoLevel(2) + ReceiveBufferSize(2)
  var infoLevel = apiParams.readUInt16LE(0);

  log('smb', 'NetShareEnum: level=%d', infoLevel);

  if (infoLevel === 1) {
    // SHARE_INFO_1: ShareName(13) + Pad(1) + Type(2) + Comment ptr(4) = 20 bytes
    var shareInfo = Buffer.alloc(20);
    var nameBytes = Buffer.from(SHARE_NAME, 'ascii');
    nameBytes.copy(shareInfo, 0, 0, Math.min(nameBytes.length, 13));
    shareInfo[14] = 0x00; // Type: STYPE_DISKTREE (low byte)
    shareInfo[15] = 0x00; // Type: STYPE_DISKTREE (high byte)
    shareInfo.writeUInt32LE(20, 16); // comment offset

    var comment = Buffer.from('Shared files\0', 'ascii');
    var respData = Buffer.concat([shareInfo, comment]);

    var respParams = Buffer.alloc(8);
    respParams.writeUInt16LE(0, 0); // status: NERR_Success
    respParams.writeUInt16LE(0, 2); // converter
    respParams.writeUInt16LE(1, 4); // entries returned
    respParams.writeUInt16LE(1, 6); // entries available

    return buildTransResponse(CMD_TRANSACTION, respParams, respData, msg);
  }

  respParams = Buffer.alloc(8);
  respParams.writeUInt16LE(124, 0); // ERROR_INVALID_LEVEL
  respParams.writeUInt16LE(0, 2);
  respParams.writeUInt16LE(0, 4);
  respParams.writeUInt16LE(0, 6);
  return buildTransResponse(CMD_TRANSACTION, respParams, Buffer.alloc(0), msg);
}

// ─── SMB_COM_QUERY_INFORMATION2 (0x23) ───────────────────────────
// Query file info by FID — returns dates, size, attributes
function handleQueryInfo2(msg, conn) {
  var params = msg.commands[0].params;
  var fid = params.readUInt16LE(0);

  log('smb', 'QUERY_INFO2: fid=%d', fid);

  var file = conn.openFiles[fid];
  if (!file) return buildErrorResponse(CMD_QUERY_INFO2, ERR_BAD_FID, msg.hdr);

  var stat;
  if (file.virtual) {
    // Virtual files — return zero-size, current time
    stat = { size: 0, mtime: new Date(), atime: new Date(), birthtime: new Date() };
  } else {
    try {
      stat = fs.fstatSync(file.fd);
    } catch (e) {
      return buildErrorResponse(CMD_QUERY_INFO2, ERR_BAD_FID, msg.hdr);
    }
  }

  // Response: WordCount=11, params=22 bytes
  // Same layout as SMB_INFO_STANDARD: dates(12) + sizes(8) + attrs(2)
  var rParams = Buffer.alloc(22);
  writeInfoStandard(rParams, 0, stat);

  return buildResponse(encodeHeader(CMD_QUERY_INFO2, STATUS_SUCCESS, msg.hdr), rParams, Buffer.alloc(0));
}

// ─── SMB_COM_SET_INFORMATION2 (0x22) ────────────────────────────
// Set file info by FID — sets dates
function handleSetInfo2(msg, conn) {
  var params = msg.commands[0].params;
  var fid = params.readUInt16LE(0);

  log('smb', 'SET_INFO2: fid=%d', fid);

  var file = conn.openFiles[fid];
  if (!file) return buildErrorResponse(CMD_SET_INFO2, ERR_BAD_FID, msg.hdr);

  if (!file.virtual && file.path) {
    // Params layout: CreateDate(2)+CreateTime(2)+AccessDate(2)+AccessTime(2)
    //                +LastWriteDate(2)+LastWriteTime(2)
    var lastWriteDate = params.readUInt16LE(8);
    var lastWriteTime = params.readUInt16LE(10);
    if (lastWriteDate !== 0 || lastWriteTime !== 0) {
      try {
        var mtime = decodeDosDateTime(lastWriteDate, lastWriteTime);
        fs.utimesSync(file.path, mtime, mtime);
      } catch (e) {}
    }
  }

  return buildResponse(encodeHeader(CMD_SET_INFO2, STATUS_SUCCESS, msg.hdr), Buffer.alloc(0), Buffer.alloc(0));
}

// ─── SMB_COM_TRANSACTION2 (0x32) ────────────────────────────────

// Helper: build SMB_INFO_STANDARD entry for FIND_FIRST2/FIND_NEXT2
// Returns a 26-byte fixed struct + variable filename (no padding for LANMAN2.1)
function buildFindInfoStandard(shortName, stat) {
  var isDir = stat.isDirectory();
  var ctime = stat.birthtime || stat.mtime;
  var mtime = stat.mtime;
  var atime = stat.atime;

  // SMB_INFO_STANDARD: 23 fixed bytes + 1 byte filename length + filename + 1 null
  var nameBytes = Buffer.from(shortName, 'ascii');
  var entry = Buffer.alloc(23 + 1 + nameBytes.length + 1);
  var off = 0;

  // ResumeKey (4 bytes) — used by FIND_NEXT2
  entry.writeUInt32LE(0, off);
  off += 4; // filled in by caller
  // CreationDate(2) + CreationTime(2)
  entry.writeUInt16LE(dosDate(ctime), off);
  off += 2;
  entry.writeUInt16LE(dosTime(ctime), off);
  off += 2;
  // LastAccessDate(2) + LastAccessTime(2)
  entry.writeUInt16LE(dosDate(atime), off);
  off += 2;
  entry.writeUInt16LE(dosTime(atime), off);
  off += 2;
  // LastWriteDate(2) + LastWriteTime(2)
  entry.writeUInt16LE(dosDate(mtime), off);
  off += 2;
  entry.writeUInt16LE(dosTime(mtime), off);
  off += 2;
  // FileDataSize(4)
  entry.writeUInt32LE(isDir ? 0 : capSize(stat.size), off);
  off += 4;
  // FileAllocationSize(4)
  entry.writeUInt32LE(isDir ? 0 : capSize(stat.size), off);
  off += 4;
  // Attributes(2)
  entry.writeUInt16LE(isDir ? ATTR_DIRECTORY : ATTR_ARCHIVE, off);
  off += 2;
  // FileNameLength(1)
  entry[off++] = nameBytes.length;
  // FileName (variable, null-terminated)
  nameBytes.copy(entry, off);
  off += nameBytes.length;
  entry[off] = 0;

  return entry;
}

function handleTransaction2(msg, conn) {
  var params = msg.commands[0].params;

  var _totalParamCount = params.readUInt16LE(0); // eslint-disable-line no-unused-vars -- parsed SMB field
  var _totalDataCount = params.readUInt16LE(2); // eslint-disable-line no-unused-vars -- parsed SMB field
  var _maxParamCount = params.readUInt16LE(4); // eslint-disable-line no-unused-vars -- parsed SMB field
  var maxDataCount = params.readUInt16LE(6);
  var paramCount = params.readUInt16LE(18);
  var paramOffset = params.readUInt16LE(20);
  var dataCount = params.readUInt16LE(22);
  var dataOffset = params.readUInt16LE(24);
  var setupCount = params[26];
  var subCommand = params.readUInt16LE(28); // Setup[0] = subcommand

  log(
    'smb',
    'TRANSACTION2: sub=0x%s setupCount=%d paramCount=%d dataCount=%d',
    subCommand.toString(16),
    setupCount,
    paramCount,
    dataCount,
  );

  // Extract Trans2_Parameters and Trans2_Data from raw message
  var rawBuf = msg.raw;
  var trans2Params = Buffer.alloc(0);
  var trans2Data = Buffer.alloc(0);
  if (paramCount > 0 && paramOffset > 0) {
    trans2Params = rawBuf.slice(paramOffset, paramOffset + paramCount);
  }
  if (dataCount > 0 && dataOffset > 0) {
    trans2Data = rawBuf.slice(dataOffset, dataOffset + dataCount);
  }

  switch (subCommand) {
    case TRANS2_FIND_FIRST2:
      return handleFindFirst2(trans2Params, trans2Data, maxDataCount, msg, conn);
    case TRANS2_FIND_NEXT2:
      return handleFindNext2(trans2Params, trans2Data, maxDataCount, msg, conn);
    case TRANS2_QUERY_PATH_INFO:
      return handleQueryPathInfo(trans2Params, trans2Data, msg, conn);
    case TRANS2_QUERY_FILE_INFO:
      return handleQueryFileInfo(trans2Params, trans2Data, msg, conn);
    case TRANS2_SET_FILE_INFO:
      return handleSetFileInfo(trans2Params, trans2Data, msg, conn);
    default:
      log('smb', 'TRANSACTION2: unsupported subcommand 0x%s', subCommand.toString(16));
      return buildErrorResponse(CMD_TRANSACTION2, ERR_BAD_FUNC, msg.hdr);
  }
}

// ─── TRANS2_FIND_FIRST2 (0x0001) ────────────────────────────────
function handleFindFirst2(trans2Params, trans2Data, maxDataCount, msg, conn) {
  // Trans2_Parameters:
  //   SearchAttributes(2) + SearchCount(2) + Flags(2) + InformationLevel(2)
  //   + SearchStorageType(4) + FileName (variable, null-terminated)
  var searchAttrs = trans2Params.readUInt16LE(0);
  var searchCount = trans2Params.readUInt16LE(2);
  var flags = trans2Params.readUInt16LE(4);
  var infoLevel = trans2Params.readUInt16LE(6);
  // Skip SearchStorageType (4 bytes)
  var r = readAsciiZ(trans2Params, 12);
  var pattern = stripSharePrefix(r.str);

  log(
    'smb',
    'FIND_FIRST2: pattern=%s count=%d flags=0x%s level=0x%s',
    pattern,
    searchCount,
    flags.toString(16),
    infoLevel.toString(16),
  );

  // Separate directory and mask
  var lastSlash = pattern.lastIndexOf('\\');
  var dir, mask;
  if (lastSlash >= 0) {
    dir = pattern.substring(0, lastSlash) || '\\';
    mask = pattern.substring(lastSlash + 1);
  } else {
    dir = '\\';
    mask = pattern;
  }
  if (mask === '') mask = '*.*';

  var localDir;
  if (dir === '\\') {
    localDir = conn.sharePath;
  } else {
    localDir = resolveShortPath(conn.sharePath, dir);
    if (!localDir) {
      return buildErrorResponse(CMD_TRANSACTION2, ERR_BAD_PATH, msg.hdr);
    }
  }

  // Build entries
  var entries = [];
  try {
    var files = fs.readdirSync(localDir).filter(function (f) {
      return !f.startsWith('.');
    });
    var shortNames = generateShortNames(files);
    var hasWildcard = mask.indexOf('*') >= 0 || mask.indexOf('?') >= 0;

    for (var i = 0; i < files.length && entries.length < searchCount; i++) {
      var fname = files[i];
      var shortName = shortNames[fname];

      if (hasWildcard) {
        if (!matchWildcard(mask, shortName)) continue;
      } else {
        if (shortName.toUpperCase() !== mask.toUpperCase()) continue;
      }

      var fullPath = path.join(localDir, fname);
      var stat;
      try {
        stat = fs.statSync(fullPath);
      } catch (e) {
        continue;
      }

      if (stat.isDirectory() && !(searchAttrs & ATTR_DIRECTORY)) continue;

      var entry = buildFindInfoStandard(shortName, stat);
      // Set ResumeKey to the entry index
      entry.writeUInt32LE(entries.length, 0);
      entries.push(entry);
    }
  } catch (e) {
    log('smb', 'FIND_FIRST2: readdir error: %s', e.message);
  }

  if (entries.length === 0) {
    return buildErrorResponse(CMD_TRANSACTION2, ERR_NO_FILES, msg.hdr);
  }

  // Store search state for FIND_NEXT2
  var sid = conn.nextSearchId++;
  var endOfSearch = 1; // assume all fit
  conn.searches[sid] = { dir: localDir, mask: mask, searchAttrs: searchAttrs, position: entries.length };

  // FIND_FIRST2 flags (MS-CIFS 2.2.6.2.1)
  var FIND_FLAG_CLOSE_AFTER_FIRST = 0x01;
  var FIND_FLAG_CLOSE_AT_END = 0x02;
  if (flags & FIND_FLAG_CLOSE_AFTER_FIRST) {
    delete conn.searches[sid];
  } else if (flags & FIND_FLAG_CLOSE_AT_END && endOfSearch) {
    delete conn.searches[sid];
  }

  // Response Trans2_Parameters: SID(2) + SearchCount(2) + EndOfSearch(2) + EaErrorOffset(2) + LastNameOffset(2)
  var respParams = Buffer.alloc(10);
  respParams.writeUInt16LE(sid, 0);
  respParams.writeUInt16LE(entries.length, 2);
  respParams.writeUInt16LE(endOfSearch, 4);
  respParams.writeUInt16LE(0, 6); // EaErrorOffset
  respParams.writeUInt16LE(0, 8); // LastNameOffset

  var respData = Buffer.concat(entries);

  return buildTransResponse(CMD_TRANSACTION2, respParams, respData, msg);
}

// ─── TRANS2_FIND_NEXT2 (0x0002) ─────────────────────────────────
function handleFindNext2(trans2Params, trans2Data, maxDataCount, msg, conn) {
  // Trans2_Parameters:
  //   SID(2) + SearchCount(2) + InformationLevel(2) + ResumeKey(4) + Flags(2) + FileName
  var sid = trans2Params.readUInt16LE(0);
  var searchCount = trans2Params.readUInt16LE(2);
  var _infoLevel = trans2Params.readUInt16LE(4); // eslint-disable-line no-unused-vars -- parsed SMB field
  var resumeKey = trans2Params.readUInt32LE(6);
  var flags = trans2Params.readUInt16LE(10);
  var r = readAsciiZ(trans2Params, 12);
  var resumeName = r.str;

  log(
    'smb',
    'FIND_NEXT2: sid=%d count=%d resumeKey=%d flags=0x%s name=%s',
    sid,
    searchCount,
    resumeKey,
    flags.toString(16),
    resumeName,
  );

  var search = conn.searches[sid];
  if (!search) {
    return buildErrorResponse(CMD_TRANSACTION2, ERR_NO_FILES, msg.hdr);
  }

  // Re-enumerate the directory from the resume position
  var entries = [];
  try {
    var files = fs.readdirSync(search.dir).filter(function (f) {
      return !f.startsWith('.');
    });
    var shortNames = generateShortNames(files);
    var hasWildcard = search.mask.indexOf('*') >= 0 || search.mask.indexOf('?') >= 0;
    var startIndex = search.position;

    var entryIndex = 0;
    for (var i = 0; i < files.length && entries.length < searchCount; i++) {
      var fname = files[i];
      var shortName = shortNames[fname];

      if (hasWildcard) {
        if (!matchWildcard(search.mask, shortName)) continue;
      } else {
        if (shortName.toUpperCase() !== search.mask.toUpperCase()) continue;
      }

      if (entryIndex < startIndex) {
        entryIndex++;
        continue;
      }

      var stat;
      try {
        stat = fs.statSync(path.join(search.dir, fname));
      } catch (e) {
        continue;
      }
      if (stat.isDirectory() && !(search.searchAttrs & ATTR_DIRECTORY)) continue;

      var entry = buildFindInfoStandard(shortName, stat);
      entry.writeUInt32LE(entryIndex, 0);
      entries.push(entry);
      entryIndex++;
    }
    search.position = entryIndex;
  } catch (e) {
    log('smb', 'FIND_NEXT2: readdir error: %s', e.message);
  }

  var endOfSearch = entries.length === 0 || entries.length < searchCount ? 1 : 0;

  var FIND_FLAG_CLOSE_AFTER_FIRST = 0x01;
  var FIND_FLAG_CLOSE_AT_END = 0x02;
  if (flags & FIND_FLAG_CLOSE_AFTER_FIRST) {
    delete conn.searches[sid];
  } else if (flags & FIND_FLAG_CLOSE_AT_END && endOfSearch) {
    delete conn.searches[sid];
  }

  if (entries.length === 0) {
    // Return success with 0 entries and endOfSearch=1
    var respParams = Buffer.alloc(8);
    respParams.writeUInt16LE(0, 0); // SearchCount
    respParams.writeUInt16LE(1, 2); // EndOfSearch
    respParams.writeUInt16LE(0, 4); // EaErrorOffset
    respParams.writeUInt16LE(0, 6); // LastNameOffset
    return buildTransResponse(CMD_TRANSACTION2, respParams, Buffer.alloc(0), msg);
  }

  respParams = Buffer.alloc(8);
  respParams.writeUInt16LE(entries.length, 0);
  respParams.writeUInt16LE(endOfSearch, 2);
  respParams.writeUInt16LE(0, 4);
  respParams.writeUInt16LE(0, 6);

  return buildTransResponse(CMD_TRANSACTION2, respParams, Buffer.concat(entries), msg);
}

// ─── TRANS2_QUERY_PATH_INFO (0x0005) ────────────────────────────
function handleQueryPathInfo(trans2Params, trans2Data, msg, conn) {
  var infoLevel = trans2Params.readUInt16LE(0);
  // Skip reserved (4 bytes)
  var r = readAsciiZ(trans2Params, 6);
  var fileName = stripSharePrefix(r.str);

  log('smb', 'QUERY_PATH_INFO: level=0x%s file=%s', infoLevel.toString(16), fileName);

  var localPath = resolvePathOrRoot(conn, fileName);
  if (!localPath) return buildErrorResponse(CMD_TRANSACTION2, ERR_BAD_FILE, msg.hdr);

  var stat;
  try {
    stat = fs.statSync(localPath);
  } catch (e) {
    return buildErrorResponse(CMD_TRANSACTION2, ERR_BAD_FILE, msg.hdr);
  }

  if (infoLevel === SMB_INFO_STANDARD) {
    // SMB_INFO_STANDARD: 22 bytes (dates + sizes + attrs)
    var respData = Buffer.alloc(22);
    writeInfoStandard(respData, 0, stat);

    var respParams = Buffer.alloc(2);
    respParams.writeUInt16LE(0, 0); // EaErrorOffset

    return buildTransResponse(CMD_TRANSACTION2, respParams, respData, msg);
  }

  // Unsupported info level
  log('smb', 'QUERY_PATH_INFO: unsupported level 0x%s', infoLevel.toString(16));
  return buildErrorResponse(CMD_TRANSACTION2, ERR_BAD_FUNC, msg.hdr);
}

// ─── TRANS2_QUERY_FILE_INFO (0x0007) ────────────────────────────
function handleQueryFileInfo(trans2Params, trans2Data, msg, conn) {
  var fid = trans2Params.readUInt16LE(0);
  var infoLevel = trans2Params.readUInt16LE(2);

  log('smb', 'QUERY_FILE_INFO: fid=%d level=0x%s', fid, infoLevel.toString(16));

  var file = conn.openFiles[fid];
  if (!file) return buildErrorResponse(CMD_TRANSACTION2, ERR_BAD_FID, msg.hdr);

  var stat;
  if (file.virtual) {
    stat = {
      size: 0,
      mtime: new Date(),
      atime: new Date(),
      birthtime: new Date(),
      isDirectory: function () {
        return false;
      },
    };
  } else {
    try {
      stat = fs.fstatSync(file.fd);
    } catch (e) {
      return buildErrorResponse(CMD_TRANSACTION2, ERR_BAD_FID, msg.hdr);
    }
  }

  if (infoLevel === SMB_INFO_STANDARD) {
    // SMB_INFO_STANDARD: 22 bytes (dates + sizes + attrs)
    var respData = Buffer.alloc(22);
    writeInfoStandard(respData, 0, stat);

    var respParams = Buffer.alloc(2);
    respParams.writeUInt16LE(0, 0); // EaErrorOffset
    return buildTransResponse(CMD_TRANSACTION2, respParams, respData, msg);
  }

  log('smb', 'QUERY_FILE_INFO: unsupported level 0x%s', infoLevel.toString(16));
  return buildErrorResponse(CMD_TRANSACTION2, ERR_BAD_FUNC, msg.hdr);
}

// ─── TRANS2_SET_FILE_INFO (0x0008) ──────────────────────────────
function handleSetFileInfo(trans2Params, trans2Data, msg, conn) {
  var fid = trans2Params.readUInt16LE(0);
  var infoLevel = trans2Params.readUInt16LE(2);

  log('smb', 'SET_FILE_INFO: fid=%d level=0x%s', fid, infoLevel.toString(16));

  var file = conn.openFiles[fid];
  if (!file) return buildErrorResponse(CMD_TRANSACTION2, ERR_BAD_FID, msg.hdr);

  if (infoLevel === SMB_INFO_STANDARD && trans2Data.length >= 12) {
    // Data layout: CreationDate(2)+CreationTime(2)+AccessDate(2)+AccessTime(2)
    //              +LastWriteDate(2)+LastWriteTime(2)
    var lastWriteDate = trans2Data.readUInt16LE(8);
    var lastWriteTime = trans2Data.readUInt16LE(10);
    if ((lastWriteDate !== 0 || lastWriteTime !== 0) && !file.virtual && file.path) {
      try {
        var mtime = decodeDosDateTime(lastWriteDate, lastWriteTime);
        fs.utimesSync(file.path, mtime, mtime);
      } catch (e) {}
    }
  }

  // Return success with empty params
  var respParams = Buffer.alloc(2);
  respParams.writeUInt16LE(0, 0);
  return buildTransResponse(CMD_TRANSACTION2, respParams, Buffer.alloc(0), msg);
}

// ─── SMB_COM_FIND_CLOSE2 (0x34) ────────────────────────────────
function handleFindClose2(msg, conn) {
  var params = msg.commands[0].params;
  var sid = params.readUInt16LE(0);

  log('smb', 'FIND_CLOSE2: sid=%d', sid);

  delete conn.searches[sid];

  return buildResponse(encodeHeader(CMD_FIND_CLOSE2, STATUS_SUCCESS, msg.hdr), Buffer.alloc(0), Buffer.alloc(0));
}

// ─── SMB_COM_LOGOFF_ANDX (0x74) ──────────────────────────────────
function handleLogoff(msg, cmdIdx, conn) {
  log('smb', 'LOGOFF: uid=%d', msg.hdr.uid);

  // Close all open files for this connection
  var fids = Object.keys(conn.openFiles);
  for (var i = 0; i < fids.length; i++) {
    var file = conn.openFiles[fids[i]];
    if (file && file.fd && !file.virtual) {
      try {
        fs.closeSync(file.fd);
      } catch (e) {}
    }
  }
  conn.openFiles = {};

  var rParams = Buffer.alloc(4);
  rParams[0] = ANDX_NONE; // AndXCommand: no further commands
  rParams[1] = 0x00; // AndXReserved
  rParams.writeUInt16LE(0, 2); // AndXOffset
  return andxResult(CMD_LOGOFF, STATUS_SUCCESS, rParams, Buffer.alloc(0));
}

function handleQueryInfoDisk(msg, conn) {
  // Get disk space for the share volume
  var stat;
  try {
    stat = fs.statfsSync(conn.sharePath);
  } catch (e) {
    // statfsSync requires Node 18.15+; fall back to fixed values
    log('smb', 'QUERY_INFO_DISK: statfsSync failed, using defaults');
    var params = Buffer.alloc(10);
    params.writeUInt16LE(MAX_UINT16, 0); // TotalUnits
    params.writeUInt16LE(4, 2); // BlocksPerUnit
    params.writeUInt16LE(512, 4); // BlockSize (bytes)
    params.writeUInt16LE(MAX_UINT16, 6); // FreeUnits
    params.writeUInt16LE(0, 8); // Reserved
    return buildResponse(encodeHeader(CMD_QUERY_INFO_DISK, STATUS_SUCCESS, msg.hdr), params, Buffer.alloc(0));
  }

  // Scale values to fit 16-bit fields.
  // Real total = bsize * blocks, free = bsize * bfree
  // We need: TotalUnits * BlocksPerUnit * BlockSize = total bytes
  var totalBytes = stat.bsize * stat.blocks;
  var freeBytes = stat.bsize * stat.bfree;
  var blockSize = 512;
  var blocksPerUnit = 64; // 32KB clusters
  var unitSize = blockSize * blocksPerUnit;
  var totalUnits = Math.min(Math.floor(totalBytes / unitSize), MAX_UINT16);
  var freeUnits = Math.min(Math.floor(freeBytes / unitSize), MAX_UINT16);

  log(
    'smb',
    'QUERY_INFO_DISK: total=%d free=%d (units=%d/%d blk=%d bs=%d)',
    totalBytes,
    freeBytes,
    totalUnits,
    freeUnits,
    blocksPerUnit,
    blockSize,
  );

  params = Buffer.alloc(10);
  params.writeUInt16LE(totalUnits, 0);
  params.writeUInt16LE(blocksPerUnit, 2);
  params.writeUInt16LE(blockSize, 4);
  params.writeUInt16LE(freeUnits, 6);
  params.writeUInt16LE(0, 8); // Reserved
  return buildResponse(encodeHeader(CMD_QUERY_INFO_DISK, STATUS_SUCCESS, msg.hdr), params, Buffer.alloc(0));
}

function handleOpen(msg, conn) {
  var params = msg.commands[0].params;
  var data = msg.commands[0].data;

  var desiredAccess = params.readUInt16LE(0);
  var _searchAttrs = params.readUInt16LE(2); // eslint-disable-line no-unused-vars -- parsed SMB field

  var r = readAsciiZ(data, 1); // skip BUF_FMT_ASCII_PATH
  var fileName = stripSharePrefix(r.str);

  log('smb', 'OPEN: %s access=0x%s', fileName, desiredAccess.toString(16));

  // Virtual file handling
  var vtype = getVirtualType(fileName);
  if (vtype) {
    var fid = openVirtualFile(conn, vtype, fileName);
    var vSize = vtype !== 'log' ? Buffer.byteLength(magicRead(vtype), 'ascii') : 0;
    // Response: WordCount=7, params=14 bytes
    // FID(2) + Attrs(2) + LastWriteTime(4) + Size(4) + GrantedAccess(2)
    var rParams = Buffer.alloc(14);
    rParams.writeUInt16LE(fid, 0);
    rParams.writeUInt16LE(ATTR_ARCHIVE, 2);
    rParams.writeUInt32LE(Math.floor(Date.now() / 1000), 4);
    rParams.writeUInt32LE(vSize, 8);
    rParams.writeUInt16LE(desiredAccess & 0x07, 12);
    return buildResponse(encodeHeader(CMD_OPEN, STATUS_SUCCESS, msg.hdr), rParams, Buffer.alloc(0));
  }

  var localPath = resolveShortPath(conn.sharePath, fileName);
  if (!localPath) return buildErrorResponse(CMD_OPEN, ERR_BAD_FILE, msg.hdr);

  var stat;
  try {
    stat = fs.statSync(localPath);
  } catch (e) {
    return buildErrorResponse(CMD_OPEN, ERR_BAD_FILE, msg.hdr);
  }

  // Determine flags
  var flags = 'r';
  var accessMode = desiredAccess & 0x07;
  if (accessMode === 1)
    flags = 'r+'; // write
  else if (accessMode === 2) flags = 'r+'; // read/write

  var fd;
  try {
    fd = fs.openSync(localPath, flags);
  } catch (e) {
    return buildErrorResponse(CMD_OPEN, ERR_NO_ACCESS, msg.hdr);
  }

  fid = nextFid++;
  conn.openFiles[fid] = { path: localPath, fd: fd, name: fileName };

  // Response: WordCount=7, params=14 bytes
  // FID(2) + Attrs(2) + LastWriteTime(4) + Size(4) + GrantedAccess(2)
  rParams = Buffer.alloc(14);
  rParams.writeUInt16LE(fid, 0);
  rParams.writeUInt16LE(getFileAttr(stat), 2);
  rParams.writeUInt32LE(Math.floor(stat.mtime.getTime() / 1000), 4);
  rParams.writeUInt32LE(capSize(stat.size), 8);
  rParams.writeUInt16LE(accessMode, 12);

  return buildResponse(encodeHeader(CMD_OPEN, STATUS_SUCCESS, msg.hdr), rParams, Buffer.alloc(0));
}

function handleOpenAndX(msg, cmdIdx, conn) {
  var params = msg.commands[cmdIdx].params;
  var data = msg.commands[cmdIdx].data;

  // Skip AndX header (4 bytes)
  var _flags = params.readUInt16LE(4); // eslint-disable-line no-unused-vars -- parsed SMB field
  var desiredAccess = params.readUInt16LE(6);
  var _searchAttrs = params.readUInt16LE(8); // eslint-disable-line no-unused-vars -- parsed SMB field
  var _fileAttrs = params.readUInt16LE(10); // eslint-disable-line no-unused-vars -- parsed SMB field
  var _creationTime = params.readUInt32LE(12); // eslint-disable-line no-unused-vars -- parsed SMB field
  var openFunc = params.readUInt16LE(16);
  var _allocSize = params.readUInt32LE(18); // eslint-disable-line no-unused-vars -- parsed SMB field

  // Data: filename (OEM, null-terminated)
  var r = readAsciiZ(data, 0);
  var fileName = stripSharePrefix(r.str);

  log('smb', 'OPEN_ANDX: %s access=0x%s openFunc=0x%s', fileName, desiredAccess.toString(16), openFunc.toString(16));

  // Virtual file handling
  var vtype = getVirtualType(fileName);
  if (vtype) {
    var fid = openVirtualFile(conn, vtype, fileName);
    var vSize = vtype !== 'log' ? Buffer.byteLength(magicRead(vtype), 'ascii') : 0;
    // Response: WordCount=15 (AndX), params=30 bytes
    var rParams = Buffer.alloc(30);
    rParams[0] = ANDX_NONE; // AndXCommand
    rParams[1] = 0x00; // AndXReserved
    rParams.writeUInt16LE(0, 2); // AndXOffset
    rParams.writeUInt16LE(fid, 4); // FID
    rParams.writeUInt16LE(ATTR_ARCHIVE, 6); // FileAttributes
    rParams.writeUInt32LE(Math.floor(Date.now() / 1000), 8); // LastWriteTime
    rParams.writeUInt32LE(vSize, 12); // FileDataSize
    rParams.writeUInt16LE(desiredAccess & 0x07, 16); // GrantedAccess
    rParams.writeUInt16LE(0, 18); // FileType: disk
    rParams.writeUInt16LE(0, 20); // DeviceState
    rParams.writeUInt16LE(1, 22); // Action: opened existing
    rParams.writeUInt32LE(0, 24); // ServerFID (reserved)
    rParams.writeUInt16LE(0, 28); // Reserved
    return andxResult(CMD_OPEN_ANDX, STATUS_SUCCESS, rParams, Buffer.alloc(0), {});
  }

  var localPath = resolveShortPath(conn.sharePath, fileName);
  // If file doesn't exist yet (create case), resolve parent + use filename directly
  if (!localPath) localPath = resolveNewFilePath(conn, fileName);

  // Determine open mode from openFunc
  // openFunc: bits 0-1: action if file exists (0=fail, 1=open, 2=truncate)
  //           bit 4: action if file doesn't exist (0=fail, 1=create)
  var existAction = openFunc & 0x03;
  var noExistAction = (openFunc >> 4) & 0x01;

  var fileExists;
  var stat;
  try {
    stat = fs.statSync(localPath);
    fileExists = true;
  } catch (e) {
    fileExists = false;
  }

  var nodeFlags;
  var actionTaken;
  if (fileExists) {
    if (existAction === 0) {
      return andxError(CMD_OPEN_ANDX, ERR_FILE_EXISTS);
    } else if (existAction === 2) {
      nodeFlags = 'w+';
      actionTaken = 3; // truncated
    } else {
      nodeFlags = 'r+';
      actionTaken = 1; // opened existing
    }
  } else {
    if (!noExistAction) {
      return andxError(CMD_OPEN_ANDX, ERR_BAD_FILE);
    }
    nodeFlags = 'w+';
    actionTaken = 2; // created new
  }

  // Access mode
  var accessMode = desiredAccess & 0x07;
  if (accessMode === 0 && nodeFlags === 'r+') nodeFlags = 'r';

  var fd;
  try {
    fd = fs.openSync(localPath, nodeFlags);
  } catch (e) {
    return andxError(CMD_OPEN_ANDX, ERR_NO_ACCESS);
  }

  if (!fileExists) {
    try {
      stat = fs.fstatSync(fd);
    } catch (e) {}
  }

  fid = nextFid++;
  conn.openFiles[fid] = { path: localPath, fd: fd, name: fileName };

  var fileSize = stat ? capSize(stat.size) : 0;

  // Response: WordCount=15 (AndX), params=30 bytes
  rParams = Buffer.alloc(30);
  rParams[0] = ANDX_NONE; // AndXCommand
  rParams[1] = 0x00; // AndXReserved
  rParams.writeUInt16LE(0, 2); // AndXOffset
  rParams.writeUInt16LE(fid, 4); // FID
  rParams.writeUInt16LE(stat ? getFileAttr(stat) : ATTR_ARCHIVE, 6); // FileAttributes
  rParams.writeUInt32LE(stat ? Math.floor(stat.mtime.getTime() / 1000) : 0, 8); // LastWriteTime
  rParams.writeUInt32LE(fileSize, 12); // FileDataSize
  rParams.writeUInt16LE(accessMode, 16); // GrantedAccess
  rParams.writeUInt16LE(0, 18); // FileType: disk
  rParams.writeUInt16LE(0, 20); // DeviceState
  rParams.writeUInt16LE(actionTaken, 22); // Action
  rParams.writeUInt32LE(0, 24); // ServerFID (reserved)
  rParams.writeUInt16LE(0, 28); // Reserved

  return andxResult(CMD_OPEN_ANDX, STATUS_SUCCESS, rParams, Buffer.alloc(0), {});
}

function handleRead(msg, conn) {
  var params = msg.commands[0].params;

  var fid = params.readUInt16LE(0);
  var count = params.readUInt16LE(2);
  var offset = params.readUInt32LE(4);

  log('smb', 'READ: fid=%d count=%d offset=%d', fid, count, offset);

  var file = conn.openFiles[fid];
  if (!file) {
    return buildErrorResponse(CMD_READ, ERR_BAD_FID, msg.hdr);
  }

  // Virtual file: return magic content
  if (file.virtual) {
    var vContent = file.type === 'log' ? Buffer.alloc(0) : Buffer.from(magicRead(file.type), 'ascii');
    var vSlice = vContent.slice(offset, offset + count);
    // Response: WordCount=5, params=10 bytes; Data: BUF_FMT_DATA_BLOCK(1) + len(2) + data
    var rParams = Buffer.alloc(10);
    rParams.writeUInt16LE(vSlice.length, 0); // CountOfBytesReturned
    var rData = Buffer.alloc(3 + vSlice.length);
    rData[0] = BUF_FMT_DATA_BLOCK;
    rData.writeUInt16LE(vSlice.length, 1);
    vSlice.copy(rData, 3);
    return buildResponse(encodeHeader(CMD_READ, STATUS_SUCCESS, msg.hdr), rParams, rData);
  }

  var buf = Buffer.alloc(count);
  var bytesRead;
  try {
    bytesRead = fs.readSync(file.fd, buf, 0, count, offset);
  } catch (e) {
    return buildErrorResponse(CMD_READ, ERR_NO_ACCESS, msg.hdr);
  }

  // Response: WordCount=5, params=10 bytes
  rParams = Buffer.alloc(10);
  rParams.writeUInt16LE(bytesRead, 0);
  // reserved (8 bytes) — zeroed

  // Data: BUF_FMT_DATA_BLOCK(1) + DataLength(2) + data
  rData = Buffer.alloc(3 + bytesRead);
  rData[0] = BUF_FMT_DATA_BLOCK;
  rData.writeUInt16LE(bytesRead, 1);
  buf.copy(rData, 3, 0, bytesRead);

  return buildResponse(encodeHeader(CMD_READ, STATUS_SUCCESS, msg.hdr), rParams, rData);
}

function handleReadAndX(msg, cmdIdx, conn) {
  var params = msg.commands[cmdIdx].params;

  // Skip AndX header (4 bytes)
  var fid = params.readUInt16LE(4);
  var offset = params.readUInt32LE(6);
  var maxCount = params.readUInt16LE(10);

  log('smb', 'READ_ANDX: fid=%d offset=%d maxCount=%d', fid, offset, maxCount);

  var file = conn.openFiles[fid];
  if (!file) return andxError(CMD_READ_ANDX, ERR_BAD_FILE);

  // DataOffset: header(32) + WordCount(1) + params(24) + ByteCount(2) = 59
  var READ_ANDX_DATA_OFFSET = 59;

  // Virtual file: return magic content
  if (file.virtual) {
    var vContent = file.type === 'log' ? Buffer.alloc(0) : Buffer.from(magicRead(file.type), 'ascii');
    var vSlice = vContent.slice(offset, offset + maxCount);
    var rParams = Buffer.alloc(24);
    rParams[0] = ANDX_NONE;
    rParams[1] = 0x00;
    rParams.writeUInt16LE(0, 2); // AndXOffset
    rParams.writeUInt16LE(-1, 4); // Available
    rParams.writeUInt16LE(0, 6); // DataCompactionMode
    rParams.writeUInt16LE(0, 8); // Reserved
    rParams.writeUInt16LE(vSlice.length, 10); // DataLength
    rParams.writeUInt16LE(READ_ANDX_DATA_OFFSET, 12); // DataOffset
    return andxResult(CMD_READ_ANDX, STATUS_SUCCESS, rParams, vSlice, {});
  }

  var buf = Buffer.alloc(maxCount);
  var bytesRead;
  try {
    bytesRead = fs.readSync(file.fd, buf, 0, maxCount, offset);
  } catch (e) {
    return andxError(CMD_READ_ANDX, ERR_NO_ACCESS);
  }

  // Response: WordCount=12 (AndX), params=24 bytes
  rParams = Buffer.alloc(24);
  rParams[0] = ANDX_NONE; // AndXCommand
  rParams[1] = 0x00; // AndXReserved
  rParams.writeUInt16LE(0, 2); // AndXOffset
  rParams.writeUInt16LE(-1, 4); // Available (unknown)
  rParams.writeUInt16LE(0, 6); // DataCompactionMode
  rParams.writeUInt16LE(0, 8); // Reserved
  rParams.writeUInt16LE(bytesRead, 10); // DataLength
  rParams.writeUInt16LE(READ_ANDX_DATA_OFFSET, 12); // DataOffset

  return andxResult(CMD_READ_ANDX, STATUS_SUCCESS, rParams, buf.slice(0, bytesRead), {});
}

function handleWrite(msg, conn) {
  var params = msg.commands[0].params;
  var data = msg.commands[0].data;

  var fid = params.readUInt16LE(0);
  var count = params.readUInt16LE(2);
  var offset = params.readUInt32LE(4);

  log('smb', 'WRITE: fid=%d count=%d offset=%d', fid, count, offset);

  var file = conn.openFiles[fid];
  if (!file) {
    return buildErrorResponse(CMD_WRITE, ERR_BAD_FILE, msg.hdr);
  }

  // Data: BUF_FMT_DATA_BLOCK(1) + DataLength(2) + data
  var writeData = data.slice(3, 3 + count);

  // Virtual file handling
  if (file.virtual) {
    if (file.type === 'log') {
      var text = writeData.toString('ascii').replace(/\r\n/g, '\n').replace(/\n$/, '');
      text.split('\n').forEach(function (line) {
        log('test', '%s', line);
      });
      try {
        fs.appendFileSync(TEST_LOG_PATH, text + '\n');
      } catch (e) {}
    } else {
      magicWrite(file.type, writeData.toString('ascii'));
    }
    var rParams = Buffer.alloc(2);
    rParams.writeUInt16LE(writeData.length, 0);
    return buildResponse(encodeHeader(CMD_WRITE, STATUS_SUCCESS, msg.hdr), rParams, Buffer.alloc(0));
  }

  var bytesWritten;
  try {
    bytesWritten = fs.writeSync(file.fd, writeData, 0, writeData.length, offset);
  } catch (e) {
    return buildErrorResponse(CMD_WRITE, ERR_NO_ACCESS, msg.hdr);
  }

  rParams = Buffer.alloc(2);
  rParams.writeUInt16LE(bytesWritten, 0);

  return buildResponse(encodeHeader(CMD_WRITE, STATUS_SUCCESS, msg.hdr), rParams, Buffer.alloc(0));
}

function handleWriteAndX(msg, cmdIdx, conn) {
  var params = msg.commands[cmdIdx].params;
  var data = msg.commands[cmdIdx].data;

  // Skip AndX header (4 bytes)
  var fid = params.readUInt16LE(4);
  var offset = params.readUInt32LE(6);
  var _writeMode = params.readUInt16LE(14); // eslint-disable-line no-unused-vars -- parsed SMB field
  var dataLen = params.readUInt16LE(20);
  // dataOffset is relative to SMB header start

  log('smb', 'WRITE_ANDX: fid=%d offset=%d len=%d', fid, offset, dataLen);

  var file = conn.openFiles[fid];
  if (!file) return andxError(CMD_WRITE_ANDX, ERR_BAD_FILE);

  var writeData = data.slice(0, dataLen);

  // Virtual file handling
  if (file.virtual) {
    if (file.type === 'log') {
      var text = writeData.toString('ascii').replace(/\r\n/g, '\n').replace(/\n$/, '');
      text.split('\n').forEach(function (line) {
        log('test', '%s', line);
      });
      try {
        fs.appendFileSync(TEST_LOG_PATH, text + '\n');
      } catch (e) {}
    } else {
      magicWrite(file.type, writeData.toString('ascii'));
    }
    var rParams = Buffer.alloc(12);
    rParams[0] = ANDX_NONE;
    rParams[1] = 0x00;
    rParams.writeUInt16LE(0, 2); // AndXOffset
    rParams.writeUInt16LE(writeData.length, 4); // CountOfBytesWritten
    return andxResult(CMD_WRITE_ANDX, STATUS_SUCCESS, rParams, Buffer.alloc(0), {});
  }

  var bytesWritten;
  try {
    bytesWritten = fs.writeSync(file.fd, writeData, 0, writeData.length, offset);
  } catch (e) {
    return andxError(CMD_WRITE_ANDX, ERR_NO_ACCESS);
  }

  // Response: WordCount=6 (AndX), params=12 bytes
  rParams = Buffer.alloc(12);
  rParams[0] = ANDX_NONE; // AndXCommand
  rParams[1] = 0x00; // AndXReserved
  rParams.writeUInt16LE(0, 2); // AndXOffset
  rParams.writeUInt16LE(bytesWritten, 4); // CountOfBytesWritten
  rParams.writeUInt16LE(0, 6); // Available
  rParams.writeUInt32LE(0, 8); // Reserved

  return andxResult(CMD_WRITE_ANDX, STATUS_SUCCESS, rParams, Buffer.alloc(0), {});
}

function handleClose(msg, conn) {
  var params = msg.commands[0].params;
  var fid = params.readUInt16LE(0);

  log('smb', 'CLOSE: fid=%d', fid);

  var file = conn.openFiles[fid];
  if (file) {
    try {
      fs.closeSync(file.fd);
    } catch (e) {}
    delete conn.openFiles[fid];
  }

  return buildResponse(encodeHeader(CMD_CLOSE, STATUS_SUCCESS, msg.hdr), Buffer.alloc(0), Buffer.alloc(0));
}

function handleEcho(msg, conn) {
  var params = msg.commands[0].params;
  var data = msg.commands[0].data;
  var echoCount = params.readUInt16LE(0);

  log('smb', 'ECHO: count=%d', echoCount);

  // Send one echo reply (we ignore echoCount > 1)
  var rParams = Buffer.alloc(2);
  rParams.writeUInt16LE(0, 0); // sequence number = 0

  return buildResponse(encodeHeader(CMD_ECHO, STATUS_SUCCESS, msg.hdr), rParams, data);
}

function handleProcessExit(msg, conn) {
  log('smb', 'PROCESS_EXIT');
  // Close all open files for this connection
  Object.keys(conn.openFiles).forEach(function (fid) {
    try {
      fs.closeSync(conn.openFiles[fid].fd);
    } catch (e) {}
  });
  conn.openFiles = {};

  return buildResponse(encodeHeader(CMD_PROCESS_EXIT, STATUS_SUCCESS, msg.hdr), Buffer.alloc(0), Buffer.alloc(0));
}

// ─── AndX Response Assembly ────────────────────────────────────────

function assembleAndXResponse(results, hdr) {
  // results is an array of { cmd, status, params, data, extraHdr }
  // Build a single SMB message with chained responses

  var extra = {};
  // Collect extra header fields from all results
  results.forEach(function (r) {
    if (r.extraHdr) {
      if (r.extraHdr.uid !== undefined) extra.uid = r.extraHdr.uid;
      if (r.extraHdr.tid !== undefined) extra.tid = r.extraHdr.tid;
    }
  });

  // Check for errors — if any command fails, send error for that command
  for (var i = 0; i < results.length; i++) {
    if (results[i].status !== STATUS_SUCCESS) {
      return buildResponse(
        encodeHeader(results[i].cmd, results[i].status, hdr, extra),
        results[i].params || Buffer.alloc(0),
        results[i].data || Buffer.alloc(0),
      );
    }
  }

  if (results.length === 1) {
    return buildResponse(encodeHeader(results[0].cmd, STATUS_SUCCESS, hdr, extra), results[0].params, results[0].data);
  }

  // Chain multiple responses together
  // Calculate offsets and update AndX pointers
  var headerBuf = encodeHeader(results[0].cmd, STATUS_SUCCESS, hdr, extra);
  var parts = [];
  var currentOffset = SMB_HEADER_LEN;

  for (i = 0; i < results.length; i++) {
    var r = results[i];
    var wordCount = r.params.length / 2;
    var byteCount = r.data.length;
    var blockSize = 1 + r.params.length + 2 + r.data.length;

    // Update AndX pointer to next command
    if (i < results.length - 1 && r.params.length >= 4) {
      r.params[0] = results[i + 1].cmd; // next command
      r.params.writeUInt16LE(currentOffset + blockSize, 2); // offset to next
    } else if (r.params.length >= 4) {
      r.params[0] = ANDX_NONE;
      r.params.writeUInt16LE(0, 2);
    }

    var block = Buffer.alloc(blockSize);
    var off = 0;
    block[off++] = wordCount;
    r.params.copy(block, off);
    off += r.params.length;
    block.writeUInt16LE(byteCount, off);
    off += 2;
    r.data.copy(block, off);

    parts.push(block);
    currentOffset += blockSize;
  }

  var body = Buffer.concat(parts);
  var smb = Buffer.concat([headerBuf, body]);
  var nbt = Buffer.alloc(4);
  nbt.writeUInt32BE(smb.length, 0);
  return Buffer.concat([nbt, smb]);
}

// ─── Main Dispatch ─────────────────────────────────────────────────

function handleSMBMessage(smbBuf, conn) {
  var msg = parseMessage(smbBuf);
  var cmdName = CMD_NAMES[msg.hdr.command] || '0x' + msg.hdr.command.toString(16);
  log('smb', '%s from %s', cmdName, conn.accountName || 'unknown');
  serverStats.commands++;

  // NEGOTIATE is special — not chained
  if (msg.hdr.command === CMD_NEGOTIATE) {
    return handleNegotiate(msg, conn);
  }

  // Process command chain
  var results = [];
  for (var i = 0; i < msg.commands.length; i++) {
    var cmd = msg.commands[i].cmd;
    var result;

    switch (cmd) {
      case CMD_SESSION_SETUP:
        result = handleSessionSetup(msg, conn);
        break;
      case CMD_TREE_CONNECT_ANDX:
        result = handleTreeConnect(msg, i, conn);
        break;
      case CMD_TREE_DISCONNECT:
        return handleTreeDisconnect(msg, conn);
      case CMD_SEARCH:
        return handleSearch(msg, conn);
      case CMD_QUERY_INFO_DISK:
        return handleQueryInfoDisk(msg, conn);
      case CMD_QUERY_INFO:
        return handleQueryInfo(msg, conn);
      case CMD_CHECK_DIR:
        return handleCheckDir(msg, conn);
      case CMD_READ:
        return handleRead(msg, conn);
      case CMD_OPEN:
        return handleOpen(msg, conn);
      case CMD_OPEN_ANDX:
        result = handleOpenAndX(msg, i, conn);
        break;
      case CMD_READ_ANDX:
        result = handleReadAndX(msg, i, conn);
        break;
      case CMD_WRITE:
        return handleWrite(msg, conn);
      case CMD_WRITE_ANDX:
        result = handleWriteAndX(msg, i, conn);
        break;
      case CMD_CLOSE:
        return handleClose(msg, conn);
      case CMD_DELETE:
        return handleDelete(msg, conn);
      case CMD_RENAME:
        return handleRename(msg, conn);
      case CMD_CREATE_DIR:
        return handleCreateDir(msg, conn);
      case CMD_DELETE_DIR:
        return handleDeleteDir(msg, conn);
      case CMD_CREATE:
        return handleCreate(msg, conn);
      case CMD_FLUSH:
        return handleFlush(msg, conn);
      case CMD_SET_INFO:
        return handleSetInfo(msg, conn);
      case CMD_ECHO:
        return handleEcho(msg, conn);
      case CMD_PROCESS_EXIT:
        return handleProcessExit(msg, conn);
      case CMD_QUERY_INFO2:
        return handleQueryInfo2(msg, conn);
      case CMD_SET_INFO2:
        return handleSetInfo2(msg, conn);
      case CMD_LOCKING:
        result = handleLocking(msg, i, conn);
        break;
      case CMD_TRANSACTION:
        return handleTransaction(msg, conn);
      case CMD_TRANSACTION2:
        return handleTransaction2(msg, conn);
      case CMD_FIND_CLOSE2:
        return handleFindClose2(msg, conn);
      case CMD_LOGOFF:
        result = handleLogoff(msg, i, conn);
        break;
      default:
        log('smb', 'Unsupported command: %s (0x%s)', CMD_NAMES[cmd] || '?', cmd.toString(16));
        return buildErrorResponse(cmd, ERR_BAD_FUNC, msg.hdr);
    }

    results.push(result);
  }

  if (results.length > 0) {
    return assembleAndXResponse(results, msg.hdr);
  }

  return buildErrorResponse(msg.hdr.command, ERR_BAD_FUNC, msg.hdr);
}

// ─── NBT Session + TCP Server ──────────────────────────────────────

var server = net.createServer(function (socket) {
  socket.setNoDelay(true);
  log('conn', 'Client connected from %s', socket.remoteAddress);

  var conn = createConnection(socket);
  serverStats.connections++;
  var buf = Buffer.alloc(0);
  var nbtDone = false;

  socket.on('data', function (data) {
    buf = Buffer.concat([buf, data]);

    // Step 1: NBT Session Request (0x81)
    if (!nbtDone) {
      if (buf.length < 4) return;
      var type = buf[0];
      var len = ((buf[1] & 0x01) << 16) | buf.readUInt16BE(2);
      if (buf.length < 4 + len) return;

      if (type === NBT_SESSION_REQUEST) {
        log('nbt', 'Session Request (%d bytes)', 4 + len);
        socket.write(Buffer.from([NBT_POSITIVE_RESPONSE, 0x00, 0x00, 0x00]));
        log('nbt', 'Sent Positive Session Response');
        buf = buf.slice(4 + len);
        nbtDone = true;
      } else {
        log('nbt', 'Unexpected type: 0x%s', type.toString(16));
        socket.destroy();
        return;
      }
    }

    // Step 2: Process SMB messages
    while (buf.length >= 4) {
      var nbtType = buf[0];
      if (nbtType !== NBT_SESSION_MESSAGE) {
        log('nbt', 'Unexpected type in data phase: 0x%s', nbtType.toString(16));
        buf = buf.slice(1); // try to recover
        continue;
      }
      var smbLen = buf.readUInt32BE(0) & 0x00ffffff; // 24-bit length
      if (buf.length < 4 + smbLen) return; // wait for full message

      var smbBuf = buf.slice(4, 4 + smbLen);
      buf = buf.slice(4 + smbLen);

      // Validate SMB magic
      if (
        smbBuf.length < SMB_HEADER_LEN ||
        smbBuf[0] !== SMB_MAGIC[0] ||
        smbBuf[1] !== SMB_MAGIC[1] ||
        smbBuf[2] !== SMB_MAGIC[2] ||
        smbBuf[3] !== SMB_MAGIC[3]
      ) {
        log('smb', 'Invalid SMB signature!');
        continue;
      }

      try {
        var response = handleSMBMessage(smbBuf, conn);
        if (response) {
          socket.write(response);
        }
      } catch (err) {
        log('smb', 'Handler error: %s', err.stack || err);
        try {
          var hdr = decodeHeader(smbBuf);
          socket.write(buildErrorResponse(hdr.command, ERR_BAD_FUNC, hdr));
        } catch (e) {}
      }
    }
  });

  socket.on('end', function () {
    log('conn', 'Client disconnected');
    // Clean up open files
    Object.keys(conn.openFiles).forEach(function (fid) {
      try {
        fs.closeSync(conn.openFiles[fid].fd);
      } catch (e) {}
    });
  });

  socket.on('error', function (err) {
    log('conn', 'Socket error: %s', err.message);
  });
});

// ─── Start Server ──────────────────────────────────────────────────

// Ensure share directory exists
try {
  fs.mkdirSync(SHARE_PATH, { recursive: true });
} catch (e) {}

// Clear test log from previous run
try {
  fs.writeFileSync(TEST_LOG_PATH, '');
} catch (e) {}

// Open server log for appending (persistent debug log with timestamps)
try {
  serverLogFd = fs.openSync(SERVER_LOG_PATH, 'a');
} catch (e) {
  console.error('Warning: could not open server.log for writing');
}

server.listen(PORT, '0.0.0.0', function () {
  console.log('=== LANMAN2.1 SMB Server for WFW 3.11 ===');
  console.log('Share: %s → %s', SHARE_NAME, SHARE_PATH);
  console.log('Test log: %s', TEST_LOG_PATH);
  console.log('Listening on port %d', PORT);
  console.log('');
  console.log('  WFW 3.11: net use z: \\\\MACHOST\\SHARE');
  console.log('');
});

server.on('error', function (err) {
  if (err.code === 'EACCES') {
    console.error('Port %d requires root. Run: sudo node lanman-server.js', PORT);
  } else if (err.code === 'EADDRINUSE') {
    console.error('Port %d is already in use.', PORT);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});
