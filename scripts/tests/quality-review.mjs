import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path, { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkFileSizes,
  formatFileSizeReport,
  HARD_LIMIT,
  REVIEW_LIMIT,
} from "./check-file-size.mjs";
import {
  DEFAULT_IGNORES,
  DEFAULT_MIN_LINES,
  DEFAULT_MIN_TOKENS,
  DEFAULT_THRESHOLD,
  runJscpd,
} from "./jscpd.mjs";
import {
  collectCoverage,
  collectGitChurn,
  collectTestResults,
  rankHotspots,
  runCommand,
  summarizeTrivyReport,
} from "./quality-metrics.mjs";
import { writeQualityReport } from "./quality-report.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPO_ROOT = resolve(scriptDir, "../..");
export const DEFAULT_QUALITY_PATHS = ["src", "bridge/rustproxyhub", "frontend/src"];

export const POLICY = {
  file: { review: REVIEW_LIMIT, hard: HARD_LIMIT },
  duplication: { hardPercent: DEFAULT_THRESHOLD },
  complexity: {
    review: { ccn: 10, nloc: 50, length: 80, arguments: 4 },
    hard: { ccn: 15, nloc: 80, length: 120, arguments: 6 },
  },
  coverage: { linePercentMin: 80 },
  churn: { days: 90, hotspotLimit: 20 },
};

function positiveInteger(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function percentage(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) throw new Error(`${name} must be between 0 and 100`);
  return parsed;
}

function requiredValue(argv, index, argument) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
  return value;
}

