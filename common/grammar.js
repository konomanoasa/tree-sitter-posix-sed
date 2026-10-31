const functionDefinitions = [
  { rule: "block_function", spelling: "{", form: "block" },
  {
    rule: "append_function",
    spelling: "a",
    form: "text",
    maxAddresses: 1,
    lineTerminated: true,
  },
  {
    rule: "branch_function",
    spelling: "b",
    form: "optionalLabel",
    labelTerminated: true,
  },
  {
    rule: "change_function",
    spelling: "c",
    form: "text",
    lineTerminated: true,
  },
  { rule: "delete_function", spelling: "d" },
  { rule: "delete_first_line_function", spelling: "D" },
  { rule: "get_function", spelling: "g" },
  { rule: "get_append_function", spelling: "G" },
  { rule: "hold_function", spelling: "h" },
  { rule: "hold_append_function", spelling: "H" },
  {
    rule: "insert_function",
    spelling: "i",
    form: "text",
    maxAddresses: 1,
    lineTerminated: true,
  },
  { rule: "list_function", spelling: "l" },
  { rule: "next_function", spelling: "n" },
  { rule: "next_append_function", spelling: "N" },
  { rule: "print_function", spelling: "p" },
  { rule: "print_first_line_function", spelling: "P" },
  { rule: "quit_function", spelling: "q", maxAddresses: 1 },
  {
    rule: "read_function",
    spelling: "r",
    form: "rfile",
    maxAddresses: 1,
    lineTerminated: true,
  },
  { rule: "substitute_function", spelling: "s", form: "substitute" },
  {
    rule: "_write_substitute_function",
    spelling: "s",
    form: "substitute",
    lineTerminated: true,
  },
  {
    rule: "test_function",
    spelling: "t",
    form: "optionalLabel",
    labelTerminated: true,
  },
  {
    rule: "write_function",
    spelling: "w",
    form: "wfile",
    lineTerminated: true,
  },
  { rule: "exchange_function", spelling: "x" },
  { rule: "translate_function", spelling: "y", form: "translate" },
  {
    rule: "label_function",
    spelling: ":",
    form: "requiredLabel",
    maxAddresses: 0,
    labelTerminated: true,
  },
  {
    rule: "line_number_function",
    spelling: "=",
    maxAddresses: 1,
  },
  {
    rule: "comment_function",
    spelling: "#",
    form: "comment",
    maxAddresses: 0,
    lineTerminated: true,
  },
];

function functionVerb($, spelling) {
  return field("verb", alias(spelling, $.function_verb));
}

function delimiter($, name) {
  return alias($[`_${name}`], $.delimiter);
}

function editingCommand($, kind) {
  return alias($[`_${kind}_editing_command`], $.editing_command);
}

function newlineSeparator($) {
  return alias("\n", $.command_separator);
}

function semicolonSeparator($) {
  return alias(";", $.command_separator);
}

function commandUnit($) {
  return choice(
    seq(
      $._separable_command_item,
      choice(semicolonSeparator($), newlineSeparator($)),
    ),
    seq(editingCommand($, "line_terminated"), newlineSeparator($)),
    prec.right(
      seq(
        editingCommand($, "label"),
        optional($._blanks),
        choice(
          semicolonSeparator($),
          newlineSeparator($),
          $._label_command_end,
        ),
      ),
    ),
  );
}

// Explicit recursion makes cursor traversal quadratic.
function commandList($, unit, finalItem) {
  return choice(
    seq(
      unit,
      repeat(seq(optional($._blanks), unit)),
      optional(seq(optional($._blanks), finalItem)),
    ),
    finalItem,
  );
}

