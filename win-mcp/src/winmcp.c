/*
 * WIN-MCP: Windows 3.1 Model Context Protocol Helper
 *
 * Win16 app that polls __WIN__.TX for commands and writes responses
 * to __WIN__.RX. Runs as a hidden window with a timer.
 *
 * Command families:
 *   META     - lifecycle (PING, VERSION, STATUS, QUIT)
 *   PROFILE  - INI file access (GET, SET, SECTIONS)
 *   FILE     - file operations (READ, WRITE, DELETE, COPY, FIND, APPEND)
 *   DIR      - directory operations (LIST, CREATE, DELETE)
 *   TIME     - system time (GET)
 *   ENV      - environment (GET)
 *   EXEC     - launch programs
 *   WINDOW   - window management (LIST, FIND, TITLE, CLOSE, MOVE, SHOW, RECT, VISIBLE, ENABLED)
 *   TASK     - task management (LIST, KILL)
 *   GDI      - graphics (SCREEN, CAPTURE)
 *   MSG      - message passing (SEND, POST)
 *   CLIP     - clipboard (GET, SET)
 *   DIALOG   - dialog interaction (LIST, GET, SET, CLICK)
 *   DDE      - Dynamic Data Exchange (CONNECT, EXEC, CLOSE)
 *   TYPE     - text input via WM_CHAR
 *   SENDKEYS - keyboard input via WM_KEYDOWN/WM_KEYUP
 *   MOUSE    - mouse simulation (MOVE, CLICK, DBLCLICK, RCLICK, DRAG, RDRAG, GETPOS)
 *   CLICK    - button click via WM_COMMAND BN_CLICKED
 *   MENU     - menu command via WM_COMMAND
 *   FOCUS    - SetFocus + BringWindowToTop
 *   SCROLL   - scroll via WM_VSCROLL/WM_HSCROLL
 *   CONTROL  - child window locator (FIND)
 *   LIST     - listbox operations (SELECT)
 *   COMBO    - combobox operations (SELECT)
 *   CHECK    - checkbox set checked
 *   UNCHECK  - checkbox set unchecked
 *   ABORT    - dismiss foreground modal dialog
 *   WAIT     - wait for window/condition (WINDOW, GONE)
 *   WAITFOR  - wait for control text match
 *   EXPECT   - immediate control text check
 */

#include <windows.h>
#include <toolhelp.h>
#include <ddeml.h>
#include <string.h>
#include <stdlib.h>
#include <direct.h>
#include <dos.h>

/* BM_CLICK doesn't exist in Win16 — simulate with BM_SETSTATE */
#ifndef BM_CLICK
#define BM_CLICK 0x00F5
#endif

/* IPC file paths — drive letter patched at startup */
static char tx_path[128] = "C:\\_MAGIC_\\__WIN__.TX";
static char rx_path[128] = "C:\\_MAGIC_\\__WIN__.RX";
static char st_path[128] = "C:\\_MAGIC_\\__WIN__.ST";
static char tw_path[128] = "C:\\_MAGIC_\\__WIN__.TW";
static char bmp_path[128] = "C:\\_MAGIC_\\__WIN__.BMP";

static char lr_path[128] = "C:\\_MAGIC_\\__WIN__.LR";

static HINSTANCE hAppInst;
static HWND      hMainWnd;
static UINT      nCmdCount = 0;
static BOOL      bInPoll = FALSE;   /* re-entrancy guard for poll_tx */
static char      cmd_buf[512];
static char      resp_buf[4096];
static char      tmp_buf[1024];

#define TIMER_ID   1
#define POLL_MS    200

/* Forward declarations */
static void pump_messages(void);

/* Win16 VK codes not in all headers */
#ifndef VK_OEM_PERIOD
#define VK_OEM_PERIOD 0xBE
#endif

/* BN_CLICKED for WM_COMMAND */
#ifndef BN_CLICKED
#define BN_CLICKED 0
#endif

/* Listbox messages */
#ifndef LB_SELECTSTRING
#define LB_SELECTSTRING  0x018C
#endif
#ifndef LB_GETCURSEL
#define LB_GETCURSEL     0x0188
#endif

/* Combobox messages */
#ifndef CB_SELECTSTRING
#define CB_SELECTSTRING  0x014D
#endif
#ifndef CB_GETCURSEL
#define CB_GETCURSEL     0x0147
#endif

/* Checkbox messages */
#ifndef BM_SETCHECK
#define BM_SETCHECK      0x00F1
#endif
#ifndef BST_CHECKED
#define BST_CHECKED      1
#endif
#ifndef BST_UNCHECKED
#define BST_UNCHECKED    0
#endif

/* DDE state */
static DWORD     ddeInst = 0;
static HCONV     ddeConv = (HCONV)0;

/* Hook DLL state — loaded on demand */
static HINSTANCE hHookDll = NULL;
static char      evt_path[128] = "C:\\_MAGIC_\\__WIN__.EVT";

/* Hook DLL function pointers */
typedef BOOL (FAR PASCAL *PFNSTARTRECORD)(void);
typedef UINT (FAR PASCAL *PFNSTOPRECORD)(void);
typedef BOOL (FAR PASCAL *PFNSTARTPLAYBACK)(UINT speed);
typedef void (FAR PASCAL *PFNSTOPPLAYBACK)(void);
typedef UINT (FAR PASCAL *PFNGETRECORDCOUNT)(void);
typedef UINT (FAR PASCAL *PFNGETPLAYBACKSTATE)(void);
typedef void (FAR PASCAL *PFNSETPLAYBACKSPEED)(UINT speed);
typedef void FAR * (FAR PASCAL *PFNGETEVTBUF)(void);
typedef BOOL (FAR PASCAL *PFNSETEVTBUF)(void FAR *src, UINT count);
typedef UINT (FAR PASCAL *PFNGETBUFCAP)(void);

static PFNSTARTRECORD     pfnStartRecord = NULL;
static PFNSTOPRECORD      pfnStopRecord = NULL;
static PFNSTARTPLAYBACK   pfnStartPlayback = NULL;
static PFNSTOPPLAYBACK    pfnStopPlayback = NULL;
static PFNGETRECORDCOUNT  pfnGetRecordCount = NULL;
static PFNGETPLAYBACKSTATE pfnGetPlaybackState = NULL;
static PFNSETPLAYBACKSPEED pfnSetPlaybackSpeed = NULL;
static PFNGETEVTBUF       pfnGetEventBuffer = NULL;
static PFNSETEVTBUF       pfnSetEventBuffer = NULL;
static PFNGETBUFCAP       pfnGetBufferCapacity = NULL;

/* ============================================================ */
/* Utility: case-insensitive prefix match                       */
/* ============================================================ */

static int prefix(const char *str, const char *pfx) {
    while (*pfx) {
        char a = *str, b = *pfx;
        if (a >= 'a' && a <= 'z') a -= 32;
        if (b >= 'a' && b <= 'z') b -= 32;
        if (a != b) return 0;
        str++; pfx++;
    }
    return 1;
}

/* Get pointer past prefix + space */
static const char *after(const char *str, int skip) {
    str += skip;
    while (*str == ' ') str++;
    return str;
}

/* Parse hex value from string */
static UINT parse_hex(const char **pp) {
    UINT val = 0;
    const char *p = *pp;
    while (*p == ' ') p++;
    while ((*p >= '0' && *p <= '9') || (*p >= 'a' && *p <= 'f') || (*p >= 'A' && *p <= 'F')) {
        char c = *p;
        if (c >= 'a') c -= 32;
        val = val * 16 + (c <= '9' ? c - '0' : c - 'A' + 10);
        p++;
    }
    *pp = p;
    return val;
}

/* Parse decimal */
static int parse_dec(const char **pp) {
    int val = 0;
    const char *p = *pp;
    while (*p == ' ') p++;
    while (*p >= '0' && *p <= '9') {
        val = val * 10 + (*p - '0');
        p++;
    }
    *pp = p;
    return val;
}

/* Skip spaces */
static const char *skip_sp(const char *p) {
    while (*p == ' ') p++;
    return p;
}

/* Copy until next space or end, return pointer to rest */
static const char *next_word(const char *p, char *out, int maxlen) {
    int i = 0;
    p = skip_sp(p);
    while (*p && *p != ' ' && i < maxlen - 1) {
        out[i++] = *p++;
    }
    out[i] = '\0';
    return p;
}

/* ============================================================ */
/* File I/O helpers                                              */
/* ============================================================ */

static BOOL file_exists(const char *path) {
    OFSTRUCT ofs;
    HFILE hf;
    hf = OpenFile(path, &ofs, OF_EXIST);
    return (hf != HFILE_ERROR);
}

static int read_file(const char *path, char *buf, int maxlen) {
    OFSTRUCT ofs;
    HFILE hf;
    int n;
    hf = OpenFile(path, &ofs, OF_READ);
    if (hf == HFILE_ERROR) return -1;
    n = _lread(hf, buf, maxlen - 1);
    _lclose(hf);
    if (n < 0) n = 0;
    buf[n] = '\0';
    return n;
}

static BOOL write_file(const char *path, const char *data, int len) {
    OFSTRUCT ofs;
    HFILE hf;
    hf = OpenFile(path, &ofs, OF_CREATE | OF_WRITE);
    if (hf == HFILE_ERROR) return FALSE;
    _lwrite(hf, data, len);
    _lclose(hf);
    return TRUE;
}

static void delete_file(const char *path) {
    OFSTRUCT ofs;
    OpenFile(path, &ofs, OF_DELETE);
}

static void write_response(const char *resp) {
    int len;
    len = lstrlen(resp);
    if (len > 3900) {
        /* Long response — write full data to LR file, signal via RX */
        write_file(lr_path, resp, len);
        write_file(rx_path, "OK @LR", 6);
    } else {
        write_file(rx_path, resp, len);
    }
}

/* ============================================================ */
/* META commands                                                 */
/* ============================================================ */

static void cmd_meta(const char *arg) {
    if (prefix(arg, "PING")) {
        write_response("OK PONG");
    } else if (prefix(arg, "VERSION")) {
        write_response("OK WINMCP/0.4 META,PROFILE,FILE,DIR,TIME,ENV,EXEC,WINDOW,TASK,GDI,MSG,CLIP,DIALOG,DDE,TYPE,SENDKEYS,MOUSE,CLICK,MENU,FOCUS,SCROLL,CONTROL,LIST,COMBO,CHECK,UNCHECK,ABORT,WAIT,WAITFOR,EXPECT,RECORD,PLAY");
    } else if (prefix(arg, "STATUS")) {
        wsprintf(resp_buf, "OK CMDS=%u POLL=%ums", nCmdCount, POLL_MS);
        write_response(resp_buf);
    } else if (prefix(arg, "QUIT")) {
        write_response("OK");
        PostQuitMessage(0);
    } else {
        write_response("ERR UNKNOWN_COMMAND");
    }
}

