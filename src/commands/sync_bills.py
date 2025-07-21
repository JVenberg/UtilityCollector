from core.logging_config import setup_logging
from jobs.pull_bills_job import sync_bills_job

# Set up logging so we can see the output
setup_logging()

if __name__ == "__main__":
    # Run the job directly
    sync_bills_job()
