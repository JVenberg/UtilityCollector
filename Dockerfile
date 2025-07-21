# Use the official Python image.
FROM python:3.13-slim

# Set the working directory in the container.
WORKDIR /app

# Install uv for package management.
RUN pip install uv

# Install build tools and playwright system dependencies
RUN apt-get update && apt-get install -y build-essential && \
    uv pip install --system playwright && \
    playwright install --with-deps

# Set the Python path to include the 'src' directory.
ENV PYTHONPATH=/app

# Copy the project's dependency file and install dependencies.
# This is done in a separate step to leverage Docker's layer caching.
COPY pyproject.toml ./
RUN uv pip sync --system pyproject.toml

# Copy the rest of the application's source code.
COPY ./src /app/src
COPY ./alembic.ini /app/

# Set the command to run the application.
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]