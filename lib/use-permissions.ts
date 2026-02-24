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
        const [
          { data: userData },
          { data: settingsData },
        ] = await Promise.all([
          supabase.auth.getUser(),
          supabase.from("settings").select("role_permissions").eq("id", 1).maybeSingle(),
        ]);

        const userId = userData?.user?.id;
        if (userId) {
          const { data: roleData } = await supabase
            .from("user_roles")
            .select("role")
            .eq("user_id", userId)
            .maybeSingle();
          const nextRole = (roleData as any)?.role;
          if (nextRole === "owner" || nextRole === "admin" || nextRole === "staff" || nextRole === "viewer") {
            if (mounted) setRole(nextRole);
          }
        }

        if (mounted) {
          setMatrix(normalizeRolePermissions((settingsData as any)?.role_permissions));
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

