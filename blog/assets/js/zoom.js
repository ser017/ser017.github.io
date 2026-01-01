(() => {
  // Только десктоп: есть hover и точный указатель (мышь/трекпад)
  const isDesktop = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  if (!isDesktop) return;

  const overlay = document.createElement("div");
  overlay.className = "img-zoom";
  overlay.innerHTML = "<img alt=''>";
  document.body.appendChild(overlay);

  const overlayImg = overlay.querySelector("img");

  function openZoom(img) {
    const src = img.currentSrc || img.src;
    overlayImg.src = src;
    overlayImg.alt = img.alt || "";
    overlay.classList.add("open");
    document.body.classList.add("zoom-lock");
  }

  function closeZoom() {
    overlay.classList.remove("open");
    document.body.classList.remove("zoom-lock");
    overlayImg.src = "";
  }

  document.addEventListener("click", (e) => {
    if (overlay.classList.contains("open")) {
      closeZoom();
      return;
    }

    const img = e.target.closest(".post-body img");
    if (!img) return;
    if (img.classList.contains("no-zoom")) return;

    const link = img.closest("a");
    if (link) e.preventDefault();

    openZoom(img);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.classList.contains("open")) closeZoom();
  });
})();
