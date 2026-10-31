import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  createTreeSitter,
  grammars,
  packageName,
  root,
} from "../scripts/tree-sitter.js";

const highlightTimeoutMs = 60_000;
const firstCaptureColor = 17;
const newlineByte = 0x0a;

function decodeEntities(text) {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

function renderedCaptures(html, source) {
  const start = html.indexOf("<pre><code>");
  const end = html.indexOf("</code></pre>");
  assert.ok(start >= 0 && end >= start, html);
  const content = html.slice(start + "<pre><code>".length, end);
  const stack = [];
  const captures = [];
  let text = "";
  for (const part of content.matchAll(
    /<span class='([^']*)'>|<[/]span>|([^<]+)/g,
  )) {
    if (part[1] !== undefined) stack.push(part[1].replaceAll(" ", "."));
    else if (part[0] === "</span>") assert.notEqual(stack.pop(), undefined);
    else {
      const decoded = decodeEntities(part[2]);
      text += decoded;
      captures.push(
        ...Array(Buffer.byteLength(decoded)).fill(stack.at(-1) ?? ""),
      );
    }
  }
  assert.equal(stack.length, 0, "unclosed highlight span");
  assert.equal(
    text.replace(/\n$/, ""),
    source.replace(/\n$/, ""),
    "rendered source differs from the input",
  );
  return captures;
}

function createHighlighter({ directory, root, run, captureNames }) {
  const parserDirectory = join(directory, "parsers");
  mkdirSync(parserDirectory);
  symlinkSync(root, join(parserDirectory, "tree-sitter-test"), "junction");
  const configPath = join(directory, "highlight.json");
  const capturePath = join(directory, "captures.txt");
  writeFileSync(
    configPath,
    JSON.stringify({
      "parser-directories": [parserDirectory],
      theme: Object.fromEntries(
        captureNames.map((name, index) => [name, index + firstCaptureColor]),
      ),
    }),
  );
  writeFileSync(capturePath, `${captureNames.join("\n")}\n`);

  return (scope, source, valid = true) => {
    const path = join(directory, "highlight.txt");
    writeFileSync(path, source);
    if (valid) {
      const parsed = run(["parse", "--cst", "--scope", scope, path]);
      assert.doesNotMatch(parsed, /^[0-9: \t-]+•/m, parsed);
    }
    const captures = renderedCaptures(
      run([
        "highlight",
        "--check",
        "--captures-path",
        capturePath,
        "--config-path",
        configPath,
        "--html",
        "--layout",
        "fragment",
        "--style",
        "classes",
        "--scope",
        scope,
        path,
      ]),
      source,
    );
    for (const capture of captures) {
      assert.ok(
        capture === "" || captureNames.includes(capture),
        `unexpected final capture: ${capture}`,
      );
    }
    return captures;
  };
}

function assertCaptures(source, actual, ranges) {
  const bytes = Buffer.from(source);
  const expected = Array(bytes.length).fill("");
  let previousEnd = 0;
  for (const [start, end, capture] of ranges) {
    assert.ok(
      Number.isSafeInteger(start) && start >= previousEnd,
      "expected ranges must be ordered and disjoint",
    );
    assert.ok(
      Number.isSafeInteger(end) && end > start && end <= bytes.length,
      "expected range exceeds source bytes",
    );
    expected.fill(capture, start, end);
    previousEnd = end;
  }
  for (const [index, byte] of bytes.entries()) {
    if (byte !== newlineByte)
      assert.equal(
        actual[index],
        expected[index],
        `byte ${index} in ${JSON.stringify(source)}`,
      );
  }
}

const captureNames = [
  "character.special",
  "comment",
  "constant.builtin",
  "keyword",
  "keyword.directive",
  "keyword.modifier",
  "label",
  "number",
  "operator",
  "punctuation.bracket",
  "punctuation.delimiter",
  "punctuation.special",
  "string",
  "string.escape",
  "string.regexp",
  "string.special.path",
  "string.special.symbol",
];
let highlight;

