import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before } from "node:test";
import { createTreeSitter } from "../../scripts/tree-sitter.js";
import { parseCst, sourceEndPoint } from "./cst.js";

const commandTimeoutMs = 60_000;
const cstOutputLimitBytes = 16 * 1024 * 1024;
const summaryTimeoutMicros = 10_000_000;

let temporaryDirectory;
let treeSitter;
let fixtureNumber = 0;

before(() => {
  temporaryDirectory = mkdtempSync(
    join(tmpdir(), "tree-sitter-posix-sed-parser-"),
  );
  try {
    treeSitter = createTreeSitter();
  } catch (error) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
});

after(() => {
  try {
    treeSitter?.close();
  } finally {
    if (temporaryDirectory !== undefined) {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }
});

function applyEdits(source, edits) {
  let bytes = Buffer.from(source);
  for (const edit of edits) {
    const { byte, deleteBytes, insert } = edit;
    const description = JSON.stringify(edit);
    assert.ok(
      Number.isSafeInteger(byte) && byte >= 0,
      `invalid byte offset: ${description}`,
    );
    assert.ok(
      Number.isSafeInteger(deleteBytes) && deleteBytes >= 0,
      `invalid deletion length: ${description}`,
    );
    assert.equal(typeof insert, "string", `invalid insertion: ${description}`);
    assert.ok(
      byte <= bytes.length && deleteBytes <= bytes.length - byte,
      `edit exceeds ${bytes.length} source bytes: ${description}`,
    );
    bytes = Buffer.concat([
      bytes.subarray(0, byte),
      Buffer.from(insert),
      bytes.subarray(byte + deleteBytes),
    ]);
  }
  return bytes;
}

function formatEdit({ byte, deleteBytes, insert }) {
  return `${byte} ${deleteBytes} ${insert}`;
}

function parseInput(scope, source, edits = []) {
  const sourcePath = join(temporaryDirectory, `fixture-${fixtureNumber}.sed`);
  fixtureNumber += 1;
  writeFileSync(sourcePath, source);
  const result = treeSitter.run(
    [
      "parse",
      "--encoding",
      "utf8",
      "--scope",
      scope,
      "--cst",
      "--time",
      sourcePath,
      ...(edits.length === 0 ? [sourcePath] : []),
      ...(edits.length === 0 ? [] : ["--edits", ...edits.map(formatEdit)]),
    ],
    {
      encoding: "utf8",
      maxBuffer: cstOutputLimitBytes,
      timeout: commandTimeoutMs,
    },
  );
  if (result.error) {
    throw result.error;
  }
  assert.ok(
    result.status === 0 || result.status === 1,
    result.stdout + result.stderr,
  );
  const trees = [];
  let lines = [];
  for (const line of result.stdout.split("\n")) {
    if (
      line.startsWith(sourcePath) &&
      /^[ \t]+Parse:[ \t]/.test(line.slice(sourcePath.length))
    ) {
      trees.push(lines.join("\n"));
      lines = [];
    } else if (!/^[ \t]*Edit:[ \t]/.test(line)) lines.push(line);
  }
  assert.equal(
    trees.length,
    edits.length === 0 ? 2 : 1,
    result.stdout + result.stderr,
  );
  if (edits.length === 0)
    assert.equal(trees[1], trees[0], "repeated fresh parses must match");
  result.nodes = parseCst(trees[0], applyEdits(source, edits));
  // CLI exit status misses hidden MISSING tokens; the root marker includes them.
  result.hasError = /^[0-9: \t-]+•/.test(trees[0]);
  return result;
}

function parse(scope, source, edits = []) {
  let initial = Buffer.from(source);
  let current = initial;
  let history = [];
  let result = parseInput(scope, initial);
  const bom = Buffer.from("\uFEFF");
  for (const edit of edits) {
    const hadBom = current.subarray(0, bom.length).equals(bom);
    current = applyEdits(current, [edit]);
    const movedBom = !hadBom && current.subarray(0, bom.length).equals(bom);
    if (movedBom) {
      initial = current;
      history = [];
      result = parseInput(scope, current);
    } else {
      history.push(edit);
      result = parseInput(scope, initial, history);
    }
  }
  return result;
}

function parseSuccessfully(scope, source, edits = []) {
  const result = parse(scope, source, edits);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.hasError, false, result.stdout);
  return result;
}

