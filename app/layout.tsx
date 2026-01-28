import './globals.css';
import { Sarabun } from 'next/font/google'; //
import Link from 'next/link';
import { ReactNode } from 'react';

// 1. Configure Sarabun font (Use all common weights)
const sarabun = Sarabun({
  weight: ['300', '400', '500', '600', '700'],
  subsets: ['thai', 'latin'],
  display: 'swap',
});

export const metadata = {
  title: 'Dorm Manager',
  description: 'Apartment Management System',
};

// Simple Nav Item Component
const NavItem = ({ href, icon, label }: { href: string; icon: string; label: string }) => (
  <Link 
    href={href} 
    className="flex items-center space-x-3 px-4 py-3 rounded-lg text-gray-300 hover:bg-slate-800 hover:text-white transition-colors"
  >
    <span className="text-xl">{icon}</span>
    <span className="font-medium">{label}</span>
  </Link>
);

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      {/* 2. Apply sarabun.className directly to body */}
      <body className={sarabun.className}>
        
        {/* 3. REMOVED "font-sans" from this div so it inherits Sarabun */}
        <div className="flex min-h-screen bg-gray-100"> 
          
          {/* Sidebar */}
          <aside className="w-64 bg-slate-900 text-white flex flex-col shadow-xl no-print shrink-0">
            <div className="p-6 border-b border-slate-800">
              <h1 className="text-2xl font-extrabold tracking-tight">🏢 DormManager</h1>
              <p className="text-xs text-slate-400 mt-1">Admin Dashboard</p>
            </div>
            
            <nav className="flex-1 p-4 space-y-2">
              <NavItem href="/" icon="🏠" label="หน้าหลัก (Dashboard)" />
              <NavItem href="/tenants" icon="👥" label="ผู้เช่า (Tenants)" />
              <NavItem href="/meters" icon="⚡" label="จดมิเตอร์ (Meters)" />
              <NavItem href="/invoices" icon="🧾" label="ใบแจ้งหนี้ (Invoices)" />
              <NavItem href="/maintenance" icon="🛠️" label="แจ้งซ่อม (Repair)" />
              <NavItem href="/report" icon="📊" label="รายงาน (Report)" />
              <NavItem href="/settings" icon="⚙️" label="ตั้งค่า (Settings)" />
            </nav>

            <div className="p-4 border-t border-slate-800 text-center text-xs text-slate-500">
              v1.0.0
            </div>
          </aside>

          {/* Main Content */}
          <main className="flex-1 overflow-auto h-screen">
            {children}
          </main>
          
        </div>
      </body>
    </html>
  );
}