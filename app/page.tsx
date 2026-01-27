'use client';

import { useEffect, useState } from 'react';
// We use '../lib/supabase' to go up one level out of 'app' and into 'lib'
import { supabase } from '../lib/supabase'; 

export default function Home() {
  const [rooms, setRooms] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchRooms = async () => {
      const { data, error } = await supabase
        .from('rooms')
        .select('*')
        .order('room_number', { ascending: true });
      
      if (error) console.error('Error fetching rooms:', error);
      else setRooms(data || []);
      setLoading(false);
    };

    fetchRooms();
  }, []);

  return (
    <div className="min-h-screen p-8 bg-gray-50">
      <h1 className="text-3xl font-bold mb-6 text-gray-800">Dormitory Rooms</h1>
      
      {loading ? (
        <p>Loading rooms...</p>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {rooms.map((room) => (
            <div 
              key={room.id} 
              className={`p-6 rounded-lg shadow-md border-l-4 ${
                room.status === 'occupied' ? 'border-green-500 bg-white' : 'border-gray-300 bg-gray-100'
              }`}
            >
              <h2 className="text-xl font-bold">Room {room.room_number}</h2>
              <p className="text-gray-600">Floor: {room.floor}</p>
              <span className={`px-2 py-1 text-xs rounded-full ${
                room.status === 'occupied' ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-800'
              }`}>
                {room.status.toUpperCase()}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}