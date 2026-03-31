# DOSBox-X Host Directory Mount: Caching, File Visibility, and Locking

Reference document covering how DOSBox-X handles host directory mounts, directory
caching behavior, and implications for test harnesses that write files from the
host side while a DOS TSR reads them inside the emulator.

---

## 1. The Directory Cache Problem

DOSBox (and DOSBox-X, which inherits the behavior) caches the directory structure
of mounted host directories in memory. This cache is populated when a directory is
first accessed and is **not automatically invalidated** when the host filesystem
changes.

**Consequence:** If the host writes a new file (e.g., a TX file for the TSR), DOS
programs inside DOSBox-X will **not see it** via `DIR`, `FindFirst/FindNext`
(INT 21h/4Eh-4Fh), or any file-open call until the cache is refreshed.

This is a well-documented issue:

- [GitHub Issue #4395](https://github.com/joncampbell123/dosbox-x/issues/4395) --
  "DOSBox-X doesn't update directory listing to show files added outside of DOSBox-X"
- [GitHub Issue #201](https://github.com/joncampbell123/dosbox-x/issues/201) --
  "Create files in mounted folder by host can not be found by dosbox-x"

The cache exists for performance: it avoids repeated host OS syscalls and context
switches, which matters on large directories or networked paths.

---

## 2. The `-nocachedir` Mount Option

DOSBox-X provides a mount flag that **disables directory caching entirely** for a
given drive:

```
MOUNT C /path/to/dir -nocachedir
```

With `-nocachedir`, every directory listing or file lookup goes directly to the
host filesystem. Host-side file creations, deletions, and modifications are
visible immediately -- no RESCAN needed.

### Global config equivalent

In `dosbox-x.conf` under the `[dosbox]` section:

```ini
[dosbox]
nocachedir = true
```

This makes all subsequent `MOUNT` commands behave as if `-nocachedir` were passed.
Default value: `false`.

**This is the recommended setting for our test harness.**

### Performance cost

Without the cache, DOSBox-X must make host OS calls for every `FindFirst`,
`FindNext`, and directory traversal. For a small exchange directory with a handful
of files, this is negligible. For directories with thousands of files, there may
be measurable slowdown.

---

## 3. The RESCAN Command (Manual Cache Refresh)

If you do NOT use `-nocachedir`, you can manually refresh the cache:

| Method | Scope |
|---|---|
| `RESCAN` (no args) | Current drive only |
| `RESCAN C:` | Specific drive |
| `RESCAN /A` | All mounted drives |
| `Ctrl+F4` | All drives (keyboard shortcut) |
| DOS menu > "Rescan all drives" | All drives (GUI menu) |

**Limitation:** RESCAN is a command-line operation. A TSR cannot easily invoke it
programmatically. The TSR would have to re-traverse the directory itself, but that
traversal would still hit the stale cache unless `-nocachedir` is active.

There is **no automatic periodic RESCAN** feature. A request for this in
dosbox-staging ([Issue #1265](https://github.com/dosbox-staging/dosbox-staging/issues/1265))
was closed as "out of scope."

---

## 4. File Access Details with `-nocachedir`

### When the host writes a file, how quickly does DOS see it?

With `nocachedir=true`: **immediately** on the next DOS file operation. The
emulated DOS call maps directly to a host `opendir()`/`readdir()` or `open()`
syscall. There is no polling delay -- it is synchronous.

Without `nocachedir`: **never**, until RESCAN is run or DOSBox-X is restarted.

### Does file truncation work correctly?

Yes. When a file is opened with `O_CREAT | O_TRUNC` semantics (DOS create/truncate
via INT 21h/3Ch), the host file is truncated. Overwriting an existing file with
new content works as expected. The host filesystem handles the actual I/O.

### File content reads -- is content cached?

**No.** DOSBox-X does NOT cache file contents. Only the **directory structure**
(file names, sizes, timestamps) is cached. Once a file handle is opened, all
reads and writes go directly through to the host OS. This means:

- If the host modifies a file's *content* while DOS has it open, the DOS program
  will see the new content on its next read (subject to host OS buffering).
- If the host modifies a file that DOS does NOT have open, the content change is
  visible the next time DOS opens the file (no cache issue for content).

The directory cache issue only affects **discovery** (finding the file by name),
not reading/writing file data.

---

## 5. File Locking

### DOS-side locking (SHARE.EXE)

DOSBox-X reports `SHARE.EXE` as resident by default (`share=true` in `[dos]`
section). This provides basic file-locking and record-locking emulation, though
not all SHARE functions are fully emulated.

### Host-side file locking

DOSBox-X can pass lock requests through to the host OS, but this is
**Windows-only** and requires specific configuration:

```ini
[dos]
share = true
file access tries = 3
```

The `file access tries` option (default: `0`) controls retry behavior:

- If set to a positive integer, DOSBox-X will retry read/write/lock operations
  on mounted local drives that many times before failing.
- **Recommended for file-locking scenarios:** set to `3`.
- This setting is designed for networked database applications (dBase, FoxPro,
  Clipper) that rely on record locking.

A developer stated: "the file locking may work on all platforms. For now please
set `nocachedir=true` for best result."
([Issue #2134](https://github.com/joncampbell123/dosbox-x/issues/2134))

### Concurrent host + DOS access

There is **no cross-boundary locking** between host processes and DOS programs.
If both the host test harness and the DOS TSR write to the same file
simultaneously, there is a race condition. The protocol must enforce
turn-taking (e.g., TX/RX file naming conventions, or a flag file).

---

## 6. Known Issues and Gotchas

1. **Deletion IS visible without RESCAN.** Interestingly, deleting a file on the
   host side is reflected immediately inside DOSBox-X even without `-nocachedir`.
   Only file *creation* is invisible. (Reported in Issue #201.)

2. **`-nocachedir` is not available in vanilla DOSBox or dosbox-staging.** It is
   a DOSBox-X-specific feature. In vanilla DOSBox, the only option is RESCAN or
   `Ctrl+F4`.

3. **No filesystem change notifications.** DOSBox-X does not use `inotify`,
   `FSEvents`, or `kqueue` to watch for host changes. The `-nocachedir` flag
   works by simply not caching, not by watching. This was discussed as a potential
   future improvement but has not been implemented.

4. **macOS note:** File locking pass-through is primarily tested on Windows.
   On macOS, `nocachedir=true` still works for cache-free directory access, but
   host-level file locking behavior may differ.

---

## 7. Recommended Configuration for Test Harness

For a test harness where the host writes TX files and a DOS TSR must detect and
read them immediately:

```ini
[dosbox]
nocachedir = true

[dos]
share = true
file access tries = 3
```

Or mount with the flag explicitly:

```
MOUNT D /path/to/exchange -nocachedir
```

### Protocol design implications

Even with `nocachedir=true`, there is no atomic "write + make visible" guarantee
from the host side. Best practice:

1. **Write to a temp file** on the host (e.g., `TX.tmp`).
2. **Rename to the final name** (e.g., `TX`). Rename is atomic on most host
   filesystems (POSIX `rename()`, Windows `MoveFile`).
3. The TSR polls for the existence of `TX` via `FindFirst` or `open()`. With
   `nocachedir`, it will see the file as soon as the rename completes.

This avoids the TSR reading a partially-written file.

---

## 8. Summary Table

| Question | With `nocachedir=true` | Without (default) |
|---|---|---|
| New host file visible to DOS? | Immediately | Never (until RESCAN) |
| Host file content changes visible? | Immediately (content is never cached) | Immediately (same) |
| Host file deletion visible? | Immediately | Immediately (oddly) |
| Performance impact? | Minor (extra host syscalls) | None (cached) |
| Requires RESCAN? | No | Yes, for new files |
| File locking between host+DOS? | No automatic locking | No automatic locking |

---

## Sources

- [DOSBox-X Issue #4395 -- Directory listing not updating](https://github.com/joncampbell123/dosbox-x/issues/4395)
- [DOSBox-X Issue #1414 -- Option NOT to cache hard-disk directories](https://github.com/joncampbell123/dosbox-x/issues/1414)
- [DOSBox-X Issue #201 -- Host-created files not found](https://github.com/joncampbell123/dosbox-x/issues/201)
- [DOSBox-X Issue #2134 -- File locking under DOSBox-X](https://github.com/joncampbell123/dosbox-x/issues/2134)
- [dosbox-staging Issue #1265 -- Periodic RESCAN request](https://github.com/dosbox-staging/dosbox-staging/issues/1265)
- [DOSBox-X reference config (nocachedir, file access tries)](https://github.com/joncampbell123/dosbox-x/blob/master/dosbox-x.reference.conf)
- [DOSBox Wiki -- MOUNT command](https://www.dosbox.com/wiki/MOUNT)
- [DOSBox Wiki -- RESCAN command](https://www.dosbox.com/wiki/RESCAN)
- [DOSBox-X Supported Commands](https://dosbox-x.com/wiki/DOSBox%E2%80%90X%E2%80%99s-Supported-Commands)
- [VOGONS -- Disable Disk Cache discussion](https://www.vogons.org/viewtopic.php?t=63315)
