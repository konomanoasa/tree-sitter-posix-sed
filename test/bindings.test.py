import unittest
from types import CapsuleType

import tree_sitter_posix_sed as grammar

from tree_sitter import Language, Parser, Query, QueryCursor


class BindingsTest(unittest.TestCase):
    def test_languages_parse_source_and_packaged_queries_capture_commands(self):
        for name, capsule, highlights, source in [
            (
                "posix_sed",
                grammar.language_posix_sed(),
                grammar.HIGHLIGHTS_QUERY,
                rb"/a\+/p",
            ),
            (
                "posix_sed_ere",
                grammar.language_posix_sed_ere(),
                grammar.HIGHLIGHTS_QUERY_ERE,
                b"/a+/p",
            ),
        ]:
            with self.subTest(language=name):
                self.assertIsInstance(capsule, CapsuleType)
                language = Language(capsule)
                self.assertEqual(language.name, name)
                tree = Parser(language).parse(source)
                self.assertEqual(tree.root_node.type, "script")
                self.assertFalse(tree.root_node.has_error)
                self.assertEqual(tree.root_node.text, source)
                captures = QueryCursor(Query(language, highlights)).captures(
                    tree.root_node
                )
                self.assertEqual(
                    [node.text for node in captures["keyword"]], [b"p"]
                )


if __name__ == "__main__":
    unittest.main()
