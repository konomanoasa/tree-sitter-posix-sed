use konomanoasa_tree_sitter_posix_sed as grammar;
use std::ops::ControlFlow;
use tree_sitter::{
  InputEdit, Language, ParseOptions, ParseState, Parser, Point, Query, Range,
  Tree,
};

fn issue_signatures(tree: &Tree) -> Vec<(String, String, Range)> {
  let mut issues = Vec::new();
  let mut nodes = vec![tree.root_node()];
  while let Some(node) = nodes.pop() {
    if node.kind() == "syntax_issue" {
      let outcome = node.named_child(0).unwrap();
      let reason = outcome.named_child(0).unwrap();
      issues.push((
        outcome.kind().to_owned(),
        reason.kind().to_owned(),
        node.range(),
      ));
    }
    for index in (0..node.named_child_count()).rev() {
      nodes.push(node.named_child(index as u32).unwrap());
    }
  }
  issues
}

fn fielded_nodes(
  tree: &Tree,
) -> Vec<(Option<&str>, &str, std::ops::Range<usize>)> {
  let mut nodes = Vec::new();
  let mut cursor = tree.walk();
  'walk: loop {
    let node = cursor.node();
    nodes.push((cursor.field_name(), node.kind(), node.byte_range()));
    if cursor.goto_first_child() {
      continue;
    }
    while !cursor.goto_next_sibling() {
      if !cursor.goto_parent() {
        break 'walk;
      }
    }
  }
  nodes
}

fn assert_invalid_encoding_leaves(
  tree: &Tree,
  expected: &[Range],
  context: &str,
) {
  let mut ranges = Vec::new();
  let mut nodes = vec![tree.root_node()];
  while let Some(node) = nodes.pop() {
    if node.kind() == "invalid_encoding" {
      assert_eq!(node.child_count(), 0, "{context}");
      ranges.push(node.range());
    } else if node.child_count() == 0 {
      for range in expected {
        assert!(
          node.end_byte() <= range.start_byte
            || node.start_byte() >= range.end_byte,
          "{context}: {} must not own undecodable source",
          node.kind()
        );
      }
    }
    for index in (0..node.child_count()).rev() {
      nodes.push(node.child(index).unwrap());
    }
  }
  assert_eq!(ranges, expected, "{context}");
}

#[test]
fn parses_valid_source() {
  for (language, node_types, highlights, source, root_kind) in [
    (
      grammar::LANGUAGE,
      grammar::NODE_TYPES,
      grammar::HIGHLIGHTS_QUERY,
      "p\n",
      "script",
    ),
    (
      grammar::LANGUAGE_ERE,
      grammar::NODE_TYPES_ERE,
      grammar::HIGHLIGHTS_QUERY_ERE,
      "p\n",
      "script",
    ),
  ] {
    let language = language.into();
    let mut parser = Parser::new();
    parser.set_language(&language).unwrap();
    let tree = parser.parse(source, None).unwrap();
    let root = tree.root_node();
    assert_eq!(root.kind(), root_kind, "{source}");
    assert_eq!(root.byte_range(), 0..source.len(), "{source}");
    assert!(!root.has_error(), "{source}");
    assert!(node_types.contains(&format!("\"{root_kind}\"")), "{source}");
    Query::new(&language, highlights).unwrap();
  }
}

