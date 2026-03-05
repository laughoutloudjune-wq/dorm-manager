"use client";

import { Modal } from "@/components/ui/Modal";
import { Loader2 } from "lucide-react";
import { t } from "@/lib/i18n";
import { useUiLanguage } from "@/lib/use-ui-language";

export function ConfirmActionModal({
  isOpen,
  title,
  message,
  confirmLabel,
  cancelLabel,
  loading = false,
  onCancel,
  onConfirm,
}: {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  loading?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const locale = useUiLanguage();
  const resolvedConfirmLabel = confirmLabel ?? t(locale, "ui_confirm");
  const resolvedCancelLabel = cancelLabel ?? t(locale, "ui_cancel");
  const processingLabel = t(locale, "ui_processing");

  return (
    <Modal isOpen={isOpen} onClose={onCancel} title={title} size="md">
      <div className="space-y-4">
        <p className="text-sm text-slate-600">{message}</p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={loading}
            className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-700 disabled:opacity-60"
          >
            {resolvedCancelLabel}
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading && <Loader2 size={16} className="animate-spin" />}
            {loading ? processingLabel : resolvedConfirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
