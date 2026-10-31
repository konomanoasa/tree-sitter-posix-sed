#include <assert.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "../common/scanner.h"

enum {
  SERIALIZATION_GUARD_BYTE = 0x5a,
  SERIALIZATION_GROUP_DEPTH = 37,
};

#ifdef TREE_SITTER_REUSE_ALLOCATOR
static size_t reuse_calloc_calls;
static size_t reuse_free_calls;
static size_t reuse_live_allocations;
static bool reuse_fail_next_calloc;

static void *reuse_calloc(size_t count, size_t size) {
  reuse_calloc_calls += 1;
  if (reuse_fail_next_calloc) {
    reuse_fail_next_calloc = false;
    return NULL;
  }
  void *result = calloc(count, size);
  if (result != NULL) {
    reuse_live_allocations += 1;
  }
  return result;
}

static void reuse_free(void *allocation) {
  reuse_free_calls += 1;
  if (allocation != NULL) {
    assert(reuse_live_allocations > 0);
    reuse_live_allocations -= 1;
  }
  free(allocation);
}

void *(*ts_current_calloc)(size_t, size_t) = reuse_calloc;
void (*ts_current_free)(void *) = reuse_free;
#endif

typedef struct {
  TSLexer lexer;
  const char *source;
  const int32_t *characters;
  size_t length;
  size_t offset;
  size_t mark;
} MockLexer;

static MockLexer *mock_lexer(TSLexer *lexer) {
  return (MockLexer *)lexer;
}

static const MockLexer *const_mock_lexer(const TSLexer *lexer) {
  return (const MockLexer *)lexer;
}

static int32_t mock_lookahead(const MockLexer *mock) {
  if (mock->offset == mock->length) {
    return 0;
  }
  return mock->characters != NULL ? mock->characters[mock->offset]
                                  : (unsigned char)mock->source[mock->offset];
}

static void mock_advance(TSLexer *lexer, bool skip) {
  (void)skip;
  MockLexer *mock = mock_lexer(lexer);
  if (mock->offset < mock->length) {
    mock->offset++;
  }
  lexer->lookahead = mock_lookahead(mock);
}

static void mock_mark_end(TSLexer *lexer) {
  MockLexer *mock = mock_lexer(lexer);
  mock->mark = mock->offset;
}

static bool mock_eof(const TSLexer *lexer) {
  const MockLexer *mock = const_mock_lexer(lexer);
  return mock->offset == mock->length;
}

static MockLexer make_mock_lexer(const char *source) {
  return (MockLexer){
    .lexer =
      {
        .lookahead = (unsigned char)source[0],
        .result_symbol = UINT16_MAX,
        .advance = mock_advance,
        .mark_end = mock_mark_end,
        .eof = mock_eof,
      },
    .source = source,
    .length = strlen(source),
  };
}

static ScannerState make_regex_state(void) {
  return (ScannerState){
    .delimiter = INT32_C(0x1f642),
    .mode = MODE_SUBSTITUTE_PATTERN,
    .regex_state = REGEX_OUTSIDE_BRACKET,
#if SED_REGEX_EXTENDED
    .regex_position = REGEX_AFTER_ALTERNATION,
#else
    .regex_position = REGEX_AFTER_ANCHOR,
#endif
    .regex_group_depth = SERIALIZATION_GROUP_DEPTH,
  };
}

static unsigned serialize_state(
  ScannerState *state,
  char buffer[TREE_SITTER_SERIALIZATION_BUFFER_SIZE]
) {
  char guarded[TREE_SITTER_SERIALIZATION_BUFFER_SIZE + 2];
  memset(guarded, SERIALIZATION_GUARD_BYTE, sizeof(guarded));
  const unsigned length = sed_scanner_serialize(state, guarded + 1);
  assert(length == 0 || length == SCANNER_SERIALIZED_STATE_SIZE);
  assert(length <= TREE_SITTER_SERIALIZATION_BUFFER_SIZE);
  assert(guarded[0] == SERIALIZATION_GUARD_BYTE);
  for (
    size_t index = SCANNER_SERIALIZED_STATE_SIZE + 1; index < sizeof(guarded);
    index++
  ) {
    assert(guarded[index] == SERIALIZATION_GUARD_BYTE);
  }
  memset(buffer, 0, SCANNER_SERIALIZED_STATE_SIZE);
  memcpy(buffer, guarded + 1, length);
  return length;
}

