"use client";

import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { t } from "@/lib/i18n";
import { useUiLanguage } from "@/lib/use-ui-language";

export function ConfirmActionModal({
  isOpen,
  title,
  message,
  confirmLabel,
  cancelLabel,
  /** Use for irreversible actions so the confirm button reads as destructive. */
  destructive = false,
  loading = false,
  onCancel,
  onConfirm,
}: {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const locale = useUiLanguage();
  const resolvedConfirmLabel = confirmLabel ?? t(locale, "ui_confirm");
  const resolvedCancelLabel = cancelLabel ?? t(locale, "ui_cancel");
  const processingLabel = t(locale, "ui_processing");

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title={title}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={loading}>
            {resolvedCancelLabel}
          </Button>
          <Button
            variant={destructive ? "danger" : "primary"}
            onClick={onConfirm}
            loading={loading}
          >
            {loading ? processingLabel : resolvedConfirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-slate-600">{message}</p>
    </Modal>
  );
}
