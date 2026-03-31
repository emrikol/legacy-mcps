/*
 * WINMCHK.DLL — Win16 Journal Record/Playback Hook DLL
 *
 * Provides WH_JOURNALRECORD and WH_JOURNALPLAYBACK hooks for
 * recording and replaying input events in Windows 3.x.
 *
 * The data segment is marked SINGLE (shared across all instances)
 * so the event buffer is accessible from both the DLL hook procs
 * (which run in the context of the active app) and the calling EXE.
 *
 * Build: wcc -bd -bt=windows -ml -zW -s winmchk.c
 *        wlink system windows_dll name WINMCHK.DLL file winmchk.obj
 */

#include <windows.h>

/* ============================================================ */
/* Shared data segment (DATA SINGLE in .def)                     */
/* ============================================================ */

/* Event buffer — stores EVENTMSG structs with relative timestamps */
typedef struct {
    UINT  message;      /* WM_KEYDOWN, WM_MOUSEMOVE, etc. */
    UINT  paramL;       /* low param (key VK or mouse X) */
    UINT  paramH;       /* high param (scan/flags or mouse Y) */
    DWORD time;         /* timestamp (ms) */
} MCPEVENT;

#define MAX_EVENTS  2048
#define STATE_IDLE      0
#define STATE_RECORDING 1
#define STATE_PLAYING   2

static MCPEVENT  events[MAX_EVENTS];  /* ~20KB shared buffer */
static UINT      nEvents = 0;         /* events recorded */
static UINT      nPlayIdx = 0;        /* current playback index */
static UINT      nState = STATE_IDLE;
static UINT      nSpeed = 100;        /* playback speed: 100=normal */
static DWORD     dwRecordStart = 0;   /* timestamp of first recorded event */
static DWORD     dwPlayStart = 0;     /* timestamp when playback began */

static HHOOK     hRecordHook = NULL;
static HHOOK     hPlayHook = NULL;
static HINSTANCE hDllInst = NULL;

/* ============================================================ */
/* Journal Record Hook                                           */
/* ============================================================ */

LRESULT FAR PASCAL _export JournalRecordProc(int code, WPARAM wParam, LPARAM lParam) {
    if (code == HC_ACTION && nState == STATE_RECORDING) {
        EVENTMSG FAR *pEvent = (EVENTMSG FAR *)lParam;
        if (nEvents < MAX_EVENTS) {
            DWORD relTime;

            if (nEvents == 0) {
                dwRecordStart = pEvent->time;
                relTime = 0;
            } else {
                relTime = pEvent->time - dwRecordStart;
            }

            events[nEvents].message = pEvent->message;
            events[nEvents].paramL  = pEvent->paramL;
            events[nEvents].paramH  = pEvent->paramH;
            events[nEvents].time    = relTime;
            nEvents++;
        }
    }
    return CallNextHookEx(hRecordHook, code, wParam, lParam);
}

/* ============================================================ */
/* Journal Playback Hook                                         */
/* ============================================================ */

LRESULT FAR PASCAL _export JournalPlaybackProc(int code, WPARAM wParam, LPARAM lParam) {
    if (code == HC_SKIP) {
        /* Advance to next event */
        nPlayIdx++;
        if (nPlayIdx >= nEvents) {
            /* Playback complete — unhook */
            if (hPlayHook) {
                UnhookWindowsHookEx(hPlayHook);
                hPlayHook = NULL;
            }
            nState = STATE_IDLE;
        }
        return 0;
    }

    if (code == HC_GETNEXT) {
        EVENTMSG FAR *pEvent = (EVENTMSG FAR *)lParam;
        DWORD elapsed, target;

        if (nPlayIdx >= nEvents) return 0;

        /* Fill in the event to play */
        pEvent->message = events[nPlayIdx].message;
        pEvent->paramL  = events[nPlayIdx].paramL;
        pEvent->paramH  = events[nPlayIdx].paramH;

        /* Calculate when this event should fire */
        if (nSpeed == 0) nSpeed = 100;
        target = (events[nPlayIdx].time * 100) / nSpeed;
        pEvent->time = dwPlayStart + target;

        /* Return delay until this event should play (0 = now) */
        elapsed = GetTickCount() - dwPlayStart;
        if (target > elapsed)
            return (LRESULT)(target - elapsed);
        return 0;
    }

    return CallNextHookEx(hPlayHook, code, wParam, lParam);
}

