'use client';

import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import EditModal from './EditModal';
import InvoiceTemplate from './InvoiceTemplate';

export default function Invoices() {
  const [invoices, setInvoices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  
  // Selection & Bulk Actions
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isBulkSending, setIsBulkSending] = useState(false);

  // Generation Progress
  const [isGenerating, setIsGenerating] = useState(false);
  const [genProgress, setGenProgress] = useState(0);

  // Modals
  const [editingInvoice, setEditingInvoice] = useState<any>(null);
  const [viewingSlip, setViewingSlip] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState<any>(null);
  const [sendingId, setSendingId] = useState<string | null>(null);
  
  // Payment Confirmation
  const [confirmingPayment, setConfirmingPayment] = useState<any>(null);
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().split('T')[0]);

  // Filter
  const [selectedMonth, setSelectedMonth] = useState(new Date().getMonth() + 1);
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());

  useEffect(() => { fetchInvoices(); }, [selectedMonth, selectedYear]);

  const fetchInvoices = async () => {
    setLoading(true);
    setSelectedIds(new Set()); 
    
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

  // --- GROUPING ---
  const getBuilding = (roomNumber: string) => {
      if (!roomNumber) return 'Other';
      if (roomNumber.endsWith('/1')) return 'Building 1';
      if (roomNumber.endsWith('/2')) return 'Building 2';
      return 'Other';
  };

  const groupedInvoices = invoices.reduce((groups: any, inv: any) => {
      const b = getBuilding(inv.rooms?.room_number || '');
      if (!groups[b]) groups[b] = [];
      groups[b].push(inv);
      return groups;
  }, {});

  // --- SELECTION ---
  const toggleSelect = (id: string) => {
      const newSet = new Set(selectedIds);
      if (newSet.has(id)) newSet.delete(id);
      else newSet.add(id);
      setSelectedIds(newSet);
  };

  const toggleSelectGroup = (groupInvoices: any[]) => {
      const groupIds = groupInvoices.map(i => i.id);
      const allSelected = groupIds.every(id => selectedIds.has(id));
      const newSet = new Set(selectedIds);
      if (allSelected) groupIds.forEach(id => newSet.delete(id));
      else groupIds.forEach(id => newSet.add(id));
      setSelectedIds(newSet);
  };

  // --- BULK ACTIONS ---
  const bulkDelete = async () => {
      if (!confirm(`⚠️ Delete ${selectedIds.size} selected invoices?`)) return;
      await supabase.from('invoices').delete().in('id', Array.from(selectedIds));
      fetchInvoices();
  };

  const bulkSendLine = async () => {
      if (!confirm(`Confirm send ${selectedIds.size} invoices to LINE?`)) return;
      setIsBulkSending(true);
      let sentCount = 0;
      let skippedCount = 0;
      let failCount = 0;
      const idsToProcess = Array.from(selectedIds);
      const { data: activeTenants } = await supabase.from('tenants').select('room_id, line_user_id').eq('status', 'active');

      for (const id of idsToProcess) {
          const inv = invoices.find(i => i.id === id);
          if (!inv) continue;
          const tenant = activeTenants?.find(t => t.room_id === inv.room_id);

          if (!tenant || !tenant.line_user_id) {
              skippedCount++;
              continue;
          }
          try {
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
                      commonFee: inv.common_fee || 0,
                      total: inv.total_amount
                  })
              });
              const result = await res.json();
              if (result.success) sentCount++; else failCount++;
          } catch (err) { failCount++; }
      }
      setIsBulkSending(false);
      alert(`✅ Bulk Send Complete!\n\nSent: ${sentCount}\nSkipped (No LINE): ${skippedCount}\nFailed: ${failCount}`);
  };

  // --- GENERATE BILLS (OPTIMIZED WITH PROGRESS) ---
  const generateBills = async () => {
    const { data: settings } = await supabase.from('settings').select('*').single();
    if (!settings) return alert("Please configure settings first");

    const { data: occupiedRooms } = await supabase.from('rooms').select('*').eq('status', 'occupied');
    if (!occupiedRooms || occupiedRooms.length === 0) return alert("No occupied rooms to bill.");

    const { count } = await supabase.from('invoices').select('*', { count: 'exact', head: true }).eq('month', selectedMonth).eq('year', selectedYear);
    if (count && count > 0 && !confirm(`Warning: ${count} bills already exist. Generate missing?`)) return;

    // START PROGRESS
    setIsGenerating(true);
    setGenProgress(10); // Initializing

    // A. Current Readings
    const { data: currentReadings } = await supabase.from('meter_readings').select('*').eq('month', selectedMonth).eq('year', selectedYear);
    if (!currentReadings?.length) {
        setIsGenerating(false);
        return alert(`No meter readings found for ${selectedMonth}/${selectedYear}`);
    }
    setGenProgress(30); // Fetched Current

    // B. Previous Readings
    let prevM = selectedMonth - 1;
    let prevY = selectedYear;
    if (prevM === 0) { prevM = 12; prevY = selectedYear - 1; }
    const { data: previousReadings } = await supabase.from('meter_readings').select('*').eq('month', prevM).eq('year', prevY);
    setGenProgress(50); // Fetched Previous

    // C. Tenants & Existing Invoices (Optimization: Fetch ALL existing IDs first)
    const { data: tenants } = await supabase.from('tenants').select('*').eq('status', 'active');
    const { data: existingInvoices } = await supabase.from('invoices').select('room_id').eq('month', selectedMonth).eq('year', selectedYear);
    const existingRoomIds = new Set(existingInvoices?.map(i => i.room_id));
    
    setGenProgress(70); // Fetched Tenants

    const newInvoices = [];
    
    for (const room of occupiedRooms) {
      if (existingRoomIds.has(room.id)) continue; // Skip existing (Fast check)

      const tenant = tenants?.find(t => t.room_id === room.id);
      
      // Electric
      const currElec = currentReadings.find(r => r.room_id === room.id && r.type === 'electric')?.current_value;
      const prevElecMeter = previousReadings?.find(r => r.room_id === room.id && r.type === 'electric')?.current_value;
      const initialElec = tenant?.initial_elec || 0;
      const startElec = (prevElecMeter !== undefined) ? prevElecMeter : initialElec;
      const elecUnits = (currElec !== undefined) ? Math.max(0, currElec - startElec) : 0;

      // Water
      const currWater = currentReadings.find(r => r.room_id === room.id && r.type === 'water')?.current_value;
      const prevWaterMeter = previousReadings?.find(r => r.room_id === room.id && r.type === 'water')?.current_value;
      const initialWater = tenant?.initial_water || 0;
      const startWater = (prevWaterMeter !== undefined) ? prevWaterMeter : initialWater;
      const waterUnits = (currWater !== undefined) ? Math.max(0, currWater - startWater) : 0;

      // Costs
      const electricCost = elecUnits * (settings.elec_rate || 7);
      let waterCost = 0;
      if (waterUnits <= settings.water_min_units) {
          waterCost = settings.water_min_price;
      } else {
          waterCost = settings.water_min_price + ((waterUnits - settings.water_min_units) * settings.water_excess_rate);
      }
      
      const rent = room.default_rent || 3500;
      const commonFee = Number(settings.common_fee || 0);
      const total = waterCost + electricCost + rent + commonFee;

      newInvoices.push({
        room_id: room.id, month: selectedMonth, year: selectedYear,
        water_units: waterUnits, electric_units: elecUnits,
        unit_price_water: settings.water_excess_rate, unit_price_elec: settings.elec_rate,
        water_cost: waterCost, electric_cost: electricCost, rent_cost: rent, common_fee: commonFee,
        total_amount: total, payment_status: 'pending'
      });
    }

    setGenProgress(90); // Calculated

    if (newInvoices.length > 0) {
      await supabase.from('invoices').insert(newInvoices);
      setGenProgress(100);
      setTimeout(() => {
          setIsGenerating(false);
          alert(`✅ Generated ${newInvoices.length} bills successfully!`);
          fetchInvoices();
      }, 500);
    } else {
      setIsGenerating(false);
      alert('All occupied rooms already have bills.');
    }
  };

  // --- SINGLE ACTIONS ---
  const sendToLine = async (inv: any, e: any) => {
    e.stopPropagation();
    if (!confirm(`Confirm send invoice for Room ${inv.rooms?.room_number} to LINE?`)) return;
    setSendingId(inv.id);
    try {
        const { data: tenant } = await supabase.from('tenants').select('line_user_id').eq('room_id', inv.room_id).eq('status', 'active').single();
        if (!tenant || !tenant.line_user_id) {
            alert("❌ Tenant has not connected LINE account.");
            setSendingId(null);
            return;
        }
        const res = await fetch('/api/send-invoice', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: tenant.line_user_id, roomId: inv.room_id, roomNumber: inv.rooms?.room_number,
                month: inv.month, year: inv.year, rent: inv.rent_cost, waterUnit: inv.water_units,
                waterPrice: inv.water_cost, elecUnit: inv.electric_units, elecPrice: inv.electric_cost,
                commonFee: inv.common_fee || 0, total: inv.total_amount
            })
        });
        const result = await res.json();
        if (result.success) alert("✅ Sent!"); else alert("❌ Failed: " + result.error);
    } catch (err: any) { alert("❌ Error: " + err.message); } finally { setSendingId(null); }
  };

  const requestApprove = (inv: any, e: any) => {
    e.stopPropagation();
    setConfirmingPayment(inv);
    setPaymentDate(new Date().toISOString().split('T')[0]); 
  };

  const confirmApprove = async () => {
    if (!confirmingPayment) return;
    const { data: settings } = await supabase.from('settings').select('*').single();
    const payDateObj = new Date(paymentDate);
    const dueDateObj = new Date(selectedYear, selectedMonth - 1, settings?.due_day || 5);
    let lateFee = 0; let daysLate = 0;
    if (payDateObj > dueDateObj) {
        const diffTime = Math.abs(payDateObj.getTime() - dueDateObj.getTime());
        daysLate = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
        lateFee = daysLate * (settings?.late_fee_amount || 0); 
    }
    const newTotal = (confirmingPayment.total_amount || 0) + lateFee;
    await supabase.from('invoices').update({ payment_status: 'paid', payment_date: paymentDate, late_fee: lateFee, late_days: daysLate, total_amount: newTotal }).eq('id', confirmingPayment.id);
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
    <div className="p-8 bg-gray-50 min-h-screen relative pb-24">
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

      {/* RENDER GROUPS */}
      {['Building 1', 'Building 2', 'Other'].map(groupName => {
         const groupInvoices = groupedInvoices[groupName] || [];
         if (groupInvoices.length === 0) return null;
         const allSelected = groupInvoices.every((inv: any) => selectedIds.has(inv.id));

         return (
            <div key={groupName} className="mb-10">
                <div className="flex items-center gap-3 mb-4 bg-slate-200 p-3 rounded-lg w-fit shadow-sm">
                    <input type="checkbox" checked={allSelected} onChange={() => toggleSelectGroup(groupInvoices)} className="w-5 h-5 accent-slate-900 cursor-pointer" />
                    <h2 className="text-lg font-black text-slate-800 uppercase tracking-widest">{groupName}</h2>
                    <span className="bg-white px-3 rounded-full text-xs font-bold text-slate-500">{groupInvoices.length} Bills</span>
                </div>
                <div className="bg-white rounded-xl shadow-md border border-gray-200 overflow-hidden">
                    <table className="w-full text-left">
                    <thead className="bg-slate-50 border-b text-sm uppercase font-extrabold text-slate-500">
                        <tr>
                        <th className="p-4 w-10"></th>
                        <th className="p-4 w-32">Status</th>
                        <th className="p-4 w-24">Room</th>
                        <th className="p-4 w-32">Period</th>
                        <th className="p-4 text-right w-32">Amount</th>
                        <th className="p-4 text-center w-24">Slip</th>
                        <th className="p-4 text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                        {groupInvoices.map((inv: any) => (
                        <tr key={inv.id} onClick={() => setEditingInvoice(inv)} className={`cursor-pointer transition-colors group ${selectedIds.has(inv.id) ? 'bg-blue-50' : 'hover:bg-gray-50'}`}>
                            <td className="p-4" onClick={e => e.stopPropagation()}><input type="checkbox" checked={selectedIds.has(inv.id)} onChange={() => toggleSelect(inv.id)} className="w-5 h-5 accent-blue-600 cursor-pointer" /></td>
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
                                <button onClick={(e) => sendToLine(inv, e)} disabled={sendingId === inv.id} className="bg-green-50 text-green-700 px-3 py-1.5 rounded border border-green-200 font-bold text-xs hover:bg-green-100 transition-colors">{sendingId === inv.id ? '...' : '💬 LINE'}</button>
                                {inv.payment_status !== 'paid' && <button onClick={(e)=>requestApprove(inv, e)} className="bg-blue-50 text-blue-700 px-3 py-1.5 rounded border border-blue-200 font-bold text-xs hover:bg-blue-100">✅ Approve</button>}
                                {inv.payment_status === 'paid' && <button onClick={(e)=>handlePreview(inv, 'RECEIPT', e)} className="bg-green-600 text-white px-3 py-1.5 rounded border border-green-700 font-bold text-xs hover:bg-green-700">🧾 Receipt</button>}
                                <button onClick={(e)=>handlePreview(inv, 'INVOICE', e)} className="bg-white text-slate-700 px-3 py-1.5 rounded border border-gray-300 font-bold text-xs hover:bg-gray-50">📄</button>
                                <button onClick={(e)=>deleteInvoice(inv.id, e)} className="bg-white text-red-600 px-3 py-1.5 rounded border border-red-200 font-bold text-xs hover:bg-red-50">🗑️</button>
                            </div>
                            </td>
                        </tr>
                        ))}
                    </tbody>
                    </table>
                </div>
            </div>
         );
      })}

      {selectedIds.size > 0 && (
          <div className="fixed bottom-6 left-1/2 transform -translate-x-1/2 bg-slate-900 text-white px-6 py-4 rounded-2xl shadow-2xl flex items-center gap-6 z-40">
              <div className="font-bold text-lg flex items-center gap-2"><span className="bg-blue-500 text-white text-xs px-2 py-1 rounded-full">{selectedIds.size}</span>Selected</div>
              <div className="h-8 w-[1px] bg-slate-700"></div>
              <div className="flex gap-3">
                  <button onClick={bulkSendLine} disabled={isBulkSending} className="bg-green-600 hover:bg-green-500 px-5 py-2 rounded-lg font-bold transition-all flex items-center gap-2">{isBulkSending ? 'Sending...' : '💬 Send to LINE'}</button>
                  <button onClick={bulkDelete} disabled={isBulkSending} className="bg-red-600 hover:bg-red-500 px-5 py-2 rounded-lg font-bold transition-all">🗑️ Delete</button>
              </div>
              <button onClick={() => setSelectedIds(new Set())} className="ml-2 text-slate-400 hover:text-white">✕</button>
          </div>
      )}

      {/* GENERATION LOADING MODAL */}
      {isGenerating && (
        <div className="fixed inset-0 bg-black/80 z-[200] flex flex-col items-center justify-center p-4">
            <div className="bg-white rounded-2xl p-8 w-full max-w-md text-center shadow-2xl animate-in fade-in zoom-in">
                <div className="w-16 h-16 border-4 border-blue-100 border-t-blue-600 rounded-full animate-spin mx-auto mb-6"></div>
                <h3 className="text-2xl font-black text-slate-900 mb-2">Generating Invoices</h3>
                <p className="text-slate-500 mb-6">Please wait while we calculate utilities and create bills...</p>
                <div className="w-full bg-gray-200 rounded-full h-4 overflow-hidden">
                    <div className="bg-blue-600 h-full transition-all duration-500 ease-out" style={{ width: `${genProgress}%` }}></div>
                </div>
                <div className="text-right text-xs font-bold text-blue-600 mt-2">{genProgress}%</div>
            </div>
        </div>
      )}

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