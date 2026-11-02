/** Patch keyed rows and their controls in place, so status updates keep the focused button. */
export function updateChildren(parent: HTMLElement, fresh: HTMLElement): void {
  const focused = parent.ownerDocument.activeElement as HTMLElement | null;
  const heldFocus = focused !== null && parent.contains(focused);
  const key = (node: Node): string | undefined => node.nodeType === 1 ? (node as HTMLElement).dataset?.key ?? ((node as Element).tagName === "BUTTON" ? `button:${node.textContent}` : undefined) : undefined;
  const keyed = new Map(Array.from(parent.childNodes).filter((node) => key(node) !== undefined).map((node) => [key(node)!, node]));
  let cursor = parent.firstChild;
  for (const next of Array.from(fresh.childNodes)) {
    const id = key(next);
    const current = id === undefined ? (cursor && key(cursor) === undefined && cursor.nodeName === next.nodeName ? cursor : null) : keyed.get(id) ?? null;
    if (!current) { parent.insertBefore(next, cursor); continue; }
    if (current !== cursor) parent.insertBefore(current, cursor);
    if (next.nodeType === 3) {
      if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
    } else if (next.nodeType === 1 && !(next as HTMLElement).hasAttribute("data-keep")) {
      const old = current as HTMLElement;
      const replacement = next as HTMLElement;
      const busy = old.hasAttribute("data-pending");
      for (const attr of Array.from(old.attributes)) if (!replacement.hasAttribute(attr.name) && attr.name !== "data-pending" && !(busy && attr.name === "disabled")) old.removeAttribute(attr.name);
      for (const attr of Array.from(replacement.attributes)) if (old.getAttribute(attr.name) !== attr.value) old.setAttribute(attr.name, attr.value);
      old.onclick = replacement.onclick;
      updateChildren(old, replacement);
    }
    cursor = current.nextSibling;
  }
  while (cursor) { const next = cursor.nextSibling; parent.removeChild(cursor); cursor = next; }
  if (heldFocus && parent.contains(focused) && parent.ownerDocument.activeElement !== focused) focused.focus();
}