function relexedTokens(scope, source, edits) {
  const sourcePath = join(temporaryDirectory, `fixture-${fixtureNumber}.sed`);
  fixtureNumber += 1;
  writeFileSync(sourcePath, source);
  const result = treeSitter.run(
    [
      "parse",
      "--encoding",
      "utf8",
      "--scope",
      scope,
      "--quiet",
      "--debug",
      "normal",
      sourcePath,
      "--edits",
      ...edits.map(formatEdit),
    ],
    {
      encoding: "utf8",
      maxBuffer: cstOutputLimitBytes,
      timeout: commandTimeoutMs,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const logs = result.stderr.split("\nparse_after_edit\n");
  assert.equal(logs.length, 2, "parser logged no reparse");
  return logs[1]
    .split("\n")
    .filter((line) => line.startsWith("lexed_lookahead")).length;
}

function assertIncrementalContract(fresh, incremental, context) {
  assert.equal(
    fresh.hasError,
    false,
    `${context}: expected a normal fresh parse`,
  );
  assert.equal(
    incremental.hasError,
    false,
    `${context}: normal source has errors\n${incremental.stdout}`,
  );
  assert.deepEqual(
    incremental.nodes,
    fresh.nodes,
    `${context}: fresh and incremental CSTs differ`,
  );
}

function assertValidHistory(scope, initial, steps) {
  let source = Buffer.from(initial);
  const edits = [];
  for (const { byte, deleteBytes, insert, source: expected, valid } of steps) {
    const edit = { byte, deleteBytes, insert };
    source = applyEdits(source, [edit]);
    assert.equal(
      source.toString(),
      expected,
      "edit must produce the explicit expected input",
    );
    edits.push(edit);
    const fresh = parse(scope, source);
    assert.equal(fresh.hasError, !valid, fresh.stdout);
    const incremental = parse(scope, initial, edits);
    if (valid)
      assertIncrementalContract(
        fresh,
        incremental,
        JSON.stringify({ initial, edits }),
      );
  }
}

function parseSummary(scope, source, timeoutMicros = summaryTimeoutMicros) {
  const sourcePath = join(temporaryDirectory, `summary-${fixtureNumber++}.sed`);
  writeFileSync(sourcePath, source);
  const result = treeSitter.run(
    [
      "parse",
      "--encoding",
      "utf8",
      "--scope",
      scope,
      "--quiet",
      "--json-summary",
      "--timeout",
      String(timeoutMicros),
      sourcePath,
    ],
    { encoding: "utf8", timeout: commandTimeoutMs },
  );
  assert.ifError(result.error);
  assert.ok(
    result.status === 0 || result.status === 1,
    result.stdout + result.stderr,
  );
  const start = result.stdout.indexOf("{\n");
  assert.notEqual(start, -1, "parser produced no summary");
  const { parse_summaries: summaries } = JSON.parse(result.stdout.slice(start));
  assert.equal(summaries?.length, 1, "parser produced no complete root");
  const summary = summaries[0];
  assert.equal(
    `${summary.end.row}:${summary.end.column}`,
    sourceEndPoint(source),
    "root must reach the source end",
  );
  assert.equal(
    summary.bytes,
    Buffer.byteLength(source),
    "parser omitted source bytes",
  );
  return summary;
}

export {
  applyEdits,
  assertIncrementalContract,
  assertValidHistory,
  parse,
  parseSuccessfully,
  parseSummary,
  relexedTokens,
};