function commandListRules() {
  return {
    script: ($) =>
      choice(
        seq(
          optional(alias($._script_command_list, $.command_list)),
          optional($._blanks),
        ),
        seq(
          $._blanks,
          alias($._command_list, $.command_list),
          optional($._blanks),
        ),
      ),
    _script_command_list: ($) =>
      choice($._initial_suppressing_comment_command_list, $._command_list),
    _initial_suppressing_comment_command_list: ($) =>
      seq(
        alias($._initial_suppressing_comment_command, $.editing_command),
        optional(
          seq(
            newlineSeparator($),
            optional(seq(optional($._blanks), $._command_list)),
          ),
        ),
      ),
    _initial_suppressing_comment_command: ($) =>
      field(
        "function",
        alias($._initial_suppressing_comment_function, $.function),
      ),
    _initial_suppressing_comment_function: ($) =>
      alias($._initial_suppressing_comment_function_body, $.comment_function),
    _initial_suppressing_comment_function_body: ($) =>
      seq(
        functionVerb($, "#"),
        field("comment", alias($._initial_suppressing_comment, $.comment)),
      ),
    _initial_suppressing_comment: ($) =>
      seq(
        field(
          "suppression",
          alias($._default_output_suppression, $.default_output_suppression),
        ),
        optional(alias($._comment_text, $.comment_text)),
      ),
    _command_list: ($) => commandList($, $._command_unit, $._command_item),
    _command_unit: commandUnit,
    _command_item: ($) =>
      choice($._separable_command_item, editingCommand($, "line_terminated")),
    _separable_command_item: ($) =>
      choice(
        $.empty_command,
        editingCommand($, "chainable"),
        seq(editingCommand($, "block"), optional($._block_trailing_blanks)),
      ),
    _block_commands: ($) =>
      seq($._command_unit, repeat(seq(optional($._blanks), $._command_unit))),
    empty_command: ($) => $._empty_command_marker,
    _blanks: () => token(/[ \t]+/),
  };
}

const regularExpressionRules = {
  bre: { expression: "basic_reg_exp" },
  ere: { expression: "extended_reg_exp" },
};

function addressRules(mode) {
  const { expression } = regularExpressionRules[mode];
  function contextAddress($, opening) {
    return seq(
      field("opening", opening),
      optional(field("expression", $[expression])),
      field("closing", delimiter($, "regex_address_end")),
    );
  }
  return {
    address_clause: ($) =>
      choice($._single_address_clause, $._double_address_clause),
    _single_address_clause: ($) => field("first", $.address),
    _double_address_clause: ($) =>
      seq(
        field("first", $.address),
        field("separator", alias(",", $.address_separator)),
        field("second", $.address),
      ),
    _max1_address_clause: ($) => $._single_address_clause,
    address: ($) =>
      choice($.line_number_address, $.last_line_address, $.context_address),
    line_number_address: () => /0*[1-9][0-9]*/,
    last_line_address: () => "$",
    context_address: ($) =>
      choice(
        contextAddress($, delimiter($, "regex_address_start")),
        seq(
          field("escape", alias("\\", $.address_escape)),
          contextAddress($, delimiter($, "escaped_regex_address_start")),
        ),
      ),
  };
}

function substitutionFlagRules() {
  const flag = ($) =>
    choice(
      alias("g", $.global_flag),
      $.occurrence_flag,
      alias("i", $.case_insensitive_flag),
      alias("p", $.print_flag),
    );
  return {
    _flags_plain: ($) => prec.right(repeat1(flag($))),
    _flags_write: ($) => prec.right(seq(repeat(flag($)), $.write_flag)),
    write_flag: ($) =>
      seq(
        field("verb", alias("w", $.substitution_flag)),
        $._blanks,
        field("wfile", $.wfile),
      ),
  };
}

function operandRules(mode) {
  const { expression } = regularExpressionRules[mode];
  function substitute($, flags) {
    return seq(
      functionVerb($, "s"),
      field("opening", delimiter($, "substitute_start")),
      optional(field("expression", $[expression])),
      field("middle", delimiter($, "substitute_middle")),
      optional(field("replacement", $.replacement)),
      field("closing", delimiter($, "substitute_end")),
      flags,
    );
  }
  return {
    substitute_function: ($) =>
      substitute(
        $,
        optional(field("flags", alias($._flags_plain, $.substitution_flags))),
      ),
    _write_substitute_function: ($) =>
      substitute(
        $,
        field("flags", alias($._flags_write, $.substitution_flags)),
      ),
    replacement: ($) =>
      repeat1(
        choice(
          $.replacement_literal,
          $.matched_text_reference,
          $.replacement_backreference,
          $.replacement_escaped_delimiter,
          $.replacement_escape,
          $.escaped_newline,
          $.replacement_case_conversion,
        ),
      ),
    replacement_literal: ($) => $._replacement_literal,
    matched_text_reference: ($) => $._replacement_match_reference,
    replacement_backreference: ($) => $._replacement_backreference,
    replacement_escaped_delimiter: ($) => $._replacement_escaped_delimiter,
    replacement_escape: ($) => $._replacement_escape_sequence,
    replacement_case_conversion: ($) => $._replacement_case_conversion,
    escaped_newline: ($) => $._replacement_escaped_newline,
    ...substitutionFlagRules(),
    occurrence_flag: () => /[0-9]+/,
    translate_function: ($) =>
      seq(
        functionVerb($, "y"),
        field("opening", delimiter($, "translate_start")),
        optional(field("string1", $.translation_string)),
        field("middle", delimiter($, "translate_middle")),
        optional(field("string2", $.translation_string)),
        field("closing", delimiter($, "translate_end")),
      ),
    translation_string: ($) =>
      repeat1(
        choice(
          $.translation_literal,
          $.translation_escape,
          $.translation_escaped_delimiter,
        ),
      ),
    translation_literal: ($) => $._translate_literal,
    translation_escape: ($) => $._translate_escape,
    translation_escaped_delimiter: ($) => $._translate_escaped_delimiter,
  };
}

