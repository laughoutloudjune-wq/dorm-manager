'use client';

import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';

export default function Meters() {
  const [rooms, setRooms] = useState<any[]>([]);
  const [readings, setReadings] = useState<Record<string, any>>({});
  const [prevReadings, setPrevReadings] = useState<Record<string, any>>({});
  const [selectedBuilding, setSelectedBuilding] = useState('1');
  const [saving, setSaving] = useState(false);

  useEffect(() => { fetchData(); }, []);

  const fetchData = async () => {
    // 1. Get Rooms
    const { data: roomData } = await supabase.from('rooms').select('*').order('room_number');
    
    // 2. Get LAST Month's readings (Simple logic: just get the latest reading for each room)
    // Note: In a real app with years of data, you'd filter by month-1. 
    // Here we just fetch all to find the latest easily.
    const { data: meterData } = await supabase.from('meter_readings').select('*').order('created_at', { ascending: false });

    // Map previous readings
    const prevMap: Record<string, any> = {};
    if (meterData) {
      roomData?.forEach(room => {
        // Find latest electric
        const lastElec = meterData.find(m => m.room_id === room.id && m.type === 'electric');
        // Find latest water
        const lastWater = meterData.find(m => m.room_id === room.id && m.type === 'water');
        
        prevMap[room.id] = {
          electric: lastElec?.current_value || 0,
          water: lastWater?.current_value || 0
        };
      });
    }
    setPrevReadings(prevMap);
    setRooms(roomData || []);
  };

  const handleInput = (roomId: string, type: 'electric' | 'water', value: string) => {
    setReadings(prev => ({
      ...prev,
      [roomId]: { ...prev[roomId], [type]: value }
    }));
  };

  const saveReadings = async () => {
    setSaving(true);
    const month = new Date().getMonth() + 1;
    const year = new Date().getFullYear();
    const inserts = [];

    for (const roomId in readings) {
      const r = readings[roomId];
      if (r.electric) inserts.push({ room_id: roomId, type: 'electric', current_value: Number(r.electric), month, year });
      if (r.water) inserts.push({ room_id: roomId, type: 'water', current_value: Number(r.water), month, year });
    }

    if (inserts.length > 0) {
      const { error } = await supabase.from('meter_readings').insert(inserts);
      if (error) alert('Error: ' + error.message);
      else {
        alert('✅ Saved successfully!');
        setReadings({}); // Clear inputs
        fetchData(); // Refresh to update "Previous"
      }
    }
    setSaving(false);
  };

  // Filter View
  const filteredRooms = rooms.filter(r => r.room_number.endsWith(`/${selectedBuilding}`));

  return (
    <div className="p-8 bg-gray-50 min-h-screen">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-extrabold text-slate-900">⚡ Meter Readings</h1>
        
        <div className="flex gap-4">
           {/* Building Toggle */}
          <div className="bg-white p-1 rounded-lg border flex shadow-sm">
            <button onClick={() => setSelectedBuilding('1')} className={`px-4 py-2 rounded font-bold ${selectedBuilding === '1' ? 'bg-slate-900 text-white' : 'text-gray-500 hover:bg-gray-50'}`}>Bldg 1</button>
            <button onClick={() => setSelectedBuilding('2')} className={`px-4 py-2 rounded font-bold ${selectedBuilding === '2' ? 'bg-slate-900 text-white' : 'text-gray-500 hover:bg-gray-50'}`}>Bldg 2</button>
          </div>

          <button onClick={saveReadings} disabled={saving} className="bg-green-600 hover:bg-green-700 text-white px-6 py-2 rounded-lg font-bold shadow-md transition-all">
            {saving ? 'Saving...' : '💾 Save All'}
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow border border-gray-200 overflow-hidden">
        <table className="w-full text-left">
          <thead className="bg-slate-900 text-white text-sm uppercase font-bold tracking-wider">
            <tr>
              <th className="p-4 w-24">Room</th>
              <th className="p-4 bg-yellow-900/30 text-yellow-100 border-l border-white/10 text-right">Prev Elec</th>
              <th className="p-4 bg-yellow-900/30 text-yellow-100 w-32">Curr Elec</th>
              <th className="p-4 bg-blue-900/30 text-blue-100 border-l border-white/10 text-right">Prev Water</th>
              <th className="p-4 bg-blue-900/30 text-blue-100 w-32">Curr Water</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filteredRooms.map(room => {
              const prev = prevReadings[room.id] || { electric: 0, water: 0 };
              const curr = readings[room.id] || {};
              
              // Calc Usage for Preview
              const elecUsage = curr.electric ? (curr.electric - prev.electric) : 0;
              const waterUsage = curr.water ? (curr.water - prev.water) : 0;

              return (
                <tr key={room.id} className="hover:bg-gray-50 transition-colors">
                  <td className="p-4 font-black text-slate-800 text-lg">{room.room_number}</td>
                  
                  {/* ELECTRICITY */}
                  <td className="p-4 text-right text-slate-500 font-mono text-lg border-l">{prev.electric}</td>
                  <td className="p-4 relative">
                    <input 
                      type="number" 
                      placeholder={prev.electric}
                      className="w-full border-2 border-gray-300 focus:border-yellow-500 rounded-lg p-2 font-mono text-lg font-bold text-slate-900 outline-none"
                      onChange={(e) => handleInput(room.id, 'electric', e.target.value)}
                    />
                    {elecUsage > 0 && (
                      <span className="absolute right-6 top-1/2 -translate-y-1/2 text-xs font-bold text-green-600">+{elecUsage}</span>
                    )}
                    {elecUsage < 0 && curr.electric && (
                      <span className="absolute right-6 top-1/2 -translate-y-1/2 text-xs font-bold text-red-500">⚠ Low</span>
                    )}
                  </td>

                  {/* WATER */}
                  <td className="p-4 text-right text-slate-500 font-mono text-lg border-l">{prev.water}</td>
                  <td className="p-4 relative">
                    <input 
                      type="number" 
                      placeholder={prev.water}
                      className="w-full border-2 border-gray-300 focus:border-blue-500 rounded-lg p-2 font-mono text-lg font-bold text-slate-900 outline-none"
                      onChange={(e) => handleInput(room.id, 'water', e.target.value)}
                    />
                    {waterUsage > 0 && (
                      <span className="absolute right-6 top-1/2 -translate-y-1/2 text-xs font-bold text-green-600">+{waterUsage}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}