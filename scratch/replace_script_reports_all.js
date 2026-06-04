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

// 1. Add 'arrears' to ReportTab type
replaceOrThrow(
  /type ReportTab = "income" \| "move_in" \| "move_out" \| "yearly" \| "utilities" \| "movement";/,
  `type ReportTab = "income" | "arrears" | "move_in" | "move_out" | "yearly" | "utilities" | "movement";`,
  "Add arrears to ReportTab"
);

// 2. Add TabButton for arrears
replaceOrThrow(
  /<TabButton active={activeTab === "income"} onClick={\(\) => setActiveTab\("income"\)} label="รายได้รายเดือน" \/>/,
  `<TabButton active={activeTab === "income"} onClick={() => setActiveTab("income")} label="รายได้รายเดือน" />\n            <TabButton active={activeTab === "arrears"} onClick={() => setActiveTab("arrears")} label="ยอดค้างชำระ (ลูกหนี้)" />`,
  "Add TabButton"
);

// 3. Add arrears calculation logic
const arrearsLogic = `
  const arrearsRows = useMemo(() => {
    const tenantDebts = new Map<string, any>();
    for (const invoice of invoices) {
      if (["pending", "partial", "overdue", "verifying"].includes(String(invoice.status))) {
        const outstanding = invoice.total_amount - invoice.paid_amount;
        if (outstanding > 0) {
          const tenantId = invoice.tenant_id || invoice.tenant_name || "unknown";
          if (!tenantDebts.has(tenantId)) {
            tenantDebts.set(tenantId, {
              tenant_name: invoice.tenant_name,
              room_number: invoice.room_number,
              building_name: invoice.building_name,
              outstanding: 0,
              invoice_count: 0,
              oldest_due_date: invoice.due_date
            });
          }
          const data = tenantDebts.get(tenantId)!;
          data.outstanding += outstanding;
          data.invoice_count += 1;
          if (invoice.due_date && (!data.oldest_due_date || new Date(invoice.due_date) < new Date(data.oldest_due_date))) {
            data.oldest_due_date = invoice.due_date;
          }
        }
      }
    }
    return Array.from(tenantDebts.values()).sort((a, b) => b.outstanding - a.outstanding);
  }, [invoices]);

  const arrearsSummary = useMemo(() => ({
    total_outstanding: arrearsRows.reduce((sum, row) => sum + row.outstanding, 0),
    total_tenants: arrearsRows.length,
    total_invoices: arrearsRows.reduce((sum, row) => sum + row.invoice_count, 0)
  }), [arrearsRows]);

  const exportArrears = () =>
    downloadCsv(
      \`arrears-report.csv\`,
      ["อาคาร", "ห้อง", "ชื่อผู้เช่า", "จำนวนบิลที่ค้าง", "วันที่ค้างนานสุด", "ยอดค้างรวม"],
      arrearsRows.map((row) => [row.building_name, row.room_number, row.tenant_name, row.invoice_count, formatDate(row.oldest_due_date), row.outstanding])
    );
`;

replaceOrThrow(
  /const exportIncome = \(\) =>/,
  arrearsLogic + "\n  const exportIncome = () =>",
  "Add arrears logic"
);

// 4. Add Arrears Tab UI
const arrearsTabUI = `
      {activeTab === "arrears" && (
        <>
          <Card>
            <CardContent className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">รายงานยอดค้างชำระ (ลูกหนี้)</h3>
                <p className="text-sm text-slate-500">รวมยอดผู้เช่าที่มียอดค้างชำระ เรียงจากค้างมากที่สุด</p>
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <ExportButton onClick={exportArrears} />
              </div>
            </CardContent>
          </Card>
          <SummaryCards
            items={[
              { label: "จำนวนผู้เช่าที่ค้างชำระ", value: arrearsSummary.total_tenants.toLocaleString("th-TH") + " คน" },
              { label: "จำนวนบิลที่ค้างรวม", value: arrearsSummary.total_invoices.toLocaleString("th-TH") + " ใบ" },
              { label: "ยอดค้างรวมทั้งหมด", value: formatMoney(arrearsSummary.total_outstanding) },
            ]}
          />
          <ReportTable
            headers={["อาคาร", "ห้อง", "ชื่อผู้เช่า", "จำนวนบิลที่ค้าง", "เริ่มค้างตั้งแต่", "ยอดค้างรวม"]}
            rows={arrearsRows.map((row) => [
              row.building_name,
              row.room_number,
              row.tenant_name,
              row.invoice_count.toLocaleString("th-TH"),
              formatDate(row.oldest_due_date),
              formatMoney(row.outstanding),
            ])}
            emptyText="ไม่มีผู้เช่าที่ค้างชำระ"
          />
        </>
      )}
`;

