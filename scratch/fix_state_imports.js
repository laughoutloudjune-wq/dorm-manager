import fs from 'fs';

let code = fs.readFileSync('lib/hooks/use-invoices-state.ts', 'utf8');

const replacement = `  resolveElectricityUsage,
  resolveWaterUsage,
  serializeTransferBreakdownRows,
  parsePaymentMethodText,
  invoiceDisplayOutstanding,
  calculateInvoiceTransferRentProration,
  type FeeLineItem,
  type CarryForwardItem,
  type LateFeeLineItem,
  type TransferBreakdownItem,
  type AdditionalFee,
  type MeterReadingRow,
  InvoiceRecord,
  ArrearsSnapshotItem,
  PrintSettings,
  PaymentMethodRow,
  normalizeInvoice,
  statusVariant
} from "@/lib/invoice-utils";
import {
  CheckCircle2,
  Loader2,
  Send,
  Trash2,`;

code = code.replace(/calculateLateFeePreview,[\s\S]*?Trash2,/s, 'calculateLateFeePreview,\n' + replacement);

fs.writeFileSync('lib/hooks/use-invoices-state.ts', code);