#[test]
fn repeated_regex_groups_keep_fields_on_their_direct_children() {
  for (language, source, group_kind, expected) in [
    (
      grammar::LANGUAGE,
      r"/\(\)\(a\)\{2,3\}/p",
      "nondupl_bre",
      vec![
        ("opening", 1..3),
        ("closing", 3..5),
        ("opening", 5..7),
        ("expression", 7..8),
        ("closing", 8..10),
      ],
    ),
    (
      grammar::LANGUAGE_ERE,
      "/()(a){2,3}?/p",
      "ere_expression",
      vec![
        ("opening", 1..2),
        ("closing", 2..3),
        ("opening", 3..4),
        ("expression", 4..5),
        ("closing", 5..6),
      ],
    ),
  ] {
    let mut parser = Parser::new();
    parser.set_language(&language.into()).unwrap();
    let tree = parser.parse(source, None).unwrap();
    assert!(!tree.root_node().has_error(), "{source}");
    assert!(issue_signatures(&tree).is_empty(), "{source}");
    let mut nodes = vec![tree.root_node()];
    let mut fields = Vec::new();
    while let Some(node) = nodes.pop() {
      if node.kind() == group_kind {
        for field in ["opening", "expression", "closing"] {
          if let Some(child) = node.child_by_field_name(field) {
            assert_eq!(child.parent(), Some(node), "{source}");
            fields.push((field, child.byte_range()));
          }
        }
      }
      for index in (0..node.named_child_count()).rev() {
        nodes.push(node.named_child(index as u32).unwrap());
      }
    }
    assert_eq!(fields, expected, "{source}");
  }
}

#[test]
fn uses_distinct_grammars() {
  let sed = Language::new(grammar::LANGUAGE);
  let posix_sed_ere = Language::new(grammar::LANGUAGE_ERE);
  assert_ne!(sed, posix_sed_ere);
}

#[test]
fn invalid_byte_issues_preserve_classification_and_ranges_through_edits() {
  for (language, mode) in
    [(grammar::LANGUAGE, "BRE"), (grammar::LANGUAGE_ERE, "ERE")]
  {
    let mut parser = Parser::new();
    parser.set_language(&language.into()).unwrap();
    for (name, source, start, end, row, column, reason) in [
      (
        "first function",
        &b"p\nq\n"[..],
        0,
        1,
        0,
        0,
        "unknown_function",
      ),
      (
        "function after newline",
        &b"p\np\nq\n"[..],
        2,
        3,
        1,
        0,
        "unknown_function",
      ),
      (
        "substitute delimiter",
        &b"p\ns///\nq\n"[..],
        3,
        6,
        1,
        1,
        "invalid_delimiter",
      ),
      (
        "translate delimiter",
        &b"p\ny///\nq\n"[..],
        3,
        6,
        1,
        1,
        "invalid_delimiter",
      ),
      (
        "address delimiter",
        &b"p\n\\##p\nq\n"[..],
        3,
        5,
        1,
        1,
        "invalid_delimiter",
      ),
      (
        "trailing command text",
        &b"p\np\nq\n"[..],
        3,
        3,
        1,
        1,
        "unexpected_command_text",
      ),
      (
        "substitution flag",
        &b"p\ns/a/b/g\nq\n"[..],
        8,
        9,
        1,
        6,
        "invalid_substitution_flag",
      ),
    ] {
      for invalid_byte in [0, 0xff] {
        let mut damaged = source.to_vec();
        damaged.splice(start..end, [invalid_byte]);
        let mut tree = parser.parse(source, None).unwrap();
        assert!(!tree.root_node().has_error(), "{mode}, {name}");
        assert!(issue_signatures(&tree).is_empty(), "{mode}, {name}");
        for damage in [true, false, true] {
          let (next, old_length, new_length) = if damage {
            (damaged.as_slice(), end - start, 1)
          } else {
            (source, 1, end - start)
          };
          tree.edit(&InputEdit {
            start_byte: start,
            old_end_byte: start + old_length,
            new_end_byte: start + new_length,
            start_position: Point::new(row, column),
            old_end_position: Point::new(row, column + old_length),
            new_end_position: Point::new(row, column + new_length),
          });
          let incremental = parser.parse(next, Some(&tree)).unwrap();
          let fresh = parser.parse(next, None).unwrap();
          let mut expected = Vec::new();
          if damage {
            let range = Range {
              start_byte: start,
              end_byte: start + 1,
              start_point: Point::new(row, column),
              end_point: Point::new(row, column + 1),
            };
            if invalid_byte == 0 {
              expected.push((
                "nonconforming_syntax".to_owned(),
                reason.to_owned(),
                range,
              ));
            }
            if invalid_byte == 0 && reason == "unexpected_command_text" {
              expected.push((
                "nonconforming_syntax".to_owned(),
                "nul_character".to_owned(),
                range,
              ));
            } else if invalid_byte == 0xff {
              expected.push((
                "invalid_syntax".to_owned(),
                "invalid_encoding".to_owned(),
                range,
              ));
            }
          }
          let context =
            format!("{mode}, {name}, byte {invalid_byte:#x}, damage {damage}");
          assert_eq!(issue_signatures(&fresh), expected, "fresh: {context}");
          assert_eq!(
            issue_signatures(&incremental),
            expected,
            "incremental: {context}"
          );
          if damage && invalid_byte == 0xff {
            let range = expected.last().unwrap().2;
            for parsed in [&fresh, &incremental] {
              assert_invalid_encoding_leaves(parsed, &[range], &context);
            }
          }
          if !damage {
            assert!(!incremental.root_node().has_error(), "{context}");
            assert_eq!(
              incremental.root_node().to_sexp(),
              fresh.root_node().to_sexp(),
              "{context}"
            );
          }
          tree = incremental;
        }
      }
    }
  }
}

