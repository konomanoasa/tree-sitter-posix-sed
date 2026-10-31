use konomanoasa_tree_sitter_posix_sed as grammar;
use tree_sitter::{Parser, Query, QueryCursor, StreamingIterator};

#[test]
fn parses_valid_source() {
  for (language, node_types, highlights, source) in [
    (
      grammar::LANGUAGE,
      grammar::NODE_TYPES,
      grammar::HIGHLIGHTS_QUERY,
      r"/a\+/p",
    ),
    (
      grammar::LANGUAGE_ERE,
      grammar::NODE_TYPES_ERE,
      grammar::HIGHLIGHTS_QUERY_ERE,
      "/a+/p",
    ),
  ] {
    let language = language.into();
    let mut parser = Parser::new();
    parser.set_language(&language).unwrap();
    let tree = parser.parse(source, None).unwrap();
    let root = tree.root_node();
    assert_eq!(root.kind(), "script");
    assert_eq!(root.byte_range(), 0..source.len());
    assert!(!root.has_error());
    assert!(node_types.contains("\"script\""));
    let query = Query::new(&language, highlights).unwrap();
    let mut cursor = QueryCursor::new();
    let mut captures = cursor.captures(&query, root, source.as_bytes());
    let mut commands = Vec::new();
    while let Some((matched, index)) = captures.next() {
      let capture = matched.captures()[*index];
      if query.capture_names()[capture.index as usize] == "keyword" {
        commands.push(capture.node.utf8_text(source.as_bytes()).unwrap());
      }
    }
    assert_eq!(commands, ["p"]);
  }
}
