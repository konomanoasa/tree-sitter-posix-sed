import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { grammars, root } from "../scripts/tree-sitter.js";
import { parseCorpus } from "./support/corpus.js";
import {
  assertNoNodes,
  issuePaths,
  issueSignatures,
  nodeRange,
  parseCst,
  publicNodes,
  syntaxSignatures,
  topLevelEditingCommands,
} from "./support/cst.js";
import {
  applyEdits,
  assertIncrementalContract,
  parse,
  parseCstWithin,
  parseSuccessfully,
  parseSummary,
} from "./support/parser.js";

const largeReplacementCharacters = 80_000;
const largeCommandCount = 16_000;

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

  test(`${grammar.name}: missing elements follow permitted layout before completion`, () => {
    for (const { source, reason, completed } of [
      { source: "1 \t", reason: "missing_function", completed: "1 \tp" },
      { source: "r \t", reason: "missing_rfile", completed: "r \tfile" },
      { source: "{; \t", reason: "missing_closing_brace", completed: "{; \t}" },
    ]) {
      const result = parseSuccessfully(grammar.scope, source);
      assert.deepEqual(
        result.nodes
          .filter((node) => node.kind === reason)
          .map(({ startByte, endByte }) => [startByte, endByte]),
        [[source.length, source.length]],
        source,
      );
      const fresh = parseSuccessfully(grammar.scope, completed);
      assert.deepEqual(issueSignatures(fresh.nodes), []);
      assertIncrementalContract(
        fresh,
        parse(grammar.scope, source, [
          {
            byte: source.length,
            deleteBytes: 0,
            insert: completed.slice(source.length),
          },
        ]),
        completed,
      );
      assertIncrementalContract(
        result,
        parse(grammar.scope, completed, [
          {
            byte: source.length,
            deleteBytes: completed.length - source.length,
            insert: "",
          },
        ]),
        source,
      );
    }
  });
}
const nestedBlockDepth = 2_000;
const printedCommandCount = 50_000;
const cstPrintTimeoutMs = 60_000;
const immediateParserTimeoutMicros = 1;

test("posix_sed: corpus reader preserves source and language selection", () => {
  const header = "==================\n";
  const separator = "\n------------------\n";
  const source = "p\0\n";
  assert.deepEqual(
    parseCorpus(
      `${header}Shared input\n:language(posix_sed)\n:language(posix_sed_ere)\n:cst\n${header}${source}${separator}expected\n\n` +
        `${header}Input at EOF\n:language(posix_sed)\n${header}p${separator}(script)\n`,
    ),
    [
      {
        name: "Shared input",
        languages: ["posix_sed", "posix_sed_ere"],
        source,
      },
      { name: "Input at EOF", languages: ["posix_sed"], source: "p" },
    ],
  );
});

const corpusDirectory = join(root, "test", "corpus");
for (const file of readdirSync(corpusDirectory).sort()) {
  const cases = parseCorpus(readFileSync(join(corpusDirectory, file), "utf8"));
  for (const { name, languages, source } of cases) {
    for (const language of languages) {
      const grammar = grammars.find(({ name }) => name === language);
      assert.ok(grammar, `${file}: unknown language ${language}`);
      test(`${language}: ${file}: ${name}: CST invariants and fresh determinism`, () => {
        const first = parseSuccessfully(grammar.scope, source);
        const second = parseSuccessfully(grammar.scope, source);
        issueSignatures(first.nodes);
        assertNoNodes(first.nodes, "ERROR", "MISSING");
        assert.deepEqual(second.nodes, first.nodes);
      });
    }
  }
}

const cstSource = "# é\n1,";
const cstOutput = [
  "0:0 - 1:2   script",
  "0:0 - 1:2     command_list",
  "0:0 - 0:4       editing_command",
  "0:0 - 0:4         function: function",
  "0:0 - 0:4           comment_function",
  "0:0 - 0:1             verb: function_verb `#`",
  "0:1 - 0:4             comment: comment",
  "0:1 - 0:4               comment_text ` é`",
  "0:4 - 1:0       command_separator",
  "0:4 - 0:5         `\\n`",
  "1:0 - 1:2       editing_command",
  "1:0 - 1:2         addresses: address_clause",
  "1:0 - 1:1           first: address",
  "1:0 - 1:1             line_number_address `1`",
  "1:1 - 1:2           separator: address_separator `,`",
  "1:2 - 1:2           issue: syntax_issue",
  "1:2 - 1:2             incomplete_syntax",
  "1:2 - 1:2               omitted_address",
  "1:2 - 1:2         issue: syntax_issue",
  "1:2 - 1:2           incomplete_syntax",
  "1:2 - 1:2             missing_function",
].join("\n");

test("posix_sed: CST helpers retain fields, UTF-8 byte offsets and zero-width issues", () => {
  const nodes = parseCst(cstOutput, cstSource);
  assert.deepEqual(
    nodes.map(({ kind, field, parent, start, end, startByte, endByte }) => [
      kind,
      field,
      parent,
      start,
      end,
      startByte,
      endByte,
    ]),
    [
      ["script", null, null, [0, 0], [1, 2], 0, 7],
      ["command_list", null, 0, [0, 0], [1, 2], 0, 7],
      ["editing_command", null, 1, [0, 0], [0, 4], 0, 4],
      ["function", "function", 2, [0, 0], [0, 4], 0, 4],
      ["comment_function", null, 3, [0, 0], [0, 4], 0, 4],
      ["function_verb", "verb", 4, [0, 0], [0, 1], 0, 1],
      ["comment", "comment", 4, [0, 1], [0, 4], 1, 4],
      ["comment_text", null, 6, [0, 1], [0, 4], 1, 4],
      ["command_separator", null, 1, [0, 4], [1, 0], 4, 5],
      ["editing_command", null, 1, [1, 0], [1, 2], 5, 7],
      ["address_clause", "addresses", 9, [1, 0], [1, 2], 5, 7],
      ["address", "first", 10, [1, 0], [1, 1], 5, 6],
      ["line_number_address", null, 11, [1, 0], [1, 1], 5, 6],
      ["address_separator", "separator", 10, [1, 1], [1, 2], 6, 7],
      ["syntax_issue", "issue", 10, [1, 2], [1, 2], 7, 7],
      ["incomplete_syntax", null, 14, [1, 2], [1, 2], 7, 7],
      ["omitted_address", null, 15, [1, 2], [1, 2], 7, 7],
      ["syntax_issue", "issue", 9, [1, 2], [1, 2], 7, 7],
      ["incomplete_syntax", null, 17, [1, 2], [1, 2], 7, 7],
      ["missing_function", null, 18, [1, 2], [1, 2], 7, 7],
    ],
  );
  assert.deepEqual(issueSignatures(nodes), [
    {
      outcome: "incomplete_syntax",
      reason: "omitted_address",
      range: "[1, 2] - [1, 2]",
    },
    {
      outcome: "incomplete_syntax",
      reason: "missing_function",
      range: "[1, 2] - [1, 2]",
    },
  ]);
  const commands = topLevelEditingCommands(nodes);
  assert.deepEqual(
    commands.map(({ start }) => start),
    [
      [0, 0],
      [1, 0],
    ],
  );
  assert.deepEqual(commands[1].nodes.at(-1), {
    kind: "missing_function",
    parent: 9,
    field: null,
    start: [0, 2],
    end: [0, 2],
    startByte: 2,
    endByte: 2,
  });
});

