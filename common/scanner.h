#ifndef TREE_SITTER_SED_COMMON_SCANNER_H_
#define TREE_SITTER_SED_COMMON_SCANNER_H_

#ifndef SED_REGEX_EXTENDED
#error "SED_REGEX_EXTENDED must be defined before including scanner.h"
#endif
#include "tokens.h"
#include "tree_sitter/alloc.h"
#include "tree_sitter/parser.h"

#include <stdbool.h>
#include <stdint.h>

enum ScannerMode {
  MODE_NONE,
  MODE_REGEX_ADDRESS,
  MODE_SUBSTITUTE_PATTERN,
  MODE_SUBSTITUTE_REPLACEMENT,
  MODE_TRANSLATE_SOURCE,
  MODE_TRANSLATE_DESTINATION,
  MODE_TEXT,
};

enum RegexState {
  REGEX_OUTSIDE_BRACKET,
  REGEX_BRACKET_FIRST,
  REGEX_BRACKET_AFTER_CARET,
  REGEX_BRACKET_BODY,
};

enum RegexPosition {
  REGEX_AFTER_ATOM,
  REGEX_AT_BRANCH_START,
#if SED_REGEX_EXTENDED
  REGEX_AFTER_ALTERNATION,
#else
  REGEX_AFTER_ANCHOR,
#endif
  REGEX_AFTER_DUPLICATION_SYMBOL,
#if SED_REGEX_EXTENDED
  REGEX_AFTER_REPETITION_MODIFIER,
#endif
};

enum RegexBracketTermState {
  REGEX_BRACKET_TERM_NONE,
  REGEX_BRACKET_TERM_COLON,
  REGEX_BRACKET_TERM_DOT,
  REGEX_BRACKET_TERM_EQUAL,
};

enum RegexBracketPendingElement {
  REGEX_BRACKET_PENDING_NONE,
  REGEX_BRACKET_PENDING_OTHER,
  REGEX_BRACKET_PENDING_DOT,
  REGEX_BRACKET_PENDING_EQUAL,
  REGEX_BRACKET_PENDING_COLON,
};

typedef struct {
  int32_t delimiter;
  enum ScannerMode mode;
  enum RegexState regex_state;
  enum RegexPosition regex_position;
  bool text_line_has_content;
  bool regex_in_interval;
  enum RegexBracketTermState regex_bracket_term_state;
  bool regex_bracket_term_has_content;
  enum RegexBracketPendingElement regex_bracket_pending_element;
  enum RegexBracketPendingElement regex_bracket_first_element;
  enum RegexBracketPendingElement regex_bracket_last_element;
  uint8_t regex_bracket_element_count;
  bool regex_bracket_range_pending;
  uint32_t regex_group_depth;
} ScannerState;

enum { SCANNER_SERIALIZED_STATE_SIZE = 17 };

enum {
  SERIALIZED_TEXT_HAS_CONTENT_FLAG = 1 << 0,
  SERIALIZED_IN_INTERVAL_FLAG = 1 << 1,
  SERIALIZED_BRACKET_TERM_HAS_CONTENT_FLAG = 1 << 2,
  SERIALIZED_RANGE_PENDING_FLAG = 1 << 3,
};

static void
reset_bracket_tracking(ScannerState *state, enum RegexState regex_state) {
  state->regex_state = regex_state;
  state->regex_bracket_term_state = REGEX_BRACKET_TERM_NONE;
  state->regex_bracket_term_has_content = false;
  state->regex_bracket_pending_element = REGEX_BRACKET_PENDING_NONE;
  state->regex_bracket_first_element = REGEX_BRACKET_PENDING_NONE;
  state->regex_bracket_last_element = REGEX_BRACKET_PENDING_NONE;
  state->regex_bracket_element_count = 0;
  state->regex_bracket_range_pending = false;
}

static bool is_regex_mode(enum ScannerMode mode) {
  return mode == MODE_REGEX_ADDRESS || mode == MODE_SUBSTITUTE_PATTERN;
}

static bool regex_at_branch_start(const ScannerState *state) {
  return state->regex_position == REGEX_AT_BRANCH_START ||
#if SED_REGEX_EXTENDED
    state->regex_position == REGEX_AFTER_ALTERNATION;
#else
    state->regex_position == REGEX_AFTER_ANCHOR;
#endif
}

static void reset_mode_tracking(ScannerState *state) {
  state->regex_position = REGEX_AFTER_ATOM;
  state->text_line_has_content = false;
  state->regex_in_interval = false;
  reset_bracket_tracking(state, REGEX_OUTSIDE_BRACKET);
  state->regex_group_depth = 0;
}

static void reset_state(ScannerState *state) {
  state->delimiter = 0;
  state->mode = MODE_NONE;
  reset_mode_tracking(state);
}

static void *sed_scanner_create(void) {
  return ts_calloc(1, sizeof(ScannerState));
}

static void sed_scanner_destroy(void *payload) {
  ts_free(payload);
}

static void serialize_uint32(char *buffer, unsigned offset, uint32_t value) {
  buffer[offset] = (char)(value & UINT32_C(0xff));
  buffer[offset + 1] = (char)((value >> 8) & UINT32_C(0xff));
  buffer[offset + 2] = (char)((value >> 16) & UINT32_C(0xff));
  buffer[offset + 3] = (char)((value >> 24) & UINT32_C(0xff));
}

static uint32_t deserialize_uint32(const char *buffer, unsigned offset) {
  return (uint32_t)(unsigned char)buffer[offset] |
    ((uint32_t)(unsigned char)buffer[offset + 1] << 8) |
    ((uint32_t)(unsigned char)buffer[offset + 2] << 16) |
    ((uint32_t)(unsigned char)buffer[offset + 3] << 24);
}

static unsigned sed_scanner_serialize(void *payload, char *buffer) {
  const ScannerState *state = payload;

  buffer[0] = (char)state->mode;
  buffer[1] = (char)state->regex_state;
  buffer[2] = (char)state->regex_position;
  buffer[3] =
    (state->text_line_has_content ? SERIALIZED_TEXT_HAS_CONTENT_FLAG : 0) |
    (state->regex_in_interval ? SERIALIZED_IN_INTERVAL_FLAG : 0) |
    (state->regex_bracket_term_has_content
        ? SERIALIZED_BRACKET_TERM_HAS_CONTENT_FLAG
        : 0) |
    (state->regex_bracket_range_pending ? SERIALIZED_RANGE_PENDING_FLAG : 0);
  serialize_uint32(buffer, 4, (uint32_t)state->delimiter);
  serialize_uint32(buffer, 8, state->regex_group_depth);
  buffer[12] = (char)state->regex_bracket_term_state;
  buffer[13] = (char)state->regex_bracket_pending_element;
  buffer[14] = (char)state->regex_bracket_first_element;
  buffer[15] = (char)state->regex_bracket_last_element;
  buffer[16] = (char)state->regex_bracket_element_count;
  // The default state must equal the empty state before the first external
  // token, or reuse fails after an edit that adds or removes external tokens.
  for (unsigned index = 0; index < SCANNER_SERIALIZED_STATE_SIZE; index++) {
    if (buffer[index] != 0) return SCANNER_SERIALIZED_STATE_SIZE;
  }
  return 0;
}

static void
sed_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
  ScannerState *state = payload;
  if (length == 0) {
    reset_state(state);
    return;
  }

  const unsigned char flags = (unsigned char)buffer[3];
  *state = (ScannerState){
    .mode = (enum ScannerMode)(unsigned char)buffer[0],
    .regex_state = (enum RegexState)(unsigned char)buffer[1],
    .regex_position = (enum RegexPosition)(unsigned char)buffer[2],
    .text_line_has_content = (flags & SERIALIZED_TEXT_HAS_CONTENT_FLAG) != 0,
    .regex_in_interval = (flags & SERIALIZED_IN_INTERVAL_FLAG) != 0,
    .regex_bracket_term_has_content =
      (flags & SERIALIZED_BRACKET_TERM_HAS_CONTENT_FLAG) != 0,
    .regex_bracket_range_pending = (flags & SERIALIZED_RANGE_PENDING_FLAG) != 0,
    .delimiter = (int32_t)deserialize_uint32(buffer, 4),
    .regex_group_depth = deserialize_uint32(buffer, 8),
    .regex_bracket_term_state =
      (enum RegexBracketTermState)(unsigned char)buffer[12],
    .regex_bracket_pending_element =
      (enum RegexBracketPendingElement)(unsigned char)buffer[13],
    .regex_bracket_first_element =
      (enum RegexBracketPendingElement)(unsigned char)buffer[14],
    .regex_bracket_last_element =
      (enum RegexBracketPendingElement)(unsigned char)buffer[15],
    .regex_bracket_element_count = (uint8_t)(unsigned char)buffer[16],
  };
}

static bool source_character_is_decoded(int32_t character) {
  const uint32_t code_point = (uint32_t)character;
  return code_point <= UINT32_C(0x10ffff) &&
    !(code_point >= UINT32_C(0xd800) && code_point <= UINT32_C(0xdfff));
}

static bool source_character_is_valid(int32_t character) {
  return character != 0 && source_character_is_decoded(character);
}

static bool delimiter_character_is_valid(int32_t character) {
  return source_character_is_valid(character) &&
    character != '\\' &&
    character != '\n';
}

static void advance(TSLexer *lexer) {
  lexer->advance(lexer, false);
}

static void consume(TSLexer *lexer) {
  advance(lexer);
  lexer->mark_end(lexer);
}

static void advance_unless_eof(TSLexer *lexer) {
  if (!lexer->eof(lexer)) {
    advance(lexer);
  }
}

static bool is_blank(int32_t character) {
  return character == ' ' || character == '\t';
}

static bool is_digit(int32_t character) {
  return character >= '0' && character <= '9';
}

static bool is_letter(int32_t character) {
  return (character >= 'a' && character <= 'z') ||
    (character >= 'A' && character <= 'Z');
}

static void advance_past_blanks(TSLexer *lexer) {
  while (is_blank(lexer->lookahead)) {
    advance(lexer);
  }
}

