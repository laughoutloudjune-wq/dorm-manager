import { Card, CardContent } from "@/components/ui/Card";
import { ArrowDownRight, ArrowUpRight, Wrench } from "lucide-react";

const stats = [
  { label: "Total Rooms", value: "128", trend: "+4 this month", icon: ArrowUpRight },
  { label: "Occupancy Rate", value: "92%", trend: "Stable", icon: ArrowUpRight },
  { label: "Pending Income", value: "฿84,500", trend: "8 invoices", icon: ArrowDownRight },
  { label: "Issues / Maintenance", value: "3", trend: "2 urgent", icon: Wrench },
];

const activities = [
  "Room 101 paid invoice for January.",
  "New tenant registered for Room 404.",
  "Maintenance request submitted for Room 210 (AC).",
  "Meter readings updated for Building B.",
];

export default function DashboardPage() {
  return (
    <div className="space-y-8">
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <Card key={stat.label} className="shadow-md">
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-slate-500">{stat.label}</p>
                  <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-slate-100 text-slate-600">
                    <Icon size={18} />
                  </span>
                </div>
                <div className="text-2xl font-semibold text-slate-900">{stat.value}</div>
                <p className="text-xs text-slate-500">{stat.trend}</p>
              </CardContent>
            </Card>
          );
        })}
      </section>

      <section className="grid gap-6 xl:grid-cols-[2fr_1fr]">
        <Card>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-900">Occupancy Snapshot</h2>
              <span className="text-xs text-slate-400">Updated today</span>
            </div>
            <div className="rounded-xl bg-slate-100 p-4">
              <div className="flex items-center justify-between text-sm text-slate-600">
                <span>Occupied</span>
                <span className="font-semibold text-slate-900">118 / 128</span>
              </div>
              <div className="mt-3 h-2 w-full rounded-full bg-white">
                <div className="h-2 rounded-full bg-blue-600" style={{ width: "92%" }} />
              </div>
              <div className="mt-3 flex justify-between text-xs text-slate-500">
                <span>Vacant: 10 rooms</span>
                <span>Maintenance: 3 rooms</span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-4">
            <h2 className="text-lg font-semibold text-slate-900">Recent Activity</h2>
            <ul className="space-y-3 text-sm text-slate-600">
              {activities.map((activity) => (
                <li
                  key={activity}
                  className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2"
                >
                  {activity}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
