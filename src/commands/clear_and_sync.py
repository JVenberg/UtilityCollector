import logging
from pathlib import Path

from sqlmodel import Session

from core.logging_config import setup_logging
from db import crud
from db.database import engine
from services.bill_manager import BillManager

log = logging.getLogger(__name__)


def clear_and_sync_bills():
    """
    Clear all bills and related data from the database, then sync all bills from the website.
    This provides a fresh start with all data pulled from the utility website.
    """
    setup_logging()
    log.info("Starting clear and sync process...")

    with Session(engine) as session:
        # Step 1: Clear all existing bills and data
        log.info("Clearing all existing bills and data from database...")
        crud.clear_all_bills_and_data(session)
        log.info("Database cleared successfully.")

        # Step 2: Remove all existing PDF files
        bills_dir = Path("data/bills")
        if bills_dir.exists():
            log.info("Removing existing PDF files...")
            for pdf_file in bills_dir.glob("*.pdf"):
                pdf_file.unlink()
                log.info(f"Removed {pdf_file.name}")
        else:
            log.info("Bills directory doesn't exist, creating it...")
            bills_dir.mkdir(parents=True, exist_ok=True)

        # Step 3: Sync all bills from the website
        log.info("Syncing all bills from utility website...")
        bill_manager = BillManager(db=session)
        bill_manager.sync_all_bills()

    log.info("Clear and sync process completed successfully!")


if __name__ == "__main__":
    clear_and_sync_bills()
