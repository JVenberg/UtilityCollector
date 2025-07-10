import logging
from pathlib import Path

from sqlmodel import Session

from app.core.logging_config import setup_logging
from app.db import crud
from app.db import models
from app.db.database import engine
from app.services.bill_manager import BillManager

log = logging.getLogger(__name__)


def reprocess_all_bills():
    """
    Re-process all PDF bills in the bills/ directory.
    This will parse them and save any adjustments that weren't captured before.
    """
    setup_logging()
    log.info("Starting reprocessing of all bills...")

    bills_dir = Path("bills")
    if not bills_dir.exists():
        log.error("Bills directory not found!")
        return

    pdf_files = list(bills_dir.glob("*.pdf"))
    log.info(f"Found {len(pdf_files)} PDF files to process")

    with Session(engine) as session:
        bill_manager = BillManager(db=session)

        for pdf_file in pdf_files:
            log.info(f"Processing {pdf_file.name}...")

            # Check if bill already exists in database
            existing_bill = crud.get_bill_by_pdf_path(session, str(pdf_file))
            if existing_bill:
                log.info(
                    f"Bill {pdf_file.name} already exists in database. Checking for adjustments..."
                )

                # Check if this bill already has parsed adjustments
                if existing_bill.id is None:
                    log.error(f"Bill {pdf_file.name} has no ID. Skipping.")
                    continue
                existing_adjustments = crud.get_parsed_adjustments_for_bill(
                    session, existing_bill.id
                )
                if existing_adjustments:
                    log.info(
                        f"Bill {pdf_file.name} already has {len(existing_adjustments)} parsed adjustments. Skipping."
                    )
                    continue
                else:
                    log.info(
                        f"Bill {pdf_file.name} has no parsed adjustments. Re-parsing..."
                    )
                    # Parse and save adjustments for existing bill
                    try:
                        parsed_data = bill_manager._parse_bill(str(pdf_file))
                        bill_manager._save_parsed_adjustments(
                            existing_bill, parsed_data
                        )
                        log.info(f"Successfully parsed adjustments for {pdf_file.name}")
                    except Exception as e:
                        log.error(f"Error parsing {pdf_file.name}: {e}")
            else:
                log.info(
                    f"Bill {pdf_file.name} not in database. Creating new bill record..."
                )
                try:
                    # Parse the bill to extract data
                    parsed_data = bill_manager._parse_bill(str(pdf_file))

                    # Extract bill date from filename or parsed data
                    bill_date = parsed_data.get(
                        "bill_date",
                        pdf_file.stem.replace("utility_bill_", "").replace("-", "/"),
                    )

                    # Create new bill record
                    new_bill = models.Bill(
                        bill_date=bill_date,
                        due_date=parsed_data["due_date"],
                        total_amount=parsed_data["total"],
                        pdf_path=str(pdf_file),
                        status="NEW",
                    )

                    created_bill = crud.create_bill(session, new_bill)

                    # Save parsed adjustments
                    bill_manager._save_parsed_adjustments(created_bill, parsed_data)

                    log.info(f"Successfully created bill record for {pdf_file.name}")

                except Exception as e:
                    log.error(f"Error processing {pdf_file.name}: {e}")

    log.info("Finished reprocessing all bills.")


if __name__ == "__main__":
    reprocess_all_bills()
