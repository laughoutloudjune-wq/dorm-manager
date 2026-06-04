const fs = require('fs');

const path = 'components/admin/ReportsPageView.tsx';
let content = fs.readFileSync(path, 'utf8');

// 1. Remove the incorrectly placed options
const toRemove = `const incomeBuildingOptions = useMemo(() => Array.from(new Set(incomeRows.filter(r => r.month === selectedMonth).map((r) => r.building_name).filter(Boolean))), [incomeRows, selectedMonth]);
  const incomePaymentMethodOptions = useMemo(() => Array.from(new Set(incomeRows.filter(r => r.month === selectedMonth).map((r) => r.paymentMethod).filter(Boolean))), [incomeRows, selectedMonth]);

  `;
content = content.replace(toRemove, "");

// 2. Add them after incomeRows
const search = `    [invoices, meterByRoomMonth]
  );`;
const replace = `    [invoices, meterByRoomMonth]
  );

  const incomeBuildingOptions = useMemo(() => Array.from(new Set(incomeRows.filter(r => r.month === selectedMonth).map((r) => r.building_name).filter(Boolean))), [incomeRows, selectedMonth]);
  const incomePaymentMethodOptions = useMemo(() => Array.from(new Set(incomeRows.filter(r => r.month === selectedMonth).map((r) => r.paymentMethod).filter(Boolean))), [incomeRows, selectedMonth]);`;

content = content.replace(search, replace);

fs.writeFileSync(path, content);
console.log("Done fixing the ReferenceError");
