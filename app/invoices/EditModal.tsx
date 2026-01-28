'use client';

import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';

export default function EditModal({ invoice, onClose, onSave }: any) {
  // Local state for the form inputs
  const [formData, setFormData] = useState({
    electric_units: 0,
    unit_price_elec: 7,
    water_units: 0,
    unit_price_water: 18,
    rent_cost: 3500,
    other_fees: 0,
    other_fees_description: '',
    discount: 0
  });

  const [calculatedTotal, setCalculatedTotal] = useState(0);

  // Load invoice data when the modal opens
  useEffect(() => {
    if (invoice) {
      setFormData({
        electric_units: invoice.electric_units || 0,
        unit_price_elec: invoice.unit_price_elec || 7,
        water_units: invoice.water_units || 0,
        unit_price_water: invoice.unit_price_water || 18,
        rent_cost: invoice.rent_cost || 3500,
        other_fees: invoice.other_fees || 0,
        other_fees_description: invoice.other_fees_description || '',
        discount: invoice.discount || 0
      });
    }
  }, [invoice]);

  // Real-time Calculation: Updates whenever you type
  useEffect(() => {
    const elecTotal = formData.electric_units * formData.unit_price_elec;
    const waterTotal = formData.water_units * formData.unit_price_water;
    const total = elecTotal + waterTotal + Number(formData.rent_cost) + Number(formData.other_fees) - Number(formData.discount);
    setCalculatedTotal(total);
  }, [formData]);

  const handleChange = (field: string, value: any) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const handleSave = async () => {
    // 1. Update Supabase
    const { error } = await supabase
      .from('invoices')
      .update({
        ...formData,
        total_amount: calculatedTotal, // Save the final calculated price
        water_cost: formData.water_units * formData.unit_price_water,
        electric_cost: formData.electric_units * formData.unit_price_elec
      })
      .eq('id', invoice.id);

    if (error) alert('Error saving: ' + error.message);
    else {
      onSave(); // Refresh the main list
      onClose(); // Close the popup
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex justify-center items-center z-50">
      <div className="bg-white p-6 rounded-lg shadow-xl w-full max-w-lg relative">
        <button onClick={onClose} className="absolute top-4 right-4 text-gray-400 hover:text-gray-600">✕</button>
        
        <h2 className="text-2xl font-bold mb-4">Edit Invoice: Room {invoice.rooms?.room_number}</h2>
        
        <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-2">
          
          {/* Section 1: Utilities */}
          <div className="bg-gray-50 p-3 rounded border">
            <h3 className="font-bold text-gray-700 mb-2">Utilities</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-gray-500 block">Elec Units</label>
                <input type="number" className="border p-1 w-full rounded" 
                  value={formData.electric_units} onChange={(e) => handleChange('electric_units', Number(e.target.value))} />
              </div>
              <div>
                <label className="text-xs text-gray-500 block">Price/Unit</label>
                <input type="number" className="border p-1 w-full rounded" 
                  value={formData.unit_price_elec} onChange={(e) => handleChange('unit_price_elec', Number(e.target.value))} />
              </div>
              <div>
                <label className="text-xs text-gray-500 block">Water Units</label>
                <input type="number" className="border p-1 w-full rounded" 
                  value={formData.water_units} onChange={(e) => handleChange('water_units', Number(e.target.value))} />
              </div>
              <div>
                <label className="text-xs text-gray-500 block">Price/Unit</label>
                <input type="number" className="border p-1 w-full rounded" 
                  value={formData.unit_price_water} onChange={(e) => handleChange('unit_price_water', Number(e.target.value))} />
              </div>
            </div>
          </div>

          {/* Section 2: Rent & Fees */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="font-bold text-gray-700 block mb-1">Rent</label>
              <input type="number" className="border p-2 w-full rounded" 
                value={formData.rent_cost} onChange={(e) => handleChange('rent_cost', Number(e.target.value))} />
            </div>
            <div>
              <label className="font-bold text-green-600 block mb-1">Discount (-)</label>
              <input type="number" className="border p-2 w-full rounded border-green-200" 
                value={formData.discount} onChange={(e) => handleChange('discount', Number(e.target.value))} />
            </div>
          </div>

          {/* Section 3: Extra Fees */}
          <div className="bg-yellow-50 p-3 rounded border border-yellow-100">
             <label className="font-bold text-yellow-800 block mb-1">Other Fees (+)</label>
             <div className="flex gap-2">
               <input type="text" placeholder="Description (e.g. WiFi)" className="border p-2 w-2/3 rounded" 
                 value={formData.other_fees_description} onChange={(e) => handleChange('other_fees_description', e.target.value)} />
               <input type="number" placeholder="0" className="border p-2 w-1/3 rounded" 
                 value={formData.other_fees} onChange={(e) => handleChange('other_fees', Number(e.target.value))} />
             </div>
          </div>

          {/* TOTAL */}
          <div className="flex justify-between items-center pt-4 border-t mt-4">
            <span className="text-gray-500">Grand Total:</span>
            <span className="text-3xl font-bold text-blue-600">{calculatedTotal.toLocaleString()} ฿</span>
          </div>

        </div>

        {/* Footer Actions */}
        <div className="flex justify-end gap-3 mt-6">
          <button onClick={onClose} className="px-4 py-2 text-gray-500 hover:bg-gray-100 rounded">Cancel</button>
          <button onClick={handleSave} className="px-6 py-2 bg-blue-600 text-white rounded shadow hover:bg-blue-700">Save Changes</button>
        </div>
      </div>
    </div>
  );
}