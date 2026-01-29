'use client';

export default function InvoiceTemplate({ data, settings, onClose }: any) {
  if (!data) return null;

  const { invoice, tenant, type } = data;
  const isReceipt = type === 'RECEIPT';
  const colorClass = isReceipt ? 'text-green-700' : 'text-slate-900';
  const borderClass = isReceipt ? 'border-green-700' : 'border-slate-900';

  const handlePrint = () => { window.print(); };

  return (
    <div id="invoice-preview-container" className="fixed inset-0 z-[100] bg-gray-900/95 flex flex-col items-center overflow-auto p-4 md:p-8">
      {/* TOOLBAR */}
      <div className="no-print w-full max-w-[210mm] flex justify-between items-center mb-6 text-white shrink-0">
        <h2 className="font-bold text-lg">Print Preview</h2>
        <div className="flex gap-3">
          <button onClick={handlePrint} className="bg-blue-600 hover:bg-blue-500 text-white px-6 py-2 rounded-full font-bold shadow-lg flex items-center gap-2 transition-transform hover:scale-105">🖨️ Print / PDF</button>
          <button onClick={onClose} className="bg-white/10 hover:bg-white/20 text-white px-4 py-2 rounded-full font-bold">Close X</button>
        </div>
      </div>
      
      {/* A4 PAPER SHEET */}
      {/* FIXED: Removed 'font-sans' so it uses Sarabun */}
      <div id="invoice-preview" className="bg-white w-full max-w-[210mm] min-h-[297mm] p-10 md:p-16 shadow-2xl relative text-slate-900 leading-relaxed origin-top transform scale-90 md:scale-100">
        
        {/* HEADER */}
        <div className="flex justify-between items-start border-b-2 border-gray-800 pb-6 mb-8">
          <div className="w-2/3">
            <h1 className="text-2xl font-extrabold uppercase tracking-wide mb-2">{settings?.dorm_name || 'Dormitory Name'}</h1>
            <p className="text-sm text-gray-600 whitespace-pre-line">{settings?.address || 'Address'}</p>
            <p className="text-sm text-gray-600 mt-1">Tel: {settings?.contact_number || '-'}</p>
            <div className="mt-6 pl-4 border-l-4 border-gray-200">
              <p className="text-xs font-bold text-gray-400 uppercase">Bill To:</p>
              <p className="text-lg font-bold">{tenant?.name || 'Current Tenant'}</p>
              <p className="text-sm text-gray-600">{tenant?.address || ''}</p>
            </div>
          </div>
          <div className="w-1/3 text-right">
            <h2 className={`text-4xl font-black uppercase mb-4 ${colorClass}`}>{type}</h2>
            <div className="space-y-1 text-sm">
              <div className="flex justify-between"><span className="font-bold text-gray-500">No:</span><span className="font-mono font-bold">{invoice.id.substring(0,8).toUpperCase()}</span></div>
              <div className="flex justify-between"><span className="font-bold text-gray-500">Room:</span><span className="font-bold text-lg">{invoice.rooms?.room_number}</span></div>
              <div className="flex justify-between"><span className="font-bold text-gray-500">Date:</span><span>{new Date().toLocaleDateString('th-TH')}</span></div>
              <div className="flex justify-between"><span className="font-bold text-gray-500">Month:</span><span>{invoice.month}/{invoice.year}</span></div>
            </div>
          </div>
        </div>

        {/* TABLE */}
        <table className="w-full mb-8">
          <thead>
            <tr className={`border-b-2 ${borderClass}`}>
              <th className="text-left py-2 font-bold uppercase text-xs text-gray-500">Description</th>
              <th className="text-right py-2 font-bold uppercase text-xs text-gray-500">Unit / Details</th>
              <th className="text-right py-2 font-bold uppercase text-xs text-gray-500">Amount</th>
            </tr>
          </thead>
          <tbody className="text-sm">
            {/* RENT */}
            <tr className="border-b border-gray-100">
              <td className="py-3 font-bold">ค่าเช่าห้อง (Room Rent)</td>
              <td className="py-3 text-right text-gray-500">1 Month</td>
              <td className="py-3 text-right font-medium">{Number(invoice.rent_cost).toLocaleString()}</td>
            </tr>
            {/* ELECTRIC */}
            <tr className="border-b border-gray-100">
              <td className="py-3 font-bold">ค่าไฟฟ้า (Electricity)</td>
              <td className="py-3 text-right text-gray-500">{invoice.electric_units} Units x {invoice.unit_price_elec}</td>
              <td className="py-3 text-right font-medium">{Number(invoice.electric_cost).toLocaleString()}</td>
            </tr>
            {/* WATER */}
            <tr className="border-b border-gray-100">
              <td className="py-3 font-bold">ค่าน้ำ (Water)</td>
              <td className="py-3 text-right text-gray-500">{invoice.water_units} Units x {invoice.unit_price_water}</td>
              <td className="py-3 text-right font-medium">{Number(invoice.water_cost).toLocaleString()}</td>
            </tr>

            {/* COMMON FEE */}
            {invoice.common_fee > 0 && (
              <tr className="border-b border-gray-100">
                <td className="py-3 font-bold text-slate-800">{settings?.common_fee_label || 'Common Fee'}</td>
                <td className="py-3 text-right text-gray-500">Monthly</td>
                <td className="py-3 text-right font-medium text-slate-800">{Number(invoice.common_fee).toLocaleString()}</td>
              </tr>
            )}

            {/* OTHER FEES */}
            {invoice.other_fees > 0 && (
              <tr className="border-b border-gray-100 bg-gray-50">
                <td className="py-3 font-bold text-gray-800">ค่าอื่นๆ (Other Fees)</td>
                <td className="py-3 text-right text-gray-800 italic">{invoice.other_fees_description}</td>
                <td className="py-3 text-right font-medium text-gray-800">{Number(invoice.other_fees).toLocaleString()}</td>
              </tr>
            )}
            
            {/* LATE FEE */}
            {invoice.late_fee > 0 && (
              <tr className="border-b border-gray-100 bg-red-50">
                <td className="py-3 font-bold text-red-700">ค่าปรับล่าช้า (Late Fee)</td>
                <td className="py-3 text-right text-red-700 italic">{invoice.late_days} Days Overdue</td>
                <td className="py-3 text-right font-bold text-red-700">{Number(invoice.late_fee).toLocaleString()}</td>
              </tr>
            )}

            {/* DISCOUNT */}
            {invoice.discount > 0 && (
              <tr className="border-b border-gray-100 bg-green-50">
                <td className="py-3 font-bold text-green-700">ส่วนลด (Discount)</td>
                <td className="py-3 text-right text-green-700 italic">{invoice.discount_description}</td>
                <td className="py-3 text-right font-bold text-green-700">-{Number(invoice.discount).toLocaleString()}</td>
              </tr>
            )}
          </tbody>
        </table>

        {/* BOTTOM */}
        <div className="flex justify-end mb-12">
          <div className={`text-right border-t-2 ${borderClass} pt-2 w-1/2`}>
            <div className="flex justify-between items-end">
              <span className="font-bold text-gray-500 uppercase text-sm mr-8">Grand Total</span>
              <span className={`text-4xl font-black ${colorClass}`}>{Number(invoice.total_amount).toLocaleString()} <span className="text-lg">THB</span></span>
            </div>
          </div>
        </div>

        {/* FOOTER */}
        <div className="grid grid-cols-2 gap-12 mt-auto pt-12 border-t border-gray-200">
          <div>
            <h3 className="font-bold text-sm uppercase text-gray-400 mb-2">{isReceipt ? 'Note' : 'Payment Details'}</h3>
            {isReceipt ? <p className="text-sm text-gray-600">This document serves as an official receipt.</p> : (
               <div className="text-sm bg-gray-50 p-3 rounded-lg border border-gray-200">
                  {tenant?.payment_methods?.[0] ? (
                    <>
                      <p className="font-bold">{tenant.payment_methods[0].bank_name}</p>
                      <p>Acc: <span className="font-mono font-bold">{tenant.payment_methods[0].account_number}</span></p>
                      <p>{tenant.payment_methods[0].account_name}</p>
                    </>
                  ) : <p>Please contact admin for payment info.</p>}
               </div>
            )}
          </div>
          <div className="text-center mt-4">
            <div className="border-b border-gray-400 w-full h-8 mb-2"></div>
            <p className="font-bold text-sm">Authorized Signature</p>
            <p className="text-xs text-gray-400">({settings?.dorm_name || 'Admin'})</p>
          </div>
        </div>

      </div>
    </div>
  );
}