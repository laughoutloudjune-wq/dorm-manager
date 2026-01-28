'use client';

import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import Link from 'next/link';

export default function Dashboard() {
  const [stats, setStats] = useState({
    totalRooms: 0,
    occupied: 0,
    pendingBills: 0,
    revenue: 0
  });

  useEffect(() => {
    async function loadStats() {
      // 1. Count Rooms
      const { count: totalRooms } = await supabase.from('rooms').select('*', { count: 'exact' });
      const { count: occupied } = await supabase.from('rooms').select('*', { count: 'exact' }).eq('status', 'occupied');

      // 2. Count Unpaid Bills
      const { count: pendingBills } = await supabase
        .from('invoices')
        .select('*', { count: 'exact' })
        .neq('payment_status', 'paid');

      // 3. Calculate Revenue (This Month)
      const thisMonth = new Date().getMonth() + 1;
      const { data: income } = await supabase
        .from('invoices')
        .select('total_amount')
        .eq('month', thisMonth)
        .eq('payment_status', 'paid');
      
      const totalRevenue = income?.reduce((sum, inv) => sum + inv.total_amount, 0) || 0;

      setStats({
        totalRooms: totalRooms || 0,
        occupied: occupied || 0,
        pendingBills: pendingBills || 0,
        revenue: totalRevenue
      });
    }
    loadStats();
  }, []);

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold text-gray-800 mb-8">Overview</h1>

      {/* STATS CARDS */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
        <StatCard 
          label="Occupancy" 
          value={`${stats.occupied} / ${stats.totalRooms}`} 
          color="bg-blue-500" 
        />
        <StatCard 
          label="Pending Bills" 
          value={stats.pendingBills} 
          color="bg-yellow-500" 
          alert={stats.pendingBills > 0}
        />
        <StatCard 
          label="Revenue (This Month)" 
          value={`${stats.revenue.toLocaleString()} ฿`} 
          color="bg-green-500" 
        />
      </div>

      {/* QUICK ACTIONS */}
      <h2 className="text-xl font-bold text-gray-700 mb-4">Quick Actions</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Link href="/meters" className="p-6 bg-white border rounded shadow hover:shadow-lg transition">
          <div className="text-3xl mb-2">⚡</div>
          <div className="font-bold text-lg">Record Meters</div>
          <div className="text-gray-500 text-sm">Input electricity & water units</div>
        </Link>

        <Link href="/invoices" className="p-6 bg-white border rounded shadow hover:shadow-lg transition">
          <div className="text-3xl mb-2">🧾</div>
          <div className="font-bold text-lg">Manage Invoices</div>
          <div className="text-gray-500 text-sm">Send bills & verify slips</div>
        </Link>
        
        <Link href="/tenants" className="p-6 bg-white border rounded shadow hover:shadow-lg transition">
          <div className="text-3xl mb-2">👥</div>
          <div className="font-bold text-lg">Tenants</div>
          <div className="text-gray-500 text-sm">Add or remove residents</div>
        </Link>
      </div>
    </div>
  );
}

function StatCard({ label, value, color, alert }: any) {
  return (
    <div className={`p-6 rounded-xl shadow-lg text-white ${color} ${alert ? 'animate-pulse' : ''}`}>
      <div className="text-sm opacity-80 uppercase tracking-wide">{label}</div>
      <div className="text-3xl font-bold mt-1">{value}</div>
    </div>
  );
}