#[test]
fn invalid_bytes_inside_intervals_and_escapes_remain_visible_through_edits() {
  for (language, mode, interval, count_start) in [
    (grammar::LANGUAGE, "BRE", &b"/a\\{1,2\\}/p\n"[..], 6),
    (grammar::LANGUAGE_ERE, "ERE", &b"/a{1,2}/p\n"[..], 5),
  ] {
    let mut parser = Parser::new();
    parser.set_language(&language.into()).unwrap();
    for (name, source, start, prefix, reasons) in [
      (
        "malformed interval",
        interval,
        count_start,
        &b"x"[..],
        &[
          ("undefined_syntax", "invalid_interval_character", 0, 1),
          (
            "invalid_syntax",
            "invalid_regular_expression_character",
            1,
            2,
          ),
        ][..],
      ),
      (
        "escaped invalid character",
        &b"/\\*/p\n"[..],
        2,
        &b""[..],
        &[(
          "invalid_syntax",
          "invalid_regular_expression_character",
          0,
          1,
        )][..],
      ),
    ] {
      for invalid_byte in [0, 0xff] {
        let replacement = [prefix, &[invalid_byte]].concat();
        let mut damaged = source.to_vec();
        damaged.splice(start..start + 1, replacement.iter().copied());
        let expected: Vec<_> = reasons
          .iter()
          .map(|&(outcome, reason, first, last)| {
            (
              outcome.to_owned(),
              if invalid_byte == 0xff
                && reason == "invalid_regular_expression_character"
              {
                "invalid_encoding".to_owned()
              } else {
                reason.to_owned()
              },
              Range {
                start_byte: start + first,
                end_byte: start + last,
                start_point: Point::new(0, start + first),
                end_point: Point::new(0, start + last),
              },
            )
          })
          .collect();
        let mut tree = parser.parse(source, None).unwrap();
        for damage in [true, false, true] {
          let (next, old_length, new_length) = if damage {
            (damaged.as_slice(), 1, replacement.len())
          } else {
            (source, replacement.len(), 1)
          };
          tree.edit(&InputEdit {
            start_byte: start,
            old_end_byte: start + old_length,
            new_end_byte: start + new_length,
            start_position: Point::new(0, start),
            old_end_position: Point::new(0, start + old_length),
            new_end_position: Point::new(0, start + new_length),
          });
          let incremental = parser.parse(next, Some(&tree)).unwrap();
          let fresh = parser.parse(next, None).unwrap();
          let wanted = if damage { expected.as_slice() } else { &[] };
          let context =
            format!("{mode}, {name}, byte {invalid_byte:#x}, damage {damage}");
          for parsed in [&fresh, &incremental] {
            assert_eq!(issue_signatures(parsed), wanted, "{context}");
            if damage && invalid_byte == 0xff {
              let range = expected.last().unwrap().2;
              assert_invalid_encoding_leaves(parsed, &[range], &context);
            }
            if damage && name == "malformed interval" {
              let mut nodes = vec![parsed.root_node()];
              let mut owners = Vec::new();
              while let Some(node) = nodes.pop() {
                if node.kind() == "syntax_issue" {
                  owners.push(node.parent().unwrap().kind());
                }
                for index in 0..node.named_child_count() {
                  nodes.push(node.named_child(index as u32).unwrap());
                }
              }
              let owner = if mode == "BRE" {
                "bre_dupl_symbol"
              } else {
                "ere_dupl_symbol"
              };
              assert_eq!(
                owners,
                [owner, owner],
                "{context}: interval faults must be siblings"
              );
            }
          }
          if !damage {
            assert!(!incremental.root_node().has_error(), "{context}");
            assert_eq!(
              incremental.root_node().to_sexp(),
              fresh.root_node().to_sexp(),
              "{context}"
            );
          }
          tree = incremental;
        }
      }
    }
  }
}

