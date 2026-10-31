import sys
from pathlib import Path

from setuptools import Extension, setup

Path("dist/metadata").mkdir(parents=True, exist_ok=True)

setup(
    options={
        "build": {"build_base": "dist/build"},
        "egg_info": {"egg_base": "dist/metadata"},
    },
    ext_modules=[
        Extension(
            "tree_sitter_posix_sed.binding",
            sources=[
                "bindings/python/binding.c",
                "posix_sed_ere/src/parser.c",
                "posix_sed_ere/src/scanner.c",
                "src/parser.c",
                "src/scanner.c",
            ],
            include_dirs=["src", "posix_sed_ere/src"],
            depends=[
                "common/scanner.h",
                "common/tokens.h",
                "posix_sed_ere/src/tree_sitter/alloc.h",
                "posix_sed_ere/src/tree_sitter/parser.h",
                "src/tree_sitter/alloc.h",
                "src/tree_sitter/parser.h",
            ],
            extra_compile_args=["/std:c17", "/utf-8"]
            if sys.platform == "win32"
            else ["-std=c17"],
        )
    ],
)