test("posix_sed: CST helpers reject truncated roots and malformed issue ownership", () => {
  assert.throws(() => parseCst("", cstSource), assert.AssertionError);
  assert.throws(
    () => parseCst(cstOutput, `${cstSource}p`),
    /root must reach the edited source end/,
  );
  for (const [name, before, after] of [
    ["wrong field", "issue: syntax_issue", "reason: syntax_issue"],
    [
      "outcome without an issue owner",
      "1:2 - 1:2             incomplete_syntax",
      "1:2 - 1:2           incomplete_syntax",
    ],
    [
      "reason without an outcome owner",
      "1:2 - 1:2               omitted_address",
      "1:2 - 1:2             omitted_address",
    ],
    [
      "outcome range differs",
      "1:2 - 1:2             incomplete_syntax",
      "1:1 - 1:2             incomplete_syntax",
    ],
    [
      "reason range differs",
      "1:2 - 1:2               omitted_address",
      "1:1 - 1:2               omitted_address",
    ],
  ]) {
    const nodes = parseCst(cstOutput.replace(before, after), cstSource);
    assert.throws(() => issueSignatures(nodes), assert.AssertionError, name);
  }
});

test("posix_sed: public CST comparison retains source children inside native recovery", () => {
  const nodes = parseCst(
    [
      "0:0 - 0:1   script",
      "0:0 - 0:1     command_list",
      "0:0 - 0:1       ERROR",
      "0:0 - 0:1         function: editing_command",
      "0:0 - 0:1           function: function",
      "0:0 - 0:1             print_function",
      "0:0 - 0:1               verb: function_verb `p`",
      "0:1 - 0:1       MISSING",
      "0:1 - 0:1         closing_brace",
    ].join("\n"),
    "p",
  );
  assert.deepEqual(
    publicNodes(nodes).map(({ kind, field, parent }) => [kind, field, parent]),
    [
      ["script", null, null],
      ["command_list", null, 0],
      ["editing_command", null, 1],
      ["function", "function", 2],
      ["print_function", null, 3],
      ["function_verb", "verb", 4],
    ],
  );
});

const issueOutcomeNames = new Set([
  "undefined_syntax",
  "unspecified_syntax",
  "implementation_defined_syntax",
  "invalid_syntax",
  "nonconforming_syntax",
  "incomplete_syntax",
]);

function namedNode(nodeTypes, type, path) {
  const matches = nodeTypes.filter((node) => node.named && node.type === type);
  if (matches.length !== 1) {
    throw new Error(`${path}: expected one named ${type} node`);
  }
  return matches[0];
}

function requiredSingleChildren(node, path) {
  const { children } = node;
  if (
    !children?.required ||
    children.multiple ||
    Object.keys(node.fields ?? {}).length !== 0
  ) {
    throw new Error(`${path}: expected one required child`);
  }
  if (
    children.types.length === 0 ||
    children.types.some((type) => !type.named)
  ) {
    throw new Error(`${path}: expected named child types`);
  }
  return children.types;
}

function checkSourceChildren(nodeTypes, grammar, displayPath) {
  const expectedChildren = [
    ["blanks_after_negation", "blank"],
    ["blanks_around_address_separator", "blank"],
    ["special_delimiter_escape", "escaped_delimiter"],
    ["replacement_ampersand_delimiter_escape", "replacement_escaped_delimiter"],
  ];
  for (const reason of [
    "unmatched_interval_close",
    "unmatched_subexpression_close",
  ]) {
    if (grammar.name === "posix_sed") {
      const node = namedNode(nodeTypes, reason, displayPath);
      assert.equal(node.children, undefined);
      assert.deepEqual(node.fields, {});
    } else {
      assert.ok(
        !nodeTypes.some((node) => node.named && node.type === reason),
        `${displayPath}: ${reason} must remain BRE-only`,
      );
    }
  }
  for (const [reason, child] of expectedChildren) {
    const node = namedNode(nodeTypes, reason, displayPath);
    assert.deepEqual(
      requiredSingleChildren(node, `${displayPath}:${reason}`),
      [{ type: child, named: true }],
      `${displayPath}: ${reason} must own one ${child} source child`,
    );
  }
}

function checkBracketTerms(nodeTypes, displayPath) {
  const invalidName = namedNode(
    nodeTypes,
    "invalid_character_class_name",
    displayPath,
  );
  assert.deepEqual(invalidName.fields, {});
  assert.equal(invalidName.children, undefined);
  const invalidElement = namedNode(
    nodeTypes,
    "invalid_equivalence_class_element",
    displayPath,
  );
  assert.deepEqual(requiredSingleChildren(invalidElement, displayPath), [
    { type: "meta_character", named: true },
  ]);
  for (const obsolete of [
    "open_colon",
    "colon_close",
    "open_dot",
    "dot_close",
    "open_equal",
    "equal_close",
  ]) {
    assert.ok(
      !nodeTypes.some((node) => node.type === obsolete),
      `${displayPath}: ${obsolete} must not be public`,
    );
  }
  for (const { type, field, payloadTypes } of [
    { type: "character_class", field: "name", payloadTypes: ["class_name"] },
    {
      type: "collating_symbol",
      field: "element",
      payloadTypes: [
        "collating_element_multi",
        "collating_element_single",
        "meta_character",
      ],
    },
    {
      type: "equivalence_class",
      field: "element",
      payloadTypes: ["collating_element_multi", "collating_element_single"],
    },
  ]) {
    const node = namedNode(nodeTypes, type, displayPath);
    assert.deepEqual(
      Object.keys(node.fields).sort(),
      [field, "issue"].sort(),
      `${displayPath}: ${type} fields`,
    );
    assert.deepEqual(
      node.fields[field],
      {
        multiple: true,
        required: false,
        types: payloadTypes.map((payload) => ({ type: payload, named: true })),
      },
      `${displayPath}: ${type}.${field} payload`,
    );
  }
}

