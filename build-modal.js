const fs = require('fs');
const oldContent = fs.readFileSync('components/admin/invoices/InvoiceDetailModal.tsx', 'utf8');
const lines = oldContent.split('\n');
// Find where '  return (' is. It's at line 206 (index 205).
let returnIndex = lines.findIndex(l => l.startsWith('  return ('));
if (returnIndex === -1) {
  console.error('Cannot find return statement');
  process.exit(1);
}
const topPart = lines.slice(0, returnIndex).join('\n');

const newJsx = fs.readFileSync('.gemini/temp-jsx.txt', 'utf8');

fs.writeFileSync('components/admin/invoices/InvoiceDetailModal.tsx', topPart + '\n' + newJsx);
