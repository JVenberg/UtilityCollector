"""
Bill PDF Parser

Extracts structured data from Seattle Utilities bill PDFs.
Adapted from the original bill_manager.py parsing logic.
"""

import itertools
import logging
import math
import re
from functools import partial
from typing import Any
from typing import Dict

from PyPDF2 import PdfReader

log = logging.getLogger(__name__)

# --- Regex Patterns ---

HEADER_REGEX = r"DUE DATE: (?P<due_date>[A-Za-z]+ \d{2}, \d{4})(?:.|\n)*Current billing: (?P<total>\d+\.\d{2})"
SERVICE_REGEX = (
    r"(?P<service>[A-Za-z ]+)(?P<bill>(?:.|\n)+?)Current \1: (?P<total>\d+\.\d{2})"
)
USAGE_REGEX = r"(?P<start_date>\w{3} \d{2}, \d{4}) (?P<end_date>\w{3} \d{2}, \d{4}) (?P<usage>\d+.\d{2})\*?(?: (?P<start_meter>\d+.\d{2})\*? (?P<end_meter>\d+.\d{2})\*?)?"
METER_REGEX = r"Meter Number: (?P<meter_number>[\w-]+) Service Category: ?(?P<service_category>\w*)"
ITEM_REGEX = r"^(?:(?P<start>\w{3} \d{2}, \d{4}) (?P<end>\w{3} \d{2}, \d{4}) *)?(?P<description>.+?)\s*(?:(?P<date>\w{3} \d{2}, \d{4}) *)?(?:(?P<usage>\d+\.\d{2}) CCF @ \$(?P<rate>\d+.\d{2}) per CCF )?(?P<cost>\d+\.\d{2})"
TRASH_REGEX = r"^(?P<count>\d+)-(?P<description>[\w /]+) (?P<size>\d+) Gal"


