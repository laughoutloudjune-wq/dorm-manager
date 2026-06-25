const fs = require('fs');

const filePath = 'c:\\Users\\laugh\\Documents\\Webapp\\dorm-manager\\components\\admin\\tenant-editor-modal.tsx';
let content = fs.readFileSync(filePath, 'utf8');

// 1. Add MoveRoomWizardModal import and state
if (!content.includes('MoveRoomWizardModal')) {
  content = content.replace(
    'import { MoveInWizard } from "@/components/admin/MoveInWizard";',
    'import { MoveInWizard } from "@/components/admin/MoveInWizard";\nimport { MoveRoomWizardModal } from "@/components/admin/MoveRoomWizardModal";'
  );
}

if (!content.includes('const [moveRoomWizardOpen, setMoveRoomWizardOpen] = useState(false);')) {
  content = content.replace(
    'const [confirmMoveOutOpen, setConfirmMoveOutOpen] = useState(false);',
    'const [confirmMoveOutOpen, setConfirmMoveOutOpen] = useState(false);\n  const [moveRoomWizardOpen, setMoveRoomWizardOpen] = useState(false);'
  );
}

// 2. Replace the room selection and isRoomTransfer logic
// We need to find the <label className="text-base text-slate-700"> ห้อง <select ... </select> </label>
// and the following {existingTenantInSelectedRoom && ...} and {isRoomTransfer && ...}
const regexRoomBlock = /<label className="text-base text-slate-700">\s*ห้อง\s*<select[\s\S]*?<\/select>\s*<\/label>\s*\{existingTenantInSelectedRoom[\s\S]*?\}\)\s*\}\s*\{isRoomTransfer && \([\s\S]*?\}\)/;

const newRoomBlock = `            <div className="flex flex-col text-base text-slate-700">
              <label>ห้อง</label>
              {!activeTenant ? (
                <>
                  <select
                    value={form.room_id}
                    onChange={(event) => setForm({ ...form, room_id: event.target.value })}
                    className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-base"
                  >
                    <option value="">เลือกห้อง</option>
                    {rooms.map((room) => (
                      <option key={room.id} value={room.id}>
                        {roomLabel(room)}
                      </option>
                    ))}
                  </select>
                  {existingTenantInSelectedRoom && (
                    <div className="mt-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                      ห้องนี้มีผู้เช่าอยู่แล้ว: {existingTenantInSelectedRoom.full_name}
                      {existingTenantInSelectedRoom.phone_number
                        ? \` | เบอร์โทร \${existingTenantInSelectedRoom.phone_number}\`
                        : ""}
                    </div>
                  )}
                </>
              ) : (
                <div className="mt-2 flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-base text-slate-900 font-semibold">
                  <span>{tenantRoomNumber(activeTenant, roomsById)}</span>
                  <button
                    type="button"
                    onClick={() => setMoveRoomWizardOpen(true)}
                    disabled={!canEditTenant}
                    className="text-sm font-semibold text-blue-600 hover:text-blue-800 bg-white border border-blue-200 px-3 py-1 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    ย้ายห้อง
                  </button>
                </div>
              )}
            </div>`;

if (regexRoomBlock.test(content)) {
  content = content.replace(regexRoomBlock, newRoomBlock);
} else {
  console.log("Could not find the room block to replace");
}

// 3. Add the MoveRoomWizardModal at the end of the modal or just before the final return closing tag
if (!content.includes('<MoveRoomWizardModal')) {
  const wizardModalStr = `
      {activeTenant && moveRoomWizardOpen && (
        <MoveRoomWizardModal
          isOpen={moveRoomWizardOpen}
          onClose={() => setMoveRoomWizardOpen(false)}
          activeTenant={activeTenant}
          rooms={rooms}
          rates={rates}
          onSuccess={async () => {
            await loadTenants();
            setMoveRoomWizardOpen(false);
            onClose(); // close editor modal too, or let it stay? Close it to refresh.
          }}
        />
      )}
    </>
  );
}`;
  content = content.replace(/<\/>\s*\);\s*\}\s*$/, wizardModalStr);
}

fs.writeFileSync(filePath, content, 'utf8');
console.log("Successfully replaced room block and added MoveRoomWizardModal");
