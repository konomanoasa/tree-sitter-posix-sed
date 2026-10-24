import assert from "node:assert/strict";

const newlineByte = 0x0a;

function sourceEndPoint(source) {
  const bytes = Buffer.from(source);
  let row = 0;
  for (const byte of bytes) if (byte === newlineByte) row += 1;
  return `${row}:${bytes.length - bytes.lastIndexOf(newlineByte) - 1}`;
}

function readCst(tree, source) {
  const bytes = Buffer.from(source);
  const lineStarts = [0];
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] === newlineByte) lineStarts.push(index + 1);
  }
  const nodes = [];
  const ancestors = [];
  for (const line of tree.split("\n")) {
    const row = /^([0-9]+):([0-9]+) +- +([0-9]+):([0-9]+) +/.exec(line);
    if (row === null) continue;
    const match =
      /^(([a-z_][a-z_0-9]*): )?([a-z_][a-z_0-9]*|ERROR|MISSING|"[^"]+")/.exec(
        line.slice(row[0].length),
      );
    if (match === null) continue;
    const [location, startRow, startColumn, endRow, endColumn] = row;
    const indentation = location.length;
    while (ancestors.length && ancestors.at(-1).indentation >= indentation) {
      ancestors.pop();
    }
    const [, , field, kind] = match;
    const start = [Number(startRow), Number(startColumn)];
    const end = [Number(endRow), Number(endColumn)];
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

function nodeRange(node) {
  return `[${node.start.join(", ")}] - [${node.end.join(", ")}]`;
}

function subtree(nodes, index) {
  let end = index + 1;
  while (
    end < nodes.length &&
    nodes[end].parent !== null &&
    nodes[end].parent >= index
  )
    end++;
  return nodes.slice(index, end);
}

function directDelimiterLeafLines(nodes, ownerType) {
  const owner = nodes.findIndex(({ kind }) => kind === ownerType);
  assert.notEqual(owner, -1, `missing ${ownerType}`);
  return nodes
    .filter(({ parent, kind }) => parent === owner && kind.startsWith('"'))
    .map(
      ({ start, end, kind }) => `${start.join(":")} - ${end.join(":")} ${kind}`,
    );
}

function issueSignatures(nodes, root = 0) {
  return subtree(nodes, root).flatMap((issue, offset) => {
    if (issue.kind !== "syntax_issue") return [];
    assert.equal(issue.field, "issue", "issues must use the issue field");
    const index = root + offset;
    const outcome = nodes[index + 1];
    const reason = nodes[index + 2];
    assert.ok(outcome !== undefined, "missing issue outcome");
    assert.ok(reason !== undefined, "missing issue reason");
    assert.equal(outcome.parent, index, "issue must directly own its outcome");
    assert.equal(
      reason.parent,
      index + 1,
      "outcome must directly own its reason",
    );
    const range = nodeRange(issue);
    assert.equal(
      nodeRange(outcome),
      range,
      "outcome range must match its issue",
    );
    assert.equal(nodeRange(reason), range, "reason range must match its issue");
    return [{ outcome: outcome.kind, reason: reason.kind, range }];
  });
}

function issuePaths(nodes) {
  return issueSignatures(nodes).map(
    ({ outcome, reason }) => `${outcome}/${reason}`,
  );
}

function syntaxSignatures(
  nodes,
  types = nodes.map(({ kind }) => kind),
  root = 0,
) {
  const selected = new Set(types);
  const depths = [];
  return subtree(nodes, root).flatMap((node, index) => {
    const depth = index === 0 ? 0 : depths[node.parent - root];
    const included = selected.has(node.kind);
    depths[index] = depth + Number(included);
    if (!included) return [];
    const field = node.field === null ? "" : `${node.field}: `;
    return [`${"  ".repeat(depth)}${field}${node.kind} ${nodeRange(node)}`];
  });
}

function assertNoNodes(nodes, ...types) {
  assert.deepEqual(
    nodes.filter(({ kind }) => types.includes(kind)),
    [],
    `unexpected ${types.join(", ")} node`,
  );
}

function publicNodes(nodes) {
  const visible = [];
  const parents = [];
  const missing = [];
  for (const [index, node] of nodes.entries()) {
    const parent = node.parent === null ? null : parents[node.parent];
    parents[index] = parent;
    missing[index] = node.kind === "MISSING" || missing[node.parent] === true;
    if (missing[index] || node.kind === "ERROR") continue;
    parents[index] = visible.length;
    visible.push({
      ...node,
      parent,
      field: nodes[node.parent]?.kind === "ERROR" ? null : node.field,
    });
  }
  return visible;
}

function topLevelEditingCommands(nodes) {
  const publicTree = publicNodes(nodes);
  const list = publicTree.findIndex(({ kind }) => kind === "command_list");
  assert.notEqual(list, -1, "missing command_list");
  return publicTree.flatMap((command, index) => {
    if (command.parent !== list || command.kind !== "editing_command")
      return [];
    const relativePoint = ([row, column]) => [
      row - command.start[0],
      row === command.start[0] ? column - command.start[1] : column,
    ];
    const nodes = subtree(publicTree, index).map((node, offset) => ({
      kind: node.kind,
      parent: offset === 0 ? null : node.parent - index,
      field: offset === 0 ? null : node.field,
      start: relativePoint(node.start),
      end: relativePoint(node.end),
      startByte: node.startByte - command.startByte,
      endByte: node.endByte - command.startByte,
    }));
    return [{ start: command.start, nodes }];
  });
}

function parseCst(tree, source) {
  const nodes = readCst(tree, source);
  assert.equal(nodes[0]?.kind, "script", tree);
  assert.equal(
    nodes[0].end.join(":"),
    sourceEndPoint(source),
    "root must reach the edited source end",
  );
  return nodes;
}

export {
  assertNoNodes,
  directDelimiterLeafLines,
  issuePaths,
  issueSignatures,
  nodeRange,
  parseCst,
  publicNodes,
  sourceEndPoint,
  subtree,
  syntaxSignatures,
  topLevelEditingCommands,
};