static bool at_line_end(const TSLexer *lexer) {
  return lexer->eof(lexer) || lexer->lookahead == '\n';
}

static bool at_line_character(const TSLexer *lexer) {
  return source_character_is_valid(lexer->lookahead) &&
    lexer->lookahead != '\n';
}

static bool scan_simple_delimiter(
  TSLexer *lexer,
  ScannerState *state,
  enum ScannerMode next_mode
) {
  if (!delimiter_character_is_valid(lexer->lookahead)) {
    return false;
  }

  state->delimiter = lexer->lookahead;
  state->mode = next_mode;
  reset_mode_tracking(state);
  state->regex_position =
    is_regex_mode(next_mode) ? REGEX_AT_BRANCH_START : REGEX_AFTER_ATOM;
  consume(lexer);
  return true;
}

static bool
emit_symbol(const bool *valid_symbols, TSSymbol candidate, TSSymbol *symbol) {
  if (!valid_symbols[candidate]) {
    return false;
  }

  *symbol = candidate;
  return true;
}

static bool consume_as(
  TSLexer *lexer,
  const bool *valid_symbols,
  TSSymbol candidate,
  TSSymbol *symbol
) {
  if (!emit_symbol(valid_symbols, candidate, symbol)) {
    return false;
  }
  consume(lexer);
  return true;
}

static bool consume_invalid_character(
  TSLexer *lexer,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  const bool nul = lexer->lookahead == 0;
  TSSymbol candidate = INVALID_CHARACTER;
  if (nul) {
    candidate = valid_symbols[SINGLE_NUL_CHARACTER] ? SINGLE_NUL_CHARACTER
                                                    : NUL_CHARACTER;
  }
  if (!emit_symbol(valid_symbols, candidate, symbol)) {
    return false;
  }
  do {
    consume(lexer);
  } while (
    candidate != SINGLE_NUL_CHARACTER &&
    !lexer->eof(lexer) &&
    (nul ? lexer->lookahead == 0
         : !source_character_is_decoded(lexer->lookahead))
  );
  if (!nul) {
    advance_unless_eof(lexer);
  }
  return true;
}

static bool end_mode(
  ScannerState *state,
  const bool *valid_symbols,
  TSSymbol candidate,
  TSSymbol *symbol
) {
  reset_state(state);
  return emit_symbol(valid_symbols, candidate, symbol);
}

static TSSymbol
dangling_escape_symbol(const TSLexer *lexer, TSSymbol at_end_of_source) {
  if (lexer->eof(lexer)) {
    return at_end_of_source;
  }
  return source_character_is_valid(lexer->lookahead) ? ERROR_SENTINEL
                                                     : ESCAPE_PREFIX;
}

static const struct {
  TSSymbol closing;
  enum ScannerMode next_mode;
  TSSymbol unterminated_at_end_of_source;
  TSSymbol unterminated_at_line_end;
} delimited_modes[] = {
  [MODE_NONE] = {ERROR_SENTINEL, MODE_NONE, ERROR_SENTINEL, ERROR_SENTINEL},
  [MODE_REGEX_ADDRESS] =
    {REGEX_ADDRESS_END,
      MODE_NONE,
      REGEX_UNTERMINATED_ADDRESS,
      REGEX_LINE_UNTERMINATED_ADDRESS},
  [MODE_SUBSTITUTE_PATTERN] =
    {SUBSTITUTE_MIDDLE,
      MODE_SUBSTITUTE_REPLACEMENT,
      REGEX_UNTERMINATED_SUBSTITUTE,
      REGEX_LINE_UNTERMINATED_SUBSTITUTE},
  [MODE_SUBSTITUTE_REPLACEMENT] =
    {SUBSTITUTE_END,
      MODE_NONE,
      REPLACEMENT_UNTERMINATED,
      REPLACEMENT_LINE_UNTERMINATED},
  [MODE_TRANSLATE_SOURCE] =
    {TRANSLATE_MIDDLE,
      MODE_TRANSLATE_DESTINATION,
      TRANSLATE_UNTERMINATED_SOURCE,
      TRANSLATE_LINE_UNTERMINATED_SOURCE},
  [MODE_TRANSLATE_DESTINATION] =
    {TRANSLATE_END,
      MODE_NONE,
      TRANSLATE_UNTERMINATED_DESTINATION,
      TRANSLATE_LINE_UNTERMINATED_DESTINATION},
  [MODE_TEXT] = {ERROR_SENTINEL, MODE_NONE, ERROR_SENTINEL, ERROR_SENTINEL},
};

static bool scan_active_mode_delimiter(
  TSLexer *lexer,
  ScannerState *state,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  const TSSymbol closing = delimited_modes[state->mode].closing;
  const enum ScannerMode next_mode = delimited_modes[state->mode].next_mode;
  if (next_mode == MODE_NONE) {
    reset_state(state);
  } else {
    state->mode = next_mode;
    reset_mode_tracking(state);
  }
  return consume_as(lexer, valid_symbols, closing, symbol);
}

static bool end_unterminated_mode(
  TSLexer *lexer,
  ScannerState *state,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  return end_mode(
    state,
    valid_symbols,
    lexer->eof(lexer)
      ? delimited_modes[state->mode].unterminated_at_end_of_source
      : delimited_modes[state->mode].unterminated_at_line_end,
    symbol
  );
}

static bool scan_text_introducer(
  TSLexer *lexer,
  ScannerState *state,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  lexer->mark_end(lexer);
  advance(lexer);
  if (lexer->lookahead == '\n') {
    consume(lexer);
    state->mode = MODE_TEXT;
    *symbol = TEXT_COMMAND_START;
    return true;
  }
  if (lexer->eof(lexer)) {
    lexer->mark_end(lexer);
    return emit_symbol(valid_symbols, TEXT_INCOMPLETE_INTRODUCER, symbol);
  }
  return emit_symbol(
    valid_symbols,
    NONCONFORMING_MISSING_TEXT_INTRODUCER_MARKER,
    symbol
  );
}

static bool scan_line_rest(TSLexer *lexer, bool ends_at_semicolon) {
  bool consumed = false;
  while (
    at_line_character(lexer) && !(ends_at_semicolon && lexer->lookahead == ';')
  ) {
    consume(lexer);
    consumed = true;
  }
  return consumed;
}

static bool scan_file_argument(TSLexer *lexer, bool ends_at_semicolon) {
  return !is_blank(lexer->lookahead) &&
    scan_line_rest(lexer, ends_at_semicolon);
}

static bool portable_label_character(int32_t character) {
  return is_letter(character) ||
    is_digit(character) ||
    character == '.' ||
    character == '_' ||
    character == '-';
}

enum { PORTABLE_LABEL_LENGTH = 8 };

static bool
scan_label_start(TSLexer *lexer, const bool *valid_symbols, TSSymbol *symbol) {
  lexer->mark_end(lexer);
  unsigned length = 0;
  while (!at_line_end(lexer)) {
    if (!portable_label_character(lexer->lookahead)) {
      return emit_symbol(valid_symbols, LABEL_START, symbol);
    }
    if (length <= PORTABLE_LABEL_LENGTH) length++;
    advance(lexer);
  }
  return emit_symbol(
    valid_symbols,
    length > PORTABLE_LABEL_LENGTH ? LONG_LABEL_START : LABEL_START,
    symbol
  );
}

static bool
scan_label_piece(TSLexer *lexer, const bool *valid_symbols, TSSymbol *symbol) {
  if (!at_line_character(lexer)) {
    return false;
  }
  const bool portable = portable_label_character(lexer->lookahead);
  do {
    consume(lexer);
  } while (
    at_line_character(lexer) &&
    portable_label_character(lexer->lookahead) == portable
  );
  return emit_symbol(
    valid_symbols,
    portable ? LABEL_LITERAL : NONPORTABLE_LABEL_CHARACTER,
    symbol
  );
}

static bool scan_unexpected_command_text(
  TSLexer *lexer,
  const bool *valid_symbols,
  TSSymbol *symbol,
  bool consumed
) {
  if (!valid_symbols[UNEXPECTED_COMMAND_TEXT]) {
    return false;
  }
  if (consumed) {
    lexer->mark_end(lexer);
  }
  while (
    at_line_character(lexer) &&
    lexer->lookahead != ';' &&
    lexer->lookahead != '}'
  ) {
    if (is_blank(lexer->lookahead)) {
      advance_past_blanks(lexer);
      if (lexer->lookahead == '}') break;
      lexer->mark_end(lexer);
      consumed = true;
      continue;
    }
    consume(lexer);
    consumed = true;
  }
  return consumed &&
    emit_symbol(valid_symbols, UNEXPECTED_COMMAND_TEXT, symbol);
}

static bool is_substitution_flag_character(int32_t character) {
  if (is_digit(character)) {
    return true;
  }

  switch (character) {
    case 'g':
    case 'i':
    case 'p':
    case 'w':
      return true;
    default:
      return false;
  }
}

static bool scan_flag_after_write_marker(
  TSLexer *lexer,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  lexer->mark_end(lexer);
  if (!valid_symbols[OMITTED_FILE_SEPARATOR_MARKER]) {
    advance(lexer);
    *symbol = FLAG_AFTER_WRITE_MARKER;
    return true;
  }
  do {
    advance(lexer);
  } while (is_substitution_flag_character(lexer->lookahead));

  if (is_blank(lexer->lookahead)) {
    *symbol = FLAG_AFTER_WRITE_MARKER;
    return true;
  }
  return emit_symbol(
    valid_symbols,
    lexer->eof(lexer) ? INCOMPLETE_OMITTED_FILE_SEPARATOR_MARKER
                      : OMITTED_FILE_SEPARATOR_MARKER,
    symbol
  );
}

static bool emit_marker(
  TSLexer *lexer,
  const bool *valid_symbols,
  TSSymbol candidate,
  TSSymbol *symbol
) {
  if (!emit_symbol(valid_symbols, candidate, symbol)) {
    return false;
  }

  lexer->mark_end(lexer);
  advance_unless_eof(lexer);
  return true;
}

