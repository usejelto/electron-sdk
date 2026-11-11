# ruleid: jelto-contracts-from-env-only
CONTRACTS ?= $(CURDIR)/../contracts

conformance:
	# ruleid: jelto-contracts-from-env-only
	go -C ../contracts run ./spec/conformance/runner
	# ok: jelto-contracts-from-env-only
	go -C "$(JELTO_CONTRACTS_DIR)" run ./spec/conformance/runner
