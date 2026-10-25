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
    lineTerminated: true,
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
    writeTerminated: true,
  },
  {
    rule: "test_function",
    spelling: "t",
    form: "optionalLabel",
    lineTerminated: true,
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
    lineTerminated: true,
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

const unknownFunctionCharacter = new RegExp(
  `[^ \\t0-9$\\/\\\\!;}\\n${functionDefinitions
    .map(({ spelling }) => spelling)
    .join("")}]`,
);

function defineIssueRules(definitions) {
  const rules = {};
  for (const { reason, id = reason, outcome, rule } of definitions) {
    rules[`_${id}_reason`] = rule;
    rules[`_${id}_outcome`] = ($) => alias($[`_${id}_reason`], $[reason]);
    rules[`_${id}_issue`] = ($) => alias($[`_${id}_outcome`], $[outcome]);
  }
  return rules;
}

function issueField($, id) {
  return field("issue", alias($[`_${id}_issue`], $.syntax_issue));
}

function issueFields($, ...ids) {
  return choice(...ids.map((id) => issueField($, id)));
}

function invalidCharacterIssue($, nulId) {
  return issueFields($, nulId, "invalid_encoding");
}

function missingAtEndOrBoundary($, reason) {
  return issueFields($, reason, `nonconforming_${reason}`);
}

function blankSeparatedFileOperand($, name, operand) {
  return seq(
    $._blanks,
    choice(operand, missingAtEndOrBoundary($, `missing_${name}`)),
  );
}

function fileOperandForms($, name, operand) {
  return [
    blankSeparatedFileOperand($, name, operand),
    seq(issueField($, "omitted_file_separator"), operand),
    missingAtEndOrBoundary($, `missing_${name}`),
  ];
}

function sourcePiece($, external, leaf) {
  return choice(
    alias(external, $[leaf]),
    invalidCharacterIssue($, "nul_character"),
  );
}

function lineOperand($, first, rest) {
  return prec.right(
    seq(
      sourcePiece($, first, "file_literal"),
      repeat(sourcePiece($, rest, "file_literal")),
    ),
  );
}

function operandAtoms($, literal, ...atoms) {
  return repeat1(
    choice(
      literal,
      seq($._escape_prefix, issueField($, "invalid_encoding")),
      invalidCharacterIssue($, "nul_character"),
      ...atoms,
    ),
  );
}

function missingCommandSeparator($, afterCommand = false) {
  return seq(
    ...(afterCommand ? [optional($._brace_leading_blanks)] : []),
    issueFields(
      $,
      "missing_command_separator",
      "incomplete_missing_command_separator",
    ),
  );
}

function functionVerb($, spelling) {
  return field("verb", alias(spelling, $.function_verb));
}

const exclusiveSubstitutionFlags = [
  {
    bit: 1,
    flag: ($) => alias("g", $.global_flag),
    conflict: "conflicting_global_flag",
  },
  {
    bit: 2,
    flag: ($) => $.occurrence_flag,
    conflict: "conflicting_occurrence_flag",
  },
];

function substitutionFlagRules() {
  const rules = {};
  for (const ending of ["plain", "write", "postwrite"]) {
    for (const seen of [0, 1, 2, 3]) {
      rules[`_flags_${ending}_${seen}`] = ($) => {
        const steady = [
          alias("i", $.case_insensitive_flag),
          alias("p", $.print_flag),
          ...(ending === "postwrite"
            ? [
                choice(
                  alias("w", $.substitution_flag),
                  issueField($, "nonfinal_write_flag"),
                ),
              ]
            : [
                issueField($, "invalid_substitution_flag"),
                issueField($, "invalid_encoding"),
              ]),
        ];
        const transitions = [];
        for (const { bit, flag, conflict } of exclusiveSubstitutionFlags) {
          const symbol = seen & ~bit ? issueField($, conflict) : flag($);
          if (seen & bit) {
            steady.push(symbol);
          } else {
            const tail = $[`_flags_${ending}_${seen | bit}`];
            transitions.push(
              seq(symbol, ending === "write" ? tail : optional(tail)),
            );
          }
        }
        if (ending === "write") {
          return prec.right(
            seq(
              repeat(choice(...steady)),
              choice(
                alias($[`_write_flag_${seen}`], $.write_flag),
                ...transitions,
              ),
            ),
          );
        }
        return prec.right(
          transitions.length === 0
            ? repeat1(choice(...steady))
            : choice(
                repeat1(choice(...steady)),
                seq(repeat(choice(...steady)), choice(...transitions)),
              ),
        );
      };
    }
  }
  for (const seen of [0, 1, 2, 3]) {
    rules[`_write_flag_${seen}`] = ($) => {
      const wfile = field("wfile", alias($._substitution_wfile, $.wfile));
      return choice(
        seq(
          field("verb", alias("w", $.substitution_flag)),
          choice(
            ...fileOperandForms($, "wfile", wfile),
            seq(issueField($, "incomplete_omitted_file_separator"), wfile),
          ),
        ),
        seq(
          issueField($, "nonfinal_write_flag"),
          $[`_flags_postwrite_${seen}`],
          blankSeparatedFileOperand($, "wfile", wfile),
        ),
      );
    };
  }
  return rules;
}

function delimiter($, name) {
  return alias($[`_${name}`], $.delimiter);
}

function missingOpeningDelimiter($) {
  return issueFields(
    $,
    "invalid_delimiter",
    "invalid_encoding",
    "missing_opening_delimiter",
    "nonconforming_missing_opening_delimiter",
  );
}

function unterminatedDelimiter($, construct) {
  return issueFields($, `incomplete_${construct}`, `unterminated_${construct}`);
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

function commandUnit($, block) {
  const beforeUnmatchedBrace = block
    ? []
    : [
        seq(
          optional($._brace_leading_blanks),
          issueField($, "missing_separator_before_unmatched_brace"),
        ),
      ];
  return choice(
    seq(
      editingCommand($, "write_terminated"),
      choice(
        newlineSeparator($),
        alias(
          block
            ? $._write_block_terminal_separator
            : $._write_terminal_separator,
          $.command_separator,
        ),
        issueField($, "undefined_write_command_separator"),
        ...beforeUnmatchedBrace,
      ),
    ),
    seq(
      $._separable_command_item,
      choice(
        semicolonSeparator($),
        newlineSeparator($),
        ...beforeUnmatchedBrace,
      ),
    ),
    ...(block
      ? []
      : [
          seq(
            issueField($, "unmatched_closing_brace"),
            optional($._blanks),
            choice(
              semicolonSeparator($),
              newlineSeparator($),
              ...beforeUnmatchedBrace,
              issueField($, "missing_separator_after_unmatched_brace"),
            ),
          ),
        ]),
    seq(
      editingCommand($, "line_terminated"),
      choice(newlineSeparator($), ...beforeUnmatchedBrace),
    ),
    editingCommand($, "recovered_line_terminated"),
  );
}

function commandItem($, block) {
  return choice(
    $._separable_command_item,
    ...(block ? [] : [issueField($, "unmatched_closing_brace")]),
    editingCommand($, "line_terminated"),
    editingCommand($, "write_terminated"),
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
        repeat(sourcePiece($, $._comment_text, "comment_text")),
      ),

    _command_list: ($) => commandList($, $._command_unit, $._command_item),

    _command_unit: ($) => commandUnit($, false),

    _command_item: ($) => commandItem($, false),

    _separable_command_item: ($) =>
      choice(
        $.empty_command,
        editingCommand($, "chainable"),
        seq(editingCommand($, "block"), optional($._block_trailing_blanks)),
        editingCommand($, "tailed_block"),
        editingCommand($, "recovered"),
      ),

    _block_commands: ($) =>
      choice(
        commandList(
          $,
          $._block_unit,
          seq($._block_item, missingCommandSeparator($, true)),
        ),
        missingCommandSeparator($),
      ),

    _block_unit: ($) => commandUnit($, true),

    _block_item: ($) => commandItem($, true),

    empty_command: ($) => $._empty_command_marker,

    _blanks: () => token(/[ \t]+/),
  };
}

function omittedAddress($) {
  return issueFields($, "omitted_address", "incomplete_omitted_address");
}

const regularExpressionRules = {
  bre: { expression: "basic_reg_exp", duplication: "bre_dupl_symbol" },
  ere: { expression: "extended_reg_exp", duplication: "ere_dupl_symbol" },
};

function addressRules(mode) {
  const { expression } = regularExpressionRules[mode];

  function addressChoice($) {
    return choice(
      $.line_number_address,
      $.last_line_address,
      $.context_address,
    );
  }

  function contextAddress($, opening) {
    return seq(
      field("opening", opening),
      optional(field("expression", $[expression])),
      choice(
        field("closing", delimiter($, "regex_address_end")),
        unterminatedDelimiter($, "regular_expression"),
      ),
    );
  }

  return {
    address_clause: ($) =>
      choice(
        $._single_address_clause,
        $._double_address_clause,
        $._max2_excess_address_clause,
      ),

    _single_address_clause: ($) => field("first", $.address),

    _double_address_clause: ($) =>
      choice(
        seq(
          field("first", $.address),
          $._address_separator,
          field("second", $.address),
        ),
        seq(
          issueField($, "omitted_first_address"),
          $._comma_address_separator,
          field("second", $.address),
        ),
        seq(
          choice(
            field("first", $.address),
            issueField($, "omitted_first_address"),
          ),
          $._comma_address_separator,
          omittedAddress($),
        ),
      ),

    _max2_excess_address_clause: ($) =>
      prec.dynamic(
        1,
        seq(
          $._double_address_clause,
          repeat1(issueField($, "excess_address_unit2")),
        ),
      ),

    _max1_address_clause: ($) =>
      choice($._single_address_clause, $._max1_excess_address_clause),

    _max1_excess_address_clause: ($) =>
      prec.dynamic(
        1,
        seq(
          choice(
            field("first", $.address),
            issueField($, "omitted_first_address_unit1"),
          ),
          repeat1(issueField($, "excess_address_unit1")),
        ),
      ),

    _max0_address_clause: ($) =>
      prec.dynamic(
        1,
        seq(
          choice(
            issueField($, "excess_address"),
            seq(
              issueField($, "omitted_first_address_unit0"),
              issueField($, "excess_address_unit0"),
            ),
          ),
          repeat(issueField($, "excess_address_unit0")),
        ),
      ),

    _address_separator: ($) =>
      choice(
        $._comma_address_separator,
        prec(
          -1,
          seq(issueField($, "missing_address_separator"), optional($._blanks)),
        ),
      ),

    _comma_address_separator: ($) =>
      seq(
        optional(issueField($, "blanks_around_address_separator")),
        field("separator", alias(",", $.address_separator)),
        optional(issueField($, "blanks_around_address_separator")),
      ),

    address: addressChoice,

    _max0_address: addressChoice,

    _max1_address: addressChoice,

    _max2_address: addressChoice,

    line_number_address: () => /[0-9]+/,

    last_line_address: () => "$",

    context_address: ($) =>
      choice(
        contextAddress($, delimiter($, "regex_address_start")),
        seq(
          field("escape", alias("\\", $.address_escape)),
          choice(
            contextAddress($, delimiter($, "escaped_regex_address_start")),
            missingOpeningDelimiter($),
          ),
        ),
      ),
  };
}

function delimitedFunction($, spelling, name, first, middleReason, rest) {
  return prec.right(
    seq(
      functionVerb($, spelling),
      choice(
        seq(
          field("opening", delimiter($, `${name}_start`)),
          optional(first),
          choice(
            seq(field("middle", delimiter($, `${name}_middle`)), ...rest),
            unterminatedDelimiter($, middleReason),
          ),
        ),
        missingOpeningDelimiter($),
      ),
    ),
  );
}

function operandRules(mode) {
  const { expression } = regularExpressionRules[mode];

  return {
    substitute_function: ($) =>
      delimitedFunction(
        $,
        "s",
        "substitute",
        field("expression", $[expression]),
        "regular_expression",
        [
          optional(field("replacement", $.replacement)),
          choice(
            seq(
              field("closing", delimiter($, "substitute_end")),
              optional(
                field("flags", alias($._flags_plain_0, $.substitution_flags)),
              ),
            ),
            unterminatedDelimiter($, "replacement"),
          ),
        ],
      ),

    replacement: ($) =>
      operandAtoms(
        $,
        $.replacement_literal,
        $.matched_text_reference,
        $.replacement_backreference,
        $.replacement_escaped_delimiter,
        issueField($, "replacement_ampersand_delimiter_escape"),
        $.replacement_escape,
        $.escaped_newline,
        issueField($, "unspecified_replacement_escape"),
        issueField($, "incomplete_replacement_escape"),
      ),

    replacement_literal: ($) => $._replacement_literal,

    matched_text_reference: ($) => $._replacement_match_reference,

    replacement_backreference: ($) => $._replacement_backreference,

    replacement_escaped_delimiter: ($) => $._replacement_escaped_delimiter,

    replacement_escape: ($) => $._replacement_escape_sequence,

    escaped_newline: ($) => $._replacement_escaped_newline,

    _write_substitute_function: ($) =>
      seq(
        functionVerb($, "s"),
        field("opening", delimiter($, "substitute_start")),
        optional(field("expression", $[expression])),
        field("middle", delimiter($, "substitute_middle")),
        optional(field("replacement", $.replacement)),
        field("closing", delimiter($, "substitute_end")),
        field("flags", alias($._flags_write_0, $.substitution_flags)),
      ),

    ...substitutionFlagRules(),

    occurrence_flag: () => /[0-9]+/,

    translate_function: ($) =>
      delimitedFunction(
        $,
        "y",
        "translate",
        field("string1", $.translation_string),
        "translation",
        [
          optional(field("string2", $.translation_string)),
          choice(
            field("closing", delimiter($, "translate_end")),
            unterminatedDelimiter($, "translation"),
          ),
        ],
      ),

    translation_string: ($) =>
      operandAtoms(
        $,
        $.translation_literal,
        $.translation_escape,
        $.translation_escaped_delimiter,
        issueField($, "undefined_translation_escape"),
        issueField($, "incomplete_translation_escape"),
      ),

    translation_literal: ($) => $._translate_literal,

    translation_escape: ($) => $._translate_escape,

    translation_escaped_delimiter: ($) => $._translate_escaped_delimiter,
  };
}

function functionRules() {
  const noArgumentDefinitions = functionDefinitions.filter(
    ({ form }) => form === undefined,
  );

  function fileOperand($) {
    return lineOperand($, $._file_argument, $._line_word);
  }

  const rules = {
    text: ($) =>
      seq(
        operandAtoms(
          $,
          $.text_literal,
          $.text_backslash_escape,
          $.text_escaped_newline,
          issueField($, "unspecified_text_escape"),
        ),
        $._text_tail,
      ),

    _text_tail: ($) =>
      seq(
        optional(issueField($, "missing_text")),
        choice($._text_line_end, $._text_eof),
      ),

    text_literal: ($) => $._text_literal,

    text_backslash_escape: ($) => $._text_backslash_escape,

    text_escaped_newline: ($) => $._text_escaped_newline,

    text_introducer: ($) => $._text_command_start,

    rfile: fileOperand,

    wfile: fileOperand,

    _substitution_wfile: ($) =>
      lineOperand(
        $,
        $._substitution_wfile_argument,
        $._substitution_wfile_continuation,
      ),

    label: ($) =>
      choice(
        seq($._label_start, $._label_body),
        issueField($, "nonportable_label_length"),
      ),

    _label_body: ($) =>
      prec.right(
        repeat1(
          choice(
            sourcePiece($, $._label_literal, "label_literal"),
            issueField($, "nonportable_label_character"),
          ),
        ),
      ),

    comment: ($) =>
      prec.right(repeat1(sourcePiece($, $._comment_text, "comment_text"))),

    comment_function: ($) =>
      prec.right(
        seq(functionVerb($, "#"), optional(field("comment", $.comment))),
      ),

    closing_brace: () => token("}"),
  };

  function fileForm(form) {
    return ($) => [choice(...fileOperandForms($, form, field(form, $[form])))];
  }

  const formArguments = {
    block: ($) => [
      optional($._blanks),
      field("commands", alias($._block_commands, $.command_list)),
      optional($._brace_leading_blanks),
      choice(
        field("closing", $.closing_brace),
        issueField($, "missing_closing_brace"),
      ),
    ],
    text: ($) => [
      choice(
        seq(
          field("introducer", $.text_introducer),
          choice(field("text", $.text), $._text_tail),
        ),
        issueField($, "incomplete_text_introducer"),
        missingAtEndOrBoundary($, "missing_text_introducer"),
      ),
    ],
    optionalLabel: ($) => [
      optional(
        seq(
          field(
            "separator",
            alias($._argument_separator, $.argument_separator),
          ),
          field("label", $.label),
        ),
      ),
    ],
    requiredLabel: ($) => [
      choice(
        field("label", $.label),
        missingAtEndOrBoundary($, "missing_label"),
      ),
    ],
    rfile: fileForm("rfile"),
    wfile: fileForm("wfile"),
  };

  for (const { rule, spelling } of noArgumentDefinitions) {
    rules[rule] = ($) => functionVerb($, spelling);
  }

  for (const { form, rule, spelling } of functionDefinitions) {
    const argumentParts = formArguments[form];
    if (argumentParts === undefined) {
      continue;
    }
    rules[rule] = ($) => seq(functionVerb($, spelling), ...argumentParts($));
  }

  return rules;
}

function commandTail($, nonempty = false) {
  const encoding = issueField($, "invalid_encoding");
  const text = issueFields(
    $,
    "unexpected_command_text",
    "incomplete_command_text",
  );
  return nonempty
    ? choice(seq(repeat1(encoding), optional(text)), text)
    : seq(repeat(encoding), optional(text));
}

function unknownFunction($, ...ids) {
  return seq(issueFields($, ...ids, "invalid_encoding"), commandTail($));
}

function editingCommandRules() {
  const addressClauses = {
    0: ($) => alias($._max0_address_clause, $.address_clause),
    1: ($) => alias($._max1_address_clause, $.address_clause),
    2: ($) => $.address_clause,
  };

  // Separate address limits prevent premature GLR merging.
  const wrappers = [];
  for (const [kind, isLineTerminated] of [
    ["chainable", false],
    ["block", false],
    ["line_terminated", true],
    ["write_terminated", false],
  ]) {
    for (const maximum of [0, 1, 2]) {
      const names = functionDefinitions
        .filter(
          ({
            lineTerminated = false,
            writeTerminated = false,
            maxAddresses = 2,
            form,
          }) =>
            (form === "block") === (kind === "block") &&
            writeTerminated === (kind === "write_terminated") &&
            lineTerminated === isLineTerminated &&
            maxAddresses === maximum,
        )
        .map(({ rule }) => rule);
      if (names.length > 0) {
        wrappers.push({
          kind,
          maximum,
          name: `_${kind}_${maximum}_address_function`,
          names,
        });
      }
    }
  }

  function addressesPrefix($, addresses) {
    return seq(field("addresses", addresses), optional($._blanks));
  }

  function addressedCommand($, addresses, body) {
    return seq(
      optional(addressesPrefix($, addresses)),
      optional(field("negation", $.negation)),
      body,
    );
  }

  function addressedForms($, kind) {
    return choice(
      ...wrappers
        .filter((wrapper) => wrapper.kind === kind)
        .map(({ maximum, name }) =>
          addressedCommand(
            $,
            addressClauses[maximum]($),
            field("function", alias($[name], $.function)),
          ),
        ),
    );
  }

  const rules = {
    _chainable_editing_command: ($) =>
      seq(addressedForms($, "chainable"), commandTail($)),

    _block_editing_command: ($) => addressedForms($, "block"),

    _tailed_block_editing_command: ($) =>
      seq(addressedForms($, "block"), commandTail($, true)),

    _write_terminated_editing_command: ($) =>
      seq(addressedForms($, "write_terminated"), commandTail($)),

    _line_terminated_editing_command: ($) =>
      seq(addressedForms($, "line_terminated"), commandTail($)),

    _recovered_line_terminated_editing_command: ($) =>
      seq(
        $._line_terminated_editing_command,
        issueField($, "forbidden_command_separator"),
      ),

    _recovered_editing_command: ($) =>
      seq(
        choice(
          seq(
            optional(addressesPrefix($, $.address_clause)),
            field("negation", $.negation),
            choice(
              unknownFunction(
                $,
                "unknown_function",
                "reserved_unknown_function",
              ),
              missingAtEndOrBoundary($, "missing_function"),
            ),
          ),
          seq(
            addressesPrefix($, $.address_clause),
            choice(
              unknownFunction($, "unknown_function"),
              missingAtEndOrBoundary($, "missing_function"),
            ),
          ),
          unknownFunction($, "unknown_function"),
        ),
      ),

    negation: ($) =>
      seq(
        field("operator", alias("!", $.negation_operator)),
        repeat(
          seq(
            optional(issueField($, "blanks_after_negation")),
            issueField($, "duplicate_negation"),
          ),
        ),
        optional(issueField($, "blanks_after_negation")),
      ),
  };

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

const nonportableRangeClasses = ["character_class", "equivalence_class"];

function escapedInvalidCharacter($) {
  return seq(
    $._escape_prefix,
    invalidCharacterIssue($, "escaped_invalid_regular_expression_character"),
  );
}

function intervalSeparator($) {
  return choice(
    alias($._regex_interval_separator, ","),
    alias($._regex_interval_escaped_separator, $.escaped_delimiter),
  );
}

function intervalExpression($, opening, closing) {
  const piece = (name) =>
    choice(
      field(name, $.duplication_count),
      field(name, alias($._regex_interval_escaped_count, $.escaped_delimiter)),
      issueField($, "invalid_interval_character"),
      ...(opening === "{"
        ? [issueField($, "incomplete_regular_expression_escape")]
        : []),
      invalidCharacterIssue($, "invalid_regular_expression_character"),
      escapedInvalidCharacter($),
    );
  return seq(
    alias($._regex_interval_open, opening),
    choice(
      repeat1(piece("minimum")),
      issueField($, "missing_interval_minimum"),
      issueField($, "incomplete_interval_minimum"),
    ),
    optional(
      seq(
        intervalSeparator($),
        repeat(
          choice(
            piece("maximum"),
            issueField($, "unexpected_interval_separator"),
          ),
        ),
      ),
    ),
    choice(
      alias($._regex_interval_close, closing),
      issueField($, "missing_interval_close"),
      issueField($, "incomplete_interval"),
      ...(opening === "\\{"
        ? [
            issueField($, "invalid_interval_close"),
            issueField($, "incomplete_interval_close"),
          ]
        : []),
    ),
  );
}

function compoundBracketExpression(
  $,
  openingExternal,
  marker,
  contentField,
  content,
  closingExternal,
  ...payloadIssues
) {
  const closingIssues = [
    issueField($, "missing_bracket_term_close"),
    issueField($, "incomplete_bracket_term"),
  ];
  const closing = seq(
    alias(closingExternal, marker),
    choice("]", ...closingIssues),
  );
  const payload = repeat1(
    choice(
      field(contentField, content),
      invalidCharacterIssue($, "invalid_regular_expression_character"),
      ...payloadIssues.map((reason) => issueField($, reason)),
    ),
  );
  return seq(
    alias(openingExternal, "["),
    marker,
    choice(
      payload,
      issueField($, "missing_bracket_term_payload"),
      issueField($, "incomplete_bracket_term_payload"),
    ),
    choice(closing, ...closingIssues),
  );
}

function bracketListBody($, list) {
  return choice(
    list,
    issueField($, "missing_bracket_list"),
    issueField($, "incomplete_missing_bracket_list"),
  );
}

function subexpressionClose($, closing) {
  return choice(
    field("closing", alias($._regex_group_close, closing)),
    issueField($, "unclosed_subexpression"),
    issueField($, "incomplete_unclosed_subexpression"),
  );
}

function bracketExpression($, ambiguous) {
  return seq(
    alias($._regex_bracket_open, "["),
    bracketListBody($, choice($.matching_list, $.nonmatching_list)),
    ...(ambiguous ? [$._ambiguous_bracket_expression_marker] : []),
    choice(
      alias($._regex_bracket_close, "]"),
      issueField($, "unclosed_bracket_expression"),
      issueField($, "incomplete_unclosed_bracket_expression"),
    ),
  );
}

function rangeOperator($) {
  return alias($._regex_bracket_hyphen, "-");
}

function nonportableRangeRules() {
  const rules = {};
  for (const kind of nonportableRangeClasses) {
    rules[`_${kind}_start_range`] = ($) =>
      seq(issueField($, `${kind}_range_start`), rangeOperator($));
  }
  for (const kind of nonportableRangeClasses) {
    rules[`_${kind}_end_range`] = ($) => issueField($, `${kind}_range_end`);
  }
  return rules;
}

function bracketRules() {
  return {
    bracket_expression: ($) => bracketExpression($, false),

    _ambiguous_bracket_expression: ($) => bracketExpression($, true),

    _bracket_expression: ($) =>
      choice(
        $.bracket_expression,
        issueField($, "ambiguous_bracket_expression"),
      ),

    matching_list: ($) => $.bracket_list,

    nonmatching_list: ($) =>
      seq(
        alias($._regex_bracket_negation, "^"),
        bracketListBody($, $.bracket_list),
      ),

    bracket_list: ($) =>
      seq(
        $.follow_list,
        optional(alias($._regex_bracket_trailing_hyphen, "-")),
      ),

    follow_list: ($) => repeat1($.expression_term),

    expression_term: ($) =>
      choice(
        $.single_expression,
        $.range_expression,
        issueField($, "shared_range_endpoint"),
      ),

    single_expression: ($) =>
      choice($.end_range, $.character_class, $.equivalence_class),

    range_expression: ($) =>
      seq(
        choice(
          $.start_range,
          ...nonportableRangeClasses.map((kind) =>
            alias($[`_${kind}_start_range`], $.start_range),
          ),
        ),
        choice(
          $.end_range,
          ...nonportableRangeClasses.map((kind) =>
            alias($[`_${kind}_end_range`], $.end_range),
          ),
          alias($._regex_bracket_range_end_hyphen, "-"),
        ),
      ),

    ...nonportableRangeRules(),

    start_range: ($) => seq($.end_range, rangeOperator($)),

    end_range: ($) =>
      choice(
        alias($._regex_bracket_literal, $.collating_element_single),
        $.collating_symbol,
        invalidCharacterIssue($, "invalid_regular_expression_character"),
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
        "equivalence_class_meta_character",
        "incomplete_equivalence_class_meta_character",
      ),

    character_class: ($) =>
      compoundBracketExpression(
        $,
        $._regex_open_colon,
        ":",
        "name",
        alias($._regex_class_name, $.class_name),
        $._regex_colon_close,
        "invalid_character_class_name",
      ),
  };
}

function regularExpressionEscape($) {
  return choice(
    $.quoted_character,
    escapedInvalidCharacter($),
    $.escaped_delimiter,
    issueField($, "ordinary_character_escape"),
    issueField($, "incomplete_regular_expression_escape"),
    issueField($, "forbidden_regular_expression_newline"),
  );
}

function oneCharOrCollElem($, ...additional) {
  return choice(
    invalidCharacterIssue($, "invalid_regular_expression_character"),
    $.ordinary_character,
    regularExpressionEscape($),
    $.sed_newline_escape,
    alias($._regex_period, "."),
    $._bracket_expression,
    issueField($, "special_delimiter_escape"),
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

    ...bracketRules(),
  };
}

function breRules() {
  return {
    ...commonRegularExpressionRules(),
    basic_reg_exp: ($) => $.bre_branch,

    bre_branch: ($) => repeat1($.bre_expression),

    bre_expression: ($) =>
      prec.right(
        choice(
          seq(
            alias($._regex_beginning_anchor, "^"),
            optional($.simple_bre),
            optional(alias($._regex_end_anchor, "$")),
          ),
          seq($.simple_bre, optional(alias($._regex_end_anchor, "$"))),
          alias($._regex_end_anchor, "$"),
        ),
      ),

    simple_bre: ($) =>
      seq(
        choice(
          seq($.nondupl_bre, optional($.bre_dupl_symbol)),
          issueField($, "leading_duplication_symbol"),
        ),
        repeat(issueField($, "adjacent_duplication_symbol")),
      ),

    nondupl_bre: ($) =>
      choice(
        $.one_char_or_coll_elem_bre,
        seq(
          field("opening", alias($._regex_group_open, "\\(")),
          optional(field("expression", $.basic_reg_exp)),
          subexpressionClose($, "\\)"),
        ),
        $.backreference,
        issueField($, "unmatched_subexpression_close"),
        issueField($, "unmatched_interval_close"),
      ),

    backreference: ($) => $._regex_backreference,

    one_char_or_coll_elem_bre: ($) =>
      oneCharOrCollElem(
        $,
        issueField($, "bre_vertical_line_escape"),
        issueField($, "bre_question_mark_escape"),
        issueField($, "bre_plus_escape"),
        issueField($, "bre_subexpression_right_anchor"),
        issueField($, "bre_subexpression_left_anchor"),
      ),

    bre_dupl_symbol: ($) =>
      choice(alias($._regex_zero_or_more, "*"), $._bre_interval),

    _bre_interval: ($) => intervalExpression($, "\\{", "\\}"),
  };
}

function ereRules() {
  return {
    ...commonRegularExpressionRules(),
    extended_reg_exp: ($) =>
      choice(
        $.ere_branch,
        seq(
          choice($.ere_branch, $._empty_ere_branch),
          repeat1(
            seq(
              alias($._regex_alternation_operator, "|"),
              choice($.ere_branch, $._empty_ere_branch),
            ),
          ),
        ),
      ),

    _empty_ere_branch: ($) =>
      issueFields($, "empty_alternative", "incomplete_alternative"),

    ere_branch: ($) => repeat1($.ere_expression),

    ere_expression: ($) =>
      prec.left(
        1,
        seq(
          choice(
            $.one_char_or_coll_elem_ere,
            alias($._regex_beginning_anchor, "^"),
            alias($._regex_end_anchor, "$"),
            seq(
              field("opening", alias($._regex_group_open, "(")),
              optional(field("expression", $.extended_reg_exp)),
              subexpressionClose($, ")"),
            ),
            issueField($, "leading_duplication_symbol"),
          ),
          repeat(
            choice(
              $.ere_dupl_symbol,
              issueField($, "adjacent_duplication_symbol"),
            ),
          ),
        ),
      ),

    one_char_or_coll_elem_ere: ($) => oneCharOrCollElem($),

    ere_dupl_symbol: ($) =>
      seq(
        choice(
          alias($._regex_zero_or_more, "*"),
          alias($._regex_one_or_more, "+"),
          alias($._regex_zero_or_one, "?"),
          $._ere_interval,
        ),
        optional(field("modifier", $.repetition_modifier)),
      ),

    _ere_interval: ($) => intervalExpression($, "{", "}"),

    repetition_modifier: ($) => $._regex_repetition_modifier,
  };
}

const missingCommandDefinitions = [
  { reason: "missing_function", atBoundary: true },
  { reason: "missing_label", atBoundary: true },
  { reason: "missing_rfile", atBoundary: true },
  { reason: "missing_wfile", atBoundary: true },
  { reason: "missing_text_introducer", atBoundary: true },
  {
    reason: "incomplete_text_introducer",
    rule: ($) => $._text_incomplete_introducer,
  },
  { reason: "missing_text" },
  { reason: "missing_closing_brace" },
  { reason: "missing_opening_delimiter", atBoundary: true },
];

const boundaryMissingReasons = missingCommandDefinitions
  .filter(({ atBoundary }) => atBoundary)
  .map(({ reason }) => reason);

function missingMarkerNames(mode) {
  return [
    "omitted_address",
    "incomplete_omitted_address",
    "omitted_first_address",
    ...(mode === "ere" ? ["empty_alternative"] : []),
    "missing_function",
    "missing_label",
    "missing_rfile",
    "missing_wfile",
    "omitted_file_separator",
    "incomplete_omitted_file_separator",
    "missing_text_introducer",
    "missing_text",
    "missing_command_separator",
    "missing_address_separator",
    "missing_closing_brace",
    "missing_opening_delimiter",
    "missing_separator_before_unmatched_brace",
    "missing_separator_after_unmatched_brace",
    ...boundaryMissingReasons.map((reason) => `nonconforming_${reason}`),
    "incomplete_bracket_list",
    "incomplete_bracket_expression",
    ...(mode === "ere" ? ["incomplete_alternative"] : []),
    "incomplete_command_separator",
  ];
}

function issueDefinitions(mode) {
  function missing(reason) {
    return ($) => $[`_${reason}_marker`];
  }

  function nonportableEscape(token) {
    return ($) =>
      choice(
        $[token],
        seq($._escape_prefix, issueField($, "escaped_nul_character")),
      );
  }

  function misplacedDuplication(marker) {
    return ($) =>
      seq(
        $[marker],
        field("operator", $[regularExpressionRules[mode].duplication]),
      );
  }

  return [
    {
      reason: "nonportable_label_character",
      outcome: "unspecified_syntax",
      rule: ($) => alias($._nonportable_label_character, $.label_literal),
    },
    {
      reason: "nonportable_label_length",
      outcome: "unspecified_syntax",
      rule: ($) =>
        seq($._long_label_start, alias($._label_literal, $.label_literal)),
    },
    {
      reason: "missing_bracket_term_close",
      outcome: "undefined_syntax",
      rule: ($) => $._regex_missing_bracket_term_close,
    },
    {
      reason: "invalid_character_class_name",
      outcome: "undefined_syntax",
      rule: ($) => $._regex_invalid_class_name,
    },
    {
      id: "equivalence_class_meta_character",
      reason: "invalid_equivalence_class_element",
      outcome: "undefined_syntax",
      rule: ($) => alias($._regex_meta_char, $.meta_character),
    },
    {
      id: "incomplete_equivalence_class_meta_character",
      reason: "invalid_equivalence_class_element",
      outcome: "incomplete_syntax",
      rule: ($) => alias($._regex_incomplete_meta_char, $.meta_character),
    },
    {
      reason: "missing_bracket_term_payload",
      outcome: "undefined_syntax",
      rule: ($) => $._regex_missing_bracket_term_payload,
    },
    {
      id: "incomplete_bracket_term_payload",
      reason: "missing_bracket_term_payload",
      outcome: "incomplete_syntax",
      rule: ($) => $._regex_incomplete_bracket_term_payload,
    },
    {
      reason: "nul_character",
      outcome: "nonconforming_syntax",
      rule: ($) => $._nul_character,
    },
    {
      reason: "invalid_regular_expression_character",
      outcome: "invalid_syntax",
      rule: ($) => $._nul_character,
    },
    {
      id: "escaped_nul_character",
      reason: "nul_character",
      outcome: "nonconforming_syntax",
      rule: ($) => $._single_nul_character,
    },
    {
      id: "escaped_invalid_regular_expression_character",
      reason: "invalid_regular_expression_character",
      outcome: "invalid_syntax",
      rule: ($) => $._single_nul_character,
    },
    {
      reason: "invalid_encoding",
      outcome: "invalid_syntax",
      rule: ($) => $._invalid_character,
    },
    {
      reason: "character_class_range_start",
      outcome: "undefined_syntax",
      rule: ($) => seq($.character_class, $._nonportable_range_start_marker),
    },
    {
      reason: "character_class_range_end",
      outcome: "undefined_syntax",
      rule: ($) => seq($._nonportable_range_end_marker, $.character_class),
    },
    {
      reason: "shared_range_endpoint",
      outcome: "undefined_syntax",
      rule: ($) => alias($._regex_shared_range_endpoint, "-"),
    },
    {
      reason: "omitted_address",
      outcome: "undefined_syntax",
      rule: missing("omitted_address"),
    },
    {
      id: "incomplete_omitted_address",
      reason: "omitted_address",
      outcome: "incomplete_syntax",
      rule: missing("incomplete_omitted_address"),
    },
    {
      id: "omitted_first_address",
      reason: "omitted_address",
      outcome: "undefined_syntax",
      rule: missing("omitted_first_address"),
    },
    ...[0, 1].map((maximum) => ({
      id: `omitted_first_address_unit${maximum}`,
      reason: "omitted_address",
      outcome: "undefined_syntax",
      rule: missing("omitted_first_address"),
    })),
    {
      reason: "ordinary_character_escape",
      outcome: "undefined_syntax",
      rule: ($) => $._regex_nonportable_escape,
    },
    {
      reason: "unclosed_subexpression",
      outcome: "undefined_syntax",
      rule: ($) => $._regex_unclosed_group,
    },
    ...(mode === "bre"
      ? [
          {
            reason: "unmatched_subexpression_close",
            outcome: "undefined_syntax",
            rule: ($) => $._regex_unmatched_group_close,
          },
          {
            reason: "unmatched_interval_close",
            outcome: "undefined_syntax",
            rule: ($) => $._regex_unmatched_interval_close,
          },
        ]
      : []),
    {
      reason: "invalid_interval_character",
      outcome: "undefined_syntax",
      rule: ($) => $._regex_invalid_interval,
    },
    {
      reason: "unexpected_interval_separator",
      outcome: "undefined_syntax",
      rule: intervalSeparator,
    },
    {
      reason: "missing_interval_minimum",
      outcome: "undefined_syntax",
      rule: ($) => $._regex_missing_interval_minimum,
    },
    {
      id: "incomplete_interval_minimum",
      reason: "missing_interval_minimum",
      outcome: "incomplete_syntax",
      rule: ($) => $._regex_incomplete_interval_minimum,
    },
    {
      reason: "missing_interval_close",
      outcome: "undefined_syntax",
      rule: ($) => $._regex_missing_interval_close,
    },
    ...(mode === "bre"
      ? [
          {
            reason: "invalid_interval_close",
            outcome: "undefined_syntax",
            rule: ($) => $._regex_invalid_interval_close,
          },
          {
            id: "incomplete_interval_close",
            reason: "invalid_interval_close",
            outcome: "incomplete_syntax",
            rule: ($) => $._regex_incomplete_interval_close,
          },
        ]
      : []),
    {
      reason: "leading_duplication_symbol",
      outcome: "undefined_syntax",
      rule: misplacedDuplication("_regex_leading_duplication_marker"),
    },
    {
      reason: "adjacent_duplication_symbol",
      outcome: "undefined_syntax",
      rule: misplacedDuplication("_regex_adjacent_duplication_marker"),
    },
    ...(mode === "ere"
      ? [
          {
            reason: "empty_alternative",
            outcome: "undefined_syntax",
            rule: missing("empty_alternative"),
          },
        ]
      : []),
    {
      reason: "missing_bracket_list",
      outcome: "undefined_syntax",
      rule: ($) => $._missing_bracket_list_marker,
    },
    {
      reason: "unclosed_bracket_expression",
      outcome: "undefined_syntax",
      rule: ($) => $._unclosed_bracket_expression_marker,
    },
    {
      reason: "undefined_translation_escape",
      outcome: "undefined_syntax",
      rule: nonportableEscape("_translate_nonportable_escape"),
    },
    {
      reason: "equivalence_class_range_start",
      outcome: "unspecified_syntax",
      rule: ($) => seq($.equivalence_class, $._nonportable_range_start_marker),
    },
    {
      reason: "equivalence_class_range_end",
      outcome: "unspecified_syntax",
      rule: ($) => seq($._nonportable_range_end_marker, $.equivalence_class),
    },
    {
      reason: "ambiguous_bracket_expression",
      outcome: "unspecified_syntax",
      rule: ($) => alias($._ambiguous_bracket_expression, $.bracket_expression),
    },
    {
      reason: "blanks_after_negation",
      outcome: "unspecified_syntax",
      rule: ($) => alias(token.immediate(/[ \t]+/), $.blank),
    },
    {
      reason: "unspecified_replacement_escape",
      outcome: "unspecified_syntax",
      rule: nonportableEscape("_replacement_nonportable_escape"),
    },
    {
      reason: "special_delimiter_escape",
      outcome: "unspecified_syntax",
      rule: ($) =>
        alias($._regex_special_escaped_delimiter, $.escaped_delimiter),
    },
    {
      reason: "replacement_ampersand_delimiter_escape",
      outcome: "unspecified_syntax",
      rule: ($) =>
        alias(
          $._replacement_ampersand_escaped_delimiter,
          $.replacement_escaped_delimiter,
        ),
    },
    {
      reason: "unspecified_text_escape",
      outcome: "unspecified_syntax",
      rule: nonportableEscape("_text_unspecified_escape"),
    },
    ...(mode === "bre"
      ? [
          {
            reason: "bre_vertical_line_escape",
            outcome: "implementation_defined_syntax",
            rule: ($) => $._regex_bre_vertical_line_escape,
          },
          {
            reason: "bre_question_mark_escape",
            outcome: "implementation_defined_syntax",
            rule: ($) => $._regex_bre_question_mark_escape,
          },
          {
            reason: "bre_plus_escape",
            outcome: "implementation_defined_syntax",
            rule: ($) => $._regex_bre_plus_escape,
          },
          {
            reason: "bre_subexpression_left_anchor",
            outcome: "nonconforming_syntax",
            rule: ($) => $._regex_bre_subexpression_caret,
          },
          {
            reason: "bre_subexpression_right_anchor",
            outcome: "nonconforming_syntax",
            rule: ($) => $._regex_bre_subexpression_dollar,
          },
        ]
      : []),
    {
      reason: "omitted_file_separator",
      outcome: "nonconforming_syntax",
      rule: missing("omitted_file_separator"),
    },
    {
      id: "incomplete_omitted_file_separator",
      reason: "omitted_file_separator",
      outcome: "incomplete_syntax",
      rule: missing("incomplete_omitted_file_separator"),
    },
    {
      reason: "excess_address",
      outcome: "nonconforming_syntax",
      rule: ($) => field("address", alias($._max0_address, $.address)),
    },
    ...[0, 1, 2].map((maximum) => ({
      id: `excess_address_unit${maximum}`,
      reason: "excess_address",
      outcome: "nonconforming_syntax",
      rule: ($) =>
        choice(
          seq(
            $._address_separator,
            field("address", alias($[`_max${maximum}_address`], $.address)),
          ),
          seq($._comma_address_separator, omittedAddress($)),
        ),
    })),
    {
      reason: "unknown_function",
      outcome: "nonconforming_syntax",
      rule: ($) =>
        choice(
          token(prec(-2, unknownFunctionCharacter)),
          $._single_nul_character,
        ),
    },
    {
      id: "reserved_unknown_function",
      reason: "unknown_function",
      outcome: "nonconforming_syntax",
      rule: ($) => $._reserved_unknown_function_token,
    },
    {
      reason: "unexpected_command_text",
      outcome: "nonconforming_syntax",
      rule: ($) =>
        seq(
          choice($._unexpected_command_text, issueField($, "nul_character")),
          repeat(
            choice(
              $._unexpected_command_text,
              invalidCharacterIssue($, "nul_character"),
            ),
          ),
        ),
    },
    {
      reason: "forbidden_command_separator",
      outcome: "nonconforming_syntax",
      rule: ($) => alias(token.immediate(";"), $.command_separator),
    },
    {
      id: "incomplete_command_text",
      reason: "unexpected_command_text",
      outcome: "incomplete_syntax",
      rule: ($) => $._incomplete_command_text,
    },
    {
      reason: "blanks_around_address_separator",
      outcome: "nonconforming_syntax",
      rule: ($) => alias($._blanks_around_address_separator, $.blank),
    },
    {
      reason: "missing_address_separator",
      outcome: "nonconforming_syntax",
      rule: missing("missing_address_separator"),
    },
    {
      reason: "duplicate_negation",
      outcome: "nonconforming_syntax",
      rule: ($) => field("operator", alias("!", $.negation_operator)),
    },
    {
      reason: "unmatched_closing_brace",
      outcome: "nonconforming_syntax",
      rule: ($) => $.closing_brace,
    },
    {
      reason: "missing_command_separator",
      outcome: "nonconforming_syntax",
      rule: missing("missing_command_separator"),
    },
    {
      id: "missing_separator_before_unmatched_brace",
      reason: "missing_command_separator",
      outcome: "nonconforming_syntax",
      rule: missing("missing_separator_before_unmatched_brace"),
    },
    {
      id: "missing_separator_after_unmatched_brace",
      reason: "missing_command_separator",
      outcome: "nonconforming_syntax",
      rule: missing("missing_separator_after_unmatched_brace"),
    },
    {
      id: "undefined_write_command_separator",
      reason: "forbidden_command_separator",
      outcome: "undefined_syntax",
      rule: ($) => alias($._write_following_separator, $.command_separator),
    },
    {
      reason: "nonfinal_write_flag",
      outcome: "undefined_syntax",
      rule: ($) =>
        seq(
          field("verb", alias("w", $.substitution_flag)),
          $._flag_after_write_marker,
        ),
    },
    {
      id: "conflicting_global_flag",
      reason: "conflicting_substitution_flag",
      outcome: "unspecified_syntax",
      rule: ($) => alias("g", $.global_flag),
    },
    {
      id: "conflicting_occurrence_flag",
      reason: "conflicting_substitution_flag",
      outcome: "unspecified_syntax",
      rule: ($) => $.occurrence_flag,
    },
    {
      reason: "invalid_substitution_flag",
      outcome: "nonconforming_syntax",
      rule: ($) => $._invalid_substitution_flag,
    },
    {
      reason: "invalid_delimiter",
      outcome: "nonconforming_syntax",
      rule: ($) => choice(token(/\\/), $._single_nul_character),
    },
    {
      reason: "unterminated_regular_expression",
      outcome: "nonconforming_syntax",
      rule: ($) =>
        choice(
          $._regex_line_unterminated_address,
          $._regex_line_unterminated_substitute,
        ),
    },
    {
      reason: "forbidden_regular_expression_newline",
      outcome: "nonconforming_syntax",
      rule: ($) => $._regex_forbidden_newline_escape,
    },
    {
      reason: "unterminated_replacement",
      outcome: "nonconforming_syntax",
      rule: ($) => $._replacement_line_unterminated,
    },
    {
      reason: "unterminated_translation",
      outcome: "nonconforming_syntax",
      rule: ($) =>
        choice(
          $._translate_line_unterminated_source,
          $._translate_line_unterminated_destination,
        ),
    },
    ...boundaryMissingReasons.map((reason) => ({
      id: `nonconforming_${reason}`,
      reason,
      outcome: "nonconforming_syntax",
      rule: missing(`nonconforming_${reason}`),
    })),
    ...missingCommandDefinitions.map(({ reason, rule }) => ({
      reason,
      outcome: "incomplete_syntax",
      rule: rule ?? missing(reason),
    })),
    {
      id: "incomplete_unclosed_subexpression",
      reason: "unclosed_subexpression",
      outcome: "incomplete_syntax",
      rule: ($) => $._regex_incomplete_group,
    },
    {
      id: "incomplete_bracket_term",
      reason: "missing_bracket_term_close",
      outcome: "incomplete_syntax",
      rule: ($) => $._regex_incomplete_bracket_term,
    },
    {
      id: "incomplete_missing_bracket_list",
      reason: "missing_bracket_list",
      outcome: "incomplete_syntax",
      rule: ($) => $._incomplete_bracket_list_marker,
    },
    {
      id: "incomplete_unclosed_bracket_expression",
      reason: "unclosed_bracket_expression",
      outcome: "incomplete_syntax",
      rule: ($) => $._incomplete_bracket_expression_marker,
    },
    ...(mode === "ere"
      ? [
          {
            id: "incomplete_alternative",
            reason: "empty_alternative",
            outcome: "incomplete_syntax",
            rule: ($) => $._incomplete_alternative_marker,
          },
        ]
      : []),
    {
      id: "incomplete_interval",
      reason: "missing_interval_close",
      outcome: "incomplete_syntax",
      rule: ($) => $._regex_incomplete_interval,
    },
    {
      id: "incomplete_missing_command_separator",
      reason: "missing_command_separator",
      outcome: "incomplete_syntax",
      rule: ($) => $._incomplete_command_separator_marker,
    },
    {
      id: "incomplete_regular_expression",
      reason: "unterminated_regular_expression",
      outcome: "incomplete_syntax",
      rule: ($) =>
        choice($._regex_unterminated_address, $._regex_unterminated_substitute),
    },
    {
      reason: "incomplete_regular_expression_escape",
      outcome: "incomplete_syntax",
      rule: ($) => $._regex_incomplete_escape,
    },
    {
      id: "incomplete_replacement",
      reason: "unterminated_replacement",
      outcome: "incomplete_syntax",
      rule: ($) => $._replacement_unterminated,
    },
    {
      reason: "incomplete_replacement_escape",
      outcome: "incomplete_syntax",
      rule: ($) => $._replacement_incomplete_escape,
    },
    {
      id: "incomplete_translation",
      reason: "unterminated_translation",
      outcome: "incomplete_syntax",
      rule: ($) =>
        choice(
          $._translate_unterminated_source,
          $._translate_unterminated_destination,
        ),
    },
    {
      reason: "incomplete_translation_escape",
      outcome: "incomplete_syntax",
      rule: ($) => $._translate_incomplete_escape,
    },
  ];
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
    "invalid_character",
    "nul_character",
    "single_nul_character",
    "regex_beginning_anchor",
    "regex_end_anchor",
    "regex_period",
    "regex_quoted_escape",
    "escape_prefix",
    "regex_newline_escape",
    "regex_escaped_delimiter",
    "regex_special_escaped_delimiter",
    "regex_group_open",
    "regex_group_close",
    "regex_unclosed_group",
    ...(mode === "bre"
      ? [
          "regex_unmatched_group_close",
          "regex_bre_vertical_line_escape",
          "regex_bre_question_mark_escape",
          "regex_bre_plus_escape",
          "regex_bre_subexpression_caret",
          "regex_bre_subexpression_dollar",
          "regex_unmatched_interval_close",
        ]
      : []),
    ...(mode === "ere" ? ["regex_alternation_operator"] : []),
    "regex_leading_duplication_marker",
    "regex_adjacent_duplication_marker",
    "regex_zero_or_more",
    ...(mode === "ere"
      ? ["regex_one_or_more", "regex_zero_or_one", "regex_repetition_modifier"]
      : []),
    "regex_interval_open",
    "regex_dup_count",
    "regex_interval_escaped_count",
    "regex_interval_escaped_separator",
    "regex_interval_separator",
    "regex_interval_close",
    ...(mode === "bre" ? ["regex_backreference"] : []),
    "regex_invalid_interval",
    "regex_missing_interval_minimum",
    "regex_incomplete_interval_minimum",
    "regex_missing_interval_close",
    ...(mode === "bre"
      ? ["regex_invalid_interval_close", "regex_incomplete_interval_close"]
      : []),
    "regex_nonportable_escape",
    "regex_incomplete_escape",
    "regex_bracket_open",
    "regex_bracket_close",
    "regex_bracket_literal",
    "regex_bracket_negation",
    "regex_bracket_hyphen",
    "regex_bracket_range_end_hyphen",
    "regex_bracket_trailing_hyphen",
    "regex_open_colon",
    "regex_class_name",
    "regex_invalid_class_name",
    "regex_colon_close",
    "regex_open_dot",
    "regex_coll_elem_single",
    "regex_coll_elem_multi",
    "regex_meta_char",
    "regex_incomplete_meta_char",
    "regex_dot_close",
    "regex_open_equal",
    "regex_equal_close",
    "regex_missing_bracket_term_close",
    "regex_missing_bracket_term_payload",
    "regex_incomplete_bracket_term_payload",
    "regex_shared_range_endpoint",
    "ambiguous_bracket_expression_marker",
    "missing_bracket_list_marker",
    "unclosed_bracket_expression_marker",
    "nonportable_range_start_marker",
    "nonportable_range_end_marker",
    "regex_unterminated_address",
    "regex_unterminated_substitute",
    "replacement_literal",
    "replacement_match_reference",
    "replacement_backreference",
    "replacement_escaped_delimiter",
    "replacement_ampersand_escaped_delimiter",
    "replacement_escape_sequence",
    "replacement_nonportable_escape",
    "replacement_escaped_newline",
    "replacement_incomplete_escape",
    "replacement_unterminated",
    "translate_literal",
    "translate_escaped_delimiter",
    "translate_escape",
    "translate_nonportable_escape",
    "translate_incomplete_escape",
    "translate_unterminated_source",
    "translate_unterminated_destination",
    "invalid_substitution_flag",
    "flag_after_write_marker",
    "write_terminal_separator",
    "write_block_terminal_separator",
    "write_following_separator",
    "text_command_start",
    "text_incomplete_introducer",
    "text_literal",
    "text_backslash_escape",
    "text_escaped_newline",
    "text_unspecified_escape",
    "text_line_end",
    "text_eof",
    "default_output_suppression",
    "comment_text",
    "file_argument",
    "substitution_wfile_argument",
    "substitution_wfile_continuation",
    "line_word",
    "label_start",
    "long_label_start",
    "label_literal",
    "nonportable_label_character",
    "argument_separator",
    "brace_leading_blanks",
    "block_trailing_blanks",
    "empty_command_marker",
    "reserved_unknown_function_token",
    "regex_incomplete_group",
    "regex_incomplete_bracket_term",
    "regex_incomplete_interval",
    "regex_forbidden_newline_escape",
    "regex_line_unterminated_address",
    "regex_line_unterminated_substitute",
    "replacement_line_unterminated",
    "translate_line_unterminated_source",
    "translate_line_unterminated_destination",
    "blanks_around_address_separator",
    ...missingMarkerNames(mode).map((name) => `${name}_marker`),
    "unexpected_command_text",
    "incomplete_command_text",
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
      [$._command_unit, $._command_item],
      [$.address_clause, $._max1_address_clause],
      [$._double_address_clause, $._excess_address_unit1_reason],
      [$.address, $._max0_address],
      [$.address, $._max1_address],
      [
        $._omitted_first_address_reason,
        $._omitted_first_address_unit0_reason,
        $._omitted_first_address_unit1_reason,
      ],
      [
        $._omitted_first_address_unit0_reason,
        $._omitted_first_address_unit1_reason,
      ],
    ],
  };
  const rules = sedRules(mode);
  const issues = defineIssueRules(issueDefinitions(mode));
  return mode === "bre"
    ? grammar({ ...options, rules: { ...rules, ...breRules(), ...issues } })
    : grammar({ ...options, rules: { ...rules, ...ereRules(), ...issues } });
}

export default defineGrammar;
