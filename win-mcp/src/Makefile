# WIN-MCP Build — Open Watcom cross-compile for Win16
#
# Produces WINMCP.EXE (Win16 NE executable) and WINMCHK.DLL (hook DLL)
# Requires: Open Watcom v2 in tools/watcom/

WATCOM   = ../../tools/watcom
BINDIR   = $(WATCOM)/armo64
CC       = $(BINDIR)/wcc
LINK     = $(BINDIR)/wlink
RC       = $(BINDIR)/wrc

# Compiler flags:
#   -bt=windows  target Windows
#   -ml          large memory model (far code + far data)
#   -zW          generate Windows prolog/epilog
#   -s           remove stack overflow checks
#   -oax         optimize for speed
CFLAGS   = -bt=windows -ml -zW -s -oax -i=$(WATCOM)/h -i=$(WATCOM)/h/win

# EXE sources
EXE_SRC  = winmcp.c
EXE_OBJ  = winmcp.obj
EXE_OUT  = WINMCP.EXE

# DLL sources
DLL_SRC  = winmchk.c
DLL_OBJ  = winmchk.obj
DLL_OUT  = WINMCHK.DLL

# Where to deploy
SHARE    = ../../share
HDD      = ../../tools/win31-hdd

.PHONY: all clean deploy

all: $(EXE_OUT) $(DLL_OUT)

$(EXE_OBJ): $(EXE_SRC)
	WATCOM=$(WATCOM) $(CC) $(CFLAGS) -fo=$(EXE_OBJ) $(EXE_SRC)

$(EXE_OUT): $(EXE_OBJ)
	WATCOM=$(WATCOM) PATH="$(BINDIR):$$PATH" $(LINK) \
		system windows \
		name $(EXE_OUT) \
		file $(EXE_OBJ) \
		option map \
		option stack=8192 \
		option heap=4096 \
		library $(WATCOM)/lib286/win/toolhelp.lib \
		library $(WATCOM)/lib286/win/ddeml.lib \
		export WndProc.1

# DLL: -bd flag tells Watcom to generate DLL prolog/epilog
$(DLL_OBJ): $(DLL_SRC)
	WATCOM=$(WATCOM) $(CC) $(CFLAGS) -bd -fo=$(DLL_OBJ) $(DLL_SRC)

$(DLL_OUT): $(DLL_OBJ)
	WATCOM=$(WATCOM) PATH="$(BINDIR):$$PATH" $(LINK) \
		system windows_dll \
		name $(DLL_OUT) \
		file $(DLL_OBJ) \
		option map=$(DLL_OUT:.DLL=.map) \
		export JournalRecordProc.1 \
		export JournalPlaybackProc.2 \
		export StartRecord.3 \
		export StopRecord.4 \
		export StartPlayback.5 \
		export StopPlayback.6 \
		export GetRecordCount.7 \
		export GetPlaybackState.8 \
		export SetPlaybackSpeed.9 \
		export GetEventBuffer.10 \
		export SetEventBuffer.11 \
		export GetBufferCapacity.12 \
		export WEP.13

deploy: $(EXE_OUT) $(DLL_OUT)
	cp $(EXE_OUT) $(SHARE)/WINMCP.EXE
	cp $(DLL_OUT) $(SHARE)/WINMCHK.DLL
	cp $(EXE_OUT) $(HDD)/WINDOWS/WINMCP.EXE
	cp $(DLL_OUT) $(HDD)/WINDOWS/WINMCHK.DLL
	@echo "Deployed WINMCP.EXE + WINMCHK.DLL"

clean:
	rm -f $(EXE_OBJ) $(DLL_OBJ) $(EXE_OUT) $(DLL_OUT) *.map *.err
