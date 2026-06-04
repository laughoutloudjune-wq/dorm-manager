const fs = require('fs');

const path = 'app/(admin)/move-outs/page.tsx';
let content = fs.readFileSync(path, 'utf8');

// 1. Add activeTab state
const stateSearch = /const \[isModalOpen, setIsModalOpen\] = useState\(false\);/;
const stateReplace = `const [isModalOpen, setIsModalOpen] = useState(false);\n  const [activeTab, setActiveTab] = useState<"waiting_verify" | "waiting_moveout" | "declined" | "past">("waiting_verify");`;

if (content.match(stateSearch)) {
    content = content.replace(stateSearch, stateReplace);
}

// 2. Remove completed filter from unifiedList
const unifiedFilterSearch = /if \(req\.status === "completed"\) return; \/\/ Filter out already moved out/;
const unifiedFilterReplace = `// if (req.status === "completed") return; // Keep completed for past moveout tab`;

if (content.match(unifiedFilterSearch)) {
    content = content.replace(unifiedFilterSearch, unifiedFilterReplace);
}

// 3. Tab logic and filter unifiedList based on activeTab
const filteredListSearch = /const requestedCount = unifiedList\.filter\(\(r\) => r\.status === "requested"\)\.length;/;

const filteredListReplace = `const requestedCount = unifiedList.filter((r) => r.status === "requested").length;\n  \n  const filteredList = useMemo(() => {\n    return unifiedList.filter(row => {\n      if (activeTab === "waiting_verify") return row.status === "requested";\n      if (activeTab === "waiting_moveout") return row.status === "approved" || row.status === "manual";\n      if (activeTab === "declined") return row.status === "rejected" || row.status === "cancelled";\n      if (activeTab === "past") return row.status === "completed";\n      return true;\n    });\n  }, [unifiedList, activeTab]);`;

if (content.match(filteredListSearch)) {
    content = content.replace(filteredListSearch, filteredListReplace);
}

// 4. Update the UI to render tabs and use filteredList
const uiSearch = /<div className="border-b border-slate-100 px-4 py-3 text-sm text-slate-600 flex gap-4">\s*<span>ทั้งหมด: <span className="font-medium text-slate-800">\{unifiedList\.length\}<\/span> รายการ<\/span>\s*<span>รอตรวจสอบ: <span className="font-semibold text-amber-600">\{requestedCount\}<\/span> รายการ<\/span>\s*<\/div>/;

const uiReplace = `<div className="flex border-b border-slate-100 overflow-x-auto">
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
            </div>`;

if (content.match(uiSearch)) {
    content = content.replace(uiSearch, uiReplace);
}

// 5. Replace unifiedList.length === 0 with filteredList.length === 0
content = content.replace(/\{unifiedList\.length === 0 \? \(/g, `{filteredList.length === 0 ? (`);

// 6. Replace unifiedList.map with filteredList.map
content = content.replace(/unifiedList\.map\(\(row\) => \(/g, `filteredList.map((row) => (`);

fs.writeFileSync(path, content);
console.log("Done updating MoveOutsPage");
