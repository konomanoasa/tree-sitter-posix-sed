import assert from "node:assert/strict";
import { test } from "node:test";
import { grammars } from "../scripts/tree-sitter.js";
import {
  assertNoNodes,
  issuePaths,
  issueSignatures,
  syntaxSignatures,
  topLevelEditingCommands,
} from "./support/cst.js";
import {
  applyEdits,
  assertIncrementalContract,
  lexedTokensAfterEdits,
  parse,
  parseSuccessfully,
} from "./support/parser.js";

const fuzzSeed = 1n;
const historiesPerInput = 2;
const editsPerHistory = 4;
const maximumDeletionBytes = 2;
const randomStateBits = 64;
const randomOutputShift = 32n;
const randomMultiplier = 6364136223846793005n;
const randomIncrement = 1n;

function createEditHistoryGenerator() {
  let seed = fuzzSeed;
  function next(maximum) {
    seed = BigInt.asUintN(
      randomStateBits,
      seed * randomMultiplier + randomIncrement,
    );
    return Number(seed >> randomOutputShift) % maximum;
  }
  return function* (inputs, insertions) {
    const historyCount = inputs.length * historiesPerInput;
    for (let iteration = 0; iteration < historyCount; iteration++) {
      const initial = inputs[iteration % inputs.length];
      let source = Buffer.from(initial);
      const edits = [];
      for (let step = 0; step < editsPerHistory; step++) {
        const position = next(source.length + 1);
        const insert = next(2) === 0 || position === source.length;
        const edit = insert
          ? {
              byte: position,
              deleteBytes: 0,
              insert: insertions[next(insertions.length)],
            }
          : {
              byte: position,
              deleteBytes: Math.min(
                next(maximumDeletionBytes) + 1,
                source.length - position,
              ),
              insert: "",
            };
        edits.push(edit);
        source = applyEdits(source, [edit]);
        yield {
          initial,
          source,
          edits: [...edits],
          context: `seed ${fuzzSeed}, iteration ${iteration}, source ${JSON.stringify(initial)}, edits ${JSON.stringify(edits)}`,
        };
      }
    }
  };
}

const inputs = [
  "1,2!p\n",
  "/[[:alpha:]]/p\n",
  "s/[a-z]*/&/g\n",
  "y/ab/cd/\n",
  ":x\nb x\n",
  "a\\\ntext\n",
  "r file\nw file\n",
  "{\np\nd\n}\n",
  "s/a",
  "/[a",
];

const insertions = "psdxq!{};,\n\\/*[]().^$|+?-:=# \tabw12";

const generateHistories = createEditHistoryGenerator();
for (const grammar of grammars) {
  const histories = [...generateHistories(inputs, insertions)];
  const historyCount = inputs.length * historiesPerInput;
  assert.equal(histories.length, historyCount * editsPerHistory);
  for (let iteration = 0; iteration < historyCount; iteration++) {
    const start = iteration * editsPerHistory;
    const states = histories.slice(start, start + editsPerHistory);
    test(`${grammar.name}: fixed-seed generated histories converge: seed ${fuzzSeed}, iteration ${iteration}`, () => {
      for (const history of states) {
        const fresh = parse(grammar.scope, history.source);
        const incremental = parse(
          grammar.scope,
          history.initial,
          history.edits,
        );
        assertIncrementalContract(
          fresh,
          incremental,
          `${grammar.name}: ${history.context}`,
        );
      }
    });
  }
}

