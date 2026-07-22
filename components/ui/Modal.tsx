"use client";

import { ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

const sizeClasses: Record<string, string> = {
  md: "max-w-xl",
  lg: "max-w-3xl",
  xl: "max-w-5xl",
  "2xl": "max-w-7xl",
  "3xl": "max-w-[96rem]",
  "4xl": "max-w-[112rem]",
};

export function Modal({
  isOpen,
  onClose,
  title,
  description,
  footer,
  size = "lg",
  children,
}: {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  description?: ReactNode;
  /** Pinned below the scroll area, so actions stay reachable in long dialogs. */
  footer?: ReactNode;
  size?: "md" | "lg" | "xl" | "2xl" | "3xl" | "4xl";
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  // Lock the page behind the dialog. Without this, scrolling past the end of
  // the modal body scrolls the admin page underneath it.
  useEffect(() => {
    if (!isOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [isOpen]);

  if (!isOpen || !mounted) return null;

  const modalNode = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/25 px-4 py-6 backdrop-blur-md animate-fade-in-up"
      onClick={onClose}
    >
      <div
        className={`flex w-full ${sizeClasses[size]} max-h-[90vh] animate-soft-pop flex-col overflow-hidden rounded-panel border border-white/60 bg-white shadow-float-xl`}
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-100 px-6 py-4">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-tight text-slate-900">{title}</h2>
            {description ? (
              <p className="mt-0.5 text-sm leading-relaxed text-slate-500">{description}</p>
            ) : null}
          </div>
          <button
            onClick={onClose}
            className="-mr-1 shrink-0 rounded-control p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
            type="button"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        <div className="scrollbar-slim flex-1 overflow-y-auto overscroll-contain px-6 py-5">
          {children}
        </div>
        {footer ? (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-slate-100 bg-slate-50/70 px-6 py-4">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );

  return createPortal(modalNode, document.body);
}
