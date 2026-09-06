export type ValidationIssue = { level: "error" | "warning"; message: string };

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function collectStrings(value: unknown, into: string[]): void {
  if (typeof value === "string") { into.push(value); return; }
  if (Array.isArray(value)) { for (const item of value) collectStrings(item, into); return; }
  if (isPlainObject(value)) { for (const item of Object.values(value)) collectStrings(item, into); }
}

/** Reads redact secrets as the literal string "[redacted]"; writing that back would overwrite the real value. */
export function findRedactedLeaks(payload: unknown): ValidationIssue[] {
  const strings: string[] = [];
  collectStrings(payload, strings);
  return strings.includes("[redacted]")
    ? [{ level: "error", message: "Payload contains the literal string \"[redacted]\", which is a placeholder from a prior read, not a real value. Omit that property instead of sending it back; sending it would overwrite the real stored value." }]
    : [];
}

export function validateNodes(nodes: Record<string, unknown>[], options: { tabId?: string; knownIds?: Set<string>; knownTypes?: Set<string>; allowContainerTypes?: boolean } = {}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seenIds = new Set<string>();
  const localIds = new Set(nodes.map((node) => (typeof node.id === "string" ? node.id : undefined)).filter((id): id is string => !!id));

  for (const node of nodes) {
    const id = typeof node.id === "string" ? node.id : undefined;
    if (!id) { issues.push({ level: "error", message: "A node is missing a string \"id\"." }); continue; }
    if (seenIds.has(id)) issues.push({ level: "error", message: `Duplicate node id "${id}" in payload.` });
    seenIds.add(id);
    if (!options.allowContainerTypes && (node.type === "tab" || node.type === "subflow")) {
      issues.push({ level: "error", message: `Node "${id}" has type "${node.type}", which is not valid inside a flow's nodes/configs list; Node-RED will reject the whole write.` });
    }
    if (options.knownTypes && typeof node.type === "string" && node.type !== "tab" && node.type !== "subflow") {
      const subflowId = node.type.startsWith("subflow:") ? node.type.slice("subflow:".length) : undefined;
      const recognized = options.knownTypes.has(node.type)
        || (subflowId !== undefined && ((options.knownIds?.has(subflowId) ?? false) || localIds.has(subflowId)));
      if (!recognized) {
        issues.push({ level: "error", message: `Node "${id}" has type "${node.type}", which is not present in get_installed_modules and is not a subflow instance referencing an existing subflow id. Confirm the node type is installed before writing.` });
      }
    }
    if (options.tabId && typeof node.z === "string" && node.z !== options.tabId) {
      issues.push({ level: "error", message: `Node "${id}" has z="${node.z}" but is being written to tab "${options.tabId}".` });
    }
    if (node.wires === undefined) continue;
    if (!Array.isArray(node.wires)) {
      issues.push({ level: "error", message: `Node "${id}" has a "wires" property that is not an array.` });
      continue;
    }
    node.wires.forEach((port, index) => {
      if (!Array.isArray(port)) {
        issues.push({ level: "error", message: `Node "${id}" wires[${index}] must be an array of target ids, e.g. [["<targetId>"]]. Got a flattened value instead: Node-RED accepts this without error but silently fails to deliver any message.` });
        return;
      }
      for (const wireTarget of port) {
        if (typeof wireTarget !== "string" || !wireTarget) {
          issues.push({ level: "error", message: `Node "${id}" wires[${index}] contains a non-string target.` });
        } else if (options.knownIds && !options.knownIds.has(wireTarget) && !localIds.has(wireTarget)) {
          issues.push({ level: "error", message: `Node "${id}" wires[${index}] targets unknown node id "${wireTarget}", which does not exist in this payload or the current flow. Node-RED accepts this but silently drops any message routed there.` });
        }
      }
    });
  }
  return issues;
}