function checkPublicCst(grammar, generatedRoot) {
  const path = join(generatedRoot, grammar.path, "src", "node-types.json");
  const displayPath = relative(generatedRoot, path);
  const nodeTypes = JSON.parse(readFileSync(path, "utf8"));
  const syntaxIssue = namedNode(nodeTypes, "syntax_issue", displayPath);
  const outcomeTypes = requiredSingleChildren(
    syntaxIssue,
    `${displayPath}:syntax_issue`,
  );
  const actualOutcomes = new Set(outcomeTypes.map(({ type }) => type));
  const reasons = new Set();

  for (const { type } of outcomeTypes) {
    if (!issueOutcomeNames.has(type)) {
      throw new Error(
        `${displayPath}: unexpected syntax_issue outcome ${type}`,
      );
    }
    const outcome = namedNode(nodeTypes, type, displayPath);
    for (const reason of requiredSingleChildren(
      outcome,
      `${displayPath}:${type}`,
    )) {
      if (
        reason.type === "syntax_issue" ||
        issueOutcomeNames.has(reason.type)
      ) {
        throw new Error(`${displayPath}: invalid issue reason ${reason.type}`);
      }
      namedNode(nodeTypes, reason.type, displayPath);
      reasons.add(reason.type);
    }
  }

  for (const outcome of issueOutcomeNames) {
    const present = nodeTypes.some(
      (node) => node.named && node.type === outcome,
    );
    if (present !== actualOutcomes.has(outcome)) {
      throw new Error(`${displayPath}: ${outcome} bypasses syntax_issue`);
    }
  }

  for (const node of nodeTypes) {
    if (
      node.named &&
      /(^_|(^|_)(recovery|control|marker|placeholder)($|_)|_token$)/.test(
        node.type,
      )
    ) {
      throw new Error(`${displayPath}: internal node ${node.type} is public`);
    }
    for (const reference of [
      node.children,
      ...Object.values(node.fields ?? {}),
    ]) {
      for (const child of reference?.types ?? []) {
        if (!child.named) {
          continue;
        }
        if (actualOutcomes.has(child.type) && node.type !== "syntax_issue") {
          throw new Error(
            `${displayPath}: ${node.type} owns ${child.type} outside syntax_issue`,
          );
        }
        if (reasons.has(child.type) && !actualOutcomes.has(node.type)) {
          throw new Error(
            `${displayPath}: ${node.type} owns reason ${child.type} outside an outcome`,
          );
        }
      }
    }
  }

  for (const type of [
    "address_separator",
    "delimiter",
    "closing_brace",
    "text_introducer",
    "collating_element_single",
    "collating_element_multi",
    "duplication_count",
    "ordinary_character",
    "quoted_character",
    "invalid_encoding",
    "class_name",
    "meta_character",
    "escaped_delimiter",
    "replacement_escaped_delimiter",
  ]) {
    const node = namedNode(nodeTypes, type, displayPath);
    assert.ok(
      node.children === undefined &&
        Object.keys(node.fields ?? {}).length === 0,
      `${displayPath}: ${type} must be a lexical leaf`,
    );
  }

  checkSourceChildren(nodeTypes, grammar, displayPath);
  checkBracketTerms(nodeTypes, displayPath);
  assert.deepEqual(
    nodeTypes
      .filter((node) => !node.named)
      .map((node) => node.type)
      .sort(),
    [
      "$",
      "*",
      ",",
      "-",
      ".",
      ":",
      "=",
      "[",
      "]",
      "^",
      ...(grammar.name === "posix_sed"
        ? ["\\(", "\\)", "\\{", "\\}"]
        : ["(", ")", "+", "?", "{", "|", "}"]),
    ].sort(),
    `${displayPath}: POSIX regular expression punctuation`,
  );
}

for (const grammar of grammars) {
  test(`${grammar.name}: public nodes preserve issue ownership, source children and bracket fields`, () => {
    checkPublicCst(grammar, root);
  });
}

const identifiedIssueLeafCases = [
  {
    name: "special regular expression delimiter escape",
    source: "s.\\..x.",
    repaired: "s.a.x.",
    damage: [
      {
        byte: 2,
        deleteBytes: 1,
        insert: "\\.",
      },
    ],
    repair: [
      {
        byte: 2,
        deleteBytes: 2,
        insert: "a",
      },
    ],
  },
  {
    name: "replacement ampersand delimiter escape",
    source: "s&a&\\&&",
    repaired: "s&a&a&",
    damage: [
      {
        byte: 4,
        deleteBytes: 1,
        insert: "\\&",
      },
    ],
    repair: [
      {
        byte: 4,
        deleteBytes: 2,
        insert: "a",
      },
    ],
  },
  {
    name: "equivalence class meta characters",
    source: "/[[=-=]][[=]=]]/p\n",
    repaired: "/[[.-.]][[.].]]/p\n",
    damage: [
      {
        byte: 3,
        deleteBytes: 1,
        insert: "=",
      },
      {
        byte: 5,
        deleteBytes: 1,
        insert: "=",
      },
      {
        byte: 10,
        deleteBytes: 1,
        insert: "=",
      },
      {
        byte: 12,
        deleteBytes: 1,
        insert: "=",
      },
    ],
    repair: [
      {
        byte: 3,
        deleteBytes: 1,
        insert: ".",
      },
      {
        byte: 5,
        deleteBytes: 1,
        insert: ".",
      },
      {
        byte: 10,
        deleteBytes: 1,
        insert: ".",
      },
      {
        byte: 12,
        deleteBytes: 1,
        insert: ".",
      },
    ],
  },
  {
    name: "shared range endpoint operator",
    source: "/[a-b-c]/p\n",
    repaired: "/[a-bc]/p\n",
    damage: [
      {
        byte: 5,
        deleteBytes: 0,
        insert: "-",
      },
    ],
    repair: [
      {
        byte: 5,
        deleteBytes: 1,
        insert: "",
      },
    ],
  },
];

for (const grammar of grammars) {
  for (const testCase of identifiedIssueLeafCases) {
    test(`${grammar.name}: ${testCase.name} converges after damage and repair`, () => {
      const original = parseSuccessfully(grammar.scope, testCase.source);
      assertIncrementalContract(
        original,
        parse(grammar.scope, testCase.repaired, testCase.damage),
        testCase.name,
      );
      const repaired = parseSuccessfully(grammar.scope, testCase.repaired);
      assertNoNodes(repaired.nodes, "syntax_issue", "ERROR", "MISSING");
      assertIncrementalContract(
        repaired,
        parse(grammar.scope, testCase.source, testCase.repair),
        testCase.name,
      );
    });
  }
}

