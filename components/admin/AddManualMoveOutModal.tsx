"use client";

import { useEffect, useState, useRef } from "react";
import { toast } from "sonner";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { createClient } from "@/lib/supabase-client";
import { Loader2, Search, ChevronDown } from "lucide-react";

type TenantOption = {
  id: string;
  full_name: string;
  rooms: { room_number: string } | { room_number: string }[] | null;
};

type Props = {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
};

export function AddManualMoveOutModal({ isOpen, onClose, onSuccess }: Props) {
  const [loading, setLoading] = useState(false);
  const [tenants, setTenants] = useState<TenantOption[]>([]);
  
  const [selectedTenantId, setSelectedTenantId] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const [moveOutDate, setMoveOutDate] = useState(() => new Date().toISOString().slice(0, 10));

  useEffect(() => {
    if (isOpen) {
      loadTenants();
      setSelectedTenantId("");
      setSearchQuery("");
      setMoveOutDate(new Date().toISOString().slice(0, 10));
      setIsDropdownOpen(false);
    }
  }, [isOpen]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const loadTenants = async () => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("tenants")
      .select("id, full_name, rooms(room_number)")
      .eq("status", "active")
      .is("move_out_date", null)
      .order("full_name");

    if (error) {
      toast.error("ดึงข้อมูลผู้เช่าไม่สำเร็จ: " + error.message);
    } else {
      setTenants(data || []);
    }
  };

  const getRoomNumber = (t: TenantOption) => {
    return Array.isArray(t.rooms) ? t.rooms[0]?.room_number : t.rooms?.room_number;
  };

  const filteredTenants = tenants.filter(t => {
    const q = searchQuery.toLowerCase();
    const room = getRoomNumber(t)?.toLowerCase() || "";
    return t.full_name.toLowerCase().includes(q) || room.includes(q);
  });

  const handleSelectTenant = (t: TenantOption) => {
    setSelectedTenantId(t.id);
    const room = getRoomNumber(t);
    setSearchQuery(room ? `[ห้อง ${room}] ${t.full_name}` : t.full_name);
    setIsDropdownOpen(false);
  };

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
    setSelectedTenantId(""); // Clear selection if typing manually
    setIsDropdownOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTenantId) {
      toast.error("กรุณาเลือกผู้เช่าจากรายการ");
      return;
    }
    if (!moveOutDate) {
      toast.error("กรุณาเลือกวันย้ายออก");
      return;
    }

    setLoading(true);
    try {
      const supabase = createClient();
      const { data: authData } = await supabase.auth.getSession();
      const token = authData.session?.access_token;
      if (!token) throw new Error("เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่");

      const res = await fetch("/api/admin/tenants/actions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          action: "save_tenant",
          payload: {
            id: selectedTenantId,
            move_out_date: moveOutDate,
          },
        }),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || "บันทึกข้อมูลไม่สำเร็จ");
      }

      toast.success("เพิ่มรายการย้ายออกแบบกำหนดเองเรียบร้อยแล้ว");
      onSuccess();
      onClose();
    } catch (error: any) {
      toast.error(error.message || "เกิดข้อผิดพลาด");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="เพิ่มย้ายออกแบบกำหนดเอง" size="md">
      <form onSubmit={handleSubmit} className="p-4 md:p-6 space-y-4 overflow-visible">
        <div ref={dropdownRef} className="relative">
          <label className="block text-sm font-medium text-slate-700 mb-1.5">ค้นหาและเลือกผู้เช่า</label>
          <div className="relative">
            <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-slate-400">
              <Search className="h-4 w-4" />
            </div>
            <input
              type="text"
              value={searchQuery}
              onChange={handleSearchChange}
              onFocus={() => setIsDropdownOpen(true)}
              placeholder="พิมพ์ชื่อหรือเลขห้องเพื่อค้นหา..."
              className="w-full rounded-xl border border-slate-300 bg-white pl-10 pr-10 py-2 text-sm text-slate-900 focus:border-primary-500 focus:ring-1 focus:ring-primary-500 disabled:opacity-50"
              disabled={loading || tenants.length === 0}
            />
            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-slate-400">
              <ChevronDown className="h-4 w-4" />
            </div>
          </div>
          
          {isDropdownOpen && tenants.length > 0 && (
            <div className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-xl border border-slate-200 bg-white py-1 shadow-lg shadow-black/5">
              {filteredTenants.length === 0 ? (
                <div className="px-4 py-3 text-sm text-slate-500">ไม่พบผู้เช่าที่ค้นหา</div>
              ) : (
                filteredTenants.map((t) => {
                  const roomNumber = getRoomNumber(t);
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => handleSelectTenant(t)}
                      className="flex w-full items-center px-4 py-2.5 text-left text-sm hover:bg-primary-50 hover:text-primary-900 transition-colors"
                    >
                      {roomNumber ? <span className="font-semibold w-16 shrink-0 text-slate-500">ห้อง {roomNumber}</span> : null}
                      <span className="font-medium">{t.full_name}</span>
                    </button>
                  );
                })
              )}
            </div>
          )}
          
          {tenants.length === 0 && (
            <p className="mt-1.5 text-xs text-amber-600">ไม่มีผู้เช่าที่สามารถตั้งค่าย้ายออกได้ในขณะนี้</p>
          )}
        </div>

        <div>
          <Input
            label="วันที่ย้ายออก"
            type="date"
            value={moveOutDate}
            onChange={(e) => setMoveOutDate(e.target.value)}
            required
            disabled={loading}
          />
        </div>

        <div className="flex justify-end gap-3 pt-4 border-t border-slate-100">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            ยกเลิก
          </button>
          <button
            type="submit"
            disabled={loading || !selectedTenantId}
            className="inline-flex items-center gap-2 rounded-xl bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            ยืนยัน
          </button>
        </div>
      </form>
    </Modal>
  );
}
