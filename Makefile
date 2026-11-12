# Native Paseo builds.
#
# `make` builds the host executable. `make all` builds Linux and macOS,
# each for x86_64 and aarch64.
#
# Two submodules: paseo/ is upstream Paseo, pristine at its release tag;
# work/paseo is the working tree (branch turbopaseo of the fork), that tag plus
# our source edits, where node_modules patches apply, npm installs and scriptc
# compiles. patches/paseo/source.patch holds the same edits as a diff.
# Outputs land in builds/ and dist/. Paseo's own patches stay in paseo/patches.

ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
SRC := $(ROOT)/paseo
WORK_DIR := $(ROOT)/work
PASEO := $(WORK_DIR)/paseo
PATCH_DIR := $(ROOT)/patches
BUILD_DIR := $(ROOT)/builds
DIST_DIR := $(ROOT)/dist
# scriptc reads the tsconfig.json nearest the entry. The entry is a copy of
# native/entries/cli, placed in packages/cli/native: its tsconfig maps the
# packages that cannot run natively onto the stand-ins under native/ (ws so
# far) and leaves Paseo's own packages/cli/tsconfig.json for Node builds.
# The repo-root tsconfig pulls in the React Native app and fails unrelated files.
NATIVE_DIR := $(ROOT)/native
ENTRY_SRC := $(NATIVE_DIR)/entries/cli
COMPILE_DIR := $(PASEO)/packages/cli/native
ENTRY := index.ts

SCRIPTC ?= $(ROOT)/.scratch/scriptc-tool/node_modules/.bin/scriptc
NPM ?= npm
ZIG ?= zig
NODE ?= node

SCRIPTC_VERSION := 0.4.10

# The daemon builds for the host only. Its entry is a copy of
# native/entries/daemon in packages/server/native, with a tsconfig generated
# from tsconfig.template.json: @SCRIPTC_SHIMS@ becomes the directory of
# declaration shims inside the scriptc compiler package.
DAEMON_ENTRY_SRC := $(NATIVE_DIR)/entries/daemon
DAEMON_COMPILE_DIR := $(PASEO)/packages/server/native
SCRIPTC_SHIMS ?= $(ROOT)/.scratch/scriptc-tool/node_modules/@scriptc/cli-linux-x64-gnu/dist/lib/declarations/shims
BUN ?= bun
PATCHELF ?= patchelf
# Stand-ins that type-check against Paseo's node_modules through a symlink.
NATIVE_LINKED := claude-sdk express highlight opencode-sdk pino
OPTIMIZATION ?= release
NODE_ISLANDS ?= off

# Host triple used when SCRIPTC_TARGET is unset. Override if uname is wrong.
UNAME_S := $(shell uname -s)
UNAME_M := $(shell uname -m)
ifeq ($(UNAME_S),Linux)
  ifeq ($(UNAME_M),x86_64)
    HOST_TARGET := x86_64-linux-gnu
    HOST_NAME := linux-x64
  else ifeq ($(UNAME_M),aarch64)
    HOST_TARGET := aarch64-linux-gnu
    HOST_NAME := linux-arm64
  else ifeq ($(UNAME_M),arm64)
    HOST_TARGET := aarch64-linux-gnu
    HOST_NAME := linux-arm64
  endif
else ifeq ($(UNAME_S),Darwin)
  ifeq ($(UNAME_M),arm64)
    HOST_TARGET := aarch64-apple-darwin
    HOST_NAME := darwin-arm64
  else ifeq ($(UNAME_M),x86_64)
    HOST_TARGET := x86_64-apple-darwin
    HOST_NAME := darwin-x64
  endif
else ifneq ($(filter Windows_NT MINGW%,$(UNAME_S)),)
  HOST_TARGET := x86_64-windows-gnu
  HOST_NAME := windows-x64
endif

ifndef HOST_TARGET
  $(error unsupported host $(UNAME_S)/$(UNAME_M); set HOST_TARGET and HOST_NAME)
endif

