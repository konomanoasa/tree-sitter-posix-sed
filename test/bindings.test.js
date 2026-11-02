import assert from "node:assert/strict";
import { test } from "node:test";
import { posix_sed, posix_sed_ere } from "@konomanoasa/tree-sitter-posix-sed";
import Parser from "tree-sitter";

const cases = [
  { name: "posix_sed", language: posix_sed, source: String.raw`/a\+/p` },
  { name: "posix_sed_ere", language: posix_sed_ere, source: "/a+/p" },
];

for (const { name, language, source } of cases) {
  test(`Node.js ${name} parses its syntax with the scanner and exposes node metadata and highlights`, () => {
    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(source);
    assert.equal(tree.rootNode.type, "script");
    assert.equal(tree.rootNode.hasError, false);
    assert.equal(tree.rootNode.text, source);
    assert.equal(tree.rootNode.descendantsOfType("syntax_issue").length, 0);
    assert.ok(
      language.nodeTypeInfo.some(
        (node) => node.type === "script" && node.named,
      ),
    );
    const query = new Parser.Query(language, language.HIGHLIGHTS_QUERY);
    assert.deepEqual(
      query
        .captures(tree.rootNode)
        .filter(({ name }) => name === "keyword")
        .map(({ name, node }) => [name, node.text]),
      [["keyword", "p"]],
    );
  });
}
