import { describe, expect, it } from "vitest";
import {
  detectFolderRole,
  folderDisplayName,
  buildFolderOverrides,
} from "@/lib/email/sync/folder-mapper.js";

describe("folder-mapper", () => {
  it("détecte INBOX et Sent Hostinger", () => {
    expect(detectFolderRole("INBOX", {})).toBe("INBOX");
    expect(detectFolderRole("INBOX.Sent", {})).toBe("SENT");
    expect(detectFolderRole("Trash", {})).toBe("TRASH");
  });

  it("respecte les overrides Paramètres", () => {
    const overrides = buildFolderOverrides({
      imapFolderSent: "Custom/SentBox",
    });
    expect(detectFolderRole("Custom/SentBox", overrides)).toBe("SENT");
    expect(detectFolderRole("Random/Folder", overrides)).toBe("CUSTOM");
  });

  it("extrait le nom affiché en français", () => {
    expect(folderDisplayName("INBOX.Sent")).toBe("Envoyés");
    expect(folderDisplayName("INBOX", "INBOX")).toBe("Boîte de réception");
    expect(folderDisplayName("INBOX.Trash")).toBe("Corbeille");
    expect(folderDisplayName("Projets", "CUSTOM")).toBe("Projets");
  });
});