static bool can_start_address(TSLexer *lexer) {
  return is_digit(lexer->lookahead) ||
    lexer->lookahead == '$' ||
    lexer->lookahead == '/' ||
    lexer->lookahead == '\\';
}

static bool at_command_boundary(TSLexer *lexer) {
  return at_line_end(lexer) ||
    lexer->lookahead == ';' ||
    lexer->lookahead == '}';
}

static bool at_command_text(TSLexer *lexer) {
  return !at_command_boundary(lexer) && !is_blank(lexer->lookahead);
}

static TSSymbol missing_command_separator_marker(
  const TSLexer *lexer,
  const bool *valid_symbols
) {
  if (lexer->lookahead == '}') {
    if (valid_symbols[MISSING_SEPARATOR_BEFORE_UNMATCHED_BRACE_MARKER]) {
      return MISSING_SEPARATOR_BEFORE_UNMATCHED_BRACE_MARKER;
    }
    if (valid_symbols[MISSING_COMMAND_SEPARATOR_MARKER]) {
      return MISSING_COMMAND_SEPARATOR_MARKER;
    }
  } else if (
    lexer->eof(lexer) && valid_symbols[INCOMPLETE_COMMAND_SEPARATOR_MARKER]
  ) {
    return INCOMPLETE_COMMAND_SEPARATOR_MARKER;
  }
  return ERROR_SENTINEL;
}

static bool omitted_address_is_valid(const bool *valid_symbols) {
  return valid_symbols[OMITTED_ADDRESS_MARKER] ||
    valid_symbols[INCOMPLETE_OMITTED_ADDRESS_MARKER];
}

static bool post_blank_recovery_is_valid(const bool *valid_symbols) {
  return omitted_address_is_valid(valid_symbols) ||
    valid_symbols[BLANKS_AROUND_ADDRESS_SEPARATOR] ||
    valid_symbols[MISSING_ADDRESS_SEPARATOR_MARKER] ||
    valid_symbols[MISSING_SEPARATOR_BEFORE_UNMATCHED_BRACE_MARKER] ||
    valid_symbols[MISSING_COMMAND_SEPARATOR_MARKER] ||
    valid_symbols[INCOMPLETE_COMMAND_SEPARATOR_MARKER];
}

static bool scan_post_blank_recovery(
  TSLexer *lexer,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  lexer->mark_end(lexer);
  advance_past_blanks(lexer);

  const bool after_separator = omitted_address_is_valid(valid_symbols);
  if (
    valid_symbols[BLANKS_AROUND_ADDRESS_SEPARATOR] &&
    (after_separator ? can_start_address(lexer) : lexer->lookahead == ',')
  ) {
    lexer->mark_end(lexer);
    *symbol = BLANKS_AROUND_ADDRESS_SEPARATOR;
    return true;
  }

  TSSymbol marker;
  if (after_separator && !can_start_address(lexer)) {
    marker = lexer->eof(lexer) ? INCOMPLETE_OMITTED_ADDRESS_MARKER
                               : OMITTED_ADDRESS_MARKER;
  } else if (
    valid_symbols[MISSING_ADDRESS_SEPARATOR_MARKER] && can_start_address(lexer)
  ) {
    marker = MISSING_ADDRESS_SEPARATOR_MARKER;
  } else {
    marker = missing_command_separator_marker(lexer, valid_symbols);
  }
  if (
    lexer->lookahead == '}' &&
    (marker == MISSING_COMMAND_SEPARATOR_MARKER ||
      marker == MISSING_SEPARATOR_BEFORE_UNMATCHED_BRACE_MARKER)
  ) {
    if (!valid_symbols[BRACE_LEADING_BLANKS]) return false;
    lexer->mark_end(lexer);
    *symbol = BRACE_LEADING_BLANKS;
    return true;
  }
  if (emit_symbol(valid_symbols, marker, symbol)) {
    return true;
  }

  if (lexer->eof(lexer) && valid_symbols[INCOMPLETE_COMMAND_TEXT]) {
    lexer->mark_end(lexer);
    *symbol = INCOMPLETE_COMMAND_TEXT;
    return true;
  }
  return scan_unexpected_command_text(lexer, valid_symbols, symbol, true);
}

static bool scan_text_token(
  TSLexer *lexer,
  ScannerState *state,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  if (lexer->eof(lexer)) {
    if (
      !state->text_line_has_content &&
      emit_marker(lexer, valid_symbols, MISSING_TEXT_MARKER, symbol)
    ) {
      state->text_line_has_content = true;
      return true;
    }
    lexer->mark_end(lexer);
    return end_mode(state, valid_symbols, TEXT_EOF, symbol);
  }

  if (lexer->lookahead == '\n') {
    lexer->mark_end(lexer);
    return end_mode(state, valid_symbols, TEXT_LINE_END, symbol);
  }

  state->text_line_has_content = true;
  if (!source_character_is_valid(lexer->lookahead)) {
    return consume_invalid_character(lexer, valid_symbols, symbol);
  }

  if (lexer->lookahead == '\\') {
    consume(lexer);

    const TSSymbol dangling =
      dangling_escape_symbol(lexer, TEXT_UNSPECIFIED_ESCAPE);
    if (dangling != ERROR_SENTINEL) {
      return emit_symbol(valid_symbols, dangling, symbol);
    }
    if (lexer->lookahead == '\\') {
      consume(lexer);
      return emit_symbol(valid_symbols, TEXT_BACKSLASH_ESCAPE, symbol);
    }
    if (lexer->lookahead == '\n') {
      consume(lexer);
      state->text_line_has_content = false;
      return emit_symbol(valid_symbols, TEXT_ESCAPED_NEWLINE, symbol);
    }

    consume(lexer);
    return emit_symbol(valid_symbols, TEXT_UNSPECIFIED_ESCAPE, symbol);
  }

  do {
    consume(lexer);
  } while (at_line_character(lexer) && lexer->lookahead != '\\');
  return emit_symbol(valid_symbols, TEXT_LITERAL, symbol);
}

static bool regex_is_inside_bracket(const ScannerState *state) {
  return state->regex_state != REGEX_OUTSIDE_BRACKET;
}

static enum RegexBracketPendingElement
bracket_element_for_character(int32_t character) {
  switch (character) {
    case '.':
      return REGEX_BRACKET_PENDING_DOT;
    case '=':
      return REGEX_BRACKET_PENDING_EQUAL;
    case ':':
      return REGEX_BRACKET_PENDING_COLON;
    default:
      return REGEX_BRACKET_PENDING_OTHER;
  }
}

static void record_bracket_element(
  ScannerState *state,
  enum RegexBracketPendingElement element
) {
  if (state->regex_bracket_element_count == 0) {
    state->regex_bracket_first_element = element;
  }
  if (state->regex_bracket_element_count < 3U) {
    state->regex_bracket_element_count++;
  }
  state->regex_bracket_last_element = element;
}

static void commit_pending_bracket_element(ScannerState *state) {
  if (state->regex_bracket_pending_element == REGEX_BRACKET_PENDING_NONE) {
    return;
  }

  record_bracket_element(state, state->regex_bracket_pending_element);
  state->regex_bracket_pending_element = REGEX_BRACKET_PENDING_NONE;
}

static void complete_bracket_range(ScannerState *state) {
  record_bracket_element(state, REGEX_BRACKET_PENDING_OTHER);
  state->regex_bracket_range_pending = false;
}

static void finish_first_bracket_element(ScannerState *state) {
  if (
    state->regex_state == REGEX_BRACKET_FIRST ||
    state->regex_state == REGEX_BRACKET_AFTER_CARET
  ) {
    state->regex_state = REGEX_BRACKET_BODY;
  }
}

static void
begin_single_bracket_element(ScannerState *state, int32_t character) {
  finish_first_bracket_element(state);
  if (state->regex_bracket_range_pending) {
    complete_bracket_range(state);
    return;
  }

  commit_pending_bracket_element(state);
  state->regex_bracket_pending_element =
    bracket_element_for_character(character);
}

static void begin_compound_bracket_element(ScannerState *state) {
  finish_first_bracket_element(state);
  state->regex_bracket_term_has_content = false;
  if (!state->regex_bracket_range_pending) {
    commit_pending_bracket_element(state);
  }
}

static void finish_compound_bracket_element(ScannerState *state) {
  state->regex_bracket_term_state = REGEX_BRACKET_TERM_NONE;
  state->regex_bracket_term_has_content = false;
  if (state->regex_bracket_range_pending) {
    complete_bracket_range(state);
    return;
  }

  state->regex_bracket_pending_element = REGEX_BRACKET_PENDING_OTHER;
}

static bool bracket_expression_is_ambiguous(const ScannerState *state) {
  return state->regex_bracket_element_count >= 3U &&
    state->regex_bracket_first_element >= REGEX_BRACKET_PENDING_DOT &&
    state->regex_bracket_first_element == state->regex_bracket_last_element;
}

static bool raw_regex_operator_character(int32_t character) {
  switch (character) {
#if SED_REGEX_EXTENDED
    case '(':
    case ')':
    case '+':
    case '?':
    case '|':
    case '{':
#endif
    case '*':
      return true;
    default:
      return false;
  }
}

static const struct {
  int32_t marker;
  TSSymbol open_symbol;
  TSSymbol close_symbol;
} bracket_terms[] = {
  [REGEX_BRACKET_TERM_COLON] = {':', REGEX_OPEN_COLON, REGEX_COLON_CLOSE},
  [REGEX_BRACKET_TERM_DOT] = {'.', REGEX_OPEN_DOT, REGEX_DOT_CLOSE},
  [REGEX_BRACKET_TERM_EQUAL] = {'=', REGEX_OPEN_EQUAL, REGEX_EQUAL_CLOSE},
};

static enum RegexBracketTermState bracket_term_for_marker(int32_t character) {
  for (
    enum RegexBracketTermState term_state = REGEX_BRACKET_TERM_COLON;
    term_state <= REGEX_BRACKET_TERM_EQUAL;
    term_state++
  ) {
    if (bracket_terms[term_state].marker == character) {
      return term_state;
    }
  }
  return REGEX_BRACKET_TERM_NONE;
}