const invalidCharacterCases = [
  {
    name: "function at source end",
    source: "\0",
    issues: [["unknown_function", "[0, 0] - [0, 1]"]],
    encodingIssues: [["invalid_encoding", "[0, 0] - [0, 1]"]],
  },
  {
    name: "function between complete commands",
    source: "p\n\0\nq\n",
    issues: [["unknown_function", "[1, 0] - [1, 1]"]],
    encodingIssues: [["invalid_encoding", "[1, 0] - [1, 1]"]],
  },
  {
    name: "trailing command text",
    source: "pX\0q\0\n",
    issues: [["unexpected_command_text", "[0, 1] - [0, 5]"]],
    encodingIssues: [
      ["unexpected_command_text", "[0, 1] - [0, 5]"],
      ["invalid_encoding", "[0, 2] - [0, 3]"],
      ["invalid_encoding", "[0, 4] - [0, 5]"],
    ],
    nulIssues: [
      ["unexpected_command_text", "[0, 1] - [0, 5]"],
      ["nul_character", "[0, 2] - [0, 3]"],
      ["nul_character", "[0, 4] - [0, 5]"],
    ],
  },
  {
    name: "command text after block trailing blanks",
    source: "{p;} \0\n",
    issues: [
      ["unexpected_command_text", "[0, 5] - [0, 6]"],
      ["nul_character", "[0, 5] - [0, 6]"],
    ],
    encodingIssues: [["invalid_encoding", "[0, 5] - [0, 6]"]],
  },
  {
    name: "block command text before a blank",
    source: "{p;}\0 ;q\n",
    issues: [
      ["unexpected_command_text", "[0, 4] - [0, 6]"],
      ["nul_character", "[0, 4] - [0, 5]"],
    ],
    encodingIssues: [
      ["invalid_encoding", "[0, 4] - [0, 5]"],
      ["unexpected_command_text", "[0, 5] - [0, 6]"],
    ],
  },
  ...["s", "y"].map((verb) => ({
    name: `${verb} opening delimiter`,
    encodingIssues: [
      ["invalid_encoding", "[0, 1] - [0, 2]"],
      ["unexpected_command_text", "[0, 2] - [0, 3]"],
    ],
    source: `${verb}\0p\n`,
    issues: [
      ["invalid_delimiter", "[0, 1] - [0, 2]"],
      ["unexpected_command_text", "[0, 2] - [0, 3]"],
    ],
  })),
  {
    name: "context address opening delimiter",
    source: "\\\0p\n",
    issues: [["invalid_delimiter", "[0, 1] - [0, 2]"]],
    encodingIssues: [["invalid_encoding", "[0, 1] - [0, 2]"]],
  },
  {
    name: "function character repeated before command text",
    source: "\0\0z\n",
    issues: [
      ["unknown_function", "[0, 0] - [0, 1]"],
      ["unexpected_command_text", "[0, 1] - [0, 3]"],
      ["nul_character", "[0, 1] - [0, 2]"],
    ],
    encodingIssues: [
      ["invalid_encoding", "[0, 0] - [0, 2]"],
      ["unexpected_command_text", "[0, 2] - [0, 3]"],
    ],
  },
  ...["s", "y"].map((verb) => ({
    name: `${verb} opening delimiter character repeated before command text`,
    source: `${verb}\0\0p\n`,
    issues: [
      ["invalid_delimiter", "[0, 1] - [0, 2]"],
      ["unexpected_command_text", "[0, 2] - [0, 4]"],
      ["nul_character", "[0, 2] - [0, 3]"],
    ],
    encodingIssues: [
      ["invalid_encoding", "[0, 1] - [0, 3]"],
      ["unexpected_command_text", "[0, 3] - [0, 4]"],
    ],
  })),
  {
    name: "context address opening delimiter character repeated before a function",
    source: "\\\0\0p\n",
    issues: [
      ["invalid_delimiter", "[0, 1] - [0, 2]"],
      ["unknown_function", "[0, 2] - [0, 3]"],
      ["unexpected_command_text", "[0, 3] - [0, 4]"],
    ],
    encodingIssues: [["invalid_encoding", "[0, 1] - [0, 3]"]],
  },
];

for (const grammar of grammars) {
  for (const [name, character] of [
    ["NUL", "\0"],
    ["decode error", "\xff"],
  ]) {
    for (const testCase of invalidCharacterCases) {
      test(`${grammar.name}: ${name}: ${testCase.name}`, () => {
        const source = Buffer.from(
          testCase.source.replaceAll("\0", character),
          "latin1",
        );
        const fresh = parseSuccessfully(grammar.scope, source);
        assert.deepEqual(
          issueSignatures(fresh.nodes),
          (character === "\0"
            ? (testCase.nulIssues ?? testCase.issues)
            : testCase.encodingIssues
          ).map(([reason, range]) => ({
            outcome:
              reason === "invalid_encoding"
                ? "invalid_syntax"
                : "nonconforming_syntax",
            reason,
            range,
          })),
          fresh.stdout,
        );
        assertNoNodes(fresh.nodes, "ERROR", "MISSING");
        const incremental = parse(
          grammar.scope,
          Buffer.concat([Buffer.from("p\n"), source]),
          [{ byte: 0, deleteBytes: 2, insert: "" }],
        );
        assertIncrementalContract(
          fresh,
          incremental,
          `${name}: ${testCase.name}`,
        );
      });
    }
  }
}

