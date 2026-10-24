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

static const struct {
  int32_t character;
  TSSymbol symbol;
} encoding_issues[] = {{-1, INVALID_CHARACTER}, {0, NUL_CHARACTER}};

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

static void mock_resume_at_token_end(MockLexer *mock) {
  mock->offset = mock->mark;
  mock->lexer.lookahead = mock_lookahead(mock);
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

static MockLexer
make_character_lexer(const int32_t *characters, size_t length) {
  return (MockLexer){
    .lexer =
      {
        .lookahead = length == 0 ? 0 : characters[0],
        .result_symbol = UINT16_MAX,
        .advance = mock_advance,
        .mark_end = mock_mark_end,
        .eof = mock_eof,
      },
    .characters = characters,
    .length = length,
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

static void serialize_state(
  ScannerState *state,
  char buffer[TREE_SITTER_SERIALIZATION_BUFFER_SIZE]
) {
  char guarded[TREE_SITTER_SERIALIZATION_BUFFER_SIZE + 2];
  memset(guarded, SERIALIZATION_GUARD_BYTE, sizeof(guarded));
  const unsigned length = sed_scanner_serialize(state, guarded + 1);
  assert(length == SCANNER_SERIALIZED_STATE_SIZE);
  assert(length <= TREE_SITTER_SERIALIZATION_BUFFER_SIZE);
  assert(guarded[0] == SERIALIZATION_GUARD_BYTE);
  for (size_t index = length + 1; index < sizeof(guarded); index++) {
    assert(guarded[index] == SERIALIZATION_GUARD_BYTE);
  }
  memcpy(buffer, guarded + 1, length);
}

static void assert_same_state(ScannerState *expected, ScannerState *actual) {
  char expected_buffer[TREE_SITTER_SERIALIZATION_BUFFER_SIZE] = {0};
  char actual_buffer[TREE_SITTER_SERIALIZATION_BUFFER_SIZE] = {0};
  serialize_state(expected, expected_buffer);
  serialize_state(actual, actual_buffer);
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

static void test_bracket_content_serialization_round_trip(void) {
  ScannerState source = make_regex_state();
  source.regex_state = REGEX_BRACKET_BODY;
  source.regex_position = REGEX_AFTER_ATOM;
  source.regex_bracket_term_state = REGEX_BRACKET_TERM_COLON;
  source.regex_bracket_term_has_content = true;
  ScannerState destination = {0};
  char buffer[TREE_SITTER_SERIALIZATION_BUFFER_SIZE] = {0};
  serialize_state(&source, buffer);

  sed_scanner_deserialize(&destination, buffer, SCANNER_SERIALIZED_STATE_SIZE);
  assert(destination.regex_bracket_term_has_content);
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

static void test_encoding_issues_preserve_construct_state(void) {
  static const struct {
    enum ScannerMode mode;
    enum RegexState bracket_state;
    enum RegexBracketTermState term_state;
    bool interval;
  } contexts[] = {
    {MODE_NONE, REGEX_OUTSIDE_BRACKET, REGEX_BRACKET_TERM_NONE, false},
    {MODE_REGEX_ADDRESS, REGEX_OUTSIDE_BRACKET, REGEX_BRACKET_TERM_NONE, false},
    {MODE_SUBSTITUTE_PATTERN,
      REGEX_BRACKET_FIRST,
      REGEX_BRACKET_TERM_NONE,
      false},
    {MODE_SUBSTITUTE_PATTERN,
      REGEX_BRACKET_BODY,
      REGEX_BRACKET_TERM_COLON,
      false},
    {MODE_SUBSTITUTE_PATTERN,
      REGEX_OUTSIDE_BRACKET,
      REGEX_BRACKET_TERM_NONE,
      true},
    {MODE_SUBSTITUTE_REPLACEMENT,
      REGEX_OUTSIDE_BRACKET,
      REGEX_BRACKET_TERM_NONE,
      false},
    {MODE_TRANSLATE_SOURCE,
      REGEX_OUTSIDE_BRACKET,
      REGEX_BRACKET_TERM_NONE,
      false},
    {MODE_TRANSLATE_DESTINATION,
      REGEX_OUTSIDE_BRACKET,
      REGEX_BRACKET_TERM_NONE,
      false},
    {MODE_TEXT, REGEX_OUTSIDE_BRACKET, REGEX_BRACKET_TERM_NONE, false},
  };
  for (
    size_t context = 0; context < sizeof(contexts) / sizeof(contexts[0]);
    context++
  ) {
    for (
      size_t issue = 0;
      issue < sizeof(encoding_issues) / sizeof(encoding_issues[0]);
      issue++
    ) {
      ScannerState state = {
        .delimiter = '/',
        .mode = contexts[context].mode,
        .regex_state = contexts[context].bracket_state,
        .regex_position = REGEX_AT_BRANCH_START,
        .regex_in_interval = contexts[context].interval,
        .regex_bracket_term_state = contexts[context].term_state,
        .regex_group_depth = 3,
      };
      ScannerState initial = state;
      const int32_t source[] = {encoding_issues[issue].character, 'a'};
      MockLexer mock =
        make_character_lexer(source, sizeof(source) / sizeof(source[0]));
      bool valid_symbols[ERROR_SENTINEL + 1] = {false};
      valid_symbols[REGEX_CLASS_NAME] =
        contexts[context].term_state != REGEX_BRACKET_TERM_NONE;

      assert(!sed_scanner_scan(&state, &mock.lexer, valid_symbols));
      assert_same_state(&initial, &state);
      mock = make_character_lexer(source, sizeof(source) / sizeof(source[0]));
      valid_symbols[encoding_issues[issue].symbol] = true;
      assert(sed_scanner_scan(&state, &mock.lexer, valid_symbols));
      assert(mock.lexer.result_symbol == encoding_issues[issue].symbol);
      assert(mock.mark == 1);
      assert(source[mock.mark] == 'a');
      assert(state.mode == initial.mode);
      assert(state.delimiter == '/');
      assert(state.regex_group_depth == initial.regex_group_depth);
      assert(state.regex_in_interval == initial.regex_in_interval);
      if (is_regex_mode(state.mode)) {
        assert(state.regex_position == REGEX_AFTER_ATOM);
      }
      if (initial.regex_state == REGEX_BRACKET_FIRST) {
        assert(state.regex_state == REGEX_BRACKET_BODY);
        assert(
          state.regex_bracket_pending_element == REGEX_BRACKET_PENDING_OTHER
        );
      }
      if (initial.regex_bracket_term_state != REGEX_BRACKET_TERM_NONE) {
        assert(
          state.regex_bracket_term_state == initial.regex_bracket_term_state
        );
        assert(state.regex_bracket_term_has_content);
      }
      if (state.mode == MODE_TEXT) {
        assert(state.text_line_has_content);
      }
      char buffer[TREE_SITTER_SERIALIZATION_BUFFER_SIZE] = {0};
      serialize_state(&state, buffer);
      ScannerState restored = {0};
      sed_scanner_deserialize(&restored, buffer, SCANNER_SERIALIZED_STATE_SIZE);
      assert_same_state(&state, &restored);
    }
  }
}

static void test_opaque_literals_split_at_encoding_issues(void) {
  static const struct {
    enum ScannerMode mode;
    TSSymbol literal;
  } contexts[] = {
    {MODE_NONE, LINE_WORD},
    {MODE_NONE, COMMENT_TEXT},
    {MODE_NONE, FILE_ARGUMENT},
    {MODE_NONE, SUBSTITUTION_WFILE_ARGUMENT},
    {MODE_NONE, SUBSTITUTION_WFILE_CONTINUATION},
    {MODE_NONE, UNEXPECTED_COMMAND_TEXT},
    {MODE_SUBSTITUTE_REPLACEMENT, REPLACEMENT_LITERAL},
    {MODE_TRANSLATE_SOURCE, TRANSLATE_LITERAL},
    {MODE_TRANSLATE_DESTINATION, TRANSLATE_LITERAL},
    {MODE_TEXT, TEXT_LITERAL},
  };
  for (
    size_t context = 0; context < sizeof(contexts) / sizeof(contexts[0]);
    context++
  ) {
    for (
      size_t issue = 0;
      issue < sizeof(encoding_issues) / sizeof(encoding_issues[0]);
      issue++
    ) {
      ScannerState state = {.mode = contexts[context].mode, .delimiter = '/'};
      const int32_t source[] =
        {'a', encoding_issues[issue].character, 'b', '\n'};
      MockLexer mock =
        make_character_lexer(source, sizeof(source) / sizeof(source[0]));
      bool valid_symbols[ERROR_SENTINEL + 1] = {false};
      valid_symbols[contexts[context].literal] = true;
      valid_symbols[INVALID_CHARACTER] = true;
      valid_symbols[NUL_CHARACTER] = true;

      const TSSymbol expected[] = {
        contexts[context].literal,
        encoding_issues[issue].symbol,
        contexts[context].literal
      };
      for (
        size_t token = 0; token < sizeof(expected) / sizeof(expected[0]);
        token++
      ) {
        assert(sed_scanner_scan(&state, &mock.lexer, valid_symbols));
        assert(mock.lexer.result_symbol == expected[token]);
        assert(mock.mark == token + 1);
        assert(state.mode == contexts[context].mode);
        mock_resume_at_token_end(&mock);
      }
      assert(mock.lexer.lookahead == '\n');
    }
  }
}

static void test_escape_prefixes_stop_before_encoding_issues(void) {
  static const enum ScannerMode modes[] = {
    MODE_REGEX_ADDRESS,
    MODE_SUBSTITUTE_REPLACEMENT,
    MODE_TRANSLATE_SOURCE,
    MODE_TRANSLATE_DESTINATION,
    MODE_TEXT
  };
  for (size_t mode = 0; mode < sizeof(modes) / sizeof(modes[0]); mode++) {
    for (
      size_t issue = 0;
      issue < sizeof(encoding_issues) / sizeof(encoding_issues[0]);
      issue++
    ) {
      ScannerState state = {.mode = modes[mode], .delimiter = '/'};
      const int32_t source[] = {'\\', encoding_issues[issue].character, 'a'};
      MockLexer mock =
        make_character_lexer(source, sizeof(source) / sizeof(source[0]));
      bool valid_symbols[ERROR_SENTINEL + 1] = {false};
      valid_symbols[ESCAPE_PREFIX] = true;
      valid_symbols[INVALID_CHARACTER] = true;
      valid_symbols[NUL_CHARACTER] = true;

      assert(sed_scanner_scan(&state, &mock.lexer, valid_symbols));
      assert(mock.lexer.result_symbol == ESCAPE_PREFIX);
      assert(mock.mark == 1);
      assert(mock.lexer.lookahead == encoding_issues[issue].character);
      mock_resume_at_token_end(&mock);
      assert(sed_scanner_scan(&state, &mock.lexer, valid_symbols));
      assert(mock.lexer.result_symbol == encoding_issues[issue].symbol);
      assert(mock.mark == 2);
      assert(source[mock.mark] == 'a');
    }
  }
}

static void test_unexpected_text_after_failed_blank_recovery(void) {
  const int32_t source[] = {' ', 'a', -1, 'b', ';', 'q'};
  MockLexer mock =
    make_character_lexer(source, sizeof(source) / sizeof(source[0]));
  ScannerState state = {0};
  bool valid_symbols[ERROR_SENTINEL + 1] = {false};
  valid_symbols[MISSING_ADDRESS_SEPARATOR_MARKER] = true;
  valid_symbols[UNEXPECTED_COMMAND_TEXT] = true;
  valid_symbols[INVALID_CHARACTER] = true;

  const struct {
    TSSymbol symbol;
    size_t mark;
  } expected[] = {
    {UNEXPECTED_COMMAND_TEXT, 2},
    {INVALID_CHARACTER, 3},
    {UNEXPECTED_COMMAND_TEXT, 4},
  };
  for (
    size_t token = 0; token < sizeof(expected) / sizeof(expected[0]); token++
  ) {
    assert(sed_scanner_scan(&state, &mock.lexer, valid_symbols));
    assert(mock.lexer.result_symbol == expected[token].symbol);
    assert(mock.mark == expected[token].mark);
    mock_resume_at_token_end(&mock);
  }
  assert(!sed_scanner_scan(&state, &mock.lexer, valid_symbols));
  assert(mock.lexer.lookahead == ';');
}

static void test_substitution_flags_precede_unexpected_text(void) {
  static const char *const sources[] = {"g", "i", "p", "w output", "123"};
  for (
    size_t index = 0; index < sizeof(sources) / sizeof(sources[0]); index++
  ) {
    ScannerState state = {0};
    ScannerState initial = state;
    MockLexer mock = make_mock_lexer(sources[index]);
    bool valid_symbols[ERROR_SENTINEL + 1] = {false};
    valid_symbols[INVALID_SUBSTITUTION_FLAG] = true;
    valid_symbols[UNEXPECTED_COMMAND_TEXT] = true;

    assert(!sed_scanner_scan(&state, &mock.lexer, valid_symbols));
    assert(mock.offset == 0);
    assert_same_state(&initial, &state);
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
    assert(state.regex_bracket_pending_element == REGEX_BRACKET_PENDING_OTHER);

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

static void test_bracket_term_payload_owns_embedded_closing_brackets(void) {
  static const struct {
    const char *source;
    enum RegexBracketTermState term_state;
    bool has_content;
    TSSymbol expected;
    size_t expected_mark;
  } cases[] = {
    {"a].]", REGEX_BRACKET_TERM_DOT, false, REGEX_COLL_ELEM_MULTI, 2},
    {"a]b.]", REGEX_BRACKET_TERM_DOT, false, REGEX_COLL_ELEM_MULTI, 3},
    {"]]a.]", REGEX_BRACKET_TERM_DOT, false, REGEX_COLL_ELEM_MULTI, 3},
    {"]a.]", REGEX_BRACKET_TERM_DOT, true, REGEX_COLL_ELEM_MULTI, 2},
    {"a]]/p", REGEX_BRACKET_TERM_DOT, false, REGEX_COLL_ELEM_MULTI, 5},
    {"a]]/p\n", REGEX_BRACKET_TERM_DOT, false, REGEX_COLL_ELEM_MULTI, 5},
    {"a]=]", REGEX_BRACKET_TERM_EQUAL, false, REGEX_COLL_ELEM_MULTI, 2},
    {"a]b=]", REGEX_BRACKET_TERM_EQUAL, false, REGEX_COLL_ELEM_MULTI, 3},
    {"]]a=]", REGEX_BRACKET_TERM_EQUAL, false, REGEX_COLL_ELEM_MULTI, 3},
    {"]a=]", REGEX_BRACKET_TERM_EQUAL, true, REGEX_COLL_ELEM_MULTI, 2},
    {"a]]/p", REGEX_BRACKET_TERM_EQUAL, false, REGEX_COLL_ELEM_MULTI, 5},
    {"a]]/p\n", REGEX_BRACKET_TERM_EQUAL, false, REGEX_COLL_ELEM_MULTI, 5},
    {"a]b:]", REGEX_BRACKET_TERM_COLON, false, REGEX_CLASS_NAME, 1},
  };

  for (size_t index = 0; index < sizeof(cases) / sizeof(cases[0]); index++) {
    ScannerState state = make_regex_state();
    state.regex_state = REGEX_BRACKET_BODY;
    state.regex_bracket_term_state = cases[index].term_state;
    state.regex_bracket_term_has_content = cases[index].has_content;
    MockLexer mock = make_mock_lexer(cases[index].source);
    bool valid_symbols[ERROR_SENTINEL + 1] = {false};
    valid_symbols[cases[index].expected] = true;
    TSSymbol symbol = ERROR_SENTINEL;

    assert(scan_regex_bracket_term_content(
      &mock.lexer,
      &state,
      valid_symbols,
      &symbol
    ));
    assert(symbol == cases[index].expected);
    assert(mock.mark == cases[index].expected_mark);
    assert(state.regex_bracket_term_state == cases[index].term_state);
    assert(state.regex_bracket_term_has_content);
  }
}

static void test_regex_closers_at_source_boundaries(void) {
  static const struct {
    const char *source;
    int32_t delimiter;
    bool in_interval;
    TSSymbol expected;
  } cases[] = {
    {"", '/', true, REGEX_INCOMPLETE_INTERVAL},
    {"", '}', true, REGEX_MISSING_INTERVAL_CLOSE},
    {"\n", '/', true, REGEX_MISSING_INTERVAL_CLOSE},
    {"/", '/', true, REGEX_MISSING_INTERVAL_CLOSE},
    {"", '/', false, REGEX_INCOMPLETE_GROUP},
    {"", ')', false, REGEX_UNCLOSED_GROUP},
    {"\n", '/', false, REGEX_UNCLOSED_GROUP},
    {"/", '/', false, REGEX_UNCLOSED_GROUP},
  };

  for (size_t index = 0; index < sizeof(cases) / sizeof(cases[0]); index++) {
    ScannerState state = {
      .delimiter = cases[index].delimiter,
      .mode = MODE_SUBSTITUTE_PATTERN,
      .regex_state = REGEX_OUTSIDE_BRACKET,
      .regex_position = REGEX_AFTER_ATOM,
      .regex_in_interval = cases[index].in_interval,
      .regex_group_depth = cases[index].in_interval ? 0 : 1,
    };
    MockLexer mock = make_mock_lexer(cases[index].source);
    bool valid_symbols[ERROR_SENTINEL + 1] = {false};
    valid_symbols[REGEX_INCOMPLETE_INTERVAL] = cases[index].in_interval;
    valid_symbols[REGEX_MISSING_INTERVAL_CLOSE] = cases[index].in_interval;
    valid_symbols[REGEX_INCOMPLETE_GROUP] = !cases[index].in_interval;
    valid_symbols[REGEX_UNCLOSED_GROUP] = !cases[index].in_interval;

    assert(sed_scanner_scan(&state, &mock.lexer, valid_symbols));
    assert(mock.lexer.result_symbol == cases[index].expected);
    assert(mock.mark == 0);
    assert(!state.regex_in_interval);
    assert(state.regex_group_depth == 0);
  }
}

static void test_empty_group_only_requires_a_closer(void) {
  ScannerState state = {
    .delimiter = ')',
    .mode = MODE_SUBSTITUTE_PATTERN,
    .regex_state = REGEX_OUTSIDE_BRACKET,
    .regex_position = REGEX_AT_BRANCH_START,
    .regex_group_depth = 1,
  };
  MockLexer mock = make_mock_lexer("");
  bool valid_symbols[ERROR_SENTINEL + 1] = {false};
  valid_symbols[REGEX_INCOMPLETE_GROUP] = true;
  valid_symbols[REGEX_UNCLOSED_GROUP] = true;

  assert(sed_scanner_scan(&state, &mock.lexer, valid_symbols));
  assert(mock.lexer.result_symbol == REGEX_UNCLOSED_GROUP);
  assert(mock.mark == 0);
  assert(state.regex_group_depth == 0);
}

static void test_brace_leading_blanks_require_a_closer(void) {
  static const struct {
    const char *source;
    bool missing_closer;
    bool expected;
  } cases[] = {
    {" \t}", false, true},
    {" \t", true, true},
    {" \t", false, false},
    {" \tp", true, false},
    {" \t;", false, false},
  };

  for (size_t index = 0; index < sizeof(cases) / sizeof(cases[0]); index++) {
    ScannerState state = {0};
    ScannerState initial = state;
    MockLexer mock = make_mock_lexer(cases[index].source);
    bool valid_symbols[ERROR_SENTINEL + 1] = {false};
    valid_symbols[BRACE_LEADING_BLANKS] = true;
    valid_symbols[MISSING_CLOSING_BRACE_MARKER] = cases[index].missing_closer;

    assert(
      sed_scanner_scan(&state, &mock.lexer, valid_symbols) ==
      cases[index].expected
    );
    if (cases[index].expected) {
      assert(mock.lexer.result_symbol == BRACE_LEADING_BLANKS);
      assert(mock.mark == 2);
    }
    assert_same_state(&initial, &state);
  }
}

#if !SED_REGEX_EXTENDED
static void test_bre_interval_backslash_requires_a_completable_closer(void) {
  static const struct {
    const char *source;
    int32_t delimiter;
    bool has_minimum;
    TSSymbol expected;
    size_t expected_mark;
  } cases[] = {
    {"\\", '/', false, REGEX_MISSING_INTERVAL_MINIMUM, 0},
    {"\\", '/', true, REGEX_INCOMPLETE_INTERVAL_CLOSE, 1},
    {"\\", '}', false, REGEX_MISSING_INTERVAL_MINIMUM, 0},
    {"\\", '}', true, REGEX_INVALID_INTERVAL_CLOSE, 1},
    {"\\\n", '/', true, REGEX_INVALID_INTERVAL_CLOSE, 1},
    {"\\}", '/', true, REGEX_INTERVAL_CLOSE, 2},
    {"\\}", '/', false, REGEX_MISSING_INTERVAL_MINIMUM, 0},
  };

  for (size_t index = 0; index < sizeof(cases) / sizeof(cases[0]); index++) {
    ScannerState state = {
      .delimiter = cases[index].delimiter,
      .mode = MODE_REGEX_ADDRESS,
      .regex_state = REGEX_OUTSIDE_BRACKET,
      .regex_position = REGEX_AFTER_ATOM,
      .regex_in_interval = true,
    };
    MockLexer mock = make_mock_lexer(cases[index].source);
    bool valid_symbols[ERROR_SENTINEL + 1] = {false};
    valid_symbols[REGEX_DUP_COUNT] = !cases[index].has_minimum;
    valid_symbols[REGEX_INTERVAL_CLOSE] = cases[index].has_minimum;
    valid_symbols[REGEX_MISSING_INTERVAL_MINIMUM] = !cases[index].has_minimum;
    valid_symbols[REGEX_INCOMPLETE_INTERVAL_CLOSE] = true;
    valid_symbols[REGEX_INVALID_INTERVAL_CLOSE] = true;

    assert(sed_scanner_scan(&state, &mock.lexer, valid_symbols));
    assert(mock.lexer.result_symbol == cases[index].expected);
    assert(mock.mark == cases[index].expected_mark);
    assert(state.regex_in_interval == !cases[index].has_minimum);
  }
}
#endif

#ifdef TREE_SITTER_REUSE_ALLOCATOR
static void test_reuse_allocator_contract(void) {
  assert(reuse_calloc_calls > 0);
  assert(reuse_free_calls > 0);
  assert(reuse_live_allocations == 0);
  reuse_fail_next_calloc = true;
  assert(sed_scanner_create() == NULL);
  assert(!reuse_fail_next_calloc);
  assert(reuse_live_allocations == 0);
}
#endif

int main(void) {
  test_lifecycle();
  test_serialization_round_trip();
  test_empty_serialization_resets_state();
  test_bracket_content_serialization_round_trip();
  test_disabled_and_all_valid_scans_preserve_state();
  test_encoding_issues_preserve_construct_state();
  test_opaque_literals_split_at_encoding_issues();
  test_escape_prefixes_stop_before_encoding_issues();
  test_unexpected_text_after_failed_blank_recovery();
  test_substitution_flags_precede_unexpected_text();
  test_bracket_term_delimiter_leaf_ranges();
  test_bracket_term_payload_owns_embedded_closing_brackets();
  test_regex_closers_at_source_boundaries();
  test_empty_group_only_requires_a_closer();
  test_brace_leading_blanks_require_a_closer();
#if !SED_REGEX_EXTENDED
  test_bre_interval_backslash_requires_a_completable_closer();
#endif
#ifdef TREE_SITTER_REUSE_ALLOCATOR
  test_reuse_allocator_contract();
#endif
  return 0;
}
