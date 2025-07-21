import logging

from sqlmodel import Session

from db.database import engine
from services.bill_manager import BillManager

log = logging.getLogger(__name__)


def sync_bills_job():
    """
    The job function that is called by the scheduler.
    """
    log.info("Running scheduled bill sync job...")
    # Each job run should have its own database session
    with Session(engine) as session:
        bill_manager = BillManager(db=session)
        bill_manager.sync_all_bills()
    log.info("Bill sync job finished.")