replaceOrThrow(
  /\{activeTab === "move_in" && \(/,
  arrearsTabUI + "\n      {activeTab === \"move_in\" && (",
  "Add arrears tab UI"
);

// 5. Add Search and Modal state
replaceOrThrow(
  /const \[activeTab, setActiveTab\] = useState<ReportTab>\("income"\);\s*const \[loading, setLoading\] = useState\(true\);/,
  `const [activeTab, setActiveTab] = useState<ReportTab>("income");
  const [loading, setLoading] = useState(true);
  const [incomeSearchQuery, setIncomeSearchQuery] = useState("");
  const [selectedIncomeInvoice, setSelectedIncomeInvoice] = useState<any>(null);
  const [movementSearchQuery, setMovementSearchQuery] = useState("");
  const [movementTypeFilter, setMovementTypeFilter] = useState("all");`,
  "Add search state"
);

// 6. Add Search and Modal imports
replaceOrThrow(
  /import \{ Download, FileSpreadsheet, Loader2 \} from "lucide-react";/,
  `import { Download, FileSpreadsheet, Loader2, Search } from "lucide-react";\nimport { Modal } from "@/components/ui/Modal";`,
  "Add imports for search and modal"
);

// 7. Update filteredIncomeRows
replaceOrThrow(
  /const filteredIncomeRows = useMemo\(\s*\(\) => incomeRows\.filter\(\(row\) => row\.month === selectedMonth\)\.sort\(byBuildingAndRoom\),\s*\[incomeRows, selectedMonth\]\s*\);/,
  `const filteredIncomeRows = useMemo(() => {
    let rows = incomeRows.filter((row) => row.month === selectedMonth);
    if (incomeSearchQuery.trim()) {
      const q = incomeSearchQuery.toLowerCase();
      rows = rows.filter((row) => 
        (row.room_number && row.room_number.toLowerCase().includes(q)) || 
        (row.tenant_name && row.tenant_name.toLowerCase().includes(q))
      );
    }
    return rows.sort(byBuildingAndRoom);
  }, [incomeRows, selectedMonth, incomeSearchQuery]);`,
  "Update filteredIncomeRows"
);

// 8. Update filteredMovementRows
replaceOrThrow(
  /const movementSummary = useMemo\([\s\S]*?\[movementRows\]\s*\);/,
  `const movementSummary = useMemo(
    () => ({
      total: movementRows.length,
      moveIn: movementRows.filter((row) => row.type === "ย้ายเข้า").length,
      moveOut: movementRows.filter((row) => row.type === "ย้ายออก").length,
      transfer: movementRows.filter((row) => row.type === "ย้ายห้อง").length,
    }),
    [movementRows]
  );

  const filteredMovementRows = useMemo(() => {
    let rows = movementRows;
    if (movementTypeFilter !== "all") {
      rows = rows.filter((row) => row.type === movementTypeFilter);
    }
    if (movementSearchQuery.trim()) {
      const q = movementSearchQuery.toLowerCase();
      rows = rows.filter((row) => 
        (row.room && row.room.toLowerCase().includes(q)) || 
        (row.tenant && row.tenant.toLowerCase().includes(q))
      );
    }
    return rows;
  }, [movementRows, movementTypeFilter, movementSearchQuery]);`,
  "Update filteredMovementRows"
);

// 9. Update Income tab UI
replaceOrThrow(
  /<div className="flex flex-wrap items-end gap-3">\s*<label className="space-y-1 text-sm text-slate-600">\s*<span className="block font-medium">เดือน<\/span>\s*<input\s*type="month"\s*value=\{selectedMonth\}\s*onChange=\{\(event\) => setSelectedMonth\(event\.target\.value\)\}\s*className="rounded-xl border border-slate-200 px-3 py-2 text-slate-900"\s*\/>\s*<\/label>\s*<ExportButton onClick=\{exportIncome\} \/>\s*<\/div>\s*<\/CardContent>\s*<\/Card>\s*<SummaryCards\s*items=\{\[\s*\{ label: "ยอดเรียกเก็บ", value: formatMoney\(incomeSummary\.billed\) \},\s*\{ label: "ยอดชำระ", value: formatMoney\(incomeSummary\.paid\) \},\s*\{ label: "ยอดค้าง", value: formatMoney\(incomeSummary\.outstanding\) \},\s*\{ label: "ค่าธรรมเนียมเพิ่ม", value: formatMoney\(incomeSummary\.additional\) \},\s*\{ label: "ค่าไฟที่เรียกเก็บ", value: formatMoney\(incomeSummary\.electricityCollected\) \},\s*\{ label: "ค่าน้ำที่เรียกเก็บ", value: formatMoney\(incomeSummary\.waterCollected\) \},\s*\]\}\s*\/>\s*<ReportTable\s*headers=\{\["อาคาร", "เลขห้อง", "ชื่อผู้เช่า", "หน่วยไฟ", "ค่าไฟ", "หน่วยน้ำ", "ค่าน้ำ", "ยอดเรียกเก็บ", "วิธีชำระ", "สถานะ", "ค่าธรรมเนียมเพิ่มเติม"\]\}\s*rows=\{filteredIncomeRows\.map\(\(row\) => \[\s*row\.building_name,\s*row\.room_number,\s*row\.tenant_name,\s*row\.electricityUsage\.toLocaleString\("th-TH"\),\s*formatMoney\(row\.electricity_bill\),\s*row\.waterUsage\.toLocaleString\("th-TH"\),\s*formatMoney\(row\.water_bill\),\s*formatMoney\(row\.total_amount\),\s*row\.paymentMethod,\s*statusLabel\(row\.status\),\s*row\.additionalFeeText,\s*\]\)\}\s*emptyText=\{\`ไม่พบข้อมูลรายได้ของเดือน \$\{selectedMonth\}\`\}\s*\/>/,
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
                <label className="space-y-1 text-sm text-slate-600">
                  <input
                    type="month"
                    value={selectedMonth}
                    onChange={(event) => setSelectedMonth(event.target.value)}
                    className="h-[38px] rounded-xl border border-slate-200 px-3 py-2 text-slate-900"
                  />
                </label>
                <ExportButton onClick={exportIncome} />
              </div>
            </CardContent>
          </Card>
          <SummaryCards
            items={[
              { label: "ยอดเรียกเก็บ", value: formatMoney(incomeSummary.billed) },
              { label: "ยอดชำระ", value: formatMoney(incomeSummary.paid) },
              { label: "ยอดค้าง", value: formatMoney(incomeSummary.outstanding) },
              { label: "ค่าธรรมเนียมเพิ่ม", value: formatMoney(incomeSummary.additional) },
              { label: "ค่าไฟ", value: formatMoney(incomeSummary.electricityCollected) },
              { label: "ค่าน้ำ", value: formatMoney(incomeSummary.waterCollected) },
            ]}
          />
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto rounded-xl">
                <table className="min-w-full text-left text-sm">
                  <thead className="bg-slate-50 text-slate-500">
                    <tr>
                      <th className="px-3 py-2">อาคาร</th>
                      <th className="px-3 py-2">เลขห้อง</th>
                      <th className="px-3 py-2">ชื่อผู้เช่า</th>
                      <th className="px-3 py-2 text-right">ยอดเรียกเก็บ</th>
                      <th className="px-3 py-2 text-right">ยอดชำระ</th>
                      <th className="px-3 py-2 text-center">วิธีชำระ</th>
                      <th className="px-3 py-2 text-center">สถานะ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredIncomeRows.length > 0 ? (
                      filteredIncomeRows.map((row) => (
                        <tr 
                          key={row.id} 
                          className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer"
                          onClick={() => setSelectedIncomeInvoice(row)}
                        >
                          <td className="px-3 py-2">{row.building_name}</td>
                          <td className="px-3 py-2 font-medium">{row.room_number}</td>
                          <td className="px-3 py-2">{row.tenant_name}</td>
                          <td className="px-3 py-2 text-right">{formatMoney(row.total_amount)}</td>
                          <td className="px-3 py-2 text-right text-green-600">{formatMoney(row.paid_amount)}</td>
                          <td className="px-3 py-2 text-center">{row.paymentMethod}</td>
                          <td className="px-3 py-2 text-center">
                            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px]">{statusLabel(row.status)}</span>
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={7} className="px-3 py-6 text-center text-slate-500">
                          ไม่พบข้อมูลรายได้
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
          
          <Modal
            isOpen={!!selectedIncomeInvoice}
            onClose={() => setSelectedIncomeInvoice(null)}
            title="รายละเอียดบิล"
            size="lg"
          >
            {selectedIncomeInvoice && (
              <div className="space-y-4 text-sm">
                <div className="flex justify-between rounded-xl bg-slate-50 p-4 border border-slate-100">
                  <div>
                    <p className="font-semibold text-slate-900">ห้อง {selectedIncomeInvoice.room_number}</p>
                    <p className="text-slate-500">{selectedIncomeInvoice.tenant_name}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-semibold text-slate-900">{formatMoney(selectedIncomeInvoice.total_amount)}</p>
                    <p className="text-slate-500">สถานะ: {statusLabel(selectedIncomeInvoice.status)}</p>
                  </div>
                </div>
                
                <table className="w-full text-sm border-collapse">
                  <thead className="bg-slate-50 text-slate-600 border border-slate-100">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium border-b border-slate-100">รายการ</th>
                      <th className="px-3 py-2 text-right font-medium border-b border-slate-100">จำนวนเงิน</th>
                    </tr>
                  </thead>
                  <tbody className="border border-slate-100">
                    <tr className="border-b border-slate-100">
                      <td className="px-3 py-2">ค่าเช่า</td>
                      <td className="px-3 py-2 text-right">{formatMoney(selectedIncomeInvoice.rent_amount)}</td>
                    </tr>
                    <tr className="border-b border-slate-100">
                      <td className="px-3 py-2">ค่าน้ำ ({selectedIncomeInvoice.waterUsage} หน่วย)</td>
                      <td className="px-3 py-2 text-right">{formatMoney(selectedIncomeInvoice.water_bill)}</td>
                    </tr>
                    <tr className="border-b border-slate-100">
                      <td className="px-3 py-2">ค่าไฟ ({selectedIncomeInvoice.electricityUsage} หน่วย)</td>
                      <td className="px-3 py-2 text-right">{formatMoney(selectedIncomeInvoice.electricity_bill)}</td>
                    </tr>
                    {selectedIncomeInvoice.common_fee > 0 && (
                      <tr className="border-b border-slate-100">
                        <td className="px-3 py-2">ค่าส่วนกลาง</td>
                        <td className="px-3 py-2 text-right">{formatMoney(selectedIncomeInvoice.common_fee)}</td>
                      </tr>
                    )}
                    {selectedIncomeInvoice.late_fee_amount > 0 && (
                      <tr className="border-b border-slate-100">
                        <td className="px-3 py-2">ค่าปรับล่าช้า</td>
                        <td className="px-3 py-2 text-right">{formatMoney(selectedIncomeInvoice.late_fee_amount)}</td>
                      </tr>
                    )}
                    {Array.isArray(selectedIncomeInvoice.additional_fees_breakdown) && selectedIncomeInvoice.additional_fees_breakdown.map((fee, idx) => (
                      <tr key={idx} className="border-b border-slate-100">
                        <td className="px-3 py-2">ค่าอื่นๆ ({fee.detail || fee.label || '-'})</td>
                        <td className="px-3 py-2 text-right">{formatMoney(fee.amount || fee.total_amount)}</td>
                      </tr>
                    ))}
                    {selectedIncomeInvoice.discount_amount > 0 && (
                      <tr className="border-b border-slate-100 text-green-600">
                        <td className="px-3 py-2">ส่วนลด</td>
                        <td className="px-3 py-2 text-right">-{formatMoney(selectedIncomeInvoice.discount_amount)}</td>
                      </tr>
                    )}
                    <tr className="bg-slate-50 font-semibold">
                      <td className="px-3 py-3 text-right">รวมสุทธิ</td>
                      <td className="px-3 py-3 text-right">{formatMoney(selectedIncomeInvoice.total_amount)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </Modal>`,
  "Update Income tab UI"
);

// 10. Update Movement tab UI
replaceOrThrow(
  /<div className="flex items-center justify-between gap-3">\s*<div>\s*<h3 className="text-lg font-semibold text-slate-900">รายงานการเคลื่อนไหวห้องและผู้เช่า<\/h3>\s*<p className="text-sm text-slate-500">ดูว่าห้องไหนมีการย้ายเข้า ย้ายออก หรือย้ายห้องเมื่อใด<\/p>\s*<\/div>\s*<ExportButton onClick=\{exportMovement\} \/>\s*<\/div>\s*<ReportTable\s*headers=\{\["อาคาร", "ห้อง", "วันที่", "ประเภท", "ชื่อผู้เช่า", "รายละเอียด"\]\}\s*rows=\{movementRows\.map\(\(row\) => \[\s*row\.building \?\? "-",\s*row\.room,\s*formatDate\(row\.date\),\s*row\.type,\s*row\.tenant,\s*row\.details,\s*\]\)\}\s*emptyText="ไม่มีข้อมูลการเคลื่อนไหว"\s*embedded\s*\/>/,
  `<div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <h3 className="text-lg font-semibold text-slate-900">รายงานการเคลื่อนไหวห้องและผู้เช่า</h3>
                  <p className="text-sm text-slate-500">ดูว่าห้องไหนมีการย้ายเข้า ย้ายออก หรือย้ายห้องเมื่อใด</p>
                </div>
                <div className="flex flex-wrap items-end gap-3">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                    <input
                      type="text"
                      placeholder="ค้นหาห้อง / ผู้เช่า..."
                      value={movementSearchQuery}
                      onChange={(e) => setMovementSearchQuery(e.target.value)}
                      className="h-[38px] w-48 rounded-xl border border-slate-200 pl-9 pr-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                  </div>
                  <select
                    value={movementTypeFilter}
                    onChange={(e) => setMovementTypeFilter(e.target.value)}
                    className="h-[38px] rounded-xl border border-slate-200 px-3 py-1 text-sm text-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="all">ทุกประเภท</option>
                    <option value="ย้ายเข้า">ย้ายเข้า</option>
                    <option value="ย้ายออก">ย้ายออก</option>
                    <option value="ย้ายห้อง">ย้ายห้อง</option>
                  </select>
                  <ExportButton onClick={exportMovement} />
                </div>
              </div>
              <ReportTable
                headers={["อาคาร", "ห้อง", "วันที่", "ประเภท", "ชื่อผู้เช่า", "รายละเอียด"]}
                rows={filteredMovementRows.map((row) => [
                  row.building ?? "-",
                  row.room,
                  formatDate(row.date),
                  row.type,
                  row.tenant,
                  row.details,
                ])}
                emptyText="ไม่มีข้อมูลการเคลื่อนไหว"
                embedded
              />`,
  "Update Movement tab UI"
);

fs.writeFileSync(path, content);
console.log("Done updating ReportsPageView fully!");
