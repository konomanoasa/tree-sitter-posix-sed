import assert from "node:assert/strict";

function sourceEndPoint(source) {
  const bytes = Buffer.from(source);
  let row = 0;
  for (const byte of bytes) if (byte === 0x0a) row += 1;
  return `${row}:${bytes.length - bytes.lastIndexOf(0x0a) - 1}`;
}

function readCst(tree, source) {
  const bytes = Buffer.from(source);
  const lineStarts = [0];
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] === 0x0a) lineStarts.push(index + 1);
  }
  const nodes = [];
  const ancestors = [];
  for (const line of tree.split("\n")) {
    const row = /^([0-9]+):([0-9]+) +- +([0-9]+):([0-9]+) +/.exec(line);
    if (row === null) continue;
    const match =
      /^(([a-z_][a-z_0-9]*): )?([a-z_][a-z_0-9]*|ERROR|MISSING|"[^"]+")/.exec(
        line.slice(row[0].length).replace(/^•/, ""),
      );
    if (match === null) continue;
    const indentation =
      row[0].length + (line.slice(row[0].length).startsWith("•") ? 1 : 0);
    while (ancestors.length && ancestors.at(-1).indentation >= indentation) {
      ancestors.pop();
    }
    const [, , field, kind] = match;
    const start = [Number(row[1]), Number(row[2])];
    const end = [Number(row[3]), Number(row[4])];
    const index = nodes.length;
    nodes.push({
      parent: ancestors.at(-1)?.index ?? null,
      kind,
      field: field ?? null,
      start,
      end,
      startByte: lineStarts[start[0]] + start[1],
      endByte: lineStarts[end[0]] + end[1],
    });
    ancestors.push({ indentation, index });
  }
  return nodes;
}

function parseCst(tree, source) {
  const nodes = readCst(tree, source);
  assert.ok(["script", "ERROR"].includes(nodes[0]?.kind), tree);
  assert.equal(
    nodes[0].end.join(":"),
    sourceEndPoint(source),
    "root must reach the edited source end",
  );
  return nodes;
}

export { parseCst, sourceEndPoint };