function functionRules() {
  const rules = {
    text: ($) =>
      seq(
        repeat1(choice($.text_literal, $.text_escape, $.text_escaped_newline)),
        $._text_tail,
      ),
    _text_tail: ($) => choice($._text_line_end, $._text_eof),
    text_literal: ($) => $._text_literal,
    text_escape: ($) => $._text_escape,
    text_escaped_newline: ($) => $._text_escaped_newline,
    text_introducer: ($) => $._text_command_start,
    rfile: ($) => alias($._file_argument, $.file_literal),
    wfile: ($) => alias($._file_argument, $.file_literal),
    label: ($) => alias($._label_literal, $.label_literal),
    comment: ($) => alias($._comment_text, $.comment_text),
    comment_function: ($) =>
      prec.right(
        seq(functionVerb($, "#"), optional(field("comment", $.comment))),
      ),
    closing_brace: () => token("}"),
  };
  const forms = {
    block: ($) => [
      optional($._blanks),
      field("commands", alias($._block_commands, $.command_list)),
      optional($._brace_leading_blanks),
      field("closing", $.closing_brace),
    ],
    text: ($) => [
      field("introducer", $.text_introducer),
      choice(field("text", $.text), $._text_tail),
    ],
    optionalLabel: ($) => [
      optional(
        seq(
          field(
            "separator",
            alias($._argument_separator, $.argument_separator),
          ),
          optional(field("label", $.label)),
        ),
      ),
    ],
    requiredLabel: ($) => [optional($._blanks), field("label", $.label)],
    rfile: ($) => [$._blanks, field("rfile", $.rfile)],
    wfile: ($) => [$._blanks, field("wfile", $.wfile)],
  };
  for (const { form, rule, spelling } of functionDefinitions) {
    if (form === undefined) rules[rule] = ($) => functionVerb($, spelling);
    else if (forms[form] !== undefined) {
      rules[rule] = ($) => seq(functionVerb($, spelling), ...forms[form]($));
    }
  }
  return rules;
}

function editingCommandRules() {
  const wrappers = [];
  for (const [kind, isLineTerminated] of [
    ["chainable", false],
    ["block", false],
    ["label", false],
    ["line_terminated", true],
  ]) {
    for (const maximum of [0, 1, 2]) {
      const names = functionDefinitions
        .filter(
          ({
            lineTerminated = false,
            labelTerminated = false,
            maxAddresses = 2,
            form,
          }) =>
            (form === "block") === (kind === "block") &&
            labelTerminated === (kind === "label") &&
            lineTerminated === isLineTerminated &&
            maxAddresses === maximum,
        )
        .map(({ rule }) => rule);
      if (names.length)
        wrappers.push({
          kind,
          maximum,
          name: `_${kind}_${maximum}_address_function`,
          names,
        });
    }
  }
  const rules = {
    negation: ($) => field("operator", alias("!", $.negation_operator)),
  };
  for (const kind of ["chainable", "block", "label", "line_terminated"]) {
    rules[`_${kind}_editing_command`] = ($) =>
      choice(
        ...wrappers
          .filter((wrapper) => wrapper.kind === kind)
          .map(({ maximum, name }) =>
            seq(
              ...(maximum === 0
                ? []
                : [
                    optional(
                      seq(
                        field(
                          "addresses",
                          maximum === 1
                            ? alias($._max1_address_clause, $.address_clause)
                            : $.address_clause,
                        ),
                        optional($._blanks),
                      ),
                    ),
                  ]),
              optional(field("negation", $.negation)),
              field("function", alias($[name], $.function)),
            ),
          ),
      );
  }
  for (const { name, names } of wrappers) {
    rules[name] = ($) =>
      choice(
        ...names.map((name) =>
          name === "_write_substitute_function"
            ? alias($[name], $.substitute_function)
            : $[name],
        ),
      );
  }
  return rules;
}

