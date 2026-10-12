// Mesure exécutée DANS la page par scripts/check-mobile.ts (injectée telle quelle, sans transpilation).
// Critères repris de l'audit mobile de la recette : scroll de page, élément hors de l'écran,
// conteneur qui coupe son contenu, cible d'action de moins de 44 px, texte tronqué illisible.
(function measure(opts) {
  var TAP = opts.tap;
  var TOL = opts.tolerance;
  var vw = document.documentElement.clientWidth;
  var vh = window.innerHeight;
  var issues = [];

  function visible(e) {
    var r = e.getBoundingClientRect();
    var s = getComputedStyle(e);
    if (r.width <= 0 || r.height <= 0 || s.visibility === "hidden" || s.display === "none") return false;
    if (Number(s.opacity) <= 0.05) return false;
    // Masqué visuellement (lien d'évitement, sr-only) ou en-tête de tableau masqué en mode cartes.
    if (e.closest(".sr-only, .visually-hidden, [aria-hidden='true'], [inert], thead")) return false;
    return true;
  }
  function label(e) {
    var name = (e.getAttribute("aria-label") || e.textContent || e.getAttribute("placeholder") || "").trim().replace(/\s+/g, " ").slice(0, 40);
    var cls = typeof e.className === "string" ? e.className.trim().split(/\s+/).slice(0, 3).join(".") : "";
    return e.tagName.toLowerCase() + (cls ? "." + cls : "") + (name ? " « " + name + " »" : "");
  }
  function scrollableAncestor(e) {
    for (var n = e.parentElement; n && n !== document.body; n = n.parentElement) {
      var ox = getComputedStyle(n).overflowX;
      if ((ox === "auto" || ox === "scroll") && n.scrollWidth > n.clientWidth + 1) return n;
    }
    return null;
  }
  // Lien « étiré » (::after absolu en inset-0) : la vraie cible est l'ancêtre positionné (tuile).
  function stretchedTarget(e) {
    var after = getComputedStyle(e, "::after");
    if (after.content !== "none" && after.position === "absolute" && after.inset === "0px") {
      for (var n = e.parentElement; n; n = n.parentElement) {
        if (getComputedStyle(n).position !== "static") return n;
      }
    }
    return e;
  }

  var root = document.documentElement;
  if (root.scrollWidth > vw + TOL) issues.push({ kind: "scroll", detail: "page " + root.scrollWidth + " > " + vw, selector: "html" });

  // Tablette et bureau (768 px et plus) : aucun tableau ne défile horizontalement
  // (colonnes masquées selon la largeur plutôt qu'un défilement interne).
  if (vw >= 768) {
    var tables = document.querySelectorAll("table, [role=table]");
    for (var t = 0; t < tables.length; t++) {
      if (!visible(tables[t])) continue;
      var box = scrollableAncestor(tables[t]);
      if (box) issues.push({ kind: "tableau", detail: "défilement horizontal " + box.scrollWidth + " > " + box.clientWidth, selector: label(box) });
    }
  }

  var all = Array.prototype.filter.call(document.querySelectorAll("body *"), visible);
  for (var i = 0; i < all.length; i++) {
    var e = all[i];
    var s = getComputedStyle(e);
    var r = e.getBoundingClientRect();

    // Conteneur qui coupe son contenu (hors champs, ellipse volontaire, bande qui défile).
    if (
      e.scrollWidth > e.clientWidth + TOL &&
      e.clientWidth > 0 &&
      (s.overflowX === "hidden" || s.overflowX === "clip") &&
      s.textOverflow !== "ellipsis" &&
      s.webkitLineClamp === "none" &&
      e.children.length > 0 &&
      !/^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName) &&
      !scrollableAncestor(e)
    ) {
      issues.push({ kind: "clip", detail: "contenu " + e.scrollWidth + " > " + e.clientWidth, selector: label(e) });
    }

    // Élément au-delà d'un bord de l'écran, hors bande qui défile et hors élément fixe.
    if (r.right > vw + TOL && r.left < vw && s.position !== "fixed" && !scrollableAncestor(e)) {
      issues.push({ kind: "clip", detail: "bord droit " + Math.round(r.right) + " > " + vw, selector: label(e) });
    }
    if (r.left < -TOL && r.right > 0 && s.position !== "fixed" && !scrollableAncestor(e)) {
      issues.push({ kind: "clip", detail: "bord gauche " + Math.round(r.left) + " < 0", selector: label(e) });
    }

    // Lisibilité : texte coupé par une ellipse dans une case trop étroite pour être lu
    // (moins de 80 px, ou moins de 120 px dans une ligne de liste ou une cellule de tableau).
    if (s.textOverflow === "ellipsis" && e.scrollWidth > e.clientWidth + 1 && (e.textContent || "").trim()) {
      var minWidth = e.closest("main li, main td, main [role=row]") ? opts.listCell : opts.minText;
      if (e.clientWidth < minWidth) {
        issues.push({ kind: "lisible", detail: "texte coupé dans " + e.clientWidth + " px (< " + minWidth + ")", selector: label(e) });
      }
    }

    // Cibles d'action de 44 px : règle tactile, contrôlée sous 768 px seulement (souris au-delà).
    if (vw < 768 && e.matches("a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=menuitem], [role=checkbox], [role=switch]")) {
      var inline = e.tagName === "A" && s.display === "inline" && e.closest("p, li, dd, td");
      if (inline || scrollableAncestor(e)) continue;
      var t = e.matches("input[type=checkbox], input[type=radio]") ? e.closest("label") || e : stretchedTarget(e);
      var tr = t.getBoundingClientRect();
      if (tr.height < TAP - TOL || tr.width < TAP - TOL) {
        issues.push({ kind: "target", detail: Math.round(tr.width) + "×" + Math.round(tr.height), selector: label(t) });
      }
    }
  }

  // Modales et menus : entièrement dans l'écran.
  var dialogs = document.querySelectorAll("[role=dialog], dialog[open], [role=menu], [role=listbox]");
  for (var j = 0; j < dialogs.length; j++) {
    var d = dialogs[j];
    if (!visible(d)) continue;
    var dr = d.getBoundingClientRect();
    if (dr.left < -TOL || dr.top < -TOL || dr.right > vw + TOL || dr.bottom > vh + TOL) {
      issues.push({ kind: "clip", detail: "modale hors de l'écran", selector: label(d) });
    }
  }

  // Dédoublonnage (un même composant répété dans une liste).
  var seen = {};
  return issues.filter(function (x) {
    var k = x.kind + x.detail + x.selector;
    if (seen[k]) return false;
    seen[k] = true;
    return true;
  });
})
