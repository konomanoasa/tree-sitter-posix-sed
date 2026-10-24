import assert from "node:assert/strict";
import { test } from "node:test";
import { grammars } from "../scripts/tree-sitter.js";
import { issuePaths, topLevelEditingCommands } from "./support/cst.js";
import {
  applyEdits,
  assertIncrementalContract,
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

test("posix_sed: fixed-seed generated histories converge", (context) => {
  const generateHistories = createEditHistoryGenerator();
  for (const grammar of grammars) {
    let checked = 0;
    for (const history of generateHistories(
      fragments,
      insertions,
      (parts) => `${parts.join("\n")}\n`,
    )) {
      const fresh = parse(grammar.scope, history.source);
      const incremental = parse(grammar.scope, history.initial, history.edits);
      assertIncrementalContract(
        fresh,
        incremental,
        `${grammar.name}: ${history.context}`,
      );
      checked += 1;
    }
    assert.equal(checked, fuzzIterations * editsPerHistory);
    context.diagnostic(
      `${grammar.name}: checked ${checked} generated edit states`,
    );
  }
});

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
