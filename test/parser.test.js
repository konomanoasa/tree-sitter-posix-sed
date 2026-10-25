import assert from "node:assert/strict";
import { test } from "node:test";
import { grammars } from "../scripts/tree-sitter.js";
import {
  assertNoNodes,
  directDelimiterLeafLines,
  issuePaths,
  issueSignatures,
  nodeRange,
  publicNodes,
  subtree,
  syntaxSignatures,
} from "./support/cst.js";
import {
  applyEdits,
  assertIncrementalContract,
  parse,
  parseSuccessfully,
} from "./support/parser.js";

const verbOperands = {
  "{": "p;}",
  a: "\\\nx",
  b: "",
  c: "\\\nx",
  d: "",
  D: "",
  g: "",
  G: "",
  h: "",
  H: "",
  i: "\\\nx",
  l: "",
  n: "",
  N: "",
  p: "",
  P: "",
  q: "",
  r: " file",
  s: "/a/b/",
  t: "",
  w: " file",
  x: "",
  y: "/a/b/",
  ":": "x",
  "=": "",
  "#": "c",
};

const addressPrefixes = ["1 ", "1\t", "1!", "1 !", "$ ", "/x/ ", "\\,x, "];

for (const grammar of grammars) {
  test(`${grammar.name}: label portability preserves source leaves and limits length checks to portable characters`, () => {
    for (const { label, issues, pieces } of [
      { label: "Ab0._-xy", issues: [], pieces: [[0, 8]] },
      {
        label: "abcdefghi",
        issues: [
          {
            outcome: "unspecified_syntax",
            reason: "nonportable_label_length",
            start: 0,
            end: 9,
          },
        ],
        pieces: [[0, 9]],
      },
      {
        label: "a@#$b",
        issues: [
          {
            outcome: "unspecified_syntax",
            reason: "nonportable_label_character",
            start: 1,
            end: 4,
          },
        ],
        pieces: [
          [0, 1],
          [1, 4],
          [4, 5],
        ],
      },
      {
        label: "é日本語",
        issues: [
          {
            outcome: "unspecified_syntax",
            reason: "nonportable_label_character",
            start: 0,
            end: 11,
          },
        ],
        pieces: [[0, 11]],
      },
      {
        label: "é\uFFFD \\x;\t}",
        issues: [
          {
            outcome: "unspecified_syntax",
            reason: "nonportable_label_character",
            start: 0,
            end: 7,
          },
          {
            outcome: "unspecified_syntax",
            reason: "nonportable_label_character",
            start: 8,
            end: 11,
          },
        ],
        pieces: [
          [0, 7],
          [7, 8],
          [8, 11],
        ],
      },
      {
        label: "abcdefghi@",
        issues: [
          {
            outcome: "unspecified_syntax",
            reason: "nonportable_label_character",
            start: 9,
            end: 10,
          },
        ],
        pieces: [
          [0, 9],
          [9, 10],
        ],
      },
      {
        label: "abcdefghi\0",
        issues: [
          {
            outcome: "nonconforming_syntax",
            reason: "nul_character",
            start: 9,
            end: 10,
          },
        ],
        pieces: [[0, 9]],
      },
      {
        label: Buffer.from("abcdefghi\xff", "latin1"),
        issues: [
          {
            outcome: "invalid_syntax",
            reason: "invalid_encoding",
            start: 9,
            end: 10,
          },
        ],
        pieces: [[0, 9]],
      },
    ]) {
      for (const prefix of [":", "b ", "t "]) {
        const source = Buffer.concat([Buffer.from(prefix), Buffer.from(label)]);
        const result = parseSuccessfully(grammar.scope, source);
        assert.deepEqual(
          issueSignatures(result.nodes),
          issues.map(({ outcome, reason, start, end }) => ({
            outcome,
            reason,
            range: `[0, ${prefix.length + start}] - [0, ${prefix.length + end}]`,
          })),
          source.toString("hex"),
        );
        assert.deepEqual(
          result.nodes
            .filter(({ kind }) => kind === "label_literal")
            .map(({ startByte, endByte }) => [
              startByte - prefix.length,
              endByte - prefix.length,
            ]),
          pieces,
          source.toString("hex"),
        );
        for (const [index, node] of result.nodes.entries()) {
          if (!node.kind.startsWith("nonportable_label_")) continue;
          assert.deepEqual(
            result.nodes
              .filter(({ parent }) => parent === index)
              .map(({ kind, startByte, endByte }) => [
                kind,
                startByte,
                endByte,
              ]),
            [["label_literal", node.startByte, node.endByte]],
            source.toString("hex"),
          );
        }
      }
    }
  });

  test(`${grammar.name}: label length and character classification follow edits to the whole operand`, () => {
    for (const { source, edit, expected } of [
      {
        source: ":abcdefgh",
        edit: { byte: 9, deleteBytes: 0, insert: "i" },
        expected: ":abcdefghi",
      },
      {
        source: ":abcdefghi",
        edit: { byte: 9, deleteBytes: 1, insert: "" },
        expected: ":abcdefgh",
      },
      {
        source: ":abcdefghi",
        edit: { byte: 10, deleteBytes: 0, insert: "@" },
        expected: ":abcdefghi@",
      },
      {
        source: ":abcdefghi@",
        edit: { byte: 10, deleteBytes: 1, insert: "" },
        expected: ":abcdefghi",
      },
      {
        source: ":abcdefghi",
        edit: { byte: 5, deleteBytes: 1, insert: "é" },
        expected: ":abcdéfghi",
      },
      {
        source: ":abcdéfghi",
        edit: { byte: 5, deleteBytes: 2, insert: "e" },
        expected: ":abcdefghi",
      },
      {
        source: "b abcdefghi\np",
        edit: { byte: 11, deleteBytes: 0, insert: "@" },
        expected: "b abcdefghi@\np",
      },
      {
        source: "t abcdefghi@\np",
        edit: { byte: 11, deleteBytes: 1, insert: "" },
        expected: "t abcdefghi\np",
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

  test(`${grammar.name}: delimiter escapes keep interval roles and source leaves`, () => {
    const [opening, closing] =
      grammar.name === "posix_sed" ? ["\\{", "\\}"] : ["{", "}"];
    const cases = [
      {
        delimiter: ",",
        body: "1\\,2",
        pieces: [
          ["minimum", "duplication_count", 0, 1],
          [null, "escaped_delimiter", 1, 3],
          ["maximum", "duplication_count", 3, 4],
        ],
        issues: [],
      },
      {
        delimiter: "1",
        body: "\\12,2\\1",
        pieces: [
          ["minimum", "escaped_delimiter", 0, 2],
          ["minimum", "duplication_count", 2, 3],
          ["maximum", "duplication_count", 4, 5],
          ["maximum", "escaped_delimiter", 5, 7],
        ],
        issues: [],
      },
      {
        delimiter: ",",
        body: "1\\,2\\,3",
        pieces: [
          ["minimum", "duplication_count", 0, 1],
          [null, "escaped_delimiter", 1, 3],
          ["maximum", "duplication_count", 3, 4],
          [null, "escaped_delimiter", 4, 6],
          ["maximum", "duplication_count", 6, 7],
        ],
        issues: [
          { reason: "unexpected_interval_separator", first: 4, last: 6 },
        ],
      },
      {
        delimiter: ",",
        body: "\\,2",
        pieces: [
          [null, "escaped_delimiter", 0, 2],
          ["maximum", "duplication_count", 2, 3],
        ],
        issues: [{ reason: "missing_interval_minimum", first: 0, last: 0 }],
      },
    ];
    for (const { delimiter, body, pieces, issues } of cases) {
      const source = `s${delimiter}a${opening}${body}${closing}${delimiter}b${delimiter}`;
      const start = 3 + opening.length;
      const fresh = parseSuccessfully(grammar.scope, source);
      assert.deepEqual(
        issueSignatures(fresh.nodes),
        issues.map(({ reason, first, last }) => ({
          outcome: "undefined_syntax",
          reason,
          range: `[0, ${start + first}] - [0, ${start + last}]`,
        })),
        source,
      );
      assert.deepEqual(
        fresh.nodes
          .filter(({ kind }) =>
            ["duplication_count", "escaped_delimiter"].includes(kind),
          )
          .map(({ field, kind, startByte, endByte }) => [
            field,
            kind,
            startByte - start,
            endByte - start,
          ]),
        pieces,
        source,
      );
      const escapeStart = source.indexOf(`\\${delimiter}`);
      const edits = [
        { byte: escapeStart + 1, deleteBytes: 1, insert: "x" },
        { byte: escapeStart + 1, deleteBytes: 1, insert: delimiter },
      ];
      assertIncrementalContract(
        fresh,
        parseSuccessfully(grammar.scope, source, edits),
        source,
      );
    }
  });

  test(`${grammar.name}: substitution flag issues converge after removing a preceding command`, () => {
    for (const source of [
      "s/a/b/2g",
      "s/a/b/g2",
      "s/a/b/gip2",
      "s/a/b/wg file",
      "s/a/b/wwg file",
      "s/a/b/2wg file",
      "s/a/b/gw2 file",
      "s/a/b/w2g file",
      "s/a/b/2gg3",
      "s/a/b/gipw file",
      "s/a/b/w g2",
      "s/a/b/2ip",
      "s/a/b/gg",
    ]) {
      assertIncrementalContract(
        parseSuccessfully(grammar.scope, source),
        parseSuccessfully(grammar.scope, `p\n${source}`, [
          { byte: 0, deleteBytes: 2, insert: "" },
        ]),
        source,
      );
    }
  });
}

test("posix_sed_ere: a trailing interval escape waits only for a usable delimiter at EOF", () => {
  for (const { source, suffix, range } of [
    { source: "s1a{\\", suffix: "1}1b1", range: "[0, 4] - [0, 5]" },
    { source: "s,a{1\\", suffix: ",2},b,", range: "[0, 5] - [0, 6]" },
    { source: "s2a{1,\\", suffix: "2}2b2", range: "[0, 6] - [0, 7]" },
  ]) {
    const original = parseSuccessfully("source.posix_sed.ere", source);
    const interval = original.nodes.findIndex(
      ({ kind }) => kind === "ere_dupl_symbol",
    );
    assert.notEqual(interval, -1, source);
    assert.deepEqual(
      issueSignatures(original.nodes, interval),
      [
        {
          outcome: "incomplete_syntax",
          reason: "incomplete_regular_expression_escape",
          range,
        },
        {
          outcome: "incomplete_syntax",
          reason: "missing_interval_close",
          range: `[0, ${source.length}] - [0, ${source.length}]`,
        },
      ],
      source,
    );
    const completed = parseSuccessfully(
      "source.posix_sed.ere",
      source + suffix,
    );
    assert.deepEqual(issueSignatures(completed.nodes), [], source + suffix);
    assertIncrementalContract(
      completed,
      parseSuccessfully("source.posix_sed.ere", source, [
        { byte: source.length, deleteBytes: 0, insert: suffix },
      ]),
      source + suffix,
    );
    assertIncrementalContract(
      original,
      parseSuccessfully("source.posix_sed.ere", source + suffix, [
        { byte: source.length, deleteBytes: suffix.length, insert: "" },
      ]),
      source,
    );
    const terminated = parseSuccessfully("source.posix_sed.ere", `${source}\n`);
    assert.deepEqual(
      issueSignatures(terminated.nodes).filter(({ reason }) =>
        [
          "incomplete_regular_expression_escape",
          "invalid_interval_character",
        ].includes(reason),
      ),
      [
        {
          outcome: "undefined_syntax",
          reason: "invalid_interval_character",
          range,
        },
      ],
      source,
    );
    assertIncrementalContract(
      terminated,
      parseSuccessfully("source.posix_sed.ere", source, [
        { byte: source.length, deleteBytes: 0, insert: "\n" },
      ]),
      source,
    );
  }
});

for (const grammar of grammars) {
  test(`${grammar.name}: replacing an interval count preserves its resulting public CST`, () => {
    const [opening, closing] =
      grammar.name === "posix_sed" ? ["\\{", "\\}"] : ["{", "}"];
    const start = 3 + opening.length;
    for (const body of [
      "",
      "\\,",
      "q\\zq",
      ",2",
      "q,2",
      "1qq2,3zz4",
      "1,2,,3",
    ]) {
      const source = `s/a${opening}${body}${closing}/x/`;
      assertIncrementalContract(
        parseSuccessfully(grammar.scope, source),
        parse(grammar.scope, `s/a${opening}1${closing}/x/`, [
          { byte: start, deleteBytes: 1, insert: body },
        ]),
        source,
      );
    }
  });

  test(`${grammar.name}: empty compound terms report payload and closing separately`, () => {
    for (const marker of [":", ".", "="]) {
      for (const { suffix, faults } of [
        {
          suffix: `${marker}]]/x/`,
          faults: [["undefined_syntax", "missing_bracket_term_payload"]],
        },
        {
          suffix: "",
          faults: [
            ["incomplete_syntax", "missing_bracket_term_payload"],
            ["incomplete_syntax", "missing_bracket_term_close"],
            ["incomplete_syntax", "unclosed_bracket_expression"],
            ["incomplete_syntax", "unterminated_regular_expression"],
          ],
        },
        {
          suffix: "\n",
          faults: [
            ["undefined_syntax", "missing_bracket_term_payload"],
            ["undefined_syntax", "missing_bracket_term_close"],
            ["undefined_syntax", "unclosed_bracket_expression"],
            ["nonconforming_syntax", "unterminated_regular_expression"],
          ],
        },
      ]) {
        const source = `s/[[${marker}${suffix}`;
        const result = parseSuccessfully(grammar.scope, source);
        assert.deepEqual(
          issueSignatures(result.nodes),
          faults.map(([outcome, reason]) => ({
            outcome,
            reason,
            range: "[0, 5] - [0, 5]",
          })),
          source,
        );
      }
    }
  });

  test(`${grammar.name}: NUL runs converge after splitting and merging their bytes`, () => {
    for (const source of [
      "s/a/\\\0\0\0/",
      "y/\\\0\0\0/x/",
      "/\\\0\0\0/p",
      "s/a/x/qq\0\0rrp",
    ]) {
      const at = source.indexOf("\0");
      assertIncrementalContract(
        parseSuccessfully(grammar.scope, source),
        parse(grammar.scope, source, [
          { byte: at + 1, deleteBytes: 0, insert: "z" },
          { byte: at + 1, deleteBytes: 1, insert: "" },
        ]),
        source,
      );
    }
  });
}

for (const grammar of grammars) {
  test(`${grammar.name}: block ownership converges after removing and restoring trailing blanks`, () => {
    for (const { source, byte, blanks } of [
      { source: "{p;} \t", byte: 4, blanks: " \t" },
      { source: "{p;}\t \n", byte: 4, blanks: "\t " },
      { source: "{p;} \t;q\n", byte: 4, blanks: " \t" },
      { source: "{{p;}\t ;} \n", byte: 5, blanks: "\t " },
    ]) {
      assertIncrementalContract(
        parseSuccessfully(grammar.scope, source),
        parse(grammar.scope, source, [
          { byte, deleteBytes: blanks.length, insert: "" },
          { byte, deleteBytes: 0, insert: blanks },
        ]),
        source,
      );
    }
  });

  test(`${grammar.name}: replacing a block separator with blanks preserves recovery`, () => {
    const source = "{p;} \tq\n";
    assertIncrementalContract(
      parseSuccessfully(grammar.scope, source),
      parse(grammar.scope, "{p;};q\n", [
        { byte: 4, deleteBytes: 1, insert: " \t" },
      ]),
      source,
    );
  });
}

for (const grammar of grammars) {
  test(`${grammar.name}: inserting blanks before closing braces preserves public ownership`, () => {
    for (const source of [
      "{p; \t}\n",
      "{ \t}\n",
      "{p; \t",
      " \t}p\n",
      "p; \t}\n",
      "p \t}\n",
      "{pq \t}",
      "{p\0 \t}",
      "{pq\0 \t}",
      "{{pq \t};}",
      "pq \t}",
    ]) {
      const byte = source.indexOf(" \t");
      assertIncrementalContract(
        parseSuccessfully(grammar.scope, source),
        parse(grammar.scope, source.replace(" \t", ""), [
          { byte, deleteBytes: 0, insert: " \t" },
        ]),
        source,
      );
    }
  });
}

for (const grammar of grammars) {
  test(`${grammar.name}: closing brace layout follows unexpected text and decoding failures`, () => {
    for (const { bad, reasons } of [
      { bad: Buffer.from("q"), reasons: ["unexpected_command_text"] },
      {
        bad: Buffer.from([0]),
        reasons: ["unexpected_command_text", "nul_character"],
      },
      { bad: Buffer.from([0xff]), reasons: ["invalid_encoding"] },
    ]) {
      for (const blanks of [" ", "\t", " \t "]) {
        const source = Buffer.concat([
          Buffer.from("{p"),
          bad,
          Buffer.from(`${blanks}}`),
        ]);
        const fresh = parseSuccessfully(grammar.scope, source);
        assert.deepEqual(issueSignatures(fresh.nodes), [
          ...reasons.map((reason) => ({
            outcome:
              reason === "invalid_encoding"
                ? "invalid_syntax"
                : "nonconforming_syntax",
            reason,
            range: "[0, 2] - [0, 3]",
          })),
          {
            outcome: "nonconforming_syntax",
            reason: "missing_command_separator",
            range: `[0, ${3 + blanks.length}] - [0, ${3 + blanks.length}]`,
          },
        ]);
        const edits = [
          { byte: 3, deleteBytes: blanks.length, insert: "" },
          { byte: 3, deleteBytes: 0, insert: blanks },
        ];
        assertIncrementalContract(
          fresh,
          parseSuccessfully(grammar.scope, source, edits),
          "restore brace layout after invalid character",
        );
      }
    }
  });
}

for (const grammar of grammars) {
  test(`${grammar.name}: known verbs stay functions after address blanks and negation`, () => {
    for (const [verb, operand] of Object.entries(verbOperands)) {
      for (const prefix of addressPrefixes) {
        const source = `${prefix}${verb}${operand}\n`;
        const result = parseSuccessfully(grammar.scope, source);
        assert.deepEqual(
          issuePaths(result.nodes),
          verb === ":" || verb === "#"
            ? ["nonconforming_syntax/excess_address"]
            : [],
          `${JSON.stringify(source)}\n${result.stdout}`,
        );
        assertNoNodes(result.nodes, "ERROR", "MISSING", "unknown_function");
      }
    }
  });
}

for (const grammar of grammars) {
  const collatingTerms = [
    ["collating_symbol", "."],
    ["equivalence_class", "="],
  ];

  test(`${grammar.name}: bracket term payloads retain closing brackets`, () => {
    for (const [type, marker] of collatingTerms) {
      for (const [name, payload] of [
        ["leading bracket", "]a"],
        ["middle bracket", "a]b"],
        ["trailing bracket", "a]"],
        ["consecutive brackets", "a]]b"],
        ["regular expression delimiter", "a]/b"],
        ["other term closing delimiter", marker === "." ? "a]=]b" : "a].]b"],
      ]) {
        const source = `/[[${marker}${payload}${marker}]]/p\n`;
        const end = 4 + payload.length;
        const label = `${type}: ${name}`;
        const result = parseSuccessfully(grammar.scope, source);
        assertNoNodes(result.nodes, "syntax_issue", "ERROR", "MISSING");
        const owner = result.nodes.findIndex(({ kind }) => kind === type);
        assert.notEqual(owner, -1, label);
        assert.deepEqual(
          syntaxSignatures(result.nodes, undefined, owner),
          [
            `${type} [0, 2] - [0, ${end + 2}]`,
            '  "[" [0, 2] - [0, 3]',
            `  "${marker}" [0, 3] - [0, 4]`,
            `  element: collating_element_multi [0, 4] - [0, ${end}]`,
            `  "${marker}" [0, ${end}] - [0, ${end + 1}]`,
            `  "]" [0, ${end + 1}] - [0, ${end + 2}]`,
          ],
          label,
        );
        assert.deepEqual(
          directDelimiterLeafLines(result.nodes, "bracket_expression"),
          ['0:1 - 0:2 "["', `0:${end + 2} - 0:${end + 3} "]"`],
          label,
        );
        const position = 4 + payload.indexOf("]");
        const withoutBracket =
          source.slice(0, position) + source.slice(position + 1);
        assertIncrementalContract(
          result,
          parse(grammar.scope, withoutBracket, [
            { byte: position, deleteBytes: 0, insert: "]" },
          ]),
          `${label}: insert payload bracket`,
        );
        assertIncrementalContract(
          parseSuccessfully(grammar.scope, withoutBracket),
          parse(grammar.scope, source, [
            { byte: position, deleteBytes: 1, insert: "" },
          ]),
          `${label}: remove payload bracket`,
        );
      }
    }
  });

  test(`${grammar.name}: unterminated collating terms own brackets through the source boundary`, () => {
    for (const [type, marker] of collatingTerms) {
      for (const suffix of ["", "\np\n"]) {
        const source = `/[[${marker}a]b]]/p${suffix}`;
        const label = `${type}: ${suffix === "" ? "EOF" : "physical newline"}`;
        const result = parseSuccessfully(grammar.scope, source);
        const outcome =
          suffix === "" ? "incomplete_syntax" : "undefined_syntax";
        const commandOutcome =
          suffix === "" ? "incomplete_syntax" : "nonconforming_syntax";
        assert.deepEqual(
          issueSignatures(result.nodes),
          [
            {
              outcome,
              reason: "missing_bracket_term_close",
              range: "[0, 11] - [0, 11]",
            },
            {
              outcome,
              reason: "unclosed_bracket_expression",
              range: "[0, 11] - [0, 11]",
            },
            {
              outcome: commandOutcome,
              reason: "unterminated_regular_expression",
              range: "[0, 11] - [0, 11]",
            },
            {
              outcome: commandOutcome,
              reason: "missing_function",
              range: "[0, 11] - [0, 11]",
            },
          ],
          label,
        );
        const owner = result.nodes.findIndex(({ kind }) => kind === type);
        assert.notEqual(owner, -1, label);
        assert.equal(nodeRange(result.nodes[owner]), "[0, 2] - [0, 11]", label);
        assert.deepEqual(
          syntaxSignatures(result.nodes, ["collating_element_multi"]),
          ["element: collating_element_multi [0, 4] - [0, 11]"],
          label,
        );
        assert.deepEqual(
          directDelimiterLeafLines(result.nodes, type),
          ['0:2 - 0:3 "["', `0:3 - 0:4 "${marker}"`],
          label,
        );
        assertNoNodes(result.nodes, '"]"', "ERROR", "MISSING");
        assert.deepEqual(
          syntaxSignatures(result.nodes, ["print_function"]),
          suffix === "" ? [] : ["print_function [1, 0] - [1, 1]"],
          label,
        );
        const repaired = `/[[${marker}a]b${marker}]]/p${suffix}`;
        const fresh = parseSuccessfully(grammar.scope, repaired);
        assertNoNodes(fresh.nodes, "syntax_issue", "ERROR", "MISSING");
        assertIncrementalContract(
          result,
          parse(grammar.scope, repaired, [
            { byte: 7, deleteBytes: 1, insert: "" },
          ]),
          `${label}: remove closing marker`,
        );
        assertIncrementalContract(
          fresh,
          parse(grammar.scope, source, [
            { byte: 7, deleteBytes: 0, insert: marker },
          ]),
          `${label}: restore closing marker`,
        );
      }
    }
  });

  test(`${grammar.name}: bracket payload fragments retain closing brackets across NUL`, () => {
    for (const [type, marker] of collatingTerms) {
      const source = `/[[${marker}a]\0]b${marker}]]/p\n`;
      const result = parseSuccessfully(grammar.scope, source);
      assert.deepEqual(
        issueSignatures(result.nodes),
        [
          {
            outcome: "invalid_syntax",
            reason: "invalid_regular_expression_character",
            range: "[0, 6] - [0, 7]",
          },
        ],
        type,
      );
      const owner = result.nodes.findIndex(({ kind }) => kind === type);
      assert.notEqual(owner, -1, type);
      assert.deepEqual(
        syntaxSignatures(result.nodes, undefined, owner),
        [
          `${type} [0, 2] - [0, 11]`,
          '  "[" [0, 2] - [0, 3]',
          `  "${marker}" [0, 3] - [0, 4]`,
          "  element: collating_element_multi [0, 4] - [0, 6]",
          "  issue: syntax_issue [0, 6] - [0, 7]",
          "    invalid_syntax [0, 6] - [0, 7]",
          "      invalid_regular_expression_character [0, 6] - [0, 7]",
          "  element: collating_element_multi [0, 7] - [0, 9]",
          `  "${marker}" [0, 9] - [0, 10]`,
          '  "]" [0, 10] - [0, 11]',
        ],
        type,
      );
      assertNoNodes(result.nodes, "ERROR", "MISSING");
      const history = `/[[${marker}a]q\0]b${marker}]]/p\n`;
      assertIncrementalContract(
        result,
        parse(grammar.scope, history, [
          { byte: 6, deleteBytes: 1, insert: "" },
        ]),
        `${type}: remove character before NUL`,
      );
      const repaired = `/[[${marker}a]c]b${marker}]]/p\n`;
      const fresh = parseSuccessfully(grammar.scope, repaired);
      assertNoNodes(fresh.nodes, "syntax_issue", "ERROR", "MISSING");
      assert.deepEqual(
        syntaxSignatures(fresh.nodes, ["collating_element_multi"]),
        ["element: collating_element_multi [0, 4] - [0, 9]"],
        type,
      );
      assertIncrementalContract(
        fresh,
        parse(grammar.scope, source, [
          { byte: 6, deleteBytes: 1, insert: "c" },
        ]),
        `${type}: replace NUL with a character`,
      );
    }
  });
}

for (const grammar of grammars) {
  test(`${grammar.name}: partial commands retain prefixes without invented functions`, () => {
    for (const { source, outcome, position } of [
      {
        source: "1",
        outcome: "incomplete_syntax/missing_function",
        position: 1,
      },
      {
        source: "1\n",
        outcome: "nonconforming_syntax/missing_function",
        position: 1,
      },
      {
        source: "!",
        outcome: "incomplete_syntax/missing_function",
        position: 1,
      },
      {
        source: "1!",
        outcome: "incomplete_syntax/missing_function",
        position: 2,
      },
      {
        source: "Z",
        outcome: "nonconforming_syntax/unknown_function",
        position: 0,
      },
      {
        source: "1Z",
        outcome: "nonconforming_syntax/unknown_function",
        position: 1,
      },
    ]) {
      const fresh = parseSuccessfully(grammar.scope, source);
      const [classification, reason] = outcome.split("/");
      const end = position + Number(source[position] === "Z");
      assert.deepEqual(issueSignatures(fresh.nodes), [
        {
          outcome: classification,
          reason,
          range: `[0, ${position}] - [0, ${end}]`,
        },
      ]);
      const nodes = publicNodes(fresh.nodes);
      assert.ok(
        nodes.some(({ kind }) => kind === "editing_command"),
        source,
      );
      assert.ok(
        !nodes.some(
          ({ kind, field }) =>
            kind === "function" ||
            kind === "function_verb" ||
            field === "function",
        ),
        source,
      );
      if (source.startsWith("1")) {
        for (const kind of ["address_clause", "line_number_address"])
          assert.ok(
            nodes.some((node) => node.kind === kind),
            source,
          );
      }
      if (source.includes("!"))
        assert.ok(
          nodes.some(({ kind }) => kind === "negation"),
          source,
        );
      const boundary =
        source.indexOf("\n") < 0 ? source.length : source.indexOf("\n");
      const complete = source.includes("Z")
        ? source.replace("Z", "p")
        : `${source.slice(0, boundary)}p${source.slice(boundary)}`;
      const edits = source.includes("Z")
        ? [{ byte: boundary - 1, deleteBytes: 1, insert: "Z" }]
        : [{ byte: boundary, deleteBytes: 1, insert: "" }];
      const incremental = parseSuccessfully(grammar.scope, complete, edits);
      assertIncrementalContract(fresh, incremental, source);
    }
  });
}

const regularExpressionEofCases = [
  {
    name: "BRE interval escape without a minimum",
    scope: "source.posix_sed",
    source: "s/a\\{\\",
    outcome: "incomplete_syntax",
    reason: "invalid_interval_close",
    range: "[0, 5] - [0, 6]",
    missingMinimum: true,
    repaired: "s/a\\{1\\}//",
    damage: [
      { byte: 5, deleteBytes: 1, insert: "" },
      { byte: 6, deleteBytes: 3, insert: "" },
    ],
    repair: [{ byte: 5, deleteBytes: 1, insert: "1\\}//" }],
  },
  {
    name: "BRE interval escape after an exact count",
    scope: "source.posix_sed",
    source: "s/a\\{1\\",
    outcome: "incomplete_syntax",
    reason: "invalid_interval_close",
    range: "[0, 6] - [0, 7]",
    repaired: "s/a\\{1\\}//",
    damage: [{ byte: 7, deleteBytes: 3, insert: "" }],
    repair: [{ byte: 7, deleteBytes: 0, insert: "}//" }],
  },
  {
    name: "BRE interval escape after an unbounded minimum",
    scope: "source.posix_sed",
    source: "s/a\\{1,\\",
    outcome: "incomplete_syntax",
    reason: "invalid_interval_close",
    range: "[0, 7] - [0, 8]",
    repaired: "s/a\\{1,\\}//",
    damage: [{ byte: 8, deleteBytes: 3, insert: "" }],
    repair: [{ byte: 8, deleteBytes: 0, insert: "}//" }],
  },
  {
    name: "BRE interval escape after a maximum",
    scope: "source.posix_sed",
    source: "s/a\\{1,2\\",
    outcome: "incomplete_syntax",
    reason: "invalid_interval_close",
    range: "[0, 8] - [0, 9]",
    repaired: "s/a\\{1,2\\}//",
    damage: [{ byte: 9, deleteBytes: 3, insert: "" }],
    repair: [{ byte: 9, deleteBytes: 0, insert: "}//" }],
  },
  {
    name: "ERE group closer conflicts with the delimiter",
    scope: "source.posix_sed.ere",
    source: "s)(a",
    outcome: "undefined_syntax",
    reason: "unclosed_subexpression",
    range: "[0, 4] - [0, 4]",
    repaired: "s/(a)//",
    damage: [
      { byte: 1, deleteBytes: 1, insert: ")" },
      { byte: 4, deleteBytes: 3, insert: "" },
    ],
    repair: [
      { byte: 1, deleteBytes: 1, insert: "/" },
      { byte: 4, deleteBytes: 0, insert: ")//" },
    ],
  },
  {
    name: "BRE group closer conflicts with the delimiter",
    scope: "source.posix_sed",
    source: "s)\\(a",
    outcome: "undefined_syntax",
    reason: "unclosed_subexpression",
    range: "[0, 5] - [0, 5]",
    repaired: "s/\\(a\\)//",
    damage: [
      { byte: 1, deleteBytes: 1, insert: ")" },
      { byte: 5, deleteBytes: 4, insert: "" },
    ],
    repair: [
      { byte: 1, deleteBytes: 1, insert: "/" },
      { byte: 5, deleteBytes: 0, insert: "\\)//" },
    ],
  },
  {
    name: "empty ERE group with a conflicting delimiter",
    scope: "source.posix_sed.ere",
    source: "s)(",
    outcome: "undefined_syntax",
    reason: "unclosed_subexpression",
    range: "[0, 3] - [0, 3]",
    repaired: "s/()//",
    damage: [
      { byte: 1, deleteBytes: 1, insert: ")" },
      { byte: 3, deleteBytes: 3, insert: "" },
    ],
    repair: [
      { byte: 1, deleteBytes: 1, insert: "/" },
      { byte: 3, deleteBytes: 0, insert: ")//" },
    ],
  },
  {
    name: "empty BRE group with a conflicting delimiter",
    scope: "source.posix_sed",
    source: "s)\\(",
    outcome: "undefined_syntax",
    reason: "unclosed_subexpression",
    range: "[0, 4] - [0, 4]",
    repaired: "s/\\(\\)//",
    damage: [
      { byte: 1, deleteBytes: 1, insert: ")" },
      { byte: 4, deleteBytes: 4, insert: "" },
    ],
    repair: [
      { byte: 1, deleteBytes: 1, insert: "/" },
      { byte: 4, deleteBytes: 0, insert: "\\)//" },
    ],
  },
  {
    name: "ERE interval closer conflicts with the delimiter",
    scope: "source.posix_sed.ere",
    source: "s}a{1",
    outcome: "undefined_syntax",
    reason: "missing_interval_close",
    range: "[0, 5] - [0, 5]",
    repaired: "s/a{1}//",
    damage: [
      { byte: 1, deleteBytes: 1, insert: "}" },
      { byte: 5, deleteBytes: 3, insert: "" },
    ],
    repair: [
      { byte: 1, deleteBytes: 1, insert: "/" },
      { byte: 5, deleteBytes: 0, insert: "}//" },
    ],
  },
  {
    name: "BRE interval closer conflicts with the delimiter",
    scope: "source.posix_sed",
    source: "s}a\\{1",
    outcome: "undefined_syntax",
    reason: "missing_interval_close",
    range: "[0, 6] - [0, 6]",
    repaired: "s/a\\{1\\}//",
    damage: [
      { byte: 1, deleteBytes: 1, insert: "}" },
      { byte: 6, deleteBytes: 4, insert: "" },
    ],
    repair: [
      { byte: 1, deleteBytes: 1, insert: "/" },
      { byte: 6, deleteBytes: 0, insert: "\\}//" },
    ],
  },
];

for (const testCase of regularExpressionEofCases) {
  const grammar = grammars.find(({ scope }) => scope === testCase.scope);
  assert.ok(grammar);
  test(`${grammar.name}: ${testCase.name}`, () => {
    const result = parseSuccessfully(testCase.scope, testCase.source);
    const end = testCase.source.length;
    const expected = [];
    if (testCase.missingMinimum) {
      expected.push({
        outcome: "undefined_syntax",
        reason: "missing_interval_minimum",
        range: "[0, 5] - [0, 5]",
      });
    }
    expected.push(
      {
        outcome: testCase.outcome,
        reason: testCase.reason,
        range: testCase.range,
      },
      {
        outcome: "incomplete_syntax",
        reason: "unterminated_regular_expression",
        range: `[0, ${end}] - [0, ${end}]`,
      },
    );
    assert.deepEqual(issueSignatures(result.nodes), expected);
    assertNoNodes(
      result.nodes,
      "ERROR",
      "MISSING",
      '"\\\\}"',
      '"}"',
      '"\\\\)"',
      '")"',
    );
    assert.deepEqual(
      applyEdits(testCase.repaired, testCase.damage),
      Buffer.from(testCase.source),
    );
    assertIncrementalContract(
      result,
      parse(testCase.scope, testCase.repaired, testCase.damage),
      testCase.name,
    );
    const repaired = parseSuccessfully(testCase.scope, testCase.repaired);
    assertNoNodes(repaired.nodes, "syntax_issue", "ERROR", "MISSING");
    assert.deepEqual(
      applyEdits(testCase.source, testCase.repair),
      Buffer.from(testCase.repaired),
    );
    assertIncrementalContract(
      repaired,
      parse(testCase.scope, testCase.source, testCase.repair),
      `${testCase.name}: repair`,
    );
  });
}

const regexIssueOwnershipCases = [
  {
    name: "BRE vertical line escape",
    scope: "source.posix_sed",
    source: "s/a\\|/x/\n",
  },
  {
    name: "BRE question mark escape",
    scope: "source.posix_sed",
    source: "s/a\\?/x/\n",
  },
  {
    name: "BRE plus escape",
    scope: "source.posix_sed",
    source: "s/a\\+/x/\n",
  },
  {
    name: "leading BRE interval",
    scope: "source.posix_sed",
    source: "s/\\{2\\}/x/\n",
  },
  {
    name: "adjacent BRE star",
    scope: "source.posix_sed",
    source: "s/a**/x/\n",
  },
  {
    name: "adjacent malformed BRE interval",
    scope: "source.posix_sed",
    source: "s/a*\\{2x\\}/x/\n",
  },
  {
    name: "leading ERE repetition and modifier",
    scope: "source.posix_sed.ere",
    source: "s/+?/x/\n",
  },
  {
    name: "adjacent ERE repetition and modifier",
    scope: "source.posix_sed.ere",
    source: "s/a**?/x/\n",
  },
  {
    name: "adjacent malformed ERE interval",
    scope: "source.posix_sed.ere",
    source: "s/a*{2x}/x/\n",
  },
  {
    name: "character class range start",
    scope: "source.posix_sed",
    source: "s/[[:alpha:]-z]/x/\n",
  },
  {
    name: "character class range end",
    scope: "source.posix_sed",
    source: "s/[a-[:alpha:]]/x/\n",
  },
  {
    name: "equivalence class range start",
    scope: "source.posix_sed",
    source: "s/[[=a=]-z]/x/\n",
  },
  {
    name: "equivalence class range end",
    scope: "source.posix_sed",
    source: "s/[a-[=b=]]/x/\n",
  },
  {
    name: "ambiguous bracket expression",
    scope: "source.posix_sed",
    source: "s/[.a.]/x/\n",
  },
  {
    name: "ambiguous bracket expression with a nonportable endpoint",
    scope: "source.posix_sed",
    source: "s/[.[=a=]-z.]/x/\n",
  },
  {
    name: "character class range start",
    scope: "source.posix_sed.ere",
    source: "s/[[:alpha:]-z]/x/\n",
  },
  {
    name: "character class range end",
    scope: "source.posix_sed.ere",
    source: "s/[a-[:alpha:]]/x/\n",
  },
  {
    name: "equivalence class range start",
    scope: "source.posix_sed.ere",
    source: "s/[[=a=]-z]/x/\n",
  },
  {
    name: "equivalence class range end",
    scope: "source.posix_sed.ere",
    source: "s/[a-[=b=]]/x/\n",
  },
  {
    name: "ambiguous bracket expression",
    scope: "source.posix_sed.ere",
    source: "s/[.a.]/x/\n",
  },
  {
    name: "ambiguous bracket expression with a nonportable endpoint",
    scope: "source.posix_sed.ere",
    source: "s/[.[=a=]-z.]/x/\n",
  },
];

for (const testCase of regexIssueOwnershipCases) {
  const grammar = grammars.find(({ scope }) => scope === testCase.scope);
  assert.ok(grammar);
  test(`${grammar.name}: ${testCase.name} converges after expression and replacement edits`, () => {
    const fresh = parseSuccessfully(testCase.scope, testCase.source);
    const replacementByte = testCase.source.lastIndexOf("/x/") + 1;
    const changed = applyEdits(testCase.source, [
      { byte: replacementByte, deleteBytes: 1, insert: "y" },
    ]);
    assertIncrementalContract(
      fresh,
      parseSuccessfully(testCase.scope, changed, [
        { byte: replacementByte, deleteBytes: 1, insert: "x" },
      ]),
      testCase.name,
    );
    const expressionEnd = testCase.source.lastIndexOf("/x/");
    assertIncrementalContract(
      fresh,
      parseSuccessfully(testCase.scope, "s//x/\n", [
        {
          byte: 2,
          deleteBytes: 0,
          insert: testCase.source.slice(2, expressionEnd),
        },
      ]),
      testCase.name,
    );
  });
}

test("posix_sed: bracket term marker prefixes preserve payloads and converge after edits", () => {
  const cases = [
    {
      type: "character_class",
      marker: ":",
      payload: "alpha",
      kind: "class_name",
      field: "name",
    },
    {
      type: "collating_symbol",
      marker: ".",
      payload: "a",
      kind: "collating_element_single",
      field: "element",
    },
    {
      type: "equivalence_class",
      marker: "=",
      payload: "a",
      kind: "collating_element_single",
      field: "element",
    },
  ];

  for (const grammar of grammars) {
    for (const testCase of cases) {
      for (const payload of [testCase.payload, ""]) {
        const source = `s/[[${testCase.marker}${payload}${testCase.marker}`;
        const eof = source.length;
        const label = `${grammar.name}: ${source}`;
        const closingMarker = payload !== "" || testCase.marker === ":";
        const missingPayload = payload === "" && closingMarker;
        const result = parseSuccessfully(grammar.scope, source);
        assert.deepEqual(
          issueSignatures(result.nodes).filter(({ reason }) =>
            [
              "missing_bracket_term_payload",
              "missing_bracket_term_close",
            ].includes(reason),
          ),
          [
            ...(missingPayload
              ? [
                  {
                    outcome: "undefined_syntax",
                    reason: "missing_bracket_term_payload",
                    range: "[0, 5] - [0, 5]",
                  },
                ]
              : []),
            {
              outcome: "incomplete_syntax",
              reason: "missing_bracket_term_close",
              range: `[0, ${eof}] - [0, ${eof}]`,
            },
          ],
          label,
        );
        assertNoNodes(result.nodes, "ERROR", "MISSING");
        const nodes = publicNodes(result.nodes);
        const owner = nodes.findIndex(({ kind }) => kind === testCase.type);
        assert.notEqual(owner, -1, label);
        assert.deepEqual(
          [nodes[owner].startByte, nodes[owner].endByte],
          [3, eof],
          label,
        );
        assert.deepEqual(
          nodes
            .filter(({ kind }) => kind === testCase.kind)
            .map(({ parent, field, startByte, endByte }) => [
              parent,
              field,
              startByte,
              endByte,
            ]),
          missingPayload
            ? []
            : [[owner, testCase.field, 5, closingMarker ? eof - 1 : eof]],
          label,
        );
        assert.deepEqual(
          nodes
            .filter(
              ({ kind, parent }) => kind === "syntax_issue" && parent === owner,
            )
            .map(({ field, startByte, endByte }) => [
              field,
              startByte,
              endByte,
            ]),
          [...(missingPayload ? [["issue", 5, 5]] : []), ["issue", eof, eof]],
          label,
        );
        assert.deepEqual(
          directDelimiterLeafLines(result.nodes, testCase.type),
          [
            '0:3 - 0:4 "["',
            `0:4 - 0:5 "${testCase.marker}"`,
            ...(closingMarker
              ? [`0:${eof - 1} - 0:${eof} "${testCase.marker}"`]
              : []),
          ],
          label,
        );
        if (missingPayload) continue;

        const suffix = `x${testCase.marker}]]/x/`;
        const initial = closingMarker ? `${source}]` : source;
        const complete = closingMarker
          ? `${source}]]/x/`
          : `${source}${suffix}`;
        const histories = closingMarker
          ? [
              { edit: { byte: eof, deleteBytes: 1, insert: "" }, source },
              {
                edit: { byte: eof, deleteBytes: 0, insert: "]" },
                source: initial,
              },
              {
                edit: { byte: eof + 1, deleteBytes: 0, insert: "]/x/" },
                source: complete,
              },
              {
                edit: { byte: eof, deleteBytes: 1, insert: "x" },
                source: `${source}x]/x/`,
              },
              {
                edit: { byte: eof, deleteBytes: 1, insert: "]" },
                source: complete,
              },
            ]
          : [
              {
                edit: { byte: eof, deleteBytes: 0, insert: suffix },
                source: complete,
              },
              {
                edit: { byte: eof, deleteBytes: suffix.length, insert: "" },
                source,
              },
            ];
        const edits = [];
        for (const history of histories) {
          edits.push(history.edit);
          assert.deepEqual(
            applyEdits(initial, edits),
            Buffer.from(history.source),
          );
          const fresh = parse(grammar.scope, history.source);
          assertIncrementalContract(
            fresh,
            parse(grammar.scope, initial, edits),
            `${label}: ${history.source}`,
          );
          if (history.source === complete) {
            assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);
            assert.deepEqual(issueSignatures(fresh.nodes), [], label);
            assertNoNodes(fresh.nodes, "ERROR", "MISSING");
            if (!closingMarker) {
              assert.deepEqual(
                syntaxSignatures(fresh.nodes, ["collating_element_multi"]),
                ["element: collating_element_multi [0, 5] - [0, 7]"],
                label,
              );
            }
          }
        }
      }
    }
  }
});

for (const grammar of grammars) {
  test(`${grammar.name}: invalid interval characters preserve boundaries`, () => {
    const opening = grammar.name === "posix_sed" ? "\\{" : "{";
    const closing = grammar.name === "posix_sed" ? "\\}" : "}";
    const prefix = Buffer.from(`/a${opening}1,x`);
    const start = prefix.length - 1;
    for (const testCase of [
      {
        name: "surrounding invalid text",
        count: 1,
        suffix: `y${closing}/p\n`,
        trailingFault: true,
      },
      {
        name: "consecutive invalid bytes",
        count: 2,
        suffix: `${closing}/p\n`,
      },
      {
        name: "end of source",
        count: 1,
        suffix: "",
        boundary: "incomplete_syntax",
      },
      {
        name: "physical newline",
        count: 1,
        suffix: "\np\n",
        boundary: "nonconforming_syntax",
      },
      {
        name: "following bracket expression",
        count: 1,
        suffix: `[bc]${closing}/p\n`,
        missingClose: true,
        unmatchedCloser: grammar.name === "posix_sed",
      },
    ]) {
      for (const byte of [0, 0xff]) {
        const invalidReason =
          byte === 0
            ? "invalid_regular_expression_character"
            : "invalid_encoding";
        const source = Buffer.concat([
          prefix,
          Buffer.alloc(testCase.count, byte),
          Buffer.from(testCase.suffix),
        ]);
        const range = (first, last) => `[0, ${first}] - [0, ${last}]`;
        const position = prefix.length + testCase.count;
        const expected = [
          {
            outcome: "undefined_syntax",
            reason: "invalid_interval_character",
            range: range(start, start + 1),
          },
          {
            outcome: "invalid_syntax",
            reason: invalidReason,
            range: range(start + 1, position),
          },
        ];
        if (testCase.trailingFault) {
          expected.push({
            outcome: "undefined_syntax",
            reason: "invalid_interval_character",
            range: range(position, position + 1),
          });
        }
        if (testCase.missingClose || testCase.boundary !== undefined) {
          expected.push({
            outcome:
              testCase.boundary === "incomplete_syntax"
                ? "incomplete_syntax"
                : "undefined_syntax",
            reason: "missing_interval_close",
            range: range(position, position),
          });
        }
        if (testCase.boundary !== undefined) {
          expected.push(
            {
              outcome: testCase.boundary,
              reason: "unterminated_regular_expression",
              range: range(start + 2, start + 2),
            },
            {
              outcome: testCase.boundary,
              reason: "missing_function",
              range: range(start + 2, start + 2),
            },
          );
        }
        if (testCase.unmatchedCloser) {
          expected.push({
            outcome: "undefined_syntax",
            reason: "unmatched_interval_close",
            range: range(start + 6, start + 8),
          });
        }
        const edits =
          testCase.suffix === ""
            ? [
                { byte: position, deleteBytes: 0, insert: closing },
                { byte: position, deleteBytes: closing.length, insert: "" },
              ]
            : [
                { byte: position, deleteBytes: 1, insert: "" },
                {
                  byte: position,
                  deleteBytes: 0,
                  insert: testCase.suffix[0],
                },
              ];
        assert.deepEqual(applyEdits(source, edits), source);
        const fresh = parse(grammar.scope, source);
        const incremental = parse(grammar.scope, source, edits);
        const label = `${testCase.name}, byte ${byte}`;
        assertIncrementalContract(fresh, incremental, label);
        const retained = [
          `minimum: duplication_count ${range(start - 2, start - 1)}`,
          ...expected
            .filter(
              ({ reason }) =>
                reason === "invalid_interval_character" ||
                reason === invalidReason,
            )
            .map(({ reason, range }) => `${reason} ${range}`),
        ];
        for (const result of [fresh, incremental]) {
          assert.deepEqual(issueSignatures(result.nodes), expected, label);
          assert.deepEqual(
            syntaxSignatures(result.nodes, [
              "duplication_count",
              "invalid_interval_character",
              invalidReason,
            ]),
            retained,
            label,
          );
        }
      }
    }
  });

  test(`${grammar.name}: character class names: invalid spellings own their source`, () => {
    for (const { name, invalid, normal } of [
      { name: "1", invalid: [[0, 1]], normal: [] },
      { name: "1alpha", invalid: [[0, 1]], normal: [[1, 6]] },
      {
        name: "a-b",
        invalid: [[1, 2]],
        normal: [
          [0, 1],
          [2, 3],
        ],
      },
      {
        name: "a_b",
        invalid: [[1, 2]],
        normal: [
          [0, 1],
          [2, 3],
        ],
      },
      {
        name: " a ",
        invalid: [
          [0, 1],
          [2, 3],
        ],
        normal: [[1, 2]],
      },
      { name: "α", invalid: [[0, 2]], normal: [] },
      {
        name: "a:b",
        invalid: [[1, 2]],
        normal: [
          [0, 1],
          [2, 3],
        ],
      },
    ]) {
      const source = `s/[[:${name}:]]/x/\n`;
      const result = parseSuccessfully(grammar.scope, source);
      const range = (start, end) => `[0, ${5 + start}] - [0, ${5 + end}]`;
      assert.deepEqual(
        issueSignatures(result.nodes),
        invalid.map(([start, end]) => ({
          outcome: "undefined_syntax",
          reason: "invalid_character_class_name",
          range: range(start, end),
        })),
        source,
      );
      assert.deepEqual(
        syntaxSignatures(result.nodes, ["class_name"]),
        normal.map(([start, end]) => `name: class_name ${range(start, end)}`),
        source,
      );
      for (const node of result.nodes.filter(
        ({ kind }) => kind === "invalid_character_class_name",
      )) {
        assert.ok(
          !result.nodes.some(
            ({ parent }) => parent === result.nodes.indexOf(node),
          ),
          source,
        );
      }
      const history = `s/[[:Alpha:]]/x/\n`;
      const edits = [{ byte: 5, deleteBytes: 5, insert: name }];
      assertIncrementalContract(
        result,
        parse(grammar.scope, history, edits),
        source,
      );
      const repaired = parseSuccessfully(grammar.scope, history);
      assertNoNodes(repaired.nodes, "syntax_issue", "ERROR", "MISSING");
      assert.deepEqual(syntaxSignatures(repaired.nodes, ["class_name"]), [
        "name: class_name [0, 5] - [0, 10]",
      ]);
      assertIncrementalContract(
        repaired,
        parse(grammar.scope, source, [
          { byte: 5, deleteBytes: Buffer.byteLength(name), insert: "Alpha" },
        ]),
        `${source}: repair`,
      );
    }
  });

  test(`${grammar.name}: invalid regular expression characters retain byte ranges through repair`, () => {
    const invalidValues = [
      { name: "NUL", bytes: Buffer.from([0]) },
      { name: "invalid UTF-8 byte", bytes: Buffer.from([0xff]) },
      { name: "overlong UTF-8 sequence", bytes: Buffer.from([0xc0, 0x80]) },
    ];
    const contexts = [
      { name: "ordinary character", prefix: "s/", suffix: "//\n" },
      { name: "bracket element", prefix: "/[", suffix: "]/p\n" },
      { name: "range start", prefix: "/[", suffix: "-z]/p\n" },
      { name: "range end", prefix: "/[a-", suffix: "]/p\n" },
      { name: "collating symbol middle", prefix: "/[[.a", suffix: "b.]]/p\n" },
      { name: "collating symbol end", prefix: "/[[.a", suffix: ".]]/p\n" },
      { name: "equivalence class", prefix: "/[[=", suffix: "=]]/p\n" },
      {
        name: "class name middle",
        prefix: "/[[:a",
        suffix: "1:]]/p\n",
        classNames: ["name: class_name [0, 4] - [0, 5]"],
        repairedClassNameRange: "[0, 4] - [0, 7]",
      },
      {
        name: "class name start",
        prefix: "/[[:",
        suffix: "1:]]/p\n",
        classNames: [],
        repairedClassNameRange: "[0, 4] - [0, 6]",
      },
      {
        name: "escaped repetition operand",
        prefix: "/\\",
        suffix: "*/p\n",
        repair: "*",
        quotedCharacterRange: "[0, 1] - [0, 3]",
      },
      {
        name: "escaped grouped character",
        prefix: grammar.name === "posix_sed" ? "/\\(\\" : "/(\\",
        suffix: grammar.name === "posix_sed" ? "\\)/p\n" : ")/p\n",
        repair: "*",
        quotedCharacterRange:
          grammar.name === "posix_sed" ? "[0, 3] - [0, 5]" : "[0, 2] - [0, 4]",
      },
    ];
    for (const invalid of invalidValues) {
      for (const context of contexts) {
        const prefix = Buffer.from(context.prefix);
        const suffix = Buffer.from(context.suffix);
        const source = Buffer.concat([prefix, invalid.bytes, suffix]);
        const label = `${invalid.name}: ${context.name}`;
        const result = parseSuccessfully(grammar.scope, source);
        const expectedIssues = [
          {
            outcome: "invalid_syntax",
            reason:
              invalid.name === "NUL"
                ? "invalid_regular_expression_character"
                : "invalid_encoding",
            range: `[0, ${prefix.length}] - [0, ${prefix.length + invalid.bytes.length}]`,
          },
        ];
        if (context.classNames !== undefined) {
          const digit = prefix.length + invalid.bytes.length;
          expectedIssues.push({
            outcome: "undefined_syntax",
            reason: "invalid_character_class_name",
            range: `[0, ${digit}] - [0, ${digit + 1}]`,
          });
          assert.deepEqual(
            syntaxSignatures(result.nodes, ["class_name"]),
            context.classNames,
            label,
          );
        }
        assert.deepEqual(issueSignatures(result.nodes), expectedIssues, label);
        assertNoNodes(
          result.nodes,
          "invalid_character_token",
          "quoted_character",
          "ERROR",
          "MISSING",
        );
        const history = Buffer.concat([
          prefix,
          Buffer.from("q"),
          invalid.bytes,
          suffix,
        ]);
        const edits = [{ byte: prefix.length, deleteBytes: 1, insert: "" }];
        assertIncrementalContract(
          result,
          parse(grammar.scope, history, edits),
          label,
        );
        const repair = context.repair ?? "a";
        const repaired = Buffer.concat([prefix, Buffer.from(repair), suffix]);
        const fresh = parseSuccessfully(grammar.scope, repaired);
        assertNoNodes(fresh.nodes, "syntax_issue", "ERROR", "MISSING");
        if (context.repairedClassNameRange !== undefined) {
          assert.deepEqual(
            syntaxSignatures(fresh.nodes, ["class_name"]),
            [`name: class_name ${context.repairedClassNameRange}`],
            `${label}: repaired class name`,
          );
        }
        if (context.quotedCharacterRange !== undefined) {
          assert.deepEqual(
            syntaxSignatures(fresh.nodes, ["quoted_character"]),
            [`quoted_character ${context.quotedCharacterRange}`],
            `${label}: repaired quoted character range`,
          );
          const quoted = fresh.nodes.findIndex(
            ({ kind }) => kind === "quoted_character",
          );
          assert.equal(
            subtree(fresh.nodes, quoted).length,
            1,
            `${label}: repaired quoted character must be a leaf`,
          );
        }
        assertIncrementalContract(
          fresh,
          parse(grammar.scope, source, [
            {
              byte: prefix.length,
              deleteBytes: invalid.bytes.length,
              insert: repair,
            },
          ]),
          `${label}: repair`,
        );
      }
    }
  });
}

for (const grammar of grammars) {
  test(`${grammar.name}: unexpected command text owns nested NUL issues`, () => {
    const source = "{\npX\0Y\0\nq\n}\n";
    const fresh = parseSuccessfully(grammar.scope, source);
    const incremental = parseSuccessfully(grammar.scope, `p\n${source}`, [
      { byte: 0, deleteBytes: 2, insert: "" },
    ]);
    assertIncrementalContract(
      fresh,
      incremental,
      "nested unexpected command text",
    );
    for (const result of [fresh, incremental]) {
      assertNoNodes(result.nodes, "ERROR", "MISSING");
      assert.deepEqual(
        syntaxSignatures(result.nodes, [
          "block_function",
          "print_function",
          "quit_function",
          "unexpected_command_text",
          "nul_character",
        ]),
        [
          "block_function [0, 0] - [3, 1]",
          "  print_function [1, 0] - [1, 1]",
          "  unexpected_command_text [1, 1] - [1, 5]",
          "    nul_character [1, 2] - [1, 3]",
          "    nul_character [1, 4] - [1, 5]",
          "  quit_function [2, 0] - [2, 1]",
        ],
      );
    }
    const edits = [
      { byte: 6, deleteBytes: 1, insert: "" },
      { byte: 4, deleteBytes: 1, insert: "" },
    ];
    const repaired = "{\npXY\nq\n}\n";
    assert.deepEqual(applyEdits(source, edits), Buffer.from(repaired));
    const repairedFresh = parseSuccessfully(grammar.scope, repaired);
    assert.deepEqual(issueSignatures(repairedFresh.nodes), [
      {
        outcome: "nonconforming_syntax",
        reason: "unexpected_command_text",
        range: "[1, 1] - [1, 3]",
      },
    ]);
    assertIncrementalContract(
      repairedFresh,
      parseSuccessfully(grammar.scope, source, edits),
      "remove only the nested NUL issues",
    );
  });
}

for (const grammar of grammars) {
  test(`${grammar.name}: long unterminated replacements parse through EOF`, () => {
    const replacementCharacters = 80_000;
    const source = `s/a/${"x".repeat(replacementCharacters)}`;
    const result = parseSuccessfully(grammar.scope, source);
    assert.deepEqual(issuePaths(result.nodes), [
      "incomplete_syntax/unterminated_replacement",
    ]);
  });
}

for (const grammar of grammars) {
  test(`${grammar.name}: decoding failure does not change interval EOF and boundary outcomes`, () => {
    const prefix = Buffer.from(
      grammar.name === "posix_sed" ? "/a\\{1" : "/a{1",
    );
    const unfinished = Buffer.concat([prefix, Buffer.from([0xf0, 0x9f, 0x98])]);
    const end = unfinished.length;
    for (const { suffix, missing } of [
      {
        suffix: "",
        missing: [
          ["incomplete_syntax", "missing_interval_close"],
          ["incomplete_syntax", "unterminated_regular_expression"],
          ["incomplete_syntax", "missing_function"],
        ],
      },
      {
        suffix: "/p\n",
        missing: [["undefined_syntax", "missing_interval_close"]],
      },
      {
        suffix: "\np\n",
        missing: [
          ["undefined_syntax", "missing_interval_close"],
          ["nonconforming_syntax", "unterminated_regular_expression"],
          ["nonconforming_syntax", "missing_function"],
        ],
      },
    ]) {
      const source = Buffer.concat([unfinished, Buffer.from(suffix)]);
      const fresh = parseSuccessfully(grammar.scope, source);
      assert.deepEqual(issueSignatures(fresh.nodes), [
        {
          outcome: "invalid_syntax",
          reason: "invalid_encoding",
          range: `[0, ${prefix.length}] - [0, ${end}]`,
        },
        ...missing.map(([outcome, reason]) => ({
          outcome,
          reason,
          range: `[0, ${end}] - [0, ${end}]`,
        })),
      ]);
      const history = Buffer.concat([unfinished, Buffer.from("/p\n")]);
      assertIncrementalContract(
        fresh,
        parse(grammar.scope, history, [
          { byte: end, deleteBytes: 3, insert: suffix },
        ]),
        JSON.stringify(suffix),
      );
    }
  });
}

test("posix_sed: BRE dollar classification tracks every byte of multibyte lookahead", () => {
  for (const [delimiter, alternative] of [
    ["é", "è"],
    ["あ", "ぃ"],
    ["😀", "😁"],
  ]) {
    const width = Buffer.byteLength(delimiter);
    const dollarStart = 1 + width;
    const edits = [{ byte: 2 * width + 1, deleteBytes: width, insert: "" }];
    for (const [source, expected, beforeKind, afterKind] of [
      [
        `s${delimiter}$${alternative}${delimiter}x${delimiter}\n`,
        `s${delimiter}$${delimiter}x${delimiter}\n`,
        "ordinary_character",
        '"$"',
      ],
      [
        `s${delimiter}$${delimiter}${alternative}${delimiter}x${delimiter}\n`,
        `s${delimiter}$${alternative}${delimiter}x${delimiter}\n`,
        '"$"',
        "ordinary_character",
      ],
    ]) {
      const context = `${width}-byte lookahead: ${beforeKind} to ${afterKind}`;
      assert.deepEqual(
        applyEdits(source, edits),
        Buffer.from(expected),
        context,
      );
      const original = parseSuccessfully("source.posix_sed", source);
      const fresh = parseSuccessfully("source.posix_sed", expected);
      const incremental = parseSuccessfully("source.posix_sed", source, edits);
      assertIncrementalContract(fresh, incremental, context);
      for (const [result, kind] of [
        [original, beforeKind],
        [fresh, afterKind],
        [incremental, afterKind],
      ]) {
        assert.deepEqual(
          publicNodes(result.nodes)
            .filter(
              (node) =>
                ["ordinary_character", '"$"'].includes(node.kind) &&
                node.startByte === dollarStart,
            )
            .map((node) => ({
              kind: node.kind,
              startByte: node.startByte,
              endByte: node.endByte,
              start: node.start,
              end: node.end,
            })),
          [
            {
              kind,
              startByte: dollarStart,
              endByte: dollarStart + 1,
              start: [0, dollarStart],
              end: [0, dollarStart + 1],
            },
          ],
          context,
        );
      }
    }
  }
});

for (const [name, opening] of [
  ["posix_sed", "\\{"],
  ["posix_sed_ere", "{"],
]) {
  test(`${name}: malformed interval content tracks every byte of a multibyte delimiter`, () => {
    const { scope } = grammars.find((grammar) => grammar.name === name);
    for (const [delimiter, alternative] of [
      ["é", "è"],
      ["あ", "ぃ"],
      ["😀", "😁"],
    ]) {
      const width = Buffer.byteLength(delimiter);
      const prefix = `s${delimiter}a${opening}x`;
      const source = `${prefix}${delimiter}${alternative}${delimiter}\n`;
      const expected = `${prefix}${alternative}${delimiter}\n`;
      const contentStart = Buffer.byteLength(prefix) - 1;
      const edits = [
        { byte: contentStart + width, deleteBytes: width, insert: "" },
      ];
      const context = `${width}-byte delimiter`;
      assert.deepEqual(
        applyEdits(source, edits),
        Buffer.from(expected),
        context,
      );
      const fresh = parseSuccessfully(scope, expected);
      const incremental = parseSuccessfully(scope, source, edits);
      assertIncrementalContract(fresh, incremental, context);
      for (const [result, contentEnd] of [
        [parseSuccessfully(scope, source), contentStart + 1],
        [fresh, contentStart + 1 + width],
        [incremental, contentStart + 1 + width],
      ]) {
        assert.deepEqual(
          issueSignatures(result.nodes).filter(
            ({ reason }) => reason === "invalid_interval_character",
          ),
          [
            {
              outcome: "undefined_syntax",
              reason: "invalid_interval_character",
              range: `[0, ${contentStart}] - [0, ${contentEnd}]`,
            },
          ],
          context,
        );
      }
    }
  });
}
