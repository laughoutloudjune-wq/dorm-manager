const fs = require('fs');

const path = 'components/admin/invoices/InvoiceDetailModal.tsx';
let content = fs.readFileSync(path, 'utf8');

// 1. Late fee breakdown
const searchLateFee = `<tr className="border-t border-slate-100">
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

const replaceLateFee = `<tr className="border-t border-slate-100">
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

if (content.includes(searchLateFee)) {
    content = content.replace(searchLateFee, replaceLateFee);
    console.log("Replaced late fee breakdown");
}

// 2. Slip button
const searchSlip = `                                  <div className="mt-1 flex items-center justify-between gap-2">
                                    <p>
                                      {(item.mode ?? "-").toString().toUpperCase()} |{" "}
                                      {item.paid_at ? new Date(item.paid_at).toLocaleString("th-TH") : "-"}
                                    </p>
                                    <button
                                      type="button"
                                      onClick={() => void cancelPaymentEntry(idx)}
                                      disabled={!canRecordInvoicePayment || paymentSubmitting}
                                      title={!canRecordInvoicePayment ? "ไม่มีสิทธิ์ยกเลิกรายการชำระเงิน" : undefined}
                                      className="rounded-md border border-red-200 px-2 py-1 text-[11px] font-semibold text-red-600 disabled:cursor-not-allowed disabled:opacity-50"
                                    >
                                      ยกเลิกรายการ
                                    </button>
                                  </div>`;

const replaceSlip = `                                  <div className="mt-1 flex items-center justify-between gap-2">
                                    <p>
                                      {(item.mode ?? "-").toString().toUpperCase()} |{" "}
                                      {item.paid_at ? new Date(item.paid_at).toLocaleString("th-TH") : "-"}
                                    </p>
                                    <div className="flex items-center gap-2">
                                      {item.slip_url && (
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setSlipModalTitle(\`สลิปการชำระเงิน - จำนวน \${formatMoney(toNumber(item.amount))}\`);
                                            setSlipModalUrl(item.slip_url);
                                            setSlipModalOpen(true);
                                          }}
                                          className="rounded-md border border-blue-200 px-2 py-1 text-[11px] font-semibold text-blue-600 hover:bg-blue-50"
                                        >
                                          ดูสลิป
                                        </button>
                                      )}
                                      <button
                                        type="button"
                                        onClick={() => void cancelPaymentEntry(idx)}
                                        disabled={!canRecordInvoicePayment || paymentSubmitting}
                                        title={!canRecordInvoicePayment ? "ไม่มีสิทธิ์ยกเลิกรายการชำระเงิน" : undefined}
                                        className="rounded-md border border-red-200 px-2 py-1 text-[11px] font-semibold text-red-600 disabled:cursor-not-allowed disabled:opacity-50 hover:bg-red-50"
                                      >
                                        ยกเลิกรายการ
                                      </button>
                                    </div>
                                  </div>`;

if (content.includes(searchSlip)) {
    content = content.replace(searchSlip, replaceSlip);
    console.log("Replaced slip button");
}

fs.writeFileSync(path, content);
console.log("Done");