# name|SCRIPTC_TARGET|runtime-pack-suffix|output-filename
# An empty runtime suffix means the installed compiler already carries that
# pack. Other rows need @scriptc/runtime-<suffix> plus zig.
# macOS and Linux, x86_64 and aarch64. The host row uses the runtime bundled
# with the compiler for this machine. The other three need a runtime pack and zig.
TARGETS := \
  linux-x64|x86_64-linux-gnu|-|paseo-linux-x64 \
  linux-arm64|aarch64-linux-gnu|linux-arm64-gnu|paseo-linux-arm64 \
  darwin-x64|x86_64-apple-darwin|darwin-x64|paseo-darwin-x64 \
  darwin-arm64|aarch64-apple-darwin|darwin-arm64|paseo-darwin-arm64

fields = $(subst |, ,$(1))
TARGET_NAMES := $(foreach row,$(TARGETS),$(word 1,$(call fields,$(row))))

.PHONY: help host all daemon daemon-prep tp dist$(TARGET_NAMES) FORCE work source-patches source-patch patches paseo-build paseo-deps paseo-check clean distclean list

host: $(HOST_NAME)

help:
	@echo "host binary:  $(HOST_NAME)  ($(HOST_TARGET))"
	@echo "entry:        $(COMPILE_DIR)/$(ENTRY)"
	@echo "output dir:   $(BUILD_DIR)"
	@echo
	@echo "make                  host executable ($(BUILD_DIR)/paseo-$(HOST_NAME)*)"
	@echo "make all              every executable target"
	@echo "make <name>           one target (make list)"
	@echo "make daemon           host daemon ($(BUILD_DIR)/paseo-daemon-$(HOST_NAME), with lib/ and assets/ beside it)"
	@echo "make tp               install manager ($(BUILD_DIR)/tp-$(HOST_NAME))"
	@echo "make dist             $(DIST_DIR)/$(DIST_NAME).tar.gz and tp-$(HOST_NAME), each with a .sha256"
	@echo "make work             export the paseo submodule into $(PASEO)"
	@echo "make source-patches   apply $(PATCH_DIR)/paseo onto $(PASEO)"
	@echo "make patches          apply $(PATCH_DIR) onto $(PASEO)/node_modules"
	@echo "make source-patch     regenerate $(PATCH_DIR)/paseo/source.patch from $(PASEO)"
	@echo "make paseo-deps       npm install the work tree and build its packages"
	@echo "make paseo-build      rebuild the workspace packages and server dist/ (native builds run it)"
	@echo "make paseo-check      Paseo's own typecheck and build on the patched tree, then the JS CLI under node"
	@echo "make clean            delete the executables in $(BUILD_DIR)"
	@echo "make distclean        also delete the work tree's node_modules and build output"
	@echo
	@echo "OPTIMIZATION=$(OPTIMIZATION)  NODE_ISLANDS=$(NODE_ISLANDS)  SCRIPTC=$(SCRIPTC)"

list:
	@printf '%-24s %-28s %s\n' NAME TARGET OUTPUT
	@$(foreach row,$(TARGETS),printf '%-24s %-28s %s\n' '$(word 1,$(call fields,$(row)))' '$(word 2,$(call fields,$(row)))' '$(word 4,$(call fields,$(row)))';)

all: $(TARGET_NAMES)

# The working tree is the work/paseo submodule. Its branch starts at the commit
# paseo/ is pinned to, so `git -C $(PASEO) diff $$(git -C $(SRC) rev-parse HEAD)`
# shows every source edit, committed or not.
work: $(PASEO)/package.json

$(PASEO)/package.json:
	@test -z "$$(git -C $(SRC) status --porcelain)" || { echo '$(SRC) has local changes; make them in $(PASEO)' >&2; exit 1; }
	git -C $(ROOT) submodule update --init work/paseo