static bool scan_regex_bracket_opener(
  TSLexer *lexer,
  ScannerState *state,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  lexer->mark_end(lexer);
  advance(lexer);

  if (
    valid_symbols[NONPORTABLE_RANGE_END_MARKER] &&
    (lexer->lookahead == ':' || lexer->lookahead == '=')
  ) {
    *symbol = NONPORTABLE_RANGE_END_MARKER;
    return true;
  }

  lexer->mark_end(lexer);

  const enum RegexBracketTermState term_state =
    bracket_term_for_marker(lexer->lookahead);
  if (term_state == REGEX_BRACKET_TERM_NONE) {
    begin_single_bracket_element(state, '[');
    return emit_symbol(valid_symbols, REGEX_BRACKET_LITERAL, symbol);
  }

  begin_compound_bracket_element(state);
  state->regex_bracket_term_state = term_state;
  return emit_symbol(
    valid_symbols,
    bracket_terms[term_state].open_symbol,
    symbol
  );
}

static void record_bracket_term_character(
  uint8_t *character_count,
  int32_t *single_character,
  int32_t character
) {
  if (*character_count == 0) {
    *single_character = character;
  }
  if (*character_count < 2U) {
    (*character_count)++;
  }
}

static bool bracket_meta_character(int32_t character) {
  return character == '-' || character == ']';
}

static TSSymbol regex_bracket_term_content_symbol(
  const ScannerState *state,
  uint8_t character_count,
  int32_t single_character,
  bool valid_class_name
) {
  if (state->regex_bracket_term_state == REGEX_BRACKET_TERM_COLON) {
    return valid_class_name ? REGEX_CLASS_NAME : REGEX_INVALID_CLASS_NAME;
  }
  if (character_count > 1U) {
    return REGEX_COLL_ELEM_MULTI;
  }
  if (!bracket_meta_character(single_character)) {
    return REGEX_COLL_ELEM_SINGLE;
  }
  return REGEX_META_CHAR;
}

static bool emit_regex_bracket_term_close(
  TSLexer *lexer,
  ScannerState *state,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  const TSSymbol closing =
    bracket_terms[state->regex_bracket_term_state].close_symbol;
  lexer->mark_end(lexer);
  if (lexer->lookahead == ']') {
    finish_compound_bracket_element(state);
  }
  return emit_symbol(valid_symbols, closing, symbol);
}

static bool scan_regex_bracket_term_content(
  TSLexer *lexer,
  ScannerState *state,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  const int32_t close_marker =
    bracket_terms[state->regex_bracket_term_state].marker;
  uint8_t character_count = 0;
  int32_t single_character = 0;
  bool stopped_at_close = false;
  bool valid_class_name = true;
  lexer->mark_end(lexer);

  if (!lexer->eof(lexer) && !source_character_is_valid(lexer->lookahead)) {
    state->regex_bracket_term_has_content = true;
    return consume_invalid_character(lexer, valid_symbols, symbol);
  }

  for (;;) {
    if (
      !at_line_character(lexer) ||
      (lexer->lookahead == ']' &&
        state->regex_bracket_term_state == REGEX_BRACKET_TERM_COLON)
    ) {
      break;
    }
    if (lexer->lookahead == close_marker) {
      advance(lexer);
      if (
        lexer->lookahead == ']' ||
        (at_line_end(lexer) &&
          (character_count > 0 ||
            state->regex_bracket_term_has_content ||
            state->regex_bracket_term_state == REGEX_BRACKET_TERM_COLON))
      ) {
        stopped_at_close = true;
        break;
      }
      if (
        state->regex_bracket_term_state == REGEX_BRACKET_TERM_COLON &&
        character_count > 0 &&
        valid_class_name
      ) {
        break;
      }
      lexer->mark_end(lexer);
      valid_class_name = false;
      record_bracket_term_character(
        &character_count,
        &single_character,
        close_marker
      );
      continue;
    }

    const int32_t character = lexer->lookahead;
    const bool class_character = is_letter(character) ||
      (valid_class_name && is_digit(character) && character_count > 0);
    if (
      state->regex_bracket_term_state == REGEX_BRACKET_TERM_COLON &&
      character_count > 0 &&
      class_character != valid_class_name
    ) {
      break;
    }
    valid_class_name = class_character;
    consume(lexer);
    record_bracket_term_character(
      &character_count,
      &single_character,
      character
    );
  }

  if (character_count == 0) {
    if (
      emit_symbol(valid_symbols, REGEX_MISSING_BRACKET_TERM_PAYLOAD, symbol)
    ) {
      return true;
    }
    if (stopped_at_close) {
      return emit_regex_bracket_term_close(lexer, state, valid_symbols, symbol);
    }
    finish_compound_bracket_element(state);
    return emit_symbol(valid_symbols, REGEX_MISSING_BRACKET_TERM_CLOSE, symbol);
  }
  state->regex_bracket_term_has_content = true;
  return emit_symbol(
    valid_symbols,
    state->regex_bracket_term_state == REGEX_BRACKET_TERM_EQUAL &&
        character_count == 1 &&
        bracket_meta_character(single_character) &&
        lexer->eof(lexer)
      ? REGEX_INCOMPLETE_META_CHAR
      : regex_bracket_term_content_symbol(
          state,
          character_count,
          single_character,
          valid_class_name
        ),
    symbol
  );
}

static bool scan_regex_bracket_term_close(
  TSLexer *lexer,
  ScannerState *state,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  advance(lexer);
  if (lexer->lookahead != ']' && !at_line_end(lexer)) {
    return false;
  }
  return emit_regex_bracket_term_close(lexer, state, valid_symbols, symbol);
}

static bool scan_regex_interval_open(
  TSLexer *lexer,
  ScannerState *state,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  consume(lexer);
  state->regex_in_interval = true;
  return emit_symbol(valid_symbols, REGEX_INTERVAL_OPEN, symbol);
}

static bool end_interval(
  ScannerState *state,
  const bool *valid_symbols,
  TSSymbol candidate,
  TSSymbol *symbol
) {
  state->regex_in_interval = false;
  return emit_symbol(valid_symbols, candidate, symbol);
}

static bool
regex_interval_content_ends(const TSLexer *lexer, const ScannerState *state) {
  const int32_t character = lexer->lookahead;
  if (at_line_end(lexer) || character == state->delimiter || character == '[') {
    return true;
  }
#if SED_REGEX_EXTENDED
  return character == '(' ||
    character == '|' ||
    (character == ')' && state->regex_group_depth > 0);
#else
  return false;
#endif
}

static bool regex_interval_syntax_character(int32_t character) {
#if SED_REGEX_EXTENDED
  if (character == '}') {
    return true;
  }
#endif
  return is_digit(character) || character == ',' || character == '\\';
}

static void
scan_invalid_interval_characters(TSLexer *lexer, const ScannerState *state) {
  while (
    !regex_interval_content_ends(lexer, state) &&
    source_character_is_valid(lexer->lookahead) &&
    !regex_interval_syntax_character(lexer->lookahead)
  ) {
    consume(lexer);
  }
}

static bool raw_duplication_symbol_follows(
  const TSLexer *lexer,
  const ScannerState *state
) {
#if SED_REGEX_EXTENDED
  (void)state;
  return lexer->lookahead == '*' ||
    lexer->lookahead == '+' ||
    lexer->lookahead == '?';
#else
  return lexer->lookahead == '*' && !regex_at_branch_start(state);
#endif
}

static TSSymbol regex_duplication_context_marker(
  const TSLexer *lexer,
  const ScannerState *state
) {
  if (regex_at_branch_start(state)) {
    return REGEX_LEADING_DUPLICATION_MARKER;
  }
  if (
    state->regex_position != REGEX_AFTER_DUPLICATION_SYMBOL
#if SED_REGEX_EXTENDED
    && state->regex_position != REGEX_AFTER_REPETITION_MODIFIER
#endif
  ) {
    return ERROR_SENTINEL;
  }
#if SED_REGEX_EXTENDED
  if (
    state->regex_position == REGEX_AFTER_DUPLICATION_SYMBOL &&
    lexer->lookahead == '?'
  ) {
    return ERROR_SENTINEL;
  }
#else
  (void)lexer;
#endif
  return REGEX_ADJACENT_DUPLICATION_MARKER;
}

static bool scan_raw_regex_operator(
  TSLexer *lexer,
  ScannerState *state,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
#if SED_REGEX_EXTENDED
  const int32_t character = lexer->lookahead;
  if (character == '{') {
    return scan_regex_interval_open(lexer, state, valid_symbols, symbol);
  }

  consume(lexer);
  switch (character) {
    case '(':
      return emit_symbol(valid_symbols, REGEX_GROUP_OPEN, symbol);
    case ')':
      return emit_symbol(
        valid_symbols,
        state->regex_group_depth > 0 ? REGEX_GROUP_CLOSE : REGEX_LITERAL,
        symbol
      );
    case '|':
      return emit_symbol(valid_symbols, REGEX_ALTERNATION_OPERATOR, symbol);
    case '+':
      return emit_symbol(valid_symbols, REGEX_ONE_OR_MORE, symbol);
    case '?':
      return emit_symbol(
        valid_symbols,
        state->regex_position == REGEX_AFTER_DUPLICATION_SYMBOL &&
            valid_symbols[REGEX_REPETITION_MODIFIER]
          ? REGEX_REPETITION_MODIFIER
          : REGEX_ZERO_OR_ONE,
        symbol
      );
    default:
      return emit_symbol(valid_symbols, REGEX_ZERO_OR_MORE, symbol);
  }
#else
  consume(lexer);
  return emit_symbol(
    valid_symbols,
    regex_at_branch_start(state) ? REGEX_LITERAL : REGEX_ZERO_OR_MORE,
    symbol
  );
#endif
}

static bool regex_delimiter_is_special(int32_t character) {
  switch (character) {
#if SED_REGEX_EXTENDED
    case '(':
    case ')':
    case '+':
    case '?':
    case '{':
    case '|':
#endif
    case '.':
    case '[':
    case '*':
    case '^':
    case '$':
      return true;
    default:
      return false;
  }
}