function sedRules(mode) {
  return {
    ...commandListRules(),
    ...addressRules(mode),
    ...operandRules(mode),
    ...functionRules(),
    ...editingCommandRules(),
  };
}

function intervalSeparator($) {
  return choice(
    alias($._regex_interval_separator, ","),
    alias($._regex_interval_escaped_separator, $.escaped_delimiter),
    alias($._regex_interval_encoded_separator, $.sed_character_escape),
  );
}

function intervalExpression($, opening, closing) {
  const count = (name) =>
    repeat1(
      choice(
        field(name, $.duplication_count),
        field(
          name,
          alias($._regex_interval_escaped_count, $.escaped_delimiter),
        ),
        field(
          name,
          alias($._regex_interval_encoded_count, $.sed_character_escape),
        ),
      ),
    );
  return seq(
    opening === "{"
      ? regexSymbol($, "interval_open", opening)
      : choice(
          alias($._regex_interval_open, opening),
          alias($._regex_encoded_interval_open, $.sed_character_escape),
        ),
    count("minimum"),
    optional(seq(intervalSeparator($), optional(count("maximum")))),
    choice(
      alias($._regex_interval_close, closing),
      alias($._regex_interval_encoded_close, $.sed_character_escape),
    ),
  );
}

function compoundBracketExpression(
  _$,
  opening,
  marker,
  name,
  content,
  closing,
) {
  return seq(
    alias(opening, "["),
    marker,
    field(name, content),
    alias(closing, marker),
    "]",
  );
}

function subexpressionClose($, closing) {
  return field(
    "closing",
    closing === ")"
      ? regexSymbol($, "group_close", closing)
      : choice(
          alias($._regex_group_close, closing),
          alias($._regex_encoded_group_close, $.sed_character_escape),
        ),
  );
}

function bracketRules() {
  return {
    bracket_expression: ($) =>
      seq(
        regexSymbol($, "bracket_open", "["),
        choice($.matching_list, $.nonmatching_list),
        alias($._regex_bracket_close, "]"),
      ),
    matching_list: ($) => $.bracket_list,
    nonmatching_list: ($) =>
      seq(alias($._regex_bracket_negation, "^"), $.bracket_list),
    bracket_list: ($) =>
      seq(
        $.follow_list,
        optional(alias($._regex_bracket_trailing_hyphen, "-")),
      ),
    follow_list: ($) => repeat1($.expression_term),
    expression_term: ($) => choice($.single_expression, $.range_expression),
    single_expression: ($) =>
      choice($.end_range, $.character_class, $.equivalence_class),
    range_expression: ($) =>
      seq(
        $.start_range,
        choice($.end_range, alias($._regex_bracket_range_end_hyphen, "-")),
      ),
    start_range: ($) => seq($.end_range, alias($._regex_bracket_hyphen, "-")),
    end_range: ($) =>
      choice(
        alias($._regex_bracket_literal, $.collating_element_single),
        $.collating_symbol,
      ),
    collating_symbol: ($) =>
      compoundBracketExpression(
        $,
        $._regex_open_dot,
        ".",
        "element",
        choice(
          alias($._regex_coll_elem_single, $.collating_element_single),
          alias($._regex_coll_elem_multi, $.collating_element_multi),
          alias($._regex_meta_char, $.meta_character),
        ),
        $._regex_dot_close,
      ),
    equivalence_class: ($) =>
      compoundBracketExpression(
        $,
        $._regex_open_equal,
        "=",
        "element",
        choice(
          alias($._regex_coll_elem_single, $.collating_element_single),
          alias($._regex_coll_elem_multi, $.collating_element_multi),
        ),
        $._regex_equal_close,
      ),
    character_class: ($) =>
      compoundBracketExpression(
        $,
        $._regex_open_colon,
        ":",
        "name",
        alias($._regex_class_name, $.class_name),
        $._regex_colon_close,
      ),
  };
}

function regexSymbol($, name, spelling) {
  return choice(
    alias($[`_regex_${name}`], spelling),
    alias($[`_regex_escaped_${name}`], $.escaped_delimiter),
    alias($[`_regex_encoded_${name}`], $.sed_character_escape),
  );
}

