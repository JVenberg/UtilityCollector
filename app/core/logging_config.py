import logging
import sys
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path

from app.core.config import settings


def setup_logging():
    """
    Configures the logging for the application.
    """
    log_dir = Path("data/logs")
    log_dir.mkdir(exist_ok=True)
    log_file = log_dir / "app.log"

    # Define the format for the log messages
    formatter = logging.Formatter(
        "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
    )

    # Create a handler that rotates log files daily, keeping 30 days of history
    # This will create files like app.log.2025-06-19
    file_handler = TimedRotatingFileHandler(
        log_file, when="midnight", interval=1, backupCount=30
    )
    file_handler.setFormatter(formatter)

    # Create a handler to also print logs to the console
    stream_handler = logging.StreamHandler(sys.stdout)
    stream_handler.setFormatter(formatter)

    # Get the root logger and add the handlers
    logger = logging.getLogger()
    logger.setLevel(settings.LOG_LEVEL.upper())

    # Avoid adding handlers multiple times if this function is called more than once
    if not logger.handlers:
        logger.addHandler(file_handler)
        logger.addHandler(stream_handler)

    logging.info("Logging configured.")