const commandRecoveryCases = [
  {
    name: "raw newline after an unclosed bracket expression",
    before: "  1,2!p\n",
    broken: "/[a\n",
    after: "\t/[[.a.]][[=b=]][[:alpha:]]/d\n",
    initial: "/[a]/p\n",
    edit: { byte: 3, deleteBytes: 3, insert: "" },
    boundary: 3,
    issues: [
      "undefined_syntax/unclosed_bracket_expression",
      "nonconforming_syntax/unterminated_regular_expression",
      "nonconforming_syntax/missing_function",
    ],
  },
  {
    name: "semicolon after an unknown function",
    before: "  1,2!p;",
    broken: "Z;",
    after: "\t/[[.a.]][[=b=]][[:alpha:]]/d\n",
    initial: "p;",
    edit: { byte: 0, deleteBytes: 1, insert: "Z" },
    boundary: 1,
    issues: ["nonconforming_syntax/unknown_function"],
  },
  {
    name: "closed block containing an unknown function",
    before: "  1{\np\n};",
    broken: "{Z\n};",
    after: "\t2s/a/b/\n",
    initial: "{p\n};",
    edit: { byte: 1, deleteBytes: 1, insert: "Z" },
    boundary: 3,
    issues: ["nonconforming_syntax/unknown_function"],
  },
];

for (const grammar of grammars) {
  for (const testCase of commandRecoveryCases) {
    test(`${grammar.name}: recovery preserves surrounding commands across ${testCase.name}`, () => {
      const { before, broken, after } = testCase;
      const source = before + broken + after;
      const followingLines = (before + broken).split("\n");
      const lastLine = followingLines.at(-1);
      assert.ok(lastLine !== undefined);
      const expected = [
        { source: before, start: [0, 0] },
        {
          source: after,
          start: [followingLines.length - 1, Buffer.byteLength(lastLine)],
        },
      ].map(({ source: commandSource, start }) => {
        const result = parseSuccessfully(grammar.scope, commandSource);
        const command = topLevelEditingCommands(result.nodes)[0];
        return {
          start: [start[0] + command.start[0], start[1] + command.start[1]],
          nodes: command.nodes,
        };
      });
      const offset = Buffer.byteLength(before);
      const boundaryPosition = offset + testCase.boundary;
      const histories = [
        { name: "fresh", source, edits: [] },
        {
          name: "damage a normal command",
          source: before + testCase.initial + after,
          edits: [{ ...testCase.edit, byte: offset + testCase.edit.byte }],
        },
        {
          name: "remove and restore the recovery boundary",
          source,
          edits: [
            { byte: boundaryPosition, deleteBytes: 1, insert: "" },
            {
              byte: boundaryPosition,
              deleteBytes: 0,
              insert: broken[testCase.boundary],
            },
          ],
        },
      ];
      for (const history of histories) {
        assert.deepEqual(
          applyEdits(history.source, history.edits),
          Buffer.from(source),
          history.name,
        );
        const result = parseSuccessfully(
          grammar.scope,
          history.source,
          history.edits,
        );
        assert.deepEqual(issuePaths(result.nodes), testCase.issues);
        const commands = topLevelEditingCommands(result.nodes);
        for (const command of expected) {
          assert.deepEqual(
            commands.find(
              ({ start }) =>
                start[0] === command.start[0] && start[1] === command.start[1],
            ),
            command,
            `${history.name}: intact command at ${command.start}\n${result.stdout}`,
          );
        }
      }
    });
  }
}

const printLine = "p\n";
const followingLineCounts = [100, 200];
const leadingCommandCount = 10;
const reuseCases = [
  {
    name: "an empty line inserted between print commands",
    leadingLines: leadingCommandCount,
    removed: "",
    inserted: "\n",
  },
  {
    name: "a substitute command inserted between print commands",
    leadingLines: leadingCommandCount,
    removed: "",
    inserted: "s/a/b/\n",
  },
  {
    name: "a substitute command deleted between print commands",
    leadingLines: leadingCommandCount,
    removed: "s/a/b/\n",
    inserted: "",
  },
  {
    name: "#n inserted before print commands",
    leadingLines: 0,
    removed: "",
    inserted: "#n\n",
  },
  {
    name: "#n deleted before print commands",
    leadingLines: 0,
    removed: "#n\n",
    inserted: "",
  },
];