const nulPayloadCases = [
  {
    name: "leading replacement NUL",
    source: "s/a/\u0000bc/\nq\n",
  },
  {
    name: "consecutive replacement NULs between literals",
    source: "s/a/a\u0000\u0000b/\nq\n",
  },
  {
    name: "trailing replacement NUL",
    source: "s/a/ab\u0000/\nq\n",
  },
  {
    name: "leading translation source NUL",
    source: "y/\u0000ab/xy/\nq\n",
  },
  {
    name: "trailing translation destination NUL",
    source: "y/ab/xy\u0000/\nq\n",
  },
  {
    name: "NUL as the only text character",
    source: "a\\\n\u0000\nq\n",
  },
  {
    name: "NULs on both sides of a continued text line",
    source: "a\\\n\u0000a\\\nb\u0000\nq\n",
  },
  {
    name: "label definition keeps one owner around NUL",
    source: ":a\u0000b\nq\n",
  },
  {
    name: "branch label begins with NUL",
    source: "b \u0000ab\nq\n",
  },
  {
    name: "test label ends with NUL",
    source: "t ab\u0000\nq\n",
  },
  {
    name: "read file keeps whitespace and semicolon after NUL",
    source: "r \u0000 a;\u0000\nq\n",
  },
  {
    name: "write file keeps its semicolon after NUL",
    source: "w a\u0000;b\nq\n",
  },
  {
    name: "substitution write file ends before its semicolon",
    source: "s/a/b/w \u0000 a;q\n",
    separatorRange: "[0, 11] - [0, 12]",
  },
  {
    name: "ordinary comment text splits around NUL",
    source: "#a\u0000b\nq\n",
  },
  {
    name: "default-output directive keeps its NUL-containing tail",
    source: "#n\u0000a\u0000\nq\n",
  },
  {
    name: "replacement escape retains its nested NUL issue",
    source: "s/a/\\\u0000/\nq\n",
    repair: "\\",
  },
  {
    name: "translation escape retains its nested NUL issue",
    source: "y/\\\u0000/x/\nq\n",
    repair: "\\",
  },
  {
    name: "text escape retains its nested NUL issue",
    source: "a\\\n\\\u0000\nq\n",
    repair: "\\",
  },
];

for (const grammar of grammars) {
  test(`${grammar.name}: NUL payload edits preserve owners and following commands`, () => {
    const isolatedQuit = topLevelEditingCommands(
      parseSuccessfully(grammar.scope, "q\n").nodes,
    )[0].nodes;
    for (const testCase of nulPayloadCases) {
      const firstNul = testCase.source.indexOf("\0");
      const history = `${testCase.source.slice(0, firstNul)}x${testCase.source.slice(firstNul)}`;
      const edits = [{ byte: firstNul, deleteBytes: 1, insert: "" }];
      assert.deepEqual(
        applyEdits(history, edits),
        Buffer.from(testCase.source),
      );
      const fresh = parseSuccessfully(grammar.scope, testCase.source);
      const incremental = parseSuccessfully(grammar.scope, history, edits);
      assertIncrementalContract(fresh, incremental, testCase.name);
      const lastCommand = topLevelEditingCommands(fresh.nodes).at(-1);
      assert.ok(lastCommand, testCase.name);
      assert.deepEqual(lastCommand.nodes, isolatedQuit, testCase.name);
      const repair = testCase.repair ?? "a";
      const repaired = testCase.source.replaceAll("\0", repair);
      const repairs = [];
      for (let index = testCase.source.length - 1; index >= 0; index--) {
        if (testCase.source[index] === "\0")
          repairs.push({ byte: index, deleteBytes: 1, insert: repair });
      }
      assert.deepEqual(
        applyEdits(testCase.source, repairs),
        Buffer.from(repaired),
      );
      const repairedFresh = parseSuccessfully(grammar.scope, repaired);
      assertNoNodes(repairedFresh.nodes, "ERROR", "MISSING");
      assert.deepEqual(
        issueSignatures(repairedFresh.nodes),
        testCase.separatorRange === undefined
          ? []
          : [
              {
                outcome: "undefined_syntax",
                reason: "forbidden_command_separator",
                range: testCase.separatorRange,
              },
            ],
      );
      assertIncrementalContract(
        repairedFresh,
        parse(grammar.scope, testCase.source, repairs),
        testCase.name,
      );
    }
  });
}

for (const grammar of grammars) {
  const expressionOwner =
    grammar.name === "posix_sed"
      ? "one_char_or_coll_elem_bre"
      : "one_char_or_coll_elem_ere";
  const duplicationOwner =
    grammar.name === "posix_sed" ? "bre_dupl_symbol" : "ere_dupl_symbol";
  const opening = grammar.name === "posix_sed" ? "\\{" : "{";
  const closing = grammar.name === "posix_sed" ? "\\}" : "}";
  for (const context of [
    { name: "function", prefix: "", suffix: "\np\n", owner: "editing_command" },
    {
      name: "command tail",
      prefix: "p",
      suffix: "\nq\n",
      owner: "editing_command",
    },
    {
      name: "substitution flags",
      prefix: "s/a/b/",
      suffix: "g\n",
      owner: "substitution_flags",
    },
    {
      name: "expression",
      prefix: "/a",
      suffix: "b/p\n",
      owner: expressionOwner,
    },
    {
      name: "escaped expression",
      prefix: "/a\\",
      suffix: "/p\n",
      owner: expressionOwner,
    },
    { name: "range end", prefix: "/[a-", suffix: "]/p\n", owner: "end_range" },
    {
      name: "collating symbol",
      prefix: "/[[.a",
      suffix: "b.]]/p\n",
      owner: "collating_symbol",
    },
    {
      name: "equivalence class",
      prefix: "/[[=a",
      suffix: "b=]]/p\n",
      owner: "equivalence_class",
    },
    {
      name: "character class",
      prefix: "/[[:a",
      suffix: "b:]]/p\n",
      owner: "character_class",
    },
    {
      name: "replacement",
      prefix: "s/a/b",
      suffix: "c/\n",
      owner: "replacement",
    },
    {
      name: "escaped replacement",
      prefix: "s/a/\\",
      suffix: "/\n",
      owner: "replacement",
    },
    {
      name: "translation",
      prefix: "y/a",
      suffix: "b/xy/\n",
      owner: "translation_string",
    },
    {
      name: "escaped translation",
      prefix: "y/\\",
      suffix: "/a/\n",
      owner: "translation_string",
    },
    { name: "label", prefix: ":ab", suffix: "cd\n", owner: "label" },
    { name: "read file", prefix: "r ab", suffix: "cd\n", owner: "rfile" },
    { name: "write file", prefix: "w ab", suffix: "cd\n", owner: "wfile" },
    {
      name: "substitution write file",
      prefix: "s/a/b/w ab",
      suffix: "cd\n",
      owner: "wfile",
    },
    { name: "comment", prefix: "# ab", suffix: "cd\n", owner: "comment" },
    { name: "text", prefix: "a\\\nab", suffix: "cd\n", owner: "text" },
    {
      name: "before minimum",
      prefix: `/a${opening}`,
      suffix: `1${closing}/p\n`,
      owner: duplicationOwner,
      counts: [["minimum", "1"]],
    },
    {
      name: "within minimum",
      prefix: `/a${opening}1`,
      suffix: `2${closing}/p\n`,
      owner: duplicationOwner,
      counts: [
        ["minimum", "1"],
        ["minimum", "2"],
      ],
    },
    {
      name: "after minimum",
      prefix: `/a${opening}1`,
      suffix: `${closing}/p\n`,
      owner: duplicationOwner,
      counts: [["minimum", "1"]],
    },
    {
      name: "before maximum",
      prefix: `/a${opening}1,`,
      suffix: `2${closing}/p\n`,
      owner: duplicationOwner,
      counts: [
        ["minimum", "1"],
        ["maximum", "2"],
      ],
    },
    {
      name: "within maximum",
      prefix: `/a${opening}1,2`,
      suffix: `3${closing}/p\n`,
      owner: duplicationOwner,
      counts: [
        ["minimum", "1"],
        ["maximum", "2"],
        ["maximum", "3"],
      ],
    },
    {
      name: "after maximum",
      prefix: `/a${opening}1,2`,
      suffix: `${closing}/p\n`,
      owner: duplicationOwner,
      counts: [
        ["minimum", "1"],
        ["maximum", "2"],
      ],
    },
    {
      name: "truncated sequence at EOF",
      prefix: "# ",
      suffix: "",
      owner: "comment",
      bytes: [0xf0, 0x9f, 0x98],
    },
  ]) {
    test(`${grammar.name}: decoding failure stays in ${context.name}`, () => {
      const prefix = Buffer.from(context.prefix);
      const bytes = Buffer.from(context.bytes ?? [0xff, 0x80, 0xfe]);
      const source = Buffer.concat([
        prefix,
        bytes,
        Buffer.from(context.suffix),
      ]);
      const result = parseSuccessfully(grammar.scope, source);
      assert.deepEqual(issuePaths(result.nodes), [
        "invalid_syntax/invalid_encoding",
      ]);
      const issue = result.nodes.find(({ kind }) => kind === "syntax_issue");
      assert.ok(issue);
      assert.deepEqual(
        [issue.startByte, issue.endByte],
        [prefix.length, prefix.length + bytes.length],
      );
      assert.equal(result.nodes[issue.parent].kind, context.owner);
      assertNoNodes(result.nodes, "ERROR", "MISSING");
      if (context.counts !== undefined) {
        assert.deepEqual(
          result.nodes
            .filter(({ kind }) => kind === "duplication_count")
            .map(({ field, startByte, endByte }) => [
              field,
              source.subarray(startByte, endByte).toString(),
            ]),
          context.counts,
        );
      }
      const history = Buffer.concat([
        prefix,
        Buffer.from("x"),
        bytes,
        Buffer.from(context.suffix),
      ]);
      assertIncrementalContract(
        result,
        parse(grammar.scope, history, [
          { byte: prefix.length, deleteBytes: 1, insert: "" },
        ]),
        context.name,
      );
    });
  }
}

