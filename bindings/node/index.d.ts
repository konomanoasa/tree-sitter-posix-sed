import type { Language } from "tree-sitter";

type PosixSedLanguage = Language & {
  HIGHLIGHTS_QUERY: string;
};

export declare const posix_sed: PosixSedLanguage;
export declare const posix_sed_ere: PosixSedLanguage;
