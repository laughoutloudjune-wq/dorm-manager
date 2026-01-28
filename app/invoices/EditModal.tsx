'use client';

import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';

export default function EditModal({ invoice, onClose, onSave }: any) {
  // 1. Utility States
  const [elecUnits, setElecUnits] = useState(0);
  const [elecPrice, setElecPrice] = useState(7);
  const [waterUnits, setWaterUnits] = useState(0);
  const [waterPrice, setWaterPrice] = useState(18);
  
  // 2. Rent & Lists States
  const [rent, setRent] = useState(3500);
  const [feesList, setFeesList] = useState<{name: string, amount: number}[]>([]);
  const [discountList, setDiscountList] = useState<{name: string, amount: number}[]>([]);
  
  // 3. Calculated Total State
  const [calculatedTotal, setCalculatedTotal] = useState(0);

  // Load Data
  useEffect(() => {
    if (invoice) {
      setElecUnits(invoice.electric_units || 0);
      setElecPrice(invoice.unit_price_elec || 7);
      setWaterUnits(invoice.water_units || 0);
      setWaterPrice(invoice.unit_price_water || 18);
      setRent(invoice.rent_cost || 3500);

      // Convert existing single fee/discount into a list item if it exists
      const initialFees = invoice.other_fees > 0 
        ? [{ name: invoice.other_fees_description || 'Other Fee', amount: invoice.other_fees }] 
        : [];
      setFeesList(initialFees);

      const initialDiscounts = invoice.discount > 0
        ? [{ name: invoice.discount_description || 'Discount', amount: invoice.discount }]
        : [];
      setDiscountList(initialDiscounts);
    }
  }, [invoice]);

  // Real-time Calculation
  const elecCost = elecUnits * elecPrice;
  const waterCost = waterUnits * waterPrice;
  const totalFees = feesList.reduce((sum, item) => sum + (Number(item.amount)||0), 0);
  const totalDiscounts = discountList.reduce((sum, item) => sum + (Number(item.amount)||0), 0);

  useEffect(() => {
    const total = elecCost + waterCost + Number(rent) + totalFees - totalDiscounts;
    setCalculatedTotal(total);
  }, [elecCost, waterCost, rent, totalFees, totalDiscounts]);

  // List Handlers
  const addFee = () => setFeesList([...feesList, { name: '', amount: 0 }]);
  const removeFee = (idx: number) => setFeesList(feesList.filter((_, i) => i !== idx));
  const updateFee = (idx: number, field: string, value: any) => {
    const newFees: any = [...feesList];
    newFees[idx][field] = value;
    setFeesList(newFees);
  };

  const addDiscount = () => setDiscountList([...discountList, { name: '', amount: 0 }]);
  const removeDiscount = (idx: number) => setDiscountList(discountList.filter((_, i) => i !== idx));
  const updateDiscount = (idx: number, field: string, value: any) => {
    const newDisc: any = [...discountList];
    newDisc[idx][field] = value;
    setDiscountList(newDisc);
  };

  const handleSave = async () => {
    const feesDesc = feesList.map(f => f.name).filter(n => n).join(', ');
    const discountDesc = discountList.map(d => d.name).filter(n => n).join(', ');

    const { error } = await supabase
      .from('invoices')
      .update({
        rent_cost: rent,
        electric_units: elecUnits,
        unit_price_elec: elecPrice,
        electric_cost: elecCost,
        water_units: waterUnits,
        unit_price_water: waterPrice,
        water_cost: waterCost,
        other_fees: totalFees,
        other_fees_description: feesDesc,
        discount: totalDiscounts,
        discount_description: discountDesc,
        total_amount: calculatedTotal
      })
      .eq('id', invoice.id);

    if (error) alert('Error saving: ' + error.message);
    else {
      onSave();
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex justify-center items-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg flex flex-col max-h-[90vh] overflow-hidden">
        
        {/* Header */}
        <div className="bg-white border-b border-gray-100 p-5 flex justify-between items-center shrink-0">
            <div>
                <h2 className="text-xl font-bold text-gray-900">Edit Invoice</h2>
                <div className="text-sm text-gray-500">Room {invoice.rooms?.room_number} • {invoice.month}/{invoice.year}</div>
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 font-bold text-xl px-2">✕</button>
        </div>
        
        <div className="p-6 space-y-6 overflow-y-auto">
          
          {/* 1. Utilities */}
          <div>
            <h3 className="text-xs font-bold text-gray-400 uppercase mb-3">Utilities</h3>
            
            <div className="grid grid-cols-10 gap-3 text-xs font-semibold text-gray-500 mb-1">
                <div className="col-span-3">Units</div>
                <div className="col-span-3">Price/Unit</div>
                <div className="col-span-4 text-right">Total</div>
            </div>

            {/* Electricity */}
            <div className="grid grid-cols-10 gap-3 items-center mb-2">
                <div className="col-span-3 relative">
                    <span className="absolute left-2 top-2 text-xs text-gray-400">Elec</span>
                    <input type="number" className="border border-gray-300 pl-8 p-2 w-full rounded text-gray-900 font-medium text-sm" value={elecUnits} onChange={(e) => setElecUnits(Number(e.target.value))} />
                </div>
                <div className="col-span-3"><input type="number" className="border border-gray-300 p-2 w-full rounded text-center text-gray-900 text-sm" value={elecPrice} onChange={(e) => setElecPrice(Number(e.target.value))} /></div>
                <div className="col-span-4 text-right">
                    <div className="bg-gray-100 py-2 px-3 rounded text-gray-700 font-bold text-sm border border-gray-200">
                        {elecCost.toLocaleString()}
                    </div>
                </div>
            </div>

            {/* Water */}
            <div className="grid grid-cols-10 gap-3 items-center">
                <div className="col-span-3 relative">
                    <span className="absolute left-2 top-2 text-xs text-gray-400">Wtr</span>
                    <input type="number" className="border border-gray-300 pl-8 p-2 w-full rounded text-gray-900 font-medium text-sm" value={waterUnits} onChange={(e) => setWaterUnits(Number(e.target.value))} />
                </div>
                <div className="col-span-3"><input type="number" className="border border-gray-300 p-2 w-full rounded text-center text-gray-900 text-sm" value={waterPrice} onChange={(e) => setWaterPrice(Number(e.target.value))} /></div>
                <div className="col-span-4 text-right">
                    <div className="bg-gray-100 py-2 px-3 rounded text-gray-700 font-bold text-sm border border-gray-200">
                        {waterCost.toLocaleString()}
                    </div>
                </div>
            </div>
          </div>

          <hr className="border-gray-100" />

          {/* 2. Rent */}
          <div>
              <label className="text-xs font-bold text-gray-400 uppercase mb-2 block">Room Rent</label>
              <input type="number" className="border border-gray-300 p-3 w-full rounded text-gray-900 font-bold text-lg" value={rent} onChange={(e) => setRent(Number(e.target.value))} />
          </div>

          <hr className="border-gray-100" />

          {/* 3. Fees & Discounts */}
          <div className="space-y-4">
             {/* Fees */}
             <div>
                 <div className="flex justify-between items-center mb-2">
                    <label className="text-xs font-bold text-gray-400 uppercase">Other Fees (+)</label>
                    <button onClick={addFee} className="text-xs text-blue-600 hover:text-blue-800 font-bold">+ Add</button>
                 </div>
                 {feesList.map((fee, idx) => (
                    <div key={idx} className="flex gap-2 mb-2">
                        <input type="text" placeholder="Description" className="flex-1 border border-gray-300 p-2 rounded text-sm text-gray-900" value={fee.name} onChange={(e) => updateFee(idx, 'name', e.target.value)} />
                        <input type="number" placeholder="0" className="w-24 border border-gray-300 p-2 rounded text-right font-medium text-sm text-gray-900" value={fee.amount} onChange={(e) => updateFee(idx, 'amount', Number(e.target.value))} />
                        <button onClick={() => removeFee(idx)} className="text-gray-400 hover:text-red-500 px-1">×</button>
                    </div>
                 ))}
             </div>

             {/* Discounts */}
             <div>
                 <div className="flex justify-between items-center mb-2">
                    <label className="text-xs font-bold text-gray-400 uppercase">Discounts (-)</label>
                    <button onClick={addDiscount} className="text-xs text-blue-600 hover:text-blue-800 font-bold">+ Add</button>
                 </div>
                 {discountList.map((disc, idx) => (
                    <div key={idx} className="flex gap-2 mb-2">
                        <input type="text" placeholder="Reason" className="flex-1 border border-gray-300 p-2 rounded text-sm text-gray-900" value={disc.name} onChange={(e) => updateDiscount(idx, 'name', e.target.value)} />
                        <input type="number" placeholder="0" className="w-24 border border-gray-300 p-2 rounded text-right font-medium text-sm text-green-700" value={disc.amount} onChange={(e) => updateDiscount(idx, 'amount', Number(e.target.value))} />
                        <button onClick={() => removeDiscount(idx)} className="text-gray-400 hover:text-red-500 px-1">×</button>
                    </div>
                 ))}
             </div>
          </div>

          {/* TOTAL */}
          <div className="bg-gray-50 -mx-6 -mb-6 p-6 border-t border-gray-100 mt-4 flex justify-between items-center">
            <span className="text-gray-500 font-bold">Grand Total</span>
            <span className="text-3xl font-black text-gray-900">{calculatedTotal.toLocaleString()} <span className="text-lg text-gray-400 font-normal">฿</span></span>
          </div>

        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-100 flex justify-end gap-3 bg-white shrink-0">
          <button onClick={onClose} className="px-5 py-2 text-gray-600 hover:bg-gray-100 rounded-lg font-bold text-sm">Cancel</button>
          <button onClick={handleSave} className="px-6 py-2 bg-slate-900 text-white rounded-lg shadow hover:bg-black font-bold text-sm">Save Changes</button>
        </div>
      </div>
    </div>
  );
}