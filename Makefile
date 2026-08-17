SHELL := /usr/bin/env bash

DATA ?= gs://monaco-dev-bucket/drug-safety-signaling-demo
PORT ?= 8000
HOST ?= 127.0.0.1
IMAGE ?= drug-safety-signaling:latest

.DEFAULT_GOAL := help

.PHONY: help
help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo "  DATA=$(DATA)"

.PHONY: setup
setup: ## Check HMAC credentials and toolchain
	@bash scripts/setup.sh

.PHONY: install
install: ## Install dependencies
	bun install

.PHONY: typecheck
typecheck: ## Type-check without emitting
	bun run typecheck

.PHONY: serve
serve: ## Run against the bucket (needs HMAC credentials)
	bun run src/server.ts --data '$(DATA)' --host '$(HOST)' --port '$(PORT)'

.PHONY: serve-local
serve-local: ## Run against ./data
	bun run src/server.ts --data ./data --host '$(HOST)' --port '$(PORT)'

.PHONY: sync
sync: ## Mirror the bucket to ./data (needs HMAC credentials)
	bun run src/sync.ts --data '$(DATA)' --dest ./data

.PHONY: sync-diffs
sync-diffs: ## Mirror only label_change_diffs, skipping the large versions tables
	bun run src/sync.ts --data '$(DATA)' --dest ./data --diffs-only

.PHONY: docker-build
docker-build: ## Build the container image
	docker build -t '$(IMAGE)' .

.PHONY: docker-run
docker-run: ## Run the image against the bucket, passing HMAC credentials through
	docker run --rm -p '$(PORT):8000' \
		-e LABEL_DIFFS_HMAC_KEY_ID \
		-e LABEL_DIFFS_HMAC_SECRET \
		-e AWS_ACCESS_KEY_ID \
		-e AWS_SECRET_ACCESS_KEY \
		-e LABEL_DIFFS_DATA='$(DATA)' \
		'$(IMAGE)'

.PHONY: clean
clean: ## Remove installed dependencies
	rm -rf node_modules
