'use client';

import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase'; // Note: we go up two levels (../../)

export default function MeterEntry() {
  const [rooms, setRooms] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // This object will store the data you type: { room_id: { water: 100, electric: 500 } }
  const [readings, setReadings] = useState<Record<string, any>>({});

  useEffect(() => {
    fetchRooms();
  }, []);

  const fetchRooms = async () => {
    // Get rooms sorted by number so it's easy to read
    const { data } = await supabase.from('rooms').select('*').order('room_number');
    setRooms(data || []);
    setLoading(false);
  };

  const handleInputChange = (roomId: string, type: 'water' | 'electric', value: string) => {
    setReadings(prev => ({
      ...prev,
      [roomId]: {
        ...prev[roomId],
        [type]: value
      }
    }));
  };

  const saveReadings = async () => {
    setSaving(true);
    const month = new Date().getMonth() + 1; // Current month (1-12)
    const year = new Date().getFullYear();

    // Prepare the data for Supabase
    const updates = [];
    
    for (const roomId in readings) {
      const entry = readings[roomId];
      // Only save if they typed something
      if (entry.water) {
        updates.push({
          room_id: roomId,
          type: 'water',
          current_value: parseFloat(entry.water),
          previous_value: 0, // We will fix this logic later!
          month, 
          year
        });
      }
      if (entry.electric) {
        updates.push({
          room_id: roomId,
          type: 'electric',
          current_value: parseFloat(entry.electric),
          previous_value: 0, 
          month, 
          year
        });
      }
    }

    if (updates.length === 0) {
      alert("Please enter some readings first!");
      setSaving(false);
      return;
    }

    const { error } = await supabase.from('meter_readings').insert(updates);

    if (error) {
      alert('Error saving: ' + error.message);
    } else {
      alert('Success! Readings saved.');
      // Optional: clear the form
      setReadings({});
    }
    setSaving(false);
  };

  return (
    <div className="p-8 bg-gray-50 min-h-screen">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold">Monthly Meter Entry</h1>
        <button 
          onClick={saveReadings}
          disabled={saving}
          className="bg-blue-600 text-white px-6 py-2 rounded shadow hover:bg-blue-700 disabled:bg-gray-400"
        >
          {saving ? 'Saving...' : 'Save All Readings'}
        </button>
      </div>

      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="w-full text-left">
          <thead className="bg-gray-100 border-b">
            <tr>
              <th className="p-4">Room</th>
              <th className="p-4">Previous Water</th>
              <th className="p-4">Current Water</th>
              <th className="p-4">Previous Electric</th>
              <th className="p-4">Current Electric</th>
            </tr>
          </thead>
          <tbody>
            {loading ? <tr><td className="p-4">Loading...</td></tr> : rooms.map(room => (
              <tr key={room.id} className="border-b hover:bg-gray-50">
                <td className="p-4 font-bold">{room.room_number}</td>
                <td className="p-4 text-gray-400">0</td>
                <td className="p-4">
                  <input 
                    type="number" 
                    placeholder="0"
                    className="border rounded p-2 w-24 bg-blue-50 focus:bg-white focus:ring-2 ring-blue-500 outline-none"
                    onChange={(e) => handleInputChange(room.id, 'water', e.target.value)}
                  />
                </td>
                <td className="p-4 text-gray-400">0</td>
                <td className="p-4">
                  <input 
                    type="number" 
                    placeholder="0"
                    className="border rounded p-2 w-24 bg-yellow-50 focus:bg-white focus:ring-2 ring-yellow-500 outline-none"
                    onChange={(e) => handleInputChange(room.id, 'electric', e.target.value)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}