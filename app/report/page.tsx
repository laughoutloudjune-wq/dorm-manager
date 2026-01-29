'use client';

import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export default function Report() {
  const [data, setData] = useState<any[]>([]);
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [year, setYear] = useState(new Date().getFullYear());
  const [filterType, setFilterType] = useState('all');
  const [totals, setTotals] = useState({ rent:0, elec:0, water:0, total:0 });

  useEffect(() => { fetchReport(); }, [month, year, filterType]);

  const fetchReport = async () => {
    let query = supabase.from('invoices').select(`*, rooms(room_number), tenants(name)`).eq('month', month).eq('year', year);
    if (filterType !== 'all') query = query.eq('type', filterType);
    
    // FETCH ALL (even unpaid, but usually report shows financial status)
    const { data: invoices } = await query;
    if (!invoices) return setData([]);

    const sorted = invoices.sort((a: any, b: any) => (a.rooms?.room_number || '').localeCompare(b.rooms?.room_number || '', undefined, { numeric: true }));
    let t = { rent:0, elec:0, water:0, total:0 };

    const formatted = sorted.map((inv: any) => {
      const tenant = Array.isArray(inv.tenants) ? inv.tenants[0] : inv.tenants;
      t.rent += inv.rent_cost || 0;
      t.elec += inv.electric_cost || 0;
      t.water += inv.water_cost || 0;
      t.total += inv.total_amount || 0;

      return {
        room: inv.rooms?.room_number || '-',
        name: tenant?.name || 'Unknown',
        type: inv.type || 'rent',
        status: inv.payment_status,
        date: inv.payment_date || '-',
        rent: inv.rent_cost || 0,
        elec: inv.electric_cost || 0,
        water: inv.water_cost || 0,
        other: inv.other_fees || 0,
        total: inv.total_amount || 0
      };
    });
    setData(formatted);
    setTotals(t);
  };

  return (
    <div className="p-8 bg-gray-50 min-h-screen">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-extrabold text-slate-900">📊 Financial Report</h1>
        <div className="flex gap-4">
          <select value={filterType} onChange={e=>setFilterType(e.target.value)} className="border p-2 rounded font-bold"><option value="all">All Types</option><option value="rent">Rent</option><option value="deposit">Deposit</option><option value="refund">Refund</option></select>
          <select value={month} onChange={e=>setMonth(Number(e.target.value))} className="border p-2 rounded">{MONTHS.map((m,i)=><option key={i} value={i+1}>{m}</option>)}</select>
          <select value={year} onChange={e=>setYear(Number(e.target.value))} className="border p-2 rounded"><option value={2026}>2026</option></select>
        </div>
      </div>
      <div className="bg-white shadow rounded-xl overflow-hidden border border-gray-200">
        <table className="w-full text-left border-collapse text-sm">
          <thead className="bg-slate-900 text-white uppercase font-bold">
            <tr>
              <th className="p-4">Room</th>
              <th className="p-4">Type</th>
              <th className="p-4">Status</th>
              <th className="p-4">Date</th>
              <th className="p-4 text-right">Rent</th>
              <th className="p-4 text-right">Elec</th>
              <th className="p-4 text-right">Water</th>
              <th className="p-4 text-right">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {data.map((row, i) => (
              <tr key={i} className="hover:bg-gray-50">
                <td className="p-4 font-black">{row.room}</td>
                <td className="p-4 uppercase text-xs font-bold text-blue-600">{row.type}</td>
                <td className="p-4"><span className={`px-2 py-1 rounded text-xs font-bold ${row.status==='paid'?'bg-green-100 text-green-700':'bg-red-100 text-red-700'}`}>{row.status}</span></td>
                <td className="p-4 text-gray-500">{row.date}</td>
                <td className="p-4 text-right">{row.rent.toLocaleString()}</td>
                <td className="p-4 text-right">{row.elec.toLocaleString()}</td>
                <td className="p-4 text-right">{row.water.toLocaleString()}</td>
                <td className="p-4 text-right font-black">{row.total.toLocaleString()}</td>
              </tr>
            ))}
            {data.length > 0 && (
              <tr className="bg-slate-100 font-bold border-t-2 border-slate-300">
                <td className="p-4" colSpan={4}>TOTALS</td>
                <td className="p-4 text-right">{totals.rent.toLocaleString()}</td>
                <td className="p-4 text-right">{totals.elec.toLocaleString()}</td>
                <td className="p-4 text-right">{totals.water.toLocaleString()}</td>
                <td className="p-4 text-right text-lg text-blue-800">{totals.total.toLocaleString()}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}