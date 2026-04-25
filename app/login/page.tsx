"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Building } from "lucide-react";
import { createClient } from "@/lib/supabase-client";

export default function LoginPage() {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    const checkSession = async () => {
      const { data } = await supabase.auth.getSession();
      if (!mounted) return;
      if (data.session) {
        router.replace("/");
        return;
      }
      setChecking(false);
    };

    void checkSession();
    return () => {
      mounted = false;
    };
  }, [router, supabase]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    setLoading(false);

    if (signInError) {
      setError(signInError.message);
      return;
    }

    router.replace("/");
  };

  if (checking) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3">
        <span className="inline-flex h-9 w-9 animate-pulse rounded-xl bg-gradient-to-br from-blue-500 to-cyan-500 opacity-80 shadow-lg shadow-blue-600/20" />
        <p className="text-sm text-slate-500">Checking session…</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="mx-auto w-full max-w-[26rem] animate-fade-in-up">
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="mb-3 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500 to-cyan-500 text-white shadow-lg shadow-blue-600/25 ring-1 ring-white/20">
            <Building size={24} />
          </span>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Admin login</h1>
          <p className="mt-1.5 text-sm text-slate-500">Sign in to Apartment Flow</p>
        </div>

        <div className="rounded-2xl border border-slate-200/80 bg-white/95 p-6 shadow-soft-lg backdrop-blur-sm">
          <form onSubmit={handleSubmit} className="space-y-4">
            <label className="block text-sm text-slate-600">
              <span className="font-medium text-slate-800">Email</span>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="mt-2 w-full rounded-xl border border-slate-200/90 bg-white px-4 py-2.5 text-sm text-slate-900 shadow-sm transition placeholder:text-slate-400 focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                required
                autoComplete="email"
                placeholder="you@example.com"
              />
            </label>

            <label className="block text-sm text-slate-600">
              <span className="font-medium text-slate-800">Password</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="mt-2 w-full rounded-xl border border-slate-200/90 bg-white px-4 py-2.5 text-sm text-slate-900 shadow-sm transition focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                required
                autoComplete="current-password"
              />
            </label>

            {error && (
              <p className="rounded-xl border border-red-200/80 bg-red-50/90 px-3 py-2.5 text-xs text-red-800">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-xl bg-gradient-to-b from-blue-600 to-blue-700 px-4 py-2.5 text-sm font-semibold text-white shadow-md shadow-blue-600/20 transition hover:brightness-105 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500/50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