function regularExpressionEscape($) {
  return choice(
    $.quoted_character,
    $.sed_character_escape,
    $.escaped_delimiter,
  );
}

function oneCharOrCollElem($, ...additional) {
  return choice(
    $.ordinary_character,
    regularExpressionEscape($),
    $.sed_newline_escape,
    $.sed_character_class,
    $.sed_boundary_assertion,
    regexSymbol($, "period", "."),
    $.bracket_expression,
    ...additional,
  );
}

function commonRegularExpressionRules() {
  return {
    duplication_count: ($) => $._regex_dup_count,

    ordinary_character: ($) => $._regex_literal,

    quoted_character: ($) => $._regex_quoted_escape,

    escaped_delimiter: ($) => $._regex_escaped_delimiter,

    sed_newline_escape: ($) => $._regex_newline_escape,

    sed_character_escape: ($) => $._regex_character_escape,
    sed_character_class: ($) => $._regex_character_class,
    sed_boundary_assertion: ($) => $._regex_boundary_assertion,
    backreference: ($) => $._regex_backreference,

    ...bracketRules(),
  };
}

function alternation(branch, operator) {
  return choice(
    branch,
    seq(optional(branch), repeat1(seq(operator, optional(branch)))),
  );
}

function breRules() {
  return {
    ...commonRegularExpressionRules(),
    basic_reg_exp: ($) =>
      alternation(
        $.bre_branch,
        choice(
          alias($._regex_alternation_operator, "\\|"),
          alias($._regex_encoded_alternation_operator, $.sed_character_escape),
        ),
      ),

    bre_branch: ($) => repeat1($.bre_expression),

    bre_expression: ($) =>
      prec.right(
        choice(
          seq(
            regexSymbol($, "beginning_anchor", "^"),
            optional($.simple_bre),
            optional(regexSymbol($, "end_anchor", "$")),
          ),
          seq($.simple_bre, optional(regexSymbol($, "end_anchor", "$"))),
          regexSymbol($, "end_anchor", "$"),
        ),
      ),

    simple_bre: ($) => seq($.nondupl_bre, repeat($.bre_dupl_symbol)),

    nondupl_bre: ($) =>
      choice(
        $.one_char_or_coll_elem_bre,
        seq(
          field(
            "opening",
            choice(
              alias($._regex_group_open, "\\("),
              alias($._regex_encoded_group_open, $.sed_character_escape),
            ),
          ),
          optional(field("expression", $.basic_reg_exp)),
          subexpressionClose($, "\\)"),
        ),
        $.backreference,
      ),

    one_char_or_coll_elem_bre: ($) => oneCharOrCollElem($),

    bre_dupl_symbol: ($) =>
      choice(
        regexSymbol($, "zero_or_more", "*"),
        choice(
          alias($._regex_one_or_more, "\\+"),
          alias($._regex_encoded_one_or_more, $.sed_character_escape),
        ),
        choice(
          alias($._regex_zero_or_one, "\\?"),
          alias($._regex_encoded_zero_or_one, $.sed_character_escape),
        ),
        $._bre_interval,
      ),

    _bre_interval: ($) => intervalExpression($, "\\{", "\\}"),
  };
}

function ereRules() {
  return {
    ...commonRegularExpressionRules(),
    extended_reg_exp: ($) =>
      alternation($.ere_branch, regexSymbol($, "alternation_operator", "|")),

    ere_branch: ($) => repeat1($.ere_expression),

    ere_expression: ($) =>
      prec.left(
        1,
        seq(
          choice(
            $.one_char_or_coll_elem_ere,
            regexSymbol($, "beginning_anchor", "^"),
            regexSymbol($, "end_anchor", "$"),
            seq(
              field("opening", regexSymbol($, "group_open", "(")),
              optional(field("expression", $.extended_reg_exp)),
              subexpressionClose($, ")"),
            ),
          ),
          repeat($.ere_dupl_symbol),
        ),
      ),

    one_char_or_coll_elem_ere: ($) => oneCharOrCollElem($, $.backreference),

    ere_dupl_symbol: ($) =>
      seq(
        choice(
          regexSymbol($, "zero_or_more", "*"),
          regexSymbol($, "one_or_more", "+"),
          regexSymbol($, "zero_or_one", "?"),
          $._ere_interval,
        ),
        optional(
          field(
            "modifier",
            choice(
              $.repetition_modifier,
              alias($._regex_escaped_repetition_modifier, $.escaped_delimiter),
              alias(
                $._regex_encoded_repetition_modifier,
                $.sed_character_escape,
              ),
            ),
          ),
        ),
      ),

    _ere_interval: ($) => intervalExpression($, "{", "}"),

    repetition_modifier: ($) => $._regex_repetition_modifier,
  };
}