static bool escape_quotes_regex_syntax(int32_t character) {
  switch (character) {
#if SED_REGEX_EXTENDED
    case '}':
#endif
    case '\\':
    case ']':
      return true;
    default:
      return regex_delimiter_is_special(character);
  }
}

static bool scan_regex_escape_after_backslash(
  TSLexer *lexer,
  ScannerState *state,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  const TSSymbol dangling =
    dangling_escape_symbol(lexer, REGEX_INCOMPLETE_ESCAPE);
  if (dangling != ERROR_SENTINEL) {
    return emit_symbol(valid_symbols, dangling, symbol);
  }

  if (lexer->lookahead == '\n') {
    return emit_symbol(valid_symbols, REGEX_FORBIDDEN_NEWLINE_ESCAPE, symbol);
  }

  if (lexer->lookahead == state->delimiter) {
    return consume_as(
      lexer,
      valid_symbols,
      regex_delimiter_is_special(lexer->lookahead)
        ? REGEX_SPECIAL_ESCAPED_DELIMITER
        : REGEX_ESCAPED_DELIMITER,
      symbol
    );
  }

#if !SED_REGEX_EXTENDED
  switch (lexer->lookahead) {
    case '{':
      return scan_regex_interval_open(lexer, state, valid_symbols, symbol);
    case '}':
      return consume_as(
        lexer,
        valid_symbols,
        REGEX_UNMATCHED_INTERVAL_CLOSE,
        symbol
      );
    case '(':
      return consume_as(lexer, valid_symbols, REGEX_GROUP_OPEN, symbol);
    case ')':
      return consume_as(
        lexer,
        valid_symbols,
        state->regex_group_depth > 0 ? REGEX_GROUP_CLOSE
                                     : REGEX_UNMATCHED_GROUP_CLOSE,
        symbol
      );
    case '|':
      return consume_as(
        lexer,
        valid_symbols,
        REGEX_BRE_VERTICAL_LINE_ESCAPE,
        symbol
      );
    case '?':
      return consume_as(
        lexer,
        valid_symbols,
        REGEX_BRE_QUESTION_MARK_ESCAPE,
        symbol
      );
    case '+':
      return consume_as(lexer, valid_symbols, REGEX_BRE_PLUS_ESCAPE, symbol);
    default:
      if (lexer->lookahead >= '1' && lexer->lookahead <= '9') {
        return consume_as(lexer, valid_symbols, REGEX_BACKREFERENCE, symbol);
      }
      break;
  }
#endif

  if (lexer->lookahead == 'n') {
    return consume_as(lexer, valid_symbols, REGEX_NEWLINE_ESCAPE, symbol);
  }

  return consume_as(
    lexer,
    valid_symbols,
    escape_quotes_regex_syntax(lexer->lookahead) ? REGEX_QUOTED_ESCAPE
                                                 : REGEX_NONPORTABLE_ESCAPE,
    symbol
  );
}

static bool scan_regex_dup_count(
  TSLexer *lexer,
  const ScannerState *state,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  do {
    consume(lexer);
  } while (is_digit(lexer->lookahead) && lexer->lookahead != state->delimiter);

  return emit_symbol(valid_symbols, REGEX_DUP_COUNT, symbol);
}

static bool emit_missing_interval_minimum(
  TSLexer *lexer,
  const bool *valid_symbols,
  bool minimum_may_follow,
  TSSymbol *symbol
) {
  if (!emit_symbol(
        valid_symbols,
        minimum_may_follow ? REGEX_INCOMPLETE_INTERVAL_MINIMUM
                           : REGEX_MISSING_INTERVAL_MINIMUM,
        symbol
      )) {
    return false;
  }
  advance_unless_eof(lexer);
  return true;
}

static bool end_interval_content(
  TSLexer *lexer,
  ScannerState *state,
  const bool *valid_symbols,
  bool at_end_of_source,
  TSSymbol *symbol
) {
  if (
    emit_missing_interval_minimum(
      lexer,
      valid_symbols,
      at_end_of_source,
      symbol
    )
  ) {
    return true;
  }
  advance_unless_eof(lexer);
  return end_interval(
    state,
    valid_symbols,
    at_end_of_source && state->delimiter != '}' ? REGEX_INCOMPLETE_INTERVAL
                                                : REGEX_MISSING_INTERVAL_CLOSE,
    symbol
  );
}

static bool scan_regex_interval_close(
  TSLexer *lexer,
  ScannerState *state,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  if (emit_missing_interval_minimum(lexer, valid_symbols, false, symbol)) {
    return true;
  }
  consume(lexer);
  return end_interval(state, valid_symbols, REGEX_INTERVAL_CLOSE, symbol);
}

static bool scan_regex_interval_separator(
  TSLexer *lexer,
  const bool *valid_symbols,
  TSSymbol separator,
  TSSymbol *symbol
) {
  return emit_missing_interval_minimum(lexer, valid_symbols, false, symbol) ||
    consume_as(lexer, valid_symbols, separator, symbol);
}

static bool scan_regex_interval_escape(
  TSLexer *lexer,
  ScannerState *state,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  advance(lexer);
  const int32_t character = lexer->lookahead;
#if !SED_REGEX_EXTENDED
  if (character == '}' && state->delimiter != '}') {
    return scan_regex_interval_close(lexer, state, valid_symbols, symbol);
  }
  if (at_line_end(lexer)) {
    if (
      emit_missing_interval_minimum(
        lexer,
        valid_symbols,
        lexer->eof(lexer) && is_digit(state->delimiter),
        symbol
      )
    ) {
      return true;
    }
    lexer->mark_end(lexer);
    return end_interval(
      state,
      valid_symbols,
      lexer->eof(lexer) && state->delimiter != '}'
        ? REGEX_INCOMPLETE_INTERVAL_CLOSE
        : REGEX_INVALID_INTERVAL_CLOSE,
      symbol
    );
  }
  if ((character == '(' || character == ')') && character != state->delimiter) {
    return end_interval_content(lexer, state, valid_symbols, false, symbol);
  }
#endif
  if (character == ',' && state->delimiter == ',') {
    return scan_regex_interval_separator(
      lexer,
      valid_symbols,
      REGEX_INTERVAL_ESCAPED_SEPARATOR,
      symbol
    );
  }

  lexer->mark_end(lexer);
#if SED_REGEX_EXTENDED
  if (lexer->eof(lexer)) {
    return emit_symbol(
      valid_symbols,
      is_digit(state->delimiter) || state->delimiter == ','
        ? REGEX_INCOMPLETE_ESCAPE
        : REGEX_INVALID_INTERVAL,
      symbol
    );
  }
  if (character == '\n') {
    return emit_symbol(valid_symbols, REGEX_INVALID_INTERVAL, symbol);
  }
#endif
  if (!source_character_is_valid(character)) {
    return emit_symbol(valid_symbols, ESCAPE_PREFIX, symbol);
  }
  if (character == state->delimiter && is_digit(character)) {
    return consume_as(
      lexer,
      valid_symbols,
      REGEX_INTERVAL_ESCAPED_COUNT,
      symbol
    );
  }
  consume(lexer);
  return emit_symbol(valid_symbols, REGEX_INVALID_INTERVAL, symbol);
}

static bool scan_regex_interval(
  TSLexer *lexer,
  ScannerState *state,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  lexer->mark_end(lexer);
  if (regex_interval_content_ends(lexer, state)) {
    return end_interval_content(
      lexer,
      state,
      valid_symbols,
      lexer->eof(lexer),
      symbol
    );
  }

  const int32_t character = lexer->lookahead;
#if SED_REGEX_EXTENDED
  if (character == '}') {
    return scan_regex_interval_close(lexer, state, valid_symbols, symbol);
  }
#endif
  if (character == ',') {
    return scan_regex_interval_separator(
      lexer,
      valid_symbols,
      REGEX_INTERVAL_SEPARATOR,
      symbol
    );
  }
  if (character == '\\') {
    return scan_regex_interval_escape(lexer, state, valid_symbols, symbol);
  }
  if (!source_character_is_valid(character)) {
    return consume_invalid_character(lexer, valid_symbols, symbol);
  }
  if (is_digit(character)) {
    return scan_regex_dup_count(lexer, state, valid_symbols, symbol);
  }
  scan_invalid_interval_characters(lexer, state);
  advance_unless_eof(lexer);
  return emit_symbol(valid_symbols, REGEX_INVALID_INTERVAL, symbol);
}

#if SED_REGEX_EXTENDED
static bool scan_empty_alternative(
  TSLexer *lexer,
  const ScannerState *state,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  if (
    valid_symbols[EMPTY_ALTERNATIVE_MARKER] &&
    (lexer->lookahead == '|' ||
      (state->regex_group_depth > 0 &&
        lexer->lookahead == ')' &&
        state->regex_position == REGEX_AFTER_ALTERNATION))
  ) {
    return emit_marker(lexer, valid_symbols, EMPTY_ALTERNATIVE_MARKER, symbol);
  }
  return false;
}
#endif

static bool scan_regex_bracket_close(
  TSLexer *lexer,
  ScannerState *state,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  commit_pending_bracket_element(state);
  if (
    bracket_expression_is_ambiguous(state) &&
    valid_symbols[AMBIGUOUS_BRACKET_EXPRESSION_MARKER]
  ) {
    lexer->mark_end(lexer);
    *symbol = AMBIGUOUS_BRACKET_EXPRESSION_MARKER;
    return true;
  }

  consume(lexer);
  reset_bracket_tracking(state, REGEX_OUTSIDE_BRACKET);
  return emit_symbol(valid_symbols, REGEX_BRACKET_CLOSE, symbol);
}

