import fs from 'fs';
const originLines = fs.readFileSync('components/admin/InvoicesPageView.tsx', 'utf8').split('\n');
let hookCode = fs.readFileSync('lib/hooks/use-invoices-state.ts', 'utf8');

const header = originLines.slice(0, 78).join('\n') + `
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import QRCodeStyling from "qr-code-styling";
import dayjs from "dayjs";
`;

hookCode = header + hookCode.substring(hookCode.indexOf('\nexport function useInvoicesState() {'));
fs.writeFileSync('lib/hooks/use-invoices-state.ts', hookCode);
