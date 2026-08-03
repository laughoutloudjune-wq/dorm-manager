import { Suspense } from "react";
import InvoicesPageView from "@/components/admin/InvoicesPageView";

export default function InvoicesPage() {
  return (
    <Suspense fallback={null}>
      <InvoicesPageView />
    </Suspense>
  );
}
