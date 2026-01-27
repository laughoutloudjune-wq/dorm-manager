'use client';

import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
// Import PDF libraries
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

export default function Invoices() {
  const [invoices, setInvoices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // Configuration
  const PRICE_PER_UNIT_ELEC = 7;
  const PRICE_PER_UNIT_WATER = 18;

  useEffect(() => { fetchInvoices(); }, []);

  const fetchInvoices = async () => {
    const { data } = await supabase
      .from('invoices')
      .select('*, rooms(room_number)')
      .order('created_at', { ascending: false });
    setInvoices(data || []);
    setLoading(false);
  };

  // --- 1. PDF GENERATOR ---
  const printPDF = (inv: any) => {
    const doc = new jsPDF();

    // Header
    doc.setFontSize(20);
    doc.text(`INVOICE: Room ${inv.rooms?.room_number}`, 14, 22);
    
    doc.setFontSize(11);
    doc.text(`Month: ${inv.month}/${inv.year}`, 14, 30);
    doc.text(`Date Issued: ${new Date(inv.created_at).toLocaleDateString()}`, 14, 35);

    // Table
    autoTable(doc, {
      startY: 45,
      head: [['Item', 'Units', 'Price/Unit', 'Total (THB)']],
      body: [
        ['Electricity', inv.electric_units, PRICE_PER_UNIT_ELEC, inv.electric_cost.toLocaleString()],
        ['Water', inv.water_units, PRICE_PER_UNIT_WATER, inv.water_cost.toLocaleString()],
        ['Rent', '1', '3,500', inv.rent_cost.toLocaleString()],
        [{ content: 'Grand Total', colSpan: 3, styles: { fontStyle: 'bold' } }, { content: inv.total_amount.toLocaleString(), styles: { fontStyle: 'bold' } }]
      ],
      theme: 'grid',
      headStyles: { fillColor: [41, 128, 185] },
    });

    // Footer
    const finalY = (doc as any).lastAutoTable.finalY || 150;
    doc.text('Please transfer to:', 14, finalY + 15);
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.text('KBank: 123-4-56789-0', 14, finalY + 25);
    doc.save(`Invoice_${inv.rooms?.room_number}.pdf`);
  };

  // --- 2. LINE SENDER ---
  const sendToLine = async (inv: any) => {
    // 1. Fetch the tenant for this room
    const { data: tenant } = await supabase
      .from('tenants')
      .select('line_user_id, name')
      .eq('room_id', inv.room_id)
      .eq('status', 'active')
      .single();

    if (!tenant || !tenant.line_user_id) {
      alert(`No active tenant (or no LINE ID) found for Room ${inv.rooms.room_number}`);
      return;
    }

    // 2. Confirm sending
    if (!confirm(`Send invoice to ${tenant.name}?`)) return;

    try {
      const response = await fetch('/api/send-invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: tenant.line_user_id, // Uses the Real ID from database
          amount: inv.total_amount.toLocaleString(),
          month: `${inv.month}/${inv.year}`,
          pdfUrl: "https://google.com"
        }),
      });

      if (response.ok) alert('Message Sent!');
      else alert('Failed to send.');
      
    } catch (e) {
      alert('Error sending message');
      console.error(e);
    }
  };

  return (
    <div className="p-8 bg-gray-50 min-h-screen">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold">Invoices</h1>
      </div>

      <div className="space-y-4">
        {loading ? <p>Loading...</p> : invoices.map((inv) => (
          <div key={inv.id} className="bg-white p-6 rounded-lg shadow border flex justify-between items-center">
            <div>
              <h2 className="text-xl font-bold">Room {inv.rooms?.room_number}</h2>
              <p className="text-gray-500 text-sm">Total: {inv.total_amount.toLocaleString()} THB</p>
            </div>
            
            <div className="flex gap-2">
                <button 
                  onClick={() => printPDF(inv)}
                  className="bg-red-600 text-white px-4 py-2 rounded hover:bg-red-700 text-sm flex items-center gap-1"
                >
                  📄 PDF
                </button>
                
                <button 
                  onClick={() => sendToLine(inv)}
                  className="bg-green-500 text-white px-4 py-2 rounded hover:bg-green-600 text-sm flex items-center gap-1"
                >
                  💬 Send LINE
                </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}