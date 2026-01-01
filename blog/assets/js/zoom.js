(() => {
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
    // если оверлей открыт — любой клик закрывает
    if (overlay.classList.contains("open")) {
      closeZoom();
      return;
    }

    const img = e.target.closest(".post-body img");
    if (!img) return;

    if (img.classList.contains("no-zoom")) return;

    // если картинка внутри ссылки — отменяем переход
    const link = img.closest("a");
    if (link) e.preventDefault();

    openZoom(img);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.classList.contains("open")) closeZoom();
  });
})();