/* ============================================================ */
/* PROFILE commands — INI file access                            */
/* ============================================================ */

static void cmd_profile(const char *arg) {
    char file[128], section[64], key[64], value[256];
    const char *p;

    if (prefix(arg, "GET ")) {
        /* PROFILE GET <file> <section> <key> */
        p = after(arg, 4);
        p = next_word(p, file, sizeof(file));
        p = next_word(p, section, sizeof(section));
        p = next_word(p, key, sizeof(key));
        if (!file[0] || !section[0] || !key[0]) {
            write_response("ERR SYNTAX");
            return;
        }
        GetPrivateProfileString(section, key, "", value, sizeof(value), file);
        wsprintf(resp_buf, "OK %s", (LPSTR)value);
        write_response(resp_buf);

    } else if (prefix(arg, "SET ")) {
        /* PROFILE SET <file> <section> <key> <value> */
        p = after(arg, 4);
        p = next_word(p, file, sizeof(file));
        p = next_word(p, section, sizeof(section));
        p = next_word(p, key, sizeof(key));
        p = skip_sp(p);
        lstrcpyn(value, p, sizeof(value));
        if (!file[0] || !section[0] || !key[0]) {
            write_response("ERR SYNTAX");
            return;
        }
        if (WritePrivateProfileString(section, key, value[0] ? value : NULL, file))
            write_response("OK");
        else
            write_response("ERR WRITE_FAILED");

    } else if (prefix(arg, "SECTIONS ")) {
        /* PROFILE SECTIONS <file> */
        int n;
        char *s;
        p = after(arg, 9);
        p = next_word(p, file, sizeof(file));
        if (!file[0]) {
            write_response("ERR SYNTAX");
            return;
        }
        n = GetPrivateProfileString(NULL, NULL, "", tmp_buf, sizeof(tmp_buf), file);
        lstrcpy(resp_buf, "OK");
        s = tmp_buf;
        while (*s) {
            lstrcat(resp_buf, " ");
            lstrcat(resp_buf, s);
            s += lstrlen(s) + 1;
        }
        write_response(resp_buf);
    } else {
        write_response("ERR UNKNOWN_COMMAND");
    }
}

/* ============================================================ */
/* FILE commands                                                 */
/* ============================================================ */

static void cmd_file(const char *arg) {
    char path[128], path2[128];
    const char *p;
    OFSTRUCT ofs;
    HFILE hf;
    int n;

    if (prefix(arg, "READ ")) {
        /* FILE READ <path> [maxbytes] */
        int maxb;
        p = after(arg, 5);
        p = next_word(p, path, sizeof(path));
        p = skip_sp(p);
        maxb = (*p) ? parse_dec(&p) : (int)(sizeof(tmp_buf) - 1);
        if (maxb > (int)(sizeof(tmp_buf) - 1)) maxb = sizeof(tmp_buf) - 1;
        if (!path[0]) { write_response("ERR SYNTAX"); return; }
        n = read_file(path, tmp_buf, maxb + 1);
        if (n < 0) { write_response("ERR NOT_FOUND"); return; }
        wsprintf(resp_buf, "OK %s", (LPSTR)tmp_buf);
        write_response(resp_buf);

    } else if (prefix(arg, "WRITE ")) {
        /* FILE WRITE <path> <data> */
        p = after(arg, 6);
        p = next_word(p, path, sizeof(path));
        p = skip_sp(p);
        if (!path[0]) { write_response("ERR SYNTAX"); return; }
        if (write_file(path, p, lstrlen(p)))
            write_response("OK");
        else
            write_response("ERR WRITE_FAILED");

    } else if (prefix(arg, "APPEND ")) {
        /* FILE APPEND <path> <data> */
        p = after(arg, 7);
        p = next_word(p, path, sizeof(path));
        p = skip_sp(p);
        if (!path[0]) { write_response("ERR SYNTAX"); return; }
        hf = OpenFile(path, &ofs, OF_WRITE);
        if (hf == HFILE_ERROR)
            hf = OpenFile(path, &ofs, OF_CREATE | OF_WRITE);
        if (hf == HFILE_ERROR) { write_response("ERR WRITE_FAILED"); return; }
        _llseek(hf, 0L, 2); /* seek to end */
        _lwrite(hf, p, lstrlen(p));
        _lclose(hf);
        write_response("OK");

    } else if (prefix(arg, "DELETE ")) {
        /* FILE DELETE <path> */
        p = after(arg, 7);
        p = next_word(p, path, sizeof(path));
        if (!path[0]) { write_response("ERR SYNTAX"); return; }
        hf = OpenFile(path, &ofs, OF_DELETE);
        if (hf == HFILE_ERROR)
            write_response("ERR NOT_FOUND");
        else
            write_response("OK");

    } else if (prefix(arg, "COPY ")) {
        /* FILE COPY <src> <dst> */
        p = after(arg, 5);
        p = next_word(p, path, sizeof(path));
        p = next_word(p, path2, sizeof(path2));
        if (!path[0] || !path2[0]) { write_response("ERR SYNTAX"); return; }
        n = read_file(path, tmp_buf, sizeof(tmp_buf));
        if (n < 0) { write_response("ERR NOT_FOUND"); return; }
        if (write_file(path2, tmp_buf, n))
            write_response("OK");
        else
            write_response("ERR WRITE_FAILED");

    } else if (prefix(arg, "FIND ")) {
        /* FILE FIND <pattern> — returns space-separated filenames */
        struct find_t fi;
        char *rp;
        int remain;
        p = after(arg, 5);
        p = next_word(p, path, sizeof(path));
        if (!path[0]) { write_response("ERR SYNTAX"); return; }
        lstrcpy(resp_buf, "OK");
        rp = resp_buf + 2;
        remain = sizeof(resp_buf) - 4;
        if (_dos_findfirst(path, _A_NORMAL | _A_RDONLY | _A_ARCH, &fi) == 0) {
            do {
                int nl;
                nl = lstrlen(fi.name);
                if (nl + 1 < remain) {
                    *rp++ = ' ';
                    lstrcpy(rp, fi.name);
                    rp += nl;
                    remain -= nl + 1;
                }
            } while (_dos_findnext(&fi) == 0);
        }
        write_response(resp_buf);

    } else {
        write_response("ERR UNKNOWN_COMMAND");
    }
}

/* ============================================================ */
/* DIR commands                                                  */
/* ============================================================ */

static void cmd_dir(const char *arg) {
    const char *p;
    char path[128];
    int n;

    if (prefix(arg, "CREATE ")) {
        /* DIR CREATE <path> — use DOS INT 21h/39h via inline or _mkdir */
        p = after(arg, 7);
        p = next_word(p, path, sizeof(path));
        if (!path[0]) { write_response("ERR SYNTAX"); return; }
        /* Win16 doesn't have CreateDirectory — use DOS call */
        if (mkdir(path) == 0)
            write_response("OK");
        else
            write_response("ERR FAILED");

    } else if (prefix(arg, "DELETE ")) {
        p = after(arg, 7);
        p = next_word(p, path, sizeof(path));
        if (!path[0]) { write_response("ERR SYNTAX"); return; }
        if (rmdir(path) == 0)
            write_response("OK");
        else
            write_response("ERR FAILED");

    } else if (prefix(arg, "LIST ")) {
        /* DIR LIST <path> — list files/dirs matching pattern */
        struct find_t fi;
        char *rp;
        int remain;
        char pattern[140];
        p = after(arg, 5);
        p = next_word(p, path, sizeof(path));
        if (!path[0]) { write_response("ERR SYNTAX"); return; }
        /* Append \*.* if path doesn't contain wildcards */
        lstrcpy(pattern, path);
        if (!_fstrchr(pattern, '*') && !_fstrchr(pattern, '?')) {
            n = lstrlen(pattern);
            if (n > 0 && pattern[n-1] != '\\') lstrcat(pattern, "\\");
            lstrcat(pattern, "*.*");
        }
        lstrcpy(resp_buf, "OK");
        rp = resp_buf + 2;
        remain = sizeof(resp_buf) - 4;
        if (_dos_findfirst(pattern, _A_NORMAL | _A_RDONLY | _A_SUBDIR | _A_ARCH, &fi) == 0) {
            do {
                int nl;
                char entry[20];
                /* Mark directories with trailing / */
                lstrcpy(entry, fi.name);
                if (fi.attrib & _A_SUBDIR) lstrcat(entry, "/");
                nl = lstrlen(entry);
                if (nl + 1 < remain) {
                    *rp++ = ' ';
                    lstrcpy(rp, entry);
                    rp += nl;
                    remain -= nl + 1;
                }
            } while (_dos_findnext(&fi) == 0);
        }
        write_response(resp_buf);
    } else {
        write_response("ERR UNKNOWN_COMMAND");
    }
}

/* ============================================================ */
/* TIME GET                                                      */
/* ============================================================ */

static void cmd_time(const char *arg) {
    if (prefix(arg, "GET")) {
        WORD hour, min, sec;
        DWORD t;
        t = GetCurrentTime(); /* ms since Windows start — not wall clock */
        /* Use DOS time instead */
        {
            WORD dosdate, dostime;
            _asm {
                mov ah, 2Ch
                int 21h
                mov hour, cx
                mov min, dx
            }
            /* CH=hour, CL=min, DH=sec, DL=1/100 */
            sec = min >> 8;
            min = hour & 0xFF;
            hour = hour >> 8;
            wsprintf(resp_buf, "OK %02u:%02u:%02u", hour, min, sec);
            write_response(resp_buf);
        }
    } else {
        write_response("ERR UNKNOWN_COMMAND");
    }
}

/* ============================================================ */
/* ENV GET                                                       */
/* ============================================================ */

static void cmd_env(const char *arg) {
    if (prefix(arg, "GET ")) {
        const char *p;
        LPCSTR env;
        int namelen;
        char name[64];
        p = after(arg, 4);
        p = next_word(p, name, sizeof(name));
        if (!name[0]) { write_response("ERR SYNTAX"); return; }
        namelen = lstrlen(name);
        env = GetDOSEnvironment();
        while (*env) {
            /* Check if this entry starts with NAME= */
            if (_fstrnicmp(env, name, namelen) == 0 && env[namelen] == '=') {
                wsprintf(resp_buf, "OK %s", (LPSTR)(env + namelen + 1));
                write_response(resp_buf);
                return;
            }
            env += lstrlen(env) + 1;
        }
        write_response("ERR NOT_FOUND");
    } else {
        write_response("ERR UNKNOWN_COMMAND");
    }
}

