const fs = require('fs');

const path = 'components/admin/ReportsPageView.tsx';
let content = fs.readFileSync(path, 'utf8');

function replaceOrThrow(search, replace, stepName) {
  if (typeof search === 'string') {
    if (!content.includes(search)) {
      throw new Error("Failed to find string for step: " + stepName);
    }
    content = content.replace(search, replace);
  } else {
    if (!content.match(search)) {
      throw new Error("Failed to match regex for step: " + stepName);
    }
    content = content.replace(search, replace);
  }
  console.log("Success: " + stepName);
}

// 1. Add filter states
replaceOrThrow(
  /const \[incomeSearchQuery, setIncomeSearchQuery\] = useState\(""\);/,
  `const [incomeSearchQuery, setIncomeSearchQuery] = useState("");
  const [incomeBuildingFilter, setIncomeBuildingFilter] = useState("all");
  const [incomeStatusFilter, setIncomeStatusFilter] = useState("all");
  const [incomePaymentMethodFilter, setIncomePaymentMethodFilter] = useState("all");`,
  "Add filter states"
);

// 2. Add building and payment method options
replaceOrThrow(
  /const incomeRows = useMemo\(/,
  `const incomeBuildingOptions = useMemo(() => Array.from(new Set(incomeRows.filter(r => r.month === selectedMonth).map((r) => r.building_name).filter(Boolean))), [incomeRows, selectedMonth]);
  const incomePaymentMethodOptions = useMemo(() => Array.from(new Set(incomeRows.filter(r => r.month === selectedMonth).map((r) => r.paymentMethod).filter(Boolean))), [incomeRows, selectedMonth]);

  const incomeRows = useMemo(`,
  "Add dropdown options logic"
);

// 3. Update filteredIncomeRows
replaceOrThrow(
  /const filteredIncomeRows = useMemo\(\(\) => \{\s*let rows = incomeRows\.filter\(\(row\) => row\.month === selectedMonth\);\s*if \(incomeSearchQuery\.trim\(\)\) \{\s*const q = incomeSearchQuery\.toLowerCase\(\);\s*rows = rows\.filter\(\(row\) => \s*\(row\.room_number && row\.room_number\.toLowerCase\(\)\.includes\(q\)\) \|\|\s*\(row\.tenant_name && row\.tenant_name\.toLowerCase\(\)\.includes\(q\)\)\s*\);\s*\}\s*return rows\.sort\(\(a, b\) => \{/,
  `const filteredIncomeRows = useMemo(() => {
    let rows = incomeRows.filter((row) => row.month === selectedMonth);
    if (incomeSearchQuery.trim()) {
      const q = incomeSearchQuery.toLowerCase();
      rows = rows.filter((row) => 
        (row.room_number && row.room_number.toLowerCase().includes(q)) || 
        (row.tenant_name && row.tenant_name.toLowerCase().includes(q))
      );
    }
    if (incomeBuildingFilter !== "all") {
      rows = rows.filter(row => row.building_name === incomeBuildingFilter);
    }
    if (incomeStatusFilter !== "all") {
      rows = rows.filter(row => row.status === incomeStatusFilter);
    }
    if (incomePaymentMethodFilter !== "all") {
      rows = rows.filter(row => row.paymentMethod === incomePaymentMethodFilter);
    }
    return rows.sort((a, b) => {`,
  "Update filteredIncomeRows"
);

// 4. Update Income Tab UI
replaceOrThrow(
  /<div className="flex flex-wrap items-end gap-3">\s*<div className="relative">\s*<Search className="absolute left-3 top-1\/2 -translate-y-1\/2 text-slate-400" size=\{16\} \/>\s*<input\s*type="text"\s*placeholder="ค้นหาห้อง \/ ผู้เช่า\.\.\."\s*value=\{incomeSearchQuery\}\s*onChange=\{\(e\) => setIncomeSearchQuery\(e\.target\.value\)\}\s*className="h-\[38px\] w-48 rounded-xl border border-slate-200 pl-9 pr-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"\s*\/>\s*<\/div>\s*<label className="space-y-1 text-sm text-slate-600">\s*<input\s*type="month"\s*value=\{selectedMonth\}\s*onChange=\{\(event\) => setSelectedMonth\(event\.target\.value\)\}\s*className="h-\[38px\] rounded-xl border border-slate-200 px-3 py-2 text-slate-900"\s*\/>\s*<\/label>\s*<ExportButton onClick=\{exportIncome\} \/>\s*<\/div>/,
  `<div className="flex flex-wrap items-end gap-3">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                  <input
                    type="text"
                    placeholder="ค้นหาห้อง / ผู้เช่า..."
                    value={incomeSearchQuery}
                    onChange={(e) => setIncomeSearchQuery(e.target.value)}
                    className="h-[38px] w-48 rounded-xl border border-slate-200 pl-9 pr-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
                {incomeBuildingOptions.length > 0 && (
                  <select
                    value={incomeBuildingFilter}
                    onChange={(e) => setIncomeBuildingFilter(e.target.value)}
                    className="h-[38px] rounded-xl border border-slate-200 px-3 py-1 text-sm text-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="all">ทุกอาคาร</option>
                    {incomeBuildingOptions.map(b => (
                      <option key={b} value={b}>{b}</option>
                    ))}
                  </select>
                )}
                <select
                  value={incomeStatusFilter}
                  onChange={(e) => setIncomeStatusFilter(e.target.value)}
                  className="h-[38px] rounded-xl border border-slate-200 px-3 py-1 text-sm text-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="all">ทุกสถานะ</option>
                  <option value="paid">ชำระแล้ว (Paid)</option>
                  <option value="pending">รอชำระ (Pending)</option>
                  <option value="partial">จ่ายบางส่วน (Partial)</option>
                  <option value="overdue">ค้างชำระ (Overdue)</option>
                  <option value="verifying">รอตรวจสอบ (Verifying)</option>
                </select>
                {incomePaymentMethodOptions.length > 0 && (
                  <select
                    value={incomePaymentMethodFilter}
                    onChange={(e) => setIncomePaymentMethodFilter(e.target.value)}
                    className="h-[38px] rounded-xl border border-slate-200 px-3 py-1 text-sm text-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="all">ทุกวิธีชำระ</option>
                    {incomePaymentMethodOptions.map(m => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                )}
                <label className="space-y-1 text-sm text-slate-600">
                  <input
                    type="month"
                    value={selectedMonth}
                    onChange={(event) => setSelectedMonth(event.target.value)}
                    className="h-[38px] rounded-xl border border-slate-200 px-3 py-2 text-slate-900"
                  />
                </label>
                <ExportButton onClick={exportIncome} />
              </div>`,
  "Update Income Tab UI"
);

// Also we need to add the dependencies to the useMemo for filteredIncomeRows
replaceOrThrow(
  /}, \[incomeRows, selectedMonth, incomeSearchQuery\]\);/,
  `}, [incomeRows, selectedMonth, incomeSearchQuery, incomeBuildingFilter, incomeStatusFilter, incomePaymentMethodFilter]);`,
  "Update useMemo dependencies"
);


fs.writeFileSync(path, content);
console.log("Done updating ReportsPageView filters!");
