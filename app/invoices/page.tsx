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
  const [sendingId, setSendingId] = useState<string | null>(null);
  
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
    const { data: settings } = await supabase.from('settings').select('*').single();
    if (!settings) return alert("Please configure settings first");

    // 1. Get Occupied Rooms ONLY
    const { data: occupiedRooms } = await supabase.from('rooms').select('*').eq('status', 'occupied');
    if (!occupiedRooms || occupiedRooms.length === 0) return alert("No occupied rooms to bill.");

    // Check for existing bills
    const { count } = await supabase.from('invoices').select('*', { count: 'exact', head: true }).eq('month', selectedMonth).eq('year', selectedYear);
    if (count && count > 0 && !confirm(`Warning: ${count} bills already exist. Generate missing?`)) return;

    // 2. Fetch Data needed for calculation
    // A. Current Month Readings
    const { data: currentReadings } = await supabase.from('meter_readings')
        .select('*')
        .eq('month', selectedMonth)
        .eq('year', selectedYear);
    
    if (!currentReadings?.length) return alert(`No meter readings found for ${selectedMonth}/${selectedYear}`);

    // B. Previous Month Readings (Logic: Curr - 1)
    let prevM = selectedMonth - 1;
    let prevY = selectedYear;
    if (prevM === 0) { prevM = 12; prevY = selectedYear - 1; }

    const { data: previousReadings } = await supabase.from('meter_readings')
        .select('*')
        .eq('month', prevM)
        .eq('year', prevY);

    // C. Tenant Initial Readings (For new tenants who have no prev month reading)
    const { data: tenants } = await supabase.from('tenants').select('*').eq('status', 'active');

    const newInvoices = [];
    
    for (const room of occupiedRooms) {
      const roomId = room.id;

      // Skip if invoice exists
      const { data: existing } = await supabase.from('invoices').select('id').eq('room_id', roomId).eq('month', selectedMonth).eq('year', selectedYear).single();
      if (existing) continue;

      // --- UTILITY CALCULATION LOGIC ---
      const tenant = tenants?.find(t => t.room_id === roomId);
      
      // Electric
      const currElec = currentReadings.find(r => r.room_id === roomId && r.type === 'electric')?.current_value;
      const prevElecMeter = previousReadings?.find(r => r.room_id === roomId && r.type === 'electric')?.current_value;
      const initialElec = tenant?.initial_elec || 0;
      
      // If we have a previous month reading, use it. If not, use the Tenant's Initial Reading.
      const startElec = (prevElecMeter !== undefined && prevElecMeter !== null) ? prevElecMeter : initialElec;
      const elecUnits = (currElec !== undefined) ? Math.max(0, currElec - startElec) : 0;

      // Water
      const currWater = currentReadings.find(r => r.room_id === roomId && r.type === 'water')?.current_value;
      const prevWaterMeter = previousReadings?.find(r => r.room_id === roomId && r.type === 'water')?.current_value;
      const initialWater = tenant?.initial_water || 0;

      const startWater = (prevWaterMeter !== undefined && prevWaterMeter !== null) ? prevWaterMeter : initialWater;
      const waterUnits = (currWater !== undefined) ? Math.max(0, currWater - startWater) : 0;
      // ---------------------------------

      // Price Calc
      const electricCost = elecUnits * (settings.elec_rate || 7);
      let waterCost = 0;
      if (waterUnits <= settings.water_min_units) {
          waterCost = settings.water_min_price;
      } else {
          waterCost = settings.water_min_price + ((waterUnits - settings.water_min_units) * settings.water_excess_rate);
      }
      
      const rent = room.default_rent || 3500;
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
      const { error } = await supabase.from('invoices').insert(newInvoices);
      if (error) alert("Error creating bills: " + error.message);
      else {
        alert(`✅ Generated ${newInvoices.length} bills successfully!`);
        fetchInvoices();
      }
    } else {
      alert('All occupied rooms already have bills or missing readings.');
    }
  };

  // --- RESTORED: SEND TO LINE FUNCTION ---
  const sendToLine = async (inv: any, e: any) => {
    e.stopPropagation();
    if (!confirm(`Confirm send invoice for Room ${inv.rooms?.room_number} to LINE?`)) return;

    setSendingId(inv.id);

    try {
        // 1. Check Tenant LINE ID
        const { data: tenant } = await supabase
            .from('tenants')
            .select('line_user_id, name')
            .eq('room_id', inv.room_id)
            .eq('status', 'active')
            .single();
        
        if (!tenant || !tenant.line_user_id) {
            alert("❌ Tenant has not connected LINE account.");
            setSendingId(null);
            return;
        }

        // 2. Call API
        const res = await fetch('/api/send-invoice', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: tenant.line_user_id,
                roomId: inv.room_id,
                roomNumber: inv.rooms?.room_number,
                month: inv.month,
                year: inv.year,
                rent: inv.rent_cost,
                waterUnit: inv.water_units,
                waterPrice: inv.water_cost,
                elecUnit: inv.electric_units,
                elecPrice: inv.electric_cost,
                total: inv.total_amount
            })
        });

        const result = await res.json();
        if (result.success) {
            alert("✅ Invoice sent successfully!");
        } else {
            alert("❌ Failed: " + result.error);
        }

    } catch (err: any) {
        alert("❌ Error: " + err.message);
    } finally {
        setSendingId(null);
    }
  };

  const requestApprove = (inv: any, e: any) => {
    e.stopPropagation();
    setConfirmingPayment(inv);
    setPaymentDate(new Date().toISOString().split('T')[0]); 
  };

  const confirmApprove = async () => {
    if (!confirmingPayment) return;
    const { data: settings } = await supabase.from('settings').select('*').single();
    
    // Late Fee Logic (Per Day)
    const payDateObj = new Date(paymentDate);
    const dueDateObj = new Date(selectedYear, selectedMonth - 1, settings?.due_day || 5);
    
    let lateFee = 0;
    let daysLate = 0;

    if (payDateObj > dueDateObj) {
        const diffTime = Math.abs(payDateObj.getTime() - dueDateObj.getTime());
        daysLate = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
        lateFee = daysLate * (settings?.late_fee_amount || 0); 
    }

    const newTotal = (confirmingPayment.total_amount || 0) + lateFee;

    await supabase.from('invoices').update({ 
        payment_status: 'paid', payment_date: paymentDate,
        late_fee: lateFee, late_days: daysLate, total_amount: newTotal
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

  return (
    <div className="p-8 bg-gray-50 min-h-screen">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-extrabold text-slate-900">🧾 Invoices</h1>
        <div className="flex gap-4">
           <div className="flex gap-2 bg-white p-1 rounded-lg border shadow-sm">
             <select value={selectedMonth} onChange={(e)=>setSelectedMonth(Number(e.target.value))} className="p-2 outline-none font-bold text-slate-800">
               {[1,2,3,4,5,6,7,8,9,10,11,12].map(m => <option key={m} value={m}>{new Date(0, m-1).toLocaleString('default', { month: 'short' })}</option>)}
             </select>
             <select value={selectedYear} onChange={(e)=>setSelectedYear(Number(e.target.value))} className="p-2 outline-none font-bold text-slate-800"><option value={2026}>2026</option><option value={2027}>2027</option></select>
           </div>
           <button onClick={generateBills} className="bg-slate-900 text-white px-6 py-2 rounded-lg font-bold hover:bg-black shadow-md">+ Generate</button>
        </div>
      </div>

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
                
                {/* ACTIONS */}
                <td className="p-4 text-right">
                   <div className="flex justify-end gap-2">
                     {/* RESTORED: SEND LINE BUTTON */}
                     <button onClick={(e) => sendToLine(inv, e)} disabled={sendingId === inv.id} className="bg-green-50 text-green-700 px-3 py-1.5 rounded border border-green-200 font-bold text-xs hover:bg-green-100 transition-colors">
                        {sendingId === inv.id ? 'Sending...' : '💬 LINE'}
                     </button>

                     {inv.payment_status !== 'paid' && <button onClick={(e)=>requestApprove(inv, e)} className="bg-blue-50 text-blue-700 px-3 py-1.5 rounded border border-blue-200 font-bold text-xs hover:bg-blue-100">✅ Approve</button>}
                     
                     {inv.payment_status === 'paid' && <button onClick={(e)=>handlePreview(inv, 'RECEIPT', e)} className="bg-green-600 text-white px-3 py-1.5 rounded border border-green-700 font-bold text-xs hover:bg-green-700">🧾 Receipt</button>}
                     
                     <button onClick={(e)=>handlePreview(inv, 'INVOICE', e)} className="bg-white text-slate-700 px-3 py-1.5 rounded border border-gray-300 font-bold text-xs hover:bg-gray-50">📄 PDF</button>
                     
                     <button onClick={(e)=>deleteInvoice(inv.id, e)} className="bg-white text-red-600 px-3 py-1.5 rounded border border-red-200 font-bold text-xs hover:bg-red-50">🗑️</button>
                   </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editingInvoice && <EditModal invoice={editingInvoice} onClose={()=>setEditingInvoice(null)} onSave={fetchInvoices}/>}
      <InvoiceTemplate data={previewData} settings={previewData?.settings} onClose={() => setPreviewData(null)} />
      
      {confirmingPayment && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-xl p-6 w-full max-w-sm shadow-2xl">
                <h3 className="text-xl font-bold mb-4">Confirm Payment</h3>
                <p className="text-sm text-gray-600 mb-2">Room: {confirmingPayment.rooms?.room_number}</p>
                
                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Payment Date</label>
                <input type="date" value={paymentDate} onChange={(e)=>setPaymentDate(e.target.value)} className="w-full border-2 border-slate-300 p-2 rounded-lg font-bold text-lg mb-4" />

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