/* ============================================================ */
/* EXEC                                                          */
/* ============================================================ */

static void cmd_exec(const char *arg) {
    const char *p;
    UINT result;
    p = skip_sp(arg);
    if (!*p) { write_response("ERR SYNTAX"); return; }
    result = WinExec(p, SW_SHOW);
    if (result >= 32) {
        wsprintf(resp_buf, "OK %u", result);
        write_response(resp_buf);
    } else {
        wsprintf(resp_buf, "ERR EXEC_FAILED %u", result);
        write_response(resp_buf);
    }
}

/* ============================================================ */
/* WINDOW commands                                               */
/* ============================================================ */

/* Callback for EnumWindows */
static char *wl_ptr;
static int   wl_remain;

static BOOL FAR PASCAL EnumWndProc(HWND hwnd, LPARAM lParam) {
    char title[128], cls[64];
    int n;
    (void)lParam;
    GetClassName(hwnd, cls, sizeof(cls));
    GetWindowText(hwnd, title, sizeof(title));
    n = wsprintf(tmp_buf, " %04X:%s:%s", (UINT)hwnd, (LPSTR)cls, (LPSTR)title);
    if (n < wl_remain) {
        lstrcat(wl_ptr, tmp_buf);
        wl_ptr += n;
        wl_remain -= n;
    }
    return TRUE;
}

static void cmd_window(const char *arg) {
    const char *p;
    HWND hwnd;

    if (prefix(arg, "LIST")) {
        lstrcpy(resp_buf, "OK");
        wl_ptr = resp_buf + 2;
        wl_remain = sizeof(resp_buf) - 4;
        EnumWindows((WNDENUMPROC)EnumWndProc, 0L);
        write_response(resp_buf);

    } else if (prefix(arg, "FIND ")) {
        char cls[64], title[128];
        p = after(arg, 5);
        p = next_word(p, cls, sizeof(cls));
        p = skip_sp(p);
        lstrcpyn(title, p, sizeof(title));
        hwnd = FindWindow(cls[0] ? cls : NULL, title[0] ? title : NULL);
        if (hwnd)
            wsprintf(resp_buf, "OK %04X", (UINT)hwnd);
        else
            lstrcpy(resp_buf, "ERR NOT_FOUND");
        write_response(resp_buf);

    } else if (prefix(arg, "TITLE ")) {
        char title[256];
        p = after(arg, 6);
        hwnd = (HWND)parse_hex(&p);
        if (!IsWindow(hwnd)) { write_response("ERR INVALID_HWND"); return; }
        GetWindowText(hwnd, title, sizeof(title));
        wsprintf(resp_buf, "OK %s", (LPSTR)title);
        write_response(resp_buf);

    } else if (prefix(arg, "CLOSE ")) {
        p = after(arg, 6);
        hwnd = (HWND)parse_hex(&p);
        if (!IsWindow(hwnd)) { write_response("ERR INVALID_HWND"); return; }
        PostMessage(hwnd, WM_CLOSE, 0, 0L);
        write_response("OK");

    } else if (prefix(arg, "MOVE ")) {
        int x, y, w, h;
        p = after(arg, 5);
        hwnd = (HWND)parse_hex(&p);
        p = skip_sp(p); x = parse_dec(&p);
        p = skip_sp(p); y = parse_dec(&p);
        p = skip_sp(p); w = parse_dec(&p);
        p = skip_sp(p); h = parse_dec(&p);
        if (!IsWindow(hwnd)) { write_response("ERR INVALID_HWND"); return; }
        MoveWindow(hwnd, x, y, w, h, TRUE);
        write_response("OK");

    } else if (prefix(arg, "SHOW ")) {
        int sw;
        p = after(arg, 5);
        hwnd = (HWND)parse_hex(&p);
        p = skip_sp(p);
        /* Parse show command */
        if (prefix(p, "HIDE")) sw = SW_HIDE;
        else if (prefix(p, "MIN")) sw = SW_MINIMIZE;
        else if (prefix(p, "MAX")) sw = SW_MAXIMIZE;
        else if (prefix(p, "RESTORE")) sw = SW_RESTORE;
        else sw = SW_SHOW;
        if (!IsWindow(hwnd)) { write_response("ERR INVALID_HWND"); return; }
        ShowWindow(hwnd, sw);
        write_response("OK");

    } else if (prefix(arg, "RECT ")) {
        RECT rc;
        p = after(arg, 5);
        hwnd = (HWND)parse_hex(&p);
        if (!IsWindow(hwnd)) { write_response("ERR INVALID_HWND"); return; }
        GetWindowRect(hwnd, &rc);
        wsprintf(resp_buf, "OK %d %d %d %d",
                 rc.left, rc.top,
                 rc.right - rc.left, rc.bottom - rc.top);
        write_response(resp_buf);

    } else if (prefix(arg, "VISIBLE ")) {
        p = after(arg, 8);
        hwnd = (HWND)parse_hex(&p);
        if (!IsWindow(hwnd)) { write_response("ERR INVALID_HWND"); return; }
        wsprintf(resp_buf, "OK %s", IsWindowVisible(hwnd) ? (LPSTR)"TRUE" : (LPSTR)"FALSE");
        write_response(resp_buf);

    } else if (prefix(arg, "ENABLED ")) {
        p = after(arg, 8);
        hwnd = (HWND)parse_hex(&p);
        if (!IsWindow(hwnd)) { write_response("ERR INVALID_HWND"); return; }
        wsprintf(resp_buf, "OK %s", IsWindowEnabled(hwnd) ? (LPSTR)"TRUE" : (LPSTR)"FALSE");
        write_response(resp_buf);

    } else {
        write_response("ERR UNKNOWN_COMMAND");
    }
}

/* ============================================================ */
/* TASK commands (ToolHelp API)                                  */
/* ============================================================ */

static void cmd_task(const char *arg) {
    if (prefix(arg, "LIST")) {
        TASKENTRY te;
        char *rp;
        int remain;
        te.dwSize = sizeof(TASKENTRY);
        lstrcpy(resp_buf, "OK");
        rp = resp_buf + 2;
        remain = sizeof(resp_buf) - 4;
        if (TaskFirst(&te)) {
            do {
                int n;
                n = wsprintf(tmp_buf, " %04X:%s", (UINT)te.hTask, (LPSTR)te.szModule);
                if (n < remain) {
                    lstrcat(rp, tmp_buf);
                    rp += n;
                    remain -= n;
                }
            } while (TaskNext(&te));
        }
        write_response(resp_buf);

    } else if (prefix(arg, "KILL ")) {
        HTASK ht;
        const char *p;
        p = after(arg, 5);
        ht = (HTASK)parse_hex(&p);
        TerminateApp(ht, NO_UAE_BOX);
        write_response("OK");

    } else {
        write_response("ERR UNKNOWN_COMMAND");
    }
}

/* ============================================================ */
/* GDI commands                                                  */
/* ============================================================ */

