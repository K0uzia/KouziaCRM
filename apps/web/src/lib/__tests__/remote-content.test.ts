import { describe, expect, it } from "vitest";
import { hasRemoteResource, remoteImagesAllowed } from "@/pages/messaging/remote-content";

describe("images distantes d'un message", () => {
  it("repère image, fond, srcset, url() et feuille de style distants", () => {
    expect(hasRemoteResource('<img src="https://t.example/p.gif">')).toBe(true);
    expect(hasRemoteResource('<td background="http://t.example/bg.png">')).toBe(true);
    expect(hasRemoteResource('<div style="background:url( \'https://t.example/x.png\')">')).toBe(true);
    expect(hasRemoteResource('<link rel="stylesheet" href="https://t.example/s.css">')).toBe(true);
    expect(hasRemoteResource('<img src="data:image/png;base64,AAAA"><a href="https://site.example">lien</a>')).toBe(false);
  });

  it("chargées pour un envoi de l'ERP ou un expéditeur reconnu, masquées sinon (copie hors ligne comprise)", () => {
    expect(remoteImagesAllowed("OUTBOUND", null)).toBe(true);
    expect(remoteImagesAllowed("INBOUND", { remoteImagesAllowed: true })).toBe(true);
    expect(remoteImagesAllowed("INBOUND", { remoteImagesAllowed: false })).toBe(false);
    expect(remoteImagesAllowed("INBOUND", undefined)).toBe(false);
  });
});
