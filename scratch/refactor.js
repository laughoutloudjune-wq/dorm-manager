const fs = require('fs');
let code = fs.readFileSync('components/admin/tenant-editor-modal.tsx', 'utf8');

// 1. Import useTenantEditor
code = code.replace(
  'import { usePermissions } from "@/lib/use-permissions";',
  'import { usePermissions } from "@/lib/use-permissions";\nimport { useTenantEditor } from "@/lib/hooks/use-tenant-editor";'
);

// 2. Remove all target useStates and add useTenantEditor
const targetStates = [
  'search', 'buildingFilter', 'activeTab', 'useCustomPayment', 'selectedMethodId',
  'useCustomReceipt', 'selectedReceiptProfileId', 'latestPrevElectricity',
  'latestPrevWater', 'forfeitDeposit', 'paymentHistoryMonth', 'confirmSaveOpen',
  'confirmDeleteOpen', 'confirmUnlinkOpen', 'confirmMoveOutOpen', 'confirmCancelMoveOutOpen',
  'isCancellingMoveOut', 'useProrate', 'isPageLoading', 'isSavingTenant',
  'isDeletingTenant', 'isUnlinkingLine', 'isMovingOut', 'isUploadingDepositSlip',
  'depositSlipUrls', 'transferCalc'
];

code = code.replace(/const \[methods, setMethods\] = useState<PaymentMethod\[\]>\(\[\]\);/g, 'const { state, setState, setForm, resetForm } = useTenantEditor();\n  const { ' + targetStates.join(', ') + ', form } = state;\n\n  const [methods, setMethods] = useState<PaymentMethod[]>([]);');

targetStates.forEach(st => {
  const regex = new RegExp('  const \\\[' + st + ', set' + st.charAt(0).toUpperCase() + st.slice(1) + '\\\] = useState.*\\n', 'g');
  code = code.replace(regex, '');
});

// Remove the form useState
code = code.replace(/  const \[form, setForm\] = useState\(\{[\s\S]*?final_move_out_date: "",\n  \}\);\n/g, '');

// 3. Replace setters
targetStates.forEach(st => {
  const setterName = 'set' + st.charAt(0).toUpperCase() + st.slice(1);
  // Match setterName(value)
  const regex = new RegExp(setterName + '\\(([^)]+)\\)', 'g');
  code = code.replace(regex, (match, p1) => {
    // Check if it's an updater function (e.g., prev => prev...) - skip or handle manually, but most are simple values
    if (p1.includes('=>')) {
      return match; // Leave alone and fix manually
    }
    return 'setState({ ' + st + ': ' + p1 + ' })';
  });
});

// Write it back
fs.writeFileSync('components/admin/tenant-editor-modal.tsx', code);
console.log('Script ran successfully!');