static bool scan_regex_bracket_hyphen(
  TSLexer *lexer,
  ScannerState *state,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  lexer->mark_end(lexer);
  advance(lexer);
  const bool ends_list = at_line_end(lexer) || lexer->lookahead == ']';
  if (valid_symbols[NONPORTABLE_RANGE_START_MARKER] && !ends_list) {
    *symbol = NONPORTABLE_RANGE_START_MARKER;
    return true;
  }
  lexer->mark_end(lexer);

  if (valid_symbols[REGEX_BRACKET_RANGE_END_HYPHEN]) {
    state->regex_bracket_pending_element = REGEX_BRACKET_PENDING_NONE;
    complete_bracket_range(state);
    *symbol = REGEX_BRACKET_RANGE_END_HYPHEN;
    return true;
  }
  if (
    emit_symbol(
      valid_symbols,
      ends_list ? REGEX_BRACKET_TRAILING_HYPHEN : REGEX_BRACKET_HYPHEN,
      symbol
    )
  ) {
    if (ends_list) {
      commit_pending_bracket_element(state);
      record_bracket_element(state, REGEX_BRACKET_PENDING_OTHER);
    } else {
      state->regex_bracket_pending_element = REGEX_BRACKET_PENDING_NONE;
      state->regex_bracket_range_pending = true;
    }
    return true;
  }
  if (!emit_symbol(valid_symbols, REGEX_SHARED_RANGE_ENDPOINT, symbol)) {
    return false;
  }
  commit_pending_bracket_element(state);
  state->regex_bracket_range_pending = false;
  return true;
}

#if !SED_REGEX_EXTENDED
static bool scan_bre_caret(
  TSLexer *lexer,
  const ScannerState *state,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  consume(lexer);
  if (state->regex_position != REGEX_AT_BRANCH_START) {
    return emit_symbol(valid_symbols, REGEX_LITERAL, symbol);
  }
  return emit_symbol(
    valid_symbols,
    state->regex_group_depth > 0 ? REGEX_BRE_SUBEXPRESSION_CARET
                                 : REGEX_BEGINNING_ANCHOR,
    symbol
  );
}

static bool scan_bre_dollar(
  TSLexer *lexer,
  const ScannerState *state,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  consume(lexer);
  if (lexer->lookahead == '\\') {
    advance(lexer);
    const bool closes_subexpression = state->regex_group_depth > 0 &&
      lexer->lookahead == ')' &&
      state->delimiter != ')';
    return emit_symbol(
      valid_symbols,
      closes_subexpression ? REGEX_BRE_SUBEXPRESSION_DOLLAR : REGEX_LITERAL,
      symbol
    );
  }
  const bool at_branch_end =
    at_line_end(lexer) || lexer->lookahead == state->delimiter;
  advance_unless_eof(lexer);
  return emit_symbol(
    valid_symbols,
    at_branch_end ? REGEX_END_ANCHOR : REGEX_LITERAL,
    symbol
  );
}
#endif

static bool scan_regex_outside_bracket(
  TSLexer *lexer,
  ScannerState *state,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  const TSSymbol marker = regex_duplication_context_marker(lexer, state);
  if (marker != ERROR_SENTINEL && valid_symbols[marker]) {
    lexer->mark_end(lexer);
#if SED_REGEX_EXTENDED
    if (
      raw_duplication_symbol_follows(lexer, state) || lexer->lookahead == '{'
    ) {
      *symbol = marker;
      return true;
    }
#else
    if (raw_duplication_symbol_follows(lexer, state)) {
      *symbol = marker;
      return true;
    }
    if (lexer->lookahead == '\\') {
      advance(lexer);
      if (lexer->lookahead == '{' && state->delimiter != '{') {
        *symbol = marker;
        return true;
      }
      lexer->mark_end(lexer);
      return scan_regex_escape_after_backslash(
        lexer,
        state,
        valid_symbols,
        symbol
      );
    }
#endif
  }

#if SED_REGEX_EXTENDED
  if (scan_empty_alternative(lexer, state, valid_symbols, symbol)) {
    return true;
  }
#endif

  switch (lexer->lookahead) {
#if SED_REGEX_EXTENDED
    case '^':
      return consume_as(lexer, valid_symbols, REGEX_BEGINNING_ANCHOR, symbol);
    case '$':
      return consume_as(lexer, valid_symbols, REGEX_END_ANCHOR, symbol);
#else
    case '^':
      return scan_bre_caret(lexer, state, valid_symbols, symbol);
    case '$':
      return scan_bre_dollar(lexer, state, valid_symbols, symbol);
#endif
    case '.':
      return consume_as(lexer, valid_symbols, REGEX_PERIOD, symbol);
    case '\\':
      consume(lexer);
      return scan_regex_escape_after_backslash(
        lexer,
        state,
        valid_symbols,
        symbol
      );
    case '[':
      consume(lexer);
      reset_bracket_tracking(state, REGEX_BRACKET_FIRST);
      return emit_symbol(valid_symbols, REGEX_BRACKET_OPEN, symbol);
    default:
      break;
  }

  if (raw_regex_operator_character(lexer->lookahead)) {
    return scan_raw_regex_operator(lexer, state, valid_symbols, symbol);
  }
  if (!source_character_is_valid(lexer->lookahead)) {
    return consume_invalid_character(lexer, valid_symbols, symbol);
  }
  return consume_as(lexer, valid_symbols, REGEX_LITERAL, symbol);
}

static bool scan_regex_inside_bracket(
  TSLexer *lexer,
  ScannerState *state,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  if (
    valid_symbols[REGEX_CLASS_NAME] ||
    valid_symbols[REGEX_INVALID_CLASS_NAME] ||
    valid_symbols[REGEX_COLL_ELEM_SINGLE] ||
    valid_symbols[REGEX_COLL_ELEM_MULTI] ||
    valid_symbols[REGEX_META_CHAR]
  ) {
    return scan_regex_bracket_term_content(lexer, state, valid_symbols, symbol);
  }
  if (state->regex_bracket_term_state != REGEX_BRACKET_TERM_NONE) {
    if (
      lexer->lookahead == ']' && valid_symbols[REGEX_MISSING_BRACKET_TERM_CLOSE]
    ) {
      lexer->mark_end(lexer);
      finish_compound_bracket_element(state);
      *symbol = REGEX_MISSING_BRACKET_TERM_CLOSE;
      return true;
    }
    if (
      valid_symbols[bracket_terms[state->regex_bracket_term_state]
          .close_symbol] &&
      lexer->lookahead == bracket_terms[state->regex_bracket_term_state].marker
    ) {
      return scan_regex_bracket_term_close(lexer, state, valid_symbols, symbol);
    }
  }

  switch (lexer->lookahead) {
    case '[':
      return scan_regex_bracket_opener(lexer, state, valid_symbols, symbol);
    case '^':
      if (state->regex_state == REGEX_BRACKET_FIRST) {
        consume(lexer);
        state->regex_state = REGEX_BRACKET_AFTER_CARET;
        return emit_symbol(valid_symbols, REGEX_BRACKET_NEGATION, symbol);
      }
      break;
    case ']':
      if (state->regex_state == REGEX_BRACKET_BODY) {
        return scan_regex_bracket_close(lexer, state, valid_symbols, symbol);
      }
      break;
    case '-':
      if (state->regex_state == REGEX_BRACKET_BODY) {
        return scan_regex_bracket_hyphen(lexer, state, valid_symbols, symbol);
      }
      break;
    default:
      break;
  }

  begin_single_bracket_element(state, lexer->lookahead);
  if (!source_character_is_valid(lexer->lookahead)) {
    return consume_invalid_character(lexer, valid_symbols, symbol);
  }
  return consume_as(lexer, valid_symbols, REGEX_BRACKET_LITERAL, symbol);
}

static bool scan_operand_literal(
  TSLexer *lexer,
  const ScannerState *state,
  bool ampersand_is_special
) {
  bool consumed = false;
  while (
    at_line_character(lexer) &&
    lexer->lookahead != state->delimiter &&
    lexer->lookahead != '\\' &&
    !(ampersand_is_special && lexer->lookahead == '&')
  ) {
    consume(lexer);
    consumed = true;
  }
  if (consumed && lexer->lookahead == state->delimiter) {
    advance(lexer);
  }
  return consumed;
}

static bool scan_replacement_escape(
  TSLexer *lexer,
  const ScannerState *state,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  consume(lexer);

  const TSSymbol dangling =
    dangling_escape_symbol(lexer, REPLACEMENT_INCOMPLETE_ESCAPE);
  if (dangling != ERROR_SENTINEL) {
    return emit_symbol(valid_symbols, dangling, symbol);
  }

  if (lexer->lookahead == '\n') {
    return consume_as(
      lexer,
      valid_symbols,
      REPLACEMENT_ESCAPED_NEWLINE,
      symbol
    );
  }

  TSSymbol candidate;
  if (lexer->lookahead == state->delimiter) {
    candidate = state->delimiter == '&'
      ? REPLACEMENT_AMPERSAND_ESCAPED_DELIMITER
      : REPLACEMENT_ESCAPED_DELIMITER;
  } else if (is_digit(lexer->lookahead)) {
    candidate = REPLACEMENT_BACKREFERENCE;
  } else if (lexer->lookahead == '&' || lexer->lookahead == '\\') {
    candidate = REPLACEMENT_ESCAPE_SEQUENCE;
  } else {
    candidate = REPLACEMENT_NONPORTABLE_ESCAPE;
  }
  return consume_as(lexer, valid_symbols, candidate, symbol);
}

static bool scan_translate_escape(
  TSLexer *lexer,
  const ScannerState *state,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  consume(lexer);

  const TSSymbol dangling =
    dangling_escape_symbol(lexer, TRANSLATE_INCOMPLETE_ESCAPE);
  if (dangling != ERROR_SENTINEL) {
    return emit_symbol(valid_symbols, dangling, symbol);
  }

  if (lexer->lookahead == '\n') {
    return emit_symbol(valid_symbols, TRANSLATE_NONPORTABLE_ESCAPE, symbol);
  }

  TSSymbol candidate;
  if (lexer->lookahead == 'n' || lexer->lookahead == '\\') {
    candidate = TRANSLATE_ESCAPE;
  } else if (lexer->lookahead == state->delimiter) {
    candidate = TRANSLATE_ESCAPED_DELIMITER;
  } else {
    candidate = TRANSLATE_NONPORTABLE_ESCAPE;
  }
  return consume_as(lexer, valid_symbols, candidate, symbol);
}

