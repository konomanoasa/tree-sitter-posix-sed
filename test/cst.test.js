import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { grammars, root } from "../scripts/tree-sitter.js";
import { parseCst } from "./support/cst.js";
import {
  assertIncrementalContract,
  parse,
  parseSuccessfully,
  parseSummary,
} from "./support/parser.js";

function parseCorpus(text) {
  const sections = text.split("==================\n");
  assert.equal(sections.shift(), "", "corpus must begin with a header");
  assert.equal(sections.length % 2, 0, "corpus headers must be paired");
  const cases = [];
  for (let index = 0; index < sections.length; index += 2) {
    const [name, ...attributes] = sections[index].trimEnd().split("\n");
    assert.ok(name, "corpus case must have a name");
    const languages = [];
    const valid = !attributes.includes(":error");
    for (const attribute of attributes) {
      if (attribute === ":cst" || attribute === ":error") continue;
      const match = /^:language\(([a-z_]+)\)$/.exec(attribute);
      assert.ok(match, `unsupported corpus attribute: ${attribute}`);
      assert.ok(!languages.includes(match[1]), `${name}: duplicate language`);
      languages.push(match[1]);
    }
    assert.ok(languages.length > 0, `${name}: missing language`);
    const parts = sections[index + 1].split("\n------------------\n");
    assert.equal(parts.length, 2, `${name}: expected one output separator`);
    const source = parts[0].endsWith("\r") ? parts[0].slice(0, -1) : parts[0];
    cases.push({ name, languages, source, valid });
  }
  return cases;
}

const largeCommandCount = 100_000;
const largeTextCharacters = 1024 * 1024;
const largeRegexCharacters = 100_000;
const nestedBlockDepth = 2_000;
const nestedGroupDepth = 2_000;
const resourceTimeoutMicros = 10_000_000;

for (const grammar of grammars) {
  test(`${grammar.name}: layout stays outside commands and empty lists`, () => {
    for (const { source, commands, lists } of [
      { source: " \t", commands: [], lists: [] },
      { source: " p; ", commands: [[1, 2]], lists: [[1, 3]] },
      { source: " 1 p", commands: [[1, 4]], lists: [[1, 4]] },
      { source: " ; ", commands: [], lists: [[1, 2]] },
      {
        source: "{ p; } ",
        commands: [
          [0, 6],
          [2, 3],
        ],
        lists: [
          [0, 6],
          [2, 4],
        ],
      },
      { source: "r file ", commands: [[0, 7]], lists: [[0, 7]] },
      { source: "a\\\n ", commands: [[0, 4]], lists: [[0, 4]] },
    ]) {
      const result = parseSuccessfully(grammar.scope, source);
      const ranges = (kind) =>
        result.nodes
          .filter((node) => node.kind === kind)
          .map(({ startByte, endByte }) => [startByte, endByte]);
      assert.deepEqual(ranges("editing_command"), commands, source);
      assert.deepEqual(ranges("command_list"), lists, source);
      for (let byte = 0; byte < source.length; byte++) {
        if (source[byte] !== " " && source[byte] !== "\t") continue;
        assertIncrementalContract(
          result,
          parse(grammar.scope, source, [
            { byte, deleteBytes: 1, insert: "" },
            { byte, deleteBytes: 0, insert: source[byte] },
          ]),
          source,
        );
      }
    }
  });
}

test("posix_sed: corpus reader preserves source and language selection", () => {
  const header = "==================\n";
  const separator = "\n------------------\n";
  const source = "p\0\n";
  assert.deepEqual(
    parseCorpus(
      `${header}Shared input\n:language(posix_sed)\n:language(posix_sed_ere)\n:cst\n${header}${source}${separator}expected\n\n` +
        `${header}Input at EOF\n:language(posix_sed)\n${header}p${separator}(script)\n` +
        `${header}Invalid input\n:language(posix_sed_ere)\n:error\n${header}\uFEFF\r\n\0${separator}\n`,
    ),
    [
      {
        name: "Shared input",
        languages: ["posix_sed", "posix_sed_ere"],
        source,
        valid: true,
      },
      {
        name: "Input at EOF",
        languages: ["posix_sed"],
        source: "p",
        valid: true,
      },
      {
        name: "Invalid input",
        languages: ["posix_sed_ere"],
        source: "\uFEFF\r\n\0",
        valid: false,
      },
    ],
  );
});

