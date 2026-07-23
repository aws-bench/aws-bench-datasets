# Build, lint, and test aws-bench-datasets.
#
# This package bundles many kinds of content — TypeScript (with a jest suite),
# CDK apps, Python scripts, shell scripts, Dockerfiles, and TOML task/scenario
# definitions. This Makefile is the single, reproducible entry point that
# validates all of them using only standard open-source tools, so you can build
# and check the repo on any clean machine.
#
# Quick start:
#   make ready      # top-level target — auto-fix, then run every check below
#   make check      # run everything: TypeScript, CDK, Python, shell, Docker, config
#   make build      # compile only: root TypeScript + CDK apps
#   make test       # all checks except the slower CDK installs
#   make help       # list every target
#
# Prerequisites: make, node/npm, uv, and docker. Linters that aren't installed
# locally are fetched on demand (ruff/ty via uv, shellcheck via uv, hadolint via
# its Docker image); run `make tools` to check your environment.
#
# Each check passes on the current tree out of the box. Thresholds and rule sets
# are tunable via pyproject.toml, .hadolint.yaml, .shellcheckrc, and the
# variables just below.

SHELL := /bin/bash
.DEFAULT_GOAL := help

# ---- tunable tool invocations ------------------------------------------------
UVX             ?= uvx
NPM             ?= npm
DOCKER          ?= docker
SHELLCHECK_SEVERITY ?= error
HADOLINT_IMAGE  ?= hadolint/hadolint:latest
# First-party Python that is meant to be maintained as source (as opposed to
# per-task/per-scenario runtime scripts that execute inside their containers
# with their own deps). ty typechecks only these paths.
PY_TYPECHECK_PATHS ?= tools

# ---- content discovery -------------------------------------------------------
PRUNE := -path '*/node_modules/*' -o -path '*/cdk.out/*' -o -path '*/dist/*'
SH_FILES     := $(shell find . \( $(PRUNE) \) -prune -o -name '*.sh' -print)
DOCKERFILES  := $(shell find . \( $(PRUNE) \) -prune -o -name 'Dockerfile*' -print | sed 's|^\./||')
CDK_APPS     := $(shell find scenarios -name cdk.json -not -path '*/node_modules/*' -not -path '*/cdk.out/*' -exec dirname {} \;)

.PHONY: help ready check build test lint fix \
        deps ts ts-build ts-test cdk \
        py py-lint py-typecheck py-fmt py-fmt-check \
        shell docker config tools clean

help: ## Show this help
	@echo "aws-bench-datasets public-tooling build"
	@echo ""
	@echo "Primary:"
	@echo "  make ready         Pre-submit: auto-fix + format Python, then run the full gate"
	@echo "  make check         Full green gate (TS + CDK + Python + shell + Docker + config)"
	@echo "  make build         Compile root TypeScript + all stable CDK apps"
	@echo "  make test          Checks only, no heavy CDK installs (jest + linters + config)"
	@echo ""
	@echo "Per content type:"
	@echo "  make ts            Root TypeScript: tsc typecheck + jest"
	@echo "  make cdk           Compile each stable scenarios/*/scenario/cdk_app (tsc)"
	@echo "  make py            Python: ruff lint + format check + ty typecheck"
	@echo "  make shell         shellcheck (severity=$(SHELLCHECK_SEVERITY))"
	@echo "  make docker        hadolint + Dockerfile license check"
	@echo "  make config        task.toml field + toolchain-pinning checks"
	@echo ""
	@echo "Utilities:"
	@echo "  make py-fmt        Apply ruff format to Python (mutates files)"
	@echo "  make py-fmt-check  Fail on ruff-format drift (also part of 'make py')"
	@echo "  make tools         Check required public tools are available"
	@echo "  make clean         Remove build artifacts"

# ---- aggregates --------------------------------------------------------------
# `ready` mirrors the aws-bench framework's `ready` target (fix -> check): the
# one-shot "get it ready to submit" command. The framework also bumps its
# dataset registry here; that step has no equivalent in this package and is
# omitted.
ready: fix check ## Pre-submit: auto-fix Python, then run the full gate

