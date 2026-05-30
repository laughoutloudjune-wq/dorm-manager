const fs = require('fs');
let code = fs.readFileSync('components/admin/tenant-editor-modal.tsx', 'utf8');
const header = `"use client";

import { getInvoiceOutstanding } from "@/lib/invoice-ledger";
import { bangkokYmd, meets30DayMoveOutNotice } from "@/lib/move-out-notice";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Modal } from "@/components/ui/Modal";
import { MoveOutTab } from "@/components/admin/MoveOutTab";
import { MoveOutProcessingModal } from "@/components/admin/MoveOutProcessingModal";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { ConfirmActionModal } from "@/components/ui/ConfirmActionModal";
import { createClient } from "@/lib/supabase-client";
import { usePermissions } from "@/lib/use-permissions";
import { useTenantEditor } from "@/lib/hooks/use-tenant-editor";
import { Loader2, Plus, Printer, Save, Search, Trash2, Upload } from "lucide-react";
import { TenantRow, RoomRow, PaymentMethod, ReceiptProfile, MoveOutRequestRow, SettingsRates, MoveOutFeeLine, TenantInvoiceHistoryRow } from "@/types";
import { TransferCalcForm } from "@/lib/hooks/use-tenant-editor";
import { toNumber, roundTo2, ymdToLocalDate, formatMoney, escapeHtml } from "@/lib/format";
import { createMoveOutFeeLine, parseDepositSlipUrls, serializeDepositSlipUrls, roomNumberCompare, roomLabel, tenantRoomNumber, tenantRoomPrice, tenantBuildingName, leaseEndDateText, calculateTransferRentProration, tenantStatusLabel, sanitizeStorageFileName, tenantPaymentMethodLabel, findExistingActiveTenantInRoom } from "@/lib/tenant-utils";

const ymdToLocalDate = (ymd: string) => {
`;
code = header + code.substring(code.indexOf('  if (p.length < 3) return new Date(NaN);'));
fs.writeFileSync('components/admin/tenant-editor-modal.tsx', code);
