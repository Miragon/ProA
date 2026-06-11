# ProA developer commands. Run `make help` for an overview.

.PHONY: help setup db-up db-down db-reset auth-up auth-down backend backend-pg \
        frontend test test-backend test-frontend lint format build clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

setup: ## One-time setup: git hooks, frontend dependencies
	git config core.hooksPath .githooks/
	cd frontend && yarn install
	test -f frontend/.env || cp frontend/.env.example frontend/.env
	@echo ""
	@echo "Setup complete. Start developing with:"
	@echo "  make auth-up   # Keycloak on :8181 (web mode only)"
	@echo "  make backend   # Quarkus dev mode (H2 in-memory DB) on :8080"
	@echo "  make frontend  # Vite dev server on :3000"

db-up: ## Start local PostgreSQL (with fuzzystrmatch) via Docker
	docker compose up -d db
	@echo "PostgreSQL ready on localhost:5433 (user/db/password: proa)"

db-down: ## Stop local PostgreSQL
	docker compose stop db

db-reset: ## Stop local PostgreSQL and delete its data volume
	docker compose down -v

auth-up: ## Start local Keycloak (realm 'proa' auto-imported) - required for web-mode dev
	docker compose up -d keycloak
	@echo "Keycloak starting on http://localhost:8181 (admin console: admin/admin)"
	@echo "Dev logins: admin@proa.local/admin (Admin), user@proa.local/user (User)"

auth-down: ## Stop local Keycloak
	docker compose stop keycloak

backend: ## Run backend in dev mode with in-memory H2 (no Docker needed)
	cd backend && ./mvnw quarkus:dev

backend-pg: ## Run backend in dev mode against local PostgreSQL (make db-up first)
	cd backend && ./mvnw quarkus:dev -Dquarkus.profile=dev-postgres

frontend: ## Run frontend dev server (proxies /api to :8080)
	cd frontend && yarn dev

test: test-backend test-frontend ## Run all tests and checks

test-backend: ## Run backend tests (mvn verify)
	cd backend && ./mvnw verify

test-frontend: ## Run frontend lint, format check and type-checked build
	cd frontend && yarn lint:check && yarn format:check && yarn build

lint: ## Auto-fix lint issues in the frontend
	cd frontend && yarn lint

format: ## Format frontend sources with Prettier
	cd frontend && yarn format

build: ## Build the full uber jar (frontend + backend)
	./mvnw clean package

clean: ## Remove build outputs
	./mvnw clean
