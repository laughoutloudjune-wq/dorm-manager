"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase-client";
import {
  PermissionKey,
  RoleKey,
  defaultRolePermissions,
  normalizeRolePermissions,
} from "@/lib/permissions";

export function usePermissions() {
  const supabase = useMemo(() => createClient(), []);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<RoleKey>("viewer");
  const [matrix, setMatrix] = useState(defaultRolePermissions());

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        // Moved server-side (finding C1) — this used to read
        // settings.role_permissions and user_roles directly from the
        // browser with the anon key. See app/api/admin/permissions/route.ts.
        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData.session?.access_token;
        if (!token) return;

        const response = await fetch("/api/admin/permissions", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) return;
        const result = await response.json();

        if (mounted) {
          const nextRole = result?.role;
          if (nextRole === "owner" || nextRole === "admin" || nextRole === "staff" || nextRole === "viewer") {
            setRole(nextRole);
          }
          setMatrix(normalizeRolePermissions(result?.matrix ?? undefined));
        }
      } finally {
        if (mounted) setLoading(false);
      }
    };
    void load();
    return () => {
      mounted = false;
    };
  }, [supabase]);

  const can = (permission: PermissionKey) => !!matrix[role]?.[permission];

  return { loading, role, can, matrix };
}

