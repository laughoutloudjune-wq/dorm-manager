'use client';

import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import * as XLSX from 'xlsx'; // Make sure to run: npm install xlsx

export default function Report() {
  const [data, setData] = useState<any[]>([]);
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [year, setYear] = useState(new Date().getFullYear());
  const [totals, setTotals] = useState({ rent:0, elec:0, water:0, other:0, late:0, total:0 });

  useEffect(() => { fetchReport(); }, [month, year]);

  const fetchReport = async () => {
    // We fetch invoices and join relations
    const { data: invoices } = await supabase
      .from('invoices')
      .select(`
        *,
        rooms (room_number),
        tenants (
          name, 
          payment_methods (label)
        )
      `)
      .eq('month', month)
      .eq('year', year);

    if (!invoices) return setData([]);

    // Sort by Room Number (handles 101/1 vs 101/2)
    const sorted = invoices.sort((a: any, b: any) => 
      (a.rooms?.room_number || '').localeCompare(b.rooms?.room_number || '', undefined, { numeric: true })
    );

    // Calculate Totals & Format Data
    let t = { rent:0, elec:0, water:0, other:0, late:0, total:0 };

    const formatted = sorted.map((inv: any) => {
      // Handle the Tenant Join array
      const tenant = Array.isArray(inv.tenants) ? inv.tenants[0] : inv.tenants;
      const payMethod = tenant?.payment_methods?.label || '-';

      t.rent += inv.rent_cost || 0;
      t.elec += inv.electric_cost || 0;
      t.water += inv.water_cost || 0;
      t.other += inv.other_fees || 0;
      t.late += inv.late_fee || 0;
      t.total += inv.total_amount || 0;

      return {
        room: inv.rooms?.room_number,
        name: tenant?.name || 'Unknown',
        method: payMethod,
        rent: inv.rent_cost || 0,
        elec: inv.electric_cost || 0,
        water: inv.water_cost || 0,
        other: inv.other_fees || 0,
        late: inv.late_fee || 0,
        total: inv.total_amount || 0
      };
    });

    setData(formatted);
    setTotals(t);
  };

  const exportExcel = () => {
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Monthly Report");
    XLSX.writeFile(wb, `Report_${month}_${year}.xlsx`);
  };

  return (
    <div className="p-8 bg-gray-50 min-h-screen">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-extrabold text-slate-900">📊 Monthly Report</h1>
        <div className="flex gap-4">
          <select value={month} onChange={e=>setMonth(Number(e.target.value))} className="border p-2 rounded">
             {Array.from({length:12},(_,i)=><option key={i+1} value={i+1}>Month {i+1}</option>)}
          </select>
          <select value={year} onChange={e=>setYear(Number(e.target.value))} className="border p-2 rounded">
             <option value={2026}>2026</option>
             <option value={2027}>2027</option>
          </select>
          <button onClick={exportExcel} className="bg-green-600 text-white px-4 py-2 rounded font-bold hover:bg-green-700">
            Export Excel
          </button>
        </div>
      </div>

      <div className="bg-white shadow rounded-xl overflow-hidden border border-gray-200">
        <table className="w-full text-left border-collapse text-sm">
          <thead className="bg-slate-900 text-white uppercase font-bold">
            <tr>
              <th className="p-4">Room</th>
              <th className="p-4">Tenant</th>
              <th className="p-4">Payment</th>
              <th className="p-4 text-right">Rent</th>
              <th className="p-4 text-right">Elec</th>
              <th className="p-4 text-right">Water</th>
              <th className="p-4 text-right">Other</th>
              <th className="p-4 text-right">Late</th>
              <th className="p-4 text-right bg-slate-800">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {data.map((row, i) => (
              <tr key={i} className="hover:bg-gray-50 transition-colors">
                <td className="p-4 font-black text-slate-800">{row.room}</td>
                <td className="p-4 font-medium">{row.name}</td>
                <td className="p-4 text-xs font-bold text-slate-500 uppercase">{row.method}</td>
                <td className="p-4 text-right text-slate-600">{row.rent.toLocaleString()}</td>
                <td className="p-4 text-right text-slate-600">{row.elec.toLocaleString()}</td>
                <td className="p-4 text-right text-slate-600">{row.water.toLocaleString()}</td>
                <td className="p-4 text-right text-slate-600">{row.other.toLocaleString()}</td>
                <td className="p-4 text-right text-red-500 font-bold">{row.late > 0 ? row.late.toLocaleString() : '-'}</td>
                <td className="p-4 text-right font-black text-slate-900 bg-gray-50">{row.total.toLocaleString()}</td>
              </tr>
            ))}
            {data.length === 0 && (
               <tr><td colSpan={9} className="p-8 text-center text-gray-400">No data for this month</td></tr>
            )}
            
            {/* TOTALS FOOTER */}
            {data.length > 0 && (
              <tr className="bg-slate-100 font-bold border-t-2 border-slate-300 text-slate-900">
                <td className="p-4" colSpan={3}>GRAND TOTAL</td>
                <td className="p-4 text-right">{totals.rent.toLocaleString()}</td>
                <td className="p-4 text-right">{totals.elec.toLocaleString()}</td>
                <td className="p-4 text-right">{totals.water.toLocaleString()}</td>
                <td className="p-4 text-right">{totals.other.toLocaleString()}</td>
                <td className="p-4 text-right">{totals.late.toLocaleString()}</td>
                <td className="p-4 text-right text-lg text-blue-700">{totals.total.toLocaleString()}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}