# DOS MCP TSR — Build & Test
#
# Targets:
#   make          - assemble DOSMCP.COM
#   make test     - assemble + run in emu2 with test harness
#   make testgui  - assemble + run in DOSBox-X with test harness (needs display)
#   make deploy   - copy DOSMCP.COM to share
#   make clean    - remove build artifacts
#
# Requires: nasm, emu2 (headless), node
# Optional: dosbox-x (GUI testing)

ASM      = nasm
AFLAGS   = -f bin -Wall -Werror -Wno-reloc-abs-word -Wno-zeroing

SRCDIR   = src
SRC      = $(SRCDIR)/dosmcp.asm
OUT      = $(SRCDIR)/DOSMCP.COM
SHARE    = ../share
TOOLS    = ../tools
EMU2     = $(TOOLS)/emu2

# DOSBox-X (patched for ARM64 GL crash fix)
DOSBOX   = $(TOOLS)/dosbox-x
DBCONF   = dosbox-test.conf

.PHONY: all test test-tsr testgui clean deploy

all: $(OUT)

$(OUT): $(SRC)
	$(ASM) $(AFLAGS) -o $(OUT) $(SRC)
	@echo "Built $(OUT) - $$(wc -c < $(OUT)) bytes"

# Copy the built COM to the share
deploy: $(OUT)
	cp $(OUT) $(SHARE)/DOSMCP.COM
	@echo "Deployed to $(SHARE)/DOSMCP.COM"

# Run automated tests in TSR mode using emu2 (headless, fast)
test: $(OUT) deploy
	@echo "Starting emu2 + test harness (TSR mode)..."
	@mkdir -p $(SHARE)/_MAGIC_
	@rm -f $(SHARE)/_MAGIC_/__mcp__.tx $(SHARE)/_MAGIC_/__mcp__.rx $(SHARE)/_MAGIC_/__mcp__.st $(SHARE)/_MAGIC_/__mcp__.tt
	@: > $(SHARE)/_MAGIC_/__mcp__.tx
	EMU2_DRIVE_C=$(SRCDIR) \
	EMU2_DRIVE_Z=$(SHARE) \
	EMU2_DEFAULT_DRIVE=C \
	EMU2_CWD='C:\\' \
	$(EMU2) $(OUT) Z: /T & echo $$! > .emu2.pid
	@sleep 2
	node test-harness.js --timeout 60; \
	  EXIT_CODE=$$?; \
	  kill $$(cat .emu2.pid) 2>/dev/null; \
	  pkill -f 'emu2.*DOSMCP' 2>/dev/null; \
	  rm -f .emu2.pid; \
	  exit $$EXIT_CODE

# Run tests with DOSBox-X GUI (needs a display)
# Uses singleton launcher to ensure only one DOSBox-X runs at a time
testgui: $(OUT) deploy
	@echo "Starting DOSBox-X + test harness..."
	@mkdir -p $(SHARE)/_MAGIC_
	@rm -f $(SHARE)/_MAGIC_/__mcp__.tx $(SHARE)/_MAGIC_/__mcp__.rx \
	       $(SHARE)/_MAGIC_/__mcp__.st $(SHARE)/_MAGIC_/__mcp__.tt \
	       $(SHARE)/_MAGIC_/__MCP__.TX $(SHARE)/_MAGIC_/__MCP__.RX \
	       $(SHARE)/_MAGIC_/__MCP__.ST $(SHARE)/_MAGIC_/__MCP__.TT
	./dosbox-run.sh $(DOSBOX) $(DBCONF)
	@sleep 3
	node test-harness.js --timeout 180; \
	  EXIT_CODE=$$?; \
	  kill -9 $$(cat .dosbox.pid) 2>/dev/null; \
	  rm -f .dosbox.pid; \
	  exit $$EXIT_CODE

clean:
	rm -f $(OUT) .emu2.pid .dosbox.pid
