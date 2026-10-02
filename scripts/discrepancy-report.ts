/**
 * READ-ONLY historical discrepancy report. Run it yourself:
 *
 *   DISCREPANCY_CONFIRM_READONLY=yes SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     npx tsx scripts/discrepancy-report.ts [--out ./dir] [--redact]
 *
 * Only SELECTs are issued (the client is wrapped in a guard that throws on
 * anything else). See docs/DISCREPANCY-REPORT-HOWTO.md.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { loadReconciliationFindings } from "@/lib/money/reconciliation-loader";
import { findingsToCsv } from "@/lib/money/reconciliation-checks";
import {
  createReadOnlyClient,
  defaultOutDir,
  hostOf,
  isReadOnlyConfirmed,
  parseArgs,
  redactFindings,
  renderProposedRepairs,
  renderSummary,
} from "@/lib/money/discrepancy-report";

async function main() {
  const env = process.env;
  const args = parseArgs(process.argv.slice(2));

  const url = env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  console.log(`Project host this run would read: ${hostOf(url)}`);

  if (!isReadOnlyConfirmed(env)) {
    console.error("Refusing to run: set DISCREPANCY_CONFIRM_READONLY=yes to confirm a read-only scan of the host above.");
    process.exit(1);
  }
  if (!url || !key) {
    console.error("Missing SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and/or SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(1);
  }

  const raw = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const supabase = createReadOnlyClient(raw);

  const now = new Date();
  const outDir = resolve(args.out ?? defaultOutDir(now));
  let findings = await loadReconciliationFindings(supabase);
  if (args.redact) findings = redactFindings(findings).findings;

  const ctx = { generatedAt: now.toISOString(), host: hostOf(url), redacted: args.redact };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "findings.csv"), findingsToCsv(findings), "utf8");
  writeFileSync(join(outDir, "summary.md"), renderSummary(findings, ctx), "utf8");
  writeFileSync(join(outDir, "proposed-repairs.md"), renderProposedRepairs(findings), "utf8");

  console.log(`Wrote ${findings.length} findings to ${outDir}`);
  console.log("Nothing was changed in the database.");
  if (!args.redact) console.log("WARNING: output contains real tenant data. Re-run with --redact before sharing.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
