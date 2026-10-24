[
  (address_escape)
  (escaped_delimiter)
  (replacement_escaped_delimiter)
  (translation_escaped_delimiter)
  (quoted_character)
  (replacement_escape)
  (sed_newline_escape)
  (text_backslash_escape)
  (translation_escape)
] @string.escape

(negation_operator) @operator

[
  (case_insensitive_flag)
  (global_flag)
  (print_flag)
  (substitution_flag)
] @keyword.modifier

(function_verb) @keyword

(comment_text) @comment

(default_output_suppression) @keyword.directive

[
  (escaped_newline)
  (text_introducer)
  (text_escaped_newline)
] @punctuation.special

(label_literal) @label

(last_line_address) @constant.builtin

[
  (duplication_count)
  (line_number_address)
  (occurrence_flag)
] @number

[
  (matched_text_reference)
  (replacement_backreference)
] @string.special.symbol

(file_literal) @string.special.path

(closing_brace) @punctuation.bracket

(character_class
  [
    "["
    "]"
  ] @punctuation.bracket)

(character_class
  ":" @punctuation.delimiter)

(collating_symbol
  [
    "["
    "]"
  ] @punctuation.bracket)

(collating_symbol
  "." @punctuation.delimiter)

(equivalence_class
  [
    "["
    "]"
  ] @punctuation.bracket)

(equivalence_class
  "=" @punctuation.delimiter)

[
  (class_name)
  (collating_element_multi)
  (collating_element_single)
  (meta_character)
] @character.special

[
  (address_separator)
  (delimiter)
] @punctuation.delimiter

((command_separator) @punctuation.delimiter
  (#eq? @punctuation.delimiter ";"))

(bracket_expression
  [
    "["
    "]"
  ] @punctuation.bracket)

(nonmatching_list
  "^" @operator)

(start_range
  "-" @operator)

(shared_range_endpoint
  "-" @operator)

(range_expression
  "-" @string.regexp)

(bracket_list
  "-" @string.regexp)

(one_char_or_coll_elem_ere
  "." @character.special)

(ere_expression
  [
    "^"
    "$"
  ] @operator)

(ere_expression
  [
    "("
    ")"
  ] @punctuation.bracket)

(ere_dupl_symbol
  [
    "{"
    "}"
  ] @punctuation.bracket)

(ere_dupl_symbol
  [
    "*"
    "+"
    "?"
  ] @operator)

(ere_dupl_symbol
  "," @punctuation.delimiter)

(unexpected_interval_separator
  "," @punctuation.delimiter)

(extended_reg_exp
  "|" @operator)

(ere_dupl_symbol
  modifier: (repetition_modifier) @operator)

(ordinary_character) @string.regexp

[
  (replacement_literal)
  (text_literal)
  (translation_literal)
] @string

(block_function
  verb: (function_verb) @punctuation.bracket)

(comment_function
  verb: (function_verb) @comment)

(comment_function
  verb: (function_verb) @keyword.directive
  comment: (comment
    suppression: (default_output_suppression)))
