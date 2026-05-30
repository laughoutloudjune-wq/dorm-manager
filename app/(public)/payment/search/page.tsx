"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Building, Search } from "lucide-react";
import { createClient } from "@/lib/supabase-client";

export default function SearchInvoicesPage() {
  const supabase = useMemo(() => createClient(), []);
  const [roomNumber, setRoomNumber] = useState("");
  const [invoices, setInvoices] = useState<any[]>([]);

  const handleSearch = async (event: React.FormEvent) => {
    event.preventDefault();
    setInvoices([]);

    const { data: room } = await supabase
      .from("rooms")
      .select("id")
      .eq("room_number", roomNumber)
      .single();

    if (!room) {
      toast.error("Room number not found. Please check and try again.");
      return;
    }

    const { data } = await supabase
      .from("invoices")
      .select("id,public_token,issue_date,total_amount,paid_amount,status")
      .eq("room_id", room.id)
      .in("status", ["pending", "partial", "overdue", "verifying"])
      .order("issue_date", { ascending: false });

    if (!data || data.length === 0) {
      toast.error("No unpaid invoices found. You're all caught up!");
      return;
    }

    setInvoices(data);
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-100 via-slate-50 to-white px-4 py-10">
      <div className="mx-auto flex w-full max-w-md flex-col gap-6">
        <header className="text-center animate-fade-in-down">
          <div className="inline-flex items-center gap-3 text-3xl font-semibold text-slate-900">
            <span className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500 to-cyan-500 text-white shadow-lg shadow-blue-600/25">
              <Building size={22} />
            </span>
            Apartment Flow
          </div>
          <p className="mt-3 text-sm text-slate-500">
            Enter your room number to view unpaid invoices.
          </p>
        </header>

        <main className="rounded-3xl border border-white/60 bg-white/90 p-6 shadow-xl backdrop-blur animate-fade-in-up">
          <form onSubmit={handleSearch} className="flex flex-col gap-3">
            <label className="text-sm font-medium text-slate-600">Room Number</label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-slate-400" />
              <input
                type="text"
                value={roomNumber}
                onChange={(event) => setRoomNumber(event.target.value)}
                placeholder="e.g. 101/1"
                className="w-full rounded-2xl border border-slate-200 bg-white px-10 py-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-600/40"
                required
              />
            </div>
            <button
              type="submit"
              className="rounded-2xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-blue-600/20 transition hover:-translate-y-0.5"
            >
              Search Invoices
            </button>
          </form>

          {invoices.length > 0 && (
            <div className="mt-6 border-t border-slate-100 pt-5">
              <h2 className="text-sm font-semibold text-slate-600">
                Results for Room <span className="text-blue-600">{roomNumber}</span>
              </h2>
              <ul className="mt-4 space-y-3">
                {invoices.map((invoice) => (
                  <li key={invoice.id}>
                    <Link
                      href={`/payment/${invoice.public_token}`}
                      className="block rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm transition hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-md"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="font-semibold text-slate-800">
                            Invoice {new Date(invoice.issue_date).toLocaleString("default", {
                              month: "long",
                            })}
                          </p>
                          <p className="text-xs text-slate-500">
                            Total: ฿{invoice.total_amount.toFixed(2)}
                          </p>
                          <p className="text-xs text-slate-500">
                            Remaining: ฿
                            {(Math.max(0, Number(invoice.total_amount || 0) - Number(invoice.paid_amount || 0))).toFixed(2)}
                          </p>
                        </div>
                        <span
                          className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                            invoice.status === "overdue"
                              ? "bg-red-100 text-red-700"
                              : invoice.status === "partial"
                              ? "bg-orange-100 text-orange-700"
                              : invoice.status === "verifying"
                              ? "bg-blue-100 text-blue-700"
                              : "bg-yellow-100 text-yellow-700"
                          }`}
                        >
                          {invoice.status.toUpperCase()}
                        </span>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </main>

        <footer className="text-center text-xs text-slate-400">&copy; {new Date().getFullYear()} Apartment Flow</footer>
      </div>
    </div>
  );
}
