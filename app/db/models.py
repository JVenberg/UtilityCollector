from typing import List
from typing import Optional

from sqlmodel import Field
from sqlmodel import Relationship
from sqlmodel import SQLModel


class Unit(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(unique=True)  # e.g., "Unit 401"
    sqft: int
    submeter_id: str
    email: str

    trash_cans: List["TrashCan"] = Relationship(back_populates="unit")


class TrashCan(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    service_type: str  # "Garbage", "Recycle", etc.
    size: int  # in Gallons

    unit_id: int = Field(foreign_key="unit.id")
    unit: "Unit" = Relationship(back_populates="trash_cans")


class Bill(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    bill_date: str  # The date of the bill document
    due_date: str
    total_amount: float
    pdf_path: str = Field(unique=True)
    status: str  # e.g., "NEW", "PROCESSING", "INVOICED", "PAID"

    sub_meter_readings: List["SubMeterReading"] = Relationship(back_populates="bill")
    parsed_adjustments: List["ParsedAdjustment"] = Relationship(back_populates="bill")


class SubMeterReading(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    reading: float  # The CCF reading

    unit_id: int = Field(foreign_key="unit.id")
    unit: "Unit" = Relationship()

    bill_id: int = Field(foreign_key="bill.id")
    bill: "Bill" = Relationship(back_populates="sub_meter_readings")


class ParsedAdjustment(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    description: str
    cost: float
    date: Optional[str] = Field(default=None)  # Date from the bill if available

    bill_id: int = Field(foreign_key="bill.id")
    bill: "Bill" = Relationship(back_populates="parsed_adjustments")

    # Relationship to unit selections
    unit_selections: List["AdjustmentUnitSelection"] = Relationship(
        back_populates="adjustment"
    )


class AdjustmentUnitSelection(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)

    adjustment_id: int = Field(foreign_key="parsedadjustment.id")
    adjustment: "ParsedAdjustment" = Relationship(back_populates="unit_selections")

    unit_id: int = Field(foreign_key="unit.id")
    unit: "Unit" = Relationship()
