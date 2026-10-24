#define SED_REGEX_EXTENDED 1
#include "../../common/scanner.h"

void *tree_sitter_posix_sed_ere_external_scanner_create(void) {
  return sed_scanner_create();
}

void tree_sitter_posix_sed_ere_external_scanner_destroy(void *payload) {
  sed_scanner_destroy(payload);
}

unsigned tree_sitter_posix_sed_ere_external_scanner_serialize(
  void *payload,
  char *buffer
) {
  return sed_scanner_serialize(payload, buffer);
}

void tree_sitter_posix_sed_ere_external_scanner_deserialize(
  void *payload,
  const char *buffer,
  unsigned length
) {
  sed_scanner_deserialize(payload, buffer, length);
}

bool tree_sitter_posix_sed_ere_external_scanner_scan(
  void *payload,
  TSLexer *lexer,
  const bool *valid_symbols
) {
  return sed_scanner_scan(payload, lexer, valid_symbols);
}