const corpusDirectory = join(root, "test", "corpus");
for (const file of readdirSync(corpusDirectory).sort()) {
  const cases = parseCorpus(readFileSync(join(corpusDirectory, file), "utf8"));
  for (const { name, languages, source, valid } of cases) {
    for (const language of languages) {
      const grammar = grammars.find(({ name }) => name === language);
      assert.ok(grammar, `${file}: unknown language ${language}`);
      test(`${language}: ${file}: ${name}: CST invariants and fresh determinism`, () => {
        const result = parse(grammar.scope, source);
        assert.equal(result.hasError, !valid, result.stdout);
        assert.ok(
          result.nodes.every(
            ({ kind, field }) => kind !== "syntax_issue" && field !== "issue",
          ),
        );
      });
    }
  }
}

test("posix_sed: CST helpers retain ERROR ancestry, fields, UTF-8 offsets and MISSING nodes", () => {
  const source = "é\np";
  const nodes = parseCst(
    [
      "0:0 - 1:1  •ERROR",
      "0:0 - 0:2     label: label_literal `é`",
      "1:0 - 1:1    •ERROR",
      "1:0 - 1:1       function_verb `p`",
      "1:1 - 1:1    •MISSING",
      '1:1 - 1:1       "}"',
    ].join("\n"),
    source,
  );
  assert.deepEqual(
    nodes.map(({ kind, field, parent, startByte, endByte }) => [
      kind,
      field,
      parent,
      startByte,
      endByte,
    ]),
    [
      ["ERROR", null, null, 0, 4],
      ["label_literal", "label", 0, 0, 2],
      ["ERROR", null, 0, 3, 4],
      ["function_verb", null, 2, 3, 4],
      ["MISSING", null, 0, 4, 4],
      ['"}"', null, 4, 4, 4],
    ],
  );
  assert.throws(() => parseCst("", source), assert.AssertionError);
  assert.throws(
    () => parseCst("0:0 - 0:2   script", source),
    /root must reach/,
  );
});

for (const grammar of grammars) {
  test(`${grammar.name}: public node definitions contain only the standard CST`, () => {
    const types = JSON.parse(
      readFileSync(join(root, grammar.path, "src/node-types.json"), "utf8"),
    );
    for (const node of types) {
      assert.doesNotMatch(
        node.type,
        /syntax_issue|invalid_|incomplete_|missing_|duplicate_|orphan_|unmatched_/,
      );
      assert.equal(node.fields?.issue, undefined);
    }
  });
}

for (const scope of ["source.posix_sed", "source.posix_sed.ere"]) {
  const open = scope.endsWith("ere") ? "(" : "\\(";
  const close = scope.endsWith("ere") ? ")" : "\\)";
  for (const [name, source, valid] of [
    [`${largeCommandCount} commands`, "p;".repeat(largeCommandCount), true],
    ["one MiB text operand", `a\\\n${"x".repeat(largeTextCharacters)}`, true],
    [
      `${largeRegexCharacters} regex characters`,
      `s/${"a".repeat(largeRegexCharacters)}/b/`,
      true,
    ],
    [
      `${nestedBlockDepth} nested blocks`,
      `${"{".repeat(nestedBlockDepth)}p${";}".repeat(nestedBlockDepth)}`,
      true,
    ],
    [
      `${nestedGroupDepth} nested groups`,
      `s/${open.repeat(nestedGroupDepth)}a${close.repeat(nestedGroupDepth)}/b/`,
      true,
    ],
    [
      `${nestedGroupDepth} unclosed groups`,
      `s/${open.repeat(nestedGroupDepth)}a`,
      false,
    ],
  ]) {
    test(`${scope}: resources ${name}`, () => {
      const result = parseSummary(scope, source, resourceTimeoutMicros);
      assert.equal(result.successful, valid, JSON.stringify(result));
    });
  }
}
