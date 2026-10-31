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
};

enum RegexBracketTermState {
  REGEX_BRACKET_TERM_NONE,
  REGEX_BRACKET_TERM_COLON,
  REGEX_BRACKET_TERM_DOT,
  REGEX_BRACKET_TERM_EQUAL,
};

typedef struct {
  int32_t delimiter;
  enum ScannerMode mode;
  enum RegexState regex_state;
  enum RegexPosition regex_position;
  bool text_line_has_content;
  bool text_raw;
  enum RegexState regex_source_bracket;
  bool regex_in_interval;
  enum RegexBracketTermState regex_bracket_term_state;
  uint32_t regex_group_depth;
} ScannerState;

enum { SCANNER_SERIALIZED_STATE_SIZE = 13 };

static inline void
reset_bracket_tracking(ScannerState *state, enum RegexState value) {
  state->regex_state = value;
  state->regex_bracket_term_state = REGEX_BRACKET_TERM_NONE;
}

static inline bool is_regex_mode(enum ScannerMode mode) {
  return mode == MODE_REGEX_ADDRESS || mode == MODE_SUBSTITUTE_PATTERN;
}

#if !SED_REGEX_EXTENDED
static inline bool regex_at_branch_start(const ScannerState *state) {
  return state->regex_position == REGEX_AT_BRANCH_START ||
    state->regex_position == REGEX_AFTER_ALTERNATION ||
    state->regex_position == REGEX_AFTER_ANCHOR;
}
#endif

static inline void reset_mode_tracking(ScannerState *state) {
  state->regex_position = REGEX_AFTER_ATOM;
  state->text_line_has_content = false;
  state->text_raw = false;
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
  if (payload == NULL) return 0;
  const ScannerState *state = payload;
  buffer[0] = (char)state->mode;
  buffer[1] = (char)state->regex_state;
  buffer[2] = (char)state->regex_position;
  buffer[3] = (char)(state->text_line_has_content |
    state->text_raw << 1 |
    state->regex_in_interval << 2 |
    state->regex_source_bracket << 3);
  serialize_uint32(buffer, 4, (uint32_t)state->delimiter);
  serialize_uint32(buffer, 8, state->regex_group_depth);
  buffer[12] = (char)state->regex_bracket_term_state;
  // Match Tree-sitter's empty initial state.
  for (unsigned i = 0; i < SCANNER_SERIALIZED_STATE_SIZE; i++) {
    if (buffer[i]) return SCANNER_SERIALIZED_STATE_SIZE;
  }
  return 0;
}

static inline void
sed_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
  if (payload == NULL) return;
  ScannerState *state = payload;
  reset_state(state);
  if (length != SCANNER_SERIALIZED_STATE_SIZE) return;
  const unsigned char flags = (unsigned char)buffer[3];
  state->mode = (enum ScannerMode)(unsigned char)buffer[0];
  state->regex_state = (enum RegexState)(unsigned char)buffer[1];
  state->regex_position = (enum RegexPosition)(unsigned char)buffer[2];
  state->text_line_has_content = (flags & 1) != 0;
  state->text_raw = (flags & 2) != 0;
  state->regex_in_interval = (flags & 4) != 0;
  state->regex_source_bracket = (enum RegexState)(flags >> 3);
  state->delimiter = (int32_t)deserialize_uint32(buffer, 4);
  state->regex_group_depth = deserialize_uint32(buffer, 8);
  state->regex_bracket_term_state =
    (enum RegexBracketTermState)(unsigned char)buffer[12];
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

static inline bool end_mode(
  ScannerState *state,
  const bool *valid_symbols,
  TSSymbol candidate,
  TSSymbol *symbol
) {
  reset_state(state);
  return emit_symbol(valid_symbols, candidate, symbol);
}

