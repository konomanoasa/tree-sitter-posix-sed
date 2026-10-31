from importlib.resources import files

from .binding import language_posix_sed, language_posix_sed_ere

HIGHLIGHTS_QUERY: str = (
    files(__package__).joinpath("queries/highlights.scm").read_text("utf-8")
)
HIGHLIGHTS_QUERY_ERE: str = (
    files(__package__).joinpath("queries_ere/highlights.scm").read_text("utf-8")
)

__all__ = [
    "HIGHLIGHTS_QUERY",
    "HIGHLIGHTS_QUERY_ERE",
    "language_posix_sed",
    "language_posix_sed_ere",
]
