const fs = require('fs');

const path = 'components/admin/ReportsPageView.tsx';
let content = fs.readFileSync(path, 'utf8');

// 1. Add 'arrears' to ReportTab type
content = content.replace(
  `type ReportTab = "income" | "move_in" | "move_out" | "yearly" | "utilities" | "movement";`,
  `type ReportTab = "income" | "arrears" | "move_in" | "move_out" | "yearly" | "utilities" | "movement";`
);

// 2. Add TabButton
content = content.replace(
  `<TabButton active={activeTab === "income"} onClick={() => setActiveTab("income")} label="รายได้รายเดือน" />`,
  `<TabButton active={activeTab === "income"} onClick={() => setActiveTab("income")} label="รายได้รายเดือน" />\n            <TabButton active={activeTab === "arrears"} onClick={() => setActiveTab("arrears")} label="ยอดค้างชำระ (ลูกหนี้)" />`
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

const insertAfter = `  const exportIncome = () =>`;
content = content.replace(insertAfter, arrearsLogic + "\n" + insertAfter);

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

const insertBeforeTab = `      {activeTab === "move_in" && (`;
content = content.replace(insertBeforeTab, arrearsTabUI + "\n" + insertBeforeTab);

fs.writeFileSync(path, content);
console.log("Done updating ReportsPageView for arrears");
