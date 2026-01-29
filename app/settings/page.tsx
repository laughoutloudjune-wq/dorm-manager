'use client';

import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';

export default function Settings() {
  const [activeTab, setActiveTab] = useState('general');
  
  // 1. Config State
  const defaultConfig = {
    dorm_name: '', address: '', phone: '', 
    elec_rate: 0, water_min_units: 0, water_min_price: 0, water_excess_rate: 0,
    late_fee_amount: 0, due_day: 5,
    common_fee: 0, common_fee_label: 'Common Fee' // NEW
  };

  const [config, setConfig] = useState<any>(defaultConfig);
  const [methods, setMethods] = useState<any[]>([]);
  const [newMethod, setNewMethod] = useState({
    label: '', type: 'text', bank_name: '', account_number: '', account_name: '', qr_file: null as File | null
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => { fetchData(); }, []);

  const fetchData = async () => {
    const { data: settings } = await supabase.from('settings').select('*').single();
    if (settings) setConfig((prev: any) => ({ ...prev, ...settings }));

    const { data: payMethods } = await supabase.from('payment_methods').select('*').order('created_at');
    setMethods(payMethods || []);
  };

  const handleSave = async () => {
    setSaving(true);
    const safeConfig = {
        ...config,
        elec_rate: Number(config.elec_rate),
        water_min_units: Number(config.water_min_units),
        water_min_price: Number(config.water_min_price),
        water_excess_rate: Number(config.water_excess_rate),
        late_fee_amount: Number(config.late_fee_amount),
        due_day: Number(config.due_day),
        common_fee: Number(config.common_fee) // NEW
    };

    const { count } = await supabase.from('settings').select('*', { count: 'exact', head: true }).eq('id', 1);
    if (count === 0) await supabase.from('settings').insert({ id: 1, ...safeConfig });
    else await supabase.from('settings').update(safeConfig).eq('id', 1);
    
    alert('✅ Settings Saved!');
    setSaving(false);
  };

  const addPaymentMethod = async () => {
    if (!newMethod.label) return alert("Please enter a name");
    let qrUrl = null;
    if (newMethod.type === 'qr' && newMethod.qr_file) {
      const fileName = `qr_${Date.now()}`;
      const { error } = await supabase.storage.from('slips').upload(fileName, newMethod.qr_file);
      if (!error) {
        const { data } = supabase.storage.from('slips').getPublicUrl(fileName);
        qrUrl = data.publicUrl;
      }
    }
    await supabase.from('payment_methods').insert({
      label: newMethod.label, type: newMethod.type, bank_name: newMethod.bank_name,
      account_number: newMethod.account_number, account_name: newMethod.account_name, qr_url: qrUrl
    });
    setNewMethod({ label: '', type: 'text', bank_name: '', account_number: '', account_name: '', qr_file: null });
    fetchData();
  };

  const deleteMethod = async (id: string) => {
    if (!confirm("Remove this payment method?")) return;
    await supabase.from('payment_methods').delete().eq('id', id);
    fetchData();
  };

  return (
    <div className="p-8 bg-gray-50 min-h-screen font-sans">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-extrabold text-slate-900">⚙️ Settings</h1>
        <button onClick={handleSave} disabled={saving} className="bg-slate-900 text-white px-8 py-3 rounded-xl font-bold shadow-lg hover:bg-black transition-all">
            {saving ? 'Saving...' : '💾 Save Changes'}
        </button>
      </div>

      {/* TABS */}
      <div className="flex gap-2 mb-8 border-b-2 border-gray-200">
        {['General', 'Utilities', 'Invoice Config', 'Payment Methods'].map((tab) => {
            const key = tab.toLowerCase().replace(' ', '');
            return (
                <button 
                    key={key} 
                    onClick={() => setActiveTab(key)}
                    className={`px-6 py-3 font-bold text-sm uppercase tracking-wide transition-all ${activeTab === key ? 'border-b-4 border-blue-600 text-blue-700 bg-blue-50' : 'text-gray-400 hover:text-gray-600'}`}
                >
                    {tab}
                </button>
            )
        })}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-8 items-start">
        
        {/* TAB 1: GENERAL */}
        {activeTab === 'general' && (
            <div className="bg-white p-8 rounded-xl shadow-sm border border-gray-200 space-y-6 animate-in fade-in">
                <h2 className="text-xl font-bold text-slate-900 border-b pb-4">🏢 Dorm Information</h2>
                <div><label className="label">Dorm Name</label><input value={config.dorm_name || ''} onChange={e => setConfig({...config, dorm_name: e.target.value})} className="input" /></div>
                <div><label className="label">Address</label><textarea value={config.address || ''} onChange={e => setConfig({...config, address: e.target.value})} className="input h-32" /></div>
                <div><label className="label">Contact Phone</label><input value={config.phone || ''} onChange={e => setConfig({...config, phone: e.target.value})} className="input" /></div>
            </div>
        )}

        {/* TAB 2: UTILITIES */}
        {activeTab === 'utilities' && (
            <div className="bg-white p-8 rounded-xl shadow-sm border border-gray-200 space-y-6 animate-in fade-in">
                <h2 className="text-xl font-bold text-slate-900 border-b pb-4">⚡ Water & Electric</h2>
                <div className="grid grid-cols-2 gap-6">
                    <div><label className="label text-yellow-600">Electricity (฿/Unit)</label><input type="number" className="input text-center font-mono font-bold text-lg" value={config.elec_rate} onChange={e=>setConfig({...config, elec_rate: e.target.value})} /></div>
                    <div><label className="label text-blue-600">Water (฿/Unit)</label><input type="number" className="input text-center font-mono font-bold text-lg" value={config.water_excess_rate} onChange={e=>setConfig({...config, water_excess_rate: e.target.value})} /></div>
                    <div><label className="label text-blue-600">Water Min Units</label><input type="number" className="input text-center" value={config.water_min_units} onChange={e=>setConfig({...config, water_min_units: e.target.value})} /></div>
                    <div><label className="label text-blue-600">Water Min Price (฿)</label><input type="number" className="input text-center" value={config.water_min_price} onChange={e=>setConfig({...config, water_min_price: e.target.value})} /></div>
                </div>
            </div>
        )}

        {/* TAB 3: INVOICE CONFIG (NEW) */}
        {activeTab === 'invoiceconfig' && (
            <div className="space-y-6 animate-in fade-in">
                {/* LATE FEE */}
                <div className="bg-red-50 p-8 rounded-xl border border-red-100">
                    <h2 className="text-xl font-bold text-red-900 border-b border-red-200 pb-4 mb-6">Late Fee Policy</h2>
                    <div className="grid grid-cols-2 gap-6">
                        <div>
                            <label className="label text-red-800">Due Day (of month)</label>
                            <input type="number" className="input border-red-200 text-red-900 font-bold" value={config.due_day} onChange={e=>setConfig({...config, due_day: e.target.value})} />
                            <p className="text-xs text-red-600 mt-2">Example: 5 = 5th of every month</p>
                        </div>
                        <div>
                            <label className="label text-red-800">Daily Fine (฿)</label>
                            <input type="number" className="input border-red-200 text-red-900 font-bold" value={config.late_fee_amount} onChange={e=>setConfig({...config, late_fee_amount: e.target.value})} />
                            <p className="text-xs text-red-600 mt-2">Added for every day past due date</p>
                        </div>
                    </div>
                </div>

                {/* COMMON FEE */}
                <div className="bg-blue-50 p-8 rounded-xl border border-blue-100">
                    <h2 className="text-xl font-bold text-blue-900 border-b border-blue-200 pb-4 mb-6">Recurring Fees</h2>
                    <div className="grid grid-cols-1 gap-6">
                        <div>
                            <label className="label text-blue-800">Common Fee Label</label>
                            <input className="input border-blue-200" placeholder="e.g. Common Fee (ค่าส่วนกลาง)" value={config.common_fee_label} onChange={e=>setConfig({...config, common_fee_label: e.target.value})} />
                        </div>
                        <div>
                            <label className="label text-blue-800">Monthly Amount (฿)</label>
                            <input type="number" className="input border-blue-200 font-bold" value={config.common_fee} onChange={e=>setConfig({...config, common_fee: e.target.value})} />
                            <p className="text-xs text-blue-600 mt-2">This amount will be added to every new invoice automatically.</p>
                        </div>
                    </div>
                </div>
            </div>
        )}

        {/* TAB 4: PAYMENT METHODS */}
        {activeTab === 'paymentmethods' && (
            <div className="space-y-6 animate-in fade-in">
                <div className="bg-white p-6 rounded-xl border border-gray-200">
                    <h2 className="text-xl font-bold text-slate-900 mb-6">Current Methods</h2>
                    <div className="space-y-3">
                        {methods.map(m => (
                        <div key={m.id} className="flex justify-between items-center p-4 border rounded-lg bg-gray-50">
                            <div className="flex items-center gap-3">
                                {m.type === 'qr' && m.qr_url ? <img src={m.qr_url} className="w-10 h-10 object-cover rounded" /> : <span className="text-2xl">🏦</span>}
                                <div><div className="font-bold text-slate-800">{m.label}</div><div className="text-xs text-gray-500">{m.bank_name} {m.account_number}</div></div>
                            </div>
                            <button onClick={() => deleteMethod(m.id)} className="text-red-500 hover:text-red-700">✕</button>
                        </div>
                        ))}
                    </div>
                </div>

                <div className="bg-white p-6 rounded-xl border border-gray-200">
                    <h2 className="text-lg font-bold text-slate-900 mb-4">+ Add New</h2>
                    <div className="space-y-4">
                        <input className="input" placeholder="Label (e.g. Main Bank)" value={newMethod.label} onChange={e => setNewMethod({...newMethod, label: e.target.value})} />
                        <select className="input" value={newMethod.type} onChange={e => setNewMethod({...newMethod, type: e.target.value})}><option value="text">Bank Transfer</option><option value="qr">QR Code</option></select>
                        {newMethod.type === 'text' ? (
                            <div className="space-y-4">
                                <input className="input" placeholder="Bank Name" value={newMethod.bank_name} onChange={e => setNewMethod({...newMethod, bank_name: e.target.value})} />
                                <input className="input" placeholder="Account Number" value={newMethod.account_number} onChange={e => setNewMethod({...newMethod, account_number: e.target.value})} />
                                <input className="input" placeholder="Account Name" value={newMethod.account_name} onChange={e => setNewMethod({...newMethod, account_name: e.target.value})} />
                            </div>
                        ) : (
                            <input type="file" className="input" onChange={(e:any) => setNewMethod({...newMethod, qr_file: e.target.files?.[0]})} />
                        )}
                        <button onClick={addPaymentMethod} className="w-full bg-blue-600 text-white font-bold py-3 rounded-lg">Add Method</button>
                    </div>
                </div>
            </div>
        )}

      </div>

      <style jsx>{`
        .label { display: block; font-size: 0.75rem; font-weight: 800; text-transform: uppercase; margin-bottom: 0.5rem; letter-spacing: 0.05em; }
        .input { width: 100%; padding: 0.75rem; border-radius: 0.5rem; border: 1px solid #e2e8f0; outline: none; transition: all 0.2s; color: #1e293b; }
        .input:focus { border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1); }
      `}</style>
    </div>
  );
}