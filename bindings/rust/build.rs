use std::{env, path::Path};

fn main() {
  let mut build = cc::Build::new();
  build.std("c17");
  if build.get_compiler().is_like_msvc() {
    build.flag("-utf-8");
  }
  if env::var("TARGET").expect("Cargo must provide TARGET")
    == "wasm32-unknown-unknown"
  {
    let headers = env::var_os("DEP_TREE_SITTER_LANGUAGE_WASM_HEADERS")
      .expect("tree-sitter-language must provide WebAssembly headers");
    build.include(&headers);
    println!("cargo::rerun-if-changed={}", Path::new(&headers).display());
  }

  let grammars = [
    ("src", "tree-sitter-posix-sed"),
    ("posix_sed_ere/src", "tree-sitter-posix-sed-ere"),
  ];
  for (directory, _) in grammars {
    println!("cargo::rerun-if-changed={directory}");
  }
  for header in ["common/scanner.h", "common/tokens.h"] {
    println!("cargo::rerun-if-changed={header}");
  }

  for (directory, library) in grammars {
    let directory = Path::new(directory);
    build
      .clone()
      .include(directory)
      .files([directory.join("parser.c"), directory.join("scanner.c")])
      .compile(library);
  }
}
