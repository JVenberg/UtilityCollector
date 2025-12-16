import { Timestamp } from "firebase/firestore";

// Unit types
export interface TrashCan {
  service_type: string; // "Garbage", "Recycle"
  size: number; // gallons
}

export interface Unit {
  id: string;
  name: string; // "Unit 401"
  sqft: number;
  submeter_id: string;
  email: string;
  trash_cans: TrashCan[];
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
  parsed_data: ParsedBillData;
  created_at: Timestamp;
  approved_at: Timestamp | null;
  approved_by: string | null;
}

export interface ParsedBillData {
  due_date: string;
  total: number;
  services: Record<string, ServiceData>;
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
}

// Reading types
export interface Reading {
  id: string;
  unit_id: string;
  submeter_id: string;
  reading: number;
  created_at: Timestamp | null;
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
export type InvoiceStatus = "DRAFT" | "SENT" | "PAID";

export interface LineItem {
  description: string;
  amount: number;
}

export interface Invoice {
  id: string;
  unit_id: string;
  unit_name: string;
  tenant_email: string;
  amount: number;
  line_items: LineItem[];
  status: InvoiceStatus;
  sent_at: Timestamp | null;
  paid_at: Timestamp | null;
  reminders_sent: number;
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
