import fs from 'fs';

const originLines = fs.readFileSync('components/admin/InvoicesPageView.tsx', 'utf8').split('\n');
const hookReturns = fs.readFileSync('scratch/hook-returns.txt', 'utf8');

// Find the imports
let importEndIndex = 0;
for (let i = 0; i < originLines.length; i++) {
  if (originLines[i].startsWith('const statusVariant')) {
    importEndIndex = i;
    break;
  }
}
const imports = originLines.slice(0, importEndIndex).join('\n');

// Find the JSX
let jsxStartIndex = -1;
for (let i = 0; i < originLines.length; i++) {
  if (originLines[i].startsWith('  return (')) {
    jsxStartIndex = i;
    break;
  }
}
const jsxLines = originLines.slice(jsxStartIndex).join('\n');

const newCode = imports + `
import { useInvoicesState } from "@/lib/hooks/use-invoices-state";
import { statusVariant } from "@/lib/invoice-utils"; // Need this for the UI

export default function InvoicesPage() {
  const {
${hookReturns.replace('  return {', '').replace('  };', '')}
  } = useInvoicesState();

` + jsxLines;

fs.writeFileSync('components/admin/InvoicesPageView.tsx', newCode);
console.log("InvoicesPageView refactored successfully!");