for (const grammar of grammars) {
  test(`${grammar.name}: EOF reclassification follows appended source in fresh and incremental parses`, () => {
    for (const { source, suffix, reason, outcome } of [
      {
        source: "/[[=]",
        suffix: "x=]]/p",
        reason: "invalid_equivalence_class_element",
        outcome: null,
      },
      {
        source: "/[[=-",
        suffix: "x=]]/p",
        reason: "invalid_equivalence_class_element",
        outcome: null,
      },
      {
        source: "/[[=-=",
        suffix: "x=]]/p",
        reason: "invalid_equivalence_class_element",
        outcome: null,
      },
      {
        source: "/[[=-",
        suffix: "=]]/p",
        reason: "invalid_equivalence_class_element",
        outcome: "undefined_syntax",
      },
      {
        source: "/[[=]",
        suffix: "\n",
        reason: "invalid_equivalence_class_element",
        outcome: "undefined_syntax",
      },
      {
        source: "p ",
        suffix: "}",
        reason: "unexpected_command_text",
        outcome: null,
      },
      {
        source: "p \t",
        suffix: "\n",
        reason: "unexpected_command_text",
        outcome: "nonconforming_syntax",
      },
      {
        source: "p ",
        suffix: "x",
        reason: "unexpected_command_text",
        outcome: "nonconforming_syntax",
      },
      {
        source: "s/a/b/wp",
        suffix: " file",
        reason: "omitted_file_separator",
        outcome: null,
      },
      {
        source: "s/a/b/wp",
        suffix: "\n",
        reason: "omitted_file_separator",
        outcome: "nonconforming_syntax",
      },
      ...(grammar.name === "posix_sed"
        ? [
            {
              source: "s1a\\{\\",
              suffix: "1\\}1b1",
              reason: "missing_interval_minimum",
              outcome: null,
            },
            {
              source: "s1a\\{\\",
              suffix: "\n",
              reason: "missing_interval_minimum",
              outcome: "undefined_syntax",
            },
          ]
        : []),
    ]) {
      const original = parseSuccessfully(grammar.scope, source);
      assert.deepEqual(
        issueSignatures(original.nodes)
          .filter((issue) => issue.reason === reason)
          .map((issue) => issue.outcome),
        ["incomplete_syntax"],
        source,
      );
      const completed = parseSuccessfully(grammar.scope, source + suffix);
      assert.deepEqual(
        issueSignatures(completed.nodes)
          .filter((issue) => issue.reason === reason)
          .map((issue) => issue.outcome),
        outcome === null ? [] : [outcome],
        source + suffix,
      );
      assertIncrementalContract(
        completed,
        parseSuccessfully(grammar.scope, source, [
          { byte: source.length, deleteBytes: 0, insert: suffix },
        ]),
        source + suffix,
      );
      assertIncrementalContract(
        original,
        parseSuccessfully(grammar.scope, source + suffix, [
          { byte: source.length, deleteBytes: suffix.length, insert: "" },
        ]),
        source,
      );
    }
    for (const { source, edit, expected } of [
      {
        source: "s/a/b/w file;",
        edit: { byte: 13, deleteBytes: 0, insert: "p" },
        expected: "s/a/b/w file;p",
      },
      {
        source: "s/a/b/w file;p",
        edit: { byte: 13, deleteBytes: 1, insert: "" },
        expected: "s/a/b/w file;",
      },
      {
        source: "s/a/b/w file;}",
        edit: { byte: 14, deleteBytes: 0, insert: "p" },
        expected: "s/a/b/w file;}p",
      },
      {
        source: "s/a/b/w file;}p",
        edit: { byte: 14, deleteBytes: 1, insert: "" },
        expected: "s/a/b/w file;}",
      },
      {
        source: "s/a/b/w file;};p",
        edit: { byte: 0, deleteBytes: 0, insert: "{" },
        expected: "{s/a/b/w file;};p",
      },
      {
        source: "{s/a/b/w file;};p",
        edit: { byte: 0, deleteBytes: 1, insert: "" },
        expected: "s/a/b/w file;};p",
      },
      {
        source: "s/a/b/2g",
        edit: { byte: 6, deleteBytes: 1, insert: "" },
        expected: "s/a/b/g",
      },
      {
        source: "s/a/b/g",
        edit: { byte: 6, deleteBytes: 0, insert: "2" },
        expected: "s/a/b/2g",
      },
      {
        source: "s/a/b/2wg file",
        edit: { byte: 6, deleteBytes: 1, insert: "" },
        expected: "s/a/b/wg file",
      },
    ]) {
      assert.deepEqual(applyEdits(source, [edit]), Buffer.from(expected));
      assertIncrementalContract(
        parseSuccessfully(grammar.scope, expected),
        parseSuccessfully(grammar.scope, source, [edit]),
        expected,
      );
    }
  });
}

