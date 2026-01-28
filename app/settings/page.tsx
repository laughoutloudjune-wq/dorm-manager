'use client';

import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';

export default function Settings() {
  // 1. Config State (General Settings)
  const [config, setConfig] = useState<any>({
    dorm_name: '', 
    address: '', 
    phone: '', 
    elec_rate: 0, 
    water_min_units: 0, 
    water_min_price: 0, 
    water_excess_rate: 0
  });

  const [methods, setMethods] = useState<any[]>([]);
  
  // 2. New Method State (FIXED: All fields initialized)
  const [newMethod, setNewMethod] = useState({
    label: '',
    type: 'text', // 'text' or 'qr'
    bank_name: '',
    account_number: '',
    account_name: '',
    qr_file: null as File | null
  });
  
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    const { data: settings } = await supabase.from('settings').select('*').single();
    if (settings) setConfig(settings);

    const { data: payMethods } = await supabase.from('payment_methods').select('*').order('created_at');
    setMethods(payMethods || []);
  };

  const handleSave = async () => {
    setSaving(true);
    
    // Safety check: Convert strings to numbers to avoid DB errors
    const safeConfig = {
        ...config,
        elec_rate: Number(config.elec_rate) || 0,
        water_min_units: Number(config.water_min_units) || 0,
        water_min_price: Number(config.water_min_price) || 0,
        water_excess_rate: Number(config.water_excess_rate) || 0,
    };

    // Upsert logic (Insert if not exists, Update if exists)
    const { count } = await supabase.from('settings').select('*', { count: 'exact', head: true }).eq('id', 1);
    
    if (count === 0) {
        await supabase.from('settings').insert({ id: 1, ...safeConfig });
    } else {
        await supabase.from('settings').update(safeConfig).eq('id', 1);
    }
    
    alert('✅ Settings Saved!');
    setSaving(false);
  };

  const addPaymentMethod = async () => {
    if (!newMethod.label) return alert("Please enter a name (e.g. KBank)");

    let qrUrl = null;
    
    // Upload QR if selected
    if (newMethod.type === 'qr' && newMethod.qr_file) {
      const fileName = `qr_${Date.now()}`;
      const { error } = await supabase.storage.from('slips').upload(fileName, newMethod.qr_file);
      
      if (!error) {
        const { data } = supabase.storage.from('slips').getPublicUrl(fileName);
        qrUrl = data.publicUrl;
      }
    }

    // Insert into DB
    const { error } = await supabase.from('payment_methods').insert({
      label: newMethod.label,
      type: newMethod.type,
      bank_name: newMethod.bank_name,
      account_number: newMethod.account_number,
      account_name: newMethod.account_name,
      qr_url: qrUrl
    });

    if (error) {
        alert(error.message);
    } else {
      // Reset form safely
      setNewMethod({
        label: '', 
        type: 'text', 
        bank_name: '', 
        account_number: '', 
        account_name: '', 
        qr_file: null
      });
      fetchData();
    }
  };

  const deleteMethod = async (id: string) => {
    if (confirm("Delete this payment method?")) {
      await supabase.from('payment_methods').delete().eq('id', id);
      fetchData();
    }
  };

  return (
    <div className="p-8 bg-gray-50 min-h-screen font-sans">
      <h1 className="text-3xl font-extrabold text-slate-900 mb-8">⚙️ Settings</h1>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-8">
        
        {/* CARD 1: GENERAL INFO */}
        <div className="bg-white p-6 rounded-xl shadow-md border border-slate-200">
          <h2 className="text-xl font-bold text-slate-800 mb-6 border-b pb-4">🏢 General Information</h2>
          
          <div className="space-y-6">
            <div>
              <label className="block text-sm font-bold text-slate-700 mb-2 uppercase">Dorm Name</label>
              <input 
                value={config.dorm_name || ''} 
                onChange={e => setConfig({...config, dorm_name: e.target.value})} 
                className="w-full border-2 border-slate-300 p-3 rounded-lg font-medium outline-none focus:border-blue-500 text-slate-900"
              />
            </div>
            
            <div>
              <label className="block text-sm font-bold text-slate-700 mb-2 uppercase">Address</label>
              <textarea 
                value={config.address || ''} 
                onChange={e => setConfig({...config, address: e.target.value})} 
                className="w-full border-2 border-slate-300 p-3 rounded-lg font-medium h-32 outline-none focus:border-blue-500 text-slate-900"
              />
            </div>

            <div className="bg-slate-50 p-5 rounded-xl border border-slate-200">
              <h3 className="font-bold text-slate-800 mb-4">Utility Rates</h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                    <label className="text-xs font-bold text-yellow-700">Elec (B/Unit)</label>
                    <input type="number" value={config.elec_rate || 0} onChange={e=>setConfig({...config, elec_rate:e.target.value})} className="w-full border-2 border-slate-300 p-2 rounded text-center font-bold text-slate-900"/>
                </div>
                <div>
                    <label className="text-xs font-bold text-blue-700">Water Excess (B/Unit)</label>
                    <input type="number" value={config.water_excess_rate || 0} onChange={e=>setConfig({...config, water_excess_rate:e.target.value})} className="w-full border-2 border-slate-300 p-2 rounded text-center font-bold text-slate-900"/>
                </div>
                <div>
                    <label className="text-xs font-bold text-blue-700">Water Min Units</label>
                    <input type="number" value={config.water_min_units || 0} onChange={e=>setConfig({...config, water_min_units:e.target.value})} className="w-full border-2 border-slate-300 p-2 rounded text-center font-bold text-slate-900"/>
                </div>
                <div>
                    <label className="text-xs font-bold text-blue-700">Water Min Price (฿)</label>
                    <input type="number" value={config.water_min_price || 0} onChange={e=>setConfig({...config, water_min_price:e.target.value})} className="w-full border-2 border-slate-300 p-2 rounded text-center font-bold text-slate-900"/>
                </div>
              </div>
            </div>
            <button onClick={handleSave} disabled={saving} className="w-full py-3 bg-slate-900 text-white rounded-xl font-bold shadow-lg hover:bg-black">
                {saving ? 'Saving...' : '💾 Save Settings'}
            </button>
          </div>
        </div>

        {/* CARD 2: PAYMENT METHODS */}
        <div className="bg-white p-6 rounded-xl shadow-md border border-slate-200">
          <h2 className="text-xl font-bold text-slate-800 mb-6 border-b pb-4">💳 Payment Methods</h2>
          
          <div className="space-y-4 mb-8">
            {methods.map(m => (
              <div key={m.id} className="flex justify-between items-center border-2 border-slate-200 p-4 rounded-xl">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-slate-100 rounded-lg flex items-center justify-center border overflow-hidden">
                    {m.type === 'qr' && m.qr_url ? (
                        <img src={m.qr_url} className="w-full h-full object-cover" alt="QR" />
                    ) : (
                        <span className="text-2xl">🏦</span>
                    )}
                  </div>
                  <div>
                    <div className="font-bold text-slate-900">{m.label}</div>
                    <div className="text-xs text-slate-500">
                      {m.type === 'qr' ? 'QR Code' : `${m.bank_name || 'Bank'} - ${m.account_number}`}
                    </div>
                  </div>
                </div>
                <button onClick={() => deleteMethod(m.id)} className="text-red-500 hover:bg-red-50 p-2 rounded-full">✕</button>
              </div>
            ))}
          </div>

          <div className="bg-blue-50 p-6 rounded-xl border-2 border-blue-100">
            <h3 className="font-bold text-blue-900 mb-4">+ Add New Method</h3>
            <div className="space-y-4">
              <input 
                placeholder="Label (e.g. KBank Main)" 
                value={newMethod.label || ''} 
                onChange={e => setNewMethod({...newMethod, label: e.target.value})} 
                className="w-full border-2 border-blue-200 p-3 rounded-lg font-medium text-slate-900"
              />
              
              <select 
                value={newMethod.type || 'text'} 
                onChange={e => setNewMethod({...newMethod, type: e.target.value})} 
                className="w-full border-2 border-blue-200 p-3 rounded-lg font-medium bg-white text-slate-900"
              >
                <option value="text">Bank Account</option>
                <option value="qr">QR Code</option>
              </select>

              {newMethod.type === 'text' ? (
                <div className="space-y-3 animate-in fade-in">
                  <input 
                    placeholder="Bank Name (e.g. Kasikorn)" 
                    value={newMethod.bank_name || ''} 
                    onChange={e => setNewMethod({...newMethod, bank_name: e.target.value})} 
                    className="w-full border-2 border-blue-200 p-3 rounded-lg text-slate-900"
                  />
                  <input 
                    placeholder="Account Number" 
                    value={newMethod.account_number || ''} 
                    onChange={e => setNewMethod({...newMethod, account_number: e.target.value})} 
                    className="w-full border-2 border-blue-200 p-3 rounded-lg text-slate-900"
                  />
                  <input 
                    placeholder="Account Name" 
                    value={newMethod.account_name || ''} 
                    onChange={e => setNewMethod({...newMethod, account_name: e.target.value})} 
                    className="w-full border-2 border-blue-200 p-3 rounded-lg text-slate-900"
                  />
                </div>
              ) : (
                <div className="animate-in fade-in">
                  <label className="block text-xs font-bold text-blue-800 uppercase mb-1">Upload QR Image</label>
                  <input 
                    type="file" 
                    onChange={e => setNewMethod({...newMethod, qr_file: e.target.files?.[0] || null})} 
                    className="w-full bg-white border-2 border-blue-200 p-2 rounded-lg text-sm text-slate-500"
                  />
                </div>
              )}

              <button onClick={addPaymentMethod} className="w-full py-3 bg-blue-600 text-white rounded-lg font-bold shadow hover:bg-blue-700">
                Add Method
              </button>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}