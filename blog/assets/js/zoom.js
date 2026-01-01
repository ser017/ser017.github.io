(() => {
  const overlay = document.createElement("div");
  overlay.className = "img-zoom";
  overlay.innerHTML = "<img alt=''>";
  document.body.appendChild(overlay);

  const overlayImg = overlay.querySelector("img");

  let isOpen = false;

  function openZoom(img) {
    const src = img.currentSrc || img.src;
    overlayImg.src = src;
    overlayImg.alt = img.alt || "";
    overlay.classList.add("open");
    document.body.classList.add("zoom-lock");
    isOpen = true;
  }

  function closeZoom() {
    overlay.classList.remove("open");
    document.body.classList.remove("zoom-lock");
    overlayImg.src = "";
    isOpen = false;
  }

  // Открытие: оставим по клику (везде)
  document.addEventListener("click", (e) => {
    if (isOpen) return; // закрытие делаем отдельно (см. ниже)

    const img = e.target.closest(".post-body img");
    if (!img) return;
    if (img.classList.contains("no-zoom")) return;

    // если вдруг внутри ссылки — не переходить
    const link = img.closest("a");
    if (link) e.preventDefault();

    openZoom(img);
  });

  // Закрытие: на мобилке — по касанию (pointerdown) сразу, без "отпустить палец"
  document.addEventListener("pointerdown", (e) => {
    if (!isOpen) return;

    // Закрываем на любое касание по оверлею (и по картинке тоже)
    if (e.target.closest(".img-zoom")) {
      e.preventDefault(); // чтобы не было лишних кликов/зумов страницы
      closeZoom();
    }
  }, { passive: false });

  // ПК: ESC закрывает
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen) closeZoom();
  });
})();
