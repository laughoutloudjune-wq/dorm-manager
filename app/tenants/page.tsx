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
  const [loading, setLoading] = useState(false);
  
  // Move Out State
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
      // Status & Config
      room_status: room.status, // 'vacant', 'occupied', 'maintenance'
      allow_line_register: room.allow_line_register || false,

      // Tenant Info
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
    } else {
       console.error("Upload Error:", error);
       return null;
    }
  };

  const saveTenant = async () => {
    if (!editingRoom) return;
    setLoading(true);

    try {
        // 1. Files
        let contractUrl = formData.contract_url;
        let slipUrl = formData.move_in_slip_url;
        if (formData.contract_file) contractUrl = await handleFileUpload(formData.contract_file, 'contract');
        if (formData.slip_file) slipUrl = await handleFileUpload(formData.slip_file, 'slip');

        // 2. Room Updates (Manual Status & Line Permission)
        const { error: roomError } = await supabase.from('rooms')
            .update({ 
                default_rent: Number(formData.default_rent || 0),
                allow_line_register: formData.allow_line_register,
                status: formData.room_status 
            })
            .eq('id', editingRoom.id);
        
        if (roomError) throw new Error("Room Update Failed: " + roomError.message);

        // 3. Tenant Data Preparation
        const tenantData = {
            name: formData.name, 
            phone: formData.phone, 
            line_user_id: formData.line_user_id ? formData.line_user_id : null, 
            address: formData.address, 
            payment_method_id: formData.payment_method_id || null,
            
            // Critical: Ensure these are Numbers (defaults to 0 if empty)
            deposit_amount: Number(formData.deposit_amount || 0), 
            advance_rent_amount: Number(formData.advance_rent_amount || 0),
            initial_elec: Number(formData.initial_elec || 0), 
            initial_water: Number(formData.initial_water || 0),
            
            move_in_date: formData.move_in_date, 
            lease_months: Number(formData.lease_months || 12),
            contract_url: contractUrl, 
            move_in_slip_url: slipUrl
        };

        if (editingRoom.tenant) {
            // UPDATE EXISTING TENANT
            const { error: updateError } = await supabase.from('tenants').update(tenantData).eq('id', editingRoom.tenant.id);
            if (updateError) throw new Error("Tenant Update Failed: " + updateError.message);
        } else {
            // CREATE NEW TENANT
            if (formData.name) {
                // A. Create Deposit Invoice
                const totalPaid = tenantData.deposit_amount + tenantData.advance_rent_amount;
                if (totalPaid > 0) {
                    await supabase.from('invoices').insert({
                        room_id: editingRoom.id, 
                        month: new Date().getMonth() + 1, 
                        year: new Date().getFullYear(),
                        total_amount: totalPaid, 
                        type: 'deposit', 
                        payment_status: 'paid', 
                        payment_date: new Date()
                    });
                }

                // B. Insert Initial Meter Reading (CRITICAL for first bill)
                if (tenantData.initial_elec > 0 || tenantData.initial_water > 0) {
                    const m = new Date().getMonth() + 1; 
                    const y = new Date().getFullYear();
                    // Delete any existing initial reading for this month to avoid duplicates
                    await supabase.from('meter_readings').delete().match({ room_id: editingRoom.id, month: m, year: y });
                    
                    await supabase.from('meter_readings').insert([
                        { room_id: editingRoom.id, type: 'electric', current_value: tenantData.initial_elec, month: m, year: y },
                        { room_id: editingRoom.id, type: 'water', current_value: tenantData.initial_water, month: m, year: y }
                    ]);
                }
                
                // C. Insert Tenant Record
                const { error: insertError } = await supabase.from('tenants').insert({ room_id: editingRoom.id, status: 'active', ...tenantData });
                if (insertError) throw new Error("Tenant Insert Failed: " + insertError.message);
                
                // D. Force Status to Occupied
                await supabase.from('rooms').update({ status: 'occupied' }).eq('id', editingRoom.id);
            }
        }
        
        alert("✅ Saved Successfully!");
        setEditingRoom(null);
        fetchRooms();

    } catch (err: any) {
        console.error("Save Error:", err);
        alert("❌ Error Saving: " + err.message);
    } finally {
        setLoading(false);
    }
  };

  const deleteTenant = async () => {
      if (!confirm("⚠️ Are you sure you want to PERMANENTLY DELETE this tenant?\n\nThis is for fixing mistakes only. Use 'Move Out' for normal cases.")) return;
      await supabase.from('tenants').delete().eq('id', editingRoom.tenant.id);
      await supabase.from('rooms').update({ status: 'vacant' }).eq('id', editingRoom.id);
      setEditingRoom(null);
      fetchRooms();
  };

  const calculateRefund = async () => {
    if (!moveOutData.elec_end || !moveOutData.water_end) return alert("Please enter meter readings");
    const { data: settings } = await supabase.from('settings').select('*').single();
    
    const elecCost = Number(moveOutData.elec_end) * (settings?.elec_rate || 7);
    const waterCost = Number(moveOutData.water_end) * (settings?.water_excess_rate || 17);
    const rent = Number(formData.default_rent);
    
    const totalCharges = rent + elecCost + waterCost + Number(moveOutData.final_deduction);
    const totalCredits = Number(formData.deposit_amount) + Number(formData.advance_rent_amount);
    
    setRefundCalc({ charges: totalCharges, credits: totalCredits, refund: totalCredits - totalCharges });
  };

  const confirmMoveOut = async () => {
    if (!refundCalc || !confirm("Confirm move out?")) return;
    
    // Create Refund Invoice record
    await supabase.from('invoices').insert({
        room_id: editingRoom.id, month: new Date().getMonth() + 1, year: new Date().getFullYear(),
        total_amount: refundCalc.refund * -1, type: 'refund', other_fees_description: 'Final Settlement', payment_status: 'paid', payment_date: new Date()
    });
    
    // Archive Tenant
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
          <div key={room.id} onClick={() => openModal(room)} className={`cursor-pointer rounded-xl border p-4 hover:shadow-lg relative overflow-hidden transition-all duration-200 ${room.status === 'occupied' ? 'bg-white border-green-200' : room.status === 'maintenance' ? 'bg-yellow-50 border-yellow-200' : 'bg-slate-100 border-gray-200'}`}>
            <div className={`absolute top-0 left-0 w-full h-1 ${room.status === 'occupied' ? 'bg-green-500' : room.status === 'maintenance' ? 'bg-yellow-500' : 'bg-gray-300'}`}></div>
            
            {/* LINE READY BADGE */}
            {room.allow_line_register && (
                <div className="absolute top-2 right-2 w-2 h-2 bg-blue-500 rounded-full animate-pulse" title="Ready for LINE Register"></div>
            )}

            <div className="text-lg font-black text-slate-800">{room.room_number}</div>
            
            {room.tenant ? (
                <div>
                   <div className="text-sm text-slate-600 truncate font-medium">{room.tenant.name}</div>
                   {!room.tenant.line_user_id && <div className="text-[10px] text-red-500 font-bold mt-1">⚠️ No LINE</div>}
                </div>
            ) : (
                <div className="text-xs text-gray-400 italic mt-2 uppercase">{room.status}</div>
            )}
          </div>
        ))}
      </div>

      {editingRoom && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
          {/* MAX-W-6XL for wider layout */}
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-6xl overflow-hidden flex flex-col max-h-[95vh]">
            
            {/* HEADER */}
            <div className="bg-white border-b p-6 flex justify-between items-center">
              <div className="flex items-center gap-6">
                  <h2 className="text-3xl font-black text-slate-900">{editingRoom.room_number}</h2>
                  
                  {/* MANUAL STATUS SELECTOR */}
                  <select 
                    value={formData.room_status} 
                    onChange={(e) => setFormData({...formData, room_status: e.target.value})}
                    className={`text-sm font-bold uppercase px-3 py-1 rounded-full border-2 outline-none cursor-pointer ${formData.room_status==='occupied' ? 'border-green-200 bg-green-50 text-green-700' : formData.room_status==='maintenance' ? 'border-yellow-200 bg-yellow-50 text-yellow-700' : 'border-gray-200 bg-gray-50 text-gray-500'}`}
                  >
                      <option value="vacant">Vacant</option>
                      <option value="occupied">Occupied</option>
                      <option value="maintenance">Maintenance</option>
                  </select>
              </div>

              <div className="flex items-center gap-4">
                 {/* LINE TOGGLE */}
                 <label className="flex items-center cursor-pointer gap-2 bg-blue-50 px-3 py-1 rounded-lg border border-blue-100 hover:bg-blue-100 transition-colors">
                    <input type="checkbox" checked={formData.allow_line_register} onChange={(e) => setFormData({...formData, allow_line_register: e.target.checked})} className="w-4 h-4 accent-blue-600" />
                    <span className="text-xs font-bold text-blue-800 uppercase">Allow LINE Register</span>
                 </label>

                 <button onClick={() => setEditingRoom(null)} className="w-8 h-8 flex items-center justify-center rounded-full bg-gray-100 hover:bg-red-100 hover:text-red-600 text-gray-500 font-bold transition-colors">✕</button>
              </div>
            </div>
            
            {/* TABS */}
            <div className="flex border-b bg-gray-50">
                {['info', 'movein', 'moveout'].map(tab => (
                    <button key={tab} onClick={() => setActiveTab(tab)} className={`flex-1 py-4 font-bold text-sm uppercase tracking-wide transition-colors ${activeTab === tab ? 'bg-white border-t-4 border-slate-900 text-slate-900' : 'text-gray-400 hover:text-slate-600 border-t-4 border-transparent'}`}>{tab}</button>
                ))}
            </div>

            {/* CONTENT AREA */}
            <div className="p-8 overflow-y-auto flex-1 bg-white">
              
              {/* TAB: INFO */}
              {activeTab === 'info' && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                    {/* Column 1: Personal */}
                    <div className="space-y-5">
                        <h3 className="font-bold text-slate-900 border-b pb-2 mb-4">Personal Info</h3>
                        <div><label className="label">Tenant Name</label><input className="input" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} placeholder="Full Name" /></div>
                        <div><label className="label">Phone</label><input className="input" value={formData.phone} onChange={e => setFormData({...formData, phone: e.target.value})} placeholder="08x-xxx-xxxx" /></div>
                        <div><label className="label">Permanent Address</label><textarea className="input h-24" value={formData.address} onChange={e => setFormData({...formData, address: e.target.value})} /></div>
                    </div>

                    {/* Column 2: System */}
                    <div className="space-y-5">
                        <h3 className="font-bold text-slate-900 border-b pb-2 mb-4">System Link</h3>
                        <div>
                            <label className="label">LINE User ID</label>
                            <input className="input font-mono text-xs bg-gray-50" value={formData.line_user_id} onChange={e => setFormData({...formData, line_user_id: e.target.value})} placeholder="(Auto-filled by LINE)" />
                            {!formData.line_user_id && <p className="text-[10px] text-amber-600 mt-1">Tenant has not connected via LINE yet.</p>}
                        </div>
                        <div>
                            <label className="label">Payment Method</label>
                            <select className="input" value={formData.payment_method_id} onChange={e => setFormData({...formData, payment_method_id: e.target.value})}>
                                <option value="">-- Select Method --</option>
                                {paymentMethods.map(pm => <option key={pm.id} value={pm.id}>{pm.label}</option>)}
                            </select>
                        </div>
                    </div>

                    {/* Column 3: Contract */}
                    <div className="space-y-5">
                        <h3 className="font-bold text-slate-900 border-b pb-2 mb-4">Lease</h3>
                        <div><label className="label">Room Rate (Monthly)</label><input type="number" className="input text-lg font-bold" value={formData.default_rent} onChange={e => setFormData({...formData, default_rent: e.target.value})} /></div>
                        <div>
                            <label className="label">Contract End</label>
                            <div className="p-3 bg-blue-50 rounded-lg border border-blue-100">
                                <span className="block text-xs text-blue-500 uppercase font-bold">Expires On</span>
                                <span className="text-lg font-black text-blue-900">{getLeaseEnd() || '-'}</span>
                            </div>
                        </div>
                    </div>
                </div>
              )}

              {/* TAB: MOVE IN */}
              {activeTab === 'movein' && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
                   <div className="space-y-6">
                      <div className="bg-slate-50 p-6 rounded-xl border border-slate-200">
                          <h3 className="font-bold text-slate-900 mb-4">Contract Details</h3>
                          <div className="grid grid-cols-2 gap-4">
                            <div><label className="label">Move In Date</label><input type="date" className="input" value={formData.move_in_date} onChange={e => setFormData({...formData, move_in_date: e.target.value})} /></div>
                            <div><label className="label">Lease (Months)</label><input type="number" className="input" value={formData.lease_months} onChange={e => setFormData({...formData, lease_months: e.target.value})} /></div>
                          </div>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                          <div><label className="label">Deposit (ประกัน)</label><input type="number" className="input" value={formData.deposit_amount} onChange={e => setFormData({...formData, deposit_amount: e.target.value})} /></div>
                          <div><label className="label">Advance (ล่วงหน้า)</label><input type="number" className="input" value={formData.advance_rent_amount} onChange={e => setFormData({...formData, advance_rent_amount: e.target.value})} /></div>
                      </div>
                   </div>

                   <div className="space-y-6">
                      <div className="bg-slate-50 p-6 rounded-xl border border-slate-200">
                          <h3 className="font-bold text-slate-900 mb-4">Initial Meter Readings</h3>
                          <div className="grid grid-cols-2 gap-4">
                             <div><label className="label">Elec Start</label><input type="number" className="input font-mono" value={formData.initial_elec} onChange={e => setFormData({...formData, initial_elec: e.target.value})} /></div>
                             <div><label className="label">Water Start</label><input type="number" className="input font-mono" value={formData.initial_water} onChange={e => setFormData({...formData, initial_water: e.target.value})} /></div>
                          </div>
                      </div>
                      
                      <div className="grid grid-cols-2 gap-4">
                         <div>
                            <label className="label">Contract Photo</label>
                            <input type="file" onChange={e => setFormData({...formData, contract_file: e.target.files?.[0]})} className="text-xs file:py-2 file:px-4 file:rounded-full file:bg-slate-100 hover:file:bg-slate-200" />
                            {formData.contract_url && <a href={formData.contract_url} target="_blank" className="text-xs text-blue-600 underline block mt-2">View</a>}
                         </div>
                         <div>
                            <label className="label">Slip Photo</label>
                            <input type="file" onChange={e => setFormData({...formData, slip_file: e.target.files?.[0]})} className="text-xs file:py-2 file:px-4 file:rounded-full file:bg-slate-100 hover:file:bg-slate-200" />
                            {formData.move_in_slip_url && <a href={formData.move_in_slip_url} target="_blank" className="text-xs text-blue-600 underline block mt-2">View</a>}
                         </div>
                      </div>
                   </div>
                </div>
              )}

              {/* TAB: MOVE OUT */}
              {activeTab === 'moveout' && (
                <div className="bg-red-50 p-8 rounded-xl border border-red-100 space-y-8">
                    <div className="flex items-center justify-between border-b border-red-200 pb-4">
                        <h3 className="text-xl font-bold text-red-900">End of Lease Settlement</h3>
                        <div className="text-red-700 text-sm">Please ensure meter readings are final.</div>
                    </div>
                    
                    <div className="grid grid-cols-3 gap-8">
                        <div><label className="label text-red-800">Final Elec (Units)</label><input type="number" className="input border-red-200 focus:border-red-500" value={moveOutData.elec_end} onChange={e => setMoveOutData({...moveOutData, elec_end: e.target.value})} /></div>
                        <div><label className="label text-red-800">Final Water (Units)</label><input type="number" className="input border-red-200 focus:border-red-500" value={moveOutData.water_end} onChange={e => setMoveOutData({...moveOutData, water_end: e.target.value})} /></div>
                        <div><label className="label text-red-800">Deductions (Damages)</label><input type="number" className="input border-red-200 focus:border-red-500" value={moveOutData.final_deduction} onChange={e => setMoveOutData({...moveOutData, final_deduction: e.target.value})} /></div>
                    </div>
                    
                    <button onClick={calculateRefund} className="w-full bg-red-600 hover:bg-red-700 text-white font-bold py-4 rounded-xl shadow transition-colors">Calculate Refund</button>

                    {refundCalc && (
                        <div className="bg-white p-8 rounded-xl border border-red-200 text-center shadow-lg animate-in fade-in slide-in-from-bottom-2">
                             <div className="grid grid-cols-2 gap-12 text-sm mb-8 border-b pb-6">
                                <div><span className="block font-bold text-green-600 text-xl mb-1">Credits</span>Deposit + Advance<br/>{refundCalc.credits.toLocaleString()}</div>
                                <div><span className="block font-bold text-red-600 text-xl mb-1">Charges</span>Rent + Utils + Damage<br/>-{refundCalc.charges.toLocaleString()}</div>
                            </div>
                            <div className={`text-5xl font-black mb-8 ${refundCalc.refund >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                <span className="text-sm font-bold text-gray-400 block mb-2 uppercase tracking-widest">{refundCalc.refund >= 0 ? 'Refund Amount' : 'Tenant Must Pay'}</span>
                                {Math.abs(refundCalc.refund).toLocaleString()} ฿
                            </div>
                            <button onClick={confirmMoveOut} className="w-full bg-slate-900 text-white font-bold px-8 py-4 rounded-xl shadow-xl hover:bg-black transition-transform hover:scale-[1.01]">Confirm & Archive Tenant</button>
                        </div>
                    )}
                </div>
              )}
            </div>

            {/* FOOTER */}
            {activeTab !== 'moveout' && (
                <div className="p-6 bg-gray-50 border-t flex justify-between items-center shrink-0">
                    {editingRoom.tenant ? (
                        <button onClick={deleteTenant} className="text-red-400 hover:text-red-600 text-xs font-bold uppercase px-2 hover:underline">
                            🗑️ Delete Tenant (Hard)
                        </button>
                    ) : <div></div>}

                    <div className="flex gap-4">
                        <button onClick={() => setEditingRoom(null)} className="px-6 py-3 text-slate-500 font-bold hover:bg-gray-200 rounded-lg transition-colors">Cancel</button>
                        <button onClick={saveTenant} disabled={loading} className="px-8 py-3 bg-slate-900 text-white rounded-lg font-bold shadow-lg hover:bg-black transition-transform hover:scale-105">
                            {loading ? 'Saving...' : 'Save Changes'}
                        </button>
                    </div>
                </div>
            )}
          </div>
        </div>
      )}
      
      {/* CSS Helper for Labels/Inputs */}
      <style jsx>{`
        .label { display: block; font-size: 0.75rem; font-weight: 700; text-transform: uppercase; color: #64748b; margin-bottom: 0.25rem; }
        .input { width: 100%; border: 1px solid #cbd5e1; padding: 0.75rem; border-radius: 0.5rem; font-weight: 500; color: #0f172a; outline: none; transition: border-color 0.2s; }
        .input:focus { border-color: #3b82f6; }
      `}</style>
    </div>
  );
}