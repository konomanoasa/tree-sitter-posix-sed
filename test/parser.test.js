import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { grammars } from "../scripts/tree-sitter.js";
import { parse, parseSuccessfully } from "./support/parser.js";

const runtimeTimeoutMs = 5_000;

for (const { name, scope } of grammars) {
  test(`${name}: empty commands end only at real separators`, () => {
    for (const { source, offsets } of [
      { source: ";;p", offsets: [0, 1] },
      { source: "p;;", offsets: [2] },
      { source: "p;", offsets: [] },
      { source: " \t", offsets: [] },
      { source: "{;\n}", offsets: [1, 2] },
      { source: "p;\n", offsets: [2] },
    ]) {
      assert.deepEqual(
        parseSuccessfully(scope, source)
          .nodes.filter(({ kind }) => kind === "empty_command")
          .map(({ startByte, endByte }) => [startByte, endByte]),
        offsets.map((offset) => [offset, offset]),
        source,
      );
    }
  });

  test(`${name}: arbitrary decoded delimiters keep their source width`, () => {
    for (const delimiter of ["/", "@", "é", "😀"]) {
      const source = `s${delimiter}a${delimiter}b${delimiter}`;
      const width = Buffer.byteLength(delimiter);
      assert.deepEqual(
        parseSuccessfully(scope, source)
          .nodes.filter(({ kind }) => kind === "delimiter")
          .map(({ startByte, endByte }) => [startByte, endByte]),
        [
          [1, 1 + width],
          [2 + width, 2 + 2 * width],
          [3 + 2 * width, 3 + 3 * width],
        ],
      );
    }
  });

  test(`${name}: decoded replacement characters are distinct from malformed bytes`, () => {
    for (const [opening, closing] of [
      [":", "\n"],
      ["r ", "\n"],
      ["#n ", "\n"],
      ["a\\\n", "\n"],
      ["s/a/", "/"],
      ["y/", "/a/"],
      ["/", "/p"],
      ["/[", "]/p"],
    ]) {
      parseSuccessfully(scope, `${opening}é\uFFFD😀${closing}`);
      for (const bytes of [
        Buffer.from([0]),
        Buffer.from([0xff]),
        Buffer.from([0xc0, 0x80]),
        Buffer.from([0xed, 0xa0, 0x80]),
      ]) {
        const source = Buffer.concat([
          Buffer.from(opening),
          bytes,
          Buffer.from(closing),
        ]);
        assert.equal(
          parse(scope, source).hasError,
          true,
          source.toString("hex"),
        );
      }
    }
  });

  test(`${name}: numeric radix changes preserve separate byte atoms and escape ranges`, () => {
    for (const { bytes, character } of [
      { bytes: [0xc2, 0x80], character: "\u0080" },
      { bytes: [0xdf, 0xbf], character: "\u07ff" },
      { bytes: [0xe0, 0xa0, 0x80], character: "\u0800" },
      { bytes: [0xed, 0x9f, 0xbf], character: "\ud7ff" },
      { bytes: [0xee, 0x80, 0x80], character: "\ue000" },
      { bytes: [0xf0, 0x90, 0x80, 0x80], character: "\u{10000}" },
      { bytes: [0xf4, 0x8f, 0xbf, 0xbf], character: "\u{10ffff}" },
    ]) {
      for (const { prefix, radix } of [
        { prefix: "x", radix: 16 },
        { prefix: "o", radix: 8 },
        { prefix: "d", radix: 10 },
      ]) {
        const escapes = bytes.map(
          (byte) => `\\${prefix}${byte.toString(radix)}`,
        );
        const pattern = escapes.join("");
        const bracketSource = `s/[${pattern}]/X/`;
        const bracket = parseSuccessfully(scope, bracketSource);
        assert.deepEqual(
          bracket.nodes
            .filter(({ kind }) => kind === "collating_element_single")
            .map(({ startByte, endByte }) =>
              bracketSource.slice(startByte, endByte),
            ),
          [...pattern],
          bracketSource,
        );
        const ere = name.endsWith("_ere");
        for (const repetition of ["*", ere ? "{2}" : "\\{2\\}"]) {
          const source = `s/${pattern}${repetition}/X/`;
          const { nodes } = parseSuccessfully(scope, source);
          const atoms = nodes.filter(
            ({ kind }) =>
              kind ===
              (ere ? "one_char_or_coll_elem_ere" : "one_char_or_coll_elem_bre"),
          );
          assert.equal(atoms.length, escapes.length, source);
          let start = 2;
          for (const [index, spelling] of escapes.entries()) {
            const atom = atoms[index];
            assert.deepEqual(
              [atom.startByte, atom.endByte],
              [start, start + spelling.length],
              source,
            );
            const leaves = nodes.filter(
              ({ parent }) => parent === nodes.indexOf(atom),
            );
            assert.deepEqual(
              leaves.map(({ kind, startByte, endByte }) => [
                kind,
                startByte,
                endByte,
              ]),
              [["sed_character_escape", start, start + spelling.length]],
              source,
            );
            start += spelling.length;
          }
          const atom = atoms.at(-1);
          const owner = ere
            ? nodes[atom.parent]
            : nodes[nodes[atom.parent].parent];
          const operator = nodes.find(
            ({ kind }) =>
              kind === (ere ? "ere_dupl_symbol" : "bre_dupl_symbol"),
          );
          assert.equal(operator?.parent, nodes.indexOf(owner), source);
          assert.deepEqual(
            [operator?.startByte, operator?.endByte],
            [start, start + repetition.length],
            source,
          );
          const literal = parseSuccessfully(
            scope,
            `s/${character}${repetition}/X/`,
          );
          assert.equal(
            literal.nodes.filter(({ kind }) => kind === atom.kind).length,
            1,
          );
        }
      }
    }
  });

  test(`${name}: repeated parses reject incomplete structures`, () => {
    for (const source of [
      "{p",
      "r ",
      "s/a/b",
      "a\\",
      "/[a/p",
      "/[[:alpha:]/p",
    ]) {
      assert.equal(parse(scope, source).hasError, true, source);
    }
  });
}

