"use client";

import { ReactNode, useEffect, useRef, useState } from "react";
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

/**
 * Modals stack — a ConfirmActionModal opens on top of the dialog that raised it.
 * Each one used to save `body.style.overflow` on open and write it back on
 * close, so the inner modal captured "hidden" (set by the outer one) as the
 * value to restore. Whenever the two unmounted in the wrong order, that
 * "hidden" was the last write and the page behind them could never scroll
 * again. Count the locks instead: the first modal to open records the real
 * value, and only the last one to close puts it back.
 */
let scrollLockCount = 0;
let scrollLockPrevious = "";

/**
 * Open modals, oldest first. Rendered later means painted on top, so the last
 * entry is the dialog the user is actually looking at — and the only one
 * Escape should close. Every open modal listens on `window`, so without this
 * one Escape dismissed the confirm dialog and the page-level dialog behind it
 * in the same keystroke.
 */
const modalStack: symbol[] = [];

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
  const stackIdRef = useRef<symbol | null>(null);
  if (stackIdRef.current === null) stackIdRef.current = Symbol("modal");
  const stackId = stackIdRef.current;

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  // Join the stack while open so the Escape handler below can tell whether this
  // dialog is the topmost one.
  useEffect(() => {
    if (!isOpen) return;
    modalStack.push(stackId);
    return () => {
      const index = modalStack.lastIndexOf(stackId);
      if (index >= 0) modalStack.splice(index, 1);
    };
  }, [isOpen, stackId]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Only the dialog on top responds; the ones underneath stay open.
      if (modalStack[modalStack.length - 1] !== stackId) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose, stackId]);

  // Lock the page behind the dialog. Without this, scrolling past the end of
  // the modal body scrolls the admin page underneath it.
  useEffect(() => {
    if (!isOpen) return;
    if (scrollLockCount === 0) {
      scrollLockPrevious = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    scrollLockCount += 1;
    return () => {
      scrollLockCount = Math.max(0, scrollLockCount - 1);
      if (scrollLockCount === 0) {
        document.body.style.overflow = scrollLockPrevious;
      }
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
