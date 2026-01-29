'use client';

import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';

export default function Tenants() {
  const [rooms, setRooms] = useState<any[]>([]);
  const [selectedBuilding, setSelectedBuilding] = useState('1'); 
  const [editingRoom, setEditingRoom] = useState<any>(null);
  const [activeTab, setActiveTab] = useState('info'); 
  const [formData, setFormData] = useState<any>({});
  const [paymentMethods, setPaymentMethods] = useState<any[]>([]);
  
  // Move Out
  const [moveOutData, setMoveOutData] = useState<any>({ elec_end: '', water_end: '', final_deduction: 0 });
  const [refundCalc, setRefundCalc] = useState<any>(null);

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
  };

  const openModal = (room: any) => {
    setEditingRoom(room);
    setActiveTab('info');
    setRefundCalc(null);
    setFormData({
      name: room.tenant?.name || '',
      phone: room.tenant?.phone || '',
      line_user_id: room.tenant?.line_user_id || '',
      address: room.tenant?.address || '',
      payment_method_id: room.tenant?.payment_method_id || '',
      default_rent: room.default_rent || 3500,
      
      // Move In Fields
      move_in_date: room.tenant?.move_in_date || new Date().toISOString().split('T')[0],
      lease_months: room.tenant?.lease_months || 12,
      deposit_amount: room.tenant?.deposit_amount || 0,
      advance_rent_amount: room.tenant?.advance_rent_amount || 0,
      initial_elec: room.tenant?.initial_elec || '',
      initial_water: room.tenant?.initial_water || '',
      contract_url: room.tenant?.contract_url || null,
      move_in_slip_url: room.tenant?.move_in_slip_url || null,
      
      contract_file: null, slip_file: null
    });
  };

  const handleFileUpload = async (file: File, prefix: string) => {
    const fileName = `${prefix}_${Date.now()}`;
    const { error } = await supabase.storage.from('slips').upload(fileName, file);
    if (!error) {
       const { data } = supabase.storage.from('slips').getPublicUrl(fileName);
       return data.publicUrl;
    }
    return null;
  };

  const saveTenant = async () => {
    if (!editingRoom) return;
    
    // 1. Files
    let contractUrl = formData.contract_url;
    let slipUrl = formData.move_in_slip_url;
    if (formData.contract_file) contractUrl = await handleFileUpload(formData.contract_file, 'contract');
    if (formData.slip_file) slipUrl = await handleFileUpload(formData.slip_file, 'slip');

    if (formData.default_rent) await supabase.from('rooms').update({ default_rent: Number(formData.default_rent) }).eq('id', editingRoom.id);

    const tenantData = {
        name: formData.name, phone: formData.phone, line_user_id: formData.line_user_id, address: formData.address, payment_method_id: formData.payment_method_id,
        deposit_amount: Number(formData.deposit_amount), advance_rent_amount: Number(formData.advance_rent_amount),
        initial_elec: Number(formData.initial_elec), initial_water: Number(formData.initial_water),
        move_in_date: formData.move_in_date, lease_months: Number(formData.lease_months),
        contract_url: contractUrl, move_in_slip_url: slipUrl
    };

    if (editingRoom.tenant) {
      await supabase.from('tenants').update(tenantData).eq('id', editingRoom.tenant.id);
    } else {
      if (formData.name) {
        // Initial Transactions
        const totalPaid = Number(formData.deposit_amount) + Number(formData.advance_rent_amount);
        if (totalPaid > 0) {
            await supabase.from('invoices').insert({
                room_id: editingRoom.id, month: new Date().getMonth() + 1, year: new Date().getFullYear(),
                total_amount: totalPaid, type: 'deposit', payment_status: 'paid', payment_date: new Date()
            });
        }
        // Initial Meter
        if (formData.initial_elec && formData.initial_water) {
             const m = new Date().getMonth() + 1; const y = new Date().getFullYear();
             await supabase.from('meter_readings').insert([
                 { room_id: editingRoom.id, type: 'electric', current_value: Number(formData.initial_elec), month: m, year: y },
                 { room_id: editingRoom.id, type: 'water', current_value: Number(formData.initial_water), month: m, year: y }
             ]);
        }
        await supabase.from('tenants').insert({ room_id: editingRoom.id, status: 'active', ...tenantData });
        await supabase.from('rooms').update({ status: 'occupied' }).eq('id', editingRoom.id);
      }
    }
    setEditingRoom(null);
    fetchRooms();
  };

  const calculateRefund = async () => {
    if (!moveOutData.elec_end || !moveOutData.water_end) return alert("Please enter meter readings");
    const { data: settings } = await supabase.from('settings').select('*').single();
    
    // Simple Calculation (In real usage, subtract from previous month reading)
    const elecCost = Number(moveOutData.elec_end) * (settings?.elec_rate || 7);
    const waterCost = Number(moveOutData.water_end) * (settings?.water_excess_rate || 17);
    const rent = Number(formData.default_rent);
    
    // Total Charges (Rent + Utilities + Damages)
    const totalCharges = rent + elecCost + waterCost + Number(moveOutData.final_deduction);
    // Total Credits (Deposit + Advance)
    const totalCredits = Number(formData.deposit_amount) + Number(formData.advance_rent_amount);
    
    setRefundCalc({ charges: totalCharges, credits: totalCredits, refund: totalCredits - totalCharges });
  };

  const confirmMoveOut = async () => {
    if (!refundCalc || !confirm("Confirm move out?")) return;
    await supabase.from('invoices').insert({
        room_id: editingRoom.id, month: new Date().getMonth() + 1, year: new Date().getFullYear(),
        total_amount: refundCalc.refund * -1, type: 'refund', other_fees_description: 'Final Settlement', payment_status: 'paid', payment_date: new Date()
    });
    await supabase.from('tenants').update({ status: 'history' }).eq('id', editingRoom.tenant.id);
    await supabase.from('rooms').update({ status: 'vacant' }).eq('id', editingRoom.id);
    setEditingRoom(null);
    fetchRooms();
  };

  const getLeaseEnd = () => {
      if(!formData.move_in_date) return '';
      const d = new Date(formData.move_in_date);
      d.setMonth(d.getMonth() + Number(formData.lease_months));
      return d.toLocaleDateString('en-GB');
  };

  const filteredRooms = rooms.filter(r => r.room_number.endsWith(`/${selectedBuilding}`));

  return (
    <div className="p-8 bg-gray-50 min-h-screen">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-extrabold text-slate-900">👥 Tenant Manager</h1>
        <div className="bg-white p-1 rounded-lg border flex shadow-sm">
          <button onClick={() => setSelectedBuilding('1')} className={`px-6 py-2 rounded-md font-bold ${selectedBuilding === '1' ? 'bg-slate-900 text-white' : 'text-gray-500'}`}>Bldg 1</button>
          <button onClick={() => setSelectedBuilding('2')} className={`px-6 py-2 rounded-md font-bold ${selectedBuilding === '2' ? 'bg-slate-900 text-white' : 'text-gray-500'}`}>Bldg 2</button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
        {filteredRooms.map(room => (
          <div key={room.id} onClick={() => openModal(room)} className={`cursor-pointer rounded-xl border p-4 hover:shadow-lg relative overflow-hidden ${room.status === 'occupied' ? 'bg-white border-green-200' : 'bg-gray-100 border-gray-200'}`}>
            <div className={`absolute top-0 left-0 w-full h-1 ${room.status === 'occupied' ? 'bg-green-500' : 'bg-gray-300'}`}></div>
            <div className="text-lg font-black text-slate-800">{room.room_number}</div>
            {room.tenant ? <div className="text-sm text-slate-600 truncate">{room.tenant.name}</div> : <div className="text-xs text-gray-400 italic mt-2">Vacant</div>}
          </div>
        ))}
      </div>

      {editingRoom && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          {/* BIGGER MODAL: max-w-4xl */}
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="bg-slate-900 p-4 flex justify-between items-center text-white">
              <h2 className="text-xl font-bold">Room {editingRoom.room_number}</h2>
              <button onClick={() => setEditingRoom(null)} className="text-gray-400 hover:text-white">✕</button>
            </div>
            
            <div className="flex border-b bg-gray-50">
                {['info', 'movein', 'moveout'].map(tab => (
                    <button key={tab} onClick={() => setActiveTab(tab)} className={`flex-1 py-3 font-bold text-sm uppercase ${activeTab === tab ? 'bg-white border-t-2 border-slate-900 text-slate-900' : 'text-gray-400'}`}>{tab}</button>
                ))}
            </div>

            <div className="p-8 overflow-y-auto space-y-6 flex-1">
              {/* INFO TAB */}
              {activeTab === 'info' && (
                <div className="grid grid-cols-2 gap-6">
                    <div><label className="text-xs font-bold uppercase text-gray-500">Tenant Name</label><input className="w-full border p-2 rounded" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} /></div>
                    <div><label className="text-xs font-bold uppercase text-gray-500">Phone</label><input className="w-full border p-2 rounded" value={formData.phone} onChange={e => setFormData({...formData, phone: e.target.value})} /></div>
                    <div><label className="text-xs font-bold uppercase text-gray-500">Address</label><textarea className="w-full border p-2 rounded" value={formData.address} onChange={e => setFormData({...formData, address: e.target.value})} /></div>
                    <div><label className="text-xs font-bold uppercase text-gray-500">Rent (Monthly)</label><input type="number" className="w-full border p-2 rounded" value={formData.default_rent} onChange={e => setFormData({...formData, default_rent: e.target.value})} /></div>
                    <div><label className="text-xs font-bold uppercase text-gray-500">Payment Method</label>
                    <select className="w-full border p-2 rounded" value={formData.payment_method_id} onChange={e => setFormData({...formData, payment_method_id: e.target.value})}>
                        <option value="">Select Method</option>
                        {paymentMethods.map(pm => <option key={pm.id} value={pm.id}>{pm.label}</option>)}
                    </select>
                    </div>
                </div>
              )}

              {/* MOVE IN TAB */}
              {activeTab === 'movein' && (
                <div className="space-y-6">
                   <div className="bg-blue-50 p-6 rounded-xl border border-blue-100 grid grid-cols-2 gap-6">
                      <div>
                          <label className="text-xs font-bold uppercase text-blue-800">Move In Date</label>
                          <input type="date" className="w-full border p-2 rounded" value={formData.move_in_date} onChange={e => setFormData({...formData, move_in_date: e.target.value})} />
                      </div>
                      <div>
                          <label className="text-xs font-bold uppercase text-blue-800">Lease (Months)</label>
                          <div className="flex items-center gap-2">
                            <input type="number" className="w-full border p-2 rounded" value={formData.lease_months} onChange={e => setFormData({...formData, lease_months: e.target.value})} />
                            <span className="text-xs text-blue-600 font-bold whitespace-nowrap">Ends: {getLeaseEnd()}</span>
                          </div>
                      </div>
                   </div>

                   <div className="grid grid-cols-2 gap-6">
                      <div><label className="text-xs font-bold uppercase text-gray-500">Deposit (ประกัน)</label><input type="number" className="w-full border p-2 rounded" value={formData.deposit_amount} onChange={e => setFormData({...formData, deposit_amount: e.target.value})} /></div>
                      <div><label className="text-xs font-bold uppercase text-gray-500">Advance (ล่วงหน้า)</label><input type="number" className="w-full border p-2 rounded" value={formData.advance_rent_amount} onChange={e => setFormData({...formData, advance_rent_amount: e.target.value})} /></div>
                      <div><label className="text-xs font-bold uppercase text-gray-500">Initial Elec</label><input type="number" className="w-full border p-2 rounded font-mono" value={formData.initial_elec} onChange={e => setFormData({...formData, initial_elec: e.target.value})} /></div>
                      <div><label className="text-xs font-bold uppercase text-gray-500">Initial Water</label><input type="number" className="w-full border p-2 rounded font-mono" value={formData.initial_water} onChange={e => setFormData({...formData, initial_water: e.target.value})} /></div>
                   </div>

                   <div className="grid grid-cols-2 gap-6 pt-4 border-t">
                      <div><label className="text-xs font-bold uppercase">Contract File</label><input type="file" onChange={e => setFormData({...formData, contract_file: e.target.files?.[0]})} /></div>
                      <div><label className="text-xs font-bold uppercase">Slip File</label><input type="file" onChange={e => setFormData({...formData, slip_file: e.target.files?.[0]})} /></div>
                   </div>
                </div>
              )}

              {/* MOVE OUT TAB */}
              {activeTab === 'moveout' && (
                <div className="bg-red-50 p-6 rounded-xl border border-red-100 space-y-4">
                    <h3 className="font-bold text-red-900 border-b border-red-200 pb-2">Final Settlement Calculator</h3>
                    <div className="grid grid-cols-3 gap-4">
                        <div><label className="text-xs font-bold">Final Elec (Units Used)</label><input type="number" className="w-full border p-2 rounded" value={moveOutData.elec_end} onChange={e => setMoveOutData({...moveOutData, elec_end: e.target.value})} /></div>
                        <div><label className="text-xs font-bold">Final Water (Units Used)</label><input type="number" className="w-full border p-2 rounded" value={moveOutData.water_end} onChange={e => setMoveOutData({...moveOutData, water_end: e.target.value})} /></div>
                        <div><label className="text-xs font-bold">Deductions (Damages)</label><input type="number" className="w-full border p-2 rounded" value={moveOutData.final_deduction} onChange={e => setMoveOutData({...moveOutData, final_deduction: e.target.value})} /></div>
                    </div>
                    <button onClick={calculateRefund} className="bg-red-600 text-white font-bold w-full py-2 rounded">Calculate Refund</button>

                    {refundCalc && (
                        <div className="bg-white p-4 rounded border border-red-200 text-center">
                            <div className="grid grid-cols-2 gap-4 text-sm mb-4">
                                <div><span className="block font-bold text-green-600">Credits</span>(Deposit + Advance)<br/>{refundCalc.credits.toLocaleString()}</div>
                                <div><span className="block font-bold text-red-600">Charges</span>(Rent + Utils + Damage)<br/>-{refundCalc.charges.toLocaleString()}</div>
                            </div>
                            <div className="text-3xl font-black text-slate-900 mb-4">
                                {refundCalc.refund >= 0 ? 'Refund: ' : 'Tenant Owes: '}
                                {Math.abs(refundCalc.refund).toLocaleString()} ฿
                            </div>
                            <button onClick={confirmMoveOut} className="bg-slate-900 text-white font-bold px-8 py-3 rounded shadow hover:bg-black">Confirm & Archive Tenant</button>
                        </div>
                    )}
                </div>
              )}
            </div>

            {/* FOOTER */}
            {activeTab !== 'moveout' && (
                <div className="p-4 bg-gray-100 border-t flex justify-end gap-3 shrink-0">
                    <button onClick={() => setEditingRoom(null)} className="px-6 py-2 text-slate-500 font-bold">Cancel</button>
                    <button onClick={saveTenant} className="px-8 py-2 bg-slate-900 text-white rounded-lg font-bold shadow hover:bg-black">Save Tenant</button>
                </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}