static bool scan_operand_token(
  TSLexer *lexer,
  ScannerState *state,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  const bool is_replacement = state->mode == MODE_SUBSTITUTE_REPLACEMENT;
  if (scan_operand_literal(lexer, state, is_replacement)) {
    return emit_symbol(
      valid_symbols,
      is_replacement ? REPLACEMENT_LITERAL : TRANSLATE_LITERAL,
      symbol
    );
  }
  if (!source_character_is_valid(lexer->lookahead)) {
    return consume_invalid_character(lexer, valid_symbols, symbol);
  }
  if (lexer->lookahead == '\\') {
    return is_replacement
      ? scan_replacement_escape(lexer, state, valid_symbols, symbol)
      : scan_translate_escape(lexer, state, valid_symbols, symbol);
  }
  return consume_as(lexer, valid_symbols, REPLACEMENT_MATCH_REFERENCE, symbol);
}

static bool scan_regex_closer(
  TSLexer *lexer,
  ScannerState *state,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  const bool at_end_of_source = lexer->eof(lexer);

  if (regex_is_inside_bracket(state)) {
    if (
      (state->regex_state == REGEX_BRACKET_FIRST ||
        state->regex_state == REGEX_BRACKET_AFTER_CARET) &&
      emit_marker(
        lexer,
        valid_symbols,
        at_end_of_source ? INCOMPLETE_BRACKET_LIST_MARKER
                         : MISSING_BRACKET_LIST_MARKER,
        symbol
      )
    ) {
      return true;
    }
    if (state->regex_bracket_term_state != REGEX_BRACKET_TERM_NONE) {
      if (
        emit_marker(
          lexer,
          valid_symbols,
          at_end_of_source ? REGEX_INCOMPLETE_BRACKET_TERM_PAYLOAD
                           : REGEX_MISSING_BRACKET_TERM_PAYLOAD,
          symbol
        )
      ) {
        return true;
      }
      if (
        emit_marker(
          lexer,
          valid_symbols,
          at_end_of_source ? REGEX_INCOMPLETE_BRACKET_TERM
                           : REGEX_MISSING_BRACKET_TERM_CLOSE,
          symbol
        )
      ) {
        finish_compound_bracket_element(state);
        return true;
      }
    }
    if (
      emit_marker(
        lexer,
        valid_symbols,
        at_end_of_source ? INCOMPLETE_BRACKET_EXPRESSION_MARKER
                         : UNCLOSED_BRACKET_EXPRESSION_MARKER,
        symbol
      )
    ) {
      reset_bracket_tracking(state, REGEX_OUTSIDE_BRACKET);
      return true;
    }
    return false;
  }

#if SED_REGEX_EXTENDED
  if (
    state->regex_position == REGEX_AFTER_ALTERNATION &&
    emit_marker(
      lexer,
      valid_symbols,
      at_end_of_source ? INCOMPLETE_ALTERNATIVE_MARKER
                       : EMPTY_ALTERNATIVE_MARKER,
      symbol
    )
  ) {
    state->regex_position = REGEX_AT_BRANCH_START;
    return true;
  }
#endif

  if (
    state->regex_group_depth > 0 &&
    emit_marker(
      lexer,
      valid_symbols,
      at_end_of_source && state->delimiter != ')' ? REGEX_INCOMPLETE_GROUP
                                                  : REGEX_UNCLOSED_GROUP,
      symbol
    )
  ) {
    state->regex_group_depth--;
    return true;
  }

  return false;
}

static bool scan_brace_leading_blanks(
  TSLexer *lexer,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  advance_past_blanks(lexer);
  if (
    lexer->lookahead != '}' &&
    !(lexer->eof(lexer) && valid_symbols[MISSING_CLOSING_BRACE_MARKER])
  ) {
    return false;
  }
  lexer->mark_end(lexer);
  *symbol = BRACE_LEADING_BLANKS;
  return true;
}

static bool scan_block_trailing_blanks(
  TSLexer *lexer,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  while (is_blank(lexer->lookahead)) {
    lexer->advance(lexer, true);
  }
  if (
    lexer->eof(lexer) && !valid_symbols[INCOMPLETE_COMMAND_SEPARATOR_MARKER]
  ) {
    return false;
  }
  if (at_command_boundary(lexer)) {
    lexer->mark_end(lexer);
    *symbol = BLOCK_TRAILING_BLANKS;
    return true;
  }
  if (!source_character_is_valid(lexer->lookahead)) {
    return consume_invalid_character(lexer, valid_symbols, symbol);
  }
  return scan_unexpected_command_text(lexer, valid_symbols, symbol, false);
}

static bool scan_command_recovery(
  TSLexer *lexer,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  if (
    lexer->lookahead == ',' &&
    emit_marker(lexer, valid_symbols, OMITTED_FIRST_ADDRESS_MARKER, symbol)
  ) {
    return true;
  }

  if (
    omitted_address_is_valid(valid_symbols) &&
    !can_start_address(lexer) &&
    !is_blank(lexer->lookahead)
  ) {
    return emit_marker(
      lexer,
      valid_symbols,
      lexer->eof(lexer) ? INCOMPLETE_OMITTED_ADDRESS_MARKER
                        : OMITTED_ADDRESS_MARKER,
      symbol
    );
  }

  if (is_blank(lexer->lookahead)) {
    if (post_blank_recovery_is_valid(valid_symbols)) {
      return scan_post_blank_recovery(lexer, valid_symbols, symbol);
    }
    if (valid_symbols[BRACE_LEADING_BLANKS]) {
      return scan_brace_leading_blanks(lexer, valid_symbols, symbol);
    }
  }

  if (
    at_command_text(lexer) &&
    emit_marker(lexer, valid_symbols, OMITTED_FILE_SEPARATOR_MARKER, symbol)
  ) {
    return true;
  }

  if (at_command_boundary(lexer)) {
    static const TSSymbol boundary_markers[][2] = {
      {MISSING_FUNCTION_MARKER, NONCONFORMING_MISSING_FUNCTION_MARKER},
      {MISSING_LABEL_MARKER, NONCONFORMING_MISSING_LABEL_MARKER},
      {MISSING_RFILE_MARKER, NONCONFORMING_MISSING_RFILE_MARKER},
      {MISSING_WFILE_MARKER, NONCONFORMING_MISSING_WFILE_MARKER},
    };
    const unsigned variant = lexer->eof(lexer) ? 0 : 1;
    for (
      unsigned index = 0;
      index < sizeof(boundary_markers) / sizeof(boundary_markers[0]);
      index++
    ) {
      if (
        emit_marker(
          lexer,
          valid_symbols,
          boundary_markers[index][variant],
          symbol
        )
      ) {
        return true;
      }
    }
  }

  const TSSymbol missing_text_introducer = lexer->eof(lexer)
    ? MISSING_TEXT_INTRODUCER_MARKER
    : NONCONFORMING_MISSING_TEXT_INTRODUCER_MARKER;
  if (emit_marker(lexer, valid_symbols, missing_text_introducer, symbol)) {
    return true;
  }

  if (
    lexer->eof(lexer) &&
    emit_marker(lexer, valid_symbols, MISSING_CLOSING_BRACE_MARKER, symbol)
  ) {
    return true;
  }

  if (
    at_command_text(lexer) &&
    emit_marker(
      lexer,
      valid_symbols,
      MISSING_SEPARATOR_AFTER_UNMATCHED_BRACE_MARKER,
      symbol
    )
  ) {
    return true;
  }

  const TSSymbol separator_marker =
    missing_command_separator_marker(lexer, valid_symbols);
  if (separator_marker != ERROR_SENTINEL) {
    return emit_marker(lexer, valid_symbols, separator_marker, symbol);
  }

  const TSSymbol missing_opening_delimiter = lexer->eof(lexer)
    ? MISSING_OPENING_DELIMITER_MARKER
    : NONCONFORMING_MISSING_OPENING_DELIMITER_MARKER;
  if (
    at_line_end(lexer) &&
    emit_marker(lexer, valid_symbols, missing_opening_delimiter, symbol)
  ) {
    return true;
  }

  return scan_unexpected_command_text(lexer, valid_symbols, symbol, false);
}

static bool scan_write_separator(
  TSLexer *lexer,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  const bool block = valid_symbols[WRITE_BLOCK_TERMINAL_SEPARATOR];
  consume(lexer);
  while (
    is_blank(lexer->lookahead) ||
    lexer->lookahead == ';' ||
    (!block && lexer->lookahead == '}')
  ) {
    advance(lexer);
  }
  TSSymbol candidate = WRITE_FOLLOWING_SEPARATOR;
  if (at_line_end(lexer) || (block && lexer->lookahead == '}')) {
    candidate =
      block ? WRITE_BLOCK_TERMINAL_SEPARATOR : WRITE_TERMINAL_SEPARATOR;
  }
  return emit_symbol(valid_symbols, candidate, symbol);
}

static bool at_invalid_substitution_flag(TSLexer *lexer) {
  return at_command_text(lexer) &&
    !is_substitution_flag_character(lexer->lookahead) &&
    source_character_is_decoded(lexer->lookahead);
}

