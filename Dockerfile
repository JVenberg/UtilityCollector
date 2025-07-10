# Use a modern, slim Python image
FROM python:3.13-slim

# Set the working directory in the container
WORKDIR /app

# Install uv, the Python package manager
RUN pip install uv

# Copy the dependency definition file
COPY pyproject.toml ./

# Install dependencies using uv
# This command ensures a fast and consistent installation based on our project file
RUN uv pip sync --system pyproject.toml

# Copy the rest of the application source code
COPY ./app ./app
COPY ./alembic.ini ./

# Command to run the application
# Uvicorn is the ASGI server that will run our FastAPI app.
# --host 0.0.0.0 makes it accessible from outside the container.
# --port 8000 is the standard port.
# --reload enables auto-reloading for development, can be removed for production.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]