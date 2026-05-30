import fs from 'fs';

// 1. Fix InvoiceDetailModal
let detailCode = fs.readFileSync('components/admin/invoices/InvoiceDetailModal.tsx', 'utf8');
detailCode = detailCode.replace(
  'AlertCircle } from "lucide-react";',
  'AlertCircle, Send } from "lucide-react";'
);
detailCode = detailCode.replace(
  'emptyFeeItem\n} from "@/lib/invoice-utils";',
  'emptyFeeItem,\n  calculateInvoiceTransferRentProration\n} from "@/lib/invoice-utils";'
);
detailCode = detailCode.replace(
  '  } = useInvoiceContext();\n\n  return (',
  `  } = useInvoiceContext();

  const modalProrateSummary = React.useMemo(() => {
    if (!activeInvoice || !activeInvoice.tenant_move_in_date || !printSettings) return null;
    return calculateInvoiceTransferRentProration(
      activeInvoice.tenant_move_in_date,
      activeInvoice.room_price_month,
      printSettings.billing_day || 1
    );
  }, [activeInvoice, printSettings]);

  return (`
);
// Also need to import React for useMemo
detailCode = detailCode.replace('"use client";\n', '"use client";\nimport React from "react";\n');
fs.writeFileSync('components/admin/invoices/InvoiceDetailModal.tsx', detailCode);

// 2. Fix InvoicePreviewModal
let previewCode = fs.readFileSync('components/admin/invoices/InvoicePreviewModal.tsx', 'utf8');
previewCode = previewCode.replace(
  'import { formatPeriodLabel, formatDateThai } from "@/lib/invoice-utils";',
  `import { 
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

console.log("Fixed modals!");