test("GNU sed 4.10 observations support the adopted POSIX boundary decisions", (t) => {
  const executable = process.env.GNU_SED ?? "gsed";
  const version = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    timeout: runtimeTimeoutMs,
  });
  if (
    version.error &&
    "code" in version.error &&
    version.error.code === "ENOENT"
  ) {
    t.skip("GNU sed 4.10 is not installed");
    return;
  }
  assert.ifError(version.error);
  assert.equal(version.status, 0);
  assert.match(version.stdout, /^.+ [(]GNU sed[)] 4[.]10$/m);
  const locale = "C";
  const env = { ...process.env };
  env.LC_ALL = locale;
  env.LANG = locale;
  delete env.POSIXLY_CORRECT;
  for (const { name, scope } of grammars) {
    const ere = name.endsWith("_ere");
    for (const { source, runtimeStatus, accepted, input = "", output = "" } of [
      {
        source: "s/\\xc3\\xa9*/X/p",
        runtimeStatus: 0,
        accepted: true,
        input: "éé\n",
        output: "Xé\n",
      },
      {
        source: ere ? "s/\\xc3\\xa9{2}/X/p" : "s/\\xc3\\xa9\\{2\\}/X/p",
        runtimeStatus: 0,
        accepted: true,
        input: "éé\n",
        output: "",
      },
      {
        source: String.raw`s/[\xc3\xa9]/X/gp`,
        runtimeStatus: 0,
        accepted: true,
        input: "é\n",
        output: "XX\n",
      },
      { source: "séaébég", runtimeStatus: 1, accepted: true },
      { source: "/[:alpha:]/p", runtimeStatus: 4, accepted: true },
      { source: "/[^:alpha:]/p", runtimeStatus: 4, accepted: true },
      { source: "/[a-c-e]/p", runtimeStatus: 1, accepted: false },
      { source: "/[a-[=c=]]/p", runtimeStatus: 1, accepted: false },
      { source: "s/a/b/gg", runtimeStatus: 1, accepted: true },
      { source: "s/a/b/pp", runtimeStatus: 1, accepted: true },
      { source: "s/a/b/1g2", runtimeStatus: 1, accepted: true },
      { source: "s/a/b/000", runtimeStatus: 1, accepted: true },
      { source: "s/a/b/g2", runtimeStatus: 0, accepted: true },
      { source: "p \t", runtimeStatus: 0, accepted: true },
      { source: "{p}", runtimeStatus: 0, accepted: false },
      { source: "{b}", runtimeStatus: 0, accepted: false },
      { source: "{t}", runtimeStatus: 0, accepted: false },
      { source: "{:x}", runtimeStatus: 0, accepted: false },
      { source: ":abcdefghijk", runtimeStatus: 0, accepted: true },
      {
        source: ere ? "s/()/x/" : "s/\\(\\)/x/",
        runtimeStatus: 0,
        accepted: true,
      },
      {
        source: ere ? "s/|a||/x/" : "s/\\|a\\|\\|/x/",
        runtimeStatus: 0,
        accepted: true,
      },
      { source: ere ? "/a}/p" : "/a\\}/p", runtimeStatus: 0, accepted: true },
      { source: "s/a/\\c\\./", runtimeStatus: 1, accepted: false },
    ]) {
      const observed = spawnSync(
        executable,
        [...(ere ? ["-E"] : []), "-n", "-e", source],
        {
          env,
          input,
          encoding: "utf8",
          timeout: runtimeTimeoutMs,
        },
      );
      assert.ifError(observed.error);
      assert.equal(
        observed.status,
        runtimeStatus,
        `${locale}: ${source}${observed.stderr}`,
      );
      assert.equal(observed.stdout, output, source);
      assert.equal(
        parse(scope, source).hasError,
        !accepted,
        `${name}: ${source}`,
      );
    }
  }
});