export function externalTokens(mode) {
  return [
    "regex_address_start",
    "escaped_regex_address_start",
    "regex_address_end",
    "substitute_start",
    "substitute_middle",
    "substitute_end",
    "translate_start",
    "translate_middle",
    "translate_end",
    "regex_literal",
    ...[
      "beginning_anchor",
      "end_anchor",
      "period",
      "zero_or_more",
      "one_or_more",
      "zero_or_one",
      "alternation_operator",
      "group_open",
      "group_close",
      "interval_open",
      "bracket_open",
    ].map((name) => `regex_encoded_${name}`),
    ...(mode === "ere" ? ["regex_encoded_repetition_modifier"] : []),
    "regex_beginning_anchor",
    "regex_escaped_beginning_anchor",
    "regex_end_anchor",
    "regex_escaped_end_anchor",
    "regex_period",
    "regex_escaped_period",
    "regex_quoted_escape",
    "regex_newline_escape",
    "regex_character_escape",
    "regex_character_class",
    "regex_boundary_assertion",
    "regex_escaped_delimiter",
    ...(mode === "ere"
      ? [
          "regex_escaped_group_open",
          "regex_escaped_group_close",
          "regex_escaped_interval_open",
          "regex_escaped_one_or_more",
          "regex_escaped_zero_or_one",
          "regex_escaped_alternation_operator",
          "regex_escaped_repetition_modifier",
        ]
      : []),
    "regex_group_open",
    "regex_group_close",
    "regex_alternation_operator",
    "regex_zero_or_more",
    "regex_escaped_zero_or_more",
    "regex_one_or_more",
    "regex_zero_or_one",
    ...(mode === "ere" ? ["regex_repetition_modifier"] : []),
    "regex_interval_open",
    "regex_dup_count",
    "regex_interval_encoded_count",
    "regex_interval_encoded_separator",
    "regex_interval_encoded_close",
    "regex_interval_escaped_count",
    "regex_interval_escaped_separator",
    "regex_interval_separator",
    "regex_interval_close",
    "regex_backreference",
    "regex_bracket_open",
    "regex_escaped_bracket_open",
    "regex_bracket_close",
    "regex_bracket_literal",
    "regex_bracket_negation",
    "regex_bracket_hyphen",
    "regex_bracket_range_end_hyphen",
    "regex_bracket_trailing_hyphen",
    "regex_open_colon",
    "regex_class_name",
    "regex_colon_close",
    "regex_open_dot",
    "regex_coll_elem_single",
    "regex_coll_elem_multi",
    "regex_meta_char",
    "regex_dot_close",
    "regex_open_equal",
    "regex_equal_close",
    "replacement_literal",
    "replacement_match_reference",
    "replacement_backreference",
    "replacement_escaped_delimiter",
    "replacement_escape_sequence",
    "replacement_case_conversion",
    "replacement_escaped_newline",
    "translate_literal",
    "translate_escaped_delimiter",
    "translate_escape",
    "text_command_start",
    "text_literal",
    "text_escape",
    "text_escaped_newline",
    "text_line_end",
    "text_eof",
    "default_output_suppression",
    "comment_text",
    "file_argument",
    "label_literal",
    "label_command_end",
    "argument_separator",
    "brace_leading_blanks",
    "block_trailing_blanks",
    "empty_command_marker",
    "error_sentinel",
  ];
}

function defineGrammar(name, mode) {
  if (mode !== "bre" && mode !== "ere") {
    throw new Error(`Unsupported regular-expression mode: ${mode}`);
  }
  const options = {
    name,
    externals: ($) => externalTokens(mode).map((name) => $[`_${name}`]),
    extras: () => [],
    conflicts: ($) => [
      [$._command_list],
      [$._initial_suppressing_comment_command_list],
      [$.address_clause, $._max1_address_clause],
    ],
  };
  const rules = sedRules(mode);
  return mode === "bre"
    ? grammar({ ...options, rules: { ...rules, ...breRules() } })
    : grammar({ ...options, rules: { ...rules, ...ereRules() } });
}

export default defineGrammar;