static bool scan_command_token(
  TSLexer *lexer,
  ScannerState *state,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  if (
    (valid_symbols[LABEL_START] || valid_symbols[LONG_LABEL_START]) &&
    !at_line_end(lexer)
  ) {
    return scan_label_start(lexer, valid_symbols, symbol);
  }

  if (
    lexer->lookahead == ';' &&
    (valid_symbols[WRITE_TERMINAL_SEPARATOR] ||
      valid_symbols[WRITE_BLOCK_TERMINAL_SEPARATOR] ||
      valid_symbols[WRITE_FOLLOWING_SEPARATOR])
  ) {
    return scan_write_separator(lexer, valid_symbols, symbol);
  }

  if (valid_symbols[BLOCK_TRAILING_BLANKS] && is_blank(lexer->lookahead)) {
    return scan_block_trailing_blanks(lexer, valid_symbols, symbol);
  }

  if (
    valid_symbols[EMPTY_COMMAND_MARKER] &&
    (lexer->lookahead == ';' || lexer->lookahead == '\n')
  ) {
    return emit_marker(lexer, valid_symbols, EMPTY_COMMAND_MARKER, symbol);
  }

  if (
    valid_symbols[INVALID_SUBSTITUTION_FLAG] &&
    at_invalid_substitution_flag(lexer)
  ) {
    do {
      consume(lexer);
    } while (at_invalid_substitution_flag(lexer));
    *symbol = INVALID_SUBSTITUTION_FLAG;
    return true;
  }

  if (
    !lexer->eof(lexer) &&
    !source_character_is_valid(lexer->lookahead) &&
    consume_invalid_character(lexer, valid_symbols, symbol)
  ) {
    return true;
  }

  if (
    valid_symbols[SUBSTITUTION_WFILE_CONTINUATION] &&
    scan_line_rest(lexer, true)
  ) {
    *symbol = SUBSTITUTION_WFILE_CONTINUATION;
    return true;
  }

  if (valid_symbols[LINE_WORD] && scan_line_rest(lexer, false)) {
    *symbol = LINE_WORD;
    return true;
  }

  if (
    (valid_symbols[LABEL_LITERAL] ||
      valid_symbols[NONPORTABLE_LABEL_CHARACTER]) &&
    scan_label_piece(lexer, valid_symbols, symbol)
  ) {
    return true;
  }

  // Recovery can swallow a '}'-leading label's separator.
  if (
    lexer->lookahead == ' ' &&
    consume_as(lexer, valid_symbols, ARGUMENT_SEPARATOR, symbol)
  ) {
    return true;
  }

  if (
    valid_symbols[FLAG_AFTER_WRITE_MARKER] &&
    is_substitution_flag_character(lexer->lookahead)
  ) {
    return scan_flag_after_write_marker(lexer, valid_symbols, symbol);
  }

  if (
    valid_symbols[SUBSTITUTION_WFILE_ARGUMENT] &&
    scan_file_argument(lexer, true)
  ) {
    *symbol = SUBSTITUTION_WFILE_ARGUMENT;
    return true;
  }

  if (valid_symbols[FILE_ARGUMENT] && scan_file_argument(lexer, false)) {
    *symbol = FILE_ARGUMENT;
    return true;
  }

  if (
    valid_symbols[INVALID_SUBSTITUTION_FLAG] &&
    is_substitution_flag_character(lexer->lookahead)
  ) {
    return false;
  }

  if (valid_symbols[TEXT_COMMAND_START] && lexer->lookahead == '\\') {
    return scan_text_introducer(lexer, state, valid_symbols, symbol);
  }

  if (
    lexer->lookahead == 'n' &&
    consume_as(lexer, valid_symbols, DEFAULT_OUTPUT_SUPPRESSION, symbol)
  ) {
    return true;
  }

  if (valid_symbols[COMMENT_TEXT] && scan_line_rest(lexer, false)) {
    *symbol = COMMENT_TEXT;
    return true;
  }

  if (
    can_start_address(lexer) &&
    emit_marker(lexer, valid_symbols, MISSING_ADDRESS_SEPARATOR_MARKER, symbol)
  ) {
    return true;
  }

  if (
    can_start_address(lexer) &&
    consume_as(lexer, valid_symbols, RESERVED_UNKNOWN_FUNCTION_TOKEN, symbol)
  ) {
    return true;
  }

  static const struct {
    TSSymbol symbol;
    enum ScannerMode mode;
    int32_t required_delimiter;
  } delimited_openers[] = {
    {REGEX_ADDRESS_START, MODE_REGEX_ADDRESS, '/'},
    {ESCAPED_REGEX_ADDRESS_START, MODE_REGEX_ADDRESS, 0},
    {SUBSTITUTE_START, MODE_SUBSTITUTE_PATTERN, 0},
    {TRANSLATE_START, MODE_TRANSLATE_SOURCE, 0},
  };
  for (
    unsigned index = 0;
    index < sizeof(delimited_openers) / sizeof(delimited_openers[0]);
    index++
  ) {
    const int32_t required = delimited_openers[index].required_delimiter;
    if (
      valid_symbols[delimited_openers[index].symbol] &&
      (required == 0 || lexer->lookahead == required) &&
      scan_simple_delimiter(lexer, state, delimited_openers[index].mode)
    ) {
      *symbol = delimited_openers[index].symbol;
      return true;
    }
  }

  return scan_command_recovery(lexer, valid_symbols, symbol);
}

static bool sed_scanner_scan_impl(
  ScannerState *state,
  TSLexer *lexer,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  if (valid_symbols[ERROR_SENTINEL]) {
    return false;
  }

  if (state->mode == MODE_NONE) {
    return scan_command_token(lexer, state, valid_symbols, symbol);
  }

  if (state->mode == MODE_TEXT) {
    return scan_text_token(lexer, state, valid_symbols, symbol);
  }

  const bool regex_mode = is_regex_mode(state->mode);
  if (regex_mode && state->regex_in_interval) {
    return scan_regex_interval(lexer, state, valid_symbols, symbol);
  }

  const bool at_closing_delimiter = lexer->lookahead == state->delimiter &&
    !(regex_mode && regex_is_inside_bracket(state));
  if (at_line_end(lexer) || at_closing_delimiter) {
    if (regex_mode && scan_regex_closer(lexer, state, valid_symbols, symbol)) {
      return true;
    }
    return at_closing_delimiter
      ? scan_active_mode_delimiter(lexer, state, valid_symbols, symbol)
      : end_unterminated_mode(lexer, state, valid_symbols, symbol);
  }

  if (!regex_mode) {
    return scan_operand_token(lexer, state, valid_symbols, symbol);
  }
  return regex_is_inside_bracket(state)
    ? scan_regex_inside_bracket(lexer, state, valid_symbols, symbol)
    : scan_regex_outside_bracket(lexer, state, valid_symbols, symbol);
}

static void
update_regex_position_after_symbol(ScannerState *state, TSSymbol symbol) {
  if (!is_regex_mode(state->mode)) {
    return;
  }

  switch (symbol) {
    case REGEX_GROUP_OPEN:
      state->regex_group_depth++;
      state->regex_position = REGEX_AT_BRANCH_START;
      return;
    case REGEX_GROUP_CLOSE:
      state->regex_group_depth--;
      state->regex_position = REGEX_AFTER_ATOM;
      return;
#if SED_REGEX_EXTENDED
    case REGEX_ALTERNATION_OPERATOR:
      state->regex_position = REGEX_AFTER_ALTERNATION;
      return;
#endif
    case REGEX_BEGINNING_ANCHOR:
    case REGEX_END_ANCHOR:
#if !SED_REGEX_EXTENDED
    case REGEX_BRE_SUBEXPRESSION_CARET:
    case REGEX_BRE_SUBEXPRESSION_DOLLAR:
#endif
#if SED_REGEX_EXTENDED
      state->regex_position = REGEX_AT_BRANCH_START;
#else
      state->regex_position = REGEX_AFTER_ANCHOR;
#endif
      return;
    case REGEX_ZERO_OR_MORE:
    case REGEX_INTERVAL_CLOSE:
    case REGEX_INVALID_INTERVAL:
#if SED_REGEX_EXTENDED
    case REGEX_ONE_OR_MORE:
    case REGEX_ZERO_OR_ONE:
#endif
      state->regex_position = REGEX_AFTER_DUPLICATION_SYMBOL;
      return;
#if SED_REGEX_EXTENDED
    case REGEX_REPETITION_MODIFIER:
      state->regex_position = REGEX_AFTER_REPETITION_MODIFIER;
      return;
#endif
    case REGEX_LITERAL:
    case INVALID_CHARACTER:
    case NUL_CHARACTER:
    case SINGLE_NUL_CHARACTER:
    case REGEX_PERIOD:
    case REGEX_QUOTED_ESCAPE:
    case ESCAPE_PREFIX:
    case REGEX_NEWLINE_ESCAPE:
    case REGEX_ESCAPED_DELIMITER:
    case REGEX_SPECIAL_ESCAPED_DELIMITER:
    case REGEX_UNCLOSED_GROUP:
#if !SED_REGEX_EXTENDED
    case REGEX_UNMATCHED_GROUP_CLOSE:
    case REGEX_BRE_VERTICAL_LINE_ESCAPE:
    case REGEX_BRE_QUESTION_MARK_ESCAPE:
    case REGEX_BRE_PLUS_ESCAPE:
    case REGEX_UNMATCHED_INTERVAL_CLOSE:
    case REGEX_BACKREFERENCE:
#endif
    case REGEX_INTERVAL_OPEN:
    case REGEX_DUP_COUNT:
    case REGEX_INTERVAL_SEPARATOR:
    case REGEX_NONPORTABLE_ESCAPE:
    case REGEX_INCOMPLETE_ESCAPE:
    case REGEX_BRACKET_OPEN:
    case REGEX_BRACKET_CLOSE:
    case REGEX_BRACKET_LITERAL:
    case REGEX_BRACKET_NEGATION:
    case REGEX_BRACKET_HYPHEN:
    case REGEX_BRACKET_RANGE_END_HYPHEN:
    case REGEX_BRACKET_TRAILING_HYPHEN:
    case REGEX_OPEN_COLON:
    case REGEX_CLASS_NAME:
    case REGEX_INVALID_CLASS_NAME:
    case REGEX_COLON_CLOSE:
    case REGEX_OPEN_DOT:
    case REGEX_COLL_ELEM_SINGLE:
    case REGEX_COLL_ELEM_MULTI:
    case REGEX_META_CHAR:
    case REGEX_DOT_CLOSE:
    case REGEX_OPEN_EQUAL:
    case REGEX_EQUAL_CLOSE:
    case REGEX_MISSING_BRACKET_TERM_CLOSE:
      state->regex_position = REGEX_AFTER_ATOM;
      return;
    default:
      return;
  }
}

static bool
sed_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
  ScannerState next = *(ScannerState *)payload;
  TSSymbol symbol;

  if (!sed_scanner_scan_impl(&next, lexer, valid_symbols, &symbol)) {
    return false;
  }

  update_regex_position_after_symbol(&next, symbol);
  *(ScannerState *)payload = next;
  lexer->result_symbol = symbol;
  return true;
}

#endif