# $(call apply_patches,<dir>) applies each <dir>/*.patch onto $(PASEO) with -p1.
# A patch whose reverse applies cleanly is already in the tree and is skipped.
# Any other failure stops make. The check uses --force: --batch assumes a
# reversed-looking patch is reversed, so it passes on an unpatched tree too.
define apply_patches
@set -e; \
for patch in $(1)/*.patch; do \
  test -e "$$patch" || continue; \
  if (cd $(PASEO) && patch --force --reverse --dry-run --silent -p1 -i "$$patch" >/dev/null 2>&1); then \
    echo "already applied $$patch"; \
  else \
    echo "patch $$patch"; \
    (cd $(PASEO) && patch --batch --forward --silent -p1 -i "$$patch"); \
  fi; \
done
endef

# Our edits to Paseo source, applied before npm install because they change
# package.json dependencies.
source-patches: work
	$(call apply_patches,$(PATCH_DIR)/paseo)

# Regenerates the source patch: the work tree against the commit paseo/ is
# pinned to. New files are marked intent-to-add so the diff includes them. The
# native entry directories make writes are ignored by the branch's .gitignore.
source-patch:
	cd $(PASEO) && git add -N -- .
	cd $(PASEO) && git diff $$(git -C $(SRC) rev-parse HEAD) -- . ':!package-lock.json' > $(PATCH_DIR)/paseo/source.patch
	@echo "wrote $(PATCH_DIR)/paseo/source.patch"

# Our node_modules patches. paseo/patches is applied by paseo's own postinstall
# script, which paseo-deps runs by name because the install skips lifecycle scripts.
patches:
	@test -d $(PASEO)/node_modules || { echo 'run make paseo-deps first' >&2; exit 1; }
	$(call apply_patches,$(PATCH_DIR))

paseo-deps: source-patches
	cd $(PASEO) && $(NPM) install --ignore-scripts --no-audit --no-fund
	cd $(PASEO) && $(NPM) run postinstall
	$(MAKE) patches
	$(MAKE) paseo-build

# The workspace packages scriptc compiles from their dist/ JavaScript, and the
# server, whose build output holds the daemon's runtime files. Native builds run
# this first so dist/ matches the patched source.
paseo-build:
	cd $(PASEO) && $(NPM) run build --workspace=@getpaseo/protocol
	cd $(PASEO) && $(NPM) run build --workspace=@getpaseo/relay
	cd $(PASEO) && $(NPM) run build --workspace=@getpaseo/client
	cd $(PASEO) && $(NPM) run build --workspace=@getpaseo/highlight
	cd $(PASEO) && $(NPM) run build --workspace=@getpaseo/plugin
	cd $(PASEO) && $(NPM) run build --workspace=@getpaseo/server

# The patched tree must still build and run as normal Paseo under Node.
paseo-check: source-patches patches
	cd $(PASEO) && $(NPM) run typecheck:server
	cd $(PASEO) && $(NPM) run build:server
	cd $(PASEO) && $(NODE) packages/cli/bin/paseo --help | grep -q '^Usage: paseo '
	cd $(PASEO) && test "$$($(NODE) packages/cli/bin/paseo --version)" = "$$($(NODE) -p 'require("./packages/cli/package.json").version')"
	@echo 'paseo-check: typecheck, build, node CLI --help and --version passed'

FORCE:

define compile_target
$(word 1,$(call fields,$(1))): $(BUILD_DIR)/$(word 4,$(call fields,$(1)))

# Always invoked: scriptc keeps its own build cache and decides what is stale.
$(BUILD_DIR)/$(word 4,$(call fields,$(1))): FORCE paseo-build
	@mkdir -p $(BUILD_DIR) $(COMPILE_DIR)
	cp $(ENTRY_SRC)/index.ts $(ENTRY_SRC)/tsconfig.json $(COMPILE_DIR)/
	@test -x "$$$$(command -v $(SCRIPTC))" || { echo 'scriptc is not on PATH; set SCRIPTC=' >&2; exit 1; }
	$$(if $(filter-out -,$(word 3,$(call fields,$(1)))), \
	  test -d $(PASEO)/node_modules/@scriptc/runtime-$(word 3,$(call fields,$(1))) || { \
	    echo 'missing @scriptc/runtime-$(word 3,$(call fields,$(1)))@$(SCRIPTC_VERSION)' >&2; \
	    echo '  cd work/paseo && npm install --save-dev @scriptc/runtime-$(word 3,$(call fields,$(1)))@$(SCRIPTC_VERSION)' >&2; \
	    exit 1; }; \
	  test -x "$$$$(command -v $(ZIG))" || { echo 'zig is required to link $(word 2,$(call fields,$(1)))' >&2; exit 1; }; \
	)
	cd $(COMPILE_DIR) && SCRIPTC_TARGET='$(word 2,$(call fields,$(1)))' \
	  $(SCRIPTC) build $(ENTRY) \
	    -o $(BUILD_DIR)/$(word 4,$(call fields,$(1))) \
	    --optimization $(OPTIMIZATION) \
	    --no-keep-llvm \
	    --node-islands=$(NODE_ISLANDS)
endef

$(foreach row,$(TARGETS),$(eval $(call compile_target,$(row))))

# Everything the daemon compile reads besides Paseo itself: the symlinks the
# stand-ins resolve packages through, the two C shims, the Claude SDK
# declaration copies, the entry files, and one FFI manifest (scriptc takes one
# --ffi; scripts/merge-ffi.ts joins the pty and sherpa manifests).
daemon-prep: paseo-build
	@test -d $(PASEO)/node_modules || { echo 'run make paseo-deps first' >&2; exit 1; }
	@test -f $(SCRIPTC_SHIMS)/hono-node-server/v2.ts || { echo 'SCRIPTC_SHIMS=$(SCRIPTC_SHIMS) has no hono-node-server/v2.ts' >&2; exit 1; }
	@set -e; for name in $(NATIVE_LINKED); do ln -sfn ../../work/paseo/node_modules $(NATIVE_DIR)/$$name/node_modules; done
	ln -sfn ../../work/paseo/packages/highlight/src $(NATIVE_DIR)/highlight/paseo-src
	$(NATIVE_DIR)/pty/build.sh
	$(NATIVE_DIR)/sherpa/build.sh
	$(NATIVE_DIR)/claude-sdk/sync-types.sh
	$(NATIVE_DIR)/opencode-sdk/sync-types.sh
	@mkdir -p $(DAEMON_COMPILE_DIR)
	cp $(DAEMON_ENTRY_SRC)/index.ts $(NATIVE_DIR)/sherpa/speech-worker.ts $(DAEMON_COMPILE_DIR)/
	sed 's#@SCRIPTC_SHIMS@#$(SCRIPTC_SHIMS)#' $(DAEMON_ENTRY_SRC)/tsconfig.template.json > $(DAEMON_COMPILE_DIR)/tsconfig.json
	$(BUN) $(ROOT)/scripts/merge-ffi.ts $(DAEMON_COMPILE_DIR)/ffi.json $(NATIVE_DIR)/pty/ffi.json $(NATIVE_DIR)/sherpa/ffi.json

daemon: $(BUILD_DIR)/paseo-daemon-$(HOST_NAME)

# tp, the install manager (tp/index.ts): one file, no runtime files beside it.
tp: $(BUILD_DIR)/tp-$(HOST_NAME)

$(BUILD_DIR)/tp-$(HOST_NAME): FORCE
	cd $(ROOT)/tp && $(SCRIPTC) build index.ts \
	    -o $@ \
	    --optimization $(OPTIMIZATION) \
	    --no-keep-llvm \
	    --node-islands=$(NODE_ISLANDS)

# A native daemon reads its runtime files from its own directory, never from
# the build tree (import.meta.url is a build-machine path in a native binary):
#   icudt78l.dat     ICU data, written by scriptc beside the binary
#   lib/             sherpa-onnx libraries, found through RUNPATH $$ORIGIN/lib
#   assets/          the voice activity model
#   builtin-plugins/ skills/ shell-integration/ opencode/
#                    copied from Paseo's own server build output, with its filters
DAEMON_RUNTIME := icudt78l.dat lib assets builtin-plugins skills shell-integration opencode
SERVER_DIST := $(PASEO)/packages/server/dist/server
OPENCODE_DIST := $(SERVER_DIST)/server/agent/providers/opencode

$(BUILD_DIR)/paseo-daemon-$(HOST_NAME): FORCE daemon-prep
	cd $(DAEMON_COMPILE_DIR) && $(SCRIPTC) build index.ts \
	    --ffi ffi.json \
	    -o $@ \
	    --optimization $(OPTIMIZATION) \
	    --no-keep-llvm \
	    --node-islands=$(NODE_ISLANDS)
	$(PATCHELF) --set-rpath '$$ORIGIN/lib' $@
	rm -rf $(addprefix $(BUILD_DIR)/,$(filter-out icudt78l.dat,$(DAEMON_RUNTIME)))
	mkdir -p $(BUILD_DIR)/lib $(BUILD_DIR)/assets $(BUILD_DIR)/opencode/v2
	cp $(NATIVE_DIR)/sherpa/build/lib/libsherpa-onnx-c-api.so $(NATIVE_DIR)/sherpa/build/lib/libonnxruntime.so $(BUILD_DIR)/lib/
	cp $(PASEO)/packages/server/src/server/speech/providers/local/sherpa/assets/silero_vad.onnx $(BUILD_DIR)/assets/
	cp -r $(SERVER_DIST)/builtin-plugins $(SERVER_DIST)/skills $(BUILD_DIR)/
	cp -r $(SERVER_DIST)/terminal/shell-integration $(BUILD_DIR)/
	cp $(OPENCODE_DIST)/bridge-plugin.bundle.mjs $(BUILD_DIR)/opencode/
	cp $(OPENCODE_DIST)/v2/bridge-plugin.bundle.mjs $(OPENCODE_DIST)/v2/state.mjs $(BUILD_DIR)/opencode/v2/

# One relocatable directory: the CLI as paseo, the daemon as paseo-daemon
# (the native CLI starts the paseo-daemon beside it), DAEMON_RUNTIME and
# Paseo's LICENSE; then a tarball of it and its SHA-256 sum.
# The programs build one after another: a release build of the CLI alone
# peaks above 60 GB in its LLVM step.
PASEO_VERSION := $(shell sed -n 's/^  "version": "\(.*\)",$$/\1/p' $(SRC)/package.json)
DIST_NAME := paseo-$(PASEO_VERSION)-$(HOST_NAME)
dist:
	$(MAKE) $(HOST_NAME) daemon tp
	rm -rf $(DIST_DIR)/$(DIST_NAME) $(DIST_DIR)/$(DIST_NAME).tar.gz $(DIST_DIR)/$(DIST_NAME).tar.gz.sha256
	cp $(BUILD_DIR)/tp-$(HOST_NAME) $(DIST_DIR)/
	cd $(DIST_DIR) && sha256sum tp-$(HOST_NAME) > tp-$(HOST_NAME).sha256
	mkdir -p $(DIST_DIR)/$(DIST_NAME)
	cp $(BUILD_DIR)/paseo-$(HOST_NAME) $(DIST_DIR)/$(DIST_NAME)/paseo
	cp $(BUILD_DIR)/paseo-daemon-$(HOST_NAME) $(DIST_DIR)/$(DIST_NAME)/paseo-daemon
	cp -r $(addprefix $(BUILD_DIR)/,$(DAEMON_RUNTIME)) $(DIST_DIR)/$(DIST_NAME)/
	cp $(SRC)/LICENSE $(DIST_DIR)/$(DIST_NAME)/
	tar -C $(DIST_DIR) --owner=0 --group=0 --numeric-owner -czf $(DIST_DIR)/$(DIST_NAME).tar.gz $(DIST_NAME)
	cd $(DIST_DIR) && sha256sum $(DIST_NAME).tar.gz > $(DIST_NAME).tar.gz.sha256
	@echo "dist: $(DIST_DIR)/$(DIST_NAME).tar.gz"

clean:
	rm -f $(foreach row,$(TARGETS),$(BUILD_DIR)/$(word 4,$(call fields,$(row)))) $(BUILD_DIR)/paseo-daemon-$(HOST_NAME)
	rm -rf $(addprefix $(BUILD_DIR)/,$(DAEMON_RUNTIME)) $(DIST_DIR)

# Removes the work tree's ignored build state (node_modules, dist/) only; the
# submodule's tracked and untracked source stays.
distclean: clean
	git -C $(PASEO) clean -fdqX
