import fs from 'fs';

let pageCode = fs.readFileSync('components/admin/InvoicesPageView.tsx', 'utf8');

const extractBounds = (startMarker, endMarker, lines) => {
  let start = -1, end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(startMarker)) {
      start = i - 1; 
    }
    if (start !== -1 && lines[i].trim() === endMarker) {
      end = i;
      break;
    }
  }
  return { start, end };
};

const replaceModal = (name, startMarker, endMarker) => {
  let lines = pageCode.split('\n');
  const { start, end } = extractBounds(startMarker, endMarker, lines);
  if (start === -1 || end === -1) {
    console.log("Could not find", name);
    return;
  }
  lines.splice(start, end - start + 1, '        <' + name + ' />');
  pageCode = lines.join('\n');
  console.log("Replaced", name);
};

replaceModal('SlipViewerModal', 'isOpen={slipModalOpen}', '</Modal>');
replaceModal('LineSendModal', 'isOpen={lineSendModalOpen}', '</Modal>');
replaceModal('InvoicePreviewModal', 'isOpen={previewOpen}', '</Modal>');
replaceModal('InvoiceDetailModal', 'isOpen={detailOpen}', '</Modal>');

// Wrap return in InvoiceProvider and add imports
pageCode = pageCode.replace('  } = useInvoicesState();', '  } = state;');
pageCode = pageCode.replace('export default function InvoicesPage() {\n  const {', 'import { InvoiceProvider } from "./invoices/InvoiceContext";\nimport { SlipViewerModal } from "./invoices/SlipViewerModal";\nimport { LineSendModal } from "./invoices/LineSendModal";\nimport { InvoicePreviewModal } from "./invoices/InvoicePreviewModal";\nimport { InvoiceDetailModal } from "./invoices/InvoiceDetailModal";\n\nexport default function InvoicesPage() {\n  const state = useInvoicesState();\n  const {');
pageCode = pageCode.replace('  return (\n    <div className="flex h-[calc(100vh-theme(spacing.20))] flex-col overflow-hidden">', '  return (\n    <InvoiceProvider state={state}>\n      <div className="flex h-[calc(100vh-theme(spacing.20))] flex-col overflow-hidden">');
const lastDivIdx = pageCode.lastIndexOf('</div>\n  );');
if (lastDivIdx !== -1) {
  pageCode = pageCode.substring(0, lastDivIdx + 6) + '\n    </InvoiceProvider>' + pageCode.substring(lastDivIdx + 6);
}

fs.writeFileSync('components/admin/InvoicesPageView.tsx', pageCode);
console.log("InvoicesPageView updated");
