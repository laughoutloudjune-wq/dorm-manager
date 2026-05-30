export type TenantRow = {
  id: string;
  full_name: string;
  address: string | null;
  phone_number: string | null;
  line_user_id: string | null;
  move_in_date: string;
  move_out_date: string | null;
  status: string;
  room_id: string;
  lease_months: number | null;
  initial_electricity_reading: number | null;
  initial_water_reading: number | null;
  advance_rent_amount: number | null;
  security_deposit_amount: number | null;
  deposit_slip_url: string | null;
  final_electricity_reading: number | null;
  final_water_reading: number | null;
  forfeit_security_deposit: boolean | null;
  custom_payment_method: any;
  custom_receipt_profile: any;
  rooms:
    | { room_number: string; price_month: number | null; buildings: { name: string }[] | null }
    | { room_number: string; price_month: number | null; buildings: { name: string }[] | null }[]
    | null;
};

export type RoomRow = {
  id: string;
  room_number: string;
  price_month: number | null;
  buildings: { name: string }[] | { name: string } | null;
};

export type PaymentMethod = {
  id: string;
  label: string;
  bank_name: string;
  account_name: string;
  account_number: string;
  qr_url: string | null;
};

export type ReceiptProfile = {
  id: string;
  label: string;
  company_name: string;
  tax_id: string | null;
  branch: string | null;
  address: string;
};

export type MoveOutRequestRow = {
  id: string;
  tenant_id: string;
  notice_date: string | null;
  requested_move_out_date: string;
  approved_move_out_date: string | null;
  actual_move_out_date: string | null;
  status: string;
  request_note: string | null;
  admin_note: string | null;
  created_at: string | null;
};

export type SettingsRates = {
  water_rate: number;
  electricity_rate: number;
};

export type MoveOutFeeLine = {
  id: string;
  label: string;
  amount: number;
};

export type TenantInvoiceHistoryRow = {
  id: string;
  start_date: string;
  end_date: string;
  total_amount: number | null;
  paid_amount: number | null;
  status: string;
  slip_url: string | null;
  slip_uploaded_at: string | null;
  payment_history: any[];
  created_at: string | null;
};

export type MeterRow = {
  room_id: string;
  room_number: string;
  reading_month: string;
  rollover: boolean;
  previous_source: "prev_month" | "move_in";
  previous_month_electricity: number;
  previous_month_water: number;
  move_in_electricity: number | null;
  move_in_water: number | null;
  move_in_tenant_name: string | null;
  move_in_date: string | null;
  previous_electricity: number;
  current_electricity: number;
  electricity_usage: number;
  previous_water: number;
  current_water: number;
  water_usage: number;
};

export type InvoiceRow = {
  id: string;
  room_id: string;
  tenant_id: string;
  issue_date: string;
  due_date: string;
  start_date: string;
  end_date: string;
  status: string;
  rent_amount: number | null;
  water_bill: number | null;
  electricity_bill: number | null;
  common_fee: number | null;
  discount_amount: number | null;
  discount_breakdown: any;
  late_fee_amount: number | null;
  late_fee_per_day: number | null;
  late_fee_start_date: string | null;
  carry_forward_amount: number | null;
  other_fees: any;
  additional_fees_total: number | null;
  additional_fees_breakdown: any;
  total_amount: number | null;
  paid_amount: number | null;
  payment_history: any[];
  public_token: string;
  slip_url: string | null;
  slip_uploaded_at: string | null;
  notes: string | null;
  tenants?: { full_name: string; phone_number: string | null; line_user_id: string | null } | null;
  rooms?: { room_number: string; buildings: { name: string }[] | null } | null;
};
