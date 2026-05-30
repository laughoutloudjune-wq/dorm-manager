import { useReducer } from "react";

export type TenantFormState = {
  full_name: string;
  address: string;
  phone_number: string;
  room_id: string;
  move_in_date: string;
  status: string;
  lease_months: number;
  initial_electricity_reading: number;
  initial_water_reading: number;
  advance_rent_amount: number;
  security_deposit_amount: number;
  deposit_slip_url: string;
  final_electricity_reading: number;
  final_water_reading: number;
  move_out_request_date: string;
  final_move_out_date: string;
};

export type TransferCalcForm = {
  transfer_date: string;
  old_prev_electricity: number;
  old_curr_electricity: number;
  old_prev_water: number;
  old_curr_water: number;
  new_curr_electricity: number;
  new_curr_water: number;
};

export type TenantEditorState = {
  search: string;
  buildingFilter: string;
  activeTab: "info" | "move_in" | "move_out" | "payments";
  useCustomPayment: boolean;
  selectedMethodId: string;
  useCustomReceipt: boolean;
  selectedReceiptProfileId: string;
  latestPrevElectricity: number;
  latestPrevWater: number;
  forfeitDeposit: boolean;
  paymentHistoryMonth: string;

  confirmSaveOpen: boolean;
  confirmDeleteOpen: boolean;
  confirmUnlinkOpen: boolean;
  confirmMoveOutOpen: boolean;
  confirmCancelMoveOutOpen: boolean;
  isCancellingMoveOut: boolean;
  useProrate: boolean;
  isPageLoading: boolean;
  isSavingTenant: boolean;
  isDeletingTenant: boolean;
  isUnlinkingLine: boolean;
  isMovingOut: boolean;
  isUploadingDepositSlip: boolean;
  
  depositSlipUrls: string[];
  transferCalc: TransferCalcForm;

  form: TenantFormState;
};

export type TenantEditorAction =
  | { type: "SET_STATE"; payload: Partial<Omit<TenantEditorState, "form">> }
  | { type: "SET_FORM"; payload: Partial<TenantFormState> }
  | { type: "RESET_FORM" };

export const initialFormState: TenantFormState = {
  full_name: "",
  address: "",
  phone_number: "",
  room_id: "",
  move_in_date: "",
  status: "active",
  lease_months: 12,
  initial_electricity_reading: 0,
  initial_water_reading: 0,
  advance_rent_amount: 0,
  security_deposit_amount: 0,
  deposit_slip_url: "",
  final_electricity_reading: 0,
  final_water_reading: 0,
  move_out_request_date: "",
  final_move_out_date: "",
};

export const initialTenantEditorState: TenantEditorState = {
  search: "",
  buildingFilter: "all",
  activeTab: "info",
  useCustomPayment: false,
  selectedMethodId: "",
  useCustomReceipt: false,
  selectedReceiptProfileId: "",
  latestPrevElectricity: 0,
  latestPrevWater: 0,
  forfeitDeposit: false,
  paymentHistoryMonth: "all",

  confirmSaveOpen: false,
  confirmDeleteOpen: false,
  confirmUnlinkOpen: false,
  confirmMoveOutOpen: false,
  confirmCancelMoveOutOpen: false,
  isCancellingMoveOut: false,
  useProrate: true,
  isPageLoading: true,
  isSavingTenant: false,
  isDeletingTenant: false,
  isUnlinkingLine: false,
  isMovingOut: false,
  isUploadingDepositSlip: false,

  depositSlipUrls: [],
  transferCalc: {
    transfer_date: new Date().toISOString().slice(0, 10),
    old_prev_electricity: 0,
    old_curr_electricity: 0,
    old_prev_water: 0,
    old_curr_water: 0,
    new_curr_electricity: 0,
    new_curr_water: 0,
  },

  form: initialFormState,
};

function tenantEditorReducer(state: TenantEditorState, action: TenantEditorAction): TenantEditorState {
  switch (action.type) {
    case "SET_STATE":
      return { ...state, ...action.payload };
    case "SET_FORM":
      return { ...state, form: { ...state.form, ...action.payload } };
    case "RESET_FORM":
      return { ...state, form: initialFormState };
    default:
      return state;
  }
}

export function useTenantEditor() {
  const [state, dispatch] = useReducer(tenantEditorReducer, initialTenantEditorState);

  const setState = (payload: Partial<Omit<TenantEditorState, "form">>) => {
    dispatch({ type: "SET_STATE", payload });
  };

  const setForm = (payload: Partial<TenantFormState>) => {
    dispatch({ type: "SET_FORM", payload });
  };

  const resetForm = () => {
    dispatch({ type: "RESET_FORM" });
  };

  return { state, setState, setForm, resetForm };
}
