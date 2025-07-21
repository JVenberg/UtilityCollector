import logging
from decimal import Decimal
from typing import Any
from typing import Dict
from typing import List

from sqlmodel import Session

from db import crud
from db import models
from services.bill_manager import BillManager

log = logging.getLogger(__name__)


class InvoiceService:
    def __init__(self, db: Session):
        self.db = db

    def save_split_data(self, bill_id: int, form_data: dict[str, Any]):
        """
        Saves the sub-meter readings and adjustment unit selections from the form.
        """
        log.info(f"Saving split data for bill_id: {bill_id}")

        # Clear out old readings
        crud.delete_readings_for_bill(self.db, bill_id)

        # Create new readings
        readings = self._get_submeter_readings(form_data)
        for unit_id, reading_val in readings.items():
            new_reading = models.SubMeterReading(
                bill_id=bill_id, unit_id=unit_id, reading=float(reading_val)
            )
            crud.create_sub_meter_reading(self.db, new_reading)

        # Clear old adjustment unit selections and save new ones
        parsed_adjustments = crud.get_parsed_adjustments_for_bill(self.db, bill_id)
        for adjustment in parsed_adjustments:
            if adjustment.id is not None:
                crud.delete_adjustment_unit_selections_for_adjustment(
                    self.db, adjustment.id
                )

        # Save new unit selections for adjustments
        self._save_adjustment_unit_selections(bill_id, form_data)

        bill = crud.get_bill_by_id(self.db, bill_id)
        if bill:
            bill.status = "SPLIT"
            crud.update_bill(self.db, bill)

        log.info(f"Successfully saved split data for bill {bill_id}")

    def calculate_invoices(self, bill: models.Bill) -> List[Dict[str, Any]]:
        """
        Calculates the invoice details on-the-fly.
        Returns a list of dictionaries, where each dict represents an invoice.
        """
        bill_manager = BillManager(db=self.db)
        parsed_data = bill_manager._parse_bill(bill.pdf_path)

        readings = {
            r.unit_id: Decimal(r.reading)
            for r in bill.sub_meter_readings
            if r.unit_id is not None
        }
        parsed_adjustments = bill.parsed_adjustments
        units = crud.get_all_units(self.db)
        total_sqft = sum(u.sqft for u in units)

        # Calculate base costs
        water_key = self._find_service_key(parsed_data, "Water")
        sewer_key = self._find_service_key(parsed_data, "Sewer")

        if not water_key or not sewer_key:
            return []  # Or raise an error

        total_water_usage = self._get_total_usage(parsed_data, water_key)
        total_sewer_usage = self._get_total_usage(parsed_data, sewer_key)
        water_cost_per_ccf = self._calculate_cost_per_unit(parsed_data, water_key)
        sewer_cost_per_ccf = self._calculate_cost_per_unit(parsed_data, sewer_key)

        total_submeter_usage = sum(readings.values())
        common_area_water = total_water_usage - total_submeter_usage
        common_area_sewer = total_sewer_usage
        common_area_water_cost = common_area_water * water_cost_per_ccf
        common_area_sewer_cost = common_area_sewer * sewer_cost_per_ccf

        # Build invoices
        invoices = []
        for unit in units:
            unit_reading = readings.get(unit.id, Decimal("0.0"))
            sqft_ratio = (
                Decimal(unit.sqft) / Decimal(total_sqft) if total_sqft > 0 else 0
            )

            line_items = [
                {
                    "description": "Water Usage",
                    "cost": float(unit_reading * water_cost_per_ccf),
                },
                {
                    "description": "Sewer Usage",
                    "cost": float(unit_reading * sewer_cost_per_ccf),
                },
                {
                    "description": "Common Area Water",
                    "cost": float(sqft_ratio * common_area_water_cost),
                },
                {
                    "description": "Common Area Sewer",
                    "cost": float(sqft_ratio * common_area_sewer_cost),
                },
            ]

            # Add adjustments for this unit based on unit selections
            for adj in parsed_adjustments:
                unit_selections = (
                    crud.get_adjustment_unit_selections_for_adjustment(self.db, adj.id)
                    if adj.id
                    else []
                )
                selected_units = [sel.unit_id for sel in unit_selections]

                if unit.id in selected_units:
                    # Calculate cost split among selected units
                    num_selected_units = len(selected_units)
                    adj_cost = (
                        adj.cost / num_selected_units if num_selected_units > 0 else 0
                    )
                    line_items.append(
                        {
                            "description": adj.description,
                            "cost": adj_cost,
                            "is_adjustment": True,
                        }
                    )

            total_amount = sum(item["cost"] for item in line_items)
            invoices.append(
                {"unit": unit, "total_amount": total_amount, "line_items": line_items}
            )

        return invoices

    def _get_total_usage(self, parsed_data: dict, service_name: str) -> Decimal:
        """Extracts total usage for a given service from the parsed bill data."""
        try:
            return sum(
                Decimal(str(part.get("usage", 0)))
                for part in parsed_data["services"][service_name]["parts"]
            )
        except KeyError:
            log.warning(f"Could not find usage data for service: {service_name}")
            return Decimal("0.0")

    def _get_submeter_readings(self, form_data: dict) -> dict[int, Decimal]:
        """Extracts and cleans sub-meter readings from the form."""
        readings = {}
        for key, value in form_data.items():
            if key.startswith("reading_"):
                try:
                    unit_id = int(key.split("_")[1])
                    readings[unit_id] = Decimal(str(value)) if value else Decimal("0.0")
                except (ValueError, IndexError):
                    log.warning(f"Could not parse sub-meter reading key: {key}")
        return readings

    def _calculate_cost_per_unit(self, parsed_data: dict, service_name: str) -> Decimal:
        """Calculates the average cost per unit (CCF) for a given service."""
        total_cost = Decimal(str(parsed_data["services"][service_name]["total"]))
        total_usage = self._get_total_usage(parsed_data, service_name)
        if total_usage == 0:
            return Decimal("0.0")
        return total_cost / total_usage

    def _find_service_key(self, parsed_data: dict, service_name: str) -> str | None:
        """Finds the service key in the parsed data, case-insensitively."""
        for key in parsed_data.get("services", {}).keys():
            if service_name.lower() in key.lower():
                return key
        return None

    def _get_adjustments(self, form_data: dict) -> list[dict]:
        """Extracts and cleans adjustment data from the form."""
        adjustments = []
        i = 0
        while True:
            if f"adj_desc_{i}" not in form_data:
                break

            desc = form_data.get(f"adj_desc_{i}")
            cost_str = form_data.get(f"adj_cost_{i}")
            unit_id = form_data.get(f"adj_unit_{i}")

            if desc and cost_str:
                try:
                    adjustments.append(
                        {
                            "unit_id": unit_id,
                            "description": desc,
                            "cost": float(cost_str),
                        }
                    )
                except (ValueError, TypeError):
                    log.warning(f"Could not parse adjustment at index {i}")

            i += 1
        return adjustments

    def _save_adjustment_unit_selections(self, bill_id: int, form_data: dict[str, Any]):
        """
        Saves adjustment unit selections from the form.
        Form data contains checkbox values like: adjustment_1_unit_2 = 'on'
        """
        parsed_adjustments = crud.get_parsed_adjustments_for_bill(self.db, bill_id)

        for adjustment in parsed_adjustments:
            if adjustment.id is None:
                continue

            # Look for checkbox selections for this adjustment
            for key, value in form_data.items():
                if (
                    key.startswith(f"adjustment_{adjustment.id}_unit_")
                    and value == "on"
                ):
                    try:
                        unit_id = int(key.split("_")[-1])
                        selection = models.AdjustmentUnitSelection(
                            adjustment_id=adjustment.id,
                            unit_id=unit_id,
                        )
                        crud.create_adjustment_unit_selection(self.db, selection)
                    except (ValueError, IndexError):
                        log.warning(
                            f"Could not parse adjustment unit selection key: {key}"
                        )
