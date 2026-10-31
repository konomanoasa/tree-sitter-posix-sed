import assert from "node:assert/strict";
import { test } from "node:test";
import { grammars } from "../scripts/tree-sitter.js";
import {
  applyEdits,
  assertIncrementalContract,
  assertValidHistory,
  parse,
  parseSuccessfully,
  relexedTokens,
} from "./support/parser.js";

for (const { name, scope } of grammars) {
  const ere = name.endsWith("_ere");
  const group = ere ? "(a){2,3}?" : "\\(a\\)\\{2,3\\}";
  test(`${name}: editing numeric bytes preserves independent atoms like a fresh parse`, () => {
    assertValidHistory(scope, "s/\\xe2\\x82\\xac*/X/", [
      {
        byte: 10,
        deleteBytes: 4,
        insert: "",
        source: "s/\\xe2\\x82*/X/",
        valid: true,
      },
      {
        byte: 10,
        deleteBytes: 0,
        insert: "\\xac",
        source: "s/\\xe2\\x82\\xac*/X/",
        valid: true,
      },
      {
        byte: 4,
        deleteBytes: 1,
        insert: "f",
        source: "s/\\xf2\\x82\\xac*/X/",
        valid: true,
      },
      {
        byte: 14,
        deleteBytes: 0,
        insert: "\\x80",
        source: "s/\\xf2\\x82\\xac\\x80*/X/",
        valid: true,
      },
      {
        byte: 4,
        deleteBytes: 1,
        insert: "e",
        source: "s/\\xe2\\x82\\xac\\x80*/X/",
        valid: true,
      },
      {
        byte: 8,
        deleteBytes: 1,
        insert: "7",
        source: "s/\\xe2\\x72\\xac\\x80*/X/",
        valid: true,
      },
      {
        byte: 8,
        deleteBytes: 1,
        insert: "8",
        source: "s/\\xe2\\x82\\xac\\x80*/X/",
        valid: true,
      },
    ]);
  });

  const sources = [
    "#n\n;;1,2!p;{p;d;\n}\n",
    ":abcdefghi#comment\nb é😀\nt \n",
    "r file ;#}\nw output\n",
    `s/${group}/\\U&\\1/g2iw file;p\n`,
    "s/[[.a]b.]c-e[:alpha:][=a=]]/é😀/g\n",
    "s5a5\\cA\\x41\\q5p\n",
    "s😀a😀é😀g\n",
    "a\\\nx\\x41\\\ny\\",
    "i\\\nx\\\ny\np\n",
    "y/\\q\\x41/ab/\np\n",
    ere ? "s,a{1\\,2},b," : "s,a\\{1\\,2\\},b,",
    ere ? "s/(|a||)*/b/" : "s/\\(\\|a\\|\\)*/b/",
    ere ? "s/é😀*/x/" : "s/é😀$/x/",
  ];
  for (const source of sources) {
    test(`${name}: deleting and repairing each byte of ${JSON.stringify(source)}`, () => {
      const expected = parseSuccessfully(scope, source);
      let byte = 0;
      for (const character of source) {
        const width = Buffer.byteLength(character);
        for (let offset = 0; offset < width; offset++) {
          const edits = [
            { byte: byte + offset, deleteBytes: 1, insert: "" },
            { byte, deleteBytes: width - 1, insert: character },
          ];
          assertIncrementalContract(
            expected,
            parse(scope, source, edits),
            `repair byte ${byte + offset}`,
          );
        }
        byte += width;
      }
    });
  }

  for (const [initial, steps] of [
    [
      "s/a/b/",
      [
        { byte: 5, deleteBytes: 1, insert: "", source: "s/a/b", valid: false },
        { byte: 5, deleteBytes: 0, insert: "/", source: "s/a/b/", valid: true },
        {
          byte: 6,
          deleteBytes: 0,
          insert: "g2",
          source: "s/a/b/g2",
          valid: true,
        },
      ],
    ],
    [
      "1,2p",
      [
        { byte: 1, deleteBytes: 1, insert: " ", source: "1 2p", valid: false },
        { byte: 1, deleteBytes: 1, insert: ",", source: "1,2p", valid: true },
      ],
    ],
    [
      "r file\n",
      [
        {
          byte: 1,
          deleteBytes: 1,
          insert: "",
          source: "rfile\n",
          valid: false,
        },
        {
          byte: 1,
          deleteBytes: 0,
          insert: " ",
          source: "r file\n",
          valid: true,
        },
      ],
    ],
    [
      "p;;",
      [
        { byte: 0, deleteBytes: 1, insert: "", source: ";;", valid: true },
        { byte: 1, deleteBytes: 1, insert: "p", source: ";p", valid: true },
      ],
    ],
    [
      "b label\n",
      [
        {
          byte: 7,
          deleteBytes: 1,
          insert: "#x\n",
          source: "b label#x\n",
          valid: true,
        },
        {
          byte: 7,
          deleteBytes: 1,
          insert: "",
          source: "b labelx\n",
          valid: true,
        },
      ],
    ],
    [
      "a\\\nx\\x41",
      [
        {
          byte: 8,
          deleteBytes: 0,
          insert: "\\",
          source: "a\\\nx\\x41\\",
          valid: true,
        },
        {
          byte: 8,
          deleteBytes: 1,
          insert: "\n",
          source: "a\\\nx\\x41\n",
          valid: true,
        },
      ],
    ],
    [
      "p\n\uFEFFp",
      [
        { byte: 0, deleteBytes: 2, insert: "", source: "\uFEFFp", valid: true },
        {
          byte: 0,
          deleteBytes: 0,
          insert: " ",
          source: " \uFEFFp",
          valid: false,
        },
        { byte: 0, deleteBytes: 1, insert: "", source: "\uFEFFp", valid: true },
      ],
    ],
  ]) {
    test(`${name}: explicit edit history from ${JSON.stringify(initial)}`, () => {
      assertValidHistory(scope, initial, steps);
    });
  }

  test(`${name}: fixed-seed generated histories recover normal structure`, () => {
    const source = `1,2{s/${group}/\\U&/g;p;}\n`;
    const expected = parseSuccessfully(scope, source);
    const insertions = ["", "\\", "/", "[", "}", "Σ", "\n", "#"];
    let state = 0x5ed2026;
    const histories = 100;
    for (let index = 0; index < histories; index++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const byte = state % source.length;
      const insert = insertions[index % insertions.length];
      const damage = { byte, deleteBytes: 1, insert };
      parse(scope, applyEdits(source, [damage]));
      assertIncrementalContract(
        expected,
        parse(scope, source, [
          damage,
          {
            byte,
            deleteBytes: Buffer.byteLength(insert),
            insert: source[byte],
          },
        ]),
        `seeded history ${index}`,
      );
    }
  });

  test(`${name}: a local edit reuses unchanged command lists`, () => {
    const source = "s/a/b/g\n".repeat(100);
    const edit = { byte: 402, deleteBytes: 1, insert: "c" };
    const expected = parseSuccessfully(scope, applyEdits(source, [edit]));
    assertIncrementalContract(
      expected,
      parse(scope, source, [edit]),
      "middle command",
    );
    assert.ok(relexedTokens(scope, source, [edit]) < 80);
  });
}
