'use client';

import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';

export default function Tenants() {
  const [rooms, setRooms] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // This stores the temporary data as you type
  const [formData, setFormData] = useState<Record<string, any>>({});

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    // 1. Get all rooms
    const { data: roomData } = await supabase
      .from('rooms')
      .select('*')
      .order('room_number');

    // 2. Get all active tenants
    const { data: tenantData } = await supabase
      .from('tenants')
      .select('*')
      .eq('status', 'active');

    // 3. Merge them together manually
    // We want a list of rooms, with the tenant info attached if they exist
    const merged = roomData?.map(room => {
      const tenant = tenantData?.find(t => t.room_id === room.id);
      return { ...room, tenant };
    });

    setRooms(merged || []);
    setLoading(false);
  };

  const handleChange = (roomId: string, field: string, value: string) => {
    setFormData(prev => ({
      ...prev,
      [roomId]: { ...prev[roomId], [field]: value }
    }));
  };

  const saveTenant = async (room: any) => {
    const input = formData[room.id];
    if (!input) return;

    // If there is already a tenant, update them. If not, create new.
    if (room.tenant) {
      // UPDATE EXISTING
      const { error } = await supabase
        .from('tenants')
        .update({ 
          name: input.name || room.tenant.name, 
          line_user_id: input.line_user_id || room.tenant.line_user_id 
        })
        .eq('id', room.tenant.id);
        
      if (!error) alert('Tenant updated!');
    } else {
      // INSERT NEW
      const { error } = await supabase
        .from('tenants')
        .insert({
          room_id: room.id,
          name: input.name,
          line_user_id: input.line_user_id,
          status: 'active'
        });

      // Also mark room as occupied
      await supabase.from('rooms').update({ status: 'occupied' }).eq('id', room.id);
      
      if (!error) alert('Tenant added!');
    }
    
    // Refresh the list
    fetchData();
  };

  return (
    <div className="p-8 bg-gray-50 min-h-screen">
      <h1 className="text-3xl font-bold mb-6">Tenant Management</h1>
      
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="w-full text-left">
          <thead className="bg-gray-100 border-b">
            <tr>
              <th className="p-4">Room</th>
              <th className="p-4">Tenant Name</th>
              <th className="p-4">LINE User ID</th>
              <th className="p-4">Action</th>
            </tr>
          </thead>
          <tbody>
            {rooms.map(room => (
              <tr key={room.id} className="border-b hover:bg-gray-50">
                <td className="p-4 font-bold">{room.room_number}</td>
                
                {/* Name Input */}
                <td className="p-4">
                  <input 
                    type="text" 
                    placeholder={room.tenant?.name || "Enter Name"}
                    className="border p-2 rounded w-full"
                    onChange={(e) => handleChange(room.id, 'name', e.target.value)}
                  />
                </td>

                {/* LINE ID Input */}
                <td className="p-4">
                  <input 
                    type="text" 
                    placeholder={room.tenant?.line_user_id || "U1234..."}
                    className="border p-2 rounded w-full font-mono text-sm"
                    onChange={(e) => handleChange(room.id, 'line_user_id', e.target.value)}
                  />
                </td>

                {/* Save Button */}
                <td className="p-4">
                  <button 
                    onClick={() => saveTenant(room)}
                    className="bg-blue-600 text-white px-4 py-1 rounded text-sm hover:bg-blue-700"
                  >
                    Save
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}