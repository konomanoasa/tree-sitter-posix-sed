import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import load from "node-gyp-build";

const binding = load(fileURLToPath(new URL("../..", import.meta.url)));

function language(name, path) {
  const result = binding[name];
  result.nodeTypeInfo = JSON.parse(
    readFileSync(
      new URL(`../../${path}/src/node-types.json`, import.meta.url),
      "utf8",
    ),
  );
  result.HIGHLIGHTS_QUERY = readFileSync(
    new URL(`../../${path}/queries/highlights.scm`, import.meta.url),
    "utf8",
  );
  return result;
}

export const posix_sed = language("posix_sed", ".");
export const posix_sed_ere = language("posix_sed_ere", "posix_sed_ere");
