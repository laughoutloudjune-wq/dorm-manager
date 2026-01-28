'use client';

import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';

export default function Tenants() {
  const [rooms, setRooms] = useState<any[]>([]);
  const [selectedBuilding, setSelectedBuilding] = useState('1'); 
  const [editingRoom, setEditingRoom] = useState<any>(null);
  const [formData, setFormData] = useState<any>({});
  const [loading, setLoading] = useState(true);
  const [paymentMethods, setPaymentMethods] = useState<any[]>([]);

  useEffect(() => { fetchRooms(); }, []);

  const fetchRooms = async () => {
    const { data: methods } = await supabase.from('payment_methods').select('*');
    setPaymentMethods(methods || []);

    const { data: roomData } = await supabase.from('rooms').select('*').order('room_number');
    const { data: tenantData } = await supabase.from('tenants').select('*').eq('status', 'active');

    const merged = roomData?.map(room => ({
      ...room,
      tenant: tenantData?.find(t => t.room_id === room.id)
    })) || [];

    setRooms(merged);
    setLoading(false);
  };

  const filteredRooms = rooms.filter(r => r.room_number.endsWith(`/${selectedBuilding}`));

  const openModal = (room: any) => {
    setEditingRoom(room);
    setFormData({
      name: room.tenant?.name || '',
      phone: room.tenant?.phone || '',
      line_user_id: room.tenant?.line_user_id || '',
      address: room.tenant?.address || '',
      payment_method_id: room.tenant?.payment_method_id || '',
      // NEW: Add default rent from the room data
      default_rent: room.default_rent || 3500 
    });
  };

  const saveTenant = async () => {
    if (!editingRoom) return;
    
    // 1. Update Room Default Rent
    if (formData.default_rent) {
        await supabase.from('rooms')
          .update({ default_rent: Number(formData.default_rent) })
          .eq('id', editingRoom.id);
    }

    // 2. Update Tenant Info
    const tenantData = {
        name: formData.name,
        phone: formData.phone,
        line_user_id: formData.line_user_id,
        address: formData.address,
        payment_method_id: formData.payment_method_id
    };

    if (editingRoom.tenant) {
      await supabase.from('tenants').update(tenantData).eq('id', editingRoom.tenant.id);
    } else {
      if (formData.name) {
        await supabase.from('tenants').insert({
          room_id: editingRoom.id,
          status: 'active',
          ...tenantData
        });
        await supabase.from('rooms').update({ status: 'occupied' }).eq('id', editingRoom.id);
      }
    }
    setEditingRoom(null);
    fetchRooms();
  };

  const vacateRoom = async () => {
    if (!confirm("Are you sure you want to remove this tenant?")) return;
    if (editingRoom.tenant) {
      await supabase.from('tenants').update({ status: 'history' }).eq('id', editingRoom.tenant.id);
      await supabase.from('rooms').update({ status: 'vacant' }).eq('id', editingRoom.id);
    }
    setEditingRoom(null);
    fetchRooms();
  };

  return (
    <div className="p-8 bg-gray-50 min-h-screen">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-extrabold text-slate-900">👥 Tenant Manager</h1>
        
        <div className="bg-white p-1 rounded-lg border flex shadow-sm">
          <button onClick={() => setSelectedBuilding('1')} className={`px-6 py-2 rounded-md font-bold transition-all ${selectedBuilding === '1' ? 'bg-slate-900 text-white' : 'text-gray-500 hover:bg-gray-50'}`}>Building 1</button>
          <button onClick={() => setSelectedBuilding('2')} className={`px-6 py-2 rounded-md font-bold transition-all ${selectedBuilding === '2' ? 'bg-slate-900 text-white' : 'text-gray-500 hover:bg-gray-50'}`}>Building 2</button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-4">
        {filteredRooms.map(room => (
          <div 
            key={room.id}
            onClick={() => openModal(room)}
            className={`cursor-pointer rounded-xl border p-4 transition-all hover:shadow-lg hover:-translate-y-1 relative overflow-hidden group ${room.status === 'occupied' ? 'bg-white border-green-200' : 'bg-gray-100 border-gray-200 opacity-80'}`}
          >
            <div className={`absolute top-0 left-0 w-full h-1 ${room.status === 'occupied' ? 'bg-green-500' : 'bg-gray-300'}`}></div>
            <div className="text-lg font-black text-slate-800 mb-1">{room.room_number}</div>
            {room.tenant ? (
              <div><div className="text-sm font-bold text-slate-600 truncate">{room.tenant.name}</div><div className="text-xs text-green-600 font-mono mt-1">Has Tenant</div></div>
            ) : (<div className="text-xs text-gray-400 font-medium italic mt-2">Vacant</div>)}
          </div>
        ))}
      </div>

      {editingRoom && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden animate-in fade-in zoom-in duration-200">
            <div className="bg-slate-900 p-6 flex justify-between items-center">
              <h2 className="text-2xl font-bold text-white">Room {editingRoom.room_number}</h2>
              <button onClick={() => setEditingRoom(null)} className="text-gray-400 hover:text-white text-xl">✕</button>
            </div>

            <div className="p-6 space-y-5 max-h-[70vh] overflow-y-auto">
              
              {/* NEW SECTION: ROOM RATE */}
              <div className="bg-blue-50 p-4 rounded-lg border border-blue-100">
                <label className="block text-xs font-bold text-blue-800 uppercase mb-1">Default Room Rate (Monthly)</label>
                <div className="flex items-center">
                    <span className="text-lg font-bold mr-2">฿</span>
                    <input type="number" value={formData.default_rent} onChange={e => setFormData({...formData, default_rent: e.target.value})} className="w-full bg-white border border-blue-200 rounded-lg p-2 text-slate-900 font-bold text-lg" />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div><label className="block text-xs font-bold text-slate-500 uppercase mb-1">Full Name</label><input type="text" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} className="w-full border border-gray-300 rounded-lg p-2 text-slate-900 font-medium" /></div>
                <div><label className="block text-xs font-bold text-slate-500 uppercase mb-1">Phone</label><input type="tel" value={formData.phone} onChange={e => setFormData({...formData, phone: e.target.value})} className="w-full border border-gray-300 rounded-lg p-2 text-slate-900" /></div>
              </div>

              <div><label className="block text-xs font-bold text-slate-500 uppercase mb-1">Permanent Address</label><textarea value={formData.address || ''} onChange={e => setFormData({...formData, address: e.target.value})} className="w-full border border-gray-300 rounded-lg p-2 text-slate-900 h-20 text-sm" placeholder="Home address..."/></div>

              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Assigned Payment Method</label>
                <select value={formData.payment_method_id || ''} onChange={e => setFormData({...formData, payment_method_id: e.target.value})} className="w-full border border-gray-300 rounded-lg p-2 text-slate-900 bg-white">
                  <option value="">-- Select Method --</option>
                  {paymentMethods.map(pm => (<option key={pm.id} value={pm.id}>{pm.label} ({pm.type === 'qr' ? 'QR' : 'Text'})</option>))}
                </select>
              </div>

              <div><label className="block text-xs font-bold text-slate-500 uppercase mb-1">LINE User ID (System)</label><input type="text" value={formData.line_user_id} onChange={e => setFormData({...formData, line_user_id: e.target.value})} className="w-full border border-gray-300 rounded-lg p-2 text-slate-500 bg-gray-50 font-mono text-xs" /></div>
            </div>

            <div className="p-6 bg-gray-50 border-t flex justify-between items-center">
              {editingRoom.tenant ? (<button onClick={vacateRoom} className="text-red-600 font-bold text-sm hover:underline px-2">Remove Tenant</button>) : <div></div>}
              <div className="flex gap-3">
                <button onClick={() => setEditingRoom(null)} className="text-slate-500 font-medium px-4 py-2 hover:bg-gray-200 rounded-lg">Cancel</button>
                <button onClick={saveTenant} className="bg-slate-900 text-white font-bold px-6 py-2 rounded-lg hover:bg-black shadow-lg">Save Changes</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}