let directory;
let runner;
before(() => {
  directory = mkdtempSync(join(tmpdir(), `${packageName}-highlight-`));
  runner = createTreeSitter();
  highlight = createHighlighter({
    directory,
    root,
    run: assertCommand,
    captureNames,
  });
  for (const grammar of grammars) {
    const query = grammar.highlights
      .map((path) => readFileSync(join(root, path), "utf8"))
      .join("\n");
    writeFileSync(join(directory, `${grammar.name}.scm`), query);
  }
});
after(() => {
  try {
    runner?.close();
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

function assertCommand(arguments_) {
  const result = runner.run(arguments_, {
    timeout: highlightTimeoutMs,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stderr, /Non-standard highlight captures/);
  return result.stdout;
}

const finalCaptureCases = [
  {
    name: "label captures stop at comments and preserve long Unicode names",
    source: ":abcdefghi\nb a@#$b\nt é\n",
    captures: [
      [0, 1, "keyword"],
      [1, 10, "label"],
      [11, 12, "keyword"],
      [13, 15, "label"],
      [15, 18, "comment"],
      [19, 20, "keyword"],
      [21, 23, "label"],
    ],
  },
  {
    name: "HTML-sensitive Unicode literals retain source bytes and captures",
    source: `s/é😀<&>"'/x/\n`,
    captures: [
      [0, 1, "keyword"],
      [1, 2, "punctuation.delimiter"],
      [2, 13, "string.regexp"],
      [13, 14, "punctuation.delimiter"],
      [14, 15, "string"],
      [15, 16, "punctuation.delimiter"],
    ],
  },
  {
    name: "empty input has no captures",
    source: "",
    captures: [],
  },
  {
    name: "the initial output-suppression directive overrides comment captures",
    source: "#n é\n",
    captures: [
      [0, 2, "keyword.directive"],
      [2, 5, "comment"],
    ],
  },
  {
    name: "ordinary UTF-8 comments retain comment captures",
    source: "# é😀\n",
    captures: [[0, 8, "comment"]],
  },
  {
    name: "block braces override function captures beside addresses and negation",
    source: "1,$!{p;d;}\n",
    captures: [
      [0, 1, "number"],
      [1, 2, "punctuation.delimiter"],
      [2, 3, "constant.builtin"],
      [3, 4, "operator"],
      [4, 5, "punctuation.bracket"],
      [5, 6, "keyword"],
      [6, 7, "punctuation.delimiter"],
      [7, 8, "keyword"],
      [8, 9, "punctuation.delimiter"],
      [9, 10, "punctuation.bracket"],
    ],
  },
  {
    name: "branch targets and declarations retain label captures",
    source: "b end\nt end\n:end\n",
    captures: [
      [0, 1, "keyword"],
      [2, 5, "label"],
      [6, 7, "keyword"],
      [8, 11, "label"],
      [12, 13, "keyword"],
      [13, 16, "label"],
    ],
  },
  {
    name: "substitutions separate patterns, UTF-8 replacements, references and flags",
    source: "s/a/é😀&/gp\n",
    captures: [
      [0, 1, "keyword"],
      [1, 2, "punctuation.delimiter"],
      [2, 3, "string.regexp"],
      [3, 4, "punctuation.delimiter"],
      [4, 10, "string"],
      [10, 11, "string.special.symbol"],
      [11, 12, "punctuation.delimiter"],
      [12, 14, "keyword.modifier"],
    ],
  },
  {
    name: "file operands keep path captures after the function verb",
    source: "r file\nw out\n",
    captures: [
      [0, 1, "keyword"],
      [2, 6, "string.special.path"],
      [7, 8, "keyword"],
      [9, 12, "string.special.path"],
    ],
  },
  {
    name: "ordinary and substitution write files retain semicolons in path captures",
    source: "w a b;p\ns/a/b/w c d;p\n",
    captures: [
      [0, 1, "keyword"],
      [2, 7, "string.special.path"],
      [8, 9, "keyword"],
      [9, 10, "punctuation.delimiter"],
      [10, 11, "string.regexp"],
      [11, 12, "punctuation.delimiter"],
      [12, 13, "string"],
      [13, 14, "punctuation.delimiter"],
      [14, 15, "keyword.modifier"],
      [16, 21, "string.special.path"],
    ],
  },
  {
    name: "ERE groups and intervals retain punctuation and replacement references",
    languages: ["posix_sed_ere"],
    source: "s/(a){2,3}/\\1/\n",
    captures: [
      [0, 1, "keyword"],
      [1, 2, "punctuation.delimiter"],
      [2, 3, "punctuation.bracket"],
      [3, 4, "string.regexp"],
      [4, 6, "punctuation.bracket"],
      [6, 7, "number"],
      [7, 8, "punctuation.delimiter"],
      [8, 9, "number"],
      [9, 10, "punctuation.bracket"],
      [10, 11, "punctuation.delimiter"],
      [11, 13, "string.special.symbol"],
      [13, 14, "punctuation.delimiter"],
    ],
  },
  {
    name: "multibyte delimiters retain complete byte ranges",
    source: "sλaλbλ\n",
    captures: [
      [0, 1, "keyword"],
      [1, 3, "punctuation.delimiter"],
      [3, 4, "string.regexp"],
      [4, 6, "punctuation.delimiter"],
      [6, 7, "string"],
      [7, 9, "punctuation.delimiter"],
    ],
  },
  {
    name: "escaped ampersand delimiters keep escape captures in replacements",
    source: "s&x&\\&&\n",
    captures: [
      [0, 1, "keyword"],
      [1, 2, "punctuation.delimiter"],
      [2, 3, "string.regexp"],
      [3, 4, "punctuation.delimiter"],
      [4, 6, "string.escape"],
      [6, 7, "punctuation.delimiter"],
    ],
  },
  {
    name: "output suppression also precedes comment text without a blank",
    source: "#note\n",
    captures: [
      [0, 2, "keyword.directive"],
      [2, 5, "comment"],
    ],
  },
  {
    name: "addresses and negation precede a simple command",
    source: "1,$!p;\n",
    captures: [
      [0, 1, "number"],
      [1, 2, "punctuation.delimiter"],
      [2, 3, "constant.builtin"],
      [3, 4, "operator"],
      [4, 5, "keyword"],
      [5, 6, "punctuation.delimiter"],
    ],
  },
  {
    name: "alternate address delimiters separate the introducer and escaped delimiter",
    source: "\\%a\\%%p\n",
    captures: [
      [0, 1, "string.escape"],
      [1, 2, "punctuation.delimiter"],
      [2, 3, "string.regexp"],
      [3, 5, "string.escape"],
      [5, 6, "punctuation.delimiter"],
      [6, 7, "keyword"],
    ],
  },
  {
    name: "BRE groups, wildcards, intervals and anchors precede references and write flags",
    source: "s/\\(a.\\)\\{2,3\\}$/\\1&x/gipw output\n",
    captures: [
      [0, 1, "keyword"],
      [1, 2, "punctuation.delimiter"],
      [2, 4, "punctuation.bracket"],
      [4, 5, "string.regexp"],
      [5, 6, "character.special"],
      [6, 10, "punctuation.bracket"],
      [10, 11, "number"],
      [11, 12, "punctuation.delimiter"],
      [12, 13, "number"],
      [13, 15, "punctuation.bracket"],
      [15, 16, "operator"],
      [16, 17, "punctuation.delimiter"],
      [17, 20, "string.special.symbol"],
      [20, 21, "string"],
      [21, 22, "punctuation.delimiter"],
      [22, 26, "keyword.modifier"],
      [27, 33, "string.special.path"],
    ],
    languages: ["posix_sed"],
  },
  {
    name: "numeric byte atoms retain escape captures before repetition",
    source: "s/\\xc3\\xa9*/X/",
    captures: [
      [0, 1, "keyword"],
      [1, 2, "punctuation.delimiter"],
      [2, 10, "string.escape"],
      [10, 11, "operator"],
      [11, 12, "punctuation.delimiter"],
      [12, 13, "string"],
      [13, 14, "punctuation.delimiter"],
    ],
  },
  {
    name: "adopted ordinary RE and replacement escapes receive escape captures",
    source: "s/\\q/\\q/\n",
    captures: [
      [0, 1, "keyword"],
      [1, 2, "punctuation.delimiter"],
      [2, 4, "string.escape"],
      [4, 5, "punctuation.delimiter"],
      [5, 7, "string.escape"],
      [7, 8, "punctuation.delimiter"],
    ],
  },
  {
    name: "literal and control text escapes receive escape captures",
    source: "a\\\n\\q\\n\n",
    captures: [
      [0, 1, "keyword"],
      [1, 3, "punctuation.special"],
      [3, 7, "string.escape"],
    ],
  },
  {
    name: "quoted metacharacters retain escape captures",
    source: "/a\\./p\n",
    captures: [
      [0, 1, "punctuation.delimiter"],
      [1, 2, "string.regexp"],
      [2, 4, "string.escape"],
      [4, 5, "punctuation.delimiter"],
      [5, 6, "keyword"],
    ],
  },
  {
    name: "replacement ampersands and backslashes retain escape captures",
    source: "s|a|\\&\\\\|\n",
    captures: [
      [0, 1, "keyword"],
      [1, 2, "punctuation.delimiter"],
      [2, 3, "string.regexp"],
      [3, 4, "punctuation.delimiter"],
      [4, 8, "string.escape"],
      [8, 9, "punctuation.delimiter"],
    ],
  },
  {
    name: "substitution occurrences retain number captures",
    source: "s/a/b/2\n",
    captures: [
      [0, 1, "keyword"],
      [1, 2, "punctuation.delimiter"],
      [2, 3, "string.regexp"],
      [3, 4, "punctuation.delimiter"],
      [4, 5, "string"],
      [5, 6, "punctuation.delimiter"],
      [6, 7, "number"],
    ],
  },
  {
    name: "translations separate literal characters and escapes",
    source: "y|a\\n\\||b\\\\c|\n",
    captures: [
      [0, 1, "keyword"],
      [1, 2, "punctuation.delimiter"],
      [2, 3, "string"],
      [3, 7, "string.escape"],
      [7, 8, "punctuation.delimiter"],
      [8, 9, "string"],
      [9, 11, "string.escape"],
      [11, 12, "string"],
      [12, 13, "punctuation.delimiter"],
    ],
  },
  {
    name: "bracket terms distinguish initial brackets, ranges and trailing hyphens",
    source: "/[^]a-c[:alpha:][.].][=a=]-]/p\n",
    captures: [
      [0, 1, "punctuation.delimiter"],
      [1, 2, "punctuation.bracket"],
      [2, 3, "operator"],
      [3, 5, "character.special"],
      [5, 6, "operator"],
      [6, 7, "character.special"],
      [7, 8, "punctuation.bracket"],
      [8, 9, "punctuation.delimiter"],
      [9, 14, "character.special"],
      [14, 15, "punctuation.delimiter"],
      [15, 17, "punctuation.bracket"],
      [17, 18, "punctuation.delimiter"],
      [18, 19, "character.special"],
      [19, 20, "punctuation.delimiter"],
      [20, 22, "punctuation.bracket"],
      [22, 23, "punctuation.delimiter"],
      [23, 24, "character.special"],
      [24, 25, "punctuation.delimiter"],
      [25, 26, "punctuation.bracket"],
      [26, 27, "string.regexp"],
      [27, 28, "punctuation.bracket"],
      [28, 29, "punctuation.delimiter"],
      [29, 30, "keyword"],
    ],
  },
  {
    name: "a range-ending hyphen keeps its literal capture",
    source: "/[%--]/p\n",
    captures: [
      [0, 1, "punctuation.delimiter"],
      [1, 2, "punctuation.bracket"],
      [2, 3, "character.special"],
      [3, 4, "operator"],
      [4, 5, "string.regexp"],
      [5, 6, "punctuation.bracket"],
      [6, 7, "punctuation.delimiter"],
      [7, 8, "keyword"],
    ],
  },
  {
    name: "ERE groups, alternation, quantifiers and write flags retain their lexical roles",
    source: "s/^(ab|c)+d{2,3}e?f*/x/gipw output\n",
    captures: [
      [0, 1, "keyword"],
      [1, 2, "punctuation.delimiter"],
      [2, 3, "operator"],
      [3, 4, "punctuation.bracket"],
      [4, 6, "string.regexp"],
      [6, 7, "operator"],
      [7, 8, "string.regexp"],
      [8, 9, "punctuation.bracket"],
      [9, 10, "operator"],
      [10, 11, "string.regexp"],
      [11, 12, "punctuation.bracket"],
      [12, 13, "number"],
      [13, 14, "punctuation.delimiter"],
      [14, 15, "number"],
      [15, 16, "punctuation.bracket"],
      [16, 17, "string.regexp"],
      [17, 18, "operator"],
      [18, 19, "string.regexp"],
      [19, 20, "operator"],
      [20, 21, "punctuation.delimiter"],
      [21, 22, "string"],
      [22, 23, "punctuation.delimiter"],
      [23, 27, "keyword.modifier"],
      [28, 34, "string.special.path"],
    ],
    languages: ["posix_sed_ere"],
  },
  {
    name: "newline separated commands retain only keyword captures",
    source: "p\np\n",
    captures: [
      [0, 1, "keyword"],
      [2, 3, "keyword"],
    ],
  },
  {
    name: "text introducers separate line continuations from literal text",
    source: "a\\\ntext\n",
    captures: [
      [0, 1, "keyword"],
      [1, 3, "punctuation.special"],
      [3, 7, "string"],
    ],
  },
  {
    name: "character class complete closing delimiter",
    source: "s/[[:alpha:]]/x/",
    captures: [
      [0, 1, "keyword"],
      [1, 2, "punctuation.delimiter"],
      [2, 4, "punctuation.bracket"],
      [4, 5, "punctuation.delimiter"],
      [5, 10, "character.special"],
      [10, 11, "punctuation.delimiter"],
      [11, 13, "punctuation.bracket"],
      [13, 14, "punctuation.delimiter"],
      [14, 15, "string"],
      [15, 16, "punctuation.delimiter"],
    ],
  },
  {
    name: "collating symbol complete closing delimiter",
    source: "s/[[.a.]]/x/",
    captures: [
      [0, 1, "keyword"],
      [1, 2, "punctuation.delimiter"],
      [2, 4, "punctuation.bracket"],
      [4, 5, "punctuation.delimiter"],
      [5, 6, "character.special"],
      [6, 7, "punctuation.delimiter"],
      [7, 9, "punctuation.bracket"],
      [9, 10, "punctuation.delimiter"],
      [10, 11, "string"],
      [11, 12, "punctuation.delimiter"],
    ],
  },
  {
    name: "equivalence class complete closing delimiter",
    source: "s/[[=a=]]/x/",
    captures: [
      [0, 1, "keyword"],
      [1, 2, "punctuation.delimiter"],
      [2, 4, "punctuation.bracket"],
      [4, 5, "punctuation.delimiter"],
      [5, 6, "character.special"],
      [6, 7, "punctuation.delimiter"],
      [7, 9, "punctuation.bracket"],
      [9, 10, "punctuation.delimiter"],
      [10, 11, "string"],
      [11, 12, "punctuation.delimiter"],
    ],
  },
  {
    name: "closing brackets inside multi-character collating elements keep element captures",
    source: "/[[.a]b.]][[=c]d=]]/p\n",
    captures: [
      [0, 1, "punctuation.delimiter"],
      [1, 3, "punctuation.bracket"],
      [3, 4, "punctuation.delimiter"],
      [4, 7, "character.special"],
      [7, 8, "punctuation.delimiter"],
      [8, 12, "punctuation.bracket"],
      [12, 13, "punctuation.delimiter"],
      [13, 16, "character.special"],
      [16, 17, "punctuation.delimiter"],
      [17, 19, "punctuation.bracket"],
      [19, 20, "punctuation.delimiter"],
      [20, 21, "keyword"],
    ],
  },
  {
    name: "class names retain their source spelling and captures",
    source: "s/[[:Alpha:]]/x/\n",
    captures: [
      [0, 1, "keyword"],
      [1, 2, "punctuation.delimiter"],
      [2, 4, "punctuation.bracket"],
      [4, 5, "punctuation.delimiter"],
      [5, 10, "character.special"],
      [10, 11, "punctuation.delimiter"],
      [11, 13, "punctuation.bracket"],
      [13, 14, "punctuation.delimiter"],
      [14, 15, "string"],
      [15, 16, "punctuation.delimiter"],
    ],
  },
  {
    name: "BRE additional operators retain operator captures",
    source: "/a*\\|b\\+c\\?\\n/p\n",
    captures: [
      [0, 1, "punctuation.delimiter"],
      [1, 2, "string.regexp"],
      [2, 5, "operator"],
      [5, 6, "string.regexp"],
      [6, 8, "operator"],
      [8, 9, "string.regexp"],
      [9, 11, "operator"],
      [11, 13, "string.escape"],
      [13, 14, "punctuation.delimiter"],
      [14, 15, "keyword"],
    ],
    languages: ["posix_sed"],
  },
  {
    name: "BRE interval commas preserve delimiter escape captures",
    source: "s,a\\{1\\,2\\},b,",
    captures: [
      [0, 1, "keyword"],
      [1, 2, "punctuation.delimiter"],
      [2, 3, "string.regexp"],
      [3, 5, "punctuation.bracket"],
      [5, 6, "number"],
      [6, 8, "string.escape"],
      [8, 9, "number"],
      [9, 11, "punctuation.bracket"],
      [11, 12, "punctuation.delimiter"],
      [12, 13, "string"],
      [13, 14, "punctuation.delimiter"],
    ],
    languages: ["posix_sed"],
  },
  {
    name: "ERE interval digits preserve delimiter escape captures",
    source: "s1a{\\12}1b1",
    captures: [
      [0, 1, "keyword"],
      [1, 2, "punctuation.delimiter"],
      [2, 3, "string.regexp"],
      [3, 4, "punctuation.bracket"],
      [4, 6, "string.escape"],
      [6, 7, "number"],
      [7, 8, "punctuation.bracket"],
      [8, 9, "punctuation.delimiter"],
      [9, 10, "string"],
      [10, 11, "punctuation.delimiter"],
    ],
    languages: ["posix_sed_ere"],
  },
];

for (const grammar of grammars) {
  for (const {
    name,
    languages,
    source,
    captures,
    valid = true,
  } of finalCaptureCases) {
    if (languages && !languages.includes(grammar.name)) continue;
    test(`${grammar.name}: ${name}`, () => {
      assertCaptures(source, highlight(grammar.scope, source, valid), captures);
    });
  }
  test(`${grammar.name}: incomplete input preserves source without error colors`, () => {
    for (const source of ["s/a", "/[a", "{p", "s/a/\\"]) {
      highlight(grammar.scope, source, false);
    }
  });
}