static void assert_same_state(ScannerState *expected, ScannerState *actual) {
  char expected_buffer[TREE_SITTER_SERIALIZATION_BUFFER_SIZE] = {0};
  char actual_buffer[TREE_SITTER_SERIALIZATION_BUFFER_SIZE] = {0};
  const unsigned expected_length = serialize_state(expected, expected_buffer);
  const unsigned actual_length = serialize_state(actual, actual_buffer);
  assert(expected_length == actual_length);
  assert(
    memcmp(expected_buffer, actual_buffer, SCANNER_SERIALIZED_STATE_SIZE) == 0
  );
}

static void assert_reset_state(ScannerState *state) {
  ScannerState reset = {0};
  assert_same_state(&reset, state);
}

static void test_lifecycle(void) {
  ScannerState *state = sed_scanner_create();
  assert(state != NULL);
  assert_reset_state(state);
  sed_scanner_destroy(state);
}

static void test_serialization_round_trip(void) {
  static const uint32_t depths[] = {
    SERIALIZATION_GROUP_DEPTH,
    UINT16_MAX,
    (uint32_t)UINT16_MAX + 1,
    UINT32_C(0x12345678),
    UINT32_MAX,
  };
  for (size_t index = 0; index < sizeof(depths) / sizeof(depths[0]); index++) {
    ScannerState source = make_regex_state();
    source.regex_group_depth = depths[index];
    ScannerState destination = {0};
    destination.mode = MODE_TEXT;
    destination.text_line_has_content = true;
    char buffer[TREE_SITTER_SERIALIZATION_BUFFER_SIZE] = {0};
    serialize_state(&source, buffer);

    sed_scanner_deserialize(
      &destination,
      buffer,
      SCANNER_SERIALIZED_STATE_SIZE
    );
    assert(destination.regex_group_depth == depths[index]);
    assert_same_state(&source, &destination);
  }
}

static void test_empty_serialization_resets_state(void) {
  ScannerState state = make_regex_state();
  sed_scanner_deserialize(&state, NULL, 0);
  assert_reset_state(&state);
}

static void test_only_the_default_state_serializes_empty(void) {
  static const ScannerState changed_states[] = {
    {.mode = MODE_TEXT},
    {.regex_position = REGEX_AT_BRANCH_START},
    {.text_line_has_content = true},
    {.delimiter = INT32_C(0x1f642)},
    {.regex_group_depth = UINT32_C(1) << 24},
    {.text_raw = true},
    {.regex_in_interval = true},
    {.regex_source_bracket = REGEX_BRACKET_FIRST},
    {.regex_bracket_term_state = REGEX_BRACKET_TERM_COLON},
  };
  ScannerState state = {0};
  char buffer[TREE_SITTER_SERIALIZATION_BUFFER_SIZE] = {0};
  assert(serialize_state(&state, buffer) == 0);
  for (
    size_t index = 0;
    index < sizeof(changed_states) / sizeof(changed_states[0]);
    index++
  ) {
    state = changed_states[index];
    assert(serialize_state(&state, buffer) == SCANNER_SERIALIZED_STATE_SIZE);
  }
}

static void test_numeric_bytes_preserve_ranges_across_serialization(void) {
  static const struct {
    const char *source;
    size_t ends[4];
    unsigned count;
  } cases[] = {
    {"\\xc3\\xa9*", {4, 8}, 2},
    {"\\xe0\\x80\\x80*", {4, 8, 12}, 3},
    {"\\xf0\\o237\\d152\\x80*", {4, 9, 14, 18}, 4},
  };
  bool valid_symbols[ERROR_SENTINEL + 1] = {false};
  valid_symbols[REGEX_LITERAL] = true;
  valid_symbols[REGEX_CHARACTER_ESCAPE] = true;
  for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
    ScannerState state = make_regex_state();
    state.delimiter = '/';
    MockLexer mock = make_mock_lexer(cases[i].source);
    for (unsigned j = 0; j < cases[i].count; j++) {
      assert(sed_scanner_scan(&state, &mock.lexer, valid_symbols));
      assert(mock.lexer.result_symbol == REGEX_CHARACTER_ESCAPE);
      assert(mock.mark == cases[i].ends[j]);
      assert(mock.offset <= cases[i].ends[cases[i].count - 1]);
      char buffer[TREE_SITTER_SERIALIZATION_BUFFER_SIZE] = {0};
      const unsigned length = serialize_state(&state, buffer);
      sed_scanner_deserialize(&state, buffer, length);
      mock.offset = mock.mark;
      mock.lexer.lookahead = mock_lookahead(&mock);
    }
    assert(mock.lexer.lookahead == '*');
  }
}

