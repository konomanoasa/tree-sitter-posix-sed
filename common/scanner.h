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
  REGEX_AFTER_ALTERNATION,
#if !SED_REGEX_EXTENDED
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
  REGEX_BRACKET_PENDING_COLON,
};

typedef struct {
  int32_t delimiter;
  enum ScannerMode mode;
  enum RegexState regex_state;
  enum RegexPosition regex_position;
  bool text_line_has_content;
  bool text_raw;
  bool text_at_eof;
  enum RegexState regex_source_bracket;
  bool regex_in_interval;
  enum RegexBracketTermState regex_bracket_term_state;
  bool regex_bracket_term_has_content;
  enum RegexBracketPendingElement regex_bracket_pending_element;
  enum RegexBracketPendingElement regex_bracket_first_element;
  enum RegexBracketPendingElement regex_bracket_last_element;
  uint8_t regex_bracket_element_count;
  bool regex_bracket_range_pending;
  bool regex_bracket_complex;
  bool regex_bracket_class_content;
  uint32_t regex_group_depth;
} ScannerState;

enum { SCANNER_SERIALIZED_STATE_SIZE = 18 };

enum {
  SERIALIZED_TEXT_HAS_CONTENT_FLAG = 1 << 0,
  SERIALIZED_IN_INTERVAL_FLAG = 1 << 1,
  SERIALIZED_BRACKET_TERM_HAS_CONTENT_FLAG = 1 << 2,
  SERIALIZED_RANGE_PENDING_FLAG = 1 << 3,
  SERIALIZED_TEXT_RAW_FLAG = 1 << 4,
  SERIALIZED_TEXT_AT_EOF_FLAG = 1 << 5,
};

static inline void
reset_bracket_tracking(ScannerState *state, enum RegexState regex_state) {
  state->regex_state = regex_state;
  state->regex_bracket_term_state = REGEX_BRACKET_TERM_NONE;
  state->regex_bracket_term_has_content = false;
  state->regex_bracket_pending_element = REGEX_BRACKET_PENDING_NONE;
  state->regex_bracket_first_element = REGEX_BRACKET_PENDING_NONE;
  state->regex_bracket_last_element = REGEX_BRACKET_PENDING_NONE;
  state->regex_bracket_element_count = 0;
  state->regex_bracket_range_pending = false;
  state->regex_bracket_complex = false;
  state->regex_bracket_class_content = false;
}

static inline bool is_regex_mode(enum ScannerMode mode) {
  return mode == MODE_REGEX_ADDRESS || mode == MODE_SUBSTITUTE_PATTERN;
}

static inline bool regex_at_branch_start(const ScannerState *state) {
  return state->regex_position == REGEX_AT_BRANCH_START ||
    state->regex_position == REGEX_AFTER_ALTERNATION
#if !SED_REGEX_EXTENDED
    || state->regex_position == REGEX_AFTER_ANCHOR
#endif
    ;
}

static inline void reset_mode_tracking(ScannerState *state) {
  state->regex_position = REGEX_AFTER_ATOM;
  state->text_line_has_content = false;
  state->text_raw = false;
  state->text_at_eof = false;
  state->regex_source_bracket = REGEX_OUTSIDE_BRACKET;
  state->regex_in_interval = false;
  reset_bracket_tracking(state, REGEX_OUTSIDE_BRACKET);
  state->regex_group_depth = 0;
}

static inline void reset_state(ScannerState *state) {
  state->delimiter = 0;
  state->mode = MODE_NONE;
  reset_mode_tracking(state);
}

static inline void *sed_scanner_create(void) {
  return ts_calloc(1, sizeof(ScannerState));
}

static inline void sed_scanner_destroy(void *payload) {
  ts_free(payload);
}

static inline void
serialize_uint32(char *buffer, unsigned offset, uint32_t value) {
  buffer[offset] = (char)(value & UINT32_C(0xff));
  buffer[offset + 1] = (char)((value >> 8) & UINT32_C(0xff));
  buffer[offset + 2] = (char)((value >> 16) & UINT32_C(0xff));
  buffer[offset + 3] = (char)((value >> 24) & UINT32_C(0xff));
}

static inline uint32_t deserialize_uint32(const char *buffer, unsigned offset) {
  return (uint32_t)(unsigned char)buffer[offset] |
    ((uint32_t)(unsigned char)buffer[offset + 1] << 8) |
    ((uint32_t)(unsigned char)buffer[offset + 2] << 16) |
    ((uint32_t)(unsigned char)buffer[offset + 3] << 24);
}

static inline unsigned sed_scanner_serialize(void *payload, char *buffer) {
  const ScannerState *state = payload;

  buffer[0] = (char)state->mode;
  buffer[1] = (char)state->regex_state;
  buffer[2] = (char)state->regex_position;
  buffer[3] =
    (state->text_line_has_content ? SERIALIZED_TEXT_HAS_CONTENT_FLAG : 0) |
    (state->text_raw ? SERIALIZED_TEXT_RAW_FLAG : 0) |
    (state->text_at_eof ? SERIALIZED_TEXT_AT_EOF_FLAG : 0) |
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
  buffer[17] = (char)((state->regex_bracket_complex ? 1 : 0) |
    (state->regex_bracket_class_content ? 2 : 0) |
    (state->regex_source_bracket << 2));
  // Match Tree-sitter's empty initial state.
  for (unsigned index = 0; index < SCANNER_SERIALIZED_STATE_SIZE; index++) {
    if (buffer[index] != 0) return SCANNER_SERIALIZED_STATE_SIZE;
  }
  return 0;
}

static inline void
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
    .text_raw = (flags & SERIALIZED_TEXT_RAW_FLAG) != 0,
    .text_at_eof = (flags & SERIALIZED_TEXT_AT_EOF_FLAG) != 0,
    .regex_source_bracket = (enum RegexState)((buffer[17] >> 2) & 3),
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
    .regex_bracket_complex = (buffer[17] & 1) != 0,
    .regex_bracket_class_content = (buffer[17] & 2) != 0,
  };
}

