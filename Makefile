# Makefile for HOA Utility Billing System

.PHONY: help build up down logs format revision migrate

help:
	@echo "Commands:"
	@echo "  build         : Build the docker images for the project."
	@echo "  up            : Start the services using docker-compose."
	@echo "  down          : Stop the services."
	@echo "  logs          : Follow the application logs."
	@echo "  format        : Format the code using black and isort."
	@echo "  revision      : Create a new alembic database migration."
	@echo "  migrate       : Apply database migrations."

build:
	docker-compose build

up:
	docker-compose up -d

down:
	docker-compose down

logs:
	docker-compose logs -f app

format:
	uv run black .
	uv run isort .

revision:
	@read -p "Enter a description for the new revision: " description; \
	docker-compose run --rm app alembic revision --autogenerate -m "$$description"

migrate:
	docker-compose run --rm app alembic upgrade head