#[test]
fn decoding_issues_split_operands_and_escapes_and_disappear_after_repair() {
  for (language, mode) in
    [(grammar::LANGUAGE, "BRE"), (grammar::LANGUAGE_ERE, "ERE")]
  {
    let mut parser = Parser::new();
    parser.set_language(&language.into()).unwrap();
    for (name, source, start, row, column, normal_nodes, allow_replacement) in [
      (
        "initial comment text",
        &b"#xn\np\n"[..],
        1,
        0,
        1,
        ("comment_text", None),
        true,
      ),
      (
        "label definition",
        &b":axb\np\n"[..],
        2,
        0,
        2,
        ("label_literal", Some("label")),
        true,
      ),
      (
        "branch label",
        &b"b axb\np\n"[..],
        3,
        0,
        3,
        ("label_literal", Some("label")),
        true,
      ),
      (
        "test label",
        &b"t axb\np\n"[..],
        3,
        0,
        3,
        ("label_literal", Some("label")),
        true,
      ),
      (
        "rfile",
        &b"r axb\np\n"[..],
        3,
        0,
        3,
        ("file_literal", Some("rfile")),
        true,
      ),
      (
        "wfile",
        &b"w axb\np\n"[..],
        3,
        0,
        3,
        ("file_literal", Some("wfile")),
        true,
      ),
      (
        "substitution wfile",
        &b"s/a/b/w axb\np\n"[..],
        9,
        0,
        9,
        ("file_literal", Some("wfile")),
        true,
      ),
      (
        "text",
        &b"a\\\naxb\np\n"[..],
        4,
        1,
        1,
        ("text_literal", None),
        true,
      ),
      (
        "replacement",
        &b"s/a/axb/\np\n"[..],
        5,
        0,
        5,
        ("replacement_literal", None),
        true,
      ),
      (
        "translation source",
        &b"y/axb/abc/\np\n"[..],
        3,
        0,
        3,
        ("translation_literal", None),
        true,
      ),
      (
        "translation destination",
        &b"y/abc/axb/\np\n"[..],
        7,
        0,
        7,
        ("translation_literal", None),
        true,
      ),
      (
        "text escape",
        &b"a\\\na\\\\b\np\n"[..],
        5,
        1,
        2,
        ("text_escape", None),
        false,
      ),
      (
        "replacement escape",
        &b"s/a/a\\\\b/\np\n"[..],
        6,
        0,
        6,
        ("replacement_escape", None),
        false,
      ),
      (
        "translation source escape",
        &b"y/a\\\\b/abc/\np\n"[..],
        4,
        0,
        4,
        ("translation_escape", None),
        false,
      ),
      (
        "translation destination escape",
        &b"y/abc/a\\\\b/\np\n"[..],
        8,
        0,
        8,
        ("translation_escape", None),
        false,
      ),
      (
        "ordinary regex character",
        &b"/axb/p\n"[..],
        2,
        0,
        2,
        ("ordinary_character", None),
        true,
      ),
      (
        "bracket element",
        &b"/[axb]/p\n"[..],
        3,
        0,
        3,
        ("collating_element_single", None),
        true,
      ),
      (
        "collating symbol",
        &b"/[[.axb.]]/p\n"[..],
        5,
        0,
        5,
        ("collating_element_multi", None),
        true,
      ),
      (
        "equivalence class",
        &b"/[[=axb=]]/p\n"[..],
        5,
        0,
        5,
        ("collating_element_multi", None),
        true,
      ),
      (
        "character class name",
        &b"/[[:axb:]]/p\n"[..],
        5,
        0,
        5,
        ("class_name", None),
        false,
      ),
    ] {
      let (normal_kind, owner_kind) = normal_nodes;
      let mut invalid_inputs = vec![
        (
          &b"\xff"[..],
          &[("invalid_syntax", "invalid_encoding", 0, 1)][..],
        ),
        (
          &b"\xff\xfe"[..],
          &[("invalid_syntax", "invalid_encoding", 0, 2)][..],
        ),
      ];
      if owner_kind.is_some() {
        invalid_inputs.extend([
          (
            &b"\0"[..],
            &[("nonconforming_syntax", "nul_character", 0, 1)][..],
          ),
          (
            &b"\xff\0\xfe"[..],
            &[
              ("invalid_syntax", "invalid_encoding", 0, 1),
              ("nonconforming_syntax", "nul_character", 1, 2),
              ("invalid_syntax", "invalid_encoding", 2, 3),
            ][..],
          ),
        ]);
      }
      for (invalid, faults) in invalid_inputs {
        let mut tree = parser.parse(source, None).unwrap();
        assert!(!tree.root_node().has_error(), "{mode}, {name}");
        assert!(issue_signatures(&tree).is_empty(), "{mode}, {name}");
        let mut old_length = 1;
        let mut replacements = vec![invalid];
        if owner_kind.is_some() {
          replacements.push(&b""[..]);
        }
        replacements.push(&source[start..start + 1]);
        if allow_replacement {
          replacements.push("\u{fffd}".as_bytes());
        }
        for (step, replacement) in replacements.into_iter().enumerate() {
          let mut next = source.to_vec();
          next.splice(start..start + 1, replacement.iter().copied());
          tree.edit(&InputEdit {
            start_byte: start,
            old_end_byte: start + old_length,
            new_end_byte: start + replacement.len(),
            start_position: Point::new(row, column),
            old_end_position: Point::new(row, column + old_length),
            new_end_position: Point::new(row, column + replacement.len()),
          });
          let incremental = parser.parse(&next, Some(&tree)).unwrap();
          let fresh = parser.parse(&next, None).unwrap();
          let expected: Vec<_> = if step == 0 {
            faults
              .iter()
              .map(|&(outcome, reason, first, last)| {
                (
                  outcome.to_owned(),
                  reason.to_owned(),
                  Range {
                    start_byte: start + first,
                    end_byte: start + last,
                    start_point: Point::new(row, column + first),
                    end_point: Point::new(row, column + last),
                  },
                )
              })
              .collect()
          } else {
            Vec::new()
          };
          let ranges: Vec<_> =
            expected.iter().map(|(_, _, range)| *range).collect();
          let encoding_ranges: Vec<_> = expected
            .iter()
            .filter(|(_, reason, _)| reason == "invalid_encoding")
            .map(|(_, _, range)| *range)
            .collect();
          let context =
            format!("{mode}, {name}, invalid {invalid:?}, step {step}");
          for parsed in [&fresh, &incremental] {
            assert!(!parsed.root_node().has_error(), "{context}");
            assert_eq!(issue_signatures(parsed), expected, "{context}");
            assert_invalid_encoding_leaves(parsed, &encoding_ranges, &context);
            let mut nodes = vec![parsed.root_node()];
            let mut repaired_leaf = false;
            let mut owners = 0;
            while let Some(node) = nodes.pop() {
              if Some(node.kind()) == owner_kind {
                owners += 1;
                let owner_range = Range {
                  start_byte: start - 1,
                  end_byte: start + replacement.len() + 1,
                  start_point: Point::new(row, column - 1),
                  end_point: Point::new(row, column + replacement.len() + 1),
                };
                assert_eq!(node.range(), owner_range, "{context}");
                let expected_children = if !ranges.is_empty() {
                  let mut children = vec![(
                    normal_kind,
                    Range {
                      end_byte: start,
                      end_point: Point::new(row, column),
                      ..owner_range
                    },
                  )];
                  children.extend(
                    ranges.iter().map(|range| ("syntax_issue", *range)),
                  );
                  children.push((
                    normal_kind,
                    Range {
                      start_byte: start + replacement.len(),
                      start_point: Point::new(row, column + replacement.len()),
                      ..owner_range
                    },
                  ));
                  children
                } else {
                  vec![(normal_kind, owner_range)]
                };
                let children: Vec<_> = (0..node.child_count())
                  .map(|index| {
                    let child = node.child(index).unwrap();
                    assert!(child.is_named(), "{context}");
                    if child.kind() == normal_kind {
                      assert_eq!(child.child_count(), 0, "{context}");
                    }
                    (child.kind(), child.range())
                  })
                  .collect();
                assert_eq!(children, expected_children, "{context}");
              }
              if name == "initial comment text" {
                assert_ne!(
                  node.kind(),
                  "default_output_suppression",
                  "{context}"
                );
              }
              if step > 0
                && node.kind() == normal_kind
                && node.child_count() == 0
                && node.start_byte() <= start
                && node.end_byte() >= start + replacement.len()
              {
                repaired_leaf = true;
              }
              for index in 0..node.child_count() {
                nodes.push(node.child(index).unwrap());
              }
            }
            if step > 0 {
              assert!(repaired_leaf, "{context}: normal leaf must return");
            }
            if owner_kind.is_some() {
              assert_eq!(owners, 1, "{context}: operand must have one owner");
            }
          }
          assert_eq!(
            incremental.root_node().to_sexp(),
            fresh.root_node().to_sexp(),
            "{context}"
          );
          tree = incremental;
          old_length = replacement.len();
        }
      }
    }
  }
}

