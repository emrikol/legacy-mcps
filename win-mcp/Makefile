# WIN-MCP Stub — Build & Test
#
# Targets:
#   make          - assemble WINSTUB.COM
#   make test     - assemble + run in emu2 with test harness (headless)
#   make testgui  - assemble + run in DOSBox-X with test harness (needs display)
#   make deploy   - copy to SMB share
#   make clean    - remove build artifacts
#
# Requires: nasm, node
# Optional: emu2 (headless), dosbox-x (GUI)

ASM      = nasm
AFLAGS   = -f bin -o
SRCDIR   = src
SRC      = $(SRCDIR)/stub.asm
OUT      = $(SRCDIR)/WINSTUB.COM
SHARE    = ../share
TOOLS    = ../tools
EMU2     = $(TOOLS)/emu2

# DOSBox-X (patched for ARM64 GL crash fix)
DOSBOX   = $(TOOLS)/dosbox-x
DBCONF   = dosbox-test.conf

.PHONY: all test testgui clean deploy

all: $(OUT)

$(OUT): $(SRC)
	$(ASM) $(AFLAGS) $(OUT) $(SRC)
	@echo "Built $(OUT) - $$(wc -c < $(OUT)) bytes"

deploy: $(OUT)
	cp $(OUT) $(SHARE)/WINSTUB.COM
	@echo "Deployed to $(SHARE)/WINSTUB.COM"

# Headless test using emu2 (fast, no display needed)
test: $(OUT) deploy
	@echo "Starting emu2 + WIN-MCP test harness..."
	@mkdir -p $(SHARE)/_MAGIC_
	@rm -f $(SHARE)/_MAGIC_/__win__.tx $(SHARE)/_MAGIC_/__win__.rx \
	       $(SHARE)/_MAGIC_/__win__.st $(SHARE)/_MAGIC_/__win__.tw \
	       $(SHARE)/_MAGIC_/__WIN__.TX $(SHARE)/_MAGIC_/__WIN__.RX \
	       $(SHARE)/_MAGIC_/__WIN__.ST $(SHARE)/_MAGIC_/__WIN__.TW
	EMU2_DRIVE_C=$(SRCDIR) \
	EMU2_DRIVE_Z=$(SHARE) \
	EMU2_DEFAULT_DRIVE=C \
	EMU2_CWD='C:\\' \
	$(EMU2) $(OUT) Z: & echo $$! > .emu2.pid
	@sleep 1
	node test-harness.js --timeout 30; \
	  EXIT_CODE=$$?; \
	  kill $$(cat .emu2.pid) 2>/dev/null; \
	  pkill -f 'emu2.*WINSTUB' 2>/dev/null; \
	  rm -f .emu2.pid; \
	  exit $$EXIT_CODE

# GUI test using DOSBox-X (needs display, closer to real WFW 3.11)
# Uses singleton launcher to ensure only one DOSBox-X runs at a time
testgui: $(OUT) deploy
	@echo "Starting DOSBox-X + WIN-MCP test harness..."
	@mkdir -p $(SHARE)/_MAGIC_
	@rm -f $(SHARE)/_MAGIC_/__win__.tx $(SHARE)/_MAGIC_/__win__.rx \
	       $(SHARE)/_MAGIC_/__win__.st $(SHARE)/_MAGIC_/__win__.tw \
	       $(SHARE)/_MAGIC_/__WIN__.TX $(SHARE)/_MAGIC_/__WIN__.RX \
	       $(SHARE)/_MAGIC_/__WIN__.ST $(SHARE)/_MAGIC_/__WIN__.TW
	./dosbox-run.sh $(DOSBOX) $(DBCONF)
	@sleep 3
	node test-harness.js --timeout 60; \
	  EXIT_CODE=$$?; \
	  kill -9 $$(cat .dosbox.pid) 2>/dev/null; \
	  rm -f .dosbox.pid; \
	  exit $$EXIT_CODE

# Full test: build Win16 MCP, boot Windows 3.1 in DOSBox-X, run all tests
testwin:
	@echo "Building Win16 MCP..."
	$(MAKE) -C src clean all deploy
	@echo "Starting DOSBox-X + Windows 3.1..."
	@mkdir -p $(SHARE)/_MAGIC_
	@rm -f $(SHARE)/_MAGIC_/__WIN__.TX $(SHARE)/_MAGIC_/__WIN__.RX \
	       $(SHARE)/_MAGIC_/__WIN__.ST $(SHARE)/_MAGIC_/__WIN__.BMP
	./dosbox-run.sh $(DOSBOX) dosbox-win31.conf
	@echo "Waiting for Windows 3.1 + WINMCP to boot..."
	@sleep 18
	node test-harness.js --timeout 120; \
	  EXIT_CODE=$$?; \
	  kill -9 $$(cat .dosbox.pid) 2>/dev/null; \
	  rm -f .dosbox.pid; \
	  exit $$EXIT_CODE

clean:
	rm -f $(OUT) .emu2.pid .dosbox.pid