for (const grammar of grammars) {
  for (const testCase of reuseCases) {
    test(`${grammar.name}: ${testCase.name} re-lexes no following command`, () => {
      const leading = printLine.repeat(testCase.leadingLines);
      const counts = followingLineCounts.map((lines) =>
        lexedTokensAfterEdits(
          grammar.scope,
          leading + testCase.removed + printLine.repeat(lines),
          [
            {
              byte: leading.length,
              deleteBytes: testCase.removed.length,
              insert: testCase.inserted,
            },
          ],
        ),
      );
      assert.equal(
        counts[1],
        counts[0],
        `lexed tokens after ${followingLineCounts.join(" and ")} following lines`,
      );
    });
  }
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

const bracketDelimiterConvergenceCases = grammars.flatMap((grammar) => [
  {
    name: `bracket term opening marker`,
    scope: grammar.scope,
    source: "/[[:alpha:]]/p\n",
    histories: [
      {
        source: "/[[xalpha:]]/p\n",
        edits: [{ byte: 3, deleteBytes: 1, insert: ":" }],
      },
      {
        source: "/[[=alpha=]]/p\n",
        edits: [
          { byte: 3, deleteBytes: 1, insert: ":" },
          { byte: 9, deleteBytes: 1, insert: ":" },
        ],
      },
    ],
  },
  {
    name: `bracket term closing bracket restoration`,
    scope: grammar.scope,
    source: "/[[:alpha:]x]/p\n",
    histories: [
      {
        source: "/[[:alpha:x]/p\n",
        edits: [{ byte: 10, deleteBytes: 0, insert: "]" }],
      },
    ],
  },
  {
    name: `bracket term closing bracket deletion`,
    scope: grammar.scope,
    source: "/[[:alpha:x]/p\n",
    histories: [
      {
        source: "/[[:alpha:]x]/p\n",
        edits: [{ byte: 10, deleteBytes: 1, insert: "" }],
      },
    ],
  },
]);

const explicitConvergenceCases = [
  ...bracketDelimiterConvergenceCases,
  ...grammars.flatMap((grammar) => {
    const [opening, closing] =
      grammar.name === "posix_sed" ? ["\\(", "\\)"] : ["(", ")"];
    const bodyStart = 2 + opening.length;
    return [
      {
        name: "empty regex groups converge after deleting their body or restoring their closer",
        scope: grammar.scope,
        source: `s/${opening}${closing}/x/\n`,
        histories: [
          {
            source: `s/${opening}a${closing}/x/\n`,
            edits: [{ byte: bodyStart, deleteBytes: 1, insert: "" }],
          },
          {
            source: `s/${opening}/x/\n`,
            edits: [{ byte: bodyStart, deleteBytes: 0, insert: closing }],
          },
          {
            source: `s/${opening}`,
            edits: [
              { byte: bodyStart, deleteBytes: 0, insert: `${closing}/x/\n` },
            ],
          },
        ],
      },
      {
        name: "inserting a regex group body restores its expression field",
        scope: grammar.scope,
        source: `s/${opening}a${closing}/x/\n`,
        histories: [
          {
            source: `s/${opening}${closing}/x/\n`,
            edits: [{ byte: bodyStart, deleteBytes: 0, insert: "a" }],
          },
        ],
      },
    ];
  }),
  ...[
    { source: "/a|/p", offsets: [3] },
    { source: "/|a/p", offsets: [1] },
    { source: "/(|a)/p", offsets: [2] },
    { source: "/(a|)/p", offsets: [4] },
    { source: "/(|)/p", offsets: [2, 3] },
    { source: "/(a||b)/p", offsets: [4] },
  ].map(({ source, offsets }) => ({
    name: `empty alternatives remain issues after deleting a group from ${source}`,
    scope: "source.posix_sed.ere",
    source,
    histories: [
      {
        source: `${source.slice(0, offsets[0])}()${source.slice(offsets[0])}`,
        edits: [{ byte: offsets[0], deleteBytes: 2, insert: "" }],
      },
    ],
  })),
  {
    name: "recovery-free substitution",
    scope: "source.posix_sed",
    source: "s/a/b/g\n",
    histories: [
      {
        source: "s/a/c/g\n",
        edits: [{ byte: 4, deleteBytes: 1, insert: "b" }],
      },
      { source: "s/a/b/\n", edits: [{ byte: 6, deleteBytes: 0, insert: "g" }] },
    ],
  },
  {
    name: "unclosed bracket expression at source end",
    scope: "source.posix_sed",
    source: "/[a",
    histories: [
      { source: "/[", edits: [{ byte: 2, deleteBytes: 0, insert: "a" }] },
      { source: "/[b", edits: [{ byte: 2, deleteBytes: 1, insert: "a" }] },
    ],
  },
  {
    name: "unmatched BRE subexpression close",
    scope: "source.posix_sed",
    source: "/\\)/p\n",
    histories: [
      { source: "//p\n", edits: [{ byte: 1, deleteBytes: 0, insert: "\\)" }] },
      {
        source: "/\\(\\)/p\n",
        edits: [{ byte: 1, deleteBytes: 2, insert: "" }],
      },
    ],
  },
  {
    name: "unmatched BRE interval close",
    scope: "source.posix_sed",
    source: "/\\}/p\n",
    histories: [
      { source: "//p\n", edits: [{ byte: 1, deleteBytes: 0, insert: "\\}" }] },
      {
        source: "/a\\{1\\}/p\n",
        edits: [{ byte: 1, deleteBytes: 4, insert: "" }],
      },
    ],
  },
  {
    name: "missing separator after an unmatched closing brace",
    scope: "source.posix_sed",
    source: "}p\n",
    histories: [
      { source: "}\n", edits: [{ byte: 1, deleteBytes: 0, insert: "p" }] },
      { source: "};p\n", edits: [{ byte: 1, deleteBytes: 1, insert: "" }] },
    ],
  },
  {
    name: "BRE subexpression anchor application requirements",
    scope: "source.posix_sed",
    source: "/\\(^a$\\)/p\n",
    histories: [
      {
        source: "/\\(a\\)/p\n",
        edits: [
          { byte: 3, deleteBytes: 0, insert: "^" },
          { byte: 5, deleteBytes: 0, insert: "$" },
        ],
      },
      {
        source: "/^a$/p\n",
        edits: [
          { byte: 1, deleteBytes: 0, insert: "\\(" },
          { byte: 6, deleteBytes: 0, insert: "\\)" },
        ],
      },
    ],
  },
  {
    name: "reserved unknown function after negation",
    scope: "source.posix_sed",
    source: "1!/\np\n",
    histories: [
      { source: "1!x\np\n", edits: [{ byte: 2, deleteBytes: 1, insert: "/" }] },
      { source: "1!$\np\n", edits: [{ byte: 2, deleteBytes: 1, insert: "/" }] },
    ],
  },
  ...grammars.map((grammar) => ({
    name: `flag-like write file contents remain deterministic`,
    scope: grammar.scope,
    source: "s/a/b/wp file\n",
    histories: [
      {
        source: "s/a/b/wg file\n",
        edits: [{ byte: 7, deleteBytes: 1, insert: "p" }],
      },
      {
        source: "s/a/b/w file\n",
        edits: [{ byte: 7, deleteBytes: 0, insert: "p" }],
      },
    ],
  })),
  ...grammars.map((grammar) => ({
    name: `semicolon text inside a write file remains deterministic`,
    scope: grammar.scope,
    source: "s/a/b/w file;p\n",
    histories: [
      {
        source: "s/a/b/w file\np\n",
        edits: [{ byte: 12, deleteBytes: 1, insert: ";" }],
      },
      {
        source: "s/a/b/w file;d\n",
        edits: [{ byte: 13, deleteBytes: 1, insert: "p" }],
      },
    ],
  })),
  ...grammars.flatMap((grammar) => {
    return [
      {
        name: `omitted first address before the separator`,
        source: ",2p\n",
        histories: [
          {
            source: "1,2p\n",
            edits: [{ byte: 0, deleteBytes: 1, insert: "" }],
          },
          { source: "2p\n", edits: [{ byte: 0, deleteBytes: 0, insert: "," }] },
        ],
      },
      {
        name: `omitted first and second addresses`,
        source: ",p\n",
        histories: [
          { source: "1,p\n", edits: [{ byte: 0, deleteBytes: 1, insert: "" }] },
          { source: ",2p\n", edits: [{ byte: 1, deleteBytes: 1, insert: "" }] },
        ],
      },
      {
        name: `omitted second address after the separator`,
        source: "1,p\n",
        histories: [
          {
            source: "1,2p\n",
            edits: [{ byte: 2, deleteBytes: 1, insert: "" }],
          },
          { source: "1p\n", edits: [{ byte: 1, deleteBytes: 0, insert: "," }] },
        ],
      },
      {
        name: `excess address unit on a one-address function`,
        source: "1,2q\n",
        histories: [
          {
            source: "1,2p\n",
            edits: [{ byte: 3, deleteBytes: 1, insert: "q" }],
          },
          {
            source: "1q\n",
            edits: [{ byte: 1, deleteBytes: 0, insert: ",2" }],
          },
        ],
      },
      {
        name: `leading excess address on a zero-address function`,
        source: "1:x\n",
        histories: [
          { source: ":x\n", edits: [{ byte: 0, deleteBytes: 0, insert: "1" }] },
          {
            source: "1,2:x\n",
            edits: [{ byte: 1, deleteBytes: 2, insert: "" }],
          },
        ],
      },
      {
        name: `blank-separated excess addresses on a zero-address function`,
        source: "1 2:x\n",
        histories: [
          {
            source: "1,2:x\n",
            edits: [{ byte: 1, deleteBytes: 1, insert: " " }],
          },
          {
            source: "1 2q\n",
            edits: [{ byte: 3, deleteBytes: 1, insert: ":x" }],
          },
          {
            source: "1 2p\n",
            edits: [{ byte: 3, deleteBytes: 1, insert: ":x" }],
          },
          {
            source: ":x\n",
            edits: [{ byte: 0, deleteBytes: 0, insert: "1 2" }],
          },
        ],
      },
      {
        name: `third address unit on a two-address function`,
        source: "1,2,3p\n",
        histories: [
          {
            source: "1,2p\n",
            edits: [{ byte: 3, deleteBytes: 0, insert: ",3" }],
          },
          {
            source: "1,2,3q\n",
            edits: [{ byte: 5, deleteBytes: 1, insert: "p" }],
          },
        ],
      },
      {
        name: `omission nested inside an excess address unit`,
        source: "1,q\n",
        histories: [
          {
            source: "1,2q\n",
            edits: [{ byte: 2, deleteBytes: 1, insert: "" }],
          },
          { source: "1q\n", edits: [{ byte: 1, deleteBytes: 0, insert: "," }] },
        ],
      },
      {
        name: `blank runs around one separator`,
        source: "1 , 2p\n",
        histories: [
          {
            source: "1,2p\n",
            edits: [
              { byte: 1, deleteBytes: 0, insert: " " },
              { byte: 3, deleteBytes: 0, insert: " " },
            ],
          },
          {
            source: "1 ,2p\n",
            edits: [{ byte: 3, deleteBytes: 0, insert: " " }],
          },
        ],
      },
      {
        name: `pre-function blanks after separator blanks`,
        source: "1 , p\n",
        histories: [
          {
            source: "1 , 2p\n",
            edits: [{ byte: 4, deleteBytes: 1, insert: "" }],
          },
          {
            source: "1,p\n",
            edits: [
              { byte: 1, deleteBytes: 0, insert: " " },
              { byte: 3, deleteBytes: 0, insert: " " },
            ],
          },
        ],
      },
      {
        name: `blank run after negation`,
        source: "! \tp\n",
        histories: [
          {
            source: "! p\n",
            edits: [{ byte: 2, deleteBytes: 0, insert: "\t" }],
          },
          {
            source: "!\tp\n",
            edits: [{ byte: 1, deleteBytes: 0, insert: " " }],
          },
        ],
      },
      {
        name: `duplicated negation after an address`,
        source: "1!!p\n",
        histories: [
          {
            source: "1!p\n",
            edits: [{ byte: 2, deleteBytes: 0, insert: "!" }],
          },
          {
            source: "!!p\n",
            edits: [{ byte: 0, deleteBytes: 0, insert: "1" }],
          },
        ],
      },
    ].map((testCase) => ({ ...testCase, scope: grammar.scope }));
  }),
];

for (const testCase of explicitConvergenceCases) {
  const grammar = grammars.find(({ scope }) => scope === testCase.scope);
  assert.ok(grammar);
  test(`${grammar.name}: ${testCase.name}`, () => {
    const fresh = parseSuccessfully(testCase.scope, testCase.source);
    for (const history of testCase.histories) {
      assert.deepEqual(
        applyEdits(history.source, history.edits),
        Buffer.from(testCase.source),
      );
      assertIncrementalContract(
        fresh,
        parse(testCase.scope, history.source, history.edits),
        testCase.name,
      );
    }
  });
}

for (const grammar of grammars) {
  test(`${grammar.name}: editing encoded characters updates regex roles and host boundaries`, () => {
    for (const { source, edit } of [
      {
        source: String.raw`/a\x2a/p`,
        edit: { byte: 4, deleteBytes: 2, insert: "5b" },
      },
      {
        source: String.raw`/a\x7b\x32\x7d/p`,
        edit: { byte: 8, deleteBytes: 2, insert: "71" },
      },
      {
        source: String.raw`/a\x5c+/p`,
        edit: { byte: 4, deleteBytes: 2, insert: "41" },
      },
      {
        source: String.raw`s/\c/X/p`,
        edit: { byte: 3, deleteBytes: 1, insert: "q" },
      },
      {
        source: String.raw`s/\x5b[/X/`,
        edit: { byte: 6, deleteBytes: 1, insert: "" },
      },
      { source: ":a#p", edit: { byte: 2, deleteBytes: 1, insert: " " } },
    ]) {
      const changed = applyEdits(source, [edit]);
      const fresh = parseSuccessfully(grammar.scope, changed);
      assertIncrementalContract(
        fresh,
        parse(grammar.scope, source, [edit]),
        source,
      );
      const undo = {
        byte: edit.byte,
        deleteBytes: Buffer.byteLength(edit.insert),
        insert: source.slice(edit.byte, edit.byte + edit.deleteBytes),
      };
      assertIncrementalContract(
        parseSuccessfully(grammar.scope, source),
        parse(grammar.scope, changed, [undo]),
        `${source}: undo`,
      );
    }
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
      },
      {
        bytes: [0xc3, 0xf0, 0x9f, 0x98, 0x80],
        invalid: [0, 1],
      },
      {
        bytes: [0xc3, 0xa9, 0x9f, 0x98, 0x80],
        invalid: [2, 5],
      },
      {
        bytes: [0xc3, 0xa9, 0xf0, 0x98, 0x80],
        invalid: [2, 5],
      },
      {
        bytes: [0xc3, 0xa9, 0xf0, 0x9f, 0x80],
        invalid: [2, 5],
      },
      {
        bytes: [0xc3, 0xa9, 0xf0, 0x9f, 0x98],
        invalid: [2, 5],
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
        { bytes, invalid },
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
              ];
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
            assert.deepEqual(issues, [], label);
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
