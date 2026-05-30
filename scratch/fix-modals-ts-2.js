import fs from 'fs';

// Fix InvoiceDetailModal
let detailCode = fs.readFileSync('components/admin/invoices/InvoiceDetailModal.tsx', 'utf8');
detailCode = detailCode.replace(
  'calculateInvoiceTransferRentProration',
  'calculateProratedRentByBillingDay'
);
detailCode = detailCode.replace(
  'calculateInvoiceTransferRentProration(',
  'calculateProratedRentByBillingDay(\n      activeInvoice.room_price_month,\n'
);
// Remove the extra activeInvoice.room_price_month that gets left behind
detailCode = detailCode.replace(
  'activeInvoice.room_price_month,\n      printSettings.billing_day || 1\n    )',
  '      printSettings.billing_day || 1\n    )'
);
fs.writeFileSync('components/admin/invoices/InvoiceDetailModal.tsx', detailCode);


// Fix InvoicePreviewModal
let previewCode = fs.readFileSync('components/admin/invoices/InvoicePreviewModal.tsx', 'utf8');
previewCode = previewCode.replace(
  'import { isInvoiceDetailEditable, formatPeriodLabel, formatDateThai } from "@/lib/invoice-utils";',
  `import { 
  isInvoiceDetailEditable,
  formatPeriodLabel, 
  formatDateThai,
  calculateProratedRentByBillingDay,
  resolveWaterUsage,
  resolveElectricityUsage,
  toTransferBreakdownItems,
  toCarryForwardRows,
  toLateFeeItems,
  toLateFeeRows,
  shortInvoiceId,
  toChargeFeeRows
} from "@/lib/invoice-utils";
import { toNumber } from "@/lib/format";`
);
fs.writeFileSync('components/admin/invoices/InvoicePreviewModal.tsx', previewCode);

console.log("Fixed again!");