static const struct {
  TSSymbol closing;
  enum ScannerMode next_mode;
} delimited_modes[] = {
  [MODE_NONE] = {ERROR_SENTINEL, MODE_NONE},
  [MODE_REGEX_ADDRESS] = {REGEX_ADDRESS_END, MODE_NONE},
  [MODE_SUBSTITUTE_PATTERN] = {SUBSTITUTE_MIDDLE, MODE_SUBSTITUTE_REPLACEMENT},
  [MODE_SUBSTITUTE_REPLACEMENT] = {SUBSTITUTE_END, MODE_NONE},
  [MODE_TRANSLATE_SOURCE] = {TRANSLATE_MIDDLE, MODE_TRANSLATE_DESTINATION},
  [MODE_TRANSLATE_DESTINATION] = {TRANSLATE_END, MODE_NONE},
  [MODE_TEXT] = {ERROR_SENTINEL, MODE_NONE},
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

static inline bool scan_text_introducer(
  TSLexer *lexer,
  ScannerState *state,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  advance(lexer);
  if (lexer->lookahead != '\n') return false;
  consume(lexer);
  reset_state(state);
  state->mode = MODE_TEXT;
  bool escaped = false;
  while (!lexer->eof(lexer)) {
    const int32_t character = lexer->lookahead;
    if (character == '\n' && !escaped) break;
    escaped = character == '\\' && !escaped;
    advance(lexer);
  }
  state->text_raw = lexer->eof(lexer) && escaped;
  return emit_symbol(valid_symbols, TEXT_COMMAND_START, symbol);
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

static inline bool at_command_boundary(TSLexer *lexer) {
  return at_line_end(lexer) ||
    lexer->lookahead == ';' ||
    lexer->lookahead == '}';
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

static inline int digit_value(int32_t character, unsigned radix) {
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

static inline CharacterEscape
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
    if (count) {
      result.value = (int32_t)(value & 255);
    }
  } else if (letter == 'c') {
    if (
      at_line_end(lexer) ||
      (state->mode != MODE_TEXT &&
        !is_regex_mode(state->mode) &&
        lexer->lookahead == state->delimiter)
    ) {
      result.incomplete = is_regex_mode(state->mode);
    } else if (!source_character_is_valid(lexer->lookahead)) {
      result.invalid_control = true;
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
        } else if (!source_character_is_valid(lexer->lookahead)) {
          result.invalid_control = true;
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
  const CharacterEscape escape = read_character_escape(lexer, state);
  lexer->mark_end(lexer);
  return !escape.invalid_control &&
    !escape.incomplete &&
    emit_symbol(valid_symbols, normal, symbol);
}

static inline bool scan_text_token(
  TSLexer *lexer,
  ScannerState *state,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  if (lexer->eof(lexer)) {
    if (!state->text_line_has_content) return false;
    lexer->mark_end(lexer);
    return end_mode(state, valid_symbols, TEXT_EOF, symbol);
  }

  if (lexer->lookahead == '\n') {
    lexer->mark_end(lexer);
    return end_mode(state, valid_symbols, TEXT_LINE_END, symbol);
  }

  state->text_line_has_content = true;
  if (!source_character_is_valid(lexer->lookahead)) {
    return false;
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
          return false;
        }
      }
      consume(lexer);
      consumed = true;
    }
    return consumed && emit_symbol(valid_symbols, TEXT_LITERAL, symbol);
  }

  if (lexer->lookahead == '\\') {
    consume(lexer);

    if (lexer->eof(lexer))
      return emit_symbol(valid_symbols, TEXT_ESCAPE, symbol);
    if (!source_character_is_valid(lexer->lookahead)) return false;
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

static inline void finish_first_bracket_element(ScannerState *state) {
  if (
    state->regex_state == REGEX_BRACKET_FIRST ||
    state->regex_state == REGEX_BRACKET_AFTER_CARET
  ) {
    state->regex_state = REGEX_BRACKET_BODY;
  }
}

static inline void finish_compound_bracket_element(ScannerState *state) {
  state->regex_bracket_term_state = REGEX_BRACKET_TERM_NONE;
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
  consume(lexer);
  const enum RegexBracketTermState term =
    bracket_term_for_marker(lexer->lookahead);
  finish_first_bracket_element(state);
  if (term == REGEX_BRACKET_TERM_NONE)
    return emit_symbol(valid_symbols, REGEX_BRACKET_LITERAL, symbol);
  state->regex_bracket_term_state = term;
  return emit_symbol(valid_symbols, bracket_terms[term].open_symbol, symbol);
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
  int32_t single_character
) {
  if (state->regex_bracket_term_state == REGEX_BRACKET_TERM_COLON) {
    return REGEX_CLASS_NAME;
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
  const int32_t marker = bracket_terms[state->regex_bracket_term_state].marker;
  const bool class_name =
    state->regex_bracket_term_state == REGEX_BRACKET_TERM_COLON;
  uint8_t count = 0;
  int32_t single = 0;
  while (at_line_character(lexer)) {
    const int32_t character = lexer->lookahead;
    if (character == marker) {
      advance(lexer);
      if (lexer->lookahead == ']') break;
      if (class_name) return false;
      lexer->mark_end(lexer);
    } else {
      if (
        class_name && !(is_letter(character) || (count && is_digit(character)))
      )
        return false;
      consume(lexer);
    }
    record_bracket_term_character(&count, &single, character);
  }
  if (!count) return false;
  return emit_symbol(
    valid_symbols,
    regex_bracket_term_content_symbol(state, count, single),
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
  if (lexer->lookahead != ']') return false;
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
    state->regex_group_depth > 0 ? ERROR_SENTINEL : REGEX_BEGINNING_ANCHOR,
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
      closes_subexpression                                   ? ERROR_SENTINEL
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
  if (at_line_end(lexer) || !source_character_is_valid(lexer->lookahead))
    return false;

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
      return consume_as(lexer, valid_symbols, REGEX_CHARACTER_ESCAPE, symbol);
    case '(':
      return consume_as(lexer, valid_symbols, REGEX_GROUP_OPEN, symbol);
    case ')':
      return consume_as(
        lexer,
        valid_symbols,
        state->regex_group_depth > 0 ? REGEX_GROUP_CLOSE : ERROR_SENTINEL,
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

static inline bool scan_regex_interval_close(
  TSLexer *lexer,
  ScannerState *state,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  consume(lexer);
  return end_interval(state, valid_symbols, REGEX_INTERVAL_CLOSE, symbol);
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
    const CharacterEscape escape = read_character_escape(lexer, state);
    if (escape.invalid_control || escape.incomplete) return false;
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
                              : ERROR_SENTINEL,
      symbol
    );
  }
#if !SED_REGEX_EXTENDED
  if (character == '}' && state->delimiter != '}')
    return scan_regex_interval_close(lexer, state, valid_symbols, symbol);
#endif
  if (character != state->delimiter) return false;
  if (character == ',')
    return consume_as(
      lexer,
      valid_symbols,
      REGEX_INTERVAL_ESCAPED_SEPARATOR,
      symbol
    );
  return is_digit(character) &&
    consume_as(lexer, valid_symbols, REGEX_INTERVAL_ESCAPED_COUNT, symbol);
}

static inline bool scan_regex_interval(
  TSLexer *lexer,
  ScannerState *state,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  if (at_line_end(lexer) || lexer->lookahead == state->delimiter) return false;
#if SED_REGEX_EXTENDED
  if (lexer->lookahead == '}')
    return scan_regex_interval_close(lexer, state, valid_symbols, symbol);
#endif
  if (lexer->lookahead == ',')
    return consume_as(lexer, valid_symbols, REGEX_INTERVAL_SEPARATOR, symbol);
  if (lexer->lookahead == '\\')
    return scan_regex_interval_escape(lexer, state, valid_symbols, symbol);
  return is_digit(lexer->lookahead) &&
    scan_regex_dup_count(lexer, state, valid_symbols, symbol);
}

static inline bool scan_regex_bracket_close(
  TSLexer *lexer,
  ScannerState *state,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  consume(lexer);
  reset_bracket_tracking(state, REGEX_OUTSIDE_BRACKET);
  return emit_symbol(valid_symbols, REGEX_BRACKET_CLOSE, symbol);
}

static inline bool scan_regex_bracket_hyphen(
  TSLexer *lexer,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  consume(lexer);
  if (valid_symbols[REGEX_BRACKET_RANGE_END_HYPHEN])
    return emit_symbol(valid_symbols, REGEX_BRACKET_RANGE_END_HYPHEN, symbol);
  return emit_symbol(
    valid_symbols,
    lexer->lookahead == ']' ? REGEX_BRACKET_TRAILING_HYPHEN
                            : REGEX_BRACKET_HYPHEN,
    symbol
  );
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
      return false;
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
  if (escape.invalid_control || escape.incomplete) return false;
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
    lexer->mark_end(lexer);
    return scan_regex_escape_after_backslash(
      lexer,
      state,
      valid_symbols,
      true,
      symbol
    );
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
    return false;
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
    valid_symbols[REGEX_COLL_ELEM_SINGLE] ||
    valid_symbols[REGEX_COLL_ELEM_MULTI] ||
    valid_symbols[REGEX_META_CHAR]
  ) {
    return scan_regex_bracket_term_content(lexer, state, valid_symbols, symbol);
  }
  if (state->regex_bracket_term_state != REGEX_BRACKET_TERM_NONE) {
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
        return scan_regex_bracket_hyphen(lexer, valid_symbols, symbol);
      }
      break;
    default:
      break;
  }

  finish_first_bracket_element(state);
  if (!source_character_is_valid(lexer->lookahead)) {
    return false;
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

  if (lexer->eof(lexer) || !source_character_is_valid(lexer->lookahead))
    return false;

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

  if (lexer->eof(lexer) || !source_character_is_valid(lexer->lookahead))
    return false;

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
    return false;
  }
  if (lexer->lookahead == '\\') {
    return is_replacement
      ? scan_replacement_escape(lexer, state, valid_symbols, symbol)
      : scan_translate_escape(lexer, state, valid_symbols, symbol);
  }
  return consume_as(lexer, valid_symbols, REPLACEMENT_MATCH_REFERENCE, symbol);
}

static inline bool scan_brace_leading_blanks(
  TSLexer *lexer,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  advance_past_blanks(lexer);
  if (lexer->lookahead != '}') return false;
  lexer->mark_end(lexer);
  return emit_symbol(valid_symbols, BRACE_LEADING_BLANKS, symbol);
}

static inline bool scan_block_trailing_blanks(
  TSLexer *lexer,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  while (is_blank(lexer->lookahead)) lexer->advance(lexer, true);
  if (lexer->eof(lexer) || !at_command_boundary(lexer)) return false;
  lexer->mark_end(lexer);
  return emit_symbol(valid_symbols, BLOCK_TRAILING_BLANKS, symbol);
}

static inline bool scan_command_token(
  TSLexer *lexer,
  ScannerState *state,
  const bool *valid_symbols,
  TSSymbol *symbol
) {
  if (valid_symbols[BLOCK_TRAILING_BLANKS] && is_blank(lexer->lookahead))
    return scan_block_trailing_blanks(lexer, valid_symbols, symbol);
  if (
    valid_symbols[EMPTY_COMMAND_MARKER] &&
    !valid_symbols[LABEL_COMMAND_END] &&
    (lexer->lookahead == ';' || lexer->lookahead == '\n')
  )
    return emit_marker(lexer, valid_symbols, EMPTY_COMMAND_MARKER, symbol);
  if (
    valid_symbols[LABEL_LITERAL] &&
    scan_label_piece(lexer, valid_symbols, symbol)
  )
    return true;
  if (is_blank(lexer->lookahead) && valid_symbols[ARGUMENT_SEPARATOR])
    return scan_argument_separator(lexer, valid_symbols, symbol);
  if (valid_symbols[LABEL_COMMAND_END]) {
    if (
      is_blank(lexer->lookahead) ||
      lexer->lookahead == ';' ||
      lexer->lookahead == '}' ||
      lexer->lookahead == '\n'
    )
      return false;
    return emit_marker(lexer, valid_symbols, LABEL_COMMAND_END, symbol);
  }
  if (valid_symbols[FILE_ARGUMENT] && scan_line_rest(lexer))
    return emit_symbol(valid_symbols, FILE_ARGUMENT, symbol);
  if (valid_symbols[TEXT_COMMAND_START] && lexer->lookahead == '\\')
    return scan_text_introducer(lexer, state, valid_symbols, symbol);
  if (
    lexer->lookahead == 'n' &&
    consume_as(lexer, valid_symbols, DEFAULT_OUTPUT_SUPPRESSION, symbol)
  )
    return true;
  if (valid_symbols[COMMENT_TEXT] && scan_line_rest(lexer))
    return emit_symbol(valid_symbols, COMMENT_TEXT, symbol);
  if (valid_symbols[BRACE_LEADING_BLANKS] && is_blank(lexer->lookahead))
    return scan_brace_leading_blanks(lexer, valid_symbols, symbol);
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

  return false;
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
    return at_closing_delimiter &&
      scan_active_mode_delimiter(lexer, state, valid_symbols, symbol);
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
#if SED_REGEX_EXTENDED
      state->regex_position = REGEX_AT_BRANCH_START;
#else
      state->regex_position = REGEX_AFTER_ANCHOR;
#endif
      return;
    case REGEX_ZERO_OR_MORE:
    case REGEX_INTERVAL_CLOSE:
    case REGEX_INTERVAL_ENCODED_CLOSE:
    case REGEX_ONE_OR_MORE:
    case REGEX_ZERO_OR_ONE:
      state->regex_position = REGEX_AFTER_DUPLICATION_SYMBOL;
      return;
#if SED_REGEX_EXTENDED
    case REGEX_REPETITION_MODIFIER:
      state->regex_position = REGEX_AFTER_ATOM;
      return;
#endif
    case REGEX_LITERAL:
    case REGEX_PERIOD:
    case REGEX_QUOTED_ESCAPE:
    case REGEX_NEWLINE_ESCAPE:
    case REGEX_CHARACTER_ESCAPE:
    case REGEX_CHARACTER_CLASS:
    case REGEX_BOUNDARY_ASSERTION:
    case REGEX_ESCAPED_DELIMITER:
    case REGEX_BACKREFERENCE:
    case REGEX_INTERVAL_OPEN:
    case REGEX_DUP_COUNT:
    case REGEX_INTERVAL_SEPARATOR:
    case REGEX_INTERVAL_ENCODED_COUNT:
    case REGEX_INTERVAL_ENCODED_SEPARATOR:
    case REGEX_BRACKET_OPEN:
    case REGEX_BRACKET_CLOSE:
    case REGEX_BRACKET_LITERAL:
    case REGEX_BRACKET_NEGATION:
    case REGEX_BRACKET_HYPHEN:
    case REGEX_BRACKET_RANGE_END_HYPHEN:
    case REGEX_BRACKET_TRAILING_HYPHEN:
    case REGEX_OPEN_COLON:
    case REGEX_CLASS_NAME:
    case REGEX_COLON_CLOSE:
    case REGEX_OPEN_DOT:
    case REGEX_COLL_ELEM_SINGLE:
    case REGEX_COLL_ELEM_MULTI:
    case REGEX_META_CHAR:
    case REGEX_DOT_CLOSE:
    case REGEX_OPEN_EQUAL:
    case REGEX_EQUAL_CLOSE:
      state->regex_position = REGEX_AFTER_ATOM;
      return;
    default:
      return;
  }
}

static inline bool
sed_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
  if (payload == NULL) return false;
  ScannerState next = *(ScannerState *)payload;
  TSSymbol symbol;

  if (!sed_scanner_scan_impl(&next, lexer, valid_symbols, &symbol)) {
    return false;
  }

  // Tree-sitter tracks only the first lookahead byte of a decoded character.
  if (lexer->lookahead >= 0x80 && source_character_is_decoded(lexer->lookahead))
    advance(lexer);
  update_regex_position_after_symbol(&next, symbol);
  *(ScannerState *)payload = next;
  lexer->result_symbol = symbol;
  return true;
}

#endif
