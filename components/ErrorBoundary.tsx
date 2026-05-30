"use client";

import React, { Component, ErrorInfo, ReactNode } from "react";
import { AlertTriangle, RefreshCcw } from "lucide-react";

interface Props {
  children?: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="flex min-h-[400px] w-full flex-col items-center justify-center rounded-2xl border border-red-100 bg-red-50 p-8 text-center animate-in fade-in zoom-in-95">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-100 text-red-600">
            <AlertTriangle size={32} />
          </div>
          <h2 className="mb-2 text-xl font-bold text-red-900">
            เกิดข้อผิดพลาดในการโหลดเนื้อหานี้
          </h2>
          <p className="mb-6 max-w-md text-sm text-red-700">
            ระบบตรวจพบข้อผิดพลาดที่ไม่คาดคิด กรุณาลองรีเฟรชหน้าเว็บอีกครั้ง
            หากปัญหายังคงอยู่ กรุณาติดต่อผู้ดูแลระบบ
          </p>
          <div className="flex gap-4">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-flex items-center gap-2 rounded-xl bg-red-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-red-700"
            >
              <RefreshCcw size={18} />
              รีเฟรชหน้าเว็บ
            </button>
            <button
              type="button"
              onClick={() => this.setState({ hasError: false, error: null })}
              className="inline-flex items-center gap-2 rounded-xl border border-red-200 bg-white px-5 py-2.5 text-sm font-semibold text-red-700 shadow-sm transition hover:bg-red-50"
            >
              ลองใหม่
            </button>
          </div>
          {process.env.NODE_ENV === "development" && this.state.error && (
            <div className="mt-8 w-full max-w-3xl overflow-auto rounded-xl bg-black/80 p-4 text-left">
              <pre className="text-xs text-red-400 font-mono whitespace-pre-wrap">
                {this.state.error.stack || this.state.error.message}
              </pre>
            </div>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}
