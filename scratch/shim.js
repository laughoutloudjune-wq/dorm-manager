const fs = require('fs');

const file = 'components/admin/tenant-editor-modal.tsx';
let code = fs.readFileSync(file, 'utf8');

// 1. Import useTenantEditor
if (!code.includes('useTenantEditor')) {
  code = code.replace(
    'import { usePermissions } from "@/lib/use-permissions";',
    'import { usePermissions } from "@/lib/use-permissions";\nimport { useTenantEditor } from "@/lib/hooks/use-tenant-editor";'
  );
}

// 2. Build the replacement block
const targetStates = [
  { name: 'search', type: '""' },
  { name: 'buildingFilter', type: '"all"' },
  { name: 'activeTab', type: '<"info" | "move_in" | "move_out" | "payments">("info")' },
  { name: 'useCustomPayment', type: '(false)' },
  { name: 'selectedMethodId', type: '<string>("")' },
  { name: 'useCustomReceipt', type: '(false)' },
  { name: 'selectedReceiptProfileId', type: '<string>("")' },
  { name: 'latestPrevElectricity', type: '(0)' },
  { name: 'latestPrevWater', type: '(0)' },
  { name: 'forfeitDeposit', type: '(false)' },
  { name: 'paymentHistoryMonth', type: '("all")' },
  { name: 'confirmSaveOpen', type: '(false)' },
  { name: 'confirmDeleteOpen', type: '(false)' },
  { name: 'confirmUnlinkOpen', type: '(false)' },
  { name: 'confirmMoveOutOpen', type: '(false)' },
  { name: 'confirmCancelMoveOutOpen', type: '(false)' },
  { name: 'isCancellingMoveOut', type: '(false)' },
  { name: 'useProrate', type: '(true)' },
  { name: 'isPageLoading', type: '(true)' },
  { name: 'isSavingTenant', type: '(false)' },
  { name: 'isDeletingTenant', type: '(false)' },
  { name: 'isUnlinkingLine', type: '(false)' },
  { name: 'isMovingOut', type: '(false)' },
  { name: 'isUploadingDepositSlip', type: '(false)' },
  { name: 'depositSlipUrls', type: '<string[]>([])' },
];

let shims = `
  const { state, setState, setForm: editorSetForm, resetForm } = useTenantEditor();
  const {
    search, buildingFilter, activeTab, useCustomPayment, selectedMethodId,
    useCustomReceipt, selectedReceiptProfileId, latestPrevElectricity,
    latestPrevWater, forfeitDeposit, paymentHistoryMonth, confirmSaveOpen,
    confirmDeleteOpen, confirmUnlinkOpen, confirmMoveOutOpen, confirmCancelMoveOutOpen,
    isCancellingMoveOut, useProrate, isPageLoading, isSavingTenant,
    isDeletingTenant, isUnlinkingLine, isMovingOut, isUploadingDepositSlip,
    depositSlipUrls, transferCalc, form
  } = state;

`;

for (const st of targetStates) {
  const setter = 'set' + st.name.charAt(0).toUpperCase() + st.name.slice(1);
  shims += `  const ${setter} = (val: any) => setState({ ${st.name}: typeof val === 'function' ? val(${st.name}) : val });\n`;
}

shims += `  const setTransferCalc = (val: any) => setState({ transferCalc: typeof val === 'function' ? val(transferCalc) : val });\n`;
shims += `  const setForm = (val: any) => editorSetForm(typeof val === 'function' ? val(form) : val);\n`;

// 3. Remove the old useState declarations
for (const st of targetStates) {
  const setterName = 'set' + st.name.charAt(0).toUpperCase() + st.name.slice(1);
  const regex = new RegExp('  const \\\\[(.*)' + st.name + '(.*), ' + setterName + '\\\\] = useState(.*)\\n', 'g');
  code = code.replace(regex, '');
}

// Remove form
code = code.replace(/  const \[form, setForm\] = useState\(\{[\s\S]*?final_move_out_date: "",\n  \}\);\n/g, '');

// Remove transferCalc
code = code.replace(/  const \[transferCalc, setTransferCalc\] = useState<TransferCalcForm>\(\{[\s\S]*?new_curr_water: 0,\n  \}\);\n/g, '');


// 4. Inject shims after methods and receipts
code = code.replace(/  const \[methods, setMethods\] = useState<PaymentMethod\[\]>\(\[\]\);\n  const \[receiptProfiles, setReceiptProfiles\] = useState<ReceiptProfile\[\]>\(\[\]\);\n  const \[rates, setRates\] = useState<SettingsRates>\(\{ water_rate: 0, electricity_rate: 0 \}\);\n/, 
  '  const [methods, setMethods] = useState<PaymentMethod[]>([]);\n  const [receiptProfiles, setReceiptProfiles] = useState<ReceiptProfile[]>([]);\n  const [rates, setRates] = useState<SettingsRates>({ water_rate: 0, electricity_rate: 0 });\n\n' + shims + '\n'
);

fs.writeFileSync(file, code);
console.log('Shims applied successfully!');