export function parseQualityArgs(argv, { repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const options = {
    repoRoot,
    paths: [],
    strict: false,
    requireTools: false,
    requireEvidence: false,
    security: false,
    skipJscpd: false,
    skipLizard: false,
    coverageMin: POLICY.coverage.linePercentMin,
    churnDays: POLICY.churn.days,
    coverageFiles: [],
    testFiles: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--strict") options.strict = true;
    else if (argument === "--require-tools") options.requireTools = true;
    else if (argument === "--require-evidence") options.requireEvidence = true;
    else if (argument === "--security") options.security = true;
    else if (argument === "--no-jscpd") options.skipJscpd = true;
    else if (argument === "--no-lizard") options.skipLizard = true;
    else if (!argument.startsWith("--")) options.paths.push(argument);
    else {
      const value = requiredValue(argv, index, argument);
      if (argument === "--root") options.repoRoot = resolve(value);
      else if (argument === "--coverage-min") options.coverageMin = percentage(value, argument);
      else if (argument === "--churn-days") options.churnDays = positiveInteger(value, argument);
      else if (argument === "--coverage") options.coverageFiles.push(value);
      else if (argument === "--test-report") options.testFiles.push(value);
      else throw new Error(`Unknown argument: ${argument}`);
      index += 1;
    }
  }
  if (options.paths.length === 0) options.paths.push(...DEFAULT_QUALITY_PATHS);
  return options;
}

async function writeReport(reportRoot, name, content) {
  await writeFile(resolve(reportRoot, name), `${String(content).trim()}\n`);
}

async function resolveLizardPython(repoRoot) {
  const configured = process.env.LIZARD_PYTHON;
  if (configured) return configured;
  const local = resolve(
    repoRoot,
    ".quality-venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
  try {
    await access(local);
    return local;
  } catch {
    return "python";
  }
}

async function runLizardWithLimits(repoRoot, filesList, limits) {
  const args = [
    "-f",
    filesList,
    "-C",
    String(limits.ccn),
    "-L",
    String(limits.length),
    "-a",
    String(limits.arguments),
    "-T",
    `nloc=${limits.nloc}`,
    "--warnings_only",
  ];
  const direct = markLizardFindings(await runCommand("lizard", args, { cwd: repoRoot }));
  if (!direct.missing) return { ...direct, available: true };
  const fallback = markLizardFindings(
    await runCommand(await resolveLizardPython(repoRoot), ["-m", "lizard", ...args], { cwd: repoRoot }),
  );
  if (/No module named lizard/i.test(fallback.stderr) || fallback.missing) {
    return { ...fallback, available: false, missing: true };
  }
  return { ...fallback, available: true };
}

function markLizardFindings(result) {
  if (result.code === 0 && result.stdout.trim()) result.code = 1;
  return result;
}

async function runLizard(repoRoot, reportRoot, files, strict) {
  const listPath = resolve(reportRoot, "lizard-files.txt");
  await writeFile(listPath, `${files.map(({ file }) => file).join("\n")}\n`);
  const review = await runLizardWithLimits(repoRoot, listPath, POLICY.complexity.review);
  if (!review.available) return { available: false, review, gate: review };
  const gate = strict ? review : await runLizardWithLimits(repoRoot, listPath, POLICY.complexity.hard);
  return { available: gate.available, review, gate };
}

async function runTrivy(repoRoot, reportRoot) {
  const reportPath = resolve(reportRoot, "trivy.json");
  const result = await runCommand(
    "trivy",
    [
      "fs",
      "--scanners",
      "vuln,misconfig,secret",
      "--severity",
      "HIGH,CRITICAL",
      "--exit-code",
      "1",
      "--format",
      "json",
      "--output",
      reportPath,
      ".",
    ],
    { cwd: repoRoot },
  );
  if (result.missing) return { available: false, exitCode: null, error: "trivy executable not found" };
  let metrics = null;
  try {
    metrics = summarizeTrivyReport(JSON.parse(await readFile(reportPath, "utf8")));
  } catch (error) {
    return { available: true, exitCode: result.code, error: error.message, stdout: result.stdout, stderr: result.stderr };
  }
  return { available: true, exitCode: result.code, reportPath, metrics, stdout: result.stdout, stderr: result.stderr };
}

export function evaluateQualityGate(summary, options) {
  const failures = [];
  if (summary.file_size.oversized > 0) failures.push(`${summary.file_size.oversized} oversized source file(s)`);
  if (summary.jscpd.enabled && summary.jscpd.available && summary.jscpd.exit_code !== 0) {
    failures.push(`duplication gate failed (${summary.jscpd.duplication_percent ?? "unknown"}%)`);
  }
  if (summary.lizard.enabled && summary.lizard.available && summary.lizard.exit_code !== 0) {
    failures.push("complexity gate failed");
  }
  if (summary.coverage.available && summary.coverage.lines_percent != null && summary.coverage.lines_percent < options.coverageMin) {
    failures.push(`line coverage ${summary.coverage.lines_percent}% < ${options.coverageMin}%`);
  }
  if (summary.tests.available && (summary.tests.failures > 0 || summary.tests.errors > 0)) {
    failures.push(`${summary.tests.failures + summary.tests.errors} failing/error test(s)`);
  }
  if (summary.security.enabled && summary.security.available && summary.security.exit_code !== 0) {
    failures.push(`${summary.security.findings ?? "security"} high/critical security finding(s)`);
  }
  if (options.requireTools) {
    if (summary.jscpd.enabled && !summary.jscpd.available) failures.push("required tool missing: jscpd");
    if (summary.lizard.enabled && !summary.lizard.available) failures.push("required tool missing: lizard");
    if (summary.security.enabled && !summary.security.available) failures.push("required tool missing: trivy");
  }
  if (options.requireEvidence) {
    if (!summary.coverage.available) failures.push("coverage evidence missing");
    if (!summary.tests.available) failures.push("test-result evidence missing");
  }
  return { status: failures.length ? "fail" : "pass", failures };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseQualityArgs(argv);
  const repoRoot = options.repoRoot;
  const reportRoot = resolve(repoRoot, "reports/quality");
  await mkdir(reportRoot, { recursive: true });

  const fileSize = await checkFileSizes({ repoRoot, roots: options.paths });
  await writeReport(reportRoot, "file-size.txt", formatFileSizeReport(fileSize));

  let jscpd = { available: false, exitCode: null, metrics: null, error: "disabled" };
  if (!options.skipJscpd) {
    try {
      jscpd = await runJscpd({
        repoRoot,
        paths: options.paths,
        output: resolve(reportRoot, "jscpd"),
        metrics: resolve(reportRoot, "jscpd-metrics.json"),
        reporters: ["json", "sarif"],
        minLines: DEFAULT_MIN_LINES,
        minTokens: DEFAULT_MIN_TOKENS,
        threshold: DEFAULT_THRESHOLD,
        mode: options.strict ? "strict" : "mild",
        ignores: DEFAULT_IGNORES,
        blame: false,
        crossFormats: [],
        binary: null,
      });
    } catch (error) {
      jscpd = { available: true, exitCode: 1, metrics: null, error: error.message };
    }
  }
  await writeReport(reportRoot, "jscpd.txt", jscpd.metrics ? JSON.stringify(jscpd.metrics, null, 2) : jscpd.error ?? "unavailable");

  const lizard = options.skipLizard
    ? { available: false, review: { code: null }, gate: { code: null }, disabled: true }
    : await runLizard(repoRoot, reportRoot, fileSize.files, options.strict);
  await writeReport(reportRoot, "lizard-review.txt", lizard.review?.stdout || lizard.review?.stderr || (lizard.available ? "lizard: no findings" : "lizard unavailable"));
  await writeReport(reportRoot, "lizard-gate.txt", lizard.gate?.stdout || lizard.gate?.stderr || (lizard.available ? "lizard: no findings" : "lizard unavailable"));

  const coverage = await collectCoverage(repoRoot, options.coverageFiles);
  const tests = await collectTestResults(repoRoot, options.testFiles);
  const churn = await collectGitChurn(repoRoot, { days: options.churnDays });
  const hotspots = rankHotspots(fileSize.files, churn.files ?? [], {
    reviewLimit: POLICY.file.review,
    limit: POLICY.churn.hotspotLimit,
  });
  await writeReport(reportRoot, "coverage.json", JSON.stringify(coverage, null, 2));
  await writeReport(reportRoot, "tests.json", JSON.stringify(tests, null, 2));
  await writeReport(reportRoot, "churn.json", JSON.stringify(churn, null, 2));
  await writeReport(reportRoot, "hotspots.json", JSON.stringify(hotspots, null, 2));

  const security = options.security
    ? await runTrivy(repoRoot, reportRoot)
    : { available: false, exitCode: null, error: "not requested" };
  await writeReport(reportRoot, "security.json", JSON.stringify(security, null, 2));

  const summary = {
    generated_at: new Date().toISOString(),
    mode: options.strict ? "strict" : "default",
    file_size: {
      files: fileSize.files.length,
      review: fileSize.review.length,
      oversized: fileSize.oversized.length,
    },
    jscpd: {
      enabled: !options.skipJscpd,
      available: Boolean(jscpd.available),
      exit_code: jscpd.exitCode,
      duplication_percent: jscpd.metrics?.summary?.duplication_percent ?? null,
      clones: jscpd.metrics?.summary?.clones ?? null,
    },
    lizard: {
      enabled: !options.skipLizard,
      available: Boolean(lizard.available),
      exit_code: lizard.gate?.code ?? null,
      review_exit_code: lizard.review?.code ?? null,
    },
    coverage: {
      available: coverage.available,
      reports: coverage.aggregate.reports,
      lines_percent: coverage.aggregate.lines.percent,
      branches_percent: coverage.aggregate.branches.percent,
      functions_percent: coverage.aggregate.functions.percent,
    },
    tests: {
      available: tests.available,
      ...tests.aggregate,
    },
    churn: {
      available: churn.available,
      days: churn.days,
      files_changed: churn.files?.length ?? 0,
      total_changes: churn.total_changes ?? 0,
      hotspots,
    },
    security: {
      enabled: options.security,
      available: Boolean(security.available),
      exit_code: security.exitCode,
      findings: security.metrics?.findings ?? null,
      high: security.metrics?.high ?? null,
      critical: security.metrics?.critical ?? null,
    },
    policy: {
      file_lines_review: POLICY.file.review,
      file_lines_hard: POLICY.file.hard,
      duplication_percent_max: POLICY.duplication.hardPercent,
      complexity_review: POLICY.complexity.review,
      complexity_hard: POLICY.complexity.hard,
      coverage_lines_min: options.coverageMin,
      churn_days: options.churnDays,
    },
  };
  summary.gate = evaluateQualityGate(summary, options);
  await writeReport(reportRoot, "summary.json", JSON.stringify(summary, null, 2));
  const report = await writeQualityReport({ repoRoot, reportRoot, summary, fileSize, testResults: tests });
  console.log(report);
  return summary.gate.status === "pass" ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error.stack || error.message);
      process.exitCode = 1;
    });
}
