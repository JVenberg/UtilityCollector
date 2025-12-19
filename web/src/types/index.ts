import { Timestamp } from "firebase/firestore";

// Solid Waste Service Types
export type SolidWasteServiceType = "Garbage" | "Food/Yard Waste" | "Recycle";

// Solid waste defaults for a unit - each unit has exactly one of each service type
export interface SolidWasteDefaults {
  garbage_size: number; // 20, 32, 60, 96 gallons
  compost_size: number; // 13, 32 gallons (Food/Yard Waste)
  recycle_size: number; // 90 gallons typically
}

// Unit types
export interface Unit {
  id: string;
  name: string; // "Unit 401"
  sqft: number;
  submeter_id: string;
  email: string;
  solid_waste_defaults?: SolidWasteDefaults; // Structured solid waste configuration
  created_at: Timestamp;
}

// Bill types
export type BillStatus =
  | "NEW"
  | "NEEDS_REVIEW"
  | "PENDING_APPROVAL"
  | "APPROVED"
  | "INVOICED";

export interface Bill {
  id: string;
  bill_date: string;
  due_date: string;
  total_amount: number;
  pdf_url: string;
  status: BillStatus;
  has_adjustments: boolean;
  services: Record<string, ServiceData>; // Flattened from parsed_data
  created_at: Timestamp;
  approved_at: Timestamp | null;
  approved_by: string | null;
  // Invoice payment tracking
  invoices_total?: number; // Total number of invoices
  invoices_paid?: number; // Number of paid invoices
  // Auto-fetched meter readings (persisted for display)
  meter_readings?: Record<string, MeterReading>; // { "401": {gallons, ccf, ...}, ... }
  meter_readings_fetched_at?: Timestamp;
}

export interface ServiceData {
  total: number;
  parts: ServicePart[];
}

export interface ServicePart {
  items: BillItem[];
  start_date?: string;
  end_date?: string;
  usage?: number;
  meter_number?: string;
}

export interface BillItem {
  description: string;
  cost: number;
  date?: string;
  usage?: number;
  rate?: number;
  size?: number;
  count?: number;
  start?: string; // Period start date for solid waste items
  end?: string; // Period end date for solid waste items
}

// Solid waste item parsed from bill - a line item like "2-Garbage 32 Gal 1X Weekly"
export interface SolidWasteItem {
  id: string; // Unique identifier for this item
  service_type: SolidWasteServiceType; // "Garbage", "Food/Yard Waste", "Recycle"
  description: string; // Full description e.g., "Garbage 32 Gal 1X Weekly"
  size: number; // Container size in gallons
  count: number; // Number of containers (e.g., "2-Garbage" = count 2)
  cost: number; // Total cost for ALL containers of this type
  cost_per_unit: number; // cost / count - for display purposes
  distributed_costs?: number[]; // Fair distribution of cost across count units (sum = cost exactly)
  start_date: string; // Service period start
  end_date: string; // Service period end
  frequency?: string; // "1X Weekly", "1X Every Other Week"
}

// Solid waste assignment for a specific item to a unit
export interface SolidWasteItemAssignment {
  item_id: string; // Reference to SolidWasteItem.id
  description: string; // For display
  size: number; // Container size
  cost: number; // This unit's cost portion (cost_per_unit from item)
  start_date: string;
  end_date: string;
}

// Solid waste assignment for a unit - stored in bills/{billId}/solid_waste_assignments/{unitId}
export interface SolidWasteAssignment {
  id: string; // Same as unit_id
  unit_id: string;
  garbage_items: SolidWasteItemAssignment[]; // Garbage items assigned
  compost_items: SolidWasteItemAssignment[]; // Food/Yard Waste items assigned
  recycle_items: SolidWasteItemAssignment[]; // Recycle items assigned
  garbage_total: number; // Sum of garbage_items costs
  compost_total: number; // Sum of compost_items costs
  recycle_total: number; // Sum of recycle_items costs
  total: number; // Total solid waste cost for this unit
  auto_assigned: boolean; // True if auto-assigned from unit defaults
  created_at: Timestamp | null;
}

// Validation result for solid waste assignments
export interface SolidWasteValidation {
  is_valid: boolean;
  errors: string[];
  warnings: string[];
  bill_total: number; // Expected total from bill
  assigned_total: number; // Actual assigned total
  units_complete: boolean; // Each unit has garbage, compost, recycle
  totals_match: boolean; // Rounded unit totals sum to bill total
}

// Reading types
export interface Reading {
  id: string;
  unit_id: string;
  submeter_id: string;
  reading: number; // Usage in gallons
  created_at: Timestamp | null;
}

// Meter reading from NextCentury scraper
export interface MeterReading {
  gallons: number;
  ccf: number;
  start_date: string;
  end_date: string;
}

// Latest readings from settings/latest_readings
export interface LatestReadings {
  readings: Record<string, MeterReading>; // { "401": {gallons, ccf, ...}, ... }
  fetched_at: Timestamp;
  unit: string; // "gallons"
  period?: {
    start_date: string | null;
    end_date: string | null;
  };
}

// Adjustment types
export interface Adjustment {
  id: string;
  description: string;
  cost: number;
  date: string | null;
  assigned_unit_ids: string[];
}

// Invoice types
// DRAFT: Invoice being prepared (temporary/legacy state)
// INVOICED: Invoice created (may or may not have email sent - check email_log)
// PAID: Invoice has been paid
export type InvoiceStatus = "DRAFT" | "INVOICED" | "PAID";

// Email log entry - tracks each email sent for an invoice
export interface EmailLogEntry {
  type: "invoice" | "reminder";  // Type of email
  sent_at: Timestamp;            // When email was sent
  message_id: string | null;     // Gmail message ID (for tracking/proof)
  recipient: string;             // Email address sent to
  success: boolean;              // Whether send was successful
  error?: string;                // Error message if failed
}

// Line item category for grouping in UI
export type LineItemCategory =
  | "sewer"
  | "water_usage"    // Water items split by usage
  | "water_sqft"     // Water items split by sqft (base charges)
  | "drainage"
  | "solid_waste"
  | "adjustment";

export interface LineItem {
  description: string;
  amount: number;
  category?: LineItemCategory;
}

export interface Invoice {
  id: string;
  unit_id: string;
  unit_name: string;
  tenant_email: string;
  amount: number;
  line_items: LineItem[];
  status: InvoiceStatus;
  paid_at: Timestamp | null;
  email_log: EmailLogEntry[];  // Log of all emails sent (invoice + reminders)
  // Convenience fields (derived from email_log but stored for easy querying)
  first_sent_at?: Timestamp | null;  // When first invoice email was sent
  reminders_sent?: number;           // Count of reminder emails (derived from email_log)
}

// Community types
export interface Community {
  id: string;
  name: string;
  owner_uid: string;
  settings: CommunitySettings;
  created_at: Timestamp;
}

export interface CommunitySettings {
  require_approval: boolean;
  reminder_days: number[];
  seattle_utilities_account: string;
}

// Gmail token
export interface GmailToken {
  access_token: string;
  refresh_token: string;
  scope: string;
  expiry: Timestamp;
  email: string;
  updated_at: Timestamp;
}

// User types
export type UserRole = "admin" | "member";

export interface AppUser {
  id: string;
  email: string;
  role: UserRole;
  name?: string;
  created_at: Timestamp;
  added_by?: string;
}