class BillParser:
    """Parses Seattle Utilities bill PDFs into structured data."""

    def parse(self, file_path: str) -> Dict[str, Any]:
        """
        Parse a bill PDF file and return structured data.

        Args:
            file_path: Path to the PDF file

        Returns:
            Dictionary with parsed bill data including:
            - due_date: str
            - total: float
            - services: dict of service data
        """
        reader = PdfReader(file_path)

        # Parse header from first page
        header: list[dict[str, Any]] = []
        reader.pages[0].extract_text(visitor_text=partial(self._visitor_body, header))
        header_text = "\n".join([part["text"].strip() for part in header])

        # Parse body from remaining pages
        body: list[dict[str, Any]] = []
        for page in reader.pages[1:]:
            page.extract_text(visitor_text=partial(self._visitor_body, body))
        body_text = "\n".join([part["text"].strip() for part in body])

        parsed_data = {
            **self._parse_header(header_text),
            "services": self._parse_services(body_text),
        }

        self._validate_bill(parsed_data)
        return parsed_data

    def _visitor_body(self, parts, text, _cm, tm, font_dict, _font_size):
        """PDF text extraction visitor function."""
        size, x, y = tm[3], tm[4], tm[5]
        font_name = font_dict["/BaseFont"].split("+")[-1] if font_dict else None
        if x > 240 and (font_name == "Arial-BoldMT" or font_name == "ArialMT"):
            parts.append(
                {
                    "text": text.replace("O00934", ""),
                    "font": font_name,
                    "size": size,
                    "x": x,
                    "y": y,
                }
            )

    def _parse_header(self, header_str: str) -> Dict[str, Any]:
        """Parse bill header to extract due date and total."""
        match = re.search(HEADER_REGEX, header_str)
        if not match:
            raise ValueError("Could not parse bill header.")
        return {
            "due_date": match.group("due_date"),
            "total": float(match.group("total")),
        }

    def _parse_services(self, bill_str: str) -> Dict[str, Any]:
        """Parse all services from the bill body."""
        services = {}
        for match in re.finditer(SERVICE_REGEX, bill_str):
            services[match.group("service")] = {
                "total": float(match.group("total")),
                "parts": self._parse_service_bill(match.group("bill")),
            }
        return services

    def _parse_service_bill(self, bill_str: str) -> list:
        """Parse individual service billing details."""
        groups = []
        splits = re.split(USAGE_REGEX, bill_str)

        if len(splits) > 1:
            for meter_group in itertools.batched(splits[1:], 6):
                start_date, end_date, usage, start_meter, end_meter, items_str = (
                    meter_group
                )
                groups.append(
                    {
                        "items": self._parse_items(items_str),
                        "start_date": start_date,
                        "end_date": end_date,
                        "usage": float(usage),
                        **({"start_meter": float(start_meter)} if start_meter else {}),
                        **({"end_meter": float(end_meter)} if end_meter else {}),
                        **self._parse_meter(items_str),
                    }
                )
        else:
            items_str = splits[0]
            groups.append(
                {"items": self._parse_items(items_str), **self._parse_meter(items_str)}
            )

        return groups

    def _parse_items(self, bill_str: str) -> list:
        """Parse line items from a service section."""
        items = []
        for match in re.finditer(ITEM_REGEX, bill_str, re.MULTILINE):
            items.append(
                self._parse_trash(
                    {
                        "description": match.group("description")
                        .replace("\n", " ")
                        .strip(),
                        "cost": float(match.group("cost")),
                        **(
                            {"start": match.group("start")}
                            if match.group("start")
                            else {}
                        ),
                        **({"end": match.group("end")} if match.group("end") else {}),
                        **(
                            {"date": match.group("date")} if match.group("date") else {}
                        ),
                        **(
                            {"usage": float(match.group("usage"))}
                            if match.group("usage")
                            else {}
                        ),
                        **(
                            {"rate": float(match.group("rate"))}
                            if match.group("rate")
                            else {}
                        ),
                    }
                )
            )
        return items

    def _parse_trash(self, item: Dict[str, Any]) -> Dict[str, Any]:
        """Parse trash service details from description."""
        match = re.search(TRASH_REGEX, item["description"])
        if match:
            return {
                **item,
                "description": match.group("description").strip(),
                "size": int(match.group("size")),
                "count": int(match.group("count")),
            }
        return item

    def _parse_meter(self, bill_str: str) -> Dict[str, str]:
        """Parse meter information if present."""
        meter = re.search(METER_REGEX, bill_str)
        if meter:
            return {
                "meter_number": meter.group("meter_number"),
                "service_category": meter.group("service_category"),
            }
        return {}

    def _validate_bill(self, bill: Dict[str, Any]):
        """Validate parsed bill data for consistency."""
        bill_total = sum(
            service_data["total"] for service, service_data in bill["services"].items()
        )

        # Warn instead of crash - bill format may vary slightly
        if not math.isclose(bill_total, bill["total"], rel_tol=0.05):
            log.warning(
                f"Bill total mismatch: services sum to {bill_total}, header says {bill['total']}"
            )

        for service, service_data in bill["services"].items():
            service_total = sum(
                item["cost"] for part in service_data["parts"] for item in part["items"]
            )

            # For adjustments, log parsing issues but don't crash
            if "adjustment" in service.lower():
                if not math.isclose(service_total, service_data["total"]):
                    items_found = [
                        f"{item['description']}: ${item['cost']}"
                        for part in service_data["parts"]
                        for item in part["items"]
                    ]
                    log.warning(
                        f"Adjustment parsing incomplete for {service}: "
                        f"Found {len(items_found)} items totaling ${service_total}, "
                        f"but bill shows ${service_data['total']}. "
                        f"Items found: {items_found}."
                    )
            else:
                assert math.isclose(
                    service_total, service_data["total"]
                ), f"Service total mismatch {service}: {service_total} != {service_data['total']}"
