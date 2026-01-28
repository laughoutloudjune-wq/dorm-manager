'use client';

import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import EditModal from './EditModal';

export default function Invoices() {
  const [invoices, setInvoices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingInvoice, setEditingInvoice] = useState<any>(null);
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

  const approvePayment = async (invId: string) => {
    if (confirm("Mark as PAID?")) {
      await supabase.from('invoices').update({ payment_status: 'paid' }).eq('id', invId);
      fetchInvoices();
    }
  };

  const deleteInvoice = async (id: string) => {
    if (confirm("Delete this bill?")) {
      await supabase.from('invoices').delete().eq('id', id);
      fetchInvoices();
    }
  };

  // Helper to convert Image URL to Base64 for PDF
  const getDataUrl = (url: string): Promise<string> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'Anonymous';
      img.src = url;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx?.drawImage(img, 0, 0);
        resolve(canvas.toDataURL('image/jpeg'));
      };
      img.onerror = (e) => reject(e);
    });
  };

  const printPDF = async (inv: any) => {
    const { data: tenant } = await supabase.from('tenants')
      .select('payment_methods(label, bank_name, account_number, account_name, qr_url, type)')
      .eq('room_id', inv.room_id).eq('status', 'active').single();

    const payMethod: any = Array.isArray(tenant?.payment_methods) 
      ? tenant.payment_methods[0] 
      : tenant?.payment_methods;

    const doc = new jsPDF();
    doc.setFontSize(20);
    doc.text(`INVOICE: Room ${inv.rooms?.room_number}`, 14, 22);
    doc.setFontSize(11);
    doc.text(`Month: ${inv.month}/${inv.year}`, 14, 30);
    doc.text(`Date: ${new Date(inv.created_at).toLocaleDateString('th-TH')}`, 14, 35);

    const rows = [
      ['Electricity', `${inv.electric_units} u`, `${inv.unit_price_elec}`, inv.electric_cost.toLocaleString()],
      ['Water', `${inv.water_units} u`, `Tiered`, inv.water_cost.toLocaleString()],
      ['Rent', '1 Month', '-', inv.rent_cost.toLocaleString()]
    ];
    if (inv.other_fees > 0) rows.push(['Fees', '-', '-', inv.other_fees.toLocaleString()]);
    if (inv.late_fee > 0) rows.push(['Late Fee', '-', '-', inv.late_fee.toLocaleString()]);
    if (inv.discount > 0) rows.push(['Discount', '-', '-', `-${inv.discount.toLocaleString()}`]);
    
    rows.push([{ content: 'Grand Total', colSpan: 3, styles: { fontStyle: 'bold' } }, { content: inv.total_amount.toLocaleString(), styles: { fontStyle: 'bold' } }]);

    autoTable(doc, {
      startY: 45,
      head: [['Item', 'Qty', 'Price', 'Total']],
      body: rows,
      theme: 'grid',
      headStyles: { fillColor: [41, 128, 185] }
    });

    const finalY = (doc as any).lastAutoTable.finalY || 150;
    doc.setFontSize(10);
    doc.text('Payment Details:', 14, finalY + 10);

    if (payMethod) {
      doc.setFont('helvetica', 'bold');
      doc.text(payMethod.label || 'Payment', 14, finalY + 16);
      doc.setFont('helvetica', 'normal');

      if (payMethod.type === 'qr' && payMethod.qr_url) {
        try {
          const base64Img = await getDataUrl(payMethod.qr_url);
          doc.addImage(base64Img, 'JPEG', 14, finalY + 20, 40, 40);
          doc.text('Scan to Pay', 14, finalY + 65);
        } catch (e) {
          doc.text('(QR Code Loading Error - CORS)', 14, finalY + 25);
        }
      } else {
        // Text Bank Details
        doc.text(`Bank: ${payMethod.bank_name || '-'}`, 14, finalY + 22);
        doc.text(`Account No: ${payMethod.account_number || '-'}`, 14, finalY + 28);
        doc.text(`Name: ${payMethod.account_name || '-'}`, 14, finalY + 34);
      }
    } else {
      doc.text('Please contact admin for payment.', 14, finalY + 16);
    }

    doc.save(`Invoice_${inv.rooms?.room_number}.pdf`);
  };

  // --- UPDATED SEND TO LINE FUNCTION ---
  const sendToLine = async (inv: any) => {
    // 1. Get Tenant Info
    const { data: tenant } = await supabase
      .from('tenants')
      .select('line_user_id, name')
      .eq('room_id', inv.room_id)
      .eq('status', 'active')
      .single();

    if (!tenant?.line_user_id) {
      alert("⚠️ This tenant has not registered on LINE yet.");
      return;
    }

    if (confirm(`Send digital bill to Room ${inv.rooms?.room_number} (${tenant.name})?`)) {
      try {
        // 2. Call our API with ALL the details
        const response = await fetch('/api/send-invoice', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: tenant.line_user_id,
            roomNumber: inv.rooms?.room_number,
            month: inv.month,
            year: inv.year,
            // Format numbers nicely with commas
            rent: inv.rent_cost.toLocaleString(),
            waterUnit: inv.water_units,
            waterPrice: inv.water_cost.toLocaleString(),
            elecUnit: inv.electric_units,
            elecPrice: inv.electric_cost.toLocaleString(),
            total: inv.total_amount.toLocaleString()
          })
        });

        if (response.ok) {
          alert('✅ Bill sent to LINE successfully!');
        } else {
          alert('❌ Failed to send LINE message.');
        }
      } catch (err) {
        console.error(err);
        alert('Error sending message');
      }
    }
  };
  // -------------------------------------

  return (
    <div className="p-8 bg-gray-50 min-h-screen">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-extrabold text-slate-900">🧾 Invoices</h1>
        <div className="flex gap-4">
           <div className="flex gap-2 bg-white p-1 rounded-lg border shadow-sm">
             <select value={selectedMonth} onChange={(e)=>setSelectedMonth(Number(e.target.value))} className="p-2 outline-none"><option value={1}>Jan</option><option value={2}>Feb</option></select>
             <select value={selectedYear} onChange={(e)=>setSelectedYear(Number(e.target.value))} className="p-2 outline-none"><option value={2026}>2026</option></select>
           </div>
           <button onClick={generateBills} className="bg-slate-900 text-white px-6 py-2 rounded-lg font-bold">+ Generate</button>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <table className="w-full text-left">
          <thead className="bg-gray-50 border-b text-xs uppercase font-bold text-gray-500">
            <tr><th className="p-4">Status</th><th className="p-4">Room</th><th className="p-4">Month</th><th className="p-4 text-right">Amount</th><th className="p-4 text-center">Slip</th><th className="p-4 text-right">Actions</th></tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {invoices.map((inv) => (
              <tr key={inv.id} className="hover:bg-gray-50">
                <td className="p-4"><span className={`px-2 py-1 rounded text-xs font-bold ${inv.payment_status==='paid'?'bg-green-100 text-green-700':inv.payment_status==='verification_pending'?'bg-yellow-100 text-yellow-700':'bg-gray-100'}`}>{inv.payment_status}</span></td>
                <td className="p-4 font-bold">{inv.rooms?.room_number}</td>
                <td className="p-4">{inv.month}/{inv.year}</td>
                <td className="p-4 text-right font-mono font-bold">{inv.total_amount.toLocaleString()}</td>
                <td className="p-4 text-center">{inv.slip_url ? <a href={inv.slip_url} target="_blank" className="text-blue-600 underline text-sm">View</a> : '-'}</td>
                <td className="p-4 text-right flex justify-end gap-2">
                   {inv.payment_status !== 'paid' && <button onClick={()=>approvePayment(inv.id)} title="Approve">✅</button>}
                   <button onClick={()=>setEditingInvoice(inv)} title="Edit">✏️</button>
                   <button onClick={()=>deleteInvoice(inv.id)} title="Delete">🗑️</button>
                   <div className="w-px bg-gray-200 mx-1"></div>
                   <button onClick={()=>printPDF(inv)} title="PDF">📄</button>
                   <button onClick={()=>sendToLine(inv)} title="LINE">💬</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editingInvoice && <EditModal invoice={editingInvoice} onClose={()=>setEditingInvoice(null)} onSave={fetchInvoices}/>}
    </div>
  );
}