static inline bool source_character_is_decoded(int32_t character) {
  const uint32_t code_point = (uint32_t)character;
  return code_point <= UINT32_C(0x10ffff) &&
    !(code_point >= UINT32_C(0xd800) && code_point <= UINT32_C(0xdfff));
}

static inline bool source_character_is_valid(int32_t character) {
  return character != 0 && source_character_is_decoded(character);
}

static inline bool delimiter_character_is_valid(int32_t character) {
  return source_character_is_valid(character) &&
    character != '\\' &&
    character != '\n';
}

static inline void advance(TSLexer *lexer) {
  lexer->advance(lexer, false);
}

static inline void consume(TSLexer *lexer) {
  advance(lexer);
  lexer->mark_end(lexer);
}

static inline void advance_unless_eof(TSLexer *lexer) {
  if (!lexer->eof(lexer)) {
    advance(lexer);
  }
}

static inline bool is_blank(int32_t character) {
  return character == ' ' || character == '\t';
}

static inline bool is_digit(int32_t character) {
  return character >= '0' && character <= '9';
}

static inline bool is_letter(int32_t character) {
  return (character >= 'a' && character <= 'z') ||
    (character >= 'A' && character <= 'Z');
}

static inline void advance_past_blanks(TSLexer *lexer) {
  while (is_blank(lexer->lookahead)) {
    advance(lexer);
  }
}

static inline bool at_line_end(const TSLexer *lexer) {
  return lexer->eof(lexer) || lexer->lookahead == '\n';
}

static inline bool at_line_character(const TSLexer *lexer) {
  return source_character_is_valid(lexer->lookahead) &&
    lexer->lookahead != '\n';
}

