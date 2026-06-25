const fs = require('fs');
const filePath = 'c:\\Users\\laugh\\Documents\\Webapp\\dorm-manager\\components\\admin\\tenant-editor-modal.tsx';

let lines = fs.readFileSync(filePath, 'utf8').split('\n');

// 1. Add imports
const importsToInject = `import { MoveInWizard } from "@/components/admin/MoveInWizard";
import { MoveRoomWizardModal } from "@/components/admin/MoveRoomWizardModal";`;

let importIdx = lines.findIndex(l => l.includes('import { MoveOutTab } from "@/components/admin/MoveOutTab";'));
if (importIdx !== -1) {
    lines.splice(importIdx + 1, 0, importsToInject);
}

// 2. Add state
const stateIdx = lines.findIndex(l => l.includes('const [confirmMoveOutOpen, setConfirmMoveOutOpen] = useState(false);'));
if (stateIdx !== -1) {
    lines.splice(stateIdx + 1, 0, '  const [moveRoomWizardOpen, setMoveRoomWizardOpen] = useState(false);');
}

// 3. Replace room block
// Find start of room block
const roomStartIdx = lines.findIndex(l => l.includes('<label className="text-base text-slate-700">') && lines[lines.indexOf(l)+1].includes('ห้อง'));
// Find end of isRoomTransfer block
let roomEndIdx = -1;
if (roomStartIdx !== -1) {
    for (let i = roomStartIdx; i < lines.length; i++) {
        if (lines[i].includes('ช่องทางรับชำระ</p>')) {
            // we went too far, let's backtrack to the enclosing div
            roomEndIdx = i - 2;
            break;
        }
    }
}

if (roomStartIdx !== -1 && roomEndIdx !== -1) {
    const newRoomBlockStr = `            <div className="flex flex-col text-base text-slate-700">
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
    
    // Replace lines from roomStartIdx to roomEndIdx
    lines.splice(roomStartIdx, roomEndIdx - roomStartIdx + 1, newRoomBlockStr);
} else {
    console.log("Failed to find room block", roomStartIdx, roomEndIdx);
}

// 4. Replace move_in block
const moveInStartIdx = lines.findIndex(l => l.includes('{activeTab === "move_in" && ('));
let moveInEndIdx = -1;
if (moveInStartIdx !== -1) {
    moveInEndIdx = lines.findIndex((l, i) => i > moveInStartIdx && l.includes('{activeTab === "move_out" && ('));
}

if (moveInStartIdx !== -1 && moveInEndIdx !== -1) {
    const newMoveInStr = `        {activeTab === "move_in" && (
          <MoveInWizard
            form={{
              move_in_date: form.move_in_date,
              lease_months: form.lease_months,
              initial_electricity_reading: form.initial_electricity_reading,
              initial_water_reading: form.initial_water_reading,
              advance_rent_amount: form.advance_rent_amount,
              security_deposit_amount: form.security_deposit_amount,
            }}
            setForm={setForm}
            canEditTenant={canEditTenant}
            isUploadingDepositSlip={isUploadingDepositSlip}
            depositSlipUrls={depositSlipUrls}
            uploadDepositSlip={uploadDepositSlip}
            removeDepositSlip={removeDepositSlip}
            leaseEnd={leaseEnd}
            leaseActive={leaseActive}
            isSavingTenant={isSavingTenant}
            onSave={() => void saveTenant()}
          />
        )}`;
    
    lines.splice(moveInStartIdx, moveInEndIdx - moveInStartIdx, newMoveInStr, "");
} else {
    console.log("Failed to find move_in block");
}

// 5. Add MoveRoomWizardModal at the bottom
const endIdx = lines.lastIndexOf('  );');
if (endIdx !== -1) {
    const wizardModalStr = `      {activeTenant && moveRoomWizardOpen && (
        <MoveRoomWizardModal
          isOpen={moveRoomWizardOpen}
          onClose={() => setMoveRoomWizardOpen(false)}
          activeTenant={activeTenant}
          rooms={rooms}
          rates={rates}
          onSuccess={async () => {
            await loadTenants();
            setMoveRoomWizardOpen(false);
            onClose();
          }}
        />
      )}`;
    lines.splice(endIdx, 0, wizardModalStr);
}

fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
console.log("Successfully modified tenant-editor-modal.tsx");