/* ============================================================ */
/* Exported control functions                                    */
/* ============================================================ */

BOOL FAR PASCAL _export StartRecord(void) {
    if (nState != STATE_IDLE) return FALSE;

    nEvents = 0;
    dwRecordStart = 0;
    nState = STATE_RECORDING;

    hRecordHook = SetWindowsHookEx(WH_JOURNALRECORD,
                                    (HOOKPROC)JournalRecordProc,
                                    hDllInst, 0);
    if (!hRecordHook) {
        nState = STATE_IDLE;
        return FALSE;
    }
    return TRUE;
}

UINT FAR PASCAL _export StopRecord(void) {
    if (hRecordHook) {
        UnhookWindowsHookEx(hRecordHook);
        hRecordHook = NULL;
    }
    nState = STATE_IDLE;
    return nEvents;
}

BOOL FAR PASCAL _export StartPlayback(UINT speed) {
    if (nState != STATE_IDLE) return FALSE;
    if (nEvents == 0) return FALSE;

    nPlayIdx = 0;
    nSpeed = speed ? speed : 100;
    dwPlayStart = GetTickCount();
    nState = STATE_PLAYING;

    hPlayHook = SetWindowsHookEx(WH_JOURNALPLAYBACK,
                                  (HOOKPROC)JournalPlaybackProc,
                                  hDllInst, 0);
    if (!hPlayHook) {
        nState = STATE_IDLE;
        return FALSE;
    }
    return TRUE;
}

void FAR PASCAL _export StopPlayback(void) {
    if (hPlayHook) {
        UnhookWindowsHookEx(hPlayHook);
        hPlayHook = NULL;
    }
    nState = STATE_IDLE;
}

UINT FAR PASCAL _export GetRecordCount(void) {
    return nEvents;
}

UINT FAR PASCAL _export GetPlaybackState(void) {
    /* Returns: 0=idle, 1=recording, 2=playing */
    /* High word: current playback index (if playing) */
    return nState | (nPlayIdx << 8);
}

void FAR PASCAL _export SetPlaybackSpeed(UINT speed) {
    nSpeed = speed ? speed : 100;
}

/* Get pointer to event buffer and count — for file save/load */
MCPEVENT FAR * FAR PASCAL _export GetEventBuffer(void) {
    return events;
}

BOOL FAR PASCAL _export SetEventBuffer(MCPEVENT FAR *src, UINT count) {
    UINT i;
    if (count > MAX_EVENTS) count = MAX_EVENTS;
    for (i = 0; i < count; i++) {
        events[i] = src[i];
    }
    nEvents = count;
    return TRUE;
}

UINT FAR PASCAL _export GetBufferCapacity(void) {
    return MAX_EVENTS;
}

/* ============================================================ */
/* DLL Entry/Exit                                                */
/* ============================================================ */

int FAR PASCAL LibMain(HINSTANCE hInstance, WORD wDataSeg,
                       WORD cbHeapSize, LPSTR lpCmdLine) {
    (void)wDataSeg;
    (void)lpCmdLine;
    hDllInst = hInstance;
    if (cbHeapSize > 0)
        UnlockData(0);
    return 1;
}

int FAR PASCAL _export WEP(int nParam) {
    (void)nParam;
    /* Clean up hooks on unload */
    if (hRecordHook) {
        UnhookWindowsHookEx(hRecordHook);
        hRecordHook = NULL;
    }
    if (hPlayHook) {
        UnhookWindowsHookEx(hPlayHook);
        hPlayHook = NULL;
    }
    nState = STATE_IDLE;
    return 1;
}
