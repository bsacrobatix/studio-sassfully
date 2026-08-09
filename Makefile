# Developer conveniences. The authoritative gate stays scripts/checks.sh.
EXT_DIR := packages/feedback-extension
EXT_DIST := $(abspath $(EXT_DIR)/dist)

.PHONY: help setup check ext-build ext-install

help:
	@echo "make setup        - install the mergiraf merge driver + configure git (rerere, zdiff3)"
	@echo "make check        - run the full repo gate (scripts/checks.sh)"
	@echo "make ext-build    - build the unpacked Chrome extension into $(EXT_DIR)/dist"
	@echo "make ext-install  - build, then open chrome://extensions to load/reload it"

setup:
	bash scripts/setup.sh

check:
	bash scripts/checks.sh

ext-build:
	npm --prefix $(EXT_DIR) run build

# Chrome cannot sideload an unpacked extension from the CLI; this gets you to
# one click: build, put the dist path on the clipboard, and open the
# extensions page. First time: enable Developer mode -> "Load unpacked" ->
# paste. After that, ext-build alone rebuilds in place and the reload arrow
# on the extension card picks it up.
ext-install: ext-build
	@printf '%s' '$(EXT_DIST)' | pbcopy 2>/dev/null || true
	@echo "Load unpacked from (copied to clipboard): $(EXT_DIST)"
	@open -a "Google Chrome" "chrome://extensions/" 2>/dev/null \
		|| echo "Open chrome://extensions manually (Developer mode -> Load unpacked)."