#[test]
fn literal_ranges_remain_stable_when_edits_split_multibyte_delimiters() {
  for (language, mode) in
    [(grammar::LANGUAGE, "BRE"), (grammar::LANGUAGE_ERE, "ERE")]
  {
    let mut parser = Parser::new();
    parser.set_language(&language.into()).unwrap();
    for (source, edited, positions, literal, expected) in [
      (
        "séaébé",
        "séaébèé",
        [8, 9, 11],
        "replacement_literal",
        &[(6, 9)][..],
      ),
      (
        "yéaébé",
        "yéaébèé",
        [8, 9, 11],
        "translation_literal",
        &[(3, 4), (6, 9)][..],
      ),
      (
        "s🙂a🙂b🙂",
        "s🙂a🙂b🙁🙂",
        [14, 15, 19],
        "replacement_literal",
        &[(10, 15)][..],
      ),
      (
        "y🙂a🙂b🙂",
        "y🙂a🙂b🙁🙂",
        [14, 15, 19],
        "translation_literal",
        &[(5, 6), (10, 15)][..],
      ),
    ] {
      let [start, old_end, new_end] = positions;
      assert_eq!(&source.as_bytes()[..start], &edited.as_bytes()[..start]);
      assert_eq!(&source.as_bytes()[old_end..], &edited.as_bytes()[new_end..]);
      let mut tree = parser.parse(source, None).unwrap();
      assert!(!tree.root_node().has_error());
      assert!(issue_signatures(&tree).is_empty());
      tree.edit(&InputEdit {
        start_byte: start,
        old_end_byte: old_end,
        new_end_byte: new_end,
        start_position: Point::new(0, start),
        old_end_position: Point::new(0, old_end),
        new_end_position: Point::new(0, new_end),
      });
      let incremental = parser.parse(edited, Some(&tree)).unwrap();
      let fresh = parser.parse(edited, None).unwrap();
      for (parse_kind, parsed) in
        [("fresh", &fresh), ("incremental", &incremental)]
      {
        let context = format!("{mode}, {parse_kind}, {source:?} -> {edited:?}");
        assert!(!parsed.root_node().has_error(), "{context}");
        assert!(issue_signatures(parsed).is_empty(), "{context}");
        let mut ranges = Vec::new();
        let mut nodes = vec![parsed.root_node()];
        while let Some(node) = nodes.pop() {
          if node.kind() == literal {
            ranges.push((node.start_byte(), node.end_byte()));
            assert_eq!(node.start_position(), Point::new(0, node.start_byte()));
            assert_eq!(node.end_position(), Point::new(0, node.end_byte()));
          }
          for index in (0..node.named_child_count()).rev() {
            nodes.push(node.named_child(index as u32).unwrap());
          }
        }
        assert_eq!(ranges, expected, "{context}");
      }
    }
  }
}

