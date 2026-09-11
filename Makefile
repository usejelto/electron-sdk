.DEFAULT_GOAL := test
.PHONY: build test conformance package
JELTO_CONTRACTS_DIR ?=
JELTO_CONTRACTS_VERSION = $(shell python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$(JELTO_CONTRACTS_DIR)/spec/contracts/manifest.json")

node_modules: package.json package-lock.json
	npm ci
	@touch $@

build: node_modules
	npm run build

test: node_modules
	npm run check
	npm test

conformance: build
	@test -n "$(JELTO_CONTRACTS_DIR)" || { echo 'Set JELTO_CONTRACTS_DIR to a verified Jelto contracts archive.' >&2; exit 1; }
	go -C "$(JELTO_CONTRACTS_DIR)" run ./spec/conformance/runner -contracts-version "$(JELTO_CONTRACTS_VERSION)" -host "$(CURDIR)/conformance-host"

package: build
	npm pack
