"use client";

import { Badge } from "@/components/ui/Badge";
import { deriveSlipState, type SlipStateInput } from "@/lib/money/slip-states";

/** Small badge describing the invoice's payment-evidence (slip) state. Renders nothing when there is none. */
export function SlipStateBadge({ invoice }: { invoice: SlipStateInput }) {
  const info = deriveSlipState(invoice);
  if (!info) return null;
  const variant =
    info.tone === "danger" ? "danger" : info.tone === "success" ? "success" : info.tone === "warning" ? "warning" : "info";
  return (
    <span title={info.nextAction}>
      <Badge variant={variant}>{info.label}</Badge>
    </span>
  );
}
