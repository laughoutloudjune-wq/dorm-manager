'use client';

import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import EditModal from './EditModal';
import InvoiceTemplate from './InvoiceTemplate'; // <--- IMPORT THIS

export default function Invoices() {
  const [invoices, setInvoices] = useState<any[]>([]);
  // ... (keep your existing state: loading, selectedMonth, etc.) ...
  const [loading, setLoading] = useState(true);
  const [editingInvoice, setEditingInvoice] = useState<any>(null);
  const [viewingSlip, setViewingSlip] = useState<string | null>(null);
  const [selectedMonth, setSelectedMonth] = useState(new Date().getMonth() + 1);
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
  
  // NEW STATE for Preview
  const [previewData, setPreviewData] = useState<any>(null);

  useEffect(() => { fetchInvoices(); }, [selectedMonth, selectedYear]);

  // ... (keep fetchInvoices, generateBills, approvePayment, deleteInvoice, openSlip as they are) ...
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
    // ... (Keep existing code) ...
    // Just to save space in chat, assume this is your existing generateBills code
    const { data: settings } = await supabase.from('settings').select('*').single();
    const elecRate = settings?.elec_rate || 7;
    const waterMinUnits = settings?.water_min_units || 10;
    const waterMinPrice = settings?.water_min_price || 150;
    const waterExcessRate = settings?.water_excess_rate || 17;

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
      
      const electricCost = elecUnits * elecRate;
      let waterCost = (waterUnits <= waterMinUnits) ? (waterUnits > 0 ? waterMinPrice : 0) : (waterMinPrice + ((waterUnits - waterMinUnits) * waterExcessRate));
      
      const total = waterCost + electricCost + rent;

      newInvoices.push({
        room_id: roomId, month: selectedMonth, year: selectedYear,
        water_units: waterUnits, electric_units: elecUnits,
        unit_price_water: waterExcessRate, unit_price_elec: elecRate,
        water_cost: waterCost, electric_cost: electricCost, rent_cost: rent,
        total_amount: total, payment_status: 'pending'
      });
    }

    if (newInvoices.length > 0) {
      await supabase.from('invoices').insert(newInvoices);
      alert(`Generated ${newInvoices.length} bills.`);
      fetchInvoices();
    } else {
      alert('All bills already exist.');
    }
  };

  const approvePayment = async (invId: string, e: any) => {
    e.stopPropagation(); 
    if (confirm("Mark as PAID?")) {
      await supabase.from('invoices').update({ payment_status: 'paid' }).eq('id', invId);
      fetchInvoices();
    }
  };

  const deleteInvoice = async (id: string, e: any) => {
    e.stopPropagation();
    if (confirm("Delete this bill?")) {
      await supabase.from('invoices').delete().eq('id', id);
      fetchInvoices();
    }
  };

  const openSlip = (url: string, e: any) => {
    e.stopPropagation();
    setViewingSlip(url);
  };

  const sendToLine = async (inv: any, e: any) => {
    e.stopPropagation();
    const { data: tenant } = await supabase.from('tenants').select('line_user_id, name').eq('room_id', inv.room_id).eq('status', 'active').single();
    if (!tenant?.line_user_id) return alert("⚠️ No LINE account linked.");
    if (confirm(`Send digital bill to Room ${inv.rooms?.room_number} (${tenant.name})?`)) {
         try {
            await fetch('/api/send-invoice', {
                method: 'POST',
                body: JSON.stringify({
                    userId: tenant.line_user_id,
                    roomNumber: inv.rooms?.room_number,
                    month: inv.month, year: inv.year,
                    rent: inv.rent_cost.toLocaleString(),
                    waterUnit: inv.water_units, waterPrice: inv.water_cost.toLocaleString(),
                    elecUnit: inv.electric_units, elecPrice: inv.electric_cost.toLocaleString(),
                    total: inv.total_amount.toLocaleString()
                })
            });
            alert('✅ Sent!');
        } catch (err) { alert('Error sending'); }
    }
  };

  // --- UPDATED PRINT FUNCTION ---
  const handlePreview = async (inv: any, type: 'INVOICE' | 'RECEIPT', e: any) => {
    e.stopPropagation();
    
    // 1. Fetch settings and tenant details
    const { data: settings } = await supabase.from('settings').select('*').single();
    const { data: tenant } = await supabase.from('tenants')
      .select('name, address, payment_methods(bank_name, account_number, account_name)')
      .eq('room_id', inv.room_id).eq('status', 'active').single();

    // 2. Open Preview Modal
    setPreviewData({
        invoice: inv,
        tenant: tenant,
        settings: settings,
        type: type
    });
  };

  return (
    <div className="p-8 bg-gray-50 min-h-screen">
      {/* HEADER */}
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
              <tr 
                key={inv.id} 
                onClick={() => setEditingInvoice(inv)} 
                className="hover:bg-blue-50 cursor-pointer transition-colors group"
              >
                <td className="p-4">
                  <div className={`inline-flex items-center px-2.5 py-1.5 rounded-full text-xs font-bold border
                    ${inv.payment_status==='paid' ? 'bg-green-100 text-green-700 border-green-200' : 
                      inv.payment_status==='verification_pending' ? 'bg-orange-100 text-orange-700 border-orange-200' : 
                      'bg-gray-100 text-gray-600 border-gray-200'}`}>
                    <span className={`w-2 h-2 rounded-full mr-2 
                      ${inv.payment_status==='paid' ? 'bg-green-500' : 
                        inv.payment_status==='verification_pending' ? 'bg-orange-500' : 'bg-gray-400'}`}></span>
                    {inv.payment_status === 'verification_pending' ? 'CHECK SLIP' : inv.payment_status.toUpperCase()}
                  </div>
                </td>
                
                <td className="p-4 font-black text-slate-800 text-xl">{inv.rooms?.room_number}</td>
                <td className="p-4 text-slate-600 font-bold">{inv.month}/{inv.year}</td>
                <td className="p-4 text-right font-mono font-black text-slate-900 text-xl">{inv.total_amount.toLocaleString()} ฿</td>
                
                <td className="p-4 text-center">
                    {inv.slip_url ? (
                        <button onClick={(e) => openSlip(inv.slip_url, e)} className="text-blue-600 hover:text-blue-800 font-bold text-sm underline">View</button>
                    ) : <span className="text-gray-300">-</span>}
                </td>

                <td className="p-4 text-right">
                   <div className="flex justify-end gap-2">
                     {inv.payment_status !== 'paid' && (
                       <button onClick={(e)=>approvePayment(inv.id, e)} className="flex items-center gap-1 bg-green-50 hover:bg-green-100 text-green-700 px-3 py-1.5 rounded-lg border border-green-200 transition-all font-bold text-xs">✅ Approve</button>
                     )}
                     
                     {/* IF PAID: Show RECEIPT */}
                     {inv.payment_status === 'paid' && (
                       <button onClick={(e)=>handlePreview(inv, 'RECEIPT', e)} className="flex items-center gap-1 bg-green-600 hover:bg-green-700 text-white px-3 py-1.5 rounded-lg border border-green-700 transition-all font-bold text-xs shadow-sm">
                         🧾 Receipt
                       </button>
                     )}

                     {/* ALWAYS: Show INVOICE */}
                     <button onClick={(e)=>handlePreview(inv, 'INVOICE', e)} className="flex items-center gap-1 bg-white hover:bg-gray-50 text-slate-700 px-3 py-1.5 rounded-lg border border-gray-300 transition-all font-bold text-xs">
                       📄 PDF
                     </button>
                     
                     <button onClick={(e)=>sendToLine(inv, e)} className="flex items-center gap-1 bg-white hover:bg-green-50 text-green-600 px-3 py-1.5 rounded-lg border border-green-200 transition-all font-bold text-xs">
                       💬 Line
                     </button>

                     <button onClick={(e)=>deleteInvoice(inv.id, e)} className="flex items-center gap-1 bg-white hover:bg-red-50 text-red-600 px-3 py-1.5 rounded-lg border border-red-200 transition-all font-bold text-xs">
                       🗑️ Del
                     </button>
                   </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* EDIT MODAL */}
      {editingInvoice && <EditModal invoice={editingInvoice} onClose={()=>setEditingInvoice(null)} onSave={fetchInvoices}/>}

      {/* PREVIEW MODAL (This is where the magic happens) */}
      <InvoiceTemplate 
        data={previewData} 
        settings={previewData?.settings} 
        onClose={() => setPreviewData(null)} 
      />

      {/* SLIP MODAL */}
      {viewingSlip && (
        <div className="fixed inset-0 bg-black/80 z-[60] flex items-center justify-center p-4" onClick={() => setViewingSlip(null)}>
            <div className="relative max-w-2xl w-full">
                <img src={viewingSlip} alt="Payment Slip" className="rounded-lg shadow-2xl w-full max-h-[90vh] object-contain bg-white" />
                <button className="absolute -top-4 -right-4 bg-white text-black rounded-full w-8 h-8 font-bold flex items-center justify-center shadow-lg hover:bg-gray-200">✕</button>
            </div>
        </div>
      )}
    </div>
  );
}