for (const grammar of grammars) {
  test(`${grammar.name}: CST reader retains Unicode line separators in ordinary and issue leaves`, () => {
    const cases = [
      {
        source: "/\u2028/p\n",
        kind: "ordinary_character",
        byte: 1,
        character: "\u2028",
      },
      {
        source: "/\u2029/p\n",
        kind: "ordinary_character",
        byte: 1,
        character: "\u2029",
      },
      {
        source:
          grammar.name === "posix_sed" ? "/a\\{\u2028/p\n" : "/a{\u2028/p\n",
        kind: "invalid_interval_character",
        byte: grammar.name === "posix_sed" ? 4 : 3,
        character: "\u2028",
      },
      {
        source:
          grammar.name === "posix_sed" ? "/a\\{\u2029/p\n" : "/a{\u2029/p\n",
        kind: "invalid_interval_character",
        byte: grammar.name === "posix_sed" ? 4 : 3,
        character: "\u2029",
      },
    ];
    for (const { source, kind, byte, character } of cases) {
      const fresh = parseSuccessfully(grammar.scope, source);
      const characterBytes = Buffer.byteLength(character);
      const range = `[0, ${byte}] - [0, ${byte + characterBytes}]`;
      assert.deepEqual(
        fresh.nodes.filter((node) => node.kind === kind).map(nodeRange),
        [range],
        JSON.stringify(source),
      );
      assert.deepEqual(
        issueSignatures(fresh.nodes),
        kind === "ordinary_character"
          ? []
          : [
              { outcome: "undefined_syntax", reason: kind, range },
              {
                outcome: "undefined_syntax",
                reason: "missing_interval_close",
                range: `[0, ${byte + characterBytes}] - [0, ${byte + characterBytes}]`,
              },
            ],
      );
      const incremental = parse(grammar.scope, source, [
        { byte, deleteBytes: characterBytes, insert: "" },
        { byte, deleteBytes: 0, insert: character },
      ]);
      assertIncrementalContract(fresh, incremental, JSON.stringify(source));
    }
  });
}

for (const grammar of grammars) {
  test(`${grammar.name}: large tokens, command lists and nested blocks parse through EOF`, () => {
    for (const [name, source] of [
      ["long replacement", `s/a/${"x".repeat(largeReplacementCharacters)}/\n`],
      ["wide command list", "p;".repeat(largeCommandCount)],
      [
        "deep blocks",
        `${"{".repeat(nestedBlockDepth)}p;${"}".repeat(nestedBlockDepth)}\n`,
      ],
    ]) {
      assert.equal(parseSummary(grammar.scope, source).successful, true, name);
    }
  });
}

for (const grammar of grammars) {
  test(`${grammar.name}: wide and tall command lists print their CST within the time limit`, () => {
    for (const [name, source] of [
      ["wide command list", "p;".repeat(printedCommandCount)],
      ["tall command list", "p\n".repeat(printedCommandCount)],
    ]) {
      parseCstWithin(grammar.scope, source, cstPrintTimeoutMs, name);
    }
  });
}

for (const grammar of grammars) {
  test(`${grammar.name}: a parser timeout cannot pass as complete recovery`, () => {
    assert.throws(() =>
      parseSummary(
        grammar.scope,
        "p;".repeat(largeCommandCount),
        immediateParserTimeoutMicros,
      ),
    );
  });
}

