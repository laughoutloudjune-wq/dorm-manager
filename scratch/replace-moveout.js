const fs = require('fs');
const filePath = 'c:\\Users\\laugh\\Documents\\Webapp\\dorm-manager\\components\\admin\\tenant-editor-modal.tsx';

let lines = fs.readFileSync(filePath, 'utf8').split('\n');

const moveOutStartIdx = lines.findIndex(l => l.includes('{activeTab === "move_out" && ('));
let moveOutEndIdx = -1;
if (moveOutStartIdx !== -1) {
    moveOutEndIdx = lines.findIndex((l, i) => i > moveOutStartIdx && l.includes('{activeTab === "payments" && ('));
}

if (moveOutStartIdx !== -1 && moveOutEndIdx !== -1) {
    const newMoveOutStr = `        {activeTab === "move_out" && (
          <MoveOutWizard
            activeTenant={activeTenant}
            activeMoveOutRequest={activeMoveOutRequest}
            rates={rates}
            form={{
              full_name: form.full_name,
              advance_rent_amount: toNumber(form.advance_rent_amount),
              security_deposit_amount: toNumber(form.security_deposit_amount),
              final_electricity_reading: toNumber(form.final_electricity_reading),
              final_water_reading: toNumber(form.final_water_reading),
              move_out_request_date: form.move_out_request_date,
              final_move_out_date: form.final_move_out_date,
            }}
            setForm={(updater) => {
              setForm((prev) => {
                const wizardForm = {
                  full_name: prev.full_name,
                  advance_rent_amount: toNumber(prev.advance_rent_amount),
                  security_deposit_amount: toNumber(prev.security_deposit_amount),
                  final_electricity_reading: toNumber(prev.final_electricity_reading),
                  final_water_reading: toNumber(prev.final_water_reading),
                  move_out_request_date: prev.move_out_request_date,
                  final_move_out_date: prev.final_move_out_date,
                };
                const next = updater(wizardForm);
                return {
                  ...prev,
                  final_electricity_reading: next.final_electricity_reading,
                  final_water_reading: next.final_water_reading,
                  move_out_request_date: next.move_out_request_date,
                  final_move_out_date: next.final_move_out_date,
                };
              });
            }}
            forfeitDeposit={forfeitDeposit}
            setForfeitDeposit={setForfeitDeposit}
            moveOutFeeLines={moveOutFeeLines}
            setMoveOutFeeLines={setMoveOutFeeLines}
            latestPrevElectricity={latestPrevElectricity}
            latestPrevWater={latestPrevWater}
            tenantInvoiceHistory={tenantInvoiceHistory}
            outstandingMoveOutInvoices={outstandingMoveOutInvoices}
            unpaidInvoicesSubtotal={unpaidInvoicesSubtotal}
            latestBilledEndYmd={latestBilledEndYmd}
            tailDaysAfterBilledPeriod={tailDaysAfterBilledPeriod}
            appliedMoveOutRentBase={appliedMoveOutRentBase}
            roomNumber={activeTenant ? tenantRoomNumber(activeTenant, roomsById) : ""}
            canEditTenant={canEditTenant}
            isMovingOut={isMovingOut}
            isCancellingMoveOut={isCancellingMoveOut}
            onApprove={() => void manageMoveOutRequest("approved")}
            onDecline={() => void manageMoveOutRequest("rejected")}
            onCancelMoveOut={() => setConfirmCancelMoveOutOpen(true)}
            onConfirmMoveOut={() => setConfirmMoveOutOpen(true)}
            onAbandonRoom={async (isForfeit, moveOutDate) => {
              if (!activeTenant) return;
              try {
                await callTenantsAction("abandon_room", {
                  tenantId: activeTenant.id,
                  forfeitDeposit: isForfeit,
                  moveOutDate,
                });
                toast.success("ดำเนินการผู้เช่าทิ้งห้องเรียบร้อยแล้ว");
                onClose();
                await loadTenants();
              } catch (error) {
                toast.error(error?.message ?? "ดำเนินการทิ้งห้องไม่สำเร็จ");
              }
            }}
          />
        )}`;
    
    // Replace the block
    lines.splice(moveOutStartIdx, moveOutEndIdx - moveOutStartIdx, newMoveOutStr, "");
} else {
    console.log("Failed to find move_out block", moveOutStartIdx, moveOutEndIdx);
}

// Ensure MoveOutWizard is imported
const importIdx = lines.findIndex(l => l.includes('import { MoveInWizard }'));
if (importIdx !== -1 && !lines.some(l => l.includes('import { MoveOutWizard }'))) {
    lines.splice(importIdx, 0, 'import { MoveOutWizard } from "@/components/admin/MoveOutWizard";');
}

fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
console.log("Successfully restored MoveOutWizard");