static void test_bracket_content_serialization_round_trip(void) {
  ScannerState source = make_regex_state();
  source.regex_state = REGEX_BRACKET_BODY;
  source.regex_position = REGEX_AFTER_ATOM;
  source.regex_bracket_term_state = REGEX_BRACKET_TERM_COLON;
  ScannerState destination = {0};
  char buffer[TREE_SITTER_SERIALIZATION_BUFFER_SIZE] = {0};
  serialize_state(&source, buffer);

  sed_scanner_deserialize(&destination, buffer, SCANNER_SERIALIZED_STATE_SIZE);
  assert_same_state(&source, &destination);
}

static void test_disabled_and_all_valid_scans_preserve_state(void) {
  const char *inputs[] = {"{", "\\{", "/", "p", " ", "\n", ""};
  bool valid_symbols[ERROR_SENTINEL + 1];
  for (size_t token = 0; token <= ERROR_SENTINEL; token++) {
    valid_symbols[token] = true;
  }
  for (enum ScannerMode mode = MODE_NONE; mode <= MODE_TEXT; mode++) {
    for (
      size_t index = 0; index < sizeof(inputs) / sizeof(inputs[0]); index++
    ) {
      ScannerState state = make_regex_state();
      state.delimiter = '/';
      state.mode = mode;
      ScannerState expected = state;
      MockLexer mock = make_mock_lexer(inputs[index]);
      assert(!sed_scanner_scan(&state, &mock.lexer, valid_symbols));
      assert_same_state(&expected, &state);
      const bool disabled_symbols[ERROR_SENTINEL + 1] = {false};
      mock = make_mock_lexer(inputs[index]);
      assert(!sed_scanner_scan(&state, &mock.lexer, disabled_symbols));
      assert_same_state(&expected, &state);
    }
  }
}

