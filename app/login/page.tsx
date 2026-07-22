"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Building } from "lucide-react";
import { createClient } from "@/lib/supabase-client";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

export default function LoginPage() {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);

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

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    setLoading(false);

    if (signInError) {
      toast.error(signInError.message);
      return;
    }

    router.replace("/");
  };

  if (checking) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3">
        <span className="inline-flex h-10 w-10 animate-pulse rounded-[0.75rem] bg-primary-600 opacity-90 shadow-float-md" />
        <p className="text-sm text-slate-500">Checking session…</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="mx-auto w-full max-w-[26rem] animate-fade-in-up">
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="mb-3 inline-flex h-12 w-12 items-center justify-center rounded-[0.875rem] bg-primary-600 text-white shadow-float-md">
            <Building size={24} />
          </span>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Admin login</h1>
          <p className="mt-1.5 text-sm text-slate-500">Sign in to Apartment Flow</p>
        </div>

        <div className="rounded-panel border border-slate-200/70 bg-white p-6 shadow-float-lg">
          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              label="Email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              autoComplete="email"
              placeholder="you@example.com"
            />

            <Input
              label="Password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              autoComplete="current-password"
            />

            <Button type="submit" fullWidth size="lg" loading={loading} className="!mt-6">
              {loading ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
