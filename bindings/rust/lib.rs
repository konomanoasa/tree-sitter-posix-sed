use tree_sitter_language::LanguageFn;

unsafe extern "C" {
  fn tree_sitter_posix_sed() -> *const ();
  fn tree_sitter_posix_sed_ere() -> *const ();
}

pub const LANGUAGE: LanguageFn =
  unsafe { LanguageFn::from_raw(tree_sitter_posix_sed) };

pub const LANGUAGE_ERE: LanguageFn =
  unsafe { LanguageFn::from_raw(tree_sitter_posix_sed_ere) };

pub const NODE_TYPES: &str = include_str!("../../src/node-types.json");

pub const NODE_TYPES_ERE: &str =
  include_str!("../../posix_sed_ere/src/node-types.json");

pub const HIGHLIGHTS_QUERY: &str = include_str!("../../queries/highlights.scm");

pub const HIGHLIGHTS_QUERY_ERE: &str =
  include_str!("../../posix_sed_ere/queries/highlights.scm");
