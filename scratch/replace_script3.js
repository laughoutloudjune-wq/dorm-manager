const fs = require('fs');

const path = 'components/admin/invoices/InvoiceDetailModal.tsx';
let content = fs.readFileSync(path, 'utf8');

const search = `<p>
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
                                    </button>`;

const replace = `<p>
                                      {(item.mode ?? "-").toString().toUpperCase()} |{" "}
                                      {item.paid_at ? new Date(item.paid_at).toLocaleString("th-TH") : "-"}
                                    </p>
                                    <div className="flex items-center gap-2">
                                      {item.slip_url && (
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setSlipModalTitle(\`สลิปการชำระเงิน - \${formatMoney(toNumber(item.amount))}\`);
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
                                    </div>`;

if (content.includes(search)) {
    fs.writeFileSync(path, content.replace(search, replace));
    console.log("Updated " + path);
} else {
    console.log("Could not find search string in " + path);
}
