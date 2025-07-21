import logging
from contextlib import asynccontextmanager
from pathlib import Path

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from core.logging_config import setup_logging
from jobs.pull_bills_job import sync_bills_job
from web.routers import bills as bills_router
from web.routers import units as units_router

# Set up logging as early as possible
setup_logging()
log = logging.getLogger(__name__)

# Initialize the scheduler
scheduler = AsyncIOScheduler()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Context manager to handle scheduler startup and shutdown.
    """
    log.info("Starting scheduler...")
    scheduler.add_job(sync_bills_job, "interval", days=1, id="sync_bills_job")
    scheduler.start()
    yield
    log.info("Shutting down scheduler...")
    scheduler.shutdown()


# Create the FastAPI app instance with the lifespan context manager
app = FastAPI(title="HOA Utility Billing System", lifespan=lifespan)

# Mount the static files directory
app.mount("/static", StaticFiles(directory=Path("src/web/static")), name="static")

# Include API routers
app.include_router(bills_router.router)
app.include_router(units_router.router)


@app.get("/")
def read_root():
    """
    Root endpoint for the application.
    """
    log.info("Root endpoint accessed.")
    return {"message": "Welcome to the HOA Utility Billing System!"}
