const fs = require('fs');

function replaceFileContent(path, search, replace) {
  try {
    let content = fs.readFileSync(path, 'utf8');
    const newContent = content.replace(search, replace);
    if (content === newContent) {
        console.log("No changes made to " + path);
    } else {
        fs.writeFileSync(path, newContent);
        console.log("Updated " + path);
    }
  } catch (e) {
    console.error("Failed to update " + path, e.message);
  }
}

// 1. InvoiceDetailModal.tsx
const searchModal = `<tr className="border-t border-slate-100">
                          <td className="px-3 py-2 font-medium">ค่าปรับล่าช้า</td>
                          <td className="px-3 py-2">
                            <input
                              type="number"
                              value={form.late_fee_amount}
                              readOnly
                              className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-right"
                            />
                          </td>
                        </tr>`;

const replaceModal = `<tr className="border-t border-slate-100">
                          <td className="px-3 py-2 font-medium">ค่าปรับล่าช้า</td>
                          <td className="px-3 py-2">
                            <input
                              type="number"
                              value={form.late_fee_amount}
                              readOnly
                              className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-right"
                            />
                            {form.late_fee_start_date && form.late_fee_amount > 0 && (
                              <p className="mt-1 text-[11px] text-slate-500 text-right">
                                (อัตรา {form.late_fee_per_day} บาท/วัน เริ่มตั้งแต่ {new Date(form.late_fee_start_date).toLocaleDateString("th-TH")})
                              </p>
                            )}
                          </td>
                        </tr>`;

replaceFileContent('components/admin/invoices/InvoiceDetailModal.tsx', searchModal, replaceModal);
replaceFileContent('components/admin/invoices/InvoicePreviewModal.tsx', searchModal, replaceModal);

// 2. use-invoices-state.ts
const searchState = `      late_fee_amount: feeItemsTotal(editableLateFeeItems),
      late_fee_per_day: toNumber(form.late_fee_per_day),
      late_fee_start_date: form.late_fee_start_date || null,
      carry_forward_amount: feeItemsTotal(editableCarryForwardItems),`;

const replaceState = `      late_fee_amount: feeItemsTotal(editableLateFeeItems),
      late_fee_per_day: editableLateFeeItems.length === 0 ? 0 : toNumber(form.late_fee_per_day),
      late_fee_start_date: editableLateFeeItems.length === 0 ? null : (form.late_fee_start_date || null),
      carry_forward_amount: feeItemsTotal(editableCarryForwardItems),`;

replaceFileContent('lib/hooks/use-invoices-state.ts', searchState, replaceState);