#[test]
fn completed_groups_replace_recovery_after_multibyte_delimiter_edits() {
  for (language, source, edited, edit_start, group_kind, boundaries) in [
    (
      grammar::LANGUAGE,
      r"sé\(é",
      r"sé\(è\)éé",
      6,
      "nondupl_bre",
      [3, 5, 7, 9],
    ),
    (
      grammar::LANGUAGE_ERE,
      "sé(é",
      "sé(è)éé",
      5,
      "ere_expression",
      [3, 4, 6, 7],
    ),
    (
      grammar::LANGUAGE,
      r"s🙂\(🙂",
      r"s🙂\(🙁\)🙂🙂",
      10,
      "nondupl_bre",
      [5, 7, 11, 13],
    ),
    (
      grammar::LANGUAGE_ERE,
      "s🙂(🙂",
      "s🙂(🙁)🙂🙂",
      9,
      "ere_expression",
      [5, 6, 10, 11],
    ),
  ] {
    let mut parser = Parser::new();
    parser.set_language(&language.into()).unwrap();
    let mut tree = parser.parse(source, None).unwrap();
    assert!(!issue_signatures(&tree).is_empty());
    assert_eq!(
      &source.as_bytes()[..edit_start],
      &edited.as_bytes()[..edit_start]
    );
    tree.edit(&InputEdit {
      start_byte: edit_start,
      old_end_byte: source.len(),
      new_end_byte: edited.len(),
      start_position: Point::new(0, edit_start),
      old_end_position: Point::new(0, source.len()),
      new_end_position: Point::new(0, edited.len()),
    });
    let incremental = parser.parse(edited, Some(&tree)).unwrap();
    let fresh = parser.parse(edited, None).unwrap();
    for (kind, parsed) in [("fresh", &fresh), ("incremental", &incremental)] {
      let context = format!("{kind}: {source:?} -> {edited:?}");
      assert!(!parsed.root_node().has_error(), "{context}");
      assert!(issue_signatures(parsed).is_empty(), "{context}");
      let mut nodes = vec![parsed.root_node()];
      let mut groups = Vec::new();
      while let Some(node) = nodes.pop() {
        if node.kind() == group_kind
          && node.child_by_field_name("opening").is_some()
        {
          groups.push(node);
        }
        for index in (0..node.named_child_count()).rev() {
          nodes.push(node.named_child(index as u32).unwrap());
        }
      }
      assert_eq!(groups.len(), 1, "{context}");
      let [start, content, closing, end] = boundaries;
      let group = groups[0];
      assert_eq!(group.byte_range(), start..end, "{context}");
      for (field, range) in [
        ("opening", start..content),
        ("expression", content..closing),
        ("closing", closing..end),
      ] {
        let child = group.child_by_field_name(field).unwrap();
        assert_eq!(child.byte_range(), range, "{field}: {context}");
        assert_eq!(child.start_position(), Point::new(0, range.start));
        assert_eq!(child.end_position(), Point::new(0, range.end));
      }
    }
    assert_eq!(
      incremental.root_node().to_sexp(),
      fresh.root_node().to_sexp()
    );
  }
}

