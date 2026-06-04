const fs = require('fs');

const path = 'app/(admin)/move-outs/page.tsx';
let content = fs.readFileSync(path, 'utf8');

// 1. Add activeTab state
const stateSearch = `  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);`;

const stateReplace = `  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"waiting_verify" | "waiting_moveout" | "declined" | "past">("waiting_verify");`;

if (content.includes(stateSearch)) {
    content = content.replace(stateSearch, stateReplace);
}

// 2. Remove completed filter from unifiedList
const unifiedFilterSearch = `    // Process requests
    requests.forEach((req) => {
      if (req.status === "completed") return; // Filter out already moved out`;

const unifiedFilterReplace = `    // Process requests
    requests.forEach((req) => {`;

if (content.includes(unifiedFilterSearch)) {
    content = content.replace(unifiedFilterSearch, unifiedFilterReplace);
}

// 3. Tab logic and filter unifiedList based on activeTab
// Add \`filteredList\` after \`requestedCount\`
const filteredListSearch = `  const requestedCount = unifiedList.filter((r) => r.status === "requested").length;`;

const filteredListReplace = `  const requestedCount = unifiedList.filter((r) => r.status === "requested").length;
  
  const filteredList = useMemo(() => {
    return unifiedList.filter(row => {
      if (activeTab === "waiting_verify") return row.status === "requested";
      if (activeTab === "waiting_moveout") return row.status === "approved" || row.status === "manual";
      if (activeTab === "declined") return row.status === "rejected" || row.status === "cancelled";
      if (activeTab === "past") return row.status === "completed";
      return true;
    });
  }, [unifiedList, activeTab]);`;

if (content.includes(filteredListSearch)) {
    content = content.replace(filteredListSearch, filteredListReplace);
}

// 4. Update the UI to render tabs and use filteredList
const uiSearch = `      {canView && !loading && (
        <Card>
          <CardContent className="!p-0">
            <div className="border-b border-slate-100 px-4 py-3 text-sm text-slate-600 flex gap-4">
              <span>ทั้งหมด: <span className="font-medium text-slate-800">{unifiedList.length}</span> รายการ</span>
              <span>รอตรวจสอบ: <span className="font-semibold text-amber-600">{requestedCount}</span> รายการ</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[800px] text-left text-sm">`;

const uiReplace = `      {canView && !loading && (
        <Card>
          <CardContent className="!p-0">
            <div className="flex border-b border-slate-100 overflow-x-auto">
              <button
                onClick={() => setActiveTab("waiting_verify")}
                className={\`px-4 py-3 text-sm font-semibold whitespace-nowrap \${activeTab === "waiting_verify" ? "border-b-2 border-blue-600 text-blue-700" : "text-slate-500 hover:text-slate-700 hover:bg-slate-50"}\`}
              >
                รอตรวจสอบ
                {requestedCount > 0 && <span className="ml-2 rounded-full bg-amber-100 text-amber-700 px-2 py-0.5 text-xs">{requestedCount}</span>}
              </button>
              <button
                onClick={() => setActiveTab("waiting_moveout")}
                className={\`px-4 py-3 text-sm font-semibold whitespace-nowrap \${activeTab === "waiting_moveout" ? "border-b-2 border-blue-600 text-blue-700" : "text-slate-500 hover:text-slate-700 hover:bg-slate-50"}\`}
              >
                รอย้ายออก
              </button>
              <button
                onClick={() => setActiveTab("declined")}
                className={\`px-4 py-3 text-sm font-semibold whitespace-nowrap \${activeTab === "declined" ? "border-b-2 border-blue-600 text-blue-700" : "text-slate-500 hover:text-slate-700 hover:bg-slate-50"}\`}
              >
                ปฏิเสธ / ยกเลิก
              </button>
              <button
                onClick={() => setActiveTab("past")}
                className={\`px-4 py-3 text-sm font-semibold whitespace-nowrap \${activeTab === "past" ? "border-b-2 border-blue-600 text-blue-700" : "text-slate-500 hover:text-slate-700 hover:bg-slate-50"}\`}
              >
                ย้ายออกแล้ว
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[800px] text-left text-sm">`;

if (content.includes(uiSearch)) {
    content = content.replace(uiSearch, uiReplace);
}

// 5. Replace unifiedList.map with filteredList.map
content = content.replace(
  `{unifiedList.length === 0 ? (`,
  `{filteredList.length === 0 ? (`
);

content = content.replace(
  `unifiedList.map((row) => (`,
  `filteredList.map((row) => (`
);


fs.writeFileSync(path, content);
console.log("Done updating MoveOutsPage");
