'use client';

import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';

const MONTHS = [
  "January", "February", "March", "April", "May", "June", 
  "July", "August", "September", "October", "November", "December"
];

// 1. MOVE COMPONENT OUTSIDE (Fixes Focus Issue)
// We must pass all the data it needs as "props" since it can't see the variables inside Meters anymore.
const MeterTable = ({ title, roomList, readings, prevReadings, onInput }: any) => (
  <div className="bg-white rounded-xl shadow border border-gray-200 overflow-hidden">
    <div className="bg-slate-900 text-white p-3 font-bold text-center uppercase tracking-widest">{title}</div>
    <table className="w-full text-left">
      <thead className="bg-gray-100 text-xs font-bold text-gray-500 uppercase">
        <tr>
          <th className="p-2 text-center">Room</th>
          <th className="p-2 text-right">Prev</th>
          <th className="p-2 w-24">Elec</th>
          <th className="p-2 text-right">Prev</th>
          <th className="p-2 w-24">Water</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-100 text-sm">
        {roomList.map((room: any) => {
           const prev = prevReadings[room.id] || { electric: 0, water: 0 };
           const curr = readings[room.id] || {};
           
           // Visual Usage Calc
           const elecUsage = (curr.electric && prev.electric) ? curr.electric - prev.electric : 0;
           const waterUsage = (curr.water && prev.water) ? curr.water - prev.water : 0;

           return (
            <tr key={room.id} className="hover:bg-gray-50">
              <td className="p-2 text-center font-black text-slate-800">{room.room_number}</td>
              
              {/* ELECTRICITY */}
              <td className="p-2 text-right text-gray-400 font-mono">{prev.electric || '-'}</td>
              <td className="p-2 relative">
                  <input 
                      type="number" 
                      value={curr.electric || ''} 
                      placeholder="0" 
                      className="w-full border-2 border-yellow-200 focus:border-yellow-500 rounded p-1 font-bold text-slate-900 text-center outline-none" 
                      // Use the passed function "onInput"
                      onChange={(e) => onInput(room.id, 'electric', e.target.value)} 
                  />
                  {elecUsage > 0 && <span className="absolute right-1 top-1 text-[10px] text-green-600 font-bold">+{elecUsage}</span>}
              </td>

              {/* WATER */}
              <td className="p-2 text-right text-gray-400 font-mono">{prev.water || '-'}</td>
              <td className="p-2 relative">
                  <input 
                      type="number" 
                      value={curr.water || ''} 
                      placeholder="0" 
                      className="w-full border-2 border-blue-200 focus:border-blue-500 rounded p-1 font-bold text-slate-900 text-center outline-none" 
                      onChange={(e) => onInput(room.id, 'water', e.target.value)} 
                  />
                  {waterUsage > 0 && <span className="absolute right-1 top-1 text-[10px] text-green-600 font-bold">+{waterUsage}</span>}
              </td>
            </tr>
           );
        })}
      </tbody>
    </table>
  </div>
);

export default function Meters() {
  const [rooms, setRooms] = useState<any[]>([]);
  const [readings, setReadings] = useState<Record<string, any>>({});
  const [prevReadings, setPrevReadings] = useState<Record<string, any>>({});
  
  const [selectedMonth, setSelectedMonth] = useState(new Date().getMonth() + 1);
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
  
  const [saving, setSaving] = useState(false);

  useEffect(() => { fetchData(); }, [selectedMonth, selectedYear]);

  const fetchData = async () => {
    const { data: roomData } = await supabase.from('rooms').select('*').order('room_number');
    
    let prevM = selectedMonth - 1;
    let prevY = selectedYear;
    if (prevM === 0) { prevM = 12; prevY = selectedYear - 1; }

    const { data: prevData } = await supabase.from('meter_readings')
        .select('*')
        .eq('month', prevM)
        .eq('year', prevY);

    const { data: currData } = await supabase.from('meter_readings')
        .select('*')
        .eq('month', selectedMonth)
        .eq('year', selectedYear);

    const prevMap: Record<string, any> = {};
    if (prevData) {
        prevData.forEach(m => {
            if (!prevMap[m.room_id]) prevMap[m.room_id] = { electric: 0, water: 0 };
            if (m.type === 'electric') prevMap[m.room_id].electric = m.current_value;
            if (m.type === 'water') prevMap[m.room_id].water = m.current_value;
        });
    }

    const currMap: Record<string, any> = {};
    if (currData) {
        currData.forEach(m => {
            if (!currMap[m.room_id]) currMap[m.room_id] = {};
            if (m.type === 'electric') currMap[m.room_id].electric = m.current_value;
            if (m.type === 'water') currMap[m.room_id].water = m.current_value;
        });
    }

    setPrevReadings(prevMap);
    setReadings(currMap);
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
    const inserts = [];

    for (const roomId in readings) {
      const r = readings[roomId];
      
      if (r.electric !== undefined && r.electric !== "") {
          await supabase.from('meter_readings').delete().match({ 
              room_id: roomId, month: selectedMonth, year: selectedYear, type: 'electric' 
          });
          inserts.push({ 
              room_id: roomId, type: 'electric', current_value: Number(r.electric), month: selectedMonth, year: selectedYear 
          });
      }

      if (r.water !== undefined && r.water !== "") {
          await supabase.from('meter_readings').delete().match({ 
              room_id: roomId, month: selectedMonth, year: selectedYear, type: 'water' 
          });
          inserts.push({ 
              room_id: roomId, type: 'water', current_value: Number(r.water), month: selectedMonth, year: selectedYear 
          });
      }
    }

    if (inserts.length > 0) {
      const { error } = await supabase.from('meter_readings').insert(inserts);
      if (error) alert('Error: ' + error.message);
      else {
        alert('✅ Saved successfully!');
        fetchData(); 
      }
    }
    setSaving(false);
  };

  const roomsB1 = rooms.filter(r => r.room_number.endsWith('/1'));
  const roomsB2 = rooms.filter(r => r.room_number.endsWith('/2'));

  return (
    <div className="p-6 bg-gray-50 min-h-screen">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-extrabold text-slate-900">⚡ Meter Readings</h1>
        
        <div className="flex gap-4">
           <select 
             value={selectedMonth} 
             onChange={e => setSelectedMonth(Number(e.target.value))} 
             className="bg-white border-2 border-slate-200 p-2 rounded-lg font-bold text-slate-700"
           >
             {MONTHS.map((m, i) => <option key={i} value={i+1}>{m}</option>)}
           </select>

           <select 
             value={selectedYear} 
             onChange={e => setSelectedYear(Number(e.target.value))} 
             className="bg-white border-2 border-slate-200 p-2 rounded-lg font-bold text-slate-700"
           >
             <option value={2025}>2025</option>
             <option value={2026}>2026</option>
             <option value={2027}>2027</option>
           </select>

           <button onClick={saveReadings} disabled={saving} className="bg-green-600 hover:bg-green-700 text-white px-6 py-2 rounded-lg font-bold shadow-lg transition-transform hover:scale-105">
             {saving ? 'Saving...' : '💾 Save All'}
           </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
         {/* 2. Pass the function and data as PROPS */}
         <MeterTable 
            title="Building 1" 
            roomList={roomsB1} 
            readings={readings} 
            prevReadings={prevReadings} 
            onInput={handleInput} 
         />
         <MeterTable 
            title="Building 2" 
            roomList={roomsB2} 
            readings={readings} 
            prevReadings={prevReadings} 
            onInput={handleInput} 
         />
      </div>
    </div>
  );
}