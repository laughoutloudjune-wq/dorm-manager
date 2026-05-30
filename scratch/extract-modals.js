import fs from 'fs';

const lines = fs.readFileSync('components/admin/InvoicesPageView.tsx', 'utf8').split('\n');

const extractBounds = (startMarker, endMarker) => {
  let start = -1, end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(startMarker)) {
      start = i - 1; // get the `<Modal` line
    }
    if (start !== -1 && lines[i].trim() === endMarker) {
      end = i;
      break;
    }
  }
  return { start, end };
};

const createModalFile = (name, startMarker, endMarker, extraImports = "") => {
  const { start, end } = extractBounds(startMarker, endMarker);
  if (start === -1 || end === -1) {
    console.error("Could not find bounds for", name, start, end);
    return;
  }
  
  let modalLines = lines.slice(start, end + 1);
  const hookReturns = fs.readFileSync('scratch/hook-returns.txt', 'utf8');
  
  const componentCode = `"use client";

import { Modal } from "@/components/ui/Modal";
import { useInvoiceContext } from "./InvoiceContext";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Loader2, Plus, Printer, Save, Search, Trash2, UploadCloud, Mail, CheckCircle2, FileText, MailOpen, AlertCircle } from "lucide-react";
import { formatMoney, toLocalDateString } from "@/lib/format";
import { isInvoiceDetailEditable, formatPeriodLabel, formatDateThai } from "@/lib/invoice-utils";
${extraImports}

export function ${name}() {
  const {
${hookReturns.replace('  return {', '').replace('  };', '')}
  } = useInvoiceContext();

  return (
${modalLines.map(l => '    ' + l).join('\n')}
  );
}
`;

  fs.writeFileSync('components/admin/invoices/' + name + '.tsx', componentCode);
  console.log("Created", name);
};

createModalFile('SlipViewerModal', 'isOpen={slipModalOpen}', '</Modal>');
createModalFile('LineSendModal', 'isOpen={lineSendModalOpen}', '</Modal>');
createModalFile('InvoicePreviewModal', 'isOpen={previewOpen}', '</Modal>');
createModalFile('InvoiceDetailModal', 'isOpen={detailOpen}', '</Modal>');
