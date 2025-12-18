FROM python:3.13-slim

# Install system dependencies for Playwright
RUN apt-get update && apt-get install -y \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install uv for faster dependency management
RUN pip install uv

# Copy dependency files first (for caching)
COPY pyproject.toml uv.lock ./

# Create fresh venv and install dependencies
RUN uv venv && uv sync --no-dev --frozen

# Install Playwright browsers
RUN uv run playwright install chromium

# Copy application code (exclude local venv and cache)
COPY main.py parser.py ./
COPY scrapers ./scrapers/

# Cloud Run uses PORT env var
ENV PORT=8080
EXPOSE 8080

CMD ["uv", "run", "gunicorn", "-b", "0.0.0.0:8080", "--timeout", "300", "main:app"]