static inline bool scan_simple_delimiter(
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

static inline bool
emit_symbol(const bool *valid_symbols, TSSymbol candidate, TSSymbol *symbol) {
  if (!valid_symbols[candidate]) {
    return false;
  }

  *symbol = candidate;
  return true;
}

static inline bool consume_as(
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

static inline bool consume_invalid_character(
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

static inline bool end_mode(
  ScannerState *state,
  const bool *valid_symbols,
  TSSymbol candidate,
  TSSymbol *symbol
) {
  reset_state(state);
  return emit_symbol(valid_symbols, candidate, symbol);
}

static inline TSSymbol
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

static inline bool scan_active_mode_delimiter(
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

static inline bool end_unterminated_mode(
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

static inline bool scan_text_introducer(
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
    bool escaped = false;
    while (!lexer->eof(lexer)) {
      const int32_t character = lexer->lookahead;
      if (character == '\n' && !escaped) break;
      escaped = character == '\\' && !escaped;
      advance(lexer);
    }
    state->text_at_eof = lexer->eof(lexer);
    state->text_raw = state->text_at_eof && escaped;
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

static inline bool scan_line_rest(TSLexer *lexer) {
  bool consumed = false;
  while (at_line_character(lexer)) {
    consume(lexer);
    consumed = true;
  }
  return consumed;
}

static inline bool label_boundary(int32_t character) {
  return is_blank(character) ||
    character == ';' ||
    character == '#' ||
    character == '}';
}

static inline bool
scan_label_piece(TSLexer *lexer, const bool *valid_symbols, TSSymbol *symbol) {
  bool consumed = false;
  while (at_line_character(lexer) && !label_boundary(lexer->lookahead)) {
    consume(lexer);
    consumed = true;
  }
  return consumed && emit_symbol(valid_symbols, LABEL_LITERAL, symbol);
}

// Blanks before a closing brace or a missing brace at EOF are layout.
static inline bool
at_closing_brace(const TSLexer *lexer, const bool *valid_symbols) {
  return lexer->lookahead == '}' ||
    (lexer->lookahead == 0 &&
      lexer->eof(lexer) &&
      (valid_symbols[MISSING_CLOSING_BRACE_MARKER] ||
        valid_symbols[INCOMPLETE_COMMAND_SEPARATOR_MARKER]));
}

static inline bool scan_unexpected_command_text(
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
      if (at_closing_brace(lexer, valid_symbols)) break;
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

static inline bool is_substitution_flag_character(int32_t character) {
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

static inline bool emit_marker(
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

static inline bool can_start_address(TSLexer *lexer) {
  return is_digit(lexer->lookahead) ||
    lexer->lookahead == '$' ||
    lexer->lookahead == '/' ||
    lexer->lookahead == '\\';
}

static inline bool at_command_boundary(TSLexer *lexer) {
  return at_line_end(lexer) ||
    lexer->lookahead == ';' ||
    lexer->lookahead == '}';
}

static inline bool at_command_text(TSLexer *lexer) {
  return !at_command_boundary(lexer) && !is_blank(lexer->lookahead);
}

static inline TSSymbol missing_command_separator_marker(
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

static inline bool omitted_address_is_valid(const bool *valid_symbols) {
  return valid_symbols[OMITTED_ADDRESS_MARKER] ||
    valid_symbols[INCOMPLETE_OMITTED_ADDRESS_MARKER];
}

static inline bool post_blank_recovery_is_valid(const bool *valid_symbols) {
  return omitted_address_is_valid(valid_symbols) ||
    valid_symbols[BLANKS_AROUND_ADDRESS_SEPARATOR] ||
    valid_symbols[MISSING_ADDRESS_SEPARATOR_MARKER] ||
    valid_symbols[MISSING_SEPARATOR_BEFORE_UNMATCHED_BRACE_MARKER] ||
    valid_symbols[MISSING_COMMAND_SEPARATOR_MARKER] ||
    valid_symbols[INCOMPLETE_COMMAND_SEPARATOR_MARKER];
}

static inline bool scan_post_blank_recovery(
  TSLexer *lexer,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
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

static inline bool scan_argument_separator(
  TSLexer *lexer,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  do {
    consume(lexer);
  } while (is_blank(lexer->lookahead));
  return emit_symbol(valid_symbols, ARGUMENT_SEPARATOR, symbol);
}

static inline unsigned escape_radix(int32_t character) {
  return character == 'x' ? 16
    : character == 'o'    ? 8
    : character == 'd'    ? 10
                          : 0;
}

static int digit_value(int32_t character, unsigned radix) {
  int value = is_digit(character)          ? character - '0'
    : character >= 'a' && character <= 'f' ? character - 'a' + 10
    : character >= 'A' && character <= 'F' ? character - 'A' + 10
                                           : -1;
  return value >= 0 && (unsigned)value < radix ? value : -1;
}

static inline bool character_escape_letter(int32_t character) {
  return escape_radix(character) ||
    character == 'c' ||
    character == 'a' ||
    character == 'f' ||
    character == 'n' ||
    character == 'r' ||
    character == 't' ||
    character == 'v';
}

typedef struct {
  int32_t value;
  bool invalid_control;
  bool incomplete;
} CharacterEscape;

static CharacterEscape
read_character_escape(TSLexer *lexer, const ScannerState *state) {
  const int32_t letter = lexer->lookahead;
  const unsigned radix = escape_radix(letter);
  CharacterEscape result = {.value = letter};
  advance(lexer);
  if (radix) {
    unsigned value = 0;
    unsigned count = 0;
    while (
      count < (radix == 16 ? 2U : 3U) &&
      !at_line_end(lexer) &&
      (state->mode == MODE_TEXT || lexer->lookahead != state->delimiter)
    ) {
      int digit = digit_value(lexer->lookahead, radix);
      if (digit < 0) break;
      value = value * radix + (unsigned)digit;
      count++;
      advance(lexer);
    }
    if (count) result.value = (int32_t)(value & 255);
  } else if (letter == 'c') {
    if (
      at_line_end(lexer) ||
      (state->mode != MODE_TEXT &&
        !is_regex_mode(state->mode) &&
        lexer->lookahead == state->delimiter)
    ) {
      result.incomplete = is_regex_mode(state->mode);
    } else if (!source_character_is_decoded(lexer->lookahead)) {
      result.value = 0;
    } else {
      int32_t value = lexer->lookahead;
      advance(lexer);
      if (value == '\\') {
        if (lexer->lookahead == '\\') advance(lexer);
        else if (
          state->mode != MODE_TEXT &&
          (lexer->lookahead == state->delimiter || lexer->lookahead == '\n')
        ) {
          value = lexer->lookahead;
          advance(lexer);
          result.invalid_control =
            state->mode == MODE_SUBSTITUTE_REPLACEMENT && value == '&';
        } else if (!source_character_is_decoded(lexer->lookahead)) {
          result.value = 0;
          return result;
        } else result.invalid_control = true;
      }
      if (value >= 'a' && value <= 'z') value -= 'a' - 'A';
      result.value = value ^ 64;
    }
  } else {
    switch (letter) {
      case 'a':
        result.value = '\a';
        break;
      case 'f':
        result.value = '\f';
        break;
      case 'n':
        result.value = '\n';
        break;
      case 'r':
        result.value = '\r';
        break;
      case 't':
        result.value = '\t';
        break;
      case 'v':
        result.value = '\v';
        break;
      default:
        break;
    }
  }
  return result;
}

static inline bool scan_character_escape(
  TSLexer *lexer,
  const ScannerState *state,
  const bool *valid_symbols,
  TSSymbol normal,
  TSSymbol *symbol
) {
  CharacterEscape escape = read_character_escape(lexer, state);
  lexer->mark_end(lexer);
  const bool incomplete =
    lexer->eof(lexer) || (state->mode == MODE_TEXT && state->text_at_eof);
  return emit_symbol(
    valid_symbols,
    escape.invalid_control || escape.incomplete
      ? (incomplete ? INCOMPLETE_CONTROL_ESCAPE : INVALID_CONTROL_ESCAPE)
      : normal,
    symbol
  );
}

static inline bool scan_text_token(
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

  if (state->text_raw) {
    bool consumed = false;
    while (at_line_character(lexer)) {
      if (lexer->lookahead == '\\') {
        advance(lexer);
        if (lexer->eof(lexer) || lexer->lookahead == '\n') {
          if (consumed) break;
          if (lexer->lookahead == '\n') {
            consume(lexer);
            state->text_line_has_content = false;
            return emit_symbol(valid_symbols, TEXT_ESCAPED_NEWLINE, symbol);
          }
          lexer->mark_end(lexer);
          return emit_symbol(valid_symbols, TEXT_ESCAPE, symbol);
        }
        if (!source_character_is_valid(lexer->lookahead)) {
          if (consumed) break;
          lexer->mark_end(lexer);
          return emit_symbol(valid_symbols, ESCAPE_PREFIX, symbol);
        }
      }
      consume(lexer);
      consumed = true;
    }
    return consumed && emit_symbol(valid_symbols, TEXT_LITERAL, symbol);
  }

  if (lexer->lookahead == '\\') {
    consume(lexer);

    const TSSymbol dangling = dangling_escape_symbol(lexer, TEXT_ESCAPE);
    if (dangling != ERROR_SENTINEL) {
      return emit_symbol(valid_symbols, dangling, symbol);
    }
    if (lexer->lookahead == '\n') {
      consume(lexer);
      state->text_line_has_content = false;
      return emit_symbol(valid_symbols, TEXT_ESCAPED_NEWLINE, symbol);
    }

    if (!state->text_raw && character_escape_letter(lexer->lookahead)) {
      return scan_character_escape(
        lexer,
        state,
        valid_symbols,
        TEXT_ESCAPE,
        symbol
      );
    }
    return consume_as(lexer, valid_symbols, TEXT_ESCAPE, symbol);
  }

  do {
    consume(lexer);
  } while (at_line_character(lexer) && lexer->lookahead != '\\');
  return emit_symbol(valid_symbols, TEXT_LITERAL, symbol);
}

static inline bool regex_is_inside_bracket(const ScannerState *state) {
  return state->regex_state != REGEX_OUTSIDE_BRACKET;
}

static inline enum RegexBracketPendingElement
bracket_element_for_character(int32_t character) {
  switch (character) {
    case ':':
      return REGEX_BRACKET_PENDING_COLON;
    default:
      return REGEX_BRACKET_PENDING_OTHER;
  }
}

static inline void record_bracket_element(
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

static inline void commit_pending_bracket_element(ScannerState *state) {
  if (state->regex_bracket_pending_element == REGEX_BRACKET_PENDING_NONE) {
    return;
  }

  record_bracket_element(state, state->regex_bracket_pending_element);
  state->regex_bracket_pending_element = REGEX_BRACKET_PENDING_NONE;
}

static inline void complete_bracket_range(ScannerState *state) {
  state->regex_bracket_complex = true;
  record_bracket_element(state, REGEX_BRACKET_PENDING_OTHER);
  state->regex_bracket_range_pending = false;
}

static inline void finish_first_bracket_element(ScannerState *state) {
  if (
    state->regex_state == REGEX_BRACKET_FIRST ||
    state->regex_state == REGEX_BRACKET_AFTER_CARET
  ) {
    state->regex_state = REGEX_BRACKET_BODY;
  }
}

static inline void
begin_single_bracket_element(ScannerState *state, int32_t character) {
  if (character != ':') state->regex_bracket_class_content = true;
  finish_first_bracket_element(state);
  if (state->regex_bracket_range_pending) {
    complete_bracket_range(state);
    return;
  }

  commit_pending_bracket_element(state);
  state->regex_bracket_pending_element =
    bracket_element_for_character(character);
}

static inline void begin_compound_bracket_element(ScannerState *state) {
  state->regex_bracket_complex = true;
  finish_first_bracket_element(state);
  state->regex_bracket_term_has_content = false;
  if (!state->regex_bracket_range_pending) {
    commit_pending_bracket_element(state);
  }
}

static inline void finish_compound_bracket_element(ScannerState *state) {
  state->regex_bracket_term_state = REGEX_BRACKET_TERM_NONE;
  state->regex_bracket_term_has_content = false;
  if (state->regex_bracket_range_pending) {
    complete_bracket_range(state);
    return;
  }

  state->regex_bracket_pending_element = REGEX_BRACKET_PENDING_OTHER;
}

static inline bool bracket_expression_is_ambiguous(const ScannerState *state) {
  return !state->regex_bracket_complex &&
    state->regex_bracket_class_content &&
    state->regex_bracket_element_count >= 3U &&
    state->regex_bracket_first_element == REGEX_BRACKET_PENDING_COLON &&
    state->regex_bracket_first_element == state->regex_bracket_last_element;
}

static inline bool raw_regex_operator_character(int32_t character) {
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

static inline enum RegexBracketTermState
bracket_term_for_marker(int32_t character) {
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

static inline bool scan_regex_bracket_opener(
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

static inline void record_bracket_term_character(
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

static inline bool bracket_meta_character(int32_t character) {
  return character == '-' || character == ']';
}

static inline TSSymbol regex_bracket_term_content_symbol(
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

static inline bool emit_regex_bracket_term_close(
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

static inline bool scan_regex_bracket_term_content(
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

  if (!source_character_is_valid(lexer->lookahead)) {
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

static inline bool scan_regex_bracket_term_close(
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

static inline bool scan_regex_interval_open(
  TSLexer *lexer,
  ScannerState *state,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  consume(lexer);
  state->regex_in_interval = true;
  return emit_symbol(valid_symbols, REGEX_INTERVAL_OPEN, symbol);
}

static inline bool end_interval(
  ScannerState *state,
  const bool *valid_symbols,
  TSSymbol candidate,
  TSSymbol *symbol
) {
  state->regex_in_interval = false;
  return emit_symbol(valid_symbols, candidate, symbol);
}

static inline bool
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

static inline bool regex_interval_syntax_character(int32_t character) {
#if SED_REGEX_EXTENDED
  if (character == '}') {
    return true;
  }
#endif
  return is_digit(character) || character == ',' || character == '\\';
}

static inline void
scan_invalid_interval_characters(TSLexer *lexer, const ScannerState *state) {
  while (
    !regex_interval_content_ends(lexer, state) &&
    source_character_is_valid(lexer->lookahead) &&
    !regex_interval_syntax_character(lexer->lookahead)
  ) {
    consume(lexer);
  }
}

static inline bool raw_duplication_symbol_follows(
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

static inline TSSymbol regex_duplication_context_marker(
  const TSLexer *lexer,
  const ScannerState *state
) {
  if (regex_at_branch_start(state)) {
    return REGEX_LEADING_DUPLICATION_MARKER;
  }
  (void)lexer;
  return ERROR_SENTINEL;
}

static inline bool scan_raw_regex_operator(
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

static inline bool regex_delimiter_is_special(int32_t character) {
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

static inline bool escape_quotes_regex_syntax(int32_t character) {
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

#if !SED_REGEX_EXTENDED
static inline bool scan_bre_caret(
  TSLexer *lexer,
  const ScannerState *state,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  consume(lexer);
  if (
    state->regex_position != REGEX_AT_BRANCH_START &&
    state->regex_position != REGEX_AFTER_ALTERNATION
  ) {
    return emit_symbol(valid_symbols, REGEX_LITERAL, symbol);
  }
  return emit_symbol(
    valid_symbols,
    state->regex_group_depth > 0 ? REGEX_BRE_SUBEXPRESSION_CARET
                                 : REGEX_BEGINNING_ANCHOR,
    symbol
  );
}

static inline bool scan_bre_dollar(
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
      closes_subexpression ? REGEX_BRE_SUBEXPRESSION_DOLLAR
        : lexer->lookahead == '|' && state->delimiter != '|' ? REGEX_END_ANCHOR
                                                             : REGEX_LITERAL,
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

static const TSSymbol regex_delimiter_escape_symbols[][2] = {
  {REGEX_LITERAL, REGEX_ESCAPED_DELIMITER},
  {REGEX_BRACKET_OPEN, REGEX_ESCAPED_BRACKET_OPEN},
  {REGEX_PERIOD, REGEX_ESCAPED_PERIOD},
  {REGEX_BEGINNING_ANCHOR, REGEX_ESCAPED_BEGINNING_ANCHOR},
  {REGEX_END_ANCHOR, REGEX_ESCAPED_END_ANCHOR},
  {REGEX_ZERO_OR_MORE, REGEX_ESCAPED_ZERO_OR_MORE},
#if SED_REGEX_EXTENDED
  {REGEX_GROUP_OPEN, REGEX_ESCAPED_GROUP_OPEN},
  {REGEX_GROUP_CLOSE, REGEX_ESCAPED_GROUP_CLOSE},
  {REGEX_INTERVAL_OPEN, REGEX_ESCAPED_INTERVAL_OPEN},
  {REGEX_ONE_OR_MORE, REGEX_ESCAPED_ONE_OR_MORE},
  {REGEX_ZERO_OR_ONE, REGEX_ESCAPED_ZERO_OR_ONE},
  {REGEX_ALTERNATION_OPERATOR, REGEX_ESCAPED_ALTERNATION_OPERATOR},
  {REGEX_REPETITION_MODIFIER, REGEX_ESCAPED_REPETITION_MODIFIER},
#else
  {REGEX_BRE_SUBEXPRESSION_CARET, REGEX_ESCAPED_BRE_SUBEXPRESSION_CARET},
  {REGEX_BRE_SUBEXPRESSION_DOLLAR, REGEX_ESCAPED_BRE_SUBEXPRESSION_DOLLAR},
#endif
};

static inline TSSymbol regex_source_symbol(TSSymbol symbol, bool escaped) {
  for (
    size_t i = 0; i < sizeof(regex_delimiter_escape_symbols) /
      sizeof(regex_delimiter_escape_symbols[0]);
    i++
  ) {
    if (symbol == regex_delimiter_escape_symbols[i][escaped ? 0 : 1]) {
      return regex_delimiter_escape_symbols[i][escaped ? 1 : 0];
    }
  }
  return symbol;
}

static inline bool scan_regex_symbol(
  TSLexer *lexer,
  ScannerState *state,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  switch (lexer->lookahead) {
    case '[':
      consume(lexer);
      reset_bracket_tracking(state, REGEX_BRACKET_FIRST);
      return emit_symbol(valid_symbols, REGEX_BRACKET_OPEN, symbol);
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
    default:
      return scan_raw_regex_operator(lexer, state, valid_symbols, symbol);
  }
}

static inline bool scan_regex_escape_after_backslash(
  TSLexer *lexer,
  ScannerState *state,
  const bool *valid_symbols,
  bool source_escape,
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

  if (source_escape && lexer->lookahead == state->delimiter) {
    if (regex_delimiter_is_special(lexer->lookahead)) {
      if (!scan_regex_symbol(lexer, state, valid_symbols, symbol)) {
        return false;
      }
      return emit_symbol(
        valid_symbols,
        regex_source_symbol(*symbol, true),
        symbol
      );
    }
    return consume_as(lexer, valid_symbols, REGEX_ESCAPED_DELIMITER, symbol);
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
        REGEX_ALTERNATION_OPERATOR,
        symbol
      );
    case '?':
      return consume_as(
        lexer,
        valid_symbols,
        regex_at_branch_start(state) ? REGEX_CHARACTER_ESCAPE
                                     : REGEX_ZERO_OR_ONE,
        symbol
      );
    case '+':
      return consume_as(
        lexer,
        valid_symbols,
        regex_at_branch_start(state) ? REGEX_CHARACTER_ESCAPE
                                     : REGEX_ONE_OR_MORE,
        symbol
      );
    default:
      if (lexer->lookahead >= '1' && lexer->lookahead <= '9') {
        return consume_as(lexer, valid_symbols, REGEX_BACKREFERENCE, symbol);
      }
      break;
  }
#endif

  if (lexer->lookahead >= '1' && lexer->lookahead <= '9') {
    return consume_as(lexer, valid_symbols, REGEX_BACKREFERENCE, symbol);
  }
  if (
    lexer->lookahead == 'w' ||
    lexer->lookahead == 'W' ||
    lexer->lookahead == 's' ||
    lexer->lookahead == 'S'
  ) {
    return consume_as(lexer, valid_symbols, REGEX_CHARACTER_CLASS, symbol);
  }
  if (
    lexer->lookahead == 'b' ||
    lexer->lookahead == 'B' ||
    lexer->lookahead == '<' ||
    lexer->lookahead == '>' ||
    lexer->lookahead == '`' ||
    lexer->lookahead == 39
  ) {
    return consume_as(lexer, valid_symbols, REGEX_BOUNDARY_ASSERTION, symbol);
  }
  if (source_escape && lexer->lookahead == 'n') {
    return consume_as(lexer, valid_symbols, REGEX_NEWLINE_ESCAPE, symbol);
  }

  return consume_as(
    lexer,
    valid_symbols,
    escape_quotes_regex_syntax(lexer->lookahead) ? REGEX_QUOTED_ESCAPE
                                                 : REGEX_CHARACTER_ESCAPE,
    symbol
  );
}

static inline bool scan_regex_dup_count(
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

static inline bool emit_missing_interval_minimum(
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

static inline bool end_interval_content(
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

static inline bool scan_regex_interval_close(
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

static inline bool scan_regex_interval_separator(
  TSLexer *lexer,
  const bool *valid_symbols,
  TSSymbol separator,
  TSSymbol *symbol
) {
  return emit_missing_interval_minimum(lexer, valid_symbols, false, symbol) ||
    consume_as(lexer, valid_symbols, separator, symbol);
}

static inline bool scan_regex_interval_escape(
  TSLexer *lexer,
  ScannerState *state,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  advance(lexer);
  const int32_t character = lexer->lookahead;
  if (character != state->delimiter && character_escape_letter(character)) {
    CharacterEscape escape = read_character_escape(lexer, state);
    if (escape.invalid_control || escape.incomplete) {
      lexer->mark_end(lexer);
      return emit_symbol(
        valid_symbols,
        lexer->eof(lexer) ? INCOMPLETE_CONTROL_ESCAPE : INVALID_CONTROL_ESCAPE,
        symbol
      );
    }
    if (
      escape.value == ',' &&
      emit_missing_interval_minimum(lexer, valid_symbols, false, symbol)
    )
      return true;
    bool closing = false;
#if SED_REGEX_EXTENDED
    closing = escape.value == '}';
#else
    if (
      escape.value == '\\' && lexer->lookahead == '}' && state->delimiter != '}'
    ) {
      closing = true;
      advance(lexer);
    }
#endif
    if (
      closing &&
      emit_missing_interval_minimum(lexer, valid_symbols, false, symbol)
    )
      return true;
    lexer->mark_end(lexer);
    if (closing)
      return end_interval(
        state,
        valid_symbols,
        REGEX_INTERVAL_ENCODED_CLOSE,
        symbol
      );
    return emit_symbol(
      valid_symbols,
      is_digit(escape.value)  ? REGEX_INTERVAL_ENCODED_COUNT
        : escape.value == ',' ? REGEX_INTERVAL_ENCODED_SEPARATOR
                              : REGEX_INVALID_ENCODED_INTERVAL,
      symbol
    );
  }

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

static inline bool scan_regex_interval(
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

static inline bool scan_regex_bracket_close(
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

static inline bool scan_regex_bracket_hyphen(
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

static inline bool
scan_regex_outside_bracket(TSLexer *, ScannerState *, const bool *, TSSymbol *);

// Present one decoded character without changing its source range.
typedef struct {
  TSLexer lexer;
  TSLexer *source;
  bool decoded;
} DecodedLexer;

static inline void advance_decoded(TSLexer *lexer, bool skip) {
  DecodedLexer *input = (DecodedLexer *)lexer;
  if (input->decoded) input->decoded = false;
  else input->source->advance(input->source, skip);
  lexer->lookahead = input->source->lookahead;
}

static inline void mark_decoded_end(TSLexer *lexer) {
  DecodedLexer *input = (DecodedLexer *)lexer;
  if (!input->decoded) input->source->mark_end(input->source);
}

static inline bool decoded_eof(const TSLexer *lexer) {
  const DecodedLexer *input = (const DecodedLexer *)lexer;
  return !input->decoded && input->source->eof(input->source);
}

static const TSSymbol regex_character_escape_symbols[][2] = {
  {REGEX_LITERAL, REGEX_CHARACTER_ESCAPE},
  {REGEX_PERIOD, REGEX_ENCODED_PERIOD},
  {REGEX_BEGINNING_ANCHOR, REGEX_ENCODED_BEGINNING_ANCHOR},
  {REGEX_END_ANCHOR, REGEX_ENCODED_END_ANCHOR},
  {REGEX_ZERO_OR_MORE, REGEX_ENCODED_ZERO_OR_MORE},
  {REGEX_ONE_OR_MORE, REGEX_ENCODED_ONE_OR_MORE},
  {REGEX_ZERO_OR_ONE, REGEX_ENCODED_ZERO_OR_ONE},
  {REGEX_ALTERNATION_OPERATOR, REGEX_ENCODED_ALTERNATION_OPERATOR},
  {REGEX_GROUP_OPEN, REGEX_ENCODED_GROUP_OPEN},
  {REGEX_GROUP_CLOSE, REGEX_ENCODED_GROUP_CLOSE},
  {REGEX_INTERVAL_OPEN, REGEX_ENCODED_INTERVAL_OPEN},
  {REGEX_BRACKET_OPEN, REGEX_ENCODED_BRACKET_OPEN},
#if SED_REGEX_EXTENDED
  {REGEX_REPETITION_MODIFIER, REGEX_ENCODED_REPETITION_MODIFIER},
#else
  {REGEX_BRE_SUBEXPRESSION_CARET, REGEX_ENCODED_BRE_SUBEXPRESSION_CARET},
  {REGEX_BRE_SUBEXPRESSION_DOLLAR, REGEX_ENCODED_BRE_SUBEXPRESSION_DOLLAR},
#endif
};

static inline TSSymbol regex_character_symbol(TSSymbol symbol, bool encoded) {
  for (
    size_t i = 0; i < sizeof(regex_character_escape_symbols) /
      sizeof(regex_character_escape_symbols[0]);
    i++
  ) {
    if (symbol == regex_character_escape_symbols[i][encoded ? 0 : 1])
      return regex_character_escape_symbols[i][encoded ? 1 : 0];
  }
  return symbol;
}

static inline bool scan_encoded_regex_character(
  TSLexer *lexer,
  ScannerState *state,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  CharacterEscape escape = read_character_escape(lexer, state);
  const bool quoted = escape.value == '\\';
  if (quoted && !escape.invalid_control && !escape.incomplete) {
    if (at_line_end(lexer) || lexer->lookahead == state->delimiter) {
      lexer->mark_end(lexer);
      return emit_symbol(valid_symbols, REGEX_INCOMPLETE_ESCAPE, symbol);
    }
    escape.value = lexer->lookahead;
    advance(lexer);
    if (
      escape.value == '\\' &&
      lexer->lookahead != state->delimiter &&
      character_escape_letter(lexer->lookahead)
    ) {
      escape = read_character_escape(lexer, state);
    } else if (
      escape.value == '\\' &&
      (lexer->lookahead == '\\' || lexer->lookahead == state->delimiter)
    ) {
      escape.value = lexer->lookahead;
      advance(lexer);
    }
  }
  if (escape.invalid_control || escape.incomplete) {
    lexer->mark_end(lexer);
    return emit_symbol(
      valid_symbols,
      lexer->eof(lexer) ? INCOMPLETE_CONTROL_ESCAPE : INVALID_CONTROL_ESCAPE,
      symbol
    );
  }
  if (escape.value == 0 || escape.value == '\n') {
    lexer->mark_end(lexer);
    return emit_symbol(valid_symbols, REGEX_CHARACTER_ESCAPE, symbol);
  }
  DecodedLexer input = {
    .lexer =
      {.lookahead = escape.value,
        .advance = advance_decoded,
        .mark_end = mark_decoded_end,
        .eof = decoded_eof},
    .source = lexer,
    .decoded = true,
  };
  if (quoted) {
    if (!scan_regex_escape_after_backslash(
          &input.lexer,
          state,
          valid_symbols,
          false,
          symbol
        ))
      return false;
    if (*symbol == REGEX_QUOTED_ESCAPE) *symbol = REGEX_CHARACTER_ESCAPE;
  } else if (!scan_regex_outside_bracket(
               &input.lexer,
               state,
               valid_symbols,
               symbol
             )) {
    return false;
  }
  return emit_symbol(
    valid_symbols,
    regex_character_symbol(*symbol, true),
    symbol
  );
}

static inline bool scan_regex_outside_bracket(
  TSLexer *lexer,
  ScannerState *state,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  lexer->mark_end(lexer);
  if (lexer->lookahead == '\\') {
    advance(lexer);
    const bool escaped_delimiter = lexer->lookahead == state->delimiter;
    if (
      !escaped_delimiter &&
      lexer->lookahead != 'n' &&
      character_escape_letter(lexer->lookahead)
    ) {
      return scan_encoded_regex_character(lexer, state, valid_symbols, symbol);
    }
    const TSSymbol marker = regex_duplication_context_marker(lexer, state);
    if (marker != ERROR_SENTINEL && valid_symbols[marker] &&
      ((escaped_delimiter && raw_duplication_symbol_follows(lexer, state))
#if !SED_REGEX_EXTENDED
        || (!escaped_delimiter && lexer->lookahead == '{')
#endif
      )) {
      *symbol = marker;
      return true;
    }
    lexer->mark_end(lexer);
    return scan_regex_escape_after_backslash(
      lexer,
      state,
      valid_symbols,
      true,
      symbol
    );
  }

  const TSSymbol marker = regex_duplication_context_marker(lexer, state);
  if (marker != ERROR_SENTINEL && valid_symbols[marker] &&
    (raw_duplication_symbol_follows(lexer, state)
#if SED_REGEX_EXTENDED
      || lexer->lookahead == '{'
#endif
    )) {
    *symbol = marker;
    return true;
  }

  switch (lexer->lookahead) {
    case '^':
    case '$':
    case '.':
      return scan_regex_symbol(lexer, state, valid_symbols, symbol);
    case '[':
      consume(lexer);
      reset_bracket_tracking(state, REGEX_BRACKET_FIRST);
      return emit_symbol(valid_symbols, REGEX_BRACKET_OPEN, symbol);
    default:
      break;
  }

  if (raw_regex_operator_character(lexer->lookahead)) {
    return scan_regex_symbol(lexer, state, valid_symbols, symbol);
  }
  if (!source_character_is_valid(lexer->lookahead)) {
    return consume_invalid_character(lexer, valid_symbols, symbol);
  }
  return consume_as(lexer, valid_symbols, REGEX_LITERAL, symbol);
}

static inline bool scan_regex_inside_bracket(
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

static inline bool scan_operand_literal(
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

static inline bool scan_replacement_escape(
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
    candidate = REPLACEMENT_ESCAPED_DELIMITER;
  } else if (is_digit(lexer->lookahead)) {
    candidate = REPLACEMENT_BACKREFERENCE;
  } else if (character_escape_letter(lexer->lookahead)) {
    return scan_character_escape(
      lexer,
      state,
      valid_symbols,
      REPLACEMENT_ESCAPE_SEQUENCE,
      symbol
    );
  } else if (
    lexer->lookahead == 'E' ||
    lexer->lookahead == 'L' ||
    lexer->lookahead == 'U' ||
    lexer->lookahead == 'l' ||
    lexer->lookahead == 'u'
  ) {
    candidate = REPLACEMENT_CASE_CONVERSION;
  } else {
    candidate = REPLACEMENT_ESCAPE_SEQUENCE;
  }
  return consume_as(lexer, valid_symbols, candidate, symbol);
}

static inline bool scan_translate_escape(
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
    return consume_as(lexer, valid_symbols, TRANSLATE_ESCAPE, symbol);
  }

  TSSymbol candidate;
  if (lexer->lookahead == 'n' || lexer->lookahead == '\\') {
    candidate = TRANSLATE_ESCAPE;
  } else if (lexer->lookahead == state->delimiter) {
    candidate = TRANSLATE_ESCAPED_DELIMITER;
  } else if (character_escape_letter(lexer->lookahead)) {
    return scan_character_escape(
      lexer,
      state,
      valid_symbols,
      TRANSLATE_ESCAPE,
      symbol
    );
  } else {
    candidate = TRANSLATE_ESCAPE;
  }
  return consume_as(lexer, valid_symbols, candidate, symbol);
}

static inline bool scan_operand_token(
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

static inline bool scan_regex_closer(
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

static inline bool scan_brace_leading_blanks(
  TSLexer *lexer,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  advance_past_blanks(lexer);
  if (!at_closing_brace(lexer, valid_symbols)) {
    return false;
  }
  lexer->mark_end(lexer);
  *symbol = BRACE_LEADING_BLANKS;
  return true;
}

static inline bool scan_block_trailing_blanks(
  TSLexer *lexer,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  while (is_blank(lexer->lookahead)) {
    lexer->advance(lexer, true);
  }
  if (lexer->eof(lexer) && !at_closing_brace(lexer, valid_symbols)) {
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

static inline bool scan_command_recovery(
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
      lexer->mark_end(lexer);
      advance_past_blanks(lexer);
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

static inline bool at_invalid_substitution_flag(TSLexer *lexer) {
  return at_command_text(lexer) &&
    !is_substitution_flag_character(lexer->lookahead) &&
    source_character_is_decoded(lexer->lookahead);
}

static inline bool scan_command_token(
  TSLexer *lexer,
  ScannerState *state,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  if (valid_symbols[BLOCK_TRAILING_BLANKS] && is_blank(lexer->lookahead)) {
    return scan_block_trailing_blanks(lexer, valid_symbols, symbol);
  }

  if (
    valid_symbols[EMPTY_COMMAND_MARKER] &&
    !valid_symbols[LABEL_COMMAND_END] &&
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

  if (valid_symbols[LINE_WORD] && scan_line_rest(lexer)) {
    *symbol = LINE_WORD;
    return true;
  }

  if (
    valid_symbols[LABEL_LITERAL] &&
    scan_label_piece(lexer, valid_symbols, symbol)
  ) {
    return true;
  }

  if (is_blank(lexer->lookahead) && valid_symbols[ARGUMENT_SEPARATOR]) {
    return scan_argument_separator(lexer, valid_symbols, symbol);
  }

  if (valid_symbols[LABEL_COMMAND_END]) {
    if (
      is_blank(lexer->lookahead) ||
      lexer->lookahead == ';' ||
      lexer->lookahead == '\n'
    )
      return false;
    return emit_marker(lexer, valid_symbols, LABEL_COMMAND_END, symbol);
  }

  if (valid_symbols[FILE_ARGUMENT] && scan_line_rest(lexer)) {
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

  if (valid_symbols[COMMENT_TEXT] && scan_line_rest(lexer)) {
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

static inline bool sed_scanner_scan_impl(
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
    !(regex_mode && state->regex_source_bracket);
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
  if (state->regex_source_bracket == REGEX_OUTSIDE_BRACKET) {
    if (lexer->lookahead == '[')
      state->regex_source_bracket = REGEX_BRACKET_FIRST;
  } else if (
    state->regex_source_bracket == REGEX_BRACKET_FIRST &&
    lexer->lookahead == '^'
  ) {
    state->regex_source_bracket = REGEX_BRACKET_AFTER_CARET;
  } else if (state->regex_source_bracket != REGEX_BRACKET_BODY) {
    state->regex_source_bracket = REGEX_BRACKET_BODY;
  } else if (
    lexer->lookahead == ']' &&
    state->regex_bracket_term_state == REGEX_BRACKET_TERM_NONE
  ) {
    state->regex_source_bracket = REGEX_OUTSIDE_BRACKET;
  }
  return regex_is_inside_bracket(state)
    ? scan_regex_inside_bracket(lexer, state, valid_symbols, symbol)
    : scan_regex_outside_bracket(lexer, state, valid_symbols, symbol);
}

static inline void
update_regex_position_after_symbol(ScannerState *state, TSSymbol symbol) {
  if (!is_regex_mode(state->mode)) {
    return;
  }

  switch (regex_character_symbol(regex_source_symbol(symbol, false), false)) {
    case REGEX_GROUP_OPEN:
      state->regex_group_depth++;
      state->regex_position = REGEX_AT_BRANCH_START;
      return;
    case REGEX_GROUP_CLOSE:
      state->regex_group_depth--;
      state->regex_position = REGEX_AFTER_ATOM;
      return;
    case REGEX_ALTERNATION_OPERATOR:
      state->regex_position = REGEX_AFTER_ALTERNATION;
      return;
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
    case REGEX_INTERVAL_ENCODED_CLOSE:
    case REGEX_INVALID_INTERVAL:
    case REGEX_ONE_OR_MORE:
    case REGEX_ZERO_OR_ONE:
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
    case REGEX_CHARACTER_ESCAPE:
    case REGEX_CHARACTER_CLASS:
    case REGEX_BOUNDARY_ASSERTION:
    case INVALID_CONTROL_ESCAPE:
    case INCOMPLETE_CONTROL_ESCAPE:
    case REGEX_ESCAPED_DELIMITER:
    case REGEX_UNCLOSED_GROUP:
#if !SED_REGEX_EXTENDED
    case REGEX_UNMATCHED_GROUP_CLOSE:
    case REGEX_UNMATCHED_INTERVAL_CLOSE:
#endif
    case REGEX_BACKREFERENCE:
    case REGEX_INTERVAL_OPEN:
    case REGEX_DUP_COUNT:
    case REGEX_INTERVAL_SEPARATOR:
    case REGEX_INTERVAL_ENCODED_COUNT:
    case REGEX_INTERVAL_ENCODED_SEPARATOR:
    case REGEX_INVALID_ENCODED_INTERVAL:
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

static inline bool
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