static void test_bracket_term_delimiter_leaf_ranges(void) {
  static const struct {
    const char *opening_source;
    const char *closing_source;
    TSSymbol opening_symbol;
    TSSymbol closing_symbol;
    enum RegexBracketTermState term_state;
  } cases[] = {
    {"[:x",
      ":]x",
      REGEX_OPEN_COLON,
      REGEX_COLON_CLOSE,
      REGEX_BRACKET_TERM_COLON},
    {"[.x", ".]x", REGEX_OPEN_DOT, REGEX_DOT_CLOSE, REGEX_BRACKET_TERM_DOT},
    {"[=x",
      "=]x",
      REGEX_OPEN_EQUAL,
      REGEX_EQUAL_CLOSE,
      REGEX_BRACKET_TERM_EQUAL},
  };

  for (size_t index = 0; index < sizeof(cases) / sizeof(cases[0]); index++) {
    ScannerState state = make_regex_state();
    state.regex_state = REGEX_BRACKET_FIRST;
    state.regex_position = REGEX_AFTER_ATOM;
    MockLexer opening = make_mock_lexer(cases[index].opening_source);
    bool opening_symbols[ERROR_SENTINEL + 1] = {false};
    opening_symbols[cases[index].opening_symbol] = true;
    TSSymbol symbol = ERROR_SENTINEL;

    assert(scan_regex_bracket_opener(
      &opening.lexer,
      &state,
      opening_symbols,
      &symbol
    ));
    assert(symbol == cases[index].opening_symbol);
    assert(opening.mark == 1);
    assert(opening.source[opening.mark] == cases[index].closing_source[0]);
    assert(state.regex_state == REGEX_BRACKET_BODY);
    assert(state.regex_bracket_term_state == cases[index].term_state);

    ScannerState deserialized = {0};
    char buffer[TREE_SITTER_SERIALIZATION_BUFFER_SIZE] = {0};
    serialize_state(&state, buffer);
    sed_scanner_deserialize(
      &deserialized,
      buffer,
      SCANNER_SERIALIZED_STATE_SIZE
    );
    assert_same_state(&state, &deserialized);

    MockLexer closing = make_mock_lexer(cases[index].closing_source);
    bool closing_symbols[ERROR_SENTINEL + 1] = {false};
    closing_symbols[cases[index].closing_symbol] = true;
    symbol = ERROR_SENTINEL;

    assert(scan_regex_bracket_term_close(
      &closing.lexer,
      &state,
      closing_symbols,
      &symbol
    ));
    assert(symbol == cases[index].closing_symbol);
    assert(closing.mark == 1);
    assert(closing.source[closing.mark] == ']');
    assert(state.regex_bracket_term_state == REGEX_BRACKET_TERM_NONE);

    ScannerState incomplete_state = make_regex_state();
    incomplete_state.regex_position = REGEX_AFTER_ATOM;
    incomplete_state.regex_state = REGEX_BRACKET_BODY;
    incomplete_state.regex_bracket_term_state = cases[index].term_state;
    ScannerState expected = incomplete_state;
    char incomplete_source[] = {cases[index].closing_source[0], 'x', '\0'};
    MockLexer incomplete = make_mock_lexer(incomplete_source);
    symbol = ERROR_SENTINEL;

    assert(!scan_regex_bracket_term_close(
      &incomplete.lexer,
      &incomplete_state,
      closing_symbols,
      &symbol
    ));
    assert_same_state(&expected, &incomplete_state);
  }

  ScannerState state = make_regex_state();
  state.regex_state = REGEX_BRACKET_FIRST;
  state.regex_position = REGEX_AFTER_ATOM;
  MockLexer opening = make_mock_lexer("[x");
  bool valid_symbols[ERROR_SENTINEL + 1] = {false};
  valid_symbols[REGEX_BRACKET_LITERAL] = true;
  TSSymbol symbol = ERROR_SENTINEL;

  assert(
    scan_regex_bracket_opener(&opening.lexer, &state, valid_symbols, &symbol)
  );
  assert(symbol == REGEX_BRACKET_LITERAL);
  assert(opening.mark == 1);
  assert(opening.source[opening.mark] == 'x');
  assert(state.regex_state == REGEX_BRACKET_BODY);
  assert(state.regex_bracket_term_state == REGEX_BRACKET_TERM_NONE);
}

#ifdef TREE_SITTER_REUSE_ALLOCATOR
static void test_reuse_allocator_contract(void) {
  assert(reuse_calloc_calls > 0);
  assert(reuse_free_calls > 0);
  assert(reuse_live_allocations == 0);
  reuse_fail_next_calloc = true;
  void *scanner = sed_scanner_create();
  assert(scanner == NULL);
  assert(!reuse_fail_next_calloc);
  char buffer[TREE_SITTER_SERIALIZATION_BUFFER_SIZE];
  memset(buffer, SERIALIZATION_GUARD_BYTE, sizeof(buffer));
  assert(sed_scanner_serialize(scanner, buffer) == 0);
  for (size_t index = 0; index < sizeof(buffer); index++) {
    assert(buffer[index] == SERIALIZATION_GUARD_BYTE);
  }
  sed_scanner_deserialize(scanner, NULL, 0);
  sed_scanner_deserialize(scanner, buffer, SCANNER_SERIALIZED_STATE_SIZE);
  bool symbols[ERROR_SENTINEL + 1] = {false};
  symbols[SUBSTITUTE_START] = true;
  MockLexer lexer = make_mock_lexer("/a/b/");
  assert(!sed_scanner_scan(scanner, &lexer.lexer, symbols));
  assert(lexer.offset == 0);
  assert(lexer.mark == 0);
  assert(lexer.lexer.result_symbol == UINT16_MAX);
  sed_scanner_destroy(scanner);
  assert(reuse_live_allocations == 0);
}
#endif

int main(void) {
  test_lifecycle();
  test_serialization_round_trip();
  test_empty_serialization_resets_state();
  test_only_the_default_state_serializes_empty();
  test_numeric_bytes_preserve_ranges_across_serialization();
  test_bracket_content_serialization_round_trip();
  test_disabled_and_all_valid_scans_preserve_state();
  test_bracket_term_delimiter_leaf_ranges();
#ifdef TREE_SITTER_REUSE_ALLOCATOR
  test_reuse_allocator_contract();
#endif
  return 0;
}
