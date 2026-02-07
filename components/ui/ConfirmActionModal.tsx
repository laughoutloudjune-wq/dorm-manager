"use client";

import { Modal } from "@/components/ui/Modal";

export function ConfirmActionModal({
  isOpen,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
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
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            {loading ? "Processing..." : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
