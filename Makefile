APP     := build/Bridgetown.app
DAEMON  := daemon/dist/bridgetown-daemon
ICON    := build/AppIcon.icns
# A stable code-signing identity keeps Keychain "Always Allow" valid across rebuilds;
# ad-hoc signatures change every build. Override with SIGN_IDENTITY="<name>".
SIGN_IDENTITY ?= Bridgetown Local Signing

.PHONY: all app daemon icon dev-app test-app mock clean

all: daemon app

# Compiled daemon binary (bun --compile), bundled into the app when present.
daemon:
	cd daemon && bun run build

# The app icon, drawn in code (scripts/app-icon.swift); redrawn only when the script changes.
icon: $(ICON)

$(ICON): scripts/app-icon.swift
	mkdir -p $(@D)
	swift scripts/app-icon.swift $@

# Release build assembled into an ad-hoc signed, menu-bar-only .app.
app: $(ICON)
	swift build -c release --package-path app
	rm -rf $(APP)
	mkdir -p $(APP)/Contents/MacOS $(APP)/Contents/Resources
	cp "$$(swift build -c release --package-path app --show-bin-path)/Bridgetown" $(APP)/Contents/MacOS/Bridgetown
	cp app/Info.plist $(APP)/Contents/Info.plist
	cp -R app/Fonts $(APP)/Contents/Resources/Fonts
	cp $(ICON) $(APP)/Contents/Resources/AppIcon.icns
	@if [ -f $(DAEMON) ]; then \
		cp $(DAEMON) $(APP)/Contents/Resources/bridgetown-daemon; \
		echo "bundled $(DAEMON)"; \
	else \
		echo "note: $(DAEMON) not found; run 'make daemon' to bundle it"; \
	fi
	@if security find-identity -v -p codesigning | grep -q "$(SIGN_IDENTITY)"; then \
		codesign --force --deep -s "$(SIGN_IDENTITY)" $(APP) && echo "signed with $(SIGN_IDENTITY)"; \
	else \
		codesign --force --deep -s - $(APP) && echo "ad-hoc signed (no '$(SIGN_IDENTITY)' identity; Keychain will ask again after each rebuild)"; \
	fi
	@echo "built $(APP)"

# Debug app attached to an already-running daemon (e.g. `make mock` in another shell).
# Pass extra flags with ARGS, e.g. make dev-app ARGS=--preview-window
dev-app:
	BRIDGETOWN_ATTACH=1 BRIDGETOWN_API_TOKEN=$${BRIDGETOWN_API_TOKEN:-dev} \
		swift run --package-path app Bridgetown $(ARGS)

# App unit tests (swift-testing). A clean Command Line Tools build doesn't find the
# swift-testing macro plugin on its own, so point the compiler at the toolchain's copy.
TESTING_PLUGINS := $(shell d="$$(dirname "$$(xcrun --find swift 2>/dev/null)")/../lib/swift/host/plugins/testing"; [ -d "$$d" ] && echo "$$d")

test-app:
	swift test --package-path app $(if $(TESTING_PLUGINS),-Xswiftc -plugin-path -Xswiftc "$(TESTING_PLUGINS)")

# The real daemon on a throwaway store with Slack, Jev, the agent and GitHub faked
# (daemon/scripts/mock/). 127.0.0.1:47621, token "dev"; BRIDGETOWN_PORT, MOCK_EXTRA=1,
# MOCK_GITHUB=blocked override. `kill -USR1 <pid>` toggles "GitHub blocked".
mock:
	cd daemon && bun scripts/mock/main.ts

clean:
	rm -rf build app/.build