for (const grammar of grammars) {
  test(`${grammar.name}: every byte inside a Unicode payload can be deleted and repaired through an edit history`, () => {
    const unicodePayload = "é😀";
    const payloadBytes = Buffer.byteLength(unicodePayload);
    const brokenPayloads = [
      {
        bytes: [0xa9, 0xf0, 0x9f, 0x98, 0x80],
        invalid: [0, 1],
        decoded: [1, 5],
      },
      {
        bytes: [0xc3, 0xf0, 0x9f, 0x98, 0x80],
        invalid: [0, 1],
        decoded: [1, 5],
      },
      {
        bytes: [0xc3, 0xa9, 0x9f, 0x98, 0x80],
        invalid: [2, 5],
        decoded: [0, 2],
      },
      {
        bytes: [0xc3, 0xa9, 0xf0, 0x98, 0x80],
        invalid: [2, 5],
        decoded: [0, 2],
      },
      {
        bytes: [0xc3, 0xa9, 0xf0, 0x9f, 0x80],
        invalid: [2, 5],
        decoded: [0, 2],
      },
      {
        bytes: [0xc3, 0xa9, 0xf0, 0x9f, 0x98],
        invalid: [2, 5],
        decoded: [0, 2],
      },
    ];
    for (const { source, changed, payloadByte, owner, literal, suffix } of [
      {
        source: "s/a/é😀/p\np\n",
        changed: "s/a/x/p\np\n",
        payloadByte: 4,
        owner: "replacement",
        literal: "replacement_literal",
        suffix: "/p\np\n",
      },
      {
        source: ":é😀\np\n",
        changed: ":x\np\n",
        payloadByte: 1,
        owner: "label",
        literal: "label_literal",
        suffix: "\np\n",
      },
      {
        source: "b é😀\np\n",
        changed: "b x\np\n",
        payloadByte: 2,
        owner: "label",
        literal: "label_literal",
        suffix: "\np\n",
      },
      {
        source: "t é😀\np\n",
        changed: "t x\np\n",
        payloadByte: 2,
        owner: "label",
        literal: "label_literal",
        suffix: "\np\n",
      },
      {
        source: "r é😀\np\n",
        changed: "r x\np\n",
        payloadByte: 2,
        owner: "rfile",
        literal: "file_literal",
        suffix: "\np\n",
      },
      {
        source: "w é😀\np\n",
        changed: "w x\np\n",
        payloadByte: 2,
        owner: "wfile",
        literal: "file_literal",
        suffix: "\np\n",
      },
      {
        source: "s/a/b/w é😀\np\n",
        changed: "s/a/b/w x\np\n",
        payloadByte: 8,
        owner: "wfile",
        literal: "file_literal",
        suffix: "\np\n",
      },
    ]) {
      const prefix = Buffer.from(source).subarray(0, payloadByte);
      for (const [
        removedByte,
        { bytes, invalid, decoded },
      ] of brokenPayloads.entries()) {
        const edits = [
          { byte: payloadByte + removedByte, deleteBytes: 1, insert: "" },
          {
            byte: payloadByte,
            deleteBytes: bytes.length,
            insert: unicodePayload,
          },
          { byte: payloadByte, deleteBytes: payloadBytes, insert: "x" },
          { byte: payloadByte, deleteBytes: 1, insert: unicodePayload },
        ];
        const expected = [
          Buffer.concat([
            Buffer.from(prefix),
            Buffer.from(bytes),
            Buffer.from(suffix),
          ]),
          Buffer.from(source),
          Buffer.from(changed),
          Buffer.from(source),
        ];
        for (const [step, expectedSource] of expected.entries()) {
          const history = edits.slice(0, step + 1);
          const label = `${JSON.stringify(source)}: UTF-8 byte ${removedByte}, edit ${step + 1}`;
          assert.deepEqual(applyEdits(source, history), expectedSource, label);
          const fresh = parse(grammar.scope, expectedSource);
          const incremental = parse(grammar.scope, source, history);
          assertIncrementalContract(fresh, incremental, label);
          for (const result of [fresh, incremental]) {
            const issues = issueSignatures(result.nodes);
            if (step === 0) {
              const expectedIssues = [
                {
                  outcome: "invalid_syntax",
                  reason: "invalid_encoding",
                  range: invalid,
                },
                ...(owner === "label"
                  ? [
                      {
                        outcome: "unspecified_syntax",
                        reason: "nonportable_label_character",
                        range: decoded,
                      },
                    ]
                  : []),
              ].sort((left, right) => left.range[0] - right.range[0]);
              assert.deepEqual(
                issues,
                expectedIssues.map(
                  ({ outcome, reason, range: [start, end] }) => ({
                    outcome,
                    reason,
                    range: `[0, ${payloadByte + start}] - [0, ${payloadByte + end}]`,
                  }),
                ),
                label,
              );
              continue;
            }
            assert.equal(result.status, 0, label);
            assertNoNodes(result.nodes, "ERROR", "MISSING");
            const end = payloadByte + (step === 2 ? 1 : payloadBytes);
            assert.deepEqual(
              issues,
              owner === "label" && step !== 2
                ? [
                    {
                      outcome: "unspecified_syntax",
                      reason: "nonportable_label_character",
                      range: `[0, ${payloadByte}] - [0, ${end}]`,
                    },
                  ]
                : [],
              label,
            );
            assert.deepEqual(
              syntaxSignatures(result.nodes, [owner, literal]),
              [
                `${owner}: ${owner} [0, ${payloadByte}] - [0, ${end}]`,
                `  ${literal} [0, ${payloadByte}] - [0, ${end}]`,
              ],
              label,
            );
          }
        }
      }
    }
  });
}

for (const grammar of grammars) {
  for (const [name, prefix, suffix] of [
    ["function", "", "\np\n"],
    ["command tail", "p", "\nq\n"],
    ["comment", "# a", "b\n"],
    ["expression", "/a", "b/p\n"],
    ["replacement", "s/a/", "/\n"],
    ["translation", "y/a", "/b/\n"],
    ["label", ":a", "b\n"],
    ["file", "r a", "b\n"],
    ["character class", "/[[:a", "b:]]/p\n"],
  ]) {
    test(`${grammar.name}: decoding runs merge after edits to the following character in ${name}`, () => {
      const offset = Buffer.byteLength(prefix);
      for (const character of ["é", "😀"]) {
        const source = Buffer.concat([
          Buffer.from(prefix),
          Buffer.from([0xff]),
          Buffer.from(character + suffix),
        ]);
        for (let index = 0; index < Buffer.byteLength(character); index++) {
          const edits = [
            { byte: offset + 1 + index, deleteBytes: 1, insert: "" },
          ];
          const fresh = parseSuccessfully(
            grammar.scope,
            applyEdits(source, edits),
          );
          assert.deepEqual(
            issueSignatures(fresh.nodes).map(({ outcome, reason }) => [
              outcome,
              reason,
            ]),
            [["invalid_syntax", "invalid_encoding"]],
          );
          const issue = fresh.nodes.find(({ kind }) => kind === "syntax_issue");
          assert.ok(issue);
          assert.deepEqual(
            [issue.startByte, issue.endByte],
            [offset, offset + Buffer.byteLength(character)],
          );
          assertIncrementalContract(
            fresh,
            parse(grammar.scope, source, edits),
            `${name}: ${character} byte ${index}`,
          );
        }
      }
    });
  }

  test(`${grammar.name}: valid characters split decoding runs without merging NUL or replacement characters`, () => {
    const source = Buffer.concat([
      Buffer.from("# \xff\x80\xfe\0", "latin1"),
      Buffer.from("\uFFFD\n"),
    ]);
    const edits = [{ byte: 3, deleteBytes: 0, insert: "x" }];
    const fresh = parseSuccessfully(grammar.scope, applyEdits(source, edits));
    assert.deepEqual(issueSignatures(fresh.nodes), [
      {
        outcome: "invalid_syntax",
        reason: "invalid_encoding",
        range: "[0, 2] - [0, 3]",
      },
      {
        outcome: "invalid_syntax",
        reason: "invalid_encoding",
        range: "[0, 4] - [0, 6]",
      },
      {
        outcome: "nonconforming_syntax",
        reason: "nul_character",
        range: "[0, 6] - [0, 7]",
      },
    ]);
    assertIncrementalContract(
      fresh,
      parse(grammar.scope, source, edits),
      "split decoding run",
    );
    const reverse = [{ byte: 3, deleteBytes: 1, insert: "" }];
    const merged = parseSuccessfully(grammar.scope, source);
    assert.deepEqual(issueSignatures(merged.nodes), [
      {
        outcome: "invalid_syntax",
        reason: "invalid_encoding",
        range: "[0, 2] - [0, 5]",
      },
      {
        outcome: "nonconforming_syntax",
        reason: "nul_character",
        range: "[0, 5] - [0, 6]",
      },
    ]);
    assertIncrementalContract(
      merged,
      parse(grammar.scope, applyEdits(source, edits), reverse),
      "merge decoding run",
    );
  });
}
