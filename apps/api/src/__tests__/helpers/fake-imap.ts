/**
 * Serveur IMAP simulé en mémoire (aucune connexion réelle) : juste ce qu'utilisent la synchro,
 * les drapeaux, le déplacement et le chargement du corps.
 */
export type FakeImapMessage = {
  uid: number;
  flags: Set<string>;
  messageId: string;
  subject: string;
  from: string;
  fromName?: string;
  replyTo?: string;
  date: Date;
  text?: string;
};

type Box = { uidValidity: number; uidNext: number; messages: FakeImapMessage[] };

export function createFakeImap(paths: Record<string, string | null> = { INBOX: "\\Inbox", Trash: "\\Trash" }) {
  const boxes = new Map<string, Box>();
  for (const p of Object.keys(paths)) boxes.set(p, { uidValidity: 1, uidNext: 1, messages: [] });
  let current = "INBOX";

  function box(path = current): Box {
    const b = boxes.get(path);
    if (!b) throw new Error(`dossier inconnu ${path}`);
    return b;
  }
  function matcher(range: string): (uid: number) => boolean {
    const parts = range.split(",").map((p) => p.trim());
    return (uid) =>
      parts.some((p) => {
        const [a, b] = p.split(":");
        if (b === undefined) return uid === Number(a);
        return uid >= Number(a) && (b === "*" || uid <= Number(b));
      });
  }
  function source(m: FakeImapMessage): Buffer {
    const lines = [
      `From: ${m.fromName ? `"${m.fromName}" ` : ""}<${m.from}>`,
      ...(m.replyTo ? [`Reply-To: ${m.replyTo}`] : []),
      "To: contact@kouzia.test",
      `Subject: ${m.subject}`,
      `Message-ID: ${m.messageId}`,
      `Date: ${m.date.toUTCString()}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      m.text ?? "",
    ];
    return Buffer.from(lines.join("\r\n"));
  }

  const client = {
    async list() {
      return [...boxes.keys()].map((path) => ({ path, specialUse: paths[path] ?? null }));
    },
    async mailboxOpen(path: string) {
      current = path;
      const b = box(path);
      return { path, uidValidity: b.uidValidity, uidNext: b.uidNext, exists: b.messages.length };
    },
    async status(path: string) {
      return { unseen: box(path).messages.filter((m) => !m.flags.has("\\Seen")).length };
    },
    async *fetch(range: string) {
      const match = matcher(range);
      for (const m of [...box().messages]) {
        if (!match(m.uid)) continue;
        yield {
          uid: m.uid,
          flags: new Set(m.flags),
          envelope: {
            messageId: m.messageId,
            subject: m.subject,
            date: m.date,
            from: [{ address: m.from, name: m.fromName }],
            replyTo: m.replyTo ? [{ address: m.replyTo }] : [{ address: m.from }],
            to: [{ address: "contact@kouzia.test" }],
          },
          bodyStructure: { type: "text/plain" },
          size: 100,
          headers: Buffer.from(""),
          source: source(m),
        };
      }
    },
    async messageFlagsAdd(range: string, flags: string[]) {
      const match = matcher(range);
      for (const m of box().messages) if (match(m.uid)) flags.forEach((f) => m.flags.add(f));
      return true;
    },
    async messageFlagsRemove(range: string, flags: string[]) {
      const match = matcher(range);
      for (const m of box().messages) if (match(m.uid)) flags.forEach((f) => m.flags.delete(f));
      return true;
    },
    async messageMove(range: string, dest: string) {
      const match = matcher(range);
      const from = box();
      const moving = from.messages.filter((m) => match(m.uid));
      from.messages = from.messages.filter((m) => !match(m.uid));
      const to = box(dest);
      for (const m of moving) to.messages.push({ ...m, uid: to.uidNext++ });
      return true;
    },
    async messageDelete(range: string) {
      const match = matcher(range);
      box().messages = box().messages.filter((m) => !match(m.uid));
      return true;
    },
  };

  return {
    client,
    /** Dépose un message dans un dossier (arrivée côté serveur). */
    deliver(path: string, m: Omit<FakeImapMessage, "uid" | "flags"> & { seen?: boolean }) {
      const b = box(path);
      const { seen, ...rest } = m;
      const msg: FakeImapMessage = { ...rest, uid: b.uidNext++, flags: new Set(seen ? ["\\Seen"] : []) };
      b.messages.push(msg);
      return msg;
    },
    find(path: string, messageId: string) {
      return box(path).messages.find((m) => m.messageId === messageId);
    },
    /** Action faite dans un autre client mail (téléphone, webmail). */
    setSeen(path: string, messageId: string, seen: boolean) {
      const m = box(path).messages.find((x) => x.messageId === messageId);
      if (!m) throw new Error("message absent");
      if (seen) m.flags.add("\\Seen");
      else m.flags.delete("\\Seen");
    },
    remove(path: string, messageId: string) {
      box(path).messages = box(path).messages.filter((m) => m.messageId !== messageId);
    },
    moveOnServer(fromPath: string, messageId: string, toPath: string) {
      const m = box(fromPath).messages.find((x) => x.messageId === messageId);
      if (!m) throw new Error("message absent");
      box(fromPath).messages = box(fromPath).messages.filter((x) => x !== m);
      box(toPath).messages.push({ ...m, uid: box(toPath).uidNext++ });
    },
  };
}