static void cmd_gdi(const char *arg) {
    if (prefix(arg, "SCREEN")) {
        HDC hdc;
        int w, h, bpp;
        hdc = GetDC(NULL);
        w = GetDeviceCaps(hdc, HORZRES);
        h = GetDeviceCaps(hdc, VERTRES);
        bpp = GetDeviceCaps(hdc, BITSPIXEL) * GetDeviceCaps(hdc, PLANES);
        ReleaseDC(NULL, hdc);
        wsprintf(resp_buf, "OK W=%d H=%d BPP=%d", w, h, bpp);
        write_response(resp_buf);

    } else if (prefix(arg, "CAPTURE")) {
        /* GDI CAPTURE [ACTIVE|<hwnd>] — save BMP to magic dir */
        const char *p;
        HWND target;
        HWND prevFG;
        HDC hdcSrc, hdcMem;
        HBITMAP hbm, hbmOld;
        RECT rc;
        int w, h;
        int brought_to_top;
        OFSTRUCT ofs;
        HFILE hf;

        p = after(arg, 7);
        p = skip_sp(p);

        brought_to_top = 0;
        if (!*p) {
            /* No argument: full desktop */
            target = GetDesktopWindow();
        } else if (prefix(p, "ACTIVE")) {
            /* ACTIVE: foreground window */
            target = GetActiveWindow();
            if (!target) target = GetDesktopWindow();
        } else {
            /* Specific hwnd */
            target = (HWND)parse_hex(&p);
        }

        if (!IsWindow(target)) { write_response("ERR INVALID_HWND"); return; }

        /* For specific windows (not desktop), we need the window to be
         * visible to capture it. Bring to top with SWP_NOACTIVATE to
         * minimize visual disruption, let it repaint, then restore. */
        prevFG = NULL;
        if (target != GetDesktopWindow()) {
            prevFG = GetActiveWindow();
            /* Bring to top without activating — less visual disruption */
            SetWindowPos(target, (HWND)0, 0, 0, 0, 0,
                         SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
            BringWindowToTop(target);
            /* Process messages so the window repaints */
            {
                DWORD start;
                start = GetTickCount();
                while (GetTickCount() - start < 150) {
                    MSG pmsg;
                    while (PeekMessage(&pmsg, NULL, 0, 0, PM_REMOVE)) {
                        TranslateMessage(&pmsg);
                        DispatchMessage(&pmsg);
                    }
                }
            }
            brought_to_top = 1;
        }

        GetWindowRect(target, &rc);
        w = rc.right - rc.left;
        h = rc.bottom - rc.top;
        if (w <= 0 || h <= 0) { write_response("ERR EMPTY_RECT"); return; }

        /* Use screen DC for reliable capture */
        hdcSrc = GetDC(NULL);
        hdcMem = CreateCompatibleDC(hdcSrc);
        hbm = CreateCompatibleBitmap(hdcSrc, w, h);
        hbmOld = SelectObject(hdcMem, hbm);
        BitBlt(hdcMem, 0, 0, w, h, hdcSrc, rc.left, rc.top, SRCCOPY);
        SelectObject(hdcMem, hbmOld);

        /* Restore previous foreground window if we brought target to top */
        if (brought_to_top && prevFG && IsWindow(prevFG)) {
            BringWindowToTop(prevFG);
        }

        /* Save as 24bpp BMP using GetPixel (works on any display driver).
         * GetDIBits requires driver support; GetPixel always works via GDI.
         * Re-select bitmap into memory DC for GetPixel access. */
        hbmOld = SelectObject(hdcMem, hbm);
        {
            BITMAPINFOHEADER bi;
            BITMAPFILEHEADER bf;
            int lineBytes, row, col;
            HGLOBAL hLine;
            char FAR *lineBuf;
            DWORD pixel;

            lineBytes = ((w * 3 + 3) / 4) * 4;  /* 24bpp DWORD-aligned */

            bi.biSize = sizeof(BITMAPINFOHEADER);
            bi.biWidth = w;
            bi.biHeight = h;
            bi.biPlanes = 1;
            bi.biBitCount = 24;
            bi.biCompression = BI_RGB;
            bi.biSizeImage = (DWORD)lineBytes * h;
            bi.biXPelsPerMeter = 0;
            bi.biYPelsPerMeter = 0;
            bi.biClrUsed = 0;
            bi.biClrImportant = 0;

            bf.bfType = 0x4D42;
            bf.bfSize = (DWORD)sizeof(bf) + sizeof(bi) + bi.biSizeImage;
            bf.bfReserved1 = 0;
            bf.bfReserved2 = 0;
            bf.bfOffBits = (DWORD)sizeof(bf) + sizeof(bi);

            hLine = GlobalAlloc(GMEM_MOVEABLE, (DWORD)lineBytes);
            if (!hLine) {
                SelectObject(hdcMem, hbmOld);
                DeleteObject(hbm); DeleteDC(hdcMem); ReleaseDC(NULL, hdcSrc);
                write_response("ERR ALLOC_FAILED");
                return;
            }
            lineBuf = GlobalLock(hLine);

            hf = OpenFile(bmp_path, &ofs, OF_CREATE | OF_WRITE);
            if (hf != HFILE_ERROR) {
                _lwrite(hf, (LPSTR)&bf, sizeof(bf));
                _lwrite(hf, (LPSTR)&bi, sizeof(bi));

                /* BMP stores bottom-up: row 0 = bottom of image */
                for (row = h - 1; row >= 0; row--) {
                    int idx = 0;
                    for (col = 0; col < w; col++) {
                        pixel = GetPixel(hdcMem, col, row);
                        lineBuf[idx++] = (char)GetBValue(pixel);
                        lineBuf[idx++] = (char)GetGValue(pixel);
                        lineBuf[idx++] = (char)GetRValue(pixel);
                    }
                    /* Pad to DWORD boundary */
                    while (idx < lineBytes) lineBuf[idx++] = 0;
                    _lwrite(hf, lineBuf, (UINT)lineBytes);
                }
                _lclose(hf);
            }

            GlobalUnlock(hLine);
            GlobalFree(hLine);
        }
        SelectObject(hdcMem, hbmOld);

        DeleteObject(hbm);
        DeleteDC(hdcMem);
        ReleaseDC(NULL, hdcSrc);

        wsprintf(resp_buf, "OK %s", (LPSTR)bmp_path);
        write_response(resp_buf);

    } else {
        write_response("ERR UNKNOWN_COMMAND");
    }
}

/* ============================================================ */
/* MSG commands                                                  */
/* ============================================================ */

static void cmd_msg(const char *arg) {
    const char *p;
    HWND hwnd;
    UINT msg;
    WPARAM wp;
    LPARAM lp;

    if (prefix(arg, "SEND ") || prefix(arg, "POST ")) {
        int is_post;
        LRESULT result;
        is_post = prefix(arg, "POST");
        p = after(arg, is_post ? 5 : 5);
        hwnd = (HWND)parse_hex(&p);
        p = skip_sp(p); msg = parse_hex(&p);
        p = skip_sp(p); wp = (WPARAM)parse_hex(&p);
        p = skip_sp(p); lp = (LPARAM)parse_hex(&p);
        if (!IsWindow(hwnd)) { write_response("ERR INVALID_HWND"); return; }
        if (is_post) {
            PostMessage(hwnd, msg, wp, lp);
            write_response("OK");
        } else {
            result = SendMessage(hwnd, msg, wp, lp);
            wsprintf(resp_buf, "OK %lX", result);
            write_response(resp_buf);
        }
    } else {
        write_response("ERR UNKNOWN_COMMAND");
    }
}

/* ============================================================ */
/* CLIP commands                                                 */
/* ============================================================ */

static void cmd_clip(const char *arg) {
    if (prefix(arg, "GET")) {
        HANDLE hData;
        LPSTR pData;
        if (!OpenClipboard(hMainWnd)) { write_response("ERR CLIPBOARD_BUSY"); return; }
        hData = GetClipboardData(CF_TEXT);
        if (!hData) {
            CloseClipboard();
            write_response("ERR EMPTY");
            return;
        }
        pData = GlobalLock(hData);
        if (pData) {
            wsprintf(resp_buf, "OK %s", pData);
            GlobalUnlock(hData);
        } else {
            lstrcpy(resp_buf, "ERR LOCK_FAILED");
        }
        CloseClipboard();
        write_response(resp_buf);

    } else if (prefix(arg, "SET ")) {
        const char *p;
        HGLOBAL hMem;
        LPSTR pMem;
        int len;
        p = after(arg, 4);
        len = lstrlen(p);
        hMem = GlobalAlloc(GMEM_MOVEABLE | GMEM_DDESHARE, (DWORD)(len + 1));
        if (!hMem) { write_response("ERR ALLOC_FAILED"); return; }
        pMem = GlobalLock(hMem);
        lstrcpy(pMem, p);
        GlobalUnlock(hMem);
        if (!OpenClipboard(hMainWnd)) {
            GlobalFree(hMem);
            write_response("ERR CLIPBOARD_BUSY");
            return;
        }
        EmptyClipboard();
        SetClipboardData(CF_TEXT, hMem);
        CloseClipboard();
        write_response("OK");

    } else {
        write_response("ERR UNKNOWN_COMMAND");
    }
}

/* ============================================================ */
/* DIALOG commands                                               */
/* ============================================================ */

/* Callback for EnumChildWindows to list dialog controls */
static char *dl_ptr;
static int   dl_remain;

static BOOL FAR PASCAL EnumDlgProc(HWND hwnd, LPARAM lParam) {
    char cls[64], text[128];
    int id, n;
    (void)lParam;
    id = GetDlgCtrlID(hwnd);
    GetClassName(hwnd, cls, sizeof(cls));
    GetWindowText(hwnd, text, sizeof(text));
    n = wsprintf(tmp_buf, " %d:%s:%s", id, (LPSTR)cls, (LPSTR)text);
    if (n < dl_remain) {
        lstrcat(dl_ptr, tmp_buf);
        dl_ptr += n;
        dl_remain -= n;
    }
    return TRUE;
}

static void cmd_dialog(const char *arg) {
    const char *p;
    HWND hwnd;

    if (prefix(arg, "LIST ")) {
        p = after(arg, 5);
        hwnd = (HWND)parse_hex(&p);
        if (!IsWindow(hwnd)) { write_response("ERR INVALID_HWND"); return; }
        lstrcpy(resp_buf, "OK");
        dl_ptr = resp_buf + 2;
        dl_remain = sizeof(resp_buf) - 4;
        EnumChildWindows(hwnd, (WNDENUMPROC)EnumDlgProc, 0L);
        write_response(resp_buf);

    } else if (prefix(arg, "GET ")) {
        int id;
        char text[256];
        p = after(arg, 4);
        hwnd = (HWND)parse_hex(&p);
        p = skip_sp(p); id = parse_dec(&p);
        if (!IsWindow(hwnd)) { write_response("ERR INVALID_HWND"); return; }
        GetDlgItemText(hwnd, id, text, sizeof(text));
        wsprintf(resp_buf, "OK %s", (LPSTR)text);
        write_response(resp_buf);

    } else if (prefix(arg, "SET ")) {
        int id;
        const char *text;
        p = after(arg, 4);
        hwnd = (HWND)parse_hex(&p);
        p = skip_sp(p); id = parse_dec(&p);
        text = skip_sp(p);
        if (!IsWindow(hwnd)) { write_response("ERR INVALID_HWND"); return; }
        SetDlgItemText(hwnd, id, text);
        write_response("OK");

    } else if (prefix(arg, "CLICK ")) {
        int id;
        HWND ctrl;
        p = after(arg, 6);
        hwnd = (HWND)parse_hex(&p);
        p = skip_sp(p); id = parse_dec(&p);
        if (!IsWindow(hwnd)) { write_response("ERR INVALID_HWND"); return; }
        ctrl = GetDlgItem(hwnd, id);
        if (!ctrl) { write_response("ERR NOT_FOUND"); return; }
        SendMessage(ctrl, BM_CLICK, 0, 0L);
        write_response("OK");

    } else {
        write_response("ERR UNKNOWN_COMMAND");
    }
}

/* ============================================================ */
/* DDE commands                                                  */
/* ============================================================ */

static HDDEDATA FAR PASCAL DdeCallback(UINT type, UINT fmt, HCONV hconv,
    HSZ hsz1, HSZ hsz2, HDDEDATA hData, DWORD dwData1, DWORD dwData2) {
    (void)type; (void)fmt; (void)hconv; (void)hsz1; (void)hsz2;
    (void)hData; (void)dwData1; (void)dwData2;
    return (HDDEDATA)0;
}

static void cmd_dde(const char *arg) {
    const char *p;

    if (prefix(arg, "CONNECT ")) {
        char service[64], topic[64];
        HSZ hszSvc, hszTopic;
        p = after(arg, 8);
        p = next_word(p, service, sizeof(service));
        p = next_word(p, topic, sizeof(topic));
        if (!service[0] || !topic[0]) { write_response("ERR SYNTAX"); return; }

        /* Initialize DDE if not already */
        if (!ddeInst) {
            if (DdeInitialize(&ddeInst, (PFNCALLBACK)DdeCallback,
                              APPCMD_CLIENTONLY, 0L) != DMLERR_NO_ERROR) {
                write_response("ERR DDE_INIT_FAILED");
                return;
            }
        }
        /* Disconnect existing */
        if (ddeConv) {
            DdeDisconnect(ddeConv);
            ddeConv = (HCONV)0;
        }

        hszSvc = DdeCreateStringHandle(ddeInst, service, CP_WINANSI);
        hszTopic = DdeCreateStringHandle(ddeInst, topic, CP_WINANSI);
        ddeConv = DdeConnect(ddeInst, hszSvc, hszTopic, NULL);
        DdeFreeStringHandle(ddeInst, hszSvc);
        DdeFreeStringHandle(ddeInst, hszTopic);

        if (ddeConv) {
            wsprintf(resp_buf, "OK %04X", (UINT)ddeConv);
            write_response(resp_buf);
        } else {
            write_response("ERR DDE_CONNECT_FAILED");
        }

    } else if (prefix(arg, "EXEC ")) {
        HDDEDATA hResult;
        int len;
        p = after(arg, 5);
        if (!ddeConv) { write_response("ERR NO_CONNECTION"); return; }
        len = lstrlen(p);
        hResult = DdeClientTransaction((LPBYTE)p, (DWORD)(len + 1),
                    ddeConv, (HSZ)NULL, CF_TEXT, XTYP_EXECUTE, 5000, NULL);
        if (hResult)
            write_response("OK");
        else
            write_response("ERR DDE_EXEC_FAILED");

    } else if (prefix(arg, "CLOSE")) {
        if (ddeConv) {
            DdeDisconnect(ddeConv);
            ddeConv = (HCONV)0;
        }
        if (ddeInst) {
            DdeUninitialize(ddeInst);
            ddeInst = 0;
        }
        write_response("OK");

    } else {
        write_response("ERR UNKNOWN_COMMAND");
    }
}

/* ============================================================ */
/* TYPE — text input via WM_CHAR                                 */
/* ============================================================ */

static void cmd_type(const char *arg) {
    /* TYPE <hwnd> <text> — sends WM_CHAR per character */
    const char *p;
    HWND hwnd;
    const char *text;

    p = skip_sp(arg);
    hwnd = (HWND)parse_hex(&p);
    text = skip_sp(p);
    if (!IsWindow(hwnd)) { write_response("ERR INVALID_HWND"); return; }
    if (!*text) { write_response("ERR SYNTAX"); return; }

    SetFocus(hwnd);

    while (*text) {
        char ch = *text;
        if (ch == '\\' && text[1]) {
            text++;
            switch (*text) {
            case 'n': ch = '\r'; break;  /* Enter = CR in Windows */
            case 't': ch = '\t'; break;
            case 'e': ch = 0x1B; break;  /* Escape */
            case '\\': ch = '\\'; break;
            default: ch = *text; break;
            }
        }
        SendMessage(hwnd, WM_CHAR, (WPARAM)(BYTE)ch, 0L);
        text++;
    }
    write_response("OK");
}

/* ============================================================ */
/* SENDKEYS — keyboard input with VK codes                       */
/* ============================================================ */

/* Build lParam for WM_KEYDOWN/WM_KEYUP */
static LONG make_key_lparam(BYTE vk, BOOL bUp) {
    BYTE scan;
    LONG lp;
    scan = (BYTE)MapVirtualKey(vk, 0);
    lp = 1L;                           /* repeat count = 1 */
    lp |= ((LONG)scan) << 16;         /* scan code bits 16-23 */
    /* Extended key flag for certain keys */
    if (vk == VK_INSERT || vk == VK_DELETE || vk == VK_HOME || vk == VK_END ||
        vk == VK_PRIOR || vk == VK_NEXT || vk == VK_LEFT || vk == VK_RIGHT ||
        vk == VK_UP || vk == VK_DOWN) {
        lp |= (1L << 24);             /* extended key bit */
    }
    if (bUp) {
        lp |= (1L << 30);             /* previous state = down */
        lp |= (1L << 31);             /* transition = releasing */
    }
    return lp;
}

static BYTE parse_vk_token(const char **pp) {
    const char *p = *pp;
    char tok[16];
    int i = 0;

    if (*p != '{') return 0;
    p++;  /* skip { */
    while (*p && *p != '}' && i < 14) {
        tok[i++] = *p++;
    }
    tok[i] = '\0';
    if (*p == '}') p++;
    *pp = p;

    /* Map token names to VK codes */
    if (prefix(tok, "ALT")) return VK_MENU;
    if (prefix(tok, "CTRL") || prefix(tok, "CONTROL")) return VK_CONTROL;
    if (prefix(tok, "SHIFT")) return VK_SHIFT;
    if (prefix(tok, "ENTER") || prefix(tok, "RETURN")) return VK_RETURN;
    if (prefix(tok, "TAB")) return VK_TAB;
    if (prefix(tok, "ESC") || prefix(tok, "ESCAPE")) return VK_ESCAPE;
    if (prefix(tok, "BACKSPACE") || prefix(tok, "BS")) return VK_BACK;
    if (prefix(tok, "DELETE") || prefix(tok, "DEL")) return VK_DELETE;
    if (prefix(tok, "INSERT") || prefix(tok, "INS")) return VK_INSERT;
    if (prefix(tok, "HOME")) return VK_HOME;
    if (prefix(tok, "END")) return VK_END;
    if (prefix(tok, "PGUP") || prefix(tok, "PAGEUP")) return VK_PRIOR;
    if (prefix(tok, "PGDN") || prefix(tok, "PAGEDOWN")) return VK_NEXT;
    if (prefix(tok, "UP")) return VK_UP;
    if (prefix(tok, "DOWN")) return VK_DOWN;
    if (prefix(tok, "LEFT")) return VK_LEFT;
    if (prefix(tok, "RIGHT")) return VK_RIGHT;
    if (prefix(tok, "SPACE")) return VK_SPACE;

    /* F-keys: F1-F12 */
    if (tok[0] == 'F' && tok[1] >= '1' && tok[1] <= '9') {
        int fnum = tok[1] - '0';
        if (tok[2] >= '0' && tok[2] <= '9')
            fnum = fnum * 10 + (tok[2] - '0');
        if (fnum >= 1 && fnum <= 12)
            return (BYTE)(VK_F1 + fnum - 1);
    }

    return 0;  /* unknown token */
}

static void cmd_sendkeys(const char *arg) {
    /* SENDKEYS <hwnd> <keys> */
    const char *p;
    HWND hwnd;
    const char *keys;
    BOOL bAlt = FALSE, bCtrl = FALSE, bShift = FALSE;

    p = skip_sp(arg);
    hwnd = (HWND)parse_hex(&p);
    keys = skip_sp(p);
    if (!IsWindow(hwnd)) { write_response("ERR INVALID_HWND"); return; }
    if (!*keys) { write_response("ERR SYNTAX"); return; }

    SetFocus(hwnd);

    while (*keys) {
        if (*keys == '{') {
            BYTE vk = parse_vk_token(&keys);
            if (!vk) continue;

            /* Check if this is a modifier */
            if (vk == VK_MENU || vk == VK_CONTROL || vk == VK_SHIFT) {
                if (vk == VK_MENU) bAlt = TRUE;
                else if (vk == VK_CONTROL) bCtrl = TRUE;
                else bShift = TRUE;
                continue;
            }

            /* Press modifiers */
            if (bCtrl) SendMessage(hwnd, WM_KEYDOWN, VK_CONTROL, make_key_lparam(VK_CONTROL, FALSE));
            if (bAlt) SendMessage(hwnd, WM_SYSKEYDOWN, VK_MENU, make_key_lparam(VK_MENU, FALSE));
            if (bShift) SendMessage(hwnd, WM_KEYDOWN, VK_SHIFT, make_key_lparam(VK_SHIFT, FALSE));

            /* Press/release the key */
            if (bAlt) {
                SendMessage(hwnd, WM_SYSKEYDOWN, vk, make_key_lparam(vk, FALSE));
                SendMessage(hwnd, WM_SYSKEYUP, vk, make_key_lparam(vk, TRUE));
            } else {
                SendMessage(hwnd, WM_KEYDOWN, vk, make_key_lparam(vk, FALSE));
                SendMessage(hwnd, WM_KEYUP, vk, make_key_lparam(vk, TRUE));
            }

            /* Release modifiers */
            if (bShift) { SendMessage(hwnd, WM_KEYUP, VK_SHIFT, make_key_lparam(VK_SHIFT, TRUE)); bShift = FALSE; }
            if (bAlt) { SendMessage(hwnd, WM_SYSKEYUP, VK_MENU, make_key_lparam(VK_MENU, TRUE)); bAlt = FALSE; }
            if (bCtrl) { SendMessage(hwnd, WM_KEYUP, VK_CONTROL, make_key_lparam(VK_CONTROL, TRUE)); bCtrl = FALSE; }
        } else {
            /* Plain character — use WM_CHAR */
            BYTE vk;
            if (bCtrl || bAlt) {
                /* For modified chars, convert to VK code */
                vk = VkKeyScan(*keys) & 0xFF;
                if (bCtrl) SendMessage(hwnd, WM_KEYDOWN, VK_CONTROL, make_key_lparam(VK_CONTROL, FALSE));
                if (bAlt) SendMessage(hwnd, WM_SYSKEYDOWN, VK_MENU, make_key_lparam(VK_MENU, FALSE));
                if (bShift) SendMessage(hwnd, WM_KEYDOWN, VK_SHIFT, make_key_lparam(VK_SHIFT, FALSE));

                if (bAlt) {
                    SendMessage(hwnd, WM_SYSKEYDOWN, vk, make_key_lparam(vk, FALSE));
                    SendMessage(hwnd, WM_SYSKEYUP, vk, make_key_lparam(vk, TRUE));
                } else {
                    SendMessage(hwnd, WM_KEYDOWN, vk, make_key_lparam(vk, FALSE));
                    SendMessage(hwnd, WM_KEYUP, vk, make_key_lparam(vk, TRUE));
                }

                if (bShift) { SendMessage(hwnd, WM_KEYUP, VK_SHIFT, make_key_lparam(VK_SHIFT, TRUE)); bShift = FALSE; }
                if (bAlt) { SendMessage(hwnd, WM_SYSKEYUP, VK_MENU, make_key_lparam(VK_MENU, TRUE)); bAlt = FALSE; }
                if (bCtrl) { SendMessage(hwnd, WM_KEYUP, VK_CONTROL, make_key_lparam(VK_CONTROL, TRUE)); bCtrl = FALSE; }
            } else {
                SendMessage(hwnd, WM_CHAR, (WPARAM)(BYTE)*keys, 0L);
            }
            keys++;
        }
    }
    write_response("OK");
}

/* ============================================================ */
/* MOUSE — mouse simulation                                      */
/* ============================================================ */

static void cmd_mouse(const char *arg) {
    const char *p;
    HWND hwnd;
    int x, y, x2, y2;
    LPARAM lp;

    if (prefix(arg, "MOVE ")) {
        /* MOUSE MOVE <x> <y> — SetCursorPos */
        p = after(arg, 5);
        x = parse_dec(&p);
        p = skip_sp(p); y = parse_dec(&p);
        SetCursorPos(x, y);
        write_response("OK");

    } else if (prefix(arg, "CLICK ")) {
        /* MOUSE CLICK <hwnd> <x> <y> */
        p = after(arg, 6);
        hwnd = (HWND)parse_hex(&p);
        p = skip_sp(p); x = parse_dec(&p);
        p = skip_sp(p); y = parse_dec(&p);
        if (!IsWindow(hwnd)) { write_response("ERR INVALID_HWND"); return; }
        lp = MAKELONG(x, y);
        PostMessage(hwnd, WM_LBUTTONDOWN, MK_LBUTTON, lp);
        PostMessage(hwnd, WM_LBUTTONUP, 0, lp);
        write_response("OK");

    } else if (prefix(arg, "DBLCLICK ")) {
        /* MOUSE DBLCLICK <hwnd> <x> <y> */
        p = after(arg, 9);
        hwnd = (HWND)parse_hex(&p);
        p = skip_sp(p); x = parse_dec(&p);
        p = skip_sp(p); y = parse_dec(&p);
        if (!IsWindow(hwnd)) { write_response("ERR INVALID_HWND"); return; }
        lp = MAKELONG(x, y);
        PostMessage(hwnd, WM_LBUTTONDOWN, MK_LBUTTON, lp);
        PostMessage(hwnd, WM_LBUTTONUP, 0, lp);
        PostMessage(hwnd, WM_LBUTTONDBLCLK, MK_LBUTTON, lp);
        PostMessage(hwnd, WM_LBUTTONUP, 0, lp);
        write_response("OK");

    } else if (prefix(arg, "RCLICK ")) {
        /* MOUSE RCLICK <hwnd> <x> <y> */
        p = after(arg, 7);
        hwnd = (HWND)parse_hex(&p);
        p = skip_sp(p); x = parse_dec(&p);
        p = skip_sp(p); y = parse_dec(&p);
        if (!IsWindow(hwnd)) { write_response("ERR INVALID_HWND"); return; }
        lp = MAKELONG(x, y);
        PostMessage(hwnd, WM_RBUTTONDOWN, MK_RBUTTON, lp);
        PostMessage(hwnd, WM_RBUTTONUP, 0, lp);
        write_response("OK");

    } else if (prefix(arg, "DRAG ") || prefix(arg, "RDRAG ")) {
        /* MOUSE DRAG <hwnd> <x1> <y1> <x2> <y2> */
        /* MOUSE RDRAG <hwnd> <x1> <y1> <x2> <y2> */
        BOOL bRight;
        UINT msgDown, msgMove, msgUp;
        WPARAM wDown;
        int steps, i, dx, dy;

        bRight = prefix(arg, "RDRAG");
        p = after(arg, bRight ? 6 : 5);
        hwnd = (HWND)parse_hex(&p);
        p = skip_sp(p); x = parse_dec(&p);
        p = skip_sp(p); y = parse_dec(&p);
        p = skip_sp(p); x2 = parse_dec(&p);
        p = skip_sp(p); y2 = parse_dec(&p);
        if (!IsWindow(hwnd)) { write_response("ERR INVALID_HWND"); return; }

        if (bRight) {
            msgDown = WM_RBUTTONDOWN; msgMove = WM_MOUSEMOVE;
            msgUp = WM_RBUTTONUP; wDown = MK_RBUTTON;
        } else {
            msgDown = WM_LBUTTONDOWN; msgMove = WM_MOUSEMOVE;
            msgUp = WM_LBUTTONUP; wDown = MK_LBUTTON;
        }

        SetCapture(hwnd);
        PostMessage(hwnd, msgDown, wDown, MAKELONG(x, y));

        /* Interpolate 8 steps */
        steps = 8;
        dx = x2 - x;
        dy = y2 - y;
        for (i = 1; i <= steps; i++) {
            int cx, cy;
            cx = x + (dx * i) / steps;
            cy = y + (dy * i) / steps;
            PostMessage(hwnd, msgMove, wDown, MAKELONG(cx, cy));
        }

        PostMessage(hwnd, msgUp, 0, MAKELONG(x2, y2));
        ReleaseCapture();
        write_response("OK");

    } else if (prefix(arg, "GETPOS")) {
        /* MOUSE GETPOS — returns current cursor position */
        POINT pt;
        GetCursorPos(&pt);
        wsprintf(resp_buf, "OK %d %d", pt.x, pt.y);
        write_response(resp_buf);

    } else {
        write_response("ERR UNKNOWN_COMMAND");
    }
}

/* ============================================================ */
/* CLICK — button click via WM_COMMAND                           */
/* ============================================================ */

static void cmd_click(const char *arg) {
    /* CLICK <hwnd> <id> — GetDlgItem + SendMessage WM_COMMAND BN_CLICKED */
    const char *p;
    HWND hwnd, ctrl;
    int id;

    p = skip_sp(arg);
    hwnd = (HWND)parse_hex(&p);
    p = skip_sp(p); id = parse_dec(&p);
    if (!IsWindow(hwnd)) { write_response("ERR INVALID_HWND"); return; }
    ctrl = GetDlgItem(hwnd, id);
    if (!ctrl) { write_response("ERR NOT_FOUND"); return; }
    SendMessage(hwnd, WM_COMMAND, (WPARAM)id, MAKELONG((UINT)ctrl, BN_CLICKED));
    write_response("OK");
}

/* ============================================================ */
/* MENU — menu command via WM_COMMAND                            */
/* ============================================================ */

static void cmd_menu(const char *arg) {
    /* MENU <hwnd> <id> */
    const char *p;
    HWND hwnd;
    int id;

    p = skip_sp(arg);
    hwnd = (HWND)parse_hex(&p);
    p = skip_sp(p); id = parse_dec(&p);
    if (!IsWindow(hwnd)) { write_response("ERR INVALID_HWND"); return; }

    /* Notify app to update menu state */
    {
        HMENU hMenu = GetMenu(hwnd);
        if (hMenu) {
            SendMessage(hwnd, WM_INITMENU, (WPARAM)hMenu, 0L);
        }
    }
    PostMessage(hwnd, WM_COMMAND, (WPARAM)id, 0L);
    write_response("OK");
}

/* ============================================================ */
/* FOCUS — SetFocus + BringWindowToTop                           */
/* ============================================================ */

static void cmd_focus(const char *arg) {
    const char *p;
    HWND hwnd;

    p = skip_sp(arg);
    hwnd = (HWND)parse_hex(&p);
    if (!IsWindow(hwnd)) { write_response("ERR INVALID_HWND"); return; }
    SetFocus(hwnd);
    BringWindowToTop(hwnd);
    write_response("OK");
}

/* ============================================================ */
/* SCROLL — WM_VSCROLL/WM_HSCROLL                               */
/* ============================================================ */

static void cmd_scroll(const char *arg) {
    /* SCROLL <hwnd> <dir> <n> */
    const char *p;
    HWND hwnd;
    char dir[8];
    int n, i;
    UINT msg_type;
    WPARAM wp;

    p = skip_sp(arg);
    hwnd = (HWND)parse_hex(&p);
    p = next_word(p, dir, sizeof(dir));
    p = skip_sp(p); n = parse_dec(&p);
    if (!IsWindow(hwnd)) { write_response("ERR INVALID_HWND"); return; }
    if (n <= 0) n = 1;

    if (prefix(dir, "UP")) { msg_type = WM_VSCROLL; wp = SB_LINEUP; }
    else if (prefix(dir, "DOWN")) { msg_type = WM_VSCROLL; wp = SB_LINEDOWN; }
    else if (prefix(dir, "PGUP")) { msg_type = WM_VSCROLL; wp = SB_PAGEUP; }
    else if (prefix(dir, "PGDN")) { msg_type = WM_VSCROLL; wp = SB_PAGEDOWN; }
    else if (prefix(dir, "LEFT")) { msg_type = WM_HSCROLL; wp = SB_LINELEFT; }
    else if (prefix(dir, "RIGHT")) { msg_type = WM_HSCROLL; wp = SB_LINERIGHT; }
    else { write_response("ERR SYNTAX"); return; }

    for (i = 0; i < n; i++) {
        SendMessage(hwnd, msg_type, wp, 0L);
    }
    write_response("OK");
}

/* ============================================================ */
/* CONTROL FIND — child window locator                           */
/* ============================================================ */

/* Callback data for CONTROL FIND */
static char  cf_class[64];
static char  cf_text[128];
static HWND  cf_found;

static BOOL FAR PASCAL EnumCtrlFindProc(HWND hwnd, LPARAM lParam) {
    char cls[64], text[128];
    (void)lParam;
    GetClassName(hwnd, cls, sizeof(cls));
    GetWindowText(hwnd, text, sizeof(text));

    /* Match class if specified (case-insensitive) */
    if (cf_class[0] && !prefix(cls, cf_class)) return TRUE;
    /* Match text if specified (case-insensitive substring) */
    if (cf_text[0]) {
        /* Simple case-insensitive substring: convert both to upper */
        char u_text[128], u_pattern[128];
        int ti, pi;
        for (ti = 0; text[ti] && ti < 127; ti++) {
            u_text[ti] = text[ti];
            if (u_text[ti] >= 'a' && u_text[ti] <= 'z') u_text[ti] -= 32;
        }
        u_text[ti] = '\0';
        for (pi = 0; cf_text[pi] && pi < 127; pi++) {
            u_pattern[pi] = cf_text[pi];
            if (u_pattern[pi] >= 'a' && u_pattern[pi] <= 'z') u_pattern[pi] -= 32;
        }
        u_pattern[pi] = '\0';
        if (!_fstrstr(u_text, u_pattern)) return TRUE;
    }
    cf_found = hwnd;
    return FALSE;  /* stop enumeration */
}

static void cmd_control(const char *arg) {
    /* CONTROL FIND <hwnd> <class> <text> */
    const char *p;
    HWND hwnd;

    if (prefix(arg, "FIND ")) {
        p = after(arg, 5);
        hwnd = (HWND)parse_hex(&p);
        p = next_word(p, cf_class, sizeof(cf_class));
        p = skip_sp(p);
        lstrcpyn(cf_text, p, sizeof(cf_text));
        if (!IsWindow(hwnd)) { write_response("ERR INVALID_HWND"); return; }

        /* Wildcard: * means match any */
        if (cf_class[0] == '*' && !cf_class[1]) cf_class[0] = '\0';
        if (cf_text[0] == '*' && !cf_text[1]) cf_text[0] = '\0';

        cf_found = NULL;
        EnumChildWindows(hwnd, (WNDENUMPROC)EnumCtrlFindProc, 0L);

        if (cf_found)
            wsprintf(resp_buf, "OK %04X", (UINT)cf_found);
        else
            lstrcpy(resp_buf, "ERR NOT_FOUND");
        write_response(resp_buf);
    } else {
        write_response("ERR UNKNOWN_COMMAND");
    }
}

/* ============================================================ */
/* LIST SELECT — listbox selection                               */
/* ============================================================ */

static void cmd_list(const char *arg) {
    /* LIST SELECT <hwnd> <text> */
    const char *p;
    HWND hwnd;
    const char *text;
    LRESULT result;

    if (prefix(arg, "SELECT ")) {
        p = after(arg, 7);
        hwnd = (HWND)parse_hex(&p);
        text = skip_sp(p);
        if (!IsWindow(hwnd)) { write_response("ERR INVALID_HWND"); return; }
        result = SendMessage(hwnd, LB_SELECTSTRING, (WPARAM)-1, (LPARAM)(LPCSTR)text);
        if (result == -1)
            write_response("ERR NOT_FOUND");
        else {
            wsprintf(resp_buf, "OK %ld", result);
            write_response(resp_buf);
        }
    } else {
        write_response("ERR UNKNOWN_COMMAND");
    }
}

/* ============================================================ */
/* COMBO SELECT — combobox selection                             */
/* ============================================================ */

static void cmd_combo(const char *arg) {
    /* COMBO SELECT <hwnd> <text> */
    const char *p;
    HWND hwnd;
    const char *text;
    LRESULT result;

    if (prefix(arg, "SELECT ")) {
        p = after(arg, 7);
        hwnd = (HWND)parse_hex(&p);
        text = skip_sp(p);
        if (!IsWindow(hwnd)) { write_response("ERR INVALID_HWND"); return; }
        result = SendMessage(hwnd, CB_SELECTSTRING, (WPARAM)-1, (LPARAM)(LPCSTR)text);
        if (result == -1)
            write_response("ERR NOT_FOUND");
        else {
            wsprintf(resp_buf, "OK %ld", result);
            write_response(resp_buf);
        }
    } else {
        write_response("ERR UNKNOWN_COMMAND");
    }
}

/* ============================================================ */
/* CHECK/UNCHECK — checkbox/radio button control                 */
/* ============================================================ */

static void cmd_check(const char *arg) {
    /* CHECK <hwnd> <id> */
    const char *p;
    HWND hwnd, ctrl;
    int id;

    p = skip_sp(arg);
    hwnd = (HWND)parse_hex(&p);
    p = skip_sp(p); id = parse_dec(&p);
    if (!IsWindow(hwnd)) { write_response("ERR INVALID_HWND"); return; }
    ctrl = GetDlgItem(hwnd, id);
    if (!ctrl) { write_response("ERR NOT_FOUND"); return; }
    SendMessage(ctrl, BM_SETCHECK, BST_CHECKED, 0L);
    write_response("OK");
}

static void cmd_uncheck(const char *arg) {
    /* UNCHECK <hwnd> <id> */
    const char *p;
    HWND hwnd, ctrl;
    int id;

    p = skip_sp(arg);
    hwnd = (HWND)parse_hex(&p);
    p = skip_sp(p); id = parse_dec(&p);
    if (!IsWindow(hwnd)) { write_response("ERR INVALID_HWND"); return; }
    ctrl = GetDlgItem(hwnd, id);
    if (!ctrl) { write_response("ERR NOT_FOUND"); return; }
    SendMessage(ctrl, BM_SETCHECK, BST_UNCHECKED, 0L);
    write_response("OK");
}

/* ============================================================ */
/* ABORT — dismiss foreground modal dialog                       */
/* ============================================================ */

static void cmd_abort(const char *arg) {
    /* ABORT — find foreground modal dialog (#32770), send IDCANCEL */
    HWND hwnd;
    char cls[32];
    (void)arg;

    hwnd = GetActiveWindow();
    if (!hwnd) { write_response("ERR NO_ACTIVE_WINDOW"); return; }

    GetClassName(hwnd, cls, sizeof(cls));
    if (lstrcmp(cls, "#32770") != 0) {
        /* Check if it's a modal dialog by testing if owner is disabled */
        HWND owner = GetWindow(hwnd, GW_OWNER);
        if (!owner || IsWindowEnabled(owner)) {
            write_response("ERR NO_MODAL_DIALOG");
            return;
        }
    }

    PostMessage(hwnd, WM_COMMAND, IDCANCEL, 0L);
    write_response("OK");
}

/* ============================================================ */
/* WAIT commands — poll with message pump                        */
/* ============================================================ */

/* Callback for WAIT WINDOW — substring title search */
static char  ww_title[128];
static HWND  ww_found;

static BOOL FAR PASCAL EnumWaitWndProc(HWND hwnd, LPARAM lParam) {
    char title[128];
    (void)lParam;
    GetWindowText(hwnd, title, sizeof(title));
    if (title[0] && _fstrstr(title, ww_title)) {
        ww_found = hwnd;
        return FALSE;  /* stop enumeration */
    }
    return TRUE;
}

static void cmd_wait(const char *arg) {
    const char *p;

    if (prefix(arg, "WINDOW ")) {
        /* WAIT WINDOW <title> [ms] — substring match on window titles */
        DWORD timeout_ms, start;

        p = after(arg, 7);
        p = next_word(p, ww_title, sizeof(ww_title));
        p = skip_sp(p);
        timeout_ms = (*p) ? (DWORD)parse_dec(&p) : 10000UL;
        if (!ww_title[0]) { write_response("ERR SYNTAX"); return; }

        start = GetTickCount();
        while (GetTickCount() - start < timeout_ms) {
            ww_found = NULL;
            EnumWindows((WNDENUMPROC)EnumWaitWndProc, 0L);
            if (ww_found) {
                wsprintf(resp_buf, "OK %04X", (UINT)ww_found);
                write_response(resp_buf);
                return;
            }
            pump_messages();
        }
        write_response("ERR TIMEOUT");

    } else if (prefix(arg, "GONE ")) {
        /* WAIT GONE <hwnd> [ms] */
        HWND hwnd;
        DWORD timeout_ms, start;

        p = after(arg, 5);
        hwnd = (HWND)parse_hex(&p);
        p = skip_sp(p);
        timeout_ms = (*p) ? (DWORD)parse_dec(&p) : 10000UL;

        start = GetTickCount();
        while (GetTickCount() - start < timeout_ms) {
            if (!IsWindow(hwnd)) {
                write_response("OK");
                return;
            }
            pump_messages();
        }
        write_response("ERR TIMEOUT");

    } else {
        write_response("ERR UNKNOWN_COMMAND");
    }
}

/* ============================================================ */
/* WAITFOR — poll control text until match                       */
/* ============================================================ */

static void cmd_waitfor(const char *arg) {
    /* WAITFOR <hwnd> <id> <text> [ms] */
    const char *p;
    HWND hwnd;
    int id;
    char text[256], actual[256];
    DWORD timeout_ms, start;

    p = skip_sp(arg);
    hwnd = (HWND)parse_hex(&p);
    p = skip_sp(p); id = parse_dec(&p);
    p = next_word(p, text, sizeof(text));
    p = skip_sp(p);
    timeout_ms = (*p) ? (DWORD)parse_dec(&p) : 10000UL;
    if (!IsWindow(hwnd)) { write_response("ERR INVALID_HWND"); return; }
    if (!text[0]) { write_response("ERR SYNTAX"); return; }

    start = GetTickCount();
    while (GetTickCount() - start < timeout_ms) {
        GetDlgItemText(hwnd, id, actual, sizeof(actual));
        if (lstrcmpi(actual, text) == 0) {
            write_response("OK MATCH");
            return;
        }
        pump_messages();
    }
    wsprintf(resp_buf, "OK MISMATCH:%s", (LPSTR)actual);
    write_response(resp_buf);
}

/* ============================================================ */
/* EXPECT — immediate control text check                         */
/* ============================================================ */

static void cmd_expect(const char *arg) {
    /* EXPECT <hwnd> <id> <text> */
    const char *p;
    HWND hwnd;
    int id;
    char text[256], actual[256];

    p = skip_sp(arg);
    hwnd = (HWND)parse_hex(&p);
    p = skip_sp(p); id = parse_dec(&p);
    p = skip_sp(p);
    lstrcpyn(text, p, sizeof(text));
    if (!IsWindow(hwnd)) { write_response("ERR INVALID_HWND"); return; }

    GetDlgItemText(hwnd, id, actual, sizeof(actual));
    if (lstrcmpi(actual, text) == 0) {
        write_response("OK MATCH");
    } else {
        wsprintf(resp_buf, "OK MISMATCH:%s", (LPSTR)actual);
        write_response(resp_buf);
    }
}

/* ============================================================ */
/* Hook DLL loader                                               */
/* ============================================================ */

static BOOL load_hook_dll(void) {
    if (hHookDll) return TRUE;
    hHookDll = LoadLibrary("WINMCHK.DLL");
    if ((UINT)hHookDll < 32) { hHookDll = NULL; return FALSE; }
    pfnStartRecord     = (PFNSTARTRECORD)GetProcAddress(hHookDll, "StartRecord");
    pfnStopRecord      = (PFNSTOPRECORD)GetProcAddress(hHookDll, "StopRecord");
    pfnStartPlayback   = (PFNSTARTPLAYBACK)GetProcAddress(hHookDll, "StartPlayback");
    pfnStopPlayback    = (PFNSTOPPLAYBACK)GetProcAddress(hHookDll, "StopPlayback");
    pfnGetRecordCount  = (PFNGETRECORDCOUNT)GetProcAddress(hHookDll, "GetRecordCount");
    pfnGetPlaybackState = (PFNGETPLAYBACKSTATE)GetProcAddress(hHookDll, "GetPlaybackState");
    pfnSetPlaybackSpeed = (PFNSETPLAYBACKSPEED)GetProcAddress(hHookDll, "SetPlaybackSpeed");
    pfnGetEventBuffer  = (PFNGETEVTBUF)GetProcAddress(hHookDll, "GetEventBuffer");
    pfnSetEventBuffer  = (PFNSETEVTBUF)GetProcAddress(hHookDll, "SetEventBuffer");
    pfnGetBufferCapacity = (PFNGETBUFCAP)GetProcAddress(hHookDll, "GetBufferCapacity");
    return TRUE;
}

/* ============================================================ */
/* RECORD commands — journal recording                           */
/* ============================================================ */

static void cmd_record(const char *arg) {
    if (prefix(arg, "START")) {
        if (!load_hook_dll()) { write_response("ERR DLL_NOT_FOUND"); return; }
        if (pfnStartRecord()) {
            write_response("OK");
        } else {
            write_response("ERR RECORD_FAILED");
        }

    } else if (prefix(arg, "STOP")) {
        UINT count;
        if (!hHookDll || !pfnStopRecord) { write_response("ERR NOT_RECORDING"); return; }
        count = pfnStopRecord();
        wsprintf(resp_buf, "OK %u", count);
        write_response(resp_buf);

    } else if (prefix(arg, "SAVE ")) {
        /* RECORD SAVE <file> — write event buffer to binary file */
        const char *p;
        char path[128];
        OFSTRUCT ofs;
        HFILE hf;
        void FAR *buf;
        UINT count;

        p = after(arg, 5);
        p = next_word(p, path, sizeof(path));
        if (!path[0]) { write_response("ERR SYNTAX"); return; }
        if (!hHookDll || !pfnGetEventBuffer || !pfnGetRecordCount) {
            write_response("ERR NO_DATA"); return;
        }
        count = pfnGetRecordCount();
        if (count == 0) { write_response("ERR NO_DATA"); return; }
        buf = pfnGetEventBuffer();
        hf = OpenFile(path, &ofs, OF_CREATE | OF_WRITE);
        if (hf == HFILE_ERROR) { write_response("ERR WRITE_FAILED"); return; }
        /* Write count header + event data (each event is 10 bytes) */
        _lwrite(hf, (LPSTR)&count, sizeof(UINT));
        _lwrite(hf, (LPSTR)buf, count * 10);
        _lclose(hf);
        wsprintf(resp_buf, "OK %u", count);
        write_response(resp_buf);

    } else {
        write_response("ERR UNKNOWN_COMMAND");
    }
}

/* ============================================================ */
/* PLAY commands — journal playback                              */
/* ============================================================ */

static void cmd_play(const char *arg) {
    if (prefix(arg, "STOP")) {
        if (hHookDll && pfnStopPlayback) pfnStopPlayback();
        write_response("OK");

    } else if (prefix(arg, "STATUS")) {
        if (!hHookDll || !pfnGetPlaybackState) {
            write_response("OK IDLE");
            return;
        }
        {
            UINT state = pfnGetPlaybackState();
            UINT mode = state & 0xFF;
            UINT idx = state >> 8;
            UINT count = pfnGetRecordCount ? pfnGetRecordCount() : 0;
            if (mode == 0)
                write_response("OK IDLE");
            else if (mode == 1)
                write_response("OK RECORDING");
            else {
                wsprintf(resp_buf, "OK PLAYING %u/%u", idx, count);
                write_response(resp_buf);
            }
        }

    } else {
        /* PLAY <file> [speed] — load events from file and play */
        const char *p;
        char path[128];
        OFSTRUCT ofs;
        HFILE hf;
        UINT count, speed;
        void FAR *buf;

        p = skip_sp(arg);
        p = next_word(p, path, sizeof(path));
        p = skip_sp(p);
        speed = (*p) ? (UINT)parse_dec(&p) : 100;
        if (!path[0]) { write_response("ERR SYNTAX"); return; }
        if (!load_hook_dll()) { write_response("ERR DLL_NOT_FOUND"); return; }

        /* Read event file */
        hf = OpenFile(path, &ofs, OF_READ);
        if (hf == HFILE_ERROR) { write_response("ERR NOT_FOUND"); return; }
        _lread(hf, (LPSTR)&count, sizeof(UINT));
        if (count == 0 || count > 2048) {
            _lclose(hf);
            write_response("ERR INVALID_DATA");
            return;
        }
        buf = pfnGetEventBuffer();
        _lread(hf, (LPSTR)buf, count * 10);
        _lclose(hf);

        /* Set event count via SetEventBuffer (re-copies but sets count) */
        if (pfnSetEventBuffer) pfnSetEventBuffer(buf, count);

        /* Start playback */
        if (pfnStartPlayback(speed)) {
            wsprintf(resp_buf, "OK %u", count);
            write_response(resp_buf);
        } else {
            write_response("ERR PLAY_FAILED");
        }
    }
}

/* ============================================================ */
/* Command dispatch                                              */
/* ============================================================ */

static void dispatch_command(void) {
    char *c;
    int len;
    c = cmd_buf;
    len = lstrlen(c);

    /* Strip trailing whitespace */
    while (len > 0 && (c[len-1] == '\r' || c[len-1] == '\n' || c[len-1] == ' '))
        c[--len] = '\0';

    nCmdCount++;

    if (prefix(c, "META "))     { cmd_meta(c + 5); return; }
    if (prefix(c, "PROFILE "))  { cmd_profile(c + 8); return; }
    if (prefix(c, "FILE "))     { cmd_file(c + 5); return; }
    if (prefix(c, "DIR "))      { cmd_dir(c + 4); return; }
    if (prefix(c, "TIME "))     { cmd_time(c + 5); return; }
    if (prefix(c, "ENV "))      { cmd_env(c + 4); return; }
    if (prefix(c, "EXEC "))     { cmd_exec(c + 5); return; }
    if (prefix(c, "WINDOW "))   { cmd_window(c + 7); return; }
    if (prefix(c, "TASK "))     { cmd_task(c + 5); return; }
    if (prefix(c, "GDI "))      { cmd_gdi(c + 4); return; }
    if (prefix(c, "MSG "))      { cmd_msg(c + 4); return; }
    if (prefix(c, "CLIP "))     { cmd_clip(c + 5); return; }
    if (prefix(c, "DIALOG "))   { cmd_dialog(c + 7); return; }
    if (prefix(c, "DDE "))      { cmd_dde(c + 4); return; }
    if (prefix(c, "TYPE "))     { cmd_type(c + 5); return; }
    if (prefix(c, "SENDKEYS ")) { cmd_sendkeys(c + 9); return; }
    if (prefix(c, "MOUSE "))    { cmd_mouse(c + 6); return; }
    if (prefix(c, "CLICK "))    { cmd_click(c + 6); return; }
    if (prefix(c, "MENU "))     { cmd_menu(c + 5); return; }
    if (prefix(c, "FOCUS "))    { cmd_focus(c + 6); return; }
    if (prefix(c, "SCROLL "))   { cmd_scroll(c + 7); return; }
    if (prefix(c, "CONTROL "))  { cmd_control(c + 8); return; }
    if (prefix(c, "LIST "))     { cmd_list(c + 5); return; }
    if (prefix(c, "COMBO "))    { cmd_combo(c + 6); return; }
    if (prefix(c, "CHECK "))    { cmd_check(c + 6); return; }
    if (prefix(c, "UNCHECK "))  { cmd_uncheck(c + 8); return; }
    if (prefix(c, "ABORT"))     { cmd_abort(c + 5); return; }
    if (prefix(c, "WAIT "))     { cmd_wait(c + 5); return; }
    if (prefix(c, "WAITFOR "))  { cmd_waitfor(c + 8); return; }
    if (prefix(c, "EXPECT "))   { cmd_expect(c + 7); return; }
    if (prefix(c, "RECORD "))   { cmd_record(c + 7); return; }
    if (prefix(c, "PLAY "))     { cmd_play(c + 5); return; }
    if (prefix(c, "PLAY"))      { cmd_play(c + 4); return; }

    write_response("ERR UNKNOWN_COMMAND");
}

/* ============================================================ */
/* Timer poll                                                    */
/* ============================================================ */

/* Pump messages to keep Windows responsive (used by WAIT commands) */
static void pump_messages(void) {
    MSG pmsg;
    while (PeekMessage(&pmsg, NULL, 0, 0, PM_REMOVE)) {
        TranslateMessage(&pmsg);
        DispatchMessage(&pmsg);
    }
    Yield();
}

static void poll_tx(void) {
    if (bInPoll) return;  /* re-entrancy guard */
    if (!file_exists(tx_path)) return;
    if (read_file(tx_path, cmd_buf, sizeof(cmd_buf)) <= 0) return;
    delete_file(tx_path);
    bInPoll = TRUE;
    dispatch_command();
    bInPoll = FALSE;
}

static void write_ready(void) {
    write_file(st_path, "READY", 5);
}

/* ============================================================ */
/* Window procedure                                              */
/* ============================================================ */

LONG FAR PASCAL _export WndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    switch (msg) {
    case WM_TIMER:
        if (wParam == TIMER_ID) poll_tx();
        break;
    case WM_DESTROY:
        KillTimer(hwnd, TIMER_ID);
        delete_file(st_path);
        if (ddeConv) DdeDisconnect(ddeConv);
        if (ddeInst) DdeUninitialize(ddeInst);
        if (hHookDll) { FreeLibrary(hHookDll); hHookDll = NULL; }
        PostQuitMessage(0);
        break;
    default:
        return DefWindowProc(hwnd, msg, wParam, lParam);
    }
    return 0L;
}

