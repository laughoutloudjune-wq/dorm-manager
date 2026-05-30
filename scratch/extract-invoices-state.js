import fs from 'fs';

const inFile = 'components/admin/InvoicesPageView.tsx';
const hookFile = 'lib/hooks/use-invoices-state.ts';

const lines = fs.readFileSync(inFile, 'utf8').split('\n');

let startIndex = -1;
let endIndex = -1;

for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('export default function InvoicesPage() {')) {
    startIndex = i + 1;
  }
  if (startIndex !== -1 && lines[i].startsWith('  return (')) {
    endIndex = i;
    break;
  }
}

if (startIndex === -1 || endIndex === -1) {
  console.error("Could not find bounds");
  process.exit(1);
}

const bodyLines = lines.slice(startIndex, endIndex);

// We need to figure out what variables are declared in the body so we can export them.
// A regex to match `const [foo, setFoo] = ` and `const myFunc = `
const exports = [];
for (const line of bodyLines) {
  const matchState = line.match(/^  const \[([a-zA-Z0-9_]+),\s*([a-zA-Z0-9_]+)\] = /);
  if (matchState) {
    exports.push(matchState[1]);
    exports.push(matchState[2]);
    continue;
  }
  const matchFunc = line.match(/^  const ([a-zA-Z0-9_]+) = /);
  if (matchFunc) {
    exports.push(matchFunc[1]);
    continue;
  }
  const matchLet = line.match(/^  let ([a-zA-Z0-9_]+) /);
  if (matchLet) {
    exports.push(matchLet[1]);
    continue;
  }
}

// Generate the hook file
const hookHeader = `"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { createClient } from "@/lib/supabase-client";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { InvoiceRecord, PaymentMethodRow, RoomRow, TenantRow } from "@/types";

export function useInvoicesState() {
`;

const hookFooter = `

  return {
${exports.map(e => `    ${e},`).join('\n')}
  };
}
`;

fs.writeFileSync(hookFile, hookHeader + bodyLines.join('\n') + hookFooter);
console.log("Hook file generated successfully!");
