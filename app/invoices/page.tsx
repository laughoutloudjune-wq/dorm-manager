'use client';

import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import EditModal from './EditModal';
import InvoiceTemplate from './InvoiceTemplate';

export default function Invoices() {
  const [invoices, setInvoices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  
  // Modals
  const [editingInvoice, setEditingInvoice] = useState<any>(null);
  const [viewingSlip, setViewingSlip] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState<any>(null);
  
  // Payment Confirmation Modal
  const [confirmingPayment, setConfirmingPayment] = useState<any>(null);
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().split('T')[0]);

  // Filter
  const [selectedMonth, setSelectedMonth] = useState(new Date().getMonth() + 1);
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());

  useEffect(() => { fetchInvoices(); }, [selectedMonth, selectedYear]);

  const fetchInvoices = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('invoices')
      .select('*, rooms(room_number)')
      .eq('month', selectedMonth)
      .eq('year', selectedYear)
      .order('created_at', { ascending: false });

    const sortedData = (data || []).sort((a: any, b: any) => 
      (a.rooms?.room_number || '').localeCompare(b.rooms?.room_number || '', undefined, { numeric: true })
    );
    setInvoices(sortedData);
    setLoading(false);
  };

  const generateBills = async () => {
    // ... (Same generation logic as before, omitting to save space. Paste your generate logic here if needed) ...
    // Assuming standard generation logic:
    const { data: settings } = await supabase.from('settings').select('*').single();
    if (!settings) return alert("Please configure settings first");

    const { count } = await supabase.from('invoices').select('*', { count: 'exact', head: true }).eq('month', selectedMonth).eq('year', selectedYear);
    if (count && count > 0 && !confirm(`Warning: ${count} bills already exist. Generate missing?`)) return;

    const { data: readings } = await supabase.from('meter_readings').select('*').eq('month', selectedMonth).eq('year', selectedYear);
    if (!readings?.length) return alert(`No readings found for ${selectedMonth}/${selectedYear}`);

    const roomReadings: Record<string, any> = {};
    readings.forEach(r => {
      if (!roomReadings[r.room_id]) roomReadings[r.room_id] = { water: 0, electric: 0 };
      if (r.type === 'water') roomReadings[r.room_id].water = r.current_value;
      if (r.type === 'electric') roomReadings[r.room_id].electric = r.current_value;
    });

    const newInvoices = [];
    for (const roomId in roomReadings) {
      const { data: existing } = await supabase.from('invoices').select('id').eq('room_id', roomId).eq('month', selectedMonth).eq('year', selectedYear).single();
      if (existing) continue;

      const { data: roomData } = await supabase.from('rooms').select('default_rent').eq('id', roomId).single();
      const rent = roomData?.default_rent || 3500;
      
      const r = roomReadings[roomId];
      const waterUnits = r.water || 0;
      const elecUnits = r.electric || 0;
      
      const electricCost = elecUnits * (settings.elec_rate || 7);
      let waterCost = (waterUnits <= settings.water_min_units) ? (settings.water_min_price) : (settings.water_min_price + ((waterUnits - settings.water_min_units) * settings.water_excess_rate));
      
      const total = waterCost + electricCost + rent;

      newInvoices.push({
        room_id: roomId, month: selectedMonth, year: selectedYear,
        water_units: waterUnits, electric_units: elecUnits,
        unit_price_water: settings.water_excess_rate, unit_price_elec: settings.elec_rate,
        water_cost: waterCost, electric_cost: electricCost, rent_cost: rent,
        total_amount: total, payment_status: 'pending'
      });
    }

    if (newInvoices.length > 0) {
      await supabase.from('invoices').insert(newInvoices);
      fetchInvoices();
    } else {
      alert('All bills exist.');
    }
  };

  // --- NEW: Open Payment Confirmation Modal ---
  const requestApprove = (inv: any, e: any) => {
    e.stopPropagation();
    setConfirmingPayment(inv);
    setPaymentDate(new Date().toISOString().split('T')[0]); // Default to today
  };

  // --- NEW: Calculate Late Fee & Confirm ---
  const confirmApprove = async () => {
    if (!confirmingPayment) return;

    const { data: settings } = await supabase.from('settings').select('*').single();
    
    // 1. Calculate Late Days
    const payDateObj = new Date(paymentDate);
    const dueDateObj = new Date(selectedYear, selectedMonth - 1, settings?.due_day || 5);
    
    let lateFee = 0;
    let daysLate = 0;

    // Only charge late fee if paid AFTER due date
    if (payDateObj > dueDateObj) {
        const diffTime = Math.abs(payDateObj.getTime() - dueDateObj.getTime());
        daysLate = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
        lateFee = daysLate * (settings?.late_fee_amount || 0); // Per Day Logic
    }

    // 2. Update Invoice
    const newTotal = (confirmingPayment.total_amount || 0) + lateFee;

    await supabase.from('invoices').update({ 
        payment_status: 'paid',
        payment_date: paymentDate,
        late_fee: lateFee,
        late_days: daysLate,
        total_amount: newTotal
    }).eq('id', confirmingPayment.id);

    setConfirmingPayment(null);
    fetchInvoices();
  };

  const deleteInvoice = async (id: string, e: any) => {
    e.stopPropagation();
    if (confirm("Delete this bill?")) {
      await supabase.from('invoices').delete().eq('id', id);
      fetchInvoices();
    }
  };

  const openSlip = (url: string, e: any) => { e.stopPropagation(); setViewingSlip(url); };
  const handlePreview = async (inv: any, type: any, e: any) => {
    e.stopPropagation();
    const { data: settings } = await supabase.from('settings').select('*').single();
    const { data: tenant } = await supabase.from('tenants').select('name, address, payment_methods(bank_name, account_number, account_name)').eq('room_id', inv.room_id).eq('status', 'active').single();
    setPreviewData({ invoice: inv, tenant, settings, type });
  };
  const sendToLine = async (inv: any, e: any) => { /* Same as before... */ };

  return (
    <div className="p-8 bg-gray-50 min-h-screen">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-extrabold text-slate-900">🧾 Invoices</h1>
        <div className="flex gap-4">
           <div className="flex gap-2 bg-white p-1 rounded-lg border shadow-sm">
             <select value={selectedMonth} onChange={(e)=>setSelectedMonth(Number(e.target.value))} className="p-2 outline-none font-bold text-slate-800"><option value={1}>Jan</option><option value={2}>Feb</option></select>
             <select value={selectedYear} onChange={(e)=>setSelectedYear(Number(e.target.value))} className="p-2 outline-none font-bold text-slate-800"><option value={2026}>2026</option></select>
           </div>
           <button onClick={generateBills} className="bg-slate-900 text-white px-6 py-2 rounded-lg font-bold hover:bg-black shadow-md">+ Generate</button>
        </div>
      </div>

      {/* TABLE */}
      <div className="bg-white rounded-xl shadow-md border border-gray-200 overflow-hidden">
        <table className="w-full text-left">
          <thead className="bg-slate-100 border-b text-sm uppercase font-extrabold text-slate-700">
            <tr>
              <th className="p-4 w-32">Status</th>
              <th className="p-4 w-24">Room</th>
              <th className="p-4 w-32">Period</th>
              <th className="p-4 text-right w-32">Amount</th>
              <th className="p-4 text-center w-24">Slip</th>
              <th className="p-4 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {invoices.map((inv) => (
              <tr key={inv.id} onClick={() => setEditingInvoice(inv)} className="hover:bg-blue-50 cursor-pointer transition-colors group">
                <td className="p-4">
                  <div className={`inline-flex items-center px-2.5 py-1.5 rounded-full text-xs font-bold border ${inv.payment_status==='paid'?'bg-green-100 text-green-700 border-green-200':inv.payment_status==='verification_pending'?'bg-orange-100 text-orange-700 border-orange-200':'bg-gray-100 text-gray-600 border-gray-200'}`}>
                    {inv.payment_status.toUpperCase()}
                  </div>
                </td>
                <td className="p-4 font-black text-slate-800 text-xl">{inv.rooms?.room_number}</td>
                <td className="p-4 text-slate-600 font-bold">{inv.month}/{inv.year}</td>
                <td className="p-4 text-right font-mono font-black text-slate-900 text-xl">{inv.total_amount.toLocaleString()} ฿</td>
                <td className="p-4 text-center">{inv.slip_url ? <button onClick={(e) => openSlip(inv.slip_url, e)} className="text-blue-600 font-bold underline">View</button> : '-'}</td>
                <td className="p-4 text-right">
                   <div className="flex justify-end gap-2">
                     {inv.payment_status !== 'paid' && <button onClick={(e)=>requestApprove(inv, e)} className="bg-green-50 text-green-700 px-3 py-1.5 rounded border border-green-200 font-bold text-xs">✅ Approve</button>}
                     {inv.payment_status === 'paid' && <button onClick={(e)=>handlePreview(inv, 'RECEIPT', e)} className="bg-green-600 text-white px-3 py-1.5 rounded border border-green-700 font-bold text-xs">🧾 Receipt</button>}
                     <button onClick={(e)=>handlePreview(inv, 'INVOICE', e)} className="bg-white text-slate-700 px-3 py-1.5 rounded border border-gray-300 font-bold text-xs">📄 PDF</button>
                     <button onClick={(e)=>deleteInvoice(inv.id, e)} className="bg-white text-red-600 px-3 py-1.5 rounded border border-red-200 font-bold text-xs">🗑️</button>
                   </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editingInvoice && <EditModal invoice={editingInvoice} onClose={()=>setEditingInvoice(null)} onSave={fetchInvoices}/>}
      <InvoiceTemplate data={previewData} settings={previewData?.settings} onClose={() => setPreviewData(null)} />
      
      {/* PAYMENT CONFIRM MODAL */}
      {confirmingPayment && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-xl p-6 w-full max-w-sm shadow-2xl">
                <h3 className="text-xl font-bold mb-4">Confirm Payment</h3>
                <p className="text-sm text-gray-600 mb-2">Room: {confirmingPayment.rooms?.room_number}</p>
                
                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Payment Date</label>
                <input 
                    type="date" 
                    value={paymentDate} 
                    onChange={(e)=>setPaymentDate(e.target.value)} 
                    className="w-full border-2 border-slate-300 p-2 rounded-lg font-bold text-lg mb-4"
                />

                <div className="flex gap-2">
                    <button onClick={()=>setConfirmingPayment(null)} className="flex-1 py-3 bg-gray-100 font-bold rounded-lg">Cancel</button>
                    <button onClick={confirmApprove} className="flex-1 py-3 bg-green-600 text-white font-bold rounded-lg shadow-lg">Confirm & Calculate</button>
                </div>
            </div>
        </div>
      )}

      {viewingSlip && <div className="fixed inset-0 bg-black/80 z-[60] flex items-center justify-center p-4" onClick={() => setViewingSlip(null)}><img src={viewingSlip} className="max-h-[90vh] bg-white rounded-lg" /></div>}
    </div>
  );
}