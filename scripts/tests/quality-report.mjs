import { readFile, writeFile } from "node:fs/promises";
import path, { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPO_ROOT = resolve(scriptDir, "../..");

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function readText(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

function decodeXml(value = "") {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function xmlAttributes(raw) {
  const values = {};
  for (const match of raw.matchAll(/([\w:-]+)=(['"])(.*?)\2/g)) values[match[1]] = decodeXml(match[3]);
  return values;
}

export function parseJUnitCases(text, repoRoot = DEFAULT_REPO_ROOT) {
  const cases = [];
  const pattern = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/gi;
  for (const match of text.matchAll(pattern)) {
    const attrs = xmlAttributes(match[1]);
    const body = match[2] ?? "";
    const status = /<failure\b/i.test(body)
      ? "failed"
      : /<error\b/i.test(body)
        ? "error"
        : /<skipped\b/i.test(body)
          ? "skipped"
          : "passed";
    const file = attrs.file
      ? path.relative(repoRoot, attrs.file).split(path.sep).join("/")
      : attrs.classname ?? "unknown";
    cases.push({
      name: attrs.name ?? "unnamed test",
      file,
      status,
      time_ms: Number.isFinite(Number(attrs.time)) ? Number(attrs.time) * 1000 : null,
    });
  }
  return cases;
}

export function parseLizardFindings(text) {
  const findings = [];
  const pattern = /^(.*?):(\d+): warning: (.+?) has (\d+) NLOC, (\d+) CCN, (\d+) token, (\d+) PARAM, (\d+) length, (\d+) ND$/gm;
  for (const match of text.matchAll(pattern)) {
    findings.push({
      function: match[3],
      file: `${match[1]}:${match[2]}`,
      nloc: Number(match[4]),
      ccn: Number(match[5]),
      token: Number(match[6]),
      params: Number(match[7]),
      length: Number(match[8]),
    });
  }
  return findings.sort((left, right) => right.ccn - left.ccn || right.nloc - left.nloc);
}

export function summarizeExtensions(files) {
  const byExtension = new Map();
  for (const item of files) {
    const extension = path.posix.extname(item.file.replaceAll("\\", "/")).toLowerCase() || "[none]";
    const current = byExtension.get(extension) ?? { extension, files: 0, lines: 0 };
    current.files += 1;
    current.lines += item.lines;
    byExtension.set(extension, current);
  }
  return [...byExtension.values()].sort((left, right) => right.files - left.files || left.extension.localeCompare(right.extension));
}

function valueOf(value) {
  return value == null ? "—" : String(value);
}

export function formatTable(headers, rows) {
  const values = [headers, ...rows].map((row) => row.map(valueOf));
  const widths = headers.map((header, index) => Math.max(...values.map((row) => row[index].length), header.length));
  const line = (left, fill, middle, right) => left + widths.map((width) => fill.repeat(width + 2)).join(middle) + right;
  const row = (valuesRow) => `│ ${valuesRow.map((value, index) => value.padEnd(widths[index])).join(" │ ")} │`;
  return [
    line("┌", "─", "┬", "┐"),
    row(values[0]),
    line("├", "─", "┼", "┤"),
    ...values.slice(1).map(row),
    line("└", "─", "┴", "┘"),
  ].join("\n");
}

function section(title, headers, rows) {
  return `${title}\n\n${formatTable(headers, rows)}`;
}

function testRows(testResults, cases) {
  const aggregate = testResults?.aggregate ?? {};
  return [
    ["Total", aggregate.tests ?? cases.length],
    ["Passed", aggregate.passed ?? cases.filter(({ status }) => status === "passed").length],
    ["Failed", aggregate.failures ?? cases.filter(({ status }) => status === "failed").length],
    ["Errors", aggregate.errors ?? cases.filter(({ status }) => status === "error").length],
    ["Skipped", aggregate.skipped ?? cases.filter(({ status }) => status === "skipped").length],
  ];
}

export function formatQualityReport({ summary, jscpd, lizard, fileSize, tests, cases, benchmarks }) {
  const lines = ["Code Quality Report", "─".repeat(61), ""];
  const lizardRows = lizard.length
    ? lizard.map((item) => [item.function, item.file, item.nloc, item.ccn, item.token, item.params])
    : [["No findings", "—", "—", "—", "—", "—"]];
  lines.push(section("LIZARD — Complexity", ["Function", "File:Line", "NLOC", "CCN", "Token", "Params"], lizardRows));
  lines.push("");

  const duplication = jscpd?.summary ?? {};
  lines.push(section("JSCPD — Duplication", ["Metric", "Result"], [
    ["Files scanned", duplication.files ?? "—"],
    ["Total lines", duplication.lines ?? "—"],
    ["Clones", duplication.clones ?? summary.jscpd?.clones ?? "—"],
    ["Duplicate LOC", duplication.duplicated_lines ?? "—"],
    ["Duplication", duplication.duplication_percent == null ? "—" : `${Number(duplication.duplication_percent).toFixed(2)}%`],
  ]));
  lines.push("");

  lines.push(section("TESTS — Results", ["Metric", "Result"], testRows(tests, cases)));
  lines.push("");
  lines.push(section("TEST CASES — Detail", ["Test", "File", "Status", "Time ms"], cases.length
    ? cases.map((item) => [item.name, item.file, item.status, item.time_ms == null ? "—" : item.time_ms.toFixed(2)])
    : [["No JUnit cases", "—", "—", "—"]]));
  lines.push("");
  lines.push(section("SOURCE — Extensions", ["Extension", "Files", "Lines"], summarizeExtensions(fileSize.files).map((item) => [item.extension, item.files, item.lines])));
  lines.push("");

  const coverage = summary.coverage;
  lines.push(section("COVERAGE — LCOV", ["Metric", "Result"], [
    ["Lines", coverage?.lines_percent == null ? "not reported" : `${coverage.lines_percent.toFixed(2)}%`],
    ["Branches", coverage?.branches_percent == null ? "not reported" : `${coverage.branches_percent.toFixed(2)}%`],
    ["Functions", coverage?.functions_percent == null ? "not reported" : `${coverage.functions_percent.toFixed(2)}%`],
  ]));
  lines.push("");

  lines.push(section("BENCHMARKS — Throughput", ["Scenario", "Iterations", "Total ms", "Ops/s"], benchmarks.length
    ? benchmarks.map((item) => [item.name, item.iterations, item.elapsed_ms, item.ops_per_second])
    : [["No benchmark report", "—", "—", "—"]]));
  lines.push("");
  lines.push(`Gate: ${(summary.gate?.status ?? "unknown").toUpperCase()}`);
  for (const failure of summary.gate?.failures ?? []) lines.push(`  ! ${failure}`);
  return lines.join("\n");
}

async function loadCases(repoRoot, testResults) {
  const cases = [];
  for (const file of [...new Set((testResults?.reports ?? []).map(({ file }) => file).filter(Boolean))]) {
    cases.push(...parseJUnitCases(await readText(resolve(repoRoot, file)), repoRoot));
  }
  return cases;
}

export async function writeQualityReport({
  repoRoot = DEFAULT_REPO_ROOT,
  reportRoot = resolve(repoRoot, "reports/quality"),
  summary,
  fileSize,
  testResults,
} = {}) {
  const [jscpd, lizardText, benchmarks] = await Promise.all([
    readJson(resolve(reportRoot, "jscpd-metrics.json"), null),
    readText(resolve(reportRoot, "lizard-gate.txt")),
    readJson(resolve(reportRoot, "benchmarks.json"), { benchmarks: [] }),
  ]);
  const cases = await loadCases(repoRoot, testResults);
  const report = formatQualityReport({
    summary,
    jscpd,
    lizard: parseLizardFindings(lizardText),
    fileSize,
    tests: testResults,
    cases,
    benchmarks: benchmarks.benchmarks ?? [],
  });
  await writeFile(resolve(reportRoot, "quality-report.txt"), `${report}\n`);
  return report;
}
