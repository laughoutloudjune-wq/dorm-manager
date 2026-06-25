const fs = require('fs');

const filePath = 'c:\\Users\\laugh\\Documents\\Webapp\\dorm-manager\\components\\admin\\tenant-editor-modal.tsx';
let content = fs.readFileSync(filePath, 'utf8');

const moveInStart = '{activeTab === "move_in" && (';
const moveOutStart = '{activeTab === "move_out" && (';

const startIndex = content.indexOf(moveInStart);
const endIndex = content.indexOf(moveOutStart);

if (startIndex === -1 || endIndex === -1 || startIndex > endIndex) {
  console.log("Error finding block bounds", { startIndex, endIndex });
  process.exit(1);
}

const before = content.slice(0, startIndex);
// The endIndex points to the start of the move_out tab, so we need to grab the whitespace before it too.
// Let's just slice until endIndex.
const after = content.slice(endIndex);

const wizardBlock = `{activeTab === "move_in" && (
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
        )}

        `;

const newContent = before + wizardBlock + after;
fs.writeFileSync(filePath, newContent, 'utf8');
console.log("Successfully replaced move_in block");