#[test]
fn balanced_regex_groups_preserve_depth_across_the_16_bit_boundary() {
  for (language, mode, opening, closing, opening_kind, closing_kind) in [
    (grammar::LANGUAGE, "BRE", "\\(", "\\)", "\\(", "\\)"),
    (grammar::LANGUAGE_ERE, "ERE", "(", ")", "(", ")"),
  ] {
    let mut parser = Parser::new();
    parser.set_language(&language.into()).unwrap();
    for depth in [65_535, 65_536] {
      let source =
        format!("/{}a{}/p\n", opening.repeat(depth), closing.repeat(depth));
      let tree = parser.parse(&source, None).unwrap();
      let root = tree.root_node();
      assert_eq!(root.kind(), "script", "{mode}, depth {depth}");
      assert_eq!(root.byte_range(), 0..source.len(), "{mode}, depth {depth}");
      assert!(!root.has_error(), "{mode}, depth {depth}");

      let mut cursor = root.walk();
      let mut openings = 0;
      let mut closings = 0;
      'walk: loop {
        let node = cursor.node();
        assert_ne!(node.kind(), "syntax_issue", "{mode}, depth {depth}");
        if node.kind() == opening_kind {
          openings += 1;
        } else if node.kind() == closing_kind {
          closings += 1;
        }
        if cursor.goto_first_child() {
          continue;
        }
        while !cursor.goto_next_sibling() {
          if !cursor.goto_parent() {
            break 'walk;
          }
        }
      }
      assert_eq!(openings, depth, "{mode}, depth {depth}");
      assert_eq!(closings, depth, "{mode}, depth {depth}");
    }
  }
}

