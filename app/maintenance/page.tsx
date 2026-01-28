'use client';

import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';

export default function Maintenance() {
  const [tickets, setTickets] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { fetchTickets(); }, []);

  const fetchTickets = async () => {
    const { data } = await supabase
      .from('maintenance_requests')
      .select('*, rooms(room_number)')
      .order('created_at', { ascending: false });
    setTickets(data || []);
    setLoading(false);
  };

  const markComplete = async (ticket: any) => {
    if (!confirm("ยืนยันว่าซ่อมเสร็จแล้ว?")) return;

    // 1. Update DB
    await supabase.from('maintenance_requests').update({ status: 'completed' }).eq('id', ticket.id);

    // 2. Notify Tenant in Thai
    const { data: tenant } = await supabase.from('tenants').select('line_user_id').eq('room_id', ticket.room_id).eq('status', 'active').single();
    if (tenant?.line_user_id) {
      await fetch('/api/send-message', {
        method: 'POST',
        body: JSON.stringify({
          userId: tenant.line_user_id,
          message: `✅ แจ้งเตือน: รายการแจ้งซ่อมของคุณดำเนินการเสร็จสิ้นแล้วครับ\n\nรายการ: ${ticket.description}`
        })
      });
    }

    fetchTickets();
  };

  return (
    <div className="p-8 bg-gray-50 min-h-screen">
      <h1 className="text-3xl font-bold text-gray-900 mb-8">รายการแจ้งซ่อม / ปัญหา</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {tickets.map(ticket => (
          <div key={ticket.id} className={`p-6 rounded-xl border shadow-sm bg-white ${ticket.status === 'completed' ? 'opacity-60 bg-gray-100' : ''}`}>
            
            <div className="flex justify-between items-start mb-4">
              <span className="font-bold text-xl text-gray-800">ห้อง {ticket.rooms?.room_number}</span>
              <span className={`px-2 py-1 rounded text-xs font-bold uppercase ${
                ticket.status === 'pending' ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'
              }`}>
                {ticket.status === 'pending' ? 'รอดำเนินการ' : 'เสร็จสิ้น'}
              </span>
            </div>

            <div className="min-h-[3rem]">
               <p className="text-gray-800 font-medium">{ticket.description}</p>
            </div>
            
            <p className="text-xs text-gray-400 mt-4 mb-4">
              วันที่แจ้ง: {new Date(ticket.created_at).toLocaleDateString('th-TH')}
            </p>

            {ticket.status === 'pending' && (
              <button 
                onClick={() => markComplete(ticket)}
                className="w-full py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors shadow-sm"
              >
                ✅ ทำรายการเสร็จสิ้น
              </button>
            )}
          </div>
        ))}

        {tickets.length === 0 && !loading && (
          <div className="text-gray-500 text-center col-span-full py-10">ไม่มีรายการแจ้งซ่อมใหม่</div>
        )}
      </div>
    </div>
  );
}