/* ============================================================ */
/* WinMain                                                       */
/* ============================================================ */

int PASCAL WinMain(HINSTANCE hInstance, HINSTANCE hPrev,
                   LPSTR lpCmd, int nShow) {
    WNDCLASS wc;
    MSG msg;

    (void)nShow;
    hAppInst = hInstance;

    /* Determine IPC drive letter */
    {
        char drv;
        char ini_val[8];
        drv = 'S';
        if (lpCmd && lpCmd[0] && lpCmd[1] == ':') {
            drv = lpCmd[0];
        } else {
            GetPrivateProfileString("winmcp", "drive", "S",
                ini_val, sizeof(ini_val), "WINMCP.INI");
            if (ini_val[0]) drv = ini_val[0];
        }
        if (drv >= 'a' && drv <= 'z') drv -= 32;
        tx_path[0] = drv;
        rx_path[0] = drv;
        st_path[0] = drv;
        tw_path[0] = drv;
        bmp_path[0] = drv;
        lr_path[0] = drv;
        evt_path[0] = drv;
    }

    if (!hPrev) {
        wc.style         = 0;
        wc.lpfnWndProc   = WndProc;
        wc.cbClsExtra    = 0;
        wc.cbWndExtra    = 0;
        wc.hInstance     = hInstance;
        wc.hIcon         = LoadIcon(NULL, IDI_APPLICATION);
        wc.hCursor       = LoadCursor(NULL, IDC_ARROW);
        wc.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1);
        wc.lpszMenuName  = NULL;
        wc.lpszClassName = "WinMCPClass";
        if (!RegisterClass(&wc)) return 1;
    }

    hMainWnd = CreateWindow(
        "WinMCPClass", "WIN-MCP",
        WS_OVERLAPPEDWINDOW,
        CW_USEDEFAULT, CW_USEDEFAULT, 1, 1,
        NULL, NULL, hInstance, NULL
    );
    if (!hMainWnd) return 1;

    SetTimer(hMainWnd, TIMER_ID, POLL_MS, NULL);
    write_ready();

    while (GetMessage(&msg, NULL, 0, 0)) {
        TranslateMessage(&msg);
        DispatchMessage(&msg);
    }
    return (int)msg.wParam;
}