#[test]
fn label_boundaries_use_decoded_characters_for_utf16_input() {
  for language in [grammar::LANGUAGE, grammar::LANGUAGE_ERE] {
    let mut parser = Parser::new();
    parser.set_language(&language.into()).unwrap();
    for (source, label_end) in [
      (":abcdefgh", 18),
      (":abcdefghi", 20),
      (":abcdefghi@", 22),
      (":ééééé", 12),
      (":a#b", 4),
      (":😀#p", 6),
    ] {
      let input: Vec<_> = source.encode_utf16().collect();
      let tree = parser.parse_utf16_le(&input, None).unwrap();
      assert!(!tree.root_node().has_error(), "{source}");
      assert!(issue_signatures(&tree).is_empty(), "{source}");
      let mut cursor = tree.walk();
      while cursor.node().kind() != "label_literal" {
        assert!(
          cursor.goto_first_child() || cursor.goto_next_sibling(),
          "{source}"
        );
      }
      assert_eq!(cursor.node().byte_range(), 2..label_end, "{source}");
    }
  }
}

#[test]
fn resumed_parses_keep_operand_fields_after_escaped_invalid_bytes() {
  let unit: &[u8] = b"\\\xc3\\qa";
  for (language, mode) in
    [(grammar::LANGUAGE, "BRE"), (grammar::LANGUAGE_ERE, "ERE")]
  {
    let mut parser = Parser::new();
    parser.set_language(&language.into()).unwrap();
    for (lines, opening, units, closing) in [
      (12, &b"a\\\n"[..], 4, &b"\n"[..]),
      (15, b"y/", 8, b"/cccc/\n"),
      (45, b"s/x/", 16, b"/\n"),
    ] {
      let source =
        [&b"p\n".repeat(lines), opening, &unit.repeat(units), closing].concat();
      let context = format!("{mode}, {:?}", String::from_utf8_lossy(&source));
      let fresh = parser.parse(&source, None).unwrap();
      assert!(!fresh.root_node().has_error(), "{context}");
      let expected = fielded_nodes(&fresh);
      let mut resumed = 0;
      for cancel_at in 1.. {
        parser.reset();
        let mut calls = 0;
        let mut progress = |_: &ParseState| {
          calls += 1;
          if calls == cancel_at {
            ControlFlow::Break(())
          } else {
            ControlFlow::Continue(())
          }
        };
        let completed = parser.parse_with_options(
          &mut |byte, _| &source[byte.min(source.len())..],
          None,
          Some(ParseOptions::new().progress_callback(&mut progress)),
        );
        if completed.is_some() {
          break;
        }
        let tree = parser.parse(&source, None).unwrap();
        assert_eq!(
          fielded_nodes(&tree),
          expected,
          "{context}, cancelled at {cancel_at}"
        );
        resumed += 1;
      }
      assert!(resumed > 0, "{context}");
    }
  }
}
