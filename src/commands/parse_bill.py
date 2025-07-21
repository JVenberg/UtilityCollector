import argparse
import json
import logging

from sqlmodel import Session

from db.database import engine
from services.bill_manager import BillManager

# Configure logging
logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)


def main():
    """
    Parses a single utility bill PDF and prints the structured data as JSON.
    """
    parser = argparse.ArgumentParser(
        description="Parse a utility bill PDF and output the parsed data."
    )
    parser.add_argument(
        "pdf_path", type=str, help="The relative path to the bill PDF file."
    )
    args = parser.parse_args()

    log.info(f"Parsing bill: {args.pdf_path}")

    with Session(engine) as session:
        try:
            bill_manager = BillManager(session)
            parsed_data = bill_manager._parse_bill(args.pdf_path)
            print(json.dumps(parsed_data, indent=2))
            log.info("Successfully parsed bill.")
        except Exception as e:
            log.error(f"Failed to parse bill: {e}", exc_info=True)


if __name__ == "__main__":
    main()