check: build test ## Full green gate

build: ts-build cdk ## Compile root TS + CDK apps

test: ts-test lint config ## All checks except heavy CDK installs

lint: py shell docker ## All linters

# Auto-fix Python the same way the framework's `fix` does: apply ruff's safe
# lint fixes, then reformat to ruff style.
fix: ## Auto-fix ruff lint findings and apply ruff formatting (mutates files)
	$(UVX) ruff check --fix .
	$(UVX) ruff format .

# ---- TypeScript (root) -------------------------------------------------------
deps: ## Install root node dependencies
	$(NPM) ci --no-audit --no-fund

ts: ts-build ts-test ## Root TypeScript typecheck + tests

ts-build: deps ## Root tsc typecheck (test suite; noEmit)
	$(NPM) run build

ts-test: deps ## Root jest suite (task.toml / reentrancy validation)
	npx jest

# ---- CDK apps ----------------------------------------------------------------
# Each stable scenario CDK app is compiled with its locally-pinned TypeScript
# (offline, no AWS credentials). `cdk synth` is intentionally NOT the gate: it
# needs account context/credentials for some constructs. Compilation is the
# reliable, hermetic correctness signal.
cdk: ## Install + tsc-compile each stable CDK app
	@set -e; for app in $(CDK_APPS); do \
		echo "=== CDK: $$app ==="; \
		( cd "$$app" && \
		  if [ -f package-lock.json ]; then $(NPM) ci --no-audit --no-fund; \
		  else $(NPM) install --no-audit --no-fund; fi && \
		  npx tsc --noEmit ); \
	done

# ---- Python ------------------------------------------------------------------
py: py-lint py-fmt-check py-typecheck ## Python lint + format check + typecheck

py-lint: ## ruff lint (rule set in pyproject.toml [tool.ruff.lint])
	$(UVX) ruff check .

py-typecheck: ## ty typecheck of maintained first-party Python
	$(UVX) ty check $(PY_TYPECHECK_PATHS)

py-fmt: ## Apply ruff format (mutates files)
	$(UVX) ruff format .

py-fmt-check: ## Fail on ruff-format drift (part of the gate)
	$(UVX) ruff format --check .

# ---- Shell -------------------------------------------------------------------
shell: ## shellcheck all shell scripts at the configured severity
	@if [ -z "$(strip $(SH_FILES))" ]; then echo "no shell scripts"; else \
		$(UVX) --from shellcheck-py shellcheck --severity=$(SHELLCHECK_SEVERITY) $(SH_FILES); \
	fi

# ---- Docker ------------------------------------------------------------------
# hadolint runs inside its official image (no local install needed). Config and
# failure-threshold live in .hadolint.yaml.
docker: ## hadolint lint
	@if [ -z "$(strip $(DOCKERFILES))" ]; then echo "no Dockerfiles"; else \
		$(DOCKER) run --rm -i -v "$$PWD":/repo -w /repo $(HADOLINT_IMAGE) hadolint $(DOCKERFILES); \
	fi

# ---- Config (task/scenario metadata) -----------------------------------------
config: ## Validate task.toml fields + verifier toolchain pinning + lockfile registries
	bash test/ci_utils/check-task-fields.sh
	bash test/ci_utils/check-toolchain-pinning.sh
	bash test/ci_utils/check-lockfile-registries.sh

# ---- Utilities ---------------------------------------------------------------
tools: ## Verify required public tools are installed
	@missing=0; \
	for t in $(NPM) npx $(UVX) $(DOCKER); do \
		if command -v $$t >/dev/null 2>&1; then echo "ok   $$t"; else echo "MISS $$t"; missing=1; fi; \
	done; \
	echo "note: ruff/ty run via '$(UVX)'; shellcheck via '$(UVX) --from shellcheck-py'; hadolint via '$(DOCKER) run $(HADOLINT_IMAGE)'; cdk via each app's local npx."; \
	exit $$missing

clean: ## Remove build artifacts
	rm -rf build coverage dist cdk.out
	find . -name '__pycache__' -type d -not -path '*/node_modules/*' -prune -exec rm -rf {} + 2>/dev/null || true
