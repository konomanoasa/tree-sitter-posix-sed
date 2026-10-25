import assert from "node:assert/strict";
import { test } from "node:test";
import { grammars } from "../scripts/tree-sitter.js";
import {
  assertNoNodes,
  issuePaths,
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
const fuzzIterations = 100;
const editsPerHistory = 5;
const maximumFragments = 3;
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
  return function* (fragments, insertions, joinSource) {
    for (let iteration = 0; iteration < fuzzIterations; iteration++) {
      const parts = [];
      const count = 1 + next(maximumFragments);
      for (let part = 0; part < count; part++) {
        parts.push(fragments[next(fragments.length)]);
      }
      const initial = joinSource(parts);
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

const fragments = [
  "p",
  "d",
  "x",
  "=",
  "q",
  "1p",
  "$p",
  "1,2p",
  "1 , 2p",
  "1, p",
  ", 2p",
  ",2p",
  "1,p",
  "1,q",
  "1,2q",
  "1 2q",
  "1:x",
  "1 2:x",
  "1 2#x",
  "1,2,3p",
  "1,2 3p",
  "1,2 ,3p",
  "/a/p",
  "/a*b/p",
  "/\\(a\\)/p",
  "/[abc]/p",
  "/[.a.]/p",
  "/[a-m-o]/p",
  "s/a/b/",
  "s/a/b/g",
  "s/a/b/w f",
  "s/a/b/2",
  "y/ab/cd/",
  "b x",
  "b }x",
  "t",
  ":l",
  "a\\\ntext",
  "i\\\nfoo",
  "c\\\nbar",
  "r file",
  "w file",
  "{p;d}",
  "{p\nd\n}",
  "{ }",
  "#comment",
  "#n",
  "!p",
  "! \tp",
  "1!p",
  "!!p",
  "}",
  "{p",
  "s/a",
  "/[a",
  "\\%re%p",
  "s;a;b;",
];

const insertions = "psdxq!{};,\n\\/*[]().^$|+?-:=# \tabw12";

const generateHistories = createEditHistoryGenerator();
for (const grammar of grammars) {
  const histories = [
    ...generateHistories(
      fragments,
      insertions,
      (parts) => `${parts.join("\n")}\n`,
    ),
  ];
  assert.equal(histories.length, fuzzIterations * editsPerHistory);
  for (let iteration = 0; iteration < fuzzIterations; iteration++) {
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
    name: `flags after write remain deterministic`,
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
    name: `command after write remains deterministic`,
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
