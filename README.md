# tree-sitter-posix-sed

[![CI](https://github.com/konomanoasa/tree-sitter-posix-sed/actions/workflows/ci.yaml/badge.svg)](https://github.com/konomanoasa/tree-sitter-posix-sed/actions/workflows/ci.yaml)
[![crates.io](https://img.shields.io/crates/v/konomanoasa-tree-sitter-posix-sed)](https://crates.io/crates/konomanoasa-tree-sitter-posix-sed)
[![npm](https://img.shields.io/npm/v/@konomanoasa/tree-sitter-posix-sed)](https://www.npmjs.com/package/@konomanoasa/tree-sitter-posix-sed)

[Tree-sitter](https://tree-sitter.github.io/tree-sitter/) grammars for
POSIX.1-2024 sed.

For GNU sed, see [tree-sitter-sed](https://github.com/konomanoasa/tree-sitter-sed).

## Installation

```sh
npm install @konomanoasa/tree-sitter-posix-sed
```

## Parsing Option

For POSIX ERE parsing, use `posix_sed_ere`.

## Development

```sh
npm install
npm run build
npm test
```

## Specifications

- [POSIX.1-2024 sed](https://pubs.opengroup.org/onlinepubs/9799919799.2024edition/utilities/sed.html)
- [POSIX.1-2024 regular expressions](https://pubs.opengroup.org/onlinepubs/9799919799.2024edition/basedefs/V1_chap09.html)

## License

[MIT](LICENSE)

## Used By

[sed-ts-mode](https://github.com/konomanoasa/sed